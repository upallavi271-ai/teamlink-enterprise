// ---------------------------------------------------------------------------
// WHAT A RECRUITER MISSED -> THE RECRUITER THEMSELVES AND THEIR TEAM LEAD (user, 2026-10-12: "Vallu emina todos
// leka follow-ups miss ayithe, reminder msg Recruiter ki, TL ki kuda vellali.").
//
// THE SIX THINGS (live data, nothing is stored about them; they clear by themselves when done):
//   followup   an open follow-up past its due day (not older than Step timing's "stale" days: the imported backlog is left alone)
//   call       a follow-up due TODAY that nobody called about (only after the end-of-day time; the end-of-day report's own rule)
//   task       a Task / personal to-do past its end date (a task the team lead gave in the Timesheet, or the person's own)
//   check      a candidate waiting for the recruiter's own check, past its date  ("Check by recruiter")
//   feedback   an interview that happened and has no feedback recorded, past its date
//   step       any other next step that is the recruiter's own and past its date (utils/nextAction.js dueStatus overdue)
// A step whose candidate already has an overdue follow-up of the same person is counted once, as the follow-up.
//
// WHO IS TOLD (utils/chainAlerts.js carries it, the same run, the same de-dupe):
//   level 0  the recruiter:  "You missed 4 things yesterday: 3 follow-ups, 1 task. Open your list."
//   level 1  their team lead, the same items, grouped by recruiter; then the STL, the Manager, the Admin by the chain's hours
// The recruiter's own screen box "My missed items" (GET /api/pending-work/my-missed) lists the same items with an Open button.
//
// This file is the one definition: the chain, the box and the dry-run all read it. Plain words, no candidate phone / e-mail /
// pay in any message.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const PW = require('./pendingWork');
const AS = require('./atsAlertSettings');

