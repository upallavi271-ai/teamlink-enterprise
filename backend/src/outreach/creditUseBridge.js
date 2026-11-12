// ---------------------------------------------------------------------------
// RECRUITERS TOKENS, THE TEAMLINK SIDE (founder 2026-11-05). Omni-Channel (Green Start) > Campaigns > Recruiters Tokens shows tokens (message credits) per department
// and per recruiter against their joinings. Green Start owns its own sends; everything about PEOPLE is TeamLink's, so it asks here, server to server
// (GET /api/public/omni-voice/credit-use, routes/omniVoiceBridge.js, signed with the shared secret):
//   viewer      who may see what: TeamLink's own rule (insights.scopeOf). The id comes from the signed sign-in ticket, because a department's login is shared.
//   persons     the CURRENT HRMS seat holders in that scope (founder 2026-10-29: past holders hidden, a new holder appears by themselves), their department from the
//               seat code's first word (BDE EDU-1 = BDE), with their TeamLink tokens, replies, interviews and same-month joinings.
//   past        TeamLink tokens of people not in a seat now, by department, with no names: past credits stay in the month's history.
//   company     every seat holder's tokens + joinings, only for the "costly" yardstick. Green Start never shows these rows.
//   workspaces  Green Start workspace id -> department (utils/omniDeptLogins.js), for the sends no person can be named for.
//   channels    (founder 2026-11-05) tokens per way of sending: { whatsapp, sms, email, call }, from the ledger, on every person and past row.
//   aiReplies   (founder 2026-11-05: "aa login nunchi send chestey aa login name ravali") the WhatsApp AI's automatic replies are charged to the chat's owner in the ledger, but
//               that person sent nothing, so here they leave the person's numbers and stand in their own row by department.
//   aiCalls     AI phone calls that really talked (AiCall live + completed, browser talks left out): ONE source for every AI call, because Green Start only keeps a
//               history copy of them. Counted to who started the call or its campaign; calls with no such person go to noPersonCalls. Tokens = calls x the Credits "call" cost.
// A login that is not active here is refused. Reads only; writes nothing.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./access');
const Cr = require('./credits');
const Ins = require('./insights');
const { deptOfSeat } = require('../utils/assetHrmsScope');
const { resolveIdentity } = require('../utils/identity');

const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));

/** userId -> { seat, department } of everybody sitting in a seat today (PositionAssignment.toDate empty). */
async function seatHolders() {
  const rows = await prisma.positionAssignment.findMany({
    where: { toDate: null, position: { active: true } },
    select: { position: { select: { code: true, department: true } }, employee: { select: { userId: true, department: true } } },
    orderBy: { fromDate: 'desc' },
  });
  const out = new Map();
  rows.forEach((r) => {
    const id = r.employee && r.employee.userId;
    if (!id || out.has(id)) return;
    out.set(id, { seat: r.position.code, department: deptOfSeat(r.position.code) || r.position.department || r.employee.department || 'No department' });
  });
  return out;
}

/** Green Start workspace id -> department, from the department logins TeamLink itself set up. */
async function workspaceDepartments() {
  const st = await require('../utils/omniDeptLogins').last(); // eslint-disable-line global-require
  const map = {};
  Object.values((st && st.departments) || {}).forEach((row) => {
    (row.workspaceIds || (row.workspaceId ? [row.workspaceId] : [])).forEach((id) => { if (id && row.dept) map[id] = row.dept; });
  });
  return map;
}

async function interviewsBy(ids, from, to) {
  const out = new Map();
  try {
    const ev = await prisma.applicationStageEvent.groupBy({ by: ['actorUserId'], where: { toStage: 'INTERVIEW_SCHEDULED', actorUserId: { in: ids }, createdAt: { gte: new Date(from), lt: new Date(to) } }, _count: { _all: true } });
    ev.forEach((x) => out.set(x.actorUserId, x._count._all));
  } catch { /* none */ }
  return out;
}

const AI_LABEL = 'AI assistant'; // omniwa/agent.js AI_NAME

