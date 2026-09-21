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

// Escalation thresholds, in days past the due date. Recruiter -> TL -> Super
// Admin, exactly as the user drew it.
const ESCALATE_TL_AFTER_DAYS = 1;
const ESCALATE_ADMIN_AFTER_DAYS = 3;

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
// ESCALATION — Recruiter -> TL alert -> Super Admin alert.
//
// WHEN IT FIRES: THERE IS NO SCHEDULER IN THIS APPLICATION. This function is
// called ON READ — whenever the follow-up list or the ATS dashboard is
// loaded — and additionally by POST /api/followups/run-escalation, which is
// the endpoint a real cron would hit. Nothing here runs on a timer.
//
// Consequence, stated plainly rather than hidden: a follow-up that goes
// overdue while nobody opens the app is not alerted until somebody does. The
// alert is not lost — escalatedTlAt / escalatedAdminAt are null until it is
// sent, so the first read after the fact still sends it exactly once — but it
// is late by however long the app went unopened. Wiring the run-escalation
// endpoint to a cron (or node-cron in src/index.js) is the whole of the fix,
// and it is deliberately NOT done here: this app starts one process and has no
// job runner, and adding a timer that only runs while a dev server happens to
// be up would be a worse lie than saying so.
//
// Idempotent: each stamp is written once, so re-reading a list does not
// re-alert. Never throws — an alert must not break a list.
// ---------------------------------------------------------------------------
async function escalateOverdue({ limit = 300 } = {}) {
  const summary = { checked: 0, tlAlerts: 0, adminAlerts: 0 };
  try {
    const today = todayStr();
    const open = await prisma.applicationFollowUp.findMany({
      where: {
        completedAt: null,
        dueDate: { not: null, lt: today },
        OR: [{ escalatedTlAt: null }, { escalatedAdminAt: null }],
      },
      take: limit,
      orderBy: { dueDate: 'asc' },
    });
    summary.checked = open.length;
    if (!open.length) return summary;

    // Resolved once, not per row.
    let admins = [];
    const needAdmin = open.some((f) => !f.escalatedAdminAt
      && daysOverdue(f, today) >= ESCALATE_ADMIN_AFTER_DAYS);
    if (needAdmin) {
      admins = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN', status: 'Active' },
        select: { id: true },
      });
    }

    for (const f of open) {
      const late = daysOverdue(f, today);
      const what = `${f.nextAction || 'Follow-up'} — due ${f.dueDate}, ${late} day(s) overdue.`;
      const who = f.ownerName || 'the owner';

      if (!f.escalatedTlAt && late >= ESCALATE_TL_AFTER_DAYS) {
        const audience = [f.tlUserId].filter(Boolean);
        if (audience.length) {
          // eslint-disable-next-line no-await-in-loop
          await notifyUsers(audience, {
            title: `Overdue follow-up escalated to you — ${who}`,
            message: what,
          });
          summary.tlAlerts += 1;
        }
        // The stamp is written even where no TL is named, so the row moves on
        // to the Super Admin rung instead of retrying a recipient that does
        // not exist on every single read.
        // eslint-disable-next-line no-await-in-loop
        await prisma.applicationFollowUp.update({
          where: { id: f.id }, data: { escalatedTlAt: new Date() },
        });
      }

      if (!f.escalatedAdminAt && late >= ESCALATE_ADMIN_AFTER_DAYS && admins.length) {
        // eslint-disable-next-line no-await-in-loop
        await notifyUsers(admins.map((a) => a.id), {
          title: `Follow-up still overdue after ${late} days — ${who}`,
          message: `${what} Escalated past ${f.tlName || 'the TL'}.`,
        });
        // eslint-disable-next-line no-await-in-loop
        await prisma.applicationFollowUp.update({
          where: { id: f.id }, data: { escalatedAdminAt: new Date() },
        });
        summary.adminAlerts += 1;
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
  ESCALATE_TL_AFTER_DAYS,
  ESCALATE_ADMIN_AFTER_DAYS,
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
