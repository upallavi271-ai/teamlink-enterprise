import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// The actual workflow with live counts (the Workflow tab).
import WorkflowDiagram from '../../components/workflow/WorkflowDiagram.jsx';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { canExportReports } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import PeopleFilter, { useAtsWorkers } from '../../components/PeopleFilter.jsx';
import HierarchyFilter, { toParams, hierarchyLabels, useHierarchy } from '../../components/HierarchyFilter.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import Modal from '../../components/Modal.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import DateRangePicker, { RANGE_PRESETS } from '../../components/DateRangePicker.jsx';
import Chart, { BarList } from '../../components/Chart.jsx';
import MoreFilters from '../../components/ui/MoreFilters.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';

// ---------------------------------------------------------------------------
// ATS REPORTS (§18) — Reports -> ATS Reports.
//
// "ATS Reports must measure the whole recruitment process."
//
// ONE page, ONE sidebar entry. Every report is a tab in here, never an entry
// of its own in the sidebar ("anni lopala vundali"). The three reports this
// screen always had — Recruitment, Interviews, Follow-ups, each with its
// Department / Team / Recruiter / TL / STL / BDE / Client / Source / Location
// / Stage groupings — are kept as they were and the rest sit beside them.
//
// The screen draws whatever the server sends — summary tiles, then tables —
// so every report looks and behaves the same, and the numbers, the exports
// and the drill-down all come from ONE builder on the server
// (backend/src/routes/atsReports.js).
//
// EVERY NUMBER OPENS ITS LIST. A clickable figure asks the server for the
// records behind exactly that figure, with exactly the applied filters, and
// shows them with links to the candidate and requirement pages.
//
// The filter bar is shared by every tab and survives switching tabs. It
// cascades — choosing a department narrows the client, requirement, people
// and location lists to it — and nothing is fetched until Apply Filters.
// ---------------------------------------------------------------------------

// The tabs, in the user's order: [id, label]. Review #3 §12 — Reports are
// "what happened / performance": Recruitment Funnel, Recruiter Performance,
// Client Performance, Department, Source first; then the report tabs that
// were already here and are not duplicates (the old Recruitment tab's stage
// matrix is "Pipeline" now — its funnel moved to Recruitment Funnel).
export const ATS_REPORT_TABS = [
  ['funnel', 'Recruitment Funnel'],
  ['recruiters', 'Recruiter Performance'],
  ['clients', 'Client Performance'],
  ['departments', 'Department'],
  ['sources', 'Source'],
  ['recruitment', 'Pipeline'],
  ['requirements', 'Requirements'],
  ['candidates', 'Candidates'],
  ['interviews', 'Interviews'],
  ['ai', 'AI Interviews'],
  ['followups', 'Follow-ups'],
  ['joining', 'Joining'],
  ['sla', 'SLA & Aging'],
  // The actual workflow (2026-09-29), live counts per box, each box opening its list.
  ['workflow', 'Workflow'],
];
const TAB_IDS = ATS_REPORT_TABS.map(([id]) => id);
// Addresses from before this page settled — the first cut's tab names, and
// the old report's groupings, which are views of the Recruitment tab.
const OLD_TABS = { overview: 'funnel', time: 'sla', department: 'departments', source: 'sources' };
const RECRUITMENT_VIEWS = ['department', 'team', 'recruiter', 'tl', 'stl', 'bde', 'client', 'source', 'location', 'stage'];

const PRESETS = [['all', 'All Time'], ...RANGE_PRESETS];
const EMPTY = {
  range: 'all', from: '', to: '', department: '', clientId: '', requirementId: '', recruiter: '', tl: '',
  stl: '', bde: '', location: '', source: '', status: '', stage: '', interviewStatus: '', aiStatus: '',
  joiningStatus: '', positionCode: '', section: '',
};
const FILTER_KEYS = Object.keys(EMPTY).filter((k) => !['range', 'from', 'to'].includes(k));
// The ones under "More Filters ▾" (the hierarchy and the date stay visible).
const MORE_KEYS = ['clientId', 'requirementId', 'source', 'stl', 'bde', 'location', 'status', 'stage', 'interviewStatus', 'aiStatus', 'joiningStatus'];

