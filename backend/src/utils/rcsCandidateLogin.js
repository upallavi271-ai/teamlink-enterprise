// ---------------------------------------------------------------------------
// THE CANDIDATE LOGIN BY RCS (founder 2026-11-10: an automatic RCS "Candidate Login Credentials" message right after a Job Portal account is
// made, with candidate_name, candidate_id, login_id, temporary_password and login_url; only approved templates, through rcssms.in; Sent /
// Delivered / Failed with the reason, history, retry, a manual Resend with permissions, never twice for one account event, no password
// stored in plain text).
//
// WHERE IT STARTS. The Job Portal makes the account and the temporary password itself (its notify/invite.js: invitation, resend, Naukri /
// Shine intake, Forgot password with no login yet). Every message that carries a NEW password goes out through the portal's SMS provider,
// which the TeamLink add-on wraps (job-portal-app/embed/rcs-login.mjs). That wrapper hands the login here, server to server with the bridge
// secret (POST /api/public/job-portal/rcs-login). The password is the portal's temporary one: the candidate must change it at the first
// sign-in.
//
// WHAT IS KEPT.
//   rcs_message_logs   one row per login message (module ATS, request_ref "login:<key>"): the number, the template, the msgid, Sent ->
//                      Delivered (rcssms.in's report, routes/rcsWebhook.js) | Failed with rcssms.in's reason. The blanks are saved with the
//                      password replaced by dots - the row NEVER holds the password.
//   app_settings       rcs.loginSeal.<row id>: the password ENCRYPTED (AES-256-GCM, INTEGRATION_SECRET_KEY, utils/secrets.js) for 48 hours,
//                      only so a failed message can be tried again with the SAME password (which is the one that works). Removed as soon
//                      as the message is delivered, and after 48 hours in any case. No key on the server = no seal: Retry then asks for
//                      "Resend new login" instead.
//   <key>              an HMAC of number + login + password (the bridge secret): the same account event is never sent twice, and the key
//                      cannot be turned back into the password.
//
// SETTINGS (Administration > Integrations > RCS > Candidate login, Admin): ON / OFF, which APPROVED template, and which blank (var1 ...)
// carries which value. Nothing is sent until an Administrator chose a template and rcssms.in approved it.
// Who is never sent: do-not-contact, consent withdrawn, Not Interested on the recruiter's sheet (utils/candidateLogins.js rule), STOP.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const rcs = require('./rcsService');
const secrets = require('./secrets');

const SETTINGS_KEY = 'rcs.candidateLogin';
const SEAL_PREFIX = 'rcs.loginSeal.';
const REF_PREFIX = 'login:';
const SEAL_HOURS = 48;
const MAX_AUTO_TRIES = 3;
const AUTO_RETRY_AFTER_MS = 10 * 60 * 1000;
const DOTS = '••••••';
const FIELDS = ['candidate_name', 'candidate_id', 'login_id', 'temporary_password', 'login_url'];
const FIELD_WORD = {
  candidate_name: 'Candidate name', candidate_id: 'Candidate ID', login_id: 'Login ID', temporary_password: 'Temporary password', login_url: 'Login link',
};
const DEFAULT_MAP = { candidate_name: 'var1', candidate_id: 'var2', login_id: 'var3', temporary_password: 'var4', login_url: 'var5' };
// The ready-made template (BASIC). rcssms.in writes its blanks as {#var1#}.
const READY_TEMPLATE = {
  cname: 'candidate_login_credentials',
  description: 'Hi {#var1#}, your TeamLink candidate account is ready. Candidate ID: {#var2#}. Login ID: {#var3#}. '
    + 'Temporary password: {#var4#}. Sign in: {#var5#} - please choose a new password at your first sign-in. Do not share this password with anyone.',
};
const BY = 'Job Portal (automatic)';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const getSetting = (key) => prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
const putSetting = (key, value) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
const mask = (n) => { const d = String(n || '').replace(/\D/g, ''); return d ? `xxxxxx${d.slice(-4)}` : '-'; };
const candidateCode = (id) => `CAN-${String(id || '').slice(-8).toUpperCase()}`;

function cleanMap(m) {
  const out = {};
  const used = new Set();
  FIELDS.forEach((f) => {
    const v = String((m && m[f]) || '').toLowerCase().trim();
    if (/^var\d{1,2}$/.test(v) && !used.has(v)) { out[f] = v; used.add(v); }
  });
  return out;
}

