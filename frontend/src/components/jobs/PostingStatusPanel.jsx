import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import PostByHand from './PostByHand.jsx';
import PostWalkthrough from './PostWalkthrough.jsx';
import './jobPostingSites.css';
import './postByHand.css';
import './postingChoices.css';

// ---------------------------------------------------------------------------
// THE PANEL RIGHT AFTER SAVE & POST (spec §15, rebuilt 2026-10-10).
// One line first: "2 of 6 sites posted automatically. 4 you must post by hand: Naukri, …".
// Then one row per ticked site:
//   Job Portal / Website      ✓ Posted (Auto) · View job
//   Naukri, Shine, LinkedIn,  ⏳ Waiting for you to post (by hand) with three buttons:
//   Indeed (not connected)    [Copy job text] [Open Naukri] [I posted it] (paste the live link)
//   a connected board         ✓ Posted / ⏳ waiting for the board / ✕ Failed + Retry
//   Indeed in our feed        ⏳ In our Indeed feed (Indeed reads it on its own schedule)
// A board is NEVER shown as Posted until the person says so ("I posted it" → "Posted (by hand)")
// or the board confirms it. [Post them one by one] walks through the waiting boards.
// GET /requirements/:id/posting-sites · POST …/postings/retry · by-hand helper routes
// ---------------------------------------------------------------------------
const GOING = ['QUEUED', 'POSTING', 'RETRYING', 'REMOVING'];
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
const fullLink = (l) => (/^https?:/i.test(l) ? l : `${origin()}${l}`);
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(t);
    return ok;
  }
}

