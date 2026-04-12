const config = require('../config');
const logger = require('../utils/logger');
const ai = require('./ai');
const db = require('./database');
const chatHistory = require('./chat-history');
const escalationStore = require('./escalation-store');

const ESCALATE_TAG = '[ESCALATE]';

// Per-user processing queue — ensures messages from the same user are handled
// sequentially, so history is consistent even when messages arrive in rapid succession.
const userQueues = new Map(); // userId -> Promise

function enqueue(userId, task) {
  const prev = userQueues.get(userId) || Promise.resolve();
  const next = prev.then(task).catch(() => {});
  userQueues.set(userId, next);
  next.finally(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId);
  });
  return next;
}

// Fallback: if user explicitly asks for a human, escalate even if model forgot the tag
const USER_ESCALATION_PHRASES = [
  'позови человека', 'позовите человека',
  'хочу человека', 'хочу оператора', 'хочу менеджера',
  'живой человек', 'живого человека', 'живой оператор',
  'соедините с человеком', 'соедини с человеком',
  'переведите на человека', 'переведи на человека',
  'поговорить с человеком', 'связаться с человеком',
  'нужен человек', 'нужен оператор',
  'дайте человека', 'дай человека',
];

function userAskedForHuman(text) {
  const lower = text.toLowerCase();
  return USER_ESCALATION_PHRASES.some(phrase => lower.includes(phrase));
}

