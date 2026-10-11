-- One name per concept on ResearchDesk (Bikram, 2026-10-09): a strategy is now a Research, a Research
-- (Optuna search) is now an Experiment, and Results (one run per commit) are now Scenarios. Tables,
-- columns, indexes and the job kinds move with the names; no data changes.

-- Experiments first, so their research_id columns are free before researches take that name.
ALTER TABLE research_research RENAME TO research_experiments;
ALTER TABLE research_experiments RENAME COLUMN parent_research_id TO parent_experiment_id;
ALTER TABLE research_trials RENAME COLUMN research_id TO experiment_id;
ALTER TABLE research_candidates RENAME COLUMN research_id TO experiment_id;

ALTER TABLE research_strategies RENAME TO research_researches;
ALTER TABLE research_researches RENAME COLUMN research_specs TO experiment_specs;
-- Experiment manifests moved from <folder>/research/ to <folder>/experiments/ in bchoor/strategies.
UPDATE research_researches SET experiment_specs = REPLACE(experiment_specs, '/research/', '/experiments/')
  WHERE experiment_specs LIKE '%/research/%';
ALTER TABLE research_strategy_versions RENAME TO research_versions;
ALTER TABLE research_versions RENAME COLUMN strategy_id TO research_id;
ALTER TABLE research_results RENAME TO research_scenarios;
ALTER TABLE research_scenarios RENAME COLUMN strategy_id TO research_id;

DROP INDEX research_idx_candidates_research;
CREATE INDEX research_idx_candidates_experiment ON research_candidates (experiment_id);
DROP INDEX research_idx_research_version;
CREATE INDEX research_idx_experiments_version ON research_experiments (version_id);
DROP INDEX research_idx_results_latest;
CREATE INDEX research_idx_scenarios_latest ON research_scenarios (research_id, archived, finished_at);
DROP INDEX research_idx_strategy_versions_strategy;
CREATE INDEX research_idx_versions_research ON research_versions (research_id);
DROP INDEX research_ux_strategy_versions_sha;
CREATE UNIQUE INDEX research_ux_versions_sha ON research_versions (research_id, git_sha, engine_version);
DROP INDEX research_idx_trials_research_score;
CREATE INDEX research_idx_trials_experiment_score ON research_trials (experiment_id, robust_score);
DROP INDEX research_idx_trials_research_state_score;
CREATE INDEX research_idx_trials_experiment_state_score ON research_trials (experiment_id, state, robust_score);
DROP INDEX research_ux_trials_research_number;
CREATE UNIQUE INDEX research_ux_trials_experiment_number ON research_trials (experiment_id, number);

-- Job kinds 'results'/'research' become 'scenario'/'experiment' (SQLite can't change a CHECK in place).
CREATE TABLE research_jobs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scenario', 'experiment')),
  manifest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  via_runner INTEGER NOT NULL DEFAULT 0 CHECK (via_runner IN (0, 1)),
  research_id TEXT,
  ref TEXT,
  commit_sha TEXT,
  progress INTEGER,
  log_tail TEXT,
  ingest_lock TEXT,
  reports_done INTEGER NOT NULL DEFAULT 0,
  report_ids TEXT,
  engine_commit_sha TEXT
);
INSERT INTO research_jobs_new
SELECT id, CASE kind WHEN 'results' THEN 'scenario' ELSE 'experiment' END, manifest, state, error,
       created_at, started_at, finished_at, via_runner, strategy_id, ref, commit_sha, progress, log_tail,
       ingest_lock, reports_done, report_ids, engine_commit_sha
FROM research_jobs;
DROP TABLE research_jobs;
ALTER TABLE research_jobs_new RENAME TO research_jobs;
CREATE INDEX research_idx_jobs_active ON research_jobs (created_at)
  WHERE via_runner = 1 AND state IN ('queued', 'running');
CREATE INDEX research_idx_jobs_manifest ON research_jobs (manifest, created_at);
CREATE INDEX research_idx_jobs_state ON research_jobs (state, created_at);
CREATE INDEX research_idx_jobs_research ON research_jobs (research_id, created_at);
