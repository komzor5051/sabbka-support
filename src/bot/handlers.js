const { Markup } = require('telegraf');
const logger = require('../utils/logger');
const config = require('../config');
const ai = require('../services/ai');
const db = require('../services/database');
const { authMiddleware } = require('./auth');
const escalationStore = require('../services/escalation-store');
const adminChat = require('../services/admin-chat');
const adminHistory = require('../services/admin-history');

// Persistent keyboard — one button only: start fresh chat (clear history).
// Useful when switching between users so old context doesn't leak in.
const MAIN_MENU = Markup.keyboard([['💬 Новый чат']]).resize().persistent();
const NEW_CHAT_BTN = '💬 Новый чат';

const HELP_TEXT = `Я — AI-ассистент оператора SABKA.

Что ты можешь:
— Дать email юзера (напиши его в любом виде) → покажу тариф, токены, подписку, платежи с ценами и проверю ошибки в БД.
— Спросить про саму SABKA (тарифы, фичи, возвраты, чанки) → отвечу из базы знаний.
— Спросить смешанное («почему у X@Y.ru не списалось?») → совмещу данные юзера и знание про механику.

Кнопка 💬 Новый чат — обнулить историю, если надо переключиться на другого юзера и не путать контекст.

Команды:
/clear — то же самое что кнопка 💬 Новый чат.
/help — показать эту справку.

Чтобы ответить юзеру из эскалации — сделай reply на сообщение бота с 🆘. Ответ уйдёт юзеру и сохранится в KB.`;

// ─────────────────────────────────────────────────────────────
// Self-learning: save operator's reply as high-quality KB entry
// ─────────────────────────────────────────────────────────────

async function saveOperatorReplyToKB(userQuestion, operatorAnswer) {
  try {
    const categories = await db.getCategories();
    const rules = await db.getRules();
    const syntheticDialog = `[USER]: ${userQuestion}\n[SUPPORT]: ${operatorAnswer}`;
    const analysis = await ai.analyzeDialog(syntheticDialog, categories, rules);

    const validCats = categories.map(c => c.name);
    if (!validCats.includes(analysis.category)) analysis.category = 'прочее';

    const embeddingText = `${analysis.summary_problem} ${analysis.summary_solution}`;
    const embedding = await ai.generateEmbedding(embeddingText);

    await db.insertDialog({
      telegramMessageId: null,
      telegramUserId: null,
      category: analysis.category,
      fullDialog: syntheticDialog,
      summaryProblem: analysis.summary_problem,
      summarySolution: analysis.summary_solution,
      embedding,
      quality: 1.5, // operator-verified — highest quality
    });
    logger.info('KB: operator answer saved', { category: analysis.category });
    return true;
  } catch (err) {
    logger.error('KB: saveOperatorReplyToKB failed', { error: err.message });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Handler: admin text → AI assistant
// ─────────────────────────────────────────────────────────────

async function handleAdminText(ctx) {
  const text = ctx.message?.text;
  if (!text || text.startsWith('/')) return;
  const adminId = ctx.from.id;

  // "Новый чат" button — wipe history, bot forgets previous context
  if (text === NEW_CHAT_BTN) {
    const ok = await adminHistory.clearHistory(adminId);
    await ctx.reply(
      ok ? '💬 Новый чат. Я забыл всё что мы обсуждали до этого. Спрашивай.'
         : '⚠️ Не удалось очистить историю.',
      MAIN_MENU
    );
    return;
  }

  await ctx.sendChatAction('typing').catch(() => {});

  try {
    await adminChat.handle(adminId, text, async (replyText) => {
      await ctx.reply(replyText || '⚠️ Пустой ответ.', MAIN_MENU);
    });
  } catch (err) {
    logger.error('admin-chat: handler threw', { adminId, error: err.message, stack: err.stack });
    await ctx.reply(`⚠️ Ошибка: ${err.message}`, MAIN_MENU);
  }
}

// ─────────────────────────────────────────────────────────────
// Handler: admin voice → transcribe → AI
// ─────────────────────────────────────────────────────────────

async function handleAdminVoice(ctx) {
  const adminId = ctx.from.id;
  await ctx.reply('🎤 Распознаю голосовое...');

  try {
    const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
    if (!fileId) return ctx.reply('⚠️ Не удалось получить аудио.');

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());
    const transcription = await ai.transcribeVoice(buffer);

    await ctx.reply(`📝 «${transcription}»`);
    await ctx.sendChatAction('typing').catch(() => {});

    await adminChat.handle(adminId, transcription, async (replyText) => {
      await ctx.reply(replyText || '⚠️ Пустой ответ.', MAIN_MENU);
    });
  } catch (err) {
    logger.error('admin-voice: failed', { adminId, error: err.message });
    await ctx.reply(`⚠️ Ошибка: ${err.message}`, MAIN_MENU);
  }
}

// ─────────────────────────────────────────────────────────────
// Main setup — order matters
// ─────────────────────────────────────────────────────────────

function setupHandlers(bot) {
  // 1. Operator reply forwarding — BEFORE auth-protected handlers
  // When admin replies to an escalation notification, forward their text to the user
  bot.on('text', async (ctx, next) => {
    const senderId = ctx.from?.id;
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo || !config.escalationUserIds.includes(senderId)) return next();

    const escalation = await escalationStore.getEscalation(replyTo.message_id);
    if (!escalation) return next();

    const userChatId = escalation.userChatId;
    const userText = escalation.userText;
    const bcId = escalationStore.getBusinessConnectionId();
    const replyText = ctx.message.text;

    if (!bcId) {
      logger.error('escalation-reply: no businessConnectionId captured yet');
      return ctx.reply('⚠️ business_connection_id ещё не получен. Дождись первого сообщения от пользователя.');
    }

    try {
      await ctx.telegram.sendMessage(userChatId, replyText, { business_connection_id: bcId });
      await ctx.reply('✅ Доставлено');
      logger.info('escalation-reply: forwarded', { userChatId, adminId: senderId });

      if (userText) {
        saveOperatorReplyToKB(userText, replyText).then((saved) => {
          if (saved) logger.info('escalation-reply: saved to KB', { userChatId });
        }).catch((err) => {
          logger.error('escalation-reply: saveOperatorReplyToKB failed', { error: err.message });
        });
      }
    } catch (err) {
      await ctx.reply('❌ Ошибка доставки: ' + err.message);
      logger.error('escalation-reply: failed', { userChatId, error: err.message });
    }
  });

  // 2. Commands (admin-only) — must come BEFORE generic text handler
  bot.command('start', authMiddleware, async (ctx) => {
    await ctx.reply(`Привет! Я AI-ассистент оператора SABKA.\n\n` + HELP_TEXT, MAIN_MENU);
  });

  bot.command('help', authMiddleware, async (ctx) => {
    await ctx.reply(HELP_TEXT, MAIN_MENU);
  });

  bot.command('clear', authMiddleware, async (ctx) => {
    const ok = await adminHistory.clearHistory(ctx.from.id);
    await ctx.reply(
      ok ? '💬 Новый чат. Я забыл всё что мы обсуждали.' : '⚠️ Не удалось очистить.',
      MAIN_MENU
    );
  });

  // 3. Voice/audio from admin → transcribe → AI
  bot.on('voice', authMiddleware, handleAdminVoice);
  bot.on('audio', authMiddleware, handleAdminVoice);

  // 4. Text messages (non-command) → admin AI chat
  bot.on('text', authMiddleware, handleAdminText);

  logger.info('Admin handlers registered');
}

module.exports = { setupHandlers };
