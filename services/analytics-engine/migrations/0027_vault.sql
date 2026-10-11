-- Vault (Bikram, 2026-10-10): every per-user row is sealed with the owner's data key (src/vault.ts),
-- so reading D1 shows nothing useful. Owners are `u_<hmac>`, never an email. Lookup columns
-- (`name_key`, `bucket`) are HMACs under the owner's key. The plain-text tables go: Bikram had their
-- rows wiped first (2026-10-10), and nothing is carried over.

CREATE TABLE vaults (
  owner TEXT PRIMARY KEY,
  -- The owner's data key, wrapped with the master key (Secrets Store EDGEDESK_VAULT_KEK).
  data_key TEXT NOT NULL
);

DROP TABLE portfolio_positions;
DROP TABLE portfolio_transactions;
DROP TABLE portfolios;

-- One row per account: name, tax type, broker, cash, as-of and the positions snapshot, sealed.
CREATE TABLE portfolios (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name_key TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (owner, name_key)
);

-- One row per account and trade month (`bucket` = HMAC of YYYY-MM): that month's transactions, sealed.
CREATE TABLE portfolio_transactions (
  portfolio_id TEXT NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (portfolio_id, bucket)
);

DROP TABLE trades;
CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name_key TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (owner, name_key)
);

-- `strategy_id` stays plain: it names a shared strategy and deletes its screeners with it.
DROP TABLE screeners;
CREATE TABLE screeners (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  strategy_id TEXT NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  name_key TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (owner, name_key)
);

-- One sealed document per owner each.
DROP TABLE watchlist;
CREATE TABLE watchlist (owner TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL);
DROP TABLE symbol_sectors;
CREATE TABLE symbol_sectors (owner TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL);
DROP TABLE position_baskets;
CREATE TABLE position_baskets (owner TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL);
DROP TABLE fund_follows;
CREATE TABLE fund_follows (owner TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL);

-- A person's own views: `name` and `config` are sealed from now on. Shared views (owner NULL) stay plain.
DELETE FROM custom_views WHERE owner IS NOT NULL;
