// ---------------------------------------------------------------------------
// MESSAGING CORE — the pieces every outbound channel shares.
//
//   normalizeMobile()   one rule for "is this a phone number we can text?"
//   maskMobile()        how a number is shown back without being shown
//   httpJson()          fetch with a timeout; never throws, never logs bodies
//   providerBase()      the provider's real base URL — or, ONLY on a
//                       non-production server and ONLY for a loopback host,
//                       a test override (see below)
//   acquire()           a per-channel rate limiter (token spacing)
//   isTransientHttp()   which failures deserve a retry
//
// THE TEST OVERRIDE. Tests must prove the SMS / WhatsApp adapters build the
// right request without a real message ever leaving the machine. They point
// the adapter at a mock HTTP server on 127.0.0.1 by storing `__devBaseUrl` in
// the channel's Integration.values (not a catalogue field, so Administration
// can neither see nor set it, and the next Save drops it) or by setting
// TL_DEV_MESSAGING_BASE_URL. Either is IGNORED when NODE_ENV=production, and
// IGNORED unless the host is loopback — so the override can only ever make a
// message go nowhere, never somewhere else.
// ---------------------------------------------------------------------------

const DEFAULT_CC = '91';

// Returns { ok, e164 (digits, with country code), national, reason }.
// Indian 10-digit mobiles (6-9 first digit) get +91; a number written with a
// '+' or a 00 prefix is taken as international (8-15 digits, E.164).
function normalizeMobile(raw, { defaultCc = DEFAULT_CC } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, reason: 'No mobile number on record' };
  if (/[a-z]/i.test(text.replace(/ext\.?\s*\d+$/i, ''))) return { ok: false, reason: `"${text}" is not a phone number` };
  let digits = text.replace(/\D/g, '');
  const plus = text.startsWith('+') || text.startsWith('00');
  if (text.startsWith('00')) digits = digits.slice(2);
  if (!plus) {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) {
      if (defaultCc === '91' && !/^[6-9]/.test(digits)) return { ok: false, reason: `${text} is not a valid Indian mobile number` };
      digits = `${defaultCc}${digits}`;
    }
  }
  if (digits.length < 8 || digits.length > 15) return { ok: false, reason: `${text} is not a valid mobile number` };
  if (/^(\d)\1+$/.test(digits.slice(-10))) return { ok: false, reason: `${text} is a placeholder number` };
  if (digits.startsWith('91')) {
    const national = digits.slice(2);
    if (national.length !== 10 || !/^[6-9]/.test(national)) return { ok: false, reason: `${text} is not a valid Indian mobile number` };
    return { ok: true, e164: digits, national, cc: '91' };
  }
  return { ok: true, e164: digits, national: digits, cc: null };
}

function maskMobile(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 4) return null;
  const cc = d.length > 10 ? `+${d.slice(0, d.length - 10)} ` : '';
  return `${cc}${'•'.repeat(Math.max(2, Math.min(d.length, 10) - 4))}${d.slice(-4)}`;
}

function maskEmail(raw) {
  const e = String(raw || '').trim();
  const at = e.indexOf('@');
  if (at < 1) return null;
  return `${e[0]}${'•'.repeat(Math.max(2, at - 1))}${e.slice(at)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(raw) { return EMAIL_RE.test(String(raw || '').trim()); }

// --- The base URL ---------------------------------------------------------
function loopback(url) {
  try {
    const u = new URL(url);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname) && ['http:', 'https:'].includes(u.protocol);
  } catch { return false; }
}
function devOverride(values) {
  if (process.env.NODE_ENV === 'production') return null;
  const candidate = (values && values.__devBaseUrl) || process.env.TL_DEV_MESSAGING_BASE_URL || '';
  if (!candidate || !loopback(candidate)) return null;
  return String(candidate).replace(/\/+$/, '');
}
function providerBase(realBase, values) {
  return devOverride(values) || realBase;
}

// --- HTTP ------------------------------------------------------------------
// Returns { ok, status, json, text, networkError }. Never throws. The request
// body and headers (which carry credentials) are never logged.
async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 2000) };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (err && (err.cause && err.cause.code)) || (err && err.message) || 'network error';
    return { ok: false, status: 0, json: null, text: '', networkError: String(reason) };
  } finally {
    clearTimeout(timer);
  }
}

// 0 (network), 408, 425, 429 and 5xx are worth another try; the rest are the
// provider saying no.
function isTransientHttp(status) {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

// --- Rate limiting ----------------------------------------------------------
// Messages per second per channel. Conservative defaults well under each
// provider's published limit; MSG_RATE_<CHANNEL>=n overrides.
const RATE_DEFAULTS = { Email: 5, SMS: 10, WhatsApp: 20 };
const nextSlot = {};
function ratePerSec(channel) {
  const env = Number(process.env[`MSG_RATE_${String(channel).toUpperCase()}`]);
  return env > 0 ? env : (RATE_DEFAULTS[channel] || 5);
}
// Resolves when this channel may send its next message.
function acquire(channel) {
  const gap = 1000 / ratePerSec(channel);
  const now = Date.now();
  const at = Math.max(now, nextSlot[channel] || 0);
  nextSlot[channel] = at + gap;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => { setTimeout(r, wait); }) : Promise.resolve();
}

// A provider's words, trimmed for a screen, with anything credential-shaped
// removed defensively (providers do not echo keys, but a proxy might).
function tidy(text) {
  return String(text || '')
    .replace(/(authkey|authorization|access_token|token|api[_-]?key)(["'=:\s]+)[^\s"'&,}]+/gi, '$1$2•••')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

module.exports = {
  normalizeMobile, maskMobile, maskEmail, validEmail,
  providerBase, devOverride, loopback,
  httpJson, isTransientHttp, acquire, ratePerSec, tidy,
};
