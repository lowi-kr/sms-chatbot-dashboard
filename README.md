# SMS CORE — Admin Dashboard

A web-based admin dashboard for your SMS chatbot. Built for Cloudflare Pages + a separate Admin API Worker.

---

## Architecture

```
[Browser]  →  Cloudflare Pages (frontend)
               ↓ fetch() with Bearer token
           →  Admin API Worker (sms-chatbot-admin-api)
               ↓ D1 bindings
           →  D1 Database (sms-chatbot-db)  ←  also used by main sms-chatbot worker
               ↓ Telnyx API for sending
           →  Telnyx (outbound SMS)
```

**Key principle:** The frontend (Pages) is static HTML/JS. It talks to a dedicated Admin API Worker which has D1 access and Telnyx credentials. Your main chatbot worker is unchanged.

---

## File Structure

```
sms-dashboard/
├── frontend/              ← Deploy this folder to Cloudflare Pages
│   ├── login.html         ← Login page
│   ├── index.html         ← Message logs / contacts
│   ├── user_controls.html ← Whitelist / blacklist management
│   ├── api.js             ← Shared API client (auto-included by pages)
│   ├── config.js          ← ⚙️ SET YOUR API URL HERE
│   ├── _headers           ← Security headers for Pages
│   └── _redirects         ← Pages routing
│
└── worker-api/            ← Deploy this as a separate Cloudflare Worker
    ├── admin-api.js        ← The API worker code
    └── wrangler.toml       ← Worker config (update database_id if different)
```

---

## Setup — Step by Step

### Step 1: Deploy the Admin API Worker

This is a NEW worker separate from your main sms-chatbot worker.

**Option A: Via Cloudflare Dashboard (no CLI)**

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
2. Click **Workers** tab → **Create Worker**
3. Name it `sms-chatbot-admin-api`
4. Click **Deploy**, then **Edit Code**
5. Paste the entire contents of `worker-api/admin-api.js` into the editor
6. Click **Deploy**

**Bind the D1 database:**
1. Go to your `sms-chatbot-admin-api` worker → **Settings** → **Bindings**
2. Click **Add** → **D1 Database**
3. Variable name: `DB`
4. Select your existing `sms-chatbot-db` database
5. Click **Save**

**Set secrets (Settings → Variables → Add variable, mark as Encrypted):**

| Variable | Value |
|---|---|
| `ADMIN_SECRET` | A strong password you choose (e.g. `MySecret$2024!`) — this is your dashboard login |
| `TELNYX_API_KEY` | Same as your main worker |
| `TELNYX_PHONE_NUMBER` | Same as your main worker |

6. Copy your worker URL — it will look like:
   `https://sms-chatbot-admin-api.YOUR-NAME.workers.dev`

---

### Step 2: Configure the Frontend

1. Open `frontend/config.js`
2. Replace `https://sms-chatbot-admin-api.YOUR-NAME.workers.dev` with your actual worker URL from Step 1

```js
window.SMS_CORE_API_URL = 'https://sms-chatbot-admin-api.YOUR-NAME.workers.dev';
```

---

### Step 3: Deploy the Frontend to Cloudflare Pages

**Option A: Connect to GitHub (recommended — auto-deploys)**

1. Push the `frontend/` folder contents to a GitHub repo
   - You can put it in a subfolder like `dashboard/` in your existing `sms-chatbot` repo,
     or create a separate `sms-chatbot-dashboard` repo
2. Go to Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. Select your repo
4. Set build settings:
   - **Framework preset:** None
   - **Build command:** (leave blank)
   - **Build output directory:** `/` (or `dashboard/` if you used a subfolder)
5. Click **Save and Deploy**

Your dashboard will be at: `https://sms-chatbot-dashboard.pages.dev` (or similar)

**Option B: Direct upload**
1. Go to Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Direct Upload**
2. Name it `sms-chatbot-dashboard`
3. Drag and drop the `frontend/` folder contents
4. Click **Deploy**

---

### Step 4: Log In

1. Open your Pages URL in a browser (e.g. `https://sms-chatbot-dashboard.pages.dev/login.html`)
2. Enter the `ADMIN_SECRET` you set in Step 1
3. You're in!

---

## Features

### Message Logs (index.html)
- **Contact table** — every phone number that has messaged the bot
- **Per-number stats** — messages today / this month / all-time
- **Status badges** — Blocked, VIP (whitelisted), Normal
- **Click any row** → slide-out panel showing full conversation history
- **Conversation switcher** — if a number has multiple conversations, tab between them
- **Quick reply** — type directly in the panel to send an SMS
- **Block button** on every row (one click, with confirmation)
- **Compose SMS** button — send to any number
- **Auto-refresh** every 60 seconds
- **Search + filter** by status, sort by activity

### User Control (user_controls.html)
- **Blacklist** — view all, add new, remove (unblock)
- **Whitelist** — view all, add new, remove
- **Search** within each list
- **Warning** if whitelist is non-empty (strict mode reminder)

---

## Security Notes

- The dashboard login is **session-only** — closing the browser tab clears the session
- The `ADMIN_SECRET` is sent as a Bearer token with every API request
- For stronger security, you can add **Cloudflare Access** in front of your Pages URL:
  - Go to **Zero Trust** → **Access** → **Applications** → **Add an Application** → **Self-hosted**
  - Set the domain to your Pages URL
  - This adds a second login layer (Google/email OTP) before anyone even sees the password form

---

## Updating the Dashboard

1. Edit files in `frontend/`
2. If using GitHub: commit and push — Cloudflare auto-deploys in ~1 minute
3. If using Direct Upload: go back to Cloudflare Pages → your project → **Upload assets**

---

## Troubleshooting

**"Connection failed" on login:**
- Check that `config.js` has the correct worker URL
- Make sure your Admin API worker is deployed and the URL is correct

**"Unauthorized" after logging in:**
- Double-check `ADMIN_SECRET` matches exactly (no extra spaces)

**CORS errors in browser console:**
- The admin-api.js sets `Access-Control-Allow-Origin: *` by default
- If you want to restrict to your Pages domain, change that header in admin-api.js

**No contacts showing:**
- Your D1 database binding might be wrong — check the worker → Settings → Bindings → `DB` is bound to `sms-chatbot-db`

**Can't send SMS:**
- Verify `TELNYX_API_KEY` and `TELNYX_PHONE_NUMBER` are set as secrets on the admin worker
