const config = require('../config');
const logger = require('../utils/logger');

const OPENROUTER_BASE = config.openrouter.baseUrl;
const API_KEY = config.openrouter.apiKey;

/**
 * Fetch with retry + exponential backoff for 429/5xx.
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxRetries) {
        const text = await res.text();
        throw new Error(`OpenRouter ${res.status} after ${maxRetries + 1} attempts: ${text}`);
      }
      const retryAfter = res.headers.get('retry-after');
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * 2 ** attempt, 30000);
      logger.warn('OpenRouter rate limit, retrying', { status: res.status, attempt: attempt + 1, delay_ms: delay });
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return res;
  }
}

async function chatCompletion(model, messages, { temperature = 0.3, maxTokens = 1024, tools, toolChoice } = {}) {
  const start = Date.now();

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const res = await fetchWithRetry(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
    has_tools: !!tools,
  });

  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    logger.error('OpenRouter empty response', { data });
    throw new Error('OpenRouter returned empty choices');
  }

  const msg = data.choices[0].message;
  return {
    content: msg.content || '',
    tool_calls: msg.tool_calls || null,
    finish_reason: data.choices[0].finish_reason,
  };
}

// ~7000 tokens ≈ 14000 chars for Russian (2 chars/token average for Cyrillic)
const EMBEDDING_MAX_CHARS = 14000;

function truncateForEmbedding(text) {
  if (text.length <= EMBEDDING_MAX_CHARS) return text;
  return text.substring(0, EMBEDDING_MAX_CHARS);
}

async function generateEmbedding(text) {
  const truncated = truncateForEmbedding(text);
  const res = await fetchWithRetry(`${OPENROUTER_BASE}/embeddings`, {
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
  "summary_problem": "суть проблемы пользователя (3-5 предложений, конкретно, без воды)",
  "summary_solution": "что посоветовали и чем закончилось (3-5 предложений, конкретные шаги)",
  "category": "одна из категорий ниже"
}

ВАЖНО: будь конкретным но кратким. Включай ключевые детали: модель, ошибку, действие.
НЕ пиши "пользователь обратился в службу поддержки" — сразу к сути.

Доступные категории:
${categoryList}
${rulesText}

Выбери ОДНУ категорию, которая лучше всего подходит. Если ничего не подходит — "прочее".

Диалог:
${fullDialog}`;

  const { content } = await chatCompletion(
    config.openrouter.models.analyzer,
    [{ role: 'user', content: prompt }],
    { temperature: 0.1, maxTokens: 2048 }
  );

  try {
    return JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
  } catch (e) {
    logger.error('Failed to parse AI analysis', { result: content });
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

  // ~1500 tokens per memory = 3000 chars for Cyrillic (2 chars/token)
  const MEMORY_MAX_CHARS = 3000;
  const casesText = similarCases.map((c, i) => {
    const block = `Кейс ${i + 1} (совпадение ${Math.round(c.similarity * 100)}%):\nПроблема: ${c.summary_problem}\nРешение: ${c.summary_solution}\nДиалог: ${c.full_dialog || ''}`;
    return block.substring(0, MEMORY_MAX_CHARS);
  }).join('\n\n');

  const prompt = `Ты — помощник оператора поддержки сервиса "Сабка" (sabka.pro — мультичат с AI моделями).
На основе похожих кейсов из базы знаний, сформулируй ответ для пользователя.

Запрос оператора: "${query}"

Похожие кейсы из базы:
${casesText}

Напиши готовый ответ пользователю. Будь дружелюбным, конкретным, без воды. Если кейсы не очень релевантны — честно скажи.`;

  const { content } = await chatCompletion(
    config.openrouter.models.analyzer,
    [{ role: 'user', content: prompt }],
    { temperature, maxTokens: 512 }
  );
  return content;
}

async function transcribeVoice(audioBuffer) {
  const base64 = audioBuffer.toString('base64');

  // Gemini via OpenRouter accepts inline_data format for audio
  const { content } = await chatCompletion(
    config.openrouter.models.analyzer,
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
  return content;
}

module.exports = {
  analyzeDialog,
  generateEmbedding,
  generateAnswer,
  transcribeVoice,
  chatCompletion,
};
