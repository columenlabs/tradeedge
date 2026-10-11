-- Setups: what a harness runs (docs/plan/desks-migration.md step 5). A setup names its strategy's
-- repo and path; `body` is the setup JSON (today's research/*.toml and replays/*.toml content).
-- Each research and replay records the strategy commit it ran at; trials inherit it from their research.
CREATE TABLE research_setups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('replay', 'research')),
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX research_setups_strategy ON research_setups (strategy, kind);

ALTER TABLE research_research ADD COLUMN commit_sha TEXT;
ALTER TABLE research_replays ADD COLUMN commit_sha TEXT;
