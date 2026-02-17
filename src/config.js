require('dotenv').config();

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: {
      gemini: 'google/gemini-2.5-flash-lite',
      embedding: 'openai/text-embedding-3-small',
    },
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  sheets: {
    credentials: process.env.GOOGLE_SHEETS_CREDENTIALS,
    sheetId: process.env.GOOGLE_SHEET_ID,
  },
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
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
};
