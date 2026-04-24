const config = require('../config');
const logger = require('../utils/logger');
const ai = require('./ai');
const chatHistory = require('./chat-history');
const escalationStore = require('./escalation-store');
const kbRetriever = require('./kb-retriever');

const ESCALATE_TAG = '[ESCALATE]';

// Max assistant replies per 4h session.
// 1-3 normal, 4 forced escalation, 5+ silent skip.
const MAX_REPLIES = 5;
const FORCED_ESCALATION_AT = 4;

// ─────────────────────────────────────────────────────────────
// Per-(platform,user) queue — sequential processing so history stays consistent
// ─────────────────────────────────────────────────────────────

const userQueues = new Map();

function queueKey(platform, userId) {
  return `${platform}:${userId}`;
}

function enqueue(platform, userId, task) {
  const key = queueKey(platform, userId);
  const prev = userQueues.get(key) || Promise.resolve();
  const next = prev.then(task).catch(() => {});
  userQueues.set(key, next);
  next.finally(() => {
    if (userQueues.get(key) === next) userQueues.delete(key);
  });
  return next;
}

// ─────────────────────────────────────────────────────────────
// User-side escalation triggers + response validation
// ─────────────────────────────────────────────────────────────

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

function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^---+$/gm, '')
    .replace(/^[-*]\s+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ALLOWED_URLS = [
  'sabka.pro',
  'sabka.pro/prompts',
  'forms.gle/bqN1QuxkG28jo8M67',
];

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

const FAKE_FEATURES = [
  'создать pptx', 'создание pptx', 'экспорт в pptx', 'скачать презентацию',
  'ии-агент', 'ии-бот', 'ai-агент',
  'запускать приложения',
  'отправлять email', 'отправить email',
  'управлять crm', 'интеграция с crm',
  'создание ботов', 'построить бота',
  'автоматизация процессов',
  'projects folders', 'папки проектов',
];

function validateResponse(text) {
  const issues = [];
  let cleaned = text;

  const urlRegex = /https?:\/\/[^\s),]+/g;
  cleaned = cleaned.replace(urlRegex, (url) => {
    const isAllowed = ALLOWED_URLS.some(allowed => url.includes(allowed));
    if (!isAllowed) {
      issues.push({ type: 'blocked_url', detail: url });
      return '';
    }
    return url;
  });

  const lower = cleaned.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) issues.push({ type: 'forbidden_phrase', detail: phrase });
  }
  for (const fake of FAKE_FEATURES) {
    if (lower.includes(fake)) issues.push({ type: 'fake_feature', detail: fake });
  }

  const hasCritical = issues.some(i => i.type === 'forbidden_phrase' || i.type === 'fake_feature');
  if (hasCritical) {
    logger.warn('support-chat: validation BLOCKED response', { issues });
    cleaned = 'Хороший вопрос — хочу дать Вам точный ответ. Передаю команде, они напишут. [ESCALATE]';
  }

  cleaned = cleaned.replace(/  +/g, ' ').trim();
  return { text: cleaned, issues };
}

// KB retrieval shared with admin-chat
const retrieveContext = kbRetriever.retrieveContext;

function buildMessages(userText, history, retrievedContext) {
  let systemPromptTemplate;
  try {
    systemPromptTemplate = config.supportChat.systemPrompt;
  } catch (err) {
    logger.error('support-chat: failed to read system-prompt.md', { error: err.message });
    systemPromptTemplate = 'Ты — ассистент поддержки Сабка.';
  }

  let systemContent = systemPromptTemplate.replace('{knowledge_base}', '');

  if (retrievedContext.kbSectionsText) {
    systemContent += '\n\n---\nРЕЛЕВАНТНЫЕ РАЗДЕЛЫ БАЗЫ ЗНАНИЙ:\n\n' + retrievedContext.kbSectionsText;
  }
  if (retrievedContext.pastCasesText) {
    systemContent += '\n\n---' + retrievedContext.pastCasesText;
  }

  return [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userText },
  ];
}

// ─────────────────────────────────────────────────────────────
// Admin notifications — always go to Telegram (admin lives in TG)
// Platform prefix makes it obvious which user is writing from where.
// ─────────────────────────────────────────────────────────────

