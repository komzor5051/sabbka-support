-- Phase E: multi-platform support (TG + MAX messenger)
-- Adds `platform` column to 3 tables. Existing rows auto-become 'tg'.
-- Safe: no data migration, brief metadata-only lock.

-- 1. chat_history — customer conversation history
ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'tg';

DROP INDEX IF EXISTS chat_history_user_id_created_at_idx;
CREATE INDEX IF NOT EXISTS chat_history_platform_user_id_created_at_idx
  ON chat_history (platform, user_id, created_at DESC);

-- 2. escalations — per-platform routing for operator replies
ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'tg';

-- 3. dialog_buffer — in-flight dialog tracking
ALTER TABLE dialog_buffer
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'tg';

DROP INDEX IF EXISTS dialog_buffer_user_id_created_at_idx;
CREATE INDEX IF NOT EXISTS dialog_buffer_platform_user_id_created_at_idx
  ON dialog_buffer (platform, user_id, created_at DESC);

-- admin_chat_history intentionally NOT touched — admin is single-user,
-- no need for platform column there.
