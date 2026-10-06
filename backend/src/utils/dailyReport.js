// ---------------------------------------------------------------------------
// RECRUITER DAILY REPORT (user spec 2026-10-03, C2) and "WHO HAS PENDING WORK"
// (ATS change list section 13). Reports → ATS → Daily report; Recruiter & BDE →
// Who has pending work.
//
// NO EXTRA TYPING, NO SECOND STORE. Every number is read from records the app
// already writes, attributed with the ONE "whose work is this" rule every ATS
// person filter uses (utils/workers.js attribute()):
//
//   Added           AuditLog "Candidate created …" by that login
//   Calls / Mails   CandidateMessage, trigger Manual (the Call / Mail /
//                   WhatsApp buttons and the Contact panel) by its sender.
//                   Bulk broadcasts and automatic stage mails are not counted.
//   Follow-ups      ApplicationFollowUp closed that day (completedAt) — by who
//                   closed it, else its owner, else the application's recruiter
//   Missed          a follow-up due that day (dueDate) not closed by the end of
//                   that day — counted once the day is over
//   Sent to TL      a step move INTO "TL Review"            ┐ by the person who
//   Sent to client  a step move INTO "Shared with client"   │ moved it; an
//   Interviews      a step move INTO "Interview scheduled"  │ imported move
//   Offers          a step move INTO "Offer"                │ (no person) goes
//   Reviewed        a step move OUT OF "Recruiter review"   ┘ to the recruiter
//   Feedback        InterviewFeedback submitted that day
//   Joined          an application at Joined whose joining date is that day
//   Pending         TODAY ONLY: the next actions this person owns now (the
//                   shared next-action helper, utils/teamWorkload.js). There
//                   is no end-of-day snapshot of the past, so a past day shows
//                   "—", never a guess.
//
// SCOPE IS THE SERVER'S. Applications come through utils/scope.js
// applicationWhere(); a message / audit row counts only when its person is
// somebody the viewer may see. A Recruiter (and a BDE / HR) sees only their
// own work whatever the URL asks; a TL their team; an STL / Manager their
// departments; Super Admin / Admin everything.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { applicationWhere, atsScopeOf, atsViewRole, scopeLabel } = require('./scope');
const V = require('./atsVocab');
const W = require('./workers');

