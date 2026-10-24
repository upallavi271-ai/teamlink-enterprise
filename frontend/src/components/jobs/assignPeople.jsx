import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import MultiPick from '../MultiPick.jsx';
import RecruiterChecklist from './RecruiterChecklist.jsx';
import TlChecklist from './TlChecklist.jsx'; // several team leads as checkboxes (2026-10-14)

// ---------------------------------------------------------------------------
// WHO A JOB CAN BE GIVEN TO (user, 2026-10-05).
//   1. "Assigned to (Team lead)" lists the TLs of EVERY department, grouped by
//      department, the job's own department first, each with their open jobs.
//      (GET /requirements/assignable-people?tls=all)
//   2. The TL then gives the job to a recruiter of THEIR OWN team, least busy
//      first: open jobs + people in process + late items — the same numbers
//      the Recruiter & BDE screen shows. An Admin / Manager sees recruiters
//      grouped by team, the job's TL's team first.
//      (GET /requirements/assignable-people?recruiters=1&tlId=)
// Used by the Add / Edit job form, the job page's "Change team" and the bulk
// Assign dialog.
// ---------------------------------------------------------------------------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const deptOf = (t) => t.atsDepartment || t.department || '';

export function tlLabel(t, note = '') {
  return `${t.name} — ${t.openJobs ? plural(t.openJobs, 'open requirement', 'open requirements') : 'no open requirements'}${note}`;
}

// The job's own department's team leads (the recommended ones), and — when the
// department has several — the least busy of them (fewest open jobs, then name).
const sameDept = (t, dept) => !!dept && deptOf(t).trim().toLowerCase() === String(dept).trim().toLowerCase();
export function recommendedTls(tls, dept) {
  return (tls || []).filter((t) => sameDept(t, dept)).sort((a, b) => ((a.openJobs || 0) - (b.openJobs || 0)) || a.name.localeCompare(b.name));
}
// The one to preselect: the department's only TL, or the least busy of several.
export const leastBusyTl = (tls, dept) => recommendedTls(tls, dept)[0] || null;

export function recruiterLabel(p) {
  // "Ravi — 4 jobs, 13 in process, 2 late · Least busy" (late only when there is some).
  const bits = [
    p.openJobs ? plural(p.openJobs, 'requirement', 'requirements') : 'no requirements',
    `${p.inProcess || 'none'} in process`,
    ...(p.late ? [`${p.late} late`] : []),
  ];
  return `${p.name} — ${bits.join(', ')}${p.leastBusy ? ' · Least busy' : ''}`;
}

// TLs grouped by department; `first` (the job's department) leads.
export function tlGroups(tls, first) {
  const by = new Map();
  (tls || []).forEach((t) => {
    const d = deptOf(t) || 'No department';
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(t);
  });
  return [...by.entries()]
    .sort(([a], [b]) => (b === first) - (a === first) || a.localeCompare(b))
    .map(([dept, list]) => ({ dept, tls: list.slice().sort((a, b) => a.name.localeCompare(b.name)) }));
}

// <optgroup>s for a TL <Combo>. `keep` = { id, name } of a TL already on the
// record who is no longer on the list (left, moved) — still shown.
// CALL AS A FUNCTION — {TlOptions({ … })}, not <TlOptions/>: Combo reads its
// <option>s from its children and cannot see inside a component.
export function TlOptions({ tls, first, keep }) {
  const groups = tlGroups(tls, first);
  const rec = recommendedTls(tls, first);
  const top = rec.length > 1 ? rec[0] : null;
  const missing = keep && keep.id && !(tls || []).some((t) => t.id === keep.id);
  return (
    <>
      {missing && <option value={keep.id}>{keep.name || 'Current team lead'}</option>}
      {groups.map((g) => (
        <optgroup key={g.dept} label={g.dept === first ? `Recommended — ${g.dept} team leads` : `Other departments — ${g.dept}`}>
          {(g.dept === first ? rec : g.tls).map((t) => <option key={t.id} value={t.id}>{tlLabel(t, top && top.id === t.id ? ' · Least busy' : '')}</option>)}
        </optgroup>
      ))}
    </>
  );
}

// Recruiter options: one plain list for a TL's own team, <optgroup>s by team
// for an Admin / Manager. `keep` = people already on the record.
export function RecruiterOptions({ groups, keep = [] }) {
  const list = groups || [];
  const shown = new Set(list.flatMap((g) => g.people.map((p) => p.id)));
  const extra = keep.filter((k) => k && k.id && !shown.has(k.id));
  return (
    <>
      {extra.map((k) => <option key={k.id} value={k.id}>{k.name || 'Current recruiter'}</option>)}
      {list.length === 1
        ? list[0].people.map((p) => <option key={p.id} value={p.id}>{recruiterLabel(p)}</option>)
        : list.map((g) => (
          <optgroup key={g.key} label={g.label}>
            {g.people.map((p) => <option key={p.id} value={p.id}>{recruiterLabel(p)}</option>)}
          </optgroup>
        ))}
    </>
  );
}

