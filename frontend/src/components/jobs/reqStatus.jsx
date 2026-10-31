import StatusChip from '../ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// THE ONLY TWO JOB STATES PEOPLE SEE (user, 2026-10-13): OPEN and CLOSED. "Nothing else should exist."
//
// A display label only; the stored status never changes (DRAFT, AGREEMENT_CHECK, ON_HOLD, OPEN, RECRUITER_ASSIGNED,
// SOURCING, CANDIDATES_AVAILABLE all read Open; CLOSED reads Closed). The server computes it
// (backend/src/utils/requirementDisplayStatus.js -> row.displayStatus) and filters by it (?dstatus=open|closed).
// This mirror is for a row that has no displayStatus yet (an older response) - same rule, same words.
// WHY a job closed (Filled / Client cancelled / On hold / Other) is a reason kept with the close, never a status.
// A plain sentence that explains an Open job that is not live yet ("Waiting for the client agreement") is TEXT on the
// job page (jobNoteOf), never a chip, a filter or a status.
// Colours: blue open - grey closed.
// ---------------------------------------------------------------------------
export const JOB_STATUSES = [
  { key: 'open', label: 'Open', tone: 'blue', hint: 'This requirement is open.' },
  { key: 'closed', label: 'Closed', tone: 'grey', hint: 'This requirement is closed. You can reopen it.' },
];
const BY_KEY = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s]));
// Old links (?dstatus=draft ...) fold into the two states.
const ALIAS = { draft: 'open', approved: 'open', assigned: 'open', hold: 'open', live: 'open', filled: 'closed' };

export const jobStatusByKey = (k) => BY_KEY[k] || BY_KEY[ALIAS[k]] || null;

// r: a job row. Uses the server's displayStatus when it is there.
export function jobStatusOf(r) {
  if (!r) return null;
  if (r.displayStatus && (r.displayStatus.key === 'open' || r.displayStatus.key === 'closed')) return r.displayStatus;
  return r.status === 'CLOSED' ? BY_KEY.closed : BY_KEY.open;
}

// OPEN = not CLOSED - the question every screen asks before it shows "Closed" or hides "Assign a recruiter" (founder
// 2026-10-30: "req open lo vunna kuda closed ani chupisthundhi (TL ki), assign cheyyadaniki raavatledhu"). `live` is
// narrower (it leaves out a job waiting for the client agreement, a draft, a paused one) and is for counting live work only.
export function isOpenJob(r) {
  if (!r) return false;
  if (r.status) return r.status !== 'CLOSED';
  if (r.displayStatus && r.displayStatus.key) return r.displayStatus.key !== 'closed';
  return r.live !== false;
}

// One plain sentence for an Open job that is not live yet (job page text, not a status).
export function jobNoteOf(r) {
  if (!r) return '';
  if (r.displayStatus && r.displayStatus.note) return r.displayStatus.note;
  if (r.status === 'AGREEMENT_CHECK') return 'Not live yet: waiting for the client agreement.';
  if (r.status === 'DRAFT') return 'Not live yet: still being prepared.';
  if (r.status === 'ON_HOLD') return 'Paused for now. Resume it when ready.';
  return '';
}

export function JobStatusChip({ job, status }) {
  const ds = status || jobStatusOf(job);
  if (!ds) return <span className="cell-muted">—</span>;
  const key = ds.key === 'closed' ? 'closed' : 'open';
  const def = BY_KEY[key];
  return <StatusChip status={def.label} tone={def.tone} title={def.hint} />;
}