const DAY_MS = 86400000;
const istDay = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + 330 * 60000).toISOString().slice(0, 10);
};
const todayIst = () => istDay(new Date());
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isTestPerson = (u) => !!u && /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''} ${u.label || ''}`);

// The metrics, in the order the month table shows them. `col` = a month-table
// column (the user's list: Date | Added | Calls | Mails | Follow-ups | Sent to
// TL | Sent to client | Interviews | Joined | Pending).
const METRICS = [
  { key: 'added', label: 'Added', col: true, hint: 'New candidate profiles created' },
  { key: 'calls', label: 'Calls', col: true, hint: 'Calls logged with the Call button or the Contact panel' },
  { key: 'mails', label: 'Mails', col: true, hint: 'Mails sent to one candidate (bulk mails not counted)' },
  { key: 'whatsapp', label: 'WhatsApp', col: false, hint: 'WhatsApp opened with the message ready' },
  { key: 'followUps', label: 'Follow-ups', col: true, hint: 'Follow-ups closed' },
  { key: 'missed', label: 'Missed follow-ups', col: false, hint: 'Follow-ups due that day and not done by the end of it' },
  { key: 'reviewed', label: 'Resumes checked', col: false, hint: 'Moved on from "Check by recruiter"' },
  { key: 'sentTl', label: 'Sent to TL', col: true, hint: 'Moved to "Check by team lead"' },
  { key: 'sentClient', label: 'Sent to client', col: true, hint: 'Moved to "Shared with client"' },
  { key: 'interviews', label: 'Interviews', col: true, hint: 'Interviews scheduled' },
  { key: 'attended', label: 'Interviews done', col: false, hint: 'Moved to "Interview completed"' },
  { key: 'feedback', label: 'Feedback recorded', col: false, hint: 'Interview feedback saved' },
  { key: 'offers', label: 'Offers', col: false, hint: 'Moved to "Offer"' },
  { key: 'joined', label: 'Joined', col: true, hint: 'Joined on that date' },
  { key: 'pending', label: 'Pending', col: true, hint: 'Next actions waiting on this person — known for today only' },
];
const METRIC_KEYS = METRICS.map((m) => m.key);
const COLUMN_KEYS = METRICS.filter((m) => m.col).map((m) => m.key);
const STEP_METRIC = {
  TL_REVIEW: 'sentTl', SHARED_WITH_CLIENT: 'sentClient', INTERVIEW_SCHEDULED: 'interviews', INTERVIEW_COMPLETED: 'attended', OFFER: 'offers',
};
const CHANNEL_METRIC = { Call: 'calls', Email: 'mails', WhatsApp: 'whatsapp' };
const WHAT = {
  added: 'Added a candidate',
  calls: 'Called',
  mails: 'Mailed',
  whatsapp: 'WhatsApp',
  followUps: 'Follow-up done',
  missed: 'Follow-up missed',
  reviewed: 'Checked the resume',
  sentTl: 'Sent to TL',
  sentClient: 'Sent to client',
  interviews: 'Interview scheduled',
  attended: 'Interview done',
  feedback: 'Feedback recorded',
  offers: 'Offer',
  joined: 'Joined',
};

// Monthly targets (HRMS → Targets, EmployeeRecord type TARGET, the same rows
// the recruiter dashboard reads) — matched to a metric by their unit / title.
const TARGET_RULES = [
  { key: 'sentClient', re: /submi|sent to client|shar|cv|profile/i },
  { key: 'joined', re: /join|placement|hire/i },
  { key: 'interviews', re: /interview/i },
  { key: 'calls', re: /call/i },
  { key: 'followUps', re: /follow/i },
  { key: 'added', re: /add|sourc|candidate/i },
];

const NOTES = {
  pending: 'Pending is known for today only — the app keeps no end-of-day snapshot, so past days show "—".',
  added: 'Added counts profiles created in the app. Imported sheets are not anyone\'s day of work, so they are not counted.',
  imported: 'Step moves that came in with imported sheets carry their real date and are counted for the recruiter the record belongs to (marked "imported").',
};

// ---------------------------------------------------------------------------
// THE WORLD — the viewer's applications with their attribution, kept for 30 s.
// ---------------------------------------------------------------------------
const WORLD = new Map();
const WORLD_TTL = 30000;

// Applications in `where`, read in chunks: a whole-scope nested read hits
// SQLite's parameter limit (P2029) — the same as utils/teamWorkload.js.
async function readChunked(where, select) {
  const slim = await prisma.application.findMany({ where, select: { id: true } });
  const ids = slim.map((a) => a.id);
  const out = [];
  const SIZE = 500;
  for (let i = 0; i < ids.length; i += SIZE * 4) {
    const batch = [];
    for (let j = i; j < Math.min(ids.length, i + SIZE * 4); j += SIZE) {
      batch.push(prisma.application.findMany({ where: { id: { in: ids.slice(j, j + SIZE) } }, select }));
    }
    // eslint-disable-next-line no-await-in-loop
    (await Promise.all(batch)).forEach((rows) => out.push(...rows));
  }
  return out;
}

async function buildWorld(user) {
  const dir = await W.loadDirectory();
  const reqSel = W.ATTR_SELECT.requirement.select;
  const apps = await readChunked({ AND: [applicationWhere(user), V.IN_ATS_WHERE] }, {
    ...W.ATTR_SELECT,
    joiningDate: true,
    joinedAt: true,
    candidate: { select: { name: true } },
    requirement: { select: { ...reqSel, title: true, internal: true, client: { select: { name: true } } } },
  });
  const byApp = new Map();
  const people = new Map(); // key -> { key, userId, label }
  const deptOfPerson = new Map(); // key -> Map(dept -> n)
  const tlOfPerson = new Map(); // recruiter key -> Map(tlKey -> n)
  const candIds = new Set();
  const addPerson = (p) => { if (p && p.key && !people.has(p.key)) people.set(p.key, { key: p.key, userId: p.userId || null, label: p.label }); };
  const bump = (map, k, v) => {
    if (!k || !v) return;
    if (!map.has(k)) map.set(k, new Map());
    const m = map.get(k);
    m.set(v, (m.get(v) || 0) + 1);
  };
  apps.forEach((a) => {
    const at = W.attribute(a.requirement, a.followUps, a.stageEvents, dir.person);
    const r = a.requirement || {};
    const info = {
      id: a.id,
      candidateId: a.candidateId,
      candidate: a.candidate ? a.candidate.name : null,
      job: r.title || null,
      client: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null,
      department: r.department || null,
      stage: a.stage,
      joiningDate: a.joiningDate,
      joinedAt: a.joinedAt,
      recruiter: at.recruiter,
      tl: at.tl,
    };
    byApp.set(a.id, info);
    candIds.add(a.candidateId);
    addPerson(at.recruiter);
    addPerson(at.tl);
    if (at.recruiter) {
      bump(deptOfPerson, at.recruiter.key, info.department);
      if (at.tl) bump(tlOfPerson, at.recruiter.key, at.tl.key);
    }
    if (at.tl) bump(deptOfPerson, at.tl.key, info.department);
  });
  // The logins the viewer may see as people (their own team, their
  // departments) even when none of their applications is attributed to them.
  const s = atsScopeOf(user);
  const extraIds = new Set([user.id, ...(s.teamUserIds || []), ...((s.positions && s.positions.holderUserIds) || [])]);
  const deptsOfViewer = [...new Set([...(s.departments || []), ...((s.positions && s.positions.departments) || [])])];
  dir.users.forEach((u) => {
    if (!['RECRUITER', 'TL', 'STL', 'BDE', 'HR'].includes(u.atsRole) && u.id !== user.id) return;
    const inDept = deptsOfViewer.length && u.atsDepartment && deptsOfViewer.includes(u.atsDepartment) && ['RECRUITER', 'BDE', 'TL'].includes(u.atsRole);
    if (s.global || extraIds.has(u.id) || (['mgmt', 'stl'].includes(atsViewRole(user)) && inDept)) addPerson(dir.person(u.id));
    if (u.atsDepartment) bump(deptOfPerson, `u:${u.id}`, u.atsDepartment);
  });
  // Never show test logins as people (agent rule 2026-09-29), unless the
  // viewer is one (the automated tests).
  if (!isTestPerson(user)) {
    [...people.values()].forEach((p) => {
      const u = p.userId ? dir.person.userById.get(p.userId) : null;
      if (isTestPerson(p) || (u && isTestPerson(u))) people.delete(p.key);
    });
  }
  // FORMER PEOPLE (user, 2026-10-05): somebody who has left HRMS keeps their
  // old work here and is marked former (a grey "Former" tag on the screen).
  const fk = await require('./formerPeople').formerKeys(); // eslint-disable-line global-require
  people.forEach((p) => { if (fk.has(p.key)) p.former = true; });
  const top = (m) => (m ? [...m.entries()].sort((x, y) => y[1] - x[1])[0][0] : null);
  const personDept = new Map([...deptOfPerson.entries()].map(([k, m]) => [k, top(m)]));
  const personTl = new Map([...tlOfPerson.entries()].map(([k, m]) => [k, top(m)]));
  return {
    dir, byApp, people, personDept, personTl, candIds, s, view: atsViewRole(user),
  };
}

async function worldFor(user, { fresh = false } = {}) {
  const hit = WORLD.get(user.id);
  if (!fresh && hit && Date.now() - hit.at < WORLD_TTL) return hit.promise;
  const promise = buildWorld(user);
  WORLD.set(user.id, { at: Date.now(), promise });
  while (WORLD.size > 30) WORLD.delete(WORLD.keys().next().value);
  promise.catch(() => WORLD.delete(user.id));
  return promise;
}

// Who may open the report at all, and whether they see only themselves.
const SELF_VIEWS = ['recruiter', 'bde', 'hr'];
function access(user) {
  const view = atsViewRole(user);
  if (['accounts', 'client', 'candidate', 'none'].includes(view)) {
    return { ok: false, error: 'The daily report is for the recruitment team.' };
  }
  return { ok: true, view, selfOnly: SELF_VIEWS.includes(view) };
}

// ---------------------------------------------------------------------------
// THE EVENTS of a date range [from, to] (IST days), each one { day, at, metric,
// person, app, imported, detail }. Already scope-checked.
// ---------------------------------------------------------------------------
async function eventsIn(user, world, from, to) {
  const gte = istStart(from);
  const lt = istStart(addDays(to, 1));
  const { dir, byApp, people } = world;
  const out = [];
  const seen = (p) => !!p && people.has(p.key);
  const push = (e) => { if (e.person && seen(e.person)) out.push(e); };
  const appRef = (info) => (info ? {
    applicationId: info.id, candidateId: info.candidateId, candidate: info.candidate, job: info.job, client: info.client, department: info.department,
  } : {});

  const [events, fusDone, fusDue, msgs, audits, feedback] = await Promise.all([
    prisma.applicationStageEvent.findMany({
      where: { createdAt: { gte, lt } },
      select: {
        applicationId: true, fromStage: true, toStage: true, actorUserId: true, actorName: true, createdAt: true,
      },
    }),
    prisma.applicationFollowUp.findMany({
      where: { completedAt: { gte, lt } },
      select: {
        applicationId: true, completedAt: true, completedById: true, ownerUserId: true, ownerName: true, purpose: true, nextAction: true, outcome: true, contactMode: true, completedNote: true,
      },
    }),
    prisma.applicationFollowUp.findMany({
      where: { dueDate: { gte: from, lte: to } },
      select: {
        applicationId: true, dueDate: true, completedAt: true, ownerUserId: true, ownerName: true, purpose: true, nextAction: true,
      },
    }),
    prisma.candidateMessage.findMany({
      where: { createdAt: { gte, lt }, trigger: 'Manual', channel: { in: Object.keys(CHANNEL_METRIC) } },
      select: {
        candidateId: true, applicationId: true, channel: true, createdAt: true, senderUserId: true, senderName: true, body: true, templateLabel: true, template: true, status: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte, lt }, action: { startsWith: 'Candidate created' }, userId: { not: null } },
      select: { userId: true, actorName: true, entityId: true, createdAt: true },
    }),
    prisma.interviewFeedback.findMany({
      where: { createdAt: { gte, lt }, kind: 'Internal' },
      select: { applicationId: true, submittedById: true, submittedBy: true, createdAt: true },
    }),
  ]);

  // Step moves.
  events.forEach((e) => {
    const info = byApp.get(e.applicationId);
    if (!info) return;
    const real = W.realActor(e);
    const person = real ? dir.person(e.actorUserId, e.actorName) : info.recruiter;
    const day = istDay(e.createdAt);
    const metric = STEP_METRIC[e.toStage];
    if (metric) {
      push({
        day, at: e.createdAt, metric, person, imported: !real, ...appRef(info),
      });
    }
    if (e.fromStage === 'RECRUITER_REVIEW' && e.toStage !== 'RECRUITER_REVIEW') {
      push({
        day, at: e.createdAt, metric: 'reviewed', person, imported: !real, detail: V.stageLabel(e.toStage), ...appRef(info),
      });
    }
  });
  // Follow-ups closed.
  fusDone.forEach((f) => {
    // Closed by the system (stale close, put on hold, reassigned) is not a follow-up somebody did.
    if (/^(Closed|Reassigned)/.test(String(f.completedNote || ''))) return;
    const info = byApp.get(f.applicationId);
    if (!info) return;
    let person = f.completedById ? dir.person(f.completedById) : null;
    if (!person && (f.ownerUserId || f.ownerName)) person = dir.person(f.ownerUserId, f.ownerName);
    if (!person) person = info.recruiter;
    push({
      day: istDay(f.completedAt), at: f.completedAt, metric: 'followUps', person, imported: !f.completedById, detail: [f.purpose || f.nextAction, f.outcome].filter(Boolean).join(' — ') || null, ...appRef(info),
    });
  });
  // Follow-ups missed (only once the day is over).
  const today = todayIst();
  fusDue.forEach((f) => {
    const due = String(f.dueDate || '').slice(0, 10);
    if (!due || due >= today) return;
    if (f.completedAt && istDay(f.completedAt) <= due) return;
    const info = byApp.get(f.applicationId);
    if (!info) return;
    const person = (f.ownerUserId || f.ownerName) ? dir.person(f.ownerUserId, f.ownerName) : info.recruiter;
    push({
      day: due, at: istStart(due), metric: 'missed', person, detail: f.purpose || f.nextAction || null, ...appRef(info),
    });
  });
  // Calls / mails / WhatsApp to one candidate.
  msgs.forEach((m) => {
    const person = dir.person(m.senderUserId, m.senderName);
    if (!person) return;
    const info = m.applicationId ? byApp.get(m.applicationId) : null;
    // Scope: the person must be visible AND (for a lead) the candidate one of theirs, or it was their own act.
    if (!world.s.global && !info && !world.candIds.has(m.candidateId) && person.userId !== user.id) return;
    const outcome = (m.channel === 'Call' || m.template === 'QUICK_LOG') ? String(m.body || '').split(' — ')[0] : null;
    push({
      day: istDay(m.createdAt),
      at: m.createdAt,
      metric: CHANNEL_METRIC[m.channel],
      person,
      detail: [m.templateLabel, outcome, m.channel === 'Email' ? ({ SENT: 'Sent', FAILED: 'Failed', QUEUED: 'Sending', RETRY: 'Sending' }[m.status] || null) : null].filter(Boolean).join(' — ') || null,
      ...(info ? appRef(info) : { candidateId: m.candidateId }),
    });
  });
  // New profiles.
  audits.forEach((a) => {
    const person = dir.person(a.userId, a.actorName);
    push({
      day: istDay(a.createdAt), at: a.createdAt, metric: 'added', person, candidateId: a.entityId,
    });
  });
  // Interview feedback.
  feedback.forEach((f) => {
    const info = byApp.get(f.applicationId);
    if (!info) return;
    const person = (f.submittedById || f.submittedBy) ? dir.person(f.submittedById, f.submittedBy) : info.recruiter;
    push({
      day: istDay(f.createdAt), at: f.createdAt, metric: 'feedback', person, ...appRef(info),
    });
  });
  // Joined (by joining date).
  byApp.forEach((info) => {
    if (!['JOINED', 'HIRED'].includes(info.stage)) return;
    const d = /^\d{4}-\d{2}-\d{2}/.test(String(info.joiningDate || '')) ? String(info.joiningDate).slice(0, 10) : istDay(info.joinedAt);
    if (!d || d < from || d > to) return;
    push({
      day: d, at: istStart(d), metric: 'joined', person: info.recruiter, ...appRef(info),
    });
  });

  // Candidate names for rows that only carry the id.
  const missing = [...new Set(out.filter((e) => e.candidateId && !e.candidate).map((e) => e.candidateId))];
  if (missing.length) {
    const cs = await prisma.candidate.findMany({ where: { id: { in: missing.slice(0, 5000) } }, select: { id: true, name: true } });
    const nm = new Map(cs.map((c) => [c.id, c.name]));
    out.forEach((e) => { if (e.candidateId && !e.candidate) e.candidate = nm.get(e.candidateId) || null; });
  }
  return out;
}

// Pending next actions owned by each person NOW (today's Pending / Late).
async function pendingNow(user) {
  // eslint-disable-next-line global-require
  const TW = require('./teamWorkload');
  const { rows, helperReady } = await TW.pendingActionRows(user);
  const byOwner = new Map();
  rows.forEach((r) => {
    const k = r.ownerUserId ? `u:${r.ownerUserId}` : (r.owner ? `n:${W.nameKey(r.owner)}` : null);
    if (!k) return;
    const c = byOwner.get(k) || { pending: 0, late: 0, today: 0 };
    c.pending += 1;
    if (r.dueStatus === 'overdue') c.late += 1;
    if (r.dueStatus === 'today') c.today += 1;
    byOwner.set(k, c);
  });
  return { byOwner, helperReady };
}

// ---------------------------------------------------------------------------
// FILTERS: Department -> Team (a TL's key) -> Person (u:/n: key). They CASCADE
// (agent rules, FILTER RULE): each one's options are counted over the work of
// the period with every OTHER chosen filter applied, the count is the number
// of work items, and an option with nothing behind it is not offered (the
// chosen value always stays, so it can be seen and removed).
// ---------------------------------------------------------------------------
function normQ(q) {
  return {
    department: String(q.department || '').trim(),
    team: String(q.team || '').trim(),
    person: String(q.person || q.recruiter || '').trim().replace(/^id:/, 'u:').replace(/^name:/, 'n:'),
    // people=active | former — the Active / Former filter ('' = everyone).
    people: ['active', 'former'].includes(String(q.people || '').trim()) ? String(q.people).trim() : '',
  };
}
function personMatches(world, k, f, omit = null) {
  if (omit !== 'department' && f.department && world.personDept.get(k) !== f.department) return false;
  if (omit !== 'team' && f.team && !(k === f.team || world.personTl.get(k) === f.team)) return false;
  if (omit !== 'person' && f.person && !(k === f.person || (f.person.startsWith('n:') && k === `n:${W.nameKey(f.person.slice(2))}`))) return false;
  if (omit !== 'people' && f.people) {
    const gone = !!(world.people.get(k) || {}).former;
    if (f.people === 'former' ? !gone : gone) return false;
  }
  return true;
}
function filterPeople(world, user, q, acc) {
  if (acc.selfOnly) return new Set([`u:${user.id}`]);
  const f = normQ(q);
  return new Set([...world.people.keys()].filter((k) => personMatches(world, k, f)));
}

function isLeadKey(world, k) {
  const u = k.startsWith('u:') ? world.dir.person.userById.get(k.slice(2)) : null;
  return !!u && ['TL', 'STL'].includes(u.atsRole);
}
const teamOf = (world, k) => world.personTl.get(k) || (isLeadKey(world, k) ? k : null);

// workByPerson: Map(personKey -> number of work items in the period).
function options(world, user, acc, q = {}, workByPerson = new Map()) {
  if (acc.selfOnly) return { selfOnly: true, people: [], teams: [], departments: [] };
  const f = normQ(q);
  const label = (k) => { const p = world.people.get(k) || {}; return p.former ? `${p.label || k} · Former` : (p.label || k); };
  const count = (omit, keyOf) => {
    const m = new Map();
    workByPerson.forEach((n, k) => {
      if (!n || !world.people.has(k) || !personMatches(world, k, f, omit)) return;
      const v = keyOf(k);
      if (v) m.set(v, (m.get(v) || 0) + n);
    });
    return m;
  };
  const finish = (m, labelOf, chosen) => {
    const list = [...m.entries()].filter(([, n]) => n > 0).map(([v, n]) => ({ value: v, label: labelOf(v), count: n }));
    list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    if (chosen && !list.some((o) => o.value === chosen)) list.unshift({ value: chosen, label: labelOf(chosen), count: 0 });
    return list;
  };
  return {
    selfOnly: false,
    departments: finish(count('department', (k) => world.personDept.get(k) || null), (v) => v, f.department),
    teams: finish(count('team', (k) => teamOf(world, k)), (v) => `${label(v)}'s team`, f.team),
    people: finish(count('person', (k) => k), label, f.person),
    status: finish(count('people', (k) => ((world.people.get(k) || {}).former ? 'former' : 'active')), (v) => (v === 'former' ? 'Former (have left)' : 'Still working here'), f.people),
  };
}

