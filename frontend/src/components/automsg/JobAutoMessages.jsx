import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './autoMsg.css';

// ---------------------------------------------------------------------------
// A JOB'S OWN SETTING for automatic stage messages (job page, side card):
// follow the company rules / no automatic messages for this job / the
// recruiter approves each message first. Shown to everybody who can see the
// job; only the recruiter, the team lead, HR or an Admin can change it.
// ---------------------------------------------------------------------------
const CHOICES = [
  ['inherit', 'Follow the company rules', 'Messages go as set in Message templates > Automatic messages.'],
  ['approval', 'The recruiter says OK first', 'Every message for this requirement waits on the person\'s page until the recruiter presses Approve & send.'],
  ['off', 'No automatic messages for this requirement', 'People who move on this requirement get nothing by themselves.'],
];

export default function JobAutoMessages({ requirementId }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState('');
  const load = useCallback(() => api.get(`/auto-messages/jobs/${requirementId}`).then((r) => setInfo(r.data)).catch(() => setInfo(false)), [requirementId]);
  useEffect(() => { load(); }, [load]);
  if (!info) return null;
  async function pick(mode) {
    setBusy(mode); setFlash('');
    try { await api.put(`/auto-messages/jobs/${requirementId}`, { mode }); setFlash('Saved.'); await load(); } catch (e) { setFlash(e.response?.data?.error || 'Could not save.'); } finally { setBusy(''); }
  }
  return (
    <div className="card section">
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>Automatic messages to candidates</h3>
      <div className="am-choices">
        {CHOICES.map(([k, label, help]) => (
          <button key={k} type="button" disabled={!info.canSet || !!busy} className={`am-choice${info.mode === k ? ' on' : ''}`} onClick={() => info.mode !== k && pick(k)}>
            <span className="am-dot" /><span><b>{label}</b><small>{help}</small></span>
          </button>
        ))}
      </div>
      {info.by && info.mode !== 'inherit' && <div className="am-help">Set by {info.by}.</div>}
      {flash && <div className="am-help" role="status">{flash}</div>}
    </div>
  );
}
