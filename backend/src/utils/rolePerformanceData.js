// ---------------------------------------------------------------------------
// ROLE-WISE RECRUITMENT PERFORMANCE — the DATA step (user spec 2026-10-13).
//
// Builds, once per minute, one in-memory picture of the whole company that the
// report / drill-down / export / filter options all read, so a number on screen,
// the list behind it and the Excel file are the SAME rows by construction.
//
// READ-ONLY. Nothing here writes to the database.
//
// WHAT IS COUNTED (one rule per metric, one date per metric, unique by candidate)
//   Generated   the candidate was CREATED / SOURCED by the employee. Date = the
//               first trustworthy day on the candidate's records (bulk-import
//               days are NOT trusted: a spreadsheet loaded on one day says
//               nothing about when each person was really sourced).
//   Submitted   first recorded MOVE of the candidate to "Shared with client" or
//               beyond (a real stage move with a from-step, like ATS Reports).
//   Selected    first recorded MOVE to "Selected" or beyond. Shortlist, interview
//               and offer are NOT selection.
//   Joined      Joined / Hired step now AND an actual joining day (typed joining
//               date, else the recorded joined-at time). Expected / offered /
//               selected-but-not-joined are NOT joinings. Marked "Dropped" = not.
//   A candidate counts ONCE per metric (the earliest dated record across all of
//   their applications); merged and certain-duplicate profiles count as one.
//   Records that qualify but have no usable date are kept apart ("date missing"),
//   never put in a month and never silently dropped.
//
// WHO GETS THE CREDIT (utils/rolePerformance.js header explains the switch)
//   Generated is always the person who generated the candidate. Submitted /
//   Selected / Joined follow the ONE function creditFor() below, driven by the
//   AppSetting 'rolePerformance.attribution':
//     owner     (default = the app's EXISTING rule, utils/workers.js attribute():
//               follow-up owner -> job's recruiter -> recruiter who moved it;
//               the same rule the HRMS Recruiter joinings and ATS Reports use)
//     generated the recruiter who generated the candidate
//     assigned  the owner on the follow-up record as it stood on the day of the
//               metric (selection / sending / joining)
//
// ROLE AND DEPARTMENT of a row = the seat on the METRIC DAY: the seat stamped on
// the record itself (follow-up / stage move), else the person's real seat tenure
// (PositionAssignment) covering that day, else "History not available". Never the
// person's current seat.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const workers = require('./workers');
const { stageIndex } = require('./pipelineView');

const IST = 330 * 60000;
const istDay = (d) => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isNaN(t) ? null : new Date(t + IST).toISOString().slice(0, 10);
};
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const isoDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m && +m[1] >= 2015 && +m[1] <= 2100 ? String(s).slice(0, 10) : null;
};
const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normSeat = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9&]/g, '');
// Test people are left out of every report (the reports' rule) - except in the sandbox, where the
// test script's own fixtures (tagged ZZTEST RP) must count.
const SANDBOX = /^(1|true|yes)$/i.test(String(process.env.TEST_MODE || process.env.TEAMLINK_SANDBOX || ''));
const TEST_RE = SANDBOX ? /(?!)/ : /zztest|example\.test/i;
const BULK_DAY_CANDIDATES = 150; // a day that created this many candidates is a file load, not people sourcing
const SETTING_KEY = 'rolePerformance.attribution';
const MODES = ['owner', 'generated', 'assigned'];
const MODE_TEXT = {
  owner: 'The recruiter who owns the candidate on the requirement (the same rule HRMS Recruiter joinings and ATS Reports use)',
  generated: 'The recruiter who generated the candidate',
  assigned: 'The recruiter who owned the candidate on the day of the selection / sending / joining',
};

const M = {
  shared: stageIndex('SHARED_WITH_CLIENT'),
  selected: stageIndex('SELECTED'),
  accepted: stageIndex('OFFER_ACCEPTED'),
};
const JOINED = ['JOINED', 'HIRED'];
const NOT_JOINING = /not\s*join|won'?t\s*join|wont|dropp/i;

async function attributionMode() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const v = row ? JSON.parse(row.value) : null;
    return MODES.includes(v) ? v : 'owner';
  } catch { return 'owner'; }
}

