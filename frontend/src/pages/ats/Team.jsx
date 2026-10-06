import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isClientUser, productRole } from '../../permissions';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import ListPageHeader, {
  StatusTabs, ListToolbar, ListFooter, FacetSelect, PanelField, useLocalFacets,
} from '../../components/ui/ListPageHeader.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import Recruiter360, { metricLink } from './Recruiter360.jsx';
import FormerHistory from './FormerHistory.jsx';
import PendingWork from '../../components/team/PendingWork.jsx';
import DeptTeamsAdmin from '../../components/team/DeptTeamsAdmin.jsx';
import FollowUps from './FollowUps.jsx';
// ATS layout v3 §5 — the performance snapshot's progress bars (shared kit).
import { ProgressBar } from '../../components/charts';
import './Team.css';
import { Help } from '../../components/ui/Guide.jsx';

// ---------------------------------------------------------------------------
// RECRUITER & BDE — the operational control centre for Recruiter / TL / BDE
// work (the user's binding spec, 2026-09-29).
//
//   [ People & Workload ]  WHO is responsible        role switch Recruiter | BDE | TL
//   [ Assignments ]        WHAT is assigned to whom  Department → Section → TL →
//                                                    Recruiter → Requirement; Client → BDE
//   [ Pending Actions ]    what must be done NOW     one row per active application:
//                                                    Stage → Next Action → Owner → Due
//
// Click a name for their 360 (Recruiter / BDE / TL). Every number opens the
// exact list it counts: ?view=list&person=<id>&metric=<m> (the rows the server
// counted, GET /api/ats/team/:id?metric=), and the action numbers open the
// Pending Actions tab filtered to that owner (?view=pending&owner=<id>).
//
// SCOPE IS THE SERVER'S (GET /api/ats/team, backend utils/teamWorkload.js):
// Super Admin everything; Manager everything read-only; STL their departments;
// TL their own team; Recruiter their own work; BDE their own clients; HR the
// internal hiring; Accounts refused. The UI only hides.
// ---------------------------------------------------------------------------

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const SELF_ROLES = ['RECRUITER', 'BDE'];
// Display words only (ATS layout v3 §5: Admin / Dept Head / BDE / Recruiter) —
// the role codes and what each role may do are unchanged.
const ROLE_SWITCH = [['RECRUITER', 'Recruiter'], ['BDE', 'Client manager (BDE)'], ['TL', 'Dept Head (TL)']];
const ROLE_WORD = {
  SUPER_ADMIN: 'Admin', ADMIN: 'Admin', MANAGER: 'Admin', ASSISTANT_MANAGER: 'Admin',
  STL: 'Dept Head', TL: 'Dept Head', BDE: 'BDE', RECRUITER: 'Recruiter',
};
const roleWord = (r) => ROLE_WORD[r.role] || ROLE_WORD[r.roleGroup] || r.roleLabel || '';
// Old ?tab= links still land in the right place.
const LEGACY_TABS = {
  recruiters: { view: 'people', role: 'RECRUITER' },
  bdes: { view: 'people', role: 'BDE' },
  workload: { view: 'people' },
  mywork: { view: 'people' },
  assignments: { view: 'assignments' },
  pending: { view: 'pending' },
  seats: { view: 'seats' },
};
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const lc = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// The shared list layout (spec 2026-10-03 §B): every filter lives in the
// Filters panel with browser-counted options (useLocalFacets — the page holds
// these lists whole). pred(row, key, value) is the ONE match rule per tab, used
// both to filter the table and to count the options (so a count is exactly
// what picking it shows).
const isSet = (v) => v !== '' && v !== undefined && v !== null;
const applyFilters = (rows, values, pred) => {
  const keys = Object.keys(values).filter((k) => isSet(values[k]));
  return keys.length ? rows.filter((r) => keys.every((k) => pred(r, k, values[k]))) : rows;
};
const personKey = (p) => (p && p.name ? (p.id ? `id:${p.id}` : `name:${p.name}`) : null);
const optLabel = (opts, v, fallback) => ((opts || []).find((o) => o.value === v) || {}).label || fallback || v;
// "Sort" for a table that also sorts by its column headers: a value the
// headers produced that the menu does not list is added, so the two agree.
const sortValue = (s) => (s.key ? `${s.key}:${s.dir}` : '');
const parseSort = (v) => { const [key, dir] = String(v || '').split(':'); return { key: key || '', dir: dir || 'desc' }; };

// A number that opens the list it counts.
function NumLink({ to, value, danger, title }) {
  if (value === null || value === undefined) return <span className="cell-muted">—</span>;
  const cls = `pw-num${danger && value > 0 ? ' danger' : ''}${value === 0 ? ' zero' : ''}`;
  // Never a bare zero in a table cell: a quiet dash instead of "0".
  if (value === 0) return <span className={cls} title={title}>—</span>;
  if (!to) return <span className={cls} title={title}>{fmt(value)}</span>;
  return <Link className={cls} to={to} title={title} onClick={(e) => e.stopPropagation()}>{fmt(value)}</Link>;
}

// Due chip: 🔴 overdue · 🟡 due today · 🟢 upcoming · no due date.
const DUE_META = {
  overdue: ['🔴', 'Late', 'red'],
  today: ['🟠', 'Due today', 'amber'],
  upcoming: ['🔵', 'Upcoming', 'blue'],
  none: ['', 'No due date', 'grey'],
};
function DueChip({ status, dueAt, source }) {
  const [icon, label, tone] = DUE_META[status] || DUE_META.none;
  const title = status === 'none'
    ? 'No due date yet. Moving the step or adding a follow-up sets one.'
    : `${label}${dueAt ? ` — due ${day(dueAt)}` : ''}${source === 'follow-up' ? ' (follow-up)' : source === 'stage-sla' ? ' (days for this step)' : ''}`;
  return (
    <span className="pw-due" title={title}>
      <StatusChip tone={tone}>{icon ? `${icon} ` : ''}{status === 'none' ? '—' : label}</StatusChip>
      {dueAt && status !== 'none' && <span className="small-muted pw-due-date">{day(dueAt)}</span>}
    </span>
  );
}

function SortTh({ id, label, sort, setSort, title, num }) {
  const on = sort.key === id;
  const next = () => setSort(on ? { key: id, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key: id, dir: id === 'name' ? 'asc' : 'desc' });
  return (
    <th className={`pw-sort${on ? ' on' : ''}${num ? ' num' : ''}`} title={title} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={next}>
        {label}
        <span className="pw-sort-arrow" aria-hidden="true">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
      {title && <Help text={title} />}
    </th>
  );
}

// ===========================================================================
// PEOPLE & WORKLOAD
// ===========================================================================
const PEOPLE_COLUMNS = {
  RECRUITER: [
    ['openRequirements', 'Open jobs', 'Open jobs given to them'],
    ['activeCandidates', 'People in process', 'People they are moving through a job now'],
    ['needsAction', 'Needs action', 'Next steps that are theirs to do'],
  ],
  BDE: [
    ['clients', 'Clients', 'Clients they look after'],
    ['openRequirements', 'Open jobs', 'Open jobs of their clients'],
    ['submitted', 'Sent to client', 'People sent to their clients'],
    ['feedbackPending', 'Waiting for client', 'Sent and waiting for the client'],
    ['interviews', 'Interviews', 'Interviews booked or done'],
    ['selected', 'Selected', 'Selected or offered, not joined yet'],
    ['activeClients', 'Active clients', 'Their clients with an open job'],
    ['clientActions', 'Client tasks', 'Client next steps that are theirs'],
  ],
  TL: [
    ['recruiters', 'Recruiters', 'Recruiters whose seat reports to them'],
    ['requirements', 'Jobs', 'Open jobs of their team'],
    ['candidates', 'Candidates', 'People in process in their team'],
    ['pendingReviews', 'Waiting for check', 'Candidates waiting for their check'],
  ],
};

