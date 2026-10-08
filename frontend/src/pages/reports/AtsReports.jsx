import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// The actual workflow with live counts (the Workflow tab).
import WorkflowDiagram from '../../components/workflow/WorkflowDiagram.jsx';
import DailyReport from './DailyReport.jsx';
// Job portal numbers — a tab here now, not a sidebar entry of its own.
import JobPortalReports from './JobPortalReports.jsx';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { canExportReports } from '../../permissions';
import Combo from '../../components/Combo.jsx';
import ListPageHeader, {
  ListToolbar, PanelField, FacetSelect, useFacets,
} from '../../components/ui/ListPageHeader.jsx';
// Section 17 (2026-10-03): the landing page of report cards, and the small
// pieces every report uses (compare, "12 of 20", Excel / PDF buttons).
import ReportsHome, { cardOfTab } from './ReportsHome.jsx';
// Reports & Analytics overview on the landing page (redesign 2026-10-08).
import ReportsOverview from '../../components/reports-v4/ReportsOverview.jsx';
// Everyday words + one-line ? tips (user, 2026-10-05: "a new person gets it in 20–30 s").
import { plainWords } from '../../components/ui/Guide.jsx';

// What a report number means, in one line (by the words in its label).
const TILE_HELP = [
  [/reject/i, 'People turned down — by us or by the client'],
  [/late|overdue|sla|past/i, 'Past the time allowed for that step'],
  [/join/i, 'People who started the job'],
  [/select|offer/i, 'People the client chose'],
  [/interview/i, 'Interviews booked or done in this period'],
  [/sent|submit|shared/i, 'People we sent to clients'],
  [/open (job|requirement)|jobs|requirement/i, 'Jobs in this period (open ones are still being filled)'],
  [/applic|candidate|people/i, 'One person applying to one job counts once'],
  [/%|ratio|conversion|rate/i, 'Out of 100 people, how many got this far'],
  [/days|time|avg|average/i, 'Average number of days'],
  [/revenue|invoice|paid|received|amount/i, 'Money for this period'],
];
const tileHelp = (label) => (TILE_HELP.find(([re]) => re.test(String(label || ''))) || [null, 'What this report counts, for your filters'])[1];
import {
  Delta, OfBar, CompareToggle, COMPARE_CHOICES, ExportButtons, useReportCatalog,
} from './ReportBits.jsx';
import Modal from '../../components/Modal.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
// ATS layout v3 (2026-10-03): the shared filter bar, cards and charts.
import PageFilterBar, { usePageFilters, rangeDates } from '../../components/ui/PageFilterBar.jsx';
import StatCard, { StatRow } from '../../components/ui/StatCard.jsx';
import ReportCharts from './ReportCharts.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import StatusChip from '../../components/ui/StatusChip.jsx';
import './AtsReports.css';
// Rejections (spec 2026-10-03 §A3): the same-client rule, shown on the Rejection reasons tab.
import SameClientRule from '../../components/rejections/SameClientRule.jsx';
// ATS-100 B6: campaign costs, campus drives, referrals + bonuses (under the Campaigns tab).
import SourcingManager from '../../components/referrals/SourcingManager.jsx';
// ATS-100 B7: agency / freelancer partner performance (its own cascading filters).
import PartnersReport from './PartnersReport.jsx';

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
  // Day / month view of each recruiter's work (spec 2026-10-03 C2; routes/atsDaily.js).
  ['daily', 'Daily report'],
  ['clients', 'Client Performance'],
  ['departments', 'Department'],
  // spec D: Department → Specialization, demand (open jobs) vs supply (candidates).
  ['specialisations', 'Specialization'],
  ['sources', 'Source'],
  ['recruitment', 'Progress by team'],
  ['requirements', 'Jobs'],
  ['candidates', 'Candidates'],
  ['interviews', 'Interviews'],
  ['ai', 'AI Interviews'],
  ['followups', 'Follow-ups'],
  ['joining', 'Joining'],
  ['sla', 'Late & waiting'],
  // Why people are rejected: by reason, side, client, department, recruiter (spec 2026-10-03 §A3).
  ['rejections', 'Rejection reasons'],
  // B8: people added to a job although they did not meet its rules (utils/fitReports.js).
  ['overrides', 'Added by override'],
  // Section 17 (2026-10-03, utils/reportsPlus.js).
  ['timetofill', 'Time to fill'],
  ['quality', 'Source quality'],
  // ATS-100 B6.3: campaign (utm) / campus drive / referral -> joined, cost per joining.
  ['campaigns', 'Campaigns'],
  // ATS-100 B7: agency / freelancer partners — submitted / duplicates / joined / payout / cost per joining.
  ['partners', 'Partners'],
  // ATS-100 B9.3: campaign costs + partner payouts + incentives ÷ joinings (utils/costPerHire.js).
  ['costperhire', 'Cost per hire'],
  ['targets', 'Results vs target'],
  ['revenue', 'Client revenue'], // Super Admin / Admin / Accounts only (server-enforced)
  // ATS-100 B9.7: invoices net of credit notes per recruiter / month / client (same gate as Client revenue).
  ['recruiter-revenue', 'Recruiter revenue'],
  ['jobportal', 'Job portal'], // the old Reports → Job Portal Reports page, as a tab
  // The actual workflow (2026-09-29), live counts per box, each box opening its list.
  ['workflow', 'Workflow'],
];
const TAB_IDS = ATS_REPORT_TABS.map(([id]) => id);
// Addresses from before this page settled — the first cut's tab names, and
// the old report's groupings, which are views of the Recruitment tab.
const OLD_TABS = { overview: 'funnel', time: 'sla', department: 'departments', source: 'sources' };
const RECRUITMENT_VIEWS = ['department', 'team', 'recruiter', 'tl', 'stl', 'bde', 'client', 'source', 'location', 'stage'];

