import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import EmptyState from '../../components/ui/EmptyState.jsx';
import { Chip } from './portalUi.jsx';
import ClientProjectPage from '../../components/omni/marketing/ClientProjectPage.jsx';
import ClientReviewPage from '../../components/omni/marketing/ClientReviewPage.jsx';

// CLIENT PORTAL > CREATIVE WORK (2026-11-14). A client person signs in to TeamLink with their own login and sees the videos and pictures TeamLink makes for their company:
// "New creative request" sends us what they need (the same form as the private link), and when options are ready they choose the one they like and add suggestions:
// that choice IS the approval, signed with their own name. Server: routes/portalCreative.js (the list, the new request) and the token-keyed pages the opened project talks to
// (marketing/projects.js). `onCount` tells the portal how many things wait for the client (the tab's number).
const TONE = { invited: 'amber', request: 'blue', working: 'blue', awaiting_client: 'amber', approved: 'green', posted: 'green', declined: 'red' };
export default function ClientCreative({ userName = '', onCount = null }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null); // the token of the project being looked at
  const [openReview, setOpenReview] = useState(null); // the token of a word / picture / video sent for approval
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/portal/client/creative').then((r) => { setD(r.data); setErr(''); if (onCount) onCount(r.data.waiting || 0); }).catch((e) => setErr((e.response && e.response.data && e.response.data.error) || 'Your creative work could not be opened just now. Please try again.')), [onCount]);
  useEffect(() => { load(); }, [load]);
  const start = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post('/portal/client/creative'); setOpen(r.data.token); load(); } catch (e) { setErr((e.response && e.response.data && e.response.data.error) || 'The request could not be started. Please try again.'); } finally { setBusy(false); }
  };
  if (err && !d) return <div className="notice red"><span>{err}</span> <button type="button" className="btn btn-sm" onClick={load}>Try again</button></div>;
  if (!d) return <div className="small-muted">Loading your creative work…</div>;
  if (openReview) {
    return (
      <div>
        <button type="button" className="btn btn-sm" style={{ marginBottom: 10 }} onClick={() => { setOpenReview(null); load(); }}>← All my creative work</button>
        <ClientReviewPage token={openReview} embedded defaultName={userName} onChanged={load} />
      </div>
    );
  }
  if (open) {
    return (
      <div>
        <button type="button" className="btn btn-sm" style={{ marginBottom: 10 }} onClick={() => { setOpen(null); load(); }}>← All my creative work</button>
        <ClientProjectPage token={open} embedded defaultName={userName} onChanged={load} />
      </div>
    );
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ flex: '1 1 260px' }}>
          <h3 style={{ margin: 0 }}>Creative work</h3>
          <div className="small-muted">Videos and pictures TeamLink makes for {d.company}. Choose the one you like: that is your approval. Send us a new request any time.</div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>{busy ? 'Opening…' : '+ New creative request'}</button>
      </div>
      {err ? <div className="notice red"><span>{err}</span></div> : null}
      {d.waiting > 0 ? <div className="tlp-banner amber"><span><b>{d.waiting} thing{d.waiting === 1 ? ' is' : 's are'} waiting for you</b>: open the highlighted ones below.</span></div> : null}
      {(d.reviews || []).length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 6px' }}>For your approval</h4>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Item</th><th>What it is</th><th>Where it stands</th><th /></tr></thead>
              <tbody>
                {d.reviews.map((r) => (
                  <tr key={r.id} style={r.needsYou ? { background: '#fffbeb' } : undefined}>
                    <td><b>{r.title}</b></td>
                    <td className="small-muted">{r.kind}</td>
                    <td><Chip label={r.status === 'sent' ? 'Waiting for your answer' : r.status === 'approved' ? `Approved${r.decidedByName ? ` by ${r.decidedByName}` : ''}` : r.status === 'changes' ? 'You asked for changes' : r.status === 'expired' ? 'Expired: ask us to send it again' : 'Closed'} tone={r.status === 'sent' ? 'amber' : r.status === 'approved' ? 'green' : r.status === 'changes' ? 'blue' : 'grey'} /></td>
                    <td style={{ textAlign: 'right' }}>{r.status === 'expired' ? null : <button type="button" className={`btn btn-sm${r.needsYou ? ' btn-primary' : ''}`} onClick={() => setOpenReview(r.token)}>{r.needsYou ? 'Review and approve →' : 'Open →'}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {d.projects.length === 0 && !(d.reviews || []).length ? (
        <EmptyState icon="🎬" title="No creative work yet" hint="Press “New creative request” and tell us what you need, for example a festival video or a hiring post with your logo." />
      ) : d.projects.length === 0 ? null : (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Request</th><th>Where it stands</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {d.projects.map((p) => (
                <tr key={p.id} style={p.needsYou ? { background: '#fffbeb' } : undefined}>
                  <td><b>{p.title}</b>{p.dueDate ? <div className="small-muted">Needed by {p.dueDate}</div> : null}</td>
                  <td><Chip label={p.words} tone={TONE[p.status] || 'grey'} /></td>
                  <td className="small-muted">{p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : ''}</td>
                  <td style={{ textAlign: 'right' }}><button type="button" className={`btn btn-sm${p.needsYou ? ' btn-primary' : ''}`} onClick={() => setOpen(p.token)}>{p.status === 'invited' ? 'Fill in the request →' : p.status === 'awaiting_client' && p.needsYou ? 'Choose →' : 'Open →'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
