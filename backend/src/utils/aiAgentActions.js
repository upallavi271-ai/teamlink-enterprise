// ---------------------------------------------------------------------------
// The AI agent's WRITE surface — proposals, not writes.
//
// THE SHAPE OF AN ACTION, AND WHY IT IS THIS SHAPE
//
//   1. The model calls the tool. Nothing is written. `propose()` runs the
//      FULL permission check and the FULL scope check, then hands back a
//      one-line human summary and an opaque single-use token.
//   2. The panel renders that summary as a confirm card. The user presses
//      Confirm. That is the only thing that can start a write.
//   3. POST /api/ai/act redeems the token. `execute()` runs the SAME
//      permission and scope checks AGAIN — a role edited between the proposal
//      and the confirmation must take effect — and only then calls the app's
//      own function for that operation.
//
// THERE IS NO SECOND IMPLEMENTATION OF ANY OF THESE OPERATIONS.
// `move_candidate_stage` and `schedule_interview` both call applyStageMove()
// from routes/applications.js, and `create_task` calls createTask() from
// routes/tasks.js — the exact functions the HTTP routes call. Those functions
// carry the stage-ownership matrix, the pipeline-history row, the candidate
// communications, the notifications and their own audit rows. This file adds
// the permission door, the scope gate, the confirmation and a second audit
// row that records the AI assistant as the origin.
//
// OFF BY DEFAULT. actionsEnabled() is false unless an administrator ticks
// "Allow the assistant to act (with confirmation)" in Administration →
// Integrations. With it off, no write tool is offered to the model at all,
// /api/ai/act refuses, and the panel says the assistant is read-only.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const prisma = require('../db');
const { can } = require('./permissions');
const { applicationWhere } = require('./scope');
const { logAudit } = require('./audit');
const { stageLabel, ALL_STAGE_CODES, INTERVIEW_MODES } = require('./atsVocab');
const { applyStageMove } = require('../routes/applications');
const { createTask, assignable } = require('../routes/tasks');

// A proposal is dead after this long, and after one redemption.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_USER = 10;

const DENIED = (what) => ({
  denied: true,
  message: `Refused: your role does not have permission to ${what}. Nothing was changed.`,
});

// --- The pending-proposal store -------------------------------------------
// In memory, per process, keyed by an unguessable token and pinned to the user
// who proposed it. Deliberately not a table: a proposal is worthless fifteen
// minutes later and losing the lot on a restart costs nothing. Nothing here is
// ever executed without a fresh permission check, so the store holding a stale
// entry cannot widen anybody's access.
const pending = new Map(); // token -> { userId, name, input, summary, at }

function sweep() {
  const now = Date.now();
  pending.forEach((v, k) => { if (now - v.at > TOKEN_TTL_MS) pending.delete(k); });
}

function remember(userId, name, input, summary, details) {
  sweep();
  const mine = [...pending.entries()].filter(([, v]) => v.userId === userId);
  if (mine.length >= MAX_PENDING_PER_USER) {
    mine.sort((a, b) => a[1].at - b[1].at);
    pending.delete(mine[0][0]);
  }
  const token = crypto.randomBytes(18).toString('hex');
  pending.set(token, {
    userId, name, input, summary, details, at: Date.now(),
  });
  return token;
}

function takePending(userId, token) {
  sweep();
  const row = pending.get(String(token || ''));
  // Pinned to the proposing user: another login holding the token gets
  // nothing, and the token dies on redemption whether or not it succeeds.
  if (!row || row.userId !== userId) return null;
  pending.delete(String(token));
  return row;
}

// --- Is the write surface switched on at all? ------------------------------
// Read from the integration config the caller already loaded, so this file
// never touches the credential store itself.
function actionsEnabled(cfg) {
  return !!(cfg && cfg.actionsEnabled);
}

// --- Shared gates ----------------------------------------------------------
// The application this action names must be one the asking user can already
// reach — the SAME where-fragment routes/applications.js lists with. A record
// the API would not show them is a record the assistant cannot act on.
async function reachableApplication(user, applicationId) {
  const id = String(applicationId || '').trim();
  if (!id) return { error: 'An application id is required.' };
  const app = await prisma.application.findFirst({
    where: { id, ...applicationWhere(user) },
    include: { candidate: true, requirement: { include: { client: true } } },
  });
  if (!app) {
    return {
      denied: true,
      message: 'Refused: that application is outside your access scope, or it does not exist. Nothing was changed.',
    };
  }
  return { app };
}

function isoDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// ---------------------------------------------------------------------------
// The actions.
//
// `check(user, input)` runs the permission and scope work and returns either a
// refusal or { summary, details, args } — the plan. It is called TWICE: once
// to build the confirm card, once at execution. `run(user, plan)` performs it.
// ---------------------------------------------------------------------------
const ACTIONS = [
  {
    name: 'move_candidate_stage',
    description: 'PROPOSE moving one candidate\'s application to a different pipeline stage. This does NOT happen when you call it: it returns a proposal the user must confirm in the panel. Call it once, then tell the user plainly what you have queued and that they must press Confirm. Never call it twice for the same move.',
    input_schema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', description: 'The applicationId from search_candidates or my_pending_actions.' },
        stage: { type: 'string', description: `The stage code to move to. One of: ${ALL_STAGE_CODES.join(', ')}.` },
        comment: { type: 'string', description: 'A short note recorded on the pipeline history row.' },
      },
      required: ['applicationId', 'stage'],
      additionalProperties: false,
    },
    async check(user, input) {
      // The permission engine, exactly as middleware/auth.js resolves
      // caps.atsAct for the route.
      if (!await can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit')) return DENIED('move a candidate through the pipeline');
      const stage = String(input.stage || '').trim().toUpperCase();
      if (!ALL_STAGE_CODES.includes(stage)) {
        return { error: `"${input.stage}" is not a stage code. Use one of: ${ALL_STAGE_CODES.join(', ')}.` };
      }
      const found = await reachableApplication(user, input.applicationId);
      if (found.denied || found.error) return found;
      const { app } = found;
      if (app.stage === stage) {
        return { error: `${app.candidate.name} is already at ${stageLabel(stage)}. Nothing to do.` };
      }
      return {
        summary: `Move ${app.candidate.name} from ${stageLabel(app.stage)} to ${stageLabel(stage)} on ${app.requirement.title}.`,
        details: {
          candidate: app.candidate.name,
          requirement: app.requirement.title,
          client: app.requirement.internal ? 'TeamLink (internal)' : (app.requirement.client && app.requirement.client.name) || null,
          from: stageLabel(app.stage),
          to: stageLabel(stage),
          comment: input.comment ? String(input.comment).slice(0, 300) : null,
        },
        args: { applicationId: app.id, stage, comment: input.comment ? String(input.comment).slice(0, 300) : null },
      };
    },
    async run(user, plan) {
      // routes/applications.js applyStageMove — the same call the PATCH route
      // makes, stage-ownership matrix and all.
      return applyStageMove(user, plan.args.applicationId, {
        stage: plan.args.stage,
        comment: plan.args.comment,
      });
    },
  },

  {
    name: 'schedule_interview',
    description: 'PROPOSE scheduling an interview for one application at a given date and time. Returns a proposal the user must confirm in the panel; nothing is booked until they do. Ask for the date and time if the user has not given one — never invent a slot.',
    input_schema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string' },
        when: { type: 'string', description: 'The slot, ISO-8601, e.g. 2026-10-02T11:30. Use the exact date and time the user gave.' },
        interviewer: { type: 'string' },
        mode: { type: 'string', description: `Interview mode. One of: ${INTERVIEW_MODES.join(', ')}.` },
        meetingLink: { type: 'string' },
      },
      required: ['applicationId', 'when'],
      additionalProperties: false,
    },
    async check(user, input) {
      // Two grants, because scheduling is two things: an interviews-module
      // action and a pipeline move. Both are required, neither is assumed.
      if (!await can(user, 'ats', 'interviews', 'Schedule Interview', 'create')) return DENIED('schedule interviews');
      if (!await can(user, 'ats', 'candidates', 'Pipeline Stages', 'edit')) return DENIED('move a candidate through the pipeline');
      const when = isoDateTime(input.when);
      if (!when) return { error: 'I need a real date and time for the interview, for example 2026-10-02T11:30.' };
      const mode = input.mode ? String(input.mode).trim() : null;
      if (mode && !INTERVIEW_MODES.includes(mode)) {
        return { error: `"${mode}" is not an interview mode. Use one of: ${INTERVIEW_MODES.join(', ')}.` };
      }
      const found = await reachableApplication(user, input.applicationId);
      if (found.denied || found.error) return found;
      const { app } = found;
      const slot = when.toISOString().slice(0, 16).replace('T', ' ');
      return {
        summary: `Schedule an interview for ${app.candidate.name} on ${app.requirement.title} at ${slot} (UTC).`,
        details: {
          candidate: app.candidate.name,
          requirement: app.requirement.title,
          slot,
          interviewer: input.interviewer ? String(input.interviewer).slice(0, 120) : null,
          mode,
          currentStage: stageLabel(app.stage),
        },
        args: {
          applicationId: app.id,
          when: when.toISOString(),
          interviewer: input.interviewer ? String(input.interviewer).slice(0, 120) : null,
          mode,
          meetingLink: input.meetingLink ? String(input.meetingLink).slice(0, 400) : null,
        },
      };
    },
    async run(user, plan) {
      // Scheduling IS the INTERVIEW_SCHEDULED move: the route stamps the
      // calendar columns from that one transition, so going through the same
      // function is what keeps the calendar and the pipeline consistent.
      return applyStageMove(user, plan.args.applicationId, {
        stage: 'INTERVIEW_SCHEDULED',
        interviewAt: plan.args.when,
        interviewer: plan.args.interviewer || undefined,
        interviewMode: plan.args.mode || undefined,
        interviewMeetingLink: plan.args.meetingLink || undefined,
        comment: 'Scheduled from the AI Assistant',
      });
    },
  },

  {
    name: 'create_task',
    description: 'PROPOSE creating a task. Returns a proposal the user must confirm in the panel. A task needs a name, a department and a start date (YYYY-MM-DD). Leave the assignee out to assign it to the signed-in user.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        department: { type: 'string' },
        description: { type: 'string' },
        startDate: { type: 'string', description: 'YYYY-MM-DD.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD.' },
        assigneeId: { type: 'string', description: 'A userId from my_team_directory. Omit to assign it to the signed-in user.' },
      },
      required: ['name', 'department', 'startDate'],
      additionalProperties: false,
    },
    async check(user, input) {
      // The same guard routes/tasks.js puts on its whole surface.
      if (!await can(user, 'hrms', 'hrms', 'Employee Services', 'view')) return DENIED('use the tasks workspace');
      const name = String(input.name || '').trim();
      const department = String(input.department || '').trim();
      if (!name) return { error: 'A task needs a name.' };
      if (!department) return { error: 'A task needs a department.' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ''))) {
        return { error: 'A task needs a start date as YYYY-MM-DD.' };
      }
      // Who this user may assign to — routes/tasks.js assignable(), not a
      // list rebuilt here.
      const { people, canAssignOthers } = await assignable(user);
      const wanted = input.assigneeId ? String(input.assigneeId) : user.id;
      if (wanted !== user.id && !canAssignOthers) return DENIED('assign work to other people');
      const target = people.find((p) => p.userId === wanted);
      if (!target) {
        return { denied: true, message: 'Refused: that person is outside the group you may assign work to. Nothing was changed.' };
      }
      return {
        summary: `Create the task "${name}" in ${department} for ${target.name}, starting ${input.startDate}.`,
        details: {
          task: name,
          department,
          assignee: target.name,
          startDate: input.startDate,
          endDate: input.endDate || null,
        },
        args: {
          name,
          department,
          description: input.description ? String(input.description).slice(0, 2000) : null,
          status: 'Not Started',
          startDate: String(input.startDate),
          endDate: input.endDate ? String(input.endDate) : null,
          assigneeId: target.userId,
        },
      };
    },
    async run(user, plan) {
      // routes/tasks.js createTask — the same validation, scope check and
      // audit row the POST route produces.
      return createTask(user, plan.args);
    },
  },
];

