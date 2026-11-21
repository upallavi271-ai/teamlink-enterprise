// ---------------------------------------------------------------------------
// BDE AGENT - THE ROUTER (founder 2026-11-20: "whatever information a BDE needs, they search it there and know it ... accurate, responds quickly").
//
// The common questions are answered IN CODE, with no model, from exact database numbers read through the login's own scope (utils/scope.js
// clientWhere / requirementWhere / applicationWhere), each record named with a link. A question is turned into { intent, period, record }:
//
//   agenda        today's work in one answer            interviews     today / tomorrow / this week / next N days
//   clients       my clients (count, list)               requirements   open (live) requirements, and the ones with no profile yet
//   shared        profiles sent to the client in a period feedback      sent with no reply, interview done with no feedback, shortlisted
//   selections    selected in a period / selected now    offers         waiting for the candidate / accepted, not joined
//   joinings      joined in a period, due to join         drops          left after joining, in a period
//   replacements  replacements due inside the guarantee   invoices       overdue / open / paid / raised (amounts only for Super Admin, Admin, Accounts)
//   agreements    expiring in N days / not signed / one client's terms   followups   client follow-ups and meetings due, own candidate chases
//   target        new clients signed this month vs the joinings target  health / complaints / nps   client health, open complaints, client NPS
//   crm           leads and deals (sales-team logins only)                process     "how do I ..." in TeamLink
//   about         one client / requirement / candidate (360), names resolved with utils/atsSearch.js (partial, typo, Telugu)
//
// THE LIMITED VIEW (a BDE / BDE TL): a candidate is a NAME and a STEP. Nothing here ever selects a candidate's phone, e-mail, address, salary,
// CTC or documents, for any login, and nothing links to a recruiter's productivity page. Invoice AMOUNTS only for logins that already see them
// (utils/atsHistory.js mayBilling). READ ONLY: nothing here writes.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const SC = require('./scope');
const V = require('./atsVocab');
const L = require('./bdeAgentLang');

const TEST_RE = /zztest|example\.test/i;
const LIVE = V.REQUIREMENT_LIVE_STATUSES; // OPEN, RECRUITER_ASSIGNED, SOURCING, CANDIDATES_AVAILABLE
const JOINED = ['JOINED', 'HIRED'];
const SELECTED_NOW = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const LEFT_STATUS = [V.JOINING_REPLACEMENT_DUE, V.JOINING_REPLACED, V.JOINING_LEFT_AFTER_GUARANTEE, 'Dropped'];
const SHOW = 100; // records listed under an answer, one compact line each (the count is always the exact total; beyond it, a link to the full list)
const TTL = 60000;

const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const safe = async (fn, fb) => { try { return await fn(); } catch (e) { console.error('[bde-agent]', e.message); return fb; } }; // eslint-disable-line no-console
const say = L.say;

// ---- the data stamp: a cached answer is dropped the moment the data it was read from changes ---------------------------------------
let stampHit = null;
async function dataStamp() {
  if (stampHit && Date.now() - stampHit.at < 1500) return stampHit.v;
  const t = (d) => (d ? new Date(d).getTime() : 0);
  const day = (col) => `TOTAL(CAST(REPLACE(SUBSTR(COALESCE("${col}", ''), 1, 10), '-', '') AS INTEGER))`;
  const sum = async (sql) => { const [x] = await prisma.$queryRawUnsafe(sql); return Object.values(x || {}).map((n) => String(n)).join(','); };
  const [a, e, r, c, i, f, j] = await Promise.all([
    prisma.application.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.applicationStageEvent.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    prisma.requirement.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    // Client and Invoice have no change date: a checksum of the columns the answers read
    sum(`SELECT COUNT(*) AS n, TOTAL(LENGTH(COALESCE("name", '') || COALESCE("status", '') || COALESCE("agreementStatus", '') || COALESCE("bdeOwner", '') || COALESCE("secondaryBde", ''))) AS l, ${day('agreementEnd')} AS e FROM "Client"`),
    sum(`SELECT COUNT(*) AS n, TOTAL(LENGTH("status")) AS s, TOTAL("receivedAmount") AS r, TOTAL("amount") AS a, ${day('dueDate')} AS d, ${day('paidDate')} AS p FROM "Invoice"`),
    prisma.appSetting.aggregate({ where: { key: { startsWith: 'clientfu.' } }, _count: { _all: true }, _max: { updatedAt: true } }),
    sum('SELECT COUNT(*) AS n, MAX("updatedAt") AS u FROM "JoiningRecord"').catch(() => ''),
  ]).catch(() => [null, null, null, '', '', null, '']);
  const v = [a && a._count._all, a && t(a._max.updatedAt), e && e._count._all, e && t(e._max.createdAt), r && r._count._all, r && t(r._max.updatedAt), c, i,
    f && f._count._all, f && t(f._max.updatedAt), j, L.todayIst()].join('|');
  stampHit = { at: Date.now(), v };
  return v;
}

// ---- the login's context: who they are, their clients and requirements (cached 60 s per login) -----------------------------------
const ctxCache = new Map();
function roleOf(user) {
  const s = SC.atsScopeOf(user);
  if (s.adminGlobal) return 'admin';
  if (SC.isBdeTl(user)) return 'bdetl';
  if (s.atsRole === 'BDE') return 'bde';
  return 'other';
}
async function contextOf(user, { fresh = false } = {}) {
  const stamp = await dataStamp();
  const hit = ctxCache.get(user.id);
  if (!fresh && hit && hit.stamp === stamp && Date.now() - hit.at < TTL) return hit;
  const testViewer = TEST_RE.test(`${user.name || ''} ${user.email || ''}`);
  const role = roleOf(user);
  const clients = (await prisma.client.findMany({
    where: SC.clientWhere(user),
    select: {
      id: true, name: true, clientCode: true, status: true, priority: true, industry: true, location: true, ownerDepartment: true, bdeOwner: true, secondaryBde: true,
      contactName: true, contactDesignation: true, contactPhone: true, contactEmail: true, agreementId: true, agreementStatus: true, agreementStart: true, agreementEnd: true,
      agreementSentAt: true, agreementSignedAt: true, agreementFeePercent: true, feeType: true, feeAmount: true, guaranteePeriod: true, paymentTerms: true, paymentDue: true,
      clientType: true, createdAt: true,
    },
    orderBy: { name: 'asc' },
  })).filter((c) => testViewer || !TEST_RE.test(c.name));
  const clientIds = new Set(clients.map((c) => c.id));
  const reqs = (await prisma.requirement.findMany({
    where: { AND: [SC.requirementWhere(user), { internal: false }] },
    select: { id: true, title: true, reqCode: true, status: true, priority: true, openings: true, department: true, location: true, clientId: true, tl: true, tlId: true, bdeId: true, createdAt: true, updatedAt: true, closingDate: true, client: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })).filter((r) => testViewer || !TEST_RE.test((r.client && r.client.name) || ''));
  let billing = false;
  try { billing = await require('./atsHistory').mayBilling(user); } catch { billing = false; } // eslint-disable-line global-require
  const ctx = {
    at: Date.now(), stamp, user, role, testViewer, billing, today: L.todayIst(),
    clients, clientIds, clientById: new Map(clients.map((c) => [c.id, c])), reqs, reqById: new Map(reqs.map((r) => [r.id, r])),
    appScope: SC.applicationWhere(user), answers: new Map(),
  };
  ctxCache.set(user.id, ctx);
  if (ctxCache.size > 400) ctxCache.delete(ctxCache.keys().next().value);
  return ctx;
}
function invalidate(userId) { if (userId) ctxCache.delete(userId); else ctxCache.clear(); stampHit = null; }

// the applications this login may read, client work only, test people hidden (the dashboard's rule)
const appWhere = (ctx, ...extra) => ({
  AND: [ctx.appScope, { requirement: { internal: false } }, ...(ctx.testViewer ? [] : [{ candidate: { NOT: { name: { contains: 'zztest' } } } }]), ...extra.filter(Boolean)],
});
// ONLY these candidate fields are ever read (the limited view): the name. Never phone / e-mail / pay / address / documents.
const APP_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, interviewAt: true, interviewStatus: true, interviewRound: true, interviewMode: true,
  offerStatus: true, offerDate: true, joiningDate: true, joiningStatus: true, rollStatus: true, joinedAt: true, updatedAt: true,
  candidate: { select: { name: true } }, requirement: { select: { id: true, title: true, reqCode: true, clientId: true, client: { select: { name: true } } } },
};
const filterArm = (f) => {
  if (!f) return null;
  if (f.clientId) return { requirement: { clientId: f.clientId } };
  if (f.requirementId) return { requirementId: f.requirementId };
  if (f.departments) return { requirement: { department: { in: f.departments } } };
  return null;
};
// the login's clients / requirements, cut to one client or one department ("Education joinings", "Medical requirements")
const inDept = (f, d) => !!d && f.departments.some((x) => String(x).toLowerCase() === String(d).toLowerCase());
function clientsOf(ctx, f) {
  if (f && f.clientId) return ctx.clients.filter((c) => c.id === f.clientId);
  if (f && f.departments) { const viaJob = new Set(ctx.reqs.filter((r) => inDept(f, r.department)).map((r) => r.clientId)); return ctx.clients.filter((c) => inDept(f, c.ownerDepartment) || viaJob.has(c.id)); }
  return ctx.clients;
}
const clientIdsOf = (ctx, f) => clientsOf(ctx, f).map((c) => c.id);
function reqsOf(ctx, f) {
  if (f && f.clientId) return ctx.reqs.filter((r) => r.clientId === f.clientId);
  if (f && f.requirementId) return ctx.reqs.filter((r) => r.id === f.requirementId);
  if (f && f.departments) return ctx.reqs.filter((r) => inDept(f, r.department));
  return ctx.reqs;
}

// ---- links ---------------------------------------------------------------------------------------------------------------------------
const clientItem = (c, sub) => ({ kind: 'client', id: c.id, label: c.name, sub: sub || '', to: `/clients/${c.id}`, history: `/clients/${c.id}?tab=history` });
const reqItem = (r, sub) => ({ kind: 'requirement', id: r.id, label: `${r.title}${r.reqCode ? ` (${r.reqCode})` : ''}`, sub: sub || '', to: `/requirements/${r.id}`, history: `/requirements/${r.id}?tab=history` });
const candItem = (a, sub, focus) => ({
  kind: 'candidate', id: a.candidateId, label: (typeof a.candidate === 'string' ? a.candidate : a.candidate && a.candidate.name) || a.candidateName || 'Candidate', sub: sub || '',
  to: `/ats/history/candidate/${a.candidateId}${focus ? `?focus=${focus}` : ''}`, record: `/candidates/${a.candidateId}`,
});
const jobOf = (a) => { const r = a.requirement || {}; return `${r.title || a.jobTitle || '-'}${(r.client && r.client.name) || a.clientName ? ` (${(r.client && r.client.name) || a.clientName})` : ''}`; };
const stepOf = (a) => (V.leftAfterJoining && JOINED.includes(a.stage) && (LEFT_STATUS.includes(a.joiningStatus) || a.rollStatus === 'Dropped') ? 'Dropped' : V.stageLabel(a.stage));

// ---- the answer --------------------------------------------------------------------------------------------------------------------
function answer(ctx, a) {
  const items = a.items || [];
  return {
    intent: a.intent, count: a.count === undefined ? null : a.count, title: a.title, lines: (a.lines || []).filter(Boolean), items: items.slice(0, a.show || SHOW),
    more: Math.max(0, (a.total === undefined ? items.length : a.total) - Math.min(items.length, a.show || SHOW)), facts: (a.facts || []).filter(Boolean),
    open: a.open || null, record: a.record || null, ...(a.stats ? { stats: a.stats } : {}),
  };
}
const scopeFact = (ctx) => {
  const who = { admin: 'Super Admin: the whole company', bdetl: 'BDE team lead: every client and its jobs', bde: `your own clients (${ctx.clients.length})`, other: 'your own scope' }[ctx.role];
  return `Scope: ${who}. Candidates from "Check by client manager" onward, name and step only (the BDE limited view).`;
};

// ============================================================================================================================================
// THE INTENTS
// ============================================================================================================================================
// "Now (20 Nov)" for the answers that are a state, not a period (the window is always the first words of an answer)
const nowLabel = (ctx, lang) => say(lang, { en: `Now (${L.dm(ctx.today)})`, tl: `Ippudu (${L.dm(ctx.today)})`, te: `ఇప్పుడు (${L.dm(ctx.today)})` });
// "By month: Jan 2026 12 · Feb 2026 15 ..." when the window covers more than one month (a long all-time window lists only the months with data)
function monthLine(days, p, ctx) {
  const list = days.filter(Boolean).map((d) => String(d).slice(0, 7));
  if (!list.length) return null;
  const lo = p.all ? list.reduce((a, b) => (a < b ? a : b)) : p.from.slice(0, 7);
  const hi = (p.to > ctx.today && !list.some((m) => m > ctx.today.slice(0, 7)) ? ctx.today : p.to).slice(0, 7);
  if (lo >= hi) return null;
  const count = new Map();
  list.forEach((m) => count.set(m, (count.get(m) || 0) + 1));
  const months = [];
  for (let m = lo; m <= hi && months.length < 400; m = L.addDays(`${L.lastOfMonth(`${m}-01`)}`, 1).slice(0, 7)) months.push(m);
  const shown = months.length > 18 ? months.filter((m) => count.get(m)) : months;
  return `By month: ${shown.map((m) => `${L.monthLabel(`${m}-01`)} ${count.get(m) || 0}`).join(' · ')}`;
}
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
// the screen that shows the same list with the same filters, for a list longer than the answer shows
const searchOpen = (type, f, extra = {}) => ({ to: `/ats/search?${qs({ type, client: f && f.clientId ? f.name : undefined, ...extra })}`, label: 'Open the full list in Search' });
const joinOpen = (p, f, view) => ({ to: `/ats/joining?${qs({ view: 'joindrop', jdview: view, from: p.all ? undefined : p.from, to: p.to, clientId: f && f.clientId })}`, label: 'Open the full list (Joining > Joined and dropped)' });
const forName = (f) => (f && f.name ? ` - ${f.name}` : '');

async function interviews(ctx, p, lang, f) {
  const where = appWhere(ctx, { interviewAt: { gte: L.startOf(p.from), lt: L.endOf(p.to) } }, { stage: { not: 'REJECTED' } },
    { OR: [{ interviewStatus: null }, { interviewStatus: { not: 'CANCELLED' } }] }, filterArm(f));
  const [n, rows] = await Promise.all([prisma.application.count({ where }), prisma.application.findMany({ where, select: APP_SELECT, orderBy: { interviewAt: p.to < ctx.today || p.all ? 'desc' : 'asc' }, take: SHOW })]);
  const when = p.label(lang);
  const days = n > SHOW ? (await prisma.application.findMany({ where, select: { interviewAt: true } })).map((a) => L.istDay(a.interviewAt)) : rows.map((a) => L.istDay(a.interviewAt));
  return answer(ctx, {
    intent: 'interviews', count: n, total: n, open: searchOpen('events', f, { ev: 'interview:upcoming,interview:done' }),
    title: say(lang, { en: `${when}: ${plural(n, 'interview', 'interviews')}${forName(f)}`, tl: `${when}: ${n} interview${n === 1 ? '' : 's'}${forName(f)}`, te: `${when}: ${n} ఇంటర్వ్యూ${n === 1 ? '' : 'లు'}${forName(f)}` }),
    lines: n ? [monthLine(days, p, ctx)] : [say(lang, { en: 'Nothing booked for this period.', tl: 'Ee period lo emi book avvaledu.', te: 'ఈ సమయంలో ఏదీ బుక్ కాలేదు.' })],
    items: rows.map((a) => candItem(a, `${jobOf(a)} · ${L.dmy(L.istDay(a.interviewAt))} ${L.timeOf(a.interviewAt)}${a.interviewRound > 1 ? ` · round ${a.interviewRound}` : ''}${a.interviewMode ? ` · ${a.interviewMode}` : ''} · ${V.stageLabel(a.stage)}`, `interview-${a.id}`)),
    facts: [`Counted: candidates with an interview between ${L.dmy(p.from)} and ${L.dmy(p.to)} (India time), not cancelled, not rejected${f && f.name ? `, for ${f.name}` : ''}.`, scopeFact(ctx)],
  });
}

