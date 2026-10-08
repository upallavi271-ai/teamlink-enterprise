import { Fragment, useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import sharedGet from '../../utils/sharedGet';
import api from '../../api';
import CandidateDrawer from '../CandidateDrawer.jsx';
import { TodayStrip, TeamLeads, OpenJobs } from './HomeSections.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import useAtsAlerts from '../../utils/useAtsAlerts';
import StatusChip from '../ui/StatusChip.jsx';
import { fmt, rupees } from './RoleBoard.jsx';
import HomeDrill from './HomeDrill.jsx';
import FirstTour from './FirstTour.jsx';
import { taskLine } from './TaskPopup.jsx';
import { FunnelChart } from '../charts';
import PageFilterBar, { usePageFilters, filterParams } from '../ui/PageFilterBar.jsx';
import { V3_WIDGETS, Cards } from './AtsHomeV3.jsx';
import AtsV4 from './ats-v4/AtsV4.jsx';
import { Icon } from '../atskit/AtsKit.jsx';
import './atsHome.css';

// ---------------------------------------------------------------------------
// THE ATS HOME — one page per role, drawn from ONE widget registry (the
// user's dashboard review #2). GET /api/dashboard/ats/home returns the role's
// widget list (backend/src/utils/atsHome.js — max 5 widgets after the
// numbers); WIDGETS below draws each type. ONE date filter (Today / This
// week / This month). Every number opens its own list right here
// (HomeDrill), with its own search, filters and Export.
// ---------------------------------------------------------------------------
const LIST_URL = '/dashboard/ats/home/list';

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const first = String(name || '').replace(/\(.*\)/, '').trim().split(/\s+/)[0];
  return `Good ${part}${first ? `, ${first}` : ''}`;
}
const shortDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};
const timeOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

// A number: a button that opens its list here. A zero says what it means.
function Num({ value, drill, onDrill, money, zero, className = 'ah-num' }) {
  if (!value) return <span className={`${className} ah-none`}>{zero || 'None'}</span>;
  const v = money ? rupees(value) : fmt(value);
  if (drill) return <button type="button" className={className} onClick={() => onDrill(drill)} title="Open the list">{v}</button>;
  return <span className={className}>{v}</span>;
}
function Delta({ d }) {
  if (!d) return null;
  return <span className={`ah-delta d-${d.dir}`}>{d.text}</span>;
}
function DueChip({ r }) {
  if (r.kind === 'call') return <StatusChip tone="amber">Call today</StatusChip>;
  if (r.note) return <StatusChip tone={r.tone === 'red' ? 'red' : 'amber'}>{r.note}</StatusChip>;
  if (r.dueKey === 'overdue') return <StatusChip tone="red" title={`Was due ${r.due}`}>Late</StatusChip>;
  if (r.dueKey === 'due_today') return <StatusChip tone="amber">Due today</StatusChip>;
  if (r.due) return <StatusChip tone="blue">Due {shortDate(r.due)}</StatusChip>;
  return null;
}
function Box({ title, right, children, className = '' }) {
  return (
    <div className={`panel ah-panel ${className}`}>
      {title && <div className="panel-head"><h3>{title}</h3>{right}</div>}
      {children}
    </div>
  );
}
const SeeAll = ({ w, onDrill }) => (w.total > (w.rows || []).length && w.drill
  ? <button type="button" className="link-btn" onClick={() => onDrill(w.drill)}>See all {fmt(w.total)} →</button>
  : null);

// ---- the widgets ------------------------------------------------------------------------
function Kpis({ w, onDrill }) {
  return (
    <div className="ah-top">
      {w.tiles.map((t) => (
        <div key={t.id} className={`ah-tile${t.tone === 'red' ? ' t-red' : ''}`}>
          <div className="ah-tile-l">{t.label}</div>
          <Num value={t.value} drill={t.drill} onDrill={onDrill} zero={t.zero} className="ah-tile-n" />
          {t.value > 0 && t.sub && <div className="ah-tile-s">{t.sub}</div>}
          <Delta d={t.delta} />
        </div>
      ))}
    </div>
  );
}

