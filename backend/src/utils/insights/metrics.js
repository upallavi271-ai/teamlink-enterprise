// ---------------------------------------------------------------------------
// ATS INSIGHTS — the numbers (2026-11-21). Every function takes the scoped report context (core.ctxFor) so a login only
// ever counts its own area.
//
//   timeToFill(ctx, { days })     01.03 / 12.06  days from a requirement being added to the person joining (time to fill)
//                                 and from the application to the joining (time to hire), per requirement and per client
//   readiness(ctx)                01.10          open requirements ranked by how close they are to being filled
//   forecast(ctx, { money })      01.09          expected joinings (and fee) from the people in the pipeline now
//   openings(ctx)                 12.10          each opening of a requirement: filled by whom, when, in how many days
//   bottlenecks(ctx)              12.16          where people wait / drop between steps, and the hiring forecast by month
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');

const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const reqLabel = (r) => `${r.reqCode ? `${r.reqCode} · ` : ''}${r.title || 'Requirement'}`;
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

// --- 01.03 / 12.06 TIME TO FILL -------------------------------------------------------------------
function timeToFill(ctx, { days = 0, clientId = '' } = {}) {
  const from = days > 0 ? C.addDays(C.today(), -days) : null;
  const jobs = new Map();
  const clients = new Map();
  const months = new Map();
  const fillAll = []; const hireAll = [];
  ctx.apps.forEach((x) => {
    if (!x.joined) return;
    if (clientId && x.req.clientKey !== clientId) return;
    const jd = C.joinDayOf(x);
    if (!jd || (from && jd < from)) return;
    const fill = C.dayDiff(C.istDay(x.req.createdAt), jd);
    const hire = C.dayDiff(C.istDay(x.a.createdAt), jd);
    if (fill < 0 || fill > C.MAX_FILL_DAYS) return;
    fillAll.push(fill);
    if (hire >= 0 && hire <= C.MAX_FILL_DAYS) hireAll.push(hire);
    const j = jobs.get(x.req.id) || { requirementId: x.req.id, requirement: reqLabel(x.req), client: x.req.clientName, clientId: x.req.internal ? null : x.req.clientId, department: x.req.department || '—', openings: x.req.openings || 1, fill: [], hire: [] };
    j.fill.push(fill); if (hire >= 0 && hire <= C.MAX_FILL_DAYS) j.hire.push(hire);
    jobs.set(x.req.id, j);
    const c = clients.get(x.req.clientKey) || { clientId: x.req.internal ? null : x.req.clientId, client: x.req.clientName, jobs: new Set(), fill: [], hire: [] };
    c.jobs.add(x.req.id); c.fill.push(fill); if (hire >= 0 && hire <= C.MAX_FILL_DAYS) c.hire.push(hire);
    clients.set(x.req.clientKey, c);
    const m = jd.slice(0, 7);
    const mm = months.get(m) || { month: m, fill: [], hire: [] };
    mm.fill.push(fill); if (hire >= 0 && hire <= C.MAX_FILL_DAYS) mm.hire.push(hire);
    months.set(m, mm);
  });
  const shape = (o) => ({
    joined: o.fill.length, medianFill: C.median(o.fill), avgFill: C.average(o.fill), fastestFill: o.fill.length ? Math.min(...o.fill) : null,
    slowestFill: o.fill.length ? Math.max(...o.fill) : null, medianHire: C.median(o.hire), avgHire: C.average(o.hire),
  });
  // the open requirements nobody has joined yet: how long they have been open (the "still waiting" side of time to fill)
  const openAges = ctx.reqs.filter((r) => LIVE.includes(r.status) && (!clientId || r.clientKey === clientId)).map((r) => r.ageDays);
  return {
    tiles: {
      medianFill: C.median(fillAll), avgFill: C.average(fillAll), medianHire: C.median(hireAll), avgHire: C.average(hireAll),
      joined: fillAll.length, openJobs: openAges.length, medianOpenAge: C.median(openAges),
    },
    window: from ? { from, to: C.today(), days } : null,
    byJob: [...jobs.values()].map((j) => ({ requirementId: j.requirementId, requirement: j.requirement, client: j.client, clientId: j.clientId, department: j.department, openings: j.openings, ...shape(j) }))
      .sort((a, b) => b.joined - a.joined || (a.medianFill ?? 0) - (b.medianFill ?? 0)),
    byClient: [...clients.values()].map((c) => ({ clientId: c.clientId, client: c.client, requirements: c.jobs.size, ...shape(c) }))
      .sort((a, b) => b.joined - a.joined),
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ month: m.month, label: C.monthLabel(m.month), ...shape(m) })),
    note: 'Time to fill = days from the requirement being added to the person joining. Time to hire = days from the candidate being added to the requirement to joining. "Usual" is the median (the middle value).',
  };
}

