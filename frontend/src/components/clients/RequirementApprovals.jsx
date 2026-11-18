import { useCallback, useEffect, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// CLIENT PORTAL: "Please confirm this requirement" (audit Checklist-168 #30). Shown only while TeamLink has switched the step ON and a
// requirement of this client waits for the client's yes before it goes live. Backend: routes/clientDepth.js portalRouter.
// ---------------------------------------------------------------------------
export default function RequirementApprovals() {
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState({});
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.get('/portal/client/requirement-approvals').then((r) => setRows(r.data.rows || [])).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  if (!rows.length && !msg) return null;
  async function decide(id, approve) {
    setBusy(id); setMsg('');
    try { await api.post(`/portal/client/requirement-approvals/${id}/decide`, { approve, note: note[id] }); setMsg(approve ? 'Thank you. The requirement will go live.' : 'Thank you. We will change it and ask again.'); load(); } catch (e) { setMsg(e.response?.data?.error || 'That did not work. Please try again.'); } finally { setBusy(''); }
  }
  return (
    <div className="card section" style={{ margin: '10px 0' }}>
      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Please confirm {rows.length === 1 ? 'this requirement' : 'these requirements'}</h3>
      {rows.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid var(--line, #ddd)', padding: '8px 0' }}>
          <b>{r.title}</b>{r.reqCode && <span className="small-muted"> · {r.reqCode}</span>}
          <div className="small-muted">{[`${r.openings || 1} opening${(r.openings || 1) === 1 ? '' : 's'}`, r.location, r.experience && `${r.experience} years`, r.salary].filter(Boolean).join(' · ')}</div>
          {r.skills && <div className="small-muted">Skills: {r.skills}</div>}
          {r.jobDescription && <div style={{ whiteSpace: 'pre-line', fontSize: 12.5, maxHeight: 120, overflow: 'auto' }}>{r.jobDescription}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => decide(r.id, true)}>Confirm, go live</button>
            <input placeholder="What should change? (needed to ask for changes)" value={note[r.id] || ''} onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))} style={{ minWidth: 260 }} />
            <button type="button" className="btn btn-sm" disabled={busy === r.id || !(note[r.id] || '').trim()} onClick={() => decide(r.id, false)}>Ask for changes</button>
          </div>
        </div>
      ))}
      {msg && <div className="small-muted" role="status">{msg}</div>}
    </div>
  );
}
