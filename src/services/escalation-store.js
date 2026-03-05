const logger = require('../utils/logger');

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Map<notificationMsgId, { userChatId, timestamp }>
const escalations = new Map();

// Singleton — captured once from any business_message, reused for replies
let businessConnectionId = null;

function storeEscalation(notificationMsgId, userChatId) {
  escalations.set(notificationMsgId, { userChatId, timestamp: Date.now() });
  logger.info('escalation-store: stored', { notificationMsgId, userChatId });
}

function getEscalation(notificationMsgId) {
  const entry = escalations.get(notificationMsgId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    escalations.delete(notificationMsgId);
    return null;
  }
  return entry;
}

function setBusinessConnectionId(bcId) {
  if (!businessConnectionId && bcId) {
    businessConnectionId = bcId;
    logger.info('escalation-store: businessConnectionId captured', { bcId });
  }
}

function getBusinessConnectionId() {
  return businessConnectionId;
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [msgId, entry] of escalations) {
    if (now - entry.timestamp > TTL_MS) {
      escalations.delete(msgId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.info('escalation-store: cleanup', { cleaned, remaining: escalations.size });
  }
}, CLEANUP_INTERVAL_MS);

module.exports = {
  storeEscalation,
  getEscalation,
  setBusinessConnectionId,
  getBusinessConnectionId,
};
