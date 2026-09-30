import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import sharedGet from '../../utils/sharedGet';
import { useAuth } from '../../context/AuthContext.jsx';
import { workRoleLabel } from '../../permissions';
import DateRangePicker, { useDateRange, rangeParams, DEFAULT_RANGE } from '../../components/DateRangePicker.jsx';
import HierarchyFilter, { EMPTY_HIERARCHY, toParams, hierarchyChips, useHierarchy } from '../../components/HierarchyFilter.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import AtsDataTools from '../../components/AtsDataTools.jsx';
import RoleBoard from '../../components/dashboard/RoleBoard.jsx';
import './AtsDashboard.css';

// ---------------------------------------------------------------------------
// The ATS home — user review #3 §3 / §15 / §22 / §23 / §24 (on top of rounds
// 1 and 2). "Dashboard = what do I need to do now"; what HAPPENED lives in
// Reports (§12), so there are no analytics charts on this page any more.
//
// ONE route, a different page per effective ATS role. The server decides the
// layout from the session (GET /api/dashboard/ats -> `layout`, resolved by
// utils/scope.js scopeOf(), so a custom role gets its system role's page):
//
//   recruiter / bde   "My Work — Good Morning, Kiran": 5 tiles (Open
//                     Requirements · Active Candidates · Interviews Today ·
//                     Pending Actions · Follow-ups Due), then straight into
//                     🔴 Needs Action. Nothing else.
//   team (TL)         "My Team": team tiles, Needs Action with an Owner
//                     column, and a per-recruiter pending / overdue table.
//   manager           STL / Manager / Asst Manager: team + department
//                     overview (department cards), Needs Action, summary.
//   company           Super Admin / Admin: the same, company-wide, plus the
//                     people summary; analytics are one click away in Reports.
//
// ?due= and ?queue= stay in the URL so the 🔔 bell's "🔴 N Overdue" lands on
// exactly that list. Read fresh on every visit and filter change.
// ---------------------------------------------------------------------------

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const LEAD_LAYOUTS = ['team', 'manager', 'company'];
const DUE = [
  { id: 'overdue', icon: '🔴', label: 'Overdue', tone: 'red' },
  { id: 'today', icon: '🟠', label: 'Due Today', tone: 'amber' },
  { id: 'upcoming', icon: '🔵', label: 'Upcoming', tone: 'blue' },
  // No real due date yet (imported with its stage) — never counted Overdue.
  { id: 'none', icon: '⚪', label: 'No due date', tone: 'blue' },
];
const TITLES = {
  recruiter: 'My Work',
  bde: 'My Work',
  team: 'My Team',
  manager: 'Team & Department Overview',
  company: 'Company Overview',
  client: 'My Company',
};
const SCOPE_OPTION = { team: 'My Team', manager: 'My Departments', company: 'Company' };

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  const first = String(name || '').replace(/\(.*\)/, '').trim().split(/\s+/)[0];
  return `Good ${part}${first ? `, ${first}` : ''}`;
}

function timeOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function Due({ row }) {
  if (!row.due) return <span className="cell-muted">—</span>;
  if (row.bucket === 'overdue' || row.overdue) return <StatusChip tone="red" title={`Was due ${row.due}`}>Overdue</StatusChip>;
  if (row.bucket === 'today') return <StatusChip tone="amber">Due Today</StatusChip>;
  return <span className="cell-muted">{row.due}</span>;
}

// ---- TILES -----------------------------------------------------------------
// `to: '#pending'` is the Needs Action table below (its length IS the number);
// a tile with `due` also narrows that table (e.g. Overdue Actions).
function Tile({ t, onPending }) {
  const inPage = t.to === '#pending';
  const value = inPage
    ? <button type="button" className="atsd-tile-a" onClick={() => onPending(t.due || '')}>{fmt(t.value)}</button>
    : <Link className="atsd-tile-a" to={t.to}>{fmt(t.value)}</Link>;
  return (
    <div className={`atsd-tile${t.tone === 'red' && t.value ? ' is-red' : ''}`}>
      <div className="atsd-tile-l">{t.label}</div>
      <div className="atsd-tile-n">
        {value}
        {t.valueLabel && <span className="atsd-tile-u">{t.valueLabel}</span>}
      </div>
      {t.total !== null && t.total !== undefined && (
        <div className="atsd-tile-of">· of <Link to={t.totalTo || t.to}>{fmt(t.total)}</Link> {t.totalLabel}</div>
      )}
      {t.sub && <div className={`atsd-tile-of${t.tone === 'red' ? ' atsd-red' : ''}`}>{t.sub}</div>}
      {(t.rows || []).map((r) => (
        <Link key={r.id} to={`/candidates/${r.candidateId}`} className="atsd-tile-row"><b>{timeOf(r.at)}</b> {r.candidate}</Link>
      ))}
    </div>
  );
}

