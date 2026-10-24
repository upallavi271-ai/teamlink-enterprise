import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './omni2.css';

// OMNI-CHANNEL > SETTINGS > CONNECTIONS (Admin): how Omni-Channel is joined to HRMS, ATS, Accounts and the Job Portal. Green = joined, yellow =
// partly, red = not working. "Test connection" only READS (counts); it never sends a message. Server: /api/outreach/connections.
const STATE_WORD = { green: 'Connected', yellow: 'Partly connected', red: 'Not working' };
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

export default function Connections() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.get('/outreach/connections').then((r) => { setData(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The connections could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  const test = async (id) => {
    setBusy(id); setNote('');
    try {
      const r = await api.post(`/outreach/connections/test/${id}`);
      setData((d) => ({ ...d, links: d.links.map((l) => (l.id === id ? r.data.link : l)) }));
      setNote(`${r.data.link.name}: ${STATE_WORD[r.data.link.state]}. Only read, nothing was sent.`);
    } catch (e) { setErr(errOf(e, 'The test could not run.')); } finally { setBusy(''); }
  };
  const sync = async () => {
    if (!window.confirm('Add every staff member who has a phone or email as an internal contact? They get no permission to be messaged until consent is recorded.')) return;
    setBusy('sync'); setNote(''); setErr('');
    try {
      const r = await api.post('/outreach/connections/sync/hrms');
      setNote(`Staff added: ${r.data.added}. Already there: ${r.data.existed}. Skipped (no usable phone or email): ${r.data.skipped}. ${r.data.note}`);
      load();
    } catch (e) { setErr(errOf(e, 'The staff could not be added.')); } finally { setBusy(''); }
  };
  if (err && !data) return <div className="bc-err" role="alert">{err}</div>;
  if (!data) return <div className="oc-note">Loading…</div>;
  return (
    <div>
      <div className="oc-note">{data.note}</div>
      {note && <div className="bc-ok" role="status">{note}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
      <div className="oc2-links" style={{ marginTop: 10 }}>
        {data.links.map((l) => (
          <div className="oc2-link" key={l.id}>
            <span className={`oc2-dot ${l.state}`} aria-hidden="true" />
            <div>
              <h4>{l.name}: {STATE_WORD[l.state]}</h4>
              <div>{l.summary}</div>
              <ul>{l.facts.map((f) => <li key={f}>{f}</li>)}</ul>
              {l.notBuilt.map((n) => <div className="nb" key={n}>Not built yet: {n}</div>)}
              <div className="oc-row2">
                <button type="button" className="btn btn-sm" disabled={busy === l.id} onClick={() => test(l.id)}>{busy === l.id ? 'Checking…' : 'Test connection'}</button>
                {l.canSync && <button type="button" className="btn btn-sm" disabled={busy === 'sync'} onClick={sync}>{l.syncWord}</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
