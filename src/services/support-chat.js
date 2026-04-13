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

// --- POST-VALIDATION (anti-hallucination) ---

// Only these URLs may appear in bot responses
const ALLOWED_URLS = [
  'sabka.pro',
  'sabka.pro/prompts',
  'forms.gle/bqN1QuxkG28jo8M67',
];

// Phrases the system prompt explicitly forbids
const FORBIDDEN_PHRASES = [
  'уточню у команды',
  'уточнил у команды',
  'уточню у коллег',
  'уточнил у коллег',
  'вернусь с ответом',
  'я передам информацию команде',
  'передам команде и вернусь',
  'временно недоступна',
  'временно не работает',
  'функция сейчас не работает',
  'эта функция недоступна',
  'сервис временно недоступен',
  'мы работаем над восстановлением',
];

// Features SABKA does NOT have — if bot mentions these as existing, it's a hallucination
const FAKE_FEATURES = [
  'создать pptx',
  'создание pptx',
  'экспорт в pptx',
  'скачать презентацию',
  'ии-агент',
  'ии-бот',
  'ai-агент',
  'запускать приложения',
  'отправлять email',
  'отправить email',
  'управлять crm',
  'интеграция с crm',
  'создание ботов',
  'построить бота',
  'автоматизация процессов',
  'projects folders',
  'папки проектов',
];

/**
 * Validate AI response before sending to user.
 * Returns { text, issues } where issues is an array of detected problems.
 * If critical issue found — text is replaced with escalation message.
 */
function validateResponse(text) {
  const issues = [];
  let cleaned = text;

  // 1. Strip unauthorized URLs (keep only whitelisted)
  const urlRegex = /https?:\/\/[^\s),]+/g;
  cleaned = cleaned.replace(urlRegex, (url) => {
    const isAllowed = ALLOWED_URLS.some(allowed => url.includes(allowed));
    if (!isAllowed) {
      issues.push({ type: 'blocked_url', detail: url });
      return '';
    }
    return url;
  });

  // 2. Check for forbidden phrases (lies the bot must not tell)
  const lower = cleaned.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) {
      issues.push({ type: 'forbidden_phrase', detail: phrase });
    }
  }

  // 3. Check for hallucinated features (bot claims SABKA can do something it can't)
  for (const fake of FAKE_FEATURES) {
    if (lower.includes(fake)) {
      issues.push({ type: 'fake_feature', detail: fake });
    }
  }

  // If forbidden phrase or fake feature detected — replace entire response with escalation
  const hasCritical = issues.some(i => i.type === 'forbidden_phrase' || i.type === 'fake_feature');
  if (hasCritical) {
    logger.warn('support-chat: validation BLOCKED response', { issues });
    cleaned = 'Хороший вопрос — хочу дать Вам точный ответ. Передаю команде, они напишут. [ESCALATE]';
  }

  // Clean up double spaces left after URL removal
  cleaned = cleaned.replace(/  +/g, ' ').trim();

  return { text: cleaned, issues };
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
      await escalationStore.storeEscalation(sent.message_id, userId, userText);
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
  // If this fails, tell the user and bail — don't proceed with a broken history
  try {
    await chatHistory.saveMessage(userId, 'user', userText);
  } catch (err) {
    logger.error('support-chat: failed to save user message', { userId, error: err.message });
    const businessConnectionId = ctx.update?.business_message?.business_connection_id;
    await ctx.telegram.sendMessage(msg.chat.id, 'Произошла техническая ошибка. Попробуйте написать ещё раз через минуту.', {
      ...(businessConnectionId && { business_connection_id: businessConnectionId }),
    }).catch(() => {});
    return;
  }

  // 2. Fetch history + context + reply count in parallel
  logger.info('support-chat: step 2 — getHistory + retrieveContext + countReplies', { userId });
  const SESSION_WINDOW_MS = 4 * 60 * 60 * 1000;
  const sessionCutoff = new Date(Date.now() - SESSION_WINDOW_MS);
  const [allHistory, retrievedContext, repliesGiven] = await Promise.all([
    chatHistory.getHistory(userId, config.supportChat.historyLimit),
    retrieveContext(userText),
    chatHistory.countRepliesInWindow(userId, sessionCutoff),
  ]);
  logger.info('support-chat: step 2 OK', { userId, historyLen: allHistory.length, repliesGiven });

  // THREE-REPLY MODE: exact count from DB (not limited by historyLimit).
  // Reply 1-2: normal AI responses. Reply 3: forced escalation to human.
  // After 3 replies: silent skip.

  if (repliesGiven >= 3) {
    logger.info('support-chat: skipping (3 replies in current session)', { userId });
    return;
  }

  // 3rd reply — forced escalation to human team
  if (repliesGiven === 2) {
    logger.info('support-chat: 3rd reply — forced escalation', { userId });
    const escalationMsg = 'Похоже, вопрос пока не решён. Передаю команде — живой человек разберётся и напишет Вам.';
    const businessConnectionId = ctx.update?.business_message?.business_connection_id;
    await ctx.telegram.sendMessage(msg.chat.id, escalationMsg, {
      ...(businessConnectionId && { business_connection_id: businessConnectionId }),
    });
    try { await chatHistory.saveMessage(userId, 'assistant', escalationMsg); }
    catch (err) { logger.error('support-chat: failed to save escalation reply', { userId, error: err.message }); }
    const username = msg.from?.username || msg.chat?.username;
    await notifyAdmins(bot, userId, username, userText);
    logger.info('support-chat: forced escalation done', { userId });
    return;
  }

  // 3. Build messages array — strip created_at before passing to OpenRouter
  // Filter to current session, exclude the last item (user message we just saved)
  const sessionMessages = allHistory.filter(m => new Date(m.created_at) >= sessionCutoff);
  const history = sessionMessages.slice(0, -1).map(({ role, content }) => ({ role, content }));
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
  const rawResponse = await ai.chatCompletion(model, messages, { temperature: 0.4, maxTokens: 300 });
  logger.info('support-chat: step 5 OK', { userId, responseLen: rawResponse.length });

  // 5.5. Post-validation — catch hallucinations, forbidden phrases, bad URLs
  const validation = validateResponse(rawResponse);
  if (validation.issues.length > 0) {
    logger.info('support-chat: validation issues', { userId, issues: validation.issues });
  }
  const response = validation.text;

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

  // 9. Persist assistant reply to history (non-fatal — response already sent)
  try {
    await chatHistory.saveMessage(userId, 'assistant', cleanResponse);
  } catch (err) {
    logger.error('support-chat: failed to save assistant reply', { userId, error: err.message });
  }

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