// --- 01.10 CLOSEST TO FILL ------------------------------------------------------------------------
const WEIGHTS = { accepted: 0.85, offer: 0.6, selected: 0.45, interview: 0.25, shared: 0.1 };
const STEP_WORDS = { accepted: 'offer accepted', offer: 'with an offer', selected: 'selected', interview: 'in interviews', shared: 'with the client' };
function furthestOf(x) {
  if (x.joined || !x.inPipeline) return null;
  if (x.a.stage === 'HOLD') return null;
  for (const k of ['accepted', 'offer', 'selected', 'interview', 'shared']) if (x.reached(k)) return k;
  return 'early';
}
function readiness(ctx, { limit = 0 } = {}) {
  const byReq = new Map();
  ctx.apps.forEach((x) => {
    const r = byReq.get(x.req.id) || { joined: 0, accepted: 0, offer: 0, selected: 0, interview: 0, shared: 0, early: 0 };
    if (x.joined) r.joined += 1;
    else { const k = furthestOf(x); if (k) r[k] += 1; }
    byReq.set(x.req.id, r);
  });
  const rows = ctx.reqs.filter((r) => LIVE.includes(r.status)).map((r) => {
    const c = byReq.get(r.id) || { joined: 0, accepted: 0, offer: 0, selected: 0, interview: 0, shared: 0, early: 0 };
    const openings = Math.max(1, Number(r.openings) || 1);
    const left = Math.max(0, openings - c.joined);
    const cover = Object.entries(WEIGHTS).reduce((n, [k, w]) => n + c[k] * w, 0);
    const readinessPct = left ? Math.min(100, Math.round((cover / left) * 100)) : 100;
    const best = Object.keys(WEIGHTS).find((k) => c[k] > 0);
    let next;
    if (!left) next = 'All openings filled - close the requirement';
    else if (c.accepted) next = `${c.accepted} offer accepted - confirm the joining date`;
    else if (c.offer) next = `${c.offer} with an offer - follow up for acceptance`;
    else if (c.selected) next = `${c.selected} selected - release the offer`;
    else if (c.interview) next = `${c.interview} in interviews - get the client's feedback`;
    else if (c.shared) next = `${c.shared} with the client - ask for interview slots`;
    else if (c.early) next = `${c.early} not sent yet - screen and send to the client`;
    else next = 'No candidates yet - start sourcing';
    return {
      requirementId: r.id, requirement: reqLabel(r), client: r.clientName, clientId: r.internal ? null : r.clientId, department: r.department || '—',
      openings, filled: c.joined, left, ageDays: r.ageDays, readiness: readinessPct, furthest: best ? STEP_WORDS[best] : (c.early ? 'not sent yet' : 'no candidates'),
      counts: c, next,
    };
  }).filter((r) => r.left > 0)
    .sort((a, b) => b.readiness - a.readiness || a.left - b.left || a.ageDays - b.ageDays);
  return { rows: limit ? rows.slice(0, limit) : rows, total: rows.length, note: 'Ready % = the people at offer / selection / interview stages, weighted by how often each step ends in a joining, against the openings still left.' };
}

