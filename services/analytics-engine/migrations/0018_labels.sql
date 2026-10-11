-- Labels (Bikram, 2026-10-09): each person's own label keys for holdings, declared once with the
-- level they sit on: a symbol (sector: every position on that underlying, options too) or a position
-- (basket, strategy: one account's holding of one symbol or contract). Set by them or an agent
-- (label_write, label_value_write). Each key is a holdings field that views group and filter by.
CREATE TABLE labels (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('symbol', 'position')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner, key)
);

-- One label's value on a symbol (portfolio_id '') or on one position (portfolio_id + symbol).
CREATE TABLE label_values (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  portfolio_id TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner, key, portfolio_id, symbol)
);
