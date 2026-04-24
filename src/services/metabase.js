const config = require('../config');
const logger = require('../utils/logger');

const LOOKUP_SQL = `
SELECT
  u.email,
  u.username,
  u.telegram_username,
  u.created_at AS registered_at,
  s.plan,
  s.status AS subscription_status,
  s.end_date,
  s.tokens_left,
  s.responses_left,
  s.auto_renewal,
  COALESCE(t.requests_30d, 0) AS requests_30d,
  COALESCE(t.images_30d, 0) AS images_30d,
  COALESCE(t.images_generated_30d, 0) AS images_generated_30d
FROM sabka.users u
LEFT JOIN sabka.subscriptions s
  ON s.user_id = u.id AND s.status = 'ACTIVE'
LEFT JOIN (
  SELECT
    user_id,
    COUNT(*) AS requests_30d,
    COALESCE(SUM(images), 0) AS images_30d,
    COALESCE(SUM(images_generated), 0) AS images_generated_30d
  FROM sabka.token_usages
  WHERE created_at >= NOW() - INTERVAL '30 days'
  GROUP BY user_id
) t ON t.user_id = u.id
WHERE LOWER(u.email) = LOWER({{email}})
LIMIT 1
`.trim();

function rowsToObject(data) {
  if (!data || !data.rows || data.rows.length === 0) return null;
  const cols = data.cols.map(c => c.name);
  const row = data.rows[0];
  const obj = {};
  cols.forEach((name, i) => { obj[name] = row[i]; });
  return obj;
}

async function lookupUserByEmail(email) {
  if (!config.metabase.apiKey) {
    logger.warn('metabase: apiKey not set, tool disabled');
    return { error: 'not_configured' };
  }

  if (!email || typeof email !== 'string') {
    return { error: 'bad_email' };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.metabase.timeoutMs);

  try {
    const res = await fetch(`${config.metabase.apiUrl}/dataset`, {
      method: 'POST',
      headers: {
        'x-api-key': config.metabase.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        database: config.metabase.databaseId,
        type: 'native',
        native: {
          query: LOOKUP_SQL,
          'template-tags': {
            email: {
              id: 'email',
              name: 'email',
              'display-name': 'Email',
              type: 'text',
            },
          },
        },
        parameters: [{
          type: 'category',
          target: ['variable', ['template-tag', 'email']],
          value: email,
        }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('metabase: non-200', { status: res.status, body: text.substring(0, 200) });
      return { error: 'http_error', status: res.status };
    }

    const json = await res.json();
    const user = rowsToObject(json.data);
    const elapsed = Date.now() - start;

    logger.info('metabase: lookup done', {
      elapsed_ms: elapsed,
      found: !!user,
      hasSubscription: user ? !!user.plan : false,
    });

    if (!user) return { found: false };
    return { found: true, user };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err.name === 'AbortError') {
      logger.error('metabase: timeout', { elapsed_ms: elapsed });
      return { error: 'timeout' };
    }
    logger.error('metabase: lookup failed', { elapsed_ms: elapsed, error: err.message });
    return { error: 'network', message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookupUserByEmail };
