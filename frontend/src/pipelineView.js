// ---------------------------------------------------------------------------
// The browser's copy of the pipeline PRESENTATION grouping.
//
// Mirrors backend/src/utils/pipelineView.js. It decides nothing: the server
// sends stageGroup / stageGroupLabel / stageDetailLabel on every row, and this
// file exists so the screen can draw the strip, the view tabs and the
// "what's inside this stage" legend without a round trip.
//
// Twenty stage codes still exist and still drive the pipeline. Eleven are shown:
//
//   New → AI Interview → Recruiter Review → TL Review → BDE Review → Client Review
//       → Interview → Selected → Offer → Joining → Joined
//
// Hold and Rejected are VIEWS, not stages.
// ---------------------------------------------------------------------------
import { STAGE_LABELS, INTERVIEW_STATUS_LABELS } from './atsVocab';

export const STAGE_GROUPS = [
  { id: 'new', label: 'New', stages: ['NEW'] },
  {
    id: 'ai_interview',
    label: 'AI Interview',
    stages: ['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED', 'AI_INTERVIEW_COMPLETED'],
  },
  { id: 'recruiter_review', label: 'Check by recruiter', stages: ['RECRUITER_REVIEW', 'RECRUITER_APPROVED'] },
  // Mirrors backend utils/pipelineView.js: without this group a candidate at
  // TL Review had no place on the strip and fell back to the grey default.
  { id: 'tl_review', label: 'Check by team lead', stages: ['TL_REVIEW'] },
  { id: 'bde_review', label: 'Check by client manager', stages: ['WITH_BDE', 'BDE_APPROVED'] },
  { id: 'client_review', label: 'With client', stages: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'] },
  {
    id: 'interview',
    label: 'Interview',
    stages: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'],
    // The detailed statuses that used to sit at the top level now live in here.
    statuses: ['SCHEDULED', 'CONFIRMED', 'STARTED', 'COMPLETED', 'PENDING_FEEDBACK', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED'],
  },
  { id: 'selected', label: 'Selected', stages: ['SELECTED'] },
  { id: 'offer', label: 'Offer', stages: ['OFFER'] },
  { id: 'joining', label: 'Offer accepted', stages: ['OFFER_ACCEPTED'] }, // mirrors the backend (the actual workflow)
  { id: 'joined', label: 'Joined', stages: ['JOINED', 'HIRED'] },
];

// The six views the screen offers. Hold and Rejected are here — filters over
// the same list — rather than being eleventh and twelfth pipeline stages.
export const CANDIDATE_VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'hold', label: 'Hold' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'selected', label: 'Selected' },
  { id: 'joined', label: 'Joined' },
];

const GROUP_OF_STAGE = {};
STAGE_GROUPS.forEach((g) => g.stages.forEach((s) => { GROUP_OF_STAGE[s] = g; }));

export function groupOfStage(stage) {
  return GROUP_OF_STAGE[stage] || null;
}

export function matchesView(viewId, stage) {
  if (!viewId || viewId === 'all') return true;
  switch (viewId) {
    case 'hold': return stage === 'HOLD';
    case 'rejected': return stage === 'REJECTED';
    case 'selected': return ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(stage);
    case 'joined': return ['JOINED', 'HIRED'].includes(stage);
    case 'active': return !!stage && !['HOLD', 'REJECTED', 'JOINED', 'HIRED'].includes(stage);
    default: return true;
  }
}

// "Interview contains: Scheduled, Confirmed, Started, …" — the line that makes
// the folding legible instead of feeling like detail was deleted.
export function groupContents(group) {
  if (group.statuses) return group.statuses.map((s) => INTERVIEW_STATUS_LABELS[s] || s);
  return group.stages.map((s) => STAGE_LABELS[s] || s);
}

// The group's position, for drawing the strip as a progress chain.
export function groupIndexById(id) {
  return STAGE_GROUPS.findIndex((g) => g.id === id);
}

// Pill colour per visible group, reusing the existing .status classes.
// §30 status colours: a group the candidate is IN is the current workflow
// stage — blue. Selected / Joined are outcomes — green. Hold amber and
// Rejected red are handled below.
const GROUP_BADGE = {
  new: 'new',
  ai_interview: 'new',
  recruiter_review: 'new',
  tl_review: 'new',
  bde_review: 'new',
  client_review: 'new',
  interview: 'new',
  selected: 'selected',
  offer: 'new',
  joining: 'new',
  joined: 'joined',
};
export function groupBadgeClass(stage, groupId) {
  if (stage === 'REJECTED') return 'rejected';
  if (stage === 'HOLD') return 'hold';
  // The group id is normally on the row; derive it when only a stage is known.
  const id = groupId || (GROUP_OF_STAGE[stage] && GROUP_OF_STAGE[stage].id);
  return GROUP_BADGE[id] || 'new';
}