async function distinctEventApps(ctx, toStages, p, f) {
  const evs = await prisma.applicationStageEvent.findMany({
    where: { toStage: { in: toStages }, createdAt: { gte: L.startOf(p.from), lt: L.endOf(p.to) }, application: appWhere(ctx, filterArm(f)) },
    select: { applicationId: true, createdAt: true }, orderBy: { createdAt: 'desc' },
  });
  const first = new Map();
  evs.forEach((e) => { if (!first.has(e.applicationId)) first.set(e.applicationId, e.createdAt); });
  return first; // applicationId -> latest event time in the period
}
async function appsById(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...await prisma.application.findMany({ where: { id: { in: ids.slice(i, i + 400) } }, select: APP_SELECT }));
  }
  return out;
}

async function shared(ctx, p, lang, f) {
  const m = await distinctEventApps(ctx, ['SHARED_WITH_CLIENT'], p, f);
  const n = m.size;
  const top = [...m.entries()].slice(0, SHOW);
  const rows = await appsById(top.map(([id]) => id));
  const byId = new Map(rows.map((a) => [a.id, a]));
  const when = p.label(lang);
  return answer(ctx, {
    intent: 'shared', count: n, total: n, open: searchOpen('candidates', f),
    title: say(lang, { en: `${when}: ${plural(n, 'profile', 'profiles')} sent to clients${forName(f)}`, tl: `${when}: clients ki ${n} profile${n === 1 ? '' : 's'} share chesam${forName(f)}`, te: `${when}: క్లయింట్లకు ${n} ప్రొఫైల్‌లు పంపాం${forName(f)}` }),
    lines: [monthLine([...m.values()].map((d) => L.istDay(d)), p, ctx)],
    items: top.map(([id]) => byId.get(id)).filter(Boolean).map((a) => candItem(a, `${jobOf(a)} · sent ${L.dmy(L.istDay(m.get(a.id)))} · now ${stepOf(a)}`)),
    facts: [`Counted: each candidate once, whose profile moved to "Sent to client" between ${L.dmy(p.from)} and ${L.dmy(p.to)} (the stage history)${f && f.name ? `, for ${f.name}` : ''}.`, scopeFact(ctx)],
  });
}

async function pendingOf(ctx) {
  if (!ctx.pending) ctx.pending = await safe(() => require('./clientWork').bdePending(ctx.user), null); // eslint-disable-line global-require
  return ctx.pending;
}
async function feedback(ctx, p, lang, f) {
  const pend = await pendingOf(ctx);
  const only = (list) => (list || []).filter((i) => !f || (f.clientId ? i.clientId === f.clientId : f.requirementId ? i.requirementId === f.requirementId : true));
  const sentAll = only(pend && pend.noReplyAllItems);
  const late = only(pend && pend.lists && pend.lists.noReply);
  const done = only(pend && pend.lists && pend.lists.feedback);
  const short = only(pend && pend.lists && pend.lists.shortlisted);
  const days = (pend && pend.feedbackDays) || 3;
  const n = sentAll.length + done.length;
  const it = (i, why) => candItem(i, `${i.job} (${i.client}) · ${why}`);
  const now = nowLabel(ctx, lang);
  return answer(ctx, {
    intent: 'feedback', count: n, total: n + short.length,
    title: say(lang, { en: `${now}: ${plural(n, 'profile is', 'profiles are')} waiting for client feedback${forName(f)}`, tl: `${now}: ${n} profile${n === 1 ? '' : 's'} client feedback kosam waiting${forName(f)}`, te: `${now}: ${n} ప్రొఫైల్‌లు క్లయింట్ ఫీడ్‌బ్యాక్ కోసం ఎదురుచూస్తున్నాయి${forName(f)}` }),
    lines: [
      `Sent, no reply yet: ${sentAll.length} (${late.length} waiting ${days}+ days)`,
      `Interview done, no feedback: ${done.length}`,
      short.length ? `Shortlisted by the client, interview not booked: ${short.length}` : null,
    ],
    items: [
      ...late.map((i) => it(i, `sent, no reply ${i.waitedDays != null ? `${i.waitedDays} days` : ''}`)),
      ...done.map((i) => it(i, 'interview done, no feedback')),
      ...sentAll.filter((i) => !late.some((x) => x.applicationId === i.applicationId)).map((i) => it(i, `sent, no reply${i.waitedDays != null ? ` ${i.waitedDays} days` : ''}`)),
      ...short.map((i) => it(i, 'shortlisted, book the interview')),
    ],
    facts: [`The same lists as your dashboard's pending client work (utils/clientWork.js): "sent" = at Sent to client / Client checking; "${days}+ days" = waiting at least the set days; "interview done" = the client interview happened and no result is recorded.`, scopeFact(ctx)],
  });
}

async function selections(ctx, p, lang, f) {
  const nowWhere = appWhere(ctx, { stage: { in: SELECTED_NOW } }, filterArm(f));
  const [m, nowN, nowRows] = await Promise.all([
    distinctEventApps(ctx, ['SELECTED'], p, f),
    prisma.application.count({ where: nowWhere }),
    prisma.application.findMany({ where: nowWhere, select: APP_SELECT, orderBy: { updatedAt: 'desc' }, take: SHOW }),
  ]);
  const when = p.label(lang);
  if (!p.named) {
    const now = nowLabel(ctx, lang);
    return answer(ctx, {
      intent: 'selections', count: nowN, total: nowN, open: searchOpen('candidates', f, { status: 'selected' }),
      title: say(lang, { en: `${now}: ${plural(nowN, 'candidate is', 'candidates are')} selected and not joined yet${forName(f)}`, tl: `${now}: ${nowN} candidates select ayyaru, inka join avvaledu${forName(f)}`, te: `${now}: ${nowN} మంది ఎంపికయ్యారు, ఇంకా చేరలేదు${forName(f)}` }),
      lines: [`Selected ${when}: ${m.size}`],
      items: nowRows.map((a) => candItem(a, `${jobOf(a)} · ${V.stageLabel(a.stage)}${a.joiningDate ? ` · joining ${L.dmy(String(a.joiningDate).slice(0, 10))}` : ''}`)),
      facts: ['Counted: candidates now at Selected, Offer or Offer accepted (not joined, not rejected).', `"Selected ${when}" = moved to Selected in that period (stage history).`, scopeFact(ctx)],
    });
  }
  const rows = await appsById([...m.keys()].slice(0, SHOW));
  const byId = new Map(rows.map((a) => [a.id, a]));
  return answer(ctx, {
    intent: 'selections', count: m.size, total: m.size, open: searchOpen('candidates', f, { status: 'selected' }),
    title: say(lang, { en: `${when}: ${plural(m.size, 'selection', 'selections')}${forName(f)}`, tl: `${when}: ${m.size} selections${forName(f)}`, te: `${when}: ${m.size} ఎంపికలు${forName(f)}` }),
    lines: [monthLine([...m.values()].map((d) => L.istDay(d)), p, ctx), `Selected now, not joined yet: ${nowN}`],
    items: [...m.keys()].slice(0, SHOW).map((id) => byId.get(id)).filter(Boolean).map((a) => candItem(a, `${jobOf(a)} · selected ${L.dmy(L.istDay(m.get(a.id)))} · now ${stepOf(a)}`)),
    facts: [`Counted: each candidate once, moved to Selected between ${L.dmy(p.from)} and ${L.dmy(p.to)} (the stage history)${f && f.name ? `, for ${f.name}` : ''}.`, scopeFact(ctx)],
  });
}

async function offers(ctx, p, lang, f) {
  if (p.named) {
    // offers RELEASED in the window (the Offer step in the stage history, or the offer date), and where each one stands now
    const ev = await distinctEventApps(ctx, ['OFFER', 'OFFER_ACCEPTED'], p, f);
    const byDate = await prisma.application.findMany({ where: appWhere(ctx, { offerDate: { gte: p.from, lt: L.addDays(p.to, 1) } }, filterArm(f)), select: { id: true, offerDate: true } });
    const dayOf = new Map([...ev.entries()].map(([id, at]) => [id, L.istDay(at)]));
    byDate.forEach((a) => { if (!dayOf.has(a.id)) dayOf.set(a.id, String(a.offerDate).slice(0, 10)); });
    const rows = (await appsById([...dayOf.keys()])).sort((a, b) => String(dayOf.get(b.id)).localeCompare(String(dayOf.get(a.id))));
    const stateOf = (a) => (JOINED.includes(a.stage) ? 'joined' : a.offerStatus === 'Offer Declined' ? 'declined' : a.stage === 'REJECTED' ? 'rejected' : (a.stage === 'OFFER_ACCEPTED' || a.offerStatus === 'Offer Accepted') ? 'accepted' : 'waiting');
    const c = { joined: 0, accepted: 0, declined: 0, waiting: 0, rejected: 0 };
    rows.forEach((a) => { c[stateOf(a)] += 1; });
    const when = p.label(lang);
    return answer(ctx, {
      intent: 'offers', count: rows.length, total: rows.length, open: searchOpen('events', f, { ev: 'offer:released,offer:accepted,offer:declined' }),
      title: say(lang, { en: `${when}: ${plural(rows.length, 'offer', 'offers')} released${forName(f)} (${c.joined} joined, ${c.accepted} accepted, ${c.declined} declined, ${c.waiting} waiting)`, tl: `${when}: ${rows.length} offers release ayyayi${forName(f)} (${c.joined} joined, ${c.accepted} accepted, ${c.declined} declined, ${c.waiting} waiting)`, te: `${when}: ${rows.length} ఆఫర్లు${forName(f)} (${c.joined} చేరారు, ${c.accepted} అంగీకరించారు, ${c.declined} తిరస్కరించారు, ${c.waiting} ఎదురుచూపు)` }),
      lines: [monthLine(rows.map((a) => dayOf.get(a.id)), p, ctx), c.rejected ? `Rejected later: ${c.rejected}` : null],
      items: rows.map((a) => candItem(a, `${jobOf(a)} · offer ${L.dmy(dayOf.get(a.id))} · now ${stateOf(a) === 'waiting' ? 'waiting for the answer' : stateOf(a)}`)),
      facts: [`Counted: candidates whose offer was released between ${L.dmy(p.from)} and ${L.dmy(p.to)} (the Offer step in the stage history, or the offer date), each once, with where they stand now. The offered pay is never shown here.`, scopeFact(ctx)],
    });
  }
  const notDone = { stage: { notIn: [...JOINED, 'REJECTED'] } };
  const relW = appWhere(ctx, notDone, { OR: [{ stage: 'OFFER' }, { offerStatus: 'Offer Released' }] }, { NOT: { stage: 'OFFER_ACCEPTED' } }, { OR: [{ offerStatus: null }, { offerStatus: { notIn: ['Offer Accepted', 'Offer Declined'] } }] }, filterArm(f));
  const accW = appWhere(ctx, notDone, { OR: [{ stage: 'OFFER_ACCEPTED' }, { offerStatus: 'Offer Accepted' }] }, filterArm(f));
  const [rel, acc, relRows, accRows] = await Promise.all([
    prisma.application.count({ where: relW }), prisma.application.count({ where: accW }),
    prisma.application.findMany({ where: relW, select: APP_SELECT, orderBy: { updatedAt: 'desc' }, take: SHOW }),
    prisma.application.findMany({ where: accW, select: APP_SELECT, orderBy: { updatedAt: 'desc' }, take: SHOW }),
  ]);
  const n = rel + acc;
  const now = nowLabel(ctx, lang);
  return answer(ctx, {
    intent: 'offers', count: n, total: n, open: searchOpen('events', f, { ev: 'offer:released,offer:accepted' }),
    title: say(lang, { en: `${now}: ${plural(n, 'offer is', 'offers are')} open${forName(f)}: ${rel} waiting for the candidate, ${acc} accepted (not joined yet)`, tl: `${now}: ${n} offers open${forName(f)}: ${rel} candidate answer kosam, ${acc} accept chesaru (inka join avvaledu)`, te: `${now}: ${n} ఆఫర్లు${forName(f)}: ${rel} అభ్యర్థి సమాధానం కోసం, ${acc} అంగీకరించారు (ఇంకా చేరలేదు)` }),
    lines: ['Ask "offers this month" or "offers from January to March" for the offers released in a period.'],
    items: [...relRows.map((a) => candItem(a, `${jobOf(a)} · offer released${a.offerDate ? ` ${L.dmy(String(a.offerDate).slice(0, 10))}` : ''}`)), ...accRows.map((a) => candItem(a, `${jobOf(a)} · offer accepted${a.joiningDate ? ` · joining ${L.dmy(String(a.joiningDate).slice(0, 10))}` : ''}`))],
    facts: ['Waiting = step Offer or offer status "Offer Released", not yet accepted or declined; accepted = step Offer accepted or status "Offer Accepted", not joined. The offered pay is never shown here.', scopeFact(ctx)],
  });
}

async function droppedAppIds(appIds) {
  if (!appIds.length) return new Set();
  const S = require('../joindrop/schema'); // eslint-disable-line global-require
  if (!(await S.ensure())) return new Set();
  const out = new Set();
  for (let i = 0; i < appIds.length; i += 400) {
    const part = appIds.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    (await S.rows(`SELECT "applicationId" FROM "JoiningRecord" WHERE "status" = 'Dropped' AND "applicationId" IN (${part.map(() => '?').join(',')})`, ...part)).forEach((r) => out.add(r.applicationId));
  }
  return out;
}
const dayArm = (p) => ({
  OR: [{ joiningDate: { gte: p.from, lt: L.addDays(p.to, 1) } }, { AND: [{ OR: [{ joiningDate: null }, { joiningDate: '' }] }, { joinedAt: { gte: L.startOf(p.from), lt: L.endOf(p.to) } }] }],
});
// JOININGS in a window: everybody who joined in it (step Joined / Hired with the joining day in the window), split into still working and left
// after joining; the ones still due to join in the window; the month-by-month count; the whole list (newest first)
async function joinings(ctx, p, lang, f, t = '') {
  const joinedW = appWhere(ctx, { stage: { in: JOINED } }, dayArm(p), filterArm(f));
  const dueFrom = p.from > ctx.today ? p.from : ctx.today;
  const dueW = dueFrom <= p.to && !p.all ? appWhere(ctx, { stage: { in: SELECTED_NOW } }, { joiningDate: { gte: dueFrom, lt: L.addDays(p.to, 1) } }, filterArm(f)) : null;
  const [joinedAll, dueRows] = await Promise.all([
    prisma.application.findMany({ where: joinedW, select: APP_SELECT }),
    dueW ? prisma.application.findMany({ where: dueW, select: APP_SELECT, orderBy: { joiningDate: 'asc' } }) : [],
  ]);
  const gone = await droppedAppIds(joinedAll.map((a) => a.id));
  const left = (a) => gone.has(a.id) || LEFT_STATUS.includes(a.joiningStatus) || a.rollStatus === 'Dropped';
  const dayOf = (a) => (a.joiningDate ? String(a.joiningDate).slice(0, 10) : L.istDay(a.joinedAt));
  joinedAll.sort((a, b) => String(dayOf(b)).localeCompare(String(dayOf(a))));
  const working = joinedAll.filter((a) => !left(a));
  const leftN = joinedAll.length - working.length;
  const onlyWorking = /\bstill working\b|\bworking\b|\bactive\b/.test(t);
  let tillNow = null;
  if (!p.named && !p.all) {
    const ever = await prisma.application.findMany({ where: appWhere(ctx, { stage: { in: JOINED } }, filterArm(f)), select: { id: true, joiningStatus: true, rollStatus: true, joiningDate: true, joinedAt: true } });
    const goneEver = await droppedAppIds(ever.map((a) => a.id));
    const leftEver = ever.filter((a) => goneEver.has(a.id) || LEFT_STATUS.includes(a.joiningStatus) || a.rollStatus === 'Dropped').length;
    tillNow = say(lang, { en: `Till now: ${plural(ever.length, 'joining', 'joinings')} (${ever.length - leftEver} still working, ${leftEver} left after joining)`, tl: `Ippati varaku: ${ever.length} joinings (${ever.length - leftEver} inka work chestunnaru, ${leftEver} vellipoyaru)`, te: `ఇప్పటి వరకు: ${ever.length} జాయినింగ్‌లు` });
  }
  const list = onlyWorking ? working : joinedAll;
  const when = p.label(lang);
  const future = p.from > ctx.today;
  if (future) {
    return answer(ctx, {
      intent: 'joinings', count: dueRows.length, total: dueRows.length,
      title: say(lang, { en: `${when}: ${plural(dueRows.length, 'candidate is', 'candidates are')} due to join${forName(f)}`, tl: `${when}: ${dueRows.length} candidates join avvali${forName(f)}`, te: `${when}: ${dueRows.length} మంది చేరాల్సి ఉంది${forName(f)}` }),
      items: dueRows.map((a) => candItem(a, `${jobOf(a)} · joining ${L.dmy(String(a.joiningDate).slice(0, 10))} · ${V.stageLabel(a.stage)}`)),
      facts: ['Due to join = Selected / Offer / Offer accepted with a joining date in the period.', scopeFact(ctx)],
    });
  }
  const n = list.length;
  return answer(ctx, {
    intent: 'joinings', count: n, total: n + (onlyWorking ? 0 : dueRows.length), open: joinOpen(p, f, onlyWorking ? 'Joined' : undefined),
    title: onlyWorking
      ? say(lang, { en: `${when}: ${plural(n, 'joining', 'joinings')} still working${forName(f)} (${leftN} more joined and left)`, tl: `${when}: ${n} joinings inka work chestunnaru${forName(f)} (${leftN} join ayyi vellipoyaru)`, te: `${when}: ${n} మంది ఇంకా పని చేస్తున్నారు${forName(f)} (${leftN} మానేశారు)` })
      : say(lang, { en: `${when}: ${plural(n, 'joining', 'joinings')}${forName(f)} (${working.length} still working, ${leftN} left after joining)`, tl: `${when}: ${n} joinings${forName(f)} (${working.length} inka work chestunnaru, ${leftN} join ayyi vellipoyaru)`, te: `${when}: ${n} జాయినింగ్‌లు${forName(f)} (${working.length} ఇంకా పని చేస్తున్నారు, ${leftN} చేరి మానేశారు)` }),
    lines: [tillNow, monthLine(list.map(dayOf), p, ctx), dueRows.length ? `Still due to join in this window (joining date set, not joined yet): ${dueRows.length}` : null],
    items: [...list.map((a) => candItem(a, `${jobOf(a)} · joined ${L.dmy(dayOf(a))}${left(a) ? ' · left after joining' : ''}`, `joining-${a.id}`)), ...(onlyWorking ? [] : dueRows.map((a) => candItem(a, `${jobOf(a)} · due to join ${L.dmy(String(a.joiningDate).slice(0, 10))} · ${V.stageLabel(a.stage)}`)))],
    facts: [`Joined = step Joined / Hired with the joining day (the joining date, else the day it was marked joined) between ${L.dmy(p.from)} and ${L.dmy(p.to)}${f && f.name ? `, for ${f.name}` : ''}. "Left after joining" = the Joining & Drop record says Dropped (or the joining / roll status does).`, 'Due to join = Selected / Offer / Offer accepted with a joining date in the window, from today on.', scopeFact(ctx)],
  });
}

