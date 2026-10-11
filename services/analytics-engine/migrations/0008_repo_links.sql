-- Step 8f: repos the owner connected through the researchdesk GitHub App. One row per repo; the
-- installation id is what the Worker mints a one-repo read token from at run time.
CREATE TABLE IF NOT EXISTS research_repo_links (
  repo TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  linked_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS research_repo_links_installation ON research_repo_links (installation_id);
-- The engine comes from the platform repo, the strategy from the connected repo: a job keeps both commits.
ALTER TABLE research_jobs ADD COLUMN engine_commit_sha TEXT;
