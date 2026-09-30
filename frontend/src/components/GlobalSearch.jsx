import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import './GlobalSearch.css';

// ---------------------------------------------------------------------------
// "Search TeamLink" — the top bar's one search box (review #3 §13).
//
// Typing (debounced) asks GET /api/ats/search?limit=5 and drops a panel of
// results grouped and typed: CANDIDATE · REQUIREMENT · CLIENT · EMPLOYEE, each
// row with its ID (Candidate ID CAN-…, REQ code, Client ID / CL-…, Employee
// ID). The server scopes every group — a recruiter gets their own candidates
// and requirements, no client records (the client desk only) and no employee
// records (only logins that may view employees, inside their employee scope).
//
// Keyboard: ↑ / ↓ move through the results, Enter opens the highlighted one,
// Enter with nothing highlighted opens the full results page (/ats/search),
// Esc closes.
// ---------------------------------------------------------------------------
const GROUPS = [
  { id: 'candidates', type: 'CANDIDATE', title: 'Candidates' },
  { id: 'requirements', type: 'REQUIREMENT', title: 'Requirements' },
  { id: 'clients', type: 'CLIENT', title: 'Clients' },
  { id: 'employees', type: 'EMPLOYEE', title: 'Employees' },
];
const DEBOUNCE_MS = 250;
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

function subline(groupId, r) {
  switch (groupId) {
    case 'candidates': return [r.phone, r.requirement && `${r.requirement}${r.stageLabel ? ` · ${r.stageLabel}` : ''}`].filter(Boolean).join(' · ');
    case 'requirements': return [r.client && r.client.name, r.department, r.status].filter(Boolean).join(' · ');
    case 'clients': return [r.gst && `GSTIN ${r.gst}`, r.location].filter(Boolean).join(' · ');
    case 'employees': return [r.roleLabel, r.department, r.status && r.status !== 'Active' ? r.status : null].filter(Boolean).join(' · ');
    default: return '';
  }
}

export default function GlobalSearch() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [active, setActive] = useState(-1);
  const wrap = useRef(null);
  const seq = useRef(0);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setData(null); setError(''); setBusy(false); return undefined; }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api.get('/ats/search', { params: { q: term, limit: 5 } })
        .then((res) => { if (mine === seq.current) { setData(res.data); setError(''); } })
        .catch((e) => { if (mine === seq.current) { setData(null); setError(e.response?.data?.error || 'Search is not available right now.'); } })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Close on navigation and on an outside click.
  useEffect(() => { setOpen(false); setActive(-1); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // The visible groups and one flat list for the arrow keys.
  const groups = useMemo(() => {
    if (!data) return [];
    return GROUPS
      .filter((g) => (g.id !== 'clients' || data.clientsAllowed) && (g.id !== 'employees' || data.employeesAllowed))
      .map((g) => ({ ...g, rows: data[g.id] || [], count: (data.counts || {})[g.id] || 0 }))
      .filter((g) => g.rows.length > 0);
  }, [data]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows.map((r) => ({ ...r, group: g.id }))), [groups]);
  useEffect(() => { setActive(-1); }, [data]);

  const term = q.trim();
  function openAll() {
    if (!term) return;
    setOpen(false);
    navigate(`/ats/search?q=${encodeURIComponent(term)}`);
  }
  function openRow(r) {
    setOpen(false);
    navigate(r.to);
  }
  function onKey(e) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (flat.length ? (i + 1) % flat.length : -1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i <= 0 ? flat.length - 1 : i - 1) : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && flat[active]) openRow(flat[active]);
      else openAll();
    }
  }

  const total = groups.reduce((n, g) => n + g.count, 0);
  let index = -1;
  return (
    <div className="gsearch gsx" ref={wrap} role="search">
      <input
        type="text"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder="Search TeamLink"
        aria-label="Search TeamLink — candidates, clients, requirements, employees"
        aria-expanded={open && term.length >= 2}
        aria-controls="gsx-panel"
        aria-activedescendant={active >= 0 ? `gsx-opt-${active}` : undefined}
        role="combobox"
        autoComplete="off"
      />
      {open && term.length >= 2 && (
        <div className="gsx-panel" id="gsx-panel" role="listbox" aria-label="Search results">
          {busy && !data && <div className="gsx-note">Searching…</div>}
          {error && <div className="gsx-note gsx-err">{error}</div>}
          {data && !error && total === 0 && !busy && (
            <div className="gsx-note">Nothing in your scope matches “{term}”.</div>
          )}
          {groups.map((g) => (
            <div className="gsx-group" key={g.id}>
              <div className="gsx-head">
                <span className="gsx-type">{g.type}</span>
                <span className="gsx-count">{fmt(g.count)}</span>
              </div>
              {g.rows.map((r) => {
                index += 1;
                const i = index;
                return (
                  <div
                    key={`${g.id}-${r.id}`}
                    id={`gsx-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={`gsx-row${i === active ? ' on' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); openRow(r); }}
                  >
                    <div className="gsx-main">
                      <span className="gsx-name">{r.name || r.title}</span>
                      {r.code && <span className="gsx-code">{r.code}</span>}
                    </div>
                    {subline(g.id, r) && <div className="gsx-sub">{subline(g.id, r)}</div>}
                  </div>
                );
              })}
            </div>
          ))}
          {data && (
            <button type="button" className="gsx-all" onMouseDown={(e) => { e.preventDefault(); openAll(); }}>
              See all results for “{term}” →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
