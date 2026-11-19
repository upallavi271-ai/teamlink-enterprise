import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { num } from './HistoryParts.jsx';

// ---------------------------------------------------------------------------
// FIND A REQUIREMENT OR CLIENT AND OPEN ITS COMPLETE HISTORY (founder 2026-11-18). One box, results as you type (partial words, any case, an old
// client name). Clients first, then requirements with their headline numbers. Only what this login may already see (the server decides).
// Lives at the top of the ATS Search page; GET /api/ats/history/search.
// ---------------------------------------------------------------------------
export default function HistorySearch({ initial = '' }) {
  const [q, setQ] = useState(initial);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setQ(initial); }, [initial]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setRes(null); setErr(''); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true); setErr('');
      api.get('/ats/history/search', { params: { q: t } })
        .then((r) => { if (live) setRes(r.data); })
        .catch((e) => { if (live) setErr(e.response?.data?.error || 'The search did not answer.'); })
        .finally(() => { if (live) setBusy(false); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);
  return (
    <div className="card section hx-sr-box">
      <h3 style={{ marginTop: 0 }}>Requirement or client history</h3>
      <div className="small-muted" style={{ marginBottom: 6 }}>Type a requirement title or ID, or a client name (an old name works too). See how many profiles were shared, selected, joined and dropped, with dates.</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Requirement title, requirement ID or client name" aria-label="Find a requirement or client history" />
      {busy && <div className="small-muted" style={{ marginTop: 6 }}>Searching…</div>}
      {err && <div className="notice red" style={{ marginTop: 6 }}>{err}</div>}
      {res && !busy && (
        <div style={{ marginTop: 10 }}>
          {res.clientsAllowed && res.clients.length > 0 && (
            <>
              <h4 style={{ margin: '4px 0' }}>Clients ({num(res.clientTotal)})</h4>
              {res.clients.map((c) => (
                <div className="hx-sr" key={c.id}>
                  <Link className="main" to={`/clients/${c.id}?tab=history`}>{c.name}</Link>
                  {c.matchedOldName && <span className="hx-muted">found by an old name</span>}
                  <span className="nums"><span><b>{c.requirements}</b> requirements</span><span><b>{c.open}</b> open</span></span>
                  <Link className="btn btn-sm" to={`/clients/${c.id}?tab=history`}>Open history</Link>
                </div>
              ))}
            </>
          )}
          {res.requirements.length > 0 && (
            <>
              <h4 style={{ margin: '8px 0 4px' }}>Requirements ({num(res.requirementTotal)})</h4>
              {res.requirements.map((r) => (
                <div className="hx-sr" key={r.id}>
                  <Link className="main" to={`/requirements/${r.id}?tab=history`}>{r.reqCode ? `${r.reqCode} · ` : ''}{r.title}</Link>
                  <span className="hx-muted">{[r.client, r.statusLabel, `${r.openings} opening${r.openings === 1 ? '' : 's'}`].join(' · ')}</span>
                  <span className="nums">
                    <span><b>{r.headline.shared}</b> shared</span><span><b>{r.headline.selected}</b> selected</span><span><b>{r.headline.joined}</b> joined</span>
                    <span><b>{r.headline.dropped}</b> dropped</span><span><b>{r.headline.inProcess}</b> in process</span>
                  </span>
                  <Link className="btn btn-sm" to={`/requirements/${r.id}?tab=history`}>Open history</Link>
                </div>
              ))}
            </>
          )}
          {res.requirements.length === 0 && (!res.clientsAllowed || res.clients.length === 0) && <div className="small-muted">Nothing matches that.</div>}
        </div>
      )}
    </div>
  );
}
