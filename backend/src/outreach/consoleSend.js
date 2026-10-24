// ---------------------------------------------------------------------------
// OMNI-CHANNEL COMMUNICATION CONSOLE (the prototype's "Direct send"): send one message to a list of people on ONE way (WhatsApp, SMS, Email, Voice) without
// building a full campaign. This file is the console's OWN small queue (it does not touch the campaign engine in campaigns.js / runner.js).
//
//   options()        what the screen needs: the accounts (our real ones), the templates, Test-mode / quiet-hours / daily-limit words, who may add new people
//   contacts()       the CRM Contact Selector (your Omni-Channel contacts, with who agreed to this way)
//   uploadCsv()      a CSV / Excel file kept for a day, so Preview and Send read the same file
//   preview()        what WOULD happen for this list (ready / not agreed / stopped / not in Contacts yet ...), nothing is saved
//   createRun()      Send now / Schedule: writes one OmniSendRun + one OmniSendRunItem per person and starts the run
//   tick() / start() a small loop inside the API process (like outreach/sequences.js): runs wake up, rows are processed in small batches
//   runs() / getRun() / stopRun() / logCsv()
//
// SAFETY (all of it is checked again here, whatever the screen says):
//   * Only a person who AGREED to that way (OutreachContactChannel.optIn = opted_in, not on the do-not-contact list) is ever messaged. Checked when the run is made
//     AND again just before each row is handed on (a STOP that arrives meanwhile is honoured).
//   * A CSV person who is not in Contacts yet is added through the SAME rules as the import (outreach/import.js save(): the tick "I have permission to message
//     these people" + a few words where they came from, recorded in the consent log) or the row is left out and says so.
//   * TEST MODE = REHEARSAL: "Outreach sending" is OFF, or Test mode is ON, or this is the test sandbox, or the provider is not connected: every row is written
//     and counted as a Test message in the credits ledger; NOTHING is handed to any provider. Real only when an Admin switched Test mode off AND the provider
//     is connected. A run keeps the mode it was made in (a rehearsal never turns real; a real run waits while Test mode is on).
//   * credits (credits.js guard / record, per sender), quiet hours (quiet.js), the daily limits (settings), the STOP line for WhatsApp / SMS, the unsubscribe
//     link for email.
//   * No phone or email is kept in the run tables: a row keeps the contact id; the address is read from Contacts only at the moment of sending, and a
//     masked login (BDE team, recruiter, marketing) only ever sees it masked (screen and downloaded log).
// Tables (self-provisioned, raw SQL; migration 20261017180000_omni_gs_console_inbox): OmniSendRun, OmniSendRunItem, OmniSendUpload.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const K = require('./contacts');
const C = require('./consent');
const Cr = require('./credits');
const Quiet = require('./quiet');
const Hub = require('./hub');
const I = require('./import');
const Comm = require('./communication');
const Sender = require('./sender');
const core = require('../utils/messagingCore');
const access = require('../utils/contactAccess');
const L = require('../broadcast/lists');
const { logAudit } = require('../utils/audit');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = S.num;
const clip = S.clip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IST = 5.5 * 3600 * 1000;
const DAY = 86400000;
const MAX_ROWS = 2000;
const MAX_FILE = 5 * 1024 * 1024;

// the ways the console can send now; the others are shown as Planned by the screen
const CH = {
  whatsapp: { word: 'WhatsApp', consent: 'whatsapp', send: 'WhatsApp', cap: 'waDailyCap', perMin: 'waPerMinute', stop: true },
  sms: { word: 'SMS', consent: 'sms', send: 'SMS', cap: 'smsDailyCap', perMin: 'smsPerMinute', stop: true },
  email: { word: 'Email', consent: 'email', send: 'Email', cap: 'emailDailyCap', perMin: 'emailPerMinute', stop: false },
  call: { word: 'Voice', consent: null, send: null, cap: null, perMin: null, stop: false },
};
const PLANNED = { rcs: 'RCS', facebook: 'Facebook', instagram: 'Instagram' };
// the two template stores spell the Meta state differently (Approved / approved, None / draft ...): one set of plain words, never the word "draft"
const WA_STATUS_WORDS = { none: 'not sent to Meta yet', draft: 'not sent to Meta yet', pending: 'still waiting for Meta', rejected: 'rejected by Meta', approved: 'approved' };

const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniSendRun" ("id" TEXT NOT NULL PRIMARY KEY, "createdById" TEXT, "createdByName" TEXT, "department" TEXT, "channel" TEXT NOT NULL, "accountId" TEXT, "accountLabel" TEXT, "name" TEXT NOT NULL, "templateKey" TEXT, "templateLabel" TEXT, "subject" TEXT, "body" TEXT, "source" TEXT NOT NULL DEFAULT \'crm\', "sourceLabel" TEXT, "contactType" TEXT NOT NULL DEFAULT \'candidate_lead\', "mode" TEXT NOT NULL DEFAULT \'test\', "status" TEXT NOT NULL DEFAULT \'running\', "scheduledAt" DATETIME, "startedAt" DATETIME, "finishedAt" DATETIME, "nextAt" DATETIME, "note" TEXT, "total" INTEGER NOT NULL DEFAULT 0, "sent" INTEGER NOT NULL DEFAULT 0, "rehearsed" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0, "skipped" INTEGER NOT NULL DEFAULT 0, "cancelled" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS "OmniSendRun_status" ON "OmniSendRun"("status", "scheduledAt")',
  'CREATE INDEX IF NOT EXISTS "OmniSendRun_user" ON "OmniSendRun"("createdById", "createdAt")',
  'CREATE TABLE IF NOT EXISTS "OmniSendRunItem" ("id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "seq" INTEGER NOT NULL DEFAULT 0, "contactId" TEXT, "name" TEXT, "status" TEXT NOT NULL DEFAULT \'queued\', "error" TEXT, "subject" TEXT, "message" TEXT, "extra" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0, "sentAt" DATETIME)',
  'CREATE INDEX IF NOT EXISTS "OmniSendRunItem_run" ON "OmniSendRunItem"("runId", "status", "seq")',
  'CREATE TABLE IF NOT EXISTS "OmniSendUpload" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "fileName" TEXT, "csv" TEXT NOT NULL, "rows" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS "OmniSendUpload_user" ON "OmniSendUpload"("userId", "createdAt")',
];
let okAt = 0; let ensuring = null;
async function ensureTables() {
  if (okAt) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try {
        // an earlier build made the time columns plain INTEGER (a Prisma raw read of a big INTEGER fails): while the tables are still empty, make them again with DATETIME columns
        const old = await q('PRAGMA table_info("OmniSendRun")');
        if (old.some((c) => c.name === 'createdAt' && String(c.type).toUpperCase() === 'INTEGER') && num((await q('SELECT COUNT(*) n FROM "OmniSendRun"'))[0].n) === 0) { await run('DROP TABLE "OmniSendRunItem"'); await run('DROP TABLE "OmniSendRun"'); await run('DROP TABLE IF EXISTS "OmniSendUpload"'); }
        for (const sql of DDL) await run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-console] tables:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}

// ---- who may do what -------------------------------------------------------------------------------------------------------------
const mayConsole = (u) => A.maySendConsole(u);
// the kind of contact a login may message from the console (the same rule as communication.quickSend)
function mayContactType(user, st, type) {
  if (type === 'internal') return A.isAdmin(user) || (A.kind(user) === 'hr' && st.internalHrMaySend === true);
  return ['admin', 'bde', 'bdetl', 'tl', 'marketing'].includes(A.kind(user));
}
const defaultType = (user) => (A.kind(user) === 'hr' ? 'internal' : 'candidate_lead');
const typeOf = (user, v) => (A.kind(user) === 'hr' ? 'internal' : (A.isAdmin(user) && (v === 'internal') ? 'internal' : 'candidate_lead'));
const maskAddr = (ch, c) => (ch === 'email' ? (c.email ? core.maskEmail(c.email) : '') : (c.phoneE164 ? core.maskMobile(c.phoneE164) : ''));
const showAddr = (user, ch, c) => (A.masked(user) ? maskAddr(ch, c) : (ch === 'email' ? (c.email || '') : (c.phoneE164 ? `+${c.phoneE164}` : '')));
const scrubText = (user, t) => (A.masked(user) ? access.scrubFor(String(t || '')) : String(t || ''));
const scrubErr = (t) => access.scrubFor(clip(t, 200));

