-- Agent feedback (Bikram, 2026-10-08): agents open feedback through any desk's MCP (feedback_*).
-- Each item is a GitHub issue in columenlabs/edgedesk (label `feedback`), the conversation of record;
-- this table holds who owns it and whether a reply waits. Owner = the Access identity (email, or
-- `token:<client id>`), so one agent never sees another's items.
CREATE TABLE feedback (
  number INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  desk TEXT NOT NULL,
  tool TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  -- open, go, needs-info, ready-to-test or closed: the issue's state and labels, kept by the GitHub hook.
  status TEXT NOT NULL DEFAULT 'open',
  -- 1 when a reply or status change waits for the owner; feedback_read clears it.
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The reply footer counts (owner, unread) on every MCP call.
CREATE INDEX feedback_owner_unread ON feedback (owner, unread);
