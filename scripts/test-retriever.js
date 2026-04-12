#!/usr/bin/env node
/**
 * Test vector retrieval: send a few typical user questions,
 * see what cases come back.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const ai = require('../src/services/ai');
const db = require('../src/services/database');

const TEST_QUERIES = [
  'Почему у меня так быстро закончились лимиты?',
  'Как отключить автопродление подписки?',
  'Не могу войти в аккаунт, ошибка авторизации',
  'Сколько стоит генерация картинок?',
  'Как сделать возврат денег?',
];

async function main() {
  for (const query of TEST_QUERIES) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`QUERY: "${query}"`);
    console.log('='.repeat(60));

    const embedding = await ai.generateEmbedding(query);
    const results = await db.searchSimilar(embedding, 3, null, 0.70);

    if (results.length === 0) {
      console.log('  (no results above threshold 0.70)');
      continue;
    }

    for (const r of results) {
      const sim = Math.round(r.similarity * 100);
      const prob = (r.summary_problem || '').substring(0, 120);
      const sol = (r.summary_solution || '').substring(0, 120);
      console.log(`\n  [${sim}%] ${r.category}`);
      console.log(`  Problem: ${prob}...`);
      console.log(`  Solution: ${sol}...`);
    }
  }
}

main().catch(e => console.error(e));
