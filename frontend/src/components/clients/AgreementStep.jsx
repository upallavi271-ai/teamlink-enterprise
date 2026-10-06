import StatusChip from '../ui/StatusChip.jsx';
import './agreementStep.css';

// ---------------------------------------------------------------------------
// SPEC 6 — THE AGREEMENT STEP, one badge everywhere.
//
//   Draft → Sent → Viewed → Signed → Active → Expired
//
// Four colours only (simple-UX rule): orange = waiting (Draft), blue = going
// on (Sent / Viewed / Signed), green = done (Active), red = problem (Expired /
// Rejected). "Client Confirmation Pending" reads as Viewed — the client has
// it open and has not signed yet.
// ---------------------------------------------------------------------------
export const AGREEMENT_STEPS = [
  ['DRAFT', 'Draft'],
  ['SENT', 'Sent'],
  ['VIEWED', 'Viewed'],
  ['SIGNED', 'Signed'],
  ['ACTIVE', 'Active'],
  ['EXPIRED', 'Expired'],
];

const ALIAS = { CLIENT_CONFIRMATION_PENDING: 'VIEWED', CONFIRMED: 'SIGNED', CANCELLED: 'REJECTED' };
export const agreementStepOf = (code) => ALIAS[code] || code || 'DRAFT';

export function agreementStepLabel(code) {
  const s = agreementStepOf(code);
  if (s === 'REJECTED') return 'Rejected';
  return (AGREEMENT_STEPS.find(([k]) => k === s) || [s, s])[1];
}

export function agreementStepTone(code) {
  const s = agreementStepOf(code);
  if (s === 'ACTIVE') return 'green';
  if (s === 'EXPIRED' || s === 'REJECTED') return 'red';
  if (s === 'DRAFT') return 'amber';
  return 'blue';
}

// What the step means, in one short line.
export const AGREEMENT_STEP_HINT = {
  DRAFT: 'Ready, not sent yet',
  SENT: 'With the client',
  VIEWED: 'The client opened it',
  SIGNED: 'Signed — make it active',
  ACTIVE: 'Jobs can go live',
  EXPIRED: 'Ended — renew it',
  REJECTED: 'The client said no',
};

export function AgreementStepChip({ status, title }) {
  const s = agreementStepOf(status);
  return <StatusChip status={agreementStepLabel(s)} tone={agreementStepTone(s)} title={title || AGREEMENT_STEP_HINT[s] || ''} />;
}

// The six steps in a row, the current one highlighted, done ones ticked.
export function AgreementStepper({ status }) {
  const s = agreementStepOf(status);
  const order = AGREEMENT_STEPS.map(([k]) => k);
  const at = s === 'REJECTED' ? 2 : order.indexOf(s);
  return (
    <ol className="agrstep-row" aria-label="Agreement steps">
      {AGREEMENT_STEPS.map(([k, label], i) => {
        const state = i < at ? 'done' : i === at ? 'now' : 'next';
        return (
          <li key={k} className={`agrstep agrstep-${state} agrstep-tone-${i === at ? agreementStepTone(s) : 'none'}`}>
            <span className="agrstep-dot">{state === 'done' ? '✓' : i + 1}</span>
            <span className="agrstep-label">{i === at && s === 'REJECTED' ? 'Rejected' : label}</span>
          </li>
        );
      })}
    </ol>
  );
}
