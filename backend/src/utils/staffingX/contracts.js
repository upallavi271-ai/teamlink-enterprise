// ---------------------------------------------------------------------------
// CONTRACTORS + PAY AND BILL (11.16) on the ATS side.
// A contractor is a placement (Application at JOINED / HIRED, client job) whose requirement is a contract / temporary job, or one a
// lead marked as a contract placement. Each has a contract row (dates, PO, approver, hours a week, how they are paid) and a rate
// history: pay rate, bill rate, unit (hour / day / month), overtime factors and the employer load (PF / ESI ...) with the date each
// one starts. Markup = (bill - cost) / cost, margin = (bill - cost) / bill.
// The BDE team sees the bill side only: never a pay rate, a cost or a margin (they are the contractor's pay).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('./store');

const CONTRACT = /contract|temp|temporary|c2h|contract to hire|fixed term|freelance/i;
const UNITS = ['Hour', 'Day', 'Month'];
const PAY_TYPES = ['TeamLink payroll', 'Vendor / C2C', 'Freelancer'];
const PLACED = ['JOINED', 'HIRED'];

const scope = () => require('../scope'); // eslint-disable-line global-require
const roleOf = (u) => scope().atsViewRole(u);
const isBdeSide = (u) => roleOf(u) === 'bde';
const seesPay = (u) => !['bde', 'client', 'candidate', 'none'].includes(roleOf(u));

const APP_SELECT = {
  id: true, stage: true, candidateId: true, requirementId: true, joinedAt: true, joiningDate: true, ownerRecruiterId: true,
  candidate: { select: { id: true, name: true, currentDesignation: true } },
  requirement: { select: { id: true, title: true, reqCode: true, internal: true, employmentType: true, jobPreference: true, clientId: true, location: true, recruiterId: true, tlId: true, client: { select: { id: true, name: true } } } },
};

// the portal logins are pinned to their own record; staff follow the ATS scope
function baseWhere(user) {
  const r = roleOf(user);
  if (r === 'candidate') return { candidateId: user.candidateId || '__none__' };
  if (r === 'client') return { requirement: { clientId: user.clientId || '__none__' } };
  return scope().applicationWhere(user);
}
async function contractRows(ids) {
  if (!ids.length) return new Map();
  const rows = await S.q(S.inList('SELECT * FROM "StfContract" WHERE "applicationId" IN (?)', ids), ...ids);
  return new Map(rows.map((r) => [r.applicationId, r]));
}
async function rateRows(ids) {
  if (!ids.length) return new Map();
  const rows = await S.q(S.inList('SELECT * FROM "StfRate" WHERE "applicationId" IN (?) ORDER BY "effectiveFrom" ASC, "at" ASC', ids), ...ids);
  const m = new Map();
  rows.forEach((r) => { if (!m.has(r.applicationId)) m.set(r.applicationId, []); m.get(r.applicationId).push(r); });
  return m;
}
// the rate in force for a week: the latest one that starts on or before the week's last day
function rateFor(list, weekStart) {
  const end = S.addDays(weekStart, 6);
  const ok = (list || []).filter((r) => r.effectiveFrom <= end);
  return ok.length ? ok[ok.length - 1] : null;
}

