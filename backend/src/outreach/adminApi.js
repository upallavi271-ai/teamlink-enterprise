// ---------------------------------------------------------------------------
// OMNI-CHANNEL ADMINISTRATION (Green Start rebuild, 2026-10-17): the answers behind the four Administration pages
//   Team & Roles   members (people of the login's own scope, with their credits and last activity), the real role table, the audit rows
//   Billing        "Your credits" for everybody; the company view (usage, balance, recharges, cost per message) for Admin and Finance
//   Super Admin    "organisations" = departments (workspaces): people, credits, messages, grant credits, the real feature switches
//   Settings       connection health rows, WhatsApp numbers per department, the extra sending limits, opt-out counts and list
//   Workspaces     the Organization Workspace modal in the top bar (+ Create Organization = a department name added to the Omni list)
// READ ONLY unless a function says it changes something; every change is audited with ids and counts, never a phone or an email.
// Nothing here sends a message.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const Cr = require('./credits');
const Ins = require('./insights');
const Cfg = require('./config');
const Pol = require('./policy');
const Chrome = require('./chrome');
const Conn = require('./connections');
const { logAudit } = require('../utils/audit');

const num = S.num;
const clip = S.clip;
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const ph = (n) => new Array(n).fill('?').join(',');
const csvEsc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvOf = (head, rows) => `﻿${[head.map(csvEsc).join(','), ...rows.map((r) => r.map(csvEsc).join(','))].join('\r\n')}\r\n`;
// no email and no phone number may reach a screen or a file made from the audit rows
const hide = (s) => String(s == null ? '' : s).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[hidden]').replace(/\+?\d(?:[\s-]?\d){9,}/g, '[hidden]');
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------------------------
// who may open what (the server decides; the pages only hide)
// ---------------------------------------------------------------------------------------------------------------------------------
const mayTeam = (u) => A.pagesFor(u).includes('team');
const levelWords = (u) => A.LEVEL_WORDS[A.level(u)] || '';

// level / kind / pages of ANY login, from the same code that decides it for that login (cached a minute)
const accessCache = new Map();
async function accessOf(userId) {
  const hit = accessCache.get(userId);
  if (hit && Date.now() - hit.at < 60000) return hit;
  let v = { level: 'none', kind: 'none', pages: [] };
  try {
    const idn = await require('../utils/identity').resolveIdentity(userId); // eslint-disable-line global-require
    if (idn) v = { level: A.level(idn), kind: A.kind(idn), pages: A.pagesFor(idn) };
  } catch { /* stays "none" */ }
  const out = { at: Date.now(), ...v };
  accessCache.set(userId, out);
  return out;
}
const monthOf = (m) => (Cr.isMonth(m) ? m : Cr.thisMonth());
function lastMonths(n = 6) {
  const out = []; const [y0, m0] = Cr.thisMonth().split('-').map(Number);
  for (let i = 0; i < n; i += 1) { const d = new Date(Date.UTC(y0, m0 - 1 - i, 1)); out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// TEAM & ROLES
// ---------------------------------------------------------------------------------------------------------------------------------
async function members(user, { month, dept, q } = {}) {
  const m = monthOf(month);
  const sc = await Ins.scopeOf(user);
  const act = await Cr.activity(m, Ins.actOpts(sc));
  let rows = act.rows;
  if (dept) rows = rows.filter((r) => lc(r.department) === lc(dept));
  const needle = lc(q);
  if (needle) rows = rows.filter((r) => [r.name, r.code, r.department].some((x) => lc(x).includes(needle)));
  const ids = rows.map((r) => r.userId);
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, lastLoginAt: true } }) : [];
  const uBy = new Map(users.map((u) => [u.id, u]));
  const last = ids.length ? await S.q(`SELECT userId, MAX(at) at FROM "OmniCreditLedger" WHERE userId IN (${ph(ids.length)}) GROUP BY userId`, ...ids) : [];
  const lastBy = new Map(last.map((r) => [r.userId, num(r.at)]));
  const admin = A.isAdmin(user);
  const out = [];
  let hidden = 0;
  for (const r of rows) {
    const acc = await accessOf(r.userId); // eslint-disable-line no-await-in-loop
    if (acc.level === 'none') { hidden += 1; continue; } // eslint-disable-line no-continue
    const u = uBy.get(r.userId) || {};
    const lastSend = lastBy.get(r.userId) || null;
    const lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).getTime() : null;
    const best = Math.max(lastSend || 0, lastLogin || 0) || null;
    out.push({
      userId: r.userId, name: r.name, code: r.code || '', department: r.department || '', level: acc.level, levelWords: A.LEVEL_WORDS[acc.level] || acc.level,
      email: admin ? (u.email || '') : '', exempt: r.exempt, given: r.given, used: r.used, left: r.left, sent: r.sent, testSent: r.testSent,
      lastActive: best ? new Date(best).toISOString() : null, lastLogin: lastLogin ? new Date(lastLogin).toISOString() : null, lastSend: lastSend ? new Date(lastSend).toISOString() : null,
    });
  }
  const sum = (k) => out.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    month: m, scopeWords: sc.words, rows: out, hiddenNoAccess: hidden, months: lastMonths(6),
    totals: { people: out.length, used: sum('used'), sent: sum('sent'), testSent: sum('testSent') },
    inviteWords: 'People are added in Administration > Users (one person, one login). Anyone whose role can use Omni-Channel appears here by themselves.',
  };
}

