# CLAUDE.md — Sabka Support KB Bot

## Overview
Telegram support knowledge base bot for sabka.pro. Parses dialogs from @sabka_help via Business API, categorizes with AI, stores in Supabase pgvector, syncs to Google Sheets.

## Commands
```bash
npm start        # Production
npm run dev      # Development (node --watch)
```

## Structure
```
src/index.js              — Entry point, bot launch
src/config.js             — Environment config
src/bot/commands.js       — Telegram commands
src/bot/handlers.js       — Private chat message handlers
src/bot/business.js       — Business message processing
src/services/ai.js        — OpenRouter (Gemini + embeddings)
src/services/database.js  — Supabase CRUD + vector search
src/services/sheets.js    — Google Sheets sync
src/services/dialog-tracker.js — Dialog buffering
src/utils/logger.js       — Winston logger
src/utils/formatters.js   — Response formatters
```

## Tech
Node.js 20, Telegraf.js 4, Supabase pgvector, OpenRouter (Gemini 2.5 Flash Lite + text-embedding-3-small), googleapis, node-cron

## Deploy
Railway (polling mode). Env vars in Railway dashboard.

## Env Vars
```
TELEGRAM_BOT_TOKEN
OPENROUTER_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_KEY
GOOGLE_SHEETS_CREDENTIALS  (base64 encoded service account JSON)
GOOGLE_SHEET_ID
ALLOWED_USER_IDS            (comma-separated Telegram user IDs)
```

## Critical Gotchas

- **`bot.launch()` hangs in Telegraf 4.16** — use `deleteWebhook + startPolling` (index.js:42-43)
- **Handler registration order matters** — `setupBusinessHandlers` → `setupCommands` → `setupHandlers`
- **`allowedUserIds` has dual purpose** — auth whitelist AND dialog role tagging (SUPPORT vs USER label)
- **Auth must NOT be `bot.use()`** — applied per-command/handler to avoid blocking business_message updates
- **`GOOGLE_SHEETS_CREDENTIALS`** — base64-encoded service account JSON
- **`/change` and `/recalculate`** — re-run AI on ALL records sequentially; expensive on large KB
- **HNSW index** (design doc mentions IVFFlat — outdated; actual schema uses HNSW)
