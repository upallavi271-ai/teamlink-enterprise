// ---------------------------------------------------------------------------
// PROOF REMINDER - DAILY WHATSAPP AND E-MAIL TO THE ACCOUNTANT (user, 2026-10-14).
//
// THE MODULE IS NOT NEW. "Proof reminder" is section 2 of Accounts -> Dashboard
// (utils/accountsControl.js buildControl().proof): every paid / received record whose
// proof document is missing. It has no table of its own - a record is "pending" while
// buildControl says its proof is missing, and stops being pending the moment the proof
// is attached (or the bank line is matched). This file only ADDS the automatic part:
//
//   * the two daily rounds - morning at 09:30, evening at 17:00 IST (editable; founder defaults 2026-10-21), each with a
//     catch-up window: a round missed because the server was down is sent once, up to
//     2 hours after its time (09:30 -> 11:30, 17:00 -> 19:00). Never outside the window;
//   * WhatsApp (channels layer: connected? kill switch? the QR number's daily limit?) and
//     e-mail (the existing mailer), each channel on its own - one failing never blocks
//     the other - retried up to 3 times with a back-off inside the window;
//   * ONE message per Accountant listing all their pending records (10 shown, "and N
//     more"); the records are read AT SEND TIME, so nothing is sent for a record whose
//     proof was attached since;
//   * every attempt is a row of ProofReminderRun (migration 20261014600000). Its UNIQUE
//     runKey = day | round | person | channel is the idempotency key, so two ticks or two
//     processes can never send the same reminder twice;
//   * the whole engine is ON by default (founder, 2026-10-21: it is automatic, nobody has to switch it on or press a button); an Admin can
//     switch it OFF (AppSetting proofReminders.settings -> enabled). A settings row that cannot be READ counts as OFF, never as ON.
//   * Sundays and holidays: there is NO rule, the rounds go every day while something is pending; a round with nothing pending sends nothing.
//
// WHO IS THE ACCOUNTANT - the record's own accountant (the person who recorded the payment /
// the bill's employee, as the Proof reminder already decides: who.own); a record with no
// owner goes to the configured "Who gets it" people, else the Accounts desk = the Accountants. Admin / Super Admin
// are NOT on the desk any more (founder, 2026-10-19): with no Accountant at all the record has nobody to tell, the run log
// says so, and the Admin gets ONE 'No accountant is set up' notice (utils/accountsRecipients.js). An Admin receives these only if
// the founder ticked 'Also send to the Admin' (settings.alsoAdmin) or picked that Admin under 'Who gets it'. Test logins never receive a real run.
//
// startSweep() is the same setInterval pattern as the other engines (real server only; the
// sandbox runs no timers and the tests call tick()).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');

