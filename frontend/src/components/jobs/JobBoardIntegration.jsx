import { useEffect, useState } from 'react';
import api from '../../api';
import './jobPostingSites.css';
import './postByHand.css';

// ---------------------------------------------------------------------------
// A JOB BOARD's CONNECT CARD on Administration → Integrations.
//
// Clear in 20 seconds for someone who has never done it:
//   1. One status word: Not connected / Waiting for approval / Connected / Problem
//      — with the reason. "Connected" only on proof (the board accepted our
//      sign-in, a job was confirmed live, or the board read our feed).
//   2. What works TODAY, what needs the board's account, what the board does
//      not offer (honest, dated).
//   3. Plain steps, the exact fields to paste, the feed link to copy, how long
//      and how much, who to ask, how applicants come back.
//   4. Buttons: Check connection (a real sign-in test where the board has one —
//      nothing is ever posted by it) · Paste details · I have applied.
// Credentials are never sent to this page (the server masks them).
// GET /admin/integrations/:id/board-status · POST …/applied (routes/admin.js)
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never');
const WORD_TONE = { Connected: 'active', 'Waiting for approval': 'pending', 'Not connected': 'pending', Problem: 'rejected' };
const ROUTE_WORD = { works: ['Works today', 'active'], built: ['Ready here — needs their account', 'pending'], gated: ['Not offered to us right now', 'rejected'] };
const abs = (u) => (/^https?:/i.test(u) ? u : `${window.location.origin}${u}`);

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(t); return ok;
  }
}

