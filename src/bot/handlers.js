const logger = require('../utils/logger');
const ai = require('../services/ai');
const db = require('../services/database');
const { formatSearchResults } = require('../utils/formatters');
const { authMiddleware } = require('./auth');

// Pending context: stores the last query so the next message saves as answer
// Map<userId, { query: string, timestamp: number }>
const pendingContext = new Map();
const PENDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — after that, context expires

function setPendingContext(userId, query) {
  pendingContext.set(userId, { query, timestamp: Date.now() });
}

function getPendingContext(userId) {
  const ctx = pendingContext.get(userId);
  if (!ctx) return null;
  // Expire after 10 min
  if (Date.now() - ctx.timestamp > PENDING_TIMEOUT_MS) {
    pendingContext.delete(userId);
    return null;
  }
  return ctx;
}

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

  // Check if this is an answer to a previous query
  const pending = getPendingContext(userId);
  if (pending) {
    pendingContext.delete(userId);

    // This text is Artem's answer — save to KB
    await ctx.reply('💾 Сохраняю ответ в базу знаний...');
    const saved = await saveAnswerToKB(pending.query, query);

    if (saved) {
      await ctx.reply('✅ Ответ сохранён в базу! Теперь я буду использовать его для похожих вопросов.');
    } else {
      await ctx.reply('❌ Не удалось сохранить ответ.');
    }
    return;
  }

  // Normal query — search KB
  await ctx.reply('🔍 Ищу в базе знаний...');

  try {
    const queryEmbedding = await ai.generateEmbedding(query);
    const results = await db.searchSimilar(queryEmbedding, 3);
    const answer = await ai.generateAnswer(query, results);
    const text = formatSearchResults(results, answer);

    await ctx.reply(text);

    // Set pending context — next text message will be saved as answer
    setPendingContext(userId, query);
    await ctx.reply('💡 Напиши свой ответ — я сохраню его в базу.\nИли задай новый вопрос через /skip');
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
    const results = await db.searchSimilar(queryEmbedding, 3);
    const answer = await ai.generateAnswer(transcription, results);
    const text = formatSearchResults(results, answer);

    await ctx.reply(text);

    // Set pending context
    setPendingContext(ctx.from.id, transcription);
    await ctx.reply('💡 Напиши свой ответ — я сохраню его в базу.\nИли задай новый вопрос через /skip');
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
    const results = await db.searchSimilar(queryEmbedding, 3);
    const answer = await ai.generateAnswer(text, results);
    const response = formatSearchResults(results, answer);

    await ctx.reply(response);

    // Set pending context
    setPendingContext(ctx.from.id, text);
    await ctx.reply('💡 Напиши свой ответ — я сохраню его в базу.\nИли задай новый вопрос через /skip');
  } catch (err) {
    logger.error('Forward handling failed', { error: err.message });
    await ctx.reply('❌ Ошибка при обработке.');
  }
}

function setupHandlers(bot) {
  // /skip — clear pending context, next message is a new query
  bot.command('skip', authMiddleware, (ctx) => {
    pendingContext.delete(ctx.from.id);
    ctx.reply('⏭ Пропущено. Задавай новый вопрос.');
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