const SETTINGS_KEY = 'proofReminders.settings';
const PLANNED_PREFIX = 'proofReminders.planned.';
const TEST_RE = /zztest|example\.test/i;
const isTest = (s) => TEST_RE.test(String(s || ''));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WINDOW_MIN = 120; // catch-up: a round may still go out up to 2 hours after its time
const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [10, 30]; // wait before attempt 2, before attempt 3
const STALE_LEASE_MS = 10 * 60000;
const LIST_CAP = 10;
const SLOTS = [{ id: 'first', key: 'time1', label: 'Morning reminder' }, { id: 'second', key: 'time2', label: 'Evening reminder' }];

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => { if (v == null) return 0; if (typeof v === 'bigint') return Number(v); if (v instanceof Date) return v.getTime(); const n = Number(v); return Number.isFinite(n) ? n : (Date.parse(v) || 0); };
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const newId = () => `prr${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;

// ---------------------------------------------------------------------------
// TIME (IST - the company's timezone)
// ---------------------------------------------------------------------------
const IST_MS = 330 * 60000;
const dayOfIst = (now) => new Date((now || new Date()).getTime() + IST_MS).toISOString().slice(0, 10);
const atIst = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const addMin = (hhmm, min) => { const t = Math.min(23 * 60 + 59, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + min); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const slotWindow = (day, time) => ({ start: atIst(day, time), end: atIst(day, addMin(time, WINDOW_MIN)) });
const niceTime = (hhmm) => { const h = Number(hhmm.slice(0, 2)); return `${h % 12 || 12}:${hhmm.slice(3)} ${h < 12 ? 'AM' : 'PM'}`; };
// Rounds whose window is open right now: [{ id, time, start, end }]
function dueSlots(now, settings) {
  const day = dayOfIst(now);
  const t = (now || new Date()).getTime();
  return SLOTS.map((s) => ({ id: s.id, label: s.label, time: settings[s.key], ...slotWindow(day, settings[s.key]) })).filter((s) => t >= s.start && t < s.end);
}

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
const DEFAULTS = { enabled: true, time1: '09:30', time2: '17:00', recipients: [], alsoAdmin: false };
function normalise(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  // A row saved under the OLD defaults (OFF, 10:00 / 17:00) and never saved since is not a choice: it is the old default written down.
  // It reads as the new defaults (ON, 09:30 / 17:00). Any save from now on is stamped defaultsVersion 2 and is a real choice.
  const oldDefaults = v.defaultsVersion !== 2 && v.enabled === false && v.time1 === '10:00' && v.time2 === '17:00';
  return {
    defaultsVersion: v.defaultsVersion === 2 ? 2 : 1,
    enabled: oldDefaults ? DEFAULTS.enabled : (v.enabled === undefined ? DEFAULTS.enabled : (v.enabled === true || v.enabled === 'true')),
    time1: oldDefaults ? DEFAULTS.time1 : (HHMM.test(String(v.time1 || '')) ? v.time1 : DEFAULTS.time1),
    time2: oldDefaults ? DEFAULTS.time2 : (HHMM.test(String(v.time2 || '')) ? v.time2 : DEFAULTS.time2),
    recipients: Array.isArray(v.recipients) ? [...new Set(v.recipients.map(String).filter(Boolean))].slice(0, 50) : [],
    alsoAdmin: v.alsoAdmin === true || v.alsoAdmin === 'true',
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
  };
}
async function getSettings() {
  // A busy database must never read as "switched on": a failed read is OFF.
  let failed = false;
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => { failed = true; return null; });
  let v = null;
  try { v = row && row.value ? JSON.parse(row.value) : null; } catch { v = null; failed = true; }
  const out = normalise(v);
  if (failed) out.enabled = false;
  return out;
}
async function saveSettings(patch, user, { allowTest = false } = {}) {
  const cur = await getSettings();
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = { ...cur };
  const err = [];
  if (p.enabled !== undefined) next.enabled = p.enabled === true || p.enabled === 'true';
  [['time1', 'Morning reminder time'], ['time2', 'Evening reminder time']].forEach(([k, label]) => {
    if (p[k] === undefined) return;
    if (!HHMM.test(String(p[k]))) err.push(`${label}: write the time like 09:30 (24-hour).`); else next[k] = String(p[k]);
  });
  if (p.alsoAdmin !== undefined) next.alsoAdmin = p.alsoAdmin === true || p.alsoAdmin === 'true';
  if (p.recipients !== undefined) {
    const ids = Array.isArray(p.recipients) ? [...new Set(p.recipients.map(String).filter(Boolean))] : [];
    const known = await candidatePeople({ allowTest });
    const okIds = new Set(known.map((u) => u.id));
    const bad = ids.filter((id) => !okIds.has(id));
    if (bad.length) err.push('Pick only people who work in Accounts (Accountant, Admin or Super Admin).'); else next.recipients = ids;
  }
  if (err.length) return { error: err.join(' ') };
  next.defaultsVersion = 2;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = user ? (user.name || user.id) : null;
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    create: { key: SETTINGS_KEY, value, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  return { settings: normalise(next), before: cur };
}

// People who can be picked as recipients: active logins with an Accounts role.
async function candidatePeople({ allowTest = false } = {}) {
  const users = await prisma.user.findMany({
    where: { status: 'Active', accountsRole: { in: ['ACCOUNTANT', 'ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true, name: true, email: true, accountsRole: true },
    orderBy: { name: 'asc' },
  });
  return users.filter((u) => allowTest || !isTest(`${u.name} ${u.email}`));
}

// ---------------------------------------------------------------------------
// THE TABLE (feature-detected, like the other raw-SQL modules)
// ---------------------------------------------------------------------------
let readyAt = 0;
let readyVal = false;
async function ready() {
  const age = Date.now() - readyAt;
  if (readyAt && age < (readyVal ? 60000 : 3000)) return readyVal;
  try {
    readyVal = (await q("SELECT name FROM sqlite_master WHERE type='table' AND name='ProofReminderRun'")).length === 1;
  } catch { readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}
function resetReady() { readyAt = 0; }

// ---------------------------------------------------------------------------
// THE PENDING RECORDS - exactly the Proof reminder list, read fresh
// ---------------------------------------------------------------------------
async function realViewer() {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const sas = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true, name: true, email: true }, orderBy: { createdAt: 'asc' }, take: 20 });
  const sa = sas.find((u) => !isTest(`${u.name} ${u.email}`)) || sas[0];
  return sa ? resolveIdentity(sa.id) : null;
}
async function defaultPending() {
  const AC = require('./accountsControl'); // eslint-disable-line global-require
  const vw = await realViewer();
  if (!vw) throw new Error('No Super Admin login to read the Accounts records with.');
  const data = await AC.buildControl(vw, { fresh: '1' });
  return (data.proof && data.proof.records) || [];
}

// records -> recipients. Returns { people: Map(userId -> { user, phone, email, records[] }), orphans: [records] }
async function resolveRecipients(records, settings, { allowTest = false } = {}) {
  const byUser = new Map();
  const orphans = [];
  const ids = new Set();
  const place = [];
  // The Admin's table (Who gets each reminder): once the 'every day' row was changed it decides the people and the ways; until then the old rules below apply.
  const row = await require('./accountsReminderSettings').resolve('proofDaily', { allowTest }); // eslint-disable-line global-require
  const rowIds = row.users.map((u) => u.id);
  records.forEach((r) => {
    const who = r.who || {};
    let to = Array.isArray(who.ids) ? who.ids : [];
    if (!who.own && settings.recipients.length) to = settings.recipients;
    if (row.peopleCustom) to = (who.own && row.owner && rowIds.includes((who.ids || [])[0])) ? who.ids : rowIds;
    place.push([r, to]);
    to.forEach((id) => ids.add(id));
  });
  const users = ids.size ? await prisma.user.findMany({ where: { id: { in: [...ids] }, status: 'Active' }, select: { id: true, name: true, email: true } }) : [];
  const emps = ids.size ? await prisma.employee.findMany({ where: { userId: { in: [...ids] } }, select: { userId: true, phone: true, email: true } }) : [];
  const userOf = new Map(users.filter((u) => allowTest || !isTest(`${u.name} ${u.email}`)).map((u) => [u.id, u]));
  const empOf = new Map();
  emps.forEach((e) => { const c = empOf.get(e.userId) || {}; empOf.set(e.userId, { phone: c.phone || e.phone || null, email: c.email || e.email || null }); });
  place.forEach(([r, to]) => {
    const live = to.filter((id) => userOf.has(id));
    if (!live.length) { orphans.push(r); return; }
    live.forEach((id) => {
      const cur = byUser.get(id) || { user: userOf.get(id), phone: (empOf.get(id) || {}).phone || null, email: userOf.get(id).email || (empOf.get(id) || {}).email || null, records: [] };
      cur.records.push(r);
      byUser.set(id, cur);
    });
  });
  return { people: byUser, orphans, channels: row.channels, rowUsers: row.users };
}

// ---------------------------------------------------------------------------
// THE MESSAGES - the user's wording first, then a compact list
// ---------------------------------------------------------------------------
const WA_HEAD = 'Hello Accountant, this is a reminder to attach and submit the required proof documents for the pending transaction. Please upload the proof in the Proof Reminder section as soon as possible.';
const MAIL_SUBJECT = 'Reminder: Pending Proof Document Submission';
const MAIL_HEAD = 'Dear Accountant,\n\nThis is a reminder to attach and submit the required proof documents for the pending transaction. Please log in to the application, open the Proof Reminder section, and upload the necessary proof documents.\n\nKindly ensure that all required proofs are submitted on time.';
const MAIL_TAIL = 'Regards,\nTeamLink System';
// For a person who may NOT open the Accounts screens (for example the HR head, named by the Admin): the same facts as plain text for their
// information, no instruction to open or upload anything and no link (founder, 2026-10-21). No permission is granted by receiving it.
const INFO_WA_HEAD = 'Hello, this is the daily Accounts summary, for your information. The Accountant is asked to attach the missing proof documents and to check what is waiting.';
const INFO_MAIL_SUBJECT = 'Accounts daily summary: pending items';
const INFO_MAIL_HEAD = 'Hello,\n\nThis is the daily Accounts summary, for your information. The Accountant is asked to attach the missing proof documents and to check what is waiting. Nothing is needed from you.';
const link = () => `${String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')}/accounts/dashboard#proof`;
const rupees = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
function listLines(records) {
  const shown = records.slice(0, LIST_CAP).map((r, i) => `${i + 1}. ${r.kind === 'invoice' ? 'Received from' : 'Paid to'} ${r.party || '-'} | ${r.ref || '-'} | ${rupees(r.amount)} | ${r.paidOn || '-'}`);
  if (records.length > LIST_CAP) shown.push(`...and ${records.length - LIST_CAP} more`);
  return shown;
}
// ONE summary per person per round (founder, 2026-10-21): the counts, the oldest proofs first (10 shown), then what else is still waiting for
// Accounts (utils/accountsDigest.js, passed in as plain lines). Plain text with the links to the Accounts screens.
function buildMessages(records, { test = false, extras: rawExtras = [], info = false } = {}) {
  const extras = rawExtras.map((x) => (typeof x === 'string' ? { line: x, where: null } : x));
  const sorted = records.slice().sort((a, b) => String(a.paidOn || '9999').localeCompare(String(b.paidOn || '9999')));
  const total = sorted.reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const parts = [];
  if (sorted.length) parts.push([`${sorted.length} proof${sorted.length === 1 ? ' is' : 's are'} missing (${rupees(total)} in all). The oldest are first.`, 'Pending records:', ...listLines(sorted)].join('\n'));
  else if (!extras.length) parts.push('(Nothing is pending right now - this is only a test of the message.)');
  if (extras.length) parts.push(['Also waiting for Accounts:', ...extras.map((x) => `- ${x.line}${!info && x.where ? ` Open: ${x.where}.` : ''}`)].join('\n'));
  const body = parts.join('\n\n');
  const open = info ? '' : `\n\nOpen: ${link()}`;
  const mark = test ? '[TEST] ' : '';
  return {
    whatsapp: `${mark}${info ? INFO_WA_HEAD : WA_HEAD}\n\n${body}${open}`,
    emailSubject: `${info ? INFO_MAIL_SUBJECT : MAIL_SUBJECT}${test ? ' (test)' : ''}`,
    emailText: `${mark}${info ? INFO_MAIL_HEAD : MAIL_HEAD}\n\n${body}${open}\n\n${MAIL_TAIL}`,
    bellTitle: `${mark}${sorted.length ? `${sorted.length} payment proof${sorted.length === 1 ? ' is' : 's are'} missing` : 'Accounts summary'}`,
    bell: `${mark}${body}${open}`.slice(0, 1800),
  };
}

// ---------------------------------------------------------------------------
// THE TRANSPORTS - the app's own channels layer / mailer (tests pass fakes)
// ---------------------------------------------------------------------------
const defaultTransports = {
  async whatsapp({ to, text, name, userId }) {
    const MS = require('./messaging'); // eslint-disable-line global-require
    return MS.send('WhatsApp', { to, kind: 'bulk', text, vars: [text], meta: { purpose: 'proof-reminder', audience: 'staff', personId: userId || null, personName: name || null } });
  },
  async email({ to, subject, text }) {
    // The 'Notification emails' master switch (Administration, HRMS notifications) is respected: OFF means no email, said plainly.
    const hn = await require('./hrmsNotify').getSettings().catch(() => null); // eslint-disable-line global-require
    if (hn && hn.emailsOn !== true) return { ok: false, switchedOff: true, error: 'Emails are switched off by Admin (Notification emails)' };
    const MS = require('./messaging'); // eslint-disable-line global-require
    return MS.send('Email', { to, subject, text, fromName: 'TeamLink System' });
  },
};

// A send result -> { ok, retry, error } in plain words
function verdict(channel, r) {
  const res = r || {};
  if (res.ok) return { ok: true };
  // an address or a number never goes into the run log
  const said = clip(res.error || res.reason, 140).replace(/[\w.+-]+@[\w.-]+/g, '(address)').replace(/\+?\d[\d\s-]{7,}\d/g, '(number)');
  const name = channel === 'WhatsApp' ? 'WhatsApp' : 'Mail';
  if (res.capped || /daily limit/i.test(said)) return { ok: false, retry: false, error: `${name} daily limit reached${said ? ` (${said})` : ''}` };
  if (res.switchedOff) return { ok: false, retry: false, error: said };
  if (res.notConfigured) return { ok: false, retry: true, error: channel === 'WhatsApp' ? `WhatsApp is not connected${said ? ` (${said})` : ''}` : `Mail is not set up${said ? ` (${said})` : ''}` };
  if (res.invalid || res.reserved) return { ok: false, retry: false, error: said || 'The address is not valid' };
  return { ok: false, retry: true, error: said || `${name} could not be sent` };
}

// ---------------------------------------------------------------------------
// ONE REMINDER = ONE ROW. claim -> deliver -> settle.
// ---------------------------------------------------------------------------
const rowOf = (r) => ({
  id: r.id, runKey: r.runKey, day: r.runDate, slot: r.slot, trigger: r.trigger, userId: r.userId, userName: r.userName, channel: r.channel, to: r.toAddress,
  status: r.status, error: r.error, attempts: num(r.attempts), records: num(r.recordCount), sentAt: r.sentAt ? new Date(num(r.sentAt)).toISOString() : null,
  at: new Date(num(r.updatedAt) || num(r.createdAt)).toISOString(), nextAttemptAt: r.nextAttemptAt ? new Date(num(r.nextAttemptAt)).toISOString() : null,
});
const keyOf = (day, slot, userId, channel) => `${day}|${slot}|${userId || 'none'}|${channel}`;

async function insertClaim({ runKey, day, slot, trigger, userId, userName, channel, to, count, keys, windowEnd }) {
  const now = Date.now();
  const n = await run(
    `INSERT OR IGNORE INTO "ProofReminderRun" ("id","runKey","runDate","slot","trigger","userId","userName","channel","toAddress","status","attempts","recordCount","recordKeys","leaseAt","windowEndAt","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,'sending',1,?,?,?,?,?,?)`,
    newId(), runKey, day, slot, trigger, userId || null, userName || null, channel, to || null, count, JSON.stringify(keys || []).slice(0, 4000), now, windowEnd || null, now, now,
  );
  return num(n) === 1 ? (await q('SELECT * FROM "ProofReminderRun" WHERE "runKey"=?', runKey))[0] : null;
}
async function settle(id, { status, error = null, nextAttemptAt = null, count, keys }) {
  const now = Date.now();
  await run(
    `UPDATE "ProofReminderRun" SET "status"=?,"error"=?,"nextAttemptAt"=?,"leaseAt"=NULL,"sentAt"=CASE WHEN ?='sent' THEN ? ELSE "sentAt" END,
       "recordCount"=COALESCE(?,"recordCount"),"recordKeys"=COALESCE(?,"recordKeys"),"updatedAt"=? WHERE "id"=?`,
    status, error ? clip(error, 300) : null, nextAttemptAt, status, now, count == null ? null : count, keys ? JSON.stringify(keys).slice(0, 4000) : null, now, id,
  );
}

// Everybody on the 'Who gets it' row is in the round when something else is waiting, even with no missing proof of their own.
async function addRowPeople(people, rowUsers) {
  const have = new Set([...people.keys()]);
  const missing = (rowUsers || []).filter((u) => !have.has(u.id));
  if (!missing.length) return;
  const emps = await prisma.employee.findMany({ where: { userId: { in: missing.map((u) => u.id) } }, select: { userId: true, phone: true, email: true } });
  missing.forEach((u) => {
    const e = emps.find((x) => x.userId === u.id) || {};
    people.set(u.id, { user: { id: u.id, name: u.name }, phone: e.phone || null, email: u.email || e.email || null, records: [] });
  });
}
// Who may open the Accounts screens (the digest of a person who may not has no link and no instruction).
async function markAccess(people) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  for (const p of people.values()) {
    // eslint-disable-next-line no-await-in-loop
    const ident = await resolveIdentity(p.user.id).catch(() => null);
    p.accountsAccess = !!(ident && ident.products && ident.products.accounts);
  }
}
async function extrasFor(pending, given, now) {
  if (Array.isArray(given)) return given;
  if (pending !== defaultPending) return [];
  try { return await require('./accountsDigest').items(now); } catch { return []; } // eslint-disable-line global-require
}