// ---- accounts, templates, settings words ---------------------------------------------------------------------------------------------
async function accountsFor(user, st, status) {
  const out = { whatsapp: [], sms: [], email: [], call: [] };
  const Cfg = require('./config'); // eslint-disable-line global-require
  const Pol = require('./policy'); // eslint-disable-line global-require
  let wa = { connected: false, number: '', why: '' };
  try { wa = await Cfg.account(); } catch { /* keep the default */ }
  const sc = A.deptScope(user);
  const mine = sc.all ? null : sc.departments;
  // WHATSAPP NUMBERS (utils/waNumbers.js): with a list of numbers the accounts ARE the numbers this login may send from
  let realNumbers = false;
  try {
    const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
    if (await WN.hasNumbers()) {
      realNumbers = true;
      for (const r of await WN.authorisedRows(user, { includeOff: true })) { // eslint-disable-line no-restricted-syntax
        const cfg = await WN.configOf(r); // eslint-disable-line no-await-in-loop
        const usable = !!(r.active && cfg && cfg.configured);
        out.whatsapp.push({ id: `wan:${r.id}`, name: r.label, sub: r.displayNumber, sub2: usable ? `Connected${r.isDefault ? ' · default number' : ''}` : (!r.active ? 'Switched off by the Admin' : ((cfg && cfg.reason) || 'Not connected')), connected: usable, where: 'Administration > Integrations > WhatsApp & SMS > WhatsApp numbers' });
      }
    }
  } catch { realNumbers = false; }
  if (!realNumbers) out.whatsapp.push({ id: 'wa:company', name: 'Company WhatsApp number', sub: wa.number || 'Not connected yet', sub2: wa.connected ? 'Connected' : (wa.why || 'Not connected'), connected: !!wa.connected, where: 'Administration > Integrations > Connections > WhatsApp Business' });
  const mapped = realNumbers ? [] : await Pol.waNumbers();
  mapped.forEach((r) => {
    const deps = (r.departments || []).map((d) => String(d).toLowerCase());
    if (mine && deps.length && !deps.some((d) => mine.includes(d))) return;
    out.whatsapp.push({ id: `wa:${r.id}`, name: r.label, sub: r.numberMasked, sub2: `${(r.departments || []).join(', ') || 'All departments'} · sends through the connected company number`, connected: !!wa.connected, departments: r.departments || [], routingOnly: true });
  });
  const sh = Sender.shown(st);
  if (sh.smsSenderId || (status.SMS && status.SMS.configured)) {
    out.sms.push({ id: 'sms:sender', name: sh.smsSenderId ? `SMS sender ${sh.smsSenderId}` : 'SMS sender', sub: sh.smsSenderId ? `Sender ID: ${sh.smsSenderId}` : 'Sender ID not set yet', sub2: sh.smsDltEntityId ? `DLT entity: ${sh.smsDltEntityId}` : ((status.SMS && status.SMS.detail) || ''), connected: !!(status.SMS && status.SMS.configured), where: 'Omni-Channel > Settings > Sender details' });
  }
  const mailFrom = sh.fromEmail || '';
  if (mailFrom || (status.Email && status.Email.configured)) {
    out.email.push({ id: 'email:from', name: sh.fromName || 'Company email', sub: mailFrom || ((status.Email && status.Email.detail) || 'From address not set yet'), sub2: sh.replyTo ? `Replies go to ${sh.replyTo}` : '', connected: !!(status.Email && status.Email.configured), where: 'Omni-Channel > Settings > Sender details' });
  }
  out.call.push({ id: 'call:tasks', name: 'Call tasks', sub: 'Each person becomes a call task for you', sub2: 'Shown in Automations > Tasks. Nothing is dialled by the system.', connected: true });
  return out;
}

const waWords = (st) => WA_STATUS_WORDS[String(st || 'none').toLowerCase()] || 'not approved yet';
function tplView(i) {
  const low = i.wa ? String(i.wa.status || 'none').toLowerCase() : 'approved';
  const status = ({ approved: 'Approved', pending: 'Pending', rejected: 'Rejected' })[low] || 'None';
  const body = String(i.body || '');
  return { key: i.key, name: i.name, group: i.group || '', channel: i.channel, subject: i.subject || '', body, department: i.department || '', status, approved: status === 'Approved', statusWords: waWords(status), hasStop: /\bSTOP\b/i.test(body), source: i.sourceWord || '' };
}
async function templatesFor(user) {
  const out = { whatsapp: [], sms: [], email: [], call: [] };
  const map = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', call: 'Call script' };
  for (const [k, w] of Object.entries(map)) {
    const r = await Hub.list(user, { channel: w }); // eslint-disable-line no-await-in-loop
    const items = (r.items || []).filter((i) => i.channel === w && i.source !== 'job' && i.source !== 'post');
    // ONE list for every sender; with several WhatsApp accounts each template also says which sender numbers can use it (outreach/tplWaba.js)
    const by = k === 'whatsapp' ? await require('./tplWaba').byNumber(items) : new Map(); // eslint-disable-line global-require, no-await-in-loop
    out[k] = items.map((i) => (by.get(i.key) ? { ...tplView(i), byNumber: by.get(i.key) } : tplView(i)));
  }
  return out;
}
async function templateByKey(user, ch, key) {
  const t = (await templatesFor(user))[ch].find((x) => x.key === key);
  return t || null;
}
// the registered details a LIVE send needs (the WhatsApp template name, the DLT template number): read from the store that owns the template
async function templateRegistered(key) {
  try {
    const [src, id] = String(key || '').split(/:(.*)/s);
    if (src === 'outreach') {
      const t = (await q('SELECT waTemplateName, dltTemplateId, senderId FROM "OutreachTemplate" WHERE id = ?', id))[0];
      return t ? { waName: t.waTemplateName || '', language: undefined, dltTemplateId: t.dltTemplateId || '', senderId: t.senderId || '' } : {};
    }
    if (src === 'message') {
      const t = await prisma.messageTemplate.findUnique({ where: { id } });
      return t ? { waName: t.waTemplateName || '', language: t.waLanguageCode || undefined, dltTemplateId: t.dltTemplateId || '', senderId: t.senderId || '' } : {};
    }
  } catch { /* nothing registered */ }
  return {};
}

async function usedToday(ch, mode, now = Date.now()) {
  await Cr.ensureTables();
  const start = Math.floor((now + IST) / DAY) * DAY - IST;
  const r = (await q('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE channel = ? AND mode = ? AND at >= ? AND result <> \'failed\'', ch, mode === 'test' ? 'test' : 'live', start))[0];
  return num(r.n);
}

// rehearsal or real for a run made NOW, and why
function modeFor(st, ch, status) {
  if (Comm.isRehearsal(st)) {
    const why = !st.master ? 'Outreach sending is switched OFF, so this is a rehearsal: nothing is sent.' : (st.emailTestMode !== false ? 'Test mode is ON, so this is a rehearsal: nothing is sent.' : 'This is the test copy of the app, so nothing is sent.');
    return { mode: 'test', why };
  }
  if (ch !== 'call') {
    const w = CH[ch].send;
    if (!(status[w] && status[w].configured)) return { mode: 'test', why: `${CH[ch].word} is not connected yet, so this is a rehearsal: nothing is sent.` };
  }
  return { mode: 'live', why: 'Test mode is OFF: these messages are REAL.' };
}