// SEVERAL RECRUITERS ON ONE JOB (user, 2026-10-13): chips + a list that shows each recruiter's work, least busy first.
// value: { recruiterId, recruiterIds } - the first chip is the main recruiter (recruiterId), the rest are recruiterIds.
// bench: GET /requirements/assignable-people?recruiters=1 ({ groups }), null while loading. keep: people already on the job.
export function recruiterMultiOptions(bench, keep = []) {
  const groups = (bench && bench.groups) || [];
  const shown = new Set(groups.flatMap((g) => g.people.map((p) => p.id)));
  const extra = keep.filter((k) => k && k.id && !shown.has(k.id)).map((k) => ({ value: k.id, label: k.name || 'Current recruiter', sub: 'Already on this requirement' }));
  const opt = (p, group) => ({
    value: p.id,
    label: p.name,
    group,
    sub: [p.openJobs ? plural(p.openJobs, 'requirement', 'requirements') : 'no requirements', `${p.inProcess || 'no one'} in process`, ...(p.late ? [`${p.late} late`] : [])].join(' · '),
    tag: p.leastBusy ? 'Least busy' : '',
  });
  return [...extra, ...groups.flatMap((g) => g.people.map((p) => opt(p, groups.length > 1 ? g.label : '')))];
}
export function RecruiterMulti({ bench, keep = [], value, onChange, disabled = false }) {
  // 2026-10-14: checkboxes grouped by team (no dropdown) - components/jobs/RecruiterChecklist.jsx
  return <RecruiterChecklist bench={bench} keep={keep} value={value} onChange={onChange} disabled={disabled} />;
}

// Every department's TLs. null while loading; [] if the server said no.
export function useAllTls(enabled = true) {
  const [tls, setTls] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    api.get('/requirements/assignable-people', { params: { tls: 'all' } })
      .then((r) => { if (live) setTls(Array.isArray(r.data && r.data.tls) ? r.data.tls : null); })
      .catch(() => { if (live) setTls(null); });
    return () => { live = false; };
  }, [enabled]);
  return tls;
}

// The recruiters for a job led by `tlId`, least busy first. null while loading.
export function useRecruiterBench(tlId, enabled = true, department = '') {
  const [bench, setBench] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setBench(null);
    api.get('/requirements/assignable-people', { params: { recruiters: 1, ...(tlId ? { tlId } : {}), ...(department ? { department } : {}) } })
      .then((r) => { if (live) setBench(r.data && Array.isArray(r.data.groups) ? r.data : { groups: [] }); })
      .catch(() => { if (live) setBench({ groups: [] }); });
    return () => { live = false; };
  }, [tlId, enabled, department]);
  return bench;
}

// The flat list behind a bench (co-recruiter ticks).
export const benchPeople = (bench) => ((bench && bench.groups) || []).flatMap((g) => g.people);

// Team lead + Recruiter + Co-recruiters for the job page's "Change team".
// value: { tlId, recruiterId, recruiterIds }; fallback: the plain people list
// (used when the server does not offer every department's TLs to this login).
export function TeamPickers({ job, value, onChange, fallback = [] }) {
  const allTls = useAllTls(true);
  const bench = useRecruiterBench(value.tlId, true, job.department || '');
  const roleOf = (t) => t.atsRole || t.role;
  const tls = allTls || fallback.filter((t) => roleOf(t) === 'TL');
  const keep = [
    job.recruiterId ? { id: job.recruiterId, name: job.recruiter?.name } : null,
    ...((job.coRecruiters || []).map((c) => ({ id: c.id, name: c.name }))),
  ].filter(Boolean);
  const tlList = value.tlIds || (value.tlId ? [value.tlId] : []);
  return (
    <>
      <div className="field">
        <span>Team leads</span>
        <TlChecklist
          tls={tls}
          loading={allTls === null && !tls.length}
          value={tlList}
          department={job.department}
          keep={tlList.map((id) => ({ id, name: id === job.tlId ? (job.tlName || job.tl) : ((job.extraTlNames || [])[(job.extraTlIds || []).indexOf(id)] || '') }))}
          onChange={(list) => onChange({ ...value, tlIds: list, tlId: list[0] || '' })}
        />
      </div>
      <div className="field">
        <span>Recruiters</span>
        <RecruiterMulti bench={bench} keep={keep} value={{ recruiterId: value.recruiterId, recruiterIds: value.recruiterIds || [] }} onChange={(r) => onChange({ ...value, ...r })} />
      </div>
    </>
  );
}
