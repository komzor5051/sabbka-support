#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const ai = require('../src/services/ai');
const db = require('../src/services/database');

async function main() {
  const query = 'Почему у меня так быстро закончились лимиты?';
  console.log(`Query: "${query}"\n`);

  const embedding = await ai.generateEmbedding(query);

  // Very low threshold to see what's there
  const results = await db.searchSimilar(embedding, 5, null, 0.3);
  console.log(`Results with threshold 0.3:`);
  for (const r of results) {
    const sim = (r.similarity * 100).toFixed(1);
    const prob = (r.summary_problem || '').substring(0, 100);
    console.log(`  [${sim}%] ${r.category} — ${prob}...`);
  }

  // Check what the embeddings look like — are they null?
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { count: withEmb } = await supabase
    .from('support_kb')
    .select('*', { count: 'exact', head: true })
    .not('embedding', 'is', null);
  const { count: total } = await supabase
    .from('support_kb')
    .select('*', { count: 'exact', head: true });
  console.log(`\nRecords with embeddings: ${withEmb}/${total}`);
}

main().catch(e => console.error(e));
