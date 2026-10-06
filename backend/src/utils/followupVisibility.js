// ---------------------------------------------------------------------------
// "WAS THIS CANDIDATE FOLLOWED UP?" — made visible (user spec 2026-10-03, C1).
//
// Nothing here is a second follow-up store. Every answer is read from the
// records the app already writes:
//
//   ApplicationFollowUp.lastContactedAt   a follow-up recorded / touched (and
//                                         the imported trackers' real dates)
//   CandidateMessage (trigger 'Manual')   a Call / Email / WhatsApp / SMS made
//                                         from the Contact panel or the quick
//                                         Call / Mail / WhatsApp buttons
//
// Bulk broadcasts and the automatic stage-change mails are NOT a follow-up —
// nobody chased this one person — so they never count as "contacted".
//
// THE BADGE (per live application):
//   Not followed up (red)   never contacted, or a follow-up was due before
//                           today and nobody has contacted them since it fell due
//   Due today (orange)      a follow-up is due today and nobody has contacted
//                           them today yet
//   Followed up (green)     contacted, and nothing is past due
// A closed application (Rejected / Joined / Hired) carries no badge.
//
// WHEN IS A FOLLOW-UP DUE? The open follow-up's own due date, always. The
// per-stage RULES (Admin: Follow-ups → Due rules) add a due date where no
// follow-up names one — but only once the user has CONFIRMED them. Until then
// the table holds SUGGESTED defaults ("suggested — confirm") and changes
// nothing anywhere. The rules never escalate and never notify anyone.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const V = require('./atsVocab');

const RULES_STORE = 'ats-followup-rules';
const CONTACT_CHANNELS = ['Call', 'Email', 'WhatsApp', 'SMS'];
const CLOSED = ['REJECTED', 'JOINED', 'HIRED'];
const DAY_MS = 86400000;

// IST calendar day of a timestamp (YYYY-MM-DD).
const istDay = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + 330 * 60000).toISOString().slice(0, 10);
};
const todayIst = () => istDay(new Date());
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// ---------------------------------------------------------------------------
// THE CONTACT INDEX — latest contact per application, per candidate (any of
// their applications or none) and per candidate where the contact named no
// application. Rebuilt when the caller's data stamp changes (the pipeline
// passes utils/nextAction.js's snapshot stamp, which already moves on every
// follow-up and message write), otherwise at most every 30 s.
// ---------------------------------------------------------------------------
let IDX = { key: null, at: 0, byApp: new Map(), byCand: new Map(), untied: new Map() };
let building = null;

const newer = (map, key, entry) => {
  if (!key || !entry.at) return;
  const cur = map.get(key);
  if (!cur || cur.at < entry.at) map.set(key, entry);
};

async function buildIndex(key) {
  const [fus, msgs] = await Promise.all([
    prisma.applicationFollowUp.findMany({
      where: { lastContactedAt: { not: null } },
      select: {
        applicationId: true, candidateId: true, lastContactedAt: true, contactMode: true, ownerName: true, outcome: true,
      },
    }),
    prisma.candidateMessage.findMany({
      where: { trigger: 'Manual', channel: { in: CONTACT_CHANNELS } },
      select: {
        candidateId: true, applicationId: true, channel: true, createdAt: true, senderName: true, body: true, template: true,
      },
    }),
  ]);
  const limit = Date.now() + DAY_MS; // an imported date in the future is a typo, not a contact
  const byApp = new Map();
  const byCand = new Map();
  const untied = new Map();
  fus.forEach((f) => {
    const at = new Date(f.lastContactedAt).getTime();
    if (!at || at > limit) return;
    const e = { at, mode: f.contactMode || null, by: f.ownerName || null, outcome: f.outcome || null };
    newer(byApp, f.applicationId, e);
    newer(byCand, f.candidateId, e);
  });
  msgs.forEach((m) => {
    const at = new Date(m.createdAt).getTime();
    if (!at || at > limit) return;
    let outcome = null;
    if (m.template === 'QUICK_LOG' || m.channel === 'Call') outcome = String(m.body || '').split(' — ')[0] || null;
    const e = { at, mode: m.channel, by: m.senderName || null, outcome };
    if (m.applicationId) newer(byApp, m.applicationId, e); else newer(untied, m.candidateId, e);
    newer(byCand, m.candidateId, e);
  });
  IDX = { key, at: Date.now(), byApp, byCand, untied };
  return IDX;
}

