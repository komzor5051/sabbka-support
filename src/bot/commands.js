const logger = require('../utils/logger');
const db = require('../services/database');
const ai = require('../services/ai');
const { formatStats, formatModels } = require('../utils/formatters');
const { authMiddleware } = require('./auth');

/**
 * Shared recalculation logic for /change, /recalculate, /rebuild_kb Step B.
 * Processes records sequentially with delay to avoid rate limits.
 */
async function recalculateRecords(records, categories, rules, ctx) {
  const validCats = categories.map(c => c.name);
  let processed = 0;
  let failed = 0;

  for (const record of records) {
    try {
      const analysis = await ai.analyzeDialog(record.full_dialog, categories, rules);
      if (!validCats.includes(analysis.category)) analysis.category = 'прочее';

      const embeddingText = `${analysis.summary_problem} ${analysis.summary_solution}`;
      const embedding = await ai.generateEmbedding(embeddingText);

      await db.updateRecord(record.id, {
        category: analysis.category,
        summaryProblem: analysis.summary_problem,
        summarySolution: analysis.summary_solution,
        embedding,
      });

      processed++;
    } catch (err) {
      failed++;
      logger.error('Failed to recalculate record', { id: record.id, error: err.message });
    }

    if ((processed + failed) % 10 === 0) {
      try {
        await ctx.reply(`🔄 ${processed + failed}/${records.length} (ок: ${processed}, ошибок: ${failed})`);
      } catch (e) { /* Telegram rate limit, ignore */ }
    }

    // 500ms delay between records to avoid OpenRouter rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  return { processed, failed };
}

function setupCommands(bot) {
  // NOTE: /start and /help are registered in handlers.js (admin-only, with MAIN_MENU keyboard)

  bot.command('stats', authMiddleware, async (ctx) => {
    try {
      const stats = await db.getStats();
      await ctx.reply(formatStats(stats.total, stats.byCategory, stats.lastSync));
    } catch (err) {
      logger.error('/stats failed', { error: err.message });
      await ctx.reply('❌ Ошибка получения статистики.');
    }
  });

  bot.command('models', authMiddleware, (ctx) => {
    ctx.reply(formatModels());
  });

  bot.command('export', authMiddleware, async (ctx) => {
    const args = ctx.message.text.split(' ');
    const limit = parseInt(args[1], 10) || 50;

    try {
      const records = await db.exportRecords(limit);

      if (records.length === 0) {
        return ctx.reply('📭 База знаний пуста.');
      }

      const header = 'ID,Дата,Категория,Проблема,Решение';
      const rows = records.map(r => {
        const date = new Date(r.created_at).toLocaleDateString('ru-RU');
        const prob = (r.summary_problem || '').replace(/"/g, '""');
        const sol = (r.summary_solution || '').replace(/"/g, '""');
        return `${r.id},${date},${r.category},"${prob}","${sol}"`;
      });

      const csv = [header, ...rows].join('\n');
      const buffer = Buffer.from(csv, 'utf-8');

      await ctx.replyWithDocument({
        source: buffer,
        filename: `sabka-kb-export-${records.length}.csv`,
      });
    } catch (err) {
      logger.error('/export failed', { error: err.message });
      await ctx.reply('❌ Ошибка экспорта.');
    }
  });

  bot.command('add_category', authMiddleware, async (ctx) => {
    const text = ctx.message.text.replace('/add_category', '').trim();
    const spaceIdx = text.indexOf(' ');

    if (!text || spaceIdx === -1) {
      return ctx.reply('Формат: /add_category название описание\nПример: /add_category баги_картинки Проблемы с AI изображениями');
    }

    const name = text.substring(0, spaceIdx).trim();
    const description = text.substring(spaceIdx + 1).replace(/"/g, '').trim();

    try {
      const result = await db.addCategory(name, description);
      if (result.exists) {
        return ctx.reply(`⚠️ Категория "${name}" уже существует.`);
      }
      await ctx.reply(
        `✅ Категория добавлена: ${name}\n📝 ${description}\n\n` +
        '⚠️ Применяется только к новым диалогам.\n' +
        'Хочешь пересчитать старые? → /recalculate'
      );
    } catch (err) {
      logger.error('/add_category failed', { error: err.message });
      await ctx.reply('❌ Ошибка добавления категории.');
    }
  });

  bot.command('change', authMiddleware, async (ctx) => {
    const rule = ctx.message.text.replace('/change', '').trim();
    if (!rule) {
      return ctx.reply('Формат: /change [правило]\nПример: /change записывай баги по картинкам в баги_картинки');
    }

    try {
      await db.addRule(rule);
      await ctx.reply('✅ Правило добавлено.\n🔄 Начинаю пересчет базы...');

      const records = await db.getAllRecords();
      const categories = await db.getCategories();
      const rules = await db.getRules();

      if (records.length === 0) {
        return ctx.reply('✅ Правило сохранено. База пуста — пересчёт не нужен.');
      }

      const { processed, failed } = await recalculateRecords(records, categories, rules, ctx);
      await ctx.reply(`✅ Пересчет завершен! Обработано: ${processed}, ошибок: ${failed}, всего: ${records.length}.`);
    } catch (err) {
      logger.error('/change failed', { error: err.message });
      await ctx.reply('❌ Ошибка при пересчете.');
    }
  });

  bot.command('recalculate', authMiddleware, async (ctx) => {
    const filterCategory = ctx.message.text.replace('/recalculate', '').trim() || null;

    try {
      const records = await db.getAllRecords(filterCategory);
      if (records.length === 0) {
        return ctx.reply(`📭 Нет записей${filterCategory ? ` в категории "${filterCategory}"` : ''}.`);
      }

      await ctx.reply(`🔄 Пересчитываю ${records.length} записей...`);

      const categories = await db.getCategories();
      const rules = await db.getRules();

      const { processed, failed } = await recalculateRecords(records, categories, rules, ctx);
      await ctx.reply(`✅ Пересчет завершён! Обработано: ${processed}, ошибок: ${failed}, всего: ${records.length}.`);
    } catch (err) {
      logger.error('/recalculate failed', { error: err.message });
      await ctx.reply('❌ Ошибка при пересчете.');
    }
  });

  bot.command('rebuild_kb', authMiddleware, async (ctx) => {
    await ctx.reply('🔨 Запускаю пересборку KB...\nШаг A: импорт из chat_history');

    try {
      const categories = await db.getCategories();
      const rules = await db.getRules();
      const validCats = categories.map(c => c.name);

      // === STEP A: import sessions from chat_history ===
      const rows = await db.getChatHistory();

      // Group rows by (platform, user_id) — tg and max user IDs are independent name-spaces
      const byUser = {};
      for (const row of rows) {
        const key = `${row.platform || 'tg'}:${row.user_id}`;
        if (!byUser[key]) byUser[key] = [];
        byUser[key].push(row);
      }

      // Split each user's messages into sessions (gap > 4h = new session)
      const SESSION_GAP_MS = 4 * 60 * 60 * 1000;
      const sessions = [];
      for (const messages of Object.values(byUser)) {
        let session = [messages[0]];
        for (let i = 1; i < messages.length; i++) {
          const gap = new Date(messages[i].created_at) - new Date(messages[i - 1].created_at);
          if (gap > SESSION_GAP_MS) {
            sessions.push(session);
            session = [];
          }
          session.push(messages[i]);
        }
        if (session.length > 0) sessions.push(session);
      }

      // Filter sessions with at least 1 user + 1 assistant message
      const validSessions = sessions.filter(s =>
        s.some(m => m.role === 'user') && s.some(m => m.role === 'assistant')
      );

      let added = 0;
      let addFailed = 0;
      for (let i = 0; i < validSessions.length; i++) {
        const session = validSessions[i];
        const dialogText = session
          .map(m => `${m.role === 'user' ? '[USER]' : '[БОТА]'}: ${m.content}`)
          .join('\n');

        try {
          const analysis = await ai.analyzeDialog(dialogText, categories, rules);
          if (!validCats.includes(analysis.category)) analysis.category = 'прочее';

          const embeddingText = `${analysis.summary_problem} ${analysis.summary_solution}`;
          const embedding = await ai.generateEmbedding(embeddingText);

          await db.insertDialog({
            telegramMessageId: null,
            telegramUserId: session[0].user_id,
            category: analysis.category,
            fullDialog: dialogText,
            summaryProblem: analysis.summary_problem,
            summarySolution: analysis.summary_solution,
            embedding,
            quality: 1.0,
          });

          added++;
          if (added % 5 === 0) {
            try {
              await ctx.reply(`Шаг A: ${added}/${validSessions.length} сессий`);
            } catch (e) { /* Telegram rate limit */ }
          }
        } catch (err) {
          addFailed++;
          logger.error('rebuild_kb: failed to process session', { i, error: err.message });
        }

        await new Promise(r => setTimeout(r, 500));
      }

      await ctx.reply(`Шаг A завершён: добавлено ${added}, ошибок ${addFailed}\n\nШаг B: переклассификация...`);

      // === STEP B: reclassify existing support_kb records ===
      const existing = await db.getAllRecords();
      const { processed, failed } = await recalculateRecords(existing, categories, rules, ctx);

      await ctx.reply(
        `✅ Готово.\nДобавлено из chat_history: ${added}\nПереклассифицировано: ${processed}/${existing.length}, ошибок: ${failed}`
      );
    } catch (err) {
      logger.error('/rebuild_kb failed', { error: err.message });
      await ctx.reply('❌ Ошибка при пересборке KB: ' + err.message);
    }
  });

  logger.info('Commands registered');
}

module.exports = { setupCommands };
