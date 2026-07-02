# SMS CORE — Admin Dashboard

A web-based admin dashboard for the [`sms-chatbot`](https://github.com/lowi-kr/sms-chatbot) SMS AI bot. Built for Cloudflare Pages (static frontend) + a separate Admin API Worker. Both share the same D1 database as the main bot worker.

If you haven't set up the bot itself yet, start with the [`sms-chatbot` README](https://github.com/lowi-kr/sms-chatbot) first — this dashboard has nothing to manage without it.

---

## Architecture

```
[Browser]  →  Cloudflare Pages (this repo, static HTML/JS)
               ↓ fetch() with Bearer token
           →  Admin API Worker (sms-chatbot-admin-api)
               ↓ D1 bindings
           →  D1 Database (sms-chatbot-db)  ←  also used by the sms-chatbot bot worker
               ↓ Telnyx API for outbound sends
           →  Telnyx
```

The frontend is static and has no server logic of its own — every read/write goes through the Admin API Worker, which is the only thing with D1 access and Telnyx credentials. The main bot worker (`sms-chatbot`) is completely untouched by anything here.

---

## File Structure

```
sms-chatbot-dashboard/
├── login.html            # Login page
├── index.html             # Message logs / contacts / quick reply
├── support.html            # Support ticket queue
├── user_controls.html       # Whitelist / blacklist management
├── model_settings.html       # Global + per-number model/fallback/limit settings
├── api.js                    # Shared API client, toasts, confirm modal
├── config.js                  # ⚙️ SET YOUR ADMIN API URL HERE
└── admin-api/
    ├── admin-api.js            # Admin API worker source (deployed manually, see below)
    └── wrangler.toml            # Reference config for the admin-api worker
```

> **Note on `admin-api/`:** this worker is **not** git-deployed. Its code is pasted directly into the Cloudflare inline editor (see Step 1 below) and this folder exists purely as a source backup so the code isn't only living in Cloudflare's editor. If you edit `admin-api.js`, remember to re-paste it into the Cloudflare dashboard manually — pushing to GitHub does **not** update this worker.

---

## Setup — Step by Step

### Step 1: Deploy the Admin API Worker

This is a separate worker from the main `sms-chatbot` bot worker, deployed via the Cloudflare dashboard inline editor (no CLI, no git auto-deploy).

1. **Workers & Pages** → **Create** → **Workers** tab → **Create Worker**.
2. Name it `sms-chatbot-admin-api` → **Deploy** → **Edit Code**.
3. Paste the entire contents of `admin-api/admin-api.js` → **Deploy**.

> ⚠️ **Inline editor risk:** anything pasted here has no git history. If you ever paste an older or partial version over the working code, you can silently lose logic (this has happened before with the support ticket routes). Always paste the full current file, and keep `admin-api/admin-api.js` in this repo up to date as your source of truth.

**Bind the D1 database:**

1. `sms-chatbot-admin-api` worker → **Settings** → **Bindings** → **Add** → **D1 Database**.
2. Variable name: `DB`, select your existing `sms-chatbot-db` (the same database the bot worker uses).

**Set secrets** (Settings → Variables → Add variable, mark as **Encrypted**):

| Variable | Value |
|---|---|
| `ADMIN_SECRET` | A strong password you choose — this is your dashboard login |
| `TELNYX_API_KEY` | Same value as on the main `sms-chatbot` worker |
| `TELNYX_PHONE_NUMBER` | Same value as on the main `sms-chatbot` worker |

Do **not** set `ENCRYPTION_KEY` on this worker — the admin API is intentionally unable to decrypt conversation content. Support ticket and outbound-SMS content is stored in plaintext by design and doesn't need it.

Copy the worker's URL, e.g. `https://sms-chatbot-admin-api.YOUR-NAME.workers.dev`.

### Step 2: Configure the Frontend

Edit `config.js`:

```js
window.SMS_CORE_API_URL = 'https://sms-chatbot-admin-api.YOUR-NAME.workers.dev';
```

Commit and push.

### Step 3: Deploy the Frontend to Cloudflare Pages

1. **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → select `sms-chatbot-dashboard`.
2. Framework preset: **None**, build command and output directory: leave blank.
3. **Save and Deploy** — Cloudflare will auto-deploy on every push from here on.

Your dashboard will be live at `https://sms-chatbot-dashboard.pages.dev` (or your custom domain).

### Step 4: Log In

Open `.../login.html`, enter the `ADMIN_SECRET` from Step 1.

---

## Pages & Features

### Message Logs (`index.html`)
- Contact table with message counts (today / month / all-time), status badges (Blocked / VIP / Normal)
- Click a row → slide-out panel: contact stats, that contact's support tickets, and a quick-reply box
- Compose SMS to any number, block/unblock inline
- Auto-refreshes every 60s

### Support (`support.html`)
- All `/support` tickets from users, filterable by Open / Closed / All
- Reply routes to Message Logs with the number pre-filled
- Close tickets; badge in the sidebar nav shows the open count

### User Control (`user_controls.html`)
- Blacklist and whitelist, side by side — add, search, remove
- Reminder banner: a non-empty whitelist puts the bot in strict allow-list mode

### Model Settings (`model_settings.html`)
- **Global Defaults**: default OpenRouter model, default fallback model (`block` or a model slug), default token limit
- **Per-Number Overrides**: model, fallback, and token limit per phone number, plus live usage bars and a reset-usage button
- Model picker pulls the live OpenRouter catalog through the admin API (`/api/openrouter-models`, cached ~10 min)

---

## Security & Privacy Notes

- Login is session-only — closing the tab clears it. `ADMIN_SECRET` is sent as a Bearer token on every request.
- **Conversation message content is not accessible from this dashboard, and never will be** — messages are encrypted per-phone on the bot worker and the admin API has no decryption key. The `/api/contacts/:phone/messages` endpoint (`conversationMessages` in `api.js`) is intentionally unused and must not be reintroduced; doing so would defeat the encryption entirely.
- **Support ticket messages and admin-sent outbound SMS are plaintext by design** — they need to be human-readable to act on, and appear in the Message Logs panel and Support page.
- For an extra layer, put **Cloudflare Access** in front of the Pages URL (Zero Trust → Access → Applications → Self-hosted) for a second login (Google/email OTP) before the password form is even reachable.

---

## Updating the Dashboard

- **Frontend:** edit files here, commit and push — Cloudflare Pages auto-deploys in ~1 minute.
- **Admin API worker:** edit `admin-api/admin-api.js` in this repo for the source-of-truth copy, then manually re-paste it into the Cloudflare inline editor for `sms-chatbot-admin-api` and redeploy. This step does **not** happen automatically.

---

## Troubleshooting

**"Connection failed" on login:** check `config.js` has the correct worker URL, and that the admin-api worker is deployed.

**"Unauthorized" after logging in:** `ADMIN_SECRET` mismatch — check for extra whitespace.

**CORS errors:** `admin-api.js` sets `Access-Control-Allow-Origin: *` by default; restrict to your Pages domain in `admin-api.js` if needed.

**No contacts showing:** check the admin-api worker's **Settings → Bindings** has `DB` bound to `sms-chatbot-db`.

**Can't send SMS:** verify `TELNYX_API_KEY` and `TELNYX_PHONE_NUMBER` are set as secrets on the **admin-api** worker (separately from the main bot worker's secrets).

**Support badge / tickets not showing:** confirm the `support_tickets` table exists in `sms-chatbot-db` (created by `schema.sql` in the [`sms-chatbot`](https://github.com/lowi-kr/sms-chatbot) repo) and that the `/support` command routes are present in the main bot worker's `commands.js`.
