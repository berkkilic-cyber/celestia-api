-- migrations/003_add_is_guest.sql
-- Run with: wrangler d1 execute celestia-db --file=003_add_is_guest.sql

ALTER TABLE users ADD COLUMN is_guest INTEGER DEFAULT 0;
