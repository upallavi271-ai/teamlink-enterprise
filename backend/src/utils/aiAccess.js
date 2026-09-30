// ---------------------------------------------------------------------------
// WHO MAY USE THE AI ASSISTANT / AGENT, AND FOR WHAT.
//
// The Role Catalog decides (Administration → Role Catalog → "AI Assistant &
// Agent"): utils/permissions.js aiAccessFor(user) reads it. This file is the
// one place the AI routes ask, and it adds the rules that sit ON TOP of the
// catalog grant:
//
//   * ask      — may open the Assistant at all. Without it the button is
//                hidden and every /api/assistant and /api/agent route is 403.
//   * voice    — may use the 🎤 mic (browser speech recognition).
//   * data     — { hrms, ats, accounts }: which product's records the
//                Assistant may answer from. A product the login does not hold
//                is never allowed, whatever the catalog says, and every data
//                read STILL runs the user's normal can() + utils/scope.js —
//                the AI never sees a row the user could not open themselves.
//   * agent    — may use the Agent tab (propose actions). Each action is
//                checked again with can() at execute time, server-side.
//   * executeWithoutConfirm — a confirmed proposal card is skipped. Off by
//                default for every role; the Super Admin grants it.
//
// Until permissions.js exports aiAccessFor, a local shim with the same shape
// answers (internal staff: ask/voice/agent on, data per product held,
// never execute-without-confirm; Client / Candidate logins: nothing).
// ---------------------------------------------------------------------------

const permissions = require('./permissions');
const { logAudit } = require('./audit');

const { can, canMoveToStage } = permissions;

const EXTERNAL = ['CLIENT', 'CANDIDATE'];
const named = (v) => !!(v && v !== 'NONE');

function isExternal(user) {
  return !!user && (EXTERNAL.includes(user.role) || EXTERNAL.includes(user.atsRole));
}

// What the login actually holds, per product — the ceiling for `data`.
function productsHeld(user) {
  const p = (user && user.products) || {};
  const ext = isExternal(user);
  return {
    hrms: !ext && !!p.hrms && named(user.hrmsRole || user.role),
    ats: !ext && !!p.ats && named(user.atsRole),
    accounts: !ext && !!p.accounts && named(user.accountsRole),
  };
}

// The shim: used only while permissions.js has no aiAccessFor.
function shimAccess(user) {
  const internal = !!user && !!user.id && !isExternal(user);
  const held = productsHeld(user);
  return {
    ask: internal,
    voice: internal,
    data: { ...held },
    agent: internal,
    executeWithoutConfirm: false,
  };
}

// The real helper's answer, read tolerantly (the catalog agent owns its
// exact key names) and folded into the shape above.
function pickBool(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return !!obj[k];
  }
  return undefined;
}

function normalise(raw, user) {
  const shim = shimAccess(user);
  if (!raw || typeof raw !== 'object') return { ...shim, source: 'shim' };
  const data = raw.data || raw.answers || raw.products || {};
  const pick = (keys, fallback) => {
    const v = pickBool(raw, keys);
    return v === undefined ? fallback : v;
  };
  const dataPick = (p, keys) => {
    const v = pickBool(data, [p]);
    if (v !== undefined) return v;
    const w = pickBool(raw, keys);
    return w === undefined ? shim.data[p] : w;
  };
  const held = productsHeld(user);
  const ask = pick(['ask', 'use', 'chat', 'assistant', 'open'], shim.ask);
  const out = {
    ask,
    voice: ask && pick(['voice', 'mic', 'voiceInput'], shim.voice),
    data: {
      // The login must hold the product AND the catalog must allow it.
      hrms: ask && held.hrms && dataPick('hrms', ['hrmsData', 'answersHrms', 'hrms']),
      ats: ask && held.ats && dataPick('ats', ['atsData', 'answersAts', 'ats']),
      accounts: ask && held.accounts && dataPick('accounts', ['accountsData', 'answersAccounts', 'accounts']),
    },
    agent: ask && pick(['agent', 'actions', 'agentActions', 'act'], shim.agent),
    executeWithoutConfirm: false,
    source: 'catalog',
  };
  out.executeWithoutConfirm = out.agent && pick(['executeWithoutConfirm', 'noConfirm', 'autoExecute', 'skipConfirm'], false);
  return out;
}

