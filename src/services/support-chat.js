const config = require('../config');
const logger = require('../utils/logger');
const ai = require('./ai');
const chatHistory = require('./chat-history');
const escalationStore = require('./escalation-store');

const ESCALATE_TAG = '[ESCALATE]';

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
 * Build the messages array for OpenRouter:
 * [system prompt + KB] + [history] + [new user message]
 */
function buildMessages(userText, history) {
  let knowledgeBase;
  try {
    knowledgeBase = config.supportChat.knowledgeBase;
  } catch (err) {
    logger.error('support-chat: failed to read knowledge-base.md', { error: err.message });
    knowledgeBase = '(база знаний недоступна)';
  }

  let systemPromptTemplate;
  try {
    systemPromptTemplate = config.supportChat.systemPrompt;
  } catch (err) {
    logger.error('support-chat: failed to read system-prompt.md', { error: err.message });
    systemPromptTemplate = 'Ты — ассистент поддержки Сабка. {knowledge_base}';
  }

  const systemContent = systemPromptTemplate.replace('{knowledge_base}', knowledgeBase);

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
 * Main handler — called from business.js for each USER message.
 * Silently fails on error to avoid disrupting KB building.
 *
 * @param {object} ctx     - Telegraf context (business_message)
 * @param {object} msg     - Raw business message object
 * @param {object} bot     - Telegraf bot instance (for admin notifications)
 */
async function handle(ctx, msg, bot) {
  const userId = msg.chat.id; // Use chat.id as conversation key (same as dialog-tracker)
  const userText = msg.text;

  logger.info('support-chat: START', { userId, textLen: userText.length });

  try {
    // 1. Fetch conversation history
    logger.info('support-chat: step 1 — getHistory', { userId });
    const history = await chatHistory.getHistory(userId, config.supportChat.historyLimit);
    logger.info('support-chat: step 1 OK', { userId, historyLen: history.length });

    // TWO-REPLY MODE: respond to first 2 messages, then go silent.
    // dialog-tracker still collects everything for KB building.
    const repliesGiven = history.filter(m => m.role === 'assistant').length;
    if (repliesGiven >= 2) {
      logger.info('support-chat: skipping (2 replies already given)', { userId });
      return;
    }

    // 2. Build messages array
    const messages = buildMessages(userText, history);
    logger.info('support-chat: step 2 — messages built', { userId, msgCount: messages.length });

    // 3. Select model — add :online for diagnostic queries
    const model = needsOnline(userText)
      ? config.openrouter.models.gemini + ':online'
      : config.openrouter.models.gemini;

    if (model.endsWith(':online')) {
      logger.info('support-chat: using :online (Exa search)', { userId });
    }

    // 4. Call OpenRouter
    logger.info('support-chat: step 4 — calling AI', { userId, model });
    const response = await ai.chatCompletion(model, messages, { temperature: 0.4, maxTokens: 300 });
    logger.info('support-chat: step 4 OK', { userId, responseLen: response.length });

    // 5. Detect escalation: model tag OR user explicitly asked for human
    const hasModelTag = response.includes(ESCALATE_TAG);
    const hasUserRequest = userAskedForHuman(userText);
    const shouldEscalate = hasModelTag || hasUserRequest;
    const cleanResponse = stripMarkdown(response.replaceAll(ESCALATE_TAG, '').trim());

    // 6. Notify admins if escalated
    if (shouldEscalate) {
      const reason = hasModelTag ? 'model_tag' : 'user_request';
      logger.info('support-chat: escalating', { userId, reason });
      const username = msg.from?.username || msg.chat?.username;
      await notifyAdmins(bot, userId, username, userText);
    }

    // 7. Reply to user via business connection (required for Business API)
    logger.info('support-chat: step 7 — sending reply', { userId });
    const businessConnectionId = ctx.update?.business_message?.business_connection_id;
    await ctx.telegram.sendMessage(msg.chat.id, cleanResponse, {
      ...(businessConnectionId && { business_connection_id: businessConnectionId }),
    });

    // 8. Persist both turns to history
    await chatHistory.saveMessage(userId, 'user', userText);
    await chatHistory.saveMessage(userId, 'assistant', cleanResponse);

    logger.info('support-chat: replied', { userId, escalated: shouldEscalate });
  } catch (err) {
    // Silent fail — human operator can still reply via @sabka_help manually
    logger.error('support-chat: handle failed', { userId, error: err.message, stack: err.stack });
  }
}

module.exports = { handle };
