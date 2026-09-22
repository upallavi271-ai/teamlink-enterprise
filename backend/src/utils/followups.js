// ---------------------------------------------------------------------------
// THE FOLLOW-UP RECORD.
//
// A follow-up belongs to an APPLICATION, never to a candidate. One candidate
// with three live applications owes three separate follow-ups, because who is
// chasing, what they are chasing and when it is due are all properties of the
// application. Nothing in this file writes to the Candidate table.
//
// The nine columns the brief names:
//   Owner · Owner Role · TL · BDE · Last Contacted · Next Action · Due Date ·
//   Next Follow-up · Status
// Owner / Owner Role / TL / BDE are SNAPSHOTTED onto the row when it is
// written, so a reassignment later cannot rewrite who owed the call. The
// other five are the follow-up's own data.
//
// STATUS IS DERIVED. Upcoming / Due Today / Overdue is dueDate compared with
// today, computed here on every read; Completed is the one stored state,
// because completing is something a person did. A stored status column would
// be wrong every midnight.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { notifyUsers } = require('./notify');
const { STAGE_OWNER_ACTION, stageLabel } = require('./atsVocab');

const FOLLOWUP_STATUSES = ['Upcoming', 'Due Today', 'Overdue', 'Completed'];
const CONTACT_MODES = ['Call', 'Email', 'WhatsApp', 'SMS', 'In Person', 'Video Call'];

// §4 — how the call itself went. Asked only for a Call.
const CALL_RESULTS = ['Answered', 'Not Answered', 'Busy', 'Switched Off', 'Wrong Number'];

// §8 — "What happened?" A RECORDED CHOICE rather than a sentence somebody may
// or may not have typed, so the next person can read the history at a glance.
// The list is filtered by CONTEXT on the way out: a client follow-up is not
// offered "Joining Confirmed".
const FOLLOWUP_OUTCOMES = [
  'Answered', 'Interested', 'Not Interested', 'Requested Later', 'No Response',
  'Call Back', 'Interview Confirmed', 'Joining Confirmed', 'Client Decision Received',
];

// §9 — "What should happen next?" This is the half that stops a follow-up
// ending in "we called them... and now what".
const FOLLOWUP_NEXT_STEPS = [
  'No further action', 'Follow up later', 'Schedule interview', 'Share with client',
  'Wait for client response', 'Confirm joining',
];

// Every next step EXCEPT the two terminal ones needs a date — that is what
// makes the chain continue instead of stopping silently.
const NEXT_STEPS_NEEDING_DATE = FOLLOWUP_NEXT_STEPS.filter(
  (s) => s !== 'No further action',
);

// §17 — the message templates, so nobody retypes the same thing.
const FOLLOWUP_TEMPLATES = {
  candidate: [
    'Interview Reminder', 'Interview Confirmation', 'Interview Reschedule',
    'Document Request', 'Joining Confirmation', 'Offer Follow-up',
  ],
  client: [
    'Candidate Shared', 'Candidate Decision Reminder', 'Interview Feedback Reminder',
    'Joining Confirmation', 'Requirement Follow-up',
  ],
};

// Escalation thresholds, in days past the due date. Recruiter -> TL -> Super
// Admin, exactly as the user drew it.

const todayStr = () => new Date().toISOString().slice(0, 10);

