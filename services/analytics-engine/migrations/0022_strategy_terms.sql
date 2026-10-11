-- StrategyDesk terms (Bikram, 2026-10-09): a strategy is the reusable structure (ex shape), a trade is a
-- saved concrete position (ex option strategy), and a strategy has screeners: a person's saved
-- screener_run inputs. No old names stay.
ALTER TABLE shapes RENAME TO strategies;

ALTER TABLE option_strategies RENAME TO trades;
DROP INDEX option_strategies_owner;
CREATE INDEX trades_owner ON trades (owner, underlying);
UPDATE trades SET id = 'tr_' || substr(id, 4) WHERE id LIKE 'os\_%' ESCAPE '\';

-- `inputs` is JSON: the screener_run inputs besides underlying and strategy (dte window, delta, width,
-- filters, ...), see screenerInputShape in src/desks/strategydesk/screeners.ts.
CREATE TABLE screeners (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  strategy_id TEXT NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  underlying TEXT NOT NULL,
  inputs TEXT NOT NULL,
  written_by TEXT NOT NULL CHECK (written_by IN ('agent', 'person')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner, strategy_id, name)
);
CREATE INDEX screeners_owner ON screeners (owner, strategy_id);
