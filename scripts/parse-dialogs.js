#!/usr/bin/env node
/**
 * Parse sabka-dialogs-export.txt → dialogs_raw.json
 * Then filter out noise → dialogs_clean.json + stats
 *
 * Usage: node scripts/parse-dialogs.js [path-to-txt]
 */

const fs = require('fs');
const path = require('path');

const INPUT = process.argv[2] || path.resolve(__dirname, '../../Downloads/sabka-dialogs-export.txt');
const OUT_RAW = path.resolve(__dirname, '../data/dialogs_raw.json');
const OUT_CLEAN = path.resolve(__dirname, '../data/dialogs_clean.json');
const OUT_DROPPED = path.resolve(__dirname, '../data/dialogs_dropped.json');

// Ensure output dir
fs.mkdirSync(path.dirname(OUT_RAW), { recursive: true });

// ──────────────────────────────────────────────
// STEP 1: Parse txt into structured objects
// ──────────────────────────────────────────────

const raw = fs.readFileSync(INPUT, 'utf-8');

const DIALOG_HEADER = /^={40}\nDialog #([a-f0-9]+) \| (\d{2}\.\d{2}\.\d{4}) \| Category: (.+)\n={40}$/gm;

const dialogs = [];
let match;
const headerPositions = [];

while ((match = DIALOG_HEADER.exec(raw)) !== null) {
  headerPositions.push({
    id: match[1],
    date: match[2],
    category: match[3],
    start: match.index,
    headerEnd: match.index + match[0].length,
  });
}

for (let i = 0; i < headerPositions.length; i++) {
  const h = headerPositions[i];
  const bodyEnd = i + 1 < headerPositions.length ? headerPositions[i + 1].start : raw.length;
  const body = raw.substring(h.headerEnd, bodyEnd).trim();

  // Split body into Problem/Solution and raw messages
  const sepIdx = body.indexOf('----------------------------------------');
  let problem = '';
  let solution = '';
  let messages = [];

  if (sepIdx !== -1) {
    const meta = body.substring(0, sepIdx).trim();
    const rawMessages = body.substring(sepIdx + 40).trim();

    // Extract Problem and Solution
    const probMatch = meta.match(/^Problem:\s*([\s\S]*?)(?=\nSolution:|$)/m);
    const solMatch = meta.match(/^Solution:\s*([\s\S]*?)$/m);
    problem = probMatch ? probMatch[1].trim() : '';
    solution = solMatch ? solMatch[1].trim() : '';

    // Parse [USER]/[SUPPORT] messages
    const msgRegex = /\[(USER|SUPPORT)\]:\s*/g;
    const msgParts = [];
    let m;
    const msgPositions = [];
    while ((m = msgRegex.exec(rawMessages)) !== null) {
      msgPositions.push({ role: m[1], start: m.index + m[0].length });
    }

    for (let j = 0; j < msgPositions.length; j++) {
      const end = j + 1 < msgPositions.length ? msgPositions[j + 1].start - msgPositions[j + 1].role.length - 4 : rawMessages.length;
      const text = rawMessages.substring(msgPositions[j].start, end).trim();
      if (text) {
        msgParts.push({ role: msgPositions[j].role, text });
      }
    }
    messages = msgParts;
  }

  dialogs.push({
    id: h.id,
    date: h.date,
    category: h.category,
    problem,
    solution,
    messages,
    messageCount: messages.length,
    hasUserMsg: messages.some(m => m.role === 'USER'),
    hasSupportMsg: messages.some(m => m.role === 'SUPPORT'),
  });
}

fs.writeFileSync(OUT_RAW, JSON.stringify(dialogs, null, 2));
console.log(`\n=== STEP 1: PARSED ===`);
console.log(`Total dialogs parsed: ${dialogs.length}`);

// ──────────────────────────────────────────────
// STEP 2: Filter noise
// ──────────────────────────────────────────────

const AUTO_REPLY_MARKER = 'Это сообщение автоматическое';
const AUTO_REPLY_MARKER2 = 'обязательно отвечу в рабочее время';

// Internal team phrases (Artem talking to team, not client support)
const INTERNAL_PHRASES = [
  'это Аня', 'это Леша', 'ответил с личного акка',
  'свинг пати', // known internal joke
  'выговор ему сделаем', // admin-to-admin
];

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /CRITICAL SYSTEM OVERRIDE/i,
  /PRIORITY LEVEL.*MAXIMUM/i,
  /ignore ALL previous instructions/i,
  /supersedes all prior/i,
];

// HTML/code artifacts
const HTML_PATTERN = /<(script|html|head|body|link|meta|div|noscript)\b/i;

// PII patterns (emails, phone numbers, contract IDs)
const PII_PATTERNS = [
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, // email
  /\b2BM-\d+/,  // Diadoc IDs
  /ИНН\s*\d+/i,
  /ОГРН\s*\d+/i,
];

