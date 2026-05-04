// admin-api.js
// Cloudflare Worker that serves as the backend API for the SMS dashboard.

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

function unauthorized() {
  return json({ error: 'Unauthorized' }, 401);
}

function checkAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  return token === env.ADMIN_SECRET;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- LOGIN ---
    if (path === '/api/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (body.password === env.ADMIN_SECRET) {
        return json({ token: env.ADMIN_SECRET });
      }
      return json({ error: 'Invalid password' }, 401);
    }

    if (!checkAuth(request, env)) return unauthorized();

    const db = env.DB;

    // =====================
    //  CONTACTS / NUMBERS
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

    const convMsgMatch = path.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (convMsgMatch && request.method === 'GET') {
      const id = convMsgMatch[1];
      const { results } = await db.prepare(`
        SELECT id, role, content, created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
      `).bind(id).all();
      return json(results);
    }

    // =====================
    //  SEND SMS
    // =====================

    if (path === '/api/send' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { to, message } = body;
      if (!to || !message) return json({ error: 'Missing to or message' }, 400);

      const resp = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.TELNYX_PHONE_NUMBER,
          to,
          text: message,
        }),
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
      const { results } = await db.prepare(
        `SELECT phone_number, reason, created_at FROM blacklist ORDER BY created_at DESC`
      ).all();
      return json(results);
    }

    if (path === '/api/blacklist' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { phone_number, reason } = body;
      if (!phone_number) return json({ error: 'Missing phone_number' }, 400);
      await db.prepare(
        `INSERT OR IGNORE INTO blacklist (phone_number, reason) VALUES (?, ?)`
      ).bind(phone_number, reason || '').run();
      return json({ success: true });
    }

    const blMatch = path.match(/^\/api\/blacklist\/(.+)$/);
    if (blMatch && request.method === 'DELETE') {
      const phone = decodeURIComponent(blMatch[1]);
      await db.prepare(`DELETE FROM blacklist WHERE phone_number = ?`).bind(phone).run();
      return json({ success: true });
    }

    // =====================
    //  WHITELIST
    // =====================

    if (path === '/api/whitelist' && request.method === 'GET') {
      const { results } = await db.prepare(
        `SELECT phone_number, label, created_at FROM whitelist ORDER BY created_at DESC`
      ).all();
      return json(results);
    }

    if (path === '/api/whitelist' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { phone_number, label } = body;
      if (!phone_number) return json({ error: 'Missing phone_number' }, 400);
      await db.prepare(
        `INSERT OR IGNORE INTO whitelist (phone_number, label) VALUES (?, ?)`
      ).bind(phone_number, label || '').run();
      return json({ success: true });
    }

    const wlMatch = path.match(/^\/api\/whitelist\/(.+)$/);
    if (wlMatch && request.method === 'DELETE') {
      const phone = decodeURIComponent(wlMatch[1]);
      await db.prepare(`DELETE FROM whitelist WHERE phone_number = ?`).bind(phone).run();
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
        UPDATE support_tickets 
        SET status = 'closed', closed_at = CURRENT_TIMESTAMP 
        WHERE id = ? AND status = 'open'
      `).bind(id).run();
      if (result.meta.changes === 0) return json({ error: 'Ticket not found or already closed' }, 404);
      return json({ success: true });
    }

    // GET /api/support/open-count — for sidebar badge
    if (path === '/api/support/open-count' && request.method === 'GET') {
      const result = await db.prepare(
        `SELECT COUNT(*) as count FROM support_tickets WHERE status = 'open'`
      ).first();
      return json({ count: result.count });
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
