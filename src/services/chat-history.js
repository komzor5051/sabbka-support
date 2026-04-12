const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

/**
 * Retrieve last N messages for a user, oldest first.
 * Returns array of { role, content, created_at }.
 */
async function getHistory(userId, limit = 10) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, content, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('chat-history: getHistory failed', { userId, error: error.message });
    return [];
  }

  // Data comes newest-first; reverse to get chronological order for the messages array
  return (data || []).reverse();
}

/**
 * Persist one message turn to chat_history.
 */
async function saveMessage(userId, role, content) {
  const { error } = await supabase
    .from('chat_history')
    .insert({ user_id: userId, role, content });

  if (error) {
    logger.error('chat-history: saveMessage failed', { userId, role, error: error.message });
    throw new Error(`saveMessage failed: ${error.message}`);
  }
}

/**
 * Count assistant replies for a user since a given date.
 * Uses a DB-level count — not limited by getHistory's row limit.
 */
async function countRepliesInWindow(userId, since) {
  const { count, error } = await supabase
    .from('chat_history')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('role', 'assistant')
    .gte('created_at', since.toISOString());

  if (error) {
    logger.error('chat-history: countRepliesInWindow failed', { userId, error: error.message });
    return 0;
  }

  return count || 0;
}

module.exports = { getHistory, saveMessage, countRepliesInWindow };
