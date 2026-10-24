// ---------------------------------------------------------------------------
// PORTAL CREDENTIALS (PortalCredential): the company's own login for a portal.
//
//   * username, password and an optional secret are AES-256-GCM ciphertext (utils/secrets.js, the same key and the same
//     format as Administration -> Integrations). The database never holds plaintext.
//   * list() / save() answer with a MASKED username and "has a password": a secret is NEVER in an API answer,
//     a log line, an audit row or a screenshot.
//   * read() is for the worker only (server side). It is the only function that returns plaintext.
//   * `enabled` is the per-portal automation switch, default OFF. A saved login never posts anything by itself.
//   * A blank field on save means "unchanged"; the single character "-" clears it (same rule as Integrations).
//   * New / changed login -> status UNVERIFIED. A wrong password -> FAILED and posting stops for that portal
//     until the login is saved again (a repeated wrong password can lock a company account).
// ---------------------------------------------------------------------------
const { encryptSecret, decryptSecret, secretsConfigured, NO_SECRET_KEY_MESSAGE } = (() => {
  const s = require('../utils/secrets');
  return { encryptSecret: s.encryptSecret, decryptSecret: s.decryptSecret, secretsConfigured: s.secretsConfigured, NO_SECRET_KEY_MESSAGE: s.NO_KEY_MESSAGE };
})();
const { logAudit } = require('../utils/audit');
const {
  q1, ex, iso, newId,
} = require('./db');
const C = require('./constants');
const S = require('./settings');
const Q = require('./queue');

const LABEL = 'default';
// Telegram / Facebook: the two saved values are a channel + a token, not a login name + a password.
const API_FIELDS = {
  telegram: { username: 'Channel', usernameHint: '@yourchannel (or the number that starts with -100)', password: 'Bot token', passwordHint: 'From @BotFather, looks like 123456789:AAH...' },
  facebook: { username: 'Page number (Page ID)', usernameHint: 'The number of your Facebook Page', password: 'Page access token', passwordHint: 'A Page token with the pages_manage_posts permission' },
};
const STATUS_WORDS = {
  CONNECTED: 'Connected', FAILED: 'Login failed', UNVERIFIED: 'Not checked yet', NEEDS_HUMAN: 'Needs a person (CAPTCHA / OTP)', DISABLED: 'Switched off',
};

function maskUser(u) {
  const s = String(u || '');
  if (!s) return '';
  const at = s.indexOf('@');
  if (at > 1) return `${s.slice(0, 2)}${'•'.repeat(4)}${s.slice(at)}`;
  return s.length <= 3 ? '•••' : `${s.slice(0, 2)}${'•'.repeat(4)}${s.slice(-1)}`;
}
const dec = (v) => (v ? decryptSecret(v) : '');

// ---------------------------------------------------------------------------
// FORMAT CHECK of a login before it is saved (nothing is sent anywhere: this only catches typing slips).
//   problems  stop the save (plain words);   warnings  are shown but do not stop it.
// Only the fields that are being changed are checked (a blank field means "unchanged", "-" means "clear").
// -> { ok, problems: [], warnings: [] }
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE_RE = /^\+?[0-9][0-9 -]{8,14}[0-9]$/;
const hasControl = (t) => Array.from(String(t)).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const COMMON_PASSWORDS = ['password', 'password1', '12345678', '123456789', 'qwerty123', 'iloveyou', 'admin123', 'welcome1'];
function validateLogin(portal, body = {}, { first = false } = {}) {
  const problems = []; const warnings = [];
  const name = (C.PORTALS[portal] && C.PORTALS[portal].name) || portal;
  const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '' && String(body[k]).trim() !== '-';
  if (first && !has('username')) problems.push('Type the login name (usually the work e-mail).');
  if (first && !has('password')) problems.push('Type the password.');
  if (has('username')) {
    const raw = String(body.username);
    const u = raw.trim();
    if (u.length < 3) problems.push('The login name is too short.');
    else if (u.length > 120) problems.push('The login name is too long (most 120 characters).');
    else if (hasControl(u)) problems.push('The login name has a hidden control character. Type it again.');
    else if (u.includes('@') && !EMAIL_RE.test(u)) problems.push('This looks like an e-mail but is not complete (for example name@company.com).');
    else if (!u.includes('@') && !MOBILE_RE.test(u)) warnings.push(`${name} logins are usually an e-mail address or a mobile number. Check this one is right.`);
    if (/\s/.test(u)) problems.push('The login name has a space inside it.');
    if (raw !== u) warnings.push('Spaces before or after the login name were removed.');
  }
  if (has('password')) {
    const raw = String(body.password);
    const p = raw.trim();
    if (p.length < 6) problems.push('The password is too short (at least 6 characters).');
    else if (p.length > 128) problems.push('The password is too long (most 128 characters).');
    else if (hasControl(p)) problems.push('The password has a hidden control character. Type it again.');
    if (has('username') && p && p.toLowerCase() === String(body.username).trim().toLowerCase()) problems.push('The password is the same as the login name. That cannot be right.');
    if (p && COMMON_PASSWORDS.includes(p.toLowerCase())) warnings.push('This password is very common. If this really is the portal password, change it on the portal.');
    if (raw !== p) warnings.push('Spaces before or after the password were removed. If the portal password really has a space at its end, it cannot be saved here.');
  }
  if (has('secret') && String(body.secret).trim().length > 200) problems.push('The extra secret is too long (most 200 characters).');
  return { ok: problems.length === 0, problems, warnings };
}