// The money for one week of hours. hours: 7 numbers, Monday first.
function calc(rate, hours, weeklyHours) {
  const h = (Array.isArray(hours) ? hours : []).slice(0, 7).map((v) => Math.max(0, Math.min(24, Number(v) || 0)));
  while (h.length < 7) h.push(0);
  const total = S.money(h.reduce((a, b) => a + b, 0));
  const days = h.filter((v) => v > 0).length;
  const std = Number(weeklyHours) > 0 ? Number(weeklyHours) : 48;
  const stdDay = std / 6;
  const out = { hours: h, total, days, reg: Math.min(total, std), ot: Math.max(0, S.money(total - std)), pay: null, cost: null, bill: null, margin: null };
  if (!rate) return out;
  const otP = rate.otPay != null ? Number(rate.otPay) : 1.5;
  const otB = rate.otBill != null ? Number(rate.otBill) : 1.5;
  const payR = Number(rate.payRate) || 0;
  const billR = Number(rate.billRate) || 0;
  if (rate.unit === 'Day') {
    const ot = S.money(h.reduce((a, v) => a + Math.max(0, v - stdDay), 0));
    out.ot = ot; out.reg = S.money(total - ot);
    out.pay = days * payR + ot * (payR / stdDay) * otP;
    out.bill = days * billR + ot * (billR / stdDay) * otB;
  } else {
    const k = rate.unit === 'Month' ? 12 / 52 / std : 1; // a monthly rate as its hourly equal
    out.pay = (out.reg * payR + out.ot * payR * otP) * k;
    out.bill = (out.reg * billR + out.ot * billR * otB) * k;
  }
  out.cost = out.pay * (1 + (Number(rate.loadPercent) || 0) / 100);
  out.pay = S.money(out.pay); out.cost = S.money(out.cost); out.bill = S.money(out.bill); out.margin = S.money(out.bill - out.cost);
  return out;
}
function rateView(rate, user) {
  if (!rate) return null;
  const pay = Number(rate.payRate) || 0; const bill = Number(rate.billRate) || 0;
  const cost = pay * (1 + (Number(rate.loadPercent) || 0) / 100);
  // the contractor sees their own pay rate, never the bill rate (what the client pays TeamLink)
  if (roleOf(user) === 'candidate') return { id: rate.id, effectiveFrom: rate.effectiveFrom, unit: rate.unit, payRate: pay, otPay: rate.otPay != null ? Number(rate.otPay) : 1.5, currency: rate.currency || 'INR' };
  const v = {
    id: rate.id, effectiveFrom: rate.effectiveFrom, unit: rate.unit, billRate: bill, otBill: rate.otBill != null ? Number(rate.otBill) : 1.5, currency: rate.currency || 'INR',
    reason: rate.reason || null, byName: rate.byName || null, at: rate.at,
  };
  if (seesPay(user)) {
    Object.assign(v, {
      payRate: pay, otPay: rate.otPay != null ? Number(rate.otPay) : 1.5, loadPercent: Number(rate.loadPercent) || 0, cost: S.money(cost),
      markupPercent: cost > 0 ? S.money(((bill - cost) / cost) * 100) : null, marginPercent: bill > 0 ? S.money(((bill - cost) / bill) * 100) : null,
    });
  }
  return v;
}

// All contractors this login may see (scope.applicationWhere), newest first.
async function list(user, { applicationId = null, clientId = null, status = null, take = 1500 } = {}) {
  await S.ensure();
  const marked = (await S.q('SELECT "applicationId" FROM "StfContract"')).map((r) => r.applicationId);
  const where = { AND: [baseWhere(user), { stage: { in: PLACED } }, ...(applicationId ? [{ id: applicationId }] : []), ...(clientId ? [{ requirement: { clientId } }] : [])] };
  const apps = await prisma.application.findMany({ where, select: APP_SELECT, orderBy: { updatedAt: 'desc' }, take });
  const markedSet = new Set(marked);
  const mine = apps.filter((a) => !a.requirement.internal && (markedSet.has(a.id) || CONTRACT.test(`${a.requirement.jobPreference || ''} ${a.requirement.employmentType || ''}`)));
  const ids = mine.map((a) => a.id);
  const [C, R] = await Promise.all([contractRows(ids), rateRows(ids)]);
  const today = new Date().toISOString().slice(0, 10);
  const wk = await S.setting('week.hours');
  const out = mine.map((a) => {
    const c = C.get(a.id) || {};
    const rates = R.get(a.id) || [];
    const cur = rateFor(rates, S.mondayOf(today)) || rates[rates.length - 1] || null;
    const st = c.status || 'Active';
    return {
      applicationId: a.id, candidateId: a.candidateId, name: a.candidate.name, designation: a.candidate.currentDesignation || null,
      requirementId: a.requirementId, requirement: a.requirement.title, reqCode: a.requirement.reqCode || null, location: a.requirement.location || null,
      clientId: a.requirement.clientId, client: a.requirement.client ? a.requirement.client.name : null, ownerRecruiterId: a.ownerRecruiterId || a.requirement.recruiterId || null,
      type: a.requirement.jobPreference || a.requirement.employmentType || null, joined: a.joiningDate || (a.joinedAt ? a.joinedAt.toISOString().slice(0, 10) : null),
      marked: markedSet.has(a.id), status: st, startOn: c.startOn || a.joiningDate || (a.joinedAt ? a.joinedAt.toISOString().slice(0, 10) : null), endOn: c.endOn || null,
      poNumber: c.poNumber || null, costCentre: c.costCentre || null, approverName: c.approverName || null, weeklyHours: c.weeklyHours != null ? Number(c.weeklyHours) : wk,
      payType: seesPay(user) ? (c.payType || null) : undefined, vmsWorkerId: c.vmsWorkerId || null, notes: c.notes || null,
      rate: rateView(cur, user), rateCount: rates.length, ended: st === 'Ended' || !!(c.endOn && c.endOn < today),
    };
  });
  return status ? out.filter((r) => (status === 'Active' ? !r.ended : r.ended)) : out;
}
async function one(user, applicationId) {
  const rows = await list(user, { applicationId });
  return rows[0] || null;
}
// a placement in scope that may become a contractor (joined, client job), even before it is marked
async function placementInScope(user, applicationId) {
  return prisma.application.findFirst({ where: { AND: [baseWhere(user), { id: String(applicationId || '') }, { stage: { in: PLACED } }] }, select: APP_SELECT });
}

