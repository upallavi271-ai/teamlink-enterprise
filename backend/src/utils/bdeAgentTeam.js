// ---------------------------------------------------------------------------
// BDE AGENT - PEOPLE, TEAM, DEPARTMENT, HISTORY AND KEYWORD ANSWERS (founder 2026-11-21: "for the BDE TL: search a BDE's name -> what that BDE
// did TODAY; 'all BDEs report', 'all BDEs interviews report'; department-wise; joinings, drops, replacements month-wise and day-wise - complete;
// any small keyword must give the answer. Same for BDEs: their own work history, each person sees only their own.")
//
//   bdeList(ctx)                     the BDE logins a BDE TL / Admin / Super Admin reports on (active, ATS role BDE)
//   matchBde(ctx, residual)          a BDE named in the question (first name, part of the name, one wrong letter)
//   dayData(ctx, metric, p, f)       the dated records of one metric in a window, read through the login's own scope -> [{ id, day, item }]
//   personReport(ctx, p, lang, who)  one person's work in the window (+ the day-wise / month-wise table, + what is pending now)
//   teamReport(ctx, p, lang, metric) one row per BDE + the team total (each record once), or a ranking for one metric
//   deptReport / deptOf              a department's numbers, lists and the BDEs handling it
//   history(ctx, metric, p, grain)   month-wise / day-wise table of joinings, drops, replacements, interviews ...
//   keywordSearch(ctx, text)         anything else: the one scoped search engine (utils/atsSearch.js)
//
// SCOPE: a BDE's numbers are read through THAT BDE's own scope (utils/identity.js resolveIdentity -> the same helpers), so the BDE TL's person
// report equals the BDE's own "my report". Only a BDE TL, an Admin or the Super Admin reports on other people (their scope holds every BDE's work);
// a BDE always gets their own work, and the names of other BDEs are never matched for them. READ ONLY.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./atsVocab');
const L = require('./bdeAgentLang');

const R = () => require('./bdeAgentRouter'); // eslint-disable-line global-require
const H = () => R()._h;
const say = L.say;
const TEST_RE = /zztest|example\.test/i;
const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- who ---------------------------------------------------------------------------------------------------------------------------
const canSeeTeam = (ctx) => ctx.role === 'admin' || ctx.role === 'bdetl';
async function bdeList(ctx) {
  if (ctx.bdes) return ctx.bdes;
  // the BDEs and the BDE team leads ("luhitha report" is a BDE TL, founder 2026-11-27)
  const users = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ atsRole: 'BDE' }, { atsRole: 'TL', OR: [{ atsDepartment: 'BDE' }, { atsScopeDepartments: { contains: 'BDE' } }] }] },
    select: { id: true, name: true, email: true, atsRole: true }, orderBy: { name: 'asc' },
  });
  ctx.bdes = users.filter((u) => u.name && (ctx.testViewer || !TEST_RE.test(`${u.name} ${u.email || ''}`))).map((u) => ({ id: u.id, name: u.name, email: u.email, bdeTl: u.atsRole === 'TL' }));
  return ctx.bdes;
}
const lev1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; } else { e += 1; if (e > 1) return false; if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; } }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
};
// the BDE whose name the words carry: a whole word of the name, a 4+ letter start of one, or one wrong letter in a 5+ letter word
async function matchBde(ctx, residual) {
  if (!canSeeTeam(ctx) || !residual) return null;
  const toks = residual.split(/\s+/).filter((t) => t.length >= 3);
  if (!toks.length) return null;
  const list = await bdeList(ctx);
  const scored = list.map((u) => {
    const words = String(u.name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let s = 0; let hit = 0;
    toks.forEach((t) => { const before = s; if (words.includes(t)) s += t.length + 2; else if (t.length >= 4 && words.some((w) => w.startsWith(t))) s += t.length; else if (t.length >= 5 && words.some((w) => w.length >= 5 && lev1(t, w))) s += t.length - 1; if (s > before) hit += 1; });
    // exact: every word is the name's own word (or its start) - not only a near spelling ("shailaja" is near "sailaja")
    const exact = toks.every((t) => words.includes(t) || (t.length >= 4 && words.some((w) => w.startsWith(t))));
    return { u, s, all: hit === toks.length, exact };
  }).filter((x) => x.s >= 4 && x.all) // every word must be part of the name: "Sravani Kondapalli" (a candidate) is not the BDE "Sravani".sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  const ties = scored.filter((x) => x.s === scored[0].s).map((x) => x.u);
  return { user: scored[0].u, ties: ties.length > 1 ? ties : null, exact: !!scored[0].exact };
}
// a BDE was named; candidates in the viewer's scope may carry the same name: "Also candidates named sailaja: 5" (+ a Search link), never a question back
async function sameNameCandidates(ctx, words) {
  if (!words) return null;
  const AS = require('./atsSearch'); // eslint-disable-line global-require
  const r = await H().safe(() => AS.search(ctx.user, words, { limit: 100, type: 'candidates' }), null);
  const g = r && (r.groups || []).find((x) => x.id === 'candidates');
  if (!g || !g.rows.length) return null;
  // only the ones whose NAME carries the words (the search also matches e-mails, skills ...)
  const toks = words.split(/\s+/).filter(Boolean);
  const named = g.rows.filter((x) => { const ws = String(x.name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u); return toks.every((t) => ws.some((w) => w.startsWith(t))); }).length;
  if (!named) return null;
  const n = g.count > g.rows.length && named === g.rows.length ? `${named}+` : String(named);
  const to = `/ats/search?q=${encodeURIComponent(words)}&type=candidates`;
  return { line: `Also candidates named "${words}": ${n} (open them in Search)`, item: { kind: 'search', id: `cand-${words}`, label: `Candidates named "${words}" (${n})`, sub: 'search', to }, count: named };
}
async function ctxOfBde(ctx, u) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const id = await resolveIdentity(u.id);
  const c = await R().contextOf(id);
  c.viewerBilling = ctx.billing; // amounts follow the VIEWER's right, never the BDE's
  return c;
}

