import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import FilterChips from '../../components/FilterChips.jsx';
import './Search.css';

// ---------------------------------------------------------------------------
// GLOBAL SEARCH (spec §24) — one simple box. Searches candidate name, phone
// and email, requirement ID and title, client, and employee name; results are
// grouped "Candidates (3) · Requirements (2) · Clients (1) · Employees (1)".
//
// Everything is scoped on the server (GET /api/ats/search): a recruiter finds
// their own candidates and requirements; Clients appear only for the client
// desk (SA / Admin / Manager / Asst Manager / BDE) — everyone else sees a
// client's NAME on the requirements it matches, never the client record.
// The top bar's search box lands here with ?q=.
// ---------------------------------------------------------------------------

const EMPTY = {
  candidates: [], requirements: [], clients: [], employees: [],
  counts: { candidates: 0, requirements: 0, clients: 0, employees: 0 },
  clientsAllowed: false, employeesAllowed: false,
};
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

function Group({ id, title, count, shown, children, empty, show = true }) {
  if (!show) return null;
  return (
    <div className="card section srch-group" id={`srch-${id}`}>
      <h3>
        {title} <span className="srch-n">({fmt(count)})</span>
        {count > shown && <span className="small-muted srch-more"> — first {fmt(shown)} shown; add more words to narrow it</span>}
      </h3>
      {count === 0 ? <div className="small-muted">{empty}</div> : children}
    </div>
  );
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') || '';
  const [q, setQ] = useState(urlQ);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Type filter (list standard): All types / Candidates / Requirements /
  // Clients / Employees — only the groups this login may see are offered.
  const [type, setType] = useState('');

  // The URL is the search: the top bar's box, a bookmark and Back all work.
  useEffect(() => {
    setQ(urlQ);
    if (!urlQ.trim()) { setResults(null); setError(''); return undefined; }
    let live = true;
    setBusy(true);
    setError('');
    api.get('/ats/search', { params: { q: urlQ } })
      .then((res) => { if (live) setResults({ ...EMPTY, ...res.data }); })
      .catch((e) => { if (live) { setResults(null); setError(e.response?.data?.error || 'Search failed — the server did not answer.'); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [urlQ]);

  function search(e) {
    e?.preventDefault();
    const t = q.trim();
    if (!t) return;
    setParams({ q: t });
  }
  function clear() {
    setQ('');
    setType('');
    setResults(null);
    setError('');
    setParams({});
  }

  const r = results || EMPTY;
  const groups = [
    ['candidates', 'Candidates', true],
    ['requirements', 'Requirements', true],
    ['clients', 'Clients', r.clientsAllowed],
    ['employees', 'Employees', r.employeesAllowed],
  ].filter(([, , on]) => on);

  return (
    <div className="srch-page">
      <div className="page-head">
        <div>
          <h1>Search TeamLink</h1>
          <div className="page-sub">Candidate name, phone or Candidate ID · requirement ID or job title · client name, GSTIN or client code · employee name or Employee ID — only what your role may see</div>
        </div>
      </div>
      <form className="filter-row" onSubmit={search}>
        <input
          style={{ flex: 1 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search TeamLink"
          aria-label="Search"
          autoFocus
        />
        {results && (
          <select value={type} onChange={(e) => setType(e.target.value)} title="Type" aria-label="Type" style={{ width: 'auto' }}>
            <option value="">All types</option>
            {groups.map(([id, label]) => <option key={id} value={id}>{`${label} (${fmt(r.counts[id])})`}</option>)}
          </select>
        )}
        <button className="btn btn-sm btn-primary" type="submit" disabled={!q.trim() || busy}>{busy ? 'Searching…' : 'Search'}</button>
        <button className="btn btn-sm" type="button" disabled={!q && !results} onClick={clear}>Clear</button>
      </form>

      {error && <div className="notice red">{error}</div>}
      {results && type && (
        <FilterChips
          filters={[{ key: 'type', label: 'Type', value: (groups.find(([id]) => id === type) || [])[1] || type, onRemove: () => setType('') }]}
          onClearAll={() => setType('')}
        />
      )}

      {results && (
        <>
          <div className="srch-summary" aria-label="Results by group">
            {groups.map(([id, label], i) => (
              <span key={id}>
                {i > 0 && <span className="srch-dot"> · </span>}
                <a href={`#srch-${id}`} className={r.counts[id] ? '' : 'srch-zero'}
                  onClick={(e) => { e.preventDefault(); const el = document.getElementById(`srch-${id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                >
                  {label} ({fmt(r.counts[id])})
                </a>
              </span>
            ))}
          </div>

          <Group show={!type || type === 'candidates'} id="candidates" title="Candidates" count={r.counts.candidates} shown={r.candidates.length} empty="No candidates match.">
            {r.candidates.map((c) => (
              <div className="srch-row" key={c.id}>
                <span className="srch-type">CANDIDATE</span>
                <Link to={`/candidates/${c.id}`} className="srch-main">{c.name}</Link>
                {c.code && <span className="srch-code">{c.code}</span>}
                <span className="small-muted">
                  {[c.phone, c.email, c.requirement && `${c.requirement}${c.stageLabel ? ` · ${c.stageLabel}` : ''}`].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </Group>

          <Group show={!type || type === 'requirements'} id="requirements" title="Requirements" count={r.counts.requirements} shown={r.requirements.length} empty="No requirements match.">
            {r.requirements.map((x) => (
              <div className="srch-row" key={x.id}>
                <span className="srch-type">REQUIREMENT</span>
                <Link to={`/requirements/${x.id}`} className="srch-main">{x.title}</Link>
                {x.reqCode && <span className="srch-code">{x.reqCode}</span>}
                <span className="small-muted">
                  {[x.client && x.client.name, x.department, x.status].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </Group>

          {r.clientsAllowed && (
            <Group show={!type || type === 'clients'} id="clients" title="Clients" count={r.counts.clients} shown={r.clients.length} empty="No clients match.">
              {r.clients.map((c) => (
                <div className="srch-row" key={c.id}>
                  <span className="srch-type">CLIENT</span>
                  <Link to={`/clients/${c.id}`} className="srch-main">{c.name}</Link>
                  {c.code && <span className="srch-code">{c.code}</span>}
                  <span className="small-muted">{[c.gst && `GSTIN ${c.gst}`, c.location].filter(Boolean).join(' · ')}</span>
                </div>
              ))}
            </Group>
          )}

          {r.employeesAllowed && (
            <Group show={!type || type === 'employees'} id="employees" title="Employees" count={r.counts.employees} shown={r.employees.length} empty="No employees match.">
              {r.employees.map((u) => (
                <div className="srch-row" key={u.id}>
                  <span className="srch-type">EMPLOYEE</span>
                  <Link to={u.to || `/employees/${u.id}`} className="srch-main">{u.name}</Link>
                  {u.code && <span className="srch-code">{u.code}</span>}
                  <span className="small-muted">{[u.roleLabel, u.department].filter(Boolean).join(' · ')}</span>
                </div>
              ))}
            </Group>
          )}
        </>
      )}
      {!results && !busy && !error && (
        <div className="small-muted srch-hint">Type a name, phone number, email, candidate ID, requirement code (e.g. MED-2658), job title, client name, GSTIN or client code and press Enter.</div>
      )}
    </div>
  );
}