// --- the build -------------------------------------------------------------------
async function build() {
  const [positions, assignments, employees, users, departments, cands, apps, reqs, clients, fus, evs, audits, aliases, flags, mode] = await Promise.all([
    prisma.position.findMany({ select: { id: true, code: true, name: true, department: true, kind: true, active: true } }),
    prisma.positionAssignment.findMany({ select: { id: true, positionId: true, employeeId: true, fromDate: true, toDate: true } }),
    prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, department: true, designation: true, employmentStatus: true, userId: true } }),
    prisma.user.findMany({ select: { id: true, name: true, status: true } }),
    prisma.department.findMany({ select: { id: true, name: true, active: true } }),
    prisma.candidate.findMany({ select: { id: true, name: true, createdAt: true } }),
    prisma.application.findMany({
      select: {
        id: true, candidateId: true, requirementId: true, stage: true, joiningDate: true, joinedAt: true,
        joiningStatus: true, createdAt: true,
      },
    }),
    prisma.requirement.findMany({ select: { id: true, title: true, reqCode: true, department: true, recruiterId: true, tlId: true, tl: true, bdeId: true, positionCode: true, internal: true, clientId: true } }),
    prisma.client.findMany({ select: { id: true, name: true } }),
    prisma.applicationFollowUp.findMany({
      select: { applicationId: true, ownerUserId: true, ownerName: true, ownerPositionCode: true, tlUserId: true, tlName: true, bdeUserId: true, bdeName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.applicationStageEvent.findMany({
      select: { applicationId: true, candidateId: true, fromStage: true, toStage: true, createdAt: true, actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.auditLog.findMany({
      where: { entity: 'Candidate', OR: [{ action: { startsWith: 'Candidate created' } }, { action: { startsWith: 'Candidate added' } }] },
      select: { entityId: true, userId: true, actorName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    // Raw + tolerant: the duplicate tables come from migration 20261010200000 (not on every database yet).
    prisma.$queryRawUnsafe('SELECT oldId, candidateId FROM CandidateAlias').catch(() => []),
    prisma.$queryRawUnsafe("SELECT candidateId, matchCandidateId FROM CandidateDupFlag WHERE level='CERTAIN' AND status IN ('OPEN','MERGE_REQUESTED')").catch(() => []),
    attributionMode(),
  ]);

  const today = todayIst();
  const dir = {
    person: null,
  };
  // The ATS person resolver (login by id / by name) — the one ATS Reports uses.
  const wdir = await workers.loadDirectory();
  dir.person = wdir.person;

  // ---- seats / departments --------------------------------------------------------
  const posById = new Map(positions.map((p) => [p.id, p]));
  const posByNorm = new Map(positions.map((p) => [normSeat(p.code), p]));
  const deptByKey = new Map();
  departments.forEach((d) => deptByKey.set(compact(d.name), { id: d.id, name: d.name, active: d.active }));
  const deptOf = (name) => {
    const k = compact(name);
    if (!k) return null;
    if (!deptByKey.has(k)) deptByKey.set(k, { id: `name:${name}`, name, active: true });
    return deptByKey.get(k);
  };
  positions.forEach((p) => { p.dept = deptOf(p.department); });

  // ---- employees / people ----------------------------------------------------------
  const userById = new Map(users.map((u) => [u.id, u]));
  const emps = new Map(); // pk -> info
  const empByUser = new Map();
  const byCompact = new Map();
  const realEmployees = employees.filter((e) => !TEST_RE.test(`${e.name} ${e.employeeCode}`));
  realEmployees.forEach((e) => {
    const pk = `e:${e.id}`;
    const u = e.userId ? userById.get(e.userId) : null;
    const left = ['Relieved', 'Exited'].includes(e.employmentStatus);
    const loginOff = u && u.status && u.status !== 'Active';
    emps.set(pk, {
      pk, employeeId: e.id, userId: e.userId || null, name: e.name, code: e.employeeCode, linked: true,
      statusGroup: left ? 'Former' : 'Active',
      statusDetail: left ? (e.employmentStatus === 'Relieved' ? 'Relieved' : 'Exited')
        : (e.employmentStatus === 'Notice Period' || e.employmentStatus === 'Exit Process' ? 'Serving notice' : loginOff ? `Login ${String(u.status).toLowerCase()}` : 'Active'),
      department: e.department || null, designation: e.designation || null,
      tenures: [], pairs: new Set(),
    });
    if (e.userId) empByUser.set(e.userId, pk);
    const k = compact(e.name);
    if (k) { if (!byCompact.has(k)) byCompact.set(k, []); byCompact.get(k).push(pk); }
  });
  assignments.forEach((a) => {
    if (a.toDate && a.toDate <= a.fromDate) return; // a same-day tenure is a data-entry stub (utils/workers.js)
    const info = emps.get(`e:${a.employeeId}`);
    const pos = posById.get(a.positionId);
    if (!info || !pos) return;
    info.tenures.push({ posId: pos.id, code: pos.code, from: a.fromDate, to: a.toDate || null });
    info.pairs.add(pos.id);
  });
  emps.forEach((i) => i.tenures.sort((x, y) => x.from.localeCompare(y.from)));

  // A credited person -> one employee entry (linked) or a name-only entry.
  function personOf(userId, name) {
    let pk = userId ? empByUser.get(userId) : null;
    if (!pk) {
      const list = byCompact.get(compact(name));
      if (list && list.length === 1) [pk] = list;
    }
    if (pk) return emps.get(pk);
    const label = String(name || '').replace(/\s+/g, ' ').trim();
    if (!label || /^imported|^system$/i.test(label) || TEST_RE.test(label)) return null;
    const npk = `n:${compact(label)}`;
    if (!emps.has(npk)) {
      emps.set(npk, {
        pk: npk, employeeId: null, userId: userId || null, name: label, code: null, linked: false, statusGroup: 'Former',
        statusDetail: 'Not linked to an employee record', department: null, designation: null, tenures: [], pairs: new Set(),
      });
    }
    return emps.get(npk);
  }

  // The seat on a day: stamped on the record, else a real tenure covering the day.
  function seatAt(info, day, stamp) {
    const sp = stamp ? posByNorm.get(normSeat(stamp)) : null;
    if (sp) { if (info) info.pairs.add(sp.id); return { pos: sp, basis: 'Seat recorded on the record' }; }
    if (info && day) {
      const cover = info.tenures.filter((t) => t.from <= day && (!t.to || t.to >= day));
      if (cover.length) {
        const pref = (t) => { const k = (posById.get(t.posId) || {}).kind; return k === 'RECRUITER' ? 0 : k === 'TL' ? 1 : 2; };
        cover.sort((a, b) => pref(a) - pref(b) || b.from.localeCompare(a.from));
        return { pos: posById.get(cover[0].posId), basis: 'Seat tenure on that day' };
      }
    }
    return { pos: null, basis: 'History not available' };
  }

  // ---- candidates: canonical id (merged / certain duplicates are one) ---------------
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  aliases.forEach((a) => union(a.oldId, a.candidateId));
  flags.forEach((f) => union(f.candidateId, f.matchCandidateId));
  const canon = (id) => find(id);
  const candById = new Map(cands.map((c) => [c.id, c]));
  const testCand = new Set(cands.filter((c) => TEST_RE.test(c.name || '')).map((c) => c.id));

  // ---- requirement / client ---------------------------------------------------------
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const reqById = new Map(reqs.map((r) => [r.id, r]));

  // ---- per-application facts ---------------------------------------------------------
  const evBy = new Map();
  evs.forEach((e) => { if (!evBy.has(e.applicationId)) evBy.set(e.applicationId, []); evBy.get(e.applicationId).push(e); });
  const fuBy = new Map();
  fus.forEach((f) => { if (!fuBy.has(f.applicationId)) fuBy.set(f.applicationId, []); fuBy.get(f.applicationId).push(f); });

  const bulk = new Set();
  const perDay = new Map();
  cands.forEach((c) => { const d = istDay(c.createdAt); perDay.set(d, (perDay.get(d) || 0) + 1); });
  perDay.forEach((n, d) => { if (n >= BULK_DAY_CANDIDATES) bulk.add(d); });
  const trusted = (d) => !!d && d >= '2015-01-01' && d <= today && !bulk.has(d);

  const realActor = (e) => !!e.actorUserId || !/^imported|^system$/i.test(String(e.actorName || '').trim()) && !!String(e.actorName || '').trim();

  const appFacts = new Map();
  const appsByCand = new Map();
  apps.forEach((a) => {
    if (testCand.has(a.candidateId)) return;
    const req = reqById.get(a.requirementId) || {};
    const aevs = evBy.get(a.id) || [];
    const afus = fuBy.get(a.id) || [];
    const joined = JOINED.includes(a.stage);
    let reach = Math.max(0, stageIndex(a.stage));
    aevs.forEach((e) => { reach = Math.max(reach, stageIndex(e.fromStage), stageIndex(e.toStage)); });
    if (!joined) reach = Math.min(reach, M.accepted);
    const crossed = {};
    aevs.forEach((e) => {
      if (!e.fromStage) return; // created / imported already at that step: keyed-in time, not event time
      ['shared', 'selected'].forEach((k) => {
        if (!crossed[k] && stageIndex(e.toStage) >= M[k] && stageIndex(e.fromStage) < M[k]) crossed[k] = istDay(e.createdAt);
      });
    });
    const f = {
      app: a, req, evs: aevs, fus: afus, joined, reach,
      sharedDay: crossed.shared || null, selectedDay: crossed.selected || null,
      joinDay: null, joinBasis: null, validJoin: false,
    };
    if (joined && !NOT_JOINING.test(a.joiningStatus || '')) {
      f.validJoin = true;
      const typed = isoDay(a.joiningDate);
      if (typed) { f.joinDay = typed; f.joinBasis = 'Joining date'; } else if (a.joinedAt) { f.joinDay = istDay(a.joinedAt); f.joinBasis = 'Joined-at time'; }
    }
    appFacts.set(a.id, f);
    if (!appsByCand.has(a.candidateId)) appsByCand.set(a.candidateId, []);
    appsByCand.get(a.candidateId).push(f);
  });

  // ---- generated: who and when ---------------------------------------------------------
  const auditBy = new Map();
  audits.forEach((x) => { if (x.entityId && !auditBy.has(x.entityId)) auditBy.set(x.entityId, x); });
  const gen = new Map(); // candidateId -> { day, info, stamp, basis }
  cands.forEach((c) => {
    if (testCand.has(c.id)) return;
    const afs = appsByCand.get(c.id) || [];
    const days = [];
    const cd = istDay(c.createdAt);
    if (trusted(cd)) days.push(cd);
    let who = null;
    let basis = null;
    const au = auditBy.get(c.id);
    if (au) {
      const ad = istDay(au.createdAt);
      if (trusted(ad)) days.push(ad);
      const p = personOf(au.userId, au.actorName || (userById.get(au.userId) || {}).name);
      if (p) { who = { info: p, stamp: null }; basis = 'Candidate created by this person (audit trail)'; }
    }
    afs.forEach((f) => {
      const ad = istDay(f.app.createdAt);
      if (trusted(ad)) days.push(ad);
      if (!who) {
        const first = f.evs.find((e) => !e.fromStage && realActor(e));
        if (first) {
          const p = personOf(first.actorUserId, first.actorName);
          if (p) { who = { info: p, stamp: first.actorPositionCode }; basis = 'Person who added the candidate to the requirement'; }
          const d = istDay(first.createdAt);
          if (trusted(d)) days.push(d);
        }
      }
      f.fus.forEach((u) => { const d = istDay(u.createdAt); if (trusted(d)) days.push(d); });
    });
    if (!who) {
      let best = null;
      afs.forEach((f) => f.fus.forEach((u) => {
        if (!(u.ownerName || u.ownerUserId)) return;
        if (!best || u.createdAt < best.createdAt) best = u;
      }));
      if (best) {
        const p = personOf(best.ownerUserId, best.ownerName);
        if (p) { who = { info: p, stamp: best.ownerPositionCode }; basis = 'Earliest recruiter on the candidate\'s follow-up record'; }
      }
    }
    gen.set(c.id, { day: days.length ? days.sort()[0] : null, who, basis: basis || 'Creator not recorded' });
  });

  // ---- credit for submitted / selected / joined ---------------------------------------
  function ownerOf(f) {
    const at = workers.attribute({
      recruiterId: f.req.recruiterId, tlId: f.req.tlId, tl: f.req.tl, bdeId: f.req.bdeId, positionCode: f.req.positionCode,
    }, f.fus, f.evs, dir.person);
    if (!at.recruiter) return null;
    const p = personOf(at.recruiter.userId, at.recruiter.label);
    if (!p) return null;
    const basis = f.fus.some((u) => u.ownerName || u.ownerUserId) ? 'Owner on the follow-up record'
      : f.req.recruiterId ? 'Recruiter of the requirement' : 'Recruiter who moved it';
    return { info: p, stamp: at.seat, basis };
  }
  function creditFor(f, day) {
    if (mode === 'generated') {
      const g = gen.get(f.app.candidateId);
      return g && g.who ? { info: g.who.info, stamp: g.who.stamp, basis: 'Generated by this recruiter' } : null;
    }
    if (mode === 'assigned' && day) {
      let hit = null;
      f.fus.forEach((u) => { if ((u.ownerName || u.ownerUserId) && istDay(u.createdAt) <= day) hit = u; });
      if (hit) {
        const p = personOf(hit.ownerUserId, hit.ownerName);
        if (p) return { info: p, stamp: hit.ownerPositionCode, basis: 'Owner on the day' };
      }
    }
    return ownerOf(f);
  }

  // ---- the events -----------------------------------------------------------------------
  const events = [];
  const seenCand = { generated: new Set(), submitted: new Set(), selected: new Set(), joined: new Set() };
  const push = (metric, cid, f, day, credit, extraBasis) => {
    const info = credit ? credit.info : null;
    const seat = info ? seatAt(info, day, credit.stamp) : { pos: null, basis: 'History not available' };
    events.push({
      metric, cid, appId: f ? f.app.id : null, day: day || null, pk: info ? info.pk : null, posId: seat.pos ? seat.pos.id : null,
      seatBasis: seat.basis, credit: credit ? credit.basis : (extraBasis || 'No recruiter on record'),
    });
  };

  // generated: one per canonical candidate (earliest day wins)
  const genBy = new Map(); // canonical -> best gen
  gen.forEach((g, id) => {
    const c = canon(id);
    const cur = genBy.get(c);
    if (!cur || (g.day && (!cur.g.day || g.day < cur.g.day)) || (!cur.g.who && g.who && !(cur.g.day && !g.day))) genBy.set(c, { id, g });
  });
  genBy.forEach(({ id, g }, c) => {
    seenCand.generated.add(c);
    const credit = g.who ? { info: g.who.info, stamp: g.who.stamp, basis: g.basis } : null;
    push('generated', id, null, g.day, credit, 'Creator not recorded');
  });

  // submitted / selected / joined: the earliest dated record of the candidate
  const byCanon = new Map();
  appsByCand.forEach((list, cid) => { const c = canon(cid); if (!byCanon.has(c)) byCanon.set(c, []); byCanon.get(c).push(...list); });
  byCanon.forEach((list, c) => {
    const pick = (qualifies, dayOf) => {
      const q = list.filter(qualifies);
      if (!q.length) return null;
      const dated = q.filter((f) => dayOf(f)).sort((a, b) => dayOf(a).localeCompare(dayOf(b)));
      return dated.length ? { f: dated[0], day: dayOf(dated[0]) } : { f: q.sort((a, b) => b.reach - a.reach)[0], day: null };
    };
    const sub = pick((f) => f.reach >= M.shared, (f) => f.sharedDay);
    const sel = pick((f) => f.reach >= M.selected, (f) => f.selectedDay);
    const joi = pick((f) => f.validJoin, (f) => f.joinDay);
    [['submitted', sub], ['selected', sel], ['joined', joi]].forEach(([metric, hit]) => {
      if (!hit) return;
      push(metric, hit.f.app.candidateId, hit.f, hit.day, creditFor(hit.f, hit.day));
    });
  });

  // company-wide months that hold any dated record = "data exists" (a 0 there is a real 0)
  const coverage = new Set();
  events.forEach((e) => { if (e.day) coverage.add(e.day.slice(0, 7)); });

  // Seat pairs seen on records (already added by seatAt) are part of each person's role history.
  const value = {
    builtAt: Date.now(), today, mode, bulkDays: [...bulk].sort(), canonMerged: [...parent.keys()].length,
    positions, posById, posByNorm, deptByKey, deptOf, emps, events, coverage,
    candById, gen, appFacts, appsByCand, byCanon, reqById, clientName, canon, userById,
    activePk: new Set(events.filter((e) => e.pk).map((e) => e.pk)),
  };
  return value;
}

let CACHE = null;
let BUILDING = null;
const TTL = 60000;
async function load({ fresh = false } = {}) {
  if (!fresh && CACHE && Date.now() - CACHE.at < TTL) return CACHE.value;
  if (BUILDING) return BUILDING;
  BUILDING = build().then((v) => { CACHE = { at: Date.now(), value: v }; return v; }).finally(() => { BUILDING = null; });
  return BUILDING;
}
function invalidate() { CACHE = null; }

module.exports = {
  load, invalidate, istDay, todayIst, compact, normSeat, attributionMode, SETTING_KEY, MODES, MODE_TEXT, TEST_RE,
};
