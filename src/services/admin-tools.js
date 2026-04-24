const logger = require('../utils/logger');
const metabase = require('./metabase');

// ─────────────────────────────────────────────────────────────
// Tool schemas — fed to Grok via `tools` param.
// Minimal set: admin works with a single user by email.
// KB retrieval is handled automatically via kb-retriever (not a tool).
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

  return {
    found: true,
    issues,
    summary: issues.length === 0 ? 'Типовых ошибок в БД не найдено' : `Найдено ${issues.length} типов проблем`,
    note: 'Это проверки только по нашей БД. Возможны скрытые ошибки на стороне Tinkoff / Cloudpayments / RBS — их здесь не видно.',
  };
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────

const EXECUTORS = {
  lookup_user_account: toolLookupUserAccount,
  payments_summary: toolPaymentsSummary,
  user_diagnostics: toolUserDiagnostics,
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
