import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';

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

export function tlLabel(t) {
  return `${t.name} — ${t.openJobs ? plural(t.openJobs, 'open job', 'open jobs') : 'no open jobs'}`;
}

export function recruiterLabel(p) {
  // "Ravi — 4 jobs, 13 in process, 2 late · Least busy" (late only when there is some).
  const bits = [
    p.openJobs ? plural(p.openJobs, 'job', 'jobs') : 'no jobs',
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
  const missing = keep && keep.id && !(tls || []).some((t) => t.id === keep.id);
  return (
    <>
      {missing && <option value={keep.id}>{keep.name || 'Current team lead'}</option>}
      {groups.map((g) => (
        <optgroup key={g.dept} label={g.dept === first ? `${g.dept} (this job's department)` : g.dept}>
          {g.tls.map((t) => <option key={t.id} value={t.id}>{tlLabel(t)}</option>)}
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
  const list = benchPeople(bench);
  const coList = [...keep.filter((k) => !list.some((p) => p.id === k.id)), ...list];
  const top = list.find((p) => p.leastBusy);
  return (
    <>
      <label className="field">
        <span>Team lead — any department</span>
        <Combo value={value.tlId} onChange={(e) => onChange({ ...value, tlId: e.target.value })}>
          <option value="">— Not assigned —</option>
          {TlOptions({ tls: tls, first: job.department, keep: value.tlId ? { id: value.tlId, name: job.tlId === value.tlId ? (job.tlName || job.tl) : '' } : null })}
        </Combo>
      </label>
      <label className="field">
        <span>Recruiter — least busy first</span>
        <Combo value={value.recruiterId} onChange={(e) => onChange({ ...value, recruiterId: e.target.value })} disabled={bench === null}>
          <option value="">{bench === null ? 'Loading…' : '— Not assigned —'}</option>
          {bench && RecruiterOptions({ groups: bench.groups, keep: keep })}
        </Combo>
        {top && <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 4 }}>{`Least busy: ${top.name}`}</div>}
      </label>
      <div className="field">
        <span>Co-recruiters</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
          {coList.filter((t) => t.id !== value.recruiterId).map((t) => (
            <label key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, fontSize: 12.5 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={value.recruiterIds.includes(t.id)}
                onChange={() => onChange({
                  ...value,
                  recruiterIds: value.recruiterIds.includes(t.id)
                    ? value.recruiterIds.filter((x) => x !== t.id)
                    : [...value.recruiterIds, t.id],
                })}
              />
              {t.name}
            </label>
          ))}
          {bench && !coList.length && <span className="cell-muted" style={{ fontSize: 12 }}>No recruiters in this team yet.</span>}
        </div>
      </div>
    </>
  );
}
