import { can, canMoveToStage, productRole } from '../../permissions.js';

// ---------------------------------------------------------------------------
// CONTEXTUAL ACTIONS (ATS review #3 §16) — ONE next valid action per row, for
// THIS viewer, and the secondary actions for the "⋯" menu.
//
// Nothing is re-decided here. The server says what the requirement is waiting
// on (row.nextActionKind + row.nextAction / row.owner, routes/requirements.js
// requirementNextAction) and what this login may do on the row (row.mayAssign
// / mayEdit / mayApprove, and the stages this login owns —
// user.workflow.allowedStages, resolved by the permission engine). The button
// is drawn only when the viewer owns that step; otherwise the row says who it
// is waiting on ("Waiting · TL review · Keerthana"). The API enforces every
// one of these regardless.
//
//   Recruiter   Review Candidates →         (owns Recruiter Review → TL Review)
//   TL          Approve / Return →          (owns TL Review → BDE)
//   BDE         Share with Client →         (owns BDE → Shared with Client)
//               Client Decision →           (owns the client's decision)
//   anyone      Assign Recruiter →          (row.mayAssign)
//   client desk Complete Agreement →        (agreement lifecycle permission)
// ---------------------------------------------------------------------------
const STAGES = {
  review: ['NEW', 'AI_INTERVIEW_COMPLETED', 'RECRUITER_REVIEW', 'RECRUITER_APPROVED'],
  'tl-review': ['TL_REVIEW'],
  share: ['WITH_BDE', 'BDE_APPROVED'],
  client: ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'],
  interview: ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'],
  joining: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'],
};
const cand = (r, kind) => `/candidates?requirementId=${encodeURIComponent(r.id)}${STAGES[kind] ? `&stage=${STAGES[kind].join(',')}` : ''}`;
const isOnRow = (r, user) => !!user && (r.mine || r.recruiterId === user.id || String(r.recruiterIds || '').split(',').includes(user.id));

// WHOSE STEP IT IS. The server names the owner's role (row.ownerRole:
// Recruiter / TL / BDE); the viewer gets the button only on their OWN role's
// step — a TL looking at a requirement waiting on its recruiter's review sees
// "Waiting · Review 3 candidate(s) · Kiran", not a Review button, even though
// a TL may technically move those stages. Super Admin / Admin act on any step.
const ROLE_STEP = {
  RECRUITER: ['Recruiter'],
  TL: ['TL'],
  STL: ['TL'],
  BDE: ['BDE'],
};
function ownsStep(r, user) {
  const role = productRole(user, 'ats');
  if (['SUPER_ADMIN', 'ADMIN'].includes(role) || ['SUPER_ADMIN', 'ADMIN'].includes(user && user.role)) return true;
  return (ROLE_STEP[role] || []).includes(r.ownerRole);
}

// { label, to } | { label, assign: true } | null
export function viewerNextAction(r, user) {
  const detail = `/requirements/${r.id}`;
  const stepKinds = ['source', 'review', 'tl-review', 'share', 'client', 'interview', 'joining'];
  if (stepKinds.includes(r.nextActionKind) && !ownsStep(r, user)) return null;
  switch (r.nextActionKind) {
    case 'agreement':
      return can(user, 'ats', 'clients', 'Agreement Lifecycle', 'edit') || can(user, 'ats', 'clients', 'Agreement Lifecycle', 'create')
        ? { label: 'Complete Agreement →', to: `/clients/${r.clientId}?tab=agreement` }
        : null;
    case 'assign':
      return r.mayAssign ? { label: 'Assign Recruiter →', assign: true } : null;
    case 'source':
      // Sourcing is the named recruiter's — or anyone global who may add to
      // the pipeline and is on the row.
      return (isOnRow(r, user) || r.mayEdit) && can(user, 'ats', 'candidates', 'Applications', 'create')
        ? { label: 'Source Candidates →', to: `${detail}?tab=candidates` }
        : null;
    case 'review':
      return canMoveToStage(user, 'TL_REVIEW') ? { label: 'Review Candidates →', to: cand(r, 'review') } : null;
    case 'tl-review':
      return canMoveToStage(user, 'WITH_BDE') ? { label: 'Approve / Return →', to: cand(r, 'tl-review') } : null;
    case 'share':
      return canMoveToStage(user, 'SHARED_WITH_CLIENT') ? { label: 'Share with Client →', to: cand(r, 'share') } : null;
    case 'client':
      return canMoveToStage(user, 'CLIENT_SHORTLISTED') || canMoveToStage(user, 'INTERVIEW_SCHEDULED')
        ? { label: 'Client Decision →', to: cand(r, 'client') } : null;
    case 'interview':
      return canMoveToStage(user, 'SELECTED') || canMoveToStage(user, 'INTERVIEW_COMPLETED')
        ? { label: 'Interview Feedback →', to: `${detail}?tab=interviews` } : null;
    case 'joining':
      return canMoveToStage(user, 'JOINED') ? { label: 'Confirm Joining →', to: cand(r, 'joining') } : null;
    default:
      return null;
  }
}

// The line under / instead of the button: what the row waits on, and who.
export function waitingText(r) {
  if (!r.nextAction) return '';
  return `${r.nextAction}${r.owner ? ` · ${r.owner}` : ''}`;
}

// "⋯" — secondary actions, each only when the server said this login may.
//   kinds: open, edit, assign-recruiter, assign-tl, hold, close, reopen, export
export function secondaryActions(r, { mayExport = false } = {}) {
  const out = [{ key: 'open', label: 'Open job' }];
  if (r.mayEdit) out.push({ key: 'edit', label: 'Edit job' });
  if (r.mayAssign) {
    out.push({ key: 'assign-recruiter', label: 'Assign recruiter' });
    out.push({ key: 'assign-tl', label: 'Assign team lead' });
  }
  if (r.mayApprove) {
    if (r.live) out.push({ key: 'hold', label: 'Pause' });
    if (r.status !== 'CLOSED') out.push({ key: 'close', label: 'Close job', danger: true });
    if (r.status === 'CLOSED' || r.status === 'ON_HOLD') out.push({ key: 'reopen', label: r.status === 'CLOSED' ? 'Reopen' : 'Resume' });
  }
  if (mayExport) out.push({ key: 'export', label: 'Export this job' });
  return out;
}
