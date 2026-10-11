-- Portfolios (Bikram, 2026-10-08): each signed-in user's holdings, written by agents through the
-- strategy MCP (portfolio_write replaces the whole snapshot). Auto-import from a broker comes later.
CREATE TABLE portfolios (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  cash REAL NOT NULL DEFAULT 0,
  as_of TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner, name)
);

-- One row per holding. `symbol` is the ticker for stock, the OCC symbol for an option.
-- Quantity is shares or contracts; negative means short.
CREATE TABLE portfolio_positions (
  portfolio_id TEXT NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiration INTEGER,
  strike REAL,
  "right" TEXT CHECK ("right" IN ('C', 'P')),
  quantity REAL NOT NULL,
  avg_cost REAL,
  PRIMARY KEY (portfolio_id, symbol)
);
