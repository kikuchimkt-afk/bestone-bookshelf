// ===== State =====
let tokenClient;
let gapiInited = false;
let gisInited = false;
let allBooks = [];
let tagsData = {};
let tagsFileId = null;
let activeTagFilters = new Set();
let currentBookFolder = null;

// ===== Google API Initialization =====
function gapiLoaded() {
    gapi.load('client', async () => {
        await gapi.client.init({
            apiKey: CONFIG.API_KEY,
            discoveryDocs: [CONFIG.DISCOVERY_DOC],
        });
        gapiInited = true;
        maybeEnableSignIn();
    });
}

function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: '', // set later
    });
    gisInited = true;
    maybeEnableSignIn();
}

function maybeEnableSignIn() {
    if (gapiInited && gisInited) {
        document.getElementById('btn-signin').disabled = false;
    }
}

// ===== Auth =====
function handleSignIn() {
    tokenClient.callback = async (resp) => {
        if (resp.error) {
            console.error('Auth error:', resp);
            return;
        }
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        showUserInfo();
        await loadBooks();
    };

    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

function handleSignOut() {
    const token = gapi.client.getToken();
    if (token) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
    }
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    allBooks = [];
    tagsData = {};
    activeTagFilters.clear();
}

function showUserInfo() {
    // Try to get user info using the People API first, fallback to simple display
    const userInfoEl = document.getElementById('user-info');
    userInfoEl.innerHTML = '<span>ログイン中</span>';
}

// ===== Data Loading =====
async function loadBooks() {
    const loading = document.getElementById('loading');
    const grid = document.getElementById('book-grid');
    const bookCount = document.getElementById('book-count');

    loading.classList.remove('hidden');
    grid.innerHTML = '';
    bookCount.classList.add('hidden');

    try {
        // 1. Get subfolders in the bookshelf folder
        const foldersRes = await gapi.client.drive.files.list({
            q: `'${CONFIG.FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
            pageSize: 1000,
            orderBy: 'name',
        });

        const folders = foldersRes.result.files || [];

        // 2. Load tags.json
        await loadTags();

        // 3. Get files for each folder (parallel batched)
        const batchSize = 20;
        allBooks = [];

        for (let i = 0; i < folders.length; i += batchSize) {
            const batch = folders.slice(i, i + batchSize);
            const promises = batch.map(folder => loadBookFolder(folder));
            const books = await Promise.all(promises);
            allBooks.push(...books.filter(b => b !== null));

            // Progressive rendering
            renderBooks(allBooks);
        }

        // 4. Render tag filters
        renderTagFilters();

    } catch (err) {
        console.error('Error loading books:', err);
        grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-text">読み込みエラー: ${err.message || 'フォルダにアクセスできません'}</p></div>`;
    } finally {
        loading.classList.add('hidden');
    }
}

async function loadBookFolder(folder) {
    try {
        const res = await gapi.client.drive.files.list({
            q: `'${folder.id}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType, webViewLink, thumbnailLink, webContentLink)',
            pageSize: 100,
        });

        const files = res.result.files || [];
        const pdfs = files.filter(f => f.mimeType === 'application/pdf');
        const images = files.filter(f => f.mimeType && f.mimeType.startsWith('image/'));
        const coverImage = images.length > 0 ? images[0] : null;

        if (pdfs.length === 0 && images.length === 0) return null;

        return {
            id: folder.id,
            name: folder.name,
            pdfs,
            coverImage,
            tags: tagsData[folder.name] || [],
        };
    } catch (err) {
        console.error(`Error loading folder ${folder.name}:`, err);
        return null;
    }
}

// ===== Tags =====
async function loadTags() {
    try {
        const res = await gapi.client.drive.files.list({
            q: `'${CONFIG.FOLDER_ID}' in parents and name = 'tags.json' and trashed = false`,
            fields: 'files(id, name)',
        });

        const files = res.result.files || [];
        if (files.length > 0) {
            tagsFileId = files[0].id;
            const content = await gapi.client.drive.files.get({
                fileId: tagsFileId,
                alt: 'media',
            });
            tagsData = typeof content.body === 'string' ? JSON.parse(content.body) : content.result || {};
        } else {
            tagsData = {};
            tagsFileId = null;
        }
    } catch (err) {
        console.error('Error loading tags:', err);
        tagsData = {};
    }
}

async function saveTags() {
    try {
        const content = JSON.stringify(tagsData, null, 2);
        const blob = new Blob([content], { type: 'application/json' });

        if (tagsFileId) {
            // Update existing
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${tagsFileId}?uploadType=media`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${gapi.client.getToken().access_token}`,
                    'Content-Type': 'application/json',
                },
                body: blob,
            });
        } else {
            // Create new tags.json in the bookshelf folder
            const metadata = {
                name: 'tags.json',
                parents: [CONFIG.FOLDER_ID],
                mimeType: 'application/json',
            };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', blob);

            const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${gapi.client.getToken().access_token}`,
                },
                body: form,
            });

            const data = await res.json();
            tagsFileId = data.id;
        }
    } catch (err) {
        console.error('Error saving tags:', err);
    }
}

// ===== Rendering =====
function renderBooks(books) {
    const grid = document.getElementById('book-grid');
    const emptyState = document.getElementById('empty-state');
    const bookCount = document.getElementById('book-count');
    const searchQuery = document.getElementById('search-input').value.toLowerCase().trim();

    // Filter
    let filtered = books;

    if (searchQuery) {
        filtered = filtered.filter(book => {
            const nameMatch = book.name.toLowerCase().includes(searchQuery);
            const tagMatch = (book.tags || []).some(t => t.toLowerCase().includes(searchQuery));
            return nameMatch || tagMatch;
        });
    }

    if (activeTagFilters.size > 0) {
        filtered = filtered.filter(book => {
            const bookTags = book.tags || [];
            return [...activeTagFilters].every(tag => bookTags.includes(tag));
        });
    }

    // Render count
    bookCount.classList.remove('hidden');
    bookCount.textContent = `${filtered.length} 冊${books.length !== filtered.length ? ` / ${books.length} 冊中` : ''}`;

    // Render grid
    if (filtered.length === 0) {
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    grid.innerHTML = filtered.map((book, i) => {
        const coverHtml = book.coverImage
            ? `<img class="book-cover" src="https://drive.google.com/thumbnail?id=${book.coverImage.id}&sz=w400" alt="${escapeHtml(book.name)}" loading="lazy">`
            : `<div class="book-cover-placeholder"><span class="placeholder-icon">📖</span><span>${escapeHtml(book.name)}</span></div>`;

        const tagsHtml = (book.tags || []).slice(0, 2).map(t =>
            `<span class="book-tag-mini">${escapeHtml(t)}</span>`
        ).join('');

        return `
      <div class="book-card" onclick="openBookModal('${book.id}')" style="animation-delay: ${Math.min(i * 0.02, 0.4)}s">
        <div class="book-cover-wrapper">
          ${coverHtml}
        </div>
        <div class="book-info">
          <div class="book-title" title="${escapeHtml(book.name)}">${escapeHtml(book.name)}</div>
          <div class="book-meta">
            <span class="book-pdf-count">📄 ${book.pdfs.length}</span>
            ${tagsHtml}
          </div>
        </div>
      </div>
    `;
    }).join('');
}

function renderTagFilters() {
    const container = document.getElementById('tag-chips');
    const allTags = {};

    // Count occurrences of each tag
    allBooks.forEach(book => {
        (book.tags || []).forEach(tag => {
            allTags[tag] = (allTags[tag] || 0) + 1;
        });
    });

    // Sort by count (desc) then alphabetically
    const sortedTags = Object.entries(allTags)
        .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b, 'ja'));

    if (sortedTags.length === 0) {
        document.getElementById('tag-filter-container').classList.add('hidden');
        return;
    }

    document.getElementById('tag-filter-container').classList.remove('hidden');

    container.innerHTML = sortedTags.map(([tag, count]) => {
        const active = activeTagFilters.has(tag) ? 'active' : '';
        return `<button class="tag-chip ${active}" onclick="toggleTagFilter('${escapeHtml(tag)}')">${escapeHtml(tag)} <span class="tag-chip-count">(${count})</span></button>`;
    }).join('');
}

