// ---------------------------------------------------------------------------
// AI MARKETING: ONE REMINDER, 24 HOURS AFTER A LINK WAS SENT (founder 2026-11-16: "send the client the link first; if they have not replied within 24 hours, send this message").
//
// When TeamLink sends a client a link to look at by WhatsApp (a client-approval link from "Send to client", or the options of a client project), schedule() writes ONE waiting reminder
// for 24 hours later. Every few minutes sweep() looks at the ones that are due and sends the reminder ONLY if all of this is still true:
//   * an Admin has not switched it off (AI usage > Telling the client) and has saved the "24-hour reminder" template there (Meta-approved; fixed words, no blanks);
//   * the link is still waiting: the client has not decided, it was not cancelled and it has not expired (a project: still "with the client");
//   * the client has not written to us on WhatsApp since the link went (a reply, a photo: then a person talks to them), and has not sent STOP;
//   * it is between 9 in the morning and 8 in the evening, India time (otherwise it waits for the morning).
// A reminder goes ONCE per link. The 24 hours have passed, so the official WhatsApp number needs the approved template: with no template saved nothing is sent and the team is told.
// Never runs in the test sandbox unless a test forces it. Nothing here can stop the step that scheduled it.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkRemind';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "refId" TEXT NOT NULL, "e164" TEXT NOT NULL, "name" TEXT, "clientName" TEXT, "sentAt" BIGINT NOT NULL, "dueAt" BIGINT NOT NULL, "status" TEXT NOT NULL DEFAULT 'waiting', "result" TEXT, "doneAt" BIGINT, "createdById" TEXT, "createdByName" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${T}_due" ON "${T}"("status", "dueAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] remind schema:', e.message); return false; } // eslint-disable-line no-console, no-await-in-loop
}

const HOUR = 3600000;
const AFTER = 24 * HOUR;
const clip = (v, n) => S.clip(v, n);
const tail = (x) => String(x || '').replace(/\D/g, '').slice(-10);
// is it between 9:00 and 20:00 in India (UTC+5:30)?
const istHour = (ms) => new Date(ms + 330 * 60000).getUTCHours();
const inHours = (ms) => { const h = istHour(ms); return h >= 9 && h < 20; };

// kind: 'review' (a client-approval link) | 'project' (the options of a client project); refId = its id; phone = the number the link went to
async function schedule({ kind, refId, phone, name = '', clientName = '', by = null, now = Date.now() } = {}) {
  try {
    if (!['review', 'project'].includes(kind) || !refId) return null;
    const nm = require('../utils/messagingCore').normalizeMobile(phone); // eslint-disable-line global-require
    if (!nm.ok || !(await ensure())) return null;
    await S.run(`UPDATE "${T}" SET status = 'replaced', doneAt = ? WHERE kind = ? AND refId = ? AND status = 'waiting'`, now, kind, String(refId)); // one waiting reminder per link: a new send restarts the 24 hours
    const id = S.newId('rm');
    await S.run(`INSERT INTO "${T}" (id, kind, refId, e164, name, clientName, sentAt, dueAt, status, createdById, createdByName) VALUES (?,?,?,?,?,?,?,?,'waiting',?,?)`, id, kind, String(refId), nm.e164, clip(name, 80) || null, clip(clientName, 120) || null, now, now + AFTER, (by && by.id) || null, (by && clip(by.name, 80)) || null);
    return id;
  } catch (e) { console.error('[omni-mk] remind schedule:', e && e.message); return null; } // eslint-disable-line no-console
}

// has the person written to us on WhatsApp since `since`?
async function wroteSince(e164, since) {
  const t = tail(e164);
  const asks = [
    ['SELECT 1 AS x FROM "OmniWaMessage" WHERE e164 = ? AND direction = \'IN\' AND at > ? LIMIT 1', [e164, since]],
    ['SELECT 1 AS x FROM "ConversationMessage" WHERE channel = \'WhatsApp\' AND direction = \'IN\' AND address LIKE ? AND createdAt > ? LIMIT 1', [`%${t}`, since]],
    ['SELECT 1 AS x FROM "OmniMkClientChat" WHERE e164 = ? AND dir = \'in\' AND at > ? LIMIT 1', [e164, since]],
  ];
  for (const [sql, args] of asks) {
    try { if ((await S.q(sql, ...args)).length) return true; } catch { /* that table may not exist yet */ } // eslint-disable-line no-await-in-loop
  }
  return false;
}

// -> { open: true, who: <row for the team's bell>, projectId? } | { open: false, why }
async function stateOf(row, now) {
  if (row.kind === 'review') {
    const r = (await S.q('SELECT * FROM "OmniMkClientReview" WHERE id = ?', row.refId))[0];
    if (!r || r.deletedAt) return { open: false, why: 'the link is gone' };
    if (r.status !== 'sent') return { open: false, why: r.status === 'revoked' ? 'the link was cancelled' : 'the client has answered' };
    if (S.num(r.expiresAt) < now) return { open: false, why: 'the link has expired' };
    return { open: true, who: r };
  }
  const p = (await S.q('SELECT * FROM "OmniMkProject" WHERE id = ?', row.refId))[0];
  if (!p || p.deletedAt) return { open: false, why: 'the project is gone' };
  if (p.status !== 'awaiting_client') return { open: false, why: 'the client has answered, or the options are no longer with them' };
  if (S.num(p.linkExpiresAt) < now) return { open: false, why: 'the link has expired' };
  return { open: true, who: p, projectId: p.id };
}

