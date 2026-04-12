const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

const BACKUP_FILENAME = 'sabbka-support-backup.json';
const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

let driveClient = null;
let backupFileId = null; // cached after first upload

function getDriveClient() {
  if (driveClient) return driveClient;

  if (!config.sheets.credentials) {
    logger.warn('backup: Google credentials not configured — backup disabled');
    return null;
  }

  const credentials = JSON.parse(
    Buffer.from(config.sheets.credentials, 'base64').toString('utf-8')
  );

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
    ],
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Fetch all tables (text only, no embeddings) and return as JSON string.
 */
async function exportData() {
  const [
    { data: supportKb },
    { data: chatHistory },
    { data: kbSections },
    { data: kbCategories },
    { data: kbRules },
  ] = await Promise.all([
    supabase.from('support_kb')
      .select('id, created_at, telegram_message_id, telegram_user_id, category, full_dialog, summary_problem, summary_solution, quality, last_synced_to_sheets')
      .order('created_at'),
    supabase.from('chat_history')
      .select('id, user_id, role, content, created_at')
      .order('created_at'),
    supabase.from('kb_sections')
      .select('id, title, keywords, content')
      .order('id'),
    supabase.from('kb_categories')
      .select('name, description'),
    supabase.from('kb_rules')
      .select('id, rule_text, active, created_at'),
  ]);

  return JSON.stringify({
    exported_at: new Date().toISOString(),
    tables: {
      support_kb: supportKb || [],
      chat_history: chatHistory || [],
      kb_sections: kbSections || [],
      kb_categories: kbCategories || [],
      kb_rules: kbRules || [],
    },
    counts: {
      support_kb: (supportKb || []).length,
      chat_history: (chatHistory || []).length,
      kb_sections: (kbSections || []).length,
      kb_categories: (kbCategories || []).length,
      kb_rules: (kbRules || []).length,
    },
  });
}

/**
 * Find existing backup file on Google Drive by name.
 */
async function findBackupFile(drive) {
  if (backupFileId) return backupFileId;

  const res = await drive.files.list({
    q: `name = '${BACKUP_FILENAME}' and trashed = false`,
    fields: 'files(id)',
    spaces: 'drive',
  });

  if (res.data.files && res.data.files.length > 0) {
    backupFileId = res.data.files[0].id;
    return backupFileId;
  }
  return null;
}

/**
 * Upload or overwrite backup file on Google Drive.
 */
async function uploadBackup(jsonString) {
  const drive = getDriveClient();
  if (!drive) return;

  const media = {
    mimeType: 'application/json',
    body: require('stream').Readable.from([jsonString]),
  };

  const existingId = await findBackupFile(drive);

  if (existingId) {
    // Overwrite existing file
    await drive.files.update({
      fileId: existingId,
      media,
    });
    logger.info('backup: file updated on Google Drive', { fileId: existingId });
  } else {
    // Create new file
    const res = await drive.files.create({
      requestBody: {
        name: BACKUP_FILENAME,
        mimeType: 'application/json',
      },
      media,
      fields: 'id',
    });
    backupFileId = res.data.id;
    logger.info('backup: file created on Google Drive', { fileId: backupFileId });
  }
}

/**
 * Run a full backup. Safe to call from anywhere — catches all errors.
 */
async function runBackup() {
  try {
    logger.info('backup: starting...');
    const data = await exportData();
    await uploadBackup(data);

    const parsed = JSON.parse(data);
    logger.info('backup: complete', parsed.counts);
  } catch (err) {
    logger.error('backup: failed', { error: err.message });
  }
}

/**
 * Start periodic backup (non-blocking, runs in background).
 */
function startBackupSchedule() {
  if (!config.sheets.credentials) {
    logger.warn('backup: skipping schedule — no Google credentials');
    return;
  }

  // First backup 1 minute after bot start
  setTimeout(() => {
    runBackup();
  }, 60 * 1000);

  // Then every 12 hours
  setInterval(() => {
    runBackup();
  }, BACKUP_INTERVAL_MS).unref();

  logger.info('backup: scheduled every 12h');
}

module.exports = { runBackup, startBackupSchedule };
