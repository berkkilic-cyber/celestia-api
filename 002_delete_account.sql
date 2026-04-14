-- migrations/002_delete_account.sql
-- Run with: wrangler d1 execute celestia-db --file=002_delete_account.sql

ALTER TABLE users ADD COLUMN delete_scheduled_at INTEGER DEFAULT NULL;