function Lines({ w, onDrill }) {
  return (
    <Box title={w.title}>
      {!w.lines.length ? <div className="ah-empty">{w.empty}</div> : (
        <ul className="ah-lines">
          {w.lines.map((l) => (
            <li key={l.id} className={`ah-line t-${l.tone || 'blue'}`}>
              <button type="button" className="ah-line-n ah-line-nb" onClick={() => onDrill(l.drill)} title="Open the list">{fmt(l.count)}</button>
              <span className="ah-line-t">{l.label}{l.sub && <span className="ah-line-s">{l.sub}</span>}</span>
              {l.to
                ? <Link className="btn btn-sm" to={l.to}>{l.button || 'Open'} →</Link>
                : <button type="button" className="btn btn-sm" onClick={() => onDrill(l.drill)}>{l.button || 'Open'} →</button>}
            </li>
          ))}
        </ul>
      )}
      {w.more > 0 && <div className="small-muted ah-pad">+ {fmt(w.more)} smaller {w.more === 1 ? 'item' : 'items'}</div>}
    </Box>
  );
}

function Money({ w, onDrill }) {
  return (
    <Box title={w.title}>
      <div className="ah-kv">
        {w.rows.map((r) => (
          <div key={r.id} className={`ah-kv-r${r.tone === 'red' ? ' t-red' : ''}`}>
            <span className="ah-kv-l">{r.label}</span>
            <Num value={r.value} drill={r.drill} onDrill={onDrill} money zero={r.zero} className="ah-kv-n ah-cell" />
            {(r.sub || r.delta) && <span className="ah-kv-s">{r.value > 0 && r.sub ? `${r.sub} ` : ''}<Delta d={r.delta} /></span>}
          </div>
        ))}
      </div>
    </Box>
  );
}

// The team leads' / HR progress (the shared kit's FunnelChart — ATS layout v3).
function Funnel({ w, onDrill }) {
  const steps = w.rows.map((r) => ({ label: r.label, value: r.value, onClick: r.value ? () => onDrill(r.drill) : undefined }));
  return (
    <Box title={w.title} right={<span className="small-muted">People added {w.period}</span>}>
      <FunnelChart steps={steps} empty={w.zero} title={w.title} />
    </Box>
  );
}