async function options(user, dept) {
  await ensureTables();
  const st = await S.settings();
  const status = await require('../utils/messaging').channelStatus(); // eslint-disable-line global-require
  const accounts = await accountsFor(user, st, status);
  const templates = await templatesFor(user);
  const modes = {};
  Object.keys(CH).forEach((c) => { modes[c] = modeFor(st, c, status); });
  const caps = {};
  for (const c of ['whatsapp', 'sms', 'email']) caps[c] = { limit: st[CH[c].cap], usedToday: await usedToday(c, modes[c].mode) }; // eslint-disable-line no-await-in-loop
  const k = A.kind(user);
  const types = A.isAdmin(user) ? ['candidate_lead', 'internal'] : [defaultType(user)];
  const mayAddNew = A.mayWrite(user, defaultType(user));
  const canSend = mayContactType(user, st, defaultType(user));
  const cs = await Cr.settings();
  const own = await Cr.personOf(user.id);
  let credits = null;
  try {
    const exempt = Cr.isExempt(cs, own);
    if (exempt) credits = { exempt: true, words: 'Your login has no monthly limit.' };
    else { const used = await Cr.usedBy(user.id); const allow = await Cr.allowanceOf(cs, user.id); credits = { exempt: false, left: Math.max(0, allow - used), allowance: allow, words: `${Math.max(0, allow - used)} credits left this month` }; }
  } catch { credits = null; }
  return {
    channels: Object.keys(CH).map((c) => ({ key: c, word: CH[c].word, connected: c === 'call' ? true : !!(status[CH[c].send] && status[CH[c].send].configured), connectedWhy: c === 'call' ? '' : ((status[CH[c].send] && status[CH[c].send].reason) || '') })),
    planned: Object.entries(PLANNED).map(([key, word]) => ({ key, word })),
    accounts, templates, modes, caps, credits,
    rehearsal: Comm.isRehearsal(st), testWords: Comm.isRehearsal(st) ? (!st.master ? 'Outreach sending is OFF: every send here is a rehearsal (nothing is sent).' : 'Test mode is ON: every send here is a rehearsal (nothing is sent).') : 'Test mode is OFF: sends to connected ways are REAL.',
    quiet: Quiet.describe(st.quietHours), quietState: Quiet.state(Date.now(), st.quietHours, 'job_promotion'),
    types, defaultType: defaultType(user), mayAddNew, canSend,
    canSendWhy: canSend ? '' : (k === 'hr' ? 'The HR desk may send to staff only after an Admin allows it (Omni-Channel > Settings).' : 'Only the BDE team, Team Leads, Marketing and Admins send from here.'),
    masked: A.masked(user), maxRows: MAX_ROWS, isAdmin: A.isAdmin(user),
    dept: dept || '',
  };
}

// ---- the CRM Contact Selector -----------------------------------------------------------------------------------------------------
async function contacts(user, f) {
  const ch = CH[f.channel] ? f.channel : 'whatsapp';
  const type = typeOf(user, f.type);
  const cc = CH[ch].consent;
  const only = f.agreed !== 'no' && f.agreed !== false;
  const r = await K.list(user, { type: type === 'internal' ? 'internal' : 'candidate_lead', q: f.q, channel: cc || undefined, optin: cc && only ? 'opted_in' : undefined, page: f.page, pageSize: f.pageSize });
  const rows = (r.contacts || []).map((c) => {
    const chs = c.channels || [];
    const mine = cc ? chs.find((x) => x.channel === cc) : null;
    const phoneAgreed = chs.some((x) => ['whatsapp', 'sms'].includes(x.channel) && x.optIn === 'opted_in');
    const agreed = cc ? !!(mine && mine.optIn === 'opted_in' && mine.hasAddress) : phoneAgreed;
    return { id: c.id, name: c.name, phone: c.phone, email: c.email, source: c.source, industries: c.industries, createdAt: c.createdAt, agreed, state: agreed ? 'Agreed' : (mine && mine.optIn === 'opted_out' ? 'Asked us to stop' : 'Has not agreed'), contactType: c.contactType };
  });
  return { rows, total: r.total, page: r.page, pageSize: r.pageSize, masked: r.masked, type, mayType: mayContactType(user, await S.settings(), type) };
}
// every id of the people who agreed (for "select all N"), at most 3000
async function contactIds(user, f) {
  const out = [];
  for (let page = 1; page <= 30; page += 1) {
    const r = await contacts(user, { ...f, page, pageSize: 100 }); // eslint-disable-line no-await-in-loop
    r.rows.filter((x) => x.agreed).forEach((x) => out.push(x.id));
    if (page * 100 >= r.total || out.length >= 3000) break;
  }
  return { ids: out.slice(0, 3000) };
}

// ---- the uploaded file ------------------------------------------------------------------------------------------------------------------
const norm = (h) => String(h == null ? '' : h).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
async function uploadCsv(user, buf, fileName) {
  await ensureTables();
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'The file is empty.', status: 400 };
  if (buf.length > MAX_FILE) return { error: 'That file is too big (the most is 5 MB). Split it into two files.', status: 400 };
  const file = L.readFile(buf);
  if (file.error) return { error: file.error === 'The file has no rows below the heading row.' ? 'That file has no data rows under its header.' : file.error, status: 400 };
  if (file.rows.length > MAX_ROWS) return { error: `The file has ${file.rows.length} rows. The most for one send is ${MAX_ROWS}. Split it into two files.`, status: 400 };
  const map = I.autoMap(file.headers);
  if (map.phone === undefined && map.email === undefined) return { error: 'No phone or email column found. Expected a header such as "mobile", "phone" or "email".', status: 400 };
  await run('DELETE FROM "OmniSendUpload" WHERE createdAt < ?', Date.now() - DAY);
  const id = S.newId('osu');
  await run('INSERT INTO "OmniSendUpload" (id, userId, fileName, csv, rows, createdAt) VALUES (?,?,?,?,?,?)', id, user.id, clip(fileName, 120) || 'file.csv', buf.toString('base64'), file.rows.length, Date.now());
  return { uploadId: id, fileName: clip(fileName, 120) || 'file.csv', rows: file.rows.length, headers: file.headers, phoneColumn: map.phone !== undefined ? file.headers[map.phone] : null, emailColumn: map.email !== undefined ? file.headers[map.email] : null, nameColumn: map.name !== undefined ? file.headers[map.name] : null };
}
async function getUpload(user, id) {
  const r = (await q('SELECT * FROM "OmniSendUpload" WHERE id = ? AND userId = ?', String(id || ''), user.id))[0];
  return r || null;
}

// ---- recipients: the one place that decides who is ready ----------------------------------------------------------------------
const WHY = {
  gone: 'This person was removed.', no_address: 'There is no address for this way.', bad_address: 'The address does not work.', suppressed: 'On the do-not-contact list.',
  opted_out: 'Asked us to stop on this way.', no_opt_in: 'Has not agreed to get messages on this way yet.',
};
const REASON_STATUS = { gone: 'outside', no_address: 'no_address', bad_address: 'no_address', suppressed: 'stopped', opted_out: 'stopped', no_opt_in: 'not_agreed' };
const STATUS_WORDS = {
  ready: 'Ready', new: 'Not in your Contacts yet', not_agreed: 'Has not agreed', stopped: 'Asked us to stop', no_address: 'No address for this way', invalid: 'Unusable row', duplicate: 'Repeated in the file',
  outside: 'Not yours to message', missing: 'A detail is missing', blocked: 'Not allowed',
};

async function agreed(contactId, ch) {
  if (ch === 'call') {
    const a = await C.canMessage(contactId, 'whatsapp'); if (a.ok) return a;
    const b = await C.canMessage(contactId, 'sms'); if (b.ok) return b;
    return a.reason === 'no_opt_in' && b.reason !== 'no_opt_in' ? b : a;
  }
  return C.canMessage(contactId, CH[ch].consent);
}
const firstOf = (n) => String(n || '').trim().split(/\s+/)[0] || '';

