// Google Cloud Console で取得した値を設定してください
const CONFIG = {
  // OAuth 2.0 クライアントID（Google Cloud Console → 認証情報）
  CLIENT_ID: '795091838060-erssda9schadu5mimco1kfcjcvant0vd.apps.googleusercontent.com',

  // API キー（Google Cloud Console → 認証情報）
  API_KEY: 'AIzaSyCMMk4tQvuPKQ8mSzrldlcXUYZ3yPwuAsk',

  // bookshelf フォルダの ID（Google Drive URLの folders/ 以降の文字列）
  FOLDER_ID: '1w7vf6MwQdSFw9c9kdrElDZiwRf4AwicJ',

  // Drive API スコープ
  SCOPES: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file',

  // Google API Discovery Doc
  DISCOVERY_DOC: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
};