async function contactIndex(stamp = null) {
  if (stamp && IDX.key === stamp) return IDX;
  if (!stamp && IDX.at && Date.now() - IDX.at < 30000) return IDX;
  if (building) return building;
  building = buildIndex(stamp || `t${Date.now()}`).finally(() => { building = null; });
  return building;
}
// Forget the index (a contact was just logged — the next read rebuilds it).
function touchContactIndex() { IDX = { ...IDX, key: null, at: 0 }; }

// The latest contact relevant to ONE application row: on this application,
// or with the person without naming any application.
function lastContactOf(idx, applicationId, candidateId) {
  const a = idx.byApp.get(applicationId) || null;
  const u = idx.untied.get(candidateId) || null;
  if (a && u) return a.at >= u.at ? a : u;
  return a || u;
}

// ---------------------------------------------------------------------------
// THE PER-STAGE DUE RULES (editable settings table; Integration row
// 'ats-followup-rules', the same internal-settings store attendance alerts use).
//
// mode  after_contact     due N days after the last contact (or after the
//                         application entered the stage, when nobody has
//                         contacted them in it yet)
//       before_interview  due N days before the interview date
//       before_joining    due N days before the joining date
//       none              no follow-up is owed in this stage
// ---------------------------------------------------------------------------
const RULE_MODES = ['after_contact', 'before_interview', 'before_joining', 'none'];
const RULE_MODE_LABEL = {
  after_contact: 'days after the last contact',
  before_interview: 'days before the interview',
  before_joining: 'days before the joining date',
  none: 'no follow-up in this stage',
};
// SUGGESTED — the user has not confirmed these (spec C1: "Rules — USER DECIDES").
const SUGGESTED_RULES = {
  NEW: { mode: 'after_contact', days: 1 },
  AI_INTERVIEW_REQUIRED: { mode: 'after_contact', days: 2 },
  AI_INTERVIEW_SCHEDULED: { mode: 'after_contact', days: 2 },
  AI_INTERVIEW_COMPLETED: { mode: 'after_contact', days: 1 },
  RECRUITER_REVIEW: { mode: 'after_contact', days: 2 },
  RECRUITER_APPROVED: { mode: 'after_contact', days: 2 },
  TL_REVIEW: { mode: 'after_contact', days: 3 },
  WITH_BDE: { mode: 'after_contact', days: 3 },
  BDE_APPROVED: { mode: 'after_contact', days: 3 },
  SHARED_WITH_CLIENT: { mode: 'after_contact', days: 3 },
  CLIENT_REVIEW: { mode: 'after_contact', days: 3 },
  CLIENT_SHORTLISTED: { mode: 'after_contact', days: 1 },
  // The user's own example: "Interview scheduled → confirm the day before".
  INTERVIEW_SCHEDULED: { mode: 'before_interview', days: 1 },
  INTERVIEW_COMPLETED: { mode: 'after_contact', days: 2 },
  SELECTED: { mode: 'after_contact', days: 2 },
  OFFER: { mode: 'after_contact', days: 2 },
  OFFER_ACCEPTED: { mode: 'before_joining', days: 1 },
  HOLD: { mode: 'after_contact', days: 7 },
};
const RULE_STAGES = Object.keys(SUGGESTED_RULES);
// The step in everyday words (spec §2), as the dashboard says it (utils/atsHome.js).
const STEP_WORD = {
  NEW: 'New', AI_INTERVIEW_REQUIRED: 'AI interview', AI_INTERVIEW_SCHEDULED: 'AI interview', AI_INTERVIEW_COMPLETED: 'Waiting for recruiter review',
  RECRUITER_REVIEW: 'Waiting for recruiter review', RECRUITER_APPROVED: 'Waiting for recruiter review', TL_REVIEW: 'Waiting for team lead review',
  WITH_BDE: 'Check by client manager (BDE)', BDE_APPROVED: 'Check by client manager (BDE)', SHARED_WITH_CLIENT: 'Sent to client',
  CLIENT_REVIEW: 'Sent to client', CLIENT_SHORTLISTED: 'Client shortlisted', INTERVIEW_SCHEDULED: 'Interview fixed',
  INTERVIEW_COMPLETED: 'Interview done', SELECTED: 'Selected', OFFER: 'Offer', OFFER_ACCEPTED: 'Waiting to join', HOLD: 'On hold',
};