// Department / Section / TL / Recruiter come from the hierarchy filter
// (components/HierarchyFilter.jsx). A Recruiter Code is kept in positionCode;
// the filter's own value spells it "seat:<CODE>".
const hierOf = (f) => ({
  department: f.department, section: f.section, tl: f.tl,
  recruiter: f.positionCode ? `seat:${f.positionCode}` : f.recruiter,
});

function queryOf(filters, extra = {}) {
  const p = new URLSearchParams();
  const f = { ...filters };
  // The hierarchy, as the server's parameters: a Section becomes the
  // comma-separated seat codes it holds (positionCode) — see HierarchyFilter.
  const h = toParams(hierOf(f));
  Object.assign(f, { department: h.department || '', tl: h.tl || '', recruiter: h.recruiter || '', positionCode: h.positionCode || '' });
  delete f.section;
  if (f.range !== 'custom') { f.from = ''; f.to = ''; }
  if (f.range === 'all') f.range = '';
  Object.entries({ ...f, ...extra }).forEach(([k, v]) => {
    if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  });
  return p.toString();
}

const fmt = (v, type) => {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'pct') return `${v}%`;
  if (typeof v === 'number') return v.toLocaleString('en-IN');
  return v;
};

// A file from an authenticated endpoint. The token stays in the request
// header; the page never sees it.
async function download(url, fallback) {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const cd = res.headers['content-disposition'] || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallback;
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    return '';
  } catch (err) {
    const blob = err.response?.data;
    if (blob && typeof blob.text === 'function') {
      try { return JSON.parse(await blob.text()).error || 'Export failed'; } catch { /* not JSON */ }
    }
    return 'Export failed';
  }
}

