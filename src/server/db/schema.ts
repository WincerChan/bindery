// Exact DDL text from bindery/db.py; SQLite persists this in sqlite_master.
export const BASE_TABLES = [
  "\n            CREATE TABLE IF NOT EXISTS sessions (\n                session_id TEXT PRIMARY KEY,\n                created_at TEXT NOT NULL,\n                last_seen TEXT NOT NULL\n            )\n            ",
  "\n            CREATE TABLE IF NOT EXISTS jobs (\n                id TEXT PRIMARY KEY,\n                book_id TEXT,\n                action TEXT NOT NULL,\n                status TEXT NOT NULL,\n                stage TEXT,\n                message TEXT,\n                log TEXT,\n                rule_template TEXT,\n                created_at TEXT NOT NULL,\n                updated_at TEXT NOT NULL\n            )\n            "
];
export const TABLES = [
  "CREATE TABLE IF NOT EXISTS passkeys (\n            credential_id TEXT PRIMARY KEY, public_key BLOB NOT NULL,\n            sign_count INTEGER NOT NULL DEFAULT 0, transports_json TEXT NOT NULL DEFAULT '[]',\n            aaguid TEXT, device_type TEXT, backed_up INTEGER NOT NULL DEFAULT 0,\n            name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT\n        )",
  "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS webauthn_challenges (\n            id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge BLOB NOT NULL,\n            session_id TEXT, expires_at TEXT NOT NULL\n        )",
  "\n            CREATE TABLE IF NOT EXISTS books (\n                book_id TEXT PRIMARY KEY,\n                title TEXT NOT NULL,\n                author TEXT,\n                language TEXT NOT NULL DEFAULT 'zh-CN',\n                description TEXT,\n                source_type TEXT NOT NULL DEFAULT 'txt',\n                series TEXT,\n                identifier TEXT,\n                publisher TEXT,\n                tags_json TEXT NOT NULL DEFAULT '[]',\n                published TEXT,\n                isbn TEXT,\n                rating INTEGER,\n                status TEXT NOT NULL DEFAULT 'synced',\n                epub_updated_at TEXT,\n                archived INTEGER NOT NULL DEFAULT 0,\n                read INTEGER NOT NULL DEFAULT 0,\n                read_updated_at TEXT,\n                cover_file TEXT,\n                rule_template TEXT,\n                theme_template TEXT,\n                custom_css TEXT,\n                created_at TEXT NOT NULL DEFAULT '',\n                updated_at TEXT NOT NULL DEFAULT ''\n            )\n            ",
  "\n            CREATE TABLE IF NOT EXISTS reader_progress (\n                book_id TEXT PRIMARY KEY,\n                section INTEGER NOT NULL,\n                page INTEGER NOT NULL,\n                page_count INTEGER NOT NULL,\n                updated_at TEXT NOT NULL\n            )\n            ",
  "\n            CREATE TABLE IF NOT EXISTS wishlist (\n                id TEXT PRIMARY KEY,\n                title TEXT NOT NULL,\n                library_book_id TEXT,\n                author TEXT,\n                identity_title TEXT NOT NULL DEFAULT '',\n                identity_author TEXT NOT NULL DEFAULT '',\n                rating INTEGER,\n                read INTEGER NOT NULL DEFAULT 0,\n                read_status TEXT NOT NULL DEFAULT 'unread',\n                tags_json TEXT NOT NULL DEFAULT '[]',\n                comment TEXT,\n                book_status TEXT NOT NULL DEFAULT 'completed',\n                created_at TEXT NOT NULL,\n                updated_at TEXT NOT NULL\n            )\n            ",
  "\n            CREATE TABLE IF NOT EXISTS device_reading (\n                book_id TEXT NOT NULL, device_id TEXT NOT NULL, device_kind TEXT NOT NULL, device_name TEXT NOT NULL,\n                section INTEGER, section_fraction REAL, percent REAL, location TEXT,\n                read_status TEXT NOT NULL, last_read_at TEXT, time_spent_seconds INTEGER NOT NULL DEFAULT 0,\n                rest_estimate_seconds INTEGER, synced_at TEXT NOT NULL,\n                PRIMARY KEY (book_id, device_id))\n            ",
  "\n            CREATE TABLE IF NOT EXISTS vocabulary (\n                id TEXT PRIMARY KEY,\n                device_id TEXT NOT NULL,\n                device_kind TEXT NOT NULL,\n                device_name TEXT NOT NULL,\n                word TEXT NOT NULL,\n                raw_word TEXT NOT NULL,\n                lang TEXT,\n                book_id TEXT,\n                source_title TEXT NOT NULL,\n                looked_up_at TEXT NOT NULL,\n                device_context_json TEXT,\n                context_json TEXT,\n                context_state TEXT NOT NULL,\n                push_state TEXT NOT NULL,\n                push_status_json TEXT,\n                pushed_at TEXT,\n                created_at TEXT NOT NULL,\n                updated_at TEXT NOT NULL\n            )\n            "
];
export const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_book ON jobs(book_id)",
  "CREATE INDEX IF NOT EXISTS idx_books_archived ON books(archived)",
  "CREATE INDEX IF NOT EXISTS idx_books_updated ON books(updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_reader_progress_updated ON reader_progress(updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_wishlist_updated ON wishlist(updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_wishlist_library_book ON wishlist(library_book_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_library_book_unique ON wishlist(library_book_id) WHERE library_book_id IS NOT NULL",
  "\n            CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_manual_identity_unique\n            ON wishlist(identity_title, identity_author)\n            WHERE library_book_id IS NULL AND identity_title != ''\n            ",
  "CREATE INDEX IF NOT EXISTS idx_device_reading_book ON device_reading(book_id)",
  "CREATE INDEX IF NOT EXISTS idx_vocabulary_device ON vocabulary(device_id, looked_up_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_vocabulary_book ON vocabulary(book_id, looked_up_at)",
  "CREATE INDEX IF NOT EXISTS idx_vocabulary_push ON vocabulary(push_state, looked_up_at)",
  // Global month ranges/latest lookup cannot use the device/book/push prefixes.
  "CREATE INDEX IF NOT EXISTS idx_vocabulary_lookup ON vocabulary(looked_up_at DESC, id)"
];
