import { useMemo, useState } from 'react';
import PickList from './PickList.jsx';
import { matchesText, noMatchText } from '../searchMatch.js';

// ---------------------------------------------------------------------------
// SEVERAL TEAM LEADS ON ONE JOB, AS CHECKBOXES (user, 2026-10-14).
//   - every department's team leads, grouped by department; a tick on the department selects all its TLs
//   - each row: checkbox, name, department, seat code, current work (open jobs)
//   - a search box (name / department / seat), "Select all shown" and "Clear"
//   - the FIRST ticked TL is the MAIN one (Main tag); the others are "also assigned"; "Make main" moves the tag
//   - choosing TLs of other departments never changes the job's own department
// value: [userId, ...] (first = main).  onChange(list).  tls: GET /requirements/assignable-people?tls=all
// keep: [{ id, name }] TLs already on the job who are not on the list any more (left, moved): still shown.
// ---------------------------------------------------------------------------
export const MAX_TLS = 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const deptOf = (t) => t.atsDepartment || t.department || '';
const seatOf = (t) => (t.seat && (t.seat.code || (typeof t.seat === 'string' ? t.seat : ''))) || '';
const work = (t) => (t.openJobs ? plural(t.openJobs, 'requirement', 'requirements') : 'no requirements');

export function tlNames(list, tls, keep = []) {
  const by = new Map([...(keep || []), ...(tls || [])].filter(Boolean).map((t) => [t.id, t.name]));
  return (list || []).map((id) => by.get(id)).filter(Boolean);
}

export default function TlChecklist({ tls, value = [], onChange, department = '', keep = [], disabled = false, loading = false }) {
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const list = useMemo(() => {
    const known = new Set((tls || []).map((t) => t.id));
    const extra = (keep || []).filter((k) => k && k.id && !known.has(k.id)).map((k) => ({ id: k.id, name: k.name || 'Current team lead', atsDepartment: '', openJobs: 0, kept: true }));
    return [...extra, ...(tls || [])];
  }, [tls, keep]);
  const byId = useMemo(() => new Map(list.map((t) => [t.id, t])), [list]);
  const shown = useMemo(() => {
    return list.filter((x) => matchesText(`${x.name} ${deptOf(x)} ${seatOf(x)}`, q));
  }, [list, q]);
  const groups = useMemo(() => {
    const by = new Map();
    shown.forEach((t) => {
      const d = deptOf(t) || (t.kept ? 'Already on this requirement' : 'No department');
      if (!by.has(d)) by.set(d, []);
      by.get(d).push(t);
    });
    const first = String(department || '').trim().toLowerCase();
    return [...by.entries()]
      .sort(([a], [b]) => ((b.toLowerCase() === first) - (a.toLowerCase() === first)) || a.localeCompare(b))
      .map(([dept, rows]) => ({ dept, rows: rows.slice().sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [shown, department]);
  const total = (dept) => list.filter((t) => (deptOf(t) || (t.kept ? 'Already on this requirement' : 'No department')) === dept).length;

  const set = (next) => { setNote(''); if (onChange) onChange(next); };
  const addMany = (ids) => {
    const next = [...value];
    let capped = false;
    ids.forEach((id) => {
      if (next.includes(id)) return;
      if (next.length >= MAX_TLS) { capped = true; return; }
      next.push(id);
    });
    if (onChange) onChange(next);
    setNote(capped ? `A requirement can have at most ${MAX_TLS} team leads.` : '');
  };
  const toggle = (id) => {
    if (disabled) return;
    if (value.includes(id)) set(value.filter((x) => x !== id));
    else addMany([id]);
  };
  const toggleDept = (rows) => {
    if (disabled) return;
    const ids = rows.map((r) => r.id);
    const all = ids.every((id) => value.includes(id));
    if (all) set(value.filter((x) => !ids.includes(x)));
    else addMany(ids);
  };
  const makeMain = (id) => set([id, ...value.filter((x) => x !== id)]);
  const nameOf = (id) => (byId.get(id) || {}).name || 'Team lead';
  const own = String(department || '').trim().toLowerCase();
  const pgroups = groups.map((g) => ({
    key: g.dept,
    label: g.dept,
    total: total(g.dept),
    tag: own && own === g.dept.toLowerCase() ? 'This requirement’s team' : '',
    rows: g.rows.map((t) => ({
      id: t.id,
      name: t.name,
      sub: seatOf(t) || 'No seat yet',
      badges: [{ text: work(t), tone: t.openJobs ? '' : 'quiet' }],
      main: value.length > 1 && value[0] === t.id,
    })),
  }));

  return (
    <PickList
      noun='team lead'
      nounPlural='team leads'
      picked={value.map((id) => ({ id, name: nameOf(id) }))}
      groups={pgroups}
      allCount={list.length}
      query={q}
      onQuery={setQ}
      onToggle={toggle}
      onToggleGroup={toggleDept}
      onSelectShown={addMany}
      onClear={() => set([])}
      onMakeMain={makeMain}
      disabled={disabled}
      loading={loading}
      note={note}
      searchPlaceholder='Type a name, department or seat'
      groupAria={(l) => `Select all in ${l}`}
      emptyText={q.trim() ? noMatchText(q) : 'No team leads to pick yet.'}
      mainLabel='Team leads'
    />
  );
}
