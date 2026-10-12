-- Autopilot (Bikram, 2026-10-12): baskets become real objects. A basket (name, target weights,
-- rebalance rule, Mode) holds one sleeve per account (share counts + cash); orders it proposes wait
-- in a queue. Every row is sealed by the vault (src/vault.ts); only owners, ids and times stay plain.
-- Today's `position_baskets` tags turn into baskets with sleeves on each person's first read (the
-- tags are sealed, so SQL can't move them); the table is dropped once it is empty.

CREATE TABLE baskets (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name_key TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  UNIQUE (owner, name_key)
);

-- One basket's part in one account: shares per symbol and its own cash.
CREATE TABLE basket_sleeves (
  basket_id TEXT NOT NULL REFERENCES baskets (id) ON DELETE CASCADE,
  portfolio_id TEXT NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (basket_id, portfolio_id)
);

-- Orders outlive their basket in Order history, so no foreign key.
CREATE TABLE basket_orders (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX basket_orders_owner_at ON basket_orders (owner, at);
