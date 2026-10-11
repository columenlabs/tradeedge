-- Explorer views (Bikram, 2026-10-07): a named table of daily rows whose columns are formulas over
-- market data. D1 holds only the definition; the rows are computed live in ClickHouse on every open
-- and never stored. Written from the Explorer page or the research MCP (explorer_view_*).
CREATE TABLE research_explorer_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  range TEXT NOT NULL,
  columns TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
