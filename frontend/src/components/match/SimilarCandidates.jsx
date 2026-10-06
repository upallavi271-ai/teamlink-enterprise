// ---------------------------------------------------------------------------
// JOB PAGE → "Similar people" (B8, 2026-10-05). Shown only while Admin →
// Company Setup → Fit settings → "Match by meaning" is ON. People in your
// area, not on this job yet, whose profile / resume talks about the same work
// — even in other words. Backend: GET /api/candidate-resumes/requirement/:id/similar
// (paginated, scoped by the server).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import './match.css';

const ENGINE = { local: 'built-in matching', ai: 'AI matching' };

export default function SimilarCandidatesPanel({ requirementId, onAdd }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    api.get(`/candidate-resumes/requirement/${requirementId}/similar`, { params: { page, limit: 10 } })
      .then((res) => { if (live) setData(res.data); })
      .catch((err) => { if (live) { setData(null); setError(err.response?.data?.error || 'The similar list could not be loaded. Please try again.'); } });
    return () => { live = false; };
  }, [requirementId, page, n]);
  if (data && !data.on) return null; // switched off by the Admin: nothing to show
  if (!data && !error) return null;
  async function add(c) {
    setBusy(c.id); setSaid('');
    try {
      await onAdd(c.id);
      setSaid(`✓ ${c.name} added to this job.`);
      setN((x) => x + 1);
    } catch (e) {
      setSaid(`✗ ${(e && e.response && e.response.data && e.response.data.error) || 'Could not add. Please try again.'}`);
    } finally { setBusy(''); }
  }
  return (
    <div className="card section b8-sim" id="similar">
      <div className="b8-sim-head">
        <h3 style={{ fontSize: 14, margin: 0 }}>Similar people</h3>
        {data && <span className="small-muted">{`${data.total} found · by ${ENGINE[data.engine] || data.engine}`}</span>}
      </div>
      <div className="small-muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>
        People whose profile talks about the same work, even in other words. Check each person before adding.
      </div>
      {said && <div className={`notice ${said.startsWith('✗') ? 'red' : 'rsm-ok'}`} style={{ margin: '0 0 8px' }}>{said}</div>}
      {error && <div className="notice red">{error}</div>}
      {data && data.rows.length === 0 && <div className="small-muted">No one similar in your area yet.</div>}
      {data && data.rows.map((c) => (
        <div className="b8-sim-row" key={c.id}>
          <span className="b8-sim-main">
            <Link to={`/candidates/${c.id}`}>{c.name}</Link>
            <span className="small-muted">{[c.location, c.experienceYears != null ? ` ${c.experienceYears} yrs` : null].filter(Boolean).join(' ·')}</span>
            {c.shared && c.shared.length > 0 && <span className="b8-sim-shared">{`Same work: ${c.shared.join(', ')}`}</span>}
          </span>
          <span className="b8-sim-pct" title="How close in meaning">{`${c.similarPct}% similar`}</span>
          <span className="small-muted" title={c.match.reason}>{`Fit ${c.match.overall}%`}</span>
          {data.canAdd && onAdd && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy === c.id} onClick={() => add(c)}>{busy === c.id ? 'Adding…' : 'Add'}</button>
          )}
        </div>
      ))}
      {data && data.pages > 1 && (
        <div className="b8-pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Back</button>
          <span className="small-muted">{`Page ${data.page} of ${data.pages}`}</span>
          <button type="button" className="btn btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