async function notifyAdmins(adminBot, platform, userId, username, userText) {
  if (!adminBot) {
    logger.error('notifyAdmins: no adminBot instance');
    return;
  }
  const userLabel = username ? `@${username}` : `ID ${userId}`;
  const platformTag = platform === 'tg' ? '' : `[${platform.toUpperCase()}] `;
  const truncatedText = userText.length > 500 ? userText.substring(0, 500) + '…' : userText;
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const alert =
    `🆘 ${platformTag}Бот не смог ответить\n\n` +
    `От пользователя: ${userLabel}\n` +
    `Вопрос: ${truncatedText}\n` +
    `Время: ${timestamp}\n\n` +
    `Ответьте на это сообщение — ответ уйдёт пользователю.`;

  for (const adminId of config.escalationUserIds) {
    try {
      const sent = await adminBot.telegram.sendMessage(adminId, alert);
      await escalationStore.storeEscalation(sent.message_id, userId, userText, platform);
    } catch (err) {
      logger.error('notifyAdmins: failed', { adminId, error: err.message });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Core handler — platform-agnostic
// ─────────────────────────────────────────────────────────────

async function _handle({ platform, userId, userText, username, sendReply, adminBot }) {
  logger.info('support-chat: START', { platform, userId, textLen: userText.length });

  // 1. Save user message first
  try {
    await chatHistory.saveMessage(platform, userId, 'user', userText);
  } catch (err) {
    logger.error('support-chat: failed to save user message', { platform, userId, error: err.message });
    await sendReply('Произошла техническая ошибка. Попробуйте написать ещё раз через минуту.').catch(() => {});
    return;
  }

  // 2. Fetch history + context + reply count in parallel
  const SESSION_WINDOW_MS = 4 * 60 * 60 * 1000;
  const sessionCutoff = new Date(Date.now() - SESSION_WINDOW_MS);
  const [allHistory, retrievedContext, repliesGiven] = await Promise.all([
    chatHistory.getHistory(platform, userId, config.supportChat.historyLimit),
    retrieveContext(userText),
    chatHistory.countRepliesInWindow(platform, userId, sessionCutoff),
  ]);
  logger.info('support-chat: loaded', { platform, userId, historyLen: allHistory.length, repliesGiven });

  if (repliesGiven >= MAX_REPLIES) {
    logger.info('support-chat: skipping (max replies)', { platform, userId, repliesGiven });
    return;
  }

  if (repliesGiven === FORCED_ESCALATION_AT - 1) {
    logger.info('support-chat: forced escalation', { platform, userId, repliesGiven });
    const escalationMsg = 'Похоже, вопрос пока не решён. Передаю команде — живой человек разберётся и напишет Вам.';
    await sendReply(escalationMsg).catch(() => {});
    try { await chatHistory.saveMessage(platform, userId, 'assistant', escalationMsg); }
    catch (err) { logger.error('support-chat: save escalation failed', { platform, userId, error: err.message }); }
    await notifyAdmins(adminBot, platform, userId, username, userText);
    return;
  }

  // 3. Build messages (no tools for customer flow — admin-chat has tools)
  const sessionMessages = allHistory.filter(m => new Date(m.created_at) >= sessionCutoff);
  const history = sessionMessages.slice(0, -1).map(({ role, content }) => ({ role, content }));
  const messages = buildMessages(userText, history, retrievedContext);

  // 4. Call Grok (no tools for customer privacy)
  const model = config.openrouter.models.chat;
  const aiResponse = await ai.chatCompletion(model, messages, {
    temperature: 0.4,
    maxTokens: 300,
  });

  const rawResponse = aiResponse.content || '';

  // 5. Post-validation
  const validation = validateResponse(rawResponse);
  if (validation.issues.length > 0) {
    logger.info('support-chat: validation issues', { platform, userId, issues: validation.issues });
  }
  const response = validation.text;

  // 6. Escalation detection
  const hasModelTag = response.includes(ESCALATE_TAG);
  const hasUserRequest = userAskedForHuman(userText);
  const shouldEscalate = hasModelTag || hasUserRequest;
  const cleanResponse = stripMarkdown(response.replaceAll(ESCALATE_TAG, '').trim());

  if (shouldEscalate) {
    const reason = hasModelTag ? 'model_tag' : 'user_request';
    logger.info('support-chat: escalating', { platform, userId, reason });
    await notifyAdmins(adminBot, platform, userId, username, userText);
  }

  // 7. Send reply + persist
  await sendReply(cleanResponse).catch((err) => {
    logger.error('support-chat: sendReply failed', { platform, userId, error: err.message });
  });

  try {
    await chatHistory.saveMessage(platform, userId, 'assistant', cleanResponse);
  } catch (err) {
    logger.error('support-chat: failed to save assistant reply', { platform, userId, error: err.message });
  }

  logger.info('support-chat: replied', { platform, userId, escalated: shouldEscalate });
}

/**
 * Public entry point. Adapters (telegram-business.js, max.js) call this with their
 * own platform tag + sendReply callback.
 */
async function handle(params) {
  const { platform, userId } = params;
  return enqueue(platform, userId, () => _handle(params).catch((err) => {
    logger.error('support-chat: handle failed', { platform, userId, error: err.message, stack: err.stack });
  }));
}

module.exports = { handle };
