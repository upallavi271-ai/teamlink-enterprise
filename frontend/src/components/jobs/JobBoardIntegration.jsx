import { useEffect, useState } from 'react';
import api from '../../api';
import './jobPostingSites.css';

// ---------------------------------------------------------------------------
// A JOB BOARD's details on Administration → Integrations (Save & Post spec
// §14, 2026-10-05): connection status, account / employer id, posting method,
// last successful post, last error in plain words (details on request), and
// the three actions [Test connection] [Save] [Reconnect]. Credentials are
// never sent to this page (the server masks them); Save opens Configure.
// GET /admin/integrations/:id/board-status (routes/admin.js)
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never');
const TONE = { Ready: 'active', Error: 'rejected', 'Switched off': 'pending', 'Not set up': 'pending' };

export default function JobBoardIntegration({ channel, run, onConfigure, reloadKey }) {
  const [st, setSt] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const load = () => api.get(`/admin/integrations/${channel.id}/board-status`).then((r) => setSt(r.data)).catch(() => setSt(false));
  useEffect(() => { load(); }, [channel.id, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (st === false) return null;
  if (!st) return <div className="jbi small-muted">Loading…</div>;
  const after = () => load();
  return (
    <div className="jbi">
      <div className="jbi-grid">
        <span className="k">Connection</span><span><span className={`status ${TONE[st.connection] || 'pending'}`}>{st.connection}</span></span>
        <span className="k">Account / Employer ID</span><span>{st.account || '—'}</span>
        <span className="k">Posting method</span><span>{st.method || '—'}</span>
        {st.feedUrl && (<><span className="k">Feed link for {st.name}</span><span><code>{st.feedUrl}</code>{st.feedLastRead ? ` · last read by the board ${when(st.feedLastRead.at)}` : ' · not read by the board yet'}</span></>)}
        <span className="k">Last successful post</span><span>{when(st.lastSuccessAt)}</span>
        <span className="k">Jobs</span><span>{`${st.jobs.posted} posted · ${st.jobs.waiting} waiting for confirmation · ${st.jobs.failed} failed · ${st.jobs.setup} need setup`}</span>
        <span className="k">Last error</span>
        <span>
          {st.lastError ? <span className="jbi-err">{st.lastError}</span> : 'None'}
          {st.lastErrorDetails && (
            <>
              {' '}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDetails((v) => !v)}>{showDetails ? 'Hide details' : 'Details'}</button>
              {showDetails && <div className="jbi-details">{st.lastErrorDetails}</div>}
            </>
          )}
        </span>
      </div>
      {!st.ready && st.hint && <div className="jbi-hint">{st.hint}</div>}
      <div className="jbi-btns">
        <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/${channel.id}/test`), (r) => `${channel.name}: ${r.data.result}`).then(after)}>Test connection</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => onConfigure(channel)}>Save settings…</button>
        <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/${channel.id}/connect`), `${channel.name} reconnected with the saved settings.`).then(after)}>Reconnect</button>
      </div>
    </div>
  );
}
