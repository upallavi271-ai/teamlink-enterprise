import StatusChip from '../ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// THE JOB STATUS CHAIN PEOPLE SEE (ATS layout v3, 2026-10-03):
//
//   Draft → Agreement Approved → Assigned → Open → On Hold → Filled / Closed
//
// A display label only; the stored status never changes. The server computes
// it (backend/src/utils/requirementDisplayStatus.js → row.displayStatus) and
// filters by it (?dstatus=). This mirror is for a row that has no
// displayStatus yet (an older response) — same rule, same words.
// Colours: yellow waiting · blue going on · green filled · grey closed.
// ---------------------------------------------------------------------------
export const JOB_STATUSES = [
  { key: 'draft', label: 'Draft', tone: 'amber', hint: 'Not live yet. Waits for the client agreement.' },
  { key: 'approved', label: 'Agreement Approved', tone: 'amber', hint: 'Live, but no recruiter on it yet.' },
  { key: 'assigned', label: 'Assigned', tone: 'blue', hint: 'A recruiter is on it. No people added yet.' },
  { key: 'open', label: 'Open', tone: 'blue', hint: 'People are being worked on this job.' },
  { key: 'hold', label: 'On Hold', tone: 'amber', hint: 'Paused for now.' },
  { key: 'filled', label: 'Filled', tone: 'green', hint: 'Closed. People joined.' },
  { key: 'closed', label: 'Closed', tone: 'grey', hint: 'Closed. Nobody joined.' },
];
const BY_KEY = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s]));
const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];

export const jobStatusByKey = (k) => BY_KEY[k] || null;

// r: a job row. Uses the server's displayStatus when it is there.
export function jobStatusOf(r) {
  if (!r) return null;
  if (r.displayStatus && r.displayStatus.key) return r.displayStatus;
  const s = r.status;
  const people = Number(r.candidates ?? r.pipeline?.candidates ?? 0);
  const joined = Number(r.filled ?? r.pipeline?.joined ?? 0);
  let key = null;
  if (s === 'DRAFT' || s === 'AGREEMENT_CHECK') key = 'draft';
  else if (s === 'ON_HOLD') key = 'hold';
  else if (s === 'CLOSED') key = joined > 0 ? 'filled' : 'closed';
  else if (LIVE.includes(s)) {
    const rec = r.recruiterId || String(r.recruiterIds || '').trim() || (r.coRecruiters || []).length;
    key = people > 0 ? 'open' : rec ? 'assigned' : 'approved';
  }
  return key ? BY_KEY[key] : { key: 'other', label: s || '—', tone: 'grey', hint: '' };
}

export function JobStatusChip({ job, status }) {
  const ds = status || jobStatusOf(job);
  if (!ds) return <span className="cell-muted">—</span>;
  return <StatusChip status={ds.label} tone={ds.tone} title={ds.hint || undefined} />;
}