const workCounts = (events) => {
  const m = new Map();
  events.forEach((e) => m.set(e.person.key, (m.get(e.person.key) || 0) + 1));
  return m;
};

const blank = () => Object.fromEntries(METRIC_KEYS.map((k) => [k, 0]));

async function targetsFor(world, keys, month) {
  const empIds = [];
  keys.forEach((k) => {
    if (!k.startsWith('u:')) return;
    const e = world.dir.empByUser.get(k.slice(2));
    if (e) empIds.push(e.id);
  });
  if (!empIds.length) return {};
  const rows = await prisma.employeeRecord.findMany({
    where: { type: 'TARGET', employeeId: { in: empIds }, date: { startsWith: month } },
    select: { title: true, unit: true, amount: true },
  });
  const out = {};
  rows.forEach((r) => {
    const text = `${r.unit || ''} ${r.title || ''}`;
    const rule = TARGET_RULES.find((t) => t.re.test(text));
    if (!rule || !(Number(r.amount) > 0)) return;
    out[rule.key] = (out[rule.key] || 0) + Number(r.amount);
  });
  return out;
}

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '')) ? month : todayIst().slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { month: m, from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` };
}

function describeScope(user, acc, q, world) {
  if (acc.selfOnly) return 'Your own work';
  const parts = [];
  if (q.person || q.recruiter) parts.push((world.people.get(String(q.person || q.recruiter).replace(/^id:/, 'u:')) || {}).label || 'One person');
  if (q.team) parts.push(`${((world.people.get(q.team) || {}).label) || 'A'}'s team`);
  if (q.department) parts.push(q.department);
  return parts.length ? parts.join(' · ') : `Your area — ${scopeLabel(user, 'ats')}`;
}

