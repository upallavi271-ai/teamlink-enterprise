// ---------------------------------------------------------------------------
// "ALREADY ON THIS JOB" (founder, 2026-10-16).
//
// A second "Add application" for the same person + job used to fail with one
// small red line, and the search boxes hid the person, so nobody could tell WHERE
// the existing application was. Now:
//
//   * the server answers 409 ALREADY_APPLIED { application, others }; api.js opens
//     <AlreadyAppliedPanel> for EVERY add button at once (openAlreadyApplied)
//   * the add dialogs ask GET /applications/pair-check as soon as a person + job
//     are picked and show <AlreadyAppliedNotice> BEFORE the click (usePairCheck)
//
// The panel says who, which job at which client, the step, the date and who added
// it, with [Open this application] and [Close]; their applications on OTHER jobs
// are listed (each row opens). No phone / email / salary ever comes in this data.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../../api';
import './alreadyApplied.css';

const when = (a) => a.addedOnText || (a.addedOn ? String(a.addedOn).slice(0, 10) : '');

// Go to an application's screen without a page reload (the app uses BrowserRouter).
export function goToApplication(link) {
  if (!link) return;
  try {
    window.history.pushState({}, '', link);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {
    window.location.assign(link);
  }
}

export function sentenceOf(name, a) {
  const where = [a.requirementTitle, a.clientName].filter(Boolean).join(' at ');
  return `${name || 'This person'} is on ${where}, step ${a.step}${when(a) ? `, added ${when(a)}` : ''}${a.addedBy ? ` by ${a.addedBy}` : ''}.`;
}

const STATE_NOTE = {
  Rejected: 'This application was rejected. Open it to see why. Moving it to an earlier step re-opens it, for the people who have that right.',
  'On hold': 'This application is on hold. Open it to see the review date and to bring it back.',
  'Job closed': 'The requirement is closed now.',
  'Job paused': 'The requirement is paused now.',
};

function Details({ a }) {
  return (
    <div className="aap-kv">
      <span>Requirement</span><b>{`${a.requirementTitle}${a.requirementCode ? ` (${a.requirementCode})` : ''}`}</b>
      {a.clientName && (<><span>Client</span><b>{a.clientName}</b></>)}
      <span>Step</span><b>{a.step}{a.status && a.status !== 'Active' && a.status !== a.step ? ` · ${a.status}` : ''}</b>
      {when(a) && (<><span>Added on</span><b>{when(a)}</b></>)}
      {a.addedBy && (<><span>Added by</span><b>{a.addedBy}</b></>)}
      {a.recruiterName && (<><span>Recruiter</span><b>{a.recruiterName}</b></>)}
      {a.tlName && (<><span>Team lead</span><b>{a.tlName}</b></>)}
    </div>
  );
}

function OthersTable({ others, onOpen }) {
  if (!others || !others.length) return null;
  return (
    <>
      <div className="aap-h">{`Also on ${others.length} other requirement${others.length > 1 ? 's' : ''}`}</div>
      <table className="aap-others">
        <thead><tr><th>Requirement</th><th>Client</th><th>Step</th><th>Added</th></tr></thead>
        <tbody>
          {others.map((o) => (
            <tr key={o.id} className="row-link" tabIndex={0} onClick={() => onOpen(o)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(o); }}>
              <td>{`${o.requirementTitle}${o.requirementCode ? ` (${o.requirementCode})` : ''}`}</td>
              <td>{o.clientName || '—'}</td>
              <td>{o.step}</td>
              <td>{when(o)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function AlreadyAppliedPanel({ info, onClose }) {
  const a = info.application;
  const open = (x) => { onClose(); goToApplication(x.link); };
  const name = info.candidate && info.candidate.name;
  return (
    <div className="overlay show" role="dialog" aria-modal="true" aria-labelledby="aap-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal aap">
        <div className="modal-head">
          <h3 id="aap-title" style={{ margin: 0, fontSize: 16 }}>Already on this requirement</h3>
          <button type="button" className="close-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <p className="aap-lead">{sentenceOf(name, a)}</p>
          <div className={`aap-box${a.status === 'Rejected' ? ' is-bad' : ''}`}>
            <Details a={a} />
            {STATE_NOTE[a.status] && <div className="aap-note">{STATE_NOTE[a.status]}</div>}
          </div>
          <OthersTable others={info.others} onOpen={open} />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" autoFocus onClick={() => open(a)}>Open this application</button>
        </div>
      </div>
    </div>
  );
}

let openNow = false;
export function openAlreadyApplied(info) {
  if (!info || !info.application || openNow) return;
  openNow = true;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const done = () => { root.unmount(); host.remove(); openNow = false; };
  root.render(<AlreadyAppliedPanel info={info} onClose={done} />);
}

// ---- BEFORE the click: the small notice inside the add dialogs ---------------------------------------------------
// usePairCheck(candidateId, requirementId) -> { exists, application, others, blocked, loading }
const FREE = { exists: false, application: null, others: [], blocked: null, loading: false };
export function usePairCheck(candidateId, requirementId) {
  const [state, setState] = useState(FREE);
  useEffect(() => {
    if (!candidateId || !requirementId) { setState(FREE); return undefined; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api.get('/applications/pair-check', { params: { candidateId, requirementId } })
        .then((r) => { if (live) setState({ ...r.data, loading: false }); })
        .catch(() => { if (live) setState(FREE); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [candidateId, requirementId]);
  return state;
}

// <AlreadyAppliedNotice check={usePairCheck(...)} name="Asha" />: nothing when the pair is free.
export function AlreadyAppliedNotice({ check, name }) {
  if (!check) return null;
  if (check.exists && check.application) {
    const a = check.application;
    return (
      <div className="aap-box aap-inline" role="status">
        <b>Already on this requirement.</b>
        {` ${sentenceOf(name, a)}`}
        <button type="button" className="btn btn-sm" onClick={() => goToApplication(a.link)}>Open this application</button>
        {STATE_NOTE[a.status] && <div className="aap-note">{STATE_NOTE[a.status]}</div>}
      </div>
    );
  }
  if (check.blocked) {
    return <div className="aap-box is-bad aap-inline" role="status">{check.blocked.error}</div>;
  }
  return null;
}

// A row in a result list: "Already on this job, step X" with the link (the job page search, the pickers).
export function OnJobChip({ onJob }) {
  if (!onJob) return null;
  return (
    <span className="aap-inline" style={{ margin: 0 }}>
      <span className="small-muted">{`Already on this requirement · step ${onJob.step}`}</span>
      <button type="button" className="btn btn-sm" onClick={() => goToApplication(onJob.link)}>Open this application</button>
    </span>
  );
}
