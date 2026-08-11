CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT DEFAULT '',
  recipient_count INTEGER DEFAULT 0,
  provider_id TEXT DEFAULT '',
  error TEXT DEFAULT ''
);
