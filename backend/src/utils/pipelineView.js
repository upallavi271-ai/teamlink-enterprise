// ---------------------------------------------------------------------------
// Pipeline PRESENTATION grouping.
//
// Twenty stage codes is the right amount of detail to STORE and the wrong
// amount to SHOW. This file folds the eighteen ordered stage codes into the ten
// stages a user actually reads on the Candidates screen:
//
//   New → AI Interview → Recruiter Review → BDE Review → Client Review
//       → Interview → Selected → Offer → Joining → Joined
//
// NOTHING here changes the pipeline. The stage codes in utils/atsVocab.js, the
// transitions in routes/applications.js and the STAGE_OWNERS guard are all
// untouched — a group is only a label over codes that already exist. The
// detailed statuses stay reachable: `stageDetail()` returns the precise status
// inside the group (for Interview, the interview lifecycle status), and the
// Candidate Detail screen lists every underlying code per group.
//
// Hold and Rejected are deliberately NOT groups. They are VIEWS — filters over
// the same records — because a held or rejected candidate has not moved to a
// different part of the process, they have paused or left it.
// ---------------------------------------------------------------------------

const {
  STAGE_LABELS, stageLabel, INTERVIEW_STATUS_CODES, INTERVIEW_STATUS_LABELS,
  interviewStatusLabel, STAGE_CODES,
} = require('./atsVocab');

// The visible pipeline, in order. `stages` are the underlying codes folded in.
const STAGE_GROUPS = [
  { id: 'new', label: 'New', stages: ['NEW'] },
  {
    id: 'ai_interview',
    label: 'AI Interview',
    stages: ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'],
  },
  { id: 'recruiter_review', label: 'Recruiter Review', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  { id: 'bde_review', label: 'BDE Review', stages: ['WITH_BDE', 'BDE_APPROVED'] },
  {
    id: 'client_review',
    label: 'Client Review',
    stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'],
  },
  {
    id: 'interview',
    label: 'Interview',
    stages: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'],
    // Inside Interview the detailed status is the interview lifecycle, not the
    // stage code: Scheduled, Confirmed, Started, Completed, Pending Feedback,
    // Rescheduled, No Show, Cancelled (utils/atsVocab.js INTERVIEW_STATUS_CODES).
    interviewStatuses: INTERVIEW_STATUS_CODES,
  },
  { id: 'selected', label: 'Selected', stages: ['SELECTED'] },
  { id: 'offer', label: 'Offer', stages: ['OFFER'] },
  { id: 'joining', label: 'Joining', stages: ['OFFER_ACCEPTED'] },
  { id: 'joined', label: 'Joined', stages: ['JOINED', 'HIRED'] },
];

// Rejected and Hold are outside the visible chain; they surface as views.
const OFF_PIPELINE = {
  REJECTED: { id: 'rejected', label: 'Rejected' },
  HOLD: { id: 'hold', label: 'Hold' },
};

const GROUP_OF_STAGE = {};
STAGE_GROUPS.forEach((g) => g.stages.forEach((s) => { GROUP_OF_STAGE[s] = g; }));

// Sanity: every ordered stage code must land in exactly one visible group, or
// a candidate would vanish from the board. Checked at require time.
const unmapped = STAGE_CODES.filter((s) => !GROUP_OF_STAGE[s]);
if (unmapped.length) {
  throw new Error(`pipelineView: stage codes not folded into a group: ${unmapped.join(', ')}`);
}

function groupOfStage(stage) {
  if (!stage) return null;
  if (OFF_PIPELINE[stage]) return OFF_PIPELINE[stage];
  return GROUP_OF_STAGE[stage] || null;
}

function groupIdOfStage(stage) {
  const g = groupOfStage(stage);
  return g ? g.id : null;
}

function groupLabelOfStage(stage) {
  const g = groupOfStage(stage);
  return g ? g.label : stageLabel(stage);
}

// The precise status WITHIN the visible group — the detail that used to be a
// top-level stage. For the Interview group that is the interview lifecycle
// status; everywhere else it is the underlying stage's own label.
function stageDetail(application) {
  if (!application || !application.stage) return null;
  const g = groupOfStage(application.stage);
  if (g && g.id === 'interview' && application.interviewStatus) {
    return interviewStatusLabel(application.interviewStatus);
  }
  return stageLabel(application.stage);
}

// How far along the visible pipeline a stage sits (-1 for Hold / Rejected /
// unknown). Used for the stage strip and for "reached" analytics.
function groupIndex(stage) {
  const g = GROUP_OF_STAGE[stage];
  if (!g) return -1;
  return STAGE_GROUPS.findIndex((x) => x.id === g.id);
}

// Index along the full 18-code chain, for "did this candidate ever reach X".
const STAGE_ORDER = {};
STAGE_CODES.forEach((s, i) => { STAGE_ORDER[s] = i; });
function stageIndex(stage) {
  return STAGE_ORDER[stage] == null ? -1 : STAGE_ORDER[stage];
}

// The six views the Candidates screen offers. Hold and Rejected are here, not
// in STAGE_GROUPS, because they are filters and not steps.
const CANDIDATE_VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'hold', label: 'Hold' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'selected', label: 'Selected' },
  { id: 'joined', label: 'Joined' },
];

// Which view a stage belongs to. `all` matches everything.
function matchesView(viewId, stage) {
  if (!viewId || viewId === 'all') return true;
  switch (viewId) {
    case 'hold': return stage === 'HOLD';
    case 'rejected': return stage === 'REJECTED';
    case 'selected': return ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(stage);
    case 'joined': return ['JOINED', 'HIRED'].includes(stage);
    case 'active': return !['HOLD', 'REJECTED', 'JOINED', 'HIRED'].includes(stage) && !!stage;
    default: return true;
  }
}

// The group list with the codes inside each one spelled out, so a screen can
// say "Interview contains: Scheduled, Confirmed, …" without re-deriving it.
function groupsWithDetail() {
  return STAGE_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    stages: g.stages.map((s) => ({ code: s, label: STAGE_LABELS[s] || s })),
    statuses: g.interviewStatuses
      ? g.interviewStatuses.map((s) => ({ code: s, label: INTERVIEW_STATUS_LABELS[s] || s }))
      : [],
  }));
}

module.exports = {
  STAGE_GROUPS,
  OFF_PIPELINE,
  CANDIDATE_VIEWS,
  groupOfStage,
  groupIdOfStage,
  groupLabelOfStage,
  stageDetail,
  groupIndex,
  stageIndex,
  matchesView,
  groupsWithDetail,
};
