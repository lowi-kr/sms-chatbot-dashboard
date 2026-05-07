// api.js — shared API client for all dashboard pages

const getApiUrl = () => sessionStorage.getItem('sms_api') || window.SMS_CORE_API_URL || '';
const getToken = () => sessionStorage.getItem('sms_token') || '';

function requireAuth() {
  if (!getToken()) { window.location.href = 'login.html'; return false; }
  return true;
}

async function apiFetch(path, options = {}) {
  const url = getApiUrl() + path;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });

  if (resp.status === 401) { sessionStorage.clear(); window.location.href = 'login.html'; throw new Error('Unauthorized'); }
  if (!resp.ok) { const err = await resp.json().catch(() => ({ error: resp.statusText })); throw new Error(err.error || 'API error'); }
  return resp.json();
}

const api = {
  get: (path) => apiFetch(path),
  post: (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),

  stats: () => api.get('/api/stats'),
  contacts: () => api.get('/api/contacts'),
  contactConversations: (phone) => api.get(`/api/contacts/${encodeURIComponent(phone)}/conversations`),
  contactSupport: (phone) => api.get(`/api/contacts/${encodeURIComponent(phone)}/support`),

  // Note: conversationMessages removed — messages are encrypted and not readable by admin

  sendSMS: (to, message) => api.post('/api/send', { to, message }),

  blacklist: () => api.get('/api/blacklist'),
  addBlacklist: (phone, reason) => api.post('/api/blacklist', { phone_number: phone, reason }),
  removeBlacklist: (phone) => api.delete(`/api/blacklist/${encodeURIComponent(phone)}`),

  whitelist: () => api.get('/api/whitelist'),
  addWhitelist: (phone, label) => api.post('/api/whitelist', { phone_number: phone, label }),
  removeWhitelist: (phone) => api.delete(`/api/whitelist/${encodeURIComponent(phone)}`),

  supportTickets: () => api.get('/api/support'),
  closeTicket: (id) => api.post(`/api/support/${id}/close`, {}),
  supportOpenCount: () => api.get('/api/support/open-count'),

  logout: () => { sessionStorage.clear(); window.location.href = 'login.html'; },
};

// ---- Sidebar support badge (called on every page) ----
async function updateSupportBadge() {
  try {
    const { count } = await api.supportOpenCount();
    const badge = document.getElementById('support-badge');
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
  } catch (_) {}
}

// ---- Toast ----
function showToast(message, type = 'success') {
  const colors = {
    success: 'background:#2a3f2e;border-color:#4a8f5a;color:#7dd99a',
    error:   'background:#3f2a2e;border-color:#8f4a55;color:#d97d8a',
    info:    'background:#2a333f;border-color:#4a6a8f;color:#7daad9',
  };
  const icons = { success: 'check_circle', error: 'error', info: 'info' };
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:999;display:flex;align-items:center;gap:10px;padding:12px 18px;border-radius:10px;border:1px solid;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,0.3);font-family:'DM Sans',sans-serif;font-size:13px;${colors[type]};animation:toastIn 0.25s ease`;
  t.innerHTML = `<span style="font-family:'Material Symbols Outlined';font-size:17px">${icons[type]}</span><span>${message}</span>`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut 0.25s ease forwards'; setTimeout(() => t.remove(), 250); }, 3000);
}

// ---- Confirm modal ----
function showConfirm(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:998;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#252d3d;border:1px solid #3d4a63;border-radius:14px;padding:28px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.4);font-family:'DM Sans',sans-serif">
      <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:22px">
        <span style="font-family:'Material Symbols Outlined';font-size:22px;color:#e07a7a;flex-shrink:0;margin-top:1px">warning</span>
        <p style="color:#c8d4e8;font-size:14px;line-height:1.6;margin:0">${message}</p>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="mc" style="padding:8px 18px;border-radius:8px;background:#1e2433;border:1px solid #3d4a63;color:#7a8ba8;font-size:13px;cursor:pointer;font-family:inherit">Cancel</button>
        <button id="mok" style="padding:8px 18px;border-radius:8px;background:#e07a7a;border:none;color:white;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#mc').onclick = () => overlay.remove();
  overlay.querySelector('#mok').onclick = () => { overlay.remove(); onConfirm(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ---- Global styles ----
const styleTag = document.createElement('style');
styleTag.textContent = `
  @keyframes toastIn  { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  @keyframes toastOut { from{opacity:1;transform:translateY(0)} to{opacity:0;transform:translateY(8px)} }
  @keyframes spin { to{transform:rotate(360deg)} }
  .spin { animation:spin 0.7s linear infinite; display:inline-block; }
`;
document.head.appendChild(styleTag);