// The client login's older tiles (GET /dashboard/ats `work`).
function WorkTile({ w }) {
  return (
    <div className="atsd-tile" title={w.meaning}>
      <div className="atsd-tile-l">{w.label}</div>
      <div className="atsd-tile-n">
        <Link className="atsd-tile-a" to={w.to}>{fmt(w.value)}</Link>
        <span className="atsd-tile-u">{w.valueLabel}</span>
      </div>
      {w.total !== null && w.total !== undefined && (
        <div className="atsd-tile-of">· {w.id === 'joining' ? '' : 'of '}<Link to={w.totalTo || w.to}>{fmt(w.total)}</Link> {w.totalLabel}</div>
      )}
    </div>
  );
}

// ---- 🔴 NEEDS ACTION ------------------------------------------------------------
function NeedsAction({ data, layout, due, queue, setDue, setQueue, clearNarrow, take, setTake }) {
  const rows = data.queue || [];
  const showOwner = layout !== 'recruiter' && layout !== 'bde' && layout !== 'client';
  // §23 — only the queues that hold something; Super Admin keeps them all.
  const full = layout === 'company';
  const queues = (data.pendingActions || []).filter((p) => full || p.count > 0);
  const dc = data.dueCounts || { overdue: 0, today: 0, upcoming: 0 };
  const q = (data.pendingActions || []).find((p) => p.id === queue);
  const d = DUE.find((x) => x.id === due);
  const narrowed = !!(q || d);
  const listed = data.listedTotal ?? rows.length;
  return (
    <div className="panel atsd-needs" id="pending">
      <div className="panel-head atsd-needs-head">
        <h3>
          <span aria-hidden="true">🔴</span> Needs Action
          {narrowed ? <span className="atsd-needs-narrow"> — {[d && d.label, q && q.label].filter(Boolean).join(' · ')}</span> : ''}
        </h3>
        <span className="small-muted">
          {rows.length < listed ? `Most urgent ${fmt(rows.length)} of ${fmt(listed)}` : `${fmt(listed)} item${listed === 1 ? '' : 's'}`}
          {narrowed && <> · <button type="button" className="link-btn" onClick={clearNarrow}>Show all {fmt(data.pendingTotal)}</button></>}
          {rows.length < listed && take < 100 && <> · <button type="button" className="link-btn" onClick={() => setTake(take === 25 ? 50 : 100)}>Show {take === 25 ? 50 : 100}</button></>}
        </span>
      </div>
      {data.pendingTotal > 0 && (
        <div className="atsd-narrow" role="group" aria-label="Narrow the list">
          {DUE.filter((x) => full || dc[x.id] > 0).map((x) => (
            <button
              key={x.id}
              type="button"
              className={`atsd-pill tone-${dc[x.id] ? x.tone : 'zero'}${due === x.id ? ' is-on' : ''}`}
              aria-pressed={due === x.id}
              onClick={() => setDue(due === x.id ? '' : x.id)}
            >
              <span aria-hidden="true">{x.icon}</span> <b>{fmt(dc[x.id])}</b> {x.label}
            </button>
          ))}
          {queues.length > 1 && <span className="atsd-narrow-sep" aria-hidden="true" />}
          {queues.length > 1 && queues.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`atsd-pill atsd-pill-q${queue === p.id ? ' is-on' : ''}`}
              aria-pressed={queue === p.id}
              onClick={() => setQueue(queue === p.id ? '' : p.id)}
              title={`${p.label}: ${fmt(p.count)} waiting`}
            >
              {p.label} <b>{fmt(p.count)}</b>
            </button>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        narrowed
          ? <EmptyState compact icon="🔍" title="Nothing matches this filter." hint="Clear the filter to see everything that is waiting." action={<button type="button" className="btn btn-sm" onClick={clearNarrow}>Show all</button>} />
          : <EmptyState icon="🎉" title="No pending actions" hint="You're all caught up." />
      ) : (
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="atsd-table">
            <thead>
              <tr>
                <th>Candidate</th><th>Requirement</th><th>Current Stage</th><th>Action →</th><th>Due</th>
                {showOwner && <th>Owner</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link className="atsd-name" to={`/candidates/${r.candidateId}`}>{r.candidate}</Link></td>
                  <td>
                    {r.requirementId ? <Link className="atsd-sub-link" to={`/requirements/${r.requirementId}`}>{r.requirement}</Link> : r.requirement}
                    {r.client && <div className="small-muted">{r.client}</div>}
                  </td>
                  {/* "Interview Completed" is WAITING for feedback here, not done. */}
                  <td><StatusChip status={r.stageLabel} tone={r.stage === 'INTERVIEW_COMPLETED' ? 'amber' : undefined} /></td>
                  <td>
                    {r.nextAction && r.nextAction !== 'No Action'
                      ? <Link className="btn btn-sm btn-primary atsd-act" to={`/candidates/${r.candidateId}`}>{r.nextAction} →</Link>
                      : <span className="cell-muted">No action</span>}
                  </td>
                  <td><Due row={r} /></td>
                  {showOwner && <td className="small-muted">{r.owner && r.owner !== '—' ? r.owner : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- TL: PER-RECRUITER ---------------------------------------------------------
function RecruiterLoad({ rows }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>My Recruiters</h3>
        <Link className="link-btn small-muted" to="/ats/team">Recruiter &amp; BDE →</Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState compact icon="✅" title="No recruiter has anything waiting." hint="New items appear here as candidates reach your team's queues." />
      ) : (
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="atsd-table">
            <thead><tr><th>Recruiter</th><th>Pending</th><th>Overdue</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td><Link className="atsd-name" to={r.to || '/ats/team'}>{r.name}</Link></td>
                  <td>{r.pending ? <StatusChip tone="amber">{fmt(r.pending)}</StatusChip> : <span className="cell-muted">0</span>}</td>
                  <td>{r.overdue ? <StatusChip tone="red">{fmt(r.overdue)}</StatusChip> : <span className="cell-muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- MANAGER / STL / SA: DEPARTMENT CARDS ---------------------------------------
function DeptCards({ cards, onPick, period }) {
  if (!cards.length) {
    return <EmptyState compact icon="🏢" title="No department activity in this scope." hint="Try a wider date range or clear the hierarchy filter." />;
  }
  const n = (c, key, label, tone) => {
    const to = c.links && c.links[key];
    const v = fmt(c[key]);
    const cls = `atsd-dc-n${tone && c[key] ? ` atsd-${tone}` : ''}`;
    return (
      <div className="atsd-dc-f">
        {to ? <Link className={cls} to={to}>{v}</Link> : <span className={cls}>{v}</span>}
        <span className="atsd-dc-l">{label}</span>
      </div>
    );
  };
  return (
    <div className="atsd-dcs">
      {cards.map((c) => (
        <div key={c.department || '—'} className="atsd-dc">
          <div className="atsd-dc-h">
            {c.department
              ? <button type="button" className="link-btn atsd-dc-t" onClick={() => onPick(c.department)} title="Narrow the dashboard to this department">{c.department}</button>
              : <span className="atsd-dc-t">No department</span>}
          </div>
          <div className="atsd-dc-g">
            {n(c, 'openRequirements', 'Open req')}
            {n(c, 'activeCandidates', 'Active candidates')}
            {n(c, 'pending', 'Pending', 'amber')}
            {n(c, 'overdue', 'Overdue', 'red')}
            {n(c, 'selected', 'Selected')}
            {n(c, 'joined', `Joined · ${period ? period.name : ''}`)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- TEAM / COMPANY SUMMARY (people) -----------------------------------------
function TeamSummary({ ta, period }) {
  const empty = ta.counts.length === 0 && ta.people.length === 0;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{ta.title || 'Team Summary'}</h3>
        {period && <span className="small-muted">{period.name}{period.name !== period.label ? ` · ${period.label}` : ''}</span>}
      </div>
      {empty && <EmptyState compact title="No activity for this date range." hint="Try changing the date range or view today's activity." />}
      {ta.counts.length > 0 && (
        <div className="atsd-parts atsd-parts-in">
          {ta.counts.map((c) => (c.to
            ? <Link key={c.label} to={c.to} className="atsd-chip tone-blue">{c.label} <b>{fmt(c.value)}</b></Link>
            : <span key={c.label} className="atsd-chip tone-blue">{c.label} <b>{fmt(c.value)}</b></span>))}
        </div>
      )}
      {ta.people.length > 0 && (
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="atsd-table">
            <thead>
              <tr>
                <th>Person</th><th>Role</th>
                <th title="Applications on their requirements waiting for the next step (now)">Pending</th>
                <th title="Applications on their requirements past the stage SLA (now)">Overdue</th>
                <th title="Follow-ups they own that are overdue (now)">Follow-ups Overdue</th>
                <th title="Stage moves they made in the selected date range">Stage Moves</th>
              </tr>
            </thead>
            <tbody>
              {ta.people.map((p) => (
                <tr key={p.userId}>
                  <td>{p.name}</td>
                  <td className="small-muted">{workRoleLabel({ atsRole: p.role, role: p.role }, 'ats')}</td>
                  <td>{p.pending ? <StatusChip tone="amber">{fmt(p.pending)}</StatusChip> : <span className="cell-muted">0</span>}</td>
                  <td>{p.overdue ? <StatusChip tone="red">{fmt(p.overdue)}</StatusChip> : <span className="cell-muted">0</span>}</td>
                  <td>{p.followUpsOverdue ? <StatusChip tone="red">{fmt(p.followUpsOverdue)}</StatusChip> : <span className="cell-muted">0</span>}</td>
                  <td>{fmt(p.moves)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ta.peopleTotal > ta.people.length && (
            <div className="small-muted" style={{ padding: '8px 18px' }}>
              Showing the {fmt(ta.people.length)} busiest of {fmt(ta.peopleTotal)} people · <Link className="link-btn" to="/ats/team">Recruiter &amp; BDE →</Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// §12 — the analytics that used to sit here now live in Reports.
function ReportsLink() {
  return (
    <div className="atsd-rep small-muted">
      Hiring funnel, applications by department and source analytics are in Reports:
      {' '}<Link to="/reports/ats?tab=funnel">Recruitment Funnel</Link>
      {' · '}<Link to="/reports/ats?tab=departments">Department</Link>
      {' · '}<Link to="/reports/ats?tab=sources">Source</Link>
      {' · '}<Link to="/reports/ats?tab=recruiters">Recruiter Performance</Link>
      {' '}<Link className="atsd-rep-go" to="/reports/ats">See in Reports →</Link>
    </div>
  );
}

// ---- ROLE BOARDS (user dashboard spec 2026-09-29) --------------------------
// GET /dashboard/ats/role decides which boards this login has (`views`) and
// builds the chosen one: Recruiter (HR: internal wording), TL (STL at
// department scope), BDE, Management (read-only; Manager / Asst Manager, and
// Super Admin can switch to it) and Admin (Super Admin / Admin). 'overview'
// is the company page below (department cards, Needs Action, summary). The
// tab is in the URL (?tab=) so a board can be linked to.
const VIEW_LABEL = { overview: 'Operations', management: 'Management', admin: 'Admin', recruiter: 'My Work', tl: 'My Team', bde: 'My Clients' };
const OPERATIONAL = ['recruiter', 'tl', 'bde'];
const INACTIVE_KEY = 'tl_dash_inactive_days';
const MGMT_RANGE_KEY = 'tl_dash_range_mgmt';

function readStore(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStore(k, v) { try { localStorage.setItem(k, v); } catch { /* no storage */ } }

function ManagementFilters({ board, range, setRange, mf, setMf }) {
  const o = board.filterOptions || { clients: [], departments: [], sources: [] };
  const set = (k, v) => setMf({ ...mf, [k]: v });
  const on = mf.clientId || mf.department || mf.source;
  return (
    <div className="rdb-filters" role="group" aria-label="Management filters">
      <DateRangePicker value={range} onChange={setRange} period={board.period} />
      {o.clients.length > 0 && (
        <label>Client
          <select value={mf.clientId} onChange={(e) => set('clientId', e.target.value)}>
            <option value="">All clients</option>
            {o.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      <label>Team
        <select value={mf.department} onChange={(e) => set('department', e.target.value)}>
          <option value="">All departments</option>
          {o.departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      <label>Source
        <select value={mf.source} onChange={(e) => set('source', e.target.value)}>
          <option value="">All sources</option>
          {o.sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      {on && <button type="button" className="btn btn-sm" onClick={() => setMf({ clientId: '', department: '', source: '' })}>Clear</button>}
      <span className="small-muted" style={{ marginLeft: 'auto' }}>Read-only · {board.period ? board.period.label : ''}</span>
    </div>
  );
}

export default function AtsDashboard() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || '';
  const [role, setRole] = useState(null);
  const [roleError, setRoleError] = useState('');
  const [inactiveDays, setInactiveDays] = useState(() => Number(readStore(INACTIVE_KEY)) || 3);
  const [hadMgmtRange] = useState(() => !!readStore(MGMT_RANGE_KEY));
  const [mRangeStored, setMRange] = useDateRange(MGMT_RANGE_KEY);
  const [mRangeTouched, setMRangeTouched] = useState(false);
  const mRange = hadMgmtRange || mRangeTouched ? mRangeStored : { range: 'this_month', from: '', to: '' };
  const [mf, setMf] = useState({ clientId: '', department: '', source: '' });

  const view = role ? role.view : '';
  const wantsMgmt = tab === 'management' || (!tab && view === 'management');
  const roleParams = {
    ...(tab ? { tab } : {}),
    ...(view === 'tl' ? { inactiveDays } : {}),
    ...(wantsMgmt ? { ...rangeParams(mRange), ...Object.fromEntries(Object.entries(mf).filter(([, v]) => v)) } : {}),
  };
  const roleKey = JSON.stringify(roleParams);
  useEffect(() => {
    let alive = true;
    sharedGet('/dashboard/ats/role', roleParams)
      .then((r) => { if (alive) { setRole(r.data); setRoleError(''); } })
      .catch((e) => { if (alive) setRoleError(e.response?.data?.error || 'Could not load your dashboard'); });
    return () => { alive = false; };
  }, [roleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (t) => {
    const p = new URLSearchParams(sp);
    p.set('tab', t); p.delete('list'); p.delete('due'); p.delete('queue');
    setSp(p, { replace: true });
  };

  if (roleError && !role) return <div className="notice red">{roleError}</div>;
  if (!role) return <div className="small-muted">Loading…</div>;
  const tabs = role.views && role.views.length > 1 ? (
    <div className="tabs" role="tablist" style={{ marginBottom: 10 }}>
      {role.views.map((v) => (
        <button key={v} type="button" role="tab" aria-selected={view === v} className={`tab${view === v ? ' active' : ''}`} onClick={() => setTab(v)}>
          {VIEW_LABEL[v] || v}
        </button>
      ))}
    </div>
  ) : null;

  if (view === 'overview') return <OperationsPage tabs={tabs} />;

  const head = view === 'management' ? (
    <ManagementFilters
      board={role}
      range={mRange}
      setRange={(r) => { setMRangeTouched(true); setMRange(r); }}
      mf={mf}
      setMf={setMf}
    />
  ) : view === 'tl' ? (
    <div className="rdb-filters">
      <label>Inactive after (days)
        <input
          type="number" min="1" max="60" value={inactiveDays} style={{ width: 90, minWidth: 0 }}
          onChange={(e) => { const n = Math.min(60, Math.max(1, Number(e.target.value) || 3)); setInactiveDays(n); writeStore(INACTIVE_KEY, String(n)); }}
        />
      </label>
    </div>
  ) : null;

  return (
    <div className="atsd">
      <RoleHeader board={role} />
      {tabs}
      <RoleBoard board={role} listUrl="/dashboard/ats/role/list" listParams={roleParams} head={head} />
      {OPERATIONAL.includes(view) && <OperationsPage embedded />}
    </div>
  );
}

function RoleHeader({ board }) {
  const { user } = useAuth();
  const scopeLabel = user && user.scope && (user.scope.atsLabel || user.scope.label);
  return (
    <div className="page-head">
      <div>
        <h1>{board.title}</h1>
        <div className="page-sub">
          <span className="atsd-hello">{greeting(user && user.name)}</span>
          {' · '}{workRoleLabel(user, 'ats')}
          {scopeLabel && <> · <span className="scope-tag-inline">Scope: {scopeLabel}</span></>}
          {board.readOnly && <> · <span className="small-muted">View only</span></>}
        </div>
      </div>
      <Link className="btn btn-sm" to="/ats/workflow">See workflow →</Link>
    </div>
  );
}

// The company operations page (and, `embedded`, the Needs Action list under an
// operational role board — the bell's "N Overdue" still lands on #pending).
function OperationsPage({ tabs = null, embedded = false }) {
  const { user } = useAuth();
  const { hash } = useLocation();
  const [sp, setSp] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useDateRange('tl_dash_range_ats');
  const [h, setH] = useState(EMPTY_HIERARCHY);
  const [scope, setScope] = useState('role');
  const [take, setTake] = useState(25);
  const tree = useHierarchy();

  const layout = data ? (data.layout || 'recruiter') : '';
  const isLead = LEAD_LAYOUTS.includes(layout);
  const due = ['overdue', 'today', 'upcoming', 'none'].includes(sp.get('due')) ? sp.get('due') : '';
  const queue = sp.get('queue') || '';
  const setParam = (k, v) => {
    const p = new URLSearchParams(sp);
    if (v) p.set(k, v); else p.delete(k);
    setSp(p, { replace: true });
  };

  const params = {
    ...rangeParams(range),
    ...toParams(h, tree.data),
    ...(scope === 'mine' ? { scope: 'mine' } : {}),
    ...(due ? { due } : {}),
    ...(queue ? { queue } : {}),
    ...(take !== 25 ? { take } : {}),
  };
  const key = JSON.stringify(params);

  // One read per filter set, fresh every time. `alive` drops a slow answer
  // for filters the user has already moved away from.
  useEffect(() => {
    let alive = true;
    sharedGet('/dashboard/ats', params)
      .then((res) => { if (alive) { setData(res.data); setError(''); } })
      .catch((err) => { if (alive) setError(err.response?.data?.error || 'Could not load your dashboard'); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // The bell's "🔴 N Overdue" arrives as ?due=overdue#pending — bring the
  // table into view once it is drawn.
  const scrollToPending = () => {
    const el = document.getElementById('pending');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  useEffect(() => {
    if (data && hash === '#pending') scrollToPending();
  }, [data, hash, due, queue]);

  if (error && !data) return <div className="notice red">{error}</div>;
  if (embedded) {
    return data ? (
      <NeedsAction
        data={data}
        layout={layout}
        due={due}
        queue={queue}
        setDue={(v) => setParam('due', v)}
        setQueue={(v) => setParam('queue', v)}
        clearNarrow={() => { const p = new URLSearchParams(sp); p.delete('due'); p.delete('queue'); setSp(p, { replace: true }); }}
        take={take}
        setTake={setTake}
      />
    ) : <div className="small-muted">Loading the pending list…</div>;
  }

  const ta = data && data.teamActivity;
  const rangeOn = !(range.range === DEFAULT_RANGE.range && !range.from && !range.to);
  const chips = [
    isLead && scope === 'mine' && { key: 'scope', label: 'Scope', value: 'Only mine', onRemove: () => setScope('role') },
    ...(isLead ? hierarchyChips(h, tree.data, setH) : []),
    due && { key: 'due', label: 'Due', value: (DUE.find((d) => d.id === due) || {}).label, onRemove: () => setParam('due', '') },
    queue && { key: 'queue', label: 'Action', value: ((data && data.pendingActions) || []).find((p) => p.id === queue)?.label || queue, onRemove: () => setParam('queue', '') },
  ].filter(Boolean);
  const clearNarrow = () => { const p = new URLSearchParams(sp); p.delete('due'); p.delete('queue'); setSp(p, { replace: true }); };
  const clearAll = () => {
    setH(EMPTY_HIERARCHY); setScope('role'); setRange(DEFAULT_RANGE); setTake(25);
    clearNarrow();
  };
  const onPending = (d) => {
    const p = new URLSearchParams(sp); p.delete('queue');
    if (d) p.set('due', d); else p.delete('due');
    setSp(p, { replace: true });
    setTimeout(scrollToPending, 50);
  };
  const scopeLabel = user && user.scope && user.scope.label;
  const tiles = data && data.tiles;

  return (
    <div className="atsd">
      <div className="page-head">
        <div>
          <h1>{TITLES[layout] || 'ATS Dashboard'}</h1>
          <div className="page-sub">
            <span className="atsd-hello">{greeting(user && user.name)}</span>
            {' · '}{workRoleLabel(user, 'ats')}
            {scopeLabel && <> · <span className="scope-tag-inline">Scope: {scopeLabel}</span></>}
          </div>
        </div>
        {/* Export only — for the leads; a recruiter's page is their work list. */}
        <Link className="btn btn-sm" to="/ats/workflow">See workflow →</Link>
        {isLead && <AtsDataTools module="dashboard" kinds={[]} params={params} />}
      </div>

      {tabs}

      {/* Leads only: Scope · Date Range · Department → Section → TL → Recruiter
          (HierarchyFilter hides the levels a login can't use). A recruiter's
          page has nothing to filter — it is their own work, as of now. */}
      {isLead && (
        <>
          <div className="filter-row atsd-filters">
            <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope" title="Scope" style={{ width: 'auto' }}>
              <option value="role">Scope: {SCOPE_OPTION[layout] || 'My scope'}</option>
              <option value="mine">Scope: Only mine</option>
            </select>
            <DateRangePicker value={range} onChange={setRange} period={data ? data.period : undefined} />
            <HierarchyFilter value={h} onChange={setH} />
            <button type="button" className="btn btn-sm" disabled={!chips.length && !rangeOn} onClick={clearAll}>Clear All</button>
          </div>
          <FilterChips filters={chips} onClearAll={clearAll} />
        </>
      )}

      {error && <div className="notice red">{error}</div>}
      {!data && <div className="small-muted">Loading…</div>}

      {data && (<>
        <div className={`atsd-tiles atsd-tiles-${tiles ? tiles.length : (data.work || []).length}`}>
          {tiles
            ? tiles.map((t) => <Tile key={t.id} t={t} onPending={onPending} />)
            : (data.work || []).map((w) => <WorkTile key={w.id} w={w} />)}
        </div>
        {isLead && (
          <div className="atsd-note small-muted">
            Numbers are as of now, in your scope and filters — the same totals as the Requirements and Candidates pages. The date range applies to Joined{ta && layout !== 'team' ? ` and the ${(ta.title || 'summary').toLowerCase()}` : ''}.
          </div>
        )}

        {(layout === 'manager' || layout === 'company') && data.departmentCards && (
          <>
            <div className="atsd-kicker atsd-kicker-out">Departments</div>
            <DeptCards
              cards={data.departmentCards}
              period={data.period}
              onPick={(dep) => setH({ ...EMPTY_HIERARCHY, department: dep })}
            />
          </>
        )}

        <NeedsAction
          data={data}
          layout={layout}
          due={due}
          queue={queue}
          setDue={(v) => setParam('due', v)}
          setQueue={(v) => setParam('queue', v)}
          clearNarrow={clearNarrow}
          take={take}
          setTake={setTake}
        />

        {layout === 'team' && data.recruiterLoad && <RecruiterLoad rows={data.recruiterLoad} />}
        {(layout === 'manager' || layout === 'company') && ta && <TeamSummary ta={ta} period={data.period} />}
        {(layout === 'manager' || layout === 'company') && <ReportsLink />}
      </>)}
    </div>
  );
}
