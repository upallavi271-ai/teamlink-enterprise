// ---------------------------------------------------------------------------
// "STILL A GOOD FIT FOR" — the other OPEN jobs a rejected person matches
// (user priority 2026-10-03: rejected people must not disappear, and we must
// see which OTHER clients they still fit).
//
//   <StillFits candidateId />              compact: 2 job names + "+N more"
//   <StillFits candidateId full />         the profile: up to 10, one per line
//
// Every StillFits on a page shares ONE request: ids are collected for a
// moment after render and sent together (GET /api/rejections/still-fits).
// Scored on the server with the one scorer (utils/resumeMatch.js), inside the
// login's own area. A client that already rejected the person is never
// offered as a fit — it is named in red instead. Client NAMES only.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './Rejections.css';

const cache = new Map(); // candidateId -> result (or a pending Promise)
let queue = new Map(); // candidateId -> [resolve]
let timer = null;
const PER = 10;

function flush() {
  timer = null;
  const batch = queue;
  queue = new Map();
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    api.get('/rejections/still-fits', { params: { ids: chunk.join(','), per: PER } })
      .then((r) => chunk.forEach((id) => {
        const v = (r.data.rows || {})[id] || { total: 0, top: [], rejectedClients: [] };
        cache.set(id, v);
        (batch.get(id) || []).forEach((fn) => fn(v));
      }))
      .catch(() => chunk.forEach((id) => {
        cache.delete(id);
        (batch.get(id) || []).forEach((fn) => fn({ error: true }));
      }));
  }
}
function request(id) {
  if (cache.has(id) && !(cache.get(id) instanceof Promise)) return Promise.resolve(cache.get(id));
  if (cache.get(id) instanceof Promise) return cache.get(id);
  const p = new Promise((resolve) => {
    if (!queue.has(id)) queue.set(id, []);
    queue.get(id).push(resolve);
    if (!timer) timer = setTimeout(flush, 60);
  });
  cache.set(id, p);
  return p;
}
// A reject / re-consider changes the answer: forget it.
export function forgetStillFits(id) { if (id) cache.delete(id); else cache.clear(); }

export default function StillFits({ candidateId, full = false }) {
  const [v, setV] = useState(() => {
    const hit = cache.get(candidateId);
    return hit && !(hit instanceof Promise) ? hit : null;
  });
  useEffect(() => {
    let live = true;
    if (!candidateId) return undefined;
    request(candidateId).then((x) => { if (live) setV(x); });
    return () => { live = false; };
  }, [candidateId]);

  if (!v) return <span className="small-muted" aria-label="Checking other jobs">…</span>;
  if (v.error) return <span className="small-muted">Could not check other jobs.</span>;
  if (v.blocked) return <span className="rjx-flag is-red">Do not use — not offered for any job.</span>;
  const top = v.top || [];
  const reds = v.rejectedClients || [];
  const redLine = reds.length > 0 && (
    <span className="rjx-flag is-red" title={reds.map((r) => r.warning).join('\n')}>
      {`Not to ${reds.map((r) => r.clientName).slice(0, 2).join(', ')}${reds.length > 2 ? ` +${reds.length - 2}` : ''} — rejected before`}
    </span>
  );
  if (!top.length) {
    return (
      <span>
        <span className="small-muted">No other open job fits right now.</span>
        {redLine}
      </span>
    );
  }
  const name = (f) => `${f.title}${f.clientName ? ` (${f.clientName})` : ''}`;
  if (full) {
    return (
      <div>
        {top.map((f) => (
          <div key={f.requirementId} style={{ fontSize: 13, marginBottom: 3 }}>
            <span className="rjx-ok" style={{ marginTop: 0, marginRight: 6 }}>{`Fit ${f.overall}%`}</span>
            <Link to={`/requirements/${f.requirementId}`}>{f.title}</Link>
            <span className="small-muted">{f.clientName ? ` · ${f.clientName}` : ''}{f.location ? ` · ${f.location}` : ''}</span>
          </div>
        ))}
        {v.total > top.length && <div className="small-muted">{`+${v.total - top.length} more open jobs fit — see Eligible jobs.`}</div>}
        {redLine}
      </div>
    );
  }
  const shown = top.slice(0, 2);
  const more = v.total - shown.length;
  return (
    <span title={top.map((f) => `${name(f)} · Fit ${f.overall}%`).join('\n') + (v.total > top.length ? `\n+${v.total - top.length} more` : '')}>
      <span style={{ color: 'var(--green)' }}>{shown.map(name).join(', ')}</span>
      {more > 0 && <span className="small-muted">{` +${more} more`}</span>}
      {redLine}
    </span>
  );
}