// ---- departments -------------------------------------------------------------------------------------------------------------------
const DEPT_WORDS = [
  [/\bnon[\s-]?it[\s-]?medical\b/, (d) => /non\s*-?\s*it\s*medical/i.test(d)],
  [/\bnon[\s-]?it[\s-]?(mfg|manufacturing)\b|\bmanufacturing\b|\bmfg\b/, (d) => /manufactur|mfg/i.test(d) && !/medical/i.test(d)],
  [/\beducation(al)?\b|\bedu\b/, (d) => /educ|^edu$/i.test(d)],
  [/\bmedical\b|\bmed\b/, (d) => /^medical$/i.test(d) || /^med$/i.test(d)],
];
function deptValues(ctx) {
  const s = new Set();
  ctx.clients.forEach((c) => c.ownerDepartment && s.add(c.ownerDepartment));
  ctx.reqs.forEach((r) => r.department && s.add(r.department));
  return [...s];
}
// -> { departments: [stored spellings], name, words: RegExp } | null
function deptOf(ctx, norm, raw) {
  const vals = deptValues(ctx);
  for (const [re, fits] of DEPT_WORDS) { // eslint-disable-line no-restricted-syntax
    const m = norm.match(re);
    if (m) {
      const deps = vals.filter(fits);
      if (deps.length) return { departments: deps, name: deps[0], word: m[0] };
    }
  }
  if (/\bbde (department|dept|desk|team)\b/.test(norm)) {
    const deps = vals.filter((d) => /^bde$/i.test(d));
    if (deps.length) return { departments: deps, name: deps[0], word: 'bde' };
  }
  if (/\bIT\b/.test(String(raw || '')) || /\bit (department|dept|desk|team|requirements?|joinings?|clients?|report)\b/.test(norm)) {
    const deps = vals.filter((d) => /^it$/i.test(d));
    if (deps.length) return { departments: deps, name: deps[0], word: 'it' };
  }
  const exact = vals.find((d) => d.length >= 4 && new RegExp(`\\b${d.toLowerCase().replace(/[^a-z0-9 ]/g, '.')}\\b`).test(norm));
  return exact ? { departments: [exact], name: exact, word: exact.toLowerCase() } : null;
}

