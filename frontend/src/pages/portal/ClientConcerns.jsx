import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import EmptyState from '../../components/ui/EmptyState.jsx';

// ---------------------------------------------------------------------------
// Client portal -> "Concerns": the client raises a concern or an escalation and follows it (backend routes/atsExperience.js
// portalRouter, /api/portal/client/concerns). It moves up our escalation matrix (level 1 -> 2 -> 3) until it is resolved.
// No staff names are shown here.
// ---------------------------------------------------------------------------
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const TONE = { Open: '#b45309', 'In progress': '#1d4ed8', Resolved: '#15803d' };

export default function ClientConcerns() {
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState({ subject: '', details: '' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.get('/portal/client/concerns').then((x) => setRows(x.data.rows || [])).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  async function send(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const x = await api.post('/portal/client/concerns', form);
      setForm({ subject: '', details: '' }); setErr(''); setMsg(`Your concern is number ${x.data.id}. The right person in our team has it now; if it is not resolved in time it goes to their senior.`); load();
    } catch (x) { setErr(x.response?.data?.error || 'Could not send. Please try again.'); }
    setBusy(false);
  }
  return (
    <div>
      <form className="card" onSubmit={send} style={{ display: 'grid', gap: 8, maxWidth: 640, marginBottom: 14 }}>
        <b>Raise a concern</b>
        <span className="small-muted">Not happy with something? Tell us here. It reaches the person handling your account at once.</span>
        {err && <div className="notice red"><span>{err}</span></div>}
        {msg && <div className="notice green"><span>{msg}</span></div>}
        <input required maxLength={200} placeholder="What is it about?" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        <textarea maxLength={4000} rows={3} placeholder="Details (optional)" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} />
        <div><button type="submit" className="btn btn-sm btn-primary" disabled={busy || !form.subject.trim()}>Send</button></div>
      </form>
      {rows && rows.length > 0 ? (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>#</th><th>Raised</th><th>About</th><th>Status</th><th className="num">Level</th><th>Resolution</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}><td>{c.id}</td><td>{day(c.raisedOn)}</td><td>{c.subject}{c.details ? <div className="small-muted">{c.details}</div> : null}</td><td><b style={{ color: TONE[c.status] }}>{c.status}</b></td><td className="num">{c.level}</td><td>{c.resolution ? `${c.resolution} (${day(c.resolvedOn)})` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : rows && <EmptyState icon="💬" title="No concerns raised" hint="Anything you raise here shows with its status until it is resolved." />}
    </div>
  );
}
