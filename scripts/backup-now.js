#!/usr/bin/env node
/**
 * Manual backup — run anytime to create/overwrite backup on Google Drive.
 * Usage: node scripts/backup-now.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { runBackup } = require('../src/services/backup');

runBackup().then(() => {
  console.log('Done.');
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