// the real role table (access.js), the hubs of each level, and which Omni-Channel pages each level really gets (read from real logins)
async function rolesView(user) {
  const table = A.rolesTable();
  const levels = Object.entries(A.LEVEL_WORDS).filter(([k]) => k !== 'none').map(([id, words]) => ({ id, words, hubs: A.hubsForLevel(id) }));
  const emps = await prisma.employee.findMany({ where: { userId: { not: null }, employmentStatus: 'Active' }, select: { userId: true }, take: 500 }).catch(() => []);
  const byLevel = {}; const people = {};
  for (const e of emps) {
    const acc = await accessOf(e.userId); // eslint-disable-line no-await-in-loop
    if (acc.level === 'none') continue; // eslint-disable-line no-continue
    people[acc.level] = (people[acc.level] || 0) + 1;
    byLevel[acc.level] = [...new Set([...(byLevel[acc.level] || []), ...acc.pages])];
  }
  const cfg = await Cfg.permissions(user).catch(() => ({ marketing: [], marketingWords: '' }));
  return {
    table, levels, pagesByLevel: byLevel, peopleByLevel: people, yourLevel: A.level(user), yourPages: A.pagesFor(user),
    marketing: cfg.marketing || [], marketingWords: cfg.marketingWords || '', approval: await Pol.approval(), canEdit: A.isAdmin(user),
    approvalWords: 'ON: a campaign made by a BDE waits for a Team Lead, BDE TL or Admin to approve it before Send. OFF: a BDE may send straight away. Default OFF.',
  };
}