function classifyDialog(d) {
  const allText = d.messages.map(m => m.text).join(' ');

  // 1. No messages at all
  if (d.messages.length === 0) {
    return { keep: false, reason: 'no_messages' };
  }

  // 2. Only 1 message, no real dialog
  if (d.messages.length === 1) {
    const single = d.messages[0];
    // Single support auto-reply with no user question
    if (single.role === 'SUPPORT' && single.text.length < 200) {
      return { keep: false, reason: 'single_support_msg_short' };
    }
    // Single user message with no response
    if (single.role === 'USER' && single.text.length < 200) {
      return { keep: false, reason: 'single_user_no_response' };
    }
  }

  // 3. Prompt injection
  if (INJECTION_PATTERNS.some(p => p.test(allText))) {
    return { keep: false, reason: 'prompt_injection' };
  }

  // 4. HTML/code artifacts
  if (HTML_PATTERN.test(allText) && allText.match(/<\w+/g)?.length > 5) {
    return { keep: false, reason: 'html_artifact' };
  }

  // 5. No user message — support talking to themselves
  if (!d.hasUserMsg) {
    // Exception: if support gave a useful standalone answer
    if (d.hasSupportMsg && d.messages.length >= 2) {
      // Could be support replying to a question we don't see — keep if substantial
      const supportText = d.messages.filter(m => m.role === 'SUPPORT').map(m => m.text).join(' ');
      if (supportText.length > 100) {
        return { keep: true, reason: 'support_only_but_substantial', flag: 'review' };
      }
    }
    return { keep: false, reason: 'no_user_message' };
  }

  // 6. No support response (only user messages)
  if (!d.hasSupportMsg) {
    return { keep: false, reason: 'no_support_response' };
  }

  // 7. Internal team conversations
  if (INTERNAL_PHRASES.some(p => allText.toLowerCase().includes(p.toLowerCase()))) {
    return { keep: false, reason: 'internal_team' };
  }

  // 8. Only auto-reply, no real answer
  const supportMsgs = d.messages.filter(m => m.role === 'SUPPORT');
  const allAutoReply = supportMsgs.every(m =>
    m.text.includes(AUTO_REPLY_MARKER) || m.text.includes(AUTO_REPLY_MARKER2)
  );
  if (allAutoReply && supportMsgs.length <= 2) {
    return { keep: false, reason: 'auto_reply_only' };
  }

  // 9. Very short meaningless exchanges ("спасибо", "ок", just a link)
  const userMsgs = d.messages.filter(m => m.role === 'USER');
  const allUserShort = userMsgs.every(m => m.text.length < 30);
  const allSupportShort = supportMsgs.every(m => m.text.length < 50);
  if (allUserShort && allSupportShort && d.messages.length <= 3) {
    return { keep: false, reason: 'too_short_both_sides' };
  }

  // 10. PII flag (keep but sanitize later)
  const hasPII = PII_PATTERNS.some(p => p.test(allText));

  // 11. User only sent a link/file with no real question
  if (userMsgs.length === 1 && /^https?:\/\/\S+$/.test(userMsgs[0].text.trim())) {
    if (supportMsgs.length <= 1 && supportMsgs[0]?.text.length < 100) {
      return { keep: false, reason: 'user_link_only' };
    }
  }

  return { keep: true, reason: 'valid', hasPII };
}

const kept = [];
const dropped = [];
const reasonCounts = {};

for (const d of dialogs) {
  const result = classifyDialog(d);
  d._classification = result;

  reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;

  if (result.keep) {
    kept.push(d);
  } else {
    dropped.push(d);
  }
}

fs.writeFileSync(OUT_CLEAN, JSON.stringify(kept, null, 2));
fs.writeFileSync(OUT_DROPPED, JSON.stringify(dropped, null, 2));

// ──────────────────────────────────────────────
// STATS
// ──────────────────────────────────────────────

console.log(`\n=== STEP 2: FILTERED ===`);
console.log(`Kept: ${kept.length} (${Math.round(kept.length / dialogs.length * 100)}%)`);
console.log(`Dropped: ${dropped.length} (${Math.round(dropped.length / dialogs.length * 100)}%)`);
console.log(`\nDrop reasons:`);
for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
  if (reason !== 'valid') {
    console.log(`  ${reason}: ${count}`);
  }
}

// Category distribution of kept
const catCounts = {};
for (const d of kept) {
  catCounts[d.category] = (catCounts[d.category] || 0) + 1;
}
console.log(`\nKept by category:`);
for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count}`);
}

// PII flagged
const piiCount = kept.filter(d => d._classification.hasPII).length;
if (piiCount > 0) {
  console.log(`\n⚠️  ${piiCount} dialogs flagged with PII (will sanitize on import)`);
}

// Message length stats
const msgLens = kept.map(d => d.messages.length);
console.log(`\nMessage count stats (kept):`);
console.log(`  min: ${Math.min(...msgLens)}, max: ${Math.max(...msgLens)}, avg: ${(msgLens.reduce((a, b) => a + b, 0) / msgLens.length).toFixed(1)}`);

console.log(`\nFiles written:`);
console.log(`  ${OUT_RAW}`);
console.log(`  ${OUT_CLEAN}`);
console.log(`  ${OUT_DROPPED}`);
