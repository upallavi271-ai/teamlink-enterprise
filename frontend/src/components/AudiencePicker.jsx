// ---------------------------------------------------------------------------
// AudiencePicker — the ONE "Send to" control for Employee Services and
// Performance & Development.
//
//   value = { mode: 'everyone' | 'departments' | 'individuals',
//             departments: string[], employeeIds: string[] }
//
//   Everyone               nothing more to choose.
//   By department          a checklist with an "All departments" toggle on
//                          top — one department or MANY.
//   Individual employee(s) a searchable multi-select (name · code ·
//                          department), narrowed by department first if you
//                          like, with a chip and × for each person picked.
//
// The lists come from GET /api/audience/options, which the server has
// already held to the caller's scope: a TL is offered their own
// department(s) and people and nothing else, and the create routes refuse
// anything outside it (403) whatever the browser sends. The live summary
// line ("Will reach 37 employees in Medical, IT") is computed from the same
// list the server resolves against.
//
// DeliverVia (below) is the "Also deliver via" row — Email / SMS / WhatsApp —
// reading each channel's real status from the same endpoint.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import Combo from './Combo.jsx';
import './AudiencePicker.css';

export const EMPTY_AUDIENCE = { mode: 'everyone', departments: [], employeeIds: [] };

// One fetch per page view, shared by every picker and DeliverVia on it.
let cached = null;
export function loadAudienceOptions({ fresh = false } = {}) {
  if (!cached || fresh) {
    cached = api.get('/audience/options').then((r) => r.data).catch((err) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

export function useAudienceOptions(preloaded) {
  const [opts, setOpts] = useState(preloaded || null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (preloaded) { setOpts(preloaded); return undefined; }
    let live = true;
    loadAudienceOptions()
      .then((d) => { if (live) setOpts(d); })
      .catch((err) => { if (live) setError(err.response?.data?.error || 'Could not load who you can send to.'); });
    return () => { live = false; };
  }, [preloaded]);
  return { opts, error };
}

// Who a value reaches, from a list of people ({ id, department }).
export function resolveLocally(value, employees) {
  const v = value || EMPTY_AUDIENCE;
  if (v.mode === 'departments') return employees.filter((e) => v.departments.includes(e.department));
  if (v.mode === 'individuals') {
    const ids = new Set(v.employeeIds);
    return employees.filter((e) => ids.has(e.id));
  }
  return employees;
}

// Is the choice complete enough to submit?
export function audienceReady(value) {
  const v = value || EMPTY_AUDIENCE;
  if (v.mode === 'departments') return v.departments.length > 0;
  if (v.mode === 'individuals') return v.employeeIds.length > 0;
  return true;
}

function summaryText(value, reached, allDepartments) {
  const n = reached.length;
  const people = `${n} employee${n === 1 ? '' : 's'}`;
  if (value.mode === 'departments') {
    if (!value.departments.length) return null;
    const all = allDepartments.length > 1 && value.departments.length === allDepartments.length;
    return <>Will reach <b>{people}</b> in {all ? 'all departments' : <b>{value.departments.join(', ')}</b>}</>;
  }
  if (value.mode === 'individuals') {
    if (!n) return null;
    const names = reached.map((e) => e.name);
    const shown = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
    return <>Will reach <b>{people}</b>: {shown}</>;
  }
  return <>Will reach <b>all {people}</b> {allDepartments.length === 1 ? <>in <b>{allDepartments[0]}</b></> : 'in your scope'}</>;
}

export default function AudiencePicker({
  value,
  onChange,
  label = 'Send to',
  required = false,
  options,           // preloaded /audience/options (optional)
  people,            // override the person list ([{ id, name, employeeCode, department }])
  everyoneLabel = 'Everyone',
  noun = 'employees',
  // false hides "Everyone" (LMS: only an organisation-wide login may assign a
  // course to everyone; the server refuses it for anyone else).
  allowEveryone = true,
}) {
  const { opts, error } = useAudienceOptions(options);
  const v = value || EMPTY_AUDIENCE;
  useEffect(() => {
    if (!allowEveryone && v.mode === 'everyone') onChange({ mode: 'departments', departments: [], employeeIds: [] });
  }, [allowEveryone, v.mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [q, setQ] = useState('');
  const [narrow, setNarrow] = useState('');

  const employees = useMemo(() => people || opts?.employees || [], [people, opts]);
  const departments = useMemo(() => {
    const own = opts?.departments || [];
    // A supplied people list may be narrower than the scope; offer only the
    // departments someone on it actually sits in.
    if (!people) return own;
    const present = new Set(people.map((p) => p.department).filter(Boolean));
    return own.length ? own.filter((d) => present.has(d)) : [...present].sort();
  }, [opts, people]);
  const countBy = useMemo(() => {
    const m = {};
    employees.forEach((e) => { m[e.department] = (m[e.department] || 0) + 1; });
    return m;
  }, [employees]);

  const reached = useMemo(() => resolveLocally(v, employees), [v, employees]);
  const set = (patch) => onChange({ ...v, ...patch });

  function setMode(mode) {
    onChange({ mode, departments: mode === 'departments' ? v.departments : [], employeeIds: mode === 'individuals' ? v.employeeIds : [] });
  }
  function toggleDept(d) {
    set({ departments: v.departments.includes(d) ? v.departments.filter((x) => x !== d) : [...v.departments, d] });
  }
  const allTicked = departments.length > 0 && departments.every((d) => v.departments.includes(d));
  function toggleAll() { set({ departments: allTicked ? [] : [...departments] }); }

  function togglePerson(id) {
    set({ employeeIds: v.employeeIds.includes(id) ? v.employeeIds.filter((x) => x !== id) : [...v.employeeIds, id] });
  }
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return employees.filter((e) => (!narrow || e.department === narrow)
      && (!t || [e.name, e.employeeCode, e.department, e.designation].some((x) => String(x || '').toLowerCase().includes(t))));
  }, [employees, q, narrow]);
  const shownIds = matches.map((e) => e.id);
  const allShownPicked = shownIds.length > 0 && shownIds.every((id) => v.employeeIds.includes(id));
  function toggleShown() {
    if (allShownPicked) set({ employeeIds: v.employeeIds.filter((id) => !shownIds.includes(id)) });
    else set({ employeeIds: [...new Set([...v.employeeIds, ...shownIds])] });
  }
  const byId = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const summary = summaryText(v, reached, departments);
  const nobody = audienceReady(v) && reached.length === 0 && opts;

  return (
    <div className="aud-picker field">
      <label>{label}{required && <span className="compose-req"> *</span>}</label>
      <Combo value={v.mode} onChange={(e) => setMode(e.target.value)}>
        {allowEveryone && <option value="everyone">{everyoneLabel}</option>}
        <option value="departments">By department</option>
        <option value="individuals">Individual employee(s)</option>
      </Combo>

      {error && <div className="error-text">{error}</div>}
      {!opts && !error && !people && <div className="aud-summary">Loading who you can send to…</div>}

      {v.mode === 'departments' && (opts || people) && (
        <div className="aud-box">
          {departments.length === 0 ? <div className="small-muted">No departments in your scope.</div> : (
            <>
              <label className="aud-all">
                <input type="checkbox" checked={allTicked} onChange={toggleAll} />
                All departments{departments.length > 1 ? ` (${departments.length})` : ''}
              </label>
              <div className="aud-grid">
                {departments.map((d) => (
                  <label key={d} className="aud-opt">
                    <input type="checkbox" checked={v.departments.includes(d)} onChange={() => toggleDept(d)} />
                    <span>{d}</span>
                    <span className="aud-count">{countBy[d] || 0}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {v.mode === 'individuals' && (opts || people) && (
        <div className="aud-box">
          {v.employeeIds.length > 0 && (
            <div className="aud-chips">
              {v.employeeIds.map((id) => {
                const e = byId.get(id);
                return (
                  <span key={id} className="aud-chip">
                    {e ? e.name : 'Unknown'}{e?.employeeCode ? ` · ${e.employeeCode}` : ''}
                    <button type="button" aria-label={`Remove ${e ? e.name : 'employee'}`} onClick={() => togglePerson(id)}>×</button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="aud-tools">
            <Combo value={narrow} onChange={(e) => setNarrow(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </Combo>
            <input type="search" placeholder={`Search ${noun} by name, code or department`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          </div>
          <div className="aud-listbar">
            <span>{matches.length} shown · {v.employeeIds.length} selected</span>
            {matches.length > 0 && (
              <button type="button" className="aud-link" onClick={toggleShown}>{allShownPicked ? 'Clear shown' : 'Select all shown'}</button>
            )}
          </div>
          <div className="aud-list" role="listbox" aria-multiselectable="true">
            {matches.length === 0 ? <div className="small-muted" style={{ padding: 6 }}>Nobody matches.</div> : matches.map((e) => (
              <label key={e.id} className="aud-person">
                <input type="checkbox" checked={v.employeeIds.includes(e.id)} onChange={() => togglePerson(e.id)} />
                <span>{e.name} <span className="aud-meta">· {e.employeeCode || '—'} · {e.department || 'No department'}</span></span>
              </label>
            ))}
          </div>
        </div>
      )}

      {summary && <div className="aud-summary">{summary}</div>}
      {nobody && <div className="aud-summary warn">Nobody active is in that selection.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeliverVia — "Also deliver via: ☐ Email ☐ SMS ☐ WhatsApp".
//
// value = ['Email', 'SMS', ...]. In-app is always sent, so it is not a box.
// The status beside each channel is the server's, not a guess (utils/
// messaging.js channelStatus): a connected channel says so and really sends;
// a channel with no provider configured says so — a ticked box there is
// RECORDED, not sent.
// ---------------------------------------------------------------------------
export function DeliverVia({ value, onChange, options, label = 'Also deliver via' }) {
  const { opts } = useAudienceOptions(options);
  const picked = value || [];
  const channels = opts?.channels || {};
  const toggle = (c) => onChange(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c]);
  return (
    <div className="deliver-via field">
      <label>{label}</label>
      <div className="dv-row">
        {['Email', 'SMS', 'WhatsApp'].map((c) => {
          const st = channels[c];
          const live = !!st?.connected;
          return (
            <label key={c} className="dv-opt">
              <input type="checkbox" checked={picked.includes(c)} onChange={() => toggle(c)} />
              {c}
              <span className={`dv-note${live ? '' : ' off'}`}>
                {st ? (live ? `(${st.note.replace(/^Connected/, 'connected')})` : '(not connected — will be recorded, not sent)') : ''}
              </span>
            </label>
          );
        })}
      </div>
      <div className="dv-foot">An in-app notification always goes to everyone it reaches.</div>
    </div>
  );
}
