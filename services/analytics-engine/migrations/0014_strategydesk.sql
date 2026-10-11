-- StrategyDesk (Bikram, 2026-10-08): saved option strategies, the live-chain watchlist, and
-- portfolio accounts with their transactions. Every row belongs to one signed-in owner.

-- A portfolio is one brokerage account. Retirement accounts (IRA, 401k) group apart from taxable ones.
ALTER TABLE portfolios ADD COLUMN tax_type TEXT NOT NULL DEFAULT 'taxable'
  CHECK (tax_type IN ('taxable', 'retirement'));
ALTER TABLE portfolios ADD COLUMN broker TEXT;

-- Option strategies the agent or the person builds. `legs` is JSON: [{action, instrument, strike,
-- expiration, qty, price}], the same leg shape as strategy_evaluate plus the entry price per share.
CREATE TABLE option_strategies (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  underlying TEXT NOT NULL,
  name TEXT NOT NULL,
  legs TEXT NOT NULL,
  note TEXT,
  written_by TEXT NOT NULL CHECK (written_by IN ('agent', 'person')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner, underlying, name)
);
CREATE INDEX option_strategies_owner ON option_strategies (owner, underlying);

-- Underlyings on the live-chain watchlist, in the order they were added.
CREATE TABLE watchlist (
  owner TEXT NOT NULL,
  symbol TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner, symbol)
);

-- Account history. `external_id` is the broker's id for the row, so uploading the same export again
-- updates rows instead of adding them. Tax lots are derived from buys and sells (FIFO).
CREATE TABLE portfolio_transactions (
  portfolio_id TEXT NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('buy', 'sell', 'dividend', 'interest', 'fee', 'deposit', 'withdrawal')),
  symbol TEXT,
  underlying TEXT,
  expiration INTEGER,
  strike REAL,
  "right" TEXT CHECK ("right" IN ('C', 'P')),
  quantity REAL,
  price REAL,
  fees REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL,
  PRIMARY KEY (portfolio_id, external_id)
);
CREATE INDEX portfolio_transactions_symbol ON portfolio_transactions (portfolio_id, symbol, trade_date);
