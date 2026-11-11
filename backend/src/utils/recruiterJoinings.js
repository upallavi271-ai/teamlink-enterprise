// ---------------------------------------------------------------------------
// RECRUITER JOININGS (user, 2026-10-05) — "a recruiter has 4 targets a month,
// i.e. 4 joinings. However many joinings they give in a month must pop up in
// HRMS; Super Admin then gives an incentive or raises the salary."
//
// ONE RULE, HERE, used by every screen (the HRMS popup, HRMS → Performance &
// Development → Recruiter joinings, the recruiter's own "3 of 4", payroll):
//
//   COUNTED      an application whose step is Joined (JOINED / HIRED) and
//                whose joining day is in the month — the ATS reports' own
//                join day (utils/reportsPlus.js joinDayOf: the joining date,
//                else joinedAt, else the recorded move into Joined) —
//                credited to the recruiter the ATS reports credit it to
//                (utils/workers.js attribute(): the follow-up owner → the
//                job's recruiter → a recruiter who moved it). Counted whether
//                the person is still inside the client's guarantee period or
//                past it; the screen says which.
//   NOT COUNTED  (shown separately, never silently dropped) applications
//                with a joining date in the month that are NOT Joined now:
//                did not join / offer declined / left after joining (moved
//                off Joined) / still waiting to join / on hold.
//   SKIPPED      (shown with the reason) joined applications that cannot be
//                credited: no recruiter on record, or no usable joining date
//                at all (old imported rows) — those belong to no month.
//   Test people (zztest / example.test on the candidate) are left out, the
//   reports' rule (utils/atsHome.js isTest).
//
// TARGET: 4 a month unless Super Admin set another number for everyone, a
// department or one person, from a month onward (RecruiterJoiningTarget).
// The most specific rule wins (person → department → everyone), and within a
// level the latest month on or before the month asked.
//
// WHO IS LISTED for a month: every login with the ATS role Recruiter whose
// HRMS employee worked that month (a real seat tenure overlapping it, or
// still employed), plus anybody credited with a joining that month.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const workers = require('./workers');
const { joinDayOf } = require('./reportsPlus');

const DEFAULT_TARGET = 4;
const JOINED = ['JOINED', 'HIRED'];
const SELECTED_WAITING = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const PAYABLE = ['Active', 'On Probation', 'Notice Period'];
const TEST_RE = /zztest|example\.test/i; // utils/atsHome.js isTest
const NOT_JOINING_TEXT = /not\s*join|won'?t\s*join|wont|dropp|rejected/i;
const IST = 330 * 60000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const thisMonth = () => todayIst().slice(0, 7);
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const prevMonth = (m = thisMonth()) => addMonths(m, -1);
const nextMonth = (m) => addMonths(m, 1);
function lastDay(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
function monthLabel(month) {
  if (!isMonth(month)) return month || '';
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : null);
const isTest = (s) => TEST_RE.test(String(s || ''));
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// "1 Month", "3 Months", "30 Days", "1 Year", "No replacement" -> days | null.
function guaranteeDays(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  if (/no\s*replace/.test(s)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*(day|month|year|week)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'month';
  if (unit === 'day') return Math.round(n);
  if (unit === 'week') return Math.round(n * 7);
  if (unit === 'year') return Math.round(n * 365);
  return Math.round(n * 30);
}

// --- Targets -------------------------------------------------------------------
async function loadTargetRules() {
  try {
    return await prisma.recruiterJoiningTarget.findMany({ orderBy: { fromMonth: 'asc' } });
  } catch { return []; } // table not migrated yet
}
// The target for one person in one month, and where it came from.
function targetOf(rules, { employeeId, department }, month) {
  const latest = (scope, key) => rules
    .filter((r) => r.scope === scope && r.scopeKey === (key || '') && r.fromMonth <= month)
    .sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))[0];
  const own = employeeId ? latest('EMPLOYEE', employeeId) : null;
  if (own) return { target: own.target, source: `Set for this person from ${monthLabel(own.fromMonth)}`, level: 'person' };
  const dept = department ? latest('DEPARTMENT', department) : null;
  if (dept) return { target: dept.target, source: `Set for ${department} from ${monthLabel(dept.fromMonth)}`, level: 'department' };
  const all = latest('ALL', '');
  if (all) return { target: all.target, source: `Set for everyone from ${monthLabel(all.fromMonth)}`, level: 'everyone' };
  return { target: DEFAULT_TARGET, source: `Standard target (${DEFAULT_TARGET} a month)`, level: 'default' };
}

