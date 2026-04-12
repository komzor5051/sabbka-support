const { Markup } = require('telegraf');
const logger = require('../utils/logger');
const config = require('../config');
const ai = require('../services/ai');
const db = require('../services/database');
const { formatSearchResults } = require('../utils/formatters');
const { authMiddleware } = require('./auth');
const escalationStore = require('../services/escalation-store');

// Pending context: stores query, generated answer, and mode
// mode: 'buttons' — waiting for inline button click
// mode: 'edit'    — waiting for text message (Artem's own answer)
// Map<userId, { query, answer, results, timestamp, mode }>
const pendingContext = new Map();
const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

function setPendingContext(userId, data) {
  pendingContext.set(userId, { ...data, timestamp: Date.now() });
}

function getPendingContext(userId) {
  const ctx = pendingContext.get(userId);
  if (!ctx) return null;
  if (Date.now() - ctx.timestamp > PENDING_TIMEOUT_MS) {
    pendingContext.delete(userId);
    return null;
  }
  return ctx;
}

const inlineKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('✅ Отправить', 'send_answer'),
  Markup.button.callback('✏️ Редактировать', 'edit_answer'),
  Markup.button.callback('🔄 Другой вариант', 'regenerate_answer'),
]);

/**
 * Save Artem's answer as a new KB entry
 */
async function saveAnswerToKB(originalQuery, answer) {
  try {
    const categories = await db.getCategories();
    const rules = await db.getRules();

    // Build a synthetic dialog for analysis
    const syntheticDialog = `[USER]: ${originalQuery}\n[SUPPORT]: ${answer}`;
    const analysis = await ai.analyzeDialog(syntheticDialog, categories, rules);

    const validCats = categories.map(c => c.name);
    if (!validCats.includes(analysis.category)) {
      analysis.category = 'прочее';
    }

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
    });

    logger.info('Answer saved to KB', { category: analysis.category });
    return true;
  } catch (err) {
    logger.error('Failed to save answer to KB', { error: err.message });
    return false;
  }
}

async function handleTextQuery(ctx) {
  const query = ctx.message.text;
  if (!query || query.startsWith('/')) return;

  const userId = ctx.from.id;

  // Check if this is a text answer (edit mode)
  const pending = getPendingContext(userId);
  if (pending && pending.mode === 'edit') {
    pendingContext.delete(userId);

    await ctx.reply('💾 Сохраняю ответ в базу знаний...');
    const saved = await saveAnswerToKB(pending.query, query);

    if (saved) {
      await ctx.reply('✅ Ответ сохранён в базу! Теперь я буду использовать его для похожих вопросов.');
    } else {
      await ctx.reply('❌ Не удалось сохранить ответ.');
    }
    return;
  }

  // New query — clear any old pending context
  pendingContext.delete(userId);

  await ctx.reply('🔍 Ищу в базе знаний...');

  try {
    const queryEmbedding = await ai.generateEmbedding(query);
    const results = await db.searchSimilar(queryEmbedding, 5);
    const answer = await ai.generateAnswer(query, results);
    const text = formatSearchResults(results, answer);

    await ctx.reply(text);

    if (answer) {
      // Store context and show inline buttons
      setPendingContext(userId, { query, answer, results, mode: 'buttons' });
      await ctx.reply('Что сделать с ответом?', inlineKeyboard);
    } else {
      // No answer generated — go straight to edit mode
      setPendingContext(userId, { query, answer: null, results, mode: 'edit' });
      await ctx.reply('💡 В базе нет подходящих кейсов. Напиши свой ответ — я сохраню его.\nИли /skip для нового вопроса.');
    }
  } catch (err) {
    logger.error('Query handling failed', { error: err.message });
    await ctx.reply('❌ Ошибка при поиске. Попробуй ещё раз.');
  }
}

async function handleVoice(ctx) {
  await ctx.reply('🎤 Транскрибирую голосовое...');

  try {
    const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
    if (!fileId) {
      return ctx.reply('❌ Не удалось получить аудио.');
    }

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await ai.transcribeVoice(buffer);
    await ctx.reply(`📝 Распознано: "${transcription}"\n\n🔍 Ищу в базе...`);

    const queryEmbedding = await ai.generateEmbedding(transcription);
    const results = await db.searchSimilar(queryEmbedding, 5);
    const answer = await ai.generateAnswer(transcription, results);
    const text = formatSearchResults(results, answer);

    await ctx.reply(text);

    if (answer) {
      setPendingContext(ctx.from.id, { query: transcription, answer, results, mode: 'buttons' });
      await ctx.reply('Что сделать с ответом?', inlineKeyboard);
    } else {
      setPendingContext(ctx.from.id, { query: transcription, answer: null, results, mode: 'edit' });
      await ctx.reply('💡 Напиши свой ответ — я сохраню его.\nИли /skip для нового вопроса.');
    }
  } catch (err) {
    logger.error('Voice handling failed', { error: err.message });
    await ctx.reply('❌ Ошибка при обработке голосового.');
  }
}