// Sends the row's message on its channel and settles the row. `row` is already claimed (status 'sending').
async function deliver(row, person, records, { transports, test = false, retryAllowed = true, nowMs = Date.now(), extras = [] }) {
  const channel = row.channel;
  const msgs = buildMessages(records, { test, extras, info: person.accountsAccess === false });
  const keys = records.map((r) => r.key);
  const attempts = num(row.attempts);
  const done = (status, error, extra = {}) => settle(row.id, { status, error, count: records.length, keys, ...extra });
  try {
    if (channel === 'Bell') {
      await prisma.notification.create({ data: { userId: person.user.id, title: msgs.bellTitle, message: msgs.bell } });
      return await done('sent', null);
    }
    if (channel === 'WhatsApp') {
      if (!person.phone) return await done('failed', `No WhatsApp number on file for ${person.user.name}`);
      const mobile = require('./messagingCore').normalizeMobile(person.phone); // eslint-disable-line global-require
      if (!mobile.ok) return await done('failed', `The WhatsApp number on file for ${person.user.name} is not a valid mobile number`);
    } else {
      if (!person.email) return await done('failed', `No email on file for ${person.user.name}`);
      if (!require('./messagingCore').validEmail(person.email)) return await done('failed', `The email on file for ${person.user.name} is not a valid email address`); // eslint-disable-line global-require
    }
    const r = channel === 'WhatsApp'
      ? await transports.whatsapp({ to: person.phone, text: msgs.whatsapp, name: person.user.name, userId: person.user.id })
      : await transports.email({ to: person.email, subject: msgs.emailSubject, text: msgs.emailText, name: person.user.name, userId: person.user.id });
    const v = verdict(channel, r);
    if (v.ok) return await done('sent', null);
    const winEnd = num(row.windowEndAt);
    const wait = BACKOFF_MIN[attempts - 1];
    const next = v.retry && retryAllowed && attempts < MAX_ATTEMPTS && wait ? nowMs + wait * 60000 : null;
    return await done('failed', v.error, { nextAttemptAt: next && (!winEnd || next < winEnd) ? next : null });
  } catch (err) {
    const wait = BACKOFF_MIN[attempts - 1];
    const next = retryAllowed && attempts < MAX_ATTEMPTS && wait ? nowMs + wait * 60000 : null;
    return done('failed', `Could not be sent: ${clip(err && err.message, 140)}`, { nextAttemptAt: next && (!num(row.windowEndAt) || next < num(row.windowEndAt)) ? next : null });
  }
}

