import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import JobTextPanel from './JobTextPanel.jsx';
import FieldByFieldCopy from './FieldByFieldCopy.jsx';
import './postByHand.css';
import './jobTextPanel.css';

// ---------------------------------------------------------------------------
// "POST BY HAND" — for a job board TeamLink cannot post to on its own (no open
// API, or the account is not connected yet). Three steps on one screen:
//   1. Get the text: the job written for THIS site from the job's real fields
//      (utils/jobText.js: missing facts stay "[ ]" with a box to fill them, a
//      warning if the job asks for an age / gender / marital status, Copy and a
//      word counter). "Field by field" keeps the old list, one Copy per field.
//   2. Open the board's own "post a job" page and paste it there.
//   3. Tick the 5 checks (salary, location, contact, client name hidden, text
//      read), paste the live link and press "I posted it". The row then says
//      "Posted by hand" with who / when / link — never "Posted".
//      Not all ticked: the button waits; an Admin may go on after a plain confirm.
// TeamLink never signs in to the board and sends nothing to it.
// GET/POST /requirements/:id/posting-sites/:source/by-hand[/done|/removed|/undo]
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const CHECKS = [
  ['salary', 'The salary is right'],
  ['location', 'The location and work mode are right'],
  ['contact', 'The contact details and apply link are right'],
  ['client', 'The client name is hidden'],
  ['review', 'I read the job text'],
];

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(t);
    return ok;
  }
}