async function handleForward(ctx) {
  const text = ctx.message.text || ctx.message.caption || '';
  if (!text) {
    return ctx.reply('❌ В пересланном сообщении нет текста.');
  }

  // Forward always starts a new query (clears pending)
  pendingContext.delete(ctx.from.id);

  await ctx.reply('🔍 Анализирую пересланное сообщение...');

  try {
    const queryEmbedding = await ai.generateEmbedding(text);
    const results = await db.searchSimilar(queryEmbedding, 5);
    const answer = await ai.generateAnswer(text, results);
    const response = formatSearchResults(results, answer);

    await ctx.reply(response);

    if (answer) {
      setPendingContext(ctx.from.id, { query: text, answer, results, mode: 'buttons' });
      await ctx.reply('Что сделать с ответом?', inlineKeyboard);
    } else {
      setPendingContext(ctx.from.id, { query: text, answer: null, results, mode: 'edit' });
      await ctx.reply('💡 Напиши свой ответ — я сохраню его.\nИли /skip для нового вопроса.');
    }
  } catch (err) {
    logger.error('Forward handling failed', { error: err.message });
    await ctx.reply('❌ Ошибка при обработке.');
  }
}

function setupHandlers(bot) {
  // Operator reply forwarding — BEFORE auth-protected handlers
  // When an admin replies to an escalation notification, forward their text to the user
  bot.on('text', (ctx, next) => {
    const senderId = ctx.from?.id;
    const replyTo = ctx.message?.reply_to_message;

    // Only process if: sender is an escalation admin AND they're replying to a message
    if (!replyTo || !config.escalationUserIds.includes(senderId)) {
      return next();
    }

    const escalation = escalationStore.getEscalation(replyTo.message_id);
    if (!escalation) {
      return next(); // Not a reply to an escalation notification
    }

    const userChatId = escalation.userChatId;
    const bcId = escalationStore.getBusinessConnectionId();
    const replyText = ctx.message.text;

    if (!bcId) {
      logger.error('escalation-reply: no businessConnectionId captured yet');
      return ctx.reply('Ошибка: business_connection_id ещё не получен. Подождите пока придёт хотя бы одно сообщение от пользователя.');
    }

    ctx.telegram.sendMessage(userChatId, replyText, { business_connection_id: bcId })
      .then(() => {
        ctx.reply('Ответ доставлен');
        logger.info('escalation-reply: forwarded to user', { userChatId, adminId: senderId });
      })
      .catch((err) => {
        ctx.reply('Ошибка доставки: ' + err.message);
        logger.error('escalation-reply: failed', { userChatId, error: err.message });
      });
  });

  // /skip — clear pending context, next message is a new query
  bot.command('skip', authMiddleware, (ctx) => {
    pendingContext.delete(ctx.from.id);
    ctx.reply('⏭ Пропущено. Задавай новый вопрос.');
  });

  // Inline button: Send — save AI answer to KB as-is
  bot.action('send_answer', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    if (!config.allowedUserIds.includes(userId)) return;
    const pending = getPendingContext(userId);

    if (!pending || !pending.answer) {
      return ctx.editMessageText('⚠️ Контекст истёк. Задай вопрос заново.');
    }

    pendingContext.delete(userId);
    await ctx.editMessageText('💾 Сохраняю ответ в базу знаний...');
    const saved = await saveAnswerToKB(pending.query, pending.answer);

    if (saved) {
      await ctx.editMessageText('✅ Ответ сохранён в базу!');
    } else {
      await ctx.editMessageText('❌ Не удалось сохранить ответ.');
    }
  });

  // Inline button: Edit — switch to text input mode
  bot.action('edit_answer', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    if (!config.allowedUserIds.includes(userId)) return;
    const pending = getPendingContext(userId);

    if (!pending) {
      return ctx.editMessageText('⚠️ Контекст истёк. Задай вопрос заново.');
    }

    // Switch to edit mode — next text message will be saved as answer
    setPendingContext(userId, { ...pending, mode: 'edit' });
    await ctx.editMessageText('✏️ Напиши свой вариант ответа — я сохраню его в базу.');
  });

  // Inline button: Regenerate — re-run AI answer with higher temperature
  bot.action('regenerate_answer', async (ctx) => {
    await ctx.answerCbQuery('🔄 Генерирую новый вариант...');
    const userId = ctx.from.id;
    if (!config.allowedUserIds.includes(userId)) return;
    const pending = getPendingContext(userId);

    if (!pending) {
      return ctx.editMessageText('⚠️ Контекст истёк. Задай вопрос заново.');
    }

    try {
      const newAnswer = await ai.generateAnswer(pending.query, pending.results, { temperature: 0.8 });
      if (!newAnswer) {
        return ctx.editMessageText('⚠️ Не удалось сгенерировать новый вариант.');
      }

      // Update stored answer
      setPendingContext(userId, { ...pending, answer: newAnswer, mode: 'buttons' });
      await ctx.editMessageText(`🔄 Новый вариант:\n\n"${newAnswer}"`, inlineKeyboard);
    } catch (err) {
      logger.error('Regenerate failed', { error: err.message });
      await ctx.editMessageText('❌ Ошибка при генерации. Попробуй ещё раз.', inlineKeyboard);
    }
  });

  // Auth on each handler individually — NOT bot.use() which would block business_messages
  bot.on('voice', authMiddleware, handleVoice);
  bot.on('audio', authMiddleware, handleVoice);

  // Forwarded messages
  bot.on('message', authMiddleware, (ctx, next) => {
    if (ctx.message.forward_origin || ctx.message.forward_from || ctx.message.forward_date) {
      return handleForward(ctx);
    }
    return next();
  });

  // Text messages (non-command)
  bot.on('text', authMiddleware, handleTextQuery);

  logger.info('Private chat handlers registered');
}

module.exports = { setupHandlers };
