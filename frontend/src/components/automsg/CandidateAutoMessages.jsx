import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ScheduledMessages from './ScheduledMessages.jsx';
import './autoMsg.css';

// ---------------------------------------------------------------------------
// One person's automatic messages (candidate page History tab, the candidate
// window, the follow-up window): the messages planned or sent when they moved
// step, and the one switch "Don't message this person automatically".
// Renders nothing for a login that cannot see the person's messages.
// ---------------------------------------------------------------------------
export default function CandidateAutoMessages({ candidateId }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(0);
  const load = useCallback(() => api.get(`/auto-messages/people/${candidateId}`).then((r) => setInfo(r.data)).catch(() => setInfo(false)), [candidateId]);
  useEffect(() => { load(); }, [load]);
  if (!info) return null;
  async function pause(paused) {
    setBusy(true);
    try { await api.post(`/auto-messages/people/${candidateId}/pause`, { paused }); await load(); setKey((k) => k + 1); } finally { setBusy(false); }
  }
  return (
    <div className="am-card" style={{ marginTop: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Automatic messages</h3>
        {info.canAct && (info.paused
          ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => pause(false)}>Resume automatic messages</button>
          : <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => pause(true)}>Don&apos;t message this person automatically</button>)}
      </div>
      {info.paused && <div className="msg-box orange">Paused{info.by ? ` by ${info.by}` : ''}: this person gets no automatic messages.</div>}
      <div className="am-help" style={{ margin: '4px 0 8px' }}>
        The message planned when this person moves to the next step. You see it before it goes. <Link to="/admin/message-templates?tab=automatic">How automatic messages work</Link>
      </div>
      <ScheduledMessages key={key} candidateId={candidateId} compact />
    </div>
  );
}
