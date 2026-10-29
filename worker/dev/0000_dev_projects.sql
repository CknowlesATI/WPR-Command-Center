-- Run ONLY against newly provisioned wpr-command-center-planning-dev D1.
-- This is a standalone minimal project registry for development, not a copy of production projects.
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL
);
INSERT OR IGNORE INTO projects(id,name) VALUES ('demo-wpr','Sample WPR Project - Synthetic');
-- Then run worker/migrations/0010_planning_items.sql against this SAME dev database.