// --- Seats -----------------------------------------------------------------------
// A same-day tenure is a data-entry stub (utils/workers.js realTenure).
const realTenure = (a) => !(a.toDate && a.toDate <= a.fromDate);
async function loadSeats() {
  const [positions, assignments] = await Promise.all([
    prisma.position.findMany({ select: { id: true, code: true, kind: true, department: true, team: true, reportsToId: true } }),
    prisma.positionAssignment.findMany({ select: { positionId: true, employeeId: true, fromDate: true, toDate: true } }),
  ]);
  const posById = new Map(positions.map((p) => [p.id, p]));
  const real = assignments.filter(realTenure);
  return { positions, posById, assignments: real };
}
const overlaps = (a, from, to) => a.fromDate <= to && (!a.toDate || a.toDate >= from);
// The seat a person held in the month: the latest real tenure overlapping it.
// Recruiter / TL seats first (a BDE / HR stub seat is not their desk).
function seatInMonth(seats, employeeId, month) {
  const from = `${month}-01`;
  const to = lastDay(month);
  const mine = seats.assignments.filter((a) => a.employeeId === employeeId && overlaps(a, from, to))
    .map((a) => ({ a, p: seats.posById.get(a.positionId) })).filter((x) => x.p);
  const pref = (x) => (x.p.kind === 'RECRUITER' ? 0 : x.p.kind === 'TL' ? 1 : 2);
  mine.sort((x, y) => pref(x) - pref(y) || y.a.fromDate.localeCompare(x.a.fromDate));
  return mine[0] ? mine[0].p : null;
}
// The TL over a seat in the month: the holder of the TL seat it reports to.
function tlOfSeat(seats, seat, month, empById) {
  if (!seat) return null;
  const from = `${month}-01`;
  const to = lastDay(month);
  let cursor = seat.kind === 'RECRUITER' ? seat.reportsToId : null;
  for (let guard = 0; cursor && guard < 6; guard += 1) {
    const p = seats.posById.get(cursor);
    if (!p) return null;
    if (p.kind === 'TL') {
      const h = seats.assignments.filter((a) => a.positionId === p.id && overlaps(a, from, to))
        .sort((x, y) => y.fromDate.localeCompare(x.fromDate))[0];
      const e = h ? empById.get(h.employeeId) : null;
      return { seat: p.code, employeeId: e ? e.id : null, userId: e ? e.userId : null, name: e ? e.name : null };
    }
    cursor = p.reportsToId;
  }
  return null;
}

