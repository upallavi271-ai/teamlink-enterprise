import { useEffect, useMemo, useState } from 'react';
import api from '../api';
import Combo from './Combo.jsx';
import MultiSelect from './ats/MultiSelect.jsx';
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
// SEVERAL VALUES PER LEVEL (founder 2026-11-20: checkboxes everywhere). Each level (department, section, TL, recruiter) holds ONE value or a comma list;
// one value is just a list of one, so every old link and saved view still works. A comma inside a name is written %2C; a comma followed by a space
// stays inside one name ("Smith, John"). The servers take the lists (utils/multiParam.js, utils/workers.js attributedApplications).
export const hierList = (x) => String(x || '').split(/,(?!\s)/).map((s) => s.replace(/%2C/gi, ',').trim()).filter(Boolean);
export const hierCsv = (list) => list.map((v) => String(v).replace(/,/g, '%2C')).join(',');
const namesText = (names) => (names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`);

export function hierarchyOptions(data, value = EMPTY_HIERARCHY) {
  const all = (data || EMPTY_DATA).departments || [];
  const v = { ...EMPTY_HIERARCHY, ...value };
  const deptIds = hierList(v.department);
  const secIds = hierList(v.section);
  const tlVals = hierList(v.tl);
  const depts = deptIds.length ? all.filter((d) => deptIds.includes(d.id)) : all;
  const picked = secIds.map((id) => findSection(data, id)).filter(Boolean);
  const sections = depts.flatMap((d) => (d.sections || []).map((s) => ({ ...s, departmentLabel: d.label })));
  const inScope = picked.length ? picked : sections;

  // TLs: the leads of the sections in scope, plus the department's own unplaced ones
  let tls = inScope.flatMap((s) => s.tls || []);
  if (!picked.length) tls = tls.concat(depts.flatMap((d) => (d.unplaced && d.unplaced.tls) || []));
  if (!picked.length && !deptIds.length) tls = tls.concat(((data || EMPTY_DATA).noDepartment || {}).tls || []);
  tls = currentFirst(dedupe(tls));

  // Recruiters: those of the sections in scope; with TLs picked, only the sections those TLs lead
  let recSections = inScope;
  if (tlVals.length) recSections = inScope.filter((s) => (s.tls || []).some((t) => tlVals.includes(t.value)));
  let people = recSections.flatMap((s) => s.recruiters || []);
  let loose = [];
  if (!picked.length && !tlVals.length) {
    loose = depts.flatMap((d) => (d.unplaced && d.unplaced.recruiters) || []);
    if (!deptIds.length) loose = loose.concat(((data || EMPTY_DATA).noDepartment || {}).recruiters || []);
  }
  people = currentFirst(dedupe(people));
  const placed = new Set(people.map((p) => p.value));
  loose = currentFirst(dedupe(loose.filter((p) => !placed.has(p.value))));
  const seats = [...new Set(recSections.flatMap((s) => (s.seats || []).filter((c) => !(s.tlSeats || []).includes(c))))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  return {
    departments: all, sections, section: picked[0] || null, tls, people, loose, seats,
  };
}

// Make a (possibly stale) selection consistent: every picked value that is no longer on offer is dropped.
export function narrowHierarchy(data, next) {
  const v = { ...EMPTY_HIERARCHY, ...next };
  if (!data || !(data.departments || []).length) return v;
  const deptIds = hierList(v.department);
  v.section = hierCsv(hierList(v.section).filter((id) => { const s = findSection(data, id); return s && (!deptIds.length || deptIds.includes(s.department)); }));
  const o = hierarchyOptions(data, v);
  v.tl = hierCsv(hierList(v.tl).filter((t) => o.tls.some((x) => x.value === t)));
  const o2 = v.tl ? hierarchyOptions(data, v) : o;
  v.recruiter = hierCsv(hierList(v.recruiter).filter((r) => (r.startsWith('seat:')
    ? o2.seats.includes(r.slice(5))
    : o2.people.some((p) => p.value === r) || o2.loose.some((p) => p.value === r))));
  return v;
}

// The hierarchy as the list routes' parameters (comma lists where several are picked).
export function toParams(value, data = lastData) {
  const v = { ...EMPTY_HIERARCHY, ...value };
  const p = {};
  if (v.department) p.department = v.department;
  if (v.tl) p.tl = v.tl;
  const recs = hierList(v.recruiter);
  const seatCodes = recs.filter((r) => r.startsWith('seat:')).map((r) => r.slice(5));
  const people = recs.filter((r) => !r.startsWith('seat:'));
  if (seatCodes.length) p.positionCode = seatCodes.join(',');
  if (people.length) p.recruiter = hierCsv(people);
  if (v.section && !v.tl && !v.recruiter) {
    const secs = hierList(v.section).map((id) => findSection(data, id)).filter(Boolean);
    const codes = [...new Set(secs.flatMap((s) => s.seats || []))];
    if (codes.length) p.positionCode = codes.join(',');
    if (!p.department && secs.length) p.department = hierCsv([...new Set(secs.map((s) => s.department))]);
  }
  return p;
}

// The same, for the Requirements list's own parameter names (an id goes by id; a name that has no login goes by name, one at a time).
export function toRequirementParams(value, data = lastData) {
  const a = toParams(value, data);
  const p = {};
  if (a.department) p.department = a.department;
  if (a.positionCode) p.positionCode = a.positionCode;
  const split = (list) => {
    const ids = list.filter((x) => x.startsWith('id:')).map((x) => x.slice(3));
    const names = list.filter((x) => !x.startsWith('id:')).map((x) => (x.startsWith('name:') ? x.slice(5) : x));
    return { ids, names };
  };
  if (a.tl) { const s = split(hierList(a.tl)); if (s.ids.length) p.tlId = s.ids.join(','); else if (s.names.length === 1) p.tlName = s.names[0]; }
  if (a.recruiter) { const s = split(hierList(a.recruiter)); if (s.ids.length) p.recruiterId = s.ids.join(','); else if (s.names.length === 1) p.workedByName = s.names[0]; }
  return p;
}

// The words for the chips and the picked values.
export function hierarchyLabels(value, data = lastData) {
  const v = { ...EMPTY_HIERARCHY, ...value };
  const depts = ((data || EMPTY_DATA).departments || []);
  const o = hierarchyOptions(data, { ...v, recruiter: '' });
  const person = (list, val) => (list.find((x) => x.value === val) || {}).name
    || (val.startsWith('name:') ? val.slice(5) : val.startsWith('id:') ? 'Selected person' : val);
  const everyone = [...o.people, ...o.loose, ...hierarchyOptions(data, EMPTY_HIERARCHY).people, ...hierarchyOptions(data, EMPTY_HIERARCHY).loose];
  const out = {};
  if (v.department) out.department = namesText(hierList(v.department).map((id) => (depts.find((x) => x.id === id) || {}).label || id));
  if (v.section) out.section = namesText(hierList(v.section).map((id) => { const s = findSection(data, id); return s ? s.label : id.split('|').pop(); }));
  if (v.tl) out.tl = namesText(hierList(v.tl).map((t) => person(o.tls, t)));
  if (v.recruiter) {
    out.recruiter = namesText(hierList(v.recruiter).map((r) => (r.startsWith('seat:') ? `Recruiter Code ${r.slice(5)}` : person(everyone, r))));
  }
  return out;
}

export function hierarchyChips(value, data, onChange) {
  const v = { ...EMPTY_HIERARCHY, ...value };
  const l = hierarchyLabels(v, data || lastData);
  const chips = [];
  if (v.department) chips.push({ key: 'department', label: 'Department', value: l.department, onRemove: () => onChange({ ...EMPTY_HIERARCHY }) });
  if (v.section) chips.push({ key: 'section', label: 'Section', value: l.section, onRemove: () => onChange({ ...v, section: '', tl: '', recruiter: '' }) });
  if (v.tl) chips.push({ key: 'tl', label: 'TL', value: l.tl, onRemove: () => onChange({ ...v, tl: '', recruiter: '' }) });
  if (v.recruiter) {
    const onlySeats = hierList(v.recruiter).every((r) => r.startsWith('seat:'));
    chips.push({
      key: 'recruiter',
      label: onlySeats ? 'Recruiter Code' : 'Recruiter',
      value: onlySeats ? hierList(v.recruiter).map((r) => r.slice(5)).join(', ') : l.recruiter,
      onRemove: () => onChange({ ...v, recruiter: '' }),
    });
  }
  return chips;
}

// --- The component ------------------------------------------------------------
export default function HierarchyFilter({
  value = EMPTY_HIERARCHY, onChange, show = {}, style, data: given, multi = false,
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
  // several at once: a checkbox dropdown per level (the servers take comma lists)
  if (multi) {
    const recOptions = [
      ...recCurrent.map((p) => ({ value: p.value, label: p.label, group: 'Recruiter' })),
      ...recFormer.map((p) => ({ value: p.value, label: p.label, group: 'Former' })),
      ...o.seats.map((c) => ({ value: `seat:${c}`, label: `Recruiter Code ${c}`, group: 'everyone who sat in it' })),
      ...o.loose.map((p) => ({ value: p.value, label: p.label, group: 'Other names in the records' })),
    ];
    return (
      <span className="hier-filter">
        {showDept && <MultiSelect label="Department" allLabel="All departments" value={v.department} onChange={(csv) => emit({ department: csv })} options={o.departments.map((d) => ({ value: d.id, label: d.label }))} />}
        {showSection && (
          <MultiSelect
            label="Section"
            allLabel="All sections"
            value={v.section}
            onChange={(csv) => {
              const secs = hierList(csv).map((id) => findSection(data, id)).filter(Boolean);
              const depts = [...new Set([...hierList(v.department), ...secs.map((s) => s.department)])];
              emit({ section: csv, ...(secs.length ? { department: hierCsv(depts) } : {}) });
            }}
            options={sectionChoices.map((s) => ({ value: s.id, label: manyDepts ? `${s.departmentLabel} · ${s.label}` : s.label }))}
          />
        )}
        {showTl && <MultiSelect label="TL" allLabel="All TLs" value={v.tl} onChange={(csv) => emit({ tl: csv })} options={o.tls.map((t) => ({ value: t.value, label: t.label }))} />}
        {showRec && <MultiSelect label="Recruiter" allLabel="All recruiters" value={v.recruiter} onChange={(csv) => emit({ recruiter: csv })} options={recOptions} />}
      </span>
    );
  }

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