export default function PostByHand({ requirementId, source, name, onClose, onChanged }) {
  const { user } = useAuth() || {};
  const [h, setH] = useState(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState('text'); // text | fields
  const [ticks, setTicks] = useState({});
  const base = `/requirements/${requirementId}/posting-sites/${source}/by-hand`;
  const isAdmin = ['SUPER_ADMIN', 'ADMIN'].includes(user && (user.role || user.atsRole));

  useEffect(() => {
    api.get(base).then((r) => setH(r.data)).catch((e) => setError(e.response?.data?.error || 'Could not prepare the requirement.'));
  }, [base]);

  async function doCopy(label, text) {
    const ok = await copy(text);
    setNote(ok ? `Copied: ${label}.` : 'Your browser did not allow copying. Select the text and copy it by hand.');
  }
  async function act(kind, body) {
    setBusy(kind); setError(''); setNote('');
    try {
      const r = await api.post(`${base}/${kind}`, body || {});
      setH(r.data.helper);
      setNote(r.data.ok || 'Saved.');
      if (kind === 'done') { setUrl(''); setTicks({}); }
      if (onChanged) onChanged(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(''); }
  }
  const allTicked = CHECKS.every(([k]) => ticks[k]);
  function posted() {
    if (!allTicked) {
      // eslint-disable-next-line no-alert
      if (!window.confirm('You have not ticked all five checks. Post it anyway?')) return;
    }
    act('done', { url });
  }

  const state = h ? h.state : 'todo';
  return (
    <Modal
      title={`Post this requirement on ${name} by hand`}
      size="wide"
      onClose={onClose}
      foot={<button type="button" className="btn" onClick={onClose}>Close</button>}
    >
      {!h && <div className="small-muted">{error || 'Getting the requirement ready…'}</div>}
      {h && (
        <div className="pbh">
          <div className="small-muted">{h.note}</div>
          {!h.live && <div className="pbh-warn">This requirement is not open, so it should not be posted now.</div>}
          {!h.publicLink && <div className="pbh-warn">The apply link below only works on this computer until the server&rsquo;s public address (APP_BASE_URL) is set. Ask your admin.</div>}

          {state === 'done' && (
            <div className="pbh-done" role="status">
              <b>✓ Posted by hand.</b> {h.doneText}{h.doneAt ? ` · ${when(h.doneAt)}` : ''}.
              {h.link ? <> <a href={h.link} target="_blank" rel="noreferrer">Open the live requirement ↗</a></> : ' No link was saved.'}
              <div className="small-muted">TeamLink cannot see whether {name} still shows it. If the requirement closes, you will be asked to take it down.</div>
              <div className="pbh-row">
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('removed')}>I took it down</button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => act('undo')}>I did not post it after all</button>
              </div>
            </div>
          )}
          {state === 'remove' && (
            <div className="pbh-warn" role="status">
              This requirement is closed, paused or no longer ticked, but it was posted on {name} by hand. Take it down on {name}, then press the button.
              <div className="pbh-row"><button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => act('removed')}>{busy === 'removed' ? 'Saving…' : 'I took it down'}</button></div>
            </div>
          )}

          {state !== 'remove' && (
            <>
              <div className="pbh-step"><span className="pbh-n">1</span><b>Get the text for {name}</b></div>
              <div className="jtp-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={view === 'text'} className={`jtp-tab${view === 'text' ? ' on' : ''}`} onClick={() => setView('text')}>Job text</button>
                <button type="button" role="tab" aria-selected={view === 'fields'} className={`jtp-tab${view === 'fields' ? ' on' : ''}`} onClick={() => setView('fields')}>Field by field</button>
              </div>
              {view === 'text' && <JobTextPanel requirementId={requirementId} tabs={[source, ...(source === 'linkedin' ? ['linkedinPost'] : []), 'master', 'checklist']} onNote={setNote} onSaved={() => api.get(base).then((r) => setH(r.data)).catch(() => {})} />}
              {view === 'fields' && (
                <>
                  <div className="small-muted">{h.usesSaved ? `These fields use the ${name} text saved by ${(h.saved && h.saved.by) || 'a team member'}${h.saved && h.saved.at ? ` on ${when(h.saved.at)}` : ''}.` : `These fields use the text TeamLink writes for ${name} (the client name is hidden). Save your own version in Job text and it is used here.`}</div>
                  <FieldByFieldCopy fields={h.fields} siteName={name} />
                  <div className="pbh-row">
                    <button type="button" className="btn" onClick={() => doCopy('the whole requirement', h.text)}>Copy all</button>
                  </div>
                  <div className="pbh-fields">
                    {h.fields.map((f) => (
                      <div key={f.key} className="pbh-field">
                        <div className="pbh-k">{f.label}</div>
                        <div className="pbh-v">{f.value}</div>
                        <button type="button" className="btn btn-sm" onClick={() => doCopy(f.label, f.value)}>Copy</button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="pbh-step"><span className="pbh-n">2</span><b>Post it on {name}</b></div>
              <ol className="pbh-steps">{h.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <div className="pbh-row"><a className="btn" href={h.openUrl} target="_blank" rel="noreferrer">{h.openLabel} ↗</a></div>

              {state === 'todo' && (
                <>
                  <div className="pbh-step"><span className="pbh-n">3</span><b>Check, then tell TeamLink it is done</b></div>
                  <div className="pbh-checks" role="group" aria-label="Before you post">
                    {CHECKS.map(([k, label]) => (
                      <label key={k} className="pbh-check"><input type="checkbox" checked={!!ticks[k]} onChange={(e) => setTicks((t) => ({ ...t, [k]: e.target.checked }))} /> {label}</label>
                    ))}
                  </div>
                  <div className="field">
                    <label htmlFor="pbh-url">Link of the live requirement (optional)</label>
                    <input id="pbh-url" type="url" inputMode="url" placeholder={`https://… (from ${name})`} value={url} onChange={(e) => setUrl(e.target.value)} />
                  </div>
                  <div className="pbh-row">
                    <button type="button" className="btn btn-primary" disabled={!!busy || !h.live || (!allTicked && !isAdmin)} onClick={posted}>{busy === 'done' ? 'Saving…' : 'I posted it'}</button>
                    {!allTicked && <span className="small-muted">{isAdmin ? 'Tick all five, or press and confirm.' : 'Tick all five checks first.'}</span>}
                  </div>
                  <div className="small-muted">Only press this after you really posted it. It will read &ldquo;Posted by hand by you&rdquo; with the time. People who apply through {name} reach TeamLink by the usual routes (Job Portal mailbox, upload) with Source = {name}.</div>
                </>
              )}
            </>
          )}
          {note && <div className="jobops-ok" role="status">{note}</div>}
          {error && <div className="error-text">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
