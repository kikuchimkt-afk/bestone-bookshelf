// ===== State =====
let tokenClient;
let gapiInited = false;
let gisInited = false;
let allBooks = [];
let tagsData = {};      // { "本名": { tags:[], favorite:bool, status:str, lastOpened:str } }
let tagsFileId = null;
let activeTagFilters = new Set();
let currentBookFolder = null;
let currentViewMode = 'all';     // all, favorites, recent, category
let currentViewStyle = 'grid';   // grid, list
let batchMode = false;
let batchSelected = new Set();

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
        callback: '',
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
        if (resp.error) { console.error('Auth error:', resp); return; }
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        showUserInfo();
        loadThemePreference();
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
    allBooks = []; tagsData = {}; activeTagFilters.clear();
}

function showUserInfo() {
    document.getElementById('user-info').innerHTML = '<span>ログイン中</span>';
}

// ===== Theme =====
function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    document.getElementById('btn-theme').textContent = next === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('book-db-theme', next);
}

function loadThemePreference() {
    const saved = localStorage.getItem('book-db-theme');
    if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
        document.getElementById('btn-theme').textContent = saved === 'dark' ? '🌙' : '☀️';
    }
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
        const foldersRes = await gapi.client.drive.files.list({
            q: `'${CONFIG.FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name, createdTime)',
            pageSize: 1000,
            orderBy: 'name',
        });

        const folders = foldersRes.result.files || [];
        await loadTags();

        const batchSize = 20;
        allBooks = [];

        for (let i = 0; i < folders.length; i += batchSize) {
            const batch = folders.slice(i, i + batchSize);
            const promises = batch.map(folder => loadBookFolder(folder));
            const books = await Promise.all(promises);
            allBooks.push(...books.filter(b => b !== null));
            renderCurrentView();
        }

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

        const meta = getBookMeta(folder.name);

        return {
            id: folder.id,
            name: folder.name,
            pdfs,
            coverImage,
            createdTime: folder.createdTime,
            tags: meta.tags || [],
            favorite: meta.favorite || false,
            status: meta.status || 'unread',
            lastOpened: meta.lastOpened || null,
        };
    } catch (err) {
        console.error(`Error loading folder ${folder.name}:`, err);
        return null;
    }
}

// ===== Tags / Metadata =====
function getBookMeta(bookName) {
    const data = tagsData[bookName];
    if (!data) return { tags: [], favorite: false, status: 'unread', lastOpened: null };
    // Backward compatibility: if data is an array, it's old format (tags only)
    if (Array.isArray(data)) return { tags: data, favorite: false, status: 'unread', lastOpened: null };
    return data;
}

function setBookMeta(bookName, meta) {
    tagsData[bookName] = meta;
}

async function loadTags() {
    try {
        const res = await gapi.client.drive.files.list({
            q: `'${CONFIG.FOLDER_ID}' in parents and name = 'tags.json' and trashed = false`,
            fields: 'files(id, name)',
        });
        const files = res.result.files || [];
        if (files.length > 0) {
            tagsFileId = files[0].id;
            const content = await gapi.client.drive.files.get({ fileId: tagsFileId, alt: 'media' });
            const raw = typeof content.body === 'string' ? JSON.parse(content.body) : content.result || {};
            // Migrate old format
            tagsData = {};
            for (const [key, val] of Object.entries(raw)) {
                if (Array.isArray(val)) {
                    tagsData[key] = { tags: val, favorite: false, status: 'unread', lastOpened: null };
                } else {
                    tagsData[key] = val;
                }
            }
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
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${tagsFileId}?uploadType=media`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${gapi.client.getToken().access_token}`, 'Content-Type': 'application/json' },
                body: blob,
            });
        } else {
            const metadata = { name: 'tags.json', parents: [CONFIG.FOLDER_ID], mimeType: 'application/json' };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', blob);
            const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${gapi.client.getToken().access_token}` },
                body: form,
            });
            const data = await res.json();
            tagsFileId = data.id;
        }
    } catch (err) {
        console.error('Error saving tags:', err);
    }
}

