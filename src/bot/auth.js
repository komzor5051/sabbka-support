const config = require('../config');

function authMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!config.allowedUserIds.includes(userId)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  return next();
}

module.exports = { authMiddleware };
