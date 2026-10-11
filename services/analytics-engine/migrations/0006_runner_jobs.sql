-- Step 8: jobs the Worker hands to the strategy runner through the RUNNER binding.
-- `via_runner` marks them; the old polling runner keeps `via_runner = 0` jobs until step 8b is live.
ALTER TABLE research_jobs ADD COLUMN via_runner INTEGER NOT NULL DEFAULT 0 CHECK (via_runner IN (0, 1));
ALTER TABLE research_jobs ADD COLUMN setup_id TEXT;
ALTER TABLE research_jobs ADD COLUMN ref TEXT;
ALTER TABLE research_jobs ADD COLUMN commit_sha TEXT;
ALTER TABLE research_jobs ADD COLUMN progress INTEGER;
ALTER TABLE research_jobs ADD COLUMN log_tail TEXT;
ALTER TABLE research_jobs ADD COLUMN ingest_lock TEXT;

-- The cron's idle read: nothing running means this index is empty.
CREATE INDEX research_idx_jobs_active ON research_jobs (created_at)
  WHERE via_runner = 1 AND state IN ('queued', 'running');

-- A Run finds its setup by (kind, path): one setup per repo path (Architect, 2026-10-06).
CREATE UNIQUE INDEX research_ux_setups_kind_repo_path ON research_setups (kind, repo, path);
