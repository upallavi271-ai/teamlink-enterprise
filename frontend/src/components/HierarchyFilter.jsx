import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import Combo from './Combo.jsx';
import './HierarchyFilter.css';

// ---------------------------------------------------------------------------
// HIERARCHY FILTER — Department -> Section -> TL -> Recruiter (spec §7, §22, §23)
//
// USAGE (for every ATS screen that filters by people):
//
//   import HierarchyFilter, {
//     EMPTY_HIERARCHY, toParams, toRequirementParams, hierarchyChips, useHierarchy,
//   } from '../components/HierarchyFilter.jsx';
//   import FilterChips from '../components/FilterChips.jsx';
//
//   const [h, setH] = useState(EMPTY_HIERARCHY);   // { department, section, tl, recruiter }
//   <div className="filter-row">
//     <HierarchyFilter value={h} onChange={setH} />          // draws 0–4 dropdowns
//     …your other filters…
//   </div>
//   const tree = useHierarchy();                              // same cached request
//   <FilterChips filters={hierarchyChips(h, tree.data, setH)} onClearAll={() => setH(EMPTY_HIERARCHY)} />
//
//   // Query parameters for the list endpoints (spread into your own params):
//   //   ATS endpoints (Candidates, /applications, Interview Calendar,
//   //   /ats/workers/applications, ATS Reports, Recruiter & BDE):
//   api.get('/candidates', { params: { ...toParams(h), search } })
//   //   → { department, tl: 'id:…'|'name:…', recruiter: 'id:…'|'name:…', positionCode }
//   //   GET /api/requirements (older parameter names):
//   api.get('/requirements', { params: { ...toRequirementParams(h) } })
//   //   → { department, tlId|tlName, recruiterId|workedByName, positionCode }
//
// PROPS
//   value     { department, section, tl, recruiter } — all strings, '' = all
//   onChange  (next) => void — receives the whole next value, already narrowed
//             (a new department clears a section / TL / recruiter outside it …)
//   show      { department?, section?, tl?, recruiter? } — set a level false to
//             leave it out on your page (default: all true). Levels the LOGIN
//             can't use are hidden anyway (viewer.levels from the server):
//             recruiter -> nothing; TL -> Recruiter (own team) only; STL /
//             Manager / Asst Manager / Admin / Super Admin -> all.
//   style     applied to every dropdown
//
// VALUES
//   department  the department NAME as stored ("Manufacturing" — the dropdown
//               only DISPLAYS "Manufacturing (Non-IT)", see §38)
//   section     "<Department>|<Team>" e.g. "Education|Team A"
//   tl          "id:<userId>" | "name:<name>" — the same values as PeopleFilter
//   recruiter   "id:<userId>" | "name:<name>" | "seat:<CODE>" (a Recruiter Code:
//               everyone who sat in it -> ?positionCode=CODE)
//
// SECTION has no server parameter of its own. toParams() sends it as
// positionCode=<the section's seat codes, comma-separated> — only when no TL /
// recruiter is chosen (a person already implies their section). NOTE: that
// matches the work STAMPED with a seat code; most imported tracker history has
// none, so a section shows only seat-attributed work.
//
// Data: GET /api/ats/hierarchy (backend/src/routes/atsHierarchy.js), cached per
// login for a minute and shared by every HierarchyFilter on the page.
// ---------------------------------------------------------------------------

export const EMPTY_HIERARCHY = { department: '', section: '', tl: '', recruiter: '' };
const EMPTY_DATA = {
  viewer: null, departments: [], noDepartment: { tls: [], recruiters: [] },
};

let cache = null;
let lastData = null;
export function loadHierarchy({ force = false } = {}) {
  let token = '';
  try { token = localStorage.getItem('tl_token') || ''; } catch { token = ''; }
  if (!cache || force || cache.token !== token || Date.now() - cache.at > 60000) {
    const promise = api.get('/ats/hierarchy').then((res) => {
      const d = { ...EMPTY_DATA, ...res.data };
      lastData = d;
      return d;
    });
    cache = { token, at: Date.now(), promise };
    promise.catch(() => { if (cache && cache.promise === promise) cache = null; });
  }
  return cache.promise;
}