// ---- the dated records of one metric --------------------------------------------------------------------------------------------
const inP = (d, p) => !!d && d >= p.from && d <= p.to;
async function closedDays(reqs) {
  const closed = reqs.filter((r) => r.status === 'CLOSED');
  const out = new Map();
  if (!closed.length) return out;
  for (let i = 0; i < closed.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.auditLog.findMany({ where: { entity: 'Requirement', entityId: { in: closed.slice(i, i + 400).map((r) => r.id) }, action: { startsWith: 'Requirement status' }, toValue: 'CLOSED' }, select: { entityId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    rows.forEach((a) => out.set(a.entityId, L.istDay(a.createdAt)));
  }
  closed.forEach((r) => { if (!out.has(r.id)) out.set(r.id, L.istDay(r.updatedAt)); });
  return out;
}
const METRICS = {
  followups: { en: 'client follow-ups', short: 'follow-ups' },
  meetings: { en: 'client meetings', short: 'meetings' },
  candFollowups: { en: 'candidate follow-ups', short: 'candidate follow-ups' },
  reqsRaised: { en: 'requirements raised', short: 'requirements raised' },
  reqsClosed: { en: 'requirements closed', short: 'requirements closed' },
  shared: { en: 'profiles shared', short: 'shared' },
  interviews: { en: 'interviews', short: 'interviews' },
  feedbackIn: { en: 'client feedback received', short: 'feedback received' },
  selections: { en: 'selections', short: 'selections' },
  offers: { en: 'offers', short: 'offers' },
  joinings: { en: 'joinings', short: 'joinings' },
  drops: { en: 'drops', short: 'drops' },
  replacements: { en: 'replacements owed', short: 'replacements' },
  replaced: { en: 'replacements given', short: 'replaced' },
  invRaised: { en: 'invoices raised', short: 'invoices raised' },
  invPaid: { en: 'invoices paid', short: 'invoices paid' },
  newClients: { en: 'new clients', short: 'new clients' },
  signed: { en: 'agreements signed', short: 'agreements signed' },
};
async function dayData(ctx, metric, p, f) {
  const h = H();
  const self = ctx.role === 'bde' || ctx.role === 'other';
  const clientIds = h.clientIdsOf(ctx, f);
  const appF = h.filterArm(f);
  switch (metric) {
    case 'followups': case 'meetings': {
      const items = await h.clientItems(ctx, clientIds);
      const kind = metric === 'followups' ? 'followup' : 'meeting';
      return items.filter((x) => x.kind === kind && inP(L.istDay(x.createdAt), p) && (!self || x.createdById === ctx.user.id || x.ownerId === ctx.user.id))
        .map((x) => { const c = ctx.clientById.get(x.clientId); return { id: x.id, day: L.istDay(x.createdAt), item: h.clientItem(c || { id: x.clientId, name: 'Client' }, `${kind === 'meeting' ? 'Meeting' : 'Follow-up'}: ${x.title || '-'} · logged ${L.dmy(L.istDay(x.createdAt))}${x.status !== 'Open' ? ' · done' : ''}`) }; });
    }
    case 'candFollowups': {
      const where = { createdAt: { gte: L.startOf(p.from), lt: L.endOf(p.to) }, ...(self ? { createdById: ctx.user.id } : {}), application: h.appWhere(ctx, appF) };
      const rows = await prisma.applicationFollowUp.findMany({ where, select: { id: true, createdAt: true, contactMode: true, purpose: true, nextAction: true, application: { select: h.APP_SELECT } }, orderBy: { createdAt: 'desc' } }).catch(() => []);
      return rows.map((x) => ({ id: x.id, day: L.istDay(x.createdAt), call: x.contactMode === 'Call', item: h.candItem(x.application, `${h.jobOf(x.application)} · ${x.contactMode || 'follow-up'}${x.purpose ? ` · ${x.purpose}` : ''} · ${L.dmy(L.istDay(x.createdAt))}`) }));
    }
    case 'reqsRaised': return h.reqsOf(ctx, f).filter((r) => inP(L.istDay(r.createdAt), p)).map((r) => ({ id: r.id, day: L.istDay(r.createdAt), item: h.reqItem(r, `${(r.client && r.client.name) || '-'} · raised ${L.dmy(L.istDay(r.createdAt))} · ${h.reqGroupWord(h.reqGroupOf(r.status))}`) }));
    case 'reqsClosed': {
      const list = h.reqsOf(ctx, f);
      const days = await closedDays(list);
      return list.filter((r) => inP(days.get(r.id), p)).map((r) => ({ id: r.id, day: days.get(r.id), item: h.reqItem(r, `${(r.client && r.client.name) || '-'} · closed ${L.dmy(days.get(r.id))}`) }));
    }
    case 'shared': case 'selections': case 'offers': {
      const stages = { shared: ['SHARED_WITH_CLIENT'], selections: ['SELECTED'], offers: ['OFFER', 'OFFER_ACCEPTED'] }[metric];
      const m = await h.distinctEventApps(ctx, stages, p, f);
      const apps = await h.appsById([...m.keys()]);
      const word = { shared: 'sent', selections: 'selected', offers: 'offer' }[metric];
      return apps.map((a) => ({ id: a.id, day: L.istDay(m.get(a.id)), item: h.candItem(a, `${h.jobOf(a)} · ${word} ${L.dmy(L.istDay(m.get(a.id)))} · now ${h.stepOf(a)}`) }));
    }
    case 'interviews': {
      const where = h.appWhere(ctx, { interviewAt: { gte: L.startOf(p.from), lt: L.endOf(p.to) } }, { stage: { not: 'REJECTED' } }, { OR: [{ interviewStatus: null }, { interviewStatus: { not: 'CANCELLED' } }] }, appF);
      const rows = await prisma.application.findMany({ where, select: h.APP_SELECT, orderBy: { interviewAt: 'asc' } });
      return rows.map((a) => ({ id: a.id, day: L.istDay(a.interviewAt), done: new Date(a.interviewAt) < new Date() || a.interviewStatus === 'COMPLETED', item: h.candItem(a, `${h.jobOf(a)} · interview ${L.dmy(L.istDay(a.interviewAt))} ${L.timeOf(a.interviewAt)} · ${V.stageLabel(a.stage)}`, `interview-${a.id}`) }));
    }
    case 'feedbackIn': {
      const evs = await prisma.applicationStageEvent.findMany({
        where: {
          createdAt: { gte: L.startOf(p.from), lt: L.endOf(p.to) }, application: h.appWhere(ctx, appF),
          OR: [{ fromStage: { in: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'] }, toStage: { notIn: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'] } }, { fromStage: 'INTERVIEW_COMPLETED', toStage: { in: ['SELECTED', 'REJECTED', 'HOLD', 'OFFER'] } }],
        },
        select: { applicationId: true, createdAt: true, toStage: true }, orderBy: { createdAt: 'desc' },
      });
      const first = new Map();
      evs.forEach((e) => { if (!first.has(e.applicationId)) first.set(e.applicationId, e); });
      const apps = await h.appsById([...first.keys()]);
      return apps.map((a) => ({ id: a.id, day: L.istDay(first.get(a.id).createdAt), item: h.candItem(a, `${h.jobOf(a)} · client answered ${L.dmy(L.istDay(first.get(a.id).createdAt))}: ${V.stageLabel(first.get(a.id).toStage)}`) }));
    }
    case 'joinings': {
      const rows = await prisma.application.findMany({ where: h.appWhere(ctx, { stage: { in: h.JOINED } }, h.dayArm(p), appF), select: h.APP_SELECT });
      const gone = await h.droppedAppIds(rows.map((a) => a.id));
      const dayOf = (a) => (a.joiningDate ? String(a.joiningDate).slice(0, 10) : L.istDay(a.joinedAt));
      return rows.map((a) => { const left = gone.has(a.id) || h.LEFT_STATUS.includes(a.joiningStatus) || a.rollStatus === 'Dropped'; return { id: a.id, day: dayOf(a), left, item: h.candItem(a, `${h.jobOf(a)} · joined ${L.dmy(dayOf(a))}${left ? ' · left after joining' : ''}`, `joining-${a.id}`) }; });
    }
    case 'drops': return (await h.joiningRecords(ctx, f)).filter((r) => inP(r.droppedOn, p)).map((r) => ({ id: r.applicationId, day: r.droppedOn, item: h.candItem({ candidateId: r.candidateId, candidateName: r.candidateName }, `${r.jobTitle || '-'} (${r.clientName || '-'}) · dropped ${L.dmy(r.droppedOn)}${r.dropReason ? ` · ${r.dropReason}` : ''}`, `drop-${r.applicationId}`) }));
    case 'replacements': {
      const RP = require('../joindrop/replacement'); // eslint-disable-line global-require
      return (await h.joiningRecords(ctx, f)).filter((r) => inP(r.droppedOn, p) && (r.dropWithinGuarantee === 1 || r.replacementDecision === 'NEEDED')).map((r) => {
        const state = r.replacementApplicationId ? 'REPLACED' : RP.describe(r, null, { today: ctx.today }).state || 'DUE';
        const word = { REPLACED: 'replacement given', DUE: 'replacement due', EXPIRED: 'period ended, not replaced', DECLINED: 'client said not needed', CLOSED: 'closed by hand' }[state] || state.toLowerCase();
        return { id: r.applicationId, day: r.droppedOn, state, item: h.candItem({ candidateId: r.candidateId, candidateName: r.candidateName }, `${r.jobTitle || '-'} (${r.clientName || '-'}) · dropped ${L.dmy(r.droppedOn)} · ${word}`, `drop-${r.applicationId}`) };
      });
    }
    case 'replaced': return (await h.joiningRecords(ctx, f)).filter((r) => r.replacementApplicationId && inP(String(r.replacementLinkedAt || '').slice(0, 10), p)).map((r) => ({ id: r.applicationId, day: String(r.replacementLinkedAt).slice(0, 10), item: h.candItem({ candidateId: r.candidateId, candidateName: r.candidateName }, `${r.jobTitle || '-'} (${r.clientName || '-'}) · replacement linked ${L.dmy(String(r.replacementLinkedAt).slice(0, 10))}`, `drop-${r.applicationId}`) }));
    case 'invRaised': case 'invPaid': {
      const field = metric === 'invPaid' ? 'paidDate' : 'invoiceDate';
      const billing = ctx.viewerBilling != null ? ctx.viewerBilling : ctx.billing;
      const rows = await h.invoiceRows({ ...ctx, billing }, f);
      return rows.filter((i) => (metric !== 'invPaid' || i.status === 'Paid') && inP(String(i[field] || '').slice(0, 10), p)).map((i) => ({ id: i.id, day: String(i[field]).slice(0, 10), amount: billing ? (metric === 'invPaid' ? Number(i.receivedAmount || 0) : Number(i.amount || 0) + Number(i.gst || 0)) : null, item: h.invoiceItem({ ...ctx, billing }, i, `${i.status} · ${metric === 'invPaid' ? 'paid' : 'dated'} ${L.dmy(String(i[field]).slice(0, 10))}`) }));
    }
    case 'newClients': return h.clientsOf(ctx, f).filter((c) => inP(L.istDay(c.createdAt), p)).map((c) => ({ id: c.id, day: L.istDay(c.createdAt), item: h.clientItem(c, `added ${L.dmy(L.istDay(c.createdAt))}`) }));
    case 'signed': return h.clientsOf(ctx, f).filter((c) => c.agreementSignedAt && inP(L.istDay(c.agreementSignedAt), p)).map((c) => ({ id: c.id, day: L.istDay(c.agreementSignedAt), item: h.clientItem(c, `agreement signed ${L.dmy(L.istDay(c.agreementSignedAt))}`) }));
    default: return [];
  }
}

// ---- tables: day-wise / month-wise -------------------------------------------------------------------------------------------------
const nextMonth = (m) => L.addDays(L.lastOfMonth(`${m}-01`), 1).slice(0, 7);
// periods of the window: every day / month in it (a long window: only the ones with data, so nothing is cut)
function periodsOf(p, grain, days, ctx) {
  const lo = p.all ? (days.length ? days.reduce((a, b) => (a < b ? a : b)) : ctx.today) : p.from;
  const hi = p.to > ctx.today && !days.some((d) => d > ctx.today) ? ctx.today : p.to;
  const out = [];
  if (grain === 'month') {
    for (let m = lo.slice(0, 7); m <= hi.slice(0, 7) && out.length < 600; m = nextMonth(m)) out.push(m);
    return out.length > 36 ? out.filter((m) => days.some((d) => d.startsWith(m))) : out;
  }
  for (let d = lo; d <= hi && out.length < 4000; d = L.addDays(d, 1)) out.push(d);
  return out.length > 62 ? out.filter((d) => days.includes(d)) : out;
}
const periodWord = (k, grain) => (grain === 'month' ? L.monthLabel(`${k}-01`) : `${L.dm(k)} ${k.slice(0, 4) !== L.todayIst().slice(0, 4) ? k.slice(0, 4) : ''}`.trim());
const grainOf = (norm) => (/\bmonth[\s-]?(wise|by[\s-]?month)\b|\bmonthly\b|\bper month\b|\bevery month\b|\bnela[\s-]?vaari\b|\bnelavari\b|\bnela vari\b|\bmonth vari\b/.test(norm) ? 'month'
  : /\bday[\s-]?(wise|by[\s-]?day)\b|\bdaily\b|\bper day\b|\bevery day\b|\bdate[\s-]?wise\b|\broju[\s-]?vaari\b|\brojuvari\b|\broju vari\b|\broju roju\b/.test(norm) ? 'day' : null);

// ---- one person's work ---------------------------------------------------------------------------------------------------------
const PERSON_METRICS = ['followups', 'meetings', 'candFollowups', 'reqsRaised', 'reqsClosed', 'shared', 'interviews', 'feedbackIn', 'selections', 'offers', 'joinings', 'drops', 'replaced', 'invRaised', 'invPaid', 'newClients', 'signed'];
async function workOf(ctx, p, metrics = PERSON_METRICS, f = null) {
  const out = {};
  await Promise.all(metrics.map(async (m) => { out[m] = await dayData(ctx, m, p, f); }));
  return out;
}
async function personReport(ctx, p, lang, who, note) {
  const h = H();
  const w = await workOf(ctx, p);
  const n = (m) => (w[m] || []).length;
  const pend = await h.pendingOf(ctx);
  const openItems = (await h.clientItems(ctx, [...ctx.clientIds])).filter((x) => x.status === 'Open' && x.dueDate && x.dueDate < ctx.today && (x.createdById === ctx.user.id || x.ownerId === ctx.user.id || ctx.role !== 'bde'));
  const repDue = await h.replacementsDueOf(ctx);
  const inv = await h.invoiceRows({ ...ctx, billing: false }, null);
  const overdue = inv.filter((i) => i.status !== 'Paid' && i.dueDate && String(i.dueDate).slice(0, 10) < ctx.today);
  const billing = ctx.viewerBilling != null ? ctx.viewerBilling : ctx.billing;
  const amt = (list) => (billing ? ` (${h.money(list.reduce((s, x) => s + (x.amount || 0), 0))})` : '');
  const ivDone = w.interviews.filter((x) => x.done).length;
  const left = w.joinings.filter((x) => x.left).length;
  const calls = w.candFollowups.filter((x) => x.call).length;
  const pendTotal = (pend ? pend.total : 0) + openItems.length;
  const when = p.label(lang);
  const name = who || ctx.user.name || 'You';
  const stats = { followups: n('followups'), meetings: n('meetings'), candFollowups: n('candFollowups'), calls, reqsRaised: n('reqsRaised'), reqsClosed: n('reqsClosed'), shared: n('shared'), interviews: n('interviews'), interviewsDone: ivDone, feedbackIn: n('feedbackIn'), feedbackPending: pend ? (pend.counts.noReplyAll || 0) + (pend.counts.feedback || 0) : 0, selections: n('selections'), offers: n('offers'), joinings: n('joinings'), left, drops: n('drops'), replaced: n('replaced'), replacementsDue: repDue.length, invRaised: n('invRaised'), invPaid: n('invPaid'), invOverdue: overdue.length, newClients: n('newClients'), signed: n('signed'), pending: pendTotal, lateFollowups: openItems.length };
  // the table: day-wise up to two months, month-wise beyond
  const span = L.daysBetween(p.from === L.ALL_FROM ? ctx.today : p.from, p.to > ctx.today ? ctx.today : p.to);
  const grain = p.from === p.to ? null : (span > 62 || p.all ? 'month' : 'day');
  const tableLines = [];
  if (grain) {
    const keyOf = (d) => (grain === 'month' ? d.slice(0, 7) : d);
    const show = ['followups', 'shared', 'interviews', 'selections', 'offers', 'joinings', 'drops'];
    const per = new Map();
    show.forEach((m) => (w[m] || []).forEach((x) => { const k = keyOf(x.day); if (!per.has(k)) per.set(k, {}); per.get(k)[m] = (per.get(k)[m] || 0) + 1; }));
    [...per.keys()].sort().forEach((k) => {
      const r = per.get(k);
      tableLines.push(`${periodWord(k, grain)}: ${show.filter((m) => r[m]).map((m) => `${r[m]} ${METRICS[m].short}`).join(' · ')}`);
    });
  }
  const items = [
    ...w.interviews.map((x) => x.item), ...w.joinings.map((x) => x.item), ...w.drops.map((x) => x.item), ...w.selections.map((x) => x.item), ...w.offers.map((x) => x.item),
    ...w.followups.map((x) => x.item), ...w.meetings.map((x) => x.item), ...w.shared.map((x) => x.item), ...w.reqsRaised.map((x) => x.item), ...w.newClients.map((x) => x.item),
  ];
  return h.answer(ctx, {
    intent: 'person', count: stats.interviews + stats.followups + stats.joinings, total: items.length, stats, record: { kind: 'person', id: ctx.user.id, name },
    title: say(lang, {
      en: `${when}: ${name} - ${pl(stats.interviews, 'interview', 'interviews')}, ${pl(stats.followups, 'client follow-up', 'client follow-ups')}, ${pl(stats.shared, 'profile shared', 'profiles shared')}, ${pl(stats.joinings, 'joining', 'joinings')}`,
      tl: `${when}: ${name} - ${stats.interviews} interviews, ${stats.followups} client follow-ups, ${stats.shared} profiles share, ${stats.joinings} joinings`,
      te: `${when}: ${name} - ${stats.interviews} ఇంటర్వ్యూలు, ${stats.followups} ఫాలో-అప్‌లు, ${stats.shared} ప్రొఫైల్‌లు, ${stats.joinings} జాయినింగ్‌లు`,
    }),
    lines: [
      note || null,
      `Client follow-ups logged: ${stats.followups} · meetings: ${stats.meetings} · candidate follow-ups: ${stats.candFollowups} (calls ${calls})`,
      `Requirements: raised ${stats.reqsRaised}, closed ${stats.reqsClosed}`,
      `Profiles shared: ${stats.shared} · client feedback received: ${stats.feedbackIn} · waiting for client feedback now: ${stats.feedbackPending}`,
      `Interviews: ${stats.interviews} (done ${ivDone}, coming ${stats.interviews - ivDone})`,
      `Selections: ${stats.selections} · offers: ${stats.offers} · joinings: ${stats.joinings}${left ? ` (${left} left after joining)` : ''} · drops: ${stats.drops}`,
      `Replacements: due now ${stats.replacementsDue}, given in this window ${stats.replaced}`,
      `Invoices: raised ${stats.invRaised}${amt(w.invRaised)}, paid ${stats.invPaid}${amt(w.invPaid)}, overdue now ${stats.invOverdue}`,
      `New clients: ${stats.newClients} · agreements signed: ${stats.signed}`,
      `Pending now: ${pendTotal}${pend ? ` (no reply ${pend.counts.noReply || 0}, no feedback ${pend.counts.feedback || 0}, interview to book ${pend.counts.shortlisted || 0}, agreements ${pend.counts.agreement || 0}, invoices late ${pend.counts.invoices || 0}` : ' ('}${`, late follow-ups ${openItems.length})`}`,
      ...(tableLines.length ? [`${grain === 'month' ? 'Month by month' : 'Day by day'}:`, ...tableLines] : []),
    ],
    items,
    facts: [`Each number is that person's own work in the window ${L.dmy(p.from === L.ALL_FROM ? ctx.today : p.from)} - ${L.dmy(p.to)}, read through their own scope: follow-ups and meetings they logged, profiles moved to Sent to client, interviews on the day, client answers, Selected / Offer steps, joinings by joining day, drops by drop day. "Now" numbers are as of today.`, h.scopeFact(ctx)],
  });
}

// ---- the team: one row per BDE ---------------------------------------------------------------------------------------------------
const TEAM_METRICS = ['followups', 'shared', 'interviews', 'selections', 'offers', 'joinings', 'drops'];
const TOPIC_METRIC = {
  interviews: 'interviews', joinings: 'joinings', followups: 'followups', offers: 'offers', drops: 'drops', replacements: 'replacements', invoices: 'invRaised',
  clients: 'newClients', requirements: 'reqsRaised', shared: 'shared', selections: 'selections', feedback: 'feedbackIn', target: 'signed',
};
async function teamReport(ctx, p, lang, metric, { rank = null } = {}) {
  const h = H();
  const bdes = (await bdeList(ctx)).filter((u) => !u.bdeTl); // the team report is the BDEs; a BDE TL is asked by name
  const metrics = metric ? [metric] : TEAM_METRICS;
  const rows = [];
  for (const u of bdes) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const c = await ctxOfBde(ctx, u);
    // eslint-disable-next-line no-await-in-loop
    const w = await workOf(c, p, metrics);
    rows.push({ u, w, n: Object.fromEntries(metrics.map((m) => [m, w[m].length])) });
  }
  const total = Object.fromEntries(metrics.map((m) => [m, new Set(rows.flatMap((r) => r.w[m].map((x) => x.id))).size]));
  const key = metric || 'interviews';
  const score = (r) => (metric ? r.n[metric] : metrics.reduce((s, m) => s + r.n[m], 0));
  rows.sort((a, b) => score(b) - score(a) || a.u.name.localeCompare(b.u.name));
  const when = p.label(lang);
  const word = (m) => METRICS[m].en;
  const summary = (n) => metrics.map((m) => `${n[m]} ${METRICS[m].short}`).join(' · ');
  const stats = { rows: rows.map((r) => ({ name: r.u.name, ...r.n })), total };
  let title;
  if (rank && rows.length) {
    const top = rank === 'least' ? [...rows].reverse()[0] : rows[0];
    title = say(lang, { en: `${when}: ${rank === 'least' ? 'fewest' : 'most'} ${word(key)} - ${top.u.name} (${top.n[key]})`, tl: `${when}: ${rank === 'least' ? 'takkuva' : 'ekkuva'} ${word(key)} - ${top.u.name} (${top.n[key]})`, te: `${when}: ${word(key)} - ${top.u.name} (${top.n[key]})` });
  } else if (metric) {
    title = say(lang, { en: `${when}: ${word(metric)} by BDE - team total ${total[metric]} (${rows.length} BDEs)`, tl: `${when}: BDE vaari ${word(metric)} - team total ${total[metric]} (${rows.length} BDEs)`, te: `${when}: BDE వారీగా ${word(metric)} - మొత్తం ${total[metric]}` });
  } else {
    title = say(lang, { en: `${when}: all BDEs (${rows.length}) - ${summary(total)}`, tl: `${when}: andaru BDEs (${rows.length}) - ${summary(total)}`, te: `${when}: అందరు BDEలు (${rows.length}) - ${summary(total)}` });
  }
  return h.answer(ctx, {
    intent: metric ? 'team_metric' : 'team', count: metric ? total[metric] : rows.length, stats, total: rows.length,
    title,
    lines: [
      ...rows.map((r, i) => `${i + 1}. ${r.u.name}: ${metric ? `${r.n[metric]} ${METRICS[metric].short}` : summary(r.n)}`),
      `Team total (each record once): ${summary(total)}`,
    ],
    items: rows.map((r) => ({ kind: 'person', id: r.u.id, label: r.u.name, sub: summary(r.n), to: `/clients?search=${encodeURIComponent(r.u.name)}` })),
    facts: ['One row per BDE login (active, ATS role BDE), each read through that BDE\'s own scope; a record that two BDEs share counts once in the team total.', `Window: ${L.dmy(p.from === L.ALL_FROM ? ctx.today : p.from)} - ${L.dmy(p.to)}. Ask "<name> report" for one person's full work.`, h.scopeFact(ctx)],
  });
}

// ---- a department ----------------------------------------------------------------------------------------------------------------
async function deptReport(ctx, dep, p, lang) {
  const h = H();
  if (!dep) {
    const vals = deptValues(ctx).sort();
    const rows = [];
    for (const d of vals) { // eslint-disable-line no-restricted-syntax
      const f = { departments: [d], name: d };
      const reqs = h.reqsOf(ctx, f);
      // eslint-disable-next-line no-await-in-loop
      const [iv, jn] = await Promise.all([dayData(ctx, 'interviews', p, f), dayData(ctx, 'joinings', p, f)]);
      rows.push({ d, clients: h.clientsOf(ctx, f).length, open: reqs.filter((r) => h.LIVE.includes(r.status)).length, all: reqs.length, iv: iv.length, jn: jn.length });
    }
    return h.answer(ctx, {
      intent: 'department', count: rows.length, stats: { rows },
      title: say(lang, { en: `${p.label(lang)}: ${rows.length} departments`, tl: `${p.label(lang)}: ${rows.length} departments`, te: `${p.label(lang)}: ${rows.length} విభాగాలు` }),
      lines: rows.map((r) => `${r.d}: ${r.clients} clients · ${r.open} open requirements (${r.all} in all) · ${r.iv} interviews · ${r.jn} joinings`),
      facts: ['Departments as written on the clients (desk) and the requirements in your scope. Ask "<department> report" for one of them in full.', h.scopeFact(ctx)],
    });
  }
  const f = { departments: dep.departments, name: dep.name };
  const reqs = h.reqsOf(ctx, f);
  const clients = h.clientsOf(ctx, f);
  const [iv, sh, jn, dr, rp] = await Promise.all(['interviews', 'shared', 'joinings', 'drops', 'replacements'].map((m) => dayData(ctx, m, p, f)));
  const repDue = await h.replacementsDueOf(ctx, f);
  const split = {};
  reqs.forEach((r) => { const g = h.reqGroupOf(r.status); split[g] = (split[g] || 0) + 1; });
  const splitLine = [...h.REQ_GROUPS.map(([g]) => g), 'other'].filter((g) => split[g]).map((g) => `${h.reqGroupWord(g)} ${split[g]}`).join(' · ') || 'none';
  const bdeNames = canSeeTeam(ctx) ? [...new Set([...clients.map((c) => c.bdeOwner), ...clients.map((c) => c.secondaryBde)].filter(Boolean).map((x) => String(x).trim()))].sort() : [];
  const when = p.label(lang);
  const stats = { clients: clients.length, requirements: reqs.length, open: reqs.filter((r) => h.LIVE.includes(r.status)).length, interviews: iv.length, shared: sh.length, joinings: jn.length, left: jn.filter((x) => x.left).length, drops: dr.length, replacementsOwed: rp.length, replacementsDue: repDue.length };
  return h.answer(ctx, {
    intent: 'department', count: stats.requirements, stats,
    title: say(lang, { en: `${when}: ${dep.name} - ${stats.clients} clients, ${stats.requirements} requirements (${stats.open} open), ${stats.interviews} interviews, ${stats.joinings} joinings`, tl: `${when}: ${dep.name} - ${stats.clients} clients, ${stats.requirements} requirements (${stats.open} open), ${stats.interviews} interviews, ${stats.joinings} joinings`, te: `${when}: ${dep.name} - ${stats.clients} క్లయింట్లు, ${stats.requirements} రిక్వైర్‌మెంట్లు, ${stats.interviews} ఇంటర్వ్యూలు, ${stats.joinings} జాయినింగ్‌లు` }),
    lines: [
      `Requirements (all time): ${splitLine}`,
      bdeNames.length ? `BDEs handling ${dep.name} clients: ${bdeNames.join(', ')}` : null,
      `Profiles shared: ${stats.shared} · interviews: ${stats.interviews} · joinings: ${stats.joinings}${stats.left ? ` (${stats.left} left after joining)` : ''} · drops: ${stats.drops}`,
      `Replacements: owed for drops in this window ${stats.replacementsOwed}, due now ${stats.replacementsDue}`,
    ],
    items: [...reqs.filter((r) => h.LIVE.includes(r.status)).map((r) => h.reqItem(r, `${(r.client && r.client.name) || '-'} · open · ${r.openings} opening${r.openings === 1 ? '' : 's'}`)), ...clients.map((c) => h.clientItem(c, `${c.ownerDepartment || '-'}${c.bdeOwner && canSeeTeam(ctx) ? ` · BDE ${c.bdeOwner}` : ''}`)), ...jn.map((x) => x.item)],
    open: { to: `/ats/search?${h.qs({ type: 'requirements', dept: dep.name })}`, label: `Open ${dep.name} requirements in Search` },
    facts: [`Department ${dep.name}: requirements whose department is ${dep.departments.join(' / ')}, clients whose desk is that department, and the candidates on those requirements.`, h.scopeFact(ctx)],
  });
}

// ---- history: month-wise / day-wise -----------------------------------------------------------------------------------------------
const HISTORY_METRICS = ['joinings', 'drops', 'replacements', 'interviews', 'shared', 'selections', 'offers', 'followups', 'newClients', 'reqsRaised', 'invRaised', 'invPaid', 'feedbackIn'];
async function history(ctx, metric, p, grain, lang, f, who) {
  const h = H();
  const rows = await dayData(ctx, metric, p, f);
  const days = rows.map((x) => x.day).filter(Boolean);
  const keys = periodsOf(p, grain, days, ctx);
  const keyOf = (d) => (grain === 'month' ? d.slice(0, 7) : d);
  const per = new Map();
  rows.forEach((x) => { const k = keyOf(x.day); if (!per.has(k)) per.set(k, []); per.get(k).push(x); });
  const extra = (list) => {
    if (metric === 'joinings') { const l = list.filter((x) => x.left).length; return l ? ` (${l} left after joining)` : ''; }
    if (metric === 'replacements') { const g = list.filter((x) => x.state === 'REPLACED').length; const d = list.filter((x) => x.state === 'DUE').length; return list.length ? ` (${g} given, ${d} due, ${list.length - g - d} other)` : ''; }
    if (metric === 'interviews') { const d = list.filter((x) => x.done).length; return list.length ? ` (${d} done)` : ''; }
    return '';
  };
  const when = p.label(lang);
  const word = METRICS[metric].en;
  const forWho = who ? ` - ${who}` : (f && f.name ? ` - ${f.name}` : '');
  const table = keys.map((k) => `${periodWord(k, grain)}: ${(per.get(k) || []).length}${extra(per.get(k) || [])}`);
  rows.sort((a, b) => String(b.day).localeCompare(String(a.day)));
  return h.answer(ctx, {
    intent: `history_${metric}`, count: rows.length, total: rows.length, stats: { grain, table: keys.map((k) => ({ period: k, n: (per.get(k) || []).length })) },
    title: say(lang, { en: `${when}: ${rows.length} ${word}${forWho}${extra(rows)}, ${grain === 'month' ? 'month by month' : 'day by day'}`, tl: `${when}: ${rows.length} ${word}${forWho}${extra(rows)}, ${grain === 'month' ? 'nela vaari' : 'roju vaari'}`, te: `${when}: ${rows.length} ${word}${forWho}${extra(rows)}, ${grain === 'month' ? 'నెల వారీగా' : 'రోజు వారీగా'}` }),
    lines: table,
    items: rows.map((x) => x.item),
    facts: [`${word} between ${L.dmy(p.from === L.ALL_FROM ? (days.length ? days.reduce((a, b) => (a < b ? a : b)) : ctx.today) : p.from)} and ${L.dmy(p.to)}, counted by their own day (${metric === 'joinings' ? 'the joining day' : metric === 'drops' || metric === 'replacements' ? 'the drop day' : metric === 'interviews' ? 'the interview day' : 'the day it happened'}), ${grain === 'month' ? 'per month' : 'per day'}${keys.length > (grain === 'month' ? 36 : 62) ? ' (only the periods with records are listed)' : ', zeros included'}.`, h.scopeFact(ctx)],
  });
}

// ---- pending now ----------------------------------------------------------------------------------------------------------------
async function pendingReport(ctx, lang, who) {
  const h = H();
  const pend = await h.pendingOf(ctx);
  const late = (await h.clientItems(ctx, [...ctx.clientIds])).filter((x) => x.status === 'Open' && x.dueDate && x.dueDate < ctx.today && (ctx.role !== 'bde' || x.createdById === ctx.user.id || x.ownerId === ctx.user.id));
  const L2 = (pend && pend.lists) || {};
  const it = (i, why) => h.candItem(i, `${i.job} (${i.client}) · ${why}`);
  const items = [
    ...late.map((x) => { const c = ctx.clientById.get(x.clientId); return h.clientItem(c || { id: x.clientId, name: 'Client' }, `Follow-up late since ${L.dmy(x.dueDate)}: ${x.title || '-'}`); }),
    ...(L2.noReply || []).map((i) => it(i, `sent, no reply ${i.waitedDays} days`)), ...(L2.feedback || []).map((i) => it(i, 'interview done, no feedback')),
    ...(L2.shortlisted || []).map((i) => it(i, 'shortlisted, book the interview')),
    ...(L2.agreement || []).map((i) => h.clientItem({ id: i.clientId, name: i.client }, `agreement ${i.notSent ? 'not sent yet' : i.agreement}`)),
    ...(L2.requests || []).map((i) => h.reqItem({ id: i.requirementId, title: i.job }, `${i.client} · request waiting`)),
    ...(L2.invoices || []).map((i) => h.clientItem({ id: i.clientId, name: i.client }, `invoice ${i.invoiceNumber || ''} ${i.daysLate} days past due`)),
  ];
  const c = (pend && pend.counts) || {};
  const total = items.length;
  const now = h.nowLabel(ctx, lang);
  return h.answer(ctx, {
    intent: 'pending', count: total, total, stats: { lateFollowups: late.length, ...c },
    title: say(lang, { en: `${now}: ${total} pending items${who ? ` - ${who}` : ''}`, tl: `${now}: ${total} pending panulu${who ? ` - ${who}` : ''}`, te: `${now}: ${total} పెండింగ్ పనులు${who ? ` - ${who}` : ''}` }),
    lines: [`Late client follow-ups: ${late.length} · sent, no reply (${(pend && pend.feedbackDays) || 3}+ days): ${c.noReply || 0} · interview done, no feedback: ${c.feedback || 0} · interview to book: ${c.shortlisted || 0}`, `Agreements not signed: ${c.agreement || 0} · requirement requests waiting: ${c.requests || 0} · invoices past due: ${c.invoices || 0} · client logins waiting: ${c.logins || 0}`],
    items,
    facts: ['Pending = your dashboard\'s client work (utils/clientWork.js) plus client follow-ups whose date has passed.', h.scopeFact(ctx)],
  });
}

// ---- any keyword: the one scoped search engine -----------------------------------------------------------------------------------
async function keywordSearch(ctx, text, lang) {
  const h = H();
  const AS = require('./atsSearch'); // eslint-disable-line global-require
  const r = await h.safe(() => AS.search(ctx.user, text, { limit: 20 }), null);
  if (!r) return null;
  const groups = (r.groups || []).filter((g) => g.id !== 'people' || canSeeTeam(ctx)).map((g) => ({
    ...g,
    // a requirement listed only because a searched candidate applied to it is left out (that candidate may be outside this login's view)
    rows: g.id === 'requirements' ? g.rows.filter((x) => (x.matchedBy || []).some((m) => m !== 'candidate')) : g.rows,
  })).map((g) => ({ ...g, count: g.id === 'requirements' ? g.rows.length : g.count })).filter((g) => g.rows.length);
  if (!groups.length) return null;
  const totalN = groups.reduce((s, g) => s + g.count, 0);
  const items = groups.flatMap((g) => g.rows.map((x) => ({ kind: g.id, id: x.id, label: x.title || x.name, sub: [g.title, x.sub].filter(Boolean).join(' · '), to: x.to || x.recordTo, record: x.recordTo })));
  return h.answer(ctx, {
    intent: 'search', count: totalN, total: Math.max(totalN, items.length),
    title: say(lang, { en: `Search "${text}": ${totalN} found - ${groups.map((g) => `${g.count} ${g.title.toLowerCase()}`).join(', ')}`, tl: `"${text}" search: ${totalN} dorikayi - ${groups.map((g) => `${g.count} ${g.title.toLowerCase()}`).join(', ')}`, te: `"${text}" వెతికితే: ${totalN} - ${groups.map((g) => `${g.count} ${g.title.toLowerCase()}`).join(', ')}` }),
    lines: [],
    items,
    open: { to: `/ats/search?q=${encodeURIComponent(text)}`, label: 'Open every result in Search' },
    facts: ['The one TeamLink search (people, clients, requirements, candidates, interviews / offers / joinings, invoices / agreements, follow-ups), inside your scope; partial words, one wrong letter and Telugu spelling are matched.', h.scopeFact(ctx)],
  });
}

module.exports = {
  canSeeTeam, bdeList, matchBde, ctxOfBde, sameNameCandidates, deptOf, dayData, workOf, personReport, teamReport, deptReport, history, pendingReport, keywordSearch, grainOf, TOPIC_METRIC, HISTORY_METRICS, METRICS,
};