// ===== View Modes =====
function setViewMode(mode) {
    currentViewMode = mode;
    document.querySelectorAll('.toolbar-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`btn-${mode === 'all' ? 'all' : mode === 'favorites' ? 'favorites' : mode === 'recent' ? 'recent' : 'category'}`).classList.add('active');
    renderCurrentView();
}

function renderCurrentView() {
    const grid = document.getElementById('book-grid');
    const categoryContainer = document.getElementById('category-container');

    if (currentViewMode === 'category') {
        grid.classList.add('hidden');
        categoryContainer.classList.remove('hidden');
        renderCategoryView();
    } else {
        grid.classList.remove('hidden');
        categoryContainer.classList.add('hidden');
        renderBooks(getFilteredBooks());
    }
}

function getFilteredBooks() {
    let books = [...allBooks];
    const searchQuery = document.getElementById('search-input').value.toLowerCase().trim();

    // View mode filter
    if (currentViewMode === 'favorites') {
        books = books.filter(b => b.favorite);
    } else if (currentViewMode === 'recent') {
        books = books.filter(b => b.lastOpened).sort((a, b) => new Date(b.lastOpened) - new Date(a.lastOpened));
    }

    // Search filter
    if (searchQuery) {
        books = books.filter(book => {
            const nameMatch = book.name.toLowerCase().includes(searchQuery);
            const tagMatch = (book.tags || []).some(t => t.toLowerCase().includes(searchQuery));
            return nameMatch || tagMatch;
        });
    }

    // Tag filter
    if (activeTagFilters.size > 0) {
        books = books.filter(book => {
            const bookTags = book.tags || [];
            return [...activeTagFilters].every(tag => bookTags.includes(tag));
        });
    }

    // Sort
    const sortVal = document.getElementById('sort-select').value;
    if (currentViewMode !== 'recent') {
        books = sortBooks(books, sortVal);
    }

    return books;
}

function sortBooks(books, sortVal) {
    switch (sortVal) {
        case 'name-asc':
            return books.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        case 'name-desc':
            return books.sort((a, b) => b.name.localeCompare(a.name, 'ja'));
        case 'tags-desc':
            return books.sort((a, b) => (b.tags?.length || 0) - (a.tags?.length || 0));
        case 'recent':
            return books.sort((a, b) => {
                const da = a.lastOpened ? new Date(a.lastOpened) : new Date(0);
                const db = b.lastOpened ? new Date(b.lastOpened) : new Date(0);
                return db - da;
            });
        default:
            return books;
    }
}

function handleSort() { renderCurrentView(); }

// ===== View Style Toggle =====
function toggleViewStyle() {
    const grid = document.getElementById('book-grid');
    const btn = document.getElementById('btn-view-toggle');
    if (currentViewStyle === 'grid') {
        currentViewStyle = 'list';
        grid.classList.add('list-view');
        btn.textContent = '⊞';
        btn.title = 'グリッド表示';
    } else {
        currentViewStyle = 'grid';
        grid.classList.remove('list-view');
        btn.textContent = '☰';
        btn.title = 'リスト表示';
    }
}

// ===== Rendering =====
function renderBooks(filtered) {
    const grid = document.getElementById('book-grid');
    const emptyState = document.getElementById('empty-state');
    const bookCount = document.getElementById('book-count');

    bookCount.classList.remove('hidden');
    bookCount.textContent = `${filtered.length} 冊${allBooks.length !== filtered.length ? ` / ${allBooks.length} 冊中` : ''}`;

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

        const favHtml = book.favorite ? '<span class="book-fav-badge">⭐</span>' : '';

        const statusLabel = { unread: '未読', reading: '読書中', done: '読了' };
        const statusHtml = book.status && book.status !== 'unread'
            ? `<span class="book-status-badge ${book.status}">${statusLabel[book.status] || ''}</span>`
            : '';

        const selectedClass = batchSelected.has(book.id) ? 'batch-selected' : '';
        const onclick = batchMode
            ? `toggleBatchSelect('${book.id}')`
            : `openBookModal('${book.id}')`;

        return `
      <div class="book-card ${selectedClass}" onclick="${onclick}" style="animation-delay: ${Math.min(i * 0.02, 0.4)}s">
        <div class="batch-checkbox">${batchSelected.has(book.id) ? '✓' : ''}</div>
        ${favHtml}
        <div class="book-cover-wrapper">${coverHtml}</div>
        <div class="book-info">
          <div class="book-title" title="${escapeHtml(book.name)}">${escapeHtml(book.name)}</div>
          <div class="book-meta">
            <span class="book-pdf-count">📄 ${book.pdfs.length}</span>
            ${statusHtml}
            ${tagsHtml}
          </div>
        </div>
      </div>
    `;
    }).join('');
}

