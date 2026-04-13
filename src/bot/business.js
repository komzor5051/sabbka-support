const logger = require('../utils/logger');
const config = require('../config');
const db = require('../services/database');
const ai = require('../services/ai');
const supportChat = require('../services/support-chat');
const escalationStore = require('../services/escalation-store');

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

    // Embed summary (not full dialog) for better query matching
    const embeddingText = `${analysis.summary_problem} ${analysis.summary_solution}`;
    const embedding = await ai.generateEmbedding(embeddingText);

    // Quality: escalated dialogs = 0.5, normal = 1.0
    const wasEscalated = fullDialog.includes('[ESCALATE]') ||
      /передаю команде|зову человека|позову человека/i.test(fullDialog);
    const quality = wasEscalated ? 0.5 : 1.0;

    await db.insertDialog({
      telegramMessageId: firstMessageId,
      telegramUserId: userId,
      category: analysis.category,
      fullDialog,
      summaryProblem: analysis.summary_problem,
      summarySolution: analysis.summary_solution,
      embedding,
      quality,
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
  bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage || ctx.update.business_message;
    if (!msg || !msg.text) return;

    // Capture business_connection_id for operator reply forwarding
    const bcId = msg.business_connection_id || ctx.update?.business_message?.business_connection_id;
    if (bcId) {
      escalationStore.setBusinessConnectionId(bcId);
    }

    const chatUserId = msg.from.id;

    // In Business API: if sender is the business account owner → SUPPORT, otherwise → USER
    const isSupport = config.allowedUserIds.includes(chatUserId);
    const sender = isSupport ? 'SUPPORT' : 'USER';

    // Use chat.id as dialog key (unique per conversation)
    const dialogKey = msg.chat.id;

    await dialogTracker.addMessage(dialogKey, {
      text: msg.text,
      sender,
      messageId: msg.message_id,
      date: new Date(msg.date * 1000),
    });

    // New: AI auto-response for USER messages only
    if (!isSupport) {
      supportChat.handle(ctx, msg, bot).catch((err) => {
        logger.error('support-chat handler threw', { error: err.message });
      });
    }
  });

  logger.info('Business message handlers registered');
}

module.exports = { setupBusinessHandlers, processCompletedDialog };