async function aiAccessFor(user) {
  if (!user || !user.id) return { ...shimAccess(null), source: 'shim' };
  // Read at call time: the catalog helper may be added while this runs.
  const real = permissions.aiAccessFor;
  if (typeof real === 'function') {
    try {
      return normalise(await real(user), user);
    } catch {
      // A catalog read that fails must not open anything up.
      return {
        ask: false, voice: false, data: { hrms: false, ats: false, accounts: false }, agent: false, executeWithoutConfirm: false, source: 'error',
      };
    }
  }
  return { ...shimAccess(user), source: 'shim' };
}

// ---------------------------------------------------------------------------
// Middleware: attaches req.user.ai and refuses what the grant does not cover.
// `need` = 'ask' | 'agent'.
// ---------------------------------------------------------------------------
function requireAi(need = 'ask') {
  return async (req, res, next) => {
    try {
      const access = await aiAccessFor(req.user);
      req.user.ai = access;
      if (!access.ask) {
        return res.status(403).json({ error: 'Your role does not have access to the AI Assistant. Ask your Super Admin to grant it in Role Catalog.', code: 'ai_denied' });
      }
      if (need === 'agent' && !access.agent) {
        return res.status(403).json({ error: 'Your role cannot use the AI Agent. Ask your Super Admin to grant it in Role Catalog.', code: 'ai_agent_denied' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Which product each data tool reads (utils/aiAgentTools.js + ReadTools).
// A tool not listed here is refused for the AI (fail closed).
// ---------------------------------------------------------------------------
const TOOL_PRODUCT = {
  // ATS
  my_pending_actions: 'ats',
  search_requirements: 'ats',
  get_requirement: 'ats',
  search_candidates: 'ats',
  summarise_candidate_against_requirement: 'ats',
  top_matches_for_requirement: 'ats',
  job_description_facts: 'ats',
  list_clients: 'ats',
  upcoming_interviews: 'ats',
  recent_joinings: 'ats',
  // HRMS
  my_profile_status: 'hrms',
  my_attendance: 'hrms',
  my_leave: 'hrms',
  my_payslips: 'hrms',
  my_tasks: 'hrms',
  my_team_directory: 'hrms',
  headcount_summary: 'hrms',
  attendance_on_date: 'hrms',
  who_is_on_leave: 'hrms',
  hr_pending_approvals: 'hrms',
  // Accounts
  accounts_summary: 'accounts',
  search_invoices: 'accounts',
};

// null = allowed; otherwise the refusal to hand back instead of data.
// Only applies when the AI grant is attached (req.user.ai) — screens that
// call the same tools without the AI are unaffected.
function toolRefusal(user, name) {
  const access = user && user.ai;
  if (!access) return null;
  const product = TOOL_PRODUCT[name];
  if (!product) return { denied: true, message: 'Refused: the AI Assistant cannot use that lookup. Nothing was read.' };
  if (!access.data || !access.data[product]) {
    return { denied: true, message: `Refused: your role may not ask the AI about ${product.toUpperCase()} data. Nothing was read.` };
  }
  return null;
}

function toolsAllowed(user) {
  return Object.keys(TOOL_PRODUCT).filter((n) => !toolRefusal(user, n));
}

// ---------------------------------------------------------------------------
// AGENT ACTIONS → the can() check each one needs, the same feature/action
// the route it replays is guarded by. Run at EXECUTE time, server-side,
// before anything is replayed. An action missing here is refused.
// ---------------------------------------------------------------------------
const hrmsSelf = (u) => can(u, 'hrms', 'hrms', 'Employee Services', 'view');
const ACTION_CHECKS = {
  submit_leave: { product: 'hrms', check: hrmsSelf },
  approve_leave: { product: 'hrms', check: (u) => can(u, null, 'hrms', 'Leave & Holidays', 'approve') },
  reject_leave: { product: 'hrms', check: (u) => can(u, null, 'hrms', 'Leave & Holidays', 'approve') },
  request_regularization: { product: 'hrms', check: hrmsSelf },
  approve_regularization: { product: 'hrms', check: (u) => can(u, null, 'hrms', 'Attendance & Time', 'approve') },
  reject_regularization: { product: 'hrms', check: (u) => can(u, null, 'hrms', 'Attendance & Time', 'approve') },
  cancel_regularization: { product: 'hrms', check: hrmsSelf },
  submit_expense_claim: { product: 'hrms', check: hrmsSelf },
  raise_helpdesk_ticket: { product: 'hrms', check: hrmsSelf },
  request_profile_edit: { product: 'hrms', check: hrmsSelf },
  post_announcement: { product: 'hrms', check: (u) => can(u, null, 'hrms', 'Employee Services', 'create') },
  create_task: { product: 'hrms', check: hrmsSelf },
  move_candidate_stage: {
    product: 'ats',
    check: async (u, p) => (await can(u, 'ats', 'candidates', 'Applications', 'view'))
      && (!p || !p.stage || await canMoveToStage(u, String(p.stage))),
  },
  schedule_interview: { product: 'ats', check: (u) => can(u, 'ats', 'interviews', 'Schedule Interview', 'create') },
  add_followup: { product: 'ats', check: (u) => can(u, 'ats', 'candidates', 'Applications', 'edit') },
  log_contact: { product: 'ats', check: (u) => can(u, 'ats', 'candidates', 'Candidate Master', 'edit') },
  assign_recruiter: { product: 'ats', check: (u) => can(u, 'ats', 'requirements', 'Requirement Detail', 'assign') },
};

// { ok } or { ok:false, message }.
async function actionPermitted(user, name, params) {
  const spec = ACTION_CHECKS[name];
  if (!spec) return { ok: false, message: 'The AI Agent is not allowed to do that. Nothing was changed.' };
  const access = user.ai || await aiAccessFor(user);
  if (!access.agent) return { ok: false, message: 'Your role cannot use the AI Agent. Nothing was changed.' };
  if (!productsHeld(user)[spec.product]) {
    return { ok: false, message: `Your login has no ${spec.product.toUpperCase()} role, so the Agent cannot do that. Nothing was changed.` };
  }
  let allowed = false;
  try { allowed = !!await spec.check(user, params || {}); } catch { allowed = false; }
  return allowed ? { ok: true } : { ok: false, message: 'Your role does not have permission to do that in the app, so the Agent cannot do it either. Nothing was changed.' };
}

// The action names a user may even be offered (a cheap product filter; the
// full can() runs at execute time).
function actionProductAllowed(user, name) {
  const spec = ACTION_CHECKS[name];
  return !!spec && !!productsHeld(user)[spec.product];
}

async function auditAgentAction(user, name, summary, message, { autoExecuted = false } = {}) {
  await logAudit({
    userId: user.id,
    actorName: user.name || user.email || null,
    action: 'AI_AGENT_ACTION',
    entity: 'AiAgent',
    entityId: name,
    toValue: String(summary || '').slice(0, 500),
    reason: `via AI Agent${autoExecuted ? ' (executed without confirm — role grant)' : ' (confirmed by user)'}${message ? ` — ${String(message).slice(0, 200)}` : ''}`,
  });
}

// ---------------------------------------------------------------------------
// SUGGESTED PROMPTS — only the ones this login can actually get an answer to.
// ---------------------------------------------------------------------------
async function suggestedPrompts(user, access) {
  const a = access || user.ai || await aiAccessFor(user);
  if (!a.ask) return [];
  const out = [];
  const isEmployee = !!user.employeeId && !user.systemAccount;
  if (a.data.hrms) {
    if (isEmployee) out.push({ area: 'hrms', label: 'How much leave do I have left?', text: 'How much leave do I have left?' });
    out.push({ area: 'hrms', label: 'When is the next holiday?', text: 'When is the next holiday?' });
    if (isEmployee) out.push({ area: 'hrms', label: 'Is my profile approved?', text: 'Is my profile approved?' });
    if (await can(user, 'hrms', 'hrms', 'Leave & Holidays', 'view') && user.caps && user.caps.hrmsManage) {
      out.push({ area: 'hrms', label: 'Who is on leave this week?', text: 'Who is on leave this week?' });
    }
  }
  if (a.data.ats) {
    const [cands, reqDetail, pending, dup] = await Promise.all([
      can(user, 'ats', 'candidates', 'Candidate List', 'view'),
      can(user, 'ats', 'requirements', 'Requirement Detail', 'view'),
      can(user, null, 'dashboard', 'Pending Approvals', 'view'),
      Promise.resolve(['SUPER_ADMIN', 'ADMIN'].includes(user.role)),
    ]);
    if (cands) out.push({ area: 'ats', label: 'Find candidates', text: 'Find candidates for ', prefill: true });
    if (reqDetail) out.push({ area: 'ats', label: 'Summarize requirement', text: 'Summarize requirement ', prefill: true });
    if (pending) {
      out.push({ area: 'ats', label: 'Explain pending actions', text: 'Explain my pending actions — what is waiting on me and what should I do first?' });
      out.push({ area: 'ats', label: "Show today's workload", text: "Show today's workload" });
    }
    if (cands && dup) out.push({ area: 'ats', label: 'Find duplicate candidates', text: 'Find duplicate candidates' });
    if (reqDetail) out.push({ area: 'ats', label: 'Prepare interview questions', text: 'Prepare interview questions for ', prefill: true });
  }
  if (a.data.accounts && await can(user, 'accounts', 'accounts', 'Invoices', 'view')) {
    out.push({ area: 'accounts', label: 'How much is outstanding?', text: 'How much is outstanding, and how much of it is overdue?' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLARIFY — voice confidence and the quick-reply options.
// ---------------------------------------------------------------------------
const LOW_CONFIDENCE = 0.6;
const VOICE_LANGS = { 'en-IN': 'English (India)', 'te-IN': 'Telugu', 'hi-IN': 'Hindi' };

// The request body's `voice` hint, cleaned. null = typed.
function voiceOf(body) {
  const v = body && body.voice;
  if (!v || typeof v !== 'object') return null;
  const c = Number(v.confidence);
  const lang = VOICE_LANGS[v.lang] ? v.lang : 'en-IN';
  return {
    lang,
    // Chrome reports 0 when it has no estimate; treat 0/absent as unknown.
    confidence: Number.isFinite(c) && c > 0 && c <= 1 ? Math.round(c * 100) / 100 : null,
  };
}

function isLowConfidence(voice) {
  return !!voice && voice.confidence != null && voice.confidence < LOW_CONFIDENCE;
}

// A line for the system prompt about how this message arrived.
function voicePromptNote(voice) {
  if (!voice) return '';
  const lang = VOICE_LANGS[voice.lang];
  if (isLowConfidence(voice)) {
    return `NOTE: the latest message was SPOKEN (${lang}) and transcribed by the browser with LOW confidence (${voice.confidence}). Words may be mis-heard. If its meaning is not completely clear, do not guess: ask one short question to confirm what they meant, offering the 2–3 most likely readings.`;
  }
  return `NOTE: the latest message was spoken (${lang}) and transcribed by the browser${voice.confidence != null ? ` (confidence ${voice.confidence})` : ''}; allow for small transcription slips.`;
}

// Assistant replies carry quick-reply options as a last line
// "OPTIONS: a | b | c". Split them off; at most 3, each short.
function splitOptions(text) {
  const s = String(text || '');
  const m = s.match(/(?:^|\n)\s*\**\s*OPTIONS?\s*\**\s*[:：]\s*(.+?)\s*$/i);
  if (!m) return { text: s.trim(), options: [] };
  const options = cleanOptions(m[1].split(/\s*\|\s*|\s*;\s*/));
  return { text: s.slice(0, m.index).trim(), options };
}

function cleanOptions(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((o) => String(o == null ? '' : o).replace(/^[\s"'\-•*\d.)]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter((o) => o && o.length <= 120 && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
    .slice(0, 3);
}

module.exports = {
  aiAccessFor,
  requireAi,
  productsHeld,
  isExternal,
  toolRefusal,
  toolsAllowed,
  TOOL_PRODUCT,
  ACTION_CHECKS,
  actionPermitted,
  actionProductAllowed,
  auditAgentAction,
  suggestedPrompts,
  voiceOf,
  isLowConfidence,
  voicePromptNote,
  splitOptions,
  cleanOptions,
  LOW_CONFIDENCE,
  VOICE_LANGS,
  // exported for tests
  normalise,
  shimAccess,
};
