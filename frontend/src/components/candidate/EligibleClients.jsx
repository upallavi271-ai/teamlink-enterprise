// "Rejected before, but could fit these clients" — a short, calm block.
//   Rejected before   one block per rejection: client, job, and the details in grey
//   Could fit         the top 5 clients, one line each:
//                     Client name — best fit 81% — N jobs      [Details]
//                     The jobs open only on click (repeated job titles are counted once).
//   "Show all N" opens the rest of the list. Nothing is removed, only folded.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import StatusChip from '../ui/StatusChip.jsx';
import { protoDate } from '../../atsVocab';

const TOP = 5;
const tone = (n) => (n >= 70 ? 'green' : n >= 60 ? 'blue' : 'amber');

// Same job title many times -> one line with a count and the best fit.
function foldJobs(reqs) {
  const map = new Map();
  (reqs || []).forEach((r) => {
    const k = r.title || 'Job';
    const cur = map.get(k) || { title: k, count: 0, best: 0, id: r.id };
    cur.count += 1;
    if (r.match > cur.best) { cur.best = r.match; cur.id = r.id; }
    map.set(k, cur);
  });
  return [...map.values()].sort((a, b) => b.best - a.best);
}

function ClientRow({ ec }) {
  const [open, setOpen] = useState(false);
  const best = Math.max(0, ...(ec.requirements || []).map((r) => r.match || 0));
  const n = (ec.requirements || []).length;
  const jobs = open ? foldJobs(ec.requirements) : [];
  return (
    <div className={`c360-ec${open ? ' is-open' : ''}`}>
      <button type="button" className="c360-ec-head" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <span className="c360-ec-name">
          {ec.clientName}
          {ec.rejectedEarlier && <span className="c360-ec-warn">rejected this person before — check first</span>}
        </span>
        <span className="c360-ec-facts">
          <StatusChip tone={tone(best)}>{`best fit ${best}%`}</StatusChip>
          <span className="small-muted">{n === 1 ? '1 job' : `${n} jobs`}</span>
        </span>
        <span className="c360-ec-more">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <ul className="c360-ec-jobs">
          {jobs.map((j) => (
            <li key={j.title}>
              {j.id ? <Link to={`/requirements/${j.id}`}>{j.title}</Link> : j.title}
              <span className="small-muted">{` — ${j.count > 1 ? `${j.count} jobs, ` : ''}fit ${j.best}%`}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EligibleClients({ c }) {
  const [all, setAll] = useState(false);
  const rejected = c.rejectedBy || [];
  const clients = c.eligibleClients || [];
  const total = c.eligibleTotal ?? (clients.filter((x) => !x.rejectedEarlier).length || 0);
  if (!rejected.length && !clients.length) return null;
  // Nothing to score on a thin profile (no skills, no experience, no resume): no "could fit" verdicts.
  if (c.profileThin && !rejected.length) return null;
  const shown = all ? clients : clients.slice(0, TOP);
  const heading = rejected.length ? 'Rejected before, but could fit these clients' : 'Other clients this person could fit';
  return (
    <div className="card section c360-elig" style={{ marginTop: 12 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>{heading}</h3>
      {rejected.length > 0 && (
        <div className="c360-elig-part">
          <div className="c360-sub c360-sub-flat">Rejected before</div>
          {rejected.map((r) => (
            <div key={r.applicationId} className="c360-rej">
              <div>
                <b>{r.clientName || '—'}</b>
                {' · '}
                <Link to={`/requirements/${r.requirementId}`}>{r.requirementTitle || 'Job'}</Link>
              </div>
              <div className="small-muted">
                {[r.at ? protoDate(r.at) : null, r.side, r.reason, r.by ? `recorded by ${r.by}` : null].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="c360-elig-part">
        <div className="c360-sub c360-sub-flat">
          {clients.length ? `Could fit ${total} client${total === 1 ? '' : 's'} (open jobs, fit 60% or more)` : 'Could fit'}
        </div>
        {clients.length === 0 && <div className="small-muted">No open job at another client fits yet.</div>}
        {shown.map((ec) => <ClientRow key={ec.clientId || 'internal'} ec={ec} />)}
        {clients.length > TOP && (
          <button type="button" className="link-btn c360-showall" onClick={() => setAll((x) => !x)}>
            {all ? 'Show top 5' : `Show all ${Math.max(total, clients.length)}`}
          </button>
        )}
      </div>
    </div>
  );
}
