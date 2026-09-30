import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { isClientUser, productRole } from '../../permissions';
import FilterChips from '../../components/FilterChips.jsx';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { leftOn } from '../../components/PeopleFilter.jsx';
import Recruiter360, { metricLink } from './Recruiter360.jsx';
import './Team.css';

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
const ROLE_SWITCH = [['RECRUITER', 'Recruiter'], ['BDE', 'BDE'], ['TL', 'TL']];
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
const uniqSorted = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
const day = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// A number that opens the list it counts.
function NumLink({ to, value, danger, title }) {
  if (value === null || value === undefined) return <span className="cell-muted">—</span>;
  const cls = `pw-num${danger && value > 0 ? ' danger' : ''}${value === 0 ? ' zero' : ''}`;
  if (!to || value === 0) return <span className={cls} title={title}>{fmt(value)}</span>;
  return <Link className={cls} to={to} title={title} onClick={(e) => e.stopPropagation()}>{fmt(value)}</Link>;
}

// Due chip: 🔴 overdue · 🟡 due today · 🟢 upcoming · no due date.
const DUE_META = {
  overdue: ['🔴', 'Overdue', 'red'],
  today: ['🟡', 'Due today', 'amber'],
  upcoming: ['🟢', 'Upcoming', 'green'],
  none: ['', 'No due date', 'grey'],
};
function DueChip({ status, dueAt, source }) {
  const [icon, label, tone] = DUE_META[status] || DUE_META.none;
  const title = status === 'none'
    ? 'No real due date yet — the row came in with its stage already set (imported) and nobody has moved it or set a follow-up'
    : `${label}${dueAt ? ` — due ${day(dueAt)}` : ''}${source === 'follow-up' ? ' (follow-up)' : source === 'stage-sla' ? ' (stage SLA)' : ''}`;
  return (
    <span className="pw-due" title={title}>
      <StatusChip tone={tone}>{icon ? `${icon} ` : ''}{status === 'none' ? '—' : label}</StatusChip>
      {dueAt && status !== 'none' && <span className="small-muted pw-due-date">{day(dueAt)}</span>}
    </span>
  );
}

function Select({ label, value, onChange, options, all, width }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} title={label} style={{ width: width || 'auto', maxWidth: 220 }}>
      <option value="">{all || `All ${label.toLowerCase()}s`}</option>
      {options.map((o) => (Array.isArray(o)
        ? <option key={o[0]} value={o[0]}>{o[1]}</option>
        : <option key={o} value={o}>{o}</option>))}
    </select>
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
    </th>
  );
}

// ===========================================================================
// PEOPLE & WORKLOAD
// ===========================================================================
const PEOPLE_COLUMNS = {
  RECRUITER: [
    ['openRequirements', 'Open Requirements', 'Live requirements assigned to them'],
    ['activeCandidates', 'Active Candidates', 'Active ATS applications they own — not Candidate Master (Hold, Rejected, Joined and Job Portal screening left out)'],
    ['needsAction', 'Needs Action', 'Active applications whose one next action is theirs (the shared next-action rule)'],
  ],
  BDE: [
    ['clients', 'Clients', 'Clients whose Owner BDE they are (or assigned to them on Users)'],
    ['openRequirements', 'Open Requirements', 'Live requirements of their clients'],
    ['submitted', 'Submitted', 'Active applications submitted to their clients (Client Submission onward)'],
    ['feedbackPending', 'Client Feedback Pending', 'Submitted and waiting on the client decision'],
    ['interviews', 'Interviews', 'Interview Scheduled / Completed'],
    ['selected', 'Selected', 'Selected, Offer or Offer Accepted — not yet joined'],
    ['activeClients', 'Active Clients', 'Their clients with at least one live requirement'],
    ['clientActions', 'Client Actions', 'Client-side next actions owned by them'],
  ],
  TL: [
    ['recruiters', 'Recruiters', 'Recruiters whose seat reports to them'],
    ['requirements', 'Requirements', 'Live requirements they lead or their recruiters hold'],
    ['candidates', 'Candidates', 'Active applications of their team'],
    ['pendingReviews', 'Pending Reviews', 'Next actions owned by them (TL Review → Approve / Reject / Hold)'],
  ],
};