const BY_NAME = Object.fromEntries(ACTIONS.map((a) => [a.name, a]));
const ACTION_NAMES = ACTIONS.map((a) => a.name);

function isAction(name) { return Object.prototype.hasOwnProperty.call(BY_NAME, name); }

// Which write tools this user may even be OFFERED. An action whose permission
// check the user fails is not described to the model at all, so it cannot
// propose something that could only ever be refused.
async function writeToolDefinitions(user) {
  const out = [];
  for (const action of ACTIONS) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await action.check(user, {});
    // A refusal on the permission gate keeps the tool hidden; a validation
    // complaint about the empty input means the gate passed.
    if (probe && probe.denied) continue;
    out.push({ name: action.name, description: action.description, input_schema: action.input_schema });
  }
  return out;
}

// --- Step 1: propose -------------------------------------------------------
// Called from the tool loop. Never writes. Never throws.
async function proposeAction(user, name, input) {
  const action = BY_NAME[name];
  if (!action) return { error: `Unknown action ${name}.` };
  try {
    const plan = await action.check(user, input && typeof input === 'object' ? input : {});
    if (!plan || plan.denied || plan.error) return plan || { error: 'That action could not be prepared.' };
    const token = remember(user.id, name, input, plan.summary, plan.details);
    return {
      proposed: true,
      awaitingConfirmation: true,
      confirmToken: token,
      action: name,
      summary: plan.summary,
      details: plan.details,
      note: 'NOTHING HAS BEEN CHANGED. This is a proposal shown to the user as a confirm card in the panel. Tell them in one line what will happen and that they must press Confirm. Do not call this tool again for the same change.',
    };
  } catch (err) {
    return { error: `That action could not be prepared: ${String((err && err.message) || err).slice(0, 200)}` };
  }
}