// the Omni-Channel rows of the audit log (who, what, when). An Admin sees all; a Department Head / Team Lead sees what the people of their own scope did.
async function auditRows(user, { q, from, to, page = 1, pageSize = 25, all = false } = {}) {
  // 2026-10-17: the shared library, app campaigns and the reply router write their rows under their own entity names
  const where = { AND: [{ OR: [{ action: { startsWith: 'Omni-Channel' } }, { action: { startsWith: 'Outreach' } }, { entity: { in: ['OmniTemplate', 'OmniTemplateLibrary', 'OmniAppCampaign', 'OmniProviderEvent'] } }] }] };
  const sc = await Ins.scopeOf(user);
  if (!sc.all) {
    const act = await Cr.activity(Cr.thisMonth(), Ins.actOpts(sc));
    where.AND.push({ userId: { in: [...new Set([user.id, ...act.rows.map((r) => r.userId)])] } });
  }
  const t = clip(q, 80);
  if (t) where.AND.push({ OR: [{ action: { contains: t } }, { actorName: { contains: t } }, { toValue: { contains: t } }, { entity: { contains: t } }] });
  const day = (v, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00'}+05:30`) : null);
  const f = day(from, false); const tt = day(to, true);
  if (f || tt) where.AND.push({ createdAt: { ...(f ? { gte: f } : {}), ...(tt ? { lte: tt } : {}) } });
  const total = await prisma.auditLog.count({ where });
  const size = all ? 5000 : Math.min(100, Math.max(5, Number(pageSize) || 25));
  const pg = all ? 1 : Math.max(1, Number(page) || 1);
  const list = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (pg - 1) * size, take: size, select: { id: true, createdAt: true, actorName: true, action: true, entity: true, toValue: true, user: { select: { name: true } } } });
  const rows = list.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), who: r.actorName || (r.user && r.user.name) || 'System', action: hide(r.action), detail: hide(r.toValue || ''), entity: r.entity }));
  return { rows, total, page: pg, pageSize: size, canExport: A.isAdmin(user), scopeWords: sc.words };
}
async function auditCsv(user, f) {
  const out = await auditRows(user, { ...f, all: true });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel audit log downloaded', entity: 'OmniAudit', entityId: 'log', toValue: `${out.rows.length} rows` });
  return { count: out.rows.length, csv: csvOf(['When (India time)', 'Who', 'What happened', 'Detail'], out.rows.map((r) => [new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), r.who, r.action, r.detail])) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// BILLING ("Plan & usage")
// ---------------------------------------------------------------------------------------------------------------------------------
// call minutes: only when the Campaigns side records them (OutreachMessage.callMinutes, channel 'call'); otherwise "not recorded"
async function callMinutes(month, userId) {
  try {
    if (!(await S.campaignsReady())) return { recorded: false };
    const cols = await S.q('PRAGMA table_info("OutreachMessage")');
    if (!cols.some((c) => c.name === 'callMinutes')) return { recorded: false };
    const { from, to } = Cr.range(month);
    const rows = await S.q(`SELECT c.createdById u, c.createdByName n, COUNT(*) calls, COALESCE(SUM(m.callMinutes),0) mins FROM "OutreachMessage" m JOIN "OutreachCampaign" c ON c.id = m.campaignId WHERE m.channel = 'call' AND m.callMinutes IS NOT NULL AND COALESCE(m.sentAt, m.queuedAt) >= ? AND COALESCE(m.sentAt, m.queuedAt) < ? ${userId ? 'AND c.createdById = ?' : ''} GROUP BY c.createdById, c.createdByName`, from, to, ...(userId ? [userId] : []));
    if (!rows.length) return { recorded: false };
    return { recorded: true, total: rows.reduce((n, r) => n + num(r.mins), 0), rows: rows.map((r) => ({ userId: r.u, name: r.n || 'Unknown', calls: num(r.calls), minutes: num(r.mins) })).sort((a, b) => b.minutes - a.minutes) };
  } catch { return { recorded: false }; }
}

async function mine(user, month) {
  await Cr.ensureTables();
  const st = await Cr.settings();
  const p = await Cr.personOf(user.id);
  const exempt = Cr.isExempt(st, p);
  const { from, to } = Cr.range(month);
  const per = await S.q('SELECT channel, mode, result, COUNT(*) n, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE userId = ? AND at >= ? AND at < ? GROUP BY channel, mode, result', user.id, from, to);
  const ch = {}; Cr.CHANNELS.forEach((c) => { ch[c] = { channel: c, word: Cr.CHANNEL_WORD[c], messages: 0, credits: 0, failed: 0, testMessages: 0 }; });
  per.forEach((r) => {
    const o = ch[r.channel]; if (!o) return;
    if (r.mode === 'test') o.testMessages += num(r.n);
    else if (r.result === 'failed') o.failed += num(r.n);
    else { o.messages += num(r.n); o.credits += num(r.c); }
  });
  const used = Object.values(ch).reduce((n, c) => n + c.credits, 0);
  const given = exempt ? null : await Cr.allowanceOf(st, user.id);
  const calls = await callMinutes(month, user.id);
  return {
    month, exempt, given, used, left: given === null ? null : Math.max(0, given - used), channels: Object.values(ch), cost: st.cost, enforce: st.enforce,
    testMessages: Object.values(ch).reduce((n, c) => n + c.testMessages, 0), calls: calls.recorded ? { recorded: true, minutes: calls.total } : { recorded: false },
    words: exempt ? 'Your login has no monthly credit limit.' : `You were given ${given} credits for ${month} and used ${used}.`,
  };
}

async function company(month) {
  const u = await Ins.usage(month);
  const st = await Cr.settings();
  const act = await Cr.activity(month, { all: true });
  const calls = await callMinutes(month, null);
  const boughtAny = u.balance.some((b) => b.bought > 0);
  const messages = u.channels.reduce((n, c) => n + c.messages, 0);
  const credits = u.channels.reduce((n, c) => n + c.credits, 0);
  const left = u.balance.reduce((n, b) => n + (b.channel === 'call' ? 0 : b.left), 0);
  return {
    ...u, settings: st, channelWords: Cr.CHANNEL_WORD, messages, creditsUsed: credits, balanceKnown: boughtAny, balanceLeft: boughtAny ? left : null,
    people: act.rows.map((r) => ({ userId: r.userId, name: r.name, department: r.department, exempt: r.exempt, given: r.given, used: r.used, left: r.left, ownAllowance: r.ownAllowance, sent: r.sent, testSent: r.testSent })),
    calls,
  };
}

async function billing(user, month) {
  const m = monthOf(month);
  const lvl = A.level(user);
  const out = {
    month: m, months: lastMonths(6), level: lvl,
    plan: { name: 'Included in TeamLink', words: 'TeamLink has no paid plan: Omni-Channel is part of your TeamLink. What you pay for is the messages themselves (the credits below).', price: null },
    planned: ['Auto top-up', 'Payment methods', 'Invoices'],
  };
  if (lvl !== 'finance') out.mine = await mine(user, m);
  if (lvl === 'admin' || lvl === 'finance') out.company = await company(m);
  out.canRecharge = lvl === 'admin'; out.canEditRules = lvl === 'admin';
  return out;
}
async function usageCsv(user, month) {
  const m = monthOf(month);
  const u = await Ins.usage(m);
  const st = await Cr.settings();
  const rows = u.channels.map((c) => [Cr.CHANNEL_WORD[c.channel], c.messages, c.testMessages, c.credits, st.cost[c.channel], (c.channel === 'call' ? st.unitCost.callPerMinute : st.unitCost[c.channel]) || 0, c.cost]);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel usage downloaded', entity: 'OmniUsage', entityId: m, toValue: `${rows.length} channels` });
  return { csv: csvOf(['Channel', 'Messages really sent', 'Test messages (not charged)', 'Credits used', 'Credits per message', 'Cost per message (Rs)', 'Cost (Rs)'], rows), month: m };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ORGANISATIONS = departments (workspaces): the modal in the top bar and the Super Admin table
// ---------------------------------------------------------------------------------------------------------------------------------
async function orgRows(user, month) {
  const m = monthOf(month);
  const ws = await Chrome.workspaces(user);
  const act = await Cr.activity(m, { all: true });
  const cfg = await Cfg.departments().catch(() => ({ rows: [] }));
  const cfgBy = new Map((cfg.rows || []).map((r) => [lc(r.name), r]));
  const rows = ws.list.map((w) => {
    const key = lc(w.name);
    const ppl = act.rows.filter((r) => lc(r.department) === key);
    const c = cfgBy.get(key) || {};
    const given = ppl.reduce((n, r) => n + (r.given || 0), 0);
    const used = ppl.reduce((n, r) => n + r.used, 0);
    return {
      name: w.name, people: w.people || 0, logins: ppl.length, creditsUsed: used, creditsGiven: given, creditsLeft: ppl.reduce((n, r) => n + (r.left || 0), 0),
      messages: ppl.reduce((n, r) => n + r.sent, 0), testMessages: ppl.reduce((n, r) => n + r.testSent, 0), zeroCredit: ppl.filter((r) => r.given !== null && r.left === 0).length,
      status: (w.people || 0) > 0 ? 'Active' : 'No people yet', whatsapp: c.whatsapp !== false, headName: c.headName || '', inMaster: c.inMaster !== false, added: c.inMaster === false,
    };
  });
  if (ws.all) {
    const known = new Set(ws.list.map((w) => lc(w.name)));
    const loose = act.rows.filter((r) => !known.has(lc(r.department)));
    if (loose.length) rows.push({ name: 'No department', people: loose.length, logins: loose.length, creditsUsed: loose.reduce((n, r) => n + r.used, 0), creditsGiven: loose.reduce((n, r) => n + (r.given || 0), 0), creditsLeft: loose.reduce((n, r) => n + (r.left || 0), 0), messages: loose.reduce((n, r) => n + r.sent, 0), testMessages: loose.reduce((n, r) => n + r.testSent, 0), zeroCredit: 0, status: 'Active', whatsapp: true, headName: '', inMaster: false, added: false, noDept: true });
  }
  return { month: m, months: lastMonths(6), rows, all: ws.all, role: A.LEVEL_WORDS[A.level(user)] || '' };
}
async function orgOverview(user, month) {
  const o = await orgRows(user, month);
  return { ...o, yourRole: o.role, canCreate: A.isAdmin(user), note: 'Campaigns, customers, templates and channel accounts belong to the department you open. Picking one narrows every Omni-Channel page to it.' };
}
async function createOrg(user, nameIn) {
  if (!A.isAdmin(user)) return { error: 'Only an Admin can create an organization.', status: 403 };
  const name = clip(nameIn, 80);
  if (!name) return { error: 'Give the organization a name.', status: 400 };
  if (name.length < 2) return { error: 'That name is too short.', status: 400 };
  const cur = await Cfg.departments();
  if (cur.rows.some((r) => lc(r.name) === lc(name))) return { error: `You already have an organization called "${name}".`, status: 400 };
  const extra = [...cur.rows.filter((r) => !r.inMaster).map((r) => r.name), name];
  const rows = [...cur.rows.map((r) => ({ name: r.name, head: r.head, whatsapp: r.whatsapp })), { name, head: null, whatsapp: true }];
  const out = await Cfg.saveDepartments(user, { rows, extra });
  if (out.error) return out;
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel organization added', entity: 'OmniDepartments', entityId: name, toValue: 'a new name in the Omni-Channel list (not in the Department master)' });
  return { ok: `"${name}" created. People are added to it in Administration > Departments and Users.`, name };
}

async function superOrgs(user, month) {
  const o = await orgRows(user, month);
  const rows = o.rows;
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return {
    month: o.month, months: o.months, rows,
    kpis: { organisations: rows.filter((r) => !r.noDept).length, active: rows.filter((r) => r.status === 'Active' && !r.noDept).length, messages: sum('messages'), creditsUsed: sum('creditsUsed'), creditsGiven: sum('creditsGiven'), zeroCredit: sum('zeroCredit') },
  };
}
async function superCsv(user, month) {
  const o = await superOrgs(user, month);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel organisations downloaded', entity: 'OmniOrganisations', entityId: o.month, toValue: `${o.rows.length} organisations` });
  return { csv: csvOf(['Organisation', 'People', 'Credits used', 'Messages sent', 'Credits given', 'Credits left', 'Status'], o.rows.map((r) => [r.name, r.people, r.creditsUsed, r.messages, r.creditsGiven, r.creditsLeft, r.status])), month: o.month };
}
// grant: { userId } or { department }; credits = the number of credits each person may use EVERY month (the allowance), 0 or more
async function grant(user, b) {
  const credits = Math.floor(Number(b.credits));
  if (!Number.isFinite(credits) || credits < 0 || credits > 100000) return { error: 'Enter a number of credits between 0 and 100000.', status: 400 };
  const note = clip(b.note, 200) || null;
  if (b.userId) {
    const p = await Cr.personOf(String(b.userId));
    if (!p) return { error: 'This person was not found.', status: 404 };
    const out = await Cr.setAllowance(p.id, credits, note, user);
    if (out.error) return { error: out.error, status: 400 };
    await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel credits granted', entity: 'OmniCredits', entityId: p.id, toValue: `${credits} credits a month for 1 person` });
    return { ok: `${credits} credits a month set for ${p.name}.`, people: 1, credits };
  }
  const dept = clip(b.department, 60);
  if (!dept) return { error: 'Choose a person or a department.', status: 400 };
  const act = await Cr.activity(Cr.thisMonth(), { all: true });
  const rows = act.rows.filter((r) => lc(r.department) === lc(dept) && !r.exempt);
  if (!rows.length) return { error: `Nobody in ${dept} has a credit limit to change (admins have no limit).`, status: 400 };
  for (const r of rows) await Cr.setAllowance(r.userId, credits, note, user); // eslint-disable-line no-await-in-loop
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel credits granted', entity: 'OmniCredits', entityId: dept, toValue: `${credits} credits a month for ${rows.length} people in the department` });
  return { ok: `${credits} credits a month set for ${rows.length} people in ${dept}.`, people: rows.length, credits };
}

// the real feature switches, in one answer
async function switches() {
  const st = await S.settings();
  const bots = await Pol.getKey('omni.bots', {});
  const rules = await Pol.consentRules();
  const ap = await Pol.approval();
  return {
    testMode: st.emailTestMode === true, master: st.master === true, approvalRequired: ap.required, atsAppliedMeansJobAllowed: rules.atsAppliedMeansJobAllowed,
    botsEnabled: bots.enabled === true, internalHrMaySend: st.internalHrMaySend === true,
  };
}
async function saveSwitches(user, b) {
  await Pol.saveSwitches(user, { atsAppliedMeansJobAllowed: b.atsAppliedMeansJobAllowed, approvalRequired: b.approvalRequired });
  if (b.botsEnabled !== undefined) {
    const cur = await Pol.getKey('omni.bots', {});
    const next = { ...(cur && typeof cur === 'object' ? cur : {}), enabled: b.botsEnabled === true };
    await Pol.putKey('omni.bots', next, user);
    if ((cur && cur.enabled === true) !== next.enabled) await logAudit({ userId: user.id, actorName: user.name, action: next.enabled ? 'Omni-Channel bot auto-replies switched ON' : 'Omni-Channel bot auto-replies switched OFF', entity: 'OmniBots', entityId: 'enabled', toValue: next.enabled ? 'on' : 'off' });
  }
  return { ok: 'Saved.', ...(await switches()) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------------------------------------------------------------
const stateWord = { green: 'Healthy', yellow: 'Needs a look', red: 'Not connected' };
async function health() {
  const conn = await Conn.status();
  const rows = conn.links.filter((l) => l.id !== 'channels').map((l) => ({ id: l.id, name: l.name, channel: l.id === 'hrms' ? 'Staff' : (l.id === 'ats' ? 'Requirements' : (l.id === 'accounts' ? 'Accounts' : 'Portal')), state: l.state, stateWord: stateWord[l.state], detail: l.summary, facts: l.facts, canSync: !!l.canSync }));
  let st = null; try { st = await require('../utils/messaging').channelStatus(); } catch { st = null; } // eslint-disable-line global-require
  const set = (await S.ready()) ? await S.settings() : { emailTestMode: true };
  let wa = null; try { wa = await Cfg.account(); } catch { wa = null; }
  const mk = (id, name, ok, reason, detail, testNote) => ({ id, name, channel: name, state: ok ? (testNote ? 'yellow' : 'green') : 'red', stateWord: ok ? (testNote ? 'Connected, Test mode ON' : 'Healthy') : 'Not connected', detail: ok ? detail : (reason || 'Not connected'), facts: [], canSync: false });
  rows.push(mk('email', 'Email', !!(st && st.Email.configured), st && st.Email.reason, st && st.Email.detail ? `Connected: ${st.Email.detail}.` : 'Connected.', set.emailTestMode ? 'Test mode is ON: emails are rehearsed, not sent.' : ''));
  const waRow = mk('whatsapp', 'WhatsApp', !!(st && st.WhatsApp.configured), st && st.WhatsApp.reason, 'Connected.', wa && wa.connected && wa.webhook && wa.webhook.state !== 'green' ? 'no replies seen yet' : '');
  if (waRow.state === 'yellow') { waRow.stateWord = 'Connected, no webhook call seen yet'; waRow.detail = 'The number is connected, but Meta has not called our webhook yet. Add the webhook address in Meta.'; }
  rows.push(waRow);
  rows.push(mk('sms', 'SMS', !!(st && st.SMS.configured), st && st.SMS.reason, st && st.SMS.provider ? `Connected through ${st.SMS.provider}.` : 'Connected.', ''));
  const bad = rows.filter((r) => r.state !== 'green').length;
  return { rows, needAttention: bad, checkedAt: new Date().toISOString(), note: 'This only reads. "Test connection" counts rows and reads settings; it never sends a message.' };
}
async function healthOne(id) { const h = await health(); const row = h.rows.find((r) => r.id === id); return row ? { row, checkedAt: h.checkedAt } : null; }

async function waNumbers() {
  const acc = await Cfg.account().catch(() => ({ connected: false, number: '' }));
  const d = await Cfg.departments();
  return { numbers: await Pol.waNumbers(), departments: d.rows.map((r) => r.name), connectedNumber: acc.number || '', connected: !!acc.connected, words: (await require('../utils/waNumbers').hasNumbers().catch(() => false)) ? 'These are the real WhatsApp numbers. Add, assign and reconnect them in Administration > Integrations > WhatsApp & SMS > WhatsApp numbers.' : 'Config and routing only: sending still uses the one connected WhatsApp number until more numbers are really connected in Administration > Integrations.' };
}

// extra sending limits that the old PUT /settings does not know: WhatsApp / SMS day limits and speeds
async function sendingExtra(user, b) {
  const cur = await S.settings();
  const next = { ...cur };
  const take = (key, min, max, label) => {
    if (b[key] === undefined) return null;
    const n = Math.floor(Number(b[key]));
    if (!Number.isFinite(n) || n < min || n > max) return `${label} must be a number between ${min} and ${max}.`;
    next[key] = n; return null;
  };
  const bad = take('waDailyCap', 0, 100000, 'The WhatsApp day limit') || take('smsDailyCap', 0, 100000, 'The SMS day limit') || take('waPerMinute', 1, 600, 'WhatsApp per minute') || take('smsPerMinute', 1, 600, 'SMS per minute');
  if (bad) return { error: bad, status: 400 };
  await S.saveSettings(next, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel sending limits changed', entity: 'OutreachSettings', entityId: 'limits', toValue: `WhatsApp ${next.waDailyCap}/day ${next.waPerMinute}/min; SMS ${next.smsDailyCap}/day ${next.smsPerMinute}/min` });
  return { ok: 'Saved.', waDailyCap: next.waDailyCap, smsDailyCap: next.smsDailyCap, waPerMinute: next.waPerMinute, smsPerMinute: next.smsPerMinute };
}

// opt-outs: counts per way and the do-not-contact list size
async function optouts() {
  if (!(await S.ready())) return { ready: false, byChannel: {}, people: 0, doNotContact: 0 };
  const per = await S.q("SELECT cc.channel ch, COUNT(*) n FROM \"OutreachContactChannel\" cc JOIN \"OutreachContact\" c ON c.id = cc.contactId WHERE cc.optIn = 'opted_out' AND c.status = 'active' GROUP BY cc.channel");
  const ppl = (await S.q("SELECT COUNT(DISTINCT cc.contactId) n FROM \"OutreachContactChannel\" cc JOIN \"OutreachContact\" c ON c.id = cc.contactId WHERE cc.optIn = 'opted_out' AND c.status = 'active'"))[0];
  const dnc = (await S.q('SELECT COUNT(*) n FROM "OutreachSuppression"'))[0];
  const byChannel = {}; per.forEach((r) => { byChannel[r.ch] = num(r.n); });
  return { ready: true, byChannel, people: num(ppl.n), doNotContact: num(dnc.n) };
}
async function optoutsCsv(user) {
  if (!(await S.ready())) return { error: 'Omni-Channel is being set up.', status: 503 };
  const rows = await S.q("SELECT c.name name, c.phoneE164 phone, c.email email, cc.channel ch, cc.optOutAt at, cc.optOutReason why FROM \"OutreachContactChannel\" cc JOIN \"OutreachContact\" c ON c.id = cc.contactId WHERE cc.optIn = 'opted_out' AND c.status = 'active' ORDER BY cc.optOutAt DESC LIMIT 50000");
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel opt-out list downloaded', entity: 'OutreachContactChannel', entityId: 'optouts', toValue: `${rows.length} rows` });
  const words = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };
  return { count: rows.length, csv: csvOf(['Name', 'Phone', 'Email', 'Way', 'When', 'Why'], rows.map((r) => [r.name, r.phone || '', r.email || '', words[r.ch] || r.ch, S.iso(r.at) || '', r.why || ''])) };
}

module.exports = {
  mayTeam, levelWords, accessOf, members, rolesView, auditRows, auditCsv, billing, usageCsv, callMinutes, mine, company, orgOverview, createOrg, superOrgs, superCsv, grant,
  switches, saveSwitches, health, healthOne, waNumbers, sendingExtra, optouts, optoutsCsv, monthOf, csvOf, hide, round2,
};
