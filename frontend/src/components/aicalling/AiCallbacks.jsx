import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../Combo.jsx';
import Modal from '../Modal.jsx';
import { errorOf, purposeLabel } from './aiCallingShared.js';

// ---------------------------------------------------------------------------
// CALL-BACKS and QUESTIONS (founder 2026-10-30) - backend calling/callbacks.js + calling/knowledge.js.
//   CallbacksTab      every "call me back at ..." the AI heard, with its India time and status; Call back = AI (the same
//                     AI calling, continuing from the last talk) or by hand. The server shows only your own candidates.
//   QuestionsTab      what candidates asked that the verified job facts did not answer; write the answer once and the
//                     AI uses it on the next calls of that requirement.
//   CallbackCard      the candidate's open call-back on the AI calls card of the profile.
// ---------------------------------------------------------------------------
const TONE = { 'Due now': 'amber', Overdue: 'red', Pending: 'blue', Rescheduled: 'blue', Completed: 'green', Cancelled: '' };
const req = (r) => [r.code, r.title, r.client].filter(Boolean).join(' · ');
const toIstInput = (ist) => String(ist || '').replace(' ', 'T');

function CallBackActions({ row, onDone, compact }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [manual, setManual] = useState(false);
  const [moving, setMoving] = useState(false);
  const [when, setWhen] = useState(toIstInput(row.dueIst));
  const act = async (what, body) => {
    setBusy(what); setErr(''); setMsg('');
    try {
      const r = await api.post(`/ai-calling/callbacks/${row.id}/${what}`, body || {});
      setMsg(r.data.message || 'Saved.'); setManual(false); setMoving(false);
      if (onDone) onDone();
    } catch (e) { setErr(errorOf(e, 'That did not work. Please try again.')); }
    setBusy('');
  };
  if (row.raw !== 'pending') return null;
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => act('call')}>{busy === 'call' ? 'Calling…' : '📞 AI call back'}</button>
      <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setManual(true)}>Call by hand</button>
      {!compact && <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setMoving(true)}>Change time</button>}
      {!compact && <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => act('cancel')}>Cancel</button>}
      {msg && <span className="small-muted">{msg}</span>}
      {err && <span className="error-text">{err}</span>}
      {manual && (
        <Modal title={`Call ${row.candidate} by hand`} onClose={() => setManual(false)} footer={(
          <>
            <button type="button" className="btn" onClick={() => setManual(false)}>Close</button>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => act('done', { how: 'Called by hand' })}>I called - close the call-back</button>
          </>
        )}
        >
          <div>{req(row.requirement)}</div>
          <div style={{ margin: '8px 0', fontSize: 18 }}>{row.phone ? <a href={`tel:${row.phone}`}>{row.phone}</a> : row.phoneMask}</div>
          {row.summary && <div className="small-muted">{`Last call: ${row.summary}`}</div>}
        </Modal>
      )}
      {moving && (
        <Modal title="Change the call-back time" onClose={() => setMoving(false)} footer={(
          <>
            <button type="button" className="btn" onClick={() => setMoving(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={!!busy || !when} onClick={() => act('move', { dueAt: when })}>Save</button>
          </>
        )}
        >
          <label className="field"><span>New day and time (India time)</span><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        </Modal>
      )}
    </div>
  );
}

