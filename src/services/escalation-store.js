const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// In-memory cache — fast lookups + fallback when DB unavailable
const cache = new Map();

let dbAvailable = null;

async function checkDbAvailable() {
  if (dbAvailable !== null) return dbAvailable;
  try {
    const { error } = await supabase
      .from('escalations')
      .select('notification_msg_id')
      .limit(1);
    dbAvailable = !error;
    if (!dbAvailable) {
      logger.warn('escalation-store: table not found, using in-memory only');
    } else {
      logger.info('escalation-store: Supabase persistence enabled');
    }
  } catch {
    dbAvailable = false;
  }
  return dbAvailable;
}

/**
 * Store escalation entry.
 * `platform` tells us which transport to use when admin replies.
 */
async function storeEscalation(notificationMsgId, userChatId, userText, platform = 'tg') {
  cache.set(notificationMsgId, {
    userChatId,
    userText: userText || '',
    platform,
    timestamp: Date.now(),
  });
  logger.info('escalation-store: stored', { notificationMsgId, userChatId, platform });

  if (await checkDbAvailable()) {
    try {
      const { error } = await supabase
        .from('escalations')
        .upsert({
          notification_msg_id: notificationMsgId,
          user_chat_id: userChatId,
          user_text: userText || '',
          platform,
        });
      if (error) {
        logger.error('escalation-store: DB write failed', { error: error.message });
      }
    } catch (err) {
      logger.error('escalation-store: DB write error', { error: err.message });
    }
  }
}

async function getEscalation(notificationMsgId) {
  const cached = cache.get(notificationMsgId);
  if (cached) {
    if (Date.now() - cached.timestamp > TTL_MS) {
      cache.delete(notificationMsgId);
      return null;
    }
    return cached;
  }

  if (await checkDbAvailable()) {
    try {
      const cutoff = new Date(Date.now() - TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('escalations')
        .select('user_chat_id, user_text, platform, created_at')
        .eq('notification_msg_id', notificationMsgId)
        .gte('created_at', cutoff)
        .single();

      if (!error && data) {
        const entry = {
          userChatId: data.user_chat_id,
          userText: data.user_text || '',
          platform: data.platform || 'tg',
          timestamp: new Date(data.created_at).getTime(),
        };
        cache.set(notificationMsgId, entry);
        return entry;
      }
    } catch (err) {
      logger.error('escalation-store: DB read error', { error: err.message });
    }
  }

  return null;
}

// Telegram Business-specific — MAX doesn't need this.
let businessConnectionId = null;

function setBusinessConnectionId(bcId) {
  if (bcId) businessConnectionId = bcId;
}

function getBusinessConnectionId() {
  return businessConnectionId;
}

// Periodic cleanup
setInterval(async () => {
  const now = Date.now();
  let cleanedCache = 0;
  for (const [msgId, entry] of cache) {
    if (now - entry.timestamp > TTL_MS) {
      cache.delete(msgId);
      cleanedCache++;
    }
  }

  if (await checkDbAvailable()) {
    try {
      const cutoff = new Date(now - TTL_MS).toISOString();
      const { error, count } = await supabase
        .from('escalations')
        .delete()
        .lt('created_at', cutoff);
      if (!error && count > 0) {
        logger.info('escalation-store: DB cleanup', { deleted: count });
      }
    } catch (err) {
      logger.error('escalation-store: DB cleanup failed', { error: err.message });
    }
  }

  if (cleanedCache > 0) {
    logger.info('escalation-store: cache cleanup', { cleaned: cleanedCache, remaining: cache.size });
  }
}, 60 * 60 * 1000).unref();

module.exports = {
  storeEscalation,
  getEscalation,
  setBusinessConnectionId,
  getBusinessConnectionId,
};