/**
 * Strip markdown formatting from AI response — Telegram plain text only.
 */
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')       // headings
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1') // bold+italic
    .replace(/\*\*(.*?)\*\*/g, '$1')     // bold
    .replace(/\*(.*?)\*/g, '$1')         // italic
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim()) // code blocks → plain
    .replace(/`([^`]+)`/g, '$1')         // inline code
    .replace(/^---+$/gm, '')             // horizontal rules
    .replace(/^[-*]\s+/gm, '- ')         // normalize list markers (keep readable)
    .replace(/\n{3,}/g, '\n\n')          // collapse excessive newlines
    .trim();
}

/**
 * Determine if message warrants Exa web search (:online suffix).
 * Adds $0.02 per request — only for diagnostic/technical queries.
 */
function needsOnline(text) {
  const lower = text.toLowerCase();
  return config.supportChat.onlineKeywords.some(k => lower.includes(k));
}

/**
 * Retrieve relevant KB sections + similar past cases in one embedding call.
 * Returns { kbSectionsText, pastCasesText }.
 */
async function retrieveContext(userText) {
  const empty = { kbSectionsText: '', pastCasesText: '' };

  // Skip retrieval for very short messages (greetings, "ок", etc.)
  if (!userText || userText.trim().length < 15) return empty;

  try {
    // One embedding, two parallel searches
    const embedding = await ai.generateEmbedding(userText);
    const [sections, cases] = await Promise.all([
      db.searchKbSections(embedding, 2, 0.50),
      db.searchSimilar(embedding, 3, null, 0.70),
    ]);

    // Format KB sections
    let kbSectionsText = '';
    if (sections && sections.length > 0) {
      kbSectionsText = sections.map(s => s.content).join('\n\n---\n\n');
      logger.info('support-chat: KB sections retrieved', { count: sections.length, ids: sections.map(s => s.id) });
    }

    // Format past cases
    let pastCasesText = '';
    if (cases && cases.length > 0) {
      const MAX_CHARS = 400;
      const trim = (s) => s && s.length > MAX_CHARS ? s.substring(0, MAX_CHARS) + '…' : s;
      const block = cases.map((c, i) => {
        const sim = Math.round(c.similarity * 100);
        return `Кейс ${i + 1} (${sim}%):\nПроблема: ${trim(c.summary_problem)}\nРешение: ${trim(c.summary_solution)}`;
      }).join('\n\n');
      pastCasesText = `\n\nПОХОЖИЕ ПРОШЛЫЕ КЕЙСЫ (референс, НЕ цитируй дословно):\n${block}`;
    }

    return { kbSectionsText, pastCasesText };
  } catch (err) {
    logger.error('support-chat: retrieval failed', { error: err.message });
    return empty;
  }
}

/**
 * Build the messages array for OpenRouter:
 * [system prompt (core) + relevant KB sections + past cases] + [history] + [user message]
 *
 * System prompt = rules, escalation, tone (~5K tokens, always present)
 * KB sections = 2 most relevant sections (~2K tokens, selective)
 * Past cases = 3 similar past dialogs (~1K tokens, selective)
 * Total: ~8K tokens instead of ~22K
 */
function buildMessages(userText, history, retrievedContext) {
  let systemPromptTemplate;
  try {
    systemPromptTemplate = config.supportChat.systemPrompt;
  } catch (err) {
    logger.error('support-chat: failed to read system-prompt.md', { error: err.message });
    systemPromptTemplate = 'Ты — ассистент поддержки Сабка.';
  }

  // System prompt without {knowledge_base} — KB is now retrieved selectively
  let systemContent = systemPromptTemplate.replace('{knowledge_base}', '');

  // Inject relevant KB sections
  if (retrievedContext.kbSectionsText) {
    systemContent += '\n\n---\nРЕЛЕВАНТНЫЕ РАЗДЕЛЫ БАЗЫ ЗНАНИЙ:\n\n' + retrievedContext.kbSectionsText;
  }

  // Inject past cases
  if (retrievedContext.pastCasesText) {
    systemContent += '\n\n---' + retrievedContext.pastCasesText;
  }

  return [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userText },
  ];
}

/**
 * Notify all admins about an escalated conversation.
 * Errors here are non-fatal — user still gets a reply.
 */
async function notifyAdmins(bot, userId, username, userText) {
  const userLabel = username ? `@${username}` : `ID ${userId}`;
  const truncatedText = userText.length > 500 ? userText.substring(0, 500) + '…' : userText;
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const alert =
    `🆘 Бот не смог ответить\n\n` +
    `От пользователя: ${userLabel}\n` +
    `Вопрос: ${truncatedText}\n` +
    `Время: ${timestamp}\n\n` +
    `Ответьте на это сообщение — ответ уйдёт пользователю.`;

  for (const adminId of config.escalationUserIds) {
    try {
      const sent = await bot.telegram.sendMessage(adminId, alert);
      escalationStore.storeEscalation(sent.message_id, userId);
    } catch (err) {
      logger.error('support-chat: failed to notify admin', { adminId, error: err.message });
    }
  }
}

/**
 * Core logic — runs sequentially per user inside the queue.
 */
async function _handle(ctx, msg, bot) {
  const userId = msg.chat.id;
  const userText = msg.text;

  logger.info('support-chat: START', { userId, textLen: userText.length });

  // 1. Save user message FIRST — so the next queued message sees it in history
  await chatHistory.saveMessage(userId, 'user', userText);

  // 2. Fetch history + context (KB sections + past cases) in parallel
  logger.info('support-chat: step 2 — getHistory + retrieveContext', { userId });
  const [allHistory, retrievedContext] = await Promise.all([
    chatHistory.getHistory(userId, config.supportChat.historyLimit),
    retrieveContext(userText),
  ]);
  logger.info('support-chat: step 2 OK', { userId, historyLen: allHistory.length });

  // TWO-REPLY MODE: count only replies within current session (last 4 hours).
  // If user comes back after 4h — treat as a new session, counter resets.
  const SESSION_WINDOW_MS = 4 * 60 * 60 * 1000;
  const sessionCutoff = new Date(Date.now() - SESSION_WINDOW_MS);
  const sessionHistory = allHistory.filter(m => new Date(m.created_at) >= sessionCutoff);
  const repliesGiven = sessionHistory.filter(m => m.role === 'assistant').length;
  if (repliesGiven >= 2) {
    logger.info('support-chat: skipping (2 replies in current session)', { userId });
    return;
  }

  // 3. Build messages array — strip created_at before passing to OpenRouter
  // Exclude the last item (user message we just saved) since it's passed separately
  const history = sessionHistory.slice(0, -1).map(({ role, content }) => ({ role, content }));
  const messages = buildMessages(userText, history, retrievedContext);
  logger.info('support-chat: step 3 — messages built', { userId, msgCount: messages.length });

  // 4. Select model — add :online for diagnostic queries
  const model = needsOnline(userText)
    ? config.openrouter.models.gemini + ':online'
    : config.openrouter.models.gemini;

  if (model.endsWith(':online')) {
    logger.info('support-chat: using :online (Exa search)', { userId });
  }

  // 5. Call OpenRouter
  logger.info('support-chat: step 5 — calling AI', { userId, model });
  const response = await ai.chatCompletion(model, messages, { temperature: 0.4, maxTokens: 300 });
  logger.info('support-chat: step 5 OK', { userId, responseLen: response.length });

  // 6. Detect escalation: model tag OR user explicitly asked for human
  const hasModelTag = response.includes(ESCALATE_TAG);
  const hasUserRequest = userAskedForHuman(userText);
  const shouldEscalate = hasModelTag || hasUserRequest;
  const cleanResponse = stripMarkdown(response.replaceAll(ESCALATE_TAG, '').trim());

  // 7. Notify admins if escalated
  if (shouldEscalate) {
    const reason = hasModelTag ? 'model_tag' : 'user_request';
    logger.info('support-chat: escalating', { userId, reason });
    const username = msg.from?.username || msg.chat?.username;
    await notifyAdmins(bot, userId, username, userText);
  }

  // 8. Reply to user via business connection (required for Business API)
  logger.info('support-chat: step 8 — sending reply', { userId });
  const businessConnectionId = ctx.update?.business_message?.business_connection_id;
  await ctx.telegram.sendMessage(msg.chat.id, cleanResponse, {
    ...(businessConnectionId && { business_connection_id: businessConnectionId }),
  });

  // 9. Persist assistant reply to history
  await chatHistory.saveMessage(userId, 'assistant', cleanResponse);

  logger.info('support-chat: replied', { userId, escalated: shouldEscalate });
}

/**
 * Public handle — enqueues per user to ensure sequential processing.
 * Silently fails on error to avoid disrupting KB building.
 */
async function handle(ctx, msg, bot) {
  const userId = msg.chat.id;
  return enqueue(userId, () => _handle(ctx, msg, bot).catch((err) => {
    logger.error('support-chat: handle failed', { userId, error: err.message, stack: err.stack });
  }));
}

module.exports = { handle };