/** The WhatsApp AI's automatic replies. -> { byUser: Map(userId -> { credits, sent }), rows: [{ department, credits, sent, channels }] } */
async function aiRepliesBy(from, to) {
  const rows = await prisma.$queryRawUnsafe('SELECT userId u, department d, channel c, COUNT(*) n, COALESCE(SUM(credits),0) t FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND mode = \'live\' AND result <> \'failed\' AND templateLabel = ? GROUP BY userId, department, channel', from, to, AI_LABEL);
  const byUser = new Map(); const byDept = new Map();
  rows.forEach((r) => {
    if (r.u) { const o = byUser.get(r.u) || { credits: 0, sent: 0 }; o.credits += num(r.t); o.sent += num(r.n); byUser.set(r.u, o); }
    const k = r.d || 'No department';
    const d = byDept.get(k) || { department: k, credits: 0, sent: 0, channels: {} };
    d.credits += num(r.t); d.sent += num(r.n); d.channels[r.c] = (d.channels[r.c] || 0) + num(r.t);
    byDept.set(k, d);
  });
  return { byUser, rows: [...byDept.values()] };
}

/** Ledger tokens per way of sending. -> userId -> { whatsapp, sms, email, call } (live, not failed; test messages use no tokens; the AI's replies are not the person's) */
async function channelsBy(from, to) {
  const rows = await prisma.$queryRawUnsafe('SELECT userId u, channel c, COALESCE(SUM(credits),0) t FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND mode = \'live\' AND result <> \'failed\' AND userId IS NOT NULL AND COALESCE(templateLabel,\'\') <> ? GROUP BY userId, channel', from, to, AI_LABEL);
  const out = new Map();
  rows.forEach((r) => { const o = out.get(r.u) || {}; o[r.c] = (o[r.c] || 0) + num(r.t); out.set(r.u, o); });
  return out;
}

/** AI calls of the month that really talked. -> { by: Map(userId -> { calls, seconds }), none: { calls, seconds } } */
async function aiCallsBy(from, to, known) {
  const by = new Map(); const none = { calls: 0, seconds: 0 };
  let rows = [];
  try {
    await require('../calling/schema').ensure(); // eslint-disable-line global-require
    rows = await prisma.$queryRawUnsafe(`SELECT COALESCE(a."initiatedById", c."createdById") u, COUNT(*) n, COALESCE(SUM(a."durationSec"),0) s FROM "AiCall" a LEFT JOIN "AiCallCampaign" c ON c."id" = a."campaignId"
      WHERE a."mode" = 'live' AND a."status" = 'completed' AND COALESCE(a."dedupeKey",'') NOT LIKE 'web:%' AND a."createdAt" >= ? AND a."createdAt" < ? GROUP BY 1`, new Date(from).toISOString(), new Date(to).toISOString());
  } catch { rows = []; } // no calls table yet
  rows.forEach((r) => {
    if (r.u && known.has(r.u)) by.set(r.u, { calls: num(r.n), seconds: num(r.s) });
    else { none.calls += num(r.n); none.seconds += num(r.s); }
  });
  return { by, none };
}

// (owner 2026-11-12) A Green Start Super Admin who has no TeamLink login: Green Start sends this ONE viewer value and gets the whole-company Admin scope.
// It is honoured only when the caller passes opts.omniSuperAdmin, which only the secret-signed /api/public/omni-voice/credit-use route does.
const OMNI_SUPER_ADMIN = 'greenstart:super-admin';