// FORMAT CHECK for a token portal (Telegram: channel + bot token; Facebook: page number + page token). Typing slips only.
const TG_CHANNEL = /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{5,15}|-\d{5,15})$/;
const TG_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
const FB_PAGE = /^\d{5,20}$/;
const FB_TOKEN = /^[A-Za-z0-9_.|-]{30,600}$/;
function validateApiLogin(portal, body = {}, { first = false } = {}) {
  const problems = []; const warnings = [];
  const has = (k) => body[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '' && String(body[k]).trim() !== '-';
  const f = API_FIELDS[portal] || { username: 'Channel', password: 'Token' };
  if (first && !has('username')) problems.push(`Type the ${f.username.toLowerCase()}.`);
  if (first && !has('password')) problems.push(`Type the ${f.password.toLowerCase()}.`);
  if (has('username')) {
    const u = String(body.username).trim();
    if (portal === 'telegram' && !TG_CHANNEL.test(u)) problems.push('The channel should look like @yourchannel, or a number that starts with -100 (for a private channel or group).');
    if (portal === 'facebook' && !FB_PAGE.test(u)) problems.push('The Page number is only digits (for example 104820934501234). Find it in the Page, About, Page transparency.');
  }
  if (has('password')) {
    const p = String(body.password).trim();
    if (portal === 'telegram' && !TG_TOKEN.test(p)) problems.push('This does not look like a bot token. It looks like 123456789:AAH... and comes from @BotFather.');
    if (portal === 'facebook' && !FB_TOKEN.test(p)) problems.push('This does not look like a Page access token (a long line of letters and numbers, no spaces).');
  }
  return { ok: problems.length === 0, problems, warnings };
}

// The result of the last Test connection in plain words: { state, words, reason, at }
async function lastTestOf(portal) {
  const t = await S.lastTest(portal);
  if (!t) return { state: 'NOT_TESTED', words: C.TEST_STATES.NOT_TESTED, reason: null, at: null };
  return { state: t.state, words: C.TEST_STATES[t.state] || t.state, reason: t.reason || null, at: t.at || null };
}
// The worker / runner records what a login check showed. code = an error code (WRONG_PASSWORD, OTP, ...) or null for success.
async function recordTest(portal, code, reason = null) {
  const state = code ? (C.TEST_STATE_OF[code] || 'ERROR') : 'CONNECTED';
  await S.setLastTest(portal, { state, code: code || null, reason: reason ? String(reason).slice(0, 300) : null });
  return state;
}

const hasRow = (portal) => ['browser', 'api'].includes(C.PORTALS[portal].kind);
const rowOf = (portal, label = LABEL) => q1('SELECT * FROM "PortalCredential" WHERE "portal" = ? AND "accountLabel" = ?', portal, label);

// The safe view of one portal's login: no secret anywhere in it.
async function view(portal, row) {
  const meta = C.PORTALS[portal];
  const u = row ? dec(row.usernameEnc) : '';
  const [kill, hold, rate] = await Promise.all([S.killState(portal), S.humanHold(portal), Q.rateCheck(portal).catch(() => ({ ok: true }))]);
  const needsLogin = ['browser', 'api'].includes(meta.kind);
  const hasLogin = !!(row && row.usernameEnc && row.passwordEnc);
  return {
    portal, name: meta.name, kind: meta.kind, note: meta.note,
    manualOnly: meta.kind === 'manual', // LinkedIn: "Manual only"
    api: meta.kind === 'api',
    fields: meta.kind === 'api' ? API_FIELDS[portal] : null, // what the two boxes are called for a token portal
    needsLogin,
    accountLabel: row ? row.accountLabel : LABEL,
    hasLogin, usernameMasked: u === null ? '(cannot be read with this key)' : maskUser(u), hasPassword: !!(row && row.passwordEnc), hasSecret: !!(row && row.secretEnc),
    status: !needsLogin ? (meta.kind === 'internal' ? 'CONNECTED' : 'DISABLED') : (row ? row.status : 'UNVERIFIED'),
    statusWords: !needsLogin ? (meta.kind === 'internal' ? 'Always ready (no sign-in)' : 'Manual only') : STATUS_WORDS[row ? row.status : 'UNVERIFIED'],
    enabled: meta.kind === 'internal' ? !kill.stopped : !!(row && row.enabled && meta.automation),
    lastVerifiedAt: row ? iso(row.lastVerifiedAt) : null,
    lastError: row ? row.lastError || null : null,
    dailyLimit: row ? row.dailyLimit : null, hourlyLimit: row ? row.hourlyLimit : null, minGapSeconds: row ? row.minGapSeconds : null,
    updatedAt: row ? iso(row.updatedAt) : null,
    killed: kill.killedOne || kill.killedAll, paused: kill.paused,
    humanHold: hold ? { at: hold.at, reason: hold.reason || null } : null,
    waitingForRateLimit: rate.ok ? null : { reason: rate.reason, until: iso(rate.until) },
    secretsConfigured: secretsConfigured(),
    lastTest: needsLogin ? await lastTestOf(portal) : null,
  };
}

// What a person who may post (not an Admin) may see of a portal's login: only whether one is saved and how the last check went.
// Never the username (not even masked), never a secret.
async function posterView(portal) {
  const v = await one(portal);
  return {
    portal, name: v.name, kind: v.kind, needsLogin: v.needsLogin, manualOnly: v.manualOnly, hasLogin: v.hasLogin, status: v.status, statusWords: v.statusWords, enabled: v.enabled,
    lastVerifiedAt: v.lastVerifiedAt, lastError: v.lastError, humanHold: v.humanHold, killed: v.killed, paused: v.paused, secretsConfigured: v.secretsConfigured, lastTest: v.lastTest,
  };
}

async function list() {
  const out = [];
  for (const portal of C.PORTAL_KEYS) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await view(portal, hasRow(portal) ? await rowOf(portal) : null));
  }
  return out;
}
async function one(portal) { return view(portal, hasRow(portal) ? await rowOf(portal) : null); }