// --- The one count -----------------------------------------------------------------
const APP_SELECT = {
  id: true, candidateId: true, requirementId: true, stage: true, joiningDate: true, joinedAt: true,
  joiningStatus: true, offerStatus: true,
  candidate: { select: { name: true } },
  requirement: {
    select: {
      id: true, reqCode: true, title: true, internal: true, department: true,
      recruiterId: true, tlId: true, tl: true, bdeId: true, positionCode: true,
      client: { select: { name: true, guaranteePeriod: true } },
    },
  },
  followUps: {
    select: {
      ownerUserId: true, ownerName: true, ownerPositionCode: true, tlUserId: true, tlName: true,
      bdeUserId: true, bdeName: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  },
  stageEvents: {
    select: {
      fromStage: true, toStage: true, createdAt: true, actorUserId: true, actorName: true, actorRole: true, actorPositionCode: true,
    },
    orderBy: { createdAt: 'asc' },
  },
};

const CACHE = new Map(); // month -> { at, value }
const CACHE_MS = 120000; // a joining keyed in ATS shows within 2 minutes; decisions refresh at once
function invalidate() { CACHE.clear(); }

// Every joining of the month, credited. -> { month, apps:[…], dir }
async function monthApplications(month, { fresh = false } = {}) {
  const hit = CACHE.get(month);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const from = `${month}-01`;
  const to = lastDay(month);
  const J = { stage: { in: JOINED } };
  const rows = await prisma.application.findMany({
    where: {
      OR: [
        { joiningDate: { startsWith: month } },
        // A joined row without a usable joining date is placed by joinedAt or
        // its move into Joined (joinDayOf), so it is read too.
        { AND: [J, { OR: [{ joiningDate: null }, { joiningDate: '' }, { joiningDate: { lt: '2015' } }, { joiningDate: { gt: '2101' } }] }] },
      ],
    },
    select: APP_SELECT,
  });
  // DID NOT JOIN (founder 2026-11-11): a person the ATS moved to Rejected with the reason "Did Not Join" and who has no joining date
  // of their own belongs to the month it was recorded, so the month shows the drop-out with its reason. Never counted; a person
  // WITH a joining date is already in that date's month above.
  let extraRows = [];
  const dnjDay = new Map();
  try {
    const dnj = await prisma.applicationStageEvent.findMany({
      where: { toStage: 'REJECTED', reasonCategory: 'Did Not Join', createdAt: { gte: new Date(`${from}T00:00:00+05:30`), lt: new Date(`${addDays(to, 1)}T00:00:00+05:30`) } },
      select: { applicationId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    dnj.forEach((e) => { if (!dnjDay.has(e.applicationId)) dnjDay.set(e.applicationId, istDay(e.createdAt)); });
    const have = new Set(rows.map((a) => a.id));
    const ids = [...dnjDay.keys()].filter((id) => !have.has(id));
    if (ids.length) {
      extraRows = (await prisma.application.findMany({ where: { id: { in: ids }, stage: 'REJECTED' }, select: APP_SELECT }))
        .filter((a) => !/^\d{4}-\d{2}-\d{2}/.test(String(a.joiningDate || '')));
    }
  } catch { /* the list is a bonus: the count never depends on it */ }
  const dir = await workers.loadDirectory();
  // handovers: the credit reads who had the candidate before each one (utils/handover.js)
  const HO = await require('./handover').handoversFor(rows.filter((a) => JOINED.includes(a.stage)).map((a) => a.id)); // eslint-disable-line global-require
  const today = todayIst();
  const apps = [];
  const undated = [];
  [...rows, ...extraRows].forEach((a) => {
    if (isTest(a.candidate && a.candidate.name)) return;
    const evs = a.stageEvents || [];
    const joined = JOINED.includes(a.stage);
    const firstMove = evs.find((e) => e.fromStage && JOINED.includes(e.toStage) && !JOINED.includes(e.fromStage));
    const x = { joined, a, crossedAt: { joined: firstMove ? firstMove.createdAt : null }, evs };
    let day = joined ? joinDayOf(x) : null;
    const typed = /^\d{4}-\d{2}-\d{2}/.test(String(a.joiningDate || '')) ? String(a.joiningDate).slice(0, 10) : null;
    // a person who never joined and has no joining date: the day it was recorded (extraRows above)
    const recordedOnly = !joined && !typed && dnjDay.has(a.id);
    if (!joined) day = typed || (recordedOnly ? dnjDay.get(a.id) : null);
    if (joined && !day) { undated.push(a); return; }
    if (!day || day < from || day > to) return;
    const req = a.requirement || {};
    const reqForAttr = { recruiterId: req.recruiterId, tlId: req.tlId, tl: req.tl, bdeId: req.bdeId, positionCode: req.positionCode };
    const at = workers.attribute(reqForAttr, a.followUps || [], evs, dir.person);
    // the joining is the work of who got the person Selected (utils/workers.js joinCredit, founder 2026-11-10; before that: who had
    // them on the joining day) - not of a recruiter who took the seat, the job or the candidate later
    if (joined) {
      const by = workers.joinCredit(reqForAttr, a.followUps || [], evs, dir.person, day ? `${day}T23:59:59+05:30` : (firstMove && firstMove.createdAt) || null, HO.get(a.id));
      // nobody on record had joined the company by then: an earlier recruiter's work, never whoever has the candidate now
      at.recruiter = by || { key: 'n:earlier recruiter', userId: null, label: 'Earlier recruiter (not recorded)', team: null };
    }
    const client = req.internal ? 'TeamLink Internal' : (req.client && req.client.name) || '—';
    const row = {
      id: a.id,
      candidateId: a.candidateId,
      candidate: (a.candidate && a.candidate.name) || '—',
      requirementId: a.requirementId,
      job: req.title || '—',
      jobCode: req.reqCode || null,
      client,
      joiningDate: day,
      recordedOnly, // true: `joiningDate` is the day the "Did Not Join" was recorded, not a joining date
      stage: a.stage,
      recruiterKey: at.recruiter ? at.recruiter.key : null,
      recruiterName: at.recruiter ? at.recruiter.label : null,
      recruiterUserId: at.recruiter ? at.recruiter.userId || null : null,
      seat: at.seat || null,
      counted: false,
      status: '',
      tone: '',
      note: null,
    };
    if (joined) {
      const days = req.internal ? null : guaranteeDays(req.client && req.client.guaranteePeriod);
      const gEnd = days ? addDays(day, days) : null;
      row.counted = true;
      row.tone = 'green';
      row.guaranteeEnd = gEnd;
      if (gEnd && today <= gEnd) {
        const g = new Date(`${gEnd}T00:00:00Z`);
        row.status = `Joined · in guarantee till ${g.getUTCDate()} ${MONTHS[g.getUTCMonth()].slice(0, 3)} ${g.getUTCFullYear()}`;
      }
      else if (gEnd) row.status = 'Joined · past guarantee';
      else row.status = 'Joined';
      if (NOT_JOINING_TEXT.test(a.joiningStatus || '')) {
        row.note = `Step says Joined, but the joining status says "${a.joiningStatus}" — please check.`;
        row.tone = 'orange';
      }
    } else {
      const wasJoined = evs.some((e) => JOINED.includes(e.toStage));
      if (a.stage === 'REJECTED') {
        if (wasJoined) { row.status = 'Left after joining'; row.tone = 'red'; } else if (a.offerStatus === 'Offer Declined') { row.status = 'Offer declined — did not join'; row.tone = 'red'; } else { row.status = 'Did not join'; row.tone = 'red'; }
      } else if (a.stage === 'HOLD') {
        row.status = 'On hold'; row.tone = 'orange';
      } else if (SELECTED_WAITING.includes(a.stage)) {
        row.status = day < today ? 'Joining date passed — not joined yet' : 'Waiting to join';
        row.tone = 'orange';
      } else {
        row.status = 'Not joined'; row.tone = 'red';
      }
    }
    apps.push(row);
  });
  // JOINING & DROP (2026-10-17): READ ONLY. A candidate who dropped after joining is shown as a note on the row, and one that dropped AFTER the
  // recruiter's incentive was decided is flagged for HR. Nothing here changes `counted`, the joining day or any past decision: the count above is the
  // only source of truth for incentives.
  try {
    const S = require('../joindrop/schema'); // eslint-disable-line global-require
    if (apps.length && (await S.ensure())) {
      const ids = apps.map((a) => a.id);
      const byApp = new Map();
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        // eslint-disable-next-line no-await-in-loop
        const got = await S.rows(`SELECT "applicationId","status","droppedOn","lastWorkingDay","dropReason","dropReasonDetail","dropWithinGuarantee","dropAfterIncentive" FROM "JoiningRecord" WHERE "applicationId" IN (${chunk.map(() => '?').join(',')})`, ...chunk);
        got.forEach((g) => byApp.set(g.applicationId, g));
      }
      apps.forEach((r) => {
        const d = byApp.get(r.id);
        if (!d || d.status !== 'Dropped') return;
        r.drop = {
          droppedOn: d.droppedOn, lastWorkingDay: d.lastWorkingDay || null, reason: d.dropReason, detail: d.dropReasonDetail || null,
          withinGuarantee: d.dropWithinGuarantee === 1, afterIncentive: d.dropAfterIncentive === 1,
        };
        const note = `Dropped after joining${d.droppedOn ? ` on ${d.droppedOn}` : ''}${d.dropReason ? ` (${d.dropReason})` : ''}. Still counted here: a drop does not change a past count or incentive.${d.dropAfterIncentive === 1 ? ' An incentive was already decided for this month: HR to review.' : ''}`;
        r.note = r.note ? `${r.note} ${note}` : note;
        r.tone = 'orange';
      });
    }
  } catch { /* the note is a bonus: the count never depends on it */ }
  const value = { month, apps, undated, dir };
  CACHE.set(month, { at: Date.now(), value });
  return value;
}

// DROP-OUTS (founder 2026-11-11: "which joinings came and how many dropped, with the reason, in the monthly targets").
//   left     a person who joined and then left: a Joining & Drop record says Dropped, or the step moved off Joined to Rejected
//   notjoin  a person who had a joining date this month and never joined: did not join / offer declined
// A drop never changes the Joinings count or an incentive (the rule above); it is shown beside it.
function dropKind(r) {
  if (r.drop || /^Left after joining/.test(r.status || '')) return 'left';
  if (!r.counted && /^(Did not join|Offer declined)/.test(r.status || '')) return 'notjoin';
  return null;
}

// --- The month board ---------------------------------------------------------------
function toneOf(n, t) {
  if (!(t > 0)) return n > 0 ? 'green' : 'grey';
  if (n >= t) return 'green';
  if (t - n <= 1 || n >= t * 0.75) return 'orange';
  return 'red';
}
const TONE_WORD = { green: 'Reached', orange: 'Close', red: 'Low', grey: '—' };

async function loadDecisions(month) {
  try {
    return await prisma.recruiterJoiningDecision.findMany({ where: { month } });
  } catch { return []; }
}

// The whole company for one month (no role scope — routes apply it).
async function monthBoard(month, { fresh = false } = {}) {
  if (!isMonth(month)) throw Object.assign(new Error('Pick a month.'), { status: 400 });
  const [{ apps, undated, dir }, seats, rules, decisions, emps] = await Promise.all([
    monthApplications(month, { fresh }), loadSeats(), loadTargetRules(), loadDecisions(month),
    prisma.employee.findMany({ select: { id: true, employeeCode: true } }),
  ]);
  const codeOf = new Map(emps.map((e) => [e.id, e.employeeCode]));
  const from = `${month}-01`;
  const to = lastDay(month);
  const empById = dir.empById;
  const decisionOf = new Map(decisions.map((d) => [d.employeeId, d]));
  const people = new Map(); // key -> person

  const addPerson = (key, { userId, name, employee }) => {
    if (people.has(key)) return people.get(key);
    const p = {
      key, userId: userId || null, name, employee: employee || null, apps: [], notCounted: [],
    };
    people.set(key, p);
    return p;
  };
  // 1. Every Recruiter login whose employee worked that month.
  dir.users.forEach((u) => {
    if (u.atsRole !== 'RECRUITER' || isTest(u.name)) return;
    const e = dir.empByUser.get(u.id);
    if (!e) return;
    const tenure = seats.assignments.some((a) => a.employeeId === e.id && overlaps(a, from, to));
    const employed = PAYABLE.includes(e.employmentStatus) && u.status === 'Active';
    if (!tenure && !employed) return;
    addPerson(`u:${u.id}`, { userId: u.id, name: u.name, employee: e });
  });
  // 2. Anybody credited with a joining that month.
  const skipped = [];
  apps.forEach((r) => {
    if (!r.recruiterKey) {
      if (r.counted) skipped.push({ ...r, reason: 'No recruiter on record for this joining' });
      return;
    }
    if (isTest(r.recruiterName)) return;
    let p = people.get(r.recruiterKey);
    if (!p) {
      const e = r.recruiterUserId ? dir.empByUser.get(r.recruiterUserId) : dir.empByName.get(String(r.recruiterName || '').trim().toLowerCase());
      p = addPerson(r.recruiterKey, { userId: r.recruiterUserId, name: r.recruiterName, employee: e || null });
    }
    (r.counted ? p.apps : p.notCounted).push(r);
  });

  const rows = [...people.values()].map((p) => {
    const e = p.employee;
    let seat = e ? seatInMonth(seats, e.id, month) : null;
    // No seat on file for the month: the seat stamped on their joinings.
    let seatCode = seat ? seat.code : null;
    if (!seatCode) {
      const counts = new Map();
      [...p.apps, ...p.notCounted].forEach((r) => { if (r.seat) counts.set(r.seat, (counts.get(r.seat) || 0) + 1); });
      seatCode = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)[0] || null;
      if (seatCode) seat = seats.positions.find((x) => x.code === seatCode) || null;
    }
    const department = (seat && seat.department) || (e && e.department) || null;
    const tl = tlOfSeat(seats, seat, month, empById);
    const t = targetOf(rules, { employeeId: e ? e.id : null, department }, month);
    const joinings = p.apps.length;
    const tone = toneOf(joinings, t.target);
    const d = e ? decisionOf.get(e.id) || null : null;
    const left = e ? !PAYABLE.includes(e.employmentStatus) : true;
    return {
      key: p.key,
      userId: p.userId,
      employeeId: e ? e.id : null,
      employeeCode: e ? codeOf.get(e.id) || null : null,
      name: (e && e.name) || p.name,
      employmentStatus: e ? e.employmentStatus : null,
      left,
      seat: seatCode,
      department,
      team: seat ? seat.team || null : null,
      tlName: tl ? tl.name : null,
      tlUserId: tl ? tl.userId : null,
      tlSeat: tl ? tl.seat : null,
      target: t.target,
      targetSource: t.source,
      joinings,
      notCountedCount: p.notCounted.length,
      // drop-outs of the month's joining dates: left after joining / never joined (counts only; the people are in personMonthDetail)
      droppedCount: [...p.apps, ...p.notCounted].filter((x) => dropKind(x) === 'left').length,
      didNotJoinCount: p.notCounted.filter((x) => dropKind(x) === 'notjoin').length,
      tone,
      toneWord: TONE_WORD[tone],
      // A decision is needed for anyone with an HRMS record who is still on
      // the payroll, or who left but brought joinings that month.
      needsDecision: !!e && (!left || joinings > 0),
      decision: d,
      joiningList: p.apps.sort((a, b) => a.joiningDate.localeCompare(b.joiningDate)),
      notCountedList: p.notCounted.sort((a, b) => a.joiningDate.localeCompare(b.joiningDate)),
    };
  });
  rows.sort((a, b) => b.joinings - a.joinings || String(a.name).localeCompare(String(b.name)));
  return {
    month,
    label: monthLabel(month),
    from,
    to,
    ended: month < thisMonth(),
    current: month === thisMonth(),
    defaultTarget: DEFAULT_TARGET,
    rule: {
      counted: 'Counted: the candidate\'s step is Joined and the joining date is in this month — whether they are still inside the client\'s guarantee period or past it.',
      notCounted: 'Not counted: people who had a joining date this month but did not join, declined, left after joining, or are still waiting to join.',
      credit: 'Each joining is credited to the recruiter the ATS reports credit it to (the follow-up owner, else the requirement\'s recruiter).',
    },
    rows,
    skipped,
    undatedCount: undated.length,
  };
}

// The applications that belong to no month (joined, no usable date).
async function undatedJoinings(month = thisMonth()) {
  const { undated } = await monthApplications(month);
  return undated.map((a) => ({
    id: a.id,
    candidate: (a.candidate && a.candidate.name) || '—',
    job: (a.requirement && a.requirement.title) || '—',
    client: a.requirement && a.requirement.internal ? 'TeamLink Internal' : ((a.requirement && a.requirement.client && a.requirement.client.name) || '—'),
    joiningDate: a.joiningDate || null,
    reason: a.joiningDate ? `Joining date "${a.joiningDate}" is not a real date` : 'No joining date recorded',
  }));
}

// One person, month by month (newest first).
async function personHistory(employeeId, months = 12) {
  const out = [];
  let m = thisMonth();
  for (let i = 0; i < months; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const b = await monthBoard(m);
    const r = b.rows.find((x) => x.employeeId === employeeId);
    out.push({
      month: m,
      label: b.label,
      current: b.current,
      target: r ? r.target : null,
      joinings: r ? r.joinings : 0,
      notCounted: r ? r.notCountedCount : 0,
      dropped: r ? r.droppedCount : 0,
      didNotJoin: r ? r.didNotJoinCount : 0,
      tone: r ? r.tone : 'grey',
      toneWord: r ? r.toneWord : '—',
      seat: r ? r.seat : null,
      decision: r ? r.decision : null,
      listed: !!r,
    });
    m = prevMonth(m);
  }
  return out;
}

// ONE recruiter, ONE month, with the people: who joined, who dropped after joining and why, who never joined and why.
// Names, clients and jobs are ATS data: the route that calls this only answers a login that holds the ATS and may see this
// recruiter (routes/recruiterJoinings.js /details). -> { month, label, key, name, target, joinings, joined[], dropouts[], waiting[] }
async function personMonthDetail(month, key) {
  const b = await monthBoard(month);
  const row = b.rows.find((r) => r.key === key || (r.employeeId && r.employeeId === key));
  if (!row) return null;
  const all = [...row.joiningList, ...row.notCountedList];
  const ids = all.filter((r) => dropKind(r) || r.stage === 'REJECTED').map((r) => r.id);
  // why a person who never joined (or left) was moved to Rejected: the reason on that step, latest first
  const why = new Map();
  if (ids.length) {
    try {
      const evs = await prisma.applicationStageEvent.findMany({
        where: { applicationId: { in: ids }, toStage: 'REJECTED' },
        orderBy: { createdAt: 'desc' },
        select: { applicationId: true, reasonCategory: true, reasonDetail: true, comment: true, createdAt: true },
      });
      evs.forEach((e) => { if (!why.has(e.applicationId)) why.set(e.applicationId, e); });
    } catch { /* the reason is a bonus: the list never depends on it */ }
  }
  const item = (r) => {
    const kind = dropKind(r);
    const d = r.drop || null;
    const ev = why.get(r.id) || null;
    const typed = d && d.reason && !/^not recorded$/i.test(d.reason) ? [d.reason, d.detail].filter(Boolean).join(' - ') : '';
    // "Did Not Join - won't join" says "did not join" twice: the "what happened" column already does, so only the detail is the reason
    const stepWhy = ev ? (ev.reasonDetail || ev.comment || '') : '';
    const fromStep = ev ? (/^did not join$/i.test(ev.reasonCategory || '') && stepWhy ? stepWhy : [ev.reasonCategory, stepWhy].filter(Boolean).join(' - ')) : '';
    const reason = typed || fromStep || '';
    return {
      id: r.id,
      candidateId: r.candidateId,
      candidate: r.candidate,
      client: r.client,
      job: r.job,
      jobCode: r.jobCode,
      joiningDate: r.recordedOnly ? null : r.joiningDate,
      status: r.status,
      tone: r.tone,
      counted: !!r.counted,
      kind: kind || (r.counted ? 'joined' : 'waiting'),
      droppedOn: d ? d.droppedOn || null : (r.recordedOnly ? r.joiningDate : null),
      lastWorkingDay: d ? d.lastWorkingDay || null : null,
      withinGuarantee: d ? !!d.withinGuarantee : null,
      afterIncentive: d ? !!d.afterIncentive : false,
      reason,
      reasonRecorded: !!reason,
      guaranteeEnd: r.guaranteeEnd || null,
    };
  };
  const byDate = (a, c) => String(a.joiningDate || '').localeCompare(String(c.joiningDate || ''));
  const items = all.map(item).sort(byDate);
  return {
    month,
    label: monthLabel(month),
    key: row.key,
    employeeId: row.employeeId,
    name: row.name,
    target: row.target,
    joinings: row.joinings,
    joined: items.filter((x) => x.counted),
    dropouts: items.filter((x) => x.kind === 'left' || x.kind === 'notjoin'),
    waiting: items.filter((x) => x.kind === 'waiting'),
  };
}

// The recruiter's own figure for a month (ATS dashboard, HRMS dashboard).
async function ownFigure(user, month = thisMonth()) {
  if (!user || !user.id) return null;
  const b = await monthBoard(month);
  const r = b.rows.find((x) => x.userId === user.id || (user.employeeId && x.employeeId === user.employeeId));
  if (!r) return null;
  return {
    month, label: b.label, target: r.target, joinings: r.joinings, tone: r.tone, toneWord: r.toneWord,
    seat: r.seat, appIds: r.joiningList.map((a) => a.id), list: r.joiningList, notCounted: r.notCountedList,
  };
}

// Target only (ATS dashboard fallback when no Monthly Target row exists).
async function targetFor(employeeId, month = thisMonth()) {
  const e = employeeId ? await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, department: true } }) : null;
  if (!e) return null;
  const [rules, seats] = await Promise.all([loadTargetRules(), loadSeats()]);
  const seat = seatInMonth(seats, e.id, month);
  return targetOf(rules, { employeeId: e.id, department: (seat && seat.department) || e.department }, month).target;
}

// The month's COUNTED placements per recruiter — the same rule as every screen
// here — for other modules (e.g. Accounts spreading a month's incentive over
// that month's placements). -> [{ key, employeeId, userId, name, seat,
// department, target, joinings, applicationIds[], incentive (₹ or null) }]
async function countedPlacements(month) {
  const b = await monthBoard(month);
  return b.rows.filter((r) => r.joinings > 0).map((r) => ({
    key: r.key, employeeId: r.employeeId, userId: r.userId, name: r.name, seat: r.seat, department: r.department,
    target: r.target, joinings: r.joinings, applicationIds: r.joiningList.map((a) => a.id),
    incentive: r.decision && r.decision.decision === 'INCENTIVE' ? Number(r.decision.amount) || 0 : null,
    payMonth: r.decision ? r.decision.payMonth || null : null,
  }));
}

module.exports = {
  countedPlacements,
  DEFAULT_TARGET, PAYABLE, isMonth, thisMonth, prevMonth, nextMonth, monthLabel, todayIst, lastDay,
  guaranteeDays, targetOf, loadTargetRules, monthApplications, monthBoard, undatedJoinings, personHistory, personMonthDetail,
  ownFigure, targetFor, invalidate, toneOf, TONE_WORD,
};