/** -> { ok:true, ... } or { ok:false, code, error } (never throws for an unknown login). */
async function forOmni(viewerId, month, opts = {}) {
  const id = String(viewerId || '').trim().slice(0, 80);
  const omniAdmin = opts.omniSuperAdmin === true && id === OMNI_SUPER_ADMIN;
  const user = omniAdmin ? { id: OMNI_SUPER_ADMIN } : (id ? await resolveIdentity(id).catch(() => null) : null);
  if (!omniAdmin && (!user || (user.status && user.status !== 'Active') || require('../utils/leftLogin').hasLeft(user))) { // eslint-disable-line global-require
    return { ok: false, code: 'VIEWER_UNKNOWN', error: 'TeamLink does not know this login, or it is not active. Open Omni-Channel again from TeamLink.' };
  }
  try { await A.warm(); } catch { /* keep the last list */ }
  const sc = omniAdmin ? { all: true, words: 'Everyone' } : await Ins.scopeOf(user);
  const scope = sc.all ? 'all' : (sc.departments ? 'department' : (sc.userIds ? 'team' : 'me'));
  const m = Cr.isMonth(month) ? month : Cr.thisMonth();
  const act = await Cr.activity(m, Ins.actOpts(sc));
  const everybody = sc.all ? act : await Cr.activity(m, { all: true });
  const holders = await seatHolders();
  const { from, to } = Cr.range(m);

  // a Recruiter always sees their own row, even on a day their seat is not recorded
  const rows = act.rows.filter((r) => holders.has(r.userId) || (scope === 'me' && r.userId === user.id));
  const ids = rows.map((r) => r.userId);
  const replyBy = await Ins.repliesByOwner(ids, from, to);
  const intBy = await interviewsBy(ids, from, to);
  await Cr.ensureTables();
  const chanBy = await channelsBy(from, to);
  const aiReplies = await aiRepliesBy(from, to);
  const notAi = (id) => aiReplies.byUser.get(id) || { credits: 0, sent: 0 };
  const companyIds = new Set([...holders.keys(), ...ids]);
  const calls = await aiCallsBy(from, to, new Set(everybody.rows.map((r) => r.userId)));
  const perCall = num(act.rules.cost.call);
  const aiOf = (id) => { const c = calls.by.get(id) || { calls: 0, seconds: 0 }; return { ...c, tokens: c.calls * perCall }; };
  const persons = rows.map((r) => {
    const h = holders.get(r.userId);
    const ai = aiOf(r.userId);
    return { userId: r.userId, name: r.name, code: r.code || null, seat: h ? h.seat : null, department: (h && h.department) || r.department || 'No department', credits: r.used - notAi(r.userId).credits + ai.tokens, sent: r.sent - notAi(r.userId).sent, replies: replyBy.get(r.userId) || 0, interviews: intBy.get(r.userId) || 0, joinings: r.joinings, channels: chanBy.get(r.userId) || {}, aiCalls: ai };
  });

  const ledger = await prisma.$queryRawUnsafe('SELECT userId u, department d, COUNT(*) n, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND mode = \'live\' AND result <> \'failed\' AND userId IS NOT NULL AND COALESCE(templateLabel,\'\') <> ? GROUP BY userId, department', from, to, AI_LABEL);
  const pastBy = new Map();
  ledger.filter((r) => !holders.has(r.u) && !ids.includes(r.u)).forEach((r) => {
    const k = r.d || 'No department';
    const o = pastBy.get(k) || { department: k, credits: 0, sent: 0, channels: {} };
    o.credits += num(r.c); o.sent += num(r.n);
    Object.entries(chanBy.get(r.u) || {}).forEach(([c, t]) => { o.channels[c] = (o.channels[c] || 0) + t; });
    pastBy.set(k, o);
  });

  const departments = [...new Set([...(sc.departments || []), ...persons.map((p) => p.department)])];
  return {
    ok: true, month: m,
    viewer: { scope, words: sc.words, departments: scope === 'me' ? [] : departments },
    cost: act.rules.cost,
    persons,
    past: [...pastBy.values()],
    company: [...everybody.rows, ...rows].filter((r, i, all) => companyIds.has(r.userId) && all.findIndex((x) => x.userId === r.userId) === i).map((r) => ({ userId: r.userId, credits: r.used - notAi(r.userId).credits + aiOf(r.userId).tokens, joinings: r.joinings })),
    aiReplies: aiReplies.rows,
    noPersonCalls: { ...calls.none, tokens: calls.none.calls * perCall },
    workspaces: await workspaceDepartments(),
  };
}

// The people the Super Admin can give AI Marketing to (the current HRMS seat holders), and the role of the person asking.
async function marketingPeople(viewerId) {
  const id = String(viewerId || '').trim().slice(0, 80);
  const viewer = id ? await resolveIdentity(id).catch(() => null) : null;
  const holders = await seatHolders();
  const users = await prisma.user.findMany({ where: { id: { in: [...holders.keys()] } }, select: { id: true, name: true, status: true } });
  const persons = users.filter((u) => !u.status || u.status === 'Active').map((u) => ({ userId: u.id, name: u.name, ...holders.get(u.id) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const superAdmin = viewer && (viewer.role === 'SUPER_ADMIN' || viewer.hrmsRole === 'SUPER_ADMIN');
  return { ok: true, viewerRole: superAdmin ? 'SUPER_ADMIN' : (viewer ? viewer.role : null), persons };
}

module.exports = { forOmni, seatHolders, workspaceDepartments, marketingPeople };
