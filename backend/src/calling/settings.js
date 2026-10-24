// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE ADMIN SETTINGS.
//
// Stored through utils/integrationStore.js (the one credential store): API key, API token and webhook secret are
// encrypted with INTEGRATION_SECRET_KEY and are NEVER in a response, a log or an audit row.
//
//   load()         server-side, decrypted, normalised into plain typed settings (+ the list of what is missing)
//   publicView()   what the browser may see: no secret, only "set / not set" and a masked hint
//   save()         Admin form -> store
//   status()       Not configured / Configuration required / Connected / Error (never "Connected" without a successful test)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const store = require('../utils/integrationStore');
const core = require('../utils/messagingCore');
const X = require('./exotelConfig');

const { F } = X;
const TEST_KEY = 'ai-calling.test';
const ROLE_WORDS = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'HR', 'ACCOUNTANT'];

const yes = (v, d) => (v == null || String(v).trim() === '' ? d : /^(y|yes|true|on|1)/i.test(String(v).trim()));
const list = (v) => String(v == null ? '' : v).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
const intIn = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
const hm = (v, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim().replace(/^(\d):/, '0$1:') : d);
const cleanHost = (v) => {
  const t = String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]{0,120}[a-z0-9])?(:\d{2,5})?$/.test(t) ? t : '';
};
const LANG_OF = (w) => {
  const t = String(w || '').trim().toLowerCase();
  if (/^(en|english)/.test(t)) return 'English';
  if (/^(te|telugu)/.test(t)) return 'Telugu';
  if (/^(hi|hindi)/.test(t)) return 'Hindi';
  return null;
};

