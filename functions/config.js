// functions/config.js — Cloudflare Pages Function.
//
// This intercepts requests to /config.js and generates it dynamically from a
// Pages environment variable, instead of shipping a hardcoded worker URL in a
// committed static file. Pages Functions take priority over static assets at
// the same path, so this fully replaces the old dashboard/config.js.
//
// Setup (one-time, in the Cloudflare dashboard):
//   1. Workers & Pages → your Pages project (sms-chatbot-dashboard) → Settings
//      → Environment variables.
//   2. Add SMS_CORE_API_URL = https://sms-chatbot.YOUR-NAME.workers.dev
//      for both "Production" and "Preview" environments.
//   3. Redeploy (or it applies on the next deploy/push automatically).
//
// No code change or git commit is needed to update the URL going forward —
// just edit the environment variable and redeploy from the Cloudflare
// dashboard's "Retry deployment" button, or push any commit.

export async function onRequest(context) {
  const apiUrl = context.env.SMS_CORE_API_URL || '';

  if (!apiUrl) {
    console.error('SMS_CORE_API_URL is not set as a Pages environment variable — dashboard will be unable to reach the admin API.');
  }

  const body = `window.SMS_CORE_API_URL = ${JSON.stringify(apiUrl)};`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // This value isn't secret (the browser has to call it anyway), but it
      // does change per-environment, so don't let intermediate caches serve
      // a stale URL across deploys.
      'Cache-Control': 'no-store',
    },
  });
}
