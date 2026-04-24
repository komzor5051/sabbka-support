# CLAUDE.md — Sabka Support Bot

## Overview

Bi-platform AI support bot for **sabka.pro**:
- **Customer flow** — Telegram Business API (@sabka_help) + MAX messenger. Both platforms run the same Grok 4.1 Fast model, same prompt, same KB, same escalation logic.
- **Admin flow** — private chat with the bot in Telegram. Full AI-assistant with Metabase tools for account diagnostics.

Parses customer dialogs → categorizes with Gemini → stores in Supabase pgvector (KB). Self-learns from operator replies to escalations.

## Commands

```bash
npm start        # production
npm run dev      # local dev (node --watch)
```

## File Structure

```
src/index.js                    — entry point, TG+MAX polling in parallel
src/config.js                   — env config (models, metabase, max)
src/bot/
  business.js                   — TG Business API adapter (customer flow)
  max.js                        — MAX messenger adapter (customer flow)
  handlers.js                   — admin private-chat + operator reply routing
  commands.js                   — KB admin commands (/stats, /rebuild_kb, …)
  auth.js                       — authMiddleware (ALLOWED_USER_IDS whitelist)
src/services/
  support-chat.js               — platform-agnostic customer core (Grok, no tools)
  admin-chat.js                 — admin AI-assistant (Grok + tools + RAG)
  admin-tools.js                — 3 tools: lookup_user_account, payments_summary, user_diagnostics
  admin-history.js              — admin_chat_history persistence
  kb-retriever.js               — shared RAG (KB sections + past cases), used by both chats
  chat-history.js               — customer chat_history persistence (platform-aware)
  escalation-store.js           — escalations with platform routing
  dialog-tracker.js             — full-dialog buffering per (platform, user)
  metabase.js                   — Metabase /api/dataset client (lookupUserByEmail + runQuery)
  transport.js                  — registered MAX bot instance for operator reply routing
  ai.js                         — OpenRouter (Grok, Gemini, embeddings) — chatCompletion returns {content, tool_calls}
  database.js                   — Supabase CRUD + vector search (support_kb, kb_sections)
  backup.js                     — periodic Google Drive JSON backup
docs/
  system-prompt.md              — customer-facing support prompt (v1.8)
  admin-system-prompt.md        — admin AI-assistant prompt (v2.0)
  knowledge-base.md             — source KB text (also split into kb_sections with embeddings)
supabase-schema.sql             — base schema (support_kb, chat_history, categories, rules, escalations, dialog_buffer)
supabase-kb-sections.sql        — kb_sections table + search_kb_sections RPC
supabase-admin-chat-history.sql — admin_chat_history table
supabase-add-platform.sql       — platform column migration (Phase E)
```

## Tech stack

- Node.js 20, Telegraf 4
- `@maxhub/max-bot-api` 0.2.2 (MAX messenger SDK)
- Supabase pgvector (HNSW index on support_kb.embedding)
- OpenRouter models:
  - `x-ai/grok-4.1-fast` — chat (customer + admin), agentic tool calling
  - `google/gemini-2.5-flash-lite` — dialog analysis, voice transcription
  - `openai/text-embedding-3-small` — embeddings (1536-dim)
- Metabase HTTP API (`metabase.sabka.pro/api/dataset`) — template-tag parameterized SQL for admin tools

## Deploy

- **Railway** (polling mode for both TG and MAX). Autodeploy from GitHub main.
- Env vars in Railway dashboard (see below).
- **Rollback:** `git reset --hard <tag> && git push --force origin main`, or remove an env var to disable a feature (MAX_BOT_TOKEN, METABASE_API_KEY both act as feature flags).

## Rollback tags

- `pre-grok-tools` — before tool-calling + Grok (2026-04-24)
- `pre-admin-refactor` — before admin AI-assistant rewrite (2026-04-24)
- `pre-max-integration` — before MAX + platform-aware core (2026-04-24)

## Env Vars

```
# Required
TELEGRAM_BOT_TOKEN              Telegram bot token for sabbka-support
OPENROUTER_API_KEY              OpenRouter for Grok + Gemini + embeddings
SUPABASE_URL
SUPABASE_SERVICE_KEY
ALLOWED_USER_IDS                comma-separated Telegram user IDs (admins)
ESCALATION_USER_IDS             comma-separated (default: 8572634797)

# Optional / feature flags
METABASE_API_URL                default: https://metabase.sabka.pro/api
METABASE_API_KEY                if unset → admin tools return not_configured
MAX_BOT_TOKEN                   if unset → MAX adapter no-ops (TG only)
GOOGLE_SHEETS_CREDENTIALS       base64 service account JSON (for sheets sync)
GOOGLE_SHEET_ID
```

## Data model

### Customer tables (platform-aware — tg / max)

