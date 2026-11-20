// ---------------------------------------------------------------------------
// ATS HISTORY OF PEOPLE (founder 2026-11-20): "search a RECRUITER and see their department, requirements and complete work history (profiles,
// sent to client, joined, month-wise, day-wise); a TL: the whole team; a CLIENT: how many requirements and joinings; a CANDIDATE: all
// their applications and their complete history."
//
// READ ONLY, built on utils/atsHistory.js: the same records, the same funnel, the same one definition of dropped, and the joinings come from
// creditedJoinings (recruiterJoinings.js / joinedRule.js): "Joined" = still working; a person who left is Dropped (and "Left after joining").
//
//   viewerOf(user)                       what this login may open: everything / its own team / itself / nothing, and whether it may read contacts
//   searchAll(user, q, { clientDesk })   People (recruiters, TLs), Clients, Requirements, Candidates - each only inside the login's scope
//   recruiterHistory / tlHistory / candidateHistory   the three pages
//   exportSheets*                        the Excel workbooks
//
// ACCESS (strict):
//   Super Admin / Admin / Manager   every recruiter, TL and candidate in their reach
//   TL / STL                        their own team's people and their own page; their requirements, clients and candidates (applicationWhere)
//   Recruiter                       only their OWN recruiter page and the candidates in their scope
//   BDE / BDE TL                    Clients and Requirements of their desk; NO recruiter or TL productivity pages; a candidate only in the limited
//                                   view (no phone, e-mail, pay, documents, notes, calls)
//   Client / Candidate logins       nothing
// A name outside the login's scope is simply not found (never an error that leaks it).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const SC = require('./scope');
const V = require('./atsVocab');
const RJ = require('./recruiterJoinings');
const H = require('./atsHistory');

const { istDay, isoDay, todayIst, addDays, daysBetween } = H;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REJECT_TYPES = ['tl', 'bde', 'recruiter', 'teamlink', 'client'];

// ---- who may open what -------------------------------------------------------------------------------------------------------------------
async function teamOf(tlId) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const ident = await resolveIdentity(tlId);
  if (!ident) return null;
  const ids = new Set();
  const ps = ident.atsPositionScope;
  if (ps && Array.isArray(ps.holderUserIds)) ps.holderUserIds.forEach((x) => ids.add(x));
  (ident.atsTeamUserIds || []).forEach((x) => ids.add(x));
  const emps = await prisma.employee.findMany({ where: { userId: { not: null }, tl: ident.name }, select: { userId: true } }).catch(() => []);
  emps.forEach((e) => ids.add(e.userId));
  ids.delete(tlId);
  return { ident, ids: [...ids] };
}

async function viewerOf(user) {
  const out = {
    kind: 'none', all: false, ids: new Set(), tlIds: new Set(), contact: false, bdeTeam: false, billing: false,
  };
  if (H.external(user)) return { ...out, kind: 'external' };
  const role = SC.atsViewRole(user);
  let bdeTeam = false;
  try { bdeTeam = require('./clientLifecycle').isBdeTeam(user); } catch { bdeTeam = false; } // eslint-disable-line global-require
  out.bdeTeam = bdeTeam;
  try {
    const { can } = require('../middleware/auth'); // eslint-disable-line global-require
    out.contact = !bdeTeam && !!(await can(user, 'ats', 'candidates', 'Candidate Contact & Salary', 'view'));
  } catch { out.contact = false; }
  out.billing = await H.mayBilling(user);
  if (role === 'admin' || role === 'mgmt') return { ...out, kind: 'all', all: true };
  if (bdeTeam || role === 'bde') return { ...out, kind: 'bde' };
  if (role === 'tl' || role === 'stl') {
    const t = await teamOf(user.id);
    const ids = new Set([user.id, ...(t ? t.ids : [])]);
    const tl = new Set([user.id]);
    const ps = SC.atsScopeOf(user).positions;
    if (role === 'stl' && ps && Array.isArray(ps.holderUserIds)) ps.holderUserIds.forEach((x) => { ids.add(x); tl.add(x); });
    return { ...out, kind: 'tl', ids, tlIds: tl };
  }
  if (role === 'recruiter') return { ...out, kind: 'recruiter', ids: new Set([user.id]) };
  return { ...out, kind: role };
}
const mayRecruiter = (v, id) => v.all || v.ids.has(id);
const mayTl = (v, id) => v.all || v.tlIds.has(id);

