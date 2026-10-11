-- Replays are gone (Bikram, 2026-10-07): a strategy runs once per commit across all its dimensions,
-- and the strategy page shows those Results. One row per (strategy, commit). The curves stay in R2
-- under `curves_key`: rows moved from a replay keep their old key, new runs write
-- `results/<strategy>/<sha>/curves.json.gz`. Saved views and benchmarks belong to the strategy.
CREATE TABLE research_results (
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  commit_sha TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('running', 'done', 'failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  curves_key TEXT,
  bytes INTEGER,
  sha256 TEXT,
  first_date TEXT,
  last_date TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  PRIMARY KEY (strategy_id, commit_sha)
);
CREATE INDEX research_idx_results_latest ON research_results (strategy_id, archived, finished_at);

ALTER TABLE research_strategies ADD COLUMN views TEXT;
ALTER TABLE research_strategies ADD COLUMN benchmarks TEXT;

-- Live, finished replays move across. A replay with no commit lands as 'unknown', archived.
INSERT OR IGNORE INTO research_results
  (strategy_id, commit_sha, spec, status, progress, total, curves_key, bytes, sha256, first_date,
   last_date, archived, created_at, finished_at)
SELECT r.strategy_id, COALESCE(r.commit_sha, 'unknown'),
       json_remove(r.spec, '$.views', '$.benchmarks'), r.status, r.progress, r.total,
       CASE WHEN b.owner_id IS NULL THEN NULL ELSE 'replays/' || r.id || '/scenarios.json.gz' END,
       b.bytes, b.sha256, b.first_date, b.last_date,
       CASE WHEN r.commit_sha IS NULL THEN 1 ELSE 0 END, r.created_at, r.finished_at
FROM research_replays r
LEFT JOIN research_blobs b ON b.owner_kind = 'replay' AND b.owner_id = r.id AND b.kind = 'scenarios'
WHERE r.archived = 0 AND r.status = 'done'
ORDER BY r.finished_at DESC;

-- Saved views and benchmarks: every live replay's views, and the newest benchmark list.
UPDATE research_strategies SET
  views = (SELECT json_group_array(json(v.value)) FROM research_replays r, json_each(r.spec, '$.views') v
           WHERE r.strategy_id = research_strategies.id AND r.archived = 0),
  benchmarks = (SELECT json_extract(r.spec, '$.benchmarks') FROM research_replays r
                WHERE r.strategy_id = research_strategies.id AND r.archived = 0
                  AND json_extract(r.spec, '$.benchmarks') IS NOT NULL
                ORDER BY r.created_at DESC LIMIT 1);
UPDATE research_strategies SET views = NULL WHERE views = '[]';

-- Setups are gone too (Bikram, 2026-10-07): a strategy carries its repo, its folder in that repo,
-- its run settings (what its run.toml held) and, for the parked Research, its research manifests.
-- Each strategy takes them from its newest Replay setup (and its Research setups); the runner runs
-- `<folder>/run.toml` from now on.
ALTER TABLE research_strategies ADD COLUMN repo TEXT;
ALTER TABLE research_strategies ADD COLUMN folder TEXT;
ALTER TABLE research_strategies ADD COLUMN settings TEXT;
ALTER TABLE research_strategies ADD COLUMN research_specs TEXT;
INSERT OR IGNORE INTO research_strategies (id, name) SELECT DISTINCT strategy, strategy FROM research_setups;
UPDATE research_strategies SET
  repo = (SELECT s.repo FROM research_setups s WHERE s.strategy = research_strategies.id
          ORDER BY s.kind = 'replay' DESC, s.updated_at DESC LIMIT 1),
  folder = (SELECT CASE
              WHEN instr(s.path, '/replays/') > 0 THEN substr(s.path, 1, instr(s.path, '/replays/') - 1)
              WHEN instr(s.path, '/research/') > 0 THEN substr(s.path, 1, instr(s.path, '/research/') - 1)
              ELSE substr(s.path, 1, length(s.path) - length('/run.toml')) END
            FROM research_setups s WHERE s.strategy = research_strategies.id
            ORDER BY s.kind = 'replay' DESC, s.updated_at DESC LIMIT 1),
  settings = (SELECT s.body FROM research_setups s
              WHERE s.strategy = research_strategies.id AND s.kind = 'replay'
              ORDER BY s.updated_at DESC LIMIT 1),
  research_specs = (SELECT json_group_array(json_object('path', s.path, 'body', json(s.body)))
                    FROM research_setups s
                    WHERE s.strategy = research_strategies.id AND s.kind = 'research')
WHERE id IN (SELECT strategy FROM research_setups);
UPDATE research_strategies SET research_specs = NULL WHERE research_specs = '[]';

-- Jobs: a job runs a strategy (its results, or one of its research manifests); the old Replay
-- jobs go, and kind allows 'results' (SQLite can't change a CHECK in place).
CREATE TABLE research_jobs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('results', 'research')),
  manifest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  via_runner INTEGER NOT NULL DEFAULT 0 CHECK (via_runner IN (0, 1)),
  strategy_id TEXT,
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
SELECT j.id, j.kind, j.manifest, j.state, j.error, j.created_at, j.started_at, j.finished_at,
       j.via_runner, (SELECT s.strategy FROM research_setups s WHERE s.id = j.setup_id), j.ref,
       j.commit_sha, j.progress, j.log_tail, j.ingest_lock, j.reports_done, j.report_ids,
       j.engine_commit_sha
FROM research_jobs j WHERE j.kind = 'research';
DROP TABLE research_jobs;
ALTER TABLE research_jobs_new RENAME TO research_jobs;
CREATE INDEX research_idx_jobs_state ON research_jobs (state, created_at);
CREATE INDEX research_idx_jobs_manifest ON research_jobs (manifest, created_at);
CREATE INDEX research_idx_jobs_active ON research_jobs (created_at)
  WHERE via_runner = 1 AND state IN ('queued', 'running');
CREATE INDEX research_idx_jobs_strategy ON research_jobs (strategy_id, created_at);

DROP TABLE research_setups;
