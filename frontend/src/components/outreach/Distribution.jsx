import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > JOB PROMOTIONS > DISTRIBUTION: where each job of yours is posted (job sites, groups, careers page) and what is still waiting.
// It shows the numbers of the job Posting tracker (server: GET /api/outreach/distribution, which asks the same tracker) and sends you to the job's own
// "Distribute" tab to post it. No posting logic lives here. A place a person marked as posted is "not checked by the system".
// ---------------------------------------------------------------------------
const TILES = [['posted', 'Posted', 'g'], ['expiring', 'Expiring soon', 'o'], ['waiting', 'Waiting to be posted', 'o'], ['expired', 'Expired', 'r']];

export default function Distribution() {
  const [d, setD] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback((text) => {
    api.get('/outreach/distribution', { params: { q: text || undefined } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr((e.response && e.response.data && e.response.data.error) || 'Distribution could not be opened.'));
  }, []);
  useEffect(() => { const t = setTimeout(() => load(q.trim()), q ? 300 : 0); return () => clearTimeout(t); }, [q, load]);
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  if (d.notReady) return <div className="oc-empty" role="status"><b>Distribution is being set up</b><div>Where your requirements are posted will show here in a little while.</div></div>;
  return (
    <div>
      <div className="oc-note">Where your open requirements are posted. Open a requirement to copy its text, get its tracked links and mark where you posted it.</div>
      <div className="oc-dist-tiles" role="group" aria-label="Counts">
        {TILES.map(([k, label, tone]) => <div key={k} className={`oc-dist-tile ${tone}`}><b>{d.counts[k] || 0}</b><span>{label}</span></div>)}
      </div>
      <div className="oc-bar">
        <input type="search" aria-label="Find a requirement" placeholder="Find a requirement (title or code)" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="oc-note">{`${d.total} requirement${d.total === 1 ? '' : 's'} · ${d.counts.jobsNotPosted || 0} not posted anywhere yet`}</span>
      </div>
      {d.total > d.jobs.length && <div className="bc-warn" role="status">{`Showing the first ${d.jobs.length} of ${d.total} requirements (the ones that need you most come first). Search for a job to find the others.`}</div>}
      {d.partial && <div className="bc-warn" role="status">There are many requirements and places, so only the first part is counted here. Search for a requirement to see it exactly.</div>}
      {d.jobs.length === 0 && (
        <div className="oc-empty"><b>{q ? 'No requirement matches.' : 'No open requirements in your area yet.'}</b><div>{q ? 'Try another title or code.' : 'When a requirement opens in your area, it shows here with where it is posted.'}</div></div>
      )}
      {d.jobs.length > 0 && (
        <div className="oc-scroll"><table className="oc-table"><thead><tr><th>Requirement</th><th>Posted</th><th>Expiring soon</th><th>Waiting</th><th>Expired</th><th /></tr></thead><tbody>
          {d.jobs.map((j) => (
            <tr key={j.id}>
              <td><b>{j.title}</b><div className="oc-note">{j.reqCode || ''}</div></td>
              <td><span className="oc-pill in">{j.posted}</span></td>
              <td>{j.expiring ? <span className="oc-pill" style={{ background: '#fff1d6', color: '#7a5200' }}>{j.expiring}</span> : <span className="oc-note">0</span>}</td>
              <td>{j.waiting ? <span className="oc-pill" style={{ background: '#fff1d6', color: '#7a5200' }}>{j.waiting}</span> : <span className="oc-note">0</span>}</td>
              <td>{j.expired ? <span className="oc-pill out">{j.expired}</span> : <span className="oc-note">0</span>}</td>
              <td><Link className="btn btn-sm btn-primary" to={`/requirements/${j.id}?tab=distribute`}>Open requirement</Link></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      <div className="oc-note" style={{ marginTop: 8 }}>{`A place you marked as posted is "not checked by the system". We remind the poster ${d.reminderDays || 3} days before it expires. Places TeamLink posts by itself (careers page, Telegram, Facebook) are not counted here.`}</div>
    </div>
  );
}
