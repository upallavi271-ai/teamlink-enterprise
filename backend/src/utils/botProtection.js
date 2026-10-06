// ---------------------------------------------------------------------------
// BOT PROTECTION on the public apply (ATS-100 B9.5) — Cloudflare Turnstile.
//
// Administration → Integrations → "Bot protection (Cloudflare Turnstile)":
// Site key (public, goes to the browser) + Secret key (encrypted at rest,
// utils/integrationStore.js). When the channel is configured AND enabled the
// careers apply form must send the Turnstile token (field
// cf-turnstile-response) and the server checks it with Cloudflare.
//
// When it is NOT configured nothing changes: the honeypot + rate limit stay
// and applies are never blocked. The Integrations card says "built, needs
// account" with the setup steps until a key is saved.
//
// Setup (free): https://dash.cloudflare.com → Turnstile → Add site → the
// site's hostname → copy Site key + Secret key here → Connect.
// ---------------------------------------------------------------------------
const { readConfig } = require('./integrationStore');

const CHANNEL = 'turnstile';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_FIELD = 'cf-turnstile-response';

async function config() {
  const cfg = await readConfig(CHANNEL).catch(() => null);
  const v = (cfg && cfg.values) || {};
  const siteKey = String(v['Site key'] || '').trim();
  const secret = String(v['Secret key'] || '').trim();
  const on = !!(cfg && cfg.enabled && siteKey && secret);
  return { on, provider: 'turnstile', siteKey: on ? siteKey : null, secret: on ? secret : null, configured: !!(siteKey && secret) };
}

// What a public page may know: whether to draw the widget, and the site key.
async function publicConfig() {
  const c = await config();
  return c.on ? { provider: 'turnstile', siteKey: c.siteKey, field: TOKEN_FIELD } : null;
}

// Checks the token. -> { ok: true } | { ok: false, error } | { ok: true, skipped: reason }
// A network failure towards Cloudflare does NOT lose the candidate: the apply
// goes through (the honeypot + rate limit still apply) and the reason is logged.
async function verify(token, ip) {
  const c = await config();
  if (!c.on) return { ok: true, skipped: 'not configured' };
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'Please tick the "I am human" box and send again.' };
  try {
    const body = new URLSearchParams({ secret: c.secret, response: t });
    if (ip) body.set('remoteip', ip);
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (j && j.success) return { ok: true };
    const codes = Array.isArray(j && j['error-codes']) ? j['error-codes'] : [];
    if (codes.includes('timeout-or-duplicate')) return { ok: false, error: 'The "I am human" check has expired — tick it again and send.' };
    return { ok: false, error: 'The "I am human" check did not pass. Please try again.' };
  } catch (err) {
    console.warn(`[bot-protection] Turnstile not reachable (${err && err.message}) — apply allowed, honeypot + rate limit still on`);
    return { ok: true, skipped: 'verify unreachable' };
  }
}

module.exports = {
  CHANNEL, TOKEN_FIELD, VERIFY_URL, config, publicConfig, verify,
};
