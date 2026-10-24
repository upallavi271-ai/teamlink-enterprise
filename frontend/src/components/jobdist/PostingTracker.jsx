import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import JpModal from '../jobpublish/JpModal.jsx';
import {
  dx, dxError, isNotMigrated, NOT_ON_WORDS, fmtDate,
} from './distKit.js';
import '../jobpublish/jobpublish.css';
import './jobdist.css';

// ---------------------------------------------------------------------------
// THE POSTING TRACKER (a quick view on the Jobs list; no sidebar entry).
//   Where jobs are posted, where they are still waiting, where posts expired: per place (counts) and per job (rows).
//   Click a number to see exactly those rows. Counts of applicants per place come from the tracked links.
// <PostingTracker onClose />   server: GET /api/job-dist/tracker
// ---------------------------------------------------------------------------
const TILES = [
  ['posted', 'Posted', 'green'], ['expiring', 'Expiring soon', 'yellow'], ['expired', 'Expired', 'red'], ['jobsNotPosted', 'Requirements not posted anywhere yet', 'yellow'], ['takenDown', 'Taken down', ''],
];
const STATUS_KEY = { posted: 'posted', expiring: 'expiring', expired: 'expired', jobsNotPosted: 'pending', takenDown: 'taken_down' };
const CHIP = { posted: 'jp-green', expiring: 'jp-yellow', expired: 'jp-red', pending: 'jp-yellow', taken_down: 'jp-grey' };

export default function PostingTracker({ onClose }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [q, setQ] = useState('');
  const [notOn, setNotOn] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const d = await dx.get('/tracker', { status: status || undefined, platform: platform || undefined, q: q.trim() || undefined, limit: 300 });
      setData(d); setErr(''); setNotOn(!!d.notReady);
    } catch (e) { if (isNotMigrated(e)) setNotOn(true); else setErr(dxError(e, 'Could not read the tracker.')); }
  }, [status, platform, q]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  const pick = (st, pl) => { setStatus(st); setPlatform(pl || ''); };
  const body = () => {
    if (notOn) return <div className="jp-off" role="status"><b>Distribution is not switched on yet</b><span>{NOT_ON_WORDS}</span></div>;
    if (err) return <div className="dx-err" role="alert">{err}</div>;
    if (!data) return <div className="jp-note" role="status">Loading...</div>;
    return (
      <div className="dx-wrap">
        <div className="dx-tiles" role="group" aria-label="Counts">
          {TILES.map(([k, label, tone]) => (
            <button type="button" key={k} className={`dx-tile${tone ? ` is-${tone}` : ''}${status === STATUS_KEY[k] ? ' is-on' : ''}`} aria-pressed={status === STATUS_KEY[k]} onClick={() => pick(status === STATUS_KEY[k] ? '' : STATUS_KEY[k], platform)}>
              <b>{data.counts[k] || 0}</b><span>{label}</span>
            </button>
          ))}
        </div>
        <div className="dx-hint">{`${data.openJobs} open requirement${data.openJobs === 1 ? '' : 's'} in your area. A post marked by hand is "not checked by the system". We remind the poster ${data.reminderDays} days before it expires.`}</div>
        <div className="tbl-wrap">
          <table className="dx-table">
            <thead><tr><th>Place</th><th>Posted</th><th>Expiring soon</th><th>Expired</th><th>Waiting</th><th>Applicants</th></tr></thead>
            <tbody>
              {data.byPlatform.map((p) => (
                <tr key={p.key}>
                  <td data-l="Place"><b>{p.name}</b></td>
                  <td data-l="Posted" className="num"><button type="button" className="cell" onClick={() => pick('posted', p.key)}>{p.posted}</button></td>
                  <td data-l="Expiring soon" className="num"><button type="button" className="cell" onClick={() => pick('expiring', p.key)}>{p.expiring}</button></td>
                  <td data-l="Expired" className="num"><button type="button" className="cell" onClick={() => pick('expired', p.key)}>{p.expired}</button></td>
                  <td data-l="Waiting" className="num"><button type="button" className="cell" onClick={() => pick('pending', p.key)}>{p.pending}</button></td>
                  <td data-l="Applicants" className="num">{p.applicants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="jp-filters">
          <input type="search" aria-label="Find a requirement" placeholder="Find a requirement (title or code)" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
          {(status || platform) && <button type="button" className="btn btn-sm" onClick={() => pick('', '')}>Show everything</button>}
          <span className="dx-count">{`${data.total} row${data.total === 1 ? '' : 's'}${status ? ` · ${TILES.find((t) => STATUS_KEY[t[0]] === status)?.[1] || status}` : ''}${platform ? ` · ${(data.byPlatform.find((p) => p.key === platform) || {}).name || platform}` : ''}`}</span>
        </div>
        {data.rows.length === 0 && <div className="jp-off"><b>Nothing here</b><span>No requirement matches. Pick another number above.</span></div>}
        {data.rows.length > 0 && (
          <div className="tbl-wrap">
            <table className="dx-table">
              <thead><tr><th>Requirement</th><th>Place</th><th>State</th><th>Posted by</th><th>Expires</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.requirementId}${r.platform}`}>
                    <td data-l="Requirement"><Link to={`/requirements/${r.requirementId}?tab=distribute`} onClick={onClose}>{r.reqCode ? `${r.reqCode} · ` : ''}{r.title}</Link></td>
                    <td data-l="Place">{r.platformName}</td>
                    <td data-l="State"><span className={`jp-chip ${CHIP[r.status] || 'jp-grey'}`} title={r.detail}>{r.words}</span></td>
                    <td data-l="Posted by">{r.postedByName ? <>{r.postedByName}{r.postUrl ? <> · <a href={r.postUrl} target="_blank" rel="noopener noreferrer">link</a></> : null}</> : ''}</td>
                    <td data-l="Expires">{r.expiresAt ? fmtDate(r.expiresAt) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };
  return (
    <JpModal title="Posting tracker: where requirements are posted" size="is-wide" onClose={onClose} foot={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {body()}
    </JpModal>
  );
}