async function joiningRecords(ctx, f) {
  const S = require('../joindrop/schema'); // eslint-disable-line global-require
  if (!(await S.ensure())) return [];
  const recs = await S.rows('SELECT * FROM "JoiningRecord" WHERE "status" = \'Dropped\'');
  const ids = recs.map((r) => r.applicationId).filter(Boolean);
  const ok = new Set();
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    (await prisma.application.findMany({ where: { AND: [{ id: { in: ids.slice(i, i + 400) } }, appWhere(ctx, filterArm(f))] }, select: { id: true } })).forEach((a) => ok.add(a.id));
  }
  return recs.filter((r) => ok.has(r.applicationId));
}
async function drops(ctx, p, lang, f) {
  const recs = (await joiningRecords(ctx, f)).filter((r) => r.droppedOn && r.droppedOn >= p.from && r.droppedOn <= p.to).sort((a, b) => String(b.droppedOn).localeCompare(String(a.droppedOn)));
  const RP = require('../joindrop/replacement'); // eslint-disable-line global-require
  const within = recs.filter((r) => r.dropWithinGuarantee === 1).length;
  const n = recs.length;
  const when = p.label(lang);
  return answer(ctx, {
    intent: 'drops', count: n, total: n, open: joinOpen(p, f, 'Dropped'),
    title: say(lang, { en: `${when}: ${plural(n, 'candidate', 'candidates')} left after joining${forName(f)}`, tl: `${when}: ${n} candidates join ayyi vellipoyaru (drops)${forName(f)}`, te: `${when}: ${n} మంది చేరి మానేశారు${forName(f)}` }),
    lines: [monthLine(recs.map((r) => r.droppedOn), p, ctx), n ? `Inside the guarantee (replacement owed): ${within}` : null],
    items: recs.map((r) => candItem({ candidateId: r.candidateId, candidateName: r.candidateName }, `${r.jobTitle || '-'} (${r.clientName || '-'}) · dropped ${L.dmy(r.droppedOn)}${r.dropReason ? ` · ${r.dropReason}` : ''} · ${RP.describe(r, null, { today: ctx.today }).words || ''}`, `drop-${r.applicationId}`)),
    facts: [`Counted: Joining & Drop records marked Dropped with a drop day between ${L.dmy(p.from)} and ${L.dmy(p.to)}${f && f.name ? `, for ${f.name}` : ''}.`, scopeFact(ctx)],
  });
}
async function replacementsDueOf(ctx, f) {
  const RP = require('../joindrop/replacement'); // eslint-disable-line global-require
  return (await joiningRecords(ctx, f)).filter((r) => !r.replacementApplicationId && RP.describe(r, null, { today: ctx.today }).state === 'DUE');
}
async function replacements(ctx, p, lang, f) {
  const RP = require('../joindrop/replacement'); // eslint-disable-line global-require
  const recs = (await joiningRecords(ctx, f)).filter((r) => !r.replacementApplicationId).map((r) => ({ r, d: RP.describe(r, null, { today: ctx.today }) })).filter((x) => x.d.state === 'DUE');
  const dueBy = (r) => r.replacementExpectedOn || r.guaranteeEndsOn || null;
  recs.sort((a, b) => String(dueBy(a.r) || '9999').localeCompare(String(dueBy(b.r) || '9999')));
  const late = recs.filter((x) => dueBy(x.r) && dueBy(x.r) < ctx.today).length;
  const n = recs.length;
  const now = nowLabel(ctx, lang);
  return answer(ctx, {
    intent: 'replacements', count: n, total: n, open: joinOpen({ all: true, to: ctx.today }, f, 'Dropped'),
    title: say(lang, { en: `${now}: ${plural(n, 'replacement is', 'replacements are')} due${forName(f)}`, tl: `${now}: ${n} replacement${n === 1 ? '' : 's'} ivvali (due)${forName(f)}`, te: `${now}: ${n} రీప్లేస్‌మెంట్లు ఇవ్వాలి${forName(f)}` }),
    lines: [n ? `Past the due date: ${late}` : say(lang, { en: 'No replacement is owed right now.', tl: 'Ippudu e replacement due ledu.', te: 'ప్రస్తుతం ఏ రీప్లేస్‌మెంట్ బాకీ లేదు.' })],
    items: recs.map(({ r }) => candItem({ candidateId: r.candidateId, candidateName: r.candidateName }, `${r.jobTitle || '-'} (${r.clientName || '-'}) · dropped ${L.dmy(r.droppedOn)} · replace by ${dueBy(r) ? L.dmy(dueBy(r)) : 'a date not set'}`, `drop-${r.applicationId}`)),
    facts: ['Counted: dropped inside the guarantee (or the client asked for a replacement), no replacement candidate linked yet, the period not over (the Joining & Drop rule, joindrop/replacement.js).', scopeFact(ctx)],
  });
}

// invoices: number, status, due date for everybody here; AMOUNTS only for the logins that already see them
const outstandingOf = (i) => Math.max(0, Number(i.amount || 0) + Number(i.gst || 0) - Number(i.tds || 0) - Number(i.receivedAmount || 0) - Number(i.creditedAmount || 0) - Number(i.adjustedAmount || 0) + Number(i.debitedAmount || 0));
async function invoiceRows(ctx, f) {
  const ids = f && f.departments ? clientIdsOf(ctx, f) : f && f.clientId ? [f.clientId] : [...ctx.clientIds];
  if (!ids.length) return [];
  const sel = { id: true, invoiceNumber: true, clientId: true, status: true, invoiceDate: true, dueDate: true, paidDate: true, candidateId: true };
  if (ctx.billing) Object.assign(sel, { amount: true, gst: true, tds: true, receivedAmount: true, creditedAmount: true, adjustedAmount: true, debitedAmount: true });
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...await prisma.invoice.findMany({ where: { clientId: { in: ids.slice(i, i + 400) }, status: { not: 'Cancelled' } }, select: sel, orderBy: { invoiceDate: 'desc' } }));
  }
  return out;
}
function invoiceItem(ctx, i, sub) {
  const c = ctx.clientById.get(i.clientId);
  return { kind: 'invoice', id: i.id, label: `Invoice ${i.invoiceNumber || i.id.slice(-6).toUpperCase()}`, sub: `${c ? c.name : '-'} · ${sub}`, to: ctx.billing ? `/invoices/${i.id}` : `/clients/${i.clientId}`, history: `/clients/${i.clientId}?tab=history${ctx.billing ? `&focus=invoice-${i.id}` : ''}` };
}
async function invoices(ctx, p, lang, f, t) {
  const all = await invoiceRows(ctx, f);
  const open = all.filter((i) => i.status !== 'Paid');
  const overdue = open.filter((i) => i.dueDate && String(i.dueDate).slice(0, 10) < ctx.today);
  const amt = (list) => (ctx.billing ? ` (${money(list.reduce((s, i) => s + outstandingOf(i), 0))} pending)` : '');
  const amountNote = ctx.billing ? null : 'Amounts are with Accounts and Admin; you see the invoice number, status and due date.';
  const unpaid = /\b(not|un|yet to be|nt) ?paid\b|\bunpaid\b|\bpaid (kaaledu|avvaledu|ledu)\b|\bnot yet paid\b/.test(t);
  const kind = !unpaid && /\bpaid\b|\breceived\b|\bcollected\b|\bpayments? (came|received)\b/.test(t) ? 'paid'
    : /\braised\b|\bgenerated\b|\bsent\b|\bmade\b|\bcreated\b/.test(t) && !/overdue|pending|due/.test(t) ? 'raised'
      : (unpaid || /\bpending\b|\boutstanding\b|\breceivable|\bbalance\b|\bcollect|\bamount\b|\bmoney\b|\bdabbulu\b|\bhow much\b|\bentha\b|\bpayment/.test(t)) && !/overdue|late|past due/.test(t) ? 'open' : 'overdue';
  const days = (i) => L.daysBetween(String(i.dueDate).slice(0, 10), ctx.today);
  const fName = f && f.name ? ` - ${f.name}` : '';
  if (kind === 'paid' || kind === 'raised') {
    const field = kind === 'paid' ? 'paidDate' : 'invoiceDate';
    const list = all.filter((i) => (kind !== 'paid' || i.status === 'Paid') && i[field] && String(i[field]).slice(0, 10) >= p.from && String(i[field]).slice(0, 10) <= p.to);
    const when = p.label(lang);
    return answer(ctx, {
      intent: 'invoices', count: list.length, total: list.length,
      title: say(lang, kind === 'paid'
        ? { en: `${when}: ${plural(list.length, 'invoice', 'invoices')} paid${fName}`, tl: `${when}: ${list.length} invoices paid ayyayi${fName}`, te: `${when}: ${list.length} ఇన్వాయిస్‌లు చెల్లించారు${fName}` }
        : { en: `${when}: ${plural(list.length, 'invoice', 'invoices')} raised${fName}`, tl: `${when}: ${list.length} invoices raise chesam${fName}`, te: `${when}: ${list.length} ఇన్వాయిస్‌లు ఇచ్చాం${fName}` }),
      lines: [monthLine(list.map((i) => String(i[field]).slice(0, 10)), p, ctx), ctx.billing ? `Total ${kind === 'paid' ? 'received' : 'billed'}: ${money(list.reduce((s, i) => s + (kind === 'paid' ? Number(i.receivedAmount || 0) : Number(i.amount || 0) + Number(i.gst || 0)), 0))}` : amountNote],
      items: list.map((i) => invoiceItem(ctx, i, `${i.status} · ${kind === 'paid' ? `paid ${L.dmy(String(i.paidDate).slice(0, 10))}` : `dated ${L.dmy(String(i.invoiceDate).slice(0, 10))}`}`)),
      facts: [`Counted: invoices of your clients (not cancelled) ${kind === 'paid' ? 'marked Paid with a paid date' : 'with an invoice date'} between ${L.dmy(p.from)} and ${L.dmy(p.to)}.`, scopeFact(ctx)],
    });
  }
  const now = nowLabel(ctx, lang);
  if (kind === 'open') {
    return answer(ctx, {
      intent: 'invoices', count: open.length, total: open.length,
      title: say(lang, { en: `${now}: ${plural(open.length, 'invoice is', 'invoices are')} not paid yet${amt(open)}${fName}`, tl: `${now}: ${open.length} invoices inka paid kaaledu${amt(open)}${fName}`, te: `${now}: ${open.length} ఇన్వాయిస్‌లు ఇంకా చెల్లించలేదు${amt(open)}${fName}` }),
      lines: [`Past the due date: ${overdue.length}${amt(overdue)}`, amountNote],
      items: open.map((i) => invoiceItem(ctx, i, `${i.status}${i.dueDate ? ` · due ${L.dm(String(i.dueDate).slice(0, 10))}` : ''}${ctx.billing ? ` · ${money(outstandingOf(i))}` : ''}`)),
      facts: ['Counted: invoices of your clients that are not Paid and not Cancelled.', ctx.billing ? 'Pending amount = amount + GST - TDS - received - credit notes - adjustments.' : 'Invoice amounts are not part of the BDE view.', scopeFact(ctx)],
    });
  }
  overdue.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  return answer(ctx, {
    intent: 'invoices', count: overdue.length, total: overdue.length,
    title: say(lang, { en: `${now}: ${plural(overdue.length, 'invoice is', 'invoices are')} overdue${amt(overdue)}${fName}`, tl: `${now}: ${overdue.length} invoices overdue${amt(overdue)}${fName}`, te: `${now}: ${overdue.length} ఇన్వాయిస్‌లు గడువు దాటాయి${amt(overdue)}${fName}` }),
    lines: [`Not paid in all: ${open.length}`, amountNote, overdue.length ? say(lang, { en: 'Next step: call the client\'s billing contact and log a follow-up on the client page.', tl: 'Next step: client billing contact ki call chesi client page lo follow-up add cheyandi.', te: 'తదుపరి: క్లయింట్ బిల్లింగ్ వ్యక్తికి కాల్ చేసి క్లయింట్ పేజీలో ఫాలో-అప్ నమోదు చేయండి.' }) : null],
    items: overdue.map((i) => invoiceItem(ctx, i, `due ${L.dm(String(i.dueDate).slice(0, 10))} · ${days(i)} days late · ${i.status}${ctx.billing ? ` · ${money(outstandingOf(i))}` : ''}`)),
    facts: [`Counted: invoices of your clients, not Paid / Cancelled, whose due date is before today (${L.dmy(ctx.today)}).`, scopeFact(ctx)],
  });
}

