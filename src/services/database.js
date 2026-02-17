const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

async function insertDialog({ telegramMessageId, telegramUserId, category, fullDialog, summaryProblem, summarySolution, embedding }) {
  const { data, error } = await supabase
    .from('support_kb')
    .insert({
      telegram_message_id: telegramMessageId,
      telegram_user_id: telegramUserId,
      category,
      full_dialog: fullDialog,
      summary_problem: summaryProblem,
      summary_solution: summarySolution,
      embedding,
    })
    .select('id')
    .single();

  if (error) {
    logger.error('Failed to insert dialog', { error: error.message });
    throw error;
  }

  logger.info('Dialog inserted', { id: data.id, category });
  return data;
}

async function searchSimilar(queryEmbedding, matchCount = 3, filterCategory = null) {
  const { data, error } = await supabase.rpc('search_kb', {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    filter_category: filterCategory,
  });

  if (error) {
    logger.error('Search failed', { error: error.message });
    throw error;
  }

  return data || [];
}

async function getStats() {
  const { count: total } = await supabase
    .from('support_kb')
    .select('*', { count: 'exact', head: true });

  const { data: rows } = await supabase
    .from('support_kb')
    .select('category');

  const byCat = {};
  for (const row of (rows || [])) {
    byCat[row.category] = (byCat[row.category] || 0) + 1;
  }

  const byCategory = Object.entries(byCat)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const { data: lastSyncRow } = await supabase
    .from('support_kb')
    .select('last_synced_to_sheets')
    .not('last_synced_to_sheets', 'is', null)
    .order('last_synced_to_sheets', { ascending: false })
    .limit(1)
    .single();

  return {
    total: total || 0,
    byCategory,
    lastSync: lastSyncRow?.last_synced_to_sheets || null,
  };
}

async function getUnsyncedRecords() {
  const { data, error } = await supabase
    .from('support_kb')
    .select('id, created_at, category, summary_problem, summary_solution, telegram_message_id')
    .is('last_synced_to_sheets', null)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Failed to get unsynced records', { error: error.message });
    return [];
  }

  return data || [];
}

async function markAsSynced(ids) {
  const { error } = await supabase
    .from('support_kb')
    .update({ last_synced_to_sheets: new Date().toISOString() })
    .in('id', ids);

  if (error) {
    logger.error('Failed to mark as synced', { error: error.message });
    throw error;
  }
}

async function getCategories() {
  const { data, error } = await supabase
    .from('kb_categories')
    .select('name, description')
    .order('name');

  if (error) {
    logger.error('Failed to fetch categories', { error: error.message });
  }
  if (!data || data.length === 0) {
    logger.warn('kb_categories table is empty — all dialogs will be categorized as "прочее"');
  }

  return data || [];
}

async function addCategory(name, description) {
  const { error } = await supabase
    .from('kb_categories')
    .insert({ name, description });

  if (error) {
    if (error.code === '23505') return { exists: true };
    throw error;
  }
  return { exists: false };
}

async function getRules() {
  const { data } = await supabase
    .from('kb_rules')
    .select('rule_text')
    .eq('active', true)
    .order('created_at');

  return (data || []).map(r => r.rule_text);
}

async function addRule(ruleText) {
  const { error } = await supabase
    .from('kb_rules')
    .insert({ rule_text: ruleText });

  if (error) throw error;
}

async function getAllRecords(filterCategory = null) {
  let query = supabase
    .from('support_kb')
    .select('id, full_dialog, category')
    .order('created_at');

  if (filterCategory) {
    query = query.eq('category', filterCategory);
  }

  const { data } = await query;
  return data || [];
}

async function updateRecord(id, { category, summaryProblem, summarySolution, embedding }) {
  const update = {};
  if (category !== undefined && category !== null) update.category = category;
  if (summaryProblem !== undefined && summaryProblem !== null) update.summary_problem = summaryProblem;
  if (summarySolution !== undefined && summarySolution !== null) update.summary_solution = summarySolution;
  if (embedding !== undefined && embedding !== null) update.embedding = embedding;

  const { error } = await supabase
    .from('support_kb')
    .update(update)
    .eq('id', id);

  if (error) throw error;
}

async function exportRecords(limit = 50) {
  const { data } = await supabase
    .from('support_kb')
    .select('id, created_at, category, summary_problem, summary_solution')
    .order('created_at', { ascending: false })
    .limit(limit);

  return data || [];
}

module.exports = {
  insertDialog,
  searchSimilar,
  getStats,
  getUnsyncedRecords,
  markAsSynced,
  getCategories,
  addCategory,
  getRules,
  addRule,
  getAllRecords,
  updateRecord,
  exportRecords,
};
