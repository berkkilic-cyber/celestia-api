-- migrations/004_user_profile_and_devices.sql
-- Run with: wrangler d1 execute celestia-db --remote --file=004_user_profile_and_devices.sql

ALTER TABLE users ADD COLUMN latitude REAL DEFAULT NULL;
ALTER TABLE users ADD COLUMN longitude REAL DEFAULT NULL;
ALTER TABLE users ADD COLUMN sun_sign TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN moon_sign TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN rising_sign TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
