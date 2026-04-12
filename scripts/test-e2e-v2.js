#!/usr/bin/env node
/**
 * E2E test: selective KB retrieval vs old full-KB approach.
 * Shows token counts to prove savings.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const config = require('../src/config');
const ai = require('../src/services/ai');
const db = require('../src/services/database');

const QUERIES = [
  'Почему у меня так быстро закончились лимиты?',
  'Как отключить автопродление?',
  'Не могу войти через Яндекс, ошибка авторизации',
];

async function main() {
  // Old approach: full KB size
  const fullKB = config.supportChat.knowledgeBase;
  const systemPrompt = config.supportChat.systemPrompt;
  const oldSystemLen = (systemPrompt + fullKB).length;
  const oldTokens = Math.round(oldSystemLen / 2);
  console.log(`OLD approach: system prompt + full KB = ${oldSystemLen} chars ≈ ${oldTokens} tokens\n`);

  for (const query of QUERIES) {
    console.log(`${'='.repeat(60)}`);
    console.log(`QUERY: "${query}"`);

    const embedding = await ai.generateEmbedding(query);
    const [sections, cases] = await Promise.all([
      db.searchKbSections(embedding, 2, 0.50),
      db.searchSimilar(embedding, 3, null, 0.70),
    ]);

    // New approach size
    const sectionsText = sections.map(s => s.content).join('\n\n');
    const newSystemLen = systemPrompt.length + sectionsText.length;
    const newTokens = Math.round(newSystemLen / 2);
    const savings = Math.round((1 - newTokens / oldTokens) * 100);

    console.log(`  KB sections: ${sections.map(s => s.id).join(', ') || 'none'}`);
    console.log(`  Past cases: ${cases.length}`);
    console.log(`  NEW tokens: ≈${newTokens} (was ${oldTokens}, saved ${savings}%)`);

    // Actually call AI to verify quality
    let systemContent = systemPrompt.replace('{knowledge_base}', '');
    if (sectionsText) systemContent += '\n\nРЕЛЕВАНТНЫЕ РАЗДЕЛЫ:\n' + sectionsText;

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: query },
    ];

    const response = await ai.chatCompletion(
      config.openrouter.models.gemini,
      messages,
      { temperature: 0.4, maxTokens: 300 }
    );

    console.log(`  BOT: ${response.substring(0, 300)}\n`);
  }
}

main().catch(e => console.error(e));
