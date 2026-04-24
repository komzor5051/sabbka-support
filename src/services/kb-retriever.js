const logger = require('../utils/logger');
const ai = require('./ai');
const db = require('./database');

/**
 * Retrieve relevant KB sections + similar past cases in one embedding call.
 * Used by both customer support chat and admin AI-assistant.
 *
 * @param {string} userText — user's question
 * @param {object} opts — thresholds override (default values tuned for customer flow)
 * @returns {Promise<{kbSectionsText: string, pastCasesText: string}>}
 */
async function retrieveContext(userText, opts = {}) {
  const {
    minTextLen = 15,
    kbMatchCount = 2,
    kbThreshold = 0.50,
    casesMatchCount = 3,
    casesThreshold = 0.70,
  } = opts;

  const empty = { kbSectionsText: '', pastCasesText: '' };

  if (!userText || userText.trim().length < minTextLen) return empty;

  try {
    const embedding = await ai.generateEmbedding(userText);
    const [sections, cases] = await Promise.all([
      db.searchKbSections(embedding, kbMatchCount, kbThreshold),
      db.searchSimilar(embedding, casesMatchCount, null, casesThreshold),
    ]);

    let kbSectionsText = '';
    if (sections && sections.length > 0) {
      kbSectionsText = sections.map(s => s.content).join('\n\n---\n\n');
      logger.info('kb-retriever: KB sections retrieved', { count: sections.length });
    }

    let pastCasesText = '';
    if (cases && cases.length > 0) {
      const MAX_CHARS = 400;
      const trim = (s) => s && s.length > MAX_CHARS ? s.substring(0, MAX_CHARS) + '…' : s;
      const block = cases.map((c, i) => {
        const sim = Math.round(c.similarity * 100);
        return `Кейс ${i + 1} (${sim}%):\nПроблема: ${trim(c.summary_problem)}\nРешение: ${trim(c.summary_solution)}`;
      }).join('\n\n');
      pastCasesText = `\n\nПОХОЖИЕ ПРОШЛЫЕ КЕЙСЫ (референс, НЕ цитируй дословно):\n${block}`;
    }

    return { kbSectionsText, pastCasesText };
  } catch (err) {
    logger.error('kb-retriever: failed', { error: err.message });
    return empty;
  }
}

module.exports = { retrieveContext };