// --- 01.09 PIPELINE / REVENUE FORECAST ------------------------------------------------------------
const DEFAULT_CHANCE = { accepted: 0.8, offer: 0.6, selected: 0.45, interview: 0.2, shared: 0.08, early: 0.02 };
const STEPS = ['accepted', 'offer', 'selected', 'interview', 'shared', 'early'];
const STEP_LABEL = { accepted: 'Offer accepted', offer: 'Offer', selected: 'Selected', interview: 'Interview', shared: 'With client', early: 'Not sent to client yet' };
const DAYS_TO_JOIN = { accepted: 15, offer: 25, selected: 35, interview: 50, shared: 65, early: 85 };
// The chance a person at a step ends up joining, learnt from the closed applications of the last year in this scope
// (at least 20 people at a step, else the usual rate).
function chances(ctx) {
  const since = C.addDays(C.today(), -365);
  const tally = Object.fromEntries(STEPS.map((k) => [k, { n: 0, j: 0 }]));
  ctx.apps.forEach((x) => {
    if (x.inPipeline && !x.joined) return; // still open: not an outcome yet
    if (C.istDay(x.a.createdAt) < since) return;
    STEPS.forEach((k) => {
      const at = k === 'early' ? true : x.reached(k);
      if (!at) return;
      tally[k].n += 1;
      if (x.joined) tally[k].j += 1;
    });
  });
  return Object.fromEntries(STEPS.map((k) => {
    const t = tally[k];
    const learnt = t.n >= 20;
    return [k, { chance: learnt ? Math.round((t.j / t.n) * 1000) / 1000 : DEFAULT_CHANCE[k], learnt, basedOn: t.n }];
  }));
}
async function forecast(ctx, { money = false } = {}) {
  const ch = chances(ctx);
  const open = [];
  ctx.apps.forEach((x) => { const k = furthestOf(x); if (k) open.push({ x, k }); });
  const byStep = Object.fromEntries(STEPS.map((k) => [k, { people: 0, expected: 0 }]));
  const byClient = new Map();
  const byMonth = new Map();
  const t0 = C.today();
  let fees = null;
  if (money) {
    const late = open.filter((o) => ['accepted', 'offer', 'selected', 'interview'].includes(o.k));
    const ids = late.map((o) => o.x.id);
    const ctc = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      (await prisma.application.findMany({ where: { id: { in: ids.slice(i, i + 500) } }, select: { id: true, offeredCtc: true } })).forEach((r) => ctc.set(r.id, r.offeredCtc));
    }
    const clientIds = [...new Set(late.map((o) => o.x.req.clientId).filter(Boolean))];
    const cl = new Map((await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, agreementFeePercent: true, feeType: true, feeAmount: true } })).map((c) => [c.id, c]));
    fees = { ctc, cl };
  }
  let revenue = 0; let feeKnown = 0; let feeUnknown = 0;
  open.forEach(({ x, k }) => {
    const p = ch[k].chance;
    byStep[k].people += 1; byStep[k].expected += p;
    const c = byClient.get(x.req.clientKey) || { client: x.req.clientName, clientId: x.req.internal ? null : x.req.clientId, people: 0, expected: 0, revenue: 0 };
    c.people += 1; c.expected += p;
    // when: the typed joining date when there is one in the future, else the usual days from this step
    const typed = C.isoDay(x.a.joiningDate);
    const when = typed && typed >= t0 ? typed : C.addDays(t0, DAYS_TO_JOIN[k]);
    const m = when.slice(0, 7);
    const mm = byMonth.get(m) || { month: m, expected: 0, revenue: 0 };
    mm.expected += p;
    if (fees && ['accepted', 'offer', 'selected', 'interview'].includes(k) && !x.req.internal) {
      const cl = fees.cl.get(x.req.clientId);
      const ctc = Number(fees.ctc.get(x.id)) || 0;
      let fee = null;
      if (cl && (cl.feeType === 'FIXED' || cl.feeType === 'PER_CANDIDATE') && cl.feeAmount) fee = Number(cl.feeAmount);
      else if (ctc > 0) fee = (ctc * (cl && cl.agreementFeePercent != null ? Number(cl.agreementFeePercent) : 8.33)) / 100;
      if (fee) { const ev = fee * p; revenue += ev; c.revenue += ev; mm.revenue += ev; feeKnown += 1; } else feeUnknown += 1;
    }
    byMonth.set(m, mm);
    byClient.set(x.req.clientKey, c);
  });
  const r1 = (n) => Math.round(n * 10) / 10;
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(0, 4)
    .map((m) => ({ month: m.month, label: C.monthLabel(m.month), expected: r1(m.expected), ...(money ? { revenue: Math.round(m.revenue) } : {}) }));
  const expected = STEPS.reduce((n, k) => n + byStep[k].expected, 0);
  return {
    expectedJoinings: r1(expected),
    inPipeline: open.length,
    byStep: STEPS.map((k) => ({ step: k, label: STEP_LABEL[k], people: byStep[k].people, chance: Math.round(ch[k].chance * 100), learnt: ch[k].learnt, expected: r1(byStep[k].expected) })),
    byClient: [...byClient.values()].sort((a, b) => b.expected - a.expected).slice(0, 15)
      .map((c) => ({ client: c.client, clientId: c.clientId, people: c.people, expected: r1(c.expected), ...(money ? { revenue: Math.round(c.revenue) } : {}) })),
    byMonth: months,
    revenue: money ? { expected: Math.round(revenue), basedOn: feeKnown, noFee: feeUnknown, note: 'Fee = the client\'s fixed fee, else the offered CTC x the agreement fee % (8.33% when not set), times the chance of joining. Only people at interview or later are counted.' } : null,
    note: 'Expected joinings = each person in the pipeline now x the chance that a person at their step joins (learnt from this area\'s last 12 months when there are 20+ people at a step, else the usual rate).',
  };
}

