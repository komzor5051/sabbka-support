const { Bot } = require('@maxhub/max-bot-api');
const config = require('../config');
const logger = require('../utils/logger');
const supportChat = require('../services/support-chat');
const transport = require('../services/transport');

/**
 * Start the MAX messenger bot. Returns the bot instance (or null if disabled).
 * Requires MAX_BOT_TOKEN env var. Silently no-ops if token is missing.
 *
 * @param {Telegraf} tgBot — Telegram bot used for admin notifications / escalations
 */
async function startMaxBot(tgBot) {
  if (!config.max.botToken) {
    logger.info('MAX bot: MAX_BOT_TOKEN not set — MAX integration disabled');
    return null;
  }

  let maxBot;
  try {
    maxBot = new Bot(config.max.botToken);
  } catch (err) {
    logger.error('MAX bot: constructor failed', { error: err.message });
    return null;
  }

  // Register with transport so operator replies can reach MAX users
  transport.registerMaxBot(maxBot);

  // One-time raw-log flag: first message gets dumped so we can verify real field shapes
  let firstMessageLogged = false;

  maxBot.on('message_created', async (ctx) => {
    try {
      if (!firstMessageLogged) {
        firstMessageLogged = true;
        const safeCtx = {
          updateType: ctx.updateType,
          chatId: ctx.chatId,
          messageId: ctx.messageId,
          user: ctx.user,
          chat: ctx.chat,
          message: ctx.message,
        };
        logger.info('MAX bot: FIRST message raw ctx', { ctx: JSON.stringify(safeCtx).substring(0, 2000) });
      }

      // Extract fields — structure derived from context.d.ts
      // ctx.message.body.text = user's text (typical for message_created)
      // ctx.user = sender (has user_id, first_name, last_name, username)
      const user = ctx.user;
      if (!user) {
        logger.warn('MAX bot: message without user, skipping');
        return;
      }
      const userId = Number(user.user_id);
      if (!userId || Number.isNaN(userId)) {
        logger.warn('MAX bot: invalid user_id', { raw: user.user_id });
        return;
      }

      const message = ctx.message;
      const text = message?.body?.text;
      if (!text) {
        logger.info('MAX bot: non-text message, skipping', { userId, messageType: typeof message?.body });
        return;
      }

      const username = user.username || user.first_name || null;

      logger.info('MAX bot: message received', { userId, textLen: text.length });

      supportChat.handle({
        platform: 'max',
        userId,
        userText: text,
        username,
        sendReply: async (replyText) => {
          await ctx.reply(replyText);
        },
        adminBot: tgBot, // admin notifications go to Telegram
      }).catch((err) => {
        logger.error('MAX bot: support-chat threw', { userId, error: err.message });
      });
    } catch (err) {
      logger.error('MAX bot: message handler crashed', { error: err.message, stack: err.stack });
    }
  });

  // Start long polling. Wrapped so crashes don't tear down Telegraf.
  try {
    await maxBot.start();
    logger.info('MAX bot: started (polling)');
  } catch (err) {
    logger.error('MAX bot: start failed', { error: err.message });
    return null;
  }

  return maxBot;
}

module.exports = { startMaxBot };
