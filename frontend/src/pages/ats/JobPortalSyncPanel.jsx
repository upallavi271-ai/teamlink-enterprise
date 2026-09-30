import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';
import '../../components/jobs/reach.css';

// ---------------------------------------------------------------------------
// LAST SYNC / ERRORS (user notes #10) — the Job Portal workspace's health line:
// is the portal answering, when did the last sync run and what did it do,
// which published requirements did not reach the portal and why, and the
// recent sync problems. Retry per requirement (POST /job-portal/jobs/:id/push)
// and a full Sync (POST /job-portal/sync) where this login may.
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function JobPortalSyncPanel({ refreshKey, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  function load() {
    return api.get('/job-portal/sync-status')
      .then((r) => { setData(r.data); setError(''); })
      .catch((e) => setError(e.response?.data?.error || 'Sync status could not be loaded.'));
  }
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(key, fn, ok) {
    setBusy(key); setNote(''); setError('');
    try {
      const r = await fn();
      setNote(ok(r));
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'That was refused.');
      await load();
    } finally {
      setBusy('');
    }
  }

  if (!data) return error ? <div className="notice red">{error}</div> : null;
  const perms = data.permissions || {};
  const last = data.lastSync;

  return (
    <div className="card section rq-reach">
      <div className="rq-reach-head">
        <h3>Last sync / errors</h3>
        {perms.sync && (
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => act('sync', () => api.post('/job-portal/sync'), (r) => r.data.note)}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>
      <div className="rq-reach-row">
        <b>Job Portal</b>
        <StatusChip tone={data.reachable ? 'green' : 'red'}>{data.reachable ? 'Connected' : (data.configured ? 'Not reachable' : 'Not configured')}</StatusChip>
        <span className="small-muted rq-reach-detail">{data.reachability}</span>
      </div>
      <div className="rq-reach-row">
        <b>Last sync</b>
        {last ? <StatusChip tone={last.status === 'Success' ? 'green' : 'red'}>{last.status === 'Success' ? 'OK' : 'Failed'}</StatusChip> : <StatusChip tone="grey">Never</StatusChip>}
        <span className="small-muted rq-reach-detail">
          {last ? `${when(last.at)} — ${last.summary}` : 'No sync has run yet.'}
          {last && last.status !== 'Success' && data.lastSuccess && ` Last successful sync: ${when(data.lastSuccess.at)}.`}
        </span>
      </div>

      {data.failedJobs.length > 0 && (
        <>
          <div className="section-label" style={{ margin: '10px 0 4px' }}>{`Published but not on the portal (${data.failedJobs.length})`}</div>
          {data.failedJobs.map((j) => (
            <div className="rq-reach-row" key={j.id}>
              <b><Link to={`/requirements/${j.id}`}>{j.reqCode || j.title}</Link></b>
              <StatusChip status={j.status} tone={j.status === 'Failed' ? 'red' : 'amber'} />
              <span className="small-muted rq-reach-detail">{`${j.title}${j.reason ? ` — ${j.reason}` : ''}${j.at ? ` (${when(j.at)})` : ''}`}</span>
              {perms.retry && (
                <button type="button" className="btn btn-sm" disabled={!!busy}
                  onClick={() => act(j.id, () => api.post(`/job-portal/jobs/${j.id}/push`), () => `${j.reqCode || j.title} is on the Job Portal now.`)}>
                  {busy === j.id ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </div>
          ))}
        </>
      )}

      {data.errors.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary className="small-muted" style={{ cursor: 'pointer' }}>{`Recent sync problems, last 7 days (${data.errors.length})`}</summary>
          {data.errors.map((e) => (
            <div className="rq-reach-row" key={e.id}>
              <b>{when(e.at)}</b>
              <span className="small-muted rq-reach-detail">
                {e.reason}
                {e.count > 1 && ` — ${e.count} times since ${when(e.firstAt)}`}
              </span>
            </div>
          ))}
        </details>
      )}
      {data.failedJobs.length === 0 && data.errors.length === 0 && (
        <div className="small-muted" style={{ marginTop: 6 }}>No sync problems in the last 7 days.</div>
      )}
      {(note || error) && <div className={`small-muted rq-reach-note${error ? ' is-error' : ''}`}>{error || note}</div>}
    </div>
  );
}
