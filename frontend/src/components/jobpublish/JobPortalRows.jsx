import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PortalChip, portalState } from './PublishChips.jsx';
import NeedsHelp from './NeedsHelp.jsx';
import {
  PORTALS, jp, jpError, isNotMigrated, useVisiblePoll, when,
} from './jpKit.js';
import './jobpublish.css';

// ---------------------------------------------------------------------------
// ONE JOB, ONE ROW PER SITE, live. Used by the Publish popup (after sending) and the Job posting status card.
//   useJobPublish(jobId)  -> { status, infos, loading, error, notOn, reload, going }
//   <JobPortalRows />     chips + plain reason + the buttons that fit the state (Retry / Republish / Take down / Cancel / Open task).
// Polls every 7 s only while something is Queued / Running and the tab is visible; stops on unmount.
// ---------------------------------------------------------------------------
export function useJobPublish(jobId) {
  const [st, setSt] = useState({ status: null, infos: [], loading: true, error: '', notOn: false, worker: null });
  const reload = useCallback(async () => {
    try {
      const [status, ports] = await Promise.all([(jobId ? jp.get(`/jobs/${jobId}/status`) : Promise.resolve(null)), jp.get('/portals')]);
      setSt({ status, infos: ports.portals || [], loading: false, error: '', notOn: false, worker: ports.worker || null, killAll: !!ports.killAll, paused: !!ports.paused });
    } catch (e) {
      setSt((s) => ({ ...s, loading: false, error: isNotMigrated(e) ? '' : jpError(e, 'Could not read the posting status.'), notOn: isNotMigrated(e) }));
    }
  }, [jobId]);
  useEffect(() => { setSt((s) => ({ ...s, loading: true })); reload(); }, [reload]);
  const items = (st.status && st.status.portals) || [];
  const going = items.some((p) => ['QUEUED', 'RUNNING', 'HELP'].includes(portalState({ posting: p }).key));
  useVisiblePoll(reload, going, 7000);
  return { ...st, reload, going };
}

export default function JobPortalRows({
  jobId, data, canPost, onChanged, only = null, showLogs = false,
}) {
  const { status, infos, reload } = data;
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const postings = (status && status.portals) || [];
  const keys = only || PORTALS.map((p) => p.key);

  async function run(key, label, fn, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key); setErr(''); setMsg('');
    try {
      const out = await fn();
      const r = out && out.results && out.results[0];
      setMsg(r ? `${label}: ${r.reason || 'Done.'}` : `${label}: done.`);
      await reload();
      if (onChanged) onChanged();
    } catch (e) { setErr(jpError(e)); } finally { setBusy(''); }
  }
  const send = (action, portal, extra) => () => jp.post(`/jobs/${jobId}/${action}`, { portals: [portal], ...(extra || {}) });

  return (
    <div className="jp-portals" aria-live="polite">
      {keys.map((k) => {
        const info = infos.find((x) => x.portal === k);
        const posting = postings.find((x) => x.portal === k);
        const s = portalState({ posting, info });
        const name = (PORTALS.find((p) => p.key === k) || {}).name || (info && info.name) || k;
        const lq = posting && posting.lastQueue;
        const b = busy === k;
        return (
          <div className="jp-portal" key={k}>
            <div className="jp-row">
              <b style={{ fontSize: 14.5 }}>{name}</b>
              <PortalChip state={s} />
              {s.key === 'PUBLISHED' && posting.portalUrl && <a href={posting.portalUrl} target="_blank" rel="noreferrer">See the post</a>}
              {s.key === 'PUBLISHED' && posting.publishedAt && <span className="jp-note">{when(posting.publishedAt)}</span>}
            </div>
            {(s.key === 'HELP' || (s.key === 'NEEDS_CHECK' && lq && lq.help)) && <NeedsHelp item={lq} name={name} canPost={canPost} onChanged={() => { reload(); if (onChanged) onChanged(); }} />}
            {s.detail && s.key !== 'PUBLISHED' && s.key !== 'HELP' && <div className="jp-note">{s.detail}{s.key === 'FAILED' && lq && lq.errorCode ? ` (${lq.errorCode})` : ''}</div>}
            {s.key === 'NEEDS_CHECK' && posting.portalUrl && <a className="jp-note" href={posting.portalUrl} target="_blank" rel="noreferrer">Open the portal and check</a>}
            {posting && posting.byHand && (s.key === 'BY_HAND' || s.key === 'OFF' || s.key === 'NOT_CONNECTED' || posting.waitingForPerson) && (
              <div className="jp-note">Post by hand: we made a task. <Link to={`/requirements/${jobId}`}>Open the requirement to finish it</Link>.</div>
            )}
            {canPost && (
              <div className="jp-row jp-acts">
                {s.key === 'PUBLISHED' && <button type="button" className="btn btn-sm" disabled={b} onClick={() => run(k, 'Republish', send('republish', k))}>Republish</button>}
                {['PUBLISHED', 'NEEDS_CHECK'].includes(s.key) && <button type="button" className="btn btn-sm btn-danger" disabled={b} onClick={() => run(k, 'Take down', send('unpublish', k), `Take this requirement down from ${name}?`)}>Take down</button>}
                {['FAILED'].includes(s.key) && lq && lq.id && <button type="button" className="btn btn-sm btn-primary" disabled={b} onClick={() => run(k, 'Retry', () => jp.post(`/queue/${lq.id}/retry`))}>Retry</button>}
                {['FAILED', 'LOGIN_FAILED'].includes(s.key) && !(lq && lq.id) && s.key === 'FAILED' && <button type="button" className="btn btn-sm btn-primary" disabled={b} onClick={() => run(k, 'Retry', send('publish', k))}>Retry</button>}
                {s.key === 'NEEDS_CHECK' && lq && lq.id && <button type="button" className="btn btn-sm" disabled={b} onClick={() => run(k, 'Try again', () => jp.post(`/queue/${lq.id}/retry`), `Check ${name} first: the requirement may already be live. Try again anyway?`)}>I checked, try again</button>}
                {s.key === 'QUEUED' && lq && lq.id && <button type="button" className="btn btn-sm" disabled={b} onClick={() => run(k, 'Cancel', () => jp.post(`/queue/${lq.id}/cancel`))}>Cancel</button>}
                {['UNPUBLISHED', 'EXPIRED', 'DRAFT'].includes(s.key) && <button type="button" className="btn btn-sm" disabled={b} onClick={() => run(k, 'Post', send('publish', k))}>Post again</button>}
                {b && <span className="jp-note">Working...</span>}
              </div>
            )}
            {showLogs && posting && (posting.logs || []).length > 0 && (
              <ul className="jp-logs">
                {posting.logs.slice(0, 3).map((l, i) => <li key={i}><span className="t">{when(l.at)}</span><span className={`jp-lvl-${l.level}`}>{l.message}</span></li>)}
              </ul>
            )}
          </div>
        );
      })}
      <div role="status" aria-live="polite">
        {msg && <div className="jp-ok">{msg}</div>}
        {err && <div className="jp-err" role="alert">{err}</div>}
      </div>
    </div>
  );
}