function dayDiff(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00.000Z`);
  const b = Date.parse(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// The four-state status, derived. `today` is passed in so a list of 200 rows
// resolves against ONE notion of today rather than 200 clock reads.
function followUpStatus(row, today = todayStr()) {
  if (!row) return null;
  if (row.completedAt) return 'Completed';
  if (!row.dueDate) return 'Upcoming';
  if (row.dueDate > today) return 'Upcoming';
  if (row.dueDate === today) return 'Due Today';
  return 'Overdue';
}

function daysOverdue(row, today = todayStr()) {
  if (!row || row.completedAt || !row.dueDate || row.dueDate >= today) return 0;
  return dayDiff(row.dueDate, today);
}

function decorate(row, today = todayStr()) {
  if (!row) return null;
  return { ...row, status: followUpStatus(row, today), daysOverdue: daysOverdue(row, today) };
}

// ---------------------------------------------------------------------------
// WHO OWNS THE FOLLOW-UP.
//
// The stage says which ROLE owns the next move (utils/atsVocab.js
// STAGE_OWNER_ACTION — the same table the Candidate list's Owner column reads,
// so the two can never disagree). That role then resolves to the actual named
// person on the requirement's assignment chain.
//
// A stage owned by the CLIENT has no internal owner user; the follow-up is
// still ours to chase, so it falls back to the BDE and then the recruiter —
// somebody in this company owes that call.
// ---------------------------------------------------------------------------
function ownerOf(application, requirement) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  const r = requirement || {};
  const recruiter = { id: r.recruiterId || null, name: (r.recruiter && r.recruiter.name) || null, role: 'Recruiter' };
  const bde = { id: r.bdeId || null, name: (r.bde && r.bde.name) || null, role: 'BDE' };
  if (rule.ownerRole === 'BDE') return bde.id ? bde : recruiter;
  if (rule.ownerRole === 'Client') {
    // The client is being waited on; chasing them is the BDE's job, or the
    // recruiter's where no BDE is named.
    const chaser = bde.id ? bde : recruiter;
    return { ...chaser, role: chaser.role, waitingOn: 'Client' };
  }
  if (rule.ownerRole === 'Recruiter') return recruiter;
  return recruiter.id ? recruiter : bde;
}

// The snapshot written onto every new follow-up row.
function chainSnapshot(application, requirement, names = null) {
  const owner = ownerOf(application, requirement);
  const r = requirement || {};
  return {
    ownerUserId: owner.id,
    ownerName: owner.name,
    ownerRole: owner.role,
    tlUserId: r.tlId || null,
    tlName: (names && r.tlId && names.get(r.tlId)) || r.tlName || r.tl || null,
    bdeUserId: r.bdeId || null,
    bdeName: (r.bde && r.bde.name) || null,
  };
}

// tlId / stlId / recruiterIds are plain scalars on Requirement, not Prisma
// relations (the clireq migration kept them ADD COLUMN only), so the TL's name
// has to be looked up rather than included. Resolved in ONE query for a whole
// list; `names` is a Map(userId -> name).
async function resolveNames(requirements) {
  const ids = new Set();
  (requirements || []).forEach((r) => { if (r && r.tlId) ids.add(r.tlId); });
  if (!ids.size) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } }, select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

// The default next action for a stage, so a recorded follow-up always says
// what is owed even when the person typed nothing.
function defaultNextAction(application) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  return rule.action || `Follow up on ${stageLabel(application.stage)}`;
}

// Default due date: the stage's own SLA in days from today.
function defaultDueDate(application) {
  const rule = STAGE_OWNER_ACTION[application.stage] || {};
  const d = new Date();
  d.setDate(d.getDate() + (rule.days || 2));
  return d.toISOString().slice(0, 10);
}

// The CURRENT follow-up on each of these applications — the newest row that
// has not been completed, and where every row is completed, the newest one
// (so the Candidates table can still show when contact last happened).
async function currentFollowUpsByApplication(applicationIds) {
  const out = new Map();
  if (!applicationIds || !applicationIds.length) return out;
  const rows = await prisma.applicationFollowUp.findMany({
    where: { applicationId: { in: applicationIds } },
    orderBy: { createdAt: 'desc' },
  });
  const today = todayStr();
  rows.forEach((row) => {
    const existing = out.get(row.applicationId);
    // rows arrive newest first: the first OPEN one wins, otherwise the first
    // row seen (which is the newest completed one).
    if (!existing) out.set(row.applicationId, row);
    else if (existing.completedAt && !row.completedAt) out.set(row.applicationId, row);
  });
  const decorated = new Map();
  out.forEach((row, key) => decorated.set(key, decorate(row, today)));
  return decorated;
}
// ---------------------------------------------------------------------------
// THE ESCALATION LADDER (§11-§13).
//
//   Owner -> TL -> STL -> Admin -> Super Admin
//
// It used to be two rungs, TL then Super Admin, so a missed follow-up went
// straight from a team lead to the top of the company with nobody in between.
//
// TWO RULES THE SPEC IS EXPLICIT ABOUT:
//
//   1. NOT EVERYONE IS TOLD AT ONCE. Each rung fires only after its own
//      threshold, and only once — the timestamp on the row is what makes it
//      once. Otherwise the alerts are noise and get ignored, which is the
//      failure this feature exists to prevent.
//   2. THE OWNER STAYS RESPONSIBLE. Escalating tells somebody else; it never
//      moves the work. `ownerUserId` is untouched at every rung.
//
// The thresholds are in DAYS OVERDUE and deliberately spread, so the ladder is
// a week long rather than an afternoon.
const ESCALATION_LADDER = [
  { level: 1, key: 'escalatedTlAt', afterDays: 1, audience: 'tl', label: 'TL' },
  { level: 2, key: 'escalatedStlAt', afterDays: 3, audience: 'stl', label: 'STL' },
  { level: 3, key: 'escalatedAdminAt', afterDays: 5, audience: 'admin', label: 'Admin' },
  { level: 4, key: 'escalatedSuperAdminAt', afterDays: 7, audience: 'superadmin', label: 'Super Admin' },
];

// Who each rung notifies. The named person on the row for TL and STL; the
// company-level logins for the last two, resolved once per run rather than per
// row.
async function audienceFor(rung, followUp, cache) {
  if (rung.audience === 'tl') return [followUp.tlUserId].filter(Boolean);
  if (rung.audience === 'stl') return [followUp.stlUserId].filter(Boolean);
  const role = rung.audience === 'admin' ? 'ADMIN' : 'SUPER_ADMIN';
  if (!cache[role]) {
    // eslint-disable-next-line no-param-reassign
    cache[role] = (await prisma.user.findMany({
      where: { role, status: 'Active' },
      select: { id: true },
    })).map((u) => u.id);
  }
  return cache[role];
}

async function escalateOverdue({ limit = 300 } = {}) {
  const summary = {
    checked: 0, tlAlerts: 0, stlAlerts: 0, adminAlerts: 0, superAdminAlerts: 0, skipped: 0,
  };
  try {
    const today = todayStr();
    const open = await prisma.applicationFollowUp.findMany({
      where: {
        completedAt: null,
        dueDate: { not: null, lt: today },
        // Anything that has not yet reached the top of the ladder.
        escalatedSuperAdminAt: null,
      },
      take: limit,
      orderBy: { dueDate: 'asc' },
    });
    summary.checked = open.length;
    if (!open.length) return summary;

    const cache = {};
    const counters = {
      tl: 'tlAlerts', stl: 'stlAlerts', admin: 'adminAlerts', superadmin: 'superAdminAlerts',
    };

    for (const f of open) {
      const late = daysOverdue(f, today);
      const what = `${f.nextAction || 'Follow-up'} — due ${f.dueDate}${f.dueTime ? ` ${f.dueTime}` : ''}, ${late} day(s) overdue.`;
      const who = f.ownerName || 'the owner';

      for (const rung of ESCALATION_LADDER) {
        if (f[rung.key]) continue;              // this rung already fired
        if (late < rung.afterDays) break;       // and no later rung is due either

        // eslint-disable-next-line no-await-in-loop
        const audience = await audienceFor(rung, f, cache);
        if (!audience.length) {
          // NOBODY HOLDS THIS RUNG — say so on the row and carry on up rather
          // than stalling the ladder at a level that has no one in it.
          summary.skipped += 1;
          // eslint-disable-next-line no-await-in-loop
          await prisma.applicationFollowUp.update({
            where: { id: f.id }, data: { [rung.key]: new Date() },
          });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        await notifyUsers(audience, {
          title: `Overdue follow-up escalated to you — ${who}`,
          message: rung.level === 1
            ? what
            : `${what} Already escalated past ${ESCALATION_LADDER[rung.level - 2].label}. ${who} is still the owner.`,
        });
        // eslint-disable-next-line no-await-in-loop
        await prisma.applicationFollowUp.update({
          where: { id: f.id },
          // THE OWNER IS NOT CHANGED. Escalating tells somebody else; it does
          // not hand the work over.
          data: { [rung.key]: new Date(), escalationLevel: rung.level },
        });
        summary[counters[rung.audience]] += 1;
      }
    }
  } catch (err) {
    // A read must never fail because an alert could not be written.
    // eslint-disable-next-line no-console
    console.error('Follow-up escalation could not run:', err.message);
  }
  return summary;
}

module.exports = {
  FOLLOWUP_STATUSES,
  CONTACT_MODES,
  CALL_RESULTS,
  FOLLOWUP_OUTCOMES,
  FOLLOWUP_NEXT_STEPS,
  NEXT_STEPS_NEEDING_DATE,
  FOLLOWUP_TEMPLATES,
  ESCALATION_LADDER,
  todayStr,
  followUpStatus,
  daysOverdue,
  decorate,
  ownerOf,
  chainSnapshot,
  defaultNextAction,
  defaultDueDate,
  currentFollowUpsByApplication,
  resolveNames,
  escalateOverdue,
};