// { data, loading, error }
export function useHierarchy() {
  const [state, setState] = useState({ data: lastData || EMPTY_DATA, loading: !lastData, error: '' });
  useEffect(() => {
    let live = true;
    let timer = null;
    // A server that is restarting answers 500 for a few seconds: try again a
    // few times (a 403 — no ATS screen in the role — is final).
    const attempt = (n) => loadHierarchy()
      .then((d) => { if (live) setState({ data: d, loading: false, error: '' }); })
      .catch((err) => {
        if (!live) return;
        const status = err.response?.status;
        if (n < 3 && status !== 403 && status !== 401) { timer = setTimeout(() => attempt(n + 1), 4000); return; }
        setState({ data: EMPTY_DATA, loading: false, error: err.response?.data?.error || 'Could not load the team structure.' });
      });
    attempt(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []);
  return state;
}

// --- Pure helpers (usable without the component) ----------------------------
const dedupe = (list) => {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.value) ? false : (seen.add(x.value), true)));
};
const currentFirst = (list) => [...list.filter((x) => x.current), ...list.filter((x) => !x.current)];

export function findSection(data, id) {
  if (!id) return null;
  for (const d of (data || EMPTY_DATA).departments || []) {
    const s = (d.sections || []).find((x) => x.id === id);
    if (s) return s;
  }
  return null;
}

