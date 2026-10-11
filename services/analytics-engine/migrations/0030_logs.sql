-- Logs (Bikram, 2026-10-11): each person's TradeEdge activity (SnapTrade, MCP, the app, backend),
-- shown on the app's Logs page. One row per event, sealed by the vault (src/vault.ts): only the
-- owner (`u_<hmac>`) and the time stay plain, for paging and the 30-day prune.
CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX logs_owner_at ON logs (owner, at);
