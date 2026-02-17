const logger = require('../utils/logger');
const config = require('../config');
const db = require('../services/database');
const ai = require('../services/ai');

async function processCompletedDialog({ userId, firstMessageId, fullDialog, messageCount }) {
  try {
    logger.info('Processing dialog', { userId, messageCount });

    const [categories, rules] = await Promise.all([
      db.getCategories(),
      db.getRules(),
    ]);

    const analysis = await ai.analyzeDialog(fullDialog, categories, rules);

    // Validate category exists
    const validCategories = categories.map(c => c.name);
    if (!validCategories.includes(analysis.category)) {
      analysis.category = 'прочее';
    }

    const embeddingText = `${analysis.summary_problem} ${analysis.summary_solution}`;
    const embedding = await ai.generateEmbedding(embeddingText);

    await db.insertDialog({
      telegramMessageId: firstMessageId,
      telegramUserId: userId,
      category: analysis.category,
      fullDialog,
      summaryProblem: analysis.summary_problem,
      summarySolution: analysis.summary_solution,
      embedding,
    });

    logger.info('Dialog processed and saved', {
      userId,
      category: analysis.category,
      problem: analysis.summary_problem,
    });
  } catch (err) {
    logger.error('Failed to process dialog', {
      userId,
      error: err.message,
    });
  }
}

function setupBusinessHandlers(bot, dialogTracker) {
  bot.on('business_message', (ctx) => {
    const msg = ctx.businessMessage || ctx.update.business_message;
    if (!msg || !msg.text) return;

    const chatUserId = msg.from.id;

    // In Business API: if sender is the business account owner → SUPPORT, otherwise → USER
    const isSupport = config.allowedUserIds.includes(chatUserId);
    const sender = isSupport ? 'SUPPORT' : 'USER';

    // Use chat.id as dialog key (unique per conversation)
    const dialogKey = msg.chat.id;

    dialogTracker.addMessage(dialogKey, {
      text: msg.text,
      sender,
      messageId: msg.message_id,
      date: new Date(msg.date * 1000),
    });
  });

  logger.info('Business message handlers registered');
}

module.exports = { setupBusinessHandlers, processCompletedDialog };
