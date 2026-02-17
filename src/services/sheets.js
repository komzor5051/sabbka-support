const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');
const db = require('./database');

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;

  if (!config.sheets.credentials || !config.sheets.sheetId) {
    logger.warn('Google Sheets not configured — sync disabled');
    return null;
  }

  const credentials = JSON.parse(
    Buffer.from(config.sheets.credentials, 'base64').toString('utf-8')
  );

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function syncToSheets() {
  const client = getClient();
  if (!client) return 0;

  const records = await db.getUnsyncedRecords();
  if (records.length === 0) {
    logger.info('Sheets sync: no new records');
    return 0;
  }

  const rows = records.map(r => [
    r.id,
    new Date(r.created_at).toLocaleString('ru-RU'),
    r.category,
    r.summary_problem || '',
    r.summary_solution || '',
    r.telegram_message_id ? `tg://msg?id=${r.telegram_message_id}` : '',
  ]);

  let attempts = 0;
  while (attempts < 3) {
    try {
      await client.spreadsheets.values.append({
        spreadsheetId: config.sheets.sheetId,
        range: 'Sheet1!A:F',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows },
      });

      const ids = records.map(r => r.id);
      await db.markAsSynced(ids);

      logger.info('Sheets synced', { count: records.length });
      return records.length;
    } catch (err) {
      attempts++;
      logger.error(`Sheets sync attempt ${attempts} failed`, { error: err.message });
      if (attempts < 3) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5s retry (not 5min in dev)
      }
    }
  }

  logger.error('Sheets sync failed after 3 attempts');
  return 0;
}

module.exports = { syncToSheets };
