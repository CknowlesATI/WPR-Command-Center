CREATE TABLE IF NOT EXISTS notification_recipients (
  email TEXT PRIMARY KEY,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT ''
);
