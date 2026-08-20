CREATE TABLE IF NOT EXISTS sync_runs (
  source TEXT PRIMARY KEY,
  label TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unknown',
  last_attempt_at TEXT DEFAULT '',
  last_success_at TEXT DEFAULT '',
  records_seen INTEGER DEFAULT 0,
  records_written INTEGER DEFAULT 0,
  project_count INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  updated_at TEXT DEFAULT '',
  updated_by TEXT DEFAULT ''
);