function LineChart({ w, onDrill }) {
  const pts = w.points;
  const max = Math.max(1, ...pts.map((p) => p.value));
  const W = 320; const H = 110; const pad = 18;
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, pts.length - 1);
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const total = pts.reduce((n, p) => n + p.value, 0);
  return (
    <Box title={w.title}>
      {!total ? <div className="ah-empty">No joinings in the last 6 months</div> : (
        <svg className="ah-linechart" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label={`${w.title}: ${pts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
          <polyline points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" stroke="var(--brand, #1f5fbf)" strokeWidth="2.5" />
          {pts.map((p, i) => (
            <g key={p.label} className="ah-line-pt" onClick={() => p.value && onDrill(p.drill)} style={{ cursor: p.value ? 'pointer' : 'default' }}>
              <circle cx={x(i)} cy={y(p.value)} r="5" fill="var(--paper-raised, #fff)" stroke="var(--brand, #1f5fbf)" strokeWidth="2" />
              <text x={x(i)} y={y(p.value) - 9} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--ink, #222)">{p.value || ''}</text>
              <text x={x(i)} y={H + 10} textAnchor="middle" fontSize="10.5" fill="var(--ink-soft, #667)">{p.label}</text>
            </g>
          ))}
        </svg>
      )}
    </Box>
  );
}

const DEPT_COLS = [['openJobs', 'Open jobs', 'Jobs open now'], ['active', 'In process', 'People on a job now'], ['interviews', 'Interviews', 'Interviews in the dates you picked'], ['selected', 'Selected', 'Selected or offered, not joined yet'], ['joined', 'Joined', 'Joined in the dates you picked'], ['late', 'Late', 'Work past its due date']];
function Departments({ w, onDrill, onPickDept, tls }) {
  // Team leads per department = the rows of the Team leads section below.
  const tlCount = (d) => { const g = tls && tls.data && (tls.data.groups || []).find((x) => x.department === (d || 'No department')); return g ? g.rows.length : 0; };
  return (
    <Box title={w.title} right={<span className="small-muted">Click a department to see only it</span>}>
      {w.rows.length === 0 ? <div className="ah-empty">No department in your area yet.</div> : (
        <div className="tbl-wrap ah-flat">
          <table className="ah-tbl ah-click">
            <thead><tr><th>Department</th>{DEPT_COLS.map(([k, l, h]) => <th key={k} className="num" title={h}>{l}</th>)}<th className="num" title="Team leads in this department">Team leads</th></tr></thead>
            <tbody>{w.rows.map((r) => (
              <tr key={r.department || 'none'} className={r.picked ? 'is-picked' : ''} onClick={() => r.active && onDrill(r.drills.active)}>
                <td>{r.fixNeeded ? <StatusChip tone="red">No department</StatusChip> : <button type="button" className="ah-name ah-dept-pick" title={`Show only ${r.department}`} onClick={(e) => { e.stopPropagation(); onPickDept(r.department); }}>{r.department} →</button>}</td>
                {DEPT_COLS.map(([k]) => (
                  <td key={k} className="num">
                    {r[k]
                      ? <button type="button" className={`ah-cell${k === 'late' ? ' ah-red' : ''}`} onClick={(e) => { e.stopPropagation(); onDrill(r.drills[k]); }}>{fmt(r[k])}</button>
                      : <span className="cell-muted">–</span>}
                  </td>
                ))}
                <td className="num">{tlCount(r.department) ? <button type="button" className="ah-cell" title={`Show ${r.department || 'this department'} and its team leads`} onClick={(e) => { e.stopPropagation(); if (r.department) onPickDept(r.department); }}>{fmt(tlCount(r.department))}</button> : <span className="cell-muted">–</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Box>
  );
}

function People({ w, onDrill }) {
  const cell = (r, k, tone) => {
    if (!r[k]) return <span className="cell-muted">–</span>;
    const n = <button type="button" className={`ah-cell${tone === 'red' ? ' ah-red' : ''}`} onClick={() => onDrill(r.drills[k])}>{fmt(r[k])}</button>;
    return n;
  };
  return (
    <Box title={w.title} right={w.total > w.rows.length && w.to ? <Link className="link-btn" to={w.to}>{w.toLabel}</Link> : null}>
      {w.rows.length === 0 ? <div className="ah-empty">Nobody has work waiting. All caught up 🎉</div> : (
        <div className="tbl-wrap ah-flat">
          <table className="ah-tbl">
            <thead><tr><th>{w.who || 'Person'}</th><th className="num">Waiting</th><th className="num">Due today</th><th className="num">Late</th></tr></thead>
            <tbody>{w.rows.map((r) => (
              <tr key={r.key}>
                <td className="ah-ellip"><span className="ah-avatar" aria-hidden="true">{String(r.name || '?').trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase()}</span>{r.name}</td>
                <td className="num">{cell(r, 'pending')}</td>
                <td className="num">{cell(r, 'dueToday')}</td>
                <td className="num">{cell(r, 'overdue', 'red')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Box>
  );
}

// A short list (top 5): person · job · when / step.
function List({ w, onDrill }) {
  return (
    <Box title={w.title} right={<SeeAll w={w} onDrill={onDrill} />}>
      {!w.rows.length ? <div className="ah-empty">{w.zero}</div> : (
        <ul className="ah-list">
          {w.rows.map((r) => (
            <li key={r.id}>
              {r.at && <span className="ah-list-t">{timeOf(r.at)}<br /><span className="small-muted">{shortDate(r.at)}</span></span>}
              <span className="ah-list-m"><b>{r.candidate}</b><span className="small-muted">{[r.requirement, r.client].filter(Boolean).join(' · ')}</span></span>
              <DueChip r={r} />
              <Link className="btn btn-sm" to={`/candidates/${r.candidateId}`}>Open</Link>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

// The recruiter's to-do checklist.
function Tasks({ w, onDrill }) {
  return (
    <Box title={w.title} right={w.more > 0 ? <button type="button" className="link-btn" onClick={() => onDrill(w.drill)}>All my tasks ({fmt(w.more)}) →</button> : null}>
      {!w.rows.length ? <div className="ah-empty">{w.empty}</div> : (
        <ul className="ah-todo">
          {w.rows.map((r, i) => (
            <li key={`${r.kind}-${r.id}-${i}`} className={r.dueKey === 'overdue' ? 'is-late' : ''}>
              <span className="ah-todo-box" aria-hidden="true">{i + 1}</span>
              <span className="ah-list-m">
                <b>{r.action || 'Next step'}</b>
                <span className="small-muted">{r.candidate} · {r.requirement}{r.client ? ` · ${r.client}` : ''}</span>
              </span>
              <DueChip r={r} />
              <Link className={`btn btn-sm${i === 0 ? ' btn-primary' : ''}`} to={`/candidates/${r.candidateId}`}>Do it →</Link>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function Review({ w, onDrill }) {
  return <List w={{ ...w, zero: w.empty, rows: w.rows }} onDrill={onDrill} />;
}

function Jobs({ w, onDrill }) {
  const tone = { Urgent: 'red', High: 'amber', Medium: 'blue', Low: 'blue' };
  return (
    <Box title={w.title} right={<SeeAll w={w} onDrill={onDrill} />}>
      {!w.rows.length ? <div className="ah-empty">{w.zero}</div> : (
        <ul className="ah-list">
          {w.rows.map((r) => (
            <li key={r.id}>
              <span className="ah-list-m"><b>{r.title}</b><span className="small-muted">{r.client || ''}</span></span>
              <StatusChip tone={tone[r.priority] || 'blue'}>{r.priority}</StatusChip>
              <span className="ah-list-n">{r.inProcess ? <button type="button" className="ah-cell" onClick={() => onDrill(r.drill)}>{fmt(r.inProcess)} in process</button> : <span className="small-muted">Nobody yet</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function Target({ w, onDrill }) {
  const pct = w.target ? Math.min(100, Math.round((w.value / w.target) * 100)) : null;
  return (
    <Box title={w.title}>
      <div className="ah-target">
        <Num value={w.value} drill={w.drill} onDrill={onDrill} zero={w.zero} className="ah-target-n" />
        {w.target ? <span className="small-muted"> of {fmt(w.target)} target</span> : <span className="small-muted"> · {w.noTarget}</span>}
        {pct != null && <div className="ah-progress"><span style={{ width: `${pct}%` }} className={pct >= 100 ? 'done' : ''} /></div>}
      </div>
    </Box>
  );
}

function Clients({ w, onDrill }) {
  return (
    <Box title={w.title} right={<SeeAll w={w} onDrill={onDrill} />}>
      {!w.rows.length ? <div className="ah-empty">{w.zero}</div> : (
        <ul className="ah-list">
          {w.rows.map((r) => (
            <li key={r.id}>
              <span className="ah-list-m"><b>{r.name}</b>{r.sub && <span className="small-muted">{r.sub}</span>}</span>
              {r.count ? <button type="button" className="ah-cell" onClick={() => onDrill(r.drill)}>{fmt(r.count)} open</button> : null}
              {r.to && <Link className="btn btn-sm" to={r.to}>Open</Link>}
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function Cleanup({ w, onDrill }) {
  return (
    <Box title={w.title}>
      <div className="ah-kv">
        <div className="ah-kv-r"><span className="ah-kv-l">Not moving ({w.days}+ days)</span><span className="ah-kv-n">{w.stale ? fmt(w.stale) : 'None'}</span></div>
        <div className="ah-kv-r"><span className="ah-kv-l">Old jobs, no recruiter</span><span className="ah-kv-n">{w.oldUnassigned ? fmt(w.oldUnassigned) : 'None'}</span></div>
        {w.health && (
          <div className={`ah-kv-r${w.health.problems ? ' t-red' : ''}`}>
            <span className="ah-kv-l">System problems</span>
            <Num value={w.health.problems} drill={w.health.drill} onDrill={onDrill} zero="All working" className="ah-kv-n ah-cell" />
          </div>
        )}
      </div>
      {w.to && <div className="ah-pad"><Link className="btn btn-sm" to={w.to}>Open Data cleanup →</Link></div>}
    </Box>
  );
}

function Banner({ w }) {
  return (
    <div className="ah-banner">
      <StatusChip tone="amber">Activity not logged</StatusChip> {w.text} {w.to && <Link className="link-btn" to={w.to}>{w.toLabel}</Link>}
    </div>
  );
}

// THE REGISTRY — widget type → how it is drawn.
const WIDGETS = {
  kpis: Kpis, lines: Lines, money: Money, funnel: Funnel, line: LineChart, depts: Departments, people: People,
  list: List, tasks: Tasks, review: Review, jobs: Jobs, target: Target, clients: Clients, cleanup: Cleanup, banner: Banner,
  ...V3_WIDGETS,
  today: TodayStrip, tls: TeamLeads, openjobs: OpenJobs,
};

// ---- the filters (ATS layout v3: Department · Date range · Client · Recruiter / BDE) -------
// The shared PageFilterBar, fed with THIS dashboard's own cascading options
// (worked out on the server from the rows matching every other filter, with
// counts — never a zero option). Older links may still carry the extra
// filters below; they keep working and show as chips that can be removed.
const EXTRA_FILTERS = [
  ['tl', 'Team lead'],
  ['recruiter', 'Recruiter'],
  ['bde', 'Client manager (BDE)'],
  ['requirementId', 'Job'],
  ['hiring', 'Hiring type'],
  ['priority', 'Priority'],
  ['source', 'Source'],
];
// Old date words → the filter bar's.
const OLD_RANGE = { this_week: 'week', this_month: 'month' };
// Links from the old dashboards / bell (?tab= ?due= ?queue= ?list= #pending) land here.
const LEGACY = ['tab', 'due', 'queue', 'list', 'scope'];
const personValue = (prefix, key) => `${prefix}:${String(key).startsWith('u:') ? String(key).slice(2) : key}`;

export default function AtsHome() {
  const { user } = useAuth();
  const alerts = useAtsAlerts();
  const { hash } = useLocation();
  const [sp, setSp] = useSearchParams();
  const [f, setF] = usePageFilters({ range: 'month' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  const [legacy] = useState(() => !!(sp.get('due') || sp.get('queue') || hash === '#pending'));
  // Refresh (v4 header): the same read again, nothing cached in between.
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);

  const extra = Object.fromEntries(EXTRA_FILTERS.map(([k]) => [k, sp.get(k) || '']).filter(([, v]) => v));
  const fp = filterParams(f);
  if (f.range !== 'custom') { delete fp.from; delete fp.to; }
  const params = { ...extra, ...fp, range: f.range || 'all' };
  const key = JSON.stringify(params);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    sharedGet('/dashboard/ats/home', params)
      .then((r) => { if (alive) { setData(r.data); setError(''); } })
      .catch((e) => { if (alive) setError(e.response?.data?.error || 'Your dashboard could not be loaded. Check your connection and refresh the page.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [key, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Old links: ?range=this_month → month; ?tab= … dropped.
  useEffect(() => {
    const r = sp.get('range');
    if (OLD_RANGE[r] || LEGACY.some((k) => sp.has(k))) {
      const p = new URLSearchParams(sp);
      LEGACY.forEach((k) => p.delete(k));
      if (OLD_RANGE[r]) p.set('range', OLD_RANGE[r]);
      setSp(p, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!legacy || !data) return;
    const first = (data.widgets || []).find((w) => ['lines', 'tasks', 'review', 'alerts'].includes(w.type));
    const d = first && (first.type === 'lines' ? (first.lines[0] || {}).drill
      : first.type === 'alerts' ? ((first.cards || []).find((c) => c.value) || {}).drill : first.drill);
    if (d) setDrill(d);
  }, [legacy, !!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const dropExtra = (k) => { const p = new URLSearchParams(sp); p.delete(k); setSp(p, { replace: true }); };
  const opts = (data && data.filterOptions) || {};
  const labelOf = (k, v) => ((opts[k] || []).find((o) => String(o.value) === String(v)) || {}).label || v;
  const barOptions = {
    department: opts.department || [],
    clientId: opts.clientId || [],
    people: [
      ...(opts.recruiter || []).map((o) => ({ value: personValue('rec', o.value), label: o.label, count: o.count, group: 'Recruiters' })),
      ...(opts.bde || []).map((o) => ({ value: personValue('bde', o.value), label: o.label, count: o.count, group: 'Client managers (BDE)' })),
    ],
  };
  const show = {
    department: true, dateRange: true,
    client: !(data && (data.filtersHidden || []).includes('clientId')),
    people: !!(opts.recruiter || opts.bde),
  };
  const pickDept = (d) => setF({ ...f, department: f.department === d ? '' : d });
  // THE DEPARTMENT CHOOSER (user, 2026-10-05): only when the login has 2+
  // departments (or one is already picked, so it can be cleared).
  const deptList = ((data && data.deptChoices) || []).filter((o) => o.count > 0 || o.jobs > 0 || o.value === f.department);
  const showDept = deptList.length > 1 || !!f.department;
  const deptName = f.department ? ((deptList.find((o) => o.value === f.department) || {}).label || (f.department === '__none__' ? 'No department' : f.department)) : '';
  const deptText = (o) => `${o.label} (${o.count ? `${fmt(o.count)} in process` : `${fmt(o.jobs)} open ${o.jobs === 1 ? 'job' : 'jobs'}`})`;
  const [moreOpen, setMoreOpen] = useState(false);
  // Team leads load on their own (a second request) so the page shows fast.
  const [tls, setTls] = useState(null);
  const [cand, setCand] = useState(null);
  const wantTls = !!(data && (data.widgets || []).some((w) => w.type === 'tls'));
  useEffect(() => {
    if (!wantTls) { setTls(null); return undefined; }
    let alive = true;
    setTls({ loading: true });
    api.get(LIST_URL, { params: { ...params, set: '__tls' } })
      .then((r) => { if (alive) setTls({ data: r.data }); })
      .catch((e) => { if (alive) setTls({ error: e.response?.data?.error || 'The team leads could not be loaded. Refresh the page to try again.' }); });
    return () => { alive = false; };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const tasks = taskLine(alerts);
  const widgets = (data && data.widgets) || [];
  const kpi = widgets.find((w) => w.type === 'kpis');
  // `more: true` marks a widget for the collapsed section. (The recruiter's
  // task list also carries a NUMBER called `more` — its total — so only a
  // literal true counts.)
  const isMore = (w) => w.more === true;
  const rest = widgets.filter((w) => w.type !== 'kpis' && !isMore(w));
  const moreW = widgets.filter((w) => w.type !== 'kpis' && isMore(w));
  const MORE_NAMES = { banner: 'Activity not logged', cleanup: 'Data cleanup' };
  const moreNames = moreW.map((w) => w.title || MORE_NAMES[w.type]).filter(Boolean);
  const g = data && data.greeting;
  const prevWord = data && data.period && !data.period.noPrev ? data.period.prevWord : null;
  const cleanupLink = !!(data && data.cleanup && data.cleanup.to && (data.cleanup.stale > 0 || data.cleanup.oldUnassigned > 0)
    && ['superadmin', 'admin'].includes(data.layout));

  // "Good morning, Aarti — 2 late, 3 client feedback pending." Every number opens its list.
  const hello = (
    <div className="ah-hello">
      {g && g.items ? (
        <>
          {greeting(user && user.name)} —{' '}
          {!g.items.length ? 'nothing is late and nothing is waiting.' : (
            <>
              {g.items.map((it, i) => (
                <Fragment key={it.id}>
                  {i ? ', ' : ''}
                  <button type="button" className={`ahv3-hello-n t-${it.tone === 'red' ? 'red' : 'yellow'}`} onClick={() => setDrill(it.drill)}>{fmt(it.value)} {it.label}</button>
                </Fragment>
              ))}
              .
            </>
          )}
        </>
      ) : g ? (
        <>
          {greeting(user && user.name)} —{' '}
          {!g.late && !g.feedback ? 'nothing is late and no feedback is pending.' : (
            <>
              {g.late ? <button type="button" className="ahv3-hello-n t-red" onClick={() => setDrill(g.lateDrill)}>{fmt(g.late)} late</button> : 'nothing late'}
              {', '}
              {g.feedback ? <button type="button" className="ahv3-hello-n t-yellow" onClick={() => setDrill(g.feedbackDrill)}>{fmt(g.feedback)} feedback pending</button> : 'no feedback pending'}
              .
            </>
          )}
        </>
      ) : (
        <>{greeting(user && user.name)}{tasks ? <> — <span className={`ah-hello-t${tasks.late ? ' t-red' : ''}`}>{tasks.short}</span></> : '.'}</>
      )}
    </div>
  );
  const extraChips = EXTRA_FILTERS.filter(([k]) => extra[k]).map(([k, l]) => (
    <StatusChip key={k} tone="blue">
      {l}: {labelOf(k, extra[k])}{' '}
      <button type="button" className="link-btn" aria-label={`Remove ${l}`} onClick={() => dropExtra(k)}>✕</button>
    </StatusChip>
  ));
  const drawOne = (w) => {
    const W = WIDGETS[w.type];
    return W ? <W key={`${w.id}-${reload}`} w={w} onDrill={setDrill} prevWord={prevWord} onPickDept={pickDept} params={params} tls={tls} onCand={setCand} /> : null;
  };
  const overlays = (
    <>
      {drill && <HomeDrill listUrl={LIST_URL} params={params} setId={drill} onClose={() => setDrill(null)} />}
      {cand && <CandidateDrawer candidateId={cand.candidateId} applicationId={cand.applicationId} user={user} onClose={() => setCand(null)} onChanged={() => {}} />}
      {data && <FirstTour user={user} layout={data.layout} />}
    </>
  );

  // ---- THE DASHBOARD (v4 redesign, 2026-10-08) — every role but the opt-in ?v3=1 page ----
  if (!data || !data.v3) {
    return (
      <div className="atsd ahome av4-page">
        <header className="av4-head">
          <div className="av4-head-l">
            <h1>
              ATS Dashboard
              {data && <span className="av4-scope">{data.title}{deptName ? ` · ${deptName}` : ''}</span>}
            </h1>
            <p className="av4-about">{(data && data.about) || 'Overview of your hiring, candidates, clients and team.'}</p>
            {hello}
          </div>
          <div className="av4-tools">
            {showDept && (
              <label className={`lph-facet av4-dept-f${f.department ? ' is-picked' : ''}`}>
                <span className="lph-facet-lbl">Department</span>
                <select value={f.department || ''} onChange={(e) => setF({ ...f, department: e.target.value })} aria-label="Department">
                  <option value="">All departments</option>
                  {deptList.map((o) => <option key={o.value} value={o.value}>{deptText(o)}</option>)}
                </select>
              </label>
            )}
            <PageFilterBar className="av4-pfb" value={f} onChange={setF} show={{ ...show, department: false }} options={barOptions} />
            <button type="button" className="btn btn-primary av4-refresh" onClick={() => setReload((n) => n + 1)} disabled={loading} title="Load the numbers again">
              <Icon name="refresh" size={15} /> {loading && data ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>
        {(f.department || extraChips.length > 0) && (
          <div className="av4-chips">
            {f.department && <button type="button" className="btn btn-sm ah-dept-all" onClick={() => setF({ ...f, department: '' })}>✕ All departments</button>}
            {f.department && <span className="small-muted">Everything below is {deptName} only.</span>}
            {extraChips}
          </div>
        )}
        {error && <div className="notice red">{error}</div>}
        {!data && !error && <div className="small-muted">Loading your dashboard…</div>}
        {data && (
          <AtsV4
            data={data}
            params={params}
            reload={reload}
            tls={tls}
            user={user}
            onDrill={setDrill}
            onPickDept={pickDept}
            draw={drawOne}
            cleanupLink={cleanupLink}
            prevWord={prevWord}
          />
        )}
        {overlays}
      </div>
    );
  }

  // ---- The opt-in ?v3=1 page keeps its own layout. ----
  return (
    <div className={`atsd ahome${data && data.v3 ? ' is-v3' : ''}`}>
      <div className="page-head">
        <div>
          <h1>{data ? data.title : 'Dashboard'}{deptName ? <span className="ah-h1-dept"> · {deptName}</span> : null}</h1>
          {data && data.about && <div className="ah-about">{data.about}</div>}
          {hello}
        </div>
        {data && data.main && (data.main.to
          ? <Link className="btn btn-primary" to={data.main.to}>{data.main.label} →</Link>
          : <button type="button" className="btn btn-primary" onClick={() => setDrill(data.main.drill)}>{data.main.label} →</button>)}
      </div>
      {/* Row 1: the department chooser (2+ departments). "Your area" is in the top bar. */}
      {showDept && (
      <div className={`ah-deptbar${f.department ? ' is-picked' : ''}`}>
        <label className="ah-deptpick">
            <span className="ah-deptpick-l">Department:</span>
            <select value={f.department || ''} onChange={(e) => setF({ ...f, department: e.target.value })} aria-label="Department">
              <option value="">All departments</option>
              {deptList.map((o) => <option key={o.value} value={o.value}>{deptText(o)}</option>)}
            </select>
          </label>
        {f.department && <button type="button" className="btn btn-sm ah-dept-all" onClick={() => setF({ ...f, department: '' })}>✕ All departments</button>}
        {f.department && <span className="small-muted">Everything below is {deptName} only.</span>}
      </div>
      )}
      {/* Row 2: date range, client, recruiter / BDE (+ chips from old links). */}
      <div className="ah-row2">
        <PageFilterBar value={f} onChange={setF} show={{ ...show, department: false }} options={barOptions} />
        {extraChips}
      </div>
      {error && <div className="notice red">{error}</div>}
      {data && (() => {
        const extrasRow = data.extras.length > 0 && (
          <div className="ah-extras">
            {data.extras.map((x) => (x.button
              ? <Link key={x.id} className="btn btn-sm" to={x.to}>{x.label} →</Link>
              : (
                <span key={x.id} className={`ah-extra${x.tone ? ` t-${x.tone}` : ''}`}>
                  {x.value ? <Num value={x.value} drill={x.drill} onDrill={setDrill} className="ah-extra-n" /> : null}
                  {' '}{x.label}
                </span>
              )))}
          </div>
        );
        const draw = (list) => list.map((w) => {
          const W = WIDGETS[w.type];
          return W ? <div key={w.id} className={`ah-w ah-w-${w.size || 'full'}`}><W w={w} onDrill={setDrill} prevWord={prevWord} onPickDept={pickDept} params={params} tls={tls} onCand={setCand} /></div> : null;
        });
        const inMore = !!data.moreExtras;
        const hasMore = moreW.length > 0 || (inMore && !!extrasRow) || cleanupLink;
        const names = [...(inMore && extrasRow ? ['Follow-ups'] : []), ...moreNames, ...(cleanupLink && !moreW.some((w) => w.type === 'cleanup') ? ['Data cleanup'] : [])];
        return (
          <>
            {kpi && <Cards w={kpi} onDrill={setDrill} prevWord={prevWord} />}
            <div className="ah-widgets">{draw(rest)}</div>
            {!inMore && extrasRow && <div className="ah-extras-below">{extrasRow}</div>}
            {hasMore && (
              <section className={`ah-more${moreOpen ? ' is-open' : ''}`}>
                <button type="button" className="btn ah-more-btn" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
                  {moreOpen ? '▴ Less' : '▾ More'}
                </button>
                {!moreOpen && names.length > 0 && <span className="small-muted ah-more-names">{names.join(' · ')}</span>}
                {moreOpen && (
                  <div className="ah-more-body">
                    {inMore && extrasRow}
                    <div className="ah-widgets">{draw(moreW)}</div>
                    {cleanupLink && !moreW.some((w) => w.type === 'cleanup') && <Link className="link-btn" to={data.cleanup.to}>Open Data cleanup →</Link>}
                  </div>
                )}
              </section>
            )}
          </>
        );
      })()}
      {overlays}
    </div>
  );
}
