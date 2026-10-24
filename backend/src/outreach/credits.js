// ---------------------------------------------------------------------------
// OMNI-CHANNEL CREDITS + ACTIVITY PER PERSON (founder note (g), 2026-10-17).
//
// CREDITS (simple, every rule editable by an Admin in Omni-Channel > Settings > Credits; AppSetting 'omni.credits'):
//   allowance      message credits per person per MONTH (default 200); one person can have their own number (OmniCreditAllowance)
//   cost           credits per message by channel: email 1, whatsapp 1, sms 1, call 0 (a logged call costs nothing)
//   exemptRoles    logins that are never blocked and have no limit: SUPER_ADMIN, ADMIN (default)
//   exemptUserIds  any single person an Admin wants exempt too
//   enforce        true = a REAL send is blocked when the credits are used up (plain message); false = only counted
// Every send is written once to OmniCreditLedger (self-provisioned, raw SQL, no Prisma model): who, when, channel, credits, campaign / template,
// result, and mode. TEST-mode sends (rehearsals / sandbox) are written with mode 'test': counted and shown apart, they never use real credits.
// Two doors are hooked, each ONCE: utils/messaging.js send() (Email / SMS / WhatsApp for ATS, HRMS, Accounts, the Inbox reply box, bulk jobs)
// and outreach/runner.js (Omni-Channel campaigns). A send with no known person (system mail) is written as 'system' and never blocked.
// record() / guard() never throw: a ledger problem must never stop a message that was allowed.
//
// ACTIVITY per person for a month: credits given / used / left, messages per channel, follow-ups done (ApplicationFollowUp completed by the
// person), promotions (job-promotion campaigns the person launched), joinings (utils/recruiterJoinings.js: the same count as HRMS).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const IST = 5.5 * 3600 * 1000;

const CHANNELS = ['email', 'whatsapp', 'sms', 'call'];
const CHANNEL_WORD = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', call: 'Call' };
const DEFAULTS = { enforce: true, allowance: 200, cost: { email: 1, whatsapp: 1, sms: 1, call: 0 }, exemptRoles: ['SUPER_ADMIN', 'ADMIN'], exemptUserIds: [], unitCost: { email: 0, whatsapp: 0, sms: 0, callPerMinute: 0 } };

// ---- tables ----------------------------------------------------------------
const DDL = [
  'CREATE TABLE IF NOT EXISTS "OmniCreditLedger" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT, "userName" TEXT, "department" TEXT, "at" INTEGER NOT NULL, "channel" TEXT NOT NULL, "credits" INTEGER NOT NULL DEFAULT 0, "mode" TEXT NOT NULL DEFAULT \'live\', "campaignId" TEXT, "templateLabel" TEXT, "result" TEXT, "source" TEXT)',
  'CREATE INDEX IF NOT EXISTS "OmniCreditLedger_user_at_idx" ON "OmniCreditLedger"("userId", "at")',
  'CREATE INDEX IF NOT EXISTS "OmniCreditLedger_at_idx" ON "OmniCreditLedger"("at")',
  'CREATE TABLE IF NOT EXISTS "OmniRecharge" ("id" TEXT NOT NULL PRIMARY KEY, "at" INTEGER NOT NULL, "channel" TEXT NOT NULL, "amount" INTEGER NOT NULL, "costRupees" REAL NOT NULL DEFAULT 0, "note" TEXT, "byId" TEXT, "byName" TEXT)',
  'CREATE TABLE IF NOT EXISTS "OmniCreditAllowance" ("userId" TEXT NOT NULL PRIMARY KEY, "allowance" INTEGER NOT NULL, "note" TEXT, "setById" TEXT, "setByName" TEXT, "updatedAt" INTEGER NOT NULL DEFAULT 0)',
];
let ensuring = null; let okAt = 0;
async function ensureTables() {
  if (okAt) return true;
  if (!ensuring) {
    ensuring = (async () => {
      try { for (const sql of DDL) await run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-credits] tables:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
      finally { ensuring = null; }
    })();
  }
  return ensuring;
}

