import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './jobPostingSites.css';
import '../messaging/messaging.css';

// ---------------------------------------------------------------------------
// NAUKRI on Administration → Integrations: every way of working with Naukri,
// what is Working, what is built and only needs Naukri's account, and what
// Naukri simply does not offer (so it is not built and never faked).
// GET /api/naukri/status (routes/naukri.js). Nothing here calls Naukri.
// ---------------------------------------------------------------------------
const TONE = (s) => (/^Working/.test(s) ? 'active' : /^Not available/.test(s) ? 'rejected' : 'pending');
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);

export default function NaukriMethods() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.get('/naukri/status').then((r) => setD(r.data)).catch(() => setD(false)); }, []);
  if (d === false) return null;
  if (!d) return <div className="jbi small-muted">Loading what Naukri allows…</div>;
  return (
    <div className="jbi" style={{ marginTop: 6 }}>
      <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} what you can do with Naukri ({d.capabilities.filter((c) => /^Working/.test(c.state)).length} working, {d.capabilities.filter((c) => /^Built/.test(c.state)).length} need an account, {d.capabilities.filter((c) => /^Not available/.test(c.state)).length} not offered by Naukri)
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            Naukri has no public API. Employers connect through a paid Naukri plan and its ATS module &ldquo;Zwayam Amplify&rdquo;. Checked on {d.checkedOn}. Anything marked &ldquo;Not available&rdquo; is something Naukri does not let an ATS do, so TeamLink does not pretend to.
          </div>
          {d.capabilities.map((c) => (
            <div key={c.id} className="mt-card" style={{ marginBottom: 8 }}>
              <h4 style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{c.title} <span className={`status ${TONE(c.state)}`}>{c.state}</span></h4>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{c.what}</div>
              {c.id === 'feed' && c.feedUrl && <div className="small-muted" style={{ marginTop: 4 }}>Feed link: <code>{c.feedUrl}</code>{c.lastRead ? ` · last read by Naukri ${when(c.lastRead.at)}` : ' · Naukri has not read it yet'}</div>}
              {c.id === 'email-intake' && (
                <div className="small-muted" style={{ marginTop: 4 }}>
                  {c.counts.candidates} candidate(s) came from Naukri so far{c.counts.last30days ? `, ${c.counts.last30days} in the last 30 days` : ''}{c.counts.lastArrivedAt ? `, the last one on ${when(c.counts.lastArrivedAt)}` : ''}.
                  {c.counts.waitingToBeChecked > 0 && ` ${c.counts.waitingToBeChecked} are waiting to be checked.`}
                  {' '}<Link to={c.link}>Open &ldquo;New from Naukri&rdquo;</Link>
                </div>
              )}
              {c.id === 'posting' && c.detail && c.detail.lastError && <div className="small-muted" style={{ marginTop: 4, color: '#8a1c14' }}>Last problem: {c.detail.lastError}</div>}
              {c.needs && c.needs.length > 0 && (
                <div style={{ marginTop: 6 }}><b style={{ fontSize: 12.5 }}>What you need from Naukri</b>
                  <ul className="mt-steps">{c.needs.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
              )}
              {c.steps && c.steps.length > 0 && (
                <details><summary><b style={{ fontSize: 12.5 }}>Steps</b></summary><ol className="mt-steps">{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></details>
              )}
            </div>
          ))}
          <div className="small-muted">
            Where this comes from: {d.docs.map((x, i) => <span key={x.url}>{i ? ' · ' : ''}<a href={x.url} target="_blank" rel="noreferrer">{x.label}</a></span>)}
          </div>
        </div>
      )}
    </div>
  );
}
