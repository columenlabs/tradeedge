-- Admin console "Mark handled" on market issues it can't fix (IBKR series, loaded by hand).
-- One row per (symbol, kind). The mark lapses when the issue grows past `latest` / `count`.
CREATE TABLE admin_handled (
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  latest TEXT NOT NULL,
  count INTEGER NOT NULL,
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (symbol, kind)
);