// ---------------------------------------------------------------------------
// MONTH VIEW — one row per day + one row per person, with targets.
// ---------------------------------------------------------------------------
async function monthReport(user, q = {}) {
  const acc = access(user);
  if (!acc.ok) return { status: 403, body: { error: acc.error } };
  const world = await worldFor(user, { fresh: q.fresh === '1' });
  const { month, from, to } = monthBounds(q.month);
  const keys = filterPeople(world, user, q, acc);
  const today = todayIst();
  const lastDay = to < today ? to : today;
  const allEvents = from > today ? [] : await eventsIn(user, world, from, lastDay);
  const work = workCounts(allEvents);
  const events = allEvents.filter((e) => keys.has(e.person.key));
  const pend = (today >= from && today <= to) ? await pendingNow(user) : null;

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ date: d, future: d > today, ...blank(), pending: null });
  const dayIdx = new Map(days.map((d, i) => [d.date, i]));
  const byPerson = new Map();
  events.forEach((e) => {
    const i = dayIdx.get(e.day);
    if (i !== undefined) days[i][e.metric] += 1;
    if (!byPerson.has(e.person.key)) byPerson.set(e.person.key, { key: e.person.key, label: e.person.label, former: !!(world.people.get(e.person.key) || {}).former, ...blank(), pending: null, late: null });
    byPerson.get(e.person.key)[e.metric] += 1;
  });
  if (pend) {
    let p = 0;
    keys.forEach((k) => {
      const c = pend.byOwner.get(k);
      if (!c) return;
      p += c.pending;
      if (!byPerson.has(k)) byPerson.set(k, { key: k, label: (world.people.get(k) || {}).label || k, former: !!(world.people.get(k) || {}).former, ...blank(), pending: null, late: null });
      byPerson.get(k).pending = c.pending;
      byPerson.get(k).late = c.late;
    });
    const i = dayIdx.get(today);
    if (i !== undefined) days[i].pending = p;
  }
  days.forEach((d) => { if (d.future) METRIC_KEYS.forEach((k) => { d[k] = null; }); });
  const totals = blank();
  events.forEach((e) => { totals[e.metric] += 1; });
  totals.pending = pend ? days[dayIdx.get(today)].pending : null;

  const tgt = await targetsFor(world, keys, month);
  const targets = Object.entries(tgt).map(([key, target]) => ({
    key, label: (METRICS.find((m) => m.key === key) || {}).label || key, target, done: totals[key] || 0,
  }));
  const people = [...byPerson.values()].sort((a, b) => a.label.localeCompare(b.label));
  return {
    status: 200,
    body: {
      view: 'month',
      month,
      from,
      to,
      today,
      scope: describeScope(user, acc, q, world),
      selfOnly: acc.selfOnly,
      metrics: METRICS,
      columns: COLUMN_KEYS,
      days,
      totals,
      people,
      targets,
      targetNote: targets.length ? null : 'No monthly target is set for this month. HR sets targets under HRMS → Targets (e.g. "20 submissions").',
      importedCount: events.filter((e) => e.imported).length,
      notes: NOTES,
      options: options(world, user, acc, q, work),
    },
  };
}

