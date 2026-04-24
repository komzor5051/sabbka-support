const logger = require('../utils/logger');
const config = require('../config');
const db = require('../services/database');
const ai = require('../services/ai');
const supportChat = require('../services/support-chat');
const escalationStore = require('../services/escalation-store');

async function processCompletedDialog({ platform, userId, firstMessageId, fullDialog, messageCount }) {
  try {
    logger.info('Processing dialog', { platform, userId, messageCount });

    const [categories, rules] = await Promise.all([
      db.getCategories(),
      db.getRules(),
    ]);

    const analysis = await ai.analyzeDialog(fullDialog, categories, rules);

    const validCategories = categories.map(c => c.name);
    if (!validCategories.includes(analysis.category)) {
      analysis.category = 'прочее';
    }

    const embeddingText = `${analysis.summary_problem} ${analysis.summary_solution}`;
    const embedding = await ai.generateEmbedding(embeddingText);

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
      platform,
      userId,
      category: analysis.category,
      problem: analysis.summary_problem,
    });
  } catch (err) {
    logger.error('Failed to process dialog', { platform, userId, error: err.message });
  }
}

function setupBusinessHandlers(bot, dialogTracker) {
  bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage || ctx.update.business_message;
    if (!msg || !msg.text) return;

    const bcId = msg.business_connection_id || ctx.update?.business_message?.business_connection_id;
    if (bcId) escalationStore.setBusinessConnectionId(bcId);

    const chatUserId = msg.from.id;
    const isSupport = config.allowedUserIds.includes(chatUserId);
    const sender = isSupport ? 'SUPPORT' : 'USER';
    const dialogChatId = msg.chat.id;

    await dialogTracker.addMessage('tg', dialogChatId, {
      text: msg.text,
      sender,
      messageId: msg.message_id,
      date: new Date(msg.date * 1000),
    });

    if (!isSupport) {
      supportChat.handle({
        platform: 'tg',
        userId: dialogChatId,
        userText: msg.text,
        username: msg.from?.username || msg.chat?.username,
        sendReply: async (text) => {
          await ctx.telegram.sendMessage(dialogChatId, text, {
            ...(bcId && { business_connection_id: bcId }),
          });
        },
        adminBot: bot,
      }).catch((err) => {
        logger.error('support-chat handler threw', { error: err.message });
      });
    }
  });

  logger.info('Business message handlers registered');
}

module.exports = { setupBusinessHandlers, processCompletedDialog };
