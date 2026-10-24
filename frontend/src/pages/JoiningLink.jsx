// THE CANDIDATE'S JOINING-LETTER PAGE (client hiring, 2026-10-13). Opened from the link the recruiter shares.
// No login: the token is the key. Read the client's letter, press "Confirm joining".
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import './offerSigning.css';

const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function JoiningLink() {
  const { token } = useParams();
  const [view, setView] = useState(null);
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const load = useCallback(() => {
    api.get(`/joining-link/${token}`)
      .then((r) => { setView(r.data); setName((n) => n || String(r.data.candidateName || '').replace(/^ZZTEST\S*\s*/i, '')); })
      .catch((e) => setFatal(e.response?.data?.error || 'This link does not work. Ask your recruiter for a new link.'));
  }, [token]);
  useEffect(load, [load]);
  const openFile = async () => {
    const r = await api.get(`/joining-link/${token}/file`, { responseType: 'blob' });
    const href = URL.createObjectURL(r.data);
    window.open(href, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  };
  const confirm = async () => {
    setBusy(true); setError('');
    try { const r = await api.post(`/joining-link/${token}/confirm`, { name: name.trim(), agree: true }); setView(r.data); setDone(r.data.message); } catch (e) { setError(e.response?.data?.error || 'Could not save. Please try again.'); } finally { setBusy(false); }
  };
  if (fatal) return <div className="careers-shell"><main className="ofs-page"><div className="notice red" role="alert">{fatal}</div></main></div>;
  if (!view) return <div className="careers-shell"><main className="ofs-page"><div className="small-muted">Loading…</div></main></div>;
  return (
    <div className="careers-shell">
      <main className="ofs-page">
        <div className="ofs-head"><h1>{`Your joining letter: ${view.job}`}</h1></div>
        {view.status === 'Confirmed' && (
          <div className="agr-card agr-done"><div className="tick" aria-hidden="true">✓</div><h3>You confirmed your joining. Thank you!</h3><p className="small-muted">{done || 'Your recruiter has been told.'}</p></div>
        )}
        {error && <div className="notice red" role="alert">{error}</div>}
        <section className="ofs-facts" aria-label="Joining details">
          <div><span>Joining date</span><b>{view.joiningDate ? day(`${view.joiningDate}T00:00:00`) : 'To be confirmed'}</b></div>
          {view.joiningTime && <div><span>Time</span><b>{view.joiningTime}</b></div>}
          {view.place && <div><span>Where to come</span><b>{view.place}</b></div>}
          {view.reportingPerson && <div><span>Who to meet</span><b>{view.reportingPerson}</b></div>}
        </section>
        {view.notes && <pre className="ofs-letter">{view.notes}</pre>}
        {view.file && <button type="button" className="btn btn-primary ofs-main" onClick={openFile}>Open the joining letter</button>}
        {view.open && (
          <div className="agr-card ofs-answer" style={{ marginTop: 14 }}>
            <h3>Will you join on this date?</h3>
            <label className="field"><span>Your full name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></label>
            <label className="agr-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I will join on this date.</span></label>
            <button type="button" className="btn btn-primary ofs-main" disabled={busy || name.trim().length < 2 || !agree} onClick={confirm}>{busy ? 'Saving…' : 'Confirm joining'}</button>
          </div>
        )}
      </main>
    </div>
  );
}