export function CallbacksTab() {
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get('/ai-calling/callbacks', { params: { status } }).then((r) => { setRows(r.data.rows || []); setErr(''); }).catch((e) => setErr(errorOf(e, 'Could not load the call-backs.')));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  const counts = (rows || []).reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  return (
    <div>
      <div className="row-actions" style={{ marginBottom: 10, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 180 }}>
          <label className="small-muted">Show</label>
          <Combo value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open call-backs</option>
            <option value="done">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </Combo>
        </div>
        {['Overdue', 'Due now', 'Pending'].map((k) => counts[k] ? <span key={k} className={`status ${TONE[k] || ''}`}>{`${k}: ${counts[k]}`}</span> : null)}
      </div>
      {err && <div className="notice red">{err}</div>}
      {rows && rows.length === 0 && <div className="small-muted">No call-backs here. When a candidate asks the AI to call back later, it shows here and you get a reminder.</div>}
      {(rows || []).map((r) => (
        <div key={r.id} className="cdw-note" style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`status ${TONE[r.status] || ''}`}>{r.status}</span>
            <b><Link to={`/candidates/${r.candidateId}`}>{r.candidate}</Link></b>
            <span className="small-muted">{r.phone || r.phoneMask}</span>
            <span style={{ marginLeft: 'auto' }}><b>{r.dueIst}</b>{!r.timeGiven && <span className="small-muted"> (no time given)</span>}</span>
          </div>
          <div className="small-muted">{[req(r.requirement), purposeLabel(r.purpose), r.language, r.owner && `Recruiter: ${r.owner}`, r.whenText && `They said: ${r.whenText}`, r.interest && `Interest: ${r.interest}`].filter(Boolean).join(' · ')}</div>
          {r.summary && <div className="small-muted" style={{ marginTop: 2 }}>{r.summary}</div>}
          {r.raw !== 'pending' && <div className="small-muted">{`${r.doneHow || r.raw}${r.doneBy ? ` by ${r.doneBy}` : ''}`}</div>}
          <div style={{ marginTop: 6 }}><CallBackActions row={r} onDone={load} /></div>
        </div>
      ))}
    </div>
  );
}

export function QuestionsTab() {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    api.get('/ai-calling/questions', { params: { status } }).then((r) => { setRows(r.data.rows || []); setErr(''); }).catch((e) => setErr(errorOf(e, 'Could not load the questions.')));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  const save = async (id, body) => {
    setBusy(id); setErr('');
    try { await api.post(`/ai-calling/questions/${id}/answer`, body); load(); } catch (e) { setErr(errorOf(e, 'Could not save.')); }
    setBusy('');
  };
  return (
    <div>
      <div className="small-muted" style={{ marginBottom: 8 }}>Questions candidates asked on AI calls that the job details did not answer. The AI told them the team would check. Write a short, true answer and the AI uses it on the next calls of that requirement.</div>
      <div style={{ maxWidth: 220, marginBottom: 10 }}>
        <Combo value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Waiting for an answer</option>
          <option value="answered">Answered</option>
          <option value="dismissed">Not for the AI</option>
          <option value="all">All</option>
        </Combo>
      </div>
      {err && <div className="notice red">{err}</div>}
      {rows && rows.length === 0 && <div className="small-muted">Nothing here.</div>}
      {(rows || []).map((q) => (
        <div key={q.id} className="cdw-note" style={{ marginBottom: 8 }}>
          <div><b>{q.question}</b> <span className="small-muted">{`· asked ${q.askedCount} time${q.askedCount === 1 ? '' : 's'} · ${req(q.requirement)}`}</span></div>
          {q.answer && <div style={{ marginTop: 4 }}>{`Answer: ${q.answer}`} <span className="small-muted">{q.answeredByName ? `(${q.answeredByName})` : ''}</span></div>}
          {q.status !== 'dismissed' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <input style={{ flex: 1, minWidth: 220 }} maxLength={300} placeholder={q.answer ? 'Change the answer' : 'The verified answer (short)'} value={draft[q.id] ?? ''} onChange={(e) => setDraft({ ...draft, [q.id]: e.target.value })} />
              <button type="button" className="btn btn-sm btn-primary" disabled={busy === q.id || !(draft[q.id] || '').trim()} onClick={() => save(q.id, { answer: draft[q.id] })}>Save answer</button>
              {q.status === 'pending' && <button type="button" className="btn btn-sm btn-ghost" disabled={busy === q.id} onClick={() => save(q.id, { dismiss: true })}>Not for the AI</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// The candidate's open call-back (profile > AI calls card)
export function CallbackCard({ applicationId, refreshKey }) {
  const [row, setRow] = useState(null);
  const load = useCallback(() => {
    if (!applicationId) { setRow(null); return; }
    api.get(`/ai-calling/callbacks/for-application/${applicationId}`).then((r) => setRow(r.data.row || null)).catch(() => setRow(null));
  }, [applicationId]);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (!row) return null;
  return (
    <div className={`notice ${row.status === 'Overdue' ? 'red' : 'amber'}`} style={{ marginBottom: 8, display: 'block' }}>
      <div><b>{`Call back ${row.dueIst}`}</b>{row.whenText && <span className="small-muted">{` · they said: ${row.whenText}`}</span>}{` · ${row.status}`}</div>
      <div style={{ marginTop: 6 }}><CallBackActions row={row} onDone={load} compact /></div>
    </div>
  );
}
