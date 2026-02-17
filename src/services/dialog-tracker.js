const config = require('../config');
const logger = require('../utils/logger');

class DialogTracker {
  constructor({ onDialogComplete }) {
    // Map<number, { messages: Array, timer: NodeJS.Timeout, firstMessageId: number }>
    this.dialogs = new Map();
    this.onDialogComplete = onDialogComplete;
  }

  addMessage(userId, { text, sender, messageId, date }) {
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

    dialog.messages.push({
      sender,
      text,
      date: date || new Date(),
    });

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

    return this.onDialogComplete({
      userId,
      firstMessageId: dialog.firstMessageId,
      fullDialog,
      messageCount: dialog.messages.length,
    });
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
