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

// Composite key for the in-memory dialogs map — avoids tg/max userId collisions
function dialogKey(platform, userId) {
  return `${platform}:${userId}`;
}

class DialogTracker {
  constructor({ onDialogComplete }) {
    this.dialogs = new Map(); // key = "platform:userId" → { messages, timer, firstMessageId, userId, platform }
    this.onDialogComplete = onDialogComplete;
  }

  async addMessage(platform, userId, { text, sender, messageId, date }) {
    const key = dialogKey(platform, userId);
    let dialog = this.dialogs.get(key);

    if (!dialog) {
      dialog = {
        messages: [],
        timer: null,
        firstMessageId: messageId,
        userId,
        platform,
      };
      this.dialogs.set(key, dialog);
    }

    const msgDate = date || new Date();
    dialog.messages.push({ sender, text, date: msgDate });

    if (await checkDbAvailable()) {
      supabase
        .from('dialog_buffer')
        .insert({
          platform,
          user_id: userId,
          sender,
          text,
          message_id: messageId || null,
          message_date: msgDate.toISOString(),
        })
        .then(({ error }) => {
          if (error) logger.error('dialog-tracker: DB insert failed', { platform, userId, error: error.message });
        })
        .catch((err) => {
          logger.error('dialog-tracker: DB insert threw', { platform, userId, error: err.message });
        });
    }

    if (dialog.timer) clearTimeout(dialog.timer);
    dialog.timer = setTimeout(() => {
      this._completeDialog(platform, userId);
    }, config.dialogTimeoutMs);

    logger.info('Message buffered', { platform, userId, sender, msgCount: dialog.messages.length });
  }

  async _completeDialog(platform, userId) {
    const key = dialogKey(platform, userId);
    const dialog = this.dialogs.get(key);
    if (!dialog || dialog.messages.length === 0) {
      this.dialogs.delete(key);
      return;
    }

    const fullDialog = dialog.messages
      .map(m => `[${m.sender}]: ${m.text}`)
      .join('\n');

    logger.info('Dialog complete', {
      platform,
      userId,
      messageCount: dialog.messages.length,
      firstMessageId: dialog.firstMessageId,
    });

    clearTimeout(dialog.timer);
    this.dialogs.delete(key);

    if (await checkDbAvailable()) {
      supabase
        .from('dialog_buffer')
        .delete()
        .eq('platform', platform)
        .eq('user_id', userId)
        .then(({ error }) => {
          if (error) logger.error('dialog-tracker: DB cleanup failed', { platform, userId, error: error.message });
        })
        .catch((err) => {
          logger.error('dialog-tracker: DB cleanup threw', { platform, userId, error: err.message });
        });
    }

    return this.onDialogComplete({
      platform,
      userId,
      firstMessageId: dialog.firstMessageId,
      fullDialog,
      messageCount: dialog.messages.length,
    });
  }

  /**
   * Recover orphaned dialogs from DB after restart.
   */
  async recoverOrphaned() {
    if (!(await checkDbAvailable())) return;

    try {
      const cutoff = new Date(Date.now() - config.dialogTimeoutMs).toISOString();
      const { data, error } = await supabase
        .from('dialog_buffer')
        .select('platform, user_id, sender, text, message_id, message_date')
        .lt('created_at', cutoff)
        .order('created_at');

      if (error || !data || data.length === 0) return;

      // Group by (platform, user_id)
      const byKey = new Map();
      for (const row of data) {
        const platform = row.platform || 'tg';
        const key = dialogKey(platform, row.user_id);
        if (!byKey.has(key)) byKey.set(key, { platform, userId: row.user_id, messages: [] });
        byKey.get(key).messages.push(row);
      }

      logger.info('dialog-tracker: recovering orphaned dialogs', { keys: byKey.size, messages: data.length });

      for (const [, group] of byKey) {
        const fullDialog = group.messages
          .map(m => `[${m.sender}]: ${m.text}`)
          .join('\n');

        await this.onDialogComplete({
          platform: group.platform,
          userId: group.userId,
          firstMessageId: group.messages[0].message_id,
          fullDialog,
          messageCount: group.messages.length,
        }).catch(err => {
          logger.error('dialog-tracker: recovery failed for user', { platform: group.platform, userId: group.userId, error: err.message });
        });

        await supabase
          .from('dialog_buffer')
          .delete()
          .eq('platform', group.platform)
          .eq('user_id', group.userId);
      }

      logger.info('dialog-tracker: recovery complete');
    } catch (err) {
      logger.error('dialog-tracker: recovery error', { error: err.message });
    }
  }

  async flushAll() {
    const entries = [...this.dialogs.values()];
    await Promise.allSettled(entries.map(d => this._completeDialog(d.platform, d.userId)));
    logger.info(`Flushed ${entries.length} pending dialogs`);
  }

  get pendingCount() {
    return this.dialogs.size;
  }
}

module.exports = DialogTracker;
