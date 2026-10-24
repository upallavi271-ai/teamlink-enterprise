import { stepper } from '../pages/vendor/billUploadLogic.js';
import '../pages/vendor/billUploads.css';

// The small stepper of an uploaded bill: Not sent yet -> Uploaded -> AI reading -> Needs review / Waiting for approval -> Approved -> Synced.
// Used on the vendor's "My bills" and on Accounts' review screen. Text always says where the bill is (colour is never the only signal).
export default function BillSteps({ status }) {
  const steps = stepper(status);
  return (
    <ol className="vm-steps bu-steps" aria-label="Where this bill is">
      {steps.map((s) => (
        <li key={s.label} className={s.state === 'done' ? 'done' : (s.state === 'now' ? 'now' : (s.state === 'bad' ? 'bad' : ''))} aria-current={s.state === 'now' || s.state === 'bad' ? 'step' : undefined}>
          {s.state === 'done' ? '✓ ' : ''}{s.label}
        </li>
      ))}
    </ol>
  );
}
