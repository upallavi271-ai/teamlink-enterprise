// ---------------------------------------------------------------------------
// "ADD ANYWAY?" — the override reason box (B8, 2026-10-05).
//
// When someone adds a person who does not meet a job's rules (must-have
// skill, minimum Fit, notice, location), the server answers 409
// NEEDS_OVERRIDE. api.js catches that for every "Add to job" button in the
// app, opens this box, and on "Add anyway" sends the same request again with
// { overrideReason }. Cancel = nothing is added (the caller sees the error).
//
// askOverrideReason(info) → Promise<string | null>
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './match.css';

const QUICK = ['Client asked for this person', 'Strong in related skills', 'Will relocate', 'Can join earlier than the notice says'];
let lastReason = ''; // offered again in the next box (a bulk add asks once per person)

function OverrideBox({ info, onDone }) {
  const [reason, setReason] = useState(lastReason);
  const ok = reason.trim().length >= 5;
  return (
    <div className="overlay show" role="dialog" aria-modal="true" aria-labelledby="b8ov-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div className="modal b8ov">
        <div className="modal-head">
          <h3 id="b8ov-title" style={{ margin: 0, fontSize: 16 }}>{`${info.candidateName || 'This person'} does not meet this job's rules`}</h3>
          <button type="button" className="close-x" aria-label="Close" onClick={() => onDone(null)}>×</button>
        </div>
        <div className="modal-body">
          {info.requirementTitle && <div className="small-muted" style={{ marginBottom: 6 }}>{`Job: ${info.requirementTitle}${info.fit != null ? ` · Fit ${info.fit}%` : ''}${info.minFit != null ? ` (needs ${info.minFit}%)` : ''}`}</div>}
          <ul className="b8ov-why">
            {(info.why || []).map((w) => <li key={w}>{w}</li>)}
          </ul>
          <label className="b8ov-label" htmlFor="b8ov-reason">Why add them anyway?</label>
          <textarea
            id="b8ov-reason"
            rows={3}
            maxLength={300}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: the client asked for this person"
          />
          <div className="b8ov-quick">
            {QUICK.map((q) => <button key={q} type="button" className="btn btn-sm" onClick={() => setReason(q)}>{q}</button>)}
          </div>
          <div className="small-muted">Your name and reason are saved, and the person shows “Added by override” on this job.</div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ok} onClick={() => { lastReason = reason.trim(); onDone(reason.trim()); }}>Add anyway</button>
        </div>
      </div>
    </div>
  );
}

export function askOverrideReason(info = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(<OverrideBox info={info} onDone={done} />);
  });
}

// "Added by override: <reason>" — the small badge on an application.
export function OverrideBadge({ reason, by, at }) {
  if (!reason) return null;
  const when = at ? new Date(at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  return (
    <span className="b8-badge" title={`Added by override${by ? ` by ${by}` : ''}${when ? ` on ${when}` : ''}: ${reason}`}>
      {`Added by override: ${reason.length > 48 ? `${reason.slice(0, 46)}…` : reason}`}
    </span>
  );
}

// "(v3)" beside a stored Fit; old scores are "v1 (before versioning)".
export function fitVersionLabel(code) {
  if (!code) return 'v1';
  const m = String(code).match(/v(\d+)/);
  return m ? `v${m[1]}` : String(code);
}
export function FitWithVersion({ score, version }) {
  if (score == null) return null;
  const v = fitVersionLabel(version);
  return (
    <span title={version ? `Scoring version ${v}` : 'Scored before versioning (v1)'}>
      {`${score}%`}
      <span className="b8-ver">{` (${v})`}</span>
    </span>
  );
}
