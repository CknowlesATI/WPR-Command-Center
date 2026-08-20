ALTER TABLE tasks ADD COLUMN due_date TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN assignee TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN source_updated_at TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