// ---------------------------------------------------------------------------
// DAY VIEW — the actual work of one day: who did what, for whom.
// ---------------------------------------------------------------------------
async function dayReport(user, q = {}) {
  const acc = access(user);
  if (!acc.ok) return { status: 403, body: { error: acc.error } };
  const world = await worldFor(user, { fresh: q.fresh === '1' });
  const today = todayIst();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(q.day || '')) ? q.day : today;
  const keys = filterPeople(world, user, q, acc);
  const allEvents = day > today ? [] : await eventsIn(user, world, day, day);
  const work = workCounts(allEvents);
  const events = allEvents.filter((e) => keys.has(e.person.key));
  const pend = day === today ? await pendingNow(user) : null;
  const totals = blank();
  const byPerson = new Map();
  events.forEach((e) => {
    totals[e.metric] += 1;
    if (!byPerson.has(e.person.key)) byPerson.set(e.person.key, { key: e.person.key, label: e.person.label, former: !!(world.people.get(e.person.key) || {}).former, ...blank(), pending: null, late: null });
    byPerson.get(e.person.key)[e.metric] += 1;
  });
  totals.pending = null;
  if (pend) {
    totals.pending = 0;
    keys.forEach((k) => {
      const c = pend.byOwner.get(k);
      if (!c) return;
      totals.pending += c.pending;
      if (!byPerson.has(k)) byPerson.set(k, { key: k, label: (world.people.get(k) || {}).label || k, former: !!(world.people.get(k) || {}).former, ...blank(), pending: null, late: null });
      byPerson.get(k).pending = c.pending;
      byPerson.get(k).late = c.late;
    });
  }
  const rows = events
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 2000)
    .map((e) => ({
      at: e.at,
      person: e.person.label,
      personKey: e.person.key,
      metric: e.metric,
      what: WHAT[e.metric] || e.metric,
      detail: e.detail || null,
      candidate: e.candidate || null,
      candidateId: e.candidateId || null,
      job: e.job || null,
      client: e.client || null,
      imported: !!e.imported,
      timeKnown: !['missed', 'joined'].includes(e.metric) && !e.imported,
    }));
  return {
    status: 200,
    body: {
      view: 'day',
      day,
      today,
      scope: describeScope(user, acc, q, world),
      selfOnly: acc.selfOnly,
      metrics: METRICS,
      totals,
      people: [...byPerson.values()].sort((a, b) => a.label.localeCompare(b.label)),
      rows,
      total: events.length,
      notes: NOTES,
      options: options(world, user, acc, q, work),
    },
  };
}

