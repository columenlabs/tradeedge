-- X posts in TradeEdge (Bikram, 2026-10-12). Both tables hold sealed rows (src/vault.ts).
--
-- posts: one row per post a person's X integration fetched, kept 30 days, when TradeEdge runs
-- without DataEdge (self-host). With DataEdge (the suite) posts go to its x_posts dataset instead.
-- `id` is an HMAC of the post id in the person's vault, so the same post is stored once.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX posts_owner_at ON posts (owner, at);

-- schedules: each person's schedules (Check X in and outside market hours, Prune old posts), one
-- sealed document. `next_at` (ms, plain) is when the earliest one is due, so the every-minute cron
-- reads only the people with work; NULL when none is on.
CREATE TABLE schedules (
  owner TEXT PRIMARY KEY,
  next_at INTEGER,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX schedules_next_at ON schedules (next_at);
