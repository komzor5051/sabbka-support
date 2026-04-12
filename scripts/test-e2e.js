#!/usr/bin/env node
/**
 * End-to-end test: simulate what support-chat.js does.
 * Builds system prompt + KB + similar cases + user message, calls AI.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const config = require('../src/config');
const ai = require('../src/services/ai');
const db = require('../src/services/database');

const TEST_QUERIES = [
  'Здравствуйте, у меня быстро закончились лимиты, почему так?',
  'Как отключить автопродление?',
  'Хочу вернуть деньги, как это сделать?',
];

async function main() {
  const kb = config.supportChat.knowledgeBase;
  const sysPrompt = config.supportChat.systemPrompt.replace('{knowledge_base}', kb);

  for (const query of TEST_QUERIES) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`USER: "${query}"`);
    console.log('='.repeat(60));

    // Retrieve similar cases
    const embedding = await ai.generateEmbedding(query);
    const cases = await db.searchSimilar(embedding, 3, null, 0.55);

    let systemContent = sysPrompt;
    if (cases.length > 0) {
      const casesBlock = cases.map((c, i) => {
        const sim = Math.round(c.similarity * 100);
        return `Кейс ${i + 1} (${sim}%):\nПроблема: ${c.summary_problem}\nРешение: ${c.summary_solution}`;
      }).join('\n\n');
      systemContent += `\n\n---\nПОХОЖИЕ ПРОШЛЫЕ КЕЙСЫ (используй как референс, НЕ цитируй дословно):\n${casesBlock}\n---`;
      console.log(`\n  [Retriever] ${cases.length} cases injected (top: ${Math.round(cases[0].similarity * 100)}%)`);
    } else {
      console.log(`\n  [Retriever] no cases found`);
    }

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: query },
    ];

    const response = await ai.chatCompletion(
      config.openrouter.models.gemini,
      messages,
      { temperature: 0.4, maxTokens: 300 }
    );

    console.log(`\n  BOT: ${response.substring(0, 500)}`);
  }
}

main().catch(e => console.error(e));
