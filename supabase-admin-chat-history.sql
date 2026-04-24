-- Admin AI-assistant chat history (Phase B)
-- Separate table from chat_history (customer flow) to keep admin context isolated.

CREATE TABLE IF NOT EXISTS admin_chat_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_chat_history_admin_id_created_at_idx
  ON admin_chat_history (admin_id, created_at DESC);
