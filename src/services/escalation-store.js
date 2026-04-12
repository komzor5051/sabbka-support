const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// In-memory cache — fast lookups, also serves as fallback if DB unavailable
const cache = new Map();

// Whether Supabase escalations table is available
let dbAvailable = null; // null = not checked yet

async function checkDbAvailable() {
  if (dbAvailable !== null) return dbAvailable;
  try {
    const { error } = await supabase
      .from('escalations')
      .select('notification_msg_id')
      .limit(1);
    dbAvailable = !error;
    if (!dbAvailable) {
      logger.warn('escalation-store: table not found, using in-memory only. Run SQL from supabase-schema.sql to enable persistence.');
    } else {
      logger.info('escalation-store: Supabase persistence enabled');
    }
  } catch {
    dbAvailable = false;
  }
  return dbAvailable;
}

async function storeEscalation(notificationMsgId, userChatId, userText) {
  // Always store in cache (including original user question for KB learning)
  cache.set(notificationMsgId, { userChatId, userText: userText || '', timestamp: Date.now() });
  logger.info('escalation-store: stored', { notificationMsgId, userChatId });

  // Persist to DB if available
  if (await checkDbAvailable()) {
    try {
      const { error } = await supabase
        .from('escalations')
        .upsert({
          notification_msg_id: notificationMsgId,
          user_chat_id: userChatId,
          user_text: userText || '',
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
  // Check cache first
  const cached = cache.get(notificationMsgId);
  if (cached) {
    if (Date.now() - cached.timestamp > TTL_MS) {
      cache.delete(notificationMsgId);
      return null;
    }
    return cached;
  }

  // Cache miss — check DB (covers restarts)
  if (await checkDbAvailable()) {
    try {
      const cutoff = new Date(Date.now() - TTL_MS).toISOString();
      const { data, error } = await supabase
        .from('escalations')
        .select('user_chat_id, user_text, created_at')
        .eq('notification_msg_id', notificationMsgId)
        .gte('created_at', cutoff)
        .single();

      if (!error && data) {
        const entry = { userChatId: data.user_chat_id, userText: data.user_text || '', timestamp: new Date(data.created_at).getTime() };
        cache.set(notificationMsgId, entry); // Warm cache
        return entry;
      }
    } catch (err) {
      logger.error('escalation-store: DB read error', { error: err.message });
    }
  }

  return null;
}

// Singleton — captured from business_message, reused for operator replies
let businessConnectionId = null;

function setBusinessConnectionId(bcId) {
  if (bcId) {
    businessConnectionId = bcId;
  }
}

function getBusinessConnectionId() {
  return businessConnectionId;
}

// Periodic cleanup — cache + DB
setInterval(async () => {
  // Clean cache
  const now = Date.now();
  let cleanedCache = 0;
  for (const [msgId, entry] of cache) {
    if (now - entry.timestamp > TTL_MS) {
      cache.delete(msgId);
      cleanedCache++;
    }
  }

  // Clean DB
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
}, 60 * 60 * 1000).unref(); // Every hour

module.exports = {
  storeEscalation,
  getEscalation,
  setBusinessConnectionId,
  getBusinessConnectionId,
};