function agreementTerms(c) {
  const fee = c.feeType === 'FIXED' || c.feeType === 'PER_CANDIDATE' ? `${money(c.feeAmount)} ${c.feeType === 'FIXED' ? 'fixed' : 'per candidate'}` : (c.agreementFeePercent != null ? `${c.agreementFeePercent}% of annual CTC` : 'not set');
  return [
    `Agreement: ${V.agreementStatusLabel(V.normalizeAgreementStatus(c.agreementStatus))}${c.agreementId ? ` (${c.agreementId})` : ''}${c.agreementStart && c.agreementEnd ? `, ${L.dmy(c.agreementStart.slice(0, 10))} to ${L.dmy(c.agreementEnd.slice(0, 10))}` : c.agreementEnd ? `, ends ${L.dmy(c.agreementEnd.slice(0, 10))}` : c.agreementStart ? `, from ${L.dmy(c.agreementStart.slice(0, 10))}` : ''}${c.agreementSentAt && !c.agreementSignedAt ? `, sent ${L.dmy(L.istDay(c.agreementSentAt))}, not signed` : ''}${c.agreementSignedAt ? `, signed ${L.dmy(L.istDay(c.agreementSignedAt))}` : ''}`,
    `Fee: ${fee}; guarantee ${c.guaranteePeriod || 'not set'}; payment: ${c.paymentDue || c.paymentTerms || 'not set'}`,
  ];
}
async function creditOf(clientId) {
  return safe(async () => {
    await require('./clientDepth').ensure(); // eslint-disable-line global-require
    const [r] = await prisma.$queryRawUnsafe('SELECT "creditDays", "creditLimit" FROM "ClientCredit" WHERE "clientId" = ?', clientId);
    return r ? { days: r.creditDays == null ? null : Number(r.creditDays), limit: r.creditLimit == null ? null : Number(r.creditLimit) } : null;
  }, null);
}
async function agreements(ctx, p, lang, f, t) {
  if (f && f.clientId) {
    const c = ctx.clientById.get(f.clientId);
    const cr = await creditOf(c.id);
    return answer(ctx, {
      intent: 'agreements', count: null,
      title: `${c.name}: ${V.agreementStatusLabel(V.normalizeAgreementStatus(c.agreementStatus))}`,
      lines: [...agreementTerms(c), `Credit: ${cr && cr.days != null ? `${cr.days} days` : 'no credit period set'}${cr && cr.limit != null ? `, limit ${money(cr.limit)}` : ''}`],
      items: [clientItem(c, 'open the client')],
      facts: ['From the client record (agreement, fee, guarantee, payment terms) and the client\'s credit settings.', scopeFact(ctx)],
    });
  }
  const unsigned = /\bnot signed\b|\bunsigned\b|\bpending\b|\bsign\b|\bsigned\b|\bnot sent\b|\bkaaledu\b|\bavvaledu\b/.test(t) && !/expir|renew|end/.test(t);
  const valid = (c) => V.normalizeAgreementStatus(c.agreementStatus) !== 'REJECTED';
  if (unsigned) {
    const liveJobClients = new Set(ctx.reqs.filter((r) => LIVE.includes(r.status)).map((r) => r.clientId));
    const live = (c) => !/archiv|pause|inactive/i.test(String(c.status || ''));
    const list = clientsOf(ctx, f).filter((c) => live(c) && liveJobClients.has(c.id) && !V.agreementIsSigned(c.agreementStatus));
    const allUnsigned = clientsOf(ctx, f).filter((c) => !V.agreementIsSigned(c.agreementStatus)).length;
    const notSent = list.filter((c) => V.normalizeAgreementStatus(c.agreementStatus) === 'DRAFT').length;
    return answer(ctx, {
      intent: 'agreements', count: list.length, total: list.length,
      title: say(lang, { en: `${nowLabel(ctx, lang)}: ${plural(list.length, 'client', 'clients')} with open requirements ${list.length === 1 ? 'has' : 'have'} no signed agreement`, tl: `${nowLabel(ctx, lang)}: ${list.length} clients ki open requirements unnayi kani agreement sign avvaledu`, te: `${nowLabel(ctx, lang)}: ${list.length} క్లయింట్లకు ఓపెన్ రిక్వైర్‌మెంట్లు ఉన్నాయి కానీ ఒప్పందం సంతకం కాలేదు` }),
      lines: [`Not sent yet: ${notSent}; waiting for the client: ${list.length - notSent}`, `All clients without a signed agreement: ${allUnsigned}`],
      items: list.map((c) => clientItem(c, `${V.agreementStatusLabel(V.normalizeAgreementStatus(c.agreementStatus))}${c.agreementSentAt ? ` · sent ${L.dm(L.istDay(c.agreementSentAt))}` : ''}`)),
      facts: ['The dashboard\'s rule: active clients with a live requirement whose agreement is not Signed / Active.', scopeFact(ctx)],
    });
  }
  const from = p.named && p.from > ctx.today ? p.from : ctx.today;
  const to = p.named ? p.to : L.addDays(ctx.today, 30);
  const withEnd = clientsOf(ctx, f).filter((c) => /^\d{4}-\d{2}-\d{2}/.test(String(c.agreementEnd || '')) && valid(c));
  const soon = withEnd.filter((c) => c.agreementEnd.slice(0, 10) >= from && c.agreementEnd.slice(0, 10) <= to).sort((a, b) => a.agreementEnd.localeCompare(b.agreementEnd));
  const expired = withEnd.filter((c) => c.agreementEnd.slice(0, 10) < ctx.today);
  const daysN = L.daysBetween(ctx.today, to);
  const win = p.named && p.key !== 'days' ? (from > p.from ? L.rangeText(from, to) : p.label(lang)) : say(lang, { en: `Next ${daysN} days (${L.dm(ctx.today)} - ${L.dm(to)})`, tl: `Next ${daysN} rojullo (${L.dm(ctx.today)} - ${L.dm(to)})`, te: `రాబోయే ${daysN} రోజుల్లో` });
  return answer(ctx, {
    intent: 'agreements', count: soon.length, total: soon.length, open: { to: '/ats/agreements', label: 'Open Agreements' },
    title: say(lang, { en: `${win}: ${plural(soon.length, 'agreement ends', 'agreements end')}`, tl: `${win}: ${soon.length} agreements expire avuthayi`, te: `${win}: ${soon.length} ఒప్పందాలు ముగుస్తాయి` }),
    lines: [`Already past the end date: ${expired.length}`, soon.length ? 'Next step: start the renewal from the client page (Agreement) before the end date.' : null],
    items: soon.map((c) => clientItem(c, `ends ${L.dmy(c.agreementEnd.slice(0, 10))} · ${L.daysBetween(ctx.today, c.agreementEnd.slice(0, 10))} days left · ${V.agreementStatusLabel(V.normalizeAgreementStatus(c.agreementStatus))}`)),
    facts: [`Counted: your clients whose agreement end date is between ${L.dmy(from)} and ${L.dmy(to)} (not cancelled / rejected).`, scopeFact(ctx)],
  });
}

async function clientItems(ctx, ids) {
  return safe(() => require('./clientBusiness').itemsOfClients(ids, { kinds: ['followup', 'meeting'] }), []); // eslint-disable-line global-require
}
async function followups(ctx, p, lang, f) {
  const ids = clientIdsOf(ctx, f);
  const upto = p.named && p.key !== 'today' ? p.to : ctx.today;
  const items = (await clientItems(ctx, ids)).filter((x) => x.status === 'Open' && x.dueDate && x.dueDate <= upto).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const late = items.filter((x) => x.dueDate < ctx.today).length;
  const chases = f ? [] : await safe(() => prisma.applicationFollowUp.findMany({
    where: { ownerUserId: ctx.user.id, completedAt: null, dueDate: { lte: upto } },
    select: { id: true, dueDate: true, nextAction: true, purpose: true, candidateId: true, applicationId: true, application: { select: APP_SELECT } }, orderBy: { dueDate: 'asc' }, take: 50,
  }), []);
  let crm = [];
  if (!f) {
    crm = await safe(async () => {
      const S = require('../crm/service'); // eslint-disable-line global-require
      if (!S.roleOf(ctx.user)) return [];
      return (await S.tasks(ctx.user, { when: 'overdue' })).concat(await S.tasks(ctx.user, { when: 'today' }));
    }, []);
  }
  const n = items.length + chases.length + crm.length;
  return answer(ctx, {
    intent: 'followups', count: n, total: n,
    title: say(lang, { en: `${upto === ctx.today ? `Today (${L.dm(ctx.today)})` : `Till ${L.dmy(upto)}`}: ${plural(n, 'follow-up is', 'follow-ups are')} due${upto === ctx.today ? ' (or late)' : ''}`, tl: `${upto === ctx.today ? `Ee roju (${L.dm(ctx.today)})` : `${L.dmy(upto)} varaku`}: ${n} follow-ups due${upto === ctx.today ? ' (late kuda)' : ''}`, te: `${upto === ctx.today ? `ఈ రోజు (${L.dm(ctx.today)})` : `${L.dmy(upto)} వరకు`}: ${n} ఫాలో-అప్‌లు చేయాలి` }),
    lines: [`Client follow-ups and meetings: ${items.length} (${late} late)`, chases.length ? `Your candidate follow-ups: ${chases.length}` : null, crm.length ? `CRM follow-ups: ${crm.length}` : null],
    items: [
      ...items.map((x) => { const c = ctx.clientById.get(x.clientId); return { ...clientItem(c || { id: x.clientId, name: 'Client' }, `${x.kind === 'meeting' ? 'Meeting' : 'Follow-up'}: ${x.title || '-'} · ${x.dueDate < ctx.today ? `late since ${L.dm(x.dueDate)}` : 'today'}`) }; }),
      ...chases.filter((x) => x.application).map((x) => candItem(x.application, `${jobOf(x.application)} · ${x.nextAction || x.purpose || 'follow up'} · due ${L.dm(x.dueDate)}`)),
      ...crm.map((x) => ({ kind: 'crm', id: x.id, label: x.title, sub: `${x.recordName || '-'} · due ${x.dueDate || '-'}`, to: '/crm/followups' })),
    ],
    facts: [`Counted: open client follow-ups and meetings of your clients due on or before ${L.dmy(upto)}; your own open candidate follow-ups due by then${crm.length ? '; your CRM follow-ups due today or late' : ''}.`, scopeFact(ctx)],
  });
}

async function target(ctx, p, lang) {
  const month = (p.named ? p.from : ctx.today).slice(0, 7);
  const from = `${month}-01`;
  const to = L.lastOfMonth(from);
  const me = String(ctx.user.name || '').trim().toLowerCase();
  const signed = ctx.clients.filter((c) => c.agreementSignedAt && L.istDay(c.agreementSignedAt) >= from && L.istDay(c.agreementSignedAt) <= to)
    .filter((c) => ctx.role !== 'bde' || String(c.bdeOwner || '').trim().toLowerCase() === me);
  const RJ = require('./recruiterJoinings'); // eslint-disable-line global-require
  const tgt = await safe(async () => (ctx.role === 'bde' ? RJ.targetOf(await RJ.loadTargetRules(), { employeeId: ctx.user.employeeId || null, department: 'BDE' }, month).target : null), null);
  const jp = { from, to, named: true, key: 'month', all: false, label: () => L.monthLabel(from) };
  const j = await joinings(ctx, jp, lang, null);
  let crm = null;
  await safe(async () => {
    const S = require('../crm/service'); // eslint-disable-line global-require
    const DB = require('../crm/schema'); // eslint-disable-line global-require
    if (!S.roleOf(ctx.user)) return;
    const own = S.seesAll(S.roleOf(ctx.user)) ? '1=1' : '"ownerId" = ?';
    const args = own === '1=1' ? [] : [ctx.user.id];
    const t = await DB.one('SELECT "amount", "deals" FROM "CrmTarget" WHERE "ownerId" = ? AND "month" = ?', ctx.user.id, month).catch(() => null);
    const w = await DB.one(`SELECT COUNT(*) AS "n", COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE ${own} AND "stage" = 'Won' AND substr(COALESCE("wonAt", "updatedAt"), 1, 7) = ?`, ...args, month).catch(() => null);
    crm = { target: t, won: w };
  }, null);
  const n = signed.length;
  const title = ctx.role === 'bde'
    ? say(lang, { en: `${L.monthLabel(from)}: ${n} of ${tgt == null ? '?' : tgt} new clients signed${tgt != null ? ` (${Math.max(0, tgt - n)} to go)` : ''}`, tl: `${L.monthLabel(from)} lo ${n} / ${tgt == null ? '?' : tgt} kotha clients sign ayyaru${tgt != null ? ` (inka ${Math.max(0, tgt - n)})` : ''}`, te: `${L.monthLabel(from)}లో ${n} / ${tgt == null ? '?' : tgt} కొత్త క్లయింట్లు సంతకం చేశారు` })
    : say(lang, { en: `${L.monthLabel(from)}: ${plural(n, 'new client', 'new clients')} signed`, tl: `${L.monthLabel(from)} lo ${n} kotha clients sign ayyaru`, te: `${L.monthLabel(from)}లో ${n} కొత్త క్లయింట్లు` });
  return answer(ctx, {
    intent: 'target', count: n, total: n,
    title,
    lines: [`Candidate joinings on your clients in ${L.monthLabel(from)}: ${j.count}`, crm && crm.won ? `CRM: won ${Number(crm.won.n) || 0} deals, ${money(crm.won.v)}${crm.target ? ` of a ${money(crm.target.amount)} target` : ''}` : null],
    items: signed.map((c) => clientItem(c, `agreement signed ${L.dm(L.istDay(c.agreementSignedAt))}`)),
    facts: ['A BDE\'s closing is a NEW CLIENT whose agreement was signed in the month, credited to the client\'s owner BDE (the joinings board rule, utils/recruiterJoinings.js).', ctx.role === 'bde' ? 'Target = the joinings target set for you (default 4 a month).' : 'The target is per BDE; you see the total.', scopeFact(ctx)],
  });
}

async function clientsList(ctx, p, lang, f, t) {
  let list = clientsOf(ctx, f && f.departments ? f : null);
  const active = /\bactive\b/.test(t) && !/inactive/.test(t);
  if (active) list = list.filter((c) => /^active$/i.test(String(c.status || 'Active')));
  if (/\binactive\b|\bsuspend/.test(t)) list = list.filter((c) => /inactive|suspend/i.test(String(c.status || '')));
  // a window named ("new clients this month", "clients added since january"): the clients ADDED in it
  if (p && p.named && !p.all) list = list.filter((c) => { const d = L.istDay(c.createdAt); return d >= p.from && d <= p.to; });
  const openBy = new Map();
  ctx.reqs.filter((r) => LIVE.includes(r.status)).forEach((r) => openBy.set(r.clientId, (openBy.get(r.clientId) || 0) + 1));
  const byStatus = {};
  list.forEach((c) => { const k = c.status || 'Active'; byStatus[k] = (byStatus[k] || 0) + 1; });
  const withOpen = list.filter((c) => openBy.get(c.id)).length;
  const sorted = [...list].sort((a, b) => (openBy.get(b.id) || 0) - (openBy.get(a.id) || 0) || a.name.localeCompare(b.name));
  const n = list.length;
  const added = p && p.named && !p.all;
  const when = added ? p.label(lang) : nowLabel(ctx, lang);
  const word = active ? 'active client' : 'client';
  return answer(ctx, {
    intent: 'clients', count: n, total: n, open: { to: '/clients', label: 'Open the Clients list' },
    title: added
      ? say(lang, { en: `${when}: ${plural(n, 'new client', 'new clients')} added`, tl: `${when}: ${n} kotha clients add ayyaru`, te: `${when}: ${n} కొత్త క్లయింట్లు` })
      : say(lang, { en: `${when}: you have ${plural(n, word, `${word}s`)}`, tl: `${when}: meeku ${n} ${active ? 'active ' : ''}clients unnaru`, te: `${when}: మీకు ${n} క్లయింట్లు ఉన్నారు` }),
    lines: [Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', '), `With open requirements: ${withOpen}`, added ? monthLine(list.map((c) => L.istDay(c.createdAt)), p, ctx) : null],
    items: sorted.map((c) => clientItem(c, `${openBy.get(c.id) || 0} open requirements · agreement ${V.agreementStatusLabel(V.normalizeAgreementStatus(c.agreementStatus))}${added ? ` · added ${L.dmy(L.istDay(c.createdAt))}` : ''}${ctx.role !== 'bde' && c.bdeOwner ? ` · BDE ${c.bdeOwner}` : ''}`)),
    facts: [added ? `Counted: your clients added between ${L.dmy(p.from)} and ${L.dmy(p.to)}.` : 'Counted: the clients your Clients list shows (utils/scope.js clientWhere).', scopeFact(ctx)],
  });
}

