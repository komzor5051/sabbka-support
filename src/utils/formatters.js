const TG_MAX_LENGTH = 4096;

function truncate(str, max) {
  if (!str || str.length <= max) return str || 'N/A';
  return str.substring(0, max - 1) + '…';
}

/**
 * Format search results for Telegram message
 */
function formatSearchResults(results, generatedAnswer) {
  if (results.length === 0) {
    return '⚠️ В базе знаний пока нет похожих кейсов.';
  }

  const avgSimilarity = results.reduce((sum, r) => sum + r.similarity, 0) / results.length;
  const confidence = avgSimilarity > 0.7 ? 'высокая' : avgSimilarity > 0.5 ? 'средняя' : 'низкая';

  let text = `🔍 Найдено похожих кейсов: ${results.length}\n\n`;

  results.forEach((r, i) => {
    const pct = Math.round(r.similarity * 100);
    text += `${i + 1}. [${pct}% совпадение]\n`;
    text += `   Проблема: ${truncate(r.summary_problem, 300)}\n`;
    text += `   Решение: ${truncate(r.summary_solution, 300)}\n`;
    text += `   Категория: ${r.category}\n\n`;
  });

  if (generatedAnswer) {
    text += `💡 Рекомендуемый ответ (уверенность: ${confidence}):\n`;
    text += `"${generatedAnswer}"`;
  }

  // Safety net: Telegram rejects messages over 4096 chars
  if (text.length > TG_MAX_LENGTH) {
    text = text.substring(0, TG_MAX_LENGTH - 1) + '…';
  }

  return text;
}

/**
 * Format stats for /stats command
 */
function formatStats(total, byCat, lastSync) {
  let text = '📊 Статистика базы знаний:\n\n';
  text += `Всего диалогов: ${total}\n`;
  text += 'По категориям:\n';

  for (const { category, count } of byCat) {
    text += `  • ${category}: ${count}\n`;
  }

  if (lastSync) {
    const ago = Math.round((Date.now() - new Date(lastSync).getTime()) / 60000);
    text += `\nПоследняя синхронизация: ${ago} мин назад`;
  } else {
    text += '\nСинхронизация с Sheets: не выполнялась';
  }

  return text;
}

/**
 * Format models list for /models command
 */
function formatModels() {
  return `📱 Актуальные модели САБКА:

OpenAI:
• GPT 5 nano
• GPT 5 Mini
• GPT 5
• GPT 4.1 Mini
• o3 mini
• o3
• GPT 5.2
• GPT 5.2 Codex
• GPT 5 Imagex
• GPT 5 Image Mini

Anthropic:
• Claude 3 Haiku
• Claude Opus 4.6
• Claude 4.5 Sonnet

Google:
• Gemini 2.5 Flash
• Gemini 3 Pro
• Nano Banana
• Nano Banana Pro

xAI:
• Grok 4.1 Fast
• Grok Code Fast 1
• Grok 4

Perplexity:
• Perplexity Sonar
• Perplexity Sonar Pro

DeepSeek:
• DeepSeek V3
• DeepSeek V3.2
• DeepSeek R1

MiniMax:
• MiniMax M2.1

Kimi:
• Kimi 2.5

Xiaomi:
• Xiaomi MiMo V2 Flash`;
}

module.exports = { formatSearchResults, formatStats, formatModels };