// ---- people --------------------------------------------------------------------------------------------------------------------------------
async function headerOf(uid) {
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, name: true, status: true, atsRole: true, atsDepartment: true, atsScopeTeams: true, createdAt: true } });
  if (!user) return null;
  const emp = await prisma.employee.findUnique({ where: { userId: uid }, select: { id: true, employeeCode: true, department: true, team: true, tl: true, designation: true, employmentStatus: true, dateOfJoining: true } }).catch(() => null);
  let seat = null; let seatTl = null;
  if (emp) {
    const as = await prisma.positionAssignment.findFirst({ where: { employeeId: emp.id, toDate: null }, orderBy: { fromDate: 'desc' }, include: { position: true } }).catch(() => null);
    if (as && as.position) {
      seat = { code: as.position.code, department: as.position.department, team: as.position.team, kind: as.position.kind, since: as.fromDate };
      if (as.position.reportsToId) {
        const holder = await prisma.positionAssignment.findFirst({ where: { positionId: as.position.reportsToId, toDate: null }, include: { employee: { select: { name: true } } } }).catch(() => null);
        seatTl = holder && holder.employee ? holder.employee.name : null;
      }
    }
  }
  const since = emp && emp.dateOfJoining ? { day: istDay(emp.dateOfJoining), est: false } : { day: istDay(user.createdAt), est: true };
  const left = emp && ['Relieved', 'Exited'].includes(emp.employmentStatus);
  return {
    id: user.id, name: user.name, role: user.atsRole === 'RECRUITER' ? 'Recruiter' : ['TL', 'STL'].includes(user.atsRole) ? 'Team lead' : user.atsRole,
    department: (emp && emp.department) || user.atsDepartment || null, section: (seat && seat.team) || (emp && emp.team) || (user.atsScopeTeams || '').split(',')[0].trim() || null,
    seat: seat ? seat.code : null, seatSince: seat ? seat.since : null, teamLead: seatTl || (emp && emp.tl) || null, designation: (emp && emp.designation) || null, employeeId: emp ? emp.id : null,
    employeeCode: emp ? emp.employeeCode : null, active: user.status === 'Active' && !left, statusWord: left ? `Left (${emp.employmentStatus})` : user.status === 'Active' ? 'Active' : user.status, since,
  };
}