// Server side only: the plaintext login for a run. -> { ok, username, password, secret, status, enabled, row } | { ok:false, code }
async function read(portal, label = LABEL) {
  const row = await rowOf(portal, label);
  if (!row || !row.usernameEnc || !row.passwordEnc) return { ok: false, code: 'NO_CREDENTIALS', row };
  const username = decryptSecret(row.usernameEnc);
  const password = decryptSecret(row.passwordEnc);
  const secret = row.secretEnc ? decryptSecret(row.secretEnc) : '';
  if (username === null || password === null || secret === null) return { ok: false, code: 'NO_SECRET_KEY', row };
  return { ok: true, username, password, secret, status: row.status, enabled: !!row.enabled, row };
}

async function audit(user, action, portal, detail) {
  await logAudit({
    userId: user ? user.id : null, actorName: user ? user.name : null, action, entity: 'PortalCredential', entityId: portal,
    fromValue: C.portalName(portal), toValue: detail ? String(detail).slice(0, 300) : null,
  });
}

const intOrNull = (v) => { if (v === '' || v == null) return null; const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : null; };

// body: { username, password, secret, enabled, dailyLimit, hourlyLimit, minGapSeconds }
async function save(portal, body, user) {
  const meta = C.PORTALS[portal];
  if (!meta) return { error: 'Unknown portal', status: 404 };
  if (!['browser', 'api'].includes(meta.kind)) return { error: meta.kind === 'manual' ? `${meta.name} is posted by hand. No login is saved for it.` : `${meta.name} needs no login.`, status: 400 };
  const b = body || {};
  const prev = await rowOf(portal);
  const check = (meta.kind === 'api' ? validateApiLogin : validateLogin)(portal, b, { first: !prev || !prev.usernameEnc });
  if (!check.ok && (b.username !== undefined || b.password !== undefined || b.secret !== undefined)) return { error: check.problems.join(' '), problems: check.problems, warnings: check.warnings, status: 400 };
  const changed = [];
  const next = {
    usernameEnc: prev ? prev.usernameEnc : null, passwordEnc: prev ? prev.passwordEnc : null, secretEnc: prev ? prev.secretEnc : null,
  };
  const field = (key, col, label) => {
    if (b[key] === undefined || b[key] === null) return;
    const raw = String(b[key]);
    if (raw.trim() === '') return; // blank = unchanged
    if (raw.trim() === '-') { next[col] = null; changed.push(`${label} removed`); return; }
    next[col] = encryptSecret(raw.trim()); // throws NO_SECRET_KEY
    changed.push(`${label} changed`);
  };
  try {
    field('username', 'usernameEnc', 'username');
    field('password', 'passwordEnc', 'password');
    field('secret', 'secretEnc', 'secret');
  } catch (err) {
    if (err && err.code === 'NO_SECRET_KEY') return { error: NO_SECRET_KEY_MESSAGE, status: 400 };
    throw err;
  }
  const now = Date.now();
  const loginChanged = changed.some((c) => /username|password/.test(c));
  const lim = {
    dailyLimit: b.dailyLimit !== undefined ? intOrNull(b.dailyLimit) : (prev ? prev.dailyLimit : null),
    hourlyLimit: b.hourlyLimit !== undefined ? intOrNull(b.hourlyLimit) : (prev ? prev.hourlyLimit : null),
    minGapSeconds: b.minGapSeconds !== undefined ? intOrNull(b.minGapSeconds) : (prev ? prev.minGapSeconds : null),
  };
  ['dailyLimit', 'hourlyLimit', 'minGapSeconds'].forEach((k) => { if (b[k] !== undefined && (prev ? prev[k] : null) !== lim[k]) changed.push(`${k} set to ${lim[k] == null ? 'default' : lim[k]}`); });
  let enabled = prev ? !!prev.enabled : false;
  if (b.enabled !== undefined) { enabled = !!b.enabled; if (!prev || !!prev.enabled !== enabled) changed.push(`switch ${enabled ? 'ON' : 'OFF'}`); }
  // A different login is not the one that was checked: back to "Not checked yet", and the portal stops until it is
  // checked or posted with. (A switch left ON stays ON: the login check / DRY RUN is what proves it.)
  const status = loginChanged || !prev ? 'UNVERIFIED' : prev.status;
  const lastError = loginChanged ? null : (prev ? prev.lastError : null);
  if (loginChanged) { await S.clearHumanHold(portal).catch(() => {}); try { require('../playwright/session').clearSession(portal); } catch { /* in use or absent */ } } // eslint-disable-line global-require
  if (prev) {
    await ex(
      'UPDATE "PortalCredential" SET "usernameEnc" = ?, "passwordEnc" = ?, "secretEnc" = ?, "status" = ?, "lastError" = ?, "enabled" = ?, "dailyLimit" = ?, "hourlyLimit" = ?, "minGapSeconds" = ?, "updatedBy" = ?, "updatedAt" = ? WHERE "id" = ?',
      next.usernameEnc, next.passwordEnc, next.secretEnc, status, lastError, enabled ? 1 : 0, lim.dailyLimit, lim.hourlyLimit, lim.minGapSeconds, user ? user.id : null, now, prev.id,
    );
  } else {
    await ex(
      'INSERT INTO "PortalCredential" ("id","portal","accountLabel","usernameEnc","passwordEnc","secretEnc","status","enabled","dailyLimit","hourlyLimit","minGapSeconds","createdBy","updatedBy","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      newId('pc'), portal, LABEL, next.usernameEnc, next.passwordEnc, next.secretEnc, status, enabled ? 1 : 0, lim.dailyLimit, lim.hourlyLimit, lim.minGapSeconds, user ? user.id : null, user ? user.id : null, now, now,
    );
  }
  // The audit row names WHAT changed, never a value.
  if (changed.length) await audit(user, 'Portal credential updated', portal, changed.join(', '));
  if (loginChanged) await S.setLastTest(portal, { state: 'NOT_TESTED', code: null, reason: null });
  return { ok: true, credential: await one(portal), changed, warnings: check.warnings };
}