async function appCountsByReq(ctx, reqIds) {
  if (!reqIds.length) return new Map();
  const out = new Map();
  for (let i = 0; i < reqIds.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const g = await prisma.application.groupBy({ by: ['requirementId'], where: appWhere(ctx, { requirementId: { in: reqIds.slice(i, i + 400) } }), _count: { _all: true } });
    g.forEach((x) => out.set(x.requirementId, x._count._all));
  }
  return out;
}
// the requirement statuses in plain words, in the order a list shows them
const REQ_GROUPS = [
  ['open', 'Open', (s) => LIVE.includes(s)],
  ['agreement', 'Waiting for the agreement', (s) => s === 'AGREEMENT_CHECK'],
  ['paused', 'Paused / on hold', (s) => s === 'ON_HOLD'],
  ['request', 'Request, not live yet', (s) => s === 'DRAFT'],
  ['closed', 'Closed', (s) => s === 'CLOSED'],
];
const reqGroupOf = (s) => (REQ_GROUPS.find(([, , fn]) => fn(s)) || ['other', V.requirementStatusLabel(s)])[0];
const reqGroupWord = (k) => (REQ_GROUPS.find(([g]) => g === k) || [k, 'Other'])[1];
// REQUIREMENTS: "open requirements" = the live ones; "closed" / "paused" / "requests" = those; anything else ("requirements list", "how many
// requirements from vcare", "all requirements") = EVERY requirement with the split by status, newest first. A window = created in it.
async function requirements(ctx, p, lang, f, t) {
  let scoped = reqsOf(ctx, f && (f.clientId || f.departments) ? f : null);
  const windowed = p && p.named && !p.all;
  if (windowed) scoped = scoped.filter((r) => { const d = L.istDay(r.createdAt); return d >= p.from && d <= p.to; });
  const fName = forName(f);
  const noProfiles = /\b(no|without|zero|0)\s+(candidates?|profiles?|applications?)\b|\bempty\b|\bnobody\b|\bprofiles? ledu\b|\bprofiles? levu\b/.test(t);
  const want = /\b(closed|close|filled)\b/.test(t) ? 'closed'
    : /\b(paused|on hold|hold)\b/.test(t) ? 'paused'
      : /\b(drafts?|requests?|not live)\b/.test(t) ? 'request'
        : /\b(open|live|active|running|current|ongoing)\b/.test(t) ? 'open'
          : /\b(all|every|total|list|motham)\b/.test(t) ? 'all'
            : /\bpositions?\b|\bvacanc\w*\b|\bopenings?\b/.test(t) ? 'open'
              : /\bagreement\b/.test(t) ? 'agreement' : 'all';
  if (noProfiles) {
    const live = scoped.filter((r) => LIVE.includes(r.status));
    const counts = await appCountsByReq(ctx, live.map((r) => r.id));
    const list = live.filter((r) => !counts.get(r.id));
    const now = nowLabel(ctx, lang);
    return answer(ctx, {
      intent: 'requirements_empty', count: list.length, total: list.length,
      title: say(lang, { en: `${now}: ${plural(list.length, 'open requirement has', 'open requirements have')} no profile with you yet${fName}`, tl: `${now}: ${list.length} open requirements ki inka profiles raaledu${fName}`, te: `${now}: ${list.length} ఓపెన్ రిక్వైర్‌మెంట్లకు ఇంకా ప్రొఫైల్‌లు రాలేదు${fName}` }),
      lines: [list.length ? 'Ask the team lead of each one when the first profiles will come.' : null],
      items: list.map((r) => reqItem(r, `${(r.client && r.client.name) || '-'} · ${r.openings} opening${r.openings === 1 ? '' : 's'} · opened ${L.dmy(L.istDay(r.createdAt))}${r.tl ? ` · TL ${r.tl}` : ''}`)),
      facts: ['Counted: live requirements (open, assigned, sourcing, candidates available) with no candidate at "Check by client manager" or later.', scopeFact(ctx)],
    });
  }
  const split = {};
  scoped.forEach((r) => { const g = reqGroupOf(r.status); split[g] = (split[g] || 0) + 1; });
  const splitLine = [...REQ_GROUPS.map(([g]) => g), 'other'].filter((g) => split[g]).map((g) => `${reqGroupWord(g)} ${split[g]}`).join(' · ') || 'none';
  const order = [...REQ_GROUPS.map(([g]) => g), 'other'];
  const list = (want === 'all' ? scoped : scoped.filter((r) => reqGroupOf(r.status) === want))
    .sort((a, b) => order.indexOf(reqGroupOf(a.status)) - order.indexOf(reqGroupOf(b.status)) || new Date(b.createdAt) - new Date(a.createdAt));
  const counts = await appCountsByReq(ctx, list.slice(0, SHOW).map((r) => r.id));
  const openings = list.filter((r) => LIVE.includes(r.status)).reduce((s, r) => s + (Number(r.openings) || 0), 0);
  const when = windowed ? p.label(lang) : (want === 'all' ? say(lang, { en: `All time (till ${L.dmy(ctx.today)})`, tl: `Ippati varaku (${L.dmy(ctx.today)} varaku)`, te: `ఇప్పటి వరకు (${L.dmy(ctx.today)} వరకు)` }) : nowLabel(ctx, lang));
  const n = list.length;
  const what = want === 'all' ? 'requirement' : `${reqGroupWord(want).toLowerCase()} requirement`;
  const title = want === 'open'
    ? say(lang, { en: `${when}: ${plural(n, 'open requirement', 'open requirements')} (${openings} openings)${fName}`, tl: `${when}: ${n} open requirements (${openings} openings)${fName}`, te: `${when}: ${n} ఓపెన్ రిక్వైర్‌మెంట్లు (${openings} ఖాళీలు)${fName}` })
    : say(lang, { en: `${when}: ${plural(n, what, `${what}s`)}${fName}${want === 'all' ? ` (${splitLine})` : ''}`, tl: `${when}: ${n} requirements${fName}${want === 'all' ? ` (${splitLine})` : ` (${reqGroupWord(want)})`}`, te: `${when}: ${n} రిక్వైర్‌మెంట్లు${fName}${want === 'all' ? ` (${splitLine})` : ` (${reqGroupWord(want)})`}` });
  return answer(ctx, {
    intent: want === 'open' ? 'requirements' : 'requirements_all', count: n, total: n,
    title,
    open: { to: `/ats/search?${qs({ type: 'requirements', client: f && f.clientId ? f.name : undefined, status: want === 'open' ? 'open' : want === 'closed' ? 'closed' : undefined, from: windowed ? p.from : undefined, to: windowed ? p.to : undefined })}`, label: 'Open the full list in Search' },
    lines: [want === 'all' ? null : `All statuses: ${splitLine}`, windowed ? monthLine(scoped.map((r) => L.istDay(r.createdAt)), p, ctx) : null,
      want === 'open' ? `With no profile yet: ${list.slice(0, SHOW).filter((r) => !counts.get(r.id)).length}${list.length > SHOW ? ' (of the first 100)' : ''}` : null],
    items: list.map((r) => reqItem(r, `${(r.client && r.client.name) || '-'} · ${reqGroupWord(reqGroupOf(r.status))} · ${r.openings} opening${r.openings === 1 ? '' : 's'} · opened ${L.dmy(L.istDay(r.createdAt))}${counts.has(r.id) ? ` · ${plural(counts.get(r.id), "profile", "profiles")} with you or the client` : ''}`)),
    facts: [want === 'open' ? 'Counted: requirements at Open / Recruiter assigned / Sourcing / Candidates available (live), client work only.' : `Counted: ${want === 'all' ? 'every' : `every ${reqGroupWord(want).toLowerCase()}`} client requirement in your scope${windowed ? ` created between ${L.dmy(p.from)} and ${L.dmy(p.to)}` : ''}${f && f.name ? `, for ${f.name}` : ''}; newest first within each status.`, scopeFact(ctx)],
  });
}

async function lastActivity(ctx, ids) {
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const g = await prisma.applicationStageEvent.groupBy({ by: ['clientId'], where: { clientId: { in: ids.slice(i, i + 400) }, application: appWhere(ctx) }, _max: { createdAt: true } }).catch(() => []);
    g.forEach((x) => out.set(x.clientId, x._max.createdAt));
  }
  const items = await clientItems(ctx, ids);
  items.forEach((x) => { const at = new Date(x.doneAt || x.createdAt || 0); if (!Number.isNaN(at.getTime()) && (!out.get(x.clientId) || at > out.get(x.clientId))) out.set(x.clientId, at); });
  ctx.reqs.forEach((r) => { if (ids.includes(r.clientId) && (!out.get(r.clientId) || r.createdAt > out.get(r.clientId))) out.set(r.clientId, r.createdAt); });
  return out;
}
// the Clients list's health rule (routes/clients.js healthOf)
function healthOf(lastAt, liveReqs, now = Date.now()) {
  if (!lastAt) return { health: 'dormant', label: 'Dormant', days: null };
  const days = Math.max(0, Math.floor((now - new Date(lastAt).getTime()) / 86400000));
  if (days > 90 || (!liveReqs && days > 60)) return { health: 'dormant', label: 'Dormant', days };
  if (days > 30) return { health: 'quiet', label: 'No activity 30 days', days };
  return { health: 'active', label: 'Active', days };
}
async function health(ctx, p, lang) {
  const ids = ctx.clients.map((c) => c.id);
  const last = await lastActivity(ctx, ids);
  const liveBy = new Map();
  ctx.reqs.filter((r) => LIVE.includes(r.status)).forEach((r) => liveBy.set(r.clientId, (liveBy.get(r.clientId) || 0) + 1));
  const rows = ctx.clients.map((c) => ({ c, h: healthOf(last.get(c.id), liveBy.get(c.id) || 0) }));
  const bad = rows.filter((x) => x.h.health !== 'active').sort((a, b) => (b.h.days == null ? 1e9 : b.h.days) - (a.h.days == null ? 1e9 : a.h.days));
  const cnt = (k) => rows.filter((x) => x.h.health === k).length;
  return answer(ctx, {
    intent: 'health', count: bad.length, total: bad.length,
    title: say(lang, { en: `${nowLabel(ctx, lang)}: ${plural(bad.length, 'client needs', 'clients need')} attention: ${cnt('dormant')} dormant, ${cnt('quiet')} with no activity for 30 days`, tl: `${nowLabel(ctx, lang)}: ${bad.length} clients ni chudali: ${cnt('dormant')} dormant, ${cnt('quiet')} 30 rojulu activity ledu`, te: `${bad.length} క్లయింట్లను చూడాలి: ${cnt('dormant')} నిద్రాణం, ${cnt('quiet')} 30 రోజులుగా కదలిక లేదు` }),
    lines: [`Active: ${cnt('active')}`],
    items: bad.map(({ c, h }) => clientItem(c, `${h.label}${h.days != null ? ` · last activity ${h.days} days ago` : ' · no activity on record'}`)),
    facts: ['Health = the Clients list rule: last activity (candidate steps, client follow-ups, new requirements) within 30 days = Active; 31-90 days = No activity 30 days; more than 90 days, none at all, or no live requirement and 60+ days = Dormant.', scopeFact(ctx)],
  });
}

async function complaintRows(ctx, ids) {
  return safe(async () => {
    const E = require('./atsExperience'); // eslint-disable-line global-require
    const all = await E.q('SELECT "id", "clientId", "clientName", "subject", "status", "level", "ownerName", "dueAt", "createdAt" FROM "AtsComplaint" WHERE "side" = \'client\' ORDER BY "id" DESC LIMIT 3000');
    const set = new Set(ids);
    return all.filter((r) => r.clientId && set.has(r.clientId));
  }, []);
}
async function surveyRows(ctx, ids) {
  return safe(async () => {
    const E = require('./atsExperience'); // eslint-disable-line global-require
    const since = new Date(Date.now() - 365 * 86400000).toISOString();
    const all = await E.q('SELECT "clientId", "nps", "stars", "answeredAt", "comment" FROM "AtsSurvey" WHERE "side" = \'client\' AND "answeredAt" IS NOT NULL AND "answeredAt" >= ?', since);
    const set = new Set(ids);
    return all.filter((r) => r.clientId && set.has(r.clientId));
  }, []);
}
async function complaints(ctx, p, lang, f) {
  const ids = clientIdsOf(ctx, f);
  const rows = (await complaintRows(ctx, ids)).filter((r) => r.status !== 'Resolved');
  const late = rows.filter((r) => r.dueAt && Date.parse(r.dueAt) < Date.now()).length;
  return answer(ctx, {
    intent: 'complaints', count: rows.length, total: rows.length,
    title: say(lang, { en: `${nowLabel(ctx, lang)}: ${plural(rows.length, 'client complaint is', 'client complaints are')} open${forName(f)}`, tl: `${nowLabel(ctx, lang)}: ${rows.length} client complaints open lo unnayi${forName(f)}`, te: `${nowLabel(ctx, lang)}: ${rows.length} క్లయింట్ ఫిర్యాదులు తెరిచి ఉన్నాయి${forName(f)}` }),
    lines: [`Past their due time: ${late}`],
    items: rows.map((r) => { const c = ctx.clientById.get(r.clientId); return { ...clientItem(c || { id: r.clientId, name: r.clientName || 'Client' }, `#${r.id} ${r.subject} · ${r.status} · level ${r.level}${r.ownerName ? ` · with ${r.ownerName}` : ''}`), label: `${(c && c.name) || r.clientName} - complaint #${r.id}` }; }),
    facts: ['Counted: client-side complaints (Experience > Complaints) of your clients that are Open or In progress.', scopeFact(ctx)],
  });
}
async function nps(ctx, p, lang, f) {
  const ids = clientIdsOf(ctx, f);
  const rows = await surveyRows(ctx, ids);
  const E = require('./atsExperience'); // eslint-disable-line global-require
  const n = E.npsOf(rows);
  const low = rows.filter((r) => r.nps != null && Number(r.nps) <= 6);
  return answer(ctx, {
    intent: 'nps', count: n.nps,
    title: n.responses
      ? say(lang, { en: `Last 12 months: client NPS ${n.nps} from ${plural(n.responses, 'answer', 'answers')}${f && f.name ? ` - ${f.name}` : ''}`, tl: `Client NPS ${n.nps} (${n.responses} answers, last 12 nelalu)`, te: `క్లయింట్ NPS ${n.nps} (${n.responses} సమాధానాలు)` })
      : say(lang, { en: 'No client has answered the survey in the last 12 months', tl: 'Last 12 nelallo e client survey ki answer ivvaledu', te: 'గత 12 నెలల్లో ఏ క్లయింట్ సర్వేకు జవాబు ఇవ్వలేదు' }),
    lines: n.responses ? [`Promoters ${n.promoters}, passives ${n.passives}, detractors ${n.detractors}`] : [],
    items: low.map((r) => { const c = ctx.clientById.get(r.clientId); return c ? clientItem(c, `gave ${r.nps}/10 on ${L.dm(String(r.answeredAt).slice(0, 10))}${r.comment ? ` · "${String(r.comment).slice(0, 60)}"` : ''}`) : null; }).filter(Boolean),
    facts: ['NPS = promoters (9-10) minus detractors (0-6), as a % of the answers, client surveys answered in the last 12 months, your clients only.', scopeFact(ctx)],
  });
}

async function crm(ctx, p, lang, f, t) {
  const out = await safe(async () => {
    const S = require('../crm/service'); // eslint-disable-line global-require
    const DB = require('../crm/schema'); // eslint-disable-line global-require
    const r = S.roleOf(ctx.user);
    if (!r) return null;
    const own = S.seesAll(r) ? '1=1' : '"ownerId" = ?';
    const args = own === '1=1' ? [] : [ctx.user.id];
    const deals = await DB.all(`SELECT d."id", d."title", d."stage", d."value", d."expectedClose", a."name" AS "account" FROM "CrmDeal" d LEFT JOIN "CrmAccount" a ON a."id" = d."accountId" WHERE ${own.replace('"ownerId"', 'd."ownerId"')} AND d."stage" NOT IN ('Won', 'Lost') ORDER BY d."value" DESC`, ...args);
    const leads = await DB.all(`SELECT "id", "company", "status", "rating" FROM "CrmLead" WHERE ${own} AND "status" NOT IN ('Converted', 'Junk') ORDER BY "updatedAt" DESC`, ...args);
    return { deals, leads };
  }, null);
  if (!out) {
    return answer(ctx, {
      intent: 'crm', count: null,
      title: say(lang, { en: 'The CRM is not open to your login', tl: 'Mee login ki CRM open ledu', te: 'మీ లాగిన్‌కు CRM తెరవలేదు' }),
      lines: ['Leads and deals are kept by the sales team; your client work (clients, requirements, candidates, agreements) is all here.'],
      facts: ['CRM access is given by the Super Admin to the sales team only.'],
    });
  }
  const leadsQ = /\blead/.test(t) && !/\bdeal/.test(t);
  const list = leadsQ ? out.leads : out.deals;
  return answer(ctx, {
    intent: 'crm', count: list.length, total: list.length,
    title: leadsQ ? `${plural(out.leads.length, 'open lead', 'open leads')}` : `${plural(out.deals.length, 'open deal', 'open deals')} worth ${money(out.deals.reduce((s, d) => s + Number(d.value || 0), 0))}`,
    lines: [leadsQ ? `Open deals: ${out.deals.length}` : `Open leads: ${out.leads.length}`],
    items: list.map((x) => (leadsQ ? { kind: 'crm', id: x.id, label: x.company, sub: `${x.status}${x.rating ? ` · ${x.rating}` : ''}`, to: '/crm/leads' } : { kind: 'crm', id: x.id, label: x.title, sub: `${x.account || '-'} · ${x.stage} · ${money(x.value)}${x.expectedClose ? ` · close ${x.expectedClose}` : ''}`, to: '/crm/deals' })),
    facts: ['From the CRM: deals not Won / Lost, leads not Converted / Junk, yours (or all, for a CRM manager).'],
  });
}