async function settings() {
  const v = parse((await getSetting(SETTINGS_KEY) || {}).value, {});
  return {
    on: v.on !== false,
    templateRowId: v.templateRowId || null,
    map: v.map && Object.keys(cleanMap(v.map)).length ? cleanMap(v.map) : { ...DEFAULT_MAP },
    skipped: v.skipped || null, // { at, reason, count } - the last time a login was NOT sent by RCS, and how often since the reason began
    changedBy: v.changedBy || null,
    changedAt: v.changedAt || null,
  };
}
async function saveSettings(patch, user) {
  const s = await settings();
  const next = { ...s };
  if (patch.on !== undefined) next.on = !!patch.on;
  if (patch.templateRowId !== undefined) next.templateRowId = patch.templateRowId ? String(patch.templateRowId) : null;
  if (patch.map !== undefined) next.map = cleanMap(patch.map);
  if (patch.skipped !== undefined) next.skipped = patch.skipped;
  if (user) { next.changedBy = user.name || user.id; next.changedAt = new Date().toISOString(); }
  await putSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
// "Not sent by RCS" is remembered as one line with a count (not a row per candidate): the Admin sees why at a glance.
async function noteSkip(reason) {
  const s = await settings();
  const same = s.skipped && s.skipped.reason === reason;
  await saveSettings({ skipped: { at: new Date().toISOString(), reason, count: same ? (Number(s.skipped.count) || 0) + 1 : 1 } }).catch(() => {});
}

// The template as the sender needs it. -> { tpl, row } | { error }
async function chosenTemplate(s) {
  if (!s.templateRowId) return { error: 'No RCS template is chosen for the candidate login yet (Integrations > RCS > Candidate login).' };
  const row = await prisma.rcsTemplate.findUnique({ where: { id: s.templateRowId } }).catch(() => null);
  if (!row) return { error: 'The chosen RCS login template was removed: choose another one.' };
  if (row.status !== 'APPROVED') return { error: `The RCS login template "${row.name}" is ${row.status === 'REJECTED' ? 'rejected by rcssms.in' : 'still waiting for rcssms.in approval'}.` };
  return { row };
}

function keyOf(msisdn, login, password) {
  const secret = process.env.JOB_PORTAL_PUSH_SECRET || process.env.INTEGRATION_SECRET_KEY || 'teamlink-rcs-login';
  return crypto.createHmac('sha256', secret).update(`${msisdn}|${String(login).toLowerCase()}|${password}`).digest('hex').slice(0, 40);
}
function variablesFor(map, values) {
  const v = {};
  Object.entries(map).forEach(([field, slot]) => { v[slot] = String(values[field] == null || values[field] === '' ? '-' : values[field]).slice(0, 500); });
  return v;
}

async function seal(logId, password, transient) {
  let sealed;
  try { sealed = secrets.encryptSecret(password); } catch { return false; } // no INTEGRATION_SECRET_KEY: never stored at all
  await putSetting(`${SEAL_PREFIX}${logId}`, JSON.stringify({ sealed, until: new Date(Date.now() + SEAL_HOURS * 3600 * 1000).toISOString(), auto: !!transient }));
  return true;
}
async function unseal(logId) {
  const r = await getSetting(`${SEAL_PREFIX}${logId}`);
  const v = parse(r && r.value, null);
  if (!v || !v.sealed || new Date(v.until) < new Date()) return null;
  try { return { password: secrets.decryptSecret(v.sealed), auto: !!v.auto }; } catch { return null; }
}
const dropSeal = (logId) => prisma.appSetting.delete({ where: { key: `${SEAL_PREFIX}${logId}` } }).catch(() => {});

// Who is this number in TeamLink (for the Candidate ID and the never-contact rules)? The newest candidate with these 10 digits.
async function candidateByNumber(msisdn) {
  const ten = String(msisdn).slice(-10);
  const rows = await prisma.candidate.findMany({
    where: { phone: { contains: ten } }, orderBy: { createdAt: 'desc' }, take: 5,
    select: { id: true, name: true, phone: true, email: true, doNotContact: true, consentStatus: true, interestStatus: true },
  }).catch(() => []);
  return rows.find((c) => String(c.phone || '').replace(/\D/g, '').slice(-10) === ten) || null;
}

// One message out, on an existing log row. -> { ok, msgId, error, errorCode, transient }
async function deliver(row, tplRow, variables) {
  const r = await rcs.sendChunk({ rcstype: tplRow.rcsType, templateid: tplRow.templateId, numbers: [row.msisdn], variables: [variables] });
  const msgId = r.ok ? rcs.idsByNumber([row.msisdn], r.items).get(row.msisdn) : null;
  await prisma.rcsMessageLog.update({
    where: { id: row.id },
    data: msgId
      ? { status: 'sent', msgId, sentAt: new Date(), attempts: { increment: 1 }, errorCode: null, errorText: null }
      : { status: 'failed', attempts: { increment: 1 }, errorCode: String(r.errorCode || 'NO_ID').slice(0, 20), errorText: String(r.error || 'rcssms.in did not confirm this number.').slice(0, 500) },
  });
  return { ok: !!msgId, msgId, error: msgId ? null : (r.error || 'rcssms.in did not confirm this number.'), errorCode: msgId ? null : (r.errorCode || 'NO_ID'), transient: !msgId && !!r.transient };
}

const inFlight = new Set();

// THE AUTOMATIC SEND (from the portal's SMS wrapper). Never throws.
//   in:  { to, vars: { candidate_name, login_email, temporary_password, portal_link } }
//   out: { ok, status: sent | failed | duplicate | off | skipped, msgId?, reason? }
async function sendLogin({ to, vars } = {}) {
  try {
    const v = vars || {};
    const password = String(v.temporary_password || '');
    const login = String(v.login_email || '').trim();
    if (!password || !login) return { ok: false, status: 'skipped', reason: 'not a login message' };
    const s = await settings();
    if (!s.on) return { ok: false, status: 'off', reason: 'The RCS candidate login is switched off.' };
    const n = rcs.normalizeNumber(to);
    if (!n.ok) return { ok: false, status: 'skipped', reason: n.reason };
    const t = await chosenTemplate(s);
    if (t.error) { await noteSkip(t.error); return { ok: false, status: 'skipped', reason: t.error }; }
    const cfg = rcs.config();
    if (!cfg.configured) { const why = `RCS is not set up on the server: ${cfg.reason}`; await noteSkip(why); return { ok: false, status: 'skipped', reason: why }; }
    const who = await candidateByNumber(n.msisdn);
    if (who && who.doNotContact) return { ok: false, status: 'skipped', reason: 'Asked not to be contacted' };
    if (who && who.consentStatus === 'WITHDRAWN') return { ok: false, status: 'skipped', reason: 'Consent withdrawn' };
    if (who && who.interestStatus && who.interestStatus !== 'INTERESTED') return { ok: false, status: 'skipped', reason: 'Not Interested on the recruiter\'s sheet' };
    const delivery = require('./messageDelivery'); // eslint-disable-line global-require
    if (await delivery.optedOut('RCS', n.msisdn)) return { ok: false, status: 'skipped', reason: 'They replied STOP' };

    const key = keyOf(n.msisdn, login, password);
    const ref = `${REF_PREFIX}${key}`;
    if (inFlight.has(key)) return { ok: false, status: 'duplicate', reason: 'This login is being sent right now.' };
    const before = await prisma.rcsMessageLog.findFirst({ where: { requestRef: ref } });
    if (before) return { ok: before.status === 'sent' || before.status === 'delivered', status: 'duplicate', msgId: before.msgId || null, reason: 'This login was already sent by RCS.' };
    inFlight.add(key);
    try {
      const name = String(v.candidate_name || v.to_name || (who && who.name) || '').trim();
      const values = {
        candidate_name: name.split(/\s+/)[0] || name || 'Candidate',
        candidate_id: who ? candidateCode(who.id) : '-',
        login_id: login,
        temporary_password: password,
        login_url: String(v.portal_link || '').trim() || '-',
      };
      const variables = variablesFor(s.map, values);
      const shown = variablesFor(s.map, { ...values, temporary_password: DOTS });
      const row = await prisma.rcsMessageLog.create({
        data: {
          module: 'ATS', entityId: who ? who.id : null, personName: name || null, msisdn: n.msisdn, templateId: t.row.templateId, rcsType: t.row.rcsType,
          variablesJson: JSON.stringify([shown]), requestRef: ref, sentByName: BY,
          // the portal sends its own login SMS, so the RCS SMS fallback is never used for these
          fallbackStatus: 'skipped', fallbackError: 'Not used for logins: the Job Portal sends its own login SMS.', fallbackAt: new Date(),
        },
      });
      const out = await deliver(row, t.row, variables);
      // kept (encrypted) also after "Sent": rcssms.in's report may still say Failed, and Retry needs the same password
      await seal(row.id, password, out.transient);
      if (s.skipped) await saveSettings({ skipped: null }).catch(() => {});
      return { ok: out.ok, status: out.ok ? 'sent' : 'failed', msgId: out.msgId || null, logId: row.id, reason: out.error || undefined };
    } finally { inFlight.delete(key); }
  } catch (err) {
    return { ok: false, status: 'failed', reason: String((err && err.message) || err).slice(0, 200) };
  }
}

const isLoginRow = (row) => !!row && String(row.requestRef || '').startsWith(REF_PREFIX);

// TRY AGAIN with the SAME password (it is the one that works). -> { ok, error?, msgId? }
async function retry(logId, { auto = false } = {}) {
  const row = await prisma.rcsMessageLog.findUnique({ where: { id: String(logId) } });
  if (!isLoginRow(row)) return { ok: false, status: 404, error: 'Not a candidate login message.' };
  if (row.status !== 'failed') return { ok: false, status: 409, error: `This message is ${row.status}, not failed.` };
  const newer = await prisma.rcsMessageLog.findFirst({ where: { msisdn: row.msisdn, requestRef: { startsWith: REF_PREFIX }, createdAt: { gt: row.createdAt } }, select: { id: true } });
  if (newer) { await dropSeal(row.id); return { ok: false, status: 409, error: 'A newer login was made for this number after this one, so this password no longer works. Nothing sent.' }; }
  const kept = await unseal(row.id);
  if (!kept) return { ok: false, status: 409, error: 'The password of this message is no longer kept (48 hours passed, or the server has no INTEGRATION_SECRET_KEY). Use "Resend new login": it makes a new temporary password.' };
  const s = await settings();
  const t = await chosenTemplate(s);
  if (t.error) return { ok: false, status: 409, error: t.error };
  if (!rcs.config().configured) return { ok: false, status: 409, error: `RCS is not set up on the server: ${rcs.config().reason}` };
  const shown = parse(row.variablesJson, [{}])[0] || {};
  const slot = s.map.temporary_password;
  if (!slot || shown[slot] !== DOTS) return { ok: false, status: 409, error: 'The blanks of the login template were changed since this message: use "Resend new login".' };
  const variables = { ...shown, [slot]: kept.password };
  const out = await deliver(row, t.row, variables);
  // a refusal that is not "could not reach rcssms.in" is not tried again by itself (a person can still press Retry)
  if (!out.ok && !out.transient && auto) await putSetting(`${SEAL_PREFIX}${row.id}`, JSON.stringify({ ...parse((await getSetting(`${SEAL_PREFIX}${row.id}`) || {}).value, {}), auto: false }));
  return out.ok ? { ok: true, msgId: out.msgId } : { ok: false, status: 422, error: out.error, errorCode: out.errorCode };
}

// The 10-minute pass: a message that failed because rcssms.in could not be reached is tried again (3 times in all); seals of delivered or
// old messages are removed. Never throws.
async function sweep() {
  try {
    const seals = await prisma.appSetting.findMany({ where: { key: { startsWith: SEAL_PREFIX } }, take: 500 });
    let retried = 0;
    for (const sRow of seals) {
      const id = sRow.key.slice(SEAL_PREFIX.length);
      const v = parse(sRow.value, {});
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.rcsMessageLog.findUnique({ where: { id }, select: { id: true, status: true, attempts: true, updatedAt: true } });
      // eslint-disable-next-line no-await-in-loop
      if (!row || row.status === 'delivered' || new Date(v.until) < new Date()) { await dropSeal(id); continue; } // eslint-disable-line no-continue
      if (v.auto && row.status === 'failed' && row.attempts < MAX_AUTO_TRIES && Date.now() - new Date(row.updatedAt).getTime() >= AUTO_RETRY_AFTER_MS) {
        // eslint-disable-next-line no-await-in-loop
        await retry(id, { auto: true });
        retried += 1;
      }
    }
    return { seals: seals.length, retried };
  } catch (err) { return { error: String((err && err.message) || err).slice(0, 200) }; }
}

// RESEND NEW LOGIN: the portal's own "resend credentials" makes a NEW temporary password and sends it (RCS, SMS, WhatsApp, email); the
// old one stops working only after a message really left (the portal's rule). -> { ok, result, error? }
async function resend(logId) {
  const row = await prisma.rcsMessageLog.findUnique({ where: { id: String(logId) } });
  if (!isLoginRow(row)) return { ok: false, status: 404, error: 'Not a candidate login message.' };
  const who = row.entityId ? await prisma.candidate.findUnique({ where: { id: row.entityId }, select: { id: true, name: true, email: true, phone: true, doNotContact: true } }).catch(() => null) : null;
  if (who && who.doNotContact) return { ok: false, status: 409, error: 'This candidate asked not to be contacted.' };
  const person = { ref: who ? who.id : row.id, name: (who && who.name) || row.personName || 'Candidate', email: (who && who.email) || undefined, phone: (who && who.phone) || row.msisdn.slice(-10), resend: true };
  const bridge = require('./jobPortalBridge'); // eslint-disable-line global-require
  let out;
  try { out = await bridge.portalFetch('/integrations/teamlink/candidates/invite', { method: 'POST', body: { people: [person], dryRun: false }, timeoutMs: 120000 }); } catch (err) {
    return { ok: false, status: 422, error: `The Job Portal could not be reached: ${String((err && err.message) || err).slice(0, 160)}` };
  }
  const r = (out && out.results && out.results[0]) || {};
  if (r.result === 'invited') return { ok: true, result: r.result, delivery: r.delivery || null };
  const words = { 'not-sent': 'the Job Portal could not send any message, so the old password still works', 'do-not-contact': 'the candidate asked not to be contacted', 'no-contact': 'no email or mobile number', already: 'the portal already sent a login today', 'retry-later': 'the portal tried today already: try again tomorrow', 'has-login': 'the candidate already signed in with their own password' };
  return { ok: false, status: 422, result: r.result || null, error: `Not resent: ${words[r.result] || r.reason || 'the Job Portal did not say why'}.` };
}

// The ready-made template, sent to rcssms.in for approval and chosen for the login. -> { ok, row } | { ok:false, error }
async function makeReadyTemplate(user) {
  const r = await rcs.createTemplate('BASIC', READY_TEMPLATE);
  if (!r.ok) return { ok: false, error: r.error, errorCode: r.errorCode || null, invalid: !!r.invalid };
  const body = { ...r.fields, source: 'teamlink', varCount: 5, promotional: false, purpose: 'candidate-login' };
  const row = await prisma.rcsTemplate.upsert({
    where: { templateId: r.templateid },
    create: { templateId: r.templateid, name: r.fields.cname, rcsType: 'BASIC', bodyJson: JSON.stringify(body), status: r.status, module: 'ATS', createdById: user ? user.id : null },
    update: { name: r.fields.cname, rcsType: 'BASIC', bodyJson: JSON.stringify(body), status: r.status, module: 'ATS' },
  });
  await saveSettings({ templateRowId: row.id, map: DEFAULT_MAP }, user);
  return { ok: true, row };
}

// For the screen.
const WORD = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', failed: 'Failed' };
async function history({ status, page = 1, size = 25 } = {}) {
  const where = { requestRef: { startsWith: REF_PREFIX } };
  if (status) where.status = String(status);
  const take = Math.min(100, Math.max(5, Number(size) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const [total, rows, g] = await Promise.all([
    prisma.rcsMessageLog.count({ where }),
    prisma.rcsMessageLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.rcsMessageLog.groupBy({ by: ['status'], where: { requestRef: { startsWith: REF_PREFIX } }, _count: { _all: true } }),
  ]);
  const kept = new Set((await prisma.appSetting.findMany({ where: { key: { in: rows.map((r) => `${SEAL_PREFIX}${r.id}`) } }, select: { key: true } })).map((k) => k.key.slice(SEAL_PREFIX.length)));
  return {
    total, page: Math.max(1, Number(page) || 1), size: take,
    counts: Object.fromEntries(g.map((x) => [WORD[x.status] || x.status, x._count._all])),
    rows: rows.map((l) => ({
      id: l.id, at: l.createdAt, person: l.personName, candidateId: l.entityId ? candidateCode(l.entityId) : null, number: mask(l.msisdn), templateId: l.templateId,
      status: WORD[l.status] || l.status, msgId: l.msgId, errorCode: l.errorCode, error: l.errorText, attempts: l.attempts, sentAt: l.sentAt, deliveredAt: l.deliveredAt,
      canRetry: l.status === 'failed' && kept.has(l.id),
    })),
  };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || require('./sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(() => { sweep().catch(() => {}); }, AUTO_RETRY_AFTER_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  SETTINGS_KEY, SEAL_PREFIX, REF_PREFIX, FIELDS, FIELD_WORD, DEFAULT_MAP, READY_TEMPLATE, DOTS,
  settings, saveSettings, sendLogin, retry, resend, sweep, history, makeReadyTemplate, chosenTemplate, cleanMap, keyOf, start,
};
