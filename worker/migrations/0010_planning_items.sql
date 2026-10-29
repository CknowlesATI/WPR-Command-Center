-- Timeline overhaul: independent planning records. Does not change existing tasks/timelines or source sync ownership.
CREATE TABLE IF NOT EXISTS planning_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unit_label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT 'task' CHECK(item_type IN ('task','milestone','inspection','coordination')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','verify','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','critical')),
  owner TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  follow_up_date TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  verification_note TEXT NOT NULL DEFAULT '',
  source_task_id TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_planning_project ON planning_items(project_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_planning_follow_up ON planning_items(status, follow_up_date);
CREATE INDEX IF NOT EXISTS idx_planning_source_link ON planning_items(source_task_id);
CREATE TABLE IF NOT EXISTS planning_dependencies (
  item_id TEXT NOT NULL REFERENCES planning_items(id) ON DELETE CASCADE,
  prerequisite_item_id TEXT NOT NULL REFERENCES planning_items(id) ON DELETE CASCADE,
  PRIMARY KEY(item_id, prerequisite_item_id),
  CHECK(item_id <> prerequisite_item_id)
);
CREATE TABLE IF NOT EXISTS planning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES planning_items(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
