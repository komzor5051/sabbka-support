const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const logger = require('../utils/logger');
const metabase = require('./metabase');
const ai = require('./ai');
const db = require('./database');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ─────────────────────────────────────────────────────────────
// Tool schemas — fed to Grok via `tools` param
// ─────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'lookup_user_account',
      description: 'Получить данные аккаунта SABKA по email: тариф, статус подписки, остаток токенов/чанков, дата окончания, активность за 30 дней (запросы, картинки).',
      parameters: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Email пользователя SABKA' } },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'payments_summary',
      description: 'Список платежей пользователя по email. Возвращает последние N платежей с суммой в рублях, статусом (SUCCESS/FAILED/PENDING), тарифом, методом оплаты и датой.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          limit: { type: 'integer', description: 'Сколько платежей вернуть (default 20, max 50)' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'user_diagnostics',
      description: 'Проверить аккаунт пользователя на типичные ошибки в БД: висящие PENDING платежи >1 дня, активные подписки с прошедшим end_date, нулевой tokens_left при активной подписке, failed платежи за 30 дней, дубликаты активных подписок. Используй когда юзер жалуется на глюки биллинга/подписки.',
      parameters: {
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_kb',
      description: 'Семантический поиск в базе знаний бота (прошлые диалоги поддержки). Возвращает похожие кейсы с проблемой и решением.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос на русском' },
          limit: { type: 'integer', description: 'Сколько результатов (default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recent_escalations',
      description: 'Последние эскалации к живому оператору (юзеры, которых бот не смог обслужить). Возвращает текст вопроса, time, user_chat_id.',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'integer', description: 'За сколько часов смотреть (default 24)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'user_dialogs',
      description: 'История диалогов пользователя с ботом поддержки (все сообщения по chat_id). Email конвертится в telegram_chat_id из sabka.users.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          limit: { type: 'integer', description: 'Сколько последних сообщений (default 30)' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'metrics_today',
      description: 'Общие метрики за сегодня: новые регистрации, успешные платежи и выручка в рублях, активные платные подписки, эскалации.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Tool executors
// ─────────────────────────────────────────────────────────────

async function toolLookupUserAccount({ email }) {
  return metabase.lookupUserByEmail(email);
}

async function toolPaymentsSummary({ email, limit = 20 }) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 50);
  const sql = `
    SELECT
      p.created_at,
      (p.amount / 100.0) AS amount_rub,
      p.currency,
      p.status,
      p.new_plan,
      p.previous_plan,
      p.payment_method,
      p.provider,
      p.source
    FROM sabka.payments p
    JOIN sabka.users u ON u.id = p.user_id
    WHERE LOWER(u.email) = LOWER({{email}})
    ORDER BY p.created_at DESC
    LIMIT ${safeLimit}
  `;
  const res = await metabase.runQuery(sql, { email });
  if (res.error) return { error: res.error };
  return { payments: res.rows, count: res.rows.length };
}

async function toolUserDiagnostics({ email }) {
  const sql = `
    WITH u AS (
      SELECT id FROM sabka.users WHERE LOWER(email) = LOWER({{email}}) LIMIT 1
    )
    SELECT
      (SELECT json_agg(json_build_object(
        'id', p.id, 'amount_rub', p.amount/100.0, 'status', p.status,
        'created_at', p.created_at, 'days_ago', EXTRACT(DAY FROM NOW() - p.created_at)::int
      )) FROM sabka.payments p WHERE p.user_id = (SELECT id FROM u)
         AND p.status = 'PENDING' AND p.created_at < NOW() - INTERVAL '1 day'
      ) AS stuck_pending_payments,

      (SELECT json_agg(json_build_object(
        'plan', s.plan, 'status', s.status, 'end_date', s.end_date,
        'tokens_left', s.tokens_left
      )) FROM sabka.subscriptions s WHERE s.user_id = (SELECT id FROM u)
         AND s.status = 'ACTIVE' AND s.end_date IS NOT NULL AND s.end_date < NOW()
      ) AS expired_but_active_subs,

      (SELECT json_agg(json_build_object(
        'plan', s.plan, 'status', s.status, 'end_date', s.end_date,
        'tokens_left', s.tokens_left
      )) FROM sabka.subscriptions s WHERE s.user_id = (SELECT id FROM u)
         AND s.status = 'ACTIVE' AND s.plan != 'free' AND s.tokens_left = 0
      ) AS zero_tokens_active_paid,

      (SELECT COUNT(*) FROM sabka.payments p WHERE p.user_id = (SELECT id FROM u)
         AND p.status = 'FAILED' AND p.created_at >= NOW() - INTERVAL '30 days'
      ) AS failed_payments_30d,

      (SELECT COUNT(*) FROM sabka.subscriptions s WHERE s.user_id = (SELECT id FROM u)
         AND s.status = 'ACTIVE'
      ) AS active_subs_count,

      (SELECT COUNT(*) FROM u) AS user_exists
  `;
  const res = await metabase.runQuery(sql, { email });
  if (res.error) return { error: res.error };
  if (!res.rows || res.rows.length === 0) return { found: false };
  const row = res.rows[0];
  if (row.user_exists === 0) return { found: false };

  const issues = [];
  if (row.stuck_pending_payments?.length > 0) {
    issues.push({ type: 'stuck_pending_payments', detail: row.stuck_pending_payments });
  }
  if (row.expired_but_active_subs?.length > 0) {
    issues.push({ type: 'expired_but_still_active', detail: row.expired_but_active_subs });
  }
  if (row.zero_tokens_active_paid?.length > 0) {
    issues.push({ type: 'zero_tokens_on_paid_plan', detail: row.zero_tokens_active_paid });
  }
  if (row.failed_payments_30d > 0) {
    issues.push({ type: 'failed_payments_30d', count: row.failed_payments_30d });
  }
  if (row.active_subs_count > 1) {
    issues.push({ type: 'duplicate_active_subscriptions', count: row.active_subs_count });
  }

  return { found: true, issues, summary: issues.length === 0 ? 'Ошибок не найдено' : `Найдено ${issues.length} типов проблем` };
}

