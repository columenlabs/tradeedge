-- Retire the Look (Bikram, 2026-10-06): no look counter, no holdout runs. 0003 is already
-- deployed, so this drops what it created. The stored blob kind `scenarios` stays as it is.
DROP INDEX IF EXISTS research_idx_holdout_trial;
DROP INDEX IF EXISTS research_idx_holdout_strategy;
DROP INDEX IF EXISTS research_idx_holdout_research;
DROP TABLE IF EXISTS research_holdout_runs;

-- research_blobs: owner_kind no longer allows 'holdout'. SQLite can't alter a CHECK, so rebuild.
DELETE FROM research_blobs WHERE owner_kind = 'holdout';
CREATE TABLE research_blobs_new (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('trial', 'strategy', 'replay')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'trades', 'tod', 'scenarios')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  first_date TEXT NOT NULL,
  last_date TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_kind, owner_id, kind)
);
INSERT INTO research_blobs_new SELECT owner_kind, owner_id, kind, bytes, sha256, first_date, last_date, uploaded_at FROM research_blobs;
DROP TABLE research_blobs;
ALTER TABLE research_blobs_new RENAME TO research_blobs;
