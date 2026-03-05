-- Sabka Support KB Bot — Database Schema
-- Run this in Supabase SQL Editor

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Main knowledge base table
CREATE TABLE support_kb (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  telegram_message_id BIGINT,
  telegram_user_id BIGINT,
  category TEXT NOT NULL DEFAULT 'прочее',
  full_dialog TEXT NOT NULL,
  summary_problem TEXT,
  summary_solution TEXT,
  embedding VECTOR(1536),
  last_synced_to_sheets TIMESTAMPTZ
);

-- Dynamic categories
CREATE TABLE kb_categories (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Categorization rules (from /change command)
CREATE TABLE kb_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  active BOOLEAN DEFAULT true
);

-- Seed default categories
INSERT INTO kb_categories (name, description) VALUES
  ('баги_фронтенд', 'Баги на фронтенде (UI, отображение)'),
  ('баги_бэкенд', 'Баги на бэкенде (API, сервер)'),
  ('частые_вопросы', 'Часто задаваемые вопросы'),
  ('лимиты_баланс', 'Вопросы по лимитам и балансу'),
  ('описание_моделей', 'Вопросы про модели и их функции'),
  ('прочее', 'Всё остальное');

-- Vector similarity search function
CREATE OR REPLACE FUNCTION search_kb(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 5,
  filter_category TEXT DEFAULT NULL,
  similarity_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  category TEXT,
  full_dialog TEXT,
  summary_problem TEXT,
  summary_solution TEXT,
  similarity FLOAT
)
LANGUAGE SQL AS $$
  SELECT id, category, full_dialog, summary_problem, summary_solution,
         1 - (embedding <=> query_embedding) AS similarity
  FROM support_kb
  WHERE embedding IS NOT NULL
    AND (filter_category IS NULL OR category = filter_category)
    AND (1 - (embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- HNSW index for vector search (works without training data, good for <1000 rows)
CREATE INDEX ON support_kb USING hnsw (embedding vector_cosine_ops);

-- AI Support Chat history
CREATE TABLE chat_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON chat_history (user_id, created_at);
