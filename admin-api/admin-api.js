// admin-api.js
// Cloudflare Worker — backend API for the SMS dashboard.
// Deploy this as a SEPARATE worker (e.g. "sms-chatbot-admin-api").
// It shares the same D1 database binding as your main sms-chatbot worker.
// Set ADMIN_SECRET env var (encrypted) — the frontend sends it as Bearer token.
// NOTE: /api/conversations/:id/messages is intentionally NOT implemented.
// Message content is AES-256-GCM encrypted per-phone in D1 and cannot be decrypted here.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function unauthorized() { return json({ error: 'Unauthorized' }, 401); }

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth.replace('Bearer ', '') === env.ADMIN_SECRET;
}

// Simple in-memory cache for the OpenRouter model catalog (per-isolate, ~10 min TTL).
// The /models endpoint is public (no API key needed) and rarely changes within a session.
let modelsCache = { data: null, fetchedAt: 0 };
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchOpenRouterModels() {
  const now = Date.now();
  if (modelsCache.data && (now - modelsCache.fetchedAt) < MODELS_CACHE_TTL_MS) {
    return modelsCache.data;
  }
  const resp = await fetch('https://openrouter.ai/api/v1/models');
  if (!resp.ok) {
    throw new Error(`OpenRouter models fetch failed: ${resp.status}`);
  }
  const data = await resp.json();
  const slim = (data.data || []).map(m => ({
    id: m.id,
    name: m.name,
    context_length: m.context_length || null,
    is_free: m.id.endsWith(':free'),
    prompt_price: m.pricing?.prompt || null,
    completion_price: m.pricing?.completion || null,
  })).sort((a, b) => a.id.localeCompare(b.id));

  modelsCache = { data: slim, fetchedAt: now };
  return slim;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const path = url.pathname;

    // --- LOGIN ---
    if (path === '/api/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.password === env.ADMIN_SECRET) return json({ token: env.ADMIN_SECRET });
      return json({ error: 'Invalid password' }, 401);
    }

    if (!checkAuth(request, env)) return unauthorized();

    const db = env.DB;

    // =====================
    //  CONTACTS
    // =====================

    if (path === '/api/contacts' && request.method === 'GET') {
      const { results } = await db.prepare(`
        SELECT
          c.phone_number,
          COUNT(DISTINCT c.id) AS conversation_count,
          COUNT(m.id) AS total_messages,
          SUM(CASE WHEN m.created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS messages_today,
          SUM(CASE WHEN m.created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS messages_month,
          MAX(m.created_at) AS last_seen,
          CASE WHEN bl.phone_number IS NOT NULL THEN 1 ELSE 0 END AS is_blacklisted,
          CASE WHEN wl.phone_number IS NOT NULL THEN 1 ELSE 0 END AS is_whitelisted
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        LEFT JOIN blacklist bl ON bl.phone_number = c.phone_number
        LEFT JOIN whitelist wl ON wl.phone_number = c.phone_number
        GROUP BY c.phone_number
        ORDER BY last_seen DESC
      `).all();
      return json(results);
    }

    // GET /api/contacts/:phone/conversations — counts only, no message content
    const contactConvMatch = path.match(/^\/api\/contacts\/(.+)\/conversations$/);
    if (contactConvMatch && request.method === 'GET') {
      const phone = decodeURIComponent(contactConvMatch[1]);
      const { results } = await db.prepare(`
        SELECT c.id, c.name, c.is_active, c.created_at, c.updated_at,
          COUNT(m.id) AS message_count
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.phone_number = ?
        GROUP BY c.id
        ORDER BY c.updated_at DESC
      `).bind(phone).all();
      return json(results);
    }

    // GET /api/contacts/:phone/support — support tickets for this contact (used in panel)
    const contactSupportMatch = path.match(/^\/api\/contacts\/(.+)\/support$/);
    if (contactSupportMatch && request.method === 'GET') {
      const phone = decodeURIComponent(contactSupportMatch[1]);
      const { results } = await db.prepare(`
        SELECT id, message, status, created_at, closed_at
        FROM support_tickets
        WHERE phone_number = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).bind(phone).all();
      return json(results);
    }

    // NOTE: /api/conversations/:id/messages intentionally omitted.
    // Message content is encrypted with a per-phone key and cannot be read server-side.

    // =====================
    //  SEND SMS
    // =====================

    if (path === '/api/send' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { to, message } = body;
      if (!to || !message) return json({ error: 'Missing to or message' }, 400);

      const resp = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.TELNYX_PHONE_NUMBER, to, text: message }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return json({ error: 'Telnyx error', detail: err }, 502);
      }
      const data = await resp.json();
      return json({ success: true, message_id: data.data?.id });
    }

    // =====================
    //  BLACKLIST
    // =====================

    if (path === '/api/blacklist' && request.method === 'GET') {
      const { results } = await db.prepare(`SELECT phone_number, reason, created_at FROM blacklist ORDER BY created_at DESC`).all();
      return json(results);
    }

    if (path === '/api/blacklist' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.phone_number) return json({ error: 'Missing phone_number' }, 400);
      await db.prepare(`INSERT OR IGNORE INTO blacklist (phone_number, reason) VALUES (?, ?)`).bind(body.phone_number, body.reason || '').run();
      return json({ success: true });
    }

    const blMatch = path.match(/^\/api\/blacklist\/(.+)$/);
    if (blMatch && request.method === 'DELETE') {
      await db.prepare(`DELETE FROM blacklist WHERE phone_number = ?`).bind(decodeURIComponent(blMatch[1])).run();
      return json({ success: true });
    }

    // =====================
    //  WHITELIST
    // =====================

    if (path === '/api/whitelist' && request.method === 'GET') {
      const { results } = await db.prepare(`SELECT phone_number, label, created_at FROM whitelist ORDER BY created_at DESC`).all();
      return json(results);
    }

    if (path === '/api/whitelist' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.phone_number) return json({ error: 'Missing phone_number' }, 400);
      await db.prepare(`INSERT OR IGNORE INTO whitelist (phone_number, label) VALUES (?, ?)`).bind(body.phone_number, body.label || '').run();
      return json({ success: true });
    }

    const wlMatch = path.match(/^\/api\/whitelist\/(.+)$/);
    if (wlMatch && request.method === 'DELETE') {
      await db.prepare(`DELETE FROM whitelist WHERE phone_number = ?`).bind(decodeURIComponent(wlMatch[1])).run();
      return json({ success: true });
    }

    // =====================
    //  SUPPORT TICKETS
    // =====================

    // GET /api/support — list all tickets (open first, then closed)
    if (path === '/api/support' && request.method === 'GET') {
      const { results } = await db.prepare(`
        SELECT id, phone_number, message, status, created_at, closed_at
        FROM support_tickets
        ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC
      `).all();
      return json(results);
    }

    // POST /api/support/:id/close — close a ticket
    const supportCloseMatch = path.match(/^\/api\/support\/(\d+)\/close$/);
    if (supportCloseMatch && request.method === 'POST') {
      const id = supportCloseMatch[1];
      const result = await db.prepare(`
        UPDATE support_tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'open'
      `).bind(id).run();
      if (result.meta.changes === 0) return json({ error: 'Ticket not found or already closed' }, 404);
      return json({ success: true });
    }

    // GET /api/support/open-count — for sidebar badge
    if (path === '/api/support/open-count' && request.method === 'GET') {
      const result = await db.prepare(`SELECT COUNT(*) as count FROM support_tickets WHERE status = 'open'`).first();
      return json({ count: result.count });
    }

    // =====================
    //  OPENROUTER MODEL CATALOG
    // =====================

    // GET /api/openrouter-models — full list of available OpenRouter models (for dashboard pickers)
    if (path === '/api/openrouter-models' && request.method === 'GET') {
      try {
        const models = await fetchOpenRouterModels();
        return json(models);
      } catch (err) {
        return json({ error: 'Failed to fetch model list', detail: err.message }, 502);
      }
    }

    // =====================
    //  GLOBAL SETTINGS (default model / fallback / token limit)
    // =====================

    // GET /api/settings — current global AI model + fallback + limit
    if (path === '/api/settings' && request.method === 'GET') {
      const rows = await db.prepare(
        `SELECT key, value FROM settings WHERE key IN ('ai_model', 'default_fallback_model', 'default_token_limit')`
      ).all();
      const map = {};
      for (const r of rows.results) map[r.key] = r.value;
      return json({
        ai_model: map.ai_model || 'openrouter/free',
        default_fallback_model: map.default_fallback_model || 'block',
        default_token_limit: map.default_token_limit ?? '',
      });
    }

    // POST /api/settings — update one or more global settings
    // Body: { ai_model?, default_fallback_model?, default_token_limit? }
    if (path === '/api/settings' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const allowedKeys = ['ai_model', 'default_fallback_model', 'default_token_limit'];
      const updates = Object.entries(body).filter(([k]) => allowedKeys.includes(k));
      if (!updates.length) return json({ error: 'No valid settings provided' }, 400);

      for (const [key, value] of updates) {
        await db.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
        ).bind(key, String(value)).run();
      }
      return json({ success: true });
    }

    // =====================
    //  PER-NUMBER MODEL / FALLBACK / LIMIT / USAGE
    // =====================

    // GET /api/numbers — all numbers with overrides + usage (joined with contact info)
    if (path === '/api/numbers' && request.method === 'GET') {
      const { results } = await db.prepare(`
        SELECT
          c.phone_number,
          ns.model,
          ns.fallback_model,
          ns.token_limit,
          COALESCE(ns.tokens_input_used, 0) AS tokens_input_used,
          COALESCE(ns.tokens_output_used, 0) AS tokens_output_used,
          ns.updated_at
        FROM (SELECT DISTINCT phone_number FROM conversations) c
        LEFT JOIN number_settings ns ON ns.phone_number = c.phone_number
        ORDER BY (COALESCE(ns.tokens_input_used,0) + COALESCE(ns.tokens_output_used,0)) DESC
      `).all();
      return json(results);
    }

    // POST /api/numbers/:phone/model — set per-number model override (null/empty = use global)
    const numModelMatch = path.match(/^\/api\/numbers\/(.+)\/model$/);
    if (numModelMatch && request.method === 'POST') {
      const phone = decodeURIComponent(numModelMatch[1]);
      const body = await request.json().catch(() => ({}));
      const model = body.model || null;
      await db.prepare(
        `INSERT INTO number_settings (phone_number, model, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(phone_number) DO UPDATE SET model = excluded.model, updated_at = CURRENT_TIMESTAMP`
      ).bind(phone, model).run();
      return json({ success: true });
    }

    // POST /api/numbers/:phone/fallback — set per-number fallback model ('block' or a model slug, null = use global)
    const numFallbackMatch = path.match(/^\/api\/numbers\/(.+)\/fallback$/);
    if (numFallbackMatch && request.method === 'POST') {
      const phone = decodeURIComponent(numFallbackMatch[1]);
      const body = await request.json().catch(() => ({}));
      const fallbackModel = body.fallback_model || null;
      await db.prepare(
        `INSERT INTO number_settings (phone_number, fallback_model, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(phone_number) DO UPDATE SET fallback_model = excluded.fallback_model, updated_at = CURRENT_TIMESTAMP`
      ).bind(phone, fallbackModel).run();
      return json({ success: true });
    }

    // POST /api/numbers/:phone/limit — set per-number token limit (0 = unlimited, null = use global)
    const numLimitMatch = path.match(/^\/api\/numbers\/(.+)\/limit$/);
    if (numLimitMatch && request.method === 'POST') {
      const phone = decodeURIComponent(numLimitMatch[1]);
      const body = await request.json().catch(() => ({}));
      const tokenLimit = body.token_limit === null || body.token_limit === '' ? null : parseInt(body.token_limit, 10);
      await db.prepare(
        `INSERT INTO number_settings (phone_number, token_limit, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(phone_number) DO UPDATE SET token_limit = excluded.token_limit, updated_at = CURRENT_TIMESTAMP`
      ).bind(phone, tokenLimit).run();
      return json({ success: true });
    }

    // POST /api/numbers/:phone/reset-usage — reset token usage counters to 0
    const numResetMatch = path.match(/^\/api\/numbers\/(.+)\/reset-usage$/);
    if (numResetMatch && request.method === 'POST') {
      const phone = decodeURIComponent(numResetMatch[1]);
      await db.prepare(
        `INSERT INTO number_settings (phone_number, tokens_input_used, tokens_output_used, updated_at)
         VALUES (?, 0, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(phone_number) DO UPDATE SET
           tokens_input_used = 0, tokens_output_used = 0, updated_at = CURRENT_TIMESTAMP`
      ).bind(phone).run();
      return json({ success: true });
    }

    // =====================
    //  STATS
    // =====================

    if (path === '/api/stats' && request.method === 'GET') {
      const [totals, todayMsgs, activeConvs, blacklistCount, whitelistCount, openTickets] = await Promise.all([
        db.prepare(`SELECT COUNT(*) as total_messages, COUNT(DISTINCT conversation_id) as total_conversations FROM messages`).first(),
        db.prepare(`SELECT COUNT(*) as count FROM messages WHERE created_at >= datetime('now', '-1 day')`).first(),
        db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE is_active = 1`).first(),
        db.prepare(`SELECT COUNT(*) as count FROM blacklist`).first(),
        db.prepare(`SELECT COUNT(*) as count FROM whitelist`).first(),
        db.prepare(`SELECT COUNT(*) as count FROM support_tickets WHERE status = 'open'`).first(),
      ]);
      return json({
        total_messages: totals.total_messages,
        total_conversations: totals.total_conversations,
        messages_today: todayMsgs.count,
        active_conversations: activeConvs.count,
        blacklisted: blacklistCount.count,
        whitelisted: whitelistCount.count,
        open_support_tickets: openTickets.count,
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};