function renderCategoryView() {
    const container = document.getElementById('category-container');
    const emptyState = document.getElementById('empty-state');
    const bookCount = document.getElementById('book-count');

    // Group books by tags
    const categories = {};
    const untagged = [];

    allBooks.forEach(book => {
        if (!book.tags || book.tags.length === 0) {
            untagged.push(book);
        } else {
            book.tags.forEach(tag => {
                if (!categories[tag]) categories[tag] = [];
                categories[tag].push(book);
            });
        }
    });

    // Sort categories by count
    const sortedCats = Object.entries(categories)
        .sort(([, a], [, b]) => b.length - a.length);

    bookCount.classList.remove('hidden');
    bookCount.textContent = `${allBooks.length} 冊 · ${sortedCats.length} カテゴリ`;

    if (sortedCats.length === 0 && untagged.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    let html = '';
    sortedCats.forEach(([tag, books]) => {
        html += `
      <div class="category-section">
        <div class="category-header">
          <h2 class="category-title">🏷️ ${escapeHtml(tag)}</h2>
          <span class="category-count">${books.length} 冊</span>
        </div>
        <div class="category-grid">
          ${books.map(book => renderMiniCard(book)).join('')}
        </div>
      </div>
    `;
    });

    if (untagged.length > 0) {
        html += `
      <div class="category-section">
        <div class="category-header">
          <h2 class="category-title">📦 タグなし</h2>
          <span class="category-count">${untagged.length} 冊</span>
        </div>
        <div class="category-grid">
          ${untagged.map(book => renderMiniCard(book)).join('')}
        </div>
      </div>
    `;
    }

    container.innerHTML = html;
}

function renderMiniCard(book) {
    const coverHtml = book.coverImage
        ? `<img class="book-cover" src="https://drive.google.com/thumbnail?id=${book.coverImage.id}&sz=w300" alt="${escapeHtml(book.name)}" loading="lazy">`
        : `<div class="book-cover-placeholder"><span class="placeholder-icon">📖</span></div>`;
    const favHtml = book.favorite ? '<span class="book-fav-badge">⭐</span>' : '';

    return `
    <div class="book-card" onclick="openBookModal('${book.id}')">
      ${favHtml}
      <div class="book-cover-wrapper">${coverHtml}</div>
      <div class="book-info">
        <div class="book-title">${escapeHtml(book.name)}</div>
        <div class="book-meta"><span class="book-pdf-count">📄 ${book.pdfs.length}</span></div>
      </div>
    </div>
  `;
}

function renderTagFilters() {
    const container = document.getElementById('tag-chips');
    const allTags = {};

    allBooks.forEach(book => {
        (book.tags || []).forEach(tag => { allTags[tag] = (allTags[tag] || 0) + 1; });
    });

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
    document.getElementById('btn-clear-search').classList.toggle('hidden', !searchInput.value);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => renderCurrentView(), 200);
});

searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); });

function clearSearch() {
    searchInput.value = '';
    document.getElementById('btn-clear-search').classList.add('hidden');
    renderCurrentView();
}

// ===== Tag Filter =====
function toggleTagFilter(tag) {
    if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
    else activeTagFilters.add(tag);
    renderTagFilters();
    renderCurrentView();
}

// ===== Modal =====
function openBookModal(folderId) {
    const book = allBooks.find(b => b.id === folderId);
    if (!book) return;
    currentBookFolder = book;

    // Record last opened
    book.lastOpened = new Date().toISOString();
    const meta = getBookMeta(book.name);
    meta.lastOpened = book.lastOpened;
    setBookMeta(book.name, meta);
    saveTags(); // async, no await needed

    const modal = document.getElementById('pdf-modal');
    document.getElementById('modal-title').textContent = book.name;

    // Favorite button
    const favBtn = document.getElementById('modal-fav-btn');
    favBtn.textContent = book.favorite ? '★' : '☆';
    favBtn.classList.toggle('favorited', book.favorite);

    // Cover
    const coverEl = document.getElementById('modal-cover');
    if (book.coverImage) {
        coverEl.innerHTML = `<img src="https://drive.google.com/thumbnail?id=${book.coverImage.id}&sz=w600" alt="${escapeHtml(book.name)}">`;
        coverEl.style.display = '';
    } else {
        coverEl.style.display = 'none';
    }

    // Reading status
    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === (book.status || 'unread'));
    });

    // PDF list
    document.getElementById('modal-pdf-list').innerHTML = book.pdfs.map(pdf => `
    <li>
      <a class="pdf-item" href="https://drive.google.com/file/d/${pdf.id}/view" target="_blank" rel="noopener noreferrer">
        <span class="pdf-icon">📄</span>
        <span class="pdf-name">${escapeHtml(pdf.name)}</span>
        <span class="pdf-open-icon">↗</span>
      </a>
    </li>
  `).join('');

    renderModalTags();

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function renderModalTags() {
    if (!currentBookFolder) return;
    const tags = currentBookFolder.tags || [];
    const tagsList = document.getElementById('modal-tags-list');
    tagsList.innerHTML = tags.length > 0
        ? tags.map(tag => `<span class="modal-tag">${escapeHtml(tag)}<button class="modal-tag-remove" onclick="removeTag('${escapeHtml(tag)}')">&times;</button></span>`).join('')
        : '<span style="color: var(--text-muted); font-size: 12px;">タグなし</span>';
}