async function saveContract(user, applicationId, body) {
  const app = await placementInScope(user, applicationId);
  if (!app || app.requirement.internal) return { error: 'A joined client placement in your scope is needed.', status: 404 };
  const b = body || {};
  for (const k of ['startOn', 'endOn']) if (b[k] && !S.isDate(b[k])) return { error: 'Dates are YYYY-MM-DD.' };
  if (b.startOn && b.endOn && b.endOn < b.startOn) return { error: 'The contract cannot end before it starts.' };
  if (b.payType && !PAY_TYPES.includes(b.payType)) return { error: `How they are paid: ${PAY_TYPES.join(', ')}.` };
  const wh = S.n(b.weeklyHours);
  if (wh != null && (wh < 1 || wh > 84)) return { error: 'Hours a week: 1 to 84.' };
  const before = (await S.q('SELECT * FROM "StfContract" WHERE "applicationId" = ?', app.id))[0] || null;
  const status = ['Active', 'Ended'].includes(b.status) ? b.status : (before ? before.status : 'Active');
  const pick = (k, max = 120) => (b[k] !== undefined ? S.clean(b[k], max) : (before ? before[k] : null));
  await S.x(`INSERT INTO "StfContract" ("applicationId","candidateId","requirementId","clientId","status","startOn","endOn","poNumber","costCentre","approverName","weeklyHours","payType","vmsWorkerId","notes","byName","at")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "status"=excluded."status","startOn"=excluded."startOn","endOn"=excluded."endOn",
    "poNumber"=excluded."poNumber","costCentre"=excluded."costCentre","approverName"=excluded."approverName","weeklyHours"=excluded."weeklyHours","payType"=excluded."payType",
    "vmsWorkerId"=excluded."vmsWorkerId","notes"=excluded."notes","byName"=excluded."byName","at"=excluded."at"`,
  app.id, app.candidateId, app.requirementId, app.requirement.clientId, status,
  b.startOn !== undefined ? (b.startOn || null) : (before ? before.startOn : (app.joiningDate && S.isDate(app.joiningDate) ? app.joiningDate : null)),
  b.endOn !== undefined ? (b.endOn || null) : (before ? before.endOn : null),
  pick('poNumber', 60), pick('costCentre', 60), pick('approverName', 120),
  wh != null ? wh : (before ? before.weeklyHours : null), b.payType !== undefined ? (b.payType || null) : (before ? before.payType : null),
  pick('vmsWorkerId', 60), pick('notes', 500), user.name, S.now());
  await require('../audit').logAudit({ userId: user.id, action: before ? 'Contract placement updated' : 'Marked as a contract placement', entity: 'Application', entityId: app.id, toValue: `${app.candidate.name} · ${app.requirement.title} · ${status}`.slice(0, 300) }); // eslint-disable-line global-require
  return { ok: true, contractor: await one(user, app.id) };
}