// Status (user, 2026-10-05): Active / Former / All. FORMER = everyone who has
// left — the people from HRMS (GET /ats/team?view=former, utils/formerPeople.js)
// and any login marked Left. A former person is listed under EVERY department
// they worked in (r.departments, each with dates in r.stints).
const isFormer = (r) => !!r.former || r.status === 'Left';
const peopleTl = (r) => (r.tl ? (r.tlUserId ? `id:${r.tlUserId}` : `name:${r.tl}`) : null);
const deptsOf = (r) => (r.former && r.departments ? r.departments : [r.department]);
const sectionsOf = (r) => (r.former && r.sections ? r.sections : [r.section]);
const PEOPLE_FIELDS = [
  { key: 'role', get: (r) => r.roleGroup },
  { key: 'dept', get: deptsOf },
  { key: 'section', get: sectionsOf },
  { key: 'tl', get: peopleTl, label: (v, r) => r.tl },
  { key: 'client', get: (r) => (r.clientOptions || []).map((c) => c.id), label: (v, r) => ((r.clientOptions || []).find((c) => c.id === v) || {}).name || v },
  { key: 'status', get: (r) => (isFormer(r) ? 'Former' : 'Active') },
];
function peoplePred(r, k, v) {
  switch (k) {
    case 'role': return r.roleGroup === v;
    case 'dept': return deptsOf(r).includes(v);
    case 'section': return sectionsOf(r).includes(v);
    case 'tl': return v.startsWith('id:') ? r.tlUserId === v.slice(3) : lc(r.tl) === lc(v.slice(5));
    case 'client': return (r.clientOptions || []).some((c) => c.id === v);
    case 'status': return v === 'Former' ? isFormer(r) : !isFormer(r);
    default: return true;
  }
}
const monthYear = (v) => (v ? new Date(`${String(v).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '?');
// "Medical · Oct 2025 – Jan 2026" — one line per department they worked in;
// the picked department first and in bold.
function Stints({ r, dept }) {
  const list = [...(r.stints || [])].sort((a, b) => (b.department === dept) - (a.department === dept));
  if (!list.length) return <span className="cell-muted">—</span>;
  return list.map((s) => (
    <span key={s.department} className={`fh-stint${s.department === dept ? ' is-picked' : ''}`} title={s.via.join(', ')}>
      {`${s.department} · ${monthYear(s.from)} – ${monthYear(s.to)}`}
    </span>
  ));
}

// PERFORMANCE SNAPSHOT (ATS layout v3 §5) — for the people listed below:
// sent to the client, at interview, joined. Each bar is scaled to the best
// in the list and opens the exact list it counts (metricLink — the same sets
// as the table's numbers). Sent and Interviews are where people are NOW;
// Joined is everyone who joined.
const SNAP = [['submitted', 'Sent to client', 'blue'], ['interviews', 'Interviews', 'yellow'], ['joined', 'Joined', 'green']];
const SNAP_TOP = 8;
function PerfSnapshot({ list, onOpen }) {
  const [all, setAll] = useState(false);
  const people = list.filter((r) => !r.former && r.counts);
  const max = Object.fromEntries(SNAP.map(([k]) => [k, Math.max(1, ...people.map((r) => Number(r.counts[k]) || 0))]));
  const ranked = [...people]
    .filter((r) => SNAP.some(([k]) => Number(r.counts[k]) > 0))
    .sort((a, b) => (b.counts.joined || 0) - (a.counts.joined || 0) || (b.counts.submitted || 0) - (a.counts.submitted || 0) || String(a.name).localeCompare(String(b.name)));
  const shown = all ? ranked : ranked.slice(0, SNAP_TOP);
  return (
    <section className="card pw-snap">
      <div className="pw-snap-head">
        <h3>Performance snapshot</h3>
        <span className="small-muted">Sent to client and interviews: where people are now. Joined: everyone who joined.</span>
      </div>
      {!ranked.length && <div className="small-muted pw-snap-empty">Nobody here has sent a person to a client yet.</div>}
      {shown.map((r) => (
        <div key={r.id} className="pw-snap-row">
          <div className="pw-snap-who">
            <button type="button" className="pw-person" onClick={() => onOpen(r.id)} title="Open their 360">{r.name}</button>
            <span className="pw-role-word">{roleWord(r)}</span>
            {r.department && <span className="small-muted">{r.department}</span>}
          </div>
          {SNAP.map(([k, label, tone]) => {
            const v = Number(r.counts[k]) || 0;
            // The number is the person's own; the bar is against the best here.
            const bar = (
              <>
                <span className="pw-snap-lbl"><span>{label}</span><b>{v ? v.toLocaleString('en-IN') : 'None'}</b></span>
                <ProgressBar value={v} max={max[k]} tone={v ? tone : 'grey'} />
              </>
            );
            return v
              ? <Link key={k} className="pw-snap-cell" to={metricLink(r.id, k)} title={`Open ${r.name}'s ${label.toLowerCase()}`}>{bar}</Link>
              : <span key={k} className="pw-snap-cell">{bar}</span>;
          })}
        </div>
      ))}
      {ranked.length > SNAP_TOP && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(!all)}>
          {all ? 'Show the top 8' : `Show all ${ranked.length}`}
        </button>
      )}
    </section>
  );
}