// One round (slot) of one day: claim + send for every (person, channel). Duplicates are counted, never sent.
async function sendRound({ day, slot, trigger, records, settings, transports, windowEnd, force = false, reclaimFailed = false, allowTest = false, nowMs = Date.now(), extras = [] }) {
  const out = {
    day, slot, pending: records.length, people: 0, sent: 0, failed: 0, duplicates: 0, noAccountant: 0, results: [],
  };
  if (!records.length && !extras.length) return out; // nothing pending: no empty message
  const { people, orphans, channels, rowUsers } = await resolveRecipients(records, settings, { allowTest });
  if (extras.length) await addRowPeople(people, rowUsers); // the summary of what else is waiting goes to every person of the row
  if (extras.length && !people.size && !orphans.length) await require('./accountsRecipients').warnNoRecipients('proofDaily', 'the daily Accounts summary', { allowTest }); // eslint-disable-line global-require
  await markAccess(people);
  const stamp = force ? `|force|${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}` : '';
  const jobs = [];
  const ways = ['WhatsApp', 'Email', 'Bell'].filter((c) => !channels || channels.includes(c.toLowerCase()));
  people.forEach((p) => { out.people += 1; ways.forEach((channel) => jobs.push({ p, channel })); });
  if (orphans.length) {
    out.noAccountant = orphans.length;
    // never the Admin in its place: the Admin hears once that there is no Accountant (deduped)
    await require('./accountsRecipients').warnNoRecipients('proofDaily', `${orphans.length} proof reminder${orphans.length === 1 ? '' : 's'}`, { allowTest }); // eslint-disable-line global-require
    for (const channel of ['WhatsApp', 'Email']) {
      // eslint-disable-next-line no-await-in-loop
      const row = await insertClaim({ runKey: keyOf(day, slot, null, channel) + stamp, day, slot, trigger, userId: null, userName: 'No accountant set', channel, to: null, count: orphans.length, keys: orphans.map((r) => r.key), windowEnd });
      // eslint-disable-next-line no-await-in-loop
      if (row) await settle(row.id, { status: 'failed', error: `${orphans.length} pending record(s) have no Accountant to tell - set "Who gets it" or give an Accountant the Accounts role`, count: orphans.length });
    }
  }
  for (const { p, channel } of jobs) {
    const runKey = keyOf(day, slot, p.user.id, channel) + stamp;
    let row;
    try {
      // eslint-disable-next-line no-await-in-loop
      row = await insertClaim({ runKey, day, slot, trigger, userId: p.user.id, userName: p.user.name, channel, to: channel === 'WhatsApp' ? (p.phone ? String(p.phone) : null) : p.email, count: p.records.length, keys: p.records.map((r) => r.key), windowEnd });
      if (!row && reclaimFailed) {
        // a manual "Run now" may try again a reminder that failed (never one that was sent)
        // eslint-disable-next-line no-await-in-loop
        const n = await run('UPDATE "ProofReminderRun" SET "status"=\'sending\',"attempts"="attempts"+1,"leaseAt"=?,"nextAttemptAt"=NULL,"updatedAt"=?,"trigger"=? WHERE "runKey"=? AND "status"=\'failed\'', Date.now(), Date.now(), trigger, runKey);
        // eslint-disable-next-line no-await-in-loop
        if (num(n) === 1) row = (await q('SELECT * FROM "ProofReminderRun" WHERE "runKey"=?', runKey))[0];
      }
    } catch (err) { out.results.push({ user: p.user.name, channel, status: 'failed', error: clip(err.message, 140) }); out.failed += 1; continue; } // eslint-disable-line no-continue
    if (!row) { out.duplicates += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await deliver(row, p, p.records, { transports, nowMs, extras });
    // eslint-disable-next-line no-await-in-loop
    const fin = (await q('SELECT "status","error" FROM "ProofReminderRun" WHERE "id"=?', row.id))[0] || {};
    if (fin.status === 'sent') out.sent += 1; else out.failed += 1;
    out.results.push({ user: p.user.name, channel, status: fin.status, error: fin.error || null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RETRIES - failed reminders whose back-off is over and whose window is still open, re-checked at send time
// ---------------------------------------------------------------------------
async function runRetries({ now = new Date(), settings, transports, pending, allowTest = false, extras: given }) {
  const t = now.getTime();
  const rows = await q(
    `SELECT * FROM "ProofReminderRun" WHERE "attempts" < ? AND "trigger" != 'test' AND "windowEndAt" > ? AND
       (("status"='failed' AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt" <= ?) OR ("status"='sending' AND "leaseAt" < ?))
     ORDER BY "createdAt" LIMIT 100`,
    MAX_ATTEMPTS, t, t, t - STALE_LEASE_MS,
  );
  const out = { due: rows.length, retried: 0, sent: 0, failed: 0, notNeeded: 0 };
  if (!rows.length) return out;
  const records = await pending();
  const extras = await extrasFor(pending, given, now);
  const { people, rowUsers } = await resolveRecipients(records, settings, { allowTest });
  if (extras.length) await addRowPeople(people, rowUsers);
  await markAccess(people);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const n = await run(
      `UPDATE "ProofReminderRun" SET "status"='sending',"attempts"="attempts"+1,"leaseAt"=?,"nextAttemptAt"=NULL,"updatedAt"=?
       WHERE "id"=? AND "attempts"<? AND (("status"='failed' AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt"<=?) OR ("status"='sending' AND "leaseAt"<?))`,
      t, t, r.id, MAX_ATTEMPTS, t, t - STALE_LEASE_MS,
    );
    if (num(n) !== 1) continue; // eslint-disable-line no-continue
    out.retried += 1;
    const claimed = { ...r, attempts: num(r.attempts) + 1 };
    const p = r.userId ? people.get(r.userId) : null;
    if (!p) {
      // eslint-disable-next-line no-await-in-loop
      await settle(r.id, { status: 'skipped', error: 'Proof already submitted - nothing left to remind', count: 0 });
      out.notNeeded += 1;
      continue; // eslint-disable-line no-continue
    }
    // eslint-disable-next-line no-await-in-loop
    await deliver(claimed, p, p.records, { transports, nowMs: t, extras });
    // eslint-disable-next-line no-await-in-loop
    const fin = (await q('SELECT "status" FROM "ProofReminderRun" WHERE "id"=?', r.id))[0] || {};
    if (fin.status === 'sent') out.sent += 1; else out.failed += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE TICK - what the timer (and the tests) call
// ---------------------------------------------------------------------------
async function tick({ now = new Date(), transports = defaultTransports, pending = defaultPending, allowTest = false, extras: given } = {}) {
  const settings = await getSettings();
  const res = { day: dayOfIst(now), rounds: [], retries: null };
  if (!settings.enabled) return { ...res, skipped: 'The daily proof reminders are switched off.' };
  if (!(await ready())) return { ...res, skipped: 'The reminder log table is not created yet (pending migration 20261014600000).' };
  for (const s of dueSlots(now, settings)) {
    const marker = `${PLANNED_PREFIX}${res.day}.${s.id}`;
    // eslint-disable-next-line no-await-in-loop
    if (await prisma.appSetting.findUnique({ where: { key: marker } }).catch(() => null)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const records = await pending();
    // eslint-disable-next-line no-await-in-loop
    const extras = await extrasFor(pending, given, now);
    // eslint-disable-next-line no-await-in-loop
    const r = await sendRound({ day: res.day, slot: s.id, trigger: 'schedule', records, settings, transports, windowEnd: s.end, allowTest, nowMs: now.getTime(), extras });
    // eslint-disable-next-line no-await-in-loop
    await prisma.appSetting.upsert({ where: { key: marker }, update: { value: JSON.stringify({ at: new Date().toISOString(), pending: r.pending, sent: r.sent }) }, create: { key: marker, value: JSON.stringify({ at: new Date().toISOString(), pending: r.pending, sent: r.sent }) } });
    res.rounds.push({ slot: s.id, time: s.time, ...r });
  }
  res.retries = await runRetries({ now, settings, transports, pending, allowTest, extras: given });
  // old planning markers (14 days) go
  if (new Date().getUTCMinutes() % 30 < 6) {
    const cut = dayOfIst(new Date(now.getTime() - 14 * 86400000));
    const old = (await prisma.appSetting.findMany({ where: { key: { startsWith: PLANNED_PREFIX } }, select: { key: true } }).catch(() => [])).filter((x) => x.key.slice(PLANNED_PREFIX.length, PLANNED_PREFIX.length + 10) < cut).map((x) => x.key);
    if (old.length) await prisma.appSetting.deleteMany({ where: { key: { in: old } } }).catch(() => null);
  }
  return res;
}

// ---------------------------------------------------------------------------
// ADMIN: Run now (respects the idempotency key unless force) and Send a test to me
// ---------------------------------------------------------------------------
function slotNow(now, settings) {
  const day = dayOfIst(now);
  const t = (now || new Date()).getTime();
  const second = atIst(day, settings.time2) - 3 * 3600000; // from 3 hours before the second time: the second round
  return t >= Math.min(second, atIst(day, settings.time2)) ? 'second' : 'first';
}
async function runNow({ user, slot, force = false, now = new Date(), transports = defaultTransports, pending = defaultPending, allowTest = false, extras: given } = {}) {
  if (!(await ready())) return { status: 409, body: { error: 'The reminder log table is not created yet (pending migration 20261014600000).' } };
  const settings = await getSettings();
  const s = SLOTS.some((x) => x.id === slot) ? slot : slotNow(now, settings);
  const day = dayOfIst(now);
  const records = await pending();
  const extras = await extrasFor(pending, given, now);
  if (!records.length && !extras.length) return { status: 200, body: { ok: true, day, slot: s, pending: 0, sent: 0, failed: 0, duplicates: 0, message: 'Nothing is pending - every paid / received record has its proof, so nothing was sent.' } };
  const r = await sendRound({ day, slot: s, trigger: 'manual', records, settings, transports, windowEnd: now.getTime() + 60 * 60000, force, reclaimFailed: true, allowTest, nowMs: now.getTime(), extras });
  await logAudit({ userId: user.id, actorName: user.name || null, action: `Proof reminder run now${force ? ' (sent again)' : ''}`, entity: 'AccountsDashboard', toValue: `${s}: ${r.sent} sent, ${r.failed} failed, ${r.duplicates} already sent` }).catch(() => null);
  const bits = [];
  if (r.sent) bits.push(`${r.sent} message${r.sent === 1 ? '' : 's'} sent`);
  if (r.failed) bits.push(`${r.failed} could not be sent (see the list below)`);
  if (r.duplicates) bits.push(`${r.duplicates} already sent today - not sent again`);
  return { status: 200, body: { ok: true, ...r, message: bits.join(' - ') || 'Nothing to send.' } };
}

// Only to the logged-in person's OWN number / address. Never touches the idempotency of the real rounds.
async function sendTest({ user, now = new Date(), transports = defaultTransports, pending = defaultPending } = {}) {
  if (!(await ready())) return { status: 409, body: { error: 'The reminder log table is not created yet (pending migration 20261014600000).' } };
  const emp = await prisma.employee.findFirst({ where: { userId: user.id, phone: { not: null } }, select: { phone: true, email: true } })
    || await prisma.employee.findFirst({ where: { userId: user.id }, select: { phone: true, email: true } });
  const me = { user: { id: user.id, name: user.name }, phone: (emp && emp.phone) || null, email: user.email || (emp && emp.email) || null };
  let records = [];
  try { records = await pending(); } catch { records = []; }
  const day = dayOfIst(now);
  const out = { channels: {} };
  for (const channel of ['WhatsApp', 'Email']) {
    // eslint-disable-next-line no-await-in-loop
    const row = await insertClaim({ runKey: `test|${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}|${user.id}|${channel}`, day, slot: 'test', trigger: 'test', userId: user.id, userName: user.name, channel, to: channel === 'WhatsApp' ? me.phone : me.email, count: records.length, keys: records.map((r) => r.key), windowEnd: null });
    // eslint-disable-next-line no-await-in-loop
    await deliver(row, me, records, { transports, test: true, retryAllowed: false, nowMs: now.getTime() });
    // eslint-disable-next-line no-await-in-loop
    const fin = (await q('SELECT "status","error" FROM "ProofReminderRun" WHERE "id"=?', row.id))[0] || {};
    out.channels[channel] = { status: fin.status, error: fin.error || null };
  }
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'Proof reminder test sent to self', entity: 'AccountsDashboard', toValue: `WhatsApp: ${out.channels.WhatsApp.status}, Email: ${out.channels.Email.status}` }).catch(() => null);
  const parts = ['WhatsApp', 'Email'].map((c) => `${c === 'Email' ? 'Email' : 'WhatsApp'}: ${out.channels[c].status === 'sent' ? 'sent to you' : `not sent - ${out.channels[c].error}`}`);
  return { status: 200, body: { ok: true, ...out, message: parts.join(' | ') } };
}

// ---------------------------------------------------------------------------
// READS for the screen
// ---------------------------------------------------------------------------
async function listRuns({ limit = 60, day = null } = {}) {
  if (!(await ready())) return [];
  const rows = day
    ? await q('SELECT * FROM "ProofReminderRun" WHERE "runDate"=? ORDER BY "createdAt" DESC LIMIT ?', day, Math.min(300, limit))
    : await q('SELECT * FROM "ProofReminderRun" ORDER BY "createdAt" DESC LIMIT ?', Math.min(300, limit));
  return rows.map(rowOf);
}
async function status({ now = new Date(), pending = defaultPending } = {}) {
  const settings = await getSettings();
  const day = dayOfIst(now);
  let records = []; let pendingError = null;
  try { records = await pending(); } catch (e) { pendingError = clip(e.message, 160); }
  const { people, orphans } = await resolveRecipients(records, settings);
  let ch = {};
  try { ch = await require('./messaging').channelStatus(); } catch { ch = {}; } // eslint-disable-line global-require
  const msgs = buildMessages(records.length ? records : [{ kind: 'expense', party: 'Sample vendor', ref: 'BILL-001', amount: 12500, paidOn: day }]);
  const emps = await candidatePeople();
  const empRows = emps.length ? await prisma.employee.findMany({ where: { userId: { in: emps.map((u) => u.id) } }, select: { userId: true, phone: true } }) : [];
  const phoneOf = new Map(empRows.filter((e) => e.phone).map((e) => [e.userId, e.phone]));
  const runs = await listRuns({ limit: 60 });
  // NEXT ROUND and LAST SENT, in plain words (the manual button is gone: it is automatic)
  const nowMs = now.getTime();
  const tomorrow = dayOfIst(new Date(nowMs + 86400000));
  const cand = [];
  [day, tomorrow].forEach((d) => SLOTS.forEach((sl) => cand.push({ at: atIst(d, settings[sl.key]), label: `${d === day ? 'today' : 'tomorrow'} ${settings[sl.key]}` })));
  const nextRound = cand.filter((c) => c.at > nowMs).sort((a, b) => a.at - b.at)[0] || null;
  const lastSent = runs.filter((r) => r.status === 'sent' && r.sentAt).map((r) => r.sentAt).sort().pop() || null;
  return {
    settings,
    automatic: { on: settings.enabled === true, next: settings.enabled ? nextRound : null, lastSent },
    tableReady: await ready(),
    day,
    rounds: SLOTS.map((s) => ({ id: s.id, label: s.label, time: settings[s.key], timeLabel: niceTime(settings[s.key]), until: niceTime(addMin(settings[s.key], WINDOW_MIN)) })),
    timezone: 'Asia/Kolkata (IST)',
    pending: { count: records.length, error: pendingError, noAccountant: orphans.length },
    recipients: [...people.values()].map((p) => ({ id: p.user.id, name: p.user.name, records: p.records.length, hasWhatsApp: !!p.phone, hasEmail: !!p.email })),
    accountsPeople: emps.map((u) => ({ id: u.id, name: u.name, role: u.accountsRole, hasWhatsApp: phoneOf.has(u.id), hasEmail: !!u.email })),
    channels: {
      whatsapp: { connected: !!(ch.WhatsApp && ch.WhatsApp.configured), reason: ch.WhatsApp && !ch.WhatsApp.configured ? ch.WhatsApp.reason : null },
      email: { connected: !!(ch.Email && ch.Email.configured), reason: ch.Email && !ch.Email.configured ? ch.Email.reason : null },
    },
    preview: { whatsapp: msgs.whatsapp, emailSubject: msgs.emailSubject, emailText: msgs.emailText, sample: !records.length },
    runs,
  };
}

// ---------------------------------------------------------------------------
// THE TIMER
// ---------------------------------------------------------------------------
let TIMER = null;
let TICKING = false;
function startSweep() {
  const ms = Number(process.env.PROOF_REMINDER_SWEEP_MS || 2 * 60000);
  if (!ms || TIMER) return;
  TIMER = setInterval(async () => {
    if (TICKING) return;
    TICKING = true;
    try {
      const r = await tick();
      if (r && (r.rounds.length || (r.retries && r.retries.retried)) && process.env.PROOF_REMINDER_LOG !== '0') {
        console.log(`[proof-reminders] ${JSON.stringify({ rounds: r.rounds.map((x) => ({ slot: x.slot, pending: x.pending, sent: x.sent, failed: x.failed, dup: x.duplicates })), retries: r.retries })}`); // eslint-disable-line no-console
      }
    } catch (err) { console.error('[proof-reminders]', err.message); } finally { TICKING = false; } // eslint-disable-line no-console
  }, ms);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  SETTINGS_KEY, DEFAULTS, SLOTS, WINDOW_MIN, MAX_ATTEMPTS, LIST_CAP, WA_HEAD, MAIL_SUBJECT, MAIL_HEAD, MAIL_TAIL,
  getSettings, saveSettings, candidatePeople, normalise, dueSlots, slotWindow, dayOfIst, atIst, ready, resetReady,
  buildMessages, resolveRecipients, defaultPending, tick, runNow, sendTest, listRuns, status, startSweep, verdict, keyOf,
};
