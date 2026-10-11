-- Strategy lab (Bikram, 2026-10-10; design: project file strategy-lab/proposal.md). A variant is a
-- name plus values for some of a research's knobs (the rest stay at their strategy.py defaults); it is
-- what runs, and its tape is one full-history run at a commit, a gzip JSON in R2 at `tape_key`
-- (results/<research>/<sha>/<variant>.json.gz). Pins are per research. `knobs` is the knob menu the
-- newest tape reported (labels, groups, defaults), so variant values can be checked; `code_sha` is the
-- newest commit touching the research's folder that the Worker has queued variants for.
ALTER TABLE research_researches ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
ALTER TABLE research_researches ADD COLUMN tags TEXT;
ALTER TABLE research_researches ADD COLUMN knobs TEXT;
ALTER TABLE research_researches ADD COLUMN code_sha TEXT;

CREATE TABLE research_variants (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES research_researches(id),
  name TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (research_id, name)
);

-- One tape per variant per commit; a re-run at the same commit replaces it. `values_json` is what it
-- ran with (the variant may have changed since); `metrics` its full-history numbers, worked out by
-- the Worker from the tape when it lands.
CREATE TABLE research_tapes (
  variant_id TEXT NOT NULL REFERENCES research_variants(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  values_json TEXT NOT NULL DEFAULT '{}',
  path_dependent INTEGER NOT NULL DEFAULT 0 CHECK (path_dependent IN (0, 1)),
  tape_key TEXT,
  bytes INTEGER,
  sha256 TEXT,
  first_date TEXT,
  last_date TEXT,
  metrics TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  PRIMARY KEY (variant_id, commit_sha)
);
CREATE INDEX research_idx_tapes_latest ON research_tapes (variant_id, status, finished_at);

-- Jobs gain kind 'variant' (runs one variant's tape) and the variant it runs (SQLite can't change a
-- CHECK in place).
CREATE TABLE research_jobs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scenario', 'experiment', 'variant')),
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
  engine_commit_sha TEXT,
  variant_id TEXT
);
INSERT INTO research_jobs_new (id, kind, manifest, state, error, created_at, started_at, finished_at,
  via_runner, research_id, ref, commit_sha, progress, log_tail, ingest_lock, reports_done, report_ids,
  engine_commit_sha)
SELECT id, kind, manifest, state, error, created_at, started_at, finished_at, via_runner, research_id,
  ref, commit_sha, progress, log_tail, ingest_lock, reports_done, report_ids, engine_commit_sha
FROM research_jobs;
DROP TABLE research_jobs;
ALTER TABLE research_jobs_new RENAME TO research_jobs;
CREATE INDEX research_idx_jobs_active ON research_jobs (created_at)
  WHERE via_runner = 1 AND state IN ('queued', 'running');
CREATE INDEX research_idx_jobs_manifest ON research_jobs (manifest, created_at);
CREATE INDEX research_idx_jobs_state ON research_jobs (state, created_at);
CREATE INDEX research_idx_jobs_research ON research_jobs (research_id, created_at);
CREATE INDEX research_idx_jobs_variant ON research_jobs (variant_id, created_at);

-- Every runnable research gets its Default variant (every knob at its default).
INSERT INTO research_variants (id, research_id, name)
SELECT lower(hex(randomblob(16))), id, 'Default' FROM research_researches
WHERE archived = 0 AND repo IS NOT NULL AND folder IS NOT NULL;

-- 9-sig's scenario grid cells (rules x ballast in its run.toml) become variants; rules as written
-- with bonds is its Default.
INSERT INTO research_variants (id, research_id, name, values_json)
SELECT lower(hex(randomblob(16))), v.research_id, v.name, v.values_json FROM (
  SELECT 'nine_sig' AS research_id, '' AS name, '' AS values_json WHERE 0
  UNION ALL VALUES
  ('nine_sig', 'Kelly''s rules as written · AGG 50%, gold 50%', '{"ballast_weights": {"AGG": 0.5, "GLD": 0.5}}'),
  ('nine_sig', 'Kelly''s rules as written · Gold 100%', '{"ballast_weights": {"GLD": 1.0}}'),
  ('nine_sig', 'Without the 30 down rule · Bonds 100% (JAAA, AGG before)', '{"thirty_down": false}'),
  ('nine_sig', 'Without the 30 down rule · AGG 50%, gold 50%', '{"thirty_down": false, "ballast_weights": {"AGG": 0.5, "GLD": 0.5}}'),
  ('nine_sig', 'Without the 30 down rule · Gold 100%', '{"thirty_down": false, "ballast_weights": {"GLD": 1.0}}'),
  ('nine_sig', 'Without the spike reset · Bonds 100% (JAAA, AGG before)', '{"spike_reset": false}'),
  ('nine_sig', 'Without the spike reset · AGG 50%, gold 50%', '{"spike_reset": false, "ballast_weights": {"AGG": 0.5, "GLD": 0.5}}'),
  ('nine_sig', 'Without the spike reset · Gold 100%', '{"spike_reset": false, "ballast_weights": {"GLD": 1.0}}'),
  ('nine_sig', 'Without the resets · Bonds 100% (JAAA, AGG before)', '{"spike_reset": false, "bond_reset": false}'),
  ('nine_sig', 'Without the resets · AGG 50%, gold 50%', '{"spike_reset": false, "bond_reset": false, "ballast_weights": {"AGG": 0.5, "GLD": 0.5}}'),
  ('nine_sig', 'Without the resets · Gold 100%', '{"spike_reset": false, "bond_reset": false, "ballast_weights": {"GLD": 1.0}}')
) v WHERE EXISTS (SELECT 1 FROM research_researches r WHERE r.id = v.research_id);
-- Pinned so they run nightly and show in the sidebar.
UPDATE research_researches SET pinned = 1 WHERE id = 'nine_sig';
