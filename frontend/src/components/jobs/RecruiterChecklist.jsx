import { useMemo, useState } from 'react';
import PickList from './PickList.jsx';
import { matchesText, noMatchText } from '../searchMatch.js';

// ---------------------------------------------------------------------------
// SEVERAL RECRUITERS ON ONE JOB, AS CHECKBOXES (user, 2026-10-14) — every place that gives ONE job to recruiters uses this.
//   - grouped by TEAM (the team lead's name is the group header; a tick on it selects the whole team)
//   - row: checkbox, name, workload ("4 jobs, 13 in process, 2 late"), a "Least busy" tag
//   - search box (name / team), "Select all shown", "Clear", "N selected"
//   - the FIRST ticked recruiter is the MAIN one; "Make main" moves the tag
// bench: GET /requirements/assignable-people?recruiters=1 -> { groups: [{ key, label, people: [...] }] }, null while loading
// value: { recruiterId, recruiterIds: [...] }  onChange({ recruiterId, recruiterIds })
// keep: [{ id, name }] people already on the job who are not on the list any more.
// ---------------------------------------------------------------------------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const seatOf = (p) => (p.seat && (p.seat.code || (typeof p.seat === 'string' ? p.seat : ''))) || '';
const badgesOf = (p) => [
  { text: [p.openJobs ? plural(p.openJobs, 'requirement', 'requirements') : 'no requirements', p.inProcess ? `${p.inProcess} in process` : 'none in process'].join(' · '), tone: p.openJobs ? '' : 'quiet' },
  ...(p.late ? [{ text: `${p.late} late`, tone: 'late' }] : []),
  ...(p.leastBusy ? [{ text: 'Least busy', tone: 'best' }] : []),
];

export default function RecruiterChecklist({ bench, keep = [], value, onChange, disabled = false }) {
  const [q, setQ] = useState('');
  const list = [value.recruiterId, ...(value.recruiterIds || [])].filter(Boolean);
  const groups = useMemo(() => {
    const gs = ((bench && bench.groups) || []).map((g) => ({ key: g.key || g.label, label: g.label || 'Team', people: g.people || [] }));
    const shown = new Set(gs.flatMap((g) => g.people.map((p) => p.id)));
    const extra = (keep || []).filter((k) => k && k.id && !shown.has(k.id)).map((k) => ({ id: k.id, name: k.name || 'Current recruiter', openJobs: 0, inProcess: 0, kept: true }));
    return extra.length ? [{ key: '__kept', label: 'Already on this requirement', people: extra }, ...gs] : gs;
  }, [bench, keep]);
  const byId = useMemo(() => new Map(groups.flatMap((g) => g.people.map((p) => [p.id, p]))), [groups]);
  const shownGroups = groups
    .map((g) => ({ ...g, rows: g.people.filter((p) => matchesText(`${p.name} ${g.label}`, q)) }))
    .filter((g) => g.rows.length);
  const shownIds = shownGroups.flatMap((g) => g.rows.map((p) => p.id));
  const set = (next) => onChange({ recruiterId: next[0] || '', recruiterIds: next.slice(1) });
  const toggle = (id) => { if (!disabled) set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]); };
  const addMany = (ids) => set([...list, ...ids.filter((i) => !list.includes(i))]);
  const toggleTeam = (g) => {
    const ids = g.rows.map((p) => p.id);
    if (ids.every((i) => list.includes(i))) set(list.filter((x) => !ids.includes(x)));
    else addMany(ids);
  };
  const nameOf = (id) => (byId.get(id) || {}).name || (keep.find((k) => k && k.id === id) || {}).name || 'Recruiter';
  const loading = bench === null && !disabled;
  const pgroups = shownGroups.map((g) => ({
    key: g.key,
    label: g.label,
    total: g.people.length,
    rows: g.rows.map((p) => ({ id: p.id, name: p.name, sub: seatOf(p), badges: badgesOf(p), main: list.length > 1 && list[0] === p.id })),
  }));

  return (
    <PickList
      noun='recruiter'
      nounPlural='recruiters'
      picked={list.map((id) => ({ id, name: nameOf(id) }))}
      groups={pgroups}
      allCount={groups.reduce((n, g) => n + g.people.length, 0)}
      query={q}
      onQuery={setQ}
      onToggle={toggle}
      onToggleGroup={toggleTeam}
      onSelectShown={addMany}
      onClear={() => set([])}
      onMakeMain={(id) => set([id, ...list.filter((x) => x !== id)])}
      disabled={disabled}
      loading={loading}
      searchPlaceholder='Type a name or team'
      groupAria={(l) => `Select all in ${l}`}
      emptyText={q.trim() ? noMatchText(q) : 'No recruiters in this team yet.'}
      mainLabel='Recruiters, least busy first'
    />
  );
}