function PeopleTab({
  rows, loading, isLead, isAdmin, initialRole, onOpen, formerRows, showFormer, setShowFormer, formerBusy,
}) {
  const presentRoles = useMemo(() => ROLE_SWITCH.filter(([id]) => rows.some((r) => r.roleGroup === id)), [rows]);
  const [roleSel, setRoleSel] = useState(initialRole || '');
  const role = presentRoles.some(([id]) => id === roleSel) ? roleSel : (presentRoles[0] ? presentRoles[0][0] : 'RECRUITER');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [section, setSection] = useState('');
  const [tl, setTl] = useState('');
  const [status, setStatus] = useState('Active');
  const [client, setClient] = useState('');
  const [sort, setSort] = useState({ key: '', dir: 'desc' });
  useEffect(() => { setSection(''); setTl(''); setClient(''); setSort({ key: '', dir: 'desc' }); }, [role]);

  const inRole = useMemo(() => rows.filter((r) => r.roleGroup === role), [rows, role]);
  const deptOptions = uniqSorted(inRole.map((r) => r.department));
  const sectionOptions = uniqSorted(inRole.filter((r) => !dept || r.department === dept).map((r) => r.section));
  const tlOptions = useMemo(() => {
    const m = new Map();
    inRole.forEach((r) => { if (r.tl) m.set(r.tlUserId ? `id:${r.tlUserId}` : `name:${r.tl}`, r.tl); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [inRole]);
  const clientOptions = useMemo(() => {
    const m = new Map();
    inRole.forEach((r) => (r.clientOptions || []).forEach((c) => m.set(c.id, c.name)));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [inRole]);

  const list = useMemo(() => {
    const out = [
      ...inRole,
      ...(showFormer && formerRows ? formerRows.filter((r) => r.roleGroup === role) : []),
    ].filter((r) => {
      if (dept && r.department !== dept) return false;
      if (section && r.section !== section) return false;
      if (tl) {
        if (tl.startsWith('id:') ? r.tlUserId !== tl.slice(3) : lc(r.tl) !== lc(tl.slice(5))) return false;
      }
      if (status && !r.former && (r.status || 'Active') !== status) return false;
      if (client && !(r.clientOptions || []).some((c) => c.id === client)) return false;
      if (q && !`${r.name} ${r.employeeCode || ''} ${r.recruiterCode || ''}`.toLowerCase().includes(lc(q))) return false;
      return true;
    });
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
  }, [inRole, formerRows, showFormer, role, dept, section, tl, status, client, q, sort]);

  const cols = PEOPLE_COLUMNS[role] || [];
  const nameLabel = { RECRUITER: 'Person', BDE: 'BDE', TL: 'TL' }[role];
  const chips = [
    dept && { key: 'dept', label: 'Department', value: dept, onRemove: () => { setDept(''); setSection(''); } },
    section && { key: 'section', label: 'Section', value: section, onRemove: () => setSection('') },
    tl && { key: 'tl', label: 'TL', value: (tlOptions.find(([v]) => v === tl) || [])[1] || tl, onRemove: () => setTl('') },
    client && { key: 'client', label: 'Client', value: (clientOptions.find(([v]) => v === client) || [])[1] || 'Selected', onRemove: () => setClient('') },
    status !== 'Active' && { key: 'status', label: 'Status', value: status || 'Active + Left', onRemove: () => setStatus('Active') },
    q && { key: 'q', label: 'Search', value: q, onRemove: () => setQ('') },
  ].filter(Boolean);
  const clearAll = () => { setDept(''); setSection(''); setTl(''); setClient(''); setStatus('Active'); setQ(''); };
  const bdeEmpty = role === 'BDE' && inRole.length > 0 && inRole.every((r) => !(r.counts && r.counts.clients));
  const showCols = role === 'BDE' ? cols.slice(0, 6) : cols;
  const extraCols = role === 'BDE' ? cols.slice(6) : [];

  return (
    <>
      {isLead && (
        <>
          <div className="filter-row pw-filters">
            {presentRoles.length > 1 && (
              <span className="pw-role-switch" role="group" aria-label="Role">
                {presentRoles.map(([id, label]) => (
                  <button key={id} type="button" className={role === id ? 'active' : ''} onClick={() => setRoleSel(id)} aria-pressed={role === id}>{label}</button>
                ))}
              </span>
            )}
            <input placeholder={`Search ${nameLabel.toLowerCase()} name or code`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            {deptOptions.length > 1 && <Select label="Department" value={dept} onChange={(v) => { setDept(v); setSection(''); }} options={deptOptions} />}
            {role !== 'BDE' && sectionOptions.length > 1 && <Select label="Section" value={section} onChange={setSection} options={sectionOptions} />}
            {role === 'RECRUITER' && tlOptions.length > 1 && <Select label="TL" value={tl} onChange={setTl} options={tlOptions} all="All TLs" />}
            {role === 'BDE' && clientOptions.length > 0 && <Select label="Client" value={client} onChange={setClient} options={clientOptions} />}
            {role !== 'TL' && (
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" title="Status" style={{ width: 'auto' }}>
                <option value="Active">Active</option>
                <option value="Left">Left</option>
                <option value="">Active + Left</option>
              </select>
            )}
            {isAdmin && role === 'RECRUITER' && (
              <label className="pw-former-toggle" title="Also list the people who used to hold these Recruiter Codes, with who replaced them">
                <input type="checkbox" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} />
                {' '}Show former holders{formerBusy ? ' …' : ''}
              </label>
            )}
            <button className="btn btn-sm" type="button" onClick={clearAll} disabled={!chips.length}>Clear All</button>
            <span className="small-muted pw-shown">{`${list.length} ${nameLabel === 'Person' ? 'recruiter' : nameLabel}${list.length === 1 ? '' : 's'}`}</span>
          </div>
          <FilterChips filters={chips} onClearAll={clearAll} />
        </>
      )}
      {bdeEmpty && (
        <div className="notice pw-notice">
          <b>No BDE owns a client yet.</b> Today no client has an Owner BDE and no requirement names a BDE, so every BDE shows 0.
          The BDE numbers count a BDE&apos;s <i>clients</i>: set the Owner BDE on <Link to="/clients">Clients</Link> (Admin), assign clients to the BDE on
          Administration → Users, or name the BDE on a requirement — the numbers fill in from there.
        </div>
      )}
      {loading
        ? <div className="small-muted" style={{ padding: 16 }}>Loading…</div>
        : (
          <>
            <div className="pw-tablebar">
              <span className="small-muted">Click a name for their 360 — every number opens the exact list it counts.</span>
            </div>
            <div className="tbl-wrap">
              <table className="pw-table">
                <thead>
                  <tr>
                    <SortTh id="name" label={nameLabel} sort={sort} setSort={setSort} />
                    {role === 'RECRUITER' && <><th>Dept</th><th>Section</th><th>TL</th></>}
                    {role === 'TL' && <><th>Dept</th><th>Section</th></>}
                    {showCols.map(([id, label, title]) => <SortTh key={id} id={id} label={label} title={title} sort={sort} setSort={setSort} num />)}
                    {extraCols.map(([id, label, title]) => <SortTh key={id} id={id} label={label} title={title} sort={sort} setSort={setSort} num />)}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const c = r.counts || {};
                    const open = !r.former ? () => onOpen(r.id) : null;
                    return (
                      <tr key={r.id} className={r.former ? 'pw-former' : 'pw-click'} onClick={open || undefined}>
                        <td>
                          {open
                            ? <button type="button" className="pw-person" onClick={(e) => { e.stopPropagation(); open(); }} title={`Open ${r.roleLabel} 360`}>{r.name}</button>
                            : <div className="pw-name">{r.name}</div>}
                          {r.role === 'STL' && <span className="small-muted"> · STL</span>}
                          {(r.seatLabel || r.recruiterCode) && <div className="small-muted">{r.seatLabel || r.recruiterCode}</div>}
                          {r.status === 'Left' && !r.former && <span className="status rejected pw-left">Left</span>}
                          {r.former && (
                            <div className="small-muted">
                              {[r.leftOn ? `Left ${leftOn(r.leftOn)}` : 'Left', r.replacedBy && `replaced by ${r.replacedBy}`].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        {role === 'RECRUITER' && (
                          <>
                            <td>{r.department || <span className="cell-muted">—</span>}</td>
                            <td>{r.section || <span className="cell-muted">—</span>}</td>
                            <td>{r.tl || <span className="cell-muted">—</span>}</td>
                          </>
                        )}
                        {role === 'TL' && (
                          <>
                            <td>{r.department || <span className="cell-muted">—</span>}</td>
                            <td>{r.section || <span className="cell-muted">—</span>}</td>
                          </>
                        )}
                        {r.former
                          ? (
                            <td colSpan={showCols.length + extraCols.length} className="small-muted">
                              {`Historical: ${fmt(r.requirementsWorked)} requirement(s) worked · ${fmt(r.candidatesWorked)} candidate(s)${r.joined ? ` · ${fmt(r.joined)} joined` : ''}`}
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
                        <EmptyState compact icon="👥" title={chips.length ? 'Nobody matches these filters.' : `No ${nameLabel === 'Person' ? 'recruiters' : `${nameLabel}s`} in your scope.`} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="small-muted pw-legend">
              {cols.map(([id, label, title], i) => (
                <span key={id}>{i ? ' · ' : ''}<b>{label}</b> {title.charAt(0).toLowerCase() + title.slice(1)}</span>
              ))}
              .
            </div>
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

function personOpts(rows, pick) {
  const m = new Map();
  rows.forEach((r) => pick(r).forEach((p) => { if (p && p.name) m.set(p.id ? `id:${p.id}` : `name:${p.name}`, p.name); }));
  return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}
const personMatch = (value, p) => !!p && (value.startsWith('id:') ? p.id === value.slice(3) : lc(p.name) === lc(value.slice(5)));

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

  const base = useMemo(() => all.filter((r) => {
    if (status === 'live' ? !r.live : status && r.status !== status) return false;
    return true;
  }), [all, status]);
  const deptOptions = uniqSorted(base.map((r) => r.department));
  const sectionOptions = uniqSorted(base.filter((r) => !dept || r.department === dept).map((r) => r.section));
  const tlOptions = useMemo(() => personOpts(base, (r) => [r.tl]), [base]);
  const recruiterOptions = useMemo(() => personOpts(base, (r) => r.recruiters || []), [base]);
  const bdeOptions = useMemo(() => personOpts(base, (r) => [r.bde]), [base]);
  const clientOptions = useMemo(() => uniqSorted(base.map((r) => r.client)), [base]);

  const list = useMemo(() => base.filter((r) => {
    if (dept && r.department !== dept) return false;
    if (section && r.section !== section) return false;
    if (tl && !personMatch(tl, r.tl)) return false;
    if (recruiter && !(r.recruiters || []).some((p) => personMatch(recruiter, p))) return false;
    if (bde === 'none' ? !(r.bdeRequired && !r.bde) : bde && !personMatch(bde, r.bde)) return false;
    if (client && r.client !== client) return false;
    if (type && r.type !== type) return false;
    if (assign && r.assignment !== assign) return false;
    if (q && !`${r.reqCode || ''} ${r.title} ${r.client}`.toLowerCase().includes(lc(q))) return false;
    return true;
  }), [base, dept, section, tl, recruiter, bde, client, type, assign, q]);
  const page = usePaged(list);
  const tally = useMemo(() => {
    const t = {};
    list.forEach((r) => { t[r.assignment] = (t[r.assignment] || 0) + 1; });
    return t;
  }, [list]);

  const label = (opts, v) => (opts.find(([x]) => x === v) || [])[1] || v;
  const chips = [
    dept && { key: 'dept', label: 'Department', value: dept, onRemove: () => { setDept(''); setSection(''); } },
    section && { key: 'section', label: 'Section', value: section, onRemove: () => setSection('') },
    tl && { key: 'tl', label: 'TL', value: label(tlOptions, tl), onRemove: () => setTl('') },
    recruiter && { key: 'rec', label: 'Recruiter', value: label(recruiterOptions, recruiter), onRemove: () => setRecruiter('') },
    bde && { key: 'bde', label: 'BDE', value: bde === 'none' ? 'Missing' : label(bdeOptions, bde), onRemove: () => setBde('') },
    client && { key: 'client', label: 'Client', value: client, onRemove: () => setClient('') },
    type && { key: 'type', label: 'Type', value: type, onRemove: () => setType('') },
    status !== 'live' && { key: 'status', label: 'Status', value: (REQ_STATUS.find(([v]) => v === status) || [])[1] || 'All', onRemove: () => setStatus('live') },
    assign && { key: 'assign', label: 'Assignment', value: assign, onRemove: () => setAssign('') },
    q && { key: 'q', label: 'Search', value: q, onRemove: () => setQ('') },
  ].filter(Boolean);
  const clearAll = () => { setQ(''); setDept(''); setSection(''); setTl(''); setRecruiter(''); setBde(''); setClient(''); setType(''); setStatus('live'); setAssign(''); };

  if (error) return <div className="notice red">{error}</div>;
  return (
    <>
      <div className="filter-row pw-filters">
        <input placeholder="Search requirement, REQ code or client" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {deptOptions.length > 1 && <Select label="Department" value={dept} onChange={(v) => { setDept(v); setSection(''); }} options={deptOptions} />}
        {sectionOptions.length > 1 && <Select label="Section" value={section} onChange={setSection} options={sectionOptions} />}
        {tlOptions.length > 1 && <Select label="TL" value={tl} onChange={setTl} options={tlOptions} all="All TLs" />}
        {recruiterOptions.length > 1 && <Select label="Recruiter" value={recruiter} onChange={setRecruiter} options={recruiterOptions} />}
        <Select label="BDE" value={bde} onChange={setBde} options={[['none', 'BDE missing (client reqs)'], ...bdeOptions]} />
        {clientOptions.length > 1 && <Select label="Client" value={client} onChange={setClient} options={clientOptions} />}
        <Select label="Type" value={type} onChange={setType} options={[['Client', 'Client'], ['Internal', 'Internal']]} all="Client + Internal" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" title="Requirement status" style={{ width: 'auto' }}>
          {REQ_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          <option value="">All statuses</option>
        </select>
        <Select label="Assignment" value={assign} onChange={setAssign} options={ASSIGNMENT_STATUSES} all="Any assignment" />
        <button className="btn btn-sm" type="button" onClick={clearAll} disabled={!chips.length}>Clear All</button>
        <span className="small-muted pw-shown">{rows ? `${fmt(list.length)} of ${fmt(all.length)} requirement(s)` : ''}</span>
      </div>
      <FilterChips filters={chips} onClearAll={clearAll} />
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
                <th>Requirement</th><th>Client</th><th>Type</th><th>Dept</th><th>Section</th><th>TL</th><th>Recruiter</th><th>BDE</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {page.slice.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/requirements/${r.id}`)}>
                  <td>
                    <div className="pw-name">{r.title}</div>
                    {r.reqCode && <div className="small-muted">{r.reqCode}</div>}
                  </td>
                  <td>{r.client}</td>
                  <td><StatusChip tone={r.internal ? 'blue' : 'grey'}>{r.type}</StatusChip></td>
                  <td>{r.department || <span className="cell-muted">—</span>}</td>
                  <td>{r.section || <span className="cell-muted">—</span>}</td>
                  <td>
                    {r.tl ? <span title={r.tl.source === 'seat' ? "From the recruiter's seat (not set on the requirement)" : undefined}>{r.tl.name}{r.tl.source === 'seat' && <span className="small-muted"> (seat)</span>}</span>
                      : <span className="pw-missing">Missing</span>}
                  </td>
                  <td>
                    {(r.recruiters || []).length
                      ? r.recruiters.map((p) => p.name).join(', ')
                      : <span className="pw-missing">Missing</span>}
                  </td>
                  <td>
                    {!r.bdeRequired
                      ? <span className="cell-muted" title="Internal requirement — no BDE needed">—</span>
                      : r.bde
                        ? <span title={r.bde.source === 'client' ? "The client's Owner BDE" : 'Named on the requirement'}>{r.bde.name}{r.bde.source === 'client' && <span className="small-muted"> (client owner)</span>}</span>
                        : <span className="pw-missing">Missing</span>}
                  </td>
                  <td>
                    <StatusChip tone={ASSIGN_TONE[r.assignment]}>{r.assignment}</StatusChip>
                    <div className="small-muted">{r.statusLabel}</div>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan="9" style={{ padding: 0 }}>
                    <EmptyState
                      compact
                      icon="📋"
                      title={all.length ? 'No requirements match these filters.' : 'No requirements in your scope.'}
                      action={chips.length ? <button type="button" className="btn btn-sm" onClick={clearAll}>Clear filters</button> : null}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {list.length > 0 && <Pager page={page} noun="requirements" />}
        </div>
      )}
      <div className="small-muted pw-legend">
        <b>Fully Assigned</b> TL, recruiter and (client requirements) BDE named · <b>Recruiter / TL / BDE Missing</b> exactly one is missing ·{' '}
        <b>Needs Assignment</b> two or more missing. Internal requirements need no BDE — they show <b>BDE: —</b> and never count it as missing.
        A TL marked (seat) comes from the recruiter&apos;s seat; a BDE marked (client owner) is the client&apos;s Owner BDE.
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
  return <span className="small-muted">{`${fmt(rows.length)} req${n ? ` · ${fmt(n)} need assignment` : ''}`}</span>;
}
function AssignmentTree({ rows }) {
  const REQS_SHOWN = 12;
  return (
    <div className="pw-tree-wrap">
      <section className="pw-tree">
        <h4>Department → Section → TL → Recruiter → Requirement</h4>
        {group(rows, (r) => r.department || 'No department').map(([d, dr]) => (
          <details key={d} open={rows.length < 60}>
            <summary><b>{d}</b> <MissingCount rows={dr} /></summary>
            {group(dr, (r) => r.section).map(([s, sr]) => (
              <details key={s} className="pw-tree-l2">
                <summary>{s} <MissingCount rows={sr} /></summary>
                {group(sr, (r) => (r.tl ? r.tl.name : 'TL missing')).map(([t, tr]) => (
                  <details key={t} className="pw-tree-l3">
                    <summary>{t === 'TL missing' ? <span className="pw-missing">TL missing</span> : <>TL {t}</>} <MissingCount rows={tr} /></summary>
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
        <h4>Client → BDE</h4>
        {group(rows, (r) => r.client).map(([c, cr]) => {
          const byBde = group(cr, (r) => (!r.bdeRequired ? 'BDE: — (internal)' : r.bde ? r.bde.name : 'BDE missing'));
          return (
            <details key={c}>
              <summary><b>{c}</b> <MissingCount rows={cr} /></summary>
              <ul>
                {byBde.map(([b, br]) => (
                  <li key={b}>
                    {b === 'BDE missing' ? <span className="pw-missing">BDE missing</span> : b}
                    {' '}<span className="small-muted">{`${fmt(br.length)} requirement(s)`}</span>
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
const DUE_FILTER = [['overdue', '🔴 Overdue'], ['today', '🟡 Due today'], ['upcoming', '🟢 Upcoming'], ['none', 'No due date']];

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
  const all = rows || [];
  const deptOptions = uniqSorted(all.map((r) => r.department));
  const sectionOptions = uniqSorted(all.filter((r) => !dept || r.department === dept).map((r) => r.section));
  const tlOptions = useMemo(() => {
    const m = new Map();
    all.forEach((r) => { if (r.tl) m.set(r.tlUserId ? `id:${r.tlUserId}` : `name:${r.tl}`, r.tl); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const ownerOptions = useMemo(() => {
    const m = new Map();
    all.forEach((r) => { if (r.owner) m.set(r.ownerUserId ? `id:${r.ownerUserId}` : `name:${r.owner}`, r.owner); });
    const out = [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (owner && owner !== 'none' && !m.has(owner)) out.unshift([owner, owner.startsWith('id:') && owner.slice(3) === selfId ? 'Me' : 'Selected person']);
    return out;
  }, [all, owner, selfId]);
  const actionOptions = uniqSorted(all.map((r) => r.action));

  const list = useMemo(() => all.filter((r) => {
    if (dept && r.department !== dept) return false;
    if (section && r.section !== section) return false;
    if (tl && (tl.startsWith('id:') ? r.tlUserId !== tl.slice(3) : lc(r.tl) !== lc(tl.slice(5)))) return false;
    if (owner === 'none' ? (r.ownerUserId || r.owner) : owner && (owner.startsWith('id:') ? r.ownerUserId !== owner.slice(3) : lc(r.owner) !== lc(owner.slice(5)))) return false;
    if (action && r.action !== action) return false;
    if (due && r.dueStatus !== due) return false;
    if (q && !`${r.candidate} ${r.requirement} ${r.reqCode || ''} ${r.client || ''}`.toLowerCase().includes(lc(q))) return false;
    return true;
  }), [all, dept, section, tl, owner, action, due, q]);
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
    tl && { key: 'tl', label: 'TL', value: label(tlOptions, tl), onRemove: () => setTl('') },
    owner && { key: 'owner', label: 'Owner', value: owner === 'none' ? 'No named owner' : label(ownerOptions, owner), onRemove: () => setOwner('') },
    action && { key: 'action', label: 'Action', value: action, onRemove: () => setAction('') },
    due && { key: 'due', label: 'Due', value: label(DUE_FILTER, due), onRemove: () => setDue('') },
    q && { key: 'q', label: 'Search', value: q, onRemove: () => setQ('') },
  ].filter(Boolean);
  const clearAll = () => { setQ(''); setDept(''); setSection(''); setTl(''); setOwner(''); setAction(''); setDue(''); };

  if (error) return <div className="notice red">{error}</div>;
  return (
    <>
      <div className="filter-row pw-filters">
        <input placeholder="Search candidate, requirement or client" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {deptOptions.length > 1 && <Select label="Department" value={dept} onChange={(v) => { setDept(v); setSection(''); }} options={deptOptions} />}
        {sectionOptions.length > 1 && <Select label="Section" value={section} onChange={setSection} options={sectionOptions} />}
        {tlOptions.length > 1 && <Select label="TL" value={tl} onChange={setTl} options={tlOptions} all="All TLs" />}
        <Select label="Owner" value={owner} onChange={setOwner} options={[['none', 'No named owner'], ...ownerOptions]} all="Any owner" />
        <Select label="Action Type" value={action} onChange={setAction} options={actionOptions} all="All actions" />
        <Select label="Due Status" value={due} onChange={setDue} options={DUE_FILTER} all="Any due status" />
        <button className="btn btn-sm" type="button" onClick={clearAll} disabled={!chips.length}>Clear All</button>
        <span className="small-muted pw-shown">{rows ? `${fmt(list.length)} of ${fmt(all.length)} action(s)` : ''}</span>
      </div>
      <FilterChips filters={chips} onClearAll={clearAll} />
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
              <tr><th>Candidate</th><th>Requirement</th><th>Client</th><th>Current Stage</th><th>Next Action</th><th>Owner</th><th>Due</th></tr>
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
                  <td><span className="link-btn">{r.action} →</span>{r.waitingOn && <div className="small-muted">{`waiting on the ${r.waitingOn.toLowerCase()}`}</div>}</td>
                  <td>
                    {r.owner
                      ? <span title={r.ownerSource === 'attributed' ? 'Not named on the requirement — the person this work is attributed to' : undefined}>{r.owner}</span>
                      : <span className="pw-missing" title="The requirement names nobody for this step">No {r.ownerRole || 'owner'} named</span>}
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
                      title={all.length ? 'Nothing pending matches these filters.' : 'Nothing is pending in your scope.'}
                      action={chips.length ? <button type="button" className="btn btn-sm" onClick={clearAll}>Clear filters</button> : null}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {list.length > 0 && <Pager page={page} noun="pending actions" />}
        </div>
      )}
      <div className="small-muted pw-legend">
        One row per active ATS application: its current stage, its ONE next action, the owner and the due date (an open follow-up&apos;s date, else
        the day it entered the stage + the stage SLA). <b>Overdue</b> only when that date has passed and the action is still pending. Rows imported with
        their stage already set have no real due date until somebody moves them or sets a follow-up — they show <b>—</b>, never Overdue.
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
      .catch((e) => setError(e.response?.data?.error || 'This list could not be opened.'));
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
            {kind === 'requirements' && <tr><th>Requirement</th><th>Client</th><th>Type</th><th>Dept · Section</th><th>TL</th><th>Recruiter</th><th>Status</th></tr>}
            {(kind === 'applications' || kind === 'joined') && <tr><th>Candidate</th><th>Requirement</th><th>Client</th><th>Stage</th><th>Next Action</th><th>Updated</th></tr>}
            {kind === 'clients' && <tr><th>Client</th><th className="num">Open Requirements</th><th className="num">Requirements</th><th>Status</th></tr>}
            {kind === 'people' && <tr><th>Recruiter</th><th>Section</th><th className="num">Open Requirements</th><th className="num">Active Candidates</th><th className="num">Needs Action</th></tr>}
            {kind === 'actions' && <tr><th>Candidate</th><th>Requirement</th><th>Client</th><th>Current Stage</th><th>Next Action</th><th>Owner</th><th>Due</th></tr>}
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
  const view = ['people', 'assignments', 'pending', 'list'].includes(rawView) ? rawView : 'people';
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
      .catch((e) => setPeople({ rows: [], loading: false, error: e.response?.data?.error || 'Could not load Recruiter & BDE — the server did not answer.' }));
  }, [reloadKey]);
  const [assignments, setAssignments] = useState({ rows: null, error: '' });
  const [pending, setPending] = useState({ data: null, error: '' });
  useEffect(() => {
    if (view === 'assignments' && assignments.rows === null && !assignments.error) {
      api.get('/ats/team', { params: { view: 'assignments' } })
        .then((res) => setAssignments({ rows: res.data.rows || [], error: '' }))
        .catch((e) => setAssignments({ rows: null, error: e.response?.data?.error || 'Could not load the assignments.' }));
    }
  }, [view, assignments, reloadKey]);
  useEffect(() => {
    if (pending.data === null && !pending.error) {
      api.get('/ats/team', { params: { view: 'pending' } })
        .then((res) => setPending({ data: res.data, error: '' }))
        .catch((e) => setPending({ data: null, error: e.response?.data?.error || 'Could not load the pending actions.' }));
    }
  }, [pending, reloadKey]);
  const reload = () => { setAssignments({ rows: null, error: '' }); setPending({ data: null, error: '' }); setReloadKey((k) => k + 1); };

  // Former seat holders — Super Admin / Admin only (the server refuses others).
  const [showFormer, setShowFormer] = useState(false);
  const [formerRows, setFormerRows] = useState(null);
  const [formerBusy, setFormerBusy] = useState(false);
  useEffect(() => {
    if (!showFormer || formerRows || !isAdmin) return;
    setFormerBusy(true);
    api.get('/ats/team', { params: { former: 1 } })
      .then((res) => setFormerRows(res.data.filter((r) => r.former)))
      .catch(() => setShowFormer(false))
      .finally(() => setFormerBusy(false));
  }, [showFormer, formerRows, isAdmin]);

  if (isClientUser(user)) {
    return (
      <div className="empty">
        <h3>Not available for your role</h3>
        <div>Recruiter &amp; BDE is internal TeamLink information and isn&apos;t part of your client scope.</div>
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
    ['people', selfMode ? 'My Workload' : 'People & Workload'],
    ['assignments', selfMode ? 'My Assignments' : 'Assignments'],
    ['pending', selfMode ? 'My Pending Actions' : 'Pending Actions'],
  ];
  const exportTab = view === 'people' ? 'recruiters' : view === 'assignments' ? 'assignments' : null;
  const exportIds = view === 'assignments' && assignments.rows ? assignments.rows.map((r) => r.id) : view === 'people' ? people.rows.map((r) => r.id) : null;

  return (
    <div className="pw-page">
      <div className="page-head">
        <div>
          <h1>{selfMode ? 'My Workload' : 'Recruiter & BDE'}</h1>
          <div className="page-sub">
            {selfMode
              ? 'Your requirements, the applications you own and what is waiting on you — click a number to open the list behind it.'
              : 'Who is responsible, what is assigned to whom, and who must act now — click a name for their 360, a number for its list.'}
          </div>
        </div>
        {isLead && exportTab && (
          <AtsDataTools
            module="team"
            kinds={['requirement-assignments']}
            onImported={reload}
            body={() => ({ tab: exportTab, former: view === 'people' && showFormer, ids: exportIds })}
          />
        )}
      </div>

      <div className="pw-views" role="tablist" aria-label="Section">
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id || (view === 'list' && id === 'people')} className={`pw-view${view === id || (view === 'list' && id === 'people') ? ' active' : ''}`} onClick={() => setView(id)}>
            {label}
            {id === 'pending' && pendingCount !== null ? <span className="pw-count">{fmt(pendingCount)}</span> : null}
          </button>
        ))}
        {isAdmin && (
          <Link className="pw-seat-link" to="/admin/positions?tab=history" title="Who held each Recruiter Code when — Administration → Positions & Seat History">
            Seat History →
          </Link>
        )}
      </div>

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
          rows={people.rows}
          loading={people.loading}
          isLead={isLead}
          isAdmin={isAdmin}
          initialRole={(legacy && legacy.role) || searchParams.get('role') || ''}
          onOpen={setOpenPerson}
          formerRows={formerRows}
          showFormer={showFormer}
          setShowFormer={setShowFormer}
          formerBusy={formerBusy}
        />
      )}
      {view === 'assignments' && <AssignmentsTab key={location.search} rows={assignments.rows} error={assignments.error} initial={assignInitial} />}
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
    </div>
  );
}
