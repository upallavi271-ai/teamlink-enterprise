import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../ui/StatusChip.jsx';
import './jobops.css';
import './jobPostingSites.css';

// ---------------------------------------------------------------------------
// "POSTING SOURCES" on the job page — Save & Post (spec §4 / §16, 2026-10-05).
// One row per site with its REAL result, stored per site on the server
// (utils/jobConnectors.js, RequirementPosting), in plain words:
//   ✓ Posted [View job] · ⏳ Queued / Posting… / Retrying… · ⏳ Sent, waiting
//   for confirmation · ✕ Failed [Retry] · ⚠ Setup required [Configure
//   integration] (Admins; others: "Ask your admin") · Waiting for agreement ·
//   Draft · Paused · Removed · Not selected
// Nothing is ever shown as Posted unless the site confirmed it. While a site
// is still going, the card looks again every few seconds; Refresh looks now.
// [Retry failed] tries every site that did not go through — never a Posted one.
//
// GET / PUT /requirements/:id/posting-sites,
// POST /requirements/:id/posting-sites/:source/retry, POST /requirements/:id/postings/retry
// ---------------------------------------------------------------------------
const TONE = { green: 'green', blue: 'blue', orange: 'amber', red: 'red', grey: 'grey' };
const GOING = ['QUEUED', 'POSTING', 'RETRYING', 'REMOVING'];
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
const fullLink = (l) => (/^https?:/i.test(l) ? l : `${origin()}${l}`);
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function JobPostingSites({ requirementId, version, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const polls = useRef(0);

  const load = () => api.get(`/requirements/${requirementId}/posting-sites`)
    .then((r) => { setData(r.data); setError(''); })
    .catch((e) => setError(e.response?.data?.error || 'Could not load where this job is posted.'));
  useEffect(() => { polls.current = 0; load(); }, [requirementId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Posting runs in the background: look again while a site is still going.
  useEffect(() => {
    if (!data || !data.sites.some((s) => GOING.includes(s.code) && !s.waiting) || polls.current > 60) return undefined;
    const t = setTimeout(() => { polls.current += 1; load(); }, 2500);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(key, fn) {
    setBusy(key); setNote(''); setError('');
    try { await fn(); if (onChanged) onChanged(); } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(''); }
  }
  const toggle = (site) => run(site.id, async () => {
    const ticked = data.sites.filter((s) => s.ticked).map((s) => s.id);
    const next = site.ticked ? ticked.filter((x) => x !== site.id) : [...ticked, site.id];
    const res = await api.put(`/requirements/${requirementId}/posting-sites`, { sites: next });
    polls.current = 0;
    setData(res.data);
    setNote(res.data.ok || 'Saved.');
  });
  const retry = (site) => run(`retry-${site.id}`, async () => {
    const res = await api.post(`/requirements/${requirementId}/posting-sites/${site.id}/retry`);
    polls.current = 0;
    setData(res.data);
    setNote(res.data.ok || 'Tried again.');
  });
  const retryFailed = () => run('retry-all', async () => {
    await api.post(`/requirements/${requirementId}/postings/retry`);
    polls.current = 0;
    await load();
    setNote('Tried the failed sites again.');
  });
  const refresh = () => run('refresh', async () => { polls.current = 0; await load(); });

  if (!data) return <div className="jobops small-muted">{error || 'Loading…'}</div>;
  const edit = data.canEdit;
  const ticked = data.sites.filter((s) => s.ticked);
  const posted = ticked.filter((s) => s.code === 'POSTED').length;
  const going = data.sites.some((s) => GOING.includes(s.code) && !s.waiting);
  const needsSetup = (s) => s.code === 'INTEGRATION_REQUIRED' || s.code === 'SETUP_REQUIRED';
  const failed = data.sites.filter((s) => s.code === 'FAILED' || (needsSetup(s) && s.canRetry));
  return (
    <div className="jobops jobops-sites jps">
      <div className="jobops-sites-head">
        <b>Posting sources</b>
        <span className="small-muted">
          {ticked.length ? `${posted} of ${ticked.length} ticked site${ticked.length === 1 ? '' : 's'} live${going ? ' · posting now…' : ''}` : 'No site ticked yet'}
        </span>
        {edit && failed.length > 0 && (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'retry-all' || going} onClick={retryFailed}>
            {busy === 'retry-all' ? 'Trying…' : `Retry failed (${failed.length})`}
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={busy === 'refresh'} onClick={refresh}>{busy === 'refresh' ? 'Looking…' : 'Refresh'}</button>
      </div>
      {data.sites.map((s) => (
        <div key={s.id} className={`jobops-site${s.ticked ? '' : ' is-off'}`}>
          <label className="jobops-tick">
            <input type="checkbox" checked={s.ticked} disabled={!edit || busy === s.id} onChange={() => toggle(s)} />
            <b>{s.name}</b>
          </label>
          <StatusChip tone={s.code === 'NOT_SELECTED' ? 'grey' : (TONE[s.tone] || 'grey')}>{s.label || s.status}</StatusChip>
          <span className="jobops-site-btns">
            {s.code === 'POSTED' && s.link && <a className="btn btn-sm" href={fullLink(s.link)} target="_blank" rel="noreferrer">View job ↗</a>}
            {needsSetup(s) && (s.setupLink
              ? <Link className="btn btn-sm" to={s.setupLink}>Configure integration</Link>
              : <span className="small-muted">Ask your admin</span>)}
            {edit && s.canRetry && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy === `retry-${s.id}`} onClick={() => retry(s)}>
                {busy === `retry-${s.id}` ? 'Trying…' : (s.code === 'NOT_POSTED' ? 'Post now' : (s.waiting ? 'Check again' : 'Retry'))}
              </button>
            )}
          </span>
          <span className="jobops-why" style={{ whiteSpace: 'pre-line' }}>
            {s.code === 'NOT_SELECTED' ? 'Not ticked for this job.' : s.reason}
            {s.lastTriedAt && s.code !== 'NOT_SELECTED' && (
              <span className="small-muted">{` · last tried ${when(s.lastTriedAt)}${s.retryCount > 1 ? ` (${s.retryCount} tries)` : ''}`}</span>
            )}
          </span>
        </div>
      ))}
      {note && <div className="jobops-ok" role="status">{note}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
