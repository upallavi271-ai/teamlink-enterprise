import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../Modal.jsx';

// ---------------------------------------------------------------------------
// FIRST LOGIN — a 3-step tour (spec §3): "This is your work. These are
// candidates. This is search." Shown once per person (this browser), on the
// dashboard; Skip ends it at once.
// ---------------------------------------------------------------------------
const KEY = (user) => `tl_tour_done_${user && user.id}`;
export function tourPending(user) {
  if (!user || !user.id) return false;
  try { return !localStorage.getItem(KEY(user)); } catch { return false; }
}
function finish(user) { try { localStorage.setItem(KEY(user), new Date().toISOString()); } catch { /* no storage */ } }

const WORK = {
  recruiter: 'Your jobs and your candidates. “Do this now” lists what to do first.',
  tl: 'Your team’s work. “Waiting for my check” is the list you act on.',
  bde: 'Your clients. The top lines show which clients owe you feedback.',
  hr: 'Who needs your check, offers and joinings.',
};

export default function FirstTour({ user, layout }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(() => tourPending(user));
  if (!open) return null;
  const steps = [
    { title: '1 of 3 · This is your work', text: `${WORK[layout] || 'How your area is doing and where the problems are.'} Click any number to see the list behind it, right here.` },
    { title: '2 of 3 · These are candidates', text: 'Candidates shows every person and the step they are at. Open one to call, message or move them on.', to: '/candidates', go: 'Open Candidates' },
    { title: '3 of 3 · This is search', text: 'Search finds any person, job or client by name, phone or skill.', to: '/ats/search', go: 'Open Search' },
  ];
  const s = steps[step];
  const close = () => { finish(user); setOpen(false); };
  const last = step === steps.length - 1;
  return (
    <Modal
      title={s.title}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={close}>Skip</button>
          {s.to && <button type="button" className="btn" onClick={() => { close(); navigate(s.to); }}>{s.go}</button>}
          <button type="button" className="btn btn-primary" onClick={() => (last ? close() : setStep(step + 1))}>{last ? 'Done' : 'Next →'}</button>
        </>
      )}
    >
      <p style={{ fontSize: 15, lineHeight: 1.5, margin: 0 }}>{s.text}</p>
    </Modal>
  );
}