- `chat_history` — per-(platform, user_id) conversation log with 4h session window
- `escalations` — notification_msg_id → (user_chat_id, user_text, platform) for operator reply routing
- `dialog_buffer` — in-flight dialog buffering, composite key (platform, user_id)
- `support_kb` — vectorized past dialogs with quality scoring (1.5 operator-verified, 1.0 normal, 0.5 escalated)
- `kb_sections` — curated KB sections from docs/knowledge-base.md, each with embedding
- `kb_categories`, `kb_rules` — taxonomy

### Admin table (single-user, no platform)

- `admin_chat_history` — admin AI-assistant conversation history (admin_id, role, content)

## Critical Gotchas

- **`bot.launch()` hangs in Telegraf 4.16** — use `deleteWebhook + startPolling` (index.js)
- **Two pollers in one process** — TG (Telegraf) + MAX (@maxhub/max-bot-api). `unhandledRejection` / `uncaughtException` global handlers prevent one crash from killing the other
- **409 Conflict on Telegraf** = another instance polling the same bot token. Railway rolling deploys can briefly cause this; Restart from dashboard fixes it
- **Handler registration order** — `setupBusinessHandlers` → `setupCommands` → `setupHandlers`. Operator-reply catcher in handlers.js must come BEFORE `bot.command('start', ...)` because of Telegraf middleware ordering
- **Auth is per-handler, not `bot.use()`** — otherwise business_messages get blocked
- **ALLOWED_USER_IDS has dual purpose** — whitelist for admin AI-assistant AND role tag (SUPPORT vs USER) in TG Business dialog buffering
- **`business_connection_id`** is a singleton in escalation-store, captured from first business_message. Operator replies to TG escalations require it
- **MAX API** — `bot.api.sendMessageToUser(userId, text, extra?)` — `text` is a STRING, not an object. `ctx.user.user_id` and `ctx.message.body.text` are the extraction points
- **Supabase `platform` column** is required on inserts after Phase E. If platform is missing, insert fails
- **Customer flow is tool-less** (Phase A security) — only admin gets `lookup_user_account` / `payments_summary` / `user_diagnostics`. Re-enabling customer tools would leak private account data
- **Admin diagnostics HARD RULE** — admin-system-prompt forces the bot to append "только по нашей БД, Tinkoff/Cloudpayments/RBS не видны" after every diagnostics call
- **Metabase template-tags** — parameterized SQL via `{{param}}` in query + matching `template-tags` block + `parameters` array. Do NOT concatenate user input directly into SQL
- **Grok `:online` suffix** not used (Exa integration uncertain for Grok). Removed in Phase A
- **Customer reply limit** — 5 per 4h session, forced escalation on the 4th
- **Admin `💬 Новый чат` button** = `/clear` = wipe admin_chat_history for that admin. Useful when switching between users (so Grok doesn't carry stale context)

## Escalation flow (both platforms)

1. Customer writes in TG Business (`@sabka_help`) or MAX (@sabbka_support_bot)
2. `support-chat.handle({platform, userId, ...})` runs Grok without tools, with RAG context
3. If escalation triggered (model [ESCALATE] tag, user asks for human, or reply #4 in session):
   - User sees "передаю команде"
   - `notifyAdmins(adminBot, platform, userId, username, userText)` sends `🆘 [platform prefix]` to TG admin
   - `escalationStore.storeEscalation(msgId, userId, userText, platform)` persists routing info
4. Admin replies in TG to that message
5. `handlers.js` reply-to-escalation catcher:
   - `platform === 'tg'` → `ctx.telegram.sendMessage(userChatId, text, {business_connection_id})`
   - `platform === 'max'` → `transport.sendToMaxUser(userChatId, text)` → `maxBot.api.sendMessageToUser(...)`
6. `saveOperatorReplyToKB(userText, replyText)` stores pair in support_kb with quality=1.5

## Admin flow

- `/start`, `/help` — intro with `💬 Новый чат` keyboard
- Any free text / email → `admin-chat.handle(adminId, text, sendReply)`
  - Loads admin_chat_history + retrieves KB sections/past cases in parallel
  - Calls Grok with 3 tools: `lookup_user_account`, `payments_summary`, `user_diagnostics`
  - Multi-step loop (max 5 iterations); Grok can parallel-call tools in one step
- Reply-to-escalation is caught BEFORE admin-chat handler — pure relay, no AI
- Voice messages → transcribe via Gemini → feed transcription into admin-chat

## Self-learning loop

- Operator reply on an escalation → `saveOperatorReplyToKB(userQuestion, operatorAnswer)` → `support_kb` insert with quality=1.5
- `support_kb.search_kb` RPC multiplies `similarity * quality`, so operator-verified answers rank higher than bot-generated ones
- `/rebuild_kb` can re-import all `chat_history` (platform-aware grouping) and re-classify
