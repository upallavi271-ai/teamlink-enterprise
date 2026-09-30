import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { ViewAsButton, ViewAsNotice } from '../../components/ViewAs.jsx';
import '../../components/ViewAs.css';

// Administration -> View as (Super Admin only). Every active login a Super
// Admin may view as, grouped by role, with department / section / seat, so
// "a TL in Education Section A" is two clicks away. Starting one opens the app
// as that person, READ-ONLY, in this tab only (components/ViewAs.jsx).
export default function ViewAsPicker() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [dept, setDept] = useState('');
  const [section, setSection] = useState('');
  const allowed = !!(user && user.role === 'SUPER_ADMIN' && !user.viewAs);

  useEffect(() => {
    if (!allowed) return;
    api.get('/admin/view-as/people')
      .then((res) => setData(res.data))
      .catch((err) => setError(err?.response?.data?.error || 'Could not load the people list.'));
  }, [allowed]);

  const people = data ? data.people : [];
  const departments = useMemo(() => [...new Set(people.map((p) => p.department).filter(Boolean))].sort(), [people]);
  const sections = useMemo(() => [...new Set(people
    .filter((p) => !dept || p.department === dept)
    .map((p) => p.section).filter(Boolean))].sort(), [people, dept]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return people.filter((p) => {
      if (group && p.group !== group) return false;
      if (dept && p.department !== dept) return false;
      if (section && p.section !== section) return false;
      if (!needle) return true;
      const hay = [p.name, p.email, p.designation, p.employeeCode, p.department, p.section, p.client, p.scope,
        ...(p.seats || []).map((s) => `${s.code} ${s.name || ''}`)].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [people, q, group, dept, section]);

  if (!allowed) {
    return (
      <div className="card">
        <h1>View as</h1>
        <div className="page-sub">Only a Super Admin can use View as{user && user.viewAs ? ' — exit the current View as first.' : '.'}</div>
      </div>
    );
  }

  const counts = {};
  people.forEach((p) => { counts[p.group] = (counts[p.group] || 0) + 1; });
  const groups = data ? data.groups.filter((g) => shown.some((p) => p.group === g.code)) : [];

  return (
    <div className="tl-viewas-page">
      <ViewAsNotice />
      <div className="card">
        <h1>👁 View as</h1>
        <div className="page-sub">
          Open the app exactly as another person sees it — their menu, their screens, their data scope — to check
          a role. It is <b>read-only</b>: nothing can be saved, sent or approved while viewing as, and their own
          session and password are never touched. It opens in <b>this tab only</b> for 60 minutes; your other tabs
          stay signed in as you. Every start and exit is written to the Audit Logs.
        </div>

        <div className="tl-va-filters">
          <input type="search" placeholder="Search name, email, seat, designation…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
          <select value={dept} onChange={(e) => { setDept(e.target.value); setSection(''); }} aria-label="Department">
            <option value="">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section / team">
            <option value="">All sections / teams</option>
            {sections.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {(q || dept || section || group) && (
            <button type="button" className="btn btn-sm" onClick={() => { setQ(''); setDept(''); setSection(''); setGroup(''); }}>Clear</button>
          )}
        </div>

        {data && (
          <div className="tl-va-chips" role="group" aria-label="Role">
            <button type="button" className={'tl-va-chip' + (group === '' ? ' on' : '')} onClick={() => setGroup('')}>All roles ({people.length})</button>
            {data.groups.filter((g) => counts[g.code]).map((g) => (
              <button type="button" key={g.code} className={'tl-va-chip' + (group === g.code ? ' on' : '')} onClick={() => setGroup(group === g.code ? '' : g.code)}>
                {g.label} ({counts[g.code]})
              </button>
            ))}
          </div>
        )}

        {error && <div className="error-text">{error}</div>}
        {!data && !error && <div className="page-sub">Loading…</div>}
        {data && !shown.length && <div className="page-sub">Nobody matches these filters.</div>}

        {groups.map((g) => {
          const rows = shown.filter((p) => p.group === g.code);
          return (
            <div className="tl-va-group" key={g.code}>
              <h3>{g.label} <small>{rows.length}</small></h3>
              <div className="tl-va-list">
                {rows.map((p) => (
                  <div className="tl-va-person" key={p.id}>
                    <div className="who">
                      <div className="nm">{p.name}</div>
                      <div className="meta">
                        {[p.designation, p.employeeCode, p.client ? `Client: ${p.client}` : null].filter(Boolean).join(' · ') || p.email}
                      </div>
                      <div className="meta">
                        {[p.department, p.section].filter(Boolean).join(' · ') || '—'}
                        {p.scope ? <> · <i>Scope: {p.scope}</i></> : null}
                      </div>
                      {(p.seats || []).map((s) => (
                        <span className="seat" key={s.code} title={s.name || ''}>
                          {s.code}{s.department ? ` · ${s.department}${s.team ? ` ${s.team}` : ''}` : ''}
                        </span>
                      ))}
                    </div>
                    <ViewAsButton userId={p.id} name={p.name} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