async function personOfRow(user, st, ch, one, extra) {
  const row = one.row;
  const it = { name: row.name || '', contactId: row.id, contactType: row.contactType, row, vars: extra.vars || {}, ref: extra.ref, status: 'ready', why: '' };
  if (!mayContactType(user, st, row.contactType)) { it.status = 'blocked'; it.why = row.contactType === 'internal' ? 'Staff contacts need an Admin (or the HR desk when an Admin allows it).' : 'You may not send to this kind of contact.'; return it; }
  const g = await agreed(row.id, ch);
  if (!g.ok) { it.status = REASON_STATUS[g.reason] || 'not_agreed'; it.why = WHY[g.reason] || 'Cannot be messaged on this way.'; return it; }
  if (ch === 'email' ? !row.email : !row.phoneE164) { it.status = 'no_address'; it.why = ch === 'email' ? 'There is no email address.' : 'There is no phone number.'; return it; }
  it.to = showAddr(user, ch, row);
  return it;
}

// src: { source: 'crm', contactIds } | { source: 'csv', upload }
async function resolveRecipients(user, st, ch, src) {
  const items = [];
  if (src.source === 'crm') {
    const ids = [...new Set((Array.isArray(src.contactIds) ? src.contactIds : []).map(String))].slice(0, 3000);
    let n = 0;
    for (const id of ids) {
      n += 1;
      const one = await K.getOne(user, id); // eslint-disable-line no-await-in-loop
      if (!one) { items.push({ name: '', contactId: null, status: 'outside', why: 'This person is not in your contacts.', ref: n, vars: {} }); continue; } // eslint-disable-line no-continue
      items.push(await personOfRow(user, st, ch, one, { ref: n })); // eslint-disable-line no-await-in-loop
    }
    return { items, label: 'CRM selection' };
  }
  // csv
  const file = L.readFile(Buffer.from(src.upload.csv, 'base64'));
  if (file.error) return { error: file.error };
  const map = I.autoMap(file.headers);
  const get = (r, f) => (map[f] === undefined ? '' : String(r.cells[map[f]] || '').trim());
  const used = new Set([map.phone, map.email].filter((x) => x !== undefined));
  const seenP = new Set(); const seenE = new Set();
  for (const r of file.rows) {
    const vars = {};
    let pos = 0;
    file.headers.forEach((h, i) => { const v = String(r.cells[i] == null ? '' : r.cells[i]).trim(); if (norm(h)) vars[norm(h)] = v; if (!used.has(i)) { pos += 1; vars[String(pos)] = v; } });
    const name = get(r, 'name');
    const phone = K.phoneOf(get(r, 'phone')); const email = K.emailOf(get(r, 'email'));
    const base = { name, vars, ref: r.line, status: 'ready', why: '', contactId: null };
    const wantsEmail = ch === 'email';
    if (wantsEmail ? !email.ok : !phone.ok) {
      const blank = wantsEmail ? email.blank : phone.blank;
      items.push({ ...base, status: 'invalid', why: wantsEmail ? (blank ? 'There is no email address in this row.' : (email.reason || 'The email address is not valid.')) : (blank ? 'There is no mobile number in this row.' : `Unusable number "${clip(get(r, 'phone'), 20)}"`) });
      continue; // eslint-disable-line no-continue
    }
    if ((phone.ok && seenP.has(phone.key)) || (email.ok && seenE.has(email.key))) { items.push({ ...base, status: 'duplicate', why: 'This number or email is already in an earlier row.' }); continue; } // eslint-disable-line no-continue
    if (phone.ok) seenP.add(phone.key);
    if (email.ok) seenE.add(email.key);
    const hits = await K.findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null); // eslint-disable-line no-await-in-loop
    if (!hits.length) { items.push({ ...base, status: 'new', why: 'Not in your Contacts yet. Tick the permission box to add them.', newPerson: true, to: wantsEmail ? (A.masked(user) ? core.maskEmail(email.addr) : email.addr) : (A.masked(user) ? core.maskMobile(phone.e164) : `+${phone.e164}`) }); continue; } // eslint-disable-line no-continue
    let one = null;
    for (const h of hits) { one = await K.getOne(user, h.id); if (one) break; } // eslint-disable-line no-await-in-loop
    if (!one) { items.push({ ...base, status: 'outside', why: 'This person is already in another team\'s contacts. Ask them.' }); continue; } // eslint-disable-line no-continue
    items.push(await personOfRow(user, st, ch, one, { ref: r.line, vars })); // eslint-disable-line no-await-in-loop
  }
  return { items, label: src.upload.fileName || 'CSV file', rows: file.rows.length };
}

function totalsOf(items) {
  const t = { total: items.length, ready: 0, new: 0, not_agreed: 0, stopped: 0, no_address: 0, invalid: 0, duplicate: 0, outside: 0, blocked: 0, missing: 0 };
  items.forEach((i) => { t[i.status] = (t[i.status] || 0) + 1; });
  return t;
}

// ---- the words of one message ------------------------------------------------------------------------------------------------------
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const tokensIn = (text) => { const out = []; String(text || '').replace(TOKEN, (m, k) => { const key = k.trim(); if (!out.includes(key)) out.push(key); return m; }); return out; };
function lookupFor(it, ch) {
  const row = it.row || {};
  const nm = it.name || row.name || '';
  return (key) => {
    const k = String(key).trim().toLowerCase();
    if (k === 'unsubscribe') {
      if (ch === 'email' && it.contactId) { try { const L2 = require('./links'); return L2.unsubscribeUrl(null, L2.mintUnsubscribe(it.contactId, 'email')); } catch { /* the plain words below */ } } // eslint-disable-line global-require
      return 'Reply STOP to stop.';
    }
    if (it.vars && Object.prototype.hasOwnProperty.call(it.vars, k)) return it.vars[k] === '' ? undefined : it.vars[k];
    if (k === 'name' || k === 'full_name') return nm || 'there';
    if (k === 'first_name' || k === 'firstname') return firstOf(nm) || 'there';
    if (k === 'company') return row.company || undefined;
    if (k === 'city') return row.city || undefined;
    if (k === 'skills') return row.skills || undefined;
    if (k === 'experience') return row.experience || undefined;
    return undefined;
  };
}
function fillText(text, it, ch) {
  const look = lookupFor(it, ch); const missing = [];
  const out = String(text || '').replace(TOKEN, (m, k) => { const v = look(k); if (v === undefined || v === null) { if (!missing.includes(k.trim())) missing.push(k.trim()); return ''; } return String(v); });
  return { text: out.trim(), missing };
}
const withStop = (text) => (/\bSTOP\b/i.test(text) ? text : `${text}\n\nReply STOP to stop.`);

// ---- preview ----------------------------------------------------------------------------------------------------------------------
async function sourceOf(user, b) {
  const source = b.source === 'csv' ? 'csv' : 'crm';
  if (source === 'csv') {
    const up = await getUpload(user, b.uploadId);
    if (!up) return { error: 'Upload the file again (it is only kept for a day).', status: 400 };
    return { source, upload: up };
  }
  return { source, contactIds: b.contactIds };
}
async function preview(user, b) {
  if (!mayConsole(user)) return { error: 'The Communication Console is for the BDE team, Team Leads, Marketing, HR and Admins.', status: 403 };
  await ensureTables();
  const ch = String(b.channel || '').toLowerCase();
  if (!CH[ch]) return { error: PLANNED[ch] ? `${PLANNED[ch]} sending is planned. Nothing is sent from here yet.` : 'Choose WhatsApp, SMS, Email or Voice.', status: 400 };
  const st = await S.settings();
  const src = await sourceOf(user, b);
  if (src.error) return src;
  const r = await resolveRecipients(user, st, ch, src);
  if (r.error) return { error: r.error, status: 400 };
  const body = String(b.body || '');
  const rows = r.items.slice(0, 60).map((i) => {
    const f = i.status === 'ready' && body ? fillText(body, i, ch) : null;
    return { ref: i.ref, name: i.name, to: i.to || '', status: i.status, statusWords: STATUS_WORDS[i.status], why: i.why, message: f ? scrubText(user, f.text) : '', missing: f ? f.missing : [] };
  });
  const totals = totalsOf(r.items);
  const mayNew = A.mayWrite(user, typeOf(user, b.contactType));
  return { source: src.source, label: r.label, totals, rows, mayAddNew: mayNew, needsPermission: totals.new > 0, masked: A.masked(user) };
}