const DAY_MS = 86400000;
const OPEN_TASK = ['Not Started', 'In Progress', 'On Hold'];
const CLOSED_STAGES = ['REJECTED', 'JOINED', 'HIRED'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WORK_KEY = /^(followup|task|step|call)\|/; // chain item keys that are a recruiter's own work (client follow-ups are "clientfu|")
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dmy = (day) => { const d = new Date(`${day}T00:00:00Z`); return `${d.getUTCDate()} ${MON3[d.getUTCMonth()]}`; };

// The kinds, in the order they are listed.
const KINDS = [
  { id: 'followup', one: 'follow-up', many: 'follow-ups', head: 'Follow-ups not done' },
  { id: 'call', one: 'call not made', many: 'calls not made', head: 'Calls not made (due today)' },
  { id: 'task', one: 'task', many: 'tasks', head: 'Tasks and to-dos' },
  { id: 'check', one: 'candidate waiting for your check', many: 'candidates waiting for your check', head: 'Candidates waiting for your check' },
  { id: 'feedback', one: 'interview feedback not recorded', many: 'interview feedbacks not recorded', head: 'Interview feedback not recorded' },
  { id: 'step', one: 'late step', many: 'late steps', head: 'Late steps' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const phrase = (items) => KINDS.map((k) => [k, items.filter((i) => i.kind === k.id).length]).filter(([, n]) => n).map(([k, n]) => plural(n, k.one, k.many)).join(', ');

// ---------------------------------------------------------------------------
// "YESTERDAY" — the last working day before today (a Monday morning looks back to Saturday).
// ---------------------------------------------------------------------------
async function windowOf(today) {
  let from = addDays(today, -1);
  for (let i = 0; i < 8 && await PW.offDayReason(from); i += 1) from = addDays(from, -1);
  const yesterday = addDays(today, -1);
  return { from, today, label: from === yesterday ? 'yesterday' : `since ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${from}T00:00:00Z`).getUTCDay()]} ${dmy(from)}` };
}

// ---------------------------------------------------------------------------
// ITEMS
// ---------------------------------------------------------------------------
const ymdOf = (v) => String(v || '').slice(0, 10);
function daysLateOf(due, today) { return Math.max(1, PW.daysBetween(due, today)); }

function followUpItem(f, today, ownerName) {
  const due = ymdOf(f.dueDate);
  const cand = f.application && f.application.candidate ? f.application.candidate.name : 'candidate';
  const job = f.application && f.application.requirement ? f.application.requirement.title : '';
  const late = daysLateOf(due, today);
  return {
    key: `followup|${f.id}`, kind: 'followup', ownerId: f.ownerUserId, ownerName: ownerName || f.ownerName || null,
    title: `${f.purpose || f.nextAction || 'Follow-up'} - ${cand}`,
    detail: `Follow-up: ${f.purpose || f.nextAction || 'Follow-up'} - ${cand}${job ? `, ${job}` : ''}; ${plural(late, 'day', 'days')} late`,
    sub: job || null, dueDay: due, daysLate: late, applicationId: f.applicationId, link: '/ats/team?view=followups', dept: f.application && f.application.requirement ? f.application.requirement.department : null,
  };
}
function taskItem(t, today) {
  const due = ymdOf(t.endDate);
  const late = daysLateOf(due, today);
  const own = t.assignedById === t.assigneeId;
  return {
    key: `task|${t.id}`, kind: 'task', ownerId: t.assigneeId, ownerName: t.assigneeName,
    title: t.name, detail: `Task: ${t.name} (${own ? 'your own to-do' : `from ${t.assignedByName || 'your team lead'}`}, was due ${dmy(due)}); ${plural(late, 'day', 'days')} late`,
    sub: own ? 'Your own to-do' : `From ${t.assignedByName || 'your team lead'}`, dueDay: due, daysLate: late, taskId: t.id, link: '/employee-services?tab=timesheet', dept: t.department || null,
  };
}
function stepItem(i, ownerId, ownerName, today) {
  const kind = i.type === 'review' ? 'check' : i.type === 'feedback' ? 'feedback' : 'step';
  const due = ymdOf(i.dueAt);
  return {
    key: `step|${i.applicationId}|${due}`, kind, ownerId, ownerName,
    title: `${i.candidate} - ${i.job}`,
    detail: `${kind === 'check' ? 'Check' : kind === 'feedback' ? 'Interview feedback' : 'Next step'}: ${i.candidate} - ${i.job}${i.client && i.client !== '—' ? ` (${i.client})` : ''}: ${i.step}; ${plural(i.daysLate || 1, 'day', 'days')} late`,
    sub: i.step, dueDay: due, daysLate: i.daysLate || 1, applicationId: i.applicationId, link: '/ats/team?view=pending', dept: null,
  };
}
function callItem(f, today, ownerName) {
  const cand = f.application && f.application.candidate ? f.application.candidate.name : 'candidate';
  const job = f.application && f.application.requirement ? f.application.requirement.title : '';
  return {
    key: `call|${f.id}|${today}`, kind: 'call', ownerId: f.ownerUserId, ownerName: ownerName || f.ownerName || null,
    title: `Call ${cand}`, detail: `Call not made: ${cand}${job ? `, ${job}` : ''} (follow-up was due today)`,
    sub: job || null, dueDay: today, daysLate: 0, applicationId: f.applicationId, link: '/ats/team?view=followups', dept: f.application && f.application.requirement ? f.application.requirement.department : null,
  };
}

// The steps that are a missed thing of THIS recruiter, from their block of the pending-work numbers (late only).
function stepsOf(block, ownerId, ownerName, today, coveredByFollowUp = new Set()) {
  return (block.items || [])
    .filter((i) => i.status === 'late' && (PW.isOwnStep(i, ownerId) || i.type === 'feedback'))
    .filter((i) => i.type === 'feedback' || !coveredByFollowUp.has(i.applicationId))
    .map((i) => stepItem(i, ownerId, ownerName, today));
}

// ---------------------------------------------------------------------------
// BULK (the chain's run, the dry run): every recruiter the pending-work directory knows, with the team lead each one reaches.
// Cached 15 minutes unless `fresh` or `people` is given (tests).
// ---------------------------------------------------------------------------
let CACHE = { at: 0, value: null };
async function world({ viewer = null, people = null, fresh = false } = {}) {
  if (!people && !fresh && CACHE.value && Date.now() - CACHE.at < 15 * 60000) return CACHE.value;
  const vw = await PW.pickViewer(viewer);
  if (!vw) return { rec: new Map(), today: PW.dayOfIst(new Date()) };
  const c = await PW.collectTeams({ viewer: vw, people, fresh });
  const rec = new Map();
  c.teams.forEach((team, tlId) => team.blocks.forEach((b) => rec.set(b.userId, { block: b, tlId, name: b.name, department: b.department || team.tl.department })));
  c.unrouted.forEach((u) => rec.set(u.block.userId, { block: u.block, tlId: null, name: u.block.name, department: u.department || u.block.department }));
  const value = { rec, today: c.today };
  if (!people) CACHE = { at: Date.now(), value };
  return value;
}
function forget() { CACHE = { at: 0, value: null }; }

// Tasks, follow-up cover and (in the evening) calls for the recruiters in `rec`; returns work items (steps, tasks, calls).
async function collectBulk({
  rec, today, settings, evening = false, now = new Date(),
}) {
  const ids = [...rec.keys()];
  if (!ids.length) return [];
  const out = [];
  const stale = AS.alertSettingsNow().staleAfterDays || 30;
  const from = addDays(today, -stale);
  const covered = new Set(); // `${owner}|${app}` that already have an overdue open follow-up
  const fus = await prisma.applicationFollowUp.findMany({
    where: { completedAt: null, ownerUserId: { in: ids }, dueDate: { lt: today, gte: from }, application: { stage: { notIn: CLOSED_STAGES } } },
    select: { ownerUserId: true, applicationId: true },
  });
  fus.forEach((f) => covered.add(`${f.ownerUserId}|${f.applicationId}`));
  if (settings.chain.steps) {
    rec.forEach((r, id) => {
      const cov = new Set(fus.filter((f) => f.ownerUserId === id).map((f) => f.applicationId));
      out.push(...stepsOf(r.block, id, r.name, today, cov));
    });
  }
  if (settings.chain.tasks) {
    const tasks = await prisma.task.findMany({ where: { assigneeId: { in: ids }, status: { in: OPEN_TASK }, endDate: { not: null, lt: today } } });
    tasks.forEach((t) => out.push(taskItem(t, today)));
  }
  if (settings.chain.steps && evening) {
    const due = await prisma.applicationFollowUp.findMany({
      where: { completedAt: null, ownerUserId: { in: ids }, dueDate: today, application: { stage: { notIn: CLOSED_STAGES } } },
      select: { id: true, ownerUserId: true, ownerName: true, candidateId: true, applicationId: true, dueDate: true, purpose: true, nextAction: true, application: { select: { candidate: { select: { name: true } }, requirement: { select: { title: true, department: true } } } } },
    });
    const calls = await prisma.candidateMessage.findMany({ where: { channel: 'Call', senderUserId: { in: ids }, createdAt: { gte: istStart(today) } }, select: { senderUserId: true, candidateId: true } });
    const called = new Set(calls.map((m) => `${m.senderUserId}|${m.candidateId}`));
    due.forEach((f) => { if (!called.has(`${f.ownerUserId}|${f.candidateId}`)) out.push(callItem(f, today, (rec.get(f.ownerUserId) || {}).name)); });
  }
  void now;
  return out;
}

// ---------------------------------------------------------------------------
// ONE PERSON (the "My missed items" box): the same items from the person's own rows.
// ---------------------------------------------------------------------------
async function forPerson(user, { now = new Date(), settings = null, fresh = false } = {}) {
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const st = settings || await PW.getSettings();
  const today = PW.dayOfIst(now);
  const stale = AS.alertSettingsNow().staleAfterDays || 30;
  const from = addDays(today, -stale);
  const items = [];
  const fus = await prisma.applicationFollowUp.findMany({
    where: { completedAt: null, ownerUserId: user.id, dueDate: { lt: today, gte: from }, application: { stage: { notIn: CLOSED_STAGES } } },
    select: { id: true, ownerUserId: true, ownerName: true, applicationId: true, dueDate: true, purpose: true, nextAction: true, application: { select: { candidate: { select: { name: true } }, requirement: { select: { title: true, department: true } } } } },
    orderBy: { dueDate: 'asc' },
    take: 200,
  });
  fus.forEach((f) => items.push(followUpItem(f, today, user.name)));
  const cov = new Set(fus.map((f) => f.applicationId));
  const tasks = await prisma.task.findMany({ where: { assigneeId: user.id, status: { in: OPEN_TASK }, endDate: { not: null, lt: today } }, orderBy: { endDate: 'asc' }, take: 200 });
  tasks.forEach((t) => items.push(taskItem(t, today)));
  try {
    const load = await AH.pendingLoad(user, { by: 'recruiter', fresh });
    const g = load.people.find((e) => e.userId === user.id);
    if (g) {
      const block = { items: g.pending.map((x) => PW.itemOf(x, load.today)) };
      items.push(...stepsOf(block, user.id, user.name, today, cov));
    }
  } catch { /* the pending-work numbers could not be read now: the rest still shows */ }
  if (PW.hhmmOfIst(now) >= st.eod.time) {
    const due = await prisma.applicationFollowUp.findMany({
      where: { completedAt: null, ownerUserId: user.id, dueDate: today, application: { stage: { notIn: CLOSED_STAGES } } },
      select: { id: true, ownerUserId: true, ownerName: true, candidateId: true, applicationId: true, dueDate: true, purpose: true, nextAction: true, application: { select: { candidate: { select: { name: true } }, requirement: { select: { title: true, department: true } } } } },
    });
    const calls = await prisma.candidateMessage.findMany({ where: { channel: 'Call', senderUserId: user.id, createdAt: { gte: istStart(today) } }, select: { candidateId: true } });
    const called = new Set(calls.map((m) => m.candidateId));
    due.forEach((f) => { if (!called.has(f.candidateId)) items.push(callItem(f, today, user.name)); });
  }
  return shape(items, today);
}

const ORDER = Object.fromEntries(KINDS.map((k, i) => [k.id, i]));
async function shape(items, today) {
  const win = await windowOf(today);
  items.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || (b.daysLate - a.daysLate) || String(a.title).localeCompare(String(b.title)));
  const fresh = items.filter((i) => i.dueDay >= win.from);
  const groups = KINDS.map((k) => ({ kind: k.id, label: k.head, n: items.filter((i) => i.kind === k.id).length, items: items.filter((i) => i.kind === k.id) })).filter((g) => g.n);
  return {
    today, total: items.length, newCount: fresh.length, olderCount: items.length - fresh.length, since: win.label,
    summary: items.length ? selfSummary(items, win) : 'Nothing missed. You are on time.',
    groups,
  };
}

// ---------------------------------------------------------------------------
// THE WORDS
// ---------------------------------------------------------------------------
// To the person themselves.
function selfSummary(items, win) {
  const calls = items.filter((i) => i.kind === 'call');
  const rest = items.filter((i) => i.kind !== 'call');
  const fresh = rest.filter((i) => i.dueDay >= win.from);
  const older = rest.filter((i) => i.dueDay < win.from);
  const parts = [];
  if (fresh.length) parts.push(`You missed ${plural(fresh.length, 'thing', 'things')} ${win.label}: ${phrase(fresh)}.`);
  if (older.length) parts.push(fresh.length ? `Still waiting from before: ${phrase(older)}.` : `${plural(older.length, 'thing is', 'things are')} still waiting from before: ${phrase(older)}.`);
  if (calls.length) parts.push(`Today ${calls.length === 1 ? 'one call due was' : `${calls.length} calls due were`} not made: ${calls.slice(0, 3).map((c) => c.title.replace(/^Call /, '')).join(', ')}${calls.length > 3 ? ' and more' : ''}.`);
  parts.push('Open your list.');
  return parts.join(' ');
}
// To the team lead: who missed what.
function teamSummary(items, win) {
  const by = new Map();
  items.forEach((i) => { const e = by.get(i.ownerId) || { name: i.ownerName || 'Someone', items: [] }; e.items.push(i); by.set(i.ownerId, e); });
  const fresh = items.filter((i) => i.kind !== 'call' && i.dueDay >= win.from);
  const head = fresh.length
    ? `Your team missed ${plural(fresh.length, 'thing', 'things')} ${win.label}.`
    : `${plural(items.length, 'thing is', 'things are')} waiting on your team.`;
  const who = [...by.values()].sort((a, b) => b.items.length - a.items.length)
    .map((e) => `${e.name}: ${phrase(e.items)}`);
  return { head, who };
}

module.exports = {
  KINDS, KIND, WORK_KEY, OPEN_TASK, plural, phrase, windowOf, world, forget, collectBulk, forPerson, followUpItem, taskItem, stepItem, callItem, stepsOf, selfSummary, teamSummary, shape, addDays, dmy,
};
