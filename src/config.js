const fs = require('fs');
const path = require('path');
require('dotenv').config();

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: {
      chat: 'x-ai/grok-4.1-fast',
      analyzer: 'google/gemini-2.5-flash-lite',
      embedding: 'openai/text-embedding-3-small',
    },
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  metabase: {
    apiUrl: process.env.METABASE_API_URL || 'https://metabase.sabka.pro/api',
    apiKey: process.env.METABASE_API_KEY,
    databaseId: 2,
    timeoutMs: 15000,
  },
  sheets: {
    credentials: process.env.GOOGLE_SHEETS_CREDENTIALS,
    sheetId: process.env.GOOGLE_SHEET_ID,
  },
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean),
  escalationUserIds: (process.env.ESCALATION_USER_IDS || '8572634797')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean),
  dialogTimeoutMs: 5 * 60 * 1000, // 5 minutes
  sheetsSyncIntervalMin: 30,
  defaultCategories: [
    { name: 'баги_фронтенд', description: 'Баги на фронтенде (UI, отображение)' },
    { name: 'баги_бэкенд', description: 'Баги на бэкенде (API, сервер)' },
    { name: 'частые_вопросы', description: 'Часто задаваемые вопросы' },
    { name: 'лимиты_баланс', description: 'Вопросы по лимитам и балансу' },
    { name: 'описание_моделей', description: 'Вопросы про модели и их функции' },
    { name: 'прочее', description: 'Всё остальное' },
  ],
  supportChat: {
    systemPromptPath: path.resolve(__dirname, '../docs/system-prompt.md'),
    knowledgeBasePath: path.resolve(__dirname, '../docs/knowledge-base.md'),
    historyLimit: 10,
    onlineKeywords: [
      'не работает', 'ошибка', 'error', 'баг', 'обновление',
      'новая версия', 'вышло', 'упало', 'не отвечает', 'недоступно',
    ],
    get systemPrompt() {
      return fs.readFileSync(this.systemPromptPath, 'utf-8');
    },
    get knowledgeBase() {
      return fs.readFileSync(this.knowledgeBasePath, 'utf-8');
    },
  },
  adminChat: {
    systemPromptPath: path.resolve(__dirname, '../docs/admin-system-prompt.md'),
    historyLimit: 20,
    maxToolSteps: 5,
    toolResultCharCap: 10000,
    get systemPrompt() {
      return fs.readFileSync(this.systemPromptPath, 'utf-8');
    },
  },
};
