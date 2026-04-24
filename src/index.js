const { Telegraf } = require('telegraf');

const config = require('./config');
const logger = require('./utils/logger');
const DialogTracker = require('./services/dialog-tracker');
const { processCompletedDialog, setupBusinessHandlers } = require('./bot/business');
const { setupHandlers } = require('./bot/handlers');
const { setupCommands } = require('./bot/commands');
const { startBackupSchedule } = require('./services/backup');
const { startMaxBot } = require('./bot/max');

// Global safety net — don't let a thrown promise kill the whole process
process.on('unhandledRejection', (reason, promise) => {
  logger.error('unhandledRejection', {
    reason: reason?.message || String(reason),
    stack: reason?.stack,
  });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
});

async function main() {
  logger.info('Starting Sabka Support KB Bot...');

  const bot = new Telegraf(config.telegram.token);

  const dialogTracker = new DialogTracker({
    onDialogComplete: processCompletedDialog,
  });

  setupBusinessHandlers(bot, dialogTracker);
  setupCommands(bot);
  setupHandlers(bot);

  let maxBot = null;

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    await dialogTracker.flushAll();
    await bot.stop(signal);
    try {
      if (maxBot && typeof maxBot.stop === 'function') await maxBot.stop();
    } catch (err) {
      logger.error('MAX bot: stop failed', { error: err.message });
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await dialogTracker.recoverOrphaned();

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  bot.startPolling();
  logger.info('Bot is running! Polling for updates...');

  // MAX bot in parallel — non-blocking. If it fails, Telegram still works.
  startMaxBot(bot).then((instance) => {
    maxBot = instance;
  }).catch((err) => {
    logger.error('MAX bot: failed to start (non-fatal)', { error: err.message });
  });

  startBackupSchedule();
  logger.info(`Allowed users: ${config.allowedUserIds.join(', ') || 'NONE (set ALLOWED_USER_IDS!)'}`);
  logger.info(`Pending dialogs in buffer: ${dialogTracker.pendingCount}`);
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
