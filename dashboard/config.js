// config.js — DEPRECATED, kept only as a safety net.
//
// The real /config.js response now comes from functions/config.js (a
// Cloudflare Pages Function), which reads the SMS_CORE_API_URL environment
// variable set in the Pages project's dashboard settings. Pages Functions
// take priority over static files at the same path, so THIS FILE IS NEVER
// ACTUALLY SERVED as long as functions/config.js exists in the repo.
//
// It's left in place (rather than deleted) only so that if functions/config.js
// is ever accidentally removed, the site fails loudly (empty API URL →
// "Connection failed" on login) instead of silently falling back to a stale
// hardcoded worker URL from a previous deploy.
//
// See functions/config.js for setup instructions (Settings → Environment
// variables → SMS_CORE_API_URL).

window.SMS_CORE_API_URL = window.SMS_CORE_API_URL || '';
