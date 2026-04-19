CREATE TABLE IF NOT EXISTS client_metadata (
  stripe_customer_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  hourly_rate_cents INTEGER,
  notes TEXT,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_metadata_archived ON client_metadata (archived_at);

CREATE TABLE IF NOT EXISTS auth_challenges (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges (expires_at);