async function setEnabled(portal, on, user) {
  const meta = C.PORTALS[portal];
  if (!meta) return { error: 'Unknown portal', status: 404 };
  if (!meta.automation) return { error: `${meta.name} is posted by hand: there is no automatic posting to switch on.`, status: 400 };
  if (meta.kind === 'internal') return { error: `${meta.name} needs no switch (it is TeamLink's own page).`, status: 400 };
  const row = await rowOf(portal);
  if (on && (!row || !row.usernameEnc || !row.passwordEnc)) return { error: `Save the ${meta.name} login first, then switch automatic posting on.`, status: 400 };
  if (on && row.status === 'FAILED') return { error: `The last sign-in to ${meta.name} failed. Save the right login first.`, status: 400 };
  await ex('UPDATE "PortalCredential" SET "enabled" = ?, "updatedBy" = ?, "updatedAt" = ? WHERE "portal" = ? AND "accountLabel" = ?', on ? 1 : 0, user ? user.id : null, Date.now(), portal, LABEL);
  await audit(user, `Portal switch ${on ? 'ON' : 'OFF'}`, portal, `Automatic posting to ${meta.name} switched ${on ? 'ON' : 'OFF'}`);
  return { ok: true, credential: await one(portal) };
}

// Remove the saved login (the limits stay). Posting to that portal stops.
async function remove(portal, user) {
  const meta = C.PORTALS[portal];
  if (!meta) return { error: 'Unknown portal', status: 404 };
  if (!['browser', 'api'].includes(meta.kind)) return { error: 'There is no saved login for this portal.', status: 400 };
  const row = await rowOf(portal);
  if (!row) return { ok: true, credential: await one(portal) };
  await ex('UPDATE "PortalCredential" SET "usernameEnc" = NULL, "passwordEnc" = NULL, "secretEnc" = NULL, "status" = \'DISABLED\', "enabled" = 0, "lastError" = NULL, "lastVerifiedAt" = NULL, "updatedBy" = ?, "updatedAt" = ? WHERE "id" = ?', user ? user.id : null, Date.now(), row.id);
  await audit(user, 'Portal credential removed', portal, 'Saved login removed and automatic posting switched OFF');
  return { ok: true, credential: await one(portal) };
}

