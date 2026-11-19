-- Accounts (Google login) and synced preferences. Deleting an account deletes every row below for its user_id in
-- one batch (no soft delete). Email lives only in user_identities; identities are never linked by email.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free'
) WITHOUT ROWID;

CREATE TABLE user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  email TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
) WITHOUT ROWID;
CREATE INDEX idx_user_identities_user ON user_identities (user_id);

-- id = hex sha256 of the random session id in the cookie. expires_at is Unix seconds (absolute lifetime).
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE user_prefs (
  user_id TEXT NOT NULL REFERENCES users (id),
  key TEXT NOT NULL CHECK (key IN ('stars', 'event_filters', 'ask_calendar')),
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;

-- Billing placeholders: nothing writes these yet.
CREATE TABLE entitlements (
  user_id TEXT NOT NULL REFERENCES users (id),
  feature TEXT NOT NULL,
  source TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  PRIMARY KEY (user_id, feature, source)
) WITHOUT ROWID;

CREATE TABLE billing_customers (
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, customer_id)
) WITHOUT ROWID;