async function finish(row, status, result, now) {
  await S.run(`UPDATE "${T}" SET status = ?, result = ?, doneAt = ? WHERE id = ?`, status, clip(result, 300), now, row.id);
}

async function one(row, set, now) {
  const P = require('./projects'); // eslint-disable-line global-require
  const cn = set.clientNotify || {};
  if (cn.remind === false) return finish(row, 'skipped', 'switched off', now).then(() => 'skipped');
  const st = await stateOf(row, now);
  if (!st.open) { await finish(row, 'skipped', st.why, now); return 'skipped'; }
  if (await wroteSince(row.e164, Number(row.sentAt))) { await finish(row, 'skipped', 'the client wrote to us: a person is talking to them', now); return 'skipped'; }
  try { if (await require('../utils/messageDelivery').optedOut('WhatsApp', row.e164)) { await finish(row, 'skipped', 'the client sent STOP', now); return 'skipped'; } } catch { /* the list is optional */ } // eslint-disable-line global-require
  const tpl = require('./waTemplates').payload(set.waTemplates, 'reminder', {}); // eslint-disable-line global-require
  if (!tpl) {
    await finish(row, 'skipped', 'no reminder template is saved', now);
    await P.tellTeam(st.who, `A reminder to ${row.clientName || 'a client'} was due but not sent`, 'Save the "24-hour reminder" template (AI usage > Telling the client > WhatsApp templates) so reminders can go.').catch(() => {});
    return 'skipped';
  }
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const meta = { audience: 'client', personName: clip(row.name || row.clientName, 80), purpose: 'AI Marketing: 24-hour reminder', module: 'AI Marketing', automatic: true, template: tpl.template.name };
  const text = require('./waTemplates').KINDS.reminder.body; // eslint-disable-line global-require
  const res = await messaging.send('WhatsApp', { to: row.e164, kind: 'text', text, template: tpl.template, vars: tpl.vars, meta });
  const ok = !!(res && res.ok);
  const why = ok ? '' : clip(String((res && res.error) || 'The sender refused it.').replace(/(\+?\d[\d\s-]{8,}\d)/g, 'a number'), 200);
  await finish(row, ok ? 'sent' : 'failed', ok ? 'sent' : why, now);
  if (st.projectId) await P.event(st.projectId, ok ? 'told' : 'told_failed', 'TeamLink', ok ? 'Reminded the client by WhatsApp (24 hours without an answer, approved template)' : `The 24-hour reminder could not be sent: ${why}`).catch(() => {});
  await logAudit({ userId: row.createdById || null, actorName: 'TeamLink (automatic)', action: ok ? 'Omni-Channel AI Marketing: 24-hour reminder sent to a client' : 'Omni-Channel AI Marketing: 24-hour reminder failed', entity: T, entityId: row.id, toValue: `${row.clientName || ''} (${row.kind}): ${ok ? 'sent' : why}` }).catch(() => {});
  if (!ok) await P.tellTeam(st.who, `The reminder to ${row.clientName || 'a client'} could not be sent`, `${why} Send them a message yourself.`).catch(() => {});
  return ok ? 'sent' : 'failed';
}

// the reminders that are due. opts.force: also in the test sandbox. -> { sent, skipped, failed, waiting }
async function sweep(now = Date.now(), opts = {}) {
  const out = { sent: 0, skipped: 0, failed: 0, waiting: 0 };
  try {
    if (!opts.force && require('../utils/sandbox').isSandbox()) return { ...out, sandbox: true }; // eslint-disable-line global-require
    if (!(await ensure())) return out;
    const rows = await S.q(`SELECT * FROM "${T}" WHERE status = 'waiting' AND dueAt <= ? ORDER BY dueAt ASC LIMIT 40`, now);
    if (!rows.length) return out;
    if (!inHours(now)) return { ...out, waiting: rows.length, night: true }; // they wait for the morning
    const set = await Cfg.getSettings();
    for (const row of rows) { // eslint-disable-line no-restricted-syntax
      try { const r = await one(row, set, now); out[r] += 1; } catch (e) { console.error('[omni-mk] remind one:', e && e.message); } // eslint-disable-line no-console, no-await-in-loop
    }
  } catch (e) { console.error('[omni-mk] remind sweep:', e && e.message); } // eslint-disable-line no-console
  return out;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { sweep().catch(() => {}); }, 10 * 60000);
  if (timer.unref) timer.unref();
}

module.exports = { schedule, sweep, start, ensure, AFTER, inHours };