async function agenda(ctx, p, lang) {
  const today = { from: ctx.today, to: ctx.today, named: true, key: 'today', label: (lg) => L.periodOf('today', 'today', ctx.today).label(lg) };
  const week7 = { from: ctx.today, to: L.addDays(ctx.today, 7), named: true, key: 'days', n: 7, label: (lg) => say(lg, { en: 'in the next 7 days', tl: 'next 7 rojullo', te: 'రాబోయే 7 రోజుల్లో' }) };
  const [iv, fu, fb, jn, rp, inv, ag] = await Promise.all([
    interviews(ctx, today, lang), followups(ctx, today, lang), feedback(ctx, today, lang), joinings(ctx, today, lang),
    replacements(ctx, today, lang), invoices(ctx, today, lang, null, 'overdue'), agreements(ctx, week7, lang, null, 'expiring'),
  ]);
  const parts = [[iv.count, 'interviews'], [fu.count, 'follow-ups due'], [fb.count, 'waiting for client feedback'], [jn.count, 'joinings'], [rp.count, 'replacements due'], [inv.count, 'invoices overdue'], [ag.count, 'agreements ending in 7 days']];
  const tl = { interviews: 'interviews', 'follow-ups due': 'follow-ups', 'waiting for client feedback': 'client feedback pending', joinings: 'joinings', 'replacements due': 'replacements', 'invoices overdue': 'overdue invoices', 'agreements ending in 7 days': 'agreements 7 rojullo end' };
  const total = parts.reduce((s, [n]) => s + (n || 0), 0);
  return answer(ctx, {
    intent: 'agenda', count: total, total: total, show: 12,
    title: say(lang, { en: `Today (${L.dm(ctx.today)}): ${iv.count} interviews, ${fu.count} follow-ups due, ${fb.count} waiting for client feedback`, tl: `Ee roju (${L.dm(ctx.today)}): ${iv.count} interviews, ${fu.count} follow-ups, ${fb.count} client feedback pending`, te: `ఈ రోజు (${L.dm(ctx.today)}): ${iv.count} ఇంటర్వ్యూలు, ${fu.count} ఫాలో-అప్‌లు, ${fb.count} ఫీడ్‌బ్యాక్ పెండింగ్` }),
    lines: parts.slice(3).map(([n, k]) => `${lang === 'tl' ? tl[k] : k}: ${n}`),
    items: [...iv.items.slice(0, 4), ...fu.items.slice(0, 3), ...fb.items.slice(0, 3), ...jn.items.slice(0, 2)],
    facts: ['Each number is the same as asking for it on its own: interviews today, follow-ups due today or late, client feedback pending, joinings today, replacements due, overdue invoices, agreements ending in the next 7 days.', scopeFact(ctx)],
  });
}

// ---- one record (360) ------------------------------------------------------------------------------------------------------------
async function teamOf(ctx, reqs) {
  const ids = reqs.map((r) => r.id);
  if (!ids.length) return { recruiters: [], bdes: [] };
  const full = await prisma.requirement.findMany({ where: { id: { in: ids } }, select: { recruiterId: true, recruiterIds: true, bdeId: true } });
  const worked = await prisma.application.groupBy({ by: ['ownerRecruiterId'], where: appWhere(ctx, { requirementId: { in: ids } }, { ownerRecruiterId: { not: null } }) }).catch(() => []);
  const rec = new Set(); const bde = new Set();
  full.forEach((r) => { if (r.recruiterId) rec.add(r.recruiterId); String(r.recruiterIds || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => rec.add(x)); if (r.bdeId) bde.add(r.bdeId); });
  worked.forEach((w) => rec.add(w.ownerRecruiterId));
  const users = await prisma.user.findMany({ where: { id: { in: [...rec, ...bde] } }, select: { id: true, name: true } });
  const nm = new Map(users.map((u) => [u.id, u.name]));
  return { recruiters: [...rec].map((x) => nm.get(x)).filter(Boolean).sort(), bdes: [...bde].map((x) => nm.get(x)).filter(Boolean).sort() };
}
async function client360(ctx, c, lang) {
  const reqs = ctx.reqs.filter((r) => r.clientId === c.id);
  const team = await teamOf(ctx, reqs).catch(() => null);
  const live = reqs.filter((r) => LIVE.includes(r.status));
  const appW = appWhere(ctx, { requirement: { clientId: c.id } });
  const [byStage, upcoming, cr, inv, comp, surv, items, pend] = await Promise.all([
    prisma.application.groupBy({ by: ['stage'], where: appW, _count: { _all: true } }),
    prisma.application.count({ where: appWhere(ctx, { requirement: { clientId: c.id } }, { interviewAt: { gte: L.startOf(ctx.today) } }, { stage: { not: 'REJECTED' } }, { OR: [{ interviewStatus: null }, { interviewStatus: { not: 'CANCELLED' } }] }) }),
    creditOf(c.id), invoiceRows(ctx, { clientId: c.id }), complaintRows(ctx, [c.id]), surveyRows(ctx, [c.id]), clientItems(ctx, [c.id]), pendingOf(ctx),
  ]);
  const st = Object.fromEntries(byStage.map((g) => [g.stage, g._count._all]));
  const sum = (codes) => codes.reduce((s, k) => s + (st[k] || 0), 0);
  const shared = sum(['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED']);
  const open = inv.filter((i) => i.status !== 'Paid');
  const overdue = open.filter((i) => i.dueDate && String(i.dueDate).slice(0, 10) < ctx.today);
  const lastDone = items.filter((x) => x.status !== 'Open' && (x.doneAt || x.createdAt)).sort((a, b) => String(b.doneAt || b.createdAt).localeCompare(String(a.doneAt || a.createdAt)))[0];
  const nextOpen = items.filter((x) => x.status === 'Open').sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
  const last = (await lastActivity(ctx, [c.id])).get(c.id);
  const h = healthOf(last, live.length);
  const npsN = surv.length ? require('./atsExperience').npsOf(surv) : null; // eslint-disable-line global-require
  const p = pend ? require('./clientWork').forClient(pend, c.id) : null; // eslint-disable-line global-require
  const contact = [c.contactName, c.contactDesignation, c.contactPhone, c.contactEmail].filter(Boolean).join(', ');
  return answer(ctx, {
    intent: 'client', count: live.length, record: { kind: 'client', id: c.id, name: c.name },
    title: `${c.name}${c.clientCode ? ` (${c.clientCode})` : ''}: ${plural(live.length, 'open requirement', 'open requirements')}, ${plural(shared, 'profile', 'profiles')} shared, ${sum(JOINED)} joined`,
    lines: [
      `Status ${c.status || 'Active'}${c.priority ? `, priority ${c.priority}` : ''}${c.industry ? `, ${c.industry}` : ''}${c.location ? `, ${c.location}` : ''}${c.ownerDepartment ? `, desk ${c.ownerDepartment}` : ''}; BDE ${c.bdeOwner || 'not set'}; health ${h.label}${h.days != null ? ` (last activity ${h.days} days ago)` : ''}`,
      `Handled by: BDE ${[c.bdeOwner, c.secondaryBde].filter(Boolean).join(', ') || 'not set'}; TL ${[...new Set(reqs.map((r) => r.tl).filter(Boolean))].join(', ') || 'not set'}${team && team.recruiters.length ? `; recruiters ${team.recruiters.slice(0, 8).join(', ')}${team.recruiters.length > 8 ? ` +${team.recruiters.length - 8} more` : ''}` : ''}`,
      `Contact: ${contact || 'not set'}`,
      `Last contact: ${lastDone ? `${lastDone.kind === 'meeting' ? 'meeting' : 'follow-up'} "${lastDone.title || '-'}" on ${L.dm(String(lastDone.doneAt || lastDone.createdAt).slice(0, 10))}` : 'no follow-up logged'}${nextOpen ? `; next: "${nextOpen.title || '-'}" due ${L.dm(nextOpen.dueDate)}` : ''}`,
      ...agreementTerms(c),
      `Credit: ${cr && cr.days != null ? `${cr.days} days` : 'no credit period set'}${cr && cr.limit != null ? `, limit ${money(cr.limit)}` : ''}`,
      `Requirements: ${reqs.length} in all (${[...REQ_GROUPS.map(([g]) => g), 'other'].map((g) => [g, reqs.filter((r) => reqGroupOf(r.status) === g).length]).filter(([, k]) => k).map(([g, k]) => `${reqGroupWord(g)} ${k}`).join(' · ') || 'none'}) - ask "${c.name} requirements list" for all of them`,
      `Pipeline (with you or later): with BDE ${sum(['WITH_BDE', 'BDE_APPROVED'])}, sent to client ${sum(['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'])}, shortlisted ${sum(['CLIENT_SHORTLISTED'])}, interview ${sum(['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'])} (${upcoming} upcoming), selected / offer ${sum(SELECTED_NOW)}, joined ${sum(JOINED)}, rejected ${st.REJECTED || 0}`,
      p ? `Pending work: ${p.total} (no reply ${p.counts.noReply || 0}, no feedback ${p.counts.feedback || 0}, interview to book ${p.counts.shortlisted || 0})` : null,
      `Invoices: ${open.length} not paid, ${overdue.length} overdue${ctx.billing ? ` (${money(open.reduce((s, i) => s + outstandingOf(i), 0))} pending)` : ''}`,
      `Complaints open: ${comp.filter((x) => x.status !== 'Resolved').length}${npsN && npsN.responses ? `; NPS ${npsN.nps} from ${npsN.responses} answers` : ''}`,
    ],
    items: [clientItem(c, 'client page'), ...live.map((r) => reqItem(r, `${r.openings} opening${r.openings === 1 ? '' : 's'}`))],
    facts: ['From the client record, its requirements, the candidates on them in your view, its follow-ups, credit settings, invoices (status only unless you see amounts), complaints and surveys.', scopeFact(ctx)],
  });
}
async function requirement360(ctx, r, lang) {
  const rteam = await teamOf(ctx, [r]).catch(() => null);
  const appW = appWhere(ctx, { requirementId: r.id });
  const [byStage, rows, nextIv] = await Promise.all([
    prisma.application.groupBy({ by: ['stage'], where: appW, _count: { _all: true } }),
    prisma.application.findMany({ where: appW, select: APP_SELECT, orderBy: { updatedAt: 'desc' }, take: SHOW }),
    prisma.application.findMany({ where: appWhere(ctx, { requirementId: r.id }, { interviewAt: { gte: L.startOf(ctx.today) } }, { stage: { not: 'REJECTED' } }), select: APP_SELECT, orderBy: { interviewAt: 'asc' }, take: 3 }),
  ]);
  const st = Object.fromEntries(byStage.map((g) => [g.stage, g._count._all]));
  const sum = (codes) => codes.reduce((s, k) => s + (st[k] || 0), 0);
  const total = byStage.reduce((s, g) => s + g._count._all, 0);
  return answer(ctx, {
    intent: 'requirement', count: total, record: { kind: 'requirement', id: r.id, name: r.title },
    title: `${r.title}${r.reqCode ? ` (${r.reqCode})` : ''} for ${(r.client && r.client.name) || '-'}: ${V.requirementStateWords(r.status) === 'open' ? 'open' : V.requirementStateWords(r.status)}, ${r.openings} opening${r.openings === 1 ? '' : 's'}, ${plural(total, 'profile', 'profiles')} in your view`,
    lines: [
      `Handled by: BDE ${(rteam && rteam.bdes.join(', ')) || (ctx.clientById.get(r.clientId) || {}).bdeOwner || 'not set'}; TL ${r.tl || 'not set'}${rteam && rteam.recruiters.length ? `; recruiters ${rteam.recruiters.slice(0, 8).join(', ')}` : ''}`,
      `Opened ${L.dmy(L.istDay(r.createdAt))}${r.closingDate ? `, closes ${L.dmy(String(r.closingDate).slice(0, 10))}` : ''}${r.location ? `, ${r.location}` : ''}${r.department ? `, ${r.department}` : ''}${r.tl ? `; TL ${r.tl}` : ''}; priority ${r.priority}`,
      `With BDE ${sum(['WITH_BDE', 'BDE_APPROVED'])}, sent to client ${sum(['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'])}, shortlisted ${sum(['CLIENT_SHORTLISTED'])}, interview ${sum(['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'])}, selected / offer ${sum(SELECTED_NOW)}, joined ${sum(JOINED)}, rejected ${st.REJECTED || 0}`,
      nextIv.length ? `Next interview: ${nextIv.map((a) => `${a.candidate.name} ${L.dm(L.istDay(a.interviewAt))} ${L.timeOf(a.interviewAt)}`).join('; ')}` : null,
    ],
    items: [reqItem(r, 'requirement page'), ...rows.map((a) => candItem(a, `${stepOf(a)}${a.interviewAt ? ` · interview ${L.dm(L.istDay(a.interviewAt))}` : ''}`))],
    facts: ['From the requirement and the candidates on it in your view (from "Check by client manager" onward).', scopeFact(ctx)],
  });
}
async function candidate360(ctx, candidateId, lang) {
  const rows = await prisma.application.findMany({ where: appWhere(ctx, { candidateId }), select: APP_SELECT, orderBy: { updatedAt: 'desc' }, take: 10 });
  if (!rows.length) return null;
  const name = rows[0].candidate.name;
  return answer(ctx, {
    intent: 'candidate', count: rows.length, record: { kind: 'candidate', id: candidateId, name },
    title: `${name}: ${rows.map((a) => `${stepOf(a)} for ${jobOf(a)}`).join('; ')}`,
    lines: rows.map((a) => [a.interviewAt ? `interview ${L.dm(L.istDay(a.interviewAt))} ${L.timeOf(a.interviewAt)}` : null, a.offerStatus && a.offerStatus !== 'Not Issued' ? a.offerStatus.toLowerCase() : null, a.joiningDate ? `joining ${L.dmy(String(a.joiningDate).slice(0, 10))}` : null].filter(Boolean).join(', ')).filter(Boolean),
    items: [candItem(rows[0], 'complete history'), ...rows.map((a) => ({ ...reqItem({ id: a.requirementId, title: a.requirement.title, reqCode: a.requirement.reqCode }, `${(a.requirement.client && a.requirement.client.name) || '-'} · ${stepOf(a)}`) }))],
    facts: ['The BDE view of a candidate: name and progress only (never phone, e-mail, address, salary or ID documents).', scopeFact(ctx)],
  });
}

// ---- "how do I ..." --------------------------------------------------------------------------------------------------------------
const PROCESS = [
  { re: /add.*client|new client|create.*client|onboard.*client/, key: 'client', en: 'Clients > Add client: company, contacts, desk, commercial terms. Then make and send the agreement from the client page.', to: '/clients' },
  { re: /client login|portal login|portal access/, key: 'login', en: 'A client asks for a login from the portal, or you request it from the client page; it is approved under Clients > Portal logins.', to: '/clients/portal-logins' },
  { re: /drop|left|replace|guarantee|abscond/, key: 'drop', en: 'If a joined candidate leaves, report the drop from Joining > the person > Report a drop (date and reason). Inside the guarantee the client may ask for a replacement: record the client\'s decision, then link the new candidate as the replacement.', to: '/ats/joining' },
  { re: /agreement|contract|sign|renew|e-?sign/, key: 'agreement', en: 'Open the client > Agreement: make the agreement, send it for e-sign, and follow it until it is Signed and then Active. Before the end date, start the renewal from the same tab (Agreements > Renewals lists the ones ending soon).', to: '/ats/agreements' },
  { re: /invoice|payment|bill|paid|collect|outstanding/, key: 'invoice', en: 'Accounts raises the invoice after the joining and records the payment. As the BDE you follow up the client for payment when an invoice is past due (your dashboard lists them) and log the follow-up on the client page.', to: '/ats/dashboard' },
  { re: /offer/, key: 'offer', en: 'After the client selects a candidate, the offer is released from Offers (Interviews & Joining > Offers). The candidate accepts, declines or asks for time there. You see the step, never the offered pay.', to: '/ats/offers' },
  { re: /join|onboard/, key: 'joining', en: 'Record the joining from Joining (Interviews & Joining > Joining) or the candidate page: the joining date and the client\'s confirmation. Accounts raises the invoice after the joining.', to: '/ats/joining' },
  { re: /interview|schedule|slot/, key: 'interview', en: 'When the client shortlists a profile, book the interview from the candidate (Interview > Schedule): date, time, mode and interviewer. TeamLink checks for clashes and sends the invites. After the interview, record the client\'s feedback on the same screen.', to: '/ats/calendar' },
  { re: /phone|mobile|e-?mail|salary|ctc|contact.*candidate|candidate.*contact|number|address|document/, key: 'limited', en: 'In the BDE view a candidate shows only the name and the progress. The phone, e-mail, address, salary and documents stay with the recruiter and the team lead; ask the team lead of the requirement when the client needs something.', to: null },
  { re: /feedback|reply|respond|chase/, key: 'feedback', en: 'Pending client feedback is listed on your dashboard (Client work). Call or mail the client contact, then record the answer on the candidate (shortlist / reject / interview result). Log the call as a follow-up on the client page so the next person knows.', to: '/ats/dashboard' },
  { re: /share|send.*(profile|cv|candidate)|profile.*(client|send)|submit/, key: 'share', en: 'Profiles reach you at "Check by client manager" after the recruiter and the team lead have checked them. Open the candidate from Candidates (or the requirement), check the share checklist, and press Send to client. The client then sees it in their portal; their answer comes back to you.', to: '/candidates' },
  { re: /follow.?up|remind|meeting/, key: 'followup', en: 'Open the client > Business activities > Add a follow-up (or a meeting) with the date. It shows on your dashboard and in this agent when it is due, and you get a reminder that day.', to: '/clients' },
  { re: /requirement|req\b|job|vacanc|opening|position|post/, key: 'requirement', en: 'A requirement starts with the client: they raise it in the client portal (or you use Clients > the client > Request a requirement). It comes to you (BDE), then to the BDE team lead, and then the department team lead ticks who gets the responses and POSTS it. The team lead posts, not the recruiter. It goes live only when the client\'s agreement is active (or an unsigned start is approved).', to: '/requirements' },
];