// ===== Search =====
const searchInput = document.getElementById('search-input');
let searchTimeout;

searchInput.addEventListener('input', () => {
    const clearBtn = document.getElementById('btn-clear-search');
    clearBtn.classList.toggle('hidden', !searchInput.value);

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        renderBooks(allBooks);
    }, 200); // debounce
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        clearSearch();
    }
});

function clearSearch() {
    searchInput.value = '';
    document.getElementById('btn-clear-search').classList.add('hidden');
    renderBooks(allBooks);
}

// ===== Tag Filter =====
function toggleTagFilter(tag) {
    if (activeTagFilters.has(tag)) {
        activeTagFilters.delete(tag);
    } else {
        activeTagFilters.add(tag);
    }
    renderTagFilters();
    renderBooks(allBooks);
}

// ===== Modal =====
function openBookModal(folderId) {
    const book = allBooks.find(b => b.id === folderId);
    if (!book) return;

    currentBookFolder = book;

    const modal = document.getElementById('pdf-modal');
    document.getElementById('modal-title').textContent = book.name;

    // Cover image
    const coverEl = document.getElementById('modal-cover');
    if (book.coverImage) {
        coverEl.innerHTML = `<img src="https://drive.google.com/thumbnail?id=${book.coverImage.id}&sz=w600" alt="${escapeHtml(book.name)}">`;
        coverEl.style.display = '';
    } else {
        coverEl.style.display = 'none';
    }

    // PDF list
    const pdfList = document.getElementById('modal-pdf-list');
    pdfList.innerHTML = book.pdfs.map(pdf => `
    <li>
      <a class="pdf-item" href="https://drive.google.com/file/d/${pdf.id}/view" target="_blank" rel="noopener noreferrer">
        <span class="pdf-icon">📄</span>
        <span class="pdf-name">${escapeHtml(pdf.name)}</span>
        <span class="pdf-open-icon">↗</span>
      </a>
    </li>
  `).join('');

    // Tags
    renderModalTags();

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function renderModalTags() {
    if (!currentBookFolder) return;

    const tags = tagsData[currentBookFolder.name] || [];
    const tagsList = document.getElementById('modal-tags-list');

    tagsList.innerHTML = tags.map(tag => `
    <span class="modal-tag">
      ${escapeHtml(tag)}
      <button class="modal-tag-remove" onclick="removeTag('${escapeHtml(tag)}')" title="タグを削除">&times;</button>
    </span>
  `).join('');

    if (tags.length === 0) {
        tagsList.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">タグなし</span>';
    }
}

function closeModal() {
    const modal = document.getElementById('pdf-modal');
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    currentBookFolder = null;
}

// Close modal on overlay click
document.getElementById('pdf-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        closeModal();
    }
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// ===== Tag Add/Remove =====
async function addTag() {
    if (!currentBookFolder) return;

    const input = document.getElementById('tag-input');
    const tag = input.value.trim();
    if (!tag) return;

    if (!tagsData[currentBookFolder.name]) {
        tagsData[currentBookFolder.name] = [];
    }

    if (!tagsData[currentBookFolder.name].includes(tag)) {
        tagsData[currentBookFolder.name].push(tag);

        // Update the book's tags in allBooks
        const book = allBooks.find(b => b.id === currentBookFolder.id);
        if (book) book.tags = tagsData[currentBookFolder.name];

        await saveTags();
        renderModalTags();
        renderTagFilters();
        renderBooks(allBooks);
    }

    input.value = '';
}

async function removeTag(tag) {
    if (!currentBookFolder) return;

    const tags = tagsData[currentBookFolder.name] || [];
    const idx = tags.indexOf(tag);
    if (idx >= 0) {
        tags.splice(idx, 1);
        if (tags.length === 0) {
            delete tagsData[currentBookFolder.name];
        }

        // Update the book's tags in allBooks
        const book = allBooks.find(b => b.id === currentBookFolder.id);
        if (book) book.tags = tagsData[currentBookFolder.name] || [];

        await saveTags();
        renderModalTags();
        renderTagFilters();
        renderBooks(allBooks);
    }
}

// Tag input enter key
document.getElementById('tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        addTag();
    }
});

// ===== Utilities =====
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