// ---------------------------------------------------------------------------
// WHO HAS PENDING WORK — Person | Pending | Late | Follow-ups late | Steps moved
// (today). For TL / STL / Manager / Admin, their area.
// ---------------------------------------------------------------------------
const LEAD_VIEWS = ['admin', 'mgmt', 'stl', 'tl'];
async function pendingWork(user, q = {}) {
  const view = atsViewRole(user);
  if (!LEAD_VIEWS.includes(view)) return { status: 403, body: { error: 'This table is for team leads, managers and admins.' } };
  const world = await worldFor(user, { fresh: q.fresh === '1' });
  const today = todayIst();
  const [pend, fus, moved] = await Promise.all([
    pendingNow(user),
    prisma.applicationFollowUp.findMany({
      where: { completedAt: null, dueDate: { lt: today } },
      select: { applicationId: true, ownerUserId: true, ownerName: true },
    }),
    prisma.applicationStageEvent.findMany({
      where: { createdAt: { gte: istStart(today) } },
      select: { applicationId: true, actorUserId: true, actorName: true },
    }),
  ]);
  const rows = new Map();
  const row = (k) => {
    if (!rows.has(k)) {
      const p = world.people.get(k);
      rows.set(k, {
        key: k, userId: p && p.userId, name: (p && p.label) || k, department: world.personDept.get(k) || null, team: teamOf(world, k), teamName: teamOf(world, k) ? `${(world.people.get(teamOf(world, k)) || {}).label || 'TL'}'s team` : null, pending: 0, late: 0, dueToday: 0, followUpsLate: 0, stepsMoved: 0,
      });
    }
    return rows.get(k);
  };
  pend.byOwner.forEach((c, k) => {
    if (!world.people.has(k)) return;
    const r = row(k);
    r.pending += c.pending;
    r.late += c.late;
    r.dueToday += c.today;
  });
  fus.forEach((f) => {
    const info = world.byApp.get(f.applicationId);
    if (!info) return;
    const p = (f.ownerUserId || f.ownerName) ? world.dir.person(f.ownerUserId, f.ownerName) : info.recruiter;
    if (!p || !world.people.has(p.key)) return;
    row(p.key).followUpsLate += 1;
  });
  moved.forEach((e) => {
    if (!world.byApp.has(e.applicationId) || !W.realActor(e)) return;
    const p = world.dir.person(e.actorUserId, e.actorName);
    if (!p || !world.people.has(p.key)) return;
    row(p.key).stepsMoved += 1;
  });
  // Everyone in the area appears, also with nothing pending — a lead must see
  // the quiet ones as well (current logins only).
  world.people.forEach((p, k) => { if (p.userId) row(k); });
  let list = [...rows.values()];
  if (q.department) list = list.filter((r) => r.department === q.department);
  list.sort((a, b) => (b.late - a.late) || (b.followUpsLate - a.followUpsLate) || (b.pending - a.pending) || a.name.localeCompare(b.name));
  return {
    status: 200,
    body: {
      today,
      rows: list,
      helperReady: pend.helperReady,
      departments: [...new Set(list.map((r) => r.department).filter(Boolean))].sort(),
      note: 'Pending = next actions waiting on this person now. Late = past their due date. Follow-ups late = follow-ups past their due date and not done. Steps moved = candidates this person moved to another step today.',
    },
  };
}

function forget(user) { if (user) WORLD.delete(user.id); else WORLD.clear(); }

module.exports = {
  METRICS, COLUMN_KEYS, WHAT, access, monthReport, dayReport, pendingWork, forget, todayIst, addDays,
};
