const logger = require('../utils/logger');
const db = require('../services/database');
const ai = require('../services/ai');
const { formatStats, formatModels } = require('../utils/formatters');

function setupCommands(bot, { syncSheets }) {
  bot.command('start', (ctx) => {
    ctx.reply(
      '👋 Привет! Я бот базы знаний поддержки Сабка.\n\n' +
      'Что умею:\n' +
      '• Напиши вопрос — найду похожие кейсы в базе\n' +
      '• Отправь голосовое — транскрибирую и найду\n' +
      '• Перешли сообщение юзера — подберу ответ\n\n' +
      'Команды:\n' +
      '/stats — статистика базы\n' +
      '/models — список моделей Сабка\n' +
      '/export [N] — выгрузить CSV\n' +
      '/sync_now — синхр. с Google Sheets\n' +
      '/add_category [имя] [описание]\n' +
      '/change [правило] — изменить категоризацию\n' +
      '/recalculate [категория] — пересчитать'
    );
  });

  bot.command('stats', async (ctx) => {
    try {
      const stats = await db.getStats();
      await ctx.reply(formatStats(stats.total, stats.byCategory, stats.lastSync));
    } catch (err) {
      logger.error('/stats failed', { error: err.message });
      await ctx.reply('❌ Ошибка получения статистики.');
    }
  });

  bot.command('models', (ctx) => {
    ctx.reply(formatModels());
  });

  bot.command('export', async (ctx) => {
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

  bot.command('sync_now', async (ctx) => {
    try {
      await ctx.reply('🔄 Запускаю синхронизацию с Google Sheets...');
      const count = await syncSheets();
      await ctx.reply(`✅ Синхронизировано записей: ${count}`);
    } catch (err) {
      logger.error('/sync_now failed', { error: err.message });
      await ctx.reply('❌ Ошибка синхронизации.');
    }
  });

  bot.command('add_category', async (ctx) => {
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

  bot.command('change', async (ctx) => {
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

      let processed = 0;
      for (const record of records) {
        const analysis = await ai.analyzeDialog(record.full_dialog, categories, rules);

        const validCats = categories.map(c => c.name);
        if (!validCats.includes(analysis.category)) {
          analysis.category = 'прочее';
        }

        const embedding = await ai.generateEmbedding(
          `${analysis.summary_problem} ${analysis.summary_solution}`
        );

        await db.updateRecord(record.id, {
          category: analysis.category,
          summaryProblem: analysis.summary_problem,
          summarySolution: analysis.summary_solution,
          embedding,
        });

        processed++;
        if (processed % 10 === 0) {
          await ctx.reply(`🔄 Обработано ${processed}/${records.length}...`);
        }
      }

      await ctx.reply(`✅ Пересчет завершен! Обработано: ${processed} записей.`);
    } catch (err) {
      logger.error('/change failed', { error: err.message });
      await ctx.reply('❌ Ошибка при пересчете.');
    }
  });

  bot.command('recalculate', async (ctx) => {
    const filterCategory = ctx.message.text.replace('/recalculate', '').trim() || null;

    try {
      const records = await db.getAllRecords(filterCategory);
      if (records.length === 0) {
        return ctx.reply(`📭 Нет записей${filterCategory ? ` в категории "${filterCategory}"` : ''}.`);
      }

      await ctx.reply(`🔄 Пересчитываю ${records.length} записей...`);

      const categories = await db.getCategories();
      const rules = await db.getRules();

      let processed = 0;
      for (const record of records) {
        const analysis = await ai.analyzeDialog(record.full_dialog, categories, rules);

        const validCats = categories.map(c => c.name);
        if (!validCats.includes(analysis.category)) {
          analysis.category = 'прочее';
        }

        const embedding = await ai.generateEmbedding(
          `${analysis.summary_problem} ${analysis.summary_solution}`
        );

        await db.updateRecord(record.id, {
          category: analysis.category,
          summaryProblem: analysis.summary_problem,
          summarySolution: analysis.summary_solution,
          embedding,
        });

        processed++;
        if (processed % 10 === 0) {
          await ctx.reply(`🔄 Обработано ${processed}/${records.length}...`);
        }
      }

      await ctx.reply(`✅ Пересчет завершён! Обработано: ${processed} записей.`);
    } catch (err) {
      logger.error('/recalculate failed', { error: err.message });
      await ctx.reply('❌ Ошибка при пересчете.');
    }
  });

  logger.info('Commands registered');
}

module.exports = { setupCommands };
