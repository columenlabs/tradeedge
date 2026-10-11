-- Integrations (Bikram, 2026-10-10): each person's own SnapTrade and Alpaca keys, sealed by the vault
-- (src/vault.ts). One row per person and provider.
CREATE TABLE integrations (
  owner TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- SnapTrade only: the random id in the person's webhook URL, so SnapTrade's call finds its owner.
  hook_id TEXT UNIQUE,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (owner, provider)
);

-- Tax lots per account, sealed: the broker's (synced from SnapTrade) or the person's own (manual
-- accounts). An account without a row takes its lots from its transactions, first-in first-out.
CREATE TABLE portfolio_lots (
  portfolio_id TEXT PRIMARY KEY REFERENCES portfolios (id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  version INTEGER NOT NULL
);