// The old ATS-side address, kept working: lands here with its ?tab= intact.
export function AtsReportsRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/reports/ats${search}`} replace />;
}

const REF_PATH = { cand: '/candidates/', req: '/requirements/', client: '/clients/' };

// One cell. A drillable figure is a button; zero is not, because an empty
// list is not worth a click.
function Cell({ col, value, refs, onDrill }) {
  if (col.drill) {
    if (!value) return <td className="num cell-muted">{fmt(value, col.type)}</td>;
    return (
      <td className="num">
        <button type="button" className="link-btn" onClick={onDrill} title="Show the list behind this number">
          {fmt(value, col.type)}
        </button>
      </td>
    );
  }
  const text = fmt(value, col.type);
  const id = col.ref && refs && refs[col.ref];
  return (
    <td className={col.type !== 'text' ? 'num' : undefined}>
      {id ? <Link to={`${REF_PATH[col.ref]}${id}`}>{text}</Link> : text}
    </td>
  );
}

// One table. Its own component so each can page and sort by itself.
function Section({ sec, onDrill, onGroupBy, onExport }) {
  const [sort, setSort] = useState(null); // { i, dir }
  const rows = useMemo(() => {
    if (!sort) return sec.rows;
    const { i, dir } = sort;
    return [...sec.rows].sort((a, b) => {
      const x = a.c[i];
      const y = b.c[i];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return dir * r;
    });
  }, [sec.rows, sort]);
  const page = usePaged(rows, 25);
  const list = sec.paged ? page.slice : rows;
  const toggle = (i) => setSort((s) => (s && s.i === i ? { i, dir: -s.dir } : { i, dir: sec.columns[i].type === 'text' ? 1 : -1 }));

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{sec.title}</h3>
        <span className="small-muted">{sec.rows.length.toLocaleString('en-IN')} row{sec.rows.length === 1 ? '' : 's'}</span>
        {/* §12 — export THIS table (the page's Export ▾ still takes them all). */}
        {onExport && sec.rows.length > 0 && (
          <span style={{ marginLeft: 'auto' }}>
            <ExportMenu small formats={[['csv', 'CSV'], ['xlsx', 'Excel']]} label="Export table" onPick={(f) => onExport(sec, f)} />
          </span>
        )}
      </div>
      {sec.sub && <div className="small-muted" style={{ marginBottom: 8 }}>{sec.sub}</div>}
      {sec.groupings && (
        <div className="report-groupby">
          {sec.groupings.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`report-tab${sec.groupBy === g.id ? ' is-on' : ''}`}
              onClick={() => onGroupBy(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
      <div className={`tbl-wrap${sec.paged ? ' tbl-fit' : ''}`}>
        <table>
          <thead>
            <tr>
              {sec.columns.map((c, i) => (
                <th
                  key={c.key}
                  className={c.type !== 'text' ? 'num' : undefined}
                  style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => toggle(i)}
                  title="Sort"
                >
                  {c.label}{sort && sort.i === i ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.key}>
                {sec.columns.map((c, i) => (
                  <Cell key={c.key} col={c} value={r.c[i]} refs={r.refs} onDrill={() => onDrill(sec, r.key, c, r.c[0])} />
                ))}
              </tr>
            ))}
            {sec.rows.length === 0 && (
              <tr><td colSpan={sec.columns.length} style={{ padding: 0 }}>
                <EmptyState compact title="Nothing here for these filters." hint="Try a wider date range, or clear a filter — only work inside your scope is counted." />
              </td></tr>
            )}
          </tbody>
          {sec.total && sec.rows.length > 0 && (
            <tfoot>
              <tr className="report-total">
                {sec.columns.map((c, i) => (i === 0
                  ? <td key={c.key}><b>Total</b></td>
                  : <Cell key={c.key} col={c} value={sec.total[i]} onDrill={() => onDrill(sec, '__total__', c, 'Total')} />))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {sec.paged && <Pager page={page} noun="rows" />}
    </div>
  );
}

// The list behind one number, with the filters the number was counted under.
function DrillModal({ tab, query, target, canExport, onClose }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const LIMIT = 100;
  const base = `${query}${query ? '&' : ''}${new URLSearchParams({ section: target.section, row: target.row, col: target.col }).toString()}`;

  useEffect(() => {
    setData(null);
    api.get(`/ats-reports/${tab}/drill?${base}&offset=${offset}&limit=${LIMIT}`)
      .then((res) => { setData(res.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load this list.'));
  }, [tab, base, offset]);

  const to = data ? Math.min(offset + LIMIT, data.total) : 0;
  const noun = data ? ({ req: 'requirements', cand: 'candidates', fu: 'follow-ups' }[data.kind] || 'applications') : '';
  return (
    <Modal
      size="xwide"
      title={data ? data.title : target.title}
      note={data ? `${data.total.toLocaleString('en-IN')} ${noun}` : ''}
      onClose={onClose}
      footer={(
        <>
          {data && data.total > LIMIT && (
            <>
              <span className="small-muted" style={{ marginRight: 'auto' }}>
                {(offset + 1).toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {data.total.toLocaleString('en-IN')}
              </span>
              <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>‹ Previous</button>
              <button type="button" className="btn btn-sm" disabled={to >= data.total} onClick={() => setOffset(offset + LIMIT)}>Next ›</button>
            </>
          )}
          {canExport && data && data.total > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const msg = await download(`/ats-reports/${tab}/drill?${base}&format=csv`, 'ats-report-list.csv');
                if (msg) setError(msg);
              }}
            >
              Export list (CSV)
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </>
      )}
    >
      {data && data.section && <div className="small-muted" style={{ marginBottom: 8 }}>{data.report} · {data.section}</div>}
      {error && <div className="error-text">{error}</div>}
      {!data && !error && <div className="small-muted">Loading the list…</div>}
      {data && (
        <div className="tbl-wrap tbl-fit">
          <table>
            <thead>
              <tr>{data.columns.map((c) => <th key={c.key} className={c.type === 'num' ? 'num' : undefined}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={`${offset + i}`}>
                  {data.columns.map((c) => ((c.key === 'status' || c.key === 'stage') && r.cells[c.key]
                    // §24 — one colour per meaning (StatusChip).
                    ? <td key={c.key}><StatusChip status={String(r.cells[c.key])} /></td>
                    : <Cell key={c.key} col={{ ...c, type: c.type || 'text' }} value={r.cells[c.key]} refs={r.refs} />))}
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr><td colSpan={data.columns.length} className="small-muted" style={{ padding: 16 }}>Nothing in this list.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// Export ▾ — CSV / Excel / PDF, and Print, all respecting the applied filters.
const ALL_FORMATS = [['csv', 'CSV'], ['xlsx', 'Excel'], ['pdf', 'PDF'], ['print', 'Print']];
function ExportMenu({ busy, onPick, formats = ALL_FORMATS, label = 'Export', small = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = { display: 'block', width: '100%', textAlign: 'left', padding: '7px 14px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13 };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className={`btn${small ? ' btn-sm' : ''}`} disabled={!!busy} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {busy ? 'Preparing…' : `${label} ▾`}
      </button>
      {open && (
        <div
          role="menu"
          className="card"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, padding: '4px 0', minWidth: 150 }}
        >
          {formats.map(([id, text]) => (
            <button key={id} type="button" role="menuitem" style={item} onClick={() => { setOpen(false); onPick(id); }}>
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// §12 — ONE simple chart per report, drawn from the report's own table (so a
// bar and its row cannot disagree): one axis, one colour, labelled values,
// and a Table view of exactly the plotted numbers.
const CHART_SPECS = {
  funnel: { section: 'funnel', col: 'count', title: 'Recruitment funnel', sub: 'Applications that reached each step', order: true, extra: ['ofPrev', 'Conversion from previous'] },
  recruiters: { section: 'recruiters', col: 'candidates', title: 'Candidates by recruiter', top: 10, extra: ['joined', 'Joined'] },
  clients: { section: 'clients', col: 'candidates', title: 'Candidates by client', top: 10, extra: ['joined', 'Joined'] },
  departments: { section: 'departments', col: 'applications', title: 'Applications by department', extra: ['joined', 'Joined'] },
  sources: { section: 'channels', col: 'applications', title: 'Applications by source', order: true, extra: ['joined', 'Joined'] },
  recruitment: { section: 'recruitment', col: 'applications', title: 'Applications by group', top: 8 },
};

function chartRows(data, spec) {
  const sec = data.sections.find((s) => s.id === spec.section);
  if (!sec) return null;
  const i = sec.columns.findIndex((c) => c.key === spec.col);
  const j = spec.extra ? sec.columns.findIndex((c) => c.key === spec.extra[0]) : -1;
  if (i < 0) return null;
  let rows = sec.rows.map((r) => ({
    label: String(r.c[0] ?? '—'), value: Number(r.c[i]) || 0, extra: j >= 0 ? r.c[j] : undefined,
    type: j >= 0 ? sec.columns[j].type : 'num',
  }));
  if (!spec.order) rows = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const all = rows.length;
  if (spec.top) rows = rows.slice(0, spec.top);
  return { rows, all, label: sec.columns[0].label, valueLabel: sec.columns[i].label };
}

function ChartCard({ data, spec }) {
  const [view, setView] = useState('chart');
  const c = chartRows(data, spec);
  if (!c) return null;
  const any = c.rows.some((r) => r.value > 0);
  const toggle = (
    <div className="report-groupby" style={{ margin: 0 }} role="group" aria-label="Chart or table">
      {[['chart', 'Chart'], ['table', 'Table']].map(([id, label]) => (
        <button key={id} type="button" className={`report-tab${view === id ? ' is-on' : ''}`} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
      ))}
    </div>
  );
  return (
    <Chart
      title={spec.title}
      sub={spec.sub || (spec.top && c.all > spec.top ? `The ${spec.top} largest of ${c.all.toLocaleString('en-IN')}` : null)}
      right={any ? toggle : null}
    >
      {!any && <EmptyState compact title="Nothing to chart for these filters." hint="Try a wider date range or clear a filter." />}
      {any && view === 'chart' && (
        <BarList rows={c.rows.map((r) => ({ label: r.label, value: r.value }))} format={(v) => v.toLocaleString('en-IN')} />
      )}
      {any && view === 'table' && (
        <div className="tbl-wrap tbl-fit">
          <table>
            <thead>
              <tr>
                <th>{c.label}</th><th className="num">{c.valueLabel}</th>
                {spec.extra && <th className="num">{spec.extra[1]}</th>}
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td><td className="num">{r.value.toLocaleString('en-IN')}</td>
                  {spec.extra && <td className="num">{fmt(r.extra, r.type)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Chart>
  );
}

export default function AtsReports() {
  const { user } = useAuth();
  const canExport = canExportReports(user, 'ATS Reports');
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const legacyView = RECRUITMENT_VIEWS.includes(asked) ? asked : '';
  const tab = TAB_IDS.includes(asked) ? asked : (OLD_TABS[asked] || (legacyView ? 'recruitment' : 'funnel'));
  // `draft` is what the filter bar shows; `filters` is what was applied.
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [groupBy, setGroupBy] = useState(() => (legacyView ? { recruitment: legacyView } : {}));
  const [options, setOptions] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  const [busy, setBusy] = useState('');
  const [denied, setDenied] = useState(false);
  const seq = useRef(0);
  const tree = useHierarchy();
  const people = useAtsWorkers();

  // An old or bare address lands on its tab, with the tab in the URL.
  useEffect(() => {
    if (asked !== tab) setParams({ tab }, { replace: true });
  }, [asked, tab, setParams]);

  // The filter lists, cascading from the department and client being chosen.
  useEffect(() => {
    const q = new URLSearchParams();
    if (draft.department) q.set('department', draft.department);
    if (draft.clientId) q.set('clientId', draft.clientId);
    api.get(`/ats-reports/options?${q.toString()}`)
      .then((res) => setOptions(res.data))
      .catch(() => setOptions(null));
  }, [draft.department, draft.clientId]);

  const query = queryOf(filters, { groupBy: groupBy[tab] || '' });
  const load = useCallback(() => {
    const mine = ++seq.current;
    // The Workflow tab draws itself (components/workflow/WorkflowDiagram.jsx).
    if (tab === 'workflow') { setLoading(false); return; }
    setLoading(true);
    api.get(`/ats-reports/${tab}?${query}`)
      .then((res) => { if (mine === seq.current) { setData(res.data); setError(''); setDenied(false); } })
      .catch((err) => {
        if (mine !== seq.current) return;
        setDenied(err.response?.status === 403);
        setError(err.response?.data?.error || 'ATS Reports are not included in your role’s permissions.');
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [tab, query]);
  useEffect(load, [load]);

  function set(patch) {
    setDraft((f) => {
      const next = { ...f, ...patch };
      // Cascade: a new department invalidates everything chosen inside it; a
      // new client, the requirement.
      if ('department' in patch && patch.department !== f.department) {
        // (Section / TL / Recruiter are narrowed by the hierarchy filter itself.)
        Object.assign(next, { clientId: '', requirementId: '', stl: '', bde: '', location: '' });
      }
      if ('clientId' in patch && patch.clientId !== f.clientId) next.requirementId = '';
      return next;
    });
  }
  const countOf = (f) => FILTER_KEYS.filter((k) => f[k]).length + (f.range !== 'all' ? 1 : 0);
  const active = countOf(filters);
  const dirty = queryOf(draft) !== queryOf(filters);

  function openTile(t) {
    if (!t.drill || !t.value) return;
    setDrill({ tab, section: 'tiles', row: '', col: t.key, title: t.label, query });
  }
  function openCell(sec, rowKey, col, rowLabel) {
    setDrill({ tab, section: sec.id, row: rowKey, col: col.key, title: `${rowLabel} · ${col.label}`, query });
  }

  // Print: a clean server-rendered page, opened first (so no popup blocker
  // intervenes) and filled once it arrives.
  async function print() {
    const w = window.open('', '_blank');
    if (!w) { setError('Allow pop-ups for this site to print.'); return; }
    w.document.write('<p style="font:14px sans-serif;padding:20px">Preparing the report…</p>');
    try {
      const res = await api.get(`/ats-reports/${tab}/export?${query}&format=html`, { responseType: 'text' });
      w.document.open();
      w.document.write(res.data);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    } catch (err) {
      w.close();
      setError(err.response?.data?.error || 'Could not prepare the print view.');
    }
  }
  async function exportAs(format) {
    if (format === 'print') { print(); return; }
    setBusy(format);
    const msg = await download(`/ats-reports/${tab}/export?${query}&format=${format}`, `ats-report.${format}`);
    setBusy('');
    if (msg) setError(msg);
  }
  // One table only (server: ?section=<id>).
  async function exportTable(sec, format) {
    const msg = await download(`/ats-reports/${tab}/export?${query}${query ? '&' : ''}format=${format}&section=${encodeURIComponent(sec.id)}`, `ats-report-${sec.id}.${format}`);
    if (msg) setError(msg);
  }

  const o = options || {};

  // THE ACTIVE FILTER CHIPS (spec §22) — what is APPLIED, each removable on
  // its own (removal applies at once; Clear All stays in the filter row).
  const labelIn = (list, v) => {
    const x = (list || []).find((y) => (typeof y === 'string' ? y === v : y.id === v));
    return x ? (typeof x === 'string' ? x : x.label) : v;
  };
  const drop = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setDraft((d) => ({ ...d, ...patch }));
  };
  const hl = hierarchyLabels(hierOf(filters), tree.data);
  const chips = [
    filters.range !== 'all' && { key: 'range', label: 'Date', value: data && data.period ? data.period.label : filters.range, onRemove: () => drop({ range: 'all', from: '', to: '' }) },
    { key: 'department', label: 'Department', value: filters.department && hl.department, onRemove: () => drop({ department: '', section: '', tl: '', recruiter: '', positionCode: '' }) },
    { key: 'section', label: 'Section', value: filters.section && hl.section, onRemove: () => drop({ section: '', tl: '', recruiter: '', positionCode: '' }) },
    { key: 'tl', label: 'TL', value: filters.tl && hl.tl, onRemove: () => drop({ tl: '', recruiter: '', positionCode: '' }) },
    { key: 'recruiter', label: 'Recruiter', value: filters.recruiter && hl.recruiter, onRemove: () => drop({ recruiter: '' }) },
    { key: 'positionCode', label: 'Recruiter Code', value: filters.positionCode, onRemove: () => drop({ positionCode: '' }) },
    { key: 'clientId', label: 'Client', value: filters.clientId && labelIn(o.clients, filters.clientId), onRemove: () => drop({ clientId: '', requirementId: '' }) },
    { key: 'requirementId', label: 'Requirement', value: filters.requirementId && labelIn(o.requirements, filters.requirementId), onRemove: () => drop({ requirementId: '' }) },
    { key: 'stl', label: 'STL', value: filters.stl && labelIn(o.stls, filters.stl), onRemove: () => drop({ stl: '' }) },
    { key: 'bde', label: 'BDE', value: filters.bde && ((people.bdes || []).find((w) => w.value === filters.bde) || {}).name || filters.bde.replace(/^(id|name):/, ''), onRemove: () => drop({ bde: '' }) },
    { key: 'location', label: 'Location', value: filters.location, onRemove: () => drop({ location: '' }) },
    { key: 'source', label: 'Source', value: filters.source, onRemove: () => drop({ source: '' }) },
    { key: 'status', label: 'Status', value: filters.status && labelIn(o.statuses, filters.status), onRemove: () => drop({ status: '' }) },
    { key: 'stage', label: 'Stage', value: filters.stage && labelIn(o.stages, filters.stage), onRemove: () => drop({ stage: '' }) },
    { key: 'interviewStatus', label: 'Interview', value: filters.interviewStatus && labelIn(o.interviewStatuses, filters.interviewStatus), onRemove: () => drop({ interviewStatus: '' }) },
    { key: 'aiStatus', label: 'AI interview', value: filters.aiStatus && labelIn(o.aiStatuses, filters.aiStatus), onRemove: () => drop({ aiStatus: '' }) },
    { key: 'joiningStatus', label: 'Joining', value: filters.joiningStatus && labelIn(o.joiningStatuses, filters.joiningStatus), onRemove: () => drop({ joiningStatus: '' }) },
  ].filter(Boolean);
  const pick = (key, label, list, allLabel) => (
    <Combo value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} title={label}>
      <option value="">{allLabel}</option>
      {(list || []).map((x) => (typeof x === 'string'
        ? <option key={x} value={x}>{x}</option>
        : <option key={x.id} value={x.id}>{x.label}</option>))}
    </Combo>
  );
  // A login the report refuses gets the refusal, not a filter bar for data it
  // will never be shown.
  if (denied && tab !== 'workflow') {
    return (
      <div>
        <div className="page-head"><div><h1>ATS Reports</h1></div></div>
        <div className="error-text">{error}</div>
      </div>
    );
  }

  const tabLabel = (ATS_REPORT_TABS.find(([id]) => id === tab) || [])[1];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>ATS Reports</h1>
          <div className="page-sub">
            {data && <b className="scope-tag">Scope: {data.scope}</b>}
            {data && ` · ${tabLabel} · ${data.period.label}`}
            {active ? ` · ${active} filter${active === 1 ? '' : 's'} applied` : ''}
            {loading && data ? ' · updating…' : ''}
          </div>
        </div>
        {canExport && <ExportMenu busy={busy} onPick={exportAs} />}
      </div>

      <div className="tabbar">
        {ATS_REPORT_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`tab-btn${tab === id ? ' active' : ''}`}
            onClick={() => setParams({ tab: id })}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'workflow' ? <WorkflowDiagram /> : (<>
      {/* THE COMMON FILTERS — the same on every tab, applied on the server.
          Review #3 §14: Date range + Department → Section → TL → Recruiter
          always visible; Client, Requirement, Source and the rest under
          More Filters ▾. */}
      {/* .filter-row gives the dropdowns their usual inline width. */}
      <div className="filter-row" style={{ display: 'block' }}>
      <MoreFilters
        storageKey="atsreports"
        activeMore={MORE_KEYS.filter((k) => draft[k]).length}
        onClearAll={countOf(draft) || active ? () => { setDraft(EMPTY); setFilters(EMPTY); } : undefined}
        extra={<button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => setFilters(draft)}>Apply Filters</button>}
        primary={(<>
        <DateRangePicker
          presets={PRESETS}
          apply={false}
          value={{ range: draft.range, from: draft.from, to: draft.to }}
          onChange={(v) => set({ range: v.range, from: v.from || '', to: v.to || '' })}
          period={data && data.period && data.period.key !== 'all' ? data.period : null}
        />
        {/* Department -> Section -> TL -> Recruiter (spec §7): one dependent
            filter, current AND former people, only the levels this login can
            use. A Recruiter Code counts the work done from that seat. */}
        <HierarchyFilter
          value={hierOf(draft)}
          onChange={(h) => {
            const seat = h.recruiter.startsWith('seat:') ? h.recruiter.slice(5) : '';
            set({ department: h.department, section: h.section, tl: h.tl, recruiter: seat ? '' : h.recruiter, positionCode: seat });
          }}
        />
        </>)}
      >
        {pick('clientId', 'Client', o.clients, 'All clients')}
        {pick('requirementId', 'Requirement', o.requirements, 'All requirements')}
        {/* STL / BDE: current AND former people, the same list as every ATS
            screen (components/PeopleFilter). The report counts the work
            attributed to them — the same rule the lists use. */}
        {pick('stl', 'STL', o.stls, 'All STLs')}
        <PeopleFilter role="BDE" department={draft.department} value={draft.bde} onChange={(v) => set({ bde: v })} />
        {pick('location', 'Location', o.locations, 'All locations')}
        {pick('source', 'Source', o.sources, 'All sources')}
        <Combo value={draft.status} onChange={(e) => set({ status: e.target.value })} title="Status">
          <option value="">All statuses</option>
          <optgroup label="Requirement status">
            {(o.statuses || []).filter((s) => s.id.startsWith('req:')).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </optgroup>
          <optgroup label="Candidate status">
            {(o.statuses || []).filter((s) => s.id.startsWith('cand:')).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </optgroup>
        </Combo>
        {pick('stage', 'Stage', o.stages, 'All stages')}
        {pick('interviewStatus', 'Interview status', o.interviewStatuses, 'All interview statuses')}
        {pick('aiStatus', 'AI interview status', o.aiStatuses, 'All AI interview statuses')}
        {pick('joiningStatus', 'Joining status', o.joiningStatuses, 'All joining statuses')}
      </MoreFilters>
      </div>

      <FilterChips filters={chips} />

      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {!data && !error && <div className="small-muted">Loading the report…</div>}

      {data && data.report === tab && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          {/* The compact summary. */}
          <div className="statbar">
            {data.tiles.map((t) => {
              const clickable = t.drill && t.value > 0;
              return (
                <div
                  key={t.key}
                  className="statitem"
                  data-goto={clickable ? '1' : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  style={clickable ? { cursor: 'pointer' } : undefined}
                  title={clickable ? 'Show the list behind this number' : undefined}
                  onClick={() => openTile(t)}
                  onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTile(t); } }}
                >
                  <div className="n">{fmt(t.value, t.type)}</div>
                  <div className="l">{t.label}</div>
                  {t.sub && <div className="s">{t.sub}</div>}
                </div>
              );
            })}
          </div>

          {/* §22 — a report with nothing in it says so, and what to try. */}
          {data.counts && data.counts.applications === 0 && data.counts.requirements === 0 && (
            <EmptyState
              title="No activity for this date range."
              hint="Try changing the date range or clearing filters — only work inside your scope is counted."
              action={filters.range !== 'all' || active
                ? <button type="button" className="btn btn-sm" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); }}>Show all time, no filters</button>
                : null}
            />
          )}

          {/* One chart per report, drawn from the report's own table, with a
              Table view of the same numbers. */}
          {CHART_SPECS[tab] && (
            <div className="chart-grid">
              <ChartCard key={`${tab}-${data.sections.map((s) => s.groupBy || '').join('')}`} data={data} spec={CHART_SPECS[tab]} />
            </div>
          )}

          {data.notes.map((n) => <div key={n} className="notice amber" style={{ marginBottom: 12 }}>{n}</div>)}

          {data.sections.map((s) => (
            <Section
              key={`${tab}-${s.id}-${s.groupBy || ''}`}
              sec={s}
              onDrill={openCell}
              onGroupBy={(g) => setGroupBy((m) => ({ ...m, [tab]: g }))}
              onExport={canExport ? exportTable : null}
            />
          ))}

          <div className="notice" style={{ marginTop: 12 }}>
            Every number opens the list behind it. {data.dateBasis}
            {' '}Stages are the Candidates screen&apos;s own: New → AI Interview → Recruiter Review → TL Review → BDE Review → Client Review → Interview → Selected → Offer → Joining → Joined, with Hold and Rejected as views.
            {['funnel', 'departments', 'recruitment', 'requirements', 'recruiters', 'sources', 'clients', 'joining'].includes(tab) && (
              <> &ldquo;Reached&rdquo; figures are cumulative — someone who reached the interview is also counted as approved and shared.</>
            )}
          </div>
        </div>
      )}

      {drill && (
        <DrillModal tab={drill.tab} query={drill.query} target={drill} canExport={canExport} onClose={() => setDrill(null)} />
      )}
      </>)}
    </div>
  );
}