// ---- settings ------------------------------------------------------------------
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const whole = (v, d, max = 100000) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };
function clean(s) {
  const b = s && typeof s === 'object' ? s : {};
  const cost = {};
  CHANNELS.forEach((c) => { cost[c] = whole(b.cost && b.cost[c], DEFAULTS.cost[c], 100); });
  return {
    enforce: b.enforce !== false,
    allowance: whole(b.allowance, DEFAULTS.allowance),
    cost,
    exemptRoles: Array.isArray(b.exemptRoles) ? [...new Set(b.exemptRoles.map((x) => String(x).trim().toUpperCase()).filter(Boolean))].slice(0, 20) : DEFAULTS.exemptRoles,
    unitCost: Object.fromEntries(['email', 'whatsapp', 'sms', 'callPerMinute'].map((c) => [c, (() => { const n = Number(b.unitCost && b.unitCost[c]); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : 0; })()])),
    exemptUserIds: Array.isArray(b.exemptUserIds) ? [...new Set(b.exemptUserIds.map((x) => String(x).trim()).filter(Boolean))].slice(0, 200) : [],
  };
}
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'omni.credits' } }).catch(() => null);
  return clean(row ? parse(row.value, {}) : {});
}
async function saveSettings(input, user) {
  const cur = await settings();
  const merged = clean({ ...cur, ...(input || {}), cost: { ...cur.cost, ...((input && input.cost) || {}) }, unitCost: { ...cur.unitCost, ...((input && input.unitCost) || {}) } });
  const v = JSON.stringify(merged);
  await prisma.appSetting.upsert({ where: { key: 'omni.credits' }, create: { key: 'omni.credits', value: v, updatedById: user && user.id, updatedByName: user && user.name }, update: { value: v, updatedById: user && user.id, updatedByName: user && user.name } });
  return merged;
}
async function setAllowance(userId, allowance, note, by) {
  await ensureTables();
  if (allowance === null || allowance === '' || allowance === undefined) { await run('DELETE FROM "OmniCreditAllowance" WHERE userId = ?', userId); return { cleared: true }; }
  const n = whole(allowance, null);
  if (n === null) return { error: 'Type a whole number of credits (0 or more).' };
  await run('INSERT INTO "OmniCreditAllowance" (userId, allowance, note, setById, setByName, updatedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET allowance = excluded.allowance, note = excluded.note, setById = excluded.setById, setByName = excluded.setByName, updatedAt = excluded.updatedAt',
    userId, n, clip(note, 200) || null, by && by.id, by && by.name, Date.now());
  return { allowance: n };
}

// ---- months (India time) -----------------------------------------------------------
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const thisMonth = (now = Date.now()) => new Date(now + IST).toISOString().slice(0, 7);
function range(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: Date.UTC(y, m - 1, 1) - IST, to: Date.UTC(y, m, 1) - IST };
}

// ---- people ----------------------------------------------------------------------------
async function personOf(userId) {
  if (!userId) return null;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, atsRole: true, status: true } }).catch(() => null);
  if (!u) return null;
  const e = await prisma.employee.findUnique({ where: { userId }, select: { name: true, department: true } }).catch(() => null);
  return { id: u.id, name: (e && e.name) || u.name, role: u.role, atsRole: u.atsRole, department: (e && e.department) || null };
}
function isExempt(st, p) {
  if (!p) return true; // nobody to charge
  return st.exemptUserIds.includes(p.id) || st.exemptRoles.includes(String(p.role || '').toUpperCase()) || st.exemptRoles.includes(String(p.atsRole || '').toUpperCase());
}
async function allowanceOf(st, userId) {
  const r = (await q('SELECT allowance FROM "OmniCreditAllowance" WHERE userId = ?', userId))[0];
  return r ? num(r.allowance) : st.allowance;
}
async function usedBy(userId, month = thisMonth()) {
  const { from, to } = range(month);
  const r = (await q('SELECT COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE userId = ? AND mode = \'live\' AND at >= ? AND at < ?', userId, from, to))[0];
  return num(r.c);
}

