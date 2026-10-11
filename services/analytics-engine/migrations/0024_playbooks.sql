-- One model on ResearchDesk (Bikram, 2026-10-10; plan: project file playbook-unify/plan.md). A
-- Research and a Playbook were the same row; the Playbook name wins. Its Analysis (run.toml),
-- Scenarios and Timelines go: variants and their tapes do that job. Tables, columns and indexes
-- move to the playbook name; no other data changes.

-- Scenarios and timelines go (9-sig's 4 scenarios are covered by its variants; their R2 curves
-- files are deleted with this change), and so do the Analysis layouts and run settings.
DROP TABLE research_scenarios;
DROP TABLE research_timelines;
ALTER TABLE research_researches DROP COLUMN views;
ALTER TABLE research_researches DROP COLUMN settings;

ALTER TABLE research_researches RENAME TO playbooks;
ALTER TABLE research_versions RENAME TO playbook_versions;
ALTER TABLE playbook_versions RENAME COLUMN research_id TO playbook_id;
ALTER TABLE research_variants RENAME TO playbook_variants;
ALTER TABLE playbook_variants RENAME COLUMN research_id TO playbook_id;
ALTER TABLE research_tapes RENAME TO playbook_tapes;
ALTER TABLE research_experiments RENAME TO playbook_experiments;
ALTER TABLE research_trials RENAME TO playbook_trials;
ALTER TABLE research_trial_folds RENAME TO playbook_trial_folds;
ALTER TABLE research_candidates RENAME TO playbook_candidates;
ALTER TABLE research_blobs RENAME TO playbook_blobs;
ALTER TABLE research_repo_links RENAME TO playbook_repo_links;

DROP INDEX research_idx_candidates_experiment;
CREATE INDEX playbook_idx_candidates_experiment ON playbook_candidates (experiment_id);
DROP INDEX research_idx_experiments_version;
CREATE INDEX playbook_idx_experiments_version ON playbook_experiments (version_id);
DROP INDEX research_idx_versions_research;
CREATE INDEX playbook_idx_versions_playbook ON playbook_versions (playbook_id);
DROP INDEX research_ux_versions_sha;
CREATE UNIQUE INDEX playbook_ux_versions_sha ON playbook_versions (playbook_id, git_sha, engine_version);
DROP INDEX research_idx_trials_experiment_score;
CREATE INDEX playbook_idx_trials_experiment_score ON playbook_trials (experiment_id, robust_score);
DROP INDEX research_idx_trials_experiment_state_score;
CREATE INDEX playbook_idx_trials_experiment_state_score ON playbook_trials (experiment_id, state, robust_score);
DROP INDEX research_ux_trials_experiment_number;
CREATE UNIQUE INDEX playbook_ux_trials_experiment_number ON playbook_trials (experiment_id, number);
DROP INDEX research_idx_tapes_latest;
CREATE INDEX playbook_idx_tapes_latest ON playbook_tapes (variant_id, status, finished_at);
DROP INDEX research_repo_links_installation;
CREATE INDEX playbook_repo_links_installation ON playbook_repo_links (installation_id);

-- Jobs lose kind 'scenario' (and its rows) and name their playbook (SQLite can't change a CHECK in
-- place).
CREATE TABLE playbook_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('experiment', 'variant')),
  manifest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  via_runner INTEGER NOT NULL DEFAULT 0 CHECK (via_runner IN (0, 1)),
  playbook_id TEXT,
  ref TEXT,
  commit_sha TEXT,
  progress INTEGER,
  log_tail TEXT,
  ingest_lock TEXT,
  reports_done INTEGER NOT NULL DEFAULT 0,
  report_ids TEXT,
  engine_commit_sha TEXT,
  variant_id TEXT
);
INSERT INTO playbook_jobs (id, kind, manifest, state, error, created_at, started_at, finished_at,
  via_runner, playbook_id, ref, commit_sha, progress, log_tail, ingest_lock, reports_done, report_ids,
  engine_commit_sha, variant_id)
SELECT id, kind, manifest, state, error, created_at, started_at, finished_at, via_runner, research_id,
  ref, commit_sha, progress, log_tail, ingest_lock, reports_done, report_ids, engine_commit_sha,
  variant_id
FROM research_jobs WHERE kind <> 'scenario';
DROP TABLE research_jobs;
CREATE INDEX playbook_idx_jobs_active ON playbook_jobs (created_at)
  WHERE via_runner = 1 AND state IN ('queued', 'running');
CREATE INDEX playbook_idx_jobs_manifest ON playbook_jobs (manifest, created_at);
CREATE INDEX playbook_idx_jobs_state ON playbook_jobs (state, created_at);
CREATE INDEX playbook_idx_jobs_playbook ON playbook_jobs (playbook_id, created_at);
CREATE INDEX playbook_idx_jobs_variant ON playbook_jobs (variant_id, created_at);

-- ORB (retired, no folder) stays as an archived playbook.
UPDATE playbooks SET archived = 1 WHERE id = 'orb';
