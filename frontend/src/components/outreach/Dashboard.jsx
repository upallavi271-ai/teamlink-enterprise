import { useEffect, useState } from 'react';
import api from '../../api';
import { Overview } from './OverviewReports.jsx';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > DASHBOARD: ONE component; the server picks the blocks for the login's level (Recruiter, Team Lead, Department Head, Super Admin,
// Finance, HR, Marketing). GET /api/outreach/dashboard. Below the blocks: the "today" overview (campaigns, failed, waiting) for everyone who has it.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

export function Block({ b }) {
  return (
    <section className="oc2-block" aria-label={b.title}>
      <h3 className="oc2-h">{b.title}</h3>
      {b.tiles && b.tiles.length > 0 && (
        <div className="oc2-tiles">{b.tiles.map((t) => <div key={t.label} className={`oc2-tile ${t.tone || ''}`}><b>{t.value}</b><span>{t.label}</span></div>)}</div>
      )}
      {b.head && b.rows && (
        b.rows.length === 0 ? <div className="oc-note">Nothing to show yet.</div> : (
          <div className="oc-scroll oc2-act">
            <table className="oc2-table">
              <thead><tr>{b.head.map((h, i) => <th key={h} className={i > 0 ? 'num' : ''}>{h}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, i) => <td key={i} className={i === 0 ? 'name' : 'num'}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )
      )}
      {b.note && <div className="oc-note" style={{ marginTop: 6 }}>{b.note}</div>}
    </section>
  );
}

export default function Dashboard({ acc, go }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/outreach/dashboard').then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'The dashboard could not be loaded.'))); }, []);
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  return (
    <div>
      <div className="oc-note" style={{ marginBottom: 6 }}>Dashboard for: <b>{d.levelWords}</b>. Only what your role may see is counted.</div>
      {d.blocks.map((b) => <Block key={b.id} b={b} />)}
      {d.overview && d.overview.ready && <section className="oc2-block"><h3 className="oc2-h">Campaigns today</h3><Overview acc={acc} go={go} /></section>}
    </div>
  );
}