export default function PostingStatusPanel({ requirementId, code, title, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [helpers, setHelpers] = useState({}); // board -> the by-hand helper (text, gaps, link to open)
  const [linkFor, setLinkFor] = useState(null); // the board whose "I posted it" box is open
  const [url, setUrl] = useState('');
  const [fix, setFix] = useState(null); // PostByHand modal (fill the [ ] gaps)
  const [walk, setWalk] = useState(false);
  const polls = useRef(0);

  const load = () => api.get(`/requirements/${requirementId}/posting-sites`)
    .then((r) => { setData(r.data); return r.data; })
    .catch((e) => setError(e.response?.data?.error || 'Could not read the posting status.'));
  useEffect(() => { polls.current = 0; load(); }, [requirementId]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = data ? data.sites.filter((s) => s.ticked && s.code !== 'NOT_SELECTED' && s.id !== 'google') : null;
  const waiting = (shown || []).filter((s) => s.code === 'WAITING_BY_HAND');
  const going = (shown || []).some((s) => GOING.includes(s.code) && !s.waiting);

  useEffect(() => {
    if (!shown || !going || polls.current > 60) return undefined;
    const t = setTimeout(() => { polls.current += 1; load(); }, 2000);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get the text ready for every board that waits, so [Copy job text] is one click.
  const waitKey = waiting.map((s) => s.id).join(',');
  useEffect(() => {
    waiting.forEach((s) => {
      if (helpers[s.id]) return;
      api.get(`/requirements/${requirementId}/posting-sites/${s.id}/by-hand`)
        .then((r) => setHelpers((h) => ({ ...h, [s.id]: r.data })))
        .catch(() => {});
    });
  }, [waitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copyJob(s) {
    const h = helpers[s.id];
    if (!h) { setNote('Getting the text ready… press again in a second.'); return; }
    setNote((await copyText(h.text)) ? `Copied the ${s.name} text. Now open ${s.name} and paste it.` : 'Your browser did not allow copying. Open "Fix the gaps" to copy by hand.');
  }
  async function posted(s) {
    setBusy(`done-${s.id}`); setError(''); setNote('');
    try {
      const r = await api.post(`/requirements/${requirementId}/posting-sites/${s.id}/by-hand/done`, { url });
      setData(r.data);
      setLinkFor(null); setUrl('');
      setNote(`Saved: ${s.name} is posted (by hand).`);
      if (onChanged) onChanged();
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(''); }
  }
  async function retryFailed() {
    setBusy('retry'); setError(''); setNote('');
    try {
      await api.post(`/requirements/${requirementId}/postings/retry`);
      polls.current = 0;
      await load();
      setNote('Tried the failed sites again.');
    } catch (e) {
      setError(e.response?.data?.error || 'That did not work. Please try again.');
    } finally { setBusy(''); }
  }

  const needsSetup = (s) => s.code === 'INTEGRATION_REQUIRED' || s.code === 'SETUP_REQUIRED';
  const failed = (shown || []).filter((s) => s.code === 'FAILED' || (needsSetup(s) && s.canRetry));
  const sum = data ? data.summary : null;
  const sumTone = !sum ? '' : waiting.length ? ' is-wait' : (sum.total && sum.posted === sum.total ? ' is-done' : '');
  const gone = waiting.filter((s) => s.why);

  return (
    <div className="pc-panel" role="status" aria-live="polite">
      <div className="pc-head">
        <b>Your requirement is saved</b>
        <span className="small-muted">{code || title || ''}</span>
        <button type="button" className="pc-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {!data && <div className="small-muted">{error || 'Loading…'}</div>}
      {sum && <div className={`pc-sum${sumTone}`}>{sum.line}</div>}
      {shown && !shown.length && <div className="small-muted">No site was ticked, so the requirement is not posted anywhere.</div>}
      {shown && shown.map((s) => {
        const isWait = s.code === 'WAITING_BY_HAND';
        const h = helpers[s.id];
        const link = s.link ? fullLink(s.link) : (s.hand && s.hand.url) || null;
        return (
          <div key={s.id} className={`pc-row is-${s.tone || 'grey'}`}>
            <span className="pc-row-name">{s.name}</span>
            <span className="pc-row-st">
              {s.label}
              {(s.code === 'POSTED') && s.mode === 'auto' && <span className={`jps-mode is-auto`} style={{ marginLeft: 6 }}>Auto</span>}
            </span>
            {!isWait && (s.code === 'FAILED' || needsSetup(s) || s.code === 'WAITING_FOR_AGREEMENT' || s.waiting || s.code === 'POSTED_BY_HAND') && (
              <span className="pc-row-why">
                {s.code === 'POSTED_BY_HAND' ? `${(s.hand && s.hand.by) || 'Posted by hand'}${s.hand && s.hand.at ? ` · ${when(s.hand.at)}` : ''}` : s.reason}
                {needsSetup(s) && (s.setupLink ? <>{' '}<Link to={s.setupLink}>Configure integration →</Link></> : ' Ask your admin.')}
              </span>
            )}
            {(s.code === 'POSTED' || s.code === 'POSTED_BY_HAND') && link && <a className="pc-row-why" href={link} target="_blank" rel="noreferrer">View requirement ↗</a>}
            {isWait && (
              <>
                <span className="pc-row-why">{s.reason}{s.hand && s.hand.overdue ? ` Waiting ${s.hand.waitedHours} hours.` : ''}</span>
                {h && h.gaps && h.gaps.length > 0 && (
                  <span className="pc-gap">
                    The text still has empty [ ] gaps for: {h.gaps.join(', ')}.{' '}
                    <button type="button" className="btn btn-sm" onClick={() => setFix(s)}>Fill the gaps</button>
                  </span>
                )}
                <div className="pc-steps">
                  <button type="button" className="btn btn-sm btn-primary" disabled={!h} onClick={() => copyJob(s)}>Copy job text</button>
                  <a className="btn btn-sm" href={(h && h.openUrl) || (s.hand && s.hand.openUrl) || '#'} target="_blank" rel="noreferrer">Open {s.name} ↗</a>
                  <button type="button" className="btn btn-sm" onClick={() => { setLinkFor(linkFor === s.id ? null : s.id); setUrl(''); }}>I posted it</button>
                </div>
                {linkFor === s.id && (
                  <div className="pc-link">
                    <label htmlFor={`pc-url-${s.id}`}>Paste the link of the live requirement from {s.name} (you can leave it empty)</label>
                    <input id={`pc-url-${s.id}`} type="url" inputMode="url" placeholder={`https://… (from ${s.name})`} value={url} onChange={(e) => setUrl(e.target.value)} />
                    <div className="pc-steps">
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy === `done-${s.id}`} onClick={() => posted(s)}>
                        {busy === `done-${s.id}` ? 'Saving…' : `Yes, it is live on ${s.name}`}
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLinkFor(null)}>Not yet</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {gone.length > 0 && (
        <details className="pc-why-panel">
          <summary>Why can&rsquo;t TeamLink post these by itself?</summary>
          {gone.map((s) => (
            <div key={s.id} className="pc-why-b">
              <b>{s.name}.</b> {s.why}
              {s.ask && <div>To switch it on, ask <b>{s.ask.who}</b>: {s.ask.what}</div>}
              {s.cardLink
                ? <div><Link to={s.cardLink}>Open the {s.name} Connect card →</Link></div>
                : <div>Ask your Admin to open the {s.name} Connect card (Administration, Integrations).</div>}
            </div>
          ))}
        </details>
      )}
      <div className="pc-foot">
        {waiting.length > 1 && (
          <button type="button" className="btn btn-primary" onClick={() => setWalk(true)}>Post them one by one ({waiting.length})</button>
        )}
        {failed.length > 0 && (
          <button type="button" className="btn btn-sm btn-primary" disabled={!!busy || going} onClick={retryFailed}>
            {busy === 'retry' ? 'Trying…' : `Retry failed (${failed.length})`}
          </button>
        )}
        <Link className="btn btn-sm" to={`/requirements/${requirementId}`}>Open requirement</Link>
        {going && <span className="small-muted">Updating…</span>}
      </div>
      {waiting.length > 0 && <div className="small-muted">Not done today? We remind you, the TL and the recruiters once a day until it is posted.</div>}
      {note && data && <div className="jobops-ok" role="status">{note}</div>}
      {error && data && <div className="error-text">{error}</div>}
      {fix && (
        <PostByHand
          requirementId={requirementId}
          source={fix.id}
          name={fix.name}
          onClose={() => { setFix(null); setHelpers((hh) => { const n = { ...hh }; delete n[fix.id]; return n; }); load(); }}
          onChanged={(payload) => { if (payload && payload.sites) setData(payload); }}
        />
      )}
      {walk && (
        <PostWalkthrough
          pairs={waiting.map((s) => ({ requirementId, reqCode: code, title: title || code, board: s.id, boardName: s.name, waitedHours: (s.hand && s.hand.waitedHours) || 0 }))}
          onClose={() => { setWalk(false); load(); }}
          onChanged={() => { if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}
