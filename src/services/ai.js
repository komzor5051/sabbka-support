const config = require('../config');
const logger = require('../utils/logger');

const OPENROUTER_BASE = config.openrouter.baseUrl;
const API_KEY = config.openrouter.apiKey;

async function chatCompletion(model, messages, { temperature = 0.3, maxTokens = 1024 } = {}) {
  const start = Date.now();

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('OpenRouter error', { status: res.status, body: text });
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  const elapsed = Date.now() - start;
  const usage = data.usage || {};

  logger.info('AI request', {
    model,
    tokens: usage.total_tokens,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    elapsed_ms: elapsed,
  });

  return data.choices[0].message.content;
}

// ~7000 tokens ≈ 14000 chars for Russian (2 chars/token average for Cyrillic)
const EMBEDDING_MAX_CHARS = 14000;

function truncateForEmbedding(text) {
  if (text.length <= EMBEDDING_MAX_CHARS) return text;
  return text.substring(0, EMBEDDING_MAX_CHARS);
}

async function generateEmbedding(text) {
  const truncated = truncateForEmbedding(text);
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openrouter.models.embedding,
      input: truncated,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error('Embedding error', { status: res.status, body });
    throw new Error(`Embedding ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

async function analyzeDialog(fullDialog, categories, rules) {
  const categoryList = categories.map(c => `- ${c.name}: ${c.description}`).join('\n');
  const rulesText = rules.length > 0
    ? `\nДополнительные правила категоризации:\n${rules.map(r => `- ${r}`).join('\n')}`
    : '';

  const prompt = `Проанализируй диалог из службы поддержки. Верни JSON (без markdown):
{
  "summary_problem": "подробное описание проблемы пользователя со всеми деталями, контекстом и шагами воспроизведения (5-15 предложений)",
  "summary_solution": "подробное описание решения, что именно посоветовали, какие шаги предложили, чем закончился диалог (5-15 предложений)",
  "category": "одна из категорий ниже"
}

ВАЖНО: summary_problem и summary_solution должны быть МАКСИМАЛЬНО подробными и конкретными.
Включай все детали из диалога: конкретные ошибки, названия моделей, действия пользователя, точные формулировки решения.
НЕ обобщай, НЕ абстрагируй — сохраняй конкретику.

Доступные категории:
${categoryList}
${rulesText}

Выбери ОДНУ категорию, которая лучше всего подходит. Если ничего не подходит — "прочее".

Диалог:
${fullDialog}`;

  const result = await chatCompletion(
    config.openrouter.models.gemini,
    [{ role: 'user', content: prompt }],
    { temperature: 0.1, maxTokens: 2048 }
  );

  try {
    return JSON.parse(result.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
  } catch (e) {
    logger.error('Failed to parse AI analysis', { result });
    return {
      summary_problem: 'Не удалось определить',
      summary_solution: 'Не удалось определить',
      category: 'прочее',
    };
  }
}

async function generateAnswer(query, similarCases, { temperature = 0.4 } = {}) {
  if (similarCases.length === 0) {
    return null;
  }

  const casesText = similarCases.map((c, i) =>
    `Кейс ${i + 1} (совпадение ${Math.round(c.similarity * 100)}%):\nПроблема: ${c.summary_problem}\nРешение: ${c.summary_solution}\nДиалог: ${c.full_dialog?.substring(0, 2000)}`
  ).join('\n\n');

  const prompt = `Ты — помощник оператора поддержки сервиса "Сабка" (sabka.pro — мультичат с AI моделями).
На основе похожих кейсов из базы знаний, сформулируй ответ для пользователя.

Запрос оператора: "${query}"

Похожие кейсы из базы:
${casesText}

Напиши готовый ответ пользователю. Будь дружелюбным, конкретным, без воды. Если кейсы не очень релевантны — честно скажи.`;

  return chatCompletion(
    config.openrouter.models.gemini,
    [{ role: 'user', content: prompt }],
    { temperature, maxTokens: 512 }
  );
}

async function transcribeVoice(audioBuffer) {
  const base64 = audioBuffer.toString('base64');

  // Gemini via OpenRouter accepts inline_data format for audio
  return chatCompletion(
    config.openrouter.models.gemini,
    [{
      role: 'user',
      content: [
        { type: 'text', text: 'Транскрибируй это голосовое сообщение. Верни только текст, без пояснений.' },
        {
          type: 'image_url',
          image_url: {
            url: `data:audio/ogg;base64,${base64}`,
          },
        },
      ],
    }],
    { temperature: 0.1, maxTokens: 2048 }
  );
}

module.exports = {
  analyzeDialog,
  generateEmbedding,
  generateAnswer,
  transcribeVoice,
};
