ALTER TABLE changes ADD COLUMN preview_url TEXT;
ALTER TABLE changes ADD COLUMN deploy_url TEXT;
ALTER TABLE changes ADD COLUMN deploy_error TEXT;
CREATE TABLE claim_conflicts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), agent TEXT NOT NULL, scope_json TEXT NOT NULL, conflicting_task TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
