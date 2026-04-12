const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

let dbAvailable = null;

async function checkDbAvailable() {
  if (dbAvailable !== null) return dbAvailable;
  try {
    const { error } = await supabase
      .from('dialog_buffer')
      .select('id')
      .limit(1);
    dbAvailable = !error;
    if (!dbAvailable) {
      logger.warn('dialog-tracker: dialog_buffer table not found, using in-memory only');
    } else {
      logger.info('dialog-tracker: Supabase persistence enabled');
    }
  } catch {
    dbAvailable = false;
  }
  return dbAvailable;
}

class DialogTracker {
  constructor({ onDialogComplete }) {
    // Map<number, { messages: Array, timer: NodeJS.Timeout, firstMessageId: number }>
    this.dialogs = new Map();
    this.onDialogComplete = onDialogComplete;
  }

  async addMessage(userId, { text, sender, messageId, date }) {
    let dialog = this.dialogs.get(userId);

    if (!dialog) {
      dialog = {
        messages: [],
        timer: null,
        firstMessageId: messageId,
        userId,
      };
      this.dialogs.set(userId, dialog);
    }

    const msgDate = date || new Date();
    dialog.messages.push({ sender, text, date: msgDate });

    // Persist to DB (non-blocking, non-fatal)
    if (await checkDbAvailable()) {
      supabase
        .from('dialog_buffer')
        .insert({
          user_id: userId,
          sender,
          text,
          message_id: messageId || null,
          message_date: msgDate.toISOString(),
        })
        .then(({ error }) => {
          if (error) logger.error('dialog-tracker: DB insert failed', { userId, error: error.message });
        });
    }

    // Reset the 5-min timer
    if (dialog.timer) {
      clearTimeout(dialog.timer);
    }

    dialog.timer = setTimeout(() => {
      this._completeDialog(userId);
    }, config.dialogTimeoutMs);

    logger.info('Message buffered', {
      userId,
      sender,
      msgCount: dialog.messages.length,
    });
  }

  async _completeDialog(userId) {
    const dialog = this.dialogs.get(userId);
    if (!dialog || dialog.messages.length === 0) {
      this.dialogs.delete(userId);
      return;
    }

    const fullDialog = dialog.messages
      .map(m => `[${m.sender}]: ${m.text}`)
      .join('\n');

    logger.info('Dialog complete', {
      userId,
      messageCount: dialog.messages.length,
      firstMessageId: dialog.firstMessageId,
    });

    clearTimeout(dialog.timer);
    this.dialogs.delete(userId);

    // Clean up DB buffer for this user
    if (await checkDbAvailable()) {
      supabase
        .from('dialog_buffer')
        .delete()
        .eq('user_id', userId)
        .then(({ error }) => {
          if (error) logger.error('dialog-tracker: DB cleanup failed', { userId, error: error.message });
        });
    }

    return this.onDialogComplete({
      userId,
      firstMessageId: dialog.firstMessageId,
      fullDialog,
      messageCount: dialog.messages.length,
    });
  }

  /**
   * Recover orphaned dialogs from DB after restart.
   * Finds buffered messages older than dialogTimeoutMs and processes them.
   */
  async recoverOrphaned() {
    if (!(await checkDbAvailable())) return;

    try {
      const cutoff = new Date(Date.now() - config.dialogTimeoutMs).toISOString();
      const { data, error } = await supabase
        .from('dialog_buffer')
        .select('user_id, sender, text, message_id, message_date')
        .lt('created_at', cutoff)
        .order('created_at');

      if (error || !data || data.length === 0) return;

      // Group by user_id
      const byUser = new Map();
      for (const row of data) {
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
        byUser.get(row.user_id).push(row);
      }

      logger.info('dialog-tracker: recovering orphaned dialogs', { users: byUser.size, messages: data.length });

      for (const [userId, messages] of byUser) {
        const fullDialog = messages
          .map(m => `[${m.sender}]: ${m.text}`)
          .join('\n');

        await this.onDialogComplete({
          userId,
          firstMessageId: messages[0].message_id,
          fullDialog,
          messageCount: messages.length,
        }).catch(err => {
          logger.error('dialog-tracker: recovery failed for user', { userId, error: err.message });
        });

        // Clean up recovered messages
        await supabase
          .from('dialog_buffer')
          .delete()
          .eq('user_id', userId);
      }

      logger.info('dialog-tracker: recovery complete');
    } catch (err) {
      logger.error('dialog-tracker: recovery error', { error: err.message });
    }
  }

  async flushAll() {
    const userIds = [...this.dialogs.keys()];
    await Promise.allSettled(userIds.map(userId => this._completeDialog(userId)));
    logger.info(`Flushed ${userIds.length} pending dialogs`);
  }

  get pendingCount() {
    return this.dialogs.size;
  }
}

module.exports = DialogTracker;
