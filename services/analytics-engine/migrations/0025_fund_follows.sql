-- ResearchDesk Funds (Bikram, 2026-10-10): who follows (★) which 13F filer. One set per signed-in
-- person (owner = Access email, lowercase). The filings themselves stay in ClickHouse.
CREATE TABLE fund_follows (
  owner TEXT NOT NULL,
  cik INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (owner, cik)
);