const EMPTY = {
  range: 'all', from: '', to: '', department: '', team: '', tl: '', recruiter: '', clientId: '', requirementId: '',
  bde: '', stl: '', source: '', location: '', status: '', stage: '', interviewStatus: '', aiStatus: '', joiningStatus: '',
  people: '',
};
// Recruiter Performance (2026-10-05): former people (left in HRMS) keep their
// old work and carry "· Former"; this picks one side.
const PEOPLE_CHOICES = [{ id: 'active', label: 'Still working here' }, { id: 'former', label: 'Former (have left)' }];
const FILTER_KEYS = Object.keys(EMPTY).filter((k) => !['range', 'from', 'to'].includes(k));

function queryOf(filters, extra = {}) {
  const p = new URLSearchParams();
  const f = { ...filters };
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
  if (type === 'money') return `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
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

const REF_PATH = { cand: '/candidates/', req: '/requirements/', client: '/clients/', inv: '/invoices/' };

// One cell. A drillable figure is a button; zero is not, because an empty
// list is not worth a click (and it reads "—", never a bare 0). In a
// comparison the change sits under the number; a result with a target
// reads "12 of 20" with a bar (section 17).
function Cell({
  col, value, refs, onDrill, prev, compare, target,
}) {
  const delta = compare && prev !== undefined && ['num', 'pct', 'money'].includes(col.type) && !col.now
    ? <Delta small cur={value} prev={prev} type={col.type} label={col.label} /> : null;
  const wrapOf = (inner) => (col.of ? <OfBar value={value} target={target}>{inner}</OfBar> : inner);
  if (col.drill) {
    if (!value) return <td className="num cell-muted">{wrapOf(col.of ? '0' : '—')}{delta}</td>;
    return (
      <td className="num">
        {wrapOf(
          <button type="button" className="link-btn" onClick={onDrill} title="Show who is behind this number">
            {fmt(value, col.type)}
          </button>,
        )}
        {delta}
      </td>
    );
  }
  const text = fmt(value, col.type);
  const id = col.ref && refs && refs[col.ref];
  return (
    <td className={col.type !== 'text' ? 'num' : undefined}>
      {id ? <Link to={`${REF_PATH[col.ref]}${id}`}>{text}</Link> : text}
      {delta}
    </td>
  );
}

// One table. Its own component so each can page and sort by itself.
function Section({
  sec, onDrill, onGroupBy, onExport, compare = false,
}) {
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
  // Target columns are not drawn on their own — they show as "of 20".
  const vis = sec.columns.map((c, i) => [c, i]).filter(([c]) => !c.hidden);
  const ofIdx = (c) => (c.of ? sec.columns.findIndex((x) => x.key === c.of) : -1);

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>{plainWords(sec.title)}</h3>
        {sec.rows.length > 0 && <span className="small-muted">{sec.rows.length.toLocaleString('en-IN')} row{sec.rows.length === 1 ? '' : 's'}</span>}
        {/* Export THIS table (the page's Excel / PDF buttons take them all). */}
        {onExport && sec.rows.length > 0 && (
          <span style={{ marginLeft: 'auto' }}>
            <button type="button" className="btn btn-sm" onClick={() => onExport(sec, 'xlsx')} title="Download this table as an Excel file">⬇ Excel</button>
          </span>
        )}
      </div>
      {sec.sub && <div className="small-muted" style={{ marginBottom: 8 }}>{plainWords(sec.sub)}</div>}
      {sec.groupings && (
        <label className="lph-facet" style={{ maxWidth: 260, marginBottom: 8 }}>
          <span className="lph-facet-lbl">Show by</span>
          <select value={sec.groupBy || ''} onChange={(e) => onGroupBy(e.target.value)}>
            {sec.groupings.map((g) => <option key={g.id} value={g.id}>{plainWords(g.label)}</option>)}
          </select>
        </label>
      )}
      <div className={`tbl-wrap${sec.paged ? ' tbl-fit' : ''}`}>
        <table>
          <thead>
            <tr>
              {vis.map(([c, i]) => (
                <th
                  key={c.key}
                  className={c.type !== 'text' ? 'num' : undefined}
                  style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => toggle(i)}
                  title={c.label === 'TL' ? 'TL = team lead. Click to sort.' : 'Click to sort'}
                >
                  {plainWords(c.label)}{sort && sort.i === i ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.key}>
                {vis.map(([c, i]) => (
                  <Cell
                    key={c.key}
                    col={c}
                    value={r.c[i]}
                    refs={r.refs}
                    compare={compare}
                    prev={r.p ? r.p[i] : undefined}
                    target={ofIdx(c) >= 0 ? r.c[ofIdx(c)] : undefined}
                    onDrill={() => onDrill(sec, r.key, c, r.c[0])}
                  />
                ))}
              </tr>
            ))}
            {sec.rows.length === 0 && (
              <tr><td colSpan={vis.length} style={{ padding: 0 }}>
                <EmptyState compact title="Nothing here for these filters." hint="Try a wider date range, or clear a filter." />
              </td></tr>
            )}
          </tbody>
          {sec.total && sec.rows.length > 0 && (
            <tfoot>
              <tr className="report-total">
                {vis.map(([c, i]) => (i === 0
                  ? <td key={c.key}><b>Total</b></td>
                  : (
                    <Cell
                      key={c.key}
                      col={c}
                      value={sec.total[i]}
                      compare={compare}
                      prev={sec.pt ? sec.pt[i] : undefined}
                      target={ofIdx(c) >= 0 ? sec.total[ofIdx(c)] : undefined}
                      onDrill={() => onDrill(sec, '__total__', c, 'Total')}
                    />
                  )))}
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
  const noun = data ? ({ req: 'jobs', cand: 'people', fu: 'follow-ups', inv: 'invoices', pay: 'payments' }[data.kind] || 'people') : '';
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
              ⬇ Download list
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </>
      )}
    >
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

// ATS layout v3 §5 — the charts of each report: ReportCharts.jsx (max 3,
// every mark opens its list). The old one-chart card and the Export ▾
// dropdown are gone (actions are separate buttons).

// The report filters (FILTER RULE 2026-10-03): options counted on the server
// over this report's own rows with every OTHER filter applied — cascading,
// with counts, no zero options (utils/atsFacets.js module 'reports').
const FACETS = [
  ['department', 'Department', 'All departments'],
  ['team', 'Team', 'All teams'],
  ['tl', 'Team lead (TL)', 'All team leads'],
  ['recruiter', 'Recruiter', 'All recruiters'],
  ['clientId', 'Client', 'All clients'],
  ['requirementId', 'Job', 'All jobs'],
  ['bde', 'Client manager (BDE)', 'All client managers'],
  ['stl', 'STL', 'All STLs'],
  ['source', 'Source', 'All sources'],
  ['location', 'Location', 'All locations'],
];
const REVENUE_FACETS = ['department', 'clientId'];
// B9.7: Recruiter revenue — the bar's Department / Client / Recruiter, cascading on the server.
const RECRUITER_REVENUE_FACETS = ['department', 'clientId', 'recruiter'];
const MONEY_TABS = ['revenue', 'recruiter-revenue'];
// Picking one level clears the levels inside it.
const CLEARS = {
  department: ['team', 'tl', 'recruiter', 'clientId', 'requirementId', 'bde', 'stl', 'location'],
  team: ['tl', 'recruiter'],
  tl: ['recruiter'],
  clientId: ['requirementId'],
};
const NO_FILTER_TABS = ['workflow', 'daily', 'jobportal', 'partners'];
// v3 colours on the cards: green good / yellow pending / red late or rejected.
const BAD_WORDS = /late|overdue|reject|pending|waiting|not add up|no joining|still to come|drop|no-show|did not/i;
function tileTone(label) {
  const l = String(label || '');
  if (/late|overdue|reject|not add up|no-show|drop/i.test(l)) return 'red';
  if (/pending|waiting|still to come|hold/i.test(l)) return 'yellow';
  if (/joined|received/i.test(l)) return 'green';
  return undefined;
}

// ATS layout v3 §5 — the SAME filter bar as every page (PageFilterBar:
// Department · Date range · Client · Recruiter / BDE), kept in the URL. These
// four live there; the panel keeps the rest (Team, TL, Job, Source …).
const BAR_KEYS = ['department', 'clientId', 'recruiter', 'bde'];
const PANEL_FACETS = FACETS.filter(([k]) => !BAR_KEYS.includes(k));
const BAR_URL_KEYS = ['department', 'range', 'from', 'to', 'clientId', 'recruiterId', 'bdeId'];
const PF_RANGE = { today: 'today', week: 'this_week', month: 'this_month' };
// The bar's value -> this report's filter keys. A person from the bar is the
// report's own facet value ("u:<id>" / "n:<name>"), or a plain user id.
const personOf = (v) => (!v ? '' : (/^(u|n|id|name):/.test(v) ? v : `id:${v}`));
function barFilters(pf) {
  const out = {
    department: pf.department || '', clientId: pf.clientId || '', recruiter: personOf(pf.recruiterId), bde: personOf(pf.bdeId),
    range: 'all', from: '', to: '',
  };
  if (PF_RANGE[pf.range]) out.range = PF_RANGE[pf.range];
  else if (pf.range) {
    const d = rangeDates(pf.range, pf.from, pf.to);
    if (d.from && d.to) Object.assign(out, { range: 'custom', from: d.from, to: d.to });
  }
  return out;
}

// fixedTab: one report embedded in another page (Accounts Reports shows
// Client revenue this way) — no landing page, no back link, no views.
export default function AtsReports({ fixedTab = '' } = {}) {
  const { user } = useAuth();
  const cat = useReportCatalog();
  const [params, setParams] = useSearchParams();
  const asked = fixedTab || params.get('tab');
  const legacyView = RECRUITMENT_VIEWS.includes(asked) ? asked : '';
  // No tab = the Reports landing page (the list of report cards).
  const tab = !asked ? '' : (TAB_IDS.includes(asked) ? asked : (OLD_TABS[asked] || (legacyView ? 'recruitment' : '')));
  const isRevenue = MONEY_TABS.includes(tab); // Client revenue + Recruiter revenue (B9.7): invoice reports, own routes + facets
  const canExport = isRevenue ? !!(cat && cat.revenue) : canExportReports(user, 'ATS Reports');
  // `draft` is what the filter panel shows; `filters` is what was applied.
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [compare, setCompare] = useState('');
  const [groupBy, setGroupBy] = useState(() => (legacyView ? { recruitment: legacyView } : {}));
  const [options, setOptions] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null);
  const [busy, setBusy] = useState('');
  const [denied, setDenied] = useState(false);
  const seq = useRef(0);
  const labels = useRef({});
  const [pf, setPf] = usePageFilters();
  const bar = barFilters(pf);
  // Switching report keeps the bar's filters (and which card it was opened from).
  const goTab = (id, extra = {}) => {
    const next = {};
    BAR_URL_KEYS.forEach((k) => { if (params.get(k)) next[k] = params.get(k); });
    const card0 = params.get('card');
    if (card0 && id) next.card = card0;
    setParams(id ? { ...next, ...extra, tab: id } : next);
  };
  // A new department / client on the bar clears the panel's levels inside it.
  const lastBar = useRef({ department: pf.department, clientId: pf.clientId });
  useEffect(() => {
    const was = lastBar.current;
    lastBar.current = { department: pf.department, clientId: pf.clientId };
    const clear = {};
    if (was.department !== pf.department) CLEARS.department.forEach((k) => { if (!BAR_KEYS.includes(k)) clear[k] = ''; });
    if (was.clientId !== pf.clientId) clear.requirementId = '';
    if (Object.keys(clear).length) { setDraft((d) => ({ ...d, ...clear })); setFilters((f) => ({ ...f, ...clear })); }
  }, [pf.department, pf.clientId]);

  // An old address lands on its tab, with the tab in the URL.
  useEffect(() => {
    if (!fixedTab && asked && asked !== tab) goTab(tab);
  }, [fixedTab, asked, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // The fixed lists (status, step, interview / AI / joining status).
  useEffect(() => {
    if (!tab || isRevenue || NO_FILTER_TABS.includes(tab) || options) return;
    api.get('/ats-reports/options').then((res) => setOptions(res.data)).catch(() => {});
  }, [tab, isRevenue, options]);

  const query = queryOf({ ...filters, ...bar }, { groupBy: groupBy[tab] || '', compare });
  const load = useCallback(() => {
    const mine = ++seq.current;
    // The landing page, the Workflow and the Daily report draw themselves.
    if (!tab || NO_FILTER_TABS.includes(tab)) { setLoading(false); return; }
    setLoading(true);
    api.get(`/ats-reports/${tab}?${query}`)
      .then((res) => { if (mine === seq.current) { setData(res.data); setError(''); setDenied(false); } })
      .catch((err) => {
        if (mine !== seq.current) return;
        setDenied(err.response?.status === 403);
        setError(err.response?.status === 403 ? 'This report isn’t part of your role.' : 'Couldn’t load this report — try again.');
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [tab, query]);
  useEffect(load, [load]);

  // Filter options with counts, for what the panel shows now.
  const facetParams = useMemo(
    () => Object.fromEntries(new URLSearchParams(queryOf({ ...draft, ...barFilters(pf) }, { report: tab, compare }))),
    [draft, tab, compare, pf],
  );
  const fac = useFacets('reports', facetParams, { enabled: !!tab && !NO_FILTER_TABS.includes(tab) });
  useEffect(() => {
    Object.entries(fac.facets || {}).forEach(([k, list]) => (list || []).forEach((o) => {
      if (o.count > 0 || !labels.current[`${k}:${o.value}`]) labels.current[`${k}:${o.value}`] = o.label;
    }));
  }, [fac.facets]);

  function set(patch) {
    setDraft((f) => {
      const next = { ...f, ...patch };
      Object.entries(CLEARS).forEach(([k, inside]) => {
        if (k in patch && patch[k] !== f[k]) inside.forEach((x) => { if (!(x in patch)) next[x] = ''; });
      });
      return next;
    });
  }
  const countOf = (f) => FILTER_KEYS.filter((k) => f[k] && !BAR_KEYS.includes(k)).length;
  const active = countOf(filters) + (compare ? 1 : 0);
  const dirty = queryOf({ ...draft, ...bar }) !== queryOf({ ...filters, ...bar });

  function openTile(t) {
    if (!t.drill || !t.value) return;
    setDrill({ tab, section: 'tiles', row: '', col: t.key, title: t.label, query });
  }
  function openCell(sec, rowKey, col, rowLabel) {
    setDrill({ tab, section: sec.id, row: rowKey, col: col.key, title: `${rowLabel} · ${col.label}`, query });
  }
  async function exportAs(format) {
    setBusy(format);
    const msg = await download(`/ats-reports/${tab}/export?${query}${query ? '&' : ''}format=${format}`, `report.${format}`);
    setBusy('');
    if (msg) setError(msg);
  }
  // One table only (server: ?section=<id>).
  async function exportTable(sec, format) {
    const msg = await download(`/ats-reports/${tab}/export?${query}${query ? '&' : ''}format=${format}&section=${encodeURIComponent(sec.id)}`, `report-${sec.id}.${format}`);
    if (msg) setError(msg);
  }

  // THE LANDING PAGE (redesign 2026-10-08) — the Reports & Analytics
  // overview (components/reports-v4) over the existing report endpoints,
  // then the same list of report cards as before ("All reports").
  // No Settings tab (user, 2026-10-03): settings live in Administration.
  if (!tab) {
    const landingQuery = (extra) => queryOf({ ...EMPTY, ...bar }, extra);
    const openFromOverview = (id, extra = {}, gb = '') => {
      if (gb) setGroupBy((m) => ({ ...m, [id]: gb }));
      const { card: cardId, ...rest } = extra;
      goTab(id, { ...rest, ...(cardId ? { card: cardId } : {}) });
    };
    const exportOverview = async (format) => {
      setBusy(format);
      const q = landingQuery({});
      const msg = await download(`/ats-reports/recruitment/export?${q}${q ? '&' : ''}format=${format}`, `report.${format}`);
      setBusy('');
      return msg;
    };
    return (
      <>
        <ReportsOverview
          pf={pf}
          setPf={setPf}
          queryFor={landingQuery}
          cat={cat}
          canExport={canExport}
          busy={busy}
          onExport={exportOverview}
          onDrill={(d) => setDrill(d)}
          onOpen={openFromOverview}
        >
          <ReportsHome embedded tabs={ATS_REPORT_TABS} onOpen={(id, cardId) => goTab(id, cardId ? { card: cardId } : {})} />
        </ReportsOverview>
        {drill && (
          <DrillModal tab={drill.tab} query={drill.query} target={drill} canExport={canExport} onClose={() => setDrill(null)} />
        )}
      </>
    );
  }

  const card = cardOfTab(tab, ATS_REPORT_TABS, params.get('card')) || { title: 'Report', answers: '', views: [[tab, tab]] };
  const views = (card.views || []).filter(([id]) => TAB_IDS.includes(id));
  const back = fixedTab ? null : <button type="button" className="rpv-back" onClick={() => goTab('')}>← All reports</button>;
  const viewSwitch = !fixedTab && views.length > 1 ? (
    <span className="rpv-views" role="tablist" aria-label="Views of this report">
      {views.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className={`rpv-view${tab === id ? ' on' : ''}`} onClick={() => goTab(id)}>{label}</button>
      ))}
    </span>
  ) : null;

  // A login the report refuses gets the refusal, not a filter bar for data
  // it will never be shown.
  if (denied && !NO_FILTER_TABS.includes(tab)) {
    return (
      <div className="atsrep">
        {back}
        <ListPageHeader title={card.title} question={card.answers || null} />
        <div className="notice">{error}</div>
      </div>
    );
  }

  const o = options || {};
  const labelOf = (key, v) => labels.current[`${key}:${v}`] || String(v).replace(/^(u|n|id|name):/, '');
  const labelIn = (list, v) => {
    const x = (list || []).find((y) => (typeof y === 'string' ? y === v : y.id === v));
    return x ? (typeof x === 'string' ? x : x.label) : v;
  };
  const drop = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setDraft((d) => ({ ...d, ...patch }));
  };
  // The panel's facets — the bar holds Department / Client / Recruiter / BDE.
  const facetKeys = isRevenue ? (tab === 'recruiter-revenue' ? RECRUITER_REVENUE_FACETS : REVENUE_FACETS).filter((k) => !BAR_KEYS.includes(k)) : PANEL_FACETS.map(([k]) => k);
  const chips = [
    compare && { key: 'compare', label: 'Compare', value: (COMPARE_CHOICES.find(([id]) => id === compare) || [])[1], onRemove: () => setCompare('') },
    ...FACETS.filter(([k]) => facetKeys.includes(k)).map(([k, label]) => ({
      key: k, label, value: filters[k] && labelOf(k, filters[k]), onRemove: () => drop({ [k]: '', ...Object.fromEntries((CLEARS[k] || []).map((x) => [x, ''])) }),
    })),
    ...(isRevenue ? [] : [
      { key: 'status', label: 'Status', value: filters.status && labelIn(o.statuses, filters.status), onRemove: () => drop({ status: '' }) },
      { key: 'stage', label: 'Step', value: filters.stage && labelIn(o.stages, filters.stage), onRemove: () => drop({ stage: '' }) },
      { key: 'interviewStatus', label: 'Interview', value: filters.interviewStatus && labelIn(o.interviewStatuses, filters.interviewStatus), onRemove: () => drop({ interviewStatus: '' }) },
      { key: 'aiStatus', label: 'AI interview', value: filters.aiStatus && labelIn(o.aiStatuses, filters.aiStatus), onRemove: () => drop({ aiStatus: '' }) },
      { key: 'joiningStatus', label: 'Joining', value: filters.joiningStatus && labelIn(o.joiningStatuses, filters.joiningStatus), onRemove: () => drop({ joiningStatus: '' }) },
      { key: 'people', label: 'People', value: filters.people && labelIn(PEOPLE_CHOICES, filters.people), onRemove: () => drop({ people: '' }) },
    ]),
  ].filter((c) => c && c.value);
  // A fixed list in the panel; an empty list is not offered.
  const pick = (key, label, list, allLabel) => (!(list || []).length && !draft[key] ? null : (
    <PanelField label={label}>
      <Combo value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} title={label}>
        <option value="">{allLabel}</option>
        {(list || []).map((x) => (typeof x === 'string'
          ? <option key={x} value={x}>{x}</option>
          : <option key={x.id} value={x.id}>{x.label}</option>))}
      </Combo>
    </PanelField>
  ));
  const clearAll = () => { setDraft(EMPTY); setFilters(EMPTY); setCompare(''); };
  const ff = fac.facets || {};
  const barOptions = {
    department: ff.department || [],
    clientId: ff.clientId || [],
    people: isRevenue ? [] : [
      ...(ff.recruiter || []).filter((x) => x.value !== '—').map((x) => ({ ...x, value: `rec:${x.value}`, group: 'Recruiters' })),
      ...(ff.bde || []).filter((x) => x.value !== '—').map((x) => ({ ...x, value: `bde:${x.value}`, group: 'Client managers (BDE)' })),
    ],
  };
  const hasPanel = !isRevenue || facetKeys.length > 0;
  // Max 6 cards (v3); the rest of the report's numbers one click away.
  const [moreTiles, setMoreTiles] = [params.get('more') === '1', (on) => setParams((p0) => { const p1 = new URLSearchParams(p0); if (on) p1.set('more', '1'); else p1.delete('more'); return p1; }, { replace: true })];
  const scopeLine = data && data.scope ? (
    <>
      Your area: <b>{data.scope}</b>
      {' · '}
      {data.compare ? `${data.compare.cur.label} vs ${data.compare.prev.label}` : data.period.label}
      {loading ? ' · updating…' : ''}
    </>
  ) : null;

  return (
    <div className="atsrep">
      {back}
      {/* Excel and PDF are two separate buttons (no dropdown), with the
          filters applied — GET /ats-reports/:tab/export. */}
      <ListPageHeader
        title={card.title}
        question={card.answers || null}
        sub={NO_FILTER_TABS.includes(tab) ? null : scopeLine}
        data={canExport && !NO_FILTER_TABS.includes(tab) ? <ExportButtons busy={busy} onPick={exportAs} /> : null}
      />

      {NO_FILTER_TABS.includes(tab) ? (
        <>
          {viewSwitch && <div style={{ marginBottom: 10 }}>{viewSwitch}</div>}
          {tab === 'workflow' ? <WorkflowDiagram /> : tab === 'jobportal' ? <JobPortalReports embedded /> : tab === 'partners' ? <PartnersReport canExport={canExport} /> : <DailyReport />}
        </>
      ) : (<>
      {/* The same filters as every page (ATS layout v3): Department · Date
          range · Client · Recruiter / BDE — cascading, with counts. */}
      <div className="rpv-filters">
        <PageFilterBar
          value={pf}
          onChange={setPf}
          options={barOptions}
          show={{ dateRange: !compare, people: tab !== 'revenue' }}
        />
        {compare && <span className="small-muted">Compare is on — it shows {compare === 'quarter' ? 'this quarter and last quarter' : 'this month and last month'}.</span>}
      </div>
      {/* The report's views, More filters, Compare. Then the chips. */}
      <ListToolbar
        className="atsrep-bar"
        filterCount={active}
        chips={chips}
        onClearAll={countOf(draft) || active ? clearAll : undefined}
        right={<span className="rpv-right">{viewSwitch}<CompareToggle value={compare} onChange={setCompare} /></span>}
        panelFooter={(
          <>
            {dirty && <span className="small-muted">Not applied yet</span>}
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => setFilters(draft)}>Apply filters</button>
          </>
        )}
        panel={hasPanel ? (
          <>
            {FACETS.filter(([k]) => facetKeys.includes(k)).map(([k, label, allLabel]) => {
              const list = (fac.facets || {})[k] || [];
              // One choice only is no choice: not drawn unless it is set.
              if (list.filter((x) => x.count > 0).length < 2 && !draft[k]) return null;
              return <FacetSelect key={k} label={label} value={draft[k]} onChange={(v) => set({ [k]: v })} options={list} allLabel={allLabel} loading={fac.loading} />;
            })}
            {!isRevenue && (
              <>
                {pick('status', 'Status', o.statuses, 'Any status')}
                {pick('stage', 'Step', o.stages, 'Any step')}
                {['interviews', 'clients', 'sla'].includes(tab) && pick('interviewStatus', 'Interview', o.interviewStatuses, 'Any interview')}
                {tab === 'ai' && pick('aiStatus', 'AI interview', o.aiStatuses, 'Any AI interview')}
                {['joining', 'timetofill'].includes(tab) && pick('joiningStatus', 'Joining', o.joiningStatuses, 'Any joining')}
                {tab === 'recruiters' && pick('people', 'Active / Former', PEOPLE_CHOICES, 'Everyone (active + former)')}
              </>
            )}
          </>
        ) : null}
      />

      {error && (
        <div className="notice red" style={{ marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => { setError(''); load(); }}>Try again</button>
        </div>
      )}
      {!data && !error && <div className="small-muted">Loading the report…</div>}

      {data && data.report === tab && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          {/* Max six cards (v3); the report's other numbers one click away. */}
          {(() => {
            const card1 = (t) => {
              const clickable = t.drill && t.value > 0;
              const pctChange = data.compare && !t.now && t.type !== 'pct' && Number(t.prev) > 0
                ? ((Number(t.value) - Number(t.prev)) / Number(t.prev)) * 100 : null;
              return (
                <StatCard
                  key={t.key}
                  label={plainWords(t.label)}
                  help={tileHelp(t.label)}
                  value={t.value === null || t.value === undefined ? null : (t.type === 'pct' || t.type === 'money' ? (t.value === 0 ? 0 : fmt(t.value, t.type)) : t.value)}
                  zeroText="None yet"
                  tone={tileTone(t.label)}
                  upIsGood={!BAD_WORDS.test(t.label)}
                  delta={pctChange}
                  deltaLabel={data.compare ? `vs ${data.compare.prev.label}` : undefined}
                  hint={t.sub ? plainWords(t.sub) : undefined}
                  onClick={clickable ? () => openTile(t) : undefined}
                  title={clickable ? 'Show who is behind this number' : undefined}
                />
              );
            };
            const head = data.tiles.slice(0, 6);
            const rest = data.tiles.slice(6);
            return (
              <>
                <StatRow>{head.map(card1)}</StatRow>
                {rest.length > 0 && (
                  <button type="button" className="rpv-more-tiles" onClick={() => setMoreTiles(!moreTiles)} aria-expanded={moreTiles}>
                    {moreTiles ? 'Fewer numbers ▲' : `More numbers (${rest.length}) ▼`}
                  </button>
                )}
                {moreTiles && rest.length > 0 && (
                  <div className="rpv-tiles-extra">
                    {Array.from({ length: Math.ceil(rest.length / 6) }, (_, i) => <StatRow key={i}>{rest.slice(i * 6, i * 6 + 6).map(card1)}</StatRow>)}
                  </div>
                )}
              </>
            );
          })()}

          {data.counts && data.counts.applications === 0 && data.counts.requirements === 0 && (
            <EmptyState
              title={isRevenue ? 'No invoices for these filters.' : 'Nothing happened in this period.'}
              hint="Try a wider date range, or clear a filter."
              action={bar.range !== 'all' || active
                ? <button type="button" className="btn btn-sm" onClick={() => { clearAll(); setPf({}); }}>Show all time, no filters</button>
                : null}
            />
          )}

          {/* Max three charts, each mark opening its list in place. */}
          <ReportCharts key={`${tab}-${data.sections.map((x) => x.groupBy || '').join('')}`} tab={tab} data={data} onDrill={openCell} />

          {tab === 'rejections' && <SameClientRule />}
          {data.notes.map((n) => <div key={n} className={`notice${data.plain ? '' : ' amber'}`} style={{ marginBottom: 12 }}>{plainWords(n)}</div>)}

          {data.sections.map((s) => (
            <Section
              key={`${tab}-${s.id}-${s.groupBy || ''}`}
              sec={s}
              compare={!!data.compare}
              onDrill={openCell}
              onGroupBy={(g) => setGroupBy((m) => ({ ...m, [tab]: g }))}
              onExport={canExport ? exportTable : null}
            />
          ))}

          <div className="rpv-tip">
            Click any blue number to see who is behind it. {data.dateBasis}
          </div>
          {/* ATS-100 B6: costs, campus drives, referrals + bonuses — below the tables. */}
          {tab === 'campaigns' && <SourcingManager />}
        </div>
      )}

      {drill && (
        <DrillModal tab={drill.tab} query={drill.query} target={drill} canExport={canExport} onClose={() => setDrill(null)} />
      )}
      </>)}
    </div>
  );
}
