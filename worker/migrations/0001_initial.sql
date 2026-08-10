CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_group TEXT,
  segment TEXT,
  external_team TEXT,
  percent INTEGER DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT
);

CREATE TABLE IF NOT EXISTS project_controls (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_outcome TEXT DEFAULT '',
  next_move_owner TEXT DEFAULT '',
  operating_state TEXT DEFAULT 'Stable',
  blocked INTEGER DEFAULT 0,
  blocker_reason TEXT DEFAULT '',
  delay_consequence TEXT DEFAULT '',
  next_action TEXT DEFAULT '',
  response_date TEXT DEFAULT '',
  review_date TEXT DEFAULT '',
  escalation_date TEXT DEFAULT '',
  last_movement_date TEXT DEFAULT '',
  evidence TEXT DEFAULT '',
  control_notes TEXT DEFAULT '',
  escalation_level TEXT DEFAULT '',
  last_escalation_action TEXT DEFAULT '',
  event_trigger TEXT DEFAULT '',
  override_daily INTEGER DEFAULT 0,
  contract_status TEXT DEFAULT '',
  deposit_status TEXT DEFAULT '',
  change_order_status TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS project_control_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  source TEXT DEFAULT '',
  external_url TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);

CREATE TABLE IF NOT EXISTS timelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  start TEXT,
  end TEXT,
  status TEXT DEFAULT '',
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  owner TEXT DEFAULT '',
  note TEXT DEFAULT '',
  due TEXT
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT,
  state TEXT DEFAULT 'future'
);