function PeopleTab({
  rows, loading, isLead, initialRole, onOpen, onOpenFormer, formerAllowed, formerLoading, clientsOf, onShown,
}) {
  const presentRoles = useMemo(() => ROLE_SWITCH.filter(([id]) => rows.some((r) => r.roleGroup === id)), [rows]);
  const defaultRole = presentRoles[0] ? presentRoles[0][0] : 'RECRUITER';
  const [roleSel, setRoleSel] = useState(initialRole || '');
  const role = presentRoles.some(([id]) => id === roleSel) ? roleSel : defaultRole;
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [section, setSection] = useState('');
  const [tl, setTl] = useState('');
  const [status, setStatus] = useState('Active');
  const [client, setClient] = useState('');
  const [sort, setSort] = useState({ key: '', dir: 'desc' });
  useEffect(() => { setSection(''); setTl(''); setClient(''); setSort({ key: '', dir: 'desc' }); }, [role]);

  const inRole = useMemo(() => rows.filter((r) => r.roleGroup === role), [rows, role]);
  // Everyone in scope — current and former (the page merges them) — searched;
  // the panel's options are counted over this.
  const searched = useMemo(() => rows
    .filter((r) => !q || `${r.name} ${r.employeeCode || ''} ${r.recruiterCode || ''} ${r.seatLabel || ''}`.toLowerCase().includes(lc(q))), [rows, q]);
  const values = useMemo(() => ({
    role, dept, section, tl, client, status,
  }), [role, dept, section, tl, client, status]);
  const facets = useLocalFacets(searched, PEOPLE_FIELDS, values, peoplePred);

  const list = useMemo(() => {
    const out = applyFilters(searched, values, peoplePred);
    if (!sort.key) return out;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...out].sort((a, b) => {
      if (sort.key === 'name') return dir * String(a.name).localeCompare(String(b.name));
      const x = (a.counts || {})[sort.key];
      const y = (b.counts || {})[sort.key];
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return dir * (x - y) || String(a.name).localeCompare(String(b.name));
    });
  }, [searched, values, sort]);

  const cols = PEOPLE_COLUMNS[role] || [];
  const nameLabel = { RECRUITER: 'Person', BDE: 'Client manager', TL: 'Dept Head' }[role];
  const noun = { RECRUITER: 'recruiters', BDE: 'client managers', TL: 'dept heads' }[role] || 'people';
  const roleCount = (id) => ((facets.role || []).find((o) => o.value === id) || {}).count || 0;
  const chips = [
    role !== defaultRole && { key: 'role', label: 'Role', value: (ROLE_SWITCH.find(([id]) => id === role) || [])[1] || role, onRemove: () => setRoleSel(defaultRole) },
    dept && { key: 'dept', label: 'Department', value: dept, onRemove: () => { setDept(''); setSection(''); } },
    section && { key: 'section', label: 'Section', value: section, onRemove: () => setSection('') },
    tl && { key: 'tl', label: 'Team lead', value: optLabel(facets.tl, tl, tl.slice(tl.indexOf(':') + 1)), onRemove: () => setTl('') },
    client && { key: 'client', label: 'Client', value: optLabel(facets.client, client, 'Selected'), onRemove: () => setClient('') },
    status !== 'Active' && { key: 'status', label: 'Showing', value: status === 'Former' ? 'Former people' : 'Active + former', onRemove: () => setStatus('Active') },
  ].filter(Boolean);
  const clearAll = () => { setRoleSel(defaultRole); setDept(''); setSection(''); setTl(''); setClient(''); setStatus('Active'); setQ(''); };
  // The page's export takes exactly the rows shown.
  useEffect(() => { if (onShown) onShown(list.map((r) => r.id), status); }, [list, status, onShown]);
  const statusCount = (v) => ((facets.status || []).find((o) => o.value === v) || {}).count || 0;
  const sortOptions = [
    ['', 'Default order'], ['name:asc', 'Name A–Z'], ['name:desc', 'Name Z–A'],
    ...cols.map(([id, label]) => [`${id}:desc`, `Most ${label.toLowerCase()}`]),
  ];
  if (sort.key && !sortOptions.some(([k]) => k === sortValue(sort))) {
    const col = cols.find(([id]) => id === sort.key);
    sortOptions.push([sortValue(sort), col ? `Fewest ${col[1].toLowerCase()}` : sortValue(sort)]);
  }
  const bdeEmpty = role === 'BDE' && inRole.length > 0 && inRole.every((r) => !(r.counts && r.counts.clients));
  const showCols = role === 'BDE' ? cols.slice(0, 6) : cols;
  const extraCols = role === 'BDE' ? cols.slice(6) : [];

  return (
    <>
      {isLead && (
        <ListToolbar
          search={q}
          onSearch={setQ}
          placeholder={`Search ${nameLabel.toLowerCase()} name or code`}
          filterCount={chips.length}
          sort={sortValue(sort)}
          sortOptions={sortOptions}
          onSort={(v) => setSort(parseSort(v))}
          chips={[...chips, q && { key: 'q', label: 'Search', value: q, onRemove: () => setQ('') }].filter(Boolean)}
          onClearAll={clearAll}
          panel={(
            <>
              {presentRoles.length > 1 && (
                <PanelField label="Role">
                  <select value={role} onChange={(e) => setRoleSel(e.target.value)} aria-label="Role">
                    {presentRoles.map(([id, label]) => <option key={id} value={id}>{`${label} (${fmt(roleCount(id))})`}</option>)}
                  </select>
                </PanelField>
              )}
              <FacetSelect label="Department" value={dept} onChange={(v) => { setDept(v); setSection(''); }} options={facets.dept} allLabel="All departments" />
              {role !== 'BDE' && <FacetSelect label="Section" value={section} onChange={setSection} options={facets.section} allLabel="All sections" />}
              {role === 'RECRUITER' && <FacetSelect label="Team lead" value={tl} onChange={setTl} options={facets.tl} allLabel="All team leads" />}
              {role === 'BDE' && <FacetSelect label="Client" value={client} onChange={setClient} options={facets.client} allLabel="All clients" />}
            </>
          )}
        />
      )}
      {bdeEmpty && (
        <div className="notice pw-notice">
          <b>No client manager has a client yet.</b> Set one on each client in <Link to="/clients">Clients</Link>, and these numbers fill in.
        </div>
      )}
      {loading
        ? <div className="small-muted" style={{ padding: 16 }}>Loading…</div>
        : (
          <>
            {isLead && status !== 'Former' && <PerfSnapshot list={list} onOpen={onOpen} />}
            <div className="pw-tablebar">
              <span className="small-muted">
                {status === 'Former' ? 'Click a name to see their work history.' : 'Click a name or a number to see the list.'}
              </span>
              {isLead && formerAllowed && (
                <div className="fh-seg" role="group" aria-label="Active or former people">
                  {[['Active', 'Active', statusCount('Active')], ['Former', 'Former', statusCount('Former')], ['', 'All', null]].map(([v, label, n]) => (
                    <button key={label} type="button" className={status === v ? 'on' : ''} aria-pressed={status === v} onClick={() => setStatus(v)}>
                      {label}
                      {v === 'Former' && formerLoading ? <span className="n">…</span> : (n ? <span className="n">{fmt(n)}</span> : null)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {status !== 'Active' && formerLoading && <div className="small-muted pw-notice">Loading the people who have left…</div>}
            <div className="tbl-wrap">
              <table className="pw-table">
                <thead>
                  <tr>
                    <SortTh id="name" label={nameLabel} sort={sort} setSort={setSort} />
                    {role === 'RECRUITER' && <><th>Department · Section</th><th title="TL = team lead">Team lead</th><th>Clients<Help text="Clients of the open jobs given to them" /></th></>}
                    {role === 'TL' && <><th>Department</th><th>Section</th></>}
                    {showCols.map(([id, label, title]) => <SortTh key={id} id={id} label={label} title={title} sort={sort} setSort={setSort} num />)}
                    {extraCols.map(([id, label, title]) => <SortTh key={id} id={id} label={label} title={title} sort={sort} setSort={setSort} num />)}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const c = r.counts || {};
                    // A former person opens their work history; everyone else their 360.
                    const open = r.former ? () => onOpenFormer(r.id) : () => onOpen(r.id);
                    const t = r.totals || {};
                    return (
                      <tr key={r.id} className={r.former ? 'pw-former pw-click' : 'pw-click'} onClick={open}>
                        <td>
                          <button type="button" className="pw-person" onClick={(e) => { e.stopPropagation(); open(); }} title={r.former ? `Open ${r.name}'s work history` : `Open ${r.roleLabel} 360`}>{r.name}</button>
                          {roleWord(r) && <span className="pw-role-word">{roleWord(r)}</span>}
                          {r.role === 'STL' && <span className="small-muted"> · STL</span>}
                          {(r.seatLabel || r.recruiterCode) && <div className="small-muted">{r.seatLabel || r.recruiterCode}</div>}
                          {r.status === 'Left' && !r.former && <div><span className="fh-leftline">Left</span></div>}
                          {r.former && <div><span className="fh-leftline">{r.leftOn ? `Left on ${day(r.leftOn)}` : 'Left · last day not recorded'}</span></div>}
                          {r.former && role === 'BDE' && <div className="small-muted"><Stints r={r} dept={dept} /></div>}
                        </td>
                        {role === 'RECRUITER' && (
                          <>
                            <td>
                              {r.former ? <Stints r={r} dept={dept} /> : (r.department || <span className="cell-muted">—</span>)}
                              {(r.former ? (r.sections || []).join(', ') : r.section) && <div className="small-muted">{r.former ? (r.sections || []).join(', ') : r.section}</div>}
                            </td>
                            <td>{r.tl || <span className="cell-muted">—</span>}</td>
                            <td className="pw-clients">{(() => {
                              const names = r.former ? [] : [...((clientsOf && clientsOf.get(r.id)) || [])].sort();
                              if (!names.length) return <span className="cell-muted">—</span>;
                              return <span title={names.join(', ')}>{`${names.length} · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`}</span>;
                            })()}</td>
                          </>
                        )}
                        {role === 'TL' && (
                          <>
                            <td>{r.former ? <Stints r={r} dept={dept} /> : (r.department || <span className="cell-muted">—</span>)}</td>
                            <td>{(r.former ? (r.sections || []).join(', ') : r.section) || <span className="cell-muted">—</span>}</td>
                          </>
                        )}
                        {r.former
                          ? (
                            <td colSpan={showCols.length + extraCols.length} className="small-muted">
                              {t.added
                                ? `Their work: ${fmt(t.jobs)} job(s) · ${fmt(t.added)} candidate(s) added · ${fmt(t.sent)} sent to client · ${fmt(t.interviews)} interview(s) · ${fmt(t.joined)} joined`
                                : 'No ATS work recorded under their name'}
                            </td>
                          )
                          : [...showCols, ...extraCols].map(([id, label]) => (
                            <td key={id} className="num">
                              <NumLink to={metricLink(r.id, id)} value={c[id]} title={`Open ${r.name}'s ${label.toLowerCase()}`} />
                            </td>
                          ))}
                      </tr>
                    );
                  })}
                  {list.length === 0 && (
                    <tr>
                      <td colSpan={1 + (role === 'RECRUITER' ? 3 : role === 'TL' ? 2 : 0) + cols.length} style={{ padding: 0 }}>
                        <EmptyState
                          compact
                          icon="👥"
                          title={status === 'Former'
                            ? (formerLoading ? 'Loading the people who have left…' : `No former ${noun}${dept ? ` in ${dept}` : ' in your area'}.`)
                            : (chips.length || q ? 'Nobody matches these filters.' : `No ${noun} in your area yet.`)}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <ListFooter from={list.length ? 1 : 0} to={list.length} total={list.length} noun={noun} />
          </>
        )}
    </>
  );
}

// ===========================================================================
// ASSIGNMENTS
// ===========================================================================
const ASSIGNMENT_STATUSES = ['Fully Assigned', 'Recruiter Missing', 'BDE Missing', 'TL Missing', 'Needs Assignment'];
const REQ_STATUS = [['live', 'Open'], ['ON_HOLD', 'On Hold'], ['CLOSED', 'Closed']];
const ASSIGN_TONE = {
  'Fully Assigned': 'green', 'Recruiter Missing': 'amber', 'BDE Missing': 'amber', 'TL Missing': 'amber', 'Needs Assignment': 'red',
};

// On screen: no bare "TL" / "BDE" in a status (the filter values stay the same).
const ASSIGN_PLAIN = { 'TL Missing': 'Team lead missing', 'BDE Missing': 'Client manager missing' };
const personMatch = (value, p) => !!p && (value.startsWith('id:') ? p.id === value.slice(3) : lc(p.name) === lc(value.slice(5)));
const REQ_STATUS_LABEL = Object.fromEntries(REQ_STATUS);
const ASSIGN_FIELDS = [
  { key: 'status', get: (r) => [r.live ? 'live' : null, ['ON_HOLD', 'CLOSED'].includes(r.status) ? r.status : null], label: (v) => REQ_STATUS_LABEL[v] || v },
  { key: 'dept', get: (r) => r.department },
  { key: 'section', get: (r) => r.section },
  { key: 'tl', get: (r) => personKey(r.tl), label: (v, r) => r.tl.name },
  { key: 'recruiter', get: (r) => (r.recruiters || []).map(personKey), label: (v, r) => ((r.recruiters || []).find((p) => personKey(p) === v) || {}).name || v },
  { key: 'bde', get: (r) => (r.bde ? personKey(r.bde) : r.bdeRequired ? 'none' : null), label: (v, r) => (v === 'none' ? 'BDE missing (client reqs)' : r.bde.name) },
  { key: 'client', get: (r) => r.client },
  { key: 'type', get: (r) => r.type },
  { key: 'assign', get: (r) => r.assignment },
];
function assignPred(r, k, v) {
  switch (k) {
    case 'status': return v === 'live' ? !!r.live : r.status === v;
    case 'dept': return r.department === v;
    case 'section': return r.section === v;
    case 'tl': return personMatch(v, r.tl);
    case 'recruiter': return (r.recruiters || []).some((p) => personMatch(v, p));
    case 'bde': return v === 'none' ? !!(r.bdeRequired && !r.bde) : personMatch(v, r.bde);
    case 'client': return r.client === v;
    case 'type': return r.type === v;
    case 'assign': return r.assignment === v;
    default: return true;
  }
}

function AssignmentsTab({ rows, error, initial }) {
  const navigate = useNavigate();
  const [q, setQ] = useState(initial.q || '');
  const [dept, setDept] = useState(initial.dept || '');
  const [section, setSection] = useState('');
  const [tl, setTl] = useState(initial.tl || '');
  const [recruiter, setRecruiter] = useState(initial.recruiter || '');
  const [bde, setBde] = useState(initial.bde || '');
  const [client, setClient] = useState(initial.client || '');
  const [type, setType] = useState(initial.type || '');
  const [status, setStatus] = useState(initial.status === undefined ? 'live' : initial.status);
  const [assign, setAssign] = useState(initial.assign || '');
  const [layout, setLayout] = useState('table');
  const all = rows || [];

  const [sort, setSort] = useState('');
  const searched = useMemo(() => all.filter((r) => !q || `${r.reqCode || ''} ${r.title} ${r.client}`.toLowerCase().includes(lc(q))), [all, q]);
  const values = useMemo(() => ({
    status, dept, section, tl, recruiter, bde, client, type, assign,
  }), [status, dept, section, tl, recruiter, bde, client, type, assign]);
  const facets = useLocalFacets(searched, ASSIGN_FIELDS, values, assignPred);

  const list = useMemo(() => {
    const out = applyFilters(searched, values, assignPred);
    if (!sort) return out;
    const by = {
      title: (r) => String(r.title || ''),
      client: (r) => String(r.client || ''),
    }[sort];
    if (by) return [...out].sort((a, b) => by(a).localeCompare(by(b)));
    // Needs Assignment first, Fully Assigned last.
    const rank = (r) => ASSIGNMENT_STATUSES.length - ASSIGNMENT_STATUSES.indexOf(r.assignment);
    return [...out].sort((a, b) => rank(b) - rank(a) || String(a.title || '').localeCompare(String(b.title || '')));
  }, [searched, values, sort]);
  const page = usePaged(list);
  const tally = useMemo(() => {
    const t = {};
    list.forEach((r) => { t[r.assignment] = (t[r.assignment] || 0) + 1; });
    return t;
  }, [list]);

  const nameOf = (v) => v.slice(v.indexOf(':') + 1);
  const chips = [
    dept && { key: 'dept', label: 'Department', value: dept, onRemove: () => { setDept(''); setSection(''); } },
    section && { key: 'section', label: 'Section', value: section, onRemove: () => setSection('') },
    tl && { key: 'tl', label: 'Team lead', value: optLabel(facets.tl, tl, nameOf(tl)), onRemove: () => setTl('') },
    recruiter && { key: 'rec', label: 'Recruiter', value: optLabel(facets.recruiter, recruiter, nameOf(recruiter)), onRemove: () => setRecruiter('') },
    bde && { key: 'bde', label: 'Client manager', value: bde === 'none' ? 'Missing' : optLabel(facets.bde, bde, nameOf(bde)), onRemove: () => setBde('') },
    client && { key: 'client', label: 'Client', value: client, onRemove: () => setClient('') },
    type && { key: 'type', label: 'Type', value: type, onRemove: () => setType('') },
    status !== 'live' && { key: 'status', label: 'Status', value: (REQ_STATUS.find(([v]) => v === status) || [])[1] || 'All', onRemove: () => setStatus('live') },
    assign && { key: 'assign', label: 'Assignment', value: assign, onRemove: () => setAssign('') },
  ].filter(Boolean);
  const clearAll = () => { setQ(''); setDept(''); setSection(''); setTl(''); setRecruiter(''); setBde(''); setClient(''); setType(''); setStatus('live'); setAssign(''); };

  if (error) return <div className="notice red">{error}</div>;
  return (
    <>
      <ListToolbar
        search={q}
        onSearch={setQ}
        placeholder="Search job, job code or client"
        filterCount={chips.length}
        sort={sort}
        sortOptions={[['', 'Default order'], ['title', 'Job A–Z'], ['client', 'Client A–Z'], ['assign', 'Needs assignment first']]}
        onSort={setSort}
        chips={[...chips, q && { key: 'q', label: 'Search', value: q, onRemove: () => setQ('') }].filter(Boolean)}
        onClearAll={clearAll}
        panel={(
          <>
            <FacetSelect label="Department" value={dept} onChange={(v) => { setDept(v); setSection(''); }} options={facets.dept} allLabel="All departments" />
            <FacetSelect label="Section" value={section} onChange={setSection} options={facets.section} allLabel="All sections" />
            <FacetSelect label="Team lead" value={tl} onChange={setTl} options={facets.tl} allLabel="All team leads" />
            <FacetSelect label="Recruiter" value={recruiter} onChange={setRecruiter} options={facets.recruiter} allLabel="All recruiters" />
            <FacetSelect label="Client manager (BDE)" value={bde} onChange={setBde} options={facets.bde} allLabel="All client managers" />
            <FacetSelect label="Client" value={client} onChange={setClient} options={facets.client} allLabel="All clients" />
            <FacetSelect label="Type" value={type} onChange={setType} options={facets.type} allLabel="Client + Internal" />
            <FacetSelect label="Status" value={status} onChange={setStatus} options={facets.status} allLabel="All statuses" />
            <FacetSelect label="Assignment" value={assign} onChange={setAssign} options={facets.assign} allLabel="Any assignment" />
          </>
        )}
      />
      {rows && list.length > 0 && (
        <div className="pw-assign-bar">
          <span className="pw-layout" role="group" aria-label="Layout">
            <button type="button" className={layout === 'table' ? 'active' : ''} onClick={() => setLayout('table')}>Table</button>
            <button type="button" className={layout === 'tree' ? 'active' : ''} onClick={() => setLayout('tree')}>Hierarchy</button>
          </span>
          {ASSIGNMENT_STATUSES.filter((s) => tally[s]).map((s) => (
            <button key={s} type="button" className={`pw-tally${assign === s ? ' on' : ''}`} onClick={() => setAssign(assign === s ? '' : s)} title={`Show only ${s}`}>
              <StatusChip tone={ASSIGN_TONE[s]}>{`${s} ${fmt(tally[s])}`}</StatusChip>
            </button>
          ))}
        </div>
      )}
      {rows === null && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}
      {rows && layout === 'tree' && list.length > 0 && <AssignmentTree rows={list} />}
      {rows && (layout === 'table' || list.length === 0) && (
        <div className="tbl-wrap">
          <table className="pw-table pw-assign">
            <thead>
              <tr>
                <th>Job</th><th>Client · type</th><th>Department · Section</th><th>Team lead</th><th>Recruiter</th><th>Client manager</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {page.slice.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                  <td>
                    <div className="pw-name">{r.title}</div>
                    {r.reqCode && <div className="small-muted">{r.reqCode}</div>}
                  </td>
                  <td>
                    {r.client}
                    <div><StatusChip tone={r.internal ? 'blue' : 'grey'}>{r.type}</StatusChip></div>
                  </td>
                  <td>
                    {r.department || <span className="cell-muted">—</span>}
                    {r.section && <div className="small-muted">{r.section}</div>}
                  </td>
                  <td>
                    {r.tl ? <span title={r.tl.source === 'seat' ? "From the recruiter's seat (not set on the job)" : undefined}>{r.tl.name}{r.tl.source === 'seat' && <span className="small-muted"> (seat)</span>}</span>
                      : <span className="pw-missing">Missing</span>}
                  </td>
                  <td>
                    {(r.recruiters || []).length
                      ? r.recruiters.map((p) => p.name).join(', ')
                      : <span className="pw-missing">Missing</span>}
                  </td>
                  <td>
                    {!r.bdeRequired
                      ? <span className="cell-muted" title="Internal job — no client manager needed">—</span>
                      : r.bde
                        ? <span title={r.bde.source === 'client' ? "The client's client manager" : 'Named on the job'}>{r.bde.name}{r.bde.source === 'client' && <span className="small-muted"> (client owner)</span>}</span>
                        : <span className="pw-missing">Missing</span>}
                  </td>
                  <td>
                    <StatusChip tone={ASSIGN_TONE[r.assignment]}>{ASSIGN_PLAIN[r.assignment] || r.assignment}</StatusChip>
                    <div className="small-muted">{r.statusLabel}</div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan="7" style={{ padding: 0 }}>
                    <EmptyState
                      compact
                      icon="📋"
                      title={all.length ? 'No jobs match these filters.' : 'No jobs in your area yet.'}
                      action={chips.length || q ? <button type="button" className="btn btn-sm" onClick={clearAll}>Clear filters</button> : null}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {list.length > 0 && (
            <ListFooter from={page.from} to={page.to} total={list.length} noun="jobs">
              <Pager page={page} noun="jobs" />
            </ListFooter>
          )}
        </div>
      )}
      {rows && layout === 'tree' && list.length > 0 && <ListFooter from={1} to={list.length} total={list.length} noun="jobs" />}
      <div className="small-muted pw-legend">
        <b>Fully Assigned</b> = team lead, recruiter and client manager named. Internal jobs need no client manager.
      </div>
    </>
  );
}

// Department → Section → TL → Recruiter → Requirement, and Client → BDE.
function group(rows, keyOf) {
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].sort((a, b) => (a[0] === '—') - (b[0] === '—') || a[0].localeCompare(b[0]));
}
function MissingCount({ rows }) {
  const n = rows.filter((r) => r.assignment !== 'Fully Assigned').length;
  return <span className="small-muted">{`${fmt(rows.length)} job${rows.length === 1 ? '' : 's'}${n ? ` · ${fmt(n)} need people` : ''}`}</span>;
}
function AssignmentTree({ rows }) {
  const REQS_SHOWN = 12;
  return (
    <div className="pw-tree-wrap">
      <section className="pw-tree">
        <h4>By department and team</h4>
        {group(rows, (r) => r.department || 'No department').map(([d, dr]) => (
          <details key={d} open={rows.length < 60}>
            <summary><b>{d}</b> <MissingCount rows={dr} /></summary>
            {group(dr, (r) => r.section).map(([s, sr]) => (
              <details key={s} className="pw-tree-l2">
                <summary>{s} <MissingCount rows={sr} /></summary>
                {group(sr, (r) => (r.tl ? r.tl.name : 'Team lead missing')).map(([t, tr]) => (
                  <details key={t} className="pw-tree-l3">
                    <summary>{t === 'Team lead missing' ? <span className="pw-missing">Team lead missing</span> : <>Team lead {t}</>} <MissingCount rows={tr} /></summary>
                    {group(tr, (r) => ((r.recruiters || []).length ? r.recruiters.map((p) => p.name).join(', ') : 'Recruiter missing')).map(([rc, rr]) => (
                      <div key={rc} className="pw-tree-l4">
                        <div>{rc === 'Recruiter missing' ? <span className="pw-missing">Recruiter missing</span> : <>Recruiter {rc}</>} <MissingCount rows={rr} /></div>
                        <ul>
                          {rr.slice(0, REQS_SHOWN).map((r) => (
                            <li key={r.id}>
                              <Link to={`/requirements/${r.id}`}>{r.reqCode ? `${r.reqCode} · ` : ''}{r.title}</Link>
                              {' '}<StatusChip tone={ASSIGN_TONE[r.assignment]}>{r.assignment}</StatusChip>
                            </li>
                          ))}
                          {rr.length > REQS_SHOWN && <li className="small-muted">{`+${fmt(rr.length - REQS_SHOWN)} more — narrow with the filters`}</li>}
                        </ul>
                      </div>
                    ))}
                  </details>
                ))}
              </details>
            ))}
          </details>
        ))}
      </section>
      <section className="pw-tree">
        <h4>By client</h4>
        {group(rows, (r) => r.client).map(([c, cr]) => {
          const byBde = group(cr, (r) => (!r.bdeRequired ? 'Internal (no client manager)' : r.bde ? r.bde.name : 'Client manager missing'));
          return (
            <details key={c}>
              <summary><b>{c}</b> <MissingCount rows={cr} /></summary>
              <ul>
                {byBde.map(([b, br]) => (
                  <li key={b}>
                    {b === 'Client manager missing' ? <span className="pw-missing">Client manager missing</span> : b}
                    {' '}<span className="small-muted">{`${fmt(br.length)} job(s)`}</span>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>
    </div>
  );
}

// ===========================================================================
// PENDING ACTIONS
// ===========================================================================
const DUE_FILTER = [['overdue', '🔴 Late'], ['today', '🟠 Due today'], ['upcoming', '🔵 Upcoming'], ['none', 'No due date']];
const DUE_LABEL = Object.fromEntries(DUE_FILTER);
const PENDING_FIELDS = [
  { key: 'dept', get: (r) => r.department },
  { key: 'section', get: (r) => r.section },
  { key: 'tl', get: peopleTl, label: (v, r) => r.tl },
  { key: 'owner', get: (r) => (r.ownerUserId ? `id:${r.ownerUserId}` : r.owner ? `name:${r.owner}` : 'none'), label: (v, r) => (v === 'none' ? 'No named owner' : r.owner || 'Selected person') },
  { key: 'action', get: (r) => r.action },
  { key: 'due', get: (r) => r.dueStatus, label: (v) => DUE_LABEL[v] || v },
];
function pendingPred(r, k, v) {
  switch (k) {
    case 'dept': return r.department === v;
    case 'section': return r.section === v;
    case 'tl': return v.startsWith('id:') ? r.tlUserId === v.slice(3) : lc(r.tl) === lc(v.slice(5));
    case 'owner':
      if (v === 'none') return !(r.ownerUserId || r.owner);
      return v.startsWith('id:') ? r.ownerUserId === v.slice(3) : lc(r.owner) === lc(v.slice(5));
    case 'action': return r.action === v;
    case 'due': return r.dueStatus === v;
    default: return true;
  }
}

function PendingTab({ data, error, initial, selfId, selfMode }) {
  const navigate = useNavigate();
  const rows = data ? data.rows : null;
  const [q, setQ] = useState(initial.q || '');
  const [dept, setDept] = useState(initial.dept || '');
  const [section, setSection] = useState(initial.section || '');
  const [tl, setTl] = useState(initial.tl || '');
  const [owner, setOwner] = useState(initial.owner !== undefined ? initial.owner : (selfMode && selfId ? `id:${selfId}` : ''));
  const [action, setAction] = useState(initial.action || '');
  const [due, setDue] = useState(initial.due || '');
  const [sort, setSort] = useState('');
  const all = rows || [];
  const searched = useMemo(() => all.filter((r) => !q || `${r.candidate} ${r.requirement} ${r.reqCode || ''} ${r.client || ''}`.toLowerCase().includes(lc(q))), [all, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = useMemo(() => ({
    dept, section, tl, owner, action, due,
  }), [dept, section, tl, owner, action, due]);
  const facets = useLocalFacets(searched, PENDING_FIELDS, values, pendingPred);
  // "Me" (a recruiter's / BDE's default) stays choosable even with nothing of theirs pending.
  const ownerOptions = useMemo(() => {
    const out = (facets.owner || []).map((o) => (selfId && o.value === `id:${selfId}` ? { ...o, label: `${o.label} (me)` } : o));
    if (owner && owner !== 'none' && !out.some((o) => o.value === owner)) {
      out.unshift({ value: owner, label: owner.startsWith('id:') && owner.slice(3) === selfId ? 'Me' : 'Selected person', count: 0 });
    }
    return out;
  }, [facets.owner, owner, selfId]);

  const list = useMemo(() => {
    const out = applyFilters(searched, values, pendingPred);
    if (sort === 'due') {
      const t = (r) => (r.dueAt && r.dueStatus !== 'none' ? new Date(r.dueAt).getTime() : Infinity);
      return [...out].sort((a, b) => t(a) - t(b));
    }
    if (sort === 'candidate') return [...out].sort((a, b) => String(a.candidate || '').localeCompare(String(b.candidate || '')));
    return out;
  }, [searched, values, sort]);
  const page = usePaged(list);
  const dueTally = useMemo(() => {
    const t = {};
    list.forEach((r) => { t[r.dueStatus] = (t[r.dueStatus] || 0) + 1; });
    return t;
  }, [list]);

  const label = (opts, v) => (opts.find(([x]) => x === v) || [])[1] || v;
  const chips = [
    dept && { key: 'dept', label: 'Department', value: dept, onRemove: () => { setDept(''); setSection(''); } },
    section && { key: 'section', label: 'Section', value: section, onRemove: () => setSection('') },
    tl && { key: 'tl', label: 'Team lead', value: optLabel(facets.tl, tl, tl.slice(tl.indexOf(':') + 1)), onRemove: () => setTl('') },
    owner && { key: 'owner', label: 'Owner', value: owner === 'none' ? 'No named owner' : optLabel(ownerOptions, owner, owner.slice(owner.indexOf(':') + 1)), onRemove: () => setOwner('') },
    action && { key: 'action', label: 'Action', value: action, onRemove: () => setAction('') },
    due && { key: 'due', label: 'Due', value: label(DUE_FILTER, due), onRemove: () => setDue('') },
  ].filter(Boolean);
  const clearAll = () => { setQ(''); setDept(''); setSection(''); setTl(''); setOwner(''); setAction(''); setDue(''); };

  if (error) return <div className="notice red">{error}</div>;
  return (
    <>
      <ListToolbar
        search={q}
        onSearch={setQ}
        placeholder="Search name, job or client"
        filterCount={chips.length}
        sort={sort}
        sortOptions={[['', 'Default order'], ['due', 'Due soonest'], ['candidate', 'Name A–Z']]}
        onSort={setSort}
        chips={[...chips, q && { key: 'q', label: 'Search', value: q, onRemove: () => setQ('') }].filter(Boolean)}
        onClearAll={clearAll}
        panel={(
          <>
            <FacetSelect label="Department" value={dept} onChange={(v) => { setDept(v); setSection(''); }} options={facets.dept} allLabel="All departments" />
            <FacetSelect label="Section" value={section} onChange={setSection} options={facets.section} allLabel="All sections" />
            <FacetSelect label="Team lead" value={tl} onChange={setTl} options={facets.tl} allLabel="All team leads" />
            <FacetSelect label="Owner" value={owner} onChange={setOwner} options={ownerOptions} allLabel="Any owner" />
            <FacetSelect label="Next step" value={action} onChange={setAction} options={facets.action} allLabel="All next steps" />
            <FacetSelect label="Due" value={due} onChange={setDue} options={facets.due} allLabel="Any" />
          </>
        )}
      />
      {rows && list.length > 0 && (
        <div className="pw-assign-bar">
          {DUE_FILTER.filter(([k]) => dueTally[k]).map(([k, l]) => (
            <button key={k} type="button" className={`pw-tally${due === k ? ' on' : ''}`} onClick={() => setDue(due === k ? '' : k)} title={`Show only ${l}`}>
              <StatusChip tone={DUE_META[k][2]}>{`${l} ${fmt(dueTally[k])}`}</StatusChip>
            </button>
          ))}
        </div>
      )}
      {rows === null && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}
      {rows && (
        <div className="tbl-wrap">
          <table className="pw-table">
            <thead>
              <tr><th>Candidate</th><th>Job</th><th>Client</th><th>Step</th><th>Next step</th><th>Owner</th><th>Due</th></tr>
            </thead>
            <tbody>
              {page.slice.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/candidates/${r.candidateId}`)}>
                  <td className="pw-name">{r.candidate}</td>
                  <td>
                    {r.requirement}
                    {r.reqCode && <div className="small-muted">{r.reqCode}</div>}
                  </td>
                  <td>{r.client || <span className="cell-muted">—</span>}</td>
                  <td><StatusChip status={r.stageLabel}>{r.stageLabel}</StatusChip></td>
                  <td><span className="link-btn">{r.action} →</span>{r.waitingOn && <div className="small-muted">{`waiting for the ${r.waitingOn.toLowerCase()}`}</div>}</td>
                  <td>
                    {r.owner
                      ? <span title={r.ownerSource === 'attributed' ? 'Not named on the job — the person doing this work' : undefined}>{r.owner}</span>
                      : <span className="pw-missing" title="The job names nobody for this step">No {r.ownerRole || 'owner'} named</span>}
                    {r.owner && r.ownerRole && <div className="small-muted">{r.ownerRole}</div>}
                  </td>
                  <td><DueChip status={r.dueStatus} dueAt={r.dueAt} source={r.dueSource} /></td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan="7" style={{ padding: 0 }}>
                    <EmptyState
                      compact
                      icon="🎉"
                      title={all.length ? 'No tasks match these filters.' : 'No tasks waiting. You are all caught up.'}
                      action={chips.length || q ? <button type="button" className="btn btn-sm" onClick={clearAll}>Clear filters</button> : null}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {list.length > 0 && (
            <ListFooter from={page.from} to={page.to} total={list.length} noun="tasks">
              <Pager page={page} noun="tasks" />
            </ListFooter>
          )}
        </div>
      )}
      <div className="small-muted pw-legend">
        One row per person on a job: the next step, who does it, and by when. <b>Late</b> = the due date has passed.
      </div>
    </>
  );
}

// ===========================================================================
// THE LIST BEHIND A NUMBER (?view=list&person=&metric=)
// ===========================================================================
function MetricList({ personId, metric, onOpen }) {
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    setD(null);
    setError('');
    api.get(`/ats/team/${encodeURIComponent(personId)}`, { params: { metric } })
      .then((r) => setD(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not open this list. Please try again.'));
  }, [personId, metric]);
  const rows = useMemo(() => (d ? d.rows.filter((r) => !q || JSON.stringify([r.candidate, r.requirement, r.title, r.name, r.client, r.reqCode]).toLowerCase().includes(lc(q))) : []), [d, q]);
  const page = usePaged(rows);
  if (error) return <div className="notice red">{error}</div>;
  if (!d) return <div className="small-muted" style={{ padding: 16 }}>Loading…</div>;
  const kind = d.kind;
  return (
    <>
      <div className="pw-list-head">
        <div>
          <h2>
            <button type="button" className="pw-person" onClick={() => onOpen(d.person.id)}>{d.person.name}</button>
            {` · ${d.label} `}
            <span className="pw-count">{fmt(d.total)}</span>
          </h2>
          {d.hint && <div className="small-muted">{d.hint}</div>}
        </div>
        <input placeholder="Search this list" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this list" />
      </div>
      <div className="tbl-wrap">
        <table className="pw-table">
          <thead>
            {kind === 'requirements' && <tr><th>Job</th><th>Client</th><th>Type</th><th>Department · Section</th><th>Team lead</th><th>Recruiter</th><th>Status</th></tr>}
            {(kind === 'applications' || kind === 'joined') && <tr><th>Candidate</th><th>Job</th><th>Client</th><th>Step</th><th>Next step</th><th>Updated</th></tr>}
            {kind === 'clients' && <tr><th>Client</th><th className="num">Open jobs</th><th className="num">All jobs</th><th>Status</th></tr>}
            {kind === 'people' && <tr><th>Recruiter</th><th>Section</th><th className="num">Open jobs</th><th className="num">People in process</th><th className="num">Needs action</th></tr>}
            {kind === 'actions' && <tr><th>Candidate</th><th>Job</th><th>Client</th><th>Step</th><th>Next step</th><th>Owner</th><th>Due</th></tr>}
          </thead>
          <tbody>
            {kind === 'requirements' && page.slice.map((r) => (
              <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                <td><div className="pw-name">{r.title}</div>{r.reqCode && <div className="small-muted">{r.reqCode}</div>}</td>
                <td>{r.client}</td>
                <td>{r.type}</td>
                <td>{[r.department, r.section].filter(Boolean).join(' · ') || '—'}</td>
                <td>{r.tl || '—'}</td>
                <td>{r.recruiter || '—'}</td>
                <td><StatusChip status={r.live ? 'Open' : 'Closed'}>{r.statusLabel}</StatusChip></td>
              </tr>
            ))}
            {(kind === 'applications' || kind === 'joined') && page.slice.map((r) => (
              <tr key={r.id} className="row-link" onClick={() => navigate(`/candidates/${r.candidateId}`)}>
                <td className="pw-name">{r.candidate}</td>
                <td>{r.requirement}{r.reqCode && <div className="small-muted">{r.reqCode}</div>}</td>
                <td>{r.client || '—'}</td>
                <td><StatusChip status={r.stageLabel}>{r.stageLabel}</StatusChip></td>
                <td>{r.nextAction ? <>{r.nextAction}{r.owner && <div className="small-muted">{r.owner}</div>}</> : <span className="cell-muted">—</span>}</td>
                <td>{day(r.updatedAt)}</td>
              </tr>
            ))}
            {kind === 'clients' && page.slice.map((r) => (
              <tr key={r.id} className={r.link ? 'row-link' : ''} onClick={r.link ? () => navigate(`/clients/${r.id}`) : undefined}>
                <td className="pw-name">{r.name}</td>
                <td className="num">{fmt(r.openRequirements)}</td>
                <td className="num">{fmt(r.requirements)}</td>
                <td>{r.status || '—'}</td>
              </tr>
            ))}
            {kind === 'people' && page.slice.map((r) => (
              <tr key={r.id} className="pw-click" onClick={() => onOpen(r.id)}>
                <td><button type="button" className="pw-person" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>{r.name}</button>{r.seatLabel && <div className="small-muted">{r.seatLabel}</div>}</td>
                <td>{r.section || '—'}</td>
                <td className="num"><NumLink to={metricLink(r.id, 'openRequirements')} value={r.counts.openRequirements} /></td>
                <td className="num"><NumLink to={metricLink(r.id, 'activeCandidates')} value={r.counts.activeCandidates} /></td>
                <td className="num"><NumLink to={metricLink(r.id, 'needsAction')} value={r.counts.needsAction} /></td>
              </tr>
            ))}
            {kind === 'actions' && page.slice.map((r) => (
              <tr key={r.id} className="row-link" onClick={() => navigate(`/candidates/${r.candidateId}`)}>
                <td className="pw-name">{r.candidate}</td>
                <td>{r.requirement}{r.reqCode && <div className="small-muted">{r.reqCode}</div>}</td>
                <td>{r.client || '—'}</td>
                <td><StatusChip status={r.stageLabel}>{r.stageLabel}</StatusChip></td>
                <td>{r.action}</td>
                <td>{r.owner || '—'}{r.ownerRole && <div className="small-muted">{r.ownerRole}</div>}</td>
                <td><DueChip status={r.dueStatus} dueAt={r.dueAt} source={r.dueSource} /></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan="7" style={{ padding: 0 }}><EmptyState compact icon="🗂️" title={q ? 'Nothing in this list matches the search.' : 'This list is empty.'} /></td></tr>
            )}
          </tbody>
        </table>
        {rows.length > 0 && <Pager page={page} noun="rows" />}
      </div>
    </>
  );
}

// ===========================================================================
// THE PAGE
// ===========================================================================
export default function Team() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const atsRole = (user && ((user.scopeRoles && user.scopeRoles.ats) || productRole(user, 'ats') || user.atsRole || user.role)) || '';
  const isAdmin = !!user && (ADMIN_ROLES.includes(user.role) || ADMIN_ROLES.includes(user.atsRole));
  const selfMode = !isAdmin && SELF_ROLES.includes(atsRole);
  const isLead = !selfMode;

  const legacy = LEGACY_TABS[searchParams.get('tab') || ''] || null;
  const rawView = searchParams.get('view') || (legacy && legacy.view) || 'people';
  // §13 (2026-10-03): 'whohas' = Who has pending work (leads), 'org' = Departments & teams (Admin).
  // 'followups' (2026-10-03): the Follow-ups screen is a tab here, not a module.
  const view = ['people', 'assignments', 'pending', 'list', 'whohas', 'org', 'followups'].includes(rawView) ? rawView : 'people';
  const leadView = isAdmin || ['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(atsRole);
  useEffect(() => {
    if (rawView === 'seats' && isAdmin) navigate('/admin/positions?tab=history', { replace: true });
  }, [rawView, isAdmin, navigate]);
  const setView = (v) => setSearchParams(v === 'people' ? {} : { view: v });

  // 360 drawer — closes whenever the address changes (a number was followed).
  const [openPerson, setOpenPerson] = useState(null);
  useEffect(() => { setOpenPerson(null); }, [location.search]);

  const [reloadKey, setReloadKey] = useState(0);
  const [people, setPeople] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => {
    setPeople((p) => ({ ...p, loading: true, error: '' }));
    api.get('/ats/team', { params: { shape: 'v2' } })
      .then((res) => setPeople({ rows: res.data.rows || [], loading: false, error: '' }))
      .catch((e) => setPeople({ rows: [], loading: false, error: e.response?.data?.error || 'Could not load this page. Please try again.' }));
  }, [reloadKey]);
  const [assignments, setAssignments] = useState({ rows: null, error: '' });
  const [pending, setPending] = useState({ data: null, error: '' });
  useEffect(() => {
    // Loaded up front (not only on the tab) so the Assignments tab shows its count.
    if (assignments.rows === null && !assignments.error) {
      api.get('/ats/team', { params: { view: 'assignments' } })
        .then((res) => setAssignments({ rows: res.data.rows || [], error: '' }))
        .catch((e) => setAssignments({ rows: null, error: e.response?.data?.error || 'Could not load the jobs list. Please try again.' }));
    }
  }, [view, assignments, reloadKey]);
  useEffect(() => {
    if (pending.data === null && !pending.error) {
      api.get('/ats/team', { params: { view: 'pending' } })
        .then((res) => setPending({ data: res.data, error: '' }))
        .catch((e) => setPending({ data: null, error: e.response?.data?.error || 'Could not load the tasks. Please try again.' }));
    }
  }, [pending, reloadKey]);
  const reload = () => { setAssignments({ rows: null, error: '' }); setPending({ data: null, error: '' }); setReloadKey((k) => k + 1); };
  // A recruiter's assigned clients: the clients of the open jobs given to them.
  const clientsOf = useMemo(() => {
    const m = new Map();
    (assignments.rows || []).forEach((r) => {
      if (!r.live || !r.client || r.client === '—') return;
      (r.recruiters || []).forEach((x) => { if (!m.has(x.id)) m.set(x.id, new Set()); m.get(x.id).add(r.client); });
    });
    return m;
  }, [assignments.rows]);

  // FORMER PEOPLE (user, 2026-10-05) — everyone who has left, from HRMS, under
  // the departments they worked in (GET /ats/team?view=former). Leads only:
  // the server gives a Recruiter / BDE nobody. Loaded after the main list, so
  // "Former" is ready by the time it is clicked.
  const [former, setFormer] = useState({ rows: null, allowed: isLead, loading: false });
  const [openFormer, setOpenFormer] = useState(null);
  useEffect(() => { setOpenFormer(null); }, [location.search]);
  useEffect(() => {
    if (!isLead || people.loading) return undefined;
    let alive = true;
    setFormer((f) => ({ ...f, loading: true }));
    api.get('/ats/team', { params: { view: 'former' } })
      .then((res) => { if (alive) setFormer({ rows: res.data.rows || [], allowed: !!res.data.allowed, loading: false }); })
      .catch(() => { if (alive) setFormer({ rows: [], allowed: false, loading: false }); });
    return () => { alive = false; };
  }, [isLead, people.loading, reloadKey]);
  // Current + former in one list; a login that has left is listed once, as
  // the former person (with their history).
  const peopleRows = useMemo(() => {
    if (!former.rows || !former.rows.length) return people.rows;
    const leftIds = new Set(former.rows.map((r) => r.userId).filter(Boolean));
    return [...people.rows.filter((r) => !(r.status === 'Left' && leftIds.has(r.id))), ...former.rows];
  }, [people.rows, former.rows]);
  const [shown, setShown] = useState({ ids: null, status: 'Active' });
  const onShown = useCallback((ids, status) => setShown({ ids, status }), []);

  if (isClientUser(user)) {
    return (
      <div className="empty">
        <h3>Not available for your role</h3>
        <div>This page is only for the TeamLink team.</div>
      </div>
    );
  }

  const sp = (k) => searchParams.get(k) || undefined;
  const pendingInitial = { q: sp('q'), dept: sp('dept'), section: sp('section'), tl: sp('tl'), owner: searchParams.has('owner') ? searchParams.get('owner') : undefined, action: sp('action'), due: sp('due') };
  const assignInitial = {
    q: sp('q'), dept: sp('dept'), tl: sp('tl'), recruiter: sp('recruiter'), bde: sp('bde'), client: sp('client'), type: sp('type'),
    status: searchParams.has('status') ? searchParams.get('status') : undefined, assign: sp('assign'),
  };
  // A recruiter / BDE: the actions that are theirs (the tab opens on them).
  const pendingCount = pending.data
    ? (selfMode ? pending.data.rows.filter((r) => r.ownerUserId === (user && user.id)).length : pending.data.rows.length)
    : null;
  const VIEWS = [
    ['people', selfMode ? 'My Workload' : 'People & Workload', people.loading ? null : people.rows.length, 'Recruiters, client managers and team leads in your area'],
    ['assignments', selfMode ? 'My Assignments' : 'Assignments', assignments.rows ? assignments.rows.filter((r) => r.live).length : null, 'Open jobs and who works on them'],
    ['pending', selfMode ? 'My tasks' : 'Tasks', pendingCount, selfMode ? 'Next steps that are yours' : 'Every next step and who does it'],
    ...(leadView ? [['whohas', 'Who has work waiting', null, 'Waiting, late and follow-ups late, per person']] : []),
    ['followups', selfMode ? 'My follow-ups' : 'Follow-ups', null, 'Who to contact, why, and by when'],
    ...(isAdmin ? [['org', 'Departments & teams', null, 'Give a TL departments, move a recruiter — with history']] : []),
  ];
  const exportTab = view === 'people' ? 'recruiters' : view === 'assignments' ? 'assignments' : null;
  const exportIds = view === 'assignments' && assignments.rows ? assignments.rows.map((r) => r.id) : view === 'people' ? (shown.ids || people.rows.map((r) => r.id)) : null;

  return (
    <div className="pw-page">
      <ListPageHeader
        title={selfMode ? 'My Workload' : 'Team'}
        question={selfMode ? 'Your jobs, your numbers and your tasks — all in one place.' : 'Who is on the team, what each person works on, and how busy they are.'}
        data={isLead && exportTab ? (
          <AtsDataTools
            module="team"
            kinds={['requirement-assignments']}
            onImported={reload}
            body={() => ({ tab: exportTab, former: view === 'people' && shown.status !== 'Active' && !!former.rows, ids: exportIds })}
          />
        ) : null}
      />

      <StatusTabs
        label="Section"
        tabs={VIEWS.map(([key, label, count, hint]) => ({ key, label, count, hint }))}
        value={view === 'list' ? 'people' : view}
        onChange={setView}
        hideZero={!isAdmin}
        // No "Seat History →" link here (2026-10-03): it is already in the menu
        // (Administration → Positions & Seat History).
      />

      {people.error && (
        <div className="notice red" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{people.error}</span>
          <button className="btn btn-sm" type="button" onClick={reload}>Retry</button>
        </div>
      )}

      {view === 'list' && (
        <>
          <button type="button" className="btn btn-sm btn-ghost pw-back" onClick={() => (window.history.length > 1 ? navigate(-1) : setView('people'))}>← Back</button>
          <MetricList key={location.search} personId={searchParams.get('person') || ''} metric={searchParams.get('metric') || ''} onOpen={setOpenPerson} />
        </>
      )}
      {view === 'people' && (
        <PeopleTab
          rows={peopleRows}
          loading={people.loading}
          isLead={isLead}
          initialRole={(legacy && legacy.role) || searchParams.get('role') || ''}
          onOpen={setOpenPerson}
          onOpenFormer={setOpenFormer}
          formerAllowed={former.allowed}
          formerLoading={former.loading || (isLead && !former.rows)}
          clientsOf={clientsOf}
          onShown={onShown}
        />
      )}
      {view === 'assignments' && <AssignmentsTab key={location.search} rows={assignments.rows} error={assignments.error} initial={assignInitial} />}
      {view === 'whohas' && leadView && <PendingWork />}
      {view === 'followups' && <FollowUps embedded />}
      {view === 'org' && isAdmin && <DeptTeamsAdmin />}
      {view === 'pending' && (
        <PendingTab
          key={location.search}
          data={pending.data}
          error={pending.error}
          initial={pendingInitial}
          selfId={user && user.id}
          selfMode={selfMode}
        />
      )}
      {openPerson && <Recruiter360 personId={openPerson} onClose={() => setOpenPerson(null)} />}
      {openFormer && <FormerHistory personId={openFormer} onClose={() => setOpenFormer(null)} />}
    </div>
  );
}
