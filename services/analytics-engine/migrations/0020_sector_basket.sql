-- Sector and Basket (Bikram, 2026-10-09) replace generic labels (0018): his two jobs are tagging
-- symbols with a sector and holdings with a basket. Every label and label value is dropped; he
-- starts clean.
DROP TABLE label_values;
DROP TABLE labels;

-- A ticker's sector, shared by every holding of it and every option on it.
CREATE TABLE symbol_sectors (
  owner TEXT NOT NULL,
  symbol TEXT NOT NULL,
  sector TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner, symbol)
);

-- A holding's basket: one account's position (portfolio_id) in a ticker or OCC contract, or every
-- account's (portfolio_id ''), which one account's own row overrides.
CREATE TABLE position_baskets (
  owner TEXT NOT NULL,
  portfolio_id TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL,
  basket TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner, portfolio_id, symbol)
);
