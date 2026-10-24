import { useNavigate } from 'react-router-dom';
import { sourceLabel } from '../../utils/candidateSource.js';
import './NewPeopleStrip.css';

// ---------------------------------------------------------------------------
// "NEWLY ADDED - NOT ON A REQUIREMENT YET" (founder, 2026-10-23).
// The pipeline has one row per application, so a person typed in by hand or uploaded as a resume with no requirement chosen has no row there.
// The server sends them as `waiting` ({ total, rows }): the newest ones, or - while something is typed in Search - everybody without an
// application who matches it (name, phone, e-mail, skills). Shown ABOVE the table, with where they came from and the exact day and time.
// ---------------------------------------------------------------------------
const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};

export default function NewPeopleStrip({ waiting, searching, onShowAll }) {
  const navigate = useNavigate();
  if (!waiting || !waiting.rows || !waiting.rows.length) return null;
  const more = Math.max(0, (waiting.total || 0) - waiting.rows.length);
  return (
    <section className="nps" aria-label="Newly added people who are not on a requirement yet">
      <div className="nps-head">
        <b>{searching ? `Found ${waiting.total} not on any requirement yet` : `New: ${waiting.total} added in the last 7 days, not on a requirement yet`}</b>
        <span className="nps-sub">Open the person, then add them to a requirement.</span>
        {more > 0 && onShowAll && <button type="button" className="btn btn-sm" onClick={onShowAll}>{`Show all ${waiting.total}`}</button>}
      </div>
      <ul className="nps-list">
        {waiting.rows.map((p) => (
          <li key={p.id} className="nps-row">
            <button type="button" className="nps-name" onClick={() => navigate(`/candidates/${p.id}`)}>{p.name}</button>
            <span className="nps-meta">{[p.phone, p.email].filter(Boolean).join(' · ') || 'No phone or e-mail saved'}</span>
            <span className="nps-came" title="Where the person came from, and when they were added">
              <b>{sourceLabel(p.sourceKey || p.sourceRaw)}</b>
              {` · ${when(p.addedAt)}`}
            </span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`/candidates/${p.id}`)}>Open</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
