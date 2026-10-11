-- researchdesk (was bchoor/investordesk D1): one squashed migration, every table prefixed research_
-- (docs/plan/desks-migration.md step 3). Replaces investordesk migrations 0001..0011; the data copy
-- (step 4) maps old table names to these. `blobs.kind = 'scenarios'` keeps its old name (R2 key rename waits).
CREATE TABLE research_strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)));

CREATE TABLE research_strategy_versions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  label TEXT NOT NULL,
  git_sha TEXT,
  param_schema TEXT,
  engine_version TEXT,
  changelog TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE research_research (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES research_strategy_versions(id),
  symbols TEXT,
  search_space TEXT,
  objective TEXT,
  dd_cap REAL,
  costs TEXT,
  folds TEXT,
  budget INTEGER,
  sampler TEXT,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','ready','running','done','failed','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0,
  best_trial_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
, parent_research_id TEXT REFERENCES research_research(id), proposed_by TEXT CHECK (proposed_by IN ('user', 'engine', 'agent')), proposal TEXT, agent_cost_usd REAL, data_snapshot TEXT, fold_order TEXT, status_note TEXT, pruned_count INTEGER NOT NULL DEFAULT 0, neighbour_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)));

CREATE TABLE research_trials (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES research_research(id),
  number INTEGER NOT NULL,
  params TEXT,
  robust_score REAL,
  is_sharpe REAL,
  dsr REAL,
  fragile INTEGER NOT NULL DEFAULT 0,
  gates_passed INTEGER NOT NULL DEFAULT 0,
  metrics TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, state TEXT NOT NULL DEFAULT 'complete'
  CHECK (state IN ('complete', 'pruned', 'failed')), kind TEXT NOT NULL DEFAULT 'search'
  CHECK (kind IN ('search', 'seed', 'neighbour')), median_sharpe REAL, worst_sharpe REAL);

CREATE TABLE research_trial_folds (
  trial_id TEXT NOT NULL REFERENCES research_trials(id),
  fold INTEGER NOT NULL CHECK (fold >= 1),
  sharpe REAL,
  cagr REAL,
  max_dd REAL,
  trades INTEGER,
  win_rate REAL,
  profit_factor REAL,
  exposure REAL, start_date TEXT, end_date TEXT,
  PRIMARY KEY (trial_id, fold)
);

CREATE TABLE research_candidates (
  trial_id TEXT PRIMARY KEY REFERENCES research_trials(id),
  research_id TEXT NOT NULL REFERENCES research_research(id),
  note TEXT,
  promoted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE research_holdout_runs (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES research_trials(id),
  research_id TEXT NOT NULL REFERENCES research_research(id),
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  look_number INTEGER NOT NULL CHECK (look_number >= 1),
  -- A look is reserved BEFORE the engine reads any 2026 data and counts from then on,
  -- whether or not results are ever attached.
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','complete')),
  metrics TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (strategy_id, look_number)
);

CREATE TABLE research_replays (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  version_id TEXT REFERENCES research_strategy_versions(id),
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  source_trial_id TEXT REFERENCES research_trials(id),
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('proposed', 'running', 'done', 'failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE research_blobs (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('trial', 'holdout', 'strategy', 'replay')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'trades', 'tod', 'scenarios')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  first_date TEXT NOT NULL,
  last_date TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_kind, owner_id, kind)
);

CREATE TABLE research_timelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE research_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('replay', 'research')),
  manifest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX research_idx_strategy_versions_strategy ON research_strategy_versions(strategy_id);

CREATE INDEX research_idx_holdout_trial ON research_holdout_runs(trial_id);

CREATE INDEX research_idx_holdout_strategy ON research_holdout_runs(strategy_id);

CREATE UNIQUE INDEX research_ux_strategy_versions_sha
  ON research_strategy_versions(strategy_id, git_sha, engine_version);

CREATE INDEX research_idx_replays_strategy ON research_replays(strategy_id, archived);

CREATE INDEX research_idx_research_version ON research_research(version_id);

CREATE INDEX research_idx_trials_research_score ON research_trials(research_id, robust_score);

CREATE UNIQUE INDEX research_ux_trials_research_number ON research_trials(research_id, number);

CREATE INDEX research_idx_trials_research_state_score ON research_trials(research_id, state, robust_score);

CREATE INDEX research_idx_candidates_research ON research_candidates(research_id);

CREATE INDEX research_idx_holdout_research ON research_holdout_runs(research_id);

CREATE INDEX research_idx_jobs_state ON research_jobs (state, created_at);

CREATE INDEX research_idx_jobs_manifest ON research_jobs (manifest, created_at);

INSERT INTO research_timelines (id, name, start_date, end_date) VALUES
  ('from-2016', 'From 2016', '2016-01-04', NULL),
  ('from-2018', 'From 2018', '2018-01-02', NULL),
  ('pre-covid-2020', 'Pre-COVID 2020', '2020-01-02', NULL),
  ('from-2022', 'From 2022', '2022-01-03', NULL),
  ('train-only', 'Train only (to 2025)', '2016-01-04', '2025-12-31');