// ---- time series ---------------------------------------------------------------------------------------------------------------------------
const GRAINS = ['day', 'week', 'month'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function mondayOf(day) { const d = new Date(`${day}T00:00:00Z`); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w); return d.toISOString().slice(0, 10); }
const bucketOf = (day, grain) => (grain === 'month' ? day.slice(0, 7) : grain === 'week' ? mondayOf(day) : day);
function labelOf(key, grain) {
  if (grain === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  const d = `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  return grain === 'week' ? `Week of ${d}` : d;
}
function rangeOf(q = {}) {
  const grain = GRAINS.includes(q.grain) ? q.grain : 'month';
  const p = H.periodOf(q);
  const today = todayIst();
  let to = p.to || today;
  let from = p.from;
  if (!from) from = grain === 'day' ? addDays(to, -29) : grain === 'week' ? mondayOf(addDays(to, -7 * 11)) : `${addDays(`${to.slice(0, 7)}-01`, -330).slice(0, 7)}-01`;
  const cap = grain === 'day' ? 366 : grain === 'week' ? 7 * 104 : 365 * 5;
  if (daysBetween(from, to) > cap) from = addDays(to, -cap);
  if (from > to) [from, to] = [to, from];
  return { grain, from, to };
}
function keysBetween(from, to, grain) {
  const out = [];
  let cur = bucketOf(from, grain);
  const last = bucketOf(to, grain);
  for (let i = 0; i < 2000 && cur <= last; i += 1) {
    out.push(cur);
    if (grain === 'day') cur = addDays(cur, 1);
    else if (grain === 'week') cur = addDays(cur, 7);
    else { const [y, m] = cur.split('-').map(Number); cur = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); }
  }
  return out;
}
const SERIES_FIELDS = ['added', 'sent', 'interviews', 'selected', 'offers', 'joined', 'dropped', 'followups', 'calls'];

// events: [{ day, field }]
function seriesOf(recs, extras, rng) {
  const rows = new Map(keysBetween(rng.from, rng.to, rng.grain).map((k) => [k, { key: k, label: labelOf(k, rng.grain), ...Object.fromEntries(SERIES_FIELDS.map((f) => [f, 0])) }]));
  const bump = (day, field) => {
    if (!day || day < rng.from || day > rng.to) return;
    const row = rows.get(bucketOf(day, rng.grain));
    if (row) row[field] += 1;
  };
  recs.forEach((r) => {
    bump(r.steps.sourced && r.steps.sourced.day, 'added');
    bump(r.steps.shared && r.steps.shared.day, 'sent');
    bump(r.steps.interviewScheduled && r.steps.interviewScheduled.day, 'interviews');
    bump(r.steps.selected && r.steps.selected.day, 'selected');
    bump(r.steps.offerReleased && r.steps.offerReleased.day, 'offers');
    bump(r.steps.joined && r.steps.joined.day, 'joined');
    if (r.outcome === 'dropped' && r.drop) bump(r.drop.day, 'dropped');
  });
  (extras || []).forEach((e) => bump(e.day, e.field));
  const list = [...rows.values()];
  const total = Object.fromEntries(SERIES_FIELDS.map((f) => [f, list.reduce((n, r) => n + r[f], 0)]));
  return { rows: list.reverse(), total, grain: rng.grain, from: rng.from, to: rng.to }; // newest first
}

async function activityExtras(userIds, rng) {
  if (!userIds.length) return [];
  const gte = new Date(`${rng.from}T00:00:00+05:30`);
  const lt = new Date(`${addDays(rng.to, 1)}T00:00:00+05:30`);
  const rows = await prisma.applicationFollowUp.findMany({
    where: { ownerUserId: { in: userIds }, OR: [{ completedAt: { gte, lt } }, { lastContactedAt: { gte, lt } }] },
    select: { completedAt: true, lastContactedAt: true, contactMode: true },
  }).catch(() => []);
  const out = [];
  rows.forEach((r) => {
    if (r.completedAt && r.completedAt >= gte && r.completedAt < lt) out.push({ day: istDay(r.completedAt), field: 'followups' });
    if (r.lastContactedAt && r.contactMode === 'Call' && r.lastContactedAt >= gte && r.lastContactedAt < lt) out.push({ day: istDay(r.lastContactedAt), field: 'calls' });
  });
  return out;
}

async function targetsFor(employeeIds, recs, rng) {
  const months = keysBetween(rng.from, rng.to, 'month').slice(-24);
  const achieved = new Map();
  recs.forEach((r) => { if (r.steps.joined) { const m = r.steps.joined.day.slice(0, 7); achieved.set(m, (achieved.get(m) || 0) + 1); } });
  const ids = employeeIds.filter(Boolean);
  const rows = [];
  for (const m of months) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const ts = await Promise.all(ids.map((e) => RJ.targetFor(e, m).catch(() => null)));
    const known = ts.filter((t) => t !== null && t !== undefined);
    rows.push({ month: m, label: labelOf(m, 'month'), target: known.length ? known.reduce((a, b) => a + b, 0) : null, achieved: achieved.get(m) || 0 });
  }
  return rows.reverse();
}

// ---- rows -------------------------------------------------------------------------------------------------------------------------------------
function personRow(rec, reqById) {
  const r = reqById.get(rec.requirementId) || {};
  return {
    ...H.rowOut(rec), added: rec.steps.sourced, sent: rec.steps.shared, requirementId: rec.requirementId,
    requirement: r.title ? (r.reqCode ? `${r.reqCode} · ${r.title}` : r.title) : '', client: H.clientNameOf(r), clientId: r.clientId || null,
  };
}
const countOf = (tiles, k) => (tiles.find((t) => t.key === k) || {}).count || 0;
const TOTAL_KEYS = ['sourced', 'approved', 'shared', 'shortlisted', 'interviewScheduled', 'selected', 'offerReleased', 'joined', 'dropped', 'left', 'inprocess'];
const totalsOf = (recs, period) => { const f = H.funnelOf(recs, period); return Object.fromEntries(TOTAL_KEYS.map((k) => [k, countOf(f.tiles, k)])); };

function requirementRows(recs, reqs, period) {
  const per = new Map();
  recs.forEach((r) => { if (!per.has(r.requirementId)) per.set(r.requirementId, []); per.get(r.requirementId).push(r); });
  return reqs.map((r) => ({
    id: r.id, reqCode: r.reqCode, title: r.title, status: r.status, statusLabel: V.requirementStatusLabel(r.status), openings: r.openings, client: H.clientNameOf(r), clientId: r.clientId,
    numbers: totalsOf(per.get(r.id) || [], period), createdDay: istDay(r.createdAt),
  }));
}

async function handoversOf(name) {
  if (!name) return { given: [], taken: [] };
  const rows = await prisma.auditLog.findMany({
    where: { entity: 'Application', action: { startsWith: 'Candidate handed over' }, OR: [{ fromValue: name }, { fromValue: `${name} (left)` }, { toValue: name }] },
    select: { entityId: true, fromValue: true, toValue: true, reason: true, actorName: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 300,
  }).catch(() => []);
  const apps = await prisma.application.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.entityId).filter(Boolean))] } }, select: { id: true, candidate: { select: { name: true } }, requirement: { select: { title: true } } } });
  const info = new Map(apps.map((a) => [a.id, a]));
  const shape = (r) => ({ day: istDay(r.createdAt), candidate: (info.get(r.entityId) || {}).candidate ? info.get(r.entityId).candidate.name : '—', requirement: (info.get(r.entityId) || {}).requirement ? info.get(r.entityId).requirement.title : '', from: r.fromValue, to: r.toValue, by: r.actorName || null, reason: r.reason || null });
  return { given: rows.filter((r) => String(r.fromValue || '').replace(/ \(left\)$/, '') === name).map(shape), taken: rows.filter((r) => r.toValue === name).map(shape) };
}

// requirements a recruiter (or a set of them) handled: assigned, or holding some of their candidates
async function requirementsOfRecruiters(viewer, uids, extraWhere = []) {
  const ownedReqIds = (await prisma.application.findMany({ where: { AND: [{ ownerRecruiterId: { in: uids } }, SC.applicationWhere(viewer)] }, select: { requirementId: true }, distinct: ['requirementId'] })).map((a) => a.requirementId);
  return prisma.requirement.findMany({
    where: { AND: [SC.requirementWhere(viewer), { OR: [{ recruiterId: { in: uids } }, ...uids.map((u) => ({ recruiterIds: { contains: u } })), { id: { in: ownedReqIds } }, ...extraWhere] }] },
    select: H.REQ_SELECT, orderBy: { createdAt: 'desc' },
  });
}

// ---- recruiter page ----------------------------------------------------------------------------------------------------------------------
async function recruiterHistory(viewerUser, uid, q = {}) {
  const v = await viewerOf(viewerUser);
  if (!mayRecruiter(v, uid)) return null;
  const person = await headerOf(uid);
  if (!person || !['Recruiter', 'Team lead'].includes(person.role)) return null;
  await H.ensureIndexes();
  const reqs = await requirementsOfRecruiters(viewerUser, [uid]);
  const { recs: all, reqById } = reqs.length ? await H.loadRecords(viewerUser, reqs, { fresh: false }) : { recs: [], reqById: new Map() };
  const mineAll = all.filter((r) => r.recruiterId === uid);
  const { recs, period } = H.applyFilters(mineAll, { from: q.from, to: q.to, period: q.period });
  const f = H.funnelOf(recs, period);
  const rng = rangeOf(q);
  const series = seriesOf(mineAll, await activityExtras([uid], rng), rng);
  const reqRows = requirementRows(recs, reqs, period).filter((r) => r.numbers.sourced > 0 || (reqs.find((x) => x.id === r.id) || {}).recruiterId === uid);
  const rows = H.tableRows(recs, q).map((r) => personRow(r, reqById));
  const targets = await targetsFor([person.employeeId], mineAll, rng);
  return {
    person, definitions: H.DEFINITIONS, period, range: rng, funnel: f.tiles, dropSummary: f.dropSummary, joinedDetail: f.joinedDetail,
    requirements: reqRows, series, targets, rows, total: rows.length, handovers: await handoversOf(person.name),
    notes: { estimatedDates: f.tiles.reduce((n, t) => n + t.estimated, 0) }, viewer: { kind: v.kind },
  };
}

// ---- TL page ----------------------------------------------------------------------------------------------------------------------------
async function tlHistory(viewerUser, tlId, q = {}) {
  const v = await viewerOf(viewerUser);
  if (!mayTl(v, tlId)) return null;
  const person = await headerOf(tlId);
  if (!person || person.role !== 'Team lead') return null;
  const team = await teamOf(tlId);
  const memberUsers = team && team.ids.length ? await prisma.user.findMany({ where: { id: { in: team.ids }, atsRole: { in: ['RECRUITER'] } }, select: { id: true } }) : [];
  const memberIds = memberUsers.map((u) => u.id);
  const heads = await Promise.all(memberIds.map((id) => headerOf(id)));
  await H.ensureIndexes();
  const reqs = await requirementsOfRecruiters(viewerUser, memberIds, [{ tlId }]);
  const { recs: all, reqById } = reqs.length ? await H.loadRecords(viewerUser, reqs, { fresh: false }) : { recs: [], reqById: new Map() };
  const mem = new Set(memberIds);
  const teamAll = all.filter((r) => mem.has(r.recruiterId) || (reqById.get(r.requirementId) || {}).tlId === tlId);
  const { recs, period } = H.applyFilters(teamAll, { from: q.from, to: q.to, period: q.period });
  const f = H.funnelOf(recs, period);
  const rng = rangeOf(q);
  const series = seriesOf(teamAll, await activityExtras([...memberIds, tlId], rng), rng);
  const memberRows = heads.filter(Boolean).map((h) => ({ id: h.id, name: h.name, active: h.active, statusWord: h.statusWord, seat: h.seat, department: h.department, totals: totalsOf(recs.filter((r) => r.recruiterId === h.id), period) }));
  const others = recs.filter((r) => !mem.has(r.recruiterId));
  const compare = [...memberRows.sort((a, b) => b.totals.joined - a.totals.joined || a.name.localeCompare(b.name))];
  if (others.length) compare.push({ id: null, name: 'Others on the team\'s requirements (not a team member / not recorded)', active: null, totals: totalsOf(others, period), other: true });
  const total = totalsOf(recs, period);
  // clients served
  const clientMap = new Map();
  recs.forEach((r) => { const rq = reqById.get(r.requirementId) || {}; const k = rq.clientId || '—'; if (!clientMap.has(k)) clientMap.set(k, { id: rq.clientId || null, name: H.clientNameOf(rq), recs: [], reqs: new Set() }); const c = clientMap.get(k); c.recs.push(r); c.reqs.add(r.requirementId); });
  const clients = [...clientMap.values()].map((c) => ({ id: c.id, name: c.name, requirements: c.reqs.size, numbers: totalsOf(c.recs, period) })).sort((a, b) => b.numbers.joined - a.numbers.joined || a.name.localeCompare(b.name));
  const listOf = (pred) => recs.filter(pred).map((r) => personRow(r, reqById));
  const targets = await targetsFor(heads.filter(Boolean).map((h) => h.employeeId), teamAll, rng);
  const hand = await Promise.all(heads.filter(Boolean).map((h) => handoversOf(h.name)));
  return {
    person, team: { section: person.section, department: person.department, members: memberRows.length, memberNames: memberRows.map((m) => m.name) },
    definitions: H.DEFINITIONS, period, range: rng, funnel: f.tiles, dropSummary: f.dropSummary, joinedDetail: f.joinedDetail,
    members: compare, total, requirements: requirementRows(recs, reqs, period).filter((r) => r.numbers.sourced > 0 || reqs.find((x) => x.id === r.id).tlId === tlId), clients, series, targets,
    joinedList: listOf((r) => r.outcome === 'joined'), droppedList: listOf((r) => r.outcome === 'dropped'),
    handovers: { given: hand.reduce((n, h) => n + h.given.length, 0), taken: hand.reduce((n, h) => n + h.taken.length, 0) },
    notes: { estimatedDates: f.tiles.reduce((n, t) => n + t.estimated, 0) }, viewer: { kind: v.kind },
  };
}

// ---- candidate page ---------------------------------------------------------------------------------------------------------------------
const codeOf = (id) => String(id || '').slice(-8).toUpperCase();

async function candidateHistory(viewerUser, candidateId) {
  const v = await viewerOf(viewerUser);
  if (['external', 'none'].includes(v.kind)) return null;
  const limited = v.bdeTeam || v.kind === 'bde';
  const cand = await prisma.candidate.findFirst({
    where: { AND: [{ id: candidateId }, SC.candidateWhere(viewerUser)] },
    select: {
      id: true, name: true, phone: true, email: true, source: true, createdAt: true, consentStatus: true, consentPurposes: true, consentAt: true, consentSource: true, consentWithdrawnAt: true, currentDesignation: true,
    },
  });
  if (!cand) return null;
  await H.ensureIndexes();
  // every application in this login's scope, with its requirement
  const scopedApps = await prisma.application.findMany({ where: { AND: [{ candidateId }, SC.applicationWhere(viewerUser)] }, select: { id: true, requirementId: true } });
  const reqIds = [...new Set(scopedApps.map((a) => a.requirementId))];
  const reqs = reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: H.REQ_SELECT }) : [];
  const { recs, reqById } = reqs.length ? await H.loadRecords(viewerUser, reqs, { fresh: false, candidateId }) : { recs: [], reqById: new Map() };
  const appIds = recs.map((r) => r.applicationId);
  const names = new Map();
  const uidList = [...new Set([...reqs.map((r) => r.tlId), ...recs.map((r) => r.recruiterId)].filter(Boolean))];
  if (uidList.length) (await prisma.user.findMany({ where: { id: { in: uidList } }, select: { id: true, name: true } })).forEach((u) => names.set(u.id, u.name));
  const apps = recs.map((r) => {
    const rq = reqById.get(r.requirementId) || {};
    return { ...personRow(r, reqById), tl: names.get(rq.tlId) || null, requirementStatus: V.requirementStatusLabel(rq.status), interviews: r.interviewDates, interviewResult: r.interviewResult };
  }).sort((a, b) => String((b.added && b.added.day) || '').localeCompare(String((a.added && a.added.day) || '')));
  const drops = recs.filter((r) => r.outcome === 'dropped' && r.drop);
  const byType = (t) => drops.filter((r) => r.drop.type === t).length;
  const rejected = drops.filter((r) => REJECT_TYPES.includes(r.drop.type));
  const totals = {
    applications: recs.length, selected: recs.filter((r) => r.steps.selected).length, offered: recs.filter((r) => r.steps.offerReleased).length,
    joined: recs.filter((r) => r.outcome === 'joined').length, dropped: drops.length, rejected: rejected.length,
    withdrawn: byType('withdrew'), declinedOffer: byType('declined_offer'), didNotJoin: byType('no_show'), leftAfterJoining: byType('left_after_joining'),
    inProcess: recs.filter((r) => ['inprocess', 'selected'].includes(r.outcome)).length,
  };
  const rejectedBy = new Map();
  rejected.forEach((r) => rejectedBy.set(r.drop.typeLabel, (rejectedBy.get(r.drop.typeLabel) || 0) + 1));
  const rejections = rejected.map((r) => ({ candidateApplicationId: r.applicationId, requirement: personRow(r, reqById).requirement, by: r.drop.typeLabel, byName: r.drop.byName, reason: r.drop.reason, stageLabel: r.drop.stageLabel, day: r.drop.day }));

  // ---- one time-ordered timeline
  const tl = [];
  const push = (day, at, kind, text, extra = {}) => { if (day) tl.push({ day, at: at ? new Date(at).toISOString() : null, kind, text, ...extra }); };
  push(istDay(cand.createdAt), cand.createdAt, 'sourced', `Added to TeamLink${cand.source ? ` (source: ${cand.source})` : ''}`);
  const reqLabel = new Map(apps.map((a) => [a.applicationId, a.requirement]));
  const stageEvs = appIds.length ? await prisma.applicationStageEvent.findMany({ where: { applicationId: { in: appIds } }, select: { applicationId: true, fromStage: true, toStage: true, action: true, comment: true, actorName: true, actorRole: true, reasonCategory: true, reasonDetail: true, createdAt: true }, orderBy: { createdAt: 'asc' } }) : [];
  stageEvs.forEach((e) => {
    const where = reqLabel.get(e.applicationId) || '';
    const same = e.fromStage === e.toStage;
    const txt = same ? `${e.action}${e.comment && !limited ? `: ${e.comment}` : ''}` : e.fromStage ? `Moved from ${V.stageLabel(e.fromStage)} to ${V.stageLabel(e.toStage)}${e.toStage === 'REJECTED' && (e.reasonCategory || e.reasonDetail) ? ` - ${[e.reasonCategory, e.reasonDetail].filter(Boolean).join(': ')}` : ''}` : `Applied (${V.stageLabel(e.toStage)})`;
    push(istDay(e.createdAt), e.createdAt, 'stage', `${where}: ${txt}${e.actorName ? ` (${e.actorName})` : ''}`, { applicationId: e.applicationId });
  });
  const ievs = appIds.length ? await prisma.interviewEvent.findMany({ where: { applicationId: { in: appIds } }, select: { applicationId: true, status: true, reason: true, toSlot: true, by: true, createdAt: true }, orderBy: { createdAt: 'asc' } }) : [];
  ievs.forEach((e) => push(istDay(e.createdAt), e.createdAt, 'interview', `${reqLabel.get(e.applicationId) || ''}: interview ${String(e.status).toLowerCase()}${e.toSlot ? ` for ${istDay(e.toSlot)}` : ''}${e.reason ? ` (${e.reason})` : ''}`, { applicationId: e.applicationId }));
  const fbs = appIds.length ? await prisma.interviewFeedback.findMany({ where: { applicationId: { in: appIds } }, select: { applicationId: true, kind: true, recommendation: true, overall: true, submittedBy: true, createdAt: true } }) : [];
  fbs.filter((f) => !limited || f.kind === 'Client').forEach((f) => push(istDay(f.createdAt), f.createdAt, 'feedback', `${reqLabel.get(f.applicationId) || ''}: ${f.kind === 'Client' ? 'client' : 'internal'} interview feedback - ${f.recommendation}${f.overall ? `: ${String(f.overall).slice(0, 160)}` : ''}${f.submittedBy ? ` (${f.submittedBy})` : ''}`, { applicationId: f.applicationId }));
  recs.forEach((r) => {
    if (r.steps.offerReleased) push(r.steps.offerReleased.day, null, 'offer', `${reqLabel.get(r.applicationId) || ''}: offer released${r.steps.offerReleased.est ? ' (date estimated)' : ''}`, { applicationId: r.applicationId, est: r.steps.offerReleased.est });
    if (r.joinDay) push(r.joinDay, null, 'joined', `${reqLabel.get(r.applicationId) || ''}: joined`, { applicationId: r.applicationId });
    if (r.drop) push(r.drop.day, null, 'dropped', `${reqLabel.get(r.applicationId) || ''}: ${r.drop.typeLabel}${r.drop.stageLabel && r.drop.type !== 'left_after_joining' ? ` at "${r.drop.stageLabel}"` : ''}${r.drop.reason ? ` (${r.drop.reason})` : ''}`, { applicationId: r.applicationId, est: r.drop.estimated });
  });
  const inScope = (appId) => !appId || appIds.includes(appId);
  if (!limited) {
    const msgs = await prisma.candidateMessage.findMany({ where: { candidateId }, select: { applicationId: true, channel: true, templateLabel: true, subject: true, status: true, senderName: true, createdAt: true, sentAt: true } });
    msgs.filter((m) => inScope(m.applicationId)).forEach((m) => push(istDay(m.sentAt || m.createdAt), m.sentAt || m.createdAt, 'message', `${m.channel} message${m.templateLabel ? ` "${m.templateLabel}"` : m.subject ? ` "${m.subject}"` : ''} - ${String(m.status).replace(/_/g, ' ').toLowerCase()}${m.senderName ? ` (${m.senderName})` : ''}`, { applicationId: m.applicationId }));
    const notes = await prisma.candidateNote.findMany({ where: { candidateId }, select: { applicationId: true, body: true, authorName: true, createdAt: true } });
    notes.filter((n) => inScope(n.applicationId)).forEach((n) => push(istDay(n.createdAt), n.createdAt, 'note', `Note: ${String(n.body).slice(0, 220)}${n.authorName ? ` (${n.authorName})` : ''}`, { applicationId: n.applicationId }));
    const fus = appIds.length ? await prisma.applicationFollowUp.findMany({ where: { applicationId: { in: appIds } }, select: { applicationId: true, ownerName: true, contactMode: true, lastContactedAt: true, nextAction: true, outcome: true, notes: true, completedAt: true, createdAt: true } }) : [];
    fus.forEach((f) => {
      if (f.lastContactedAt) push(istDay(f.lastContactedAt), f.lastContactedAt, f.contactMode === 'Call' ? 'call' : 'followup', `${f.contactMode || 'Contact'} with the candidate${f.outcome ? `: ${f.outcome}` : ''}${f.ownerName ? ` (${f.ownerName})` : ''}`, { applicationId: f.applicationId });
      else if (f.completedAt) push(istDay(f.completedAt), f.completedAt, 'followup', `Follow-up done: ${f.nextAction || 'follow-up'}${f.ownerName ? ` (${f.ownerName})` : ''}`, { applicationId: f.applicationId });
    });
    const hos = appIds.length ? await prisma.auditLog.findMany({ where: { entity: 'Application', entityId: { in: appIds }, action: { startsWith: 'Candidate handed over' } }, select: { entityId: true, fromValue: true, toValue: true, actorName: true, reason: true, createdAt: true } }) : [];
    hos.forEach((h) => push(istDay(h.createdAt), h.createdAt, 'handover', `Handed over from ${h.fromValue || '—'} to ${h.toValue}${h.reason ? ` (${h.reason})` : ''}${h.actorName ? ` by ${h.actorName}` : ''}`, { applicationId: h.entityId }));
    const merges = await prisma.candidateMergeLog.findMany({ where: { OR: [{ masterId: candidateId }, { donorIds: { contains: candidateId } }] }, select: { kind: true, status: true, summary: true, performedByName: true, createdAt: true } }).catch(() => []);
    merges.forEach((m) => push(istDay(m.createdAt), m.createdAt, 'merge', `Duplicate ${m.kind === 'SAME_PERSON_OTHER_JOB' ? 'linked' : 'merged'}${m.status === 'UNDONE' ? ' (undone later)' : ''}${m.summary ? `: ${String(m.summary).slice(0, 160)}` : ''}${m.performedByName ? ` (${m.performedByName})` : ''}`));
    const docs = await prisma.candidateDocument.findMany({ where: { candidateId, deletedAt: null }, select: { id: true, docType: true, name: true, uploadedByName: true, createdAt: true } });
    docs.forEach((d) => push(istDay(d.createdAt), d.createdAt, 'document', `Document added: ${d.docType} - ${d.name}${d.uploadedByName ? ` (${d.uploadedByName})` : ''}`, { refId: d.id }));
    if (cand.consentStatus) push(istDay(cand.consentAt || cand.createdAt), cand.consentAt || cand.createdAt, 'consent', `Consent ${String(cand.consentStatus).replace(/_/g, ' ').toLowerCase()}${cand.consentSource ? ` (via ${cand.consentSource})` : ''}${cand.consentAt ? '' : ' (date not recorded)'}`);
    if (cand.consentWithdrawnAt) push(istDay(cand.consentWithdrawnAt), cand.consentWithdrawnAt, 'consent', 'Consent withdrawn');
  }
  tl.sort((a, b) => String(a.at || `${a.day}T12:00:00.000Z`).localeCompare(String(b.at || `${b.day}T12:00:00.000Z`)));
  return {
    candidate: {
      id: cand.id, name: cand.name, code: codeOf(cand.id), source: cand.source || null, cameOn: istDay(cand.createdAt), designation: cand.currentDesignation || null,
      ...(v.contact ? { phone: cand.phone || null, email: cand.email || null } : {}),
      owners: [...new Set(recs.map((r) => r.recruiterName).filter(Boolean))],
      consent: limited ? undefined : { status: cand.consentStatus || null, source: cand.consentSource || null, at: cand.consentAt ? istDay(cand.consentAt) : null },
    },
    limited, contactShown: v.contact, definitions: H.DEFINITIONS, totals, rejections, rejectedBy: [...rejectedBy.entries()].map(([by, count]) => ({ by, count })),
    applications: apps, timeline: tl, viewer: { kind: v.kind },
  };
}

// (the search itself is utils/atsSearch.js: ONE engine for the top bar, the dashboard bar and the results page)

async function accessInfo(user) {
  const v = await viewerOf(user);
  return { kind: v.kind, peopleAll: v.all, peopleIds: v.all ? [] : [...v.ids], tlIds: v.all ? [] : [...v.tlIds], contact: v.contact, billing: v.billing, limited: v.bdeTeam || v.kind === 'bde' };
}

// ---- Excel -----------------------------------------------------------------------------------------------------------------------------------
const mark = (x) => (x ? `${x.day}${x.est ? ' (estimated)' : ''}` : '');
const dayCell = (d) => d || '';
const SERIES_HEAD = ['Period', 'Profiles added', 'Sent to client', 'Interviews', 'Selected', 'Offers', 'Joined', 'Dropped', 'Follow-ups done', 'Calls made'];
const seriesRows = (s) => [...s.rows.map((r) => [r.label, ...SERIES_FIELDS.map((f) => r[f])]), ['Total', ...SERIES_FIELDS.map((f) => s.total[f])]];
const candRows = (rows) => rows.map((x) => [x.candidate, x.recruiterName || '', x.requirement, x.client, mark(x.added), mark(x.sent), (x.interviewDates || []).join(', '), x.interviewResult || '', mark(x.selected), mark(x.offer), dayCell(x.joinDay),
  x.outcome === 'joined' ? 'Joined (still working)' : x.outcome === 'dropped' ? 'Dropped' : x.outcome === 'selected' ? 'Selected, not joined yet' : 'In process',
  x.drop ? `${x.drop.day || ''}${x.drop.estimated ? ' (estimated)' : ''}` : '', x.drop ? x.drop.typeLabel : '', x.drop ? x.drop.reason || '' : '']);
const CAND_HEAD = ['Candidate', 'Recruiter', 'Requirement', 'Client', 'Added', 'Sent to client', 'Interview date(s)', 'Interview result', 'Selected on', 'Offer released', 'Joining date', 'Status', 'Dropped on', 'Drop type', 'Drop reason'];
const TOTAL_HEAD = ['Name', 'Profiles sourced', 'Approved', 'Sent to client', 'Shortlisted', 'Interviews', 'Selected', 'Offers', 'Joined (still working)', 'Dropped', 'Left after joining', 'In process'];
const totalRow = (name, t) => [name, t.sourced, t.approved, t.shared, t.shortlisted, t.interviewScheduled, t.selected, t.offerReleased, t.joined, t.dropped, t.left, t.inprocess];

function recruiterSheets(d) {
  return [
    { name: 'Summary', headers: ['Item', 'Value'], rows: [['Recruiter', d.person.name], ['Department', d.person.department || ''], ['Section / team', d.person.section || ''], ['Seat', d.person.seat || ''], ['Team lead', d.person.teamLead || ''], ['Status', d.person.statusWord], ['Dropped means', d.definitions.dropped]] },
    H.funnelSheet(d.funnel),
    { name: 'Periods', headers: SERIES_HEAD, rows: seriesRows(d.series) },
    { name: 'Targets', headers: ['Month', 'Target (joinings)', 'Joined'], rows: d.targets.map((t) => [t.label, t.target === null ? '' : t.target, t.achieved]) },
    { name: 'Requirements', headers: ['Requirement', 'Client', 'Status', 'Openings', 'Sourced', 'Sent to client', 'Interviews', 'Selected', 'Joined', 'Dropped'], rows: d.requirements.map((r) => [r.title, r.client, r.statusLabel, r.openings, r.numbers.sourced, r.numbers.shared, r.numbers.interviewScheduled, r.numbers.selected, r.numbers.joined, r.numbers.dropped]) },
    { name: 'Candidates', headers: CAND_HEAD, rows: candRows(d.rows) },
  ];
}
function tlSheets(d) {
  return [
    { name: 'Summary', headers: ['Item', 'Value'], rows: [['Team lead', d.person.name], ['Department', d.person.department || ''], ['Section / team', d.person.section || ''], ['Members', d.team.members], ['Dropped means', d.definitions.dropped]] },
    H.funnelSheet(d.funnel),
    { name: 'Periods', headers: SERIES_HEAD, rows: seriesRows(d.series) },
    { name: 'Members', headers: TOTAL_HEAD, rows: [...d.members.map((m) => totalRow(m.name, m.totals)), totalRow('Team total', d.total)] },
    { name: 'Clients', headers: ['Client', 'Requirements', 'Sent to client', 'Selected', 'Joined', 'Dropped'], rows: d.clients.map((c) => [c.name, c.requirements, c.numbers.shared, c.numbers.selected, c.numbers.joined, c.numbers.dropped]) },
    { name: 'Joined', headers: CAND_HEAD, rows: candRows(d.joinedList) },
    { name: 'Dropped', headers: CAND_HEAD, rows: candRows(d.droppedList) },
  ];
}
function candidateSheets(d) {
  return [
    { name: 'Summary', headers: ['Item', 'Value'], rows: [['Candidate', d.candidate.name], ['Candidate ID', d.candidate.code], ['Source', d.candidate.source || ''], ['Came on', d.candidate.cameOn || ''], ...(d.candidate.phone !== undefined ? [['Phone', d.candidate.phone || ''], ['Email', d.candidate.email || '']] : []),
      ['Applications', d.totals.applications], ['Selected', d.totals.selected], ['Rejected', d.totals.rejected], ['Offered', d.totals.offered], ['Joined', d.totals.joined], ['Dropped', d.totals.dropped], ['Withdrawn', d.totals.withdrawn]] },
    {
      name: 'Applications',
      headers: ['Requirement', 'Client', 'Recruiter', 'Team lead', 'Applied', 'Sent to client', 'Interview date(s)', 'Interview result', 'Selected on', 'Offer released', 'Joining date', 'Status', 'Dropped on', 'Drop type', 'Drop reason'],
      rows: d.applications.map((x) => [x.requirement, x.client, x.recruiterName || '', x.tl || '', mark(x.added), mark(x.sent), (x.interviewDates || []).join(', '), x.interviewResult || '', mark(x.selected), mark(x.offer), dayCell(x.joinDay),
        x.outcome === 'joined' ? 'Joined (still working)' : x.outcome === 'dropped' ? 'Dropped' : x.outcome === 'selected' ? 'Selected, not joined yet' : 'In process', x.drop ? `${x.drop.day || ''}` : '', x.drop ? x.drop.typeLabel : '', x.drop ? x.drop.reason || '' : '']),
    },
    { name: 'Timeline', headers: ['Date', 'What'], rows: d.timeline.map((e) => [e.day, e.text]) },
  ];
}

module.exports = {
  viewerOf, teamOf, headerOf, mayRecruiter, mayTl, rangeOf, seriesOf, bucketOf, keysBetween, recruiterHistory, tlHistory, candidateHistory, accessInfo,
  recruiterSheets, tlSheets, candidateSheets, GRAINS,
};
