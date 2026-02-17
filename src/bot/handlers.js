const config = require('../config');
const logger = require('../utils/logger');
const ai = require('../services/ai');
const db = require('../services/database');
const { formatSearchResults } = require('../utils/formatters');

function authMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!config.allowedUserIds.includes(userId)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  return next();
}

async function handleTextQuery(ctx) {
  const query = ctx.message.text;
  if (!query || query.startsWith('/')) return;

  await ctx.reply('🔍 Ищу в базе знаний...');

  try {
    const queryEmbedding = await ai.generateEmbedding(query);
    const results = await db.searchSimilar(queryEmbedding, 3);
    const answer = await ai.generateAnswer(query, results);
    const text = formatSearchResults(results, answer);

    await ctx.reply(text);
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

  await ctx.reply('🔍 Анализирую пересланное сообщение...');

  try {
    const queryEmbedding = await ai.generateEmbedding(text);
    const results = await db.searchSimilar(queryEmbedding, 3);
    const answer = await ai.generateAnswer(text, results);
    const response = formatSearchResults(results, answer);

    await ctx.reply(response);
  } catch (err) {
    logger.error('Forward handling failed', { error: err.message });
    await ctx.reply('❌ Ошибка при обработке.');
  }
}

function setupHandlers(bot) {
  bot.use(authMiddleware);

  bot.on('voice', handleVoice);
  bot.on('audio', handleVoice);

  // Forwarded messages
  bot.on('message', (ctx, next) => {
    if (ctx.message.forward_origin || ctx.message.forward_from || ctx.message.forward_date) {
      return handleForward(ctx);
    }
    return next();
  });

  // Text messages (non-command)
  bot.on('text', handleTextQuery);

  logger.info('Private chat handlers registered');
}

module.exports = { setupHandlers };
