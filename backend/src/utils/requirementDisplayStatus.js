// ---------------------------------------------------------------------------
// THE ONLY TWO JOB STATES PEOPLE SEE (user, 2026-10-13): OPEN and CLOSED.
// "Nothing else should exist."
//
// A DISPLAY label only. The stored Requirement.status values do not change
// (DRAFT · AGREEMENT_CHECK · OPEN · RECRUITER_ASSIGNED · SOURCING ·
// CANDIDATES_AVAILABLE · ON_HOLD · CLOSED) and every engine rule keeps reading
// them. The label is read off them like this:
//
//   open    every stored status except CLOSED (Draft, Agreement Check, On Hold,
//           Open, Recruiter Assigned, Sourcing, Candidates Available)
//   closed  CLOSED  (the WHY - Filled / Client cancelled / On hold-paused /
//           Other - is a close REASON kept with the close, not a status)
//
// `note` is plain job-page TEXT (never a status, never a filter) that explains
// why an Open job is not live yet: "Waiting for the agreement", "Paused".
//
// The SAME rule exists twice - as a Prisma where (DISPLAY_WHERE, used by the
// ?dstatus= filter and the summary counts) and in JS for a row already in
// memory (displayStatusOf) - so a number on a card and the list it opens can
// never disagree. The frontend mirror is components/jobs/reqStatus.jsx.
// ---------------------------------------------------------------------------
const { REQUIREMENT_LIVE_STATUSES } = require('./atsVocab');

const JOINED_STAGES = ['JOINED', 'HIRED'];
const DRAFT_CODES = ['DRAFT', 'AGREEMENT_CHECK'];

const DISPLAY_STATUSES = [
  { key: 'open', label: 'Open', tone: 'blue', hint: 'This requirement is open.' },
  { key: 'closed', label: 'Closed', tone: 'grey', hint: 'This requirement is closed. You can reopen it.' },
];
const BY_KEY = Object.fromEntries(DISPLAY_STATUSES.map((s) => [s.key, s]));

const WHERE_OF = {
  open: { status: { not: 'CLOSED' } },
  closed: { status: 'CLOSED' },
};

// Old links (?dstatus=draft|approved|assigned|hold|filled) keep working: they fold into Open / Closed.
const ALIAS = { draft: 'open', approved: 'open', assigned: 'open', hold: 'open', filled: 'closed', live: 'open' };
const normKey = (k) => (BY_KEY[k] ? k : ALIAS[k] || null);

// Plain words that explain a not-live Open job (job-page text only).
function noteOf(status) {
  if (DRAFT_CODES.includes(status)) return status === 'AGREEMENT_CHECK' ? 'Not live yet: waiting for the client agreement.' : 'Not live yet: still being prepared.';
  if (status === 'ON_HOLD') return 'Paused for now. Resume it when ready.';
  return '';
}

function displayKeyOf(r) {
  if (!r) return null;
  return r.status === 'CLOSED' ? 'closed' : 'open';
}

// (people / joined are kept in the signature: older callers pass them.)
function displayStatusOf(r) {
  const key = displayKeyOf(r);
  const def = key ? BY_KEY[key] : null;
  if (!def) return { key: 'open', label: 'Open', tone: 'blue', hint: '', note: '' };
  return { ...def, note: noteOf(r.status), live: REQUIREMENT_LIVE_STATUSES.includes(r.status) };
}

// A stored code as the one word a person may read in a list, export or sentence.
function userLabel(code) {
  return code === 'CLOSED' ? 'Closed' : 'Open';
}

module.exports = {
  DISPLAY_STATUSES, DISPLAY_WHERE: WHERE_OF, displayKeyOf, displayStatusOf, JOINED_STAGES, normKey, noteOf, userLabel,
};
