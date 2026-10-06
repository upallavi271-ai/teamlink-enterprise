import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './jobPostingSites.css';

// ---------------------------------------------------------------------------
// "POSTING STATUS" right where Save & Post was pressed (spec §15, 2026-10-05).
// A small panel in the corner that updates by itself:
//   ✓ Posted · ⏳ Posting… · ✕ Failed — reason · ⚠ Setup required
// [Retry failed] tries again every site that did not go through (never a
// Posted one). Close it any time and keep working; the job page keeps the
// same statuses (components/jobs/JobPostingSites.jsx).
// GET /requirements/:id/posting-sites · POST /requirements/:id/postings/retry
// ---------------------------------------------------------------------------
const GOING = ['QUEUED', 'POSTING', 'RETRYING', 'REMOVING'];
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
const fullLink = (l) => (/^https?:/i.test(l) ? l : `${origin()}${l}`);

export default function PostingStatusPanel({ requirementId, code, title, onClose }) {
  const [sites, setSites] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const polls = useRef(0);

  const load = () => api.get(`/requirements/${requirementId}/posting-sites`)
    .then((r) => setSites(r.data.sites.filter((s) => s.ticked && s.code !== 'NOT_SELECTED')))
    .catch((e) => setNote(e.response?.data?.error || 'Could not read the posting status.'));
  useEffect(() => { polls.current = 0; load(); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!sites || !sites.some((s) => GOING.includes(s.code) && !s.waiting) || polls.current > 60) return undefined;
    const t = setTimeout(() => { polls.current += 1; load(); }, 2000);
    return () => clearTimeout(t);
  }, [sites]); // eslint-disable-line react-hooks/exhaustive-deps

  async function retryFailed() {
    setBusy(true); setNote('');
    try {
      await api.post(`/requirements/${requirementId}/postings/retry`);
      polls.current = 0;
      await load();
      setNote('Tried the failed sites again.');
    } catch (e) {
      setNote(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(false); }
  }

  const needsSetup = (s) => s.code === 'INTEGRATION_REQUIRED' || s.code === 'SETUP_REQUIRED';
  const failed = (sites || []).filter((s) => s.code === 'FAILED' || (needsSetup(s) && s.canRetry));
  const going = (sites || []).some((s) => GOING.includes(s.code) && !s.waiting);
  return (
    <div className="jps-toast" role="status" aria-live="polite">
      <div className="jps-toast-head">
        <b>Posting status</b>
        <span className="small-muted">{code || title || ''}</span>
        <button type="button" className="jps-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {!sites && <div className="small-muted">{note || 'Loading…'}</div>}
      {sites && !sites.length && <div className="small-muted">No site was ticked, so the job is not posted anywhere.</div>}
      {sites && sites.map((s) => (
        <div key={s.id} className={`jps-toast-row is-${s.tone || 'grey'}`}>
          <span className="jps-toast-site">{s.name}</span>
          <span className="jps-toast-st">{s.label}</span>
          {(s.code === 'FAILED' || needsSetup(s) || s.code === 'WAITING_FOR_AGREEMENT' || s.waiting) && (
            <span className="jps-toast-why" style={{ whiteSpace: 'pre-line' }}>
              {s.reason}
              {needsSetup(s) && (s.setupLink
                ? <>{' '}<Link to={s.setupLink}>Configure integration →</Link></>
                : ' Ask your admin.')}
            </span>
          )}
          {s.code === 'POSTED' && s.link && <a className="jps-toast-link" href={fullLink(s.link)} target="_blank" rel="noreferrer">View job ↗</a>}
        </div>
      ))}
      <div className="jps-toast-foot">
        {failed.length > 0 && (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || going} onClick={retryFailed}>
            {busy ? 'Trying…' : `Retry failed (${failed.length})`}
          </button>
        )}
        <Link className="btn btn-sm" to={`/requirements/${requirementId}`}>Open job</Link>
        {going && <span className="small-muted">Updating…</span>}
      </div>
      {note && sites && <div className="small-muted">{note}</div>}
    </div>
  );
}