// Pure: a map of stored values -> typed settings. Unknown / invalid values become the safe default.
function normalise(values) {
  const v = values || {};
  const D = X.DEFAULTS;
  const mode = /^live/i.test(String(v[F.mode] || '').trim()) ? 'Live' : /^test/i.test(String(v[F.mode] || '').trim()) ? 'Test' : 'Off';
  const region = /sing/i.test(String(v[F.region] || '')) ? 'singapore' : 'mumbai';
  const host = cleanHost(v[F.host]) || X.HOSTS[region];
  const languages = list(v[F.languages]).map(LANG_OF).filter((x, i, a) => x && a.indexOf(x) === i);
  const gaps = list(v[F.gaps]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 10080).map(Math.round);
  const reminders = list(v[F.reminders]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0 && n <= 168);
  const roles = (raw, fallback) => {
    const r = list(raw).map((x) => x.toUpperCase().replace(/\s+/g, '_')).filter((x) => ROLE_WORDS.includes(x));
    return r.length ? r : fallback;
  };
  const phones = list(v[F.testNumbers]).map((x) => core.normalizeMobile(x)).filter((m) => m.ok).map((m) => m.e164);
  const from = hm(v[F.hoursFrom], D.hoursFrom);
  const to = hm(v[F.hoursTo], D.hoursTo);
  const publicBase = String(v[F.publicBase] || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  return {
    mode,
    sid: String(v[F.sid] || '').trim(),
    key: String(v[F.key] || '').trim(),
    token: String(v[F.token] || '').trim(),
    region,
    host,
    callerId: String(v[F.callerId] || '').trim(),
    appId: String(v[F.appId] || '').trim().replace(/[^\w.-]/g, ''),
    flowUrl: /^https?:\/\/[^\s]+$/i.test(String(v[F.flowUrl] || '').trim()) ? String(v[F.flowUrl]).trim() : '',
    hook: String(v[F.hook] || '').trim(),
    hookIps: list(v[F.hookIps]),
    publicBase,
    testNumbers: phones,
    hoursFrom: from,
    hoursTo: to,
    outside: /^ref/i.test(String(v[F.outside] || '')) ? 'Refuse' : 'Queue',
    dailyLimit: intIn(v[F.dailyLimit], 1, 100000, D.dailyLimit),
    userLimit: intIn(v[F.userLimit], 0, 100000, D.userLimit),
    attempts: intIn(v[F.attempts], 1, 10, D.attempts),
    gaps: gaps.length ? gaps : D.gaps,
    languages: languages.length ? languages : D.languages,
    fallbackLanguage: LANG_OF(v[F.fallbackLanguage]) || D.fallbackLanguage,
    voice: String(v[F.voice] || '').trim().slice(0, 60),
    reminders: reminders.length ? reminders : D.reminders,
    callRoles: roles(v[F.callRoles], D.callRoles),
    bulkRoles: roles(v[F.bulkRoles], D.bulkRoles),
    consentApplied: yes(v[F.consentApplied], D.consentApplied),
    dndService: yes(v[F.dndService], D.dndService),
    recording: yes(v[F.recording], D.recording),
    keepTranscripts: yes(v[F.keepTranscripts], D.keepTranscripts),
    transcriptDays: intIn(v[F.transcriptDays], 1, 3650, D.transcriptDays),
    recordingDays: intIn(v[F.recordingDays], 1, 3650, D.recordingDays),
    writtenEmail: yes(v[F.writtenEmail], D.writtenEmail),
    writtenWhatsapp: yes(v[F.writtenWhatsapp], D.writtenWhatsapp),
    shortlistStages: list(v[F.shortlistStages]).map((x) => x.toUpperCase().replace(/\s+/g, '_')).filter(Boolean).length
      ? list(v[F.shortlistStages]).map((x) => x.toUpperCase().replace(/\s+/g, '_')).filter(Boolean) : D.shortlistStages,
    maxBulk: intIn(v[F.maxBulk], 1, 1000, D.maxBulk),
  };
}

const fingerprintOf = (s) => crypto.createHash('sha256').update([s.sid, s.key, s.token, s.host, s.callerId, s.appId, s.flowUrl].join('\u0001')).digest('hex').slice(0, 24);

// What is still missing before a real call can be placed, in plain words (empty = ready to place calls).
function problemsOf(s, { row, missingKey }) {
  const p = [];
  if (!row) { p.push('Nothing is saved yet. Fill in the Exotel details below and press Save.'); return p; }
  if (missingKey) p.push('A saved key could not be read (INTEGRATION_SECRET_KEY is missing or has changed). Enter the API key, API token and webhook secret again.');
  if (!s.sid) p.push('Account SID is missing (Exotel dashboard > Settings > API Settings).');
  if (!s.key || !s.token) p.push('API key and API token are missing (Exotel dashboard > Settings > API Settings).');
  if (!s.callerId) p.push('Approved caller ID (the ExoPhone Exotel approved for you) is missing.');
  if (!s.appId && !s.flowUrl) p.push('The Voicebot flow is missing. Ask Exotel to enable Voicebot on your account, create a Flow with the Voicebot applet pointing to your TeamLink address, then paste the Flow App ID here.');
  if (!s.hook) p.push('Webhook secret is missing. Type any long text; it protects the address Exotel calls back.');
  if (!s.publicBase) p.push('The public address of this TeamLink is missing. Exotel must be able to reach it over the internet.');
  else if (!/^https:\/\//i.test(s.publicBase) && !core.loopback(s.publicBase)) p.push('The public address must start with https:// so Exotel can call back safely.');
  return p;
}

async function readTest() {
  const r = await prisma.appSetting.findUnique({ where: { key: TEST_KEY } }).catch(() => null);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}
async function writeTest(obj, user) {
  const v = JSON.stringify(obj);
  await prisma.appSetting.upsert({
    where: { key: TEST_KEY },
    create: { key: TEST_KEY, value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
}

let CACHE = null; // { at, value } - 3 seconds, so a burst of requests reads the store once
function dropCache() { CACHE = null; }

async function load({ fresh = false } = {}) {
  if (!fresh && CACHE && Date.now() - CACHE.at < 3000) return CACHE.value;
  let cfg;
  try {
    cfg = await store.readConfig(X.CHANNEL_ID);
  } catch (err) {
    const s = normalise({});
    return { ...s, configured: false, problems: [`The settings could not be read: ${String(err && err.message).slice(0, 160)}`], hasRow: false };
  }
  const s = normalise(cfg.values);
  const problems = problemsOf(s, { row: cfg.row, missingKey: cfg.missingKey });
  const value = {
    ...s, hasRow: !!cfg.row, missingKey: !!cfg.missingKey, problems, configured: problems.length === 0,
    devBase: core.devOverride(cfg.values), fingerprint: fingerprintOf(s),
  };
  CACHE = { at: Date.now(), value };
  return value;
}

// The address of the Exotel API: the region's host, or (tests / a loopback override, never in production) the local fake.
function apiBase(s) {
  return core.providerBase(`https://${s.host}`, {});
}

// Not configured / Configuration required / Connected / Error. "Connected" ONLY after a successful read-only test of THIS
// exact configuration (a changed key / number / flow invalidates it).
async function status(s0) {
  const s = s0 || await load();
  const test = await readTest();
  if (!s.hasRow || (!s.sid && !s.key && !s.token && !s.callerId && !s.appId && !s.flowUrl && !s.hook)) {
    return { state: 'Not configured', detail: 'Exotel AI Calling is not set up yet.', steps: s.problems };
  }
  if (!s.configured) return { state: 'Configuration required', detail: s.problems[0], steps: s.problems };
  const fresh = test && test.fingerprint === s.fingerprint;
  if (!fresh) return { state: 'Configuration required', detail: 'Details are saved. Press "Test connection" to check them with Exotel (no call is placed).', steps: ['Press "Test connection".'] };
  if (!test.ok) return { state: 'Error', detail: test.message || 'The last connection test failed.', steps: [], lastTest: { at: test.at, message: test.message, checks: test.checks } };
  return { state: 'Connected', detail: test.message || 'Exotel accepted the account details.', steps: [], lastTest: { at: test.at, message: test.message, checks: test.checks } };
}

// What the browser may see. No secret value, no Exotel key, only whether each secret is set.
async function publicView() {
  const channel = require('../utils/adminCatalog').integrationById(X.CHANNEL_ID);
  const row = await store.integrationRow(X.CHANNEL_ID);
  const pv = store.publicValuesFor(channel, row);
  const s = await load({ fresh: true });
  const st = await status(s);
  return {
    id: X.CHANNEL_ID,
    mode: s.mode,
    status: st,
    fields: channel.fields.map(([label, placeholder]) => ({
      k: Object.keys(F).find((n) => F[n] === label), label, placeholder, secret: pv.secretFields.includes(label), hint: pv.secretHints[label] || '', value: pv.secretFields.includes(label) ? '' : (pv.values[label] || ''),
    })),
    secretSet: { key: !!s.key, token: !!s.token, hook: !!s.hook },
    ready: { configured: s.configured, problems: s.problems },
    urls: webhookUrls(s, { masked: true }),
    live: s.mode === 'Live',
  };
}

// The addresses to paste into Exotel. The secret is shown as bullets unless asked for (server-side only).
function webhookUrls(s, { masked = true } = {}) {
  const base = s.publicBase || '(set the public address first)';
  const key = s.hook ? (masked ? '•••••' : encodeURIComponent(s.hook)) : '(set the webhook secret first)';
  return {
    statusCallback: `${base}${X.WEBHOOK.statusPath}?${X.WEBHOOK.keyParam}=${key}`,
    voicebotWebSocket: `${base.replace(/^http/i, 'ws')}${X.WEBHOOK.voicebotWsPath}`,
    voicebotHttp: `${base}${X.WEBHOOK.voicebotHttpPath}/<call token>/turn`,
  };
}

// Admin form -> store. Secrets left blank keep their stored value ("-" clears one). A field the form did not send keeps what
// was stored (so a partial save never wipes the other settings).
async function save(values, user) {
  const incoming = values && typeof values === 'object' ? values : {};
  const row0 = await store.integrationRow(X.CHANNEL_ID);
  const stored = store.parseValues(row0);
  const merged = {};
  X.FIELD_LIST.forEach(([label]) => {
    if (Object.prototype.hasOwnProperty.call(incoming, label)) merged[label] = incoming[label];
    else if (!store.isSecretField(X.CHANNEL_ID, label)) merged[label] = stored[label] == null ? '' : stored[label];
  });
  const written = await store.writeValues(X.CHANNEL_ID, merged);
  const mode = normalise({ [F.mode]: merged[F.mode] }).mode;
  const row = await prisma.integration.update({
    where: { id: X.CHANNEL_ID },
    data: {
      values: JSON.stringify(written.values),
      enabled: mode !== 'Off',
      connected: false,
      state: 'Not Connected',
      error: null,
    },
  });
  dropCache();
  await store.recordEvent(X.CHANNEL_ID, { action: 'Configured', by: user ? user.name : 'system', result: 'Saved (secrets encrypted at rest)' });
  return row;
}

module.exports = {
  normalise, load, publicView, save, status, readTest, writeTest, dropCache, webhookUrls, apiBase, fingerprintOf, problemsOf, ROLE_WORDS, TEST_KEY, list,
};