// ---- the two hooks ---------------------------------------------------------------------------
// guard: may this person send ONE more message on this channel now? ({ ok } | { ok:false, message, left, allowance })
async function guard({ userId, channel, mode = 'live', now = Date.now() }) {
  try {
    if (mode === 'test' || !userId) return { ok: true };
    const ch = String(channel || '').toLowerCase();
    const st = await settings();
    const cost = st.cost[ch] || 0;
    if (!st.enforce || !cost) return { ok: true };
    await ensureTables();
    const p = await personOf(userId);
    if (isExempt(st, p)) return { ok: true };
    const allowance = await allowanceOf(st, userId);
    const used = await usedBy(userId, thisMonth(now));
    if (used + cost > allowance) return { ok: false, allowance, used, left: Math.max(0, allowance - used), message: `You have used all ${allowance} credits this month. Ask an Admin for more.` };
    return { ok: true };
  } catch { return { ok: true }; }
}
// record: one ledger row. result: 'sent' | 'failed' | 'test'. Credits are charged only for a message that really went (or was captured in Test mode, shown apart).
async function record({ userId = null, channel, mode = 'live', ok = true, campaignId = null, templateLabel = null, source = null, now = Date.now() }) {
  try {
    const ch = String(channel || '').toLowerCase();
    if (!CHANNELS.includes(ch)) return null;
    if (!(await ensureTables())) return null;
    const st = await settings();
    const p = await personOf(userId);
    const credits = ok ? (st.cost[ch] || 0) : 0;
    const id = newId('ocl');
    await run('INSERT INTO "OmniCreditLedger" (id, userId, userName, department, at, channel, credits, mode, campaignId, templateLabel, result, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, userId, p ? p.name : 'System', p ? p.department : null, now, ch, credits, mode === 'test' ? 'test' : 'live', campaignId, clip(templateLabel, 120) || null, mode === 'test' ? 'test' : (ok ? 'sent' : 'failed'), clip(source, 40) || null);
    return id;
  } catch (e) { console.error('[omni-credits] record:', e.message); return null; } // eslint-disable-line no-console
}

// ---- activity ---------------------------------------------------------------------------------
// who = { all: bool, departments: [lower-case] } (access.deptScope) ; selfId = the viewer (a person who is neither lead nor admin gets only themselves)
async function activity(month, { all = false, departments = [], onlyUserId = null, userIds = null } = {}) {
  await ensureTables();
  const m = isMonth(month) ? month : thisMonth();
  const { from, to } = range(m);
  const st = await settings();
  const emps = await prisma.employee.findMany({ where: { userId: { not: null } }, select: { userId: true, name: true, department: true, employeeCode: true } });
  let people = emps.filter((e) => {
    if (onlyUserId) return e.userId === onlyUserId;
    if (userIds) return userIds.has(e.userId);
    return all || departments.includes(String(e.department || '').toLowerCase());
  });
  const users = await prisma.user.findMany({ where: { id: { in: people.map((e) => e.userId) } }, select: { id: true, role: true, atsRole: true, status: true } });
  const uBy = new Map(users.map((u) => [u.id, u]));
  people = people.filter((e) => uBy.has(e.userId) && (uBy.get(e.userId).status === 'Active' || onlyUserId));
  const ids = new Set(people.map((e) => e.userId));

  const ledger = await q('SELECT userId, channel, mode, COUNT(*) n, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND userId IS NOT NULL AND result <> \'failed\' GROUP BY userId, channel, mode', from, to);
  const allow = await q('SELECT userId, allowance FROM "OmniCreditAllowance"');
  const allowBy = new Map(allow.map((r) => [r.userId, num(r.allowance)]));
  const fu = await prisma.applicationFollowUp.groupBy({ by: ['completedById'], where: { completedAt: { gte: new Date(from), lt: new Date(to) }, completedById: { not: null } }, _count: { _all: true } });
  const fuBy = new Map(fu.map((r) => [r.completedById, r._count._all]));
  let promoRows = [];
  try { promoRows = await q('SELECT createdById u, COUNT(*) n FROM "OutreachCampaign" WHERE type = \'job_promotion\' AND status <> \'draft\' AND COALESCE(startedAt, createdAt) >= ? AND COALESCE(startedAt, createdAt) < ? GROUP BY createdById', from, to); } catch { promoRows = []; }
  const promoBy = new Map(promoRows.map((r) => [r.u, num(r.n)]));
  const joinBy = new Map();
  try {
    const RJ = require('../utils/recruiterJoinings'); // eslint-disable-line global-require
    const board = await RJ.monthBoard(m);
    board.rows.forEach((r) => { if (r.userId) joinBy.set(r.userId, (joinBy.get(r.userId) || 0) + (r.joinings || 0)); });
  } catch { /* the joinings count is optional here */ }

  const rows = people.map((e) => {
    const u = uBy.get(e.userId);
    const exempt = isExempt(st, { id: e.userId, role: u.role, atsRole: u.atsRole });
    const per = {}; CHANNELS.forEach((c) => { per[c] = 0; });
    const testPer = {}; CHANNELS.forEach((c) => { testPer[c] = 0; });
    let used = 0;
    ledger.filter((r) => r.userId === e.userId).forEach((r) => {
      if (r.mode === 'live') { per[r.channel] += num(r.n); used += num(r.c); } else testPer[r.channel] += num(r.n);
    });
    const given = exempt ? null : (allowBy.has(e.userId) ? allowBy.get(e.userId) : st.allowance);
    return {
      userId: e.userId, name: e.name, code: e.employeeCode, department: e.department || '',
      exempt, given, used, left: given === null ? null : Math.max(0, given - used),
      email: per.email, whatsapp: per.whatsapp, sms: per.sms, call: per.call, sent: per.email + per.whatsapp + per.sms + per.call,
      testSent: Object.values(testPer).reduce((a, b) => a + b, 0),
      followUps: fuBy.get(e.userId) || 0, promotions: promoBy.get(e.userId) || 0, joinings: joinBy.get(e.userId) || 0,
      ownAllowance: allowBy.has(e.userId) ? allowBy.get(e.userId) : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    month: m, rows, ids: [...ids],
    totals: { people: rows.length, used: sum('used'), sent: sum('sent'), testSent: sum('testSent'), followUps: sum('followUps'), promotions: sum('promotions'), joinings: sum('joinings') },
    rules: { allowance: st.allowance, cost: st.cost, enforce: st.enforce },
  };
}

function csv(act) {
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Name', 'Employee code', 'Department', 'Credits given', 'Credits used', 'Credits left', 'Emails', 'WhatsApp', 'SMS', 'Calls logged', 'Test messages', 'Follow-ups done', 'Promotions', 'Joinings'];
  const lines = [head.join(',')];
  act.rows.forEach((r) => lines.push([r.name, r.code, r.department, r.given === null ? 'No limit' : r.given, r.used, r.left === null ? 'No limit' : r.left, r.email, r.whatsapp, r.sms, r.call, r.testSent, r.followUps, r.promotions, r.joinings].map(esc).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { range, CHANNELS, CHANNEL_WORD, DEFAULTS, ensureTables, settings, saveSettings, setAllowance, guard, record, activity, csv, isMonth, thisMonth, usedBy, allowanceOf, personOf, isExempt, clean };
