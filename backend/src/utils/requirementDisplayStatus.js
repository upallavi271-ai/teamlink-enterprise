// ---------------------------------------------------------------------------
// THE JOB STATUS CHAIN SHOWN TO PEOPLE (ATS layout v3, 2026-10-03):
//
//   Draft → Agreement Approved → Assigned → Open → On Hold → Filled / Closed
//
// A DISPLAY label only. The stored Requirement.status values do not change
// (DRAFT · AGREEMENT_CHECK · OPEN · RECRUITER_ASSIGNED · SOURCING ·
// CANDIDATES_AVAILABLE · ON_HOLD · CLOSED); the label is read off them plus
// the job's own data:
//
//   draft     DRAFT / AGREEMENT_CHECK — not live yet (waiting for the agreement)
//   approved  live, nobody has a recruiter on it yet and no people yet
//   assigned  live, a recruiter (or co-recruiter) is on it, no people yet
//   open      live, people are being worked on it
//   hold      ON_HOLD
//   filled    CLOSED with at least one person joined
//   closed    CLOSED with nobody joined
//
// The SAME rule exists twice — as a Prisma where (WHERE_OF, used by the
// ?dstatus= filter and the summary counts) and in JS for a row already in
// memory (displayStatusOf) — so a number on a card and the list it opens can
// never disagree. The frontend mirror is components/jobs/reqStatus.js.
// ---------------------------------------------------------------------------
const { REQUIREMENT_LIVE_STATUSES } = require('./atsVocab');

const JOINED_STAGES = ['JOINED', 'HIRED'];
const DRAFT_CODES = ['DRAFT', 'AGREEMENT_CHECK'];

const DISPLAY_STATUSES = [
  { key: 'draft', label: 'Draft', tone: 'amber', hint: 'Not live yet. Waits for the client agreement.' },
  { key: 'approved', label: 'Agreement Approved', tone: 'amber', hint: 'Live, but no recruiter on it yet.' },
  { key: 'assigned', label: 'Assigned', tone: 'blue', hint: 'A recruiter is on it. No people added yet.' },
  { key: 'open', label: 'Open', tone: 'blue', hint: 'People are being worked on this job.' },
  { key: 'hold', label: 'On Hold', tone: 'amber', hint: 'Paused for now.' },
  { key: 'filled', label: 'Filled', tone: 'green', hint: 'Closed. People joined.' },
  { key: 'closed', label: 'Closed', tone: 'grey', hint: 'Closed. Nobody joined.' },
];
const BY_KEY = Object.fromEntries(DISPLAY_STATUSES.map((s) => [s.key, s]));

const LIVE = { status: { in: REQUIREMENT_LIVE_STATUSES } };
const NO_RECRUITER = { AND: [{ recruiterId: null }, { OR: [{ recruiterIds: null }, { recruiterIds: '' }] }] };
const HAS_RECRUITER = { OR: [{ recruiterId: { not: null } }, { AND: [{ recruiterIds: { not: null } }, { recruiterIds: { not: '' } }] }] };
const WHERE_OF = {
  draft: { status: { in: DRAFT_CODES } },
  approved: { AND: [LIVE, { applications: { none: {} } }, NO_RECRUITER] },
  assigned: { AND: [LIVE, { applications: { none: {} } }, HAS_RECRUITER] },
  open: { AND: [LIVE, { applications: { some: {} } }] },
  hold: { status: 'ON_HOLD' },
  filled: { AND: [{ status: 'CLOSED' }, { applications: { some: { stage: { in: JOINED_STAGES } } } }] },
  closed: { AND: [{ status: 'CLOSED' }, { applications: { none: { stage: { in: JOINED_STAGES } } } }] },
};

const csvHas = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).length > 0;

// r: { status, recruiterId, recruiterIds } · people: how many applications
// the job has (all of them, not one login's slice) · joined: how many joined.
function displayKeyOf(r, people, joined) {
  if (!r) return null;
  const s = r.status;
  if (DRAFT_CODES.includes(s)) return 'draft';
  if (s === 'ON_HOLD') return 'hold';
  if (s === 'CLOSED') return joined > 0 ? 'filled' : 'closed';
  if (REQUIREMENT_LIVE_STATUSES.includes(s)) {
    if (people > 0) return 'open';
    return r.recruiterId || csvHas(r.recruiterIds) ? 'assigned' : 'approved';
  }
  return null;
}

function displayStatusOf(r, people, joined) {
  const key = displayKeyOf(r, people, joined);
  const def = key ? BY_KEY[key] : null;
  return def ? { ...def } : { key: 'other', label: String((r && r.status) || '—'), tone: 'grey', hint: '' };
}

module.exports = {
  DISPLAY_STATUSES, DISPLAY_WHERE: WHERE_OF, displayKeyOf, displayStatusOf, JOINED_STAGES,
};