// --- 12.10 PER-OPENING REPORTING --------------------------------------------------------------------
async function openings(ctx, { multiOnly = true, status = 'live' } = {}) {
  const byReq = new Map();
  ctx.apps.forEach((x) => {
    const list = byReq.get(x.req.id) || { joined: [], pipeline: { accepted: 0, offer: 0, selected: 0, interview: 0 } };
    if (x.joined) list.joined.push({ x, day: C.joinDayOf(x) });
    else { const k = furthestOf(x); if (k && list.pipeline[k] !== undefined) list.pipeline[k] += 1; }
    byReq.set(x.req.id, list);
  });
  const reqs = ctx.reqs.filter((r) => (status === 'live' ? LIVE.includes(r.status) : status === 'closed' ? r.status === 'CLOSED' : true))
    .filter((r) => !multiOnly || (Number(r.openings) || 1) > 1);
  const candIds = [];
  reqs.forEach((r) => (byReq.get(r.id) || { joined: [] }).joined.forEach((j) => candIds.push(j.x.a.candidateId)));
  const names = await C.namesOf(candIds);
  const t0 = C.today();
  const rows = reqs.map((r) => {
    const info = byReq.get(r.id) || { joined: [], pipeline: { accepted: 0, offer: 0, selected: 0, interview: 0 } };
    const joined = [...info.joined].sort((a, b) => String(a.day || '9999').localeCompare(String(b.day || '9999')));
    const n = Math.max(1, Number(r.openings) || 1);
    const opened = C.istDay(r.createdAt);
    const seats = [];
    for (let i = 0; i < Math.max(n, joined.length); i += 1) {
      const j = joined[i];
      if (j) {
        seats.push({
          opening: i + 1, status: i < n ? 'Filled' : 'Extra joining', person: names.get(j.x.a.candidateId) || '—', applicationId: j.x.id, candidateId: j.x.a.candidateId,
          filledOn: j.day, daysToFill: j.day ? Math.max(0, C.dayDiff(opened, j.day)) : null,
        });
      } else seats.push({ opening: i + 1, status: LIVE.includes(r.status) ? 'Open' : 'Not filled', daysOpen: C.dayDiff(opened, t0) });
    }
    const filled = Math.min(n, joined.length);
    return {
      requirementId: r.id, requirement: reqLabel(r), client: r.clientName, clientId: r.internal ? null : r.clientId, department: r.department || '—',
      status: LIVE.includes(r.status) ? 'Open' : (r.status === 'CLOSED' ? 'Closed' : r.status), openings: n, filled, left: Math.max(0, n - filled), openedOn: opened,
      pipeline: info.pipeline, seats,
    };
  }).sort((a, b) => b.left - a.left || b.openings - a.openings);
  const totals = rows.reduce((t, r) => ({ openings: t.openings + r.openings, filled: t.filled + r.filled, left: t.left + r.left }), { openings: 0, filled: 0, left: 0 });
  return { rows, totals, requirements: rows.length };
}

