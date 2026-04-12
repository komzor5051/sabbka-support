-- KB Sections: selective retrieval instead of full KB in every prompt
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)

CREATE TABLE IF NOT EXISTS kb_sections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kb_sections_embedding_idx
  ON kb_sections USING hnsw (embedding vector_cosine_ops);

-- Search function for KB sections (similar to search_kb but for sections)
CREATE OR REPLACE FUNCTION search_kb_sections(
  query_embedding VECTOR(1536),
  match_count INT DEFAULT 3,
  similarity_threshold FLOAT DEFAULT 0.50
)
RETURNS TABLE (
  id TEXT,
  title TEXT,
  content TEXT,
  similarity FLOAT
)
LANGUAGE SQL AS $$
  SELECT id, title, content,
         1 - (embedding <=> query_embedding) AS similarity
  FROM kb_sections
  WHERE embedding IS NOT NULL
    AND (1 - (embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
