import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import AiCallDialog from './AiCallDialog.jsx';
import AiCallDetail from './AiCallDetail.jsx';
import { TalkHistoryButton } from './TalkHistory.jsx';
import { CallbackCard } from './AiCallbacks.jsx'; // the candidate's open call-back (2026-10-30) // the whole conversation of a call (2026-10-29)
import {
  PURPOSES, purposeLabel, statusWord, STATUS_CLASS, when, minutes,
} from './aiCallingShared.js';

// "Calls by the AI assistant" on a candidate: the history (what was asked, what they said, what is next) and the button
// to place a new call. Shown inside the existing candidate History tab. A login that may not use AI calling sees nothing.
export default function AiCallHistory({ candidate, refreshKey = 0 }) {
  const [rows, setRows] = useState(null);
  const [offers, setOffers] = useState([]);
  const [allowed, setAllowed] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [open, setOpen] = useState(null);
  const apps = (candidate.applications || []).filter((a) => a && a.id);
  const [appId, setAppId] = useState(candidate.latestApplicationId || (apps[0] && apps[0].id) || '');
  const [purpose, setPurpose] = useState('Screening');
  const load = useCallback(() => {
    api.get('/ai-calling/history', { params: { candidateId: candidate.id } })
      .then((r) => { setRows(r.data.rows || []); setAllowed(true); })
      .catch(() => { setRows(null); setAllowed(false); });
    api.get('/ai-calling/offers').then((r) => setOffers((r.data.rows || []).filter((o) => apps.some((a) => a.id === o.applicationId)))).catch(() => setOffers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate.id]);
  useEffect(load, [load, refreshKey]);
  if (!allowed) return null;

  return (
    <section className="cdw-card" style={{ marginBottom: 12 }}>
      <div className="cdw-label">Calls by the AI assistant</div>
      {apps.map((a) => <CallbackCard key={a.id} applicationId={a.id} refreshKey={refreshKey} />)}
      {offers.map((o) => (
        <div key={o.id} className="notice amber" style={{ marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 180 }}>{o.kind === 'shortlist' ? 'Shortlisted: tell them with the AI assistant?' : 'Interview booked or changed: tell them with the AI assistant?'} <b>{o.jobTitle}</b></span>
          <button className="btn btn-sm btn-primary" onClick={() => setDialog({ ids: [o.applicationId], purpose: o.purpose, offerId: o.id })}>Preview and call</button>
          <button className="btn btn-sm" onClick={() => api.post(`/ai-calling/offers/${o.id}/dismiss`).then(load)}>Not now</button>
        </div>
      ))}
      <div className="row-actions" style={{ marginBottom: 8, alignItems: 'flex-end' }}>
        {apps.length > 0 && (
          <div style={{ minWidth: 260 }}>
            <label className="small-muted">{apps.length > 1 ? `Requirement (${apps.length} applications)` : 'Requirement'}</label>
            {/* code · title · client: the same title at two clients must not look the same (2026-10-30) */}
            <Combo value={appId} onChange={(e) => setAppId(e.target.value)}>
              {apps.map((a) => {
                const r = a.requirement || {};
                const client = r.internal ? 'TeamLink' : (r.client && r.client.name);
                return <option key={a.id} value={a.id}>{[r.reqCode, r.title, client].filter(Boolean).join(' · ') || a.id}</option>;
              })}
            </Combo>
          </div>
        )}
        <div style={{ minWidth: 200 }}>
          <label className="small-muted">Call for</label>
          <Combo value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Combo>
        </div>
        <button className="btn btn-primary btn-sm" disabled={!appId} onClick={() => setDialog({ ids: [appId], purpose })}>Call with AI assistant</button>
      </div>
      {rows && rows.length === 0 && <div className="small-muted">No AI calls yet.</div>}
      {(rows || []).map((r) => (
        <div key={r.id} className="cdw-note" style={{ cursor: 'pointer' }} onClick={() => setOpen(r.id)}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`status ${STATUS_CLASS[r.status] || 'new'}`}>{statusWord(r.status)}</span>
            <b>{purposeLabel(r.purpose)}</b>
            {r.initiatedVia === 'web-link' && <span className="small-muted">· AI link</span>}
            {r.initiatedVia === 'sip' && <span className="small-muted">· AI phone (own line)</span>}
            {r.outcome && <span>{`· ${r.outcome}`}</span>}
            {r.durationSec != null && <span className="small-muted">{`· talked ${minutes(r.durationSec)}`}</span>}
            <span style={{ marginLeft: 'auto' }}><TalkHistoryButton call={r} /></span>
          </div>
          <div className="small-muted">{`${when(r.createdAt)} · ${r.jobTitle || ''} · started by ${r.initiatedByName || r.initiatedVia}${r.attempts > 1 ? ` · ${r.attempts} tries` : ''}`}</div>
          {r.summary && <div className="small-muted" style={{ marginTop: 2 }}>{r.summary}</div>}
          {r.status !== 'completed' && r.waitReason && <div className="small-muted">{r.waitReason}</div>}
        </div>
      ))}
      {dialog && <AiCallDialog applicationIds={dialog.ids} purpose={dialog.purpose} offerId={dialog.offerId} onClose={() => setDialog(null)} onDone={load} />}
      {open && <AiCallDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </section>
  );
}