async function saveRate(user, applicationId, body) {
  const app = await placementInScope(user, applicationId);
  if (!app || app.requirement.internal) return { error: 'A joined client placement in your scope is needed.', status: 404 };
  const b = body || {};
  if (!S.isDate(b.effectiveFrom)) return { error: 'Give the date the rate starts (YYYY-MM-DD).' };
  const unit = UNITS.includes(b.unit) ? b.unit : null;
  if (!unit) return { error: `Rate per: ${UNITS.join(', ')}.` };
  const pay = S.n(b.payRate); const bill = S.n(b.billRate);
  if (pay == null || pay <= 0 || bill == null || bill <= 0) return { error: 'Give both the pay rate and the bill rate (more than 0).' };
  const otPay = S.n(b.otPay) == null ? 1.5 : S.n(b.otPay); const otBill = S.n(b.otBill) == null ? 1.5 : S.n(b.otBill);
  if (otPay < 1 || otPay > 3 || otBill < 1 || otBill > 3) return { error: 'Overtime factors are between 1 and 3 (1.5 = time and a half).' };
  const load = S.n(b.loadPercent) == null ? 0 : S.n(b.loadPercent);
  if (load < 0 || load > 60) return { error: 'Employer load is 0 to 60 %.' };
  const used = await S.q('SELECT COUNT(*) AS n FROM "StfTimesheet" WHERE "applicationId" = ? AND "batchId" IS NOT NULL AND "weekStart" >= ?', app.id, S.mondayOf(b.effectiveFrom));
  if (S.num(used[0] && used[0].n) > 0) return { error: 'Weeks from that date are already billed. Start the new rate after the last billed week.', status: 409 };
  const id = S.newId();
  // a contractor gets a contract row the moment a rate is set
  if (!(await S.q('SELECT 1 FROM "StfContract" WHERE "applicationId" = ?', app.id)).length) await saveContract(user, app.id, {});
  await S.x('INSERT INTO "StfRate" ("id","applicationId","effectiveFrom","unit","payRate","billRate","otPay","otBill","loadPercent","currency","reason","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, app.id, b.effectiveFrom, unit, pay, bill, otPay, otBill, load, 'INR', S.clean(b.reason, 200), user.name, S.now());
  await require('../audit').logAudit({ userId: user.id, action: 'Contract rate set', entity: 'Application', entityId: app.id, toValue: `from ${b.effectiveFrom}: bill ${bill}/${unit.toLowerCase()} (pay rate recorded)`, reason: S.clean(b.reason, 200) || undefined }); // eslint-disable-line global-require
  return { ok: true, id, warning: bill <= pay * (1 + load / 100) ? 'The bill rate does not cover the cost: this placement loses money.' : null };
}
async function rateHistory(user, applicationId) {
  const c = await one(user, applicationId);
  if (!c) return { error: 'Contractor not found (or not in your scope).', status: 404 };
  const rows = (await rateRows([applicationId])).get(applicationId) || [];
  return { contractor: c, rows: rows.map((r) => rateView(r, user)).reverse() };
}

// Pay & bill summary of approved weeks in a period (default: this month)
async function payBill(user, { from = null, to = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const f = S.isDate(from) ? from : `${today.slice(0, 7)}-01`;
  const t = S.isDate(to) ? to : today;
  const cs = await list(user);
  const ids = cs.map((c) => c.applicationId);
  const ts = ids.length ? await S.q(S.inList('SELECT * FROM "StfTimesheet" WHERE "status" = \'Approved\' AND "applicationId" IN (?)', ids) + ' AND "weekStart" >= ? AND "weekStart" <= ?', ...ids, S.mondayOf(f), t) : [];
  const by = new Map();
  ts.forEach((r) => { const a = by.get(r.applicationId) || { weeks: 0, hours: 0, pay: 0, cost: 0, bill: 0 }; a.weeks += 1; a.hours += Number(r.totalHours) || 0; a.pay += Number(r.payAmount) || 0; a.cost += Number(r.costAmount) || 0; a.bill += Number(r.billAmount) || 0; by.set(r.applicationId, a); });
  const pay = seesPay(user);
  const rows = cs.map((c) => {
    const a = by.get(c.applicationId) || { weeks: 0, hours: 0, pay: 0, cost: 0, bill: 0 };
    return { applicationId: c.applicationId, name: c.name, client: c.client, clientId: c.clientId, rate: c.rate, weeks: a.weeks, hours: S.money(a.hours), bill: S.money(a.bill), ...(pay ? { pay: S.money(a.pay), cost: S.money(a.cost), margin: S.money(a.bill - a.cost), marginPercent: a.bill > 0 ? S.money(((a.bill - a.cost) / a.bill) * 100) : null } : {}) };
  });
  const sum = (k) => S.money(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  const clients = new Map();
  rows.forEach((r) => { const c = clients.get(r.clientId) || { clientId: r.clientId, client: r.client, contractors: 0, hours: 0, bill: 0, cost: 0 }; c.contractors += 1; c.hours += r.hours; c.bill += r.bill; c.cost += r.cost || 0; clients.set(r.clientId, c); });
  return {
    from: f, to: t, seesPay: pay, rows,
    totals: { hours: sum('hours'), bill: sum('bill'), ...(pay ? { pay: sum('pay'), cost: sum('cost'), margin: S.money(sum('bill') - sum('cost')) } : {}) },
    byClient: [...clients.values()].map((c) => ({ clientId: c.clientId, client: c.client, contractors: c.contractors, hours: S.money(c.hours), bill: S.money(c.bill), ...(pay ? { margin: S.money(c.bill - c.cost) } : {}) })),
  };
}

module.exports = {
  CONTRACT, UNITS, PAY_TYPES, PLACED, roleOf, isBdeSide, seesPay, calc, rateFor, rateRows, contractRows, rateView,
  list, one, placementInScope, saveContract, saveRate, rateHistory, payBill,
};