// ============================================================================================================================================
// DETECTION
// ============================================================================================================================================
const TOPICS = [
  ['replacements', /\breplacements?\b|\breplace\b|\bguarantee\b/],
  ['drops', /\bdrops?\b|\bdropped\b|\bleft (after|the job|the company)\b|\babscond|\bvellipoyaru\b|\bmanesaru\b|\bquit\b/],
  ['invoices', /\binvoices?\b|\bbills?\b|\bbilling\b|\bpayments?\b|\bpaid\b|\boutstanding\b|\breceivables?\b|\bdabbulu\b|\bcollections?\b|\bpending amount\b|\bamount pending\b|\bdues\b/],
  ['agreements', /\bagreements?\b|\bcontracts?\b|\brenewals?\b|\bexpir\w*\b|\bmou\b|\bfee\b|\bcredit (days|period|limit)\b|\bpayment terms\b|\bunsigned\b/],
  ['complaints', /\bcomplain\w*\b|\bescalat\w*\b|\bgrievance/],
  ['nps', /\bnps\b|\bsatisf\w*\b|\bsurvey\b|\bfeedback score\b/],
  ['health', /\bhealth\b|\bdormant\b|\bno activity\b|\binactive clients?\b|\bquiet clients?\b|\bneglected\b/],
  ['followups', /\bfollow ups\b|\bfollow up\b|\bcall backs?\b|\bremind\w*\b|\bmeetings?\b/],
  ['target', /\btargets?\b|\bachiev\w*\b|\bquota\b|\bclosings?\b|\bincentive\b/],
  ['crm', /\bcrm\b|\bleads?\b|\bdeals?\b/],
  ['feedback', /\bfeedback\b|\bnot replied\b|\bno reply\b|\bnot responded\b|\bno response\b|\bwaiting for (the )?client\b|\bclient (has not|hasn't|did not|didn't) (reply|replied|respond|responded)\b|\breply ivvaledu\b|\bresponse ledu\b|\bshortlisted\b/],
  ['interviews', /\binterviews\b|\binterview\b/],
  ['offers', /\boffers?\b|\boffer letter\b/],
  ['joinings', /\bjoinings\b|\bjoined\b|\bjoin\b|\bjoining\b|\bonboard\w*\b|\bplacements?\b|\bplaced\b/],
  ['selections', /\bselected\b|\bselect\b/],
  ['shared', /\bshared?\b|\bsent to (the )?clients?\b|\bsubmitted\b|\bsubmissions?\b|\bprofiles? (sent|shared)\b|\bsend chesina\b|\bpampina\b/],
  ['requirements', /\brequirements?\b|\breqs?\b|\bvacanc\w*\b|\bopenings?\b|\bpositions?\b|\bjobs?\b|\bhiring\b/],
  ['clients', /\bclients?\b|\bcustomers?\b|\baccounts?\b|\bcompan(y|ies)\b/],
];
const ADVICE = /\b(pitch|objection|convince|negotiat\w*|draft|write|compose|tips?|advice|advise|suggest\w*|what should i say|how should i|how can i convince|better|improve|strategy|why)\b/;
const PROCESS_Q = /\bhow (do|can|should|to) (i|we)?\b|\bhow to\b|\bprocess\b|\bprocedure\b|\bsteps? (to|for)\b|\bela (cheyali|cheyyali|cheyalo|cheyyalo|pampali|chesthe|raise|add)\b|\bwhere (do|can) i\b|\bwho (posts|approves|raises|sends)\b|\bwhy can'?t i see\b|\bwhy (is|are) .* hidden\b|\bcan i see\b/;
const HELP = /^(help|hi|hello|hey|namaste|namaskaram|menu|start|good (morning|afternoon|evening)|thanks|thank you)\b|\bwhat can you (do|answer|tell)\b|\bwhat (questions|can i ask)\b|\bemi adagali\b/;
const AGENDA = /\bagenda\b|\bmy day\b|\bplan for today\b|\btoday (work|plan|tasks?|list|pending|pani|panulu|summary)\b|\b(what is|whats|what's|what) (pending|due|there|on) (for me )?today\b|\b(pending|work|tasks?|pani|panulu) (for )?today\b|\bwhat (do|should) i do today\b|\bsummary\b|\boverview\b|\bdashboard\b|\bem cheyali today\b|\bpending (for me|work|items)\b|\bwhat is pending\b|\bwhats pending\b|\bmy pending\b/;
const ABOUT = /\babout\b|\bdetails?\b|\bstatus of\b|\bstatus for\b|\bupdate on\b|\b360\b|\btell me\b|\bgurinchi\b|\binfo\b|\binformation\b|\bhistory of\b|\bhow is\b|\bwhere is\b|\bprogress of\b|\bprogress\b|\bwhat happened\b|\bcheppu\b|\bchupinchu\b/;

const STOP = new Set(`a an the and or of for to in on at by with from is are was were be been am do does did have has had i me my mine we our you your it its this that these those
what which who whom whose when where why how many much any some all show list give tell get find see check please pls kindly can could would should will shall may might
there here now today tomorrow yesterday week weeks month months year days day next last this coming upcoming previous within past due late overdue pending open closed
about details detail status update info information history 360 progress happened where is how me us our total count number numbers so far till yet still not no new
client clients customer customers account accounts company companies requirement requirements req reqs job jobs vacancy vacancies opening openings position positions hiring
candidate candidates profile profiles cv cvs resume resumes interview interviews interviewed offer offers joining joinings joined join selected selection selections drop drops dropped
replacement replacements invoice invoices bill bills payment payments paid agreement agreements contract contracts expiring expire expiry expired renewal renewals signed unsigned sign
follow ups up followups meeting meetings target targets achieved complaint complaints nps health shared share sent submitted feedback reply replied waiting
enti entha enni emi emiti em ela evaru eppudu ekkada cheppu cheppandi chupinchu chupinchandi kavali undi unnayi unnaya unda vunnayi vundi ayyindi ayyayi ayye ayyevi naaku naa maa
meeku mee gurinchi lo ki ni ga ee roju repu ninna vaaram nela gatha ledu levu chesam chesanu ivvali avvali avvaledu kaaledu raaledu kosam inka mariyu and also
current currently latest recent recently ok okay thanks thank hello hi dear sir madam
evi avi adi idi vati valla ku tho kuda anni inni entho enduku ippudu eppatiki varaku nundi daaka chusi chesi cheyandi pettandi ivvandi vachina vacche raabooye
kottha kotha unnara unnaru unnadi ayina aina sari sare ante kada kadu emaina edaina chesina chesaru pampina pampinchina ayyaru avvali cheyali cheyyali book booked
person people name named whom someone anyone cheppandi chepu chupinchandi telusu teliyali kanipinchu
january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
till until upto since before after between nundi nunchi varaku daaka onwards onward date dates completed complete done finished finish total totally overall ever alltime
time far list lists motham mottham year years samvatsaram wise breakdown month-wise still working left range period whole entire
are there have been got happened came made raised released per each
handles handle handled handling owner owns own report reports work worked activity activities performance summary did doing bde bdes team all every each
department departments dept desk wise monthly daily roju vaari vari nela which most least top ranking leaderboard best highest lowest maximum minimum more less
naa nenu chesina chesaru chesindi pani panulu`.split(/\s+/));

function residualOf(norm) {
  return norm.split(' ').filter((w) => w && !STOP.has(w) && !/^[\d/.-]+$/.test(w) && !/^\d{1,2}(st|nd|rd|th)$/.test(w) && w.length >= 2).join(' ').trim();
}

// ---- name resolution: the login's own clients and requirements in memory, then the one scoped search engine -------------------
const lev1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; } else {
      edits += 1; if (edits > 1) return false;
      if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i += 1; j += 1; }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
function wordScore(tok, words) {
  let best = 0;
  words.forEach((w) => {
    if (w === tok) best = Math.max(best, tok.length + 2);
    else if (tok.length >= 3 && w.startsWith(tok)) best = Math.max(best, tok.length);
    else if (tok.length >= 4 && lev1(tok, w)) best = Math.max(best, tok.length - 1);
    else if (tok.length >= 5 && w.length >= 5 && lev1(tok, w.slice(0, tok.length))) best = Math.max(best, tok.length - 2);
  });
  return best;
}
function scoreName(tokens, name, code) {
  const words = String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const c = String(code || '').toLowerCase();
  let s = 0; let hit = 0;
  tokens.forEach((t) => { const ws = Math.max(wordScore(t, words), c && c === t ? t.length + 3 : 0); if (ws) { s += ws; hit += 1; } });
  return { s, hit };
}
function memoryMatch(ctx, residual) {
  const AS = require('./atsSearch'); // eslint-disable-line global-require
  const tokens = residual.split(/\s+/).map((t) => (L.TELUGU.test(t) ? AS.teluguToLatin(t) : t)).filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  const best = (list, nameOf, codeOf) => {
    const scored = list.map((x) => ({ x, ...scoreName(tokens, nameOf(x), codeOf(x)) })).filter((y) => y.s >= 4);
    scored.sort((a, b) => b.hit - a.hit || b.s - a.s);
    return scored;
  };
  const cs = best(ctx.clients, (c) => c.name, (c) => c.clientCode);
  const rs = best(ctx.reqs, (r) => r.title, (r) => r.reqCode);
  const top = (arr) => (arr.length ? arr[0] : null);
  const c = top(cs); const r = top(rs);
  if (c && (!r || c.hit > r.hit || (c.hit === r.hit && c.s >= r.s))) {
    const ties = cs.filter((y) => y.hit === c.hit && y.s === c.s);
    return { kind: 'client', x: c.x, ties: ties.length > 1 ? ties.map((y) => y.x) : null, hit: c.hit, tokens: tokens.length };
  }
  if (r) {
    const ties = rs.filter((y) => y.hit === r.hit && y.s === r.s);
    return { kind: 'requirement', x: r.x, ties: ties.length > 1 ? ties.map((y) => y.x) : null, hit: r.hit, tokens: tokens.length };
  }
  return null;
}
async function engineMatch(ctx, residual) {
  const AS = require('./atsSearch'); // eslint-disable-line global-require
  const tries = [residual];
  const words = residual.split(' ').filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
  if (words.length > 1) tries.push(words.slice(0, 2).join(' '), words[0]);
  for (const q of [...new Set(tries)]) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const r = await safe(() => AS.search(ctx.user, q, { mode: 'type' }), null);
    if (!r) continue; // eslint-disable-line no-continue
    // only what the words name THEMSELVES: a requirement listed because a searched candidate applied to it, or a client listed by its contact
    // person, is not an answer (that candidate may be outside this login's view)
    const cd = (r.candidates || []).filter((x) => nameFits(q, x.name));
    // a shorter try (some of the words left out) must name the record itself: its name, or its code in full
    const part = q !== residual;
    const fits = (x, nm) => nameFits(q, nm) || String(x.code || '').toLowerCase() === q;
    const cl = (r.clients || []).filter((x) => (!(x.via || []).includes('contact person') || nameFits(q, x.name)) && (!part || fits(x, x.name))).map((x) => ctx.clientById.get(x.id)).filter(Boolean);
    const rq = (r.requirements || []).filter((x) => (x.matchedBy || []).some((m) => m === 'requirement' || m === 'client') && (!part || fits(x, x.title))).map((x) => ctx.reqById.get(x.id)).filter(Boolean);
    if (cd.length) return { kind: 'candidate', x: cd[0], ties: cd.length > 1 ? cd.slice(0, 5) : null };
    if (cl.length) return { kind: 'client', x: cl[0], ties: cl.length > 1 && q.split(' ').length === 1 ? cl.slice(0, 5) : null };
    if (rq.length) return { kind: 'requirement', x: rq[0], ties: null };
  }
  return null;
}
// a candidate found by the engine counts only when every typed word starts a word of the name (so "evi" never finds "Devi")
function nameFits(residual, name) {
  const AS = require('./atsSearch'); // eslint-disable-line global-require
  const words = String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const toks = residual.split(/\s+/).map((t) => (L.TELUGU.test(t) ? AS.teluguToLatin(t) : t)).filter((t) => t.length >= 2);
  return toks.length > 0 && toks.every((t) => words.some((w) => w.startsWith(t) || (t.length >= 4 && lev1(t, w))));
}
async function resolve(ctx, residual, { candidates = true } = {}) {
  if (!residual || residual.replace(/\s/g, '').length < 3) return null;
  const mem = memoryMatch(ctx, residual);
  if (mem && mem.hit === mem.tokens) return mem;
  const eng = residual.replace(/\s/g, '').length >= 4 ? await engineMatch(ctx, residual) : null;
  if (eng && eng.kind === 'candidate') {
    if (!candidates) return mem || null;
    return mem && mem.hit >= 2 ? mem : eng;
  }
  return mem || eng;
}

const RUN = {
  interviews: [interviews, 'next7'], shared: [shared, 'week'], feedback: [feedback, 'month'], selections: [selections, 'month'], offers: [offers, 'month'],
  joinings: [joinings, 'month'], drops: [drops, 'month'], replacements: [replacements, 'month'], invoices: [invoices, 'month'], agreements: [agreements, 'days'],
  followups: [followups, 'today'], target: [target, 'month'], clients: [clientsList, 'month'], requirements: [requirements, 'month'], health: [health, 'month'],
  complaints: [complaints, 'month'], nps: [nps, 'month'], crm: [crm, 'month'], agenda: [agenda, 'today'],
};

function topicsOf(norm) { return TOPICS.filter(([, re]) => re.test(norm)).map(([k]) => k); }

// route(user, question) -> { kind: 'code' | 'model' | 'advice', answers[], record, lang, norm, topics }
async function route(user, question, { fresh = false } = {}) {
  const lang = L.langOf(question);
  const norm = L.normalize(question);
  const ctx = await contextOf(user, { fresh });
  const cacheKey = `${lang}|${norm}`;
  const hit = ctx.answers.get(cacheKey);
  if (hit && !fresh) return { ...hit, cached: true };
  const out = await routeUncached(ctx, question, norm, lang);
  out.lang = lang;
  if (out.kind === 'code') { ctx.answers.set(cacheKey, out); if (ctx.answers.size > 200) ctx.answers.delete(ctx.answers.keys().next().value); }
  return out;
}

