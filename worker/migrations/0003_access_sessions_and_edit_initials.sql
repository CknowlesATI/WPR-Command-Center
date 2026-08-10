ALTER TABLE tasks ADD COLUMN updated_by TEXT DEFAULT '';
ALTER TABLE tasks ADD COLUMN updated_at TEXT DEFAULT '';

ALTER TABLE project_controls ADD COLUMN updated_by TEXT DEFAULT '';
ALTER TABLE project_control_history ADD COLUMN changed_by TEXT DEFAULT '';