// ---- send / schedule ---------------------------------------------------------------------------------------------------------------
function istMs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return Date.parse(`${s}:00+05:30`);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

async function createRun(user, b, ctx = {}) {
  if (!mayConsole(user)) return { error: 'The Communication Console is for the BDE team, Team Leads, Marketing, HR and Admins.', status: 403 };
  if (!(await S.ready())) return { error: 'Omni-Channel is being set up.', status: 503 };
  await ensureTables();
  const ch = String(b.channel || '').toLowerCase();
  const word = (CH[ch] || {}).word || PLANNED[ch];
  if (!CH[ch]) return { error: PLANNED[ch] ? `${PLANNED[ch]} sending is planned. Nothing is sent from here yet.` : 'Choose WhatsApp, SMS, Email or Voice.', status: 400 };
  const st = await S.settings();
  const status = await require('../utils/messaging').channelStatus(); // eslint-disable-line global-require
  const accounts = await accountsFor(user, st, status);
  // 1 the account
  const acc = accounts[ch].find((a) => a.id === b.accountId);
  if (!acc) return { error: ch === 'whatsapp' && accounts.whatsapp.length === 0 ? 'No WhatsApp number is assigned to you yet. Ask the Admin (Integrations > WhatsApp > Assign).' : `Select a ${word} account first`, status: 400, ...(ch === 'whatsapp' && accounts.whatsapp.length === 0 ? { code: 'NO_WHATSAPP_NUMBER' } : {}) };
  // 2 the template
  const tpls = (await templatesFor(user))[ch];
  const tpl = b.templateKey ? tpls.find((t) => t.key === b.templateKey) : null;
  if (b.templateKey && !tpl) return { error: 'That template was not found. Pick one from the list.', status: 400 };
  if (ch === 'whatsapp') {
    if (!tpl) return { error: 'Select an approved WhatsApp template', status: 400 };
    if (!tpl.approved) return { error: `"${tpl.name}" is ${tpl.statusWords}: Meta must approve it before you can send`, status: 400 };
  }
  if (ch === 'whatsapp' && String(acc.id).startsWith('wan:')) { // a template approved on another WhatsApp Business Account cannot go from this number
    try {
      const reg0 = await templateRegistered(tpl.key);
      const cfg = await require('../utils/waNumbers').configOf(String(acc.id).slice(4)); // eslint-disable-line global-require
      const bad = reg0.waName && cfg ? await require('../utils/whatsappCloud').templateAccountProblem(cfg, reg0.waName) : null; // eslint-disable-line global-require
      if (bad) return { error: bad, status: 409, code: 'TEMPLATE_OTHER_ACCOUNT' };
    } catch { /* the send checks it again */ }
  }
  if (ch === 'sms' && !tpl) return { error: 'Select an SMS template', status: 400 };
  // 3 the name
  const name = clip(b.name, 120);
  if (name.length < 2) return { error: 'Give the campaign a name', status: 400 };
  // 4 the recipients
  const src = await sourceOf(user, b);
  if (src.error) return src;
  if (src.source === 'crm' && !(Array.isArray(src.contactIds) && src.contactIds.length)) return { error: 'Pick recipients from CRM or upload a CSV', status: 400 };
  // the words: WhatsApp and SMS send the approved template exactly; Email and Voice may be edited
  const body = (ch === 'whatsapp' || ch === 'sms') ? tpl.body : (clip(b.body, 8000) || (tpl ? tpl.body : ''));
  if (!String(body).trim()) return { error: 'Write the message.', status: 400 };
  const subjectBase = ch === 'email' ? (clip(b.subject, 200) || (tpl && tpl.subject) || name) : '';
  // when
  let scheduledAt = null;
  if (b.scheduledAt !== undefined && b.scheduledAt !== null && b.scheduledAt !== '') {
    scheduledAt = istMs(b.scheduledAt);
    if (!scheduledAt) return { error: 'Pick a date and time first', status: 400 };
    if (scheduledAt < Date.now() + 30000) return { error: 'Pick a time in the future (India time).', status: 400 };
    if (scheduledAt > Date.now() + 90 * DAY) return { error: 'The most you can schedule ahead is 90 days.', status: 400 };
  }
  const { mode, why: modeWhy } = modeFor(st, ch, status);
  if (mode === 'live' && CH[ch].stop && tpl && !tpl.hasStop && (ch === 'whatsapp' || ch === 'sms')) {
    const reg0 = await templateRegistered(tpl.key);
    if ((ch === 'whatsapp' && reg0.waName) || (ch === 'sms' && reg0.dltTemplateId)) return { error: `"${tpl.name}" has no "Reply STOP" line. ${word} messages must carry one. Add it in Templates, then send.`, status: 400 };
  }

  // resolve; people who are not in Contacts yet are added through the import's own rules (permission tick + where from)
  const type = typeOf(user, b.contactType);
  let r = await resolveRecipients(user, st, ch, src);
  if (r.error) return { error: r.error, status: 400 };
  let addedPeople = 0;
  const newCount = r.items.filter((i) => i.status === 'new').length;
  const basis = clip(b.basis, 400);
  if (newCount && b.permission === true && src.source === 'csv') {
    if (!A.mayWrite(user, type)) return { error: type === 'internal' ? 'Only the HR desk and Admins add staff contacts.' : 'Only the BDE team, Team Leads and Admins can add new people. Remove those rows, or ask one of them.', status: 403 };
    if (basis.length < 5) return { error: 'Write in a few words where these people come from (for example: "Our own past candidates who gave their number").', status: 400, code: 'NO_BASIS' };
    const saved = await I.save(user, Buffer.from(src.upload.csv, 'base64'), { contactType: type, permission: true, basis, fileName: src.upload.fileName, source: `Console: ${src.upload.fileName || 'CSV'}`, dupMode: 'skip', industries: [] });
    if (saved.error && !saved.totals) return { error: saved.error, status: saved.status || 400 };
    addedPeople = saved.counts ? saved.counts.created : 0;
    r = await resolveRecipients(user, st, ch, src);
    if (r.error) return { error: r.error, status: 400 };
  }
  // the rows that are still "new" were not added (no tick): left out, and they say so
  r.items.forEach((i) => { if (i.status === 'new') { i.status = 'blocked'; i.why = 'Not in your Contacts yet, and no permission was ticked, so they were left out.'; } });

  // the words per person
  r.items.forEach((i) => {
    if (i.status !== 'ready') return;
    const f = fillText(body, i, ch);
    if (f.missing.length) { i.status = 'missing'; i.why = `Missing: ${f.missing.map((m) => `{{${m}}}`).join(', ')}`; return; }
    i.message = (CH[ch].stop && ch !== 'email') ? withStop(f.text) : f.text;
    if (ch === 'email') { const s = fillText(subjectBase, i, ch); i.subject = s.text || name; }
  });
  const ready = r.items.filter((i) => i.status === 'ready');
  const totals = totalsOf(r.items);
  if (!r.items.length || !ready.length) {
    const msg = !r.items.length ? 'That recipient source has no usable contacts' : (ch === 'email' && totals.invalid === r.items.length ? 'None of these contacts have an email address' : (ch !== 'email' && totals.invalid === r.items.length ? 'None of these contacts have a usable phone number' : 'Nobody on this list can be messaged on this way (they have not agreed, asked us to stop, or are not yours). Nothing was sent.'));
    return { error: msg, status: 400, totals };
  }

  const id = S.newId('osr');
  const now = Date.now();
  const sourceLabel = src.source === 'csv' ? (src.upload.fileName || 'CSV file') : 'CRM selection';
  const note = scheduledAt ? `Scheduled. ${modeWhy}` : modeWhy;
  await run('INSERT INTO "OmniSendRun" (id, createdById, createdByName, department, channel, accountId, accountLabel, name, templateKey, templateLabel, subject, body, source, sourceLabel, contactType, mode, status, scheduledAt, startedAt, nextAt, note, total, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, user.id, user.name, clip(ctx.dept, 60) || null, ch, acc.id, acc.name, name, tpl ? tpl.key : null, tpl ? tpl.name : null, subjectBase || null, clip(body, 8000), src.source, sourceLabel, type, mode, scheduledAt ? 'scheduled' : 'running', scheduledAt, scheduledAt ? null : now, null, clip(note, 300), r.items.length, now, now);
  // the registered WhatsApp / SMS details for a LIVE send are looked up once and kept on every row of the run (the template may change later)
  const reg = mode === 'live' && tpl ? await templateRegistered(tpl.key) : {};
  let seq = 0;
  for (let k = 0; k < r.items.length; k += 100) {
    for (const i of r.items.slice(k, k + 100)) {
      seq += 1;
      const extra = i.status === 'ready' ? { vars: ch === 'email' ? undefined : tokensIn(body).map((t) => { const v = lookupFor(i, ch)(t); return v === undefined ? '' : String(v); }), reg } : undefined;
      // eslint-disable-next-line no-await-in-loop
      await run('INSERT INTO "OmniSendRunItem" (id, runId, seq, contactId, name, status, error, subject, message, extra, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        S.newId('osi'), id, seq, i.contactId || null, clip(i.name, 120) || null, i.status === 'ready' ? 'queued' : 'skipped', i.status === 'ready' ? null : clip(`${STATUS_WORDS[i.status] || i.status}: ${i.why}`, 200), i.subject || null, i.message ? clip(i.message, 8000) : null, extra ? JSON.stringify(extra) : null, now);
    }
  }
  await run('UPDATE "OmniSendRun" SET skipped = (SELECT COUNT(*) FROM "OmniSendRunItem" WHERE runId = ? AND status = \'skipped\') WHERE id = ?', id, id);
  if (src.source === 'csv') await run('DELETE FROM "OmniSendUpload" WHERE id = ?', src.upload.id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel console send', entity: 'OmniSendRun', entityId: id, toValue: `${ch}: ${ready.length} to send, ${r.items.length - ready.length} left out, ${mode === 'test' ? 'rehearsal' : 'real'}${scheduledAt ? ', scheduled' : ''}${addedPeople ? `, ${addedPeople} people added` : ''}` });
  if (!scheduledAt) setImmediate(() => { drive(id).catch(() => {}); });
  return { ok: true, id, mode, rehearsal: mode === 'test', modeWords: modeWhy, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null, total: r.items.length, ready: ready.length, leftOut: r.items.length - ready.length, addedPeople, totals };
}

// ---- the worker ------------------------------------------------------------------------------------------------------------------------
const driving = new Set();
let recovered = false;

// the counts of a run, written in ONE statement (a read-then-write here could overwrite a newer count made at the same moment by the worker)
async function recount(runId) {
  const cnt = (cond) => `(SELECT COUNT(*) FROM "OmniSendRunItem" WHERE runId = ? AND status ${cond})`;
  await run(`UPDATE "OmniSendRun" SET sent = ${cnt("IN ('sent','task')")}, rehearsed = ${cnt("= 'rehearsed'")}, failed = ${cnt("= 'failed'")}, skipped = ${cnt("= 'skipped'")}, cancelled = ${cnt("= 'cancelled'")}, updatedAt = ? WHERE id = ?`, runId, runId, runId, runId, runId, Date.now(), runId);
  const rows = await q('SELECT status, COUNT(*) n FROM "OmniSendRunItem" WHERE runId = ? GROUP BY status', runId);
  const c = {}; rows.forEach((x) => { c[x.status] = num(x.n); });
  return { queued: (c.queued || 0), sending: (c.sending || 0), ...c };
}

async function sendOne(runRow, it, contact, chRow, st) {
  const ch = runRow.channel;
  const extra = S.parse(it.extra, {}) || {};
  const reg = extra.reg || {};
  const opts = { to: chRow.address, kind: 'bulk', actorUserId: runRow.createdById, ...(ch === 'whatsapp' && String(runRow.accountId || '').startsWith('wan:') ? { numberId: String(runRow.accountId).slice(4) } : {}), meta: { template: runRow.templateLabel || runRow.name, purpose: 'console', senderUserId: runRow.createdById, senderName: runRow.createdByName } };
  if (ch === 'email') {
    let unsub = '';
    try { const L2 = require('./links'); unsub = L2.unsubscribeUrl(null, L2.mintUnsubscribe(contact.id, 'email', it.id)); } catch { unsub = ''; } // eslint-disable-line global-require
    opts.subject = it.subject || runRow.name;
    opts.text = `${it.message}\n\n--\n${unsub ? `To stop getting these emails: ${unsub}` : 'To stop getting these emails, reply STOP.'}`;
    if (st.fromName) opts.fromName = st.fromName;
  } else if (ch === 'sms') {
    opts.text = it.message; opts.vars = extra.vars && extra.vars.length ? extra.vars : [it.message];
    if (reg.dltTemplateId) { opts.templateId = reg.dltTemplateId; opts.senderId = reg.senderId || st.smsSenderId || undefined; }
  } else {
    opts.text = it.message; opts.vars = extra.vars && extra.vars.length ? extra.vars : [it.message];
    if (reg.waName) opts.template = { name: reg.waName, language: reg.language, vars: opts.vars };
  }
  return require('../utils/messaging').send(CH[ch].send, opts); // eslint-disable-line global-require
}

async function processItem(runRow, it, ctx) {
  const { st, now } = ctx;
  const ch = runRow.channel;
  const fin = (status, error) => run('UPDATE "OmniSendRunItem" SET status = ?, error = ?, updatedAt = ?, sentAt = ? WHERE id = ?', status, error ? clip(error, 200) : null, Date.now(), ['sent', 'rehearsed', 'task'].includes(status) ? Date.now() : null, it.id);
  const contact = it.contactId ? (await q('SELECT * FROM "OutreachContact" WHERE id = ?', it.contactId))[0] : null;
  if (!contact || contact.status !== 'active') { await fin('skipped', 'This person was removed.'); return 'skipped'; }
  // checked AGAIN now: a STOP that came while the row waited is honoured
  const g = await agreed(contact.id, ch);
  if (!g.ok) { await fin('skipped', WHY[g.reason] || 'Cannot be messaged on this way now.'); return 'skipped'; }
  // quiet hours: this row waits (staff messages only when the Admin ticked it)
  const qs = Quiet.state(now, st.quietHours, contact.contactType === 'internal' ? 'internal' : 'job_promotion');
  if (qs.active) { ctx.heldUntil = Math.min(ctx.heldUntil || Infinity, qs.resumeAt); ctx.heldWhy = qs.words; await run('UPDATE "OmniSendRunItem" SET status = \'queued\', updatedAt = ? WHERE id = ?', Date.now(), it.id); return 'held'; }
  // the daily limit of this way
  if (CH[ch].cap) {
    if (ctx.used[ch] === undefined) ctx.used[ch] = await usedToday(ch, runRow.mode, now);
    const limit = st[CH[ch].cap];
    if (ctx.used[ch] >= limit) {
      ctx.heldUntil = Math.min(ctx.heldUntil || Infinity, Math.floor((now + IST) / DAY) * DAY - IST + DAY); ctx.heldWhy = `Today's limit of ${limit} ${CH[ch].word} messages is reached. The rest goes tomorrow.`;
      await run('UPDATE "OmniSendRunItem" SET status = \'queued\', updatedAt = ? WHERE id = ?', Date.now(), it.id);
      return 'held';
    }
  }
  // REHEARSAL: written and counted as a Test message, nothing is handed to any provider
  if (runRow.mode === 'test') {
    await Cr.record({ userId: runRow.createdById, channel: ch, mode: 'test', ok: true, templateLabel: runRow.templateLabel || runRow.name, source: 'console', now });
    if (CH[ch].cap) ctx.used[ch] = (ctx.used[ch] || 0) + 1;
    await fin('rehearsed', null);
    return 'rehearsed';
  }
  // REAL (Test mode is off AND the way is connected; created that way and still is)
  if (ch === 'call') {
    try {
      await require('./sequences').ensureTables(); // eslint-disable-line global-require
      await run('INSERT INTO "OmniSequenceLog" (id, runId, sequenceId, contactId, stepIndex, at, channel, outcome, note, ownerUserId) VALUES (?,?,?,?,?,?,?,?,?,?)', S.newId('osl'), null, `console:${runRow.id}`, contact.id, 0, now, 'call', 'task', clip(`Call task: ${runRow.name}${it.message ? ` - ${clip(it.message, 120)}` : ''}`, 200), runRow.createdById);
      await fin('task', null);
      return 'task';
    } catch (e) { await fin('failed', 'The call task could not be made.'); return 'failed'; }
  }
  const chRow = (await q('SELECT * FROM "OutreachContactChannel" WHERE contactId = ? AND channel = ?', contact.id, CH[ch].consent))[0];
  if (!chRow || !chRow.address) { await fin('skipped', 'There is no address for this way.'); return 'skipped'; }
  const guard = await Cr.guard({ userId: runRow.createdById, channel: ch, mode: 'live', now });
  if (!guard.ok) { await fin('failed', guard.message); return 'failed'; }
  await run('UPDATE "OmniSendRunItem" SET status = \'sending\', updatedAt = ? WHERE id = ?', Date.now(), it.id);
  let res;
  try { res = await sendOne(runRow, it, contact, chRow, st); } catch (e) { res = { ok: false, error: 'The message could not be sent.' }; }
  if (CH[ch].cap) ctx.used[ch] = (ctx.used[ch] || 0) + 1;
  if (res && res.ok) { await fin('sent', null); await Comm.noteInInbox({ id: runRow.createdById, name: runRow.createdByName }, chRow, ch, it.message, runRow.templateLabel || runRow.name); return 'sent'; }
  await fin('failed', scrubErr((res && res.error) || 'The provider did not accept it.'));
  return 'failed';
}

// one step of a run: returns 'more' (call again at once) or 'stop'
async function step(runRow) {
  const now = Date.now();
  const mark = (status, f = {}) => { const sets = ['status = ?', 'updatedAt = ?']; const ps = [status, now]; Object.entries(f).forEach(([k, v]) => { sets.push(`${k} = ?`); ps.push(v); }); return run(`UPDATE "OmniSendRun" SET ${sets.join(', ')} WHERE id = ?`, ...ps, runRow.id); };
  if (runRow.status === 'scheduled') { if (num(runRow.scheduledAt) > now) return 'stop'; await mark('running', { startedAt: now }); return 'more'; }
  if (runRow.status === 'waiting') { if (num(runRow.nextAt) > now) return 'stop'; await mark('running', { nextAt: null }); return 'more'; }
  if (runRow.status === 'stopping') {
    await run('UPDATE "OmniSendRunItem" SET status = \'cancelled\', updatedAt = ? WHERE runId = ? AND status = \'queued\'', now, runRow.id);
    const c = await recount(runRow.id);
    if (!c.sending) await mark('stopped', { finishedAt: now, note: 'Stopped. The people not reached yet were not messaged.' });
    return 'stop';
  }
  if (runRow.status !== 'running') return 'stop';
  const st = await S.settings();
  // a REAL run waits while Test mode is on; a rehearsal always rehearses
  if (runRow.mode === 'live' && Comm.isRehearsal(st)) { await mark('waiting', { nextAt: now + 60000, note: 'Waiting: Test mode (or the Outreach sending switch) is on. It goes when an Admin switches Test mode off.' }); return 'stop'; }
  // WHATSAPP NUMBERS: the number chosen for this run was switched off or taken away: the run WAITS with the reason (never sends from another number)
  if (runRow.mode === 'live' && runRow.channel === 'whatsapp' && String(runRow.accountId || '').startsWith('wan:')) {
    const ck = await require('../utils/waNumbers').recheck(String(runRow.accountId).slice(4), runRow.createdById).catch(() => ({ ok: true })); // eslint-disable-line global-require
    if (!ck.ok) { await mark('waiting', { nextAt: now + 5 * 60000, note: `Waiting: ${ck.error}` }); return 'stop'; }
  }
  const live = runRow.mode === 'live';
  const perMin = CH[runRow.channel].perMin ? st[CH[runRow.channel].perMin] : 60;
  const batch = live ? Math.max(1, Math.ceil(perMin / 12)) : 25;
  const items = await q('SELECT * FROM "OmniSendRunItem" WHERE runId = ? AND status = \'queued\' ORDER BY seq LIMIT ?', runRow.id, batch);
  const ctx = { st, now, used: {}, heldUntil: 0, heldWhy: '' };
  for (const it of items) {
    const fresh = (await q('SELECT status FROM "OmniSendRun" WHERE id = ?', runRow.id))[0];
    if (!fresh || fresh.status !== 'running') break; // stopped meanwhile
    const claimed = await run('UPDATE "OmniSendRunItem" SET status = \'sending\', updatedAt = ? WHERE id = ? AND status = \'queued\'', Date.now(), it.id); // eslint-disable-line no-await-in-loop
    if (!claimed) continue; // eslint-disable-line no-continue
    try { await processItem(runRow, it, ctx); } catch (e) { await run('UPDATE "OmniSendRunItem" SET status = \'failed\', error = ?, updatedAt = ? WHERE id = ?', 'The message could not be sent.', Date.now(), it.id); console.error('[omni-console] item:', e.message); } // eslint-disable-line no-await-in-loop, no-console
  }
  const c = await recount(runRow.id);
  const fresh = (await q('SELECT status FROM "OmniSendRun" WHERE id = ?', runRow.id))[0];
  if (!fresh || fresh.status !== 'running') return 'more';
  if (!c.queued && !c.sending) { await mark('done', { finishedAt: Date.now(), note: live ? 'Done.' : 'Done. This was a rehearsal: nothing was sent.' }); return 'stop'; }
  if (ctx.heldUntil && ctx.heldUntil !== Infinity) { await mark('waiting', { nextAt: ctx.heldUntil, note: ctx.heldWhy || 'Waiting.' }); return 'stop'; }
  if (live) return 'stop'; // a real run goes at the pace of the setting: the next batch comes with the next tick
  await sleep(15);
  return 'more';
}

async function drive(runId) {
  if (driving.has(runId)) return;
  driving.add(runId);
  try {
    for (let g = 0; g < 5000; g += 1) {
      const row = (await q('SELECT * FROM "OmniSendRun" WHERE id = ?', runId))[0]; // eslint-disable-line no-await-in-loop
      if (!row) return;
      if ((await step(row)) !== 'more') return; // eslint-disable-line no-await-in-loop
    }
  } catch (e) { console.error('[omni-console] run:', e.message); } // eslint-disable-line no-console
  finally { driving.delete(runId); }
}

async function tick() {
  if (!(await ensureTables()) || !(await S.ready())) return { ran: 0 };
  if (!recovered) {
    recovered = true;
    // rows left 'sending' by a restart: a rehearsal row goes back to the queue; a REAL one is never sent again (an unknown outcome is better than a duplicate)
    await run('UPDATE "OmniSendRunItem" SET status = \'queued\', updatedAt = ? WHERE status = \'sending\' AND runId IN (SELECT id FROM "OmniSendRun" WHERE mode = \'test\')', Date.now());
    await run('UPDATE "OmniSendRunItem" SET status = \'failed\', error = \'The app restarted while this one was sending. It was not sent again.\', updatedAt = ? WHERE status = \'sending\'', Date.now());
  }
  const rows = await q('SELECT id FROM "OmniSendRun" WHERE status IN (\'running\',\'scheduled\',\'waiting\',\'stopping\') ORDER BY createdAt LIMIT 10');
  for (const r of rows) await drive(r.id); // eslint-disable-line no-await-in-loop
  return { ran: rows.length };
}
let timer = null;
function start() {
  if (timer || process.env.OMNI_CONSOLE_OFF === '1') return;
  timer = setInterval(() => { tick().catch(() => {}); }, 5000);
  if (timer.unref) timer.unref();
}

// ---- reading runs ----------------------------------------------------------------------------------------------------------------------
const STATUS_WORD = { scheduled: 'Scheduled', running: 'Sending', waiting: 'Waiting', stopping: 'Stopping', done: 'Done', stopped: 'Stopped' };
function runView(r) {
  return {
    id: r.id, name: r.name, channel: r.channel, channelWord: (CH[r.channel] || {}).word || r.channel, accountLabel: r.accountLabel || '', templateLabel: r.templateLabel || '', source: r.source, sourceLabel: r.sourceLabel || '',
    mode: r.mode, rehearsal: r.mode === 'test', status: r.status, statusWords: STATUS_WORD[r.status] || r.status, scheduledAt: S.iso(r.scheduledAt), startedAt: S.iso(r.startedAt), finishedAt: S.iso(r.finishedAt), nextAt: S.iso(r.nextAt), note: r.note || '',
    total: num(r.total), sent: num(r.sent), rehearsed: num(r.rehearsed), failed: num(r.failed), skipped: num(r.skipped), cancelled: num(r.cancelled), createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt),
  };
}
function mayRead(user, r) {
  if (A.isAdmin(user) || r.createdById === user.id) return true;
  const k = A.kind(user);
  if (['tl', 'bdetl', 'view'].includes(k)) return A.mayDepartment(user, r.department);
  return false;
}
async function getRaw(user, id) {
  await ensureTables();
  const r = (await q('SELECT * FROM "OmniSendRun" WHERE id = ?', String(id || '')))[0];
  return r && mayRead(user, r) ? r : null;
}
async function runs(user, limit = 30) {
  await ensureTables();
  const rows = await q('SELECT * FROM "OmniSendRun" ORDER BY createdAt DESC LIMIT 300');
  return { runs: rows.filter((r) => mayRead(user, r)).slice(0, Math.min(100, limit)).map(runView) };
}
const itemView = (user, ch, i) => ({
  id: i.id, seq: num(i.seq), name: i.name || '', to: ch === 'call' || ch === 'whatsapp' || ch === 'sms' ? (i.phoneE164 ? (A.masked(user) ? core.maskMobile(i.phoneE164) : `+${i.phoneE164}`) : '') : (i.email ? (A.masked(user) ? core.maskEmail(i.email) : i.email) : ''),
  message: scrubText(user, i.message), status: i.status, error: i.error || '',
});
async function getRun(user, id, o = {}) {
  const r = await getRaw(user, id);
  if (!r) return { error: 'This send was not found.', status: 404 };
  const c = await recount(r.id);
  const total = num(r.total);
  const done = total - (c.queued || 0) - (c.sending || 0);
  const windowed = total > 200;
  const from = windowed ? Math.max(0, done - 60) : 0;
  const lim = windowed ? 72 : 200;
  const rows = await q('SELECT i.*, c.phoneE164, c.email FROM "OmniSendRunItem" i LEFT JOIN "OutreachContact" c ON c.id = i.contactId WHERE i.runId = ? ORDER BY i.seq LIMIT ? OFFSET ?', r.id, lim, from);
  const fresh = (await q('SELECT * FROM "OmniSendRun" WHERE id = ?', r.id))[0];
  return { run: runView(fresh), done, windowed, items: rows.map((i) => itemView(user, r.channel, i)), masked: A.masked(user), mayStop: ['running', 'waiting', 'scheduled'].includes(fresh.status) };
}
async function stopRun(user, id) {
  const r = await getRaw(user, id);
  if (!r) return { error: 'This send was not found.', status: 404 };
  if (!(A.isAdmin(user) || r.createdById === user.id)) return { error: 'Only the person who started this send, or an Admin, can stop it.', status: 403 };
  if (!['running', 'waiting', 'scheduled'].includes(r.status)) return { ok: 'It was already finished.', run: runView(r) };
  const now = Date.now();
  await run('UPDATE "OmniSendRun" SET status = \'stopping\', updatedAt = ? WHERE id = ?', now, r.id);
  await run('UPDATE "OmniSendRunItem" SET status = \'cancelled\', updatedAt = ? WHERE runId = ? AND status = \'queued\'', now, r.id);
  const c = await recount(r.id);
  if (!c.sending && !driving.has(r.id)) await run('UPDATE "OmniSendRun" SET status = \'stopped\', finishedAt = ?, note = \'Stopped. The people not reached yet were not messaged.\', updatedAt = ? WHERE id = ?', now, now, r.id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel console send stopped', entity: 'OmniSendRun', entityId: r.id, toValue: `${c.cancelled || 0} not reached` });
  setImmediate(() => { drive(r.id).catch(() => {}); });
  return { ok: 'Stopped after the current message.', run: runView((await q('SELECT * FROM "OmniSendRun" WHERE id = ?', r.id))[0]) };
}
async function logCsv(user, id) {
  const r = await getRaw(user, id);
  if (!r) return { error: 'This send was not found.', status: 404 };
  const safe = (v) => require('./messageLog').safeCell(v); // eslint-disable-line global-require
  const rows = await q('SELECT i.*, c.phoneE164, c.email FROM "OmniSendRunItem" i LEFT JOIN "OutreachContact" c ON c.id = i.contactId WHERE i.runId = ? ORDER BY i.seq LIMIT 5000', r.id);
  const lines = [['Name', 'To', 'Status', 'Error', 'Message'].map(safe).join(',')];
  rows.forEach((i) => { const v = itemView(user, r.channel, i); lines.push([v.name, v.to, ({ rehearsed: 'rehearsed (nothing sent)', task: 'call task made' })[v.status] || v.status, v.error, v.message].map(safe).join(',')); });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel console log downloaded', entity: 'OmniSendRun', entityId: r.id, toValue: `${rows.length} rows${A.masked(user) ? ' (masked)' : ''}` });
  const slug = String(r.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'send';
  return { csv: `﻿${lines.join('\r\n')}\r\n`, fileName: `${slug}-log.csv` };
}
function sampleCsv(channel) {
  const ch = CH[channel] ? channel : 'whatsapp';
  const rows = ch === 'email' ? [['name', 'email', 'city'], ['Anita Rao', 'anita@example.test', 'Hyderabad'], ['Ravi Kumar', 'ravi@example.test', 'Vijayawada']] : [['name', 'mobile', 'city'], ['Anita Rao', '9000000001', 'Hyderabad'], ['Ravi Kumar', '9000000002', 'Vijayawada']];
  return { csv: `${rows.map((r) => r.join(',')).join('\r\n')}\r\n`, fileName: `sample-${ch}.csv` };
}

module.exports = {
  CH, PLANNED, STATUS_WORDS, MAX_ROWS, MAX_FILE, ensureTables, options, contacts, contactIds, uploadCsv, preview, createRun, tick, start, drive,
  runs, getRun, stopRun, logCsv, sampleCsv, fillText, tokensIn, modeFor, mayContactType, resolveRecipients,
};
