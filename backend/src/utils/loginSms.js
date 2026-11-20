// ---------------------------------------------------------------------------
// THE CANDIDATE LOGIN SMS (2026-11-20): the approved DLT template "TeamLink Job Portal login credentials" (Administration > Integrations > SMS
// Gateway > SMS Push Platform: DLT Template ID - Candidate login, and its text word for word). Variable 1 = the candidate's login ID, variable 2 =
// their own password setup link (made by the portal, embed/login-sms.mjs). It leaves through the EXISTING SMS Push integration (utils/smsGateway.js
// sendSms): same credentials, same sender id, same "proven by a real test SMS" rule, same Pull DLR check. No second integration.
//
//   sendLoginSms({ to, loginId, url })  -> { ok, status: 'sent' | 'duplicate' | 'off' | 'failed', providerRef?, reason? }
//
// DUPLICATES: one login SMS per number and login ID in 24 hours (a retry of the same invitation, or the same invitation sent twice, is
// answered "duplicate" and nothing leaves). Kept in the Integration table as an internal row (no schema change), PII-light: a short hash of the
// number + login ID and the provider's ackid, never the link.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const gw = require('./smsGateway');

const STORE_ID = 'login-sms-sent';
const WINDOW_MS = 24 * 3600 * 1000;
const KEEP = 5000;
const hashOf = (to, loginId) => crypto.createHash('sha256').update(`${String(to).replace(/\D/g, '').slice(-10)}|${String(loginId).toLowerCase()}`).digest('hex').slice(0, 24);

async function readLog() {
  const row = await prisma.integration.findUnique({ where: { id: STORE_ID } }).catch(() => null);
  try { return row && row.values ? JSON.parse(row.values) : {}; } catch { return {}; }
}
async function writeLog(map) {
  const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  const values = JSON.stringify(Object.fromEntries(entries));
  await prisma.integration.upsert({ where: { id: STORE_ID }, create: { id: STORE_ID, enabled: true, state: 'Internal', values }, update: { values } });
}

let chain = Promise.resolve(); // one at a time: two invitations of one person cannot both pass the duplicate check
function sendLoginSms(args) {
  const run = chain.then(() => sendOne(args), () => sendOne(args));
  chain = run.catch(() => {});
  return run;
}

async function sendOne({ to, loginId, url, send = gw.sendSms }) {
  const cfg = await gw.smsConfig();
  if (!cfg.configured) return { ok: false, status: 'off', reason: cfg.reason || 'The SMS Gateway is not configured.' };
  if (cfg.provider !== 'SMSGW') return { ok: false, status: 'off', reason: 'The candidate login template is for the SMS Push Platform; it is not the chosen provider.' };
  const text = gw.loginText(cfg, loginId, url);
  if (!text) return { ok: false, status: 'off', reason: 'The candidate login template id and its approved text (with {login_id} and {url}) are not saved yet: Administration > Integrations > SMS Gateway.' };
  const key = hashOf(to, loginId);
  const log = await readLog();
  if (log[key] && Date.now() - log[key].at < WINDOW_MS) return { ok: true, status: 'duplicate', providerRef: log[key].ref || null, reason: 'A login SMS went to this number for this login ID in the last 24 hours.' };
  const out = await send({ to, kind: 'login', text, templateId: cfg.templates.login });
  if (!out || !out.ok) return { ok: false, status: out && out.notConfigured ? 'off' : 'failed', transient: !!(out && out.transient), reason: String((out && out.error) || 'The SMS was not accepted.').slice(0, 300) };
  log[key] = { at: Date.now(), ref: out.providerRef || null };
  await writeLog(log).catch(() => {});
  return { ok: true, status: 'sent', providerRef: out.providerRef || null, provider: out.provider || 'SMSGW' };
}

module.exports = { sendLoginSms, sendOne, hashOf };