let RULES_CACHE = null; // { at, value }

async function loadRules() {
  if (RULES_CACHE && Date.now() - RULES_CACHE.at < 15000) return RULES_CACHE.value;
  const row = await prisma.integration.findUnique({ where: { id: RULES_STORE } });
  let saved = {};
  try { saved = row && row.values ? JSON.parse(row.values) : {}; } catch { saved = {}; }
  const rules = {};
  RULE_STAGES.forEach((st) => {
    const s = (saved.rules || {})[st];
    rules[st] = s && RULE_MODES.includes(s.mode) ? { mode: s.mode, days: Number(s.days) || 0 } : { ...SUGGESTED_RULES[st] };
  });
  const value = {
    confirmed: !!saved.confirmed,
    confirmedAt: saved.confirmedAt || null,
    confirmedBy: saved.confirmedBy || null,
    updatedAt: saved.updatedAt || null,
    updatedBy: saved.updatedBy || null,
    rules,
  };
  RULES_CACHE = { at: Date.now(), value };
  return value;
}

// The settings table as the screen draws it.
async function rulesTable() {
  const r = await loadRules();
  return {
    confirmed: r.confirmed,
    status: r.confirmed ? 'Confirmed — in use' : 'Suggested — confirm',
    confirmedAt: r.confirmedAt,
    confirmedBy: r.confirmedBy,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
    modes: RULE_MODES.map((m) => ({ id: m, label: RULE_MODE_LABEL[m] })),
    note: r.confirmed
      ? 'In use: where a live application has no follow-up due date of its own, these rules set when it is owed. They change the Due today / Not followed up badges only — nothing is escalated and nobody is notified by them.'
      : 'Suggested defaults — NOT in use yet. Nothing in the app reads them until you confirm. Even after confirming, they only drive the Due today / Not followed up badges; they never escalate or notify.',
    rows: RULE_STAGES.map((st) => {
      const cur = r.rules[st];
      const sug = SUGGESTED_RULES[st];
      return {
        stage: st,
        label: V.stageLabel(st),
        word: STEP_WORD[st] || V.stageLabel(st),
        owner: (V.STAGE_OWNER_ACTION[st] || {}).ownerRole || '—',
        mode: cur.mode,
        days: cur.days,
        suggested: { ...sug, text: sug.mode === 'none' ? RULE_MODE_LABEL.none : `${sug.days} ${RULE_MODE_LABEL[sug.mode]}` },
        changed: cur.mode !== sug.mode || cur.days !== sug.days,
      };
    }),
  };
}

// Save edits (and, with confirm: true, confirm them). Super Admin / Admin —
// the route checks that.
async function saveRules(user, body = {}) {
  const cur = await loadRules();
  const errs = [];
  const next = { ...cur.rules };
  const incoming = body.rules && typeof body.rules === 'object' ? body.rules : {};
  Object.entries(incoming).forEach(([st, v]) => {
    if (!RULE_STAGES.includes(st)) { errs.push(`Unknown stage ${st}`); return; }
    const mode = v && v.mode;
    const days = Number(v && v.days);
    if (!RULE_MODES.includes(mode)) { errs.push(`${V.stageLabel(st)}: choose how the due date is set`); return; }
    if (mode !== 'none' && (!Number.isInteger(days) || days < 0 || days > 60)) { errs.push(`${V.stageLabel(st)}: days must be a whole number from 0 to 60`); return; }
    next[st] = { mode, days: mode === 'none' ? 0 : days };
  });
  if (errs.length) return { error: errs.join('; ') };
  let { confirmed } = cur;
  let { confirmedAt, confirmedBy } = cur;
  if (body.confirm === true) { confirmed = true; confirmedAt = new Date().toISOString(); confirmedBy = user.name || user.id; }
  if (body.confirm === false) { confirmed = false; confirmedAt = null; confirmedBy = null; }
  const values = {
    confirmed, confirmedAt, confirmedBy, rules: next, updatedAt: new Date().toISOString(), updatedBy: user.name || user.id,
  };
  await prisma.integration.upsert({
    where: { id: RULES_STORE },
    create: { id: RULES_STORE, enabled: true, state: 'Internal', values: JSON.stringify(values) },
    update: { values: JSON.stringify(values) },
  });
  RULES_CACHE = null;
  const changed = RULE_STAGES.filter((st) => cur.rules[st].mode !== next[st].mode || cur.rules[st].days !== next[st].days);
  await logAudit({
    userId: user.id,
    actorName: user.name,
    action: body.confirm === true ? 'Follow-up due rules confirmed' : (body.confirm === false ? 'Follow-up due rules set back to suggested (not in use)' : 'Follow-up due rules edited'),
    entity: 'Integration',
    entityId: RULES_STORE,
    toValue: changed.length
      ? changed.map((st) => `${V.stageLabel(st)}: ${next[st].mode === 'none' ? 'none' : `${next[st].days} ${RULE_MODE_LABEL[next[st].mode]}`}`).join('; ')
      : (confirmed ? 'confirmed, no rule changed' : 'no rule changed'),
  });
  return { table: await rulesTable() };
}