// The worker records what a sign-in showed. `status`: CONNECTED | FAILED | NEEDS_HUMAN
async function recordCheck(portal, status, error = null) {
  const now = Date.now();
  await ex(
    'UPDATE "PortalCredential" SET "status" = ?, "lastError" = ?, "lastVerifiedAt" = CASE WHEN ? = \'CONNECTED\' THEN ? ELSE "lastVerifiedAt" END, "updatedAt" = ? WHERE "portal" = ? AND "accountLabel" = ?',
    status, error ? String(error).slice(0, 300) : null, status, now, now, portal, LABEL,
  );
}

// Test / verify: a login-only run, queued for the worker (nothing is posted).
async function requestVerify(portal, user) {
  const meta = C.PORTALS[portal];
  if (!meta) return { error: 'Unknown portal', status: 404 };
  if (meta.kind === 'api') return verifyApi(portal, user);
  if (meta.kind !== 'browser') return { error: meta.kind === 'manual' ? `${meta.name} is manual only: there is no sign-in to test.` : `${meta.name} needs no sign-in.`, status: 400 };
  const cred = await read(portal);
  if (!cred.ok) return { error: cred.code === 'NO_SECRET_KEY' ? NO_SECRET_KEY_MESSAGE : `Save the ${meta.name} login first.`, status: 400 };
  const out = await Q.enqueue({ requirementId: null, portal, action: 'VERIFY', payloadHash: 'verify', requestedBy: user ? user.id : null, requestedByName: user ? user.name : null, maxAttempts: 1 });
  if (out.created) await S.setLastTest(portal, { state: 'TESTING', code: null, reason: null });
  await audit(user, 'Portal login check requested', portal, out.created ? 'Login check queued' : 'A login check is already waiting');
  return { ok: true, queued: out.created, duplicate: out.duplicate, entry: out.entry, worker: await S.workerState() };
}

