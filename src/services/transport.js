const logger = require('../utils/logger');

// MAX bot instance is registered by src/bot/max.js on startup.
// Kept here so handlers.js (operator reply) can route messages back to MAX
// without a direct dependency on the MAX adapter file.
let maxBotInstance = null;

function registerMaxBot(bot) {
  maxBotInstance = bot;
  logger.info('transport: MAX bot instance registered');
}

/**
 * Send a message to a MAX user. Used for operator replies to MAX escalations.
 * Returns true on success, false on failure (error already logged).
 */
async function sendToMaxUser(userId, text) {
  if (!maxBotInstance) {
    logger.error('transport: maxBotInstance not registered — operator reply cannot reach MAX user');
    return false;
  }
  try {
    // @maxhub/max-bot-api: api.sendMessageToUser(userId, text, extra?)
    await maxBotInstance.api.sendMessageToUser(Number(userId), text);
    return true;
  } catch (err) {
    logger.error('transport: sendToMaxUser failed', { userId, error: err.message });
    return false;
  }
}

module.exports = { registerMaxBot, sendToMaxUser };