// --- 12.16 BOTTLENECKS + HIRING FORECAST ------------------------------------------------------------
const FLOW = [
  ['added', 'Added', null], ['shared', 'Sent to client', 'shared'], ['interview', 'Interview', 'interview'], ['selected', 'Selected', 'selected'],
  ['offer', 'Offer', 'offer'], ['joined', 'Joined', 'joined'],
];
function bottlenecks(ctx, { days = 180 } = {}) {
  const since = C.addDays(C.today(), -days);
  const recent = ctx.apps.filter((x) => C.istDay(x.a.createdAt) >= since);
  const reached = FLOW.map(([id, label, k]) => ({ id, label, n: k ? recent.filter((x) => x.reached(k)).length : recent.length }));
  const steps = reached.slice(1).map((s, i) => ({ from: reached[i].label, to: s.label, people: reached[i].n, moved: s.n, rate: pctOf(s.n, reached[i].n) }));
  // where people are waiting NOW: open applications by their current step, days in it
  const waits = new Map();
  ctx.apps.forEach((x) => {
    if (!x.inPipeline || x.joined) return;
    const w = waits.get(x.pipe.id) || { step: x.pipe.label, id: x.pipe.id, days: [] };
    w.days.push(x.daysInStage || 0);
    waits.set(x.pipe.id, w);
  });
  const waiting = [...waits.values()].map((w) => ({ step: w.step, id: w.id, people: w.days.length, usualDays: C.median(w.days), over7: w.days.filter((d) => d > 7).length, over15: w.days.filter((d) => d > 15).length }))
    .sort((a, b) => b.over7 - a.over7);
  const worstRate = steps.filter((s) => s.people >= 5 && s.rate !== null).sort((a, b) => a.rate - b.rate)[0] || null;
  const worstWait = waiting.filter((w) => w.people >= 3).sort((a, b) => (b.usualDays || 0) - (a.usualDays || 0))[0] || null;
  // the hiring forecast: requirements raised and people joined month by month, and next month from the last three
  const months = [];
  for (let i = 5; i >= 0; i -= 1) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); months.push(d.toISOString().slice(0, 7)); }
  const raised = new Map(months.map((m) => [m, 0])); const openingsRaised = new Map(months.map((m) => [m, 0])); const joined = new Map(months.map((m) => [m, 0]));
  const byDept = new Map();
  ctx.reqs.forEach((r) => {
    const m = C.istDay(r.createdAt).slice(0, 7);
    if (!raised.has(m)) return;
    raised.set(m, raised.get(m) + 1); openingsRaised.set(m, openingsRaised.get(m) + (Number(r.openings) || 1));
    const d = byDept.get(r.department || '—') || new Map(months.map((mm) => [mm, 0]));
    d.set(m, d.get(m) + (Number(r.openings) || 1)); byDept.set(r.department || '—', d);
  });
  ctx.apps.forEach((x) => { const jd = C.joinDayOf(x); if (jd && joined.has(jd.slice(0, 7))) joined.set(jd.slice(0, 7), joined.get(jd.slice(0, 7)) + 1); });
  // a weighted average of the last three full months (3 : 2 : 1); the current month is still running
  const full = months.slice(-4, -1);
  const proj = (map) => Math.round(((map.get(full[2]) || 0) * 3 + (map.get(full[1]) || 0) * 2 + (map.get(full[0]) || 0)) / 6);
  const nd = new Date(); nd.setUTCDate(1); nd.setUTCMonth(nd.getUTCMonth() + 1);
  const nextMonth = nd.toISOString().slice(0, 7);
  return {
    window: { from: since, to: C.today(), days },
    funnel: reached,
    steps,
    waiting,
    bottleneck: {
      conversion: worstRate ? `${worstRate.from} → ${worstRate.to}: only ${worstRate.rate}% move on (${worstRate.moved} of ${worstRate.people}).` : null,
      waiting: worstWait ? `${worstWait.step}: people usually wait ${worstWait.usualDays} days here (${worstWait.over7} waiting over 7 days).` : null,
    },
    trend: months.map((m) => ({ month: m, label: C.monthLabel(m), requirements: raised.get(m), openings: openingsRaised.get(m), joined: joined.get(m) })),
    nextMonth: { month: nextMonth, label: C.monthLabel(nextMonth), openings: proj(openingsRaised), requirements: proj(raised), joined: proj(joined) },
    byDepartment: [...byDept.entries()].map(([dept, m]) => ({ department: dept, last3: full.map((x) => m.get(x) || 0), nextMonth: proj(m) }))
      .sort((a, b) => b.nextMonth - a.nextMonth).slice(0, 12),
    note: 'Next month = a weighted average of the last three full months (the latest counts most). Conversion is over people added in the window.',
  };
}

module.exports = { timeToFill, readiness, forecast, openings, bottlenecks, chances, LIVE, reqLabel };