// The rule-based due date for one application (only when confirmed).
function ruleDueDate(rules, { stage, lastDay, enteredDay, interviewDay, joiningDay }) {
  if (!rules || !rules.confirmed) return null;
  const r = rules.rules[stage];
  if (!r || r.mode === 'none') return null;
  if (r.mode === 'before_interview') return interviewDay ? addDays(interviewDay, -r.days) : null;
  if (r.mode === 'before_joining') return joiningDay ? addDays(joiningDay, -r.days) : null;
  const base = [lastDay, enteredDay].filter(Boolean).sort().pop();
  return base ? addDays(base, r.days) : null;
}

// ---------------------------------------------------------------------------
// THE BADGE. `dueDate` = the open follow-up's due date (YYYY-MM-DD) or null.
// ---------------------------------------------------------------------------
const BADGES = {
  not_followed: { key: 'not_followed', label: 'Not followed up', tone: 'red' },
  due_today: { key: 'due_today', label: 'Due today', tone: 'orange' },
  followed: { key: 'followed', label: 'Followed up', tone: 'green' },
};

function contactStatus({
  stage, contact, followUpDue = null, rules = null, enteredAt = null, interviewAt = null, joiningDate = null, today = todayIst(),
}) {
  const lastDay = contact ? istDay(contact.at) : null;
  const daysAgo = lastDay ? Math.max(0, daysBetween(lastDay, today)) : null;
  const out = {
    lastContactAt: contact ? new Date(contact.at).toISOString() : null,
    lastContactMode: contact ? contact.mode : null,
    lastContactBy: contact ? contact.by : null,
    lastContactOutcome: contact ? contact.outcome : null,
    lastContactDays: daysAgo,
    contactDue: null,
    contactDueSource: null,
    contactBadge: null,
  };
  if (!stage || CLOSED.includes(stage)) return out;
  let due = followUpDue ? String(followUpDue).slice(0, 10) : null;
  if (due) out.contactDueSource = 'follow-up';
  if (!due) {
    const jd = (/^(\d{4}-\d{2}-\d{2})/.exec(String(joiningDate || '')) || [])[1] || null;
    due = ruleDueDate(rules, {
      stage, lastDay, enteredDay: istDay(enteredAt), interviewDay: istDay(interviewAt), joiningDay: jd,
    });
    if (due) out.contactDueSource = 'stage-rule';
  }
  out.contactDue = due;
  if (!lastDay) out.contactBadge = { ...BADGES.not_followed, why: 'Never contacted' };
  else if (due && due < today && lastDay < due) out.contactBadge = { ...BADGES.not_followed, why: `Follow-up was due ${due}; no contact since` };
  else if (due && due === today && lastDay < today) out.contactBadge = { ...BADGES.due_today, why: 'Follow-up due today; not contacted today yet' };
  else out.contactBadge = { ...BADGES.followed, why: due ? `Contacted; next due ${due}` : 'Contacted' };
  return out;
}

