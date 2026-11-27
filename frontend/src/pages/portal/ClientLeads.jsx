import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './clientPosts.css';

// THE CLIENT LOGIN'S "MY ENQUIRIES" (2026-11-27): the enquiries TeamLink recorded for THEIR company, read only, and only where the team switched that on.
// Server: routes/portalPosts.js GET /leads -> marketing/clientLeads.js forClientLogin().
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const when = (iso) => { try { return iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : ''; } catch { return ''; } };
const TONE = { new: 'amber', contacted: 'blue', customer: 'green', lost: 'red' };
const thisMonth = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);

export default function ClientLeads() {
  const [month, setMonth] = useState(thisMonth());
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/portal/client/posts/leads', { params: { month } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Your enquiries could not be opened just now. Please try again.'))), [month]);
  useEffect(() => { load(); }, [load]);

  if (err && !d) return <div className="cpx"><div className="cpx-msg err">{err} <button type="button" className="cpx-back" onClick={load}>Try again</button></div></div>;
  if (!d) return <div className="cpx"><div className="cpx-meta">Loading your enquiries…</div></div>;
  const c = d.counts;
  return (
    <div className="cpx">
      <h1>My enquiries</h1>
      <div className="cpx-sub">{d.company}</div>
      {err ? <div className="cpx-msg err">{err}</div> : null}
      {!d.shared ? (
        <div className="cpx-card"><div className="cpx-body" style={{ textAlign: 'center', padding: '28px 14px' }}>
          <div style={{ fontSize: 34 }} aria-hidden="true">📨</div>
          <h3 className="cpx-title">Not shared yet</h3>
          <div className="cpx-meta">Ask your TeamLink contact to share your enquiry list.</div>
        </div></div>
      ) : (
        <>
          <input type="month" aria-label="Month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ marginBottom: 10 }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <span className="cpx-chip">{c.total} enquiries</span>
            <span className="cpx-chip amber">{c.waiting} not contacted</span>
            <span className="cpx-chip green">{c.customers} customers</span>
            <span className="cpx-chip">{c.callPresses} call presses</span>
            <span className="cpx-chip">{c.whatsappPresses} WhatsApp presses</span>
          </div>
          {!d.leads.length ? <div className="cpx-card"><div className="cpx-body cpx-meta">No enquiries in this month.</div></div> : (
            <div className="cpx-list">{d.leads.map((l) => (
              <div className="cpx-card" key={l.id}><div className="cpx-body">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <span className={`cpx-chip ${TONE[l.status] || ''}`}>{l.statusWords}</span>
                  <span className="cpx-meta">{when(l.at)} · {l.sourceWords}{l.how === 'hand' ? ' · added by TeamLink' : ''}{l.times > 1 ? ` · ${l.times} times` : ''}</span>
                </div>
                <h3 className="cpx-title">{l.name || 'Name not given'}</h3>
                {l.phone ? <div><a href={`tel:+${l.phone}`}>+{l.phone}</a> · <a href={`https://wa.me/${l.phone}`} target="_blank" rel="noopener noreferrer">WhatsApp</a></div> : null}
                {l.email ? <div><a href={`mailto:${l.email}`}>{l.email}</a></div> : null}
                {l.message ? <p className="cpx-preview" style={{ whiteSpace: 'pre-wrap' }}>{l.message}</p> : null}
              </div></div>
            ))}</div>
          )}
        </>
      )}
    </div>
  );
}
