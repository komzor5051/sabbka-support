const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

/**
 * Get last N messages for an admin, oldest first.
 */
async function getHistory(adminId, limit = 20) {
  const { data, error } = await supabase
    .from('admin_chat_history')
    .select('role, content, created_at')
    .eq('admin_id', adminId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('admin-history: getHistory failed', { adminId, error: error.message });
    return [];
  }
  return (data || []).reverse();
}

/**
 * Persist one message.
 */
async function saveMessage(adminId, role, content) {
  const { error } = await supabase
    .from('admin_chat_history')
    .insert({ admin_id: adminId, role, content });

  if (error) {
    logger.error('admin-history: saveMessage failed', { adminId, role, error: error.message });
    throw new Error(`admin saveMessage failed: ${error.message}`);
  }
}

/**
 * Clear all messages for an admin (for /clear command).
 */
async function clearHistory(adminId) {
  const { error } = await supabase
    .from('admin_chat_history')
    .delete()
    .eq('admin_id', adminId);
  if (error) {
    logger.error('admin-history: clearHistory failed', { adminId, error: error.message });
    return false;
  }
  return true;
}

module.exports = { getHistory, saveMessage, clearHistory };