async function toolSearchKb({ query, limit = 5 }) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 5), 20);
  try {
    const embedding = await ai.generateEmbedding(query);
    const rows = await db.searchSimilar(embedding, safeLimit, null, 0.40);
    return {
      count: rows.length,
      cases: rows.map(r => ({
        similarity: Math.round(r.similarity * 100),
        category: r.category,
        problem: r.summary_problem,
        solution: r.summary_solution,
      })),
    };
  } catch (err) {
    logger.error('admin-tools: search_kb failed', { error: err.message });
    return { error: 'kb_search_failed', message: err.message };
  }
}

async function toolRecentEscalations({ hours = 24 }) {
  const safeHours = Math.min(Math.max(1, Number(hours) || 24), 24 * 7);
  const since = new Date(Date.now() - safeHours * 3600 * 1000);
  const { data, error } = await supabase
    .from('escalations')
    .select('notification_msg_id, user_chat_id, user_text, created_at')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return { error: 'supabase_error', message: error.message };
  return { count: data.length, escalations: data };
}

async function toolUserDialogs({ email, limit = 30 }) {
  const safeLimit = Math.min(Math.max(5, Number(limit) || 30), 100);

  // 1. email → telegram_chat_id via Metabase
  const idRes = await metabase.runQuery(
    `SELECT telegram_chat_id FROM sabka.users WHERE LOWER(email) = LOWER({{email}}) LIMIT 1`,
    { email }
  );
  if (idRes.error) return { error: idRes.error };
  if (!idRes.rows || idRes.rows.length === 0) return { found: false };
  const rawTgId = idRes.rows[0].telegram_chat_id;
  if (!rawTgId) return { found: true, telegram_linked: false, messages: [] };

  // 2. telegram_chat_id → chat_history
  const tgId = Number(rawTgId);
  if (Number.isNaN(tgId)) return { error: 'invalid_telegram_id', raw: rawTgId };

  const { data, error } = await supabase
    .from('chat_history')
    .select('role, content, created_at')
    .eq('user_id', tgId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) return { error: 'supabase_error', message: error.message };

  return {
    found: true,
    telegram_linked: true,
    telegram_chat_id: tgId,
    count: data.length,
    messages: data.reverse(), // chronological
  };
}

async function toolMetricsToday() {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM sabka.users WHERE created_at >= CURRENT_DATE) AS new_users_today,
      (SELECT COUNT(*) FROM sabka.payments WHERE created_at >= CURRENT_DATE AND status = 'SUCCESS') AS payments_today,
      (SELECT COALESCE(SUM(amount), 0) / 100.0 FROM sabka.payments WHERE created_at >= CURRENT_DATE AND status = 'SUCCESS') AS revenue_today_rub,
      (SELECT COUNT(*) FROM sabka.subscriptions WHERE status = 'ACTIVE' AND plan != 'free') AS active_paid_subs,
      (SELECT COUNT(*) FROM sabka.token_usages WHERE created_at >= CURRENT_DATE) AS ai_requests_today
  `;
  const mbRes = await metabase.runQuery(sql);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data: escData, error: escErr } = await supabase
    .from('escalations')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', today.toISOString());

  return {
    ...(mbRes.rows?.[0] || { error: mbRes.error || 'metabase_unavailable' }),
    escalations_today: escErr ? null : (escData?.length ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────
// Dispatcher — called from admin-chat.js
// ─────────────────────────────────────────────────────────────

const EXECUTORS = {
  lookup_user_account: toolLookupUserAccount,
  payments_summary: toolPaymentsSummary,
  user_diagnostics: toolUserDiagnostics,
  search_kb: toolSearchKb,
  recent_escalations: toolRecentEscalations,
  user_dialogs: toolUserDialogs,
  metrics_today: toolMetricsToday,
};

async function executeTool(name, args) {
  const exec = EXECUTORS[name];
  if (!exec) return { error: 'unknown_tool', name };
  try {
    return await exec(args || {});
  } catch (err) {
    logger.error('admin-tools: executor threw', { name, error: err.message });
    return { error: 'executor_exception', message: err.message };
  }
}

module.exports = { TOOL_SCHEMAS, executeTool };
