const { Telegraf } = require('telegraf');

const config = require('./config');
const logger = require('./utils/logger');
const DialogTracker = require('./services/dialog-tracker');
const { processCompletedDialog, setupBusinessHandlers } = require('./bot/business');
const { setupHandlers } = require('./bot/handlers');
const { setupCommands } = require('./bot/commands');

async function main() {
  logger.info('Starting Sabka Support KB Bot...');

  // 1. Create bot
  const bot = new Telegraf(config.telegram.token);

  // 2. Create dialog tracker
  const dialogTracker = new DialogTracker({
    onDialogComplete: processCompletedDialog,
  });

  // 3. Register handlers (order matters!)
  // Business messages first (they come via business_message update type)
  setupBusinessHandlers(bot, dialogTracker);
  // Commands before generic text handler
  setupCommands(bot);
  // Generic handlers last (text, voice, forward)
  setupHandlers(bot);

  // 4. Graceful shutdown — flush pending dialogs
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    await dialogTracker.flushAll();
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 5. Launch bot (polling mode)
  // bot.launch() hangs in Telegraf 4.16 — use deleteWebhook + startPolling
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  bot.startPolling();
  logger.info('Bot is running! Polling for updates...');
  logger.info(`Allowed users: ${config.allowedUserIds.join(', ') || 'NONE (set ALLOWED_USER_IDS!)'}`);
  logger.info(`Pending dialogs in buffer: ${dialogTracker.pendingCount}`);
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