// --- Step 2: execute -------------------------------------------------------
// Called from POST /api/ai/act after the user pressed Confirm. Re-runs the
// whole check; the proposal's stored args are NOT trusted.
async function executeAction(user, token) {
  const row = takePending(user.id, token);
  if (!row) {
    return { ok: false, status: 404, error: 'That confirmation has expired or was already used. Ask again and confirm the new one.' };
  }
  const action = BY_NAME[row.name];
  if (!action) return { ok: false, status: 400, error: 'Unknown action.' };

  // THE SECOND CHECK. A role edited, a scope narrowed or a record reassigned
  // between the proposal and this click must refuse here.
  let plan;
  try {
    plan = await action.check(user, row.input && typeof row.input === 'object' ? row.input : {});
  } catch (err) {
    return { ok: false, status: 500, error: `That action could not be re-checked: ${String((err && err.message) || err).slice(0, 200)}` };
  }
  if (!plan || plan.denied) {
    return { ok: false, status: 403, error: (plan && plan.message) || 'That action is not included in your role\'s permissions.' };
  }
  if (plan.error) return { ok: false, status: 400, error: plan.error };

  let out;
  try {
    out = await action.run(user, plan);
  } catch (err) {
    return { ok: false, status: 500, error: `That action failed: ${String((err && err.message) || err).slice(0, 200)}` };
  }
  if (!out || out.status >= 400) {
    const error = (out && out.body && (out.body.error || out.body.field)) || 'That action was refused.';
    return { ok: false, status: (out && out.status) || 500, error: String(error) };
  }

  // The origin row. The underlying function writes its own audit entry for the
  // business event; this one records that the AI assistant proposed it and
  // that this user confirmed it, which is the fact the business event cannot
  // carry on its own.
  await logAudit({
    userId: user.id,
    actorName: user.name,
    action: `AI Assistant action confirmed — ${row.name}`,
    entity: 'AiAssistantAction',
    entityId: (out.body && out.body.id) || row.name,
    toValue: plan.summary,
  });

  return { ok: true, action: row.name, summary: plan.summary, result: out.body };
}

// How many proposals this user has open — the panel shows them as cards, and
// the number is useful in a test.
function pendingCountFor(userId) {
  sweep();
  return [...pending.values()].filter((v) => v.userId === userId).length;
}

function clearPending() { pending.clear(); }

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  isAction,
  actionsEnabled,
  writeToolDefinitions,
  proposeAction,
  executeAction,
  pendingCountFor,
  clearPending,
  TOKEN_TTL_MS,
};