// ?contact= filter values of the Candidates list.
const CONTACT_FILTERS = {
  never: { label: 'Never contacted', test: (r) => !r.lastContactAt },
  stale3: { label: 'Not contacted in 3 days', test: (r) => !r.lastContactAt || r.lastContactDays >= 3 },
  overdue: { label: 'Late follow-ups', test: (r) => !!(r.followUp && r.followUp.status === 'Overdue') },
  not_followed: { label: 'Not followed up', test: (r) => !!(r.contactBadge && r.contactBadge.key === 'not_followed') },
  due_today: { label: 'Follow-up due today', test: (r) => !!(r.contactBadge && r.contactBadge.key === 'due_today') },
  followed: { label: 'Followed up', test: (r) => !!(r.contactBadge && r.contactBadge.key === 'followed') },
};
function matchesContactFilter(value, row) {
  if (!value) return true;
  const wanted = String(value).split(',').map((x) => x.trim()).filter((x) => CONTACT_FILTERS[x]);
  if (!wanted.length) return true;
  return wanted.some((k) => CONTACT_FILTERS[k].test(row));
}

// ---------------------------------------------------------------------------
// FOR THE ATS DASHBOARD — "N candidates not followed up yet", scoped exactly
// like the Candidates list (utils/scope.js applicationWhere; ATS-pipeline
// applications only, Job Portal ones excluded), over ACTIVE applications (not
// Hold / Rejected / Joined) — the list's default Active tab.
//
//   never         distinct candidates never contacted  -> ?contact=never
//   notFollowed   distinct candidates with the red badge -> ?contact=not_followed
//   dueToday      distinct candidates due today          -> ?contact=due_today
// `link` opens exactly those rows on the Candidates page.
// ---------------------------------------------------------------------------
async function notFollowedUpSummary(user, { sample = 0 } = {}) {
  const { applicationWhere } = require('./scope'); // eslint-disable-line global-require
  const NA = require('./nextAction'); // eslint-disable-line global-require
  const snap = await NA.ensureNextActionContext();
  const [idx, rules, apps] = await Promise.all([
    contactIndex(snap.stamp),
    loadRules(),
    prisma.application.findMany({
      where: { AND: [applicationWhere(user), { stage: { notIn: [...CLOSED, 'HOLD'] } }, V.IN_ATS_WHERE] },
      select: {
        id: true, candidateId: true, stage: true, interviewAt: true, joiningDate: true, createdAt: true, updatedAt: true,
        candidate: { select: { name: true } },
      },
    }),
  ]);
  const today = todayIst();
  const sets = { never: new Set(), notFollowed: new Set(), dueToday: new Set() };
  const rows = [];
  apps.forEach((a) => {
    const fu = snap.openFu.get(a.id) || null;
    const st = contactStatus({
      stage: a.stage,
      contact: lastContactOf(idx, a.id, a.candidateId),
      followUpDue: fu && fu.dueDate,
      rules,
      enteredAt: NA.stageEnteredAt(a, snap),
      interviewAt: a.interviewAt,
      joiningDate: a.joiningDate,
      today,
    });
    if (!st.lastContactAt) sets.never.add(a.candidateId);
    if (st.contactBadge && st.contactBadge.key === 'not_followed') {
      sets.notFollowed.add(a.candidateId);
      if (sample && rows.length < sample) rows.push({ applicationId: a.id, candidateId: a.candidateId, name: a.candidate && a.candidate.name, why: st.contactBadge.why });
    }
    if (st.contactBadge && st.contactBadge.key === 'due_today') sets.dueToday.add(a.candidateId);
  });
  return {
    activeApplications: apps.length,
    never: sets.never.size,
    notFollowed: sets.notFollowed.size,
    dueToday: sets.dueToday.size,
    rulesConfirmed: rules.confirmed,
    links: {
      never: '/candidates?view=pipeline&sub=active&contact=never',
      notFollowed: '/candidates?view=pipeline&sub=active&contact=not_followed',
      dueToday: '/candidates?view=pipeline&sub=active&contact=due_today',
    },
    ...(sample ? { sample: rows } : {}),
  };
}

module.exports = {
  CONTACT_CHANNELS,
  CONTACT_FILTERS,
  RULE_MODES,
  SUGGESTED_RULES,
  contactIndex,
  touchContactIndex,
  lastContactOf,
  contactStatus,
  matchesContactFilter,
  loadRules,
  rulesTable,
  saveRules,
  notFollowedUpSummary,
  istDay,
  todayIst,
};
