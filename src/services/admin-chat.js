const config = require('../config');
const logger = require('../utils/logger');
const ai = require('./ai');
const adminHistory = require('./admin-history');
const adminTools = require('./admin-tools');

/**
 * Strip markdown from model output — Telegram plain text.
 * Shorter version than support-chat (no need for complex escape).
 */
function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^---+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Core handler for admin AI-assistant chat.
 * Multi-step tool loop with safety cap.
 *
 * @param {number} adminId — telegram user id
 * @param {string} userText — current message text
 * @param {(text: string) => Promise<void>} sendReply
 */
async function handle(adminId, userText, sendReply) {
  const start = Date.now();
  logger.info('admin-chat: START', { adminId, textLen: userText.length });

  // 1. Save user message first
  try {
    await adminHistory.saveMessage(adminId, 'user', userText);
  } catch (err) {
    logger.error('admin-chat: failed to save user message', { adminId, error: err.message });
    await sendReply('⚠️ Не получилось сохранить сообщение. Попробуй ещё раз.').catch(() => {});
    return;
  }

  // 2. Load history (includes just-saved user message) + build messages
  let systemPrompt;
  try {
    systemPrompt = config.adminChat.systemPrompt;
  } catch (err) {
    logger.error('admin-chat: failed to read prompt', { error: err.message });
    systemPrompt = 'Ты — AI-ассистент оператора поддержки SABKA.';
  }

  const history = await adminHistory.getHistory(adminId, config.adminChat.historyLimit);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(({ role, content }) => ({ role, content })),
  ];

  // 3. Multi-step tool loop
  const model = config.openrouter.models.chat;
  const MAX_STEPS = config.adminChat.maxToolSteps;
  const CHAR_CAP = config.adminChat.toolResultCharCap;
  let finalText = null;
  let toolCallsExecuted = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    logger.info('admin-chat: step', { adminId, step, toolCallsExecuted });

    const resp = await ai.chatCompletion(model, messages, {
      temperature: 0.3,
      maxTokens: 1500,
      tools: adminTools.TOOL_SCHEMAS,
    });

    // No tool calls → model produced textual answer → done
    if (!resp.tool_calls || resp.tool_calls.length === 0) {
      finalText = resp.content || '';
      logger.info('admin-chat: got text answer', { adminId, step, contentLen: finalText.length });
      break;
    }

    // Execute tool(s)
    messages.push({
      role: 'assistant',
      content: resp.content || '',
      tool_calls: resp.tool_calls,
    });

    for (const tc of resp.tool_calls) {
      toolCallsExecuted++;
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch (err) {
        logger.warn('admin-chat: failed to parse tool args', { adminId, error: err.message });
      }
      logger.info('admin-chat: tool call', { adminId, name: tc.function?.name, argsKeys: Object.keys(args) });

      const result = await adminTools.executeTool(tc.function?.name, args);
      let resultJson = JSON.stringify(result);
      if (resultJson.length > CHAR_CAP) {
        resultJson = resultJson.substring(0, CHAR_CAP) + '...[truncated]';
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultJson,
      });
    }
  }

  // Loop exhausted without text → final call without tools to force answer
  if (finalText === null) {
    logger.warn('admin-chat: max steps reached, forcing text answer', { adminId, toolCallsExecuted });
    const finalResp = await ai.chatCompletion(model, messages, {
      temperature: 0.3,
      maxTokens: 1500,
    });
    finalText = finalResp.content || '⚠️ Не смог сформулировать ответ после нескольких tool-шагов.';
  }

  const clean = stripMarkdown(finalText);

  // 4. Send reply + save assistant message
  try {
    await sendReply(clean);
  } catch (err) {
    logger.error('admin-chat: sendReply failed', { adminId, error: err.message });
    return;
  }

  try {
    await adminHistory.saveMessage(adminId, 'assistant', clean);
  } catch (err) {
    logger.error('admin-chat: failed to save assistant', { adminId, error: err.message });
  }

  const elapsed = Date.now() - start;
  logger.info('admin-chat: DONE', { adminId, elapsed_ms: elapsed, toolCallsExecuted });
}

module.exports = { handle };
