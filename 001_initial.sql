-- migrations/001_initial.sql
-- Run with: wrangler d1 execute celestia-db --file=migrations/001_initial.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  apple_user_id TEXT UNIQUE,
  google_user_id TEXT UNIQUE,
  email TEXT,
  name TEXT,
  birth_date TEXT,
  birth_time TEXT,
  birth_place TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY,
  balance INTEGER DEFAULT 5,
  daily_spent INTEGER DEFAULT 0,
  daily_reset_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  apple_original_transaction_id TEXT,
  current_period_start INTEGER,
  current_period_end INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS iap_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  credits_granted INTEGER NOT NULL,
  apple_transaction_id TEXT UNIQUE,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_apple ON users(apple_user_id);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
