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
  match_count INT DEFAULT 3,
  filter_category TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  category TEXT,
  full_dialog TEXT,
  summary_problem TEXT,
  summary_solution TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.category,
    s.full_dialog,
    s.summary_problem,
    s.summary_solution,
    1 - (s.embedding <=> query_embedding) AS similarity
  FROM support_kb s
  WHERE s.embedding IS NOT NULL
    AND (filter_category IS NULL OR s.category = filter_category)
  ORDER BY s.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- HNSW index for vector search (works without training data, good for <1000 rows)
CREATE INDEX ON support_kb USING hnsw (embedding vector_cosine_ops);