function closeModal() {
    document.getElementById('pdf-modal').classList.add('hidden');
    document.body.style.overflow = '';
    currentBookFolder = null;
}

document.getElementById('pdf-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ===== Favorite =====
async function toggleFavorite() {
    if (!currentBookFolder) return;
    currentBookFolder.favorite = !currentBookFolder.favorite;

    const meta = getBookMeta(currentBookFolder.name);
    meta.favorite = currentBookFolder.favorite;
    setBookMeta(currentBookFolder.name, meta);

    const favBtn = document.getElementById('modal-fav-btn');
    favBtn.textContent = currentBookFolder.favorite ? '★' : '☆';
    favBtn.classList.toggle('favorited', currentBookFolder.favorite);

    await saveTags();
    renderCurrentView();
}

// ===== Reading Status =====
async function setReadingStatus(status) {
    if (!currentBookFolder) return;
    currentBookFolder.status = status;

    const meta = getBookMeta(currentBookFolder.name);
    meta.status = status;
    setBookMeta(currentBookFolder.name, meta);

    document.querySelectorAll('.status-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === status);
    });

    await saveTags();
    renderCurrentView();
}

// ===== Tag Add/Remove =====
async function addTag() {
    if (!currentBookFolder) return;
    const input = document.getElementById('tag-input');
    const tag = input.value.trim();
    if (!tag) return;

    const meta = getBookMeta(currentBookFolder.name);
    if (!meta.tags) meta.tags = [];
    if (!meta.tags.includes(tag)) {
        meta.tags.push(tag);
        setBookMeta(currentBookFolder.name, meta);
        currentBookFolder.tags = meta.tags;
        await saveTags();
        renderModalTags();
        renderTagFilters();
        renderCurrentView();
    }
    input.value = '';
}

async function removeTag(tag) {
    if (!currentBookFolder) return;
    const meta = getBookMeta(currentBookFolder.name);
    const idx = (meta.tags || []).indexOf(tag);
    if (idx >= 0) {
        meta.tags.splice(idx, 1);
        setBookMeta(currentBookFolder.name, meta);
        currentBookFolder.tags = meta.tags;
        await saveTags();
        renderModalTags();
        renderTagFilters();
        renderCurrentView();
    }
}

document.getElementById('tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
});

// ===== Batch Tag Edit =====
function toggleBatchMode() {
    batchMode = !batchMode;
    batchSelected.clear();
    document.getElementById('batch-bar').classList.toggle('hidden', !batchMode);
    document.getElementById('book-grid').classList.toggle('batch-mode', batchMode);
    document.getElementById('btn-batch-tag').style.background = batchMode ? 'var(--accent)' : '';
    document.getElementById('btn-batch-tag').style.color = batchMode ? '#fff' : '';
    updateBatchCount();
    renderCurrentView();
}

function toggleBatchSelect(bookId) {
    if (batchSelected.has(bookId)) batchSelected.delete(bookId);
    else batchSelected.add(bookId);
    updateBatchCount();
    renderCurrentView();
}

function updateBatchCount() {
    document.getElementById('batch-count').textContent = `${batchSelected.size}冊 選択中`;
}

async function batchAddTag() {
    const input = document.getElementById('batch-tag-input');
    const tag = input.value.trim();
    if (!tag || batchSelected.size === 0) return;

    for (const bookId of batchSelected) {
        const book = allBooks.find(b => b.id === bookId);
        if (!book) continue;

        const meta = getBookMeta(book.name);
        if (!meta.tags) meta.tags = [];
        if (!meta.tags.includes(tag)) {
            meta.tags.push(tag);
            setBookMeta(book.name, meta);
            book.tags = meta.tags;
        }
    }

    await saveTags();
    input.value = '';
    renderTagFilters();
    renderCurrentView();
    toggleBatchMode();
}

document.getElementById('batch-tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); batchAddTag(); }
});

// ===== Utilities =====
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
