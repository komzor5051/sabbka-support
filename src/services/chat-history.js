const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

/**
 * Retrieve last N messages for a (platform, user_id), oldest first.
 */
async function getHistory(platform, userId, limit = 10) {
  const { data, error } = await supabase
    .from('chat_history')
    .select('role, content, created_at')
    .eq('platform', platform)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('chat-history: getHistory failed', { platform, userId, error: error.message });
    return [];
  }

  return (data || []).reverse();
}

/**
 * Persist one message turn.
 */
async function saveMessage(platform, userId, role, content) {
  const { error } = await supabase
    .from('chat_history')
    .insert({ platform, user_id: userId, role, content });

  if (error) {
    logger.error('chat-history: saveMessage failed', { platform, userId, role, error: error.message });
    throw new Error(`saveMessage failed: ${error.message}`);
  }
}

/**
 * Count assistant replies for a user since a given date.
 */
async function countRepliesInWindow(platform, userId, since) {
  const { count, error } = await supabase
    .from('chat_history')
    .select('*', { count: 'exact', head: true })
    .eq('platform', platform)
    .eq('user_id', userId)
    .eq('role', 'assistant')
    .gte('created_at', since.toISOString());

  if (error) {
    logger.error('chat-history: countRepliesInWindow failed', { platform, userId, error: error.message });
    return 0;
  }

  return count || 0;
}

module.exports = { getHistory, saveMessage, countRepliesInWindow };