async function routeUncached(ctx, question, norm, lang) {
  if (HELP.test(norm) && norm.split(' ').length <= 6) return { kind: 'code', answers: [help(ctx, lang)] };
  const topics = topicsOf(norm);
  const advice = ADVICE.test(norm);
  if (PROCESS_Q.test(norm) && !/\bhow many\b|\bhow much\b/.test(norm)) {
    const p = PROCESS.find((x) => x.re.test(norm));
    if (p && !advice) return { kind: 'code', answers: [processAnswer(ctx, p, lang)] };
    if (!p && !advice) return { kind: 'model', answers: [], topics, reason: 'process' };
  }
  if (advice) {
    const record = await resolve(ctx, residualOf(norm), { candidates: false });
    return { kind: 'advice', answers: [], topics, record };
  }

  // ---- people, the team, departments, month-wise / day-wise history (founder 2026-11-21) ----------------------------------------
  const T = require('./bdeAgentTeam'); // eslint-disable-line global-require
  const team = await routeTeam(ctx, question, norm, lang, topics, T);
  if (team) return team;
  if (AGENDA.test(norm) && !topics.some((t) => ['interviews', 'invoices', 'agreements', 'joinings', 'replacements', 'drops'].includes(t))) {
    return { kind: 'code', answers: [await agenda(ctx, L.periodOf(norm, 'today', ctx.today), lang)] };
  }
  const residual = residualOf(norm);
  const PIPE = ['interviews', 'offers', 'joinings', 'selections', 'feedback', 'shared', 'drops', 'replacements'];
  const rec = residual ? await resolve(ctx, residual, { candidates: !topics.length || ABOUT.test(norm) || topics.some((t) => PIPE.includes(t)) }) : null;
  if (rec && rec.kind === 'candidate' && !rec.ties) {
    const a = await candidate360(ctx, rec.x.id, lang);
    if (a) return { kind: 'code', answers: [a], record: rec };
  }
  if (rec && rec.ties && rec.ties.length > 1 && !(rec.hit && rec.hit === rec.tokens && rec.kind !== 'candidate')) {
    return { kind: 'code', answers: [choose(ctx, rec, lang)] };
  }
  const f = rec && rec.kind === 'client' ? { clientId: rec.x.id, name: rec.x.name } : rec && rec.kind === 'requirement' ? { requirementId: rec.x.id, clientId: null, name: rec.x.title } : null;
  // a record named, and the question is about it (or names nothing else): its 360
  const listTopics = topics.filter((t) => !(t === 'clients' && rec && rec.kind === 'client') && !(t === 'requirements' && rec && rec.kind === 'requirement'));
  if (rec && (!listTopics.length || (ABOUT.test(norm) && !listTopics.some((t) => ['interviews', 'invoices', 'agreements', 'shared', 'feedback', 'joinings', 'selections', 'offers', 'drops', 'replacements', 'complaints', 'followups'].includes(t))))) {
    if (rec.kind === 'client') return { kind: 'code', answers: [await client360(ctx, rec.x, lang)], record: rec };
    if (rec.kind === 'requirement') return { kind: 'code', answers: [await requirement360(ctx, rec.x, lang)], record: rec };
    const a = await candidate360(ctx, rec.x.id, lang);
    if (a) return { kind: 'code', answers: [a], record: rec };
  }
  const grain = T.grainOf(norm);
  const hm = grain ? historyMetric(listTopics.length ? listTopics : topics, norm, T) : null;
  if (hm) {
    const hf = f && rec.kind === 'requirement' ? { requirementId: rec.x.id, name: rec.x.title } : f;
    return { kind: 'code', answers: [await T.history(ctx, hm, historyWindow(norm, grain, ctx), grain, lang, hf)], record: rec };
  }
  if (listTopics.length) {
    // "interviews today and overdue invoices": up to two answers
    const firstAt = (k) => { const m = norm.match(TOPICS.find(([x]) => x === k)[1]); return m ? m.index : 999; };
    const pick = norm.includes(' and ') || norm.includes(' mariyu ') ? [...listTopics].sort((a, b) => firstAt(a) - firstAt(b)).slice(0, 2) : listTopics.slice(0, 1);
    const fr = f && rec.kind === 'requirement' && ['agreements', 'invoices', 'complaints', 'nps', 'followups'].some((x) => pick.includes(x)) ? { clientId: rec.x.clientId, name: (rec.x.client && rec.x.client.name) || f.name } : f;
    const answers = [];
    for (const t of pick) { // eslint-disable-line no-restricted-syntax
      const [fn, def] = RUN[t];
      const p = L.periodOf(norm, def, ctx.today, { future: t === 'agreements' });
      // eslint-disable-next-line no-await-in-loop
      answers.push(await fn(ctx, p, lang, t === 'clients' ? null : fr, norm));
    }
    return { kind: 'code', answers, record: rec };
  }
  // a NAME that matched nothing (the words of "Tell me about X", a capitalised name, Telugu, or one or two bare words): say so plainly;
  // anything else open-ended goes to the model
  const named = ABOUT.test(norm) || L.TELUGU.test(question) || residual.split(' ').length <= 2 || /\s[A-Z][a-z]/.test(String(question).trim());
  // any small keyword (a city, a skill, a REQ code, an invoice number, part of a name): the one scoped search engine
  if (residual && residual.replace(/\s/g, '').length >= 2 && residual.split(' ').length <= 4) {
    const k = await T.keywordSearch(ctx, residual, lang);
    if (k) return { kind: 'code', answers: [k] };
  }
  if (residual && residual.replace(/\s/g, '').length >= 3 && named) {
    return { kind: 'code', answers: [notFound(ctx, residual, lang)], notFound: true };
  }
  return { kind: 'model', answers: [], topics, record: rec };
}


// ---- people, the team, departments and history --------------------------------------------------------------------------------------
const TEAM_WORDS = /\b(all|every|each)\s+(the\s+)?bdes?\b|\bbdes\b|\bteam\b|\bbde[\s-]?wise\b|\bper bde\b|\bwhich bde\b|\bwho (did|has|made|got|had|gave|shared|booked|logged|closed)\b|\bleaderboard\b|\branking\b|\btop bdes?\b|\bandaru\b|\banni bdes?\b/;
const SELF_WORDS = /\b(my|naa|na|mana)\s+(report|work|day|week|month|performance|activity|summary|history|pani|panulu)\b|\bwhat (did|have) i (do|done)\b|\bnenu (emi|em) chesanu\b|\bmy (today|todays)\b/;
const PENDING_WORDS = /\bmy pending\b|\bpending (items|work|list|panulu|anni)\b|\bwhat is late\b|\bwhats late\b|\blate (items|work)\b|\boverdue (work|items)\b|\bpending( work)? of\b/;
const REPORT_WORDS = /\breport\b|\bwork\b|\bactivity\b|\bperformance\b|\bsummary\b|\bwhat did\b|\bdone\b|\bpani\b|\bchesaru\b|\bchesindi\b|\bhistory\b|\btoday\b|\byesterday\b/;
const DEPT_ALL = /\bdepartments\b|\bdepartment[\s-]?wise\b|\bdept[\s-]?wise\b|\bdesk[\s-]?wise\b|^department report$|^dept report$|\ball departments\b|\bdepartment report\b/;
function historyMetric(topics, norm, T) {
  for (const t of topics) { // eslint-disable-line no-restricted-syntax
    if (t === 'invoices') return /\bpaid\b|\breceived\b/.test(norm) ? 'invPaid' : 'invRaised';
    const m = T.TOPIC_METRIC[t];
    if (m && T.HISTORY_METRICS.includes(m)) return m;
  }
  return null;
}
function historyWindow(norm, grain, ctx) {
  const p = L.periodOf(norm, 'all', ctx.today);
  if (p.named || grain !== 'day') return p;
  return L.periodOf('last 30 days', 'all', ctx.today);
}
const withWho = (a, name) => { const i = String(a.title || '').indexOf(': '); return i < 0 ? { ...a, title: `${name} - ${a.title}` } : { ...a, title: `${a.title.slice(0, i + 2)}${name} - ${a.title.slice(i + 2)}` }; };
async function routeTeam(ctx, question, norm, lang, topics, T) {
  const grain = T.grainOf(norm);
  const teamy = TEAM_WORDS.test(norm);
  const rank = /\b(most|maximum|highest|top|best|ekkuva)\b/.test(norm) ? 'most' : /\b(least|fewest|lowest|minimum|takkuva)\b/.test(norm) ? 'least' : null;
  const metricOf = () => { if (topics.includes('invoices')) return /\bpaid\b/.test(norm) ? 'invPaid' : 'invRaised'; const t = topics.find((x) => T.TOPIC_METRIC[x]); return t ? T.TOPIC_METRIC[t] : null; };
  const listTopics = topics.filter((t) => t !== 'clients' || /\bclients? of\b|\bclients\b/.test(norm));
  const runWith = async (c, name, f) => {
    if (PENDING_WORDS.test(norm) || (name && /\bpending\b/.test(norm) && !listTopics.length)) return T.pendingReport(c, lang, name);
    const hm = grain ? historyMetric(listTopics, norm, T) : null;
    if (hm) return T.history(c, hm, historyWindow(norm, grain, ctx), grain, lang, f, name);
    if (listTopics.length) {
      const t = listTopics[0];
      const [fn, def] = RUN[t];
      const a = await fn(c, L.periodOf(norm, def, ctx.today, { future: t === 'agreements' }), lang, t === 'clients' ? (f && f.departments ? f : null) : f, norm);
      return name ? withWho(a, name) : a;
    }
    return null;
  };
  // 1. a BDE TL / Admin / Super Admin names a BDE: that person's work (their own scope)
  if (T.canSeeTeam(ctx)) {
    const who = await T.matchBde(ctx, residualOf(norm));
    if (who && who.ties) {
      return { kind: 'code', answers: [answer(ctx, { intent: 'choose', count: who.ties.length, title: say(lang, { en: `${who.ties.length} BDEs match. Which one do you mean?`, tl: `${who.ties.length} BDEs match ayyaru. Evaru?`, te: `${who.ties.length} BDEలు సరిపోలారు. ఎవరు?` }), lines: ['Ask again with the full name.'], items: who.ties.map((u) => ({ kind: 'person', id: u.id, label: u.name, sub: 'BDE', to: `/clients?search=${encodeURIComponent(u.name)}` })), facts: [scopeFact(ctx)] })] };
    }
    if (who) {
      const c = await T.ctxOfBde(ctx, who.user);
      const a = await runWith(c, who.user.name, null);
      const ans = a || await T.personReport(c, L.periodOf(norm, 'today', ctx.today), lang, who.user.name);
      const also = await T.sameNameCandidates(ctx, residualOf(norm));
      if (also) { ans.lines = [also.line, ...(ans.lines || [])]; ans.items = [also.item, ...(ans.items || [])]; }
      return { kind: 'code', answers: [ans], person: who.user.id };
    }
    // 2. the team: one row per BDE, a ranking, or the team's month-wise history
    if (teamy) {
      const metric = metricOf();
      const hm = grain ? historyMetric(listTopics, norm, T) : null;
      if (hm) return { kind: 'code', answers: [await T.history(ctx, hm, historyWindow(norm, grain, ctx), grain, lang, null, 'the team')] };
      return { kind: 'code', answers: [await T.teamReport(ctx, L.periodOf(norm, 'today', ctx.today), lang, metric, { rank })] };
    }
  } else if (teamy || SELF_WORDS.test(norm) || (PENDING_WORDS.test(norm))) {
    // a BDE: only their own work, whatever is asked for the team or another person
    const note = teamy ? say(lang, { en: 'A BDE login shows only your own work; here it is.', tl: 'BDE login lo mee pani matrame kanipistundi; idi mee report.', te: 'BDE లాగిన్‌లో మీ పని మాత్రమే కనిపిస్తుంది.' }) : null;
    if (!teamy) { const a = await runWith(ctx, null, null); if (a) return { kind: 'code', answers: [a] }; }
    const own = await T.personReport(ctx, L.periodOf(norm, 'today', ctx.today), lang, ctx.user.name, note);
    return { kind: 'code', answers: [own] };
  }
  if (T.canSeeTeam(ctx) && SELF_WORDS.test(norm)) return { kind: 'code', answers: [await T.teamReport(ctx, L.periodOf(norm, 'today', ctx.today), lang, metricOf(), { rank })] };
  if (PENDING_WORDS.test(norm)) return { kind: 'code', answers: [await T.pendingReport(ctx, lang, null)] };
  // 3. a department
  const dep = T.deptOf(ctx, norm, question);
  if (dep) {
    const rest = residualOf(norm.replace(dep.word, ' '));
    const other = rest ? memoryMatchQuick(ctx, rest) : null;
    if (!other) {
      const f = { departments: dep.departments, name: dep.name };
      const a = await runWith(ctx, null, f);
      if (a) return { kind: 'code', answers: [a] };
      return { kind: 'code', answers: [await T.deptReport(ctx, dep, L.periodOf(norm, 'month', ctx.today), lang)] };
    }
  } else if (DEPT_ALL.test(norm)) {
    return { kind: 'code', answers: [await T.deptReport(ctx, null, L.periodOf(norm, 'month', ctx.today), lang)] };
  }
  return null;
}
// a client / requirement the words name, from the login's own lists only (no search engine): keeps "Kovida medical" a client question
function memoryMatchQuick(ctx, rest) { const m = memoryMatch(ctx, rest); return m && m.hit === m.tokens ? m : null; }

function choose(ctx, rec, lang) {
  const items = rec.ties.map((x) => (rec.kind === 'client' ? clientItem(x, x.location || '') : rec.kind === 'requirement' ? reqItem(x, (x.client && x.client.name) || '') : { kind: 'candidate', id: x.id, label: x.name, sub: x.step || '', to: `/ats/history/candidate/${x.id}`, record: `/candidates/${x.id}` }));
  return answer(ctx, {
    intent: 'choose', count: items.length,
    title: say(lang, { en: `${items.length} records match. Which one do you mean?`, tl: `${items.length} match ayyayi. Edi kavali?`, te: `${items.length} సరిపోలాయి. ఏది కావాలి?` }),
    lines: ['Ask again with the full name, or open one below.'], items, facts: [scopeFact(ctx)],
  });
}
function notFound(ctx, residual, lang) {
  // the same words for a record outside the login's scope and for a name that does not exist
  return answer(ctx, {
    intent: 'not_found', count: 0,
    title: say(lang, { en: `Nothing called "${residual}" in your clients, requirements or candidates`, tl: `Mee clients, requirements, candidates lo "${residual}" ledu`, te: `మీ క్లయింట్లు, రిక్వైర్‌మెంట్లు, అభ్యర్థుల్లో "${residual}" లేదు` }),
    lines: ['Check the spelling or try part of the name. Try: "Today\'s interviews", "Overdue invoices", "Tell me about <client>".'],
    facts: [scopeFact(ctx)],
  });
}
function processAnswer(ctx, p, lang) {
  return answer(ctx, {
    intent: 'process', count: null, title: p.en.split('. ')[0], lines: p.en.split('. ').slice(1).map((s) => s.replace(/\.$/, '')).filter(Boolean).map((s) => `${s}.`),
    items: p.to ? [{ kind: 'page', id: p.key, label: 'Open the screen', sub: p.to, to: p.to }] : [],
    facts: ['TeamLink\'s own process (the same rules the screens enforce).'],
  });
}
function help(ctx, lang) {
  return answer(ctx, {
    intent: 'help', count: null,
    title: say(lang, { en: 'Ask me about your clients and their candidates, in English or Telugu', tl: 'Mee clients, candidates gurinchi English lo leda Telugu lo adagandi', te: 'మీ క్లయింట్లు, అభ్యర్థుల గురించి తెలుగులో లేదా ఇంగ్లీష్‌లో అడగండి' }),
    lines: [
      'Today: "What is pending today?", "Today\'s interviews", "Follow-ups due"',
      'Pipeline: "Profiles shared this week", "Pending client feedback", "Selections this month", "Open offers", "Joinings this month"',
      'After joining: "Drops this month", "Replacements due"',
      'Money and terms: "Overdue invoices", "Agreements expiring in 30 days", "Agreements not signed"',
      'One record: "Tell me about <client>", "Status of <requirement>", "Where is <candidate>?"',
      'Process: "How do I raise a requirement?", "How do I report a drop?"',
    ],
    facts: [scopeFact(ctx)],
  });
}

// the exact numbers an open-ended question is answered from (the model never computes one)
async function summaryFacts(ctx, lang) {
  const a = await agenda(ctx, L.periodOf('today', 'today', ctx.today), lang);
  const [cl, rq, sh, jn, ag] = await Promise.all([
    clientsList(ctx, null, lang, null, ''), requirements(ctx, null, lang, null, ''),
    shared(ctx, L.periodOf('this week', 'week', ctx.today), lang), joinings(ctx, L.periodOf('this month', 'month', ctx.today), lang),
    agreements(ctx, L.periodOf('', 'days', ctx.today), lang, null, 'not signed'),
  ]);
  return [a, cl, rq, sh, jn, ag];
}

module.exports = {
  route, contextOf, invalidate, summaryFacts, resolve, residualOf, topicsOf, RUN, PROCESS, client360, requirement360, candidate360, healthOf,
  // shared with utils/bdeAgentTeam.js
  _h: {
    appWhere, APP_SELECT, filterArm, clientIdsOf, clientsOf, reqsOf, clientItems, clientItem, reqItem, candItem, jobOf, stepOf, reqGroupOf, reqGroupWord, REQ_GROUPS,
    distinctEventApps, appsById, JOINED, LIVE, LEFT_STATUS, dayArm, droppedAppIds, joiningRecords, invoiceRows, invoiceItem, answer, pendingOf, replacementsDueOf,
    money, scopeFact, nowLabel, qs, safe,
  },
};