// What each level offers for the current value.
export function hierarchyOptions(data, value = EMPTY_HIERARCHY) {
  const all = (data || EMPTY_DATA).departments || [];
  const v = { ...EMPTY_HIERARCHY, ...value };
  const depts = v.department ? all.filter((d) => d.id === v.department) : all;
  const section = findSection(data, v.section);
  const sections = depts.flatMap((d) => (d.sections || []).map((s) => ({ ...s, departmentLabel: d.label })));
  const inScope = section ? [section] : sections;

  // TLs: the chosen section's, or the department's (sections + unplaced).
  let tls = inScope.flatMap((s) => s.tls || []);
  if (!section) tls = tls.concat(depts.flatMap((d) => (d.unplaced && d.unplaced.tls) || []));
  if (!section && !v.department) tls = tls.concat(((data || EMPTY_DATA).noDepartment || {}).tls || []);
  tls = currentFirst(dedupe(tls));

  // Recruiters: under the chosen TL's section(s), else the section, else the
  // department (+ people who never sat in a seat), else everyone.
  let recSections = inScope;
  if (v.tl) {
    const led = inScope.filter((s) => (s.tls || []).some((t) => t.value === v.tl));
    recSections = led;
  }
  let people = recSections.flatMap((s) => s.recruiters || []);
  let loose = [];
  if (!section && !v.tl) {
    loose = depts.flatMap((d) => (d.unplaced && d.unplaced.recruiters) || []);
    if (!v.department) loose = loose.concat(((data || EMPTY_DATA).noDepartment || {}).recruiters || []);
  }
  people = currentFirst(dedupe(people));
  const placed = new Set(people.map((p) => p.value));
  loose = currentFirst(dedupe(loose.filter((p) => !placed.has(p.value))));
  const seats = [...new Set(recSections.flatMap((s) => (s.seats || []).filter((c) => !(s.tlSeats || []).includes(c))))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return { departments: all, sections, section, tls, people, loose, seats };
}

// Keep a value consistent with the tree: drop what the new parent excludes.
export function narrowHierarchy(data, next) {
  const v = { ...EMPTY_HIERARCHY, ...next };
  if (!data || !(data.departments || []).length) return v;
  const sec = findSection(data, v.section);
  if (v.section && !sec) v.section = '';
  if (sec && v.department && sec.department !== v.department) v.section = '';
  const o = hierarchyOptions(data, v);
  if (v.tl && !o.tls.some((t) => t.value === v.tl)) v.tl = '';
  const o2 = v.tl ? hierarchyOptions(data, v) : o;
  if (v.recruiter) {
    const ok = v.recruiter.startsWith('seat:')
      ? o2.seats.includes(v.recruiter.slice(5))
      : o2.people.some((p) => p.value === v.recruiter) || o2.loose.some((p) => p.value === v.recruiter);
    if (!ok) v.recruiter = '';
  }
  return v;
}

// Query parameters for the ATS list endpoints (see USAGE).
export function toParams(value, data = lastData) {
  const v = { ...EMPTY_HIERARCHY, ...value };
  const p = {};
  if (v.department) p.department = v.department;
  if (v.tl) p.tl = v.tl;
  if (v.recruiter && v.recruiter.startsWith('seat:')) p.positionCode = v.recruiter.slice(5);
  else if (v.recruiter) p.recruiter = v.recruiter;
  if (v.section && !v.tl && !v.recruiter) {
    const sec = findSection(data, v.section);
    if (sec && sec.seats && sec.seats.length) p.positionCode = sec.seats.join(',');
    if (!p.department && sec) p.department = sec.department;
  }
  return p;
}

// The same, in GET /api/requirements' older parameter names.
export function toRequirementParams(value, data = lastData) {
  const a = toParams(value, data);
  const p = {};
  if (a.department) p.department = a.department;
  if (a.positionCode) p.positionCode = a.positionCode;
  const split = (x) => (x.startsWith('id:') ? { id: x.slice(3) } : { name: x.startsWith('name:') ? x.slice(5) : x });
  if (a.tl) { const s = split(a.tl); if (s.id) p.tlId = s.id; else p.tlName = s.name; }
  if (a.recruiter) { const s = split(a.recruiter); if (s.id) p.recruiterId = s.id; else p.workedByName = s.name; }
  return p;
}

// Human labels for chips / scope lines.
export function hierarchyLabels(value, data = lastData) {
  const v = { ...EMPTY_HIERARCHY, ...value };
  const d = ((data || EMPTY_DATA).departments || []).find((x) => x.id === v.department);
  const sec = findSection(data, v.section);
  const o = hierarchyOptions(data, { ...v, recruiter: '' });
  const person = (list, val) => (list.find((x) => x.value === val) || {}).name
    || (val.startsWith('name:') ? val.slice(5) : val.startsWith('id:') ? 'Selected person' : val);
  const out = {};
  if (v.department) out.department = d ? d.label : v.department;
  if (v.section) out.section = sec ? sec.label : v.section.split('|').pop();
  if (v.tl) out.tl = person(o.tls, v.tl);
  if (v.recruiter) {
    out.recruiter = v.recruiter.startsWith('seat:')
      ? `Recruiter Code ${v.recruiter.slice(5)}`
      : person([...o.people, ...o.loose, ...hierarchyOptions(data, EMPTY_HIERARCHY).people, ...hierarchyOptions(data, EMPTY_HIERARCHY).loose], v.recruiter);
  }
  return out;
}

// Chips for <FilterChips>: removing a level also clears the levels under it.
export function hierarchyChips(value, data, onChange) {
  const v = { ...EMPTY_HIERARCHY, ...value };
  const l = hierarchyLabels(v, data || lastData);
  const chips = [];
  if (v.department) chips.push({ key: 'department', label: 'Department', value: l.department, onRemove: () => onChange({ ...EMPTY_HIERARCHY }) });
  if (v.section) chips.push({ key: 'section', label: 'Section', value: l.section, onRemove: () => onChange({ ...v, section: '', tl: '', recruiter: '' }) });
  if (v.tl) chips.push({ key: 'tl', label: 'TL', value: l.tl, onRemove: () => onChange({ ...v, tl: '', recruiter: '' }) });
  if (v.recruiter) {
    chips.push({
      key: 'recruiter',
      label: v.recruiter.startsWith('seat:') ? 'Recruiter Code' : 'Recruiter',
      value: v.recruiter.startsWith('seat:') ? v.recruiter.slice(5) : l.recruiter,
      onRemove: () => onChange({ ...v, recruiter: '' }),
    });
  }
  return chips;
}

// --- The component ------------------------------------------------------------
export default function HierarchyFilter({
  value = EMPTY_HIERARCHY, onChange, show = {}, style, data: given,
}) {
  const fetched = useHierarchy();
  const data = given || fetched.data;
  const v = { ...EMPTY_HIERARCHY, ...value };
  const o = useMemo(() => hierarchyOptions(data, v), [data, v.department, v.section, v.tl]); // eslint-disable-line react-hooks/exhaustive-deps
  const levels = (data && data.viewer && data.viewer.levels) || { department: false, section: false, tl: false, recruiter: false };
  const want = { department: true, section: true, tl: true, recruiter: true, ...show };

  const emit = (patch) => { if (onChange) onChange(narrowHierarchy(data, { ...v, ...patch })); };

  // A section level is only worth drawing when there is a choice to make:
  // a one-section department (Medical, Manufacturing) IS its section, so with
  // no department chosen only the departments that split (Education A / B)
  // are offered, and choosing one sets the department too.
  const splitDepts = new Set(o.departments.filter((d) => (d.sections || []).length > 1).map((d) => d.id));
  const sectionChoices = v.department ? o.sections : o.sections.filter((s) => splitDepts.has(s.department));
  const showDept = want.department && levels.department && o.departments.length > 1;
  const showSection = want.section && levels.section && (sectionChoices.length > 1 || (v.section && sectionChoices.length));
  const showTl = want.tl && levels.tl && (o.tls.length > 0 || !!v.tl);
  const showRec = want.recruiter && levels.recruiter && (o.people.length + o.loose.length + o.seats.length > 0 || !!v.recruiter);
  if (!showDept && !showSection && !showTl && !showRec) return null;

  const manyDepts = new Set(sectionChoices.map((s) => s.department)).size > 1;
  const recCurrent = o.people.filter((p) => p.current);
  const recFormer = o.people.filter((p) => !p.current);

  return (
    <span className="hier-filter">
      {showDept && (
        <Combo value={v.department} title="Department" style={style} onChange={(e) => emit({ department: e.target.value })}>
          <option value="">All departments</option>
          {o.departments.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </Combo>
      )}
      {showSection && (
        <Combo
          value={v.section}
          title="Section"
          style={style}
          onChange={(e) => {
            const sec = findSection(data, e.target.value);
            emit({ section: e.target.value, ...(sec ? { department: sec.department } : {}) });
          }}
        >
          <option value="">All sections</option>
          {sectionChoices.map((s) => (
            <option key={s.id} value={s.id}>{manyDepts ? `${s.departmentLabel} · ${s.label}` : s.label}</option>
          ))}
        </Combo>
      )}
      {showTl && (
        <Combo value={v.tl} title="TL" style={style} onChange={(e) => emit({ tl: e.target.value })}>
          <option value="">All TLs</option>
          {o.tls.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Combo>
      )}
      {showRec && (
        <Combo value={v.recruiter} title="Recruiter" style={style} onChange={(e) => emit({ recruiter: e.target.value })}>
          <option value="">All recruiters</option>
          {recCurrent.length > 0 && (
            <optgroup label="Recruiters">
              {recCurrent.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </optgroup>
          )}
          {recFormer.length > 0 && (
            <optgroup label="Former">
              {recFormer.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </optgroup>
          )}
          {o.seats.length > 0 && (
            <optgroup label="Recruiter Code">
              {o.seats.map((c) => <option key={c} value={`seat:${c}`}>{`Recruiter Code ${c} · everyone who sat in it`}</option>)}
            </optgroup>
          )}
          {o.loose.length > 0 && (
            <optgroup label="Other names in the records">
              {o.loose.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </optgroup>
          )}
        </Combo>
      )}
    </span>
  );
}
