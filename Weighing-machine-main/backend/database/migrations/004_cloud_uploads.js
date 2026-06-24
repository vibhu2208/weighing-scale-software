'use strict';

const id = '004_cloud_uploads';

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      uploaded INTEGER DEFAULT 0,
      uploaded_at DATETIME,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_uploads_pending
      ON cloud_uploads(uploaded, retry_count);
  `);
}

module.exports = { id, up };