// ---- Telegram / Facebook: Test connection runs here at once (a read-only call to the official API; NOTHING is posted)
const quiet = { info: async () => {}, warn: async () => {}, error: async () => {}, addSecret() {} };
async function apiAdapter(portal) {
  const c = await read(portal);
  if (!c.ok) return { error: c.code === 'NO_SECRET_KEY' ? NO_SECRET_KEY_MESSAGE : `Save the ${C.portalName(portal)} details first.`, status: 400 };
  return { adapter: require('../portals/registry').create(portal, { creds: { username: c.username, password: c.password }, log: quiet, ctx: {} }), cred: c }; // eslint-disable-line global-require
}
async function verifyApi(portal, user) {
  const a = await apiAdapter(portal);
  if (a.error) return a;
  let result;
  try {
    const c = await a.adapter.check();
    await recordCheck(portal, 'CONNECTED', null);
    await recordTest(portal, null, c.summary);
    result = { ok: true, state: 'CONNECTED', words: C.TEST_STATES.CONNECTED, summary: c.summary, apiStatus: c.apiStatus || null };
  } catch (e) {
    const code = (e && e.code) || 'ERROR';
    const reason = a.adapter.scrub(String((e && e.message) || 'The check did not finish.'));
    // only a token the site refused blocks posting; "not an administrator" / "channel not found" keep the token and say what to fix
    await recordCheck(portal, code === 'BAD_TOKEN' ? 'FAILED' : 'UNVERIFIED', reason);
    const state = await recordTest(portal, code, reason);
    result = { ok: false, state, code, words: C.TEST_STATES[state] || state, summary: reason, apiStatus: (e && e.apiStatus) || null };
  }
  await audit(user, 'Portal connection tested', portal, `${result.ok ? 'Connected' : result.state}: nothing was posted`);
  return { ok: true, inline: true, result, credential: await one(portal) };
}
// A separate, explicit button: ONE real test message to the channel. Only while the channel is switched ON.
async function sendTestPost(portal, user) {
  const meta = C.PORTALS[portal];
  if (!meta || meta.kind !== 'api') return { error: 'This place has no test post.', status: 400 };
  const row = await rowOf(portal);
  if (!row || !row.enabled) return { error: `Posting to ${meta.name} is switched off. An Admin switches it on first, then the test post can be sent.`, status: 409 };
  const ks = await S.killState(portal);
  if (ks.stopped) return { error: `${ks.reason}. Nothing was sent.`, status: 409 };
  const a = await apiAdapter(portal);
  if (a.error) return a;
  try {
    const r = await a.adapter.testPost('Test message from TeamLink. The connection works. You can delete this message.');
    await audit(user, 'Test post sent', portal, `message ${r.id}`);
    return { ok: true, sent: true, id: String(r.id), summary: `A test message was posted to ${meta.name}. You can delete it there.` };
  } catch (e) {
    const code = (e && e.code) || 'ERROR';
    const reason = a.adapter.scrub(String((e && e.message) || 'The test post did not go through.'));
    await audit(user, 'Test post failed', portal, `${code}`);
    return { ok: false, code, error: reason, apiStatus: (e && e.apiStatus) || null, status: 200 };
  }
}

module.exports = {
  sendTestPost, validateApiLogin, API_FIELDS,
  list, one, posterView, read, save, setEnabled, remove, recordCheck, requestVerify, maskUser, STATUS_WORDS, LABEL, validateLogin, lastTestOf, recordTest,
};
