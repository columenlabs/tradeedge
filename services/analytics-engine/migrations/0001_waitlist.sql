-- Waitlist for the invite-only beta. One row per email (lowercased).
-- status: pending → confirmed (email verified) → invited (approved, invite sent) → redeemed.
-- Tokens are stored as SHA-256 hex; the raw values only ever exist in the emails.
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  frequency TEXT,
  instruments TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  referral TEXT,
  updates INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  confirm_hash TEXT,
  confirm_expires TEXT,
  invite_hash TEXT,
  invite_expires TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  invited_at TEXT,
  redeemed_at TEXT
);

CREATE INDEX waitlist_status ON waitlist (status, created_at);
CREATE INDEX waitlist_confirm ON waitlist (confirm_hash);
CREATE INDEX waitlist_invite ON waitlist (invite_hash);