export default function JobBoardIntegration({ channel, run, onConfigure, reloadKey }) {
  const [st, setSt] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [open, setOpen] = useState(null); // null = decide from the status
  const [copied, setCopied] = useState('');
  const load = () => api.get(`/admin/integrations/${channel.id}/board-status`).then((r) => setSt(r.data)).catch(() => setSt(false));
  useEffect(() => { load(); }, [channel.id, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (st === false) return null;
  if (!st) return <div className="jbi small-muted">Loading…</div>;
  const after = () => load();
  const c = st.connect;
  const expanded = open === null ? st.word === 'Problem' : open;
  const doCopy = async (label, text) => { const ok = await copy(text); setCopied(ok ? label : ''); setTimeout(() => setCopied(''), 2500); };
  const checkWord = st.ready ? 'Check connection' : 'Paste the details…';
  return (
    <div className="jbi">
      <div className="jbi-top">
        <span className={`status ${WORD_TONE[st.word] || 'pending'}`} style={{ fontSize: 13 }}>{st.word}</span>
        <span className="jbi-why">{st.wordWhy}</span>
      </div>
      <div className="jbi-jobs small-muted">
        {`${st.jobs.posted} posted by TeamLink · ${st.jobs.byHand || 0} posted by hand · ${st.jobs.waiting} waiting for the board · ${st.jobs.failed} failed · ${st.jobs.setup} waiting for this connection`}
      </div>

      {c && (
        <>
          <div className="jbi-headline">{c.headline}</div>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>{expanded ? 'Hide how to connect' : 'Show how to connect'}</button>
          {expanded && (
            <div className="jbi-guide">
              <div className="jbi-routes">
                {c.routes.map((r) => (
                  <div key={r.id} className="jbi-route">
                    <div className="jbi-route-h"><b>{r.title}</b> <span className={`status ${ROUTE_WORD[r.state][1]}`}>{ROUTE_WORD[r.state][0]}</span></div>
                    <div>{r.text}</div>
                  </div>
                ))}
              </div>

              {st.feedLinks && st.feedLinks.length > 0 && (
                <div className="jbi-links">
                  {st.feedLinks.map((f) => (
                    <div key={f.url} className="jbi-link">
                      <b>{f.label}</b>
                      <div className="jbi-link-row"><code>{abs(f.url)}</code><button type="button" className="btn btn-sm" onClick={() => doCopy(f.url, abs(f.url))}>{copied === f.url ? 'Copied' : 'Copy link'}</button></div>
                      <div className="small-muted">{f.note ? `${f.note} ` : ''}{f.lastRead ? `Last read by the board ${when(f.lastRead.at)}.` : 'Not read by the board yet.'}</div>
                    </div>
                  ))}
                  {!st.publicAddressSet && <div className="pbh-warn">This server does not know its public web address yet (APP_BASE_URL). The links above show this computer&rsquo;s address; the board can only read them once your site is public. Ask your admin.</div>}
                </div>
              )}

              <b>Steps</b>
              <ol className="jbi-steps">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>

              <b>What to paste in &ldquo;Paste the details&rdquo;</b>
              <ul className="jbi-fields">{c.fields.map((f) => <li key={f.label}><b>{f.label}</b> — {f.where}</li>)}</ul>

              <div className="jbi-grid" style={{ marginTop: 8 }}>
                <span className="k">How long</span><span>{c.leadTime}</span>
                <span className="k">How much</span><span>{c.cost}</span>
                <span className="k">Who to ask</span><span><b>{c.ask.who}</b>: {c.ask.what}</span>
                <span className="k">Applicants come back</span><span>{c.applicants}</span>
              </div>
              {c.notPossible.length > 0 && (
                <div style={{ marginTop: 8 }}><b>What is not possible</b>
                  <ul className="jbi-fields">{c.notPossible.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
              )}
              <div className="small-muted">Checked {c.checkedOn}. Prices are third-party and indicative. {c.docs.map((d, i) => <span key={d.url}>{i ? ' · ' : ''}<a href={d.url} target="_blank" rel="noreferrer">{d.label}</a></span>)}</div>
            </div>
          )}
        </>
      )}

      <div className="jbi-btns">
        {st.ready
          ? <button type="button" className="btn btn-sm btn-primary" onClick={() => run(() => api.post(`/admin/integrations/${channel.id}/test`), (r) => `${channel.name}: ${r.data.result}`).then(after)}>Check connection</button>
          : <button type="button" className="btn btn-sm btn-primary" onClick={() => onConfigure(channel)}>{checkWord}</button>}
        {st.ready && <button type="button" className="btn btn-sm" onClick={() => onConfigure(channel)}>Change the details…</button>}
        {!st.ready && !st.applied && c && st.canPostByHand !== undefined && (
          <button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/${channel.id}/applied`, { applied: true }), `${channel.name}: marked as waiting for approval.`).then(after)}>I have applied — waiting</button>
        )}
        {st.applied && !st.ready && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => run(() => api.post(`/admin/integrations/${channel.id}/applied`, { applied: false }), 'Cleared.').then(after)}>I did not apply</button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowDetails((v) => !v)}>{showDetails ? 'Hide technical details' : 'Technical details'}</button>
      </div>
      {st.lastCheck && <div className="small-muted">Last check {when(st.lastCheck.at)}: {st.lastCheck.text}</div>}

      {showDetails && (
        <div className="jbi-grid" style={{ marginTop: 8 }}>
          <span className="k">Connection</span><span>{st.connection}</span>
          <span className="k">Account / Employer ID</span><span>{st.account || '—'}</span>
          <span className="k">Posting method</span><span>{st.method || '—'}</span>
          <span className="k">Last successful post</span><span>{when(st.lastSuccessAt)}</span>
          <span className="k">Last error</span>
          <span>{st.lastError ? <span className="jbi-err">{st.lastError}</span> : 'None'}{st.lastErrorDetails && <div className="jbi-details">{st.lastErrorDetails}</div>}</span>
          <span className="k">Reconnect</span>
          <span><button type="button" className="btn btn-sm" onClick={() => run(() => api.post(`/admin/integrations/${channel.id}/connect`), `${channel.name} reconnected with the saved settings.`).then(after)}>Reconnect with the saved details</button></span>
        </div>
      )}
    </div>
  );
}
