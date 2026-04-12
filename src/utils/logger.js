const winston = require('winston');
const path = require('path');
const fs = require('fs');

// File transport: optional, safe on read-only FS (Railway ephemeral disk)
const transports = [new winston.transports.Console()];

try {
  const logsDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  transports.push(new winston.transports.File({
    filename: path.join(logsDir, 'bot.log'),
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 3,
  }));
} catch (e) {
  // Read-only filesystem (Railway) — console-only logging
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
    })
  ),
  transports,
});

module.exports = logger;
