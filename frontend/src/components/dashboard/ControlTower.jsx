import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api';
import DrillExport, { useDrillRight } from '../DrillExport.jsx';
import './controlTower.css';

// ---------------------------------------------------------------------------
// THE 360° CONTROL TOWER (founder, 2026-10-23): the Super Admin / Admin home. ONE server call (GET /api/dashboard/control-tower, utils/controlTower.js).
//
// NO NAVIGATION (founder rule): whatever is clicked - a figure, a pipeline step, a chart month, an attention row, an integration, a health check,
// an activity row - opens its details in a SIDE DRAWER on this same page. The address never changes, the dashboard (and its scroll position)
// stays underneath, closing the drawer (X, Esc, or a click outside) shows the overview exactly as it was. The drawer has search, filters, sorting
// and paging, all done on the server (GET /api/dashboard/control-tower/list, utils/controlTowerLists.js), and each row opens to its full detail.
// Nothing here imports a router, calls navigate() or links to another page.
// Rules kept: every figure shows its scope word and a definition on hover; nothing is drawn without data behind it; a failed read says so with Try again.
// ---------------------------------------------------------------------------
const inr0 = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const lakhs = (n) => (Math.abs(n) >= 100000 ? `₹${(n / 100000).toFixed(2)}L` : inr0(n));
const num = (n) => Number(n || 0).toLocaleString('en-IN');
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }); };
const stamp = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`; };
const dmy = (v) => { if (!v) return '-'; const s = String(v); const d = new Date(s.length === 10 ? `${s}T00:00:00` : s); return Number.isNaN(d.getTime()) ? s : `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
const dmyHm = (v) => { const d = new Date(v); return !v || Number.isNaN(d.getTime()) ? '-' : `${dmy(v)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const ICON = {
  employees: 'M16 11a3 3 0 100-6 3 3 0 000 6zM8 11a3 3 0 100-6 3 3 0 000 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z',
  requirements: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a7 7 0 110 14 7 7 0 010-14zm0 3a4 4 0 100 8 4 4 0 000-8zm0 2.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z',
  candidates: 'M12 12a4.5 4.5 0 100-9 4.5 4.5 0 000 9zm0 2c-3 0-9 1.5-9 4.5V21h18v-2.5C21 15.5 15 14 12 14z',
  pending: 'M12 2a10 10 0 100 20 10 10 0 000-20zm-1.2 14.4L6.6 12.2 8 10.8l2.8 2.8 5.2-5.2 1.4 1.4-6.6 6.6z',
  receivables: 'M6 4h12v2.5h-3.1c.7.6 1.2 1.4 1.4 2.5H18V11h-1.7c-.4 3-2.5 5-6 5H9.5l7 5h-3L7 16.200V15h3.500c2.100 0 3.300-1.100 3.600-3H7V9h6.500c-.3-1.500-1.300-2.500-3.500-2.500H7V4z',
};
const Svg = ({ d, size = 22 }) => (<svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"><path d={d} fill="currentColor" /></svg>);
const TONE_OF = { employees: 'violet', requirements: 'green', candidates: 'blue', pending: 'amber', receivables: 'purple' };

// ---------------------------------------------------------------------------------------------- the drawer
const GOOD = /^(connected|active|open|paid|joined|selected|offer accepted)$/i;
const BAD = /(overdue|failed|rejected|needs attention|error|unmatched)/i;
const WARN = /(pending|partially|notice|hold|not connected|interview|new)/i;
const tone = (v) => (BAD.test(v) ? 'bad' : GOOD.test(v) ? 'good' : WARN.test(v) ? 'warn' : 'plain');
function cell(c, v) {
  if (v === null || v === undefined || v === '') return '-';
  if (c.type === 'date') return dmy(v);
  if (c.type === 'datetime') return dmyHm(v);
  if (c.type === 'money') return `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  if (c.type === 'num') return Number(v).toLocaleString('en-IN');
  if (c.type === 'status') return <span className={`ct-badge ${tone(String(v))}`}>{String(v).replace(/_/g, ' ')}</span>;
  return String(v);
}

function Drawer({ panel, onClose }) {
  const [state, setState] = useState({ q: '', filter: panel.filter || '', sort: '', dir: 'desc', page: 1 });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [openRow, setOpenRow] = useState(panel.open || null);
  const [qDeb, setQDeb] = useState('');
  const closeRef = useRef(null);
  const seq = useRef(0);
  useEffect(() => { const t = setTimeout(() => setQDeb(state.q), 300); return () => clearTimeout(t); }, [state.q]);
  const load = useCallback(() => {
    const mine = (seq.current += 1);
    setBusy(true); setError('');
    api.get('/dashboard/control-tower/list', { params: { set: panel.set, stage: panel.stage || undefined, month: panel.month || undefined, open: panel.open || undefined, q: qDeb || panel.q || undefined, filter: state.filter || undefined, sort: state.sort || undefined, dir: state.sort ? state.dir : undefined, page: state.page } })
      .then((r) => { if (mine === seq.current) setData(r.data); })
      .catch((e) => { if (mine === seq.current) setError(e.response?.data?.error || 'These details could not be loaded.'); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [panel.set, panel.stage, panel.month, panel.open, panel.q, qDeb, state.filter, state.sort, state.dir, state.page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setState((s) => ({ ...s, page: 1 })); }, [qDeb]);
  useEffect(() => {
    const prev = document.activeElement;
    if (closeRef.current) closeRef.current.focus();
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); if (prev && prev.focus) prev.focus(); }; // focus goes back to what was clicked
  }, [onClose]);
  const sortBy = (c) => { if (!c.sort) return; setState((s) => ({ ...s, sort: c.sort, dir: s.sort === c.sort && s.dir === 'desc' ? 'asc' : (s.sort === c.sort ? 'desc' : 'asc'), page: 1 })); };
  const rows = (data && data.rows) || [];
  const cols = (data && data.columns) || [];
  const mayExport = useDrillRight('admin');
  // The file holds every page of the list for the search / filter picked (not only the page on the screen).
  async function buildFile() {
    const base = { set: panel.set, stage: panel.stage || undefined, month: panel.month || undefined, open: panel.open || undefined, q: qDeb || panel.q || undefined, filter: state.filter || undefined, sort: state.sort || undefined, dir: state.sort ? state.dir : undefined };
    const all = [];
    const last = Math.max(1, (data && data.pages) || 1);
    for (let p = 1; p <= last; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = p === data.page ? data : (await api.get('/dashboard/control-tower/list', { params: { ...base, page: p } })).data;
      all.push(...(r.rows || []));
    }
    const plain = (c, v) => (v === null || v === undefined || v === '' ? '' : c.type === 'date' ? String(v).slice(0, 10) : c.type === 'datetime' ? String(v).replace('T', ' ').slice(0, 16) : c.type === 'status' ? String(v).replace(/_/g, ' ') : v);
    return { headers: cols.map((c) => c.label), rows: all.map((r) => cols.map((c) => plain(c, r.c[c.key]))) };
  }
  return (
    <div className="ct-drawer-wrap" role="presentation">
      <button type="button" className="ct-backdrop" aria-label="Close the details" onClick={onClose} tabIndex={-1} />
      <aside className="ct-drawer" role="dialog" aria-modal="true" aria-label={(data && data.title) || panel.title}>
        <header className="ct-d-head">
          <div>
            <h2>{(data && data.title) || panel.title}</h2>
            {data && data.sub && <p>{data.sub}</p>}
          </div>
          <button type="button" ref={closeRef} className="btn btn-sm" onClick={onClose} aria-label="Close the details">✕ Close</button>
        </header>
        <div className="ct-d-tools">
          <input type="search" className="ct-d-search" placeholder="Search…" value={state.q} onChange={(e) => setState((s) => ({ ...s, q: e.target.value }))} aria-label="Search these details" />
          {data && data.filters && data.filters.map((f) => (
            <label key={f.key} className="ct-d-filter"><span>{f.label}</span>
              <select value={state.filter || f.value} onChange={(e) => setState((s) => ({ ...s, filter: e.target.value, page: 1 }))}>
                {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          ))}
          <span className="ct-d-count">{data ? `${num(data.total)} record${data.total === 1 ? '' : 's'}` : ''}{busy ? ' · loading…' : ''}</span>
          {data && rows.length > 0 && <DrillExport name={data.title || panel.title} allowed={mayExport} disabled={busy} build={buildFile} />}
        </div>
        <div className="ct-d-body">
          {error && <div className="notice red"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>}
          {!error && data && !rows.length && !busy && <div className="ct-d-empty">Nothing here{state.q ? ' for this search' : ''}.</div>}
          {rows.length > 0 && (
            <div className="tbl-wrap ct-d-table">
              <table>
                <thead><tr>{cols.map((c) => (
                  <th key={c.key} className={`${c.sort ? 'ct-sortable' : ''} ${c.type === 'money' || c.type === 'num' ? 'num' : ''}`} onClick={() => sortBy(c)} aria-sort={state.sort === c.sort && c.sort ? (state.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.label}{c.sort && state.sort === c.sort ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}<th aria-label="Details" /></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const open = openRow === r.id;
                    const det = (r.d || []).filter(([, v]) => v !== null && v !== undefined && v !== '');
                    return (
                      <FragmentRow key={r.id} open={open} onToggle={() => setOpenRow(open ? null : r.id)} cols={cols} r={r} det={det} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {data && data.pages > 1 && (
          <footer className="ct-d-pager">
            <button type="button" className="btn btn-sm" disabled={state.page <= 1 || busy} onClick={() => setState((s) => ({ ...s, page: s.page - 1 }))}>‹ Previous</button>
            <span>Page {data.page} of {data.pages}</span>
            <button type="button" className="btn btn-sm" disabled={state.page >= data.pages || busy} onClick={() => setState((s) => ({ ...s, page: s.page + 1 }))}>Next ›</button>
          </footer>
        )}
      </aside>
    </div>
  );
}

function FragmentRow({ open, onToggle, cols, r, det }) {
  return (
    <>
      <tr className={`ct-d-row${open ? ' open' : ''}`} onClick={onToggle} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }} aria-expanded={open}>
        {cols.map((c) => <td key={c.key} className={c.type === 'money' || c.type === 'num' ? 'num' : ''}>{cell(c, r.c[c.key])}</td>)}
        <td className="ct-d-caret" aria-hidden="true">{open ? '▾' : '▸'}</td>
      </tr>
      {open && (
        <tr className="ct-d-detail"><td colSpan={cols.length + 1}>
          <dl>
            {cols.map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{cell(c, r.c[c.key])}</dd></div>)}
            {det.map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{String(v)}</dd></div>)}
          </dl>
        </td></tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- the overview
function Tile({ k, onShow }) {
  const value = k.money ? lakhs(k.value) : num(k.value);
  return (
    <button type="button" className={`ct-kpi ct-${TONE_OF[k.key] || 'blue'}`} onClick={() => onShow({ set: k.set, title: k.label })} title={k.definition} aria-label={`${k.label}: ${value}. ${k.sub}. ${k.scope}. Click to view details.`}>
      <span className="ct-kpi-ic"><Svg d={ICON[k.key] || ICON.pending} /></span>
      <span className="ct-kpi-body">
        <span className="ct-kpi-label">{k.label}</span>
        <span className="ct-kpi-value">{value}</span>
        <span className="ct-kpi-sub">{k.sub}</span>
        <span className="ct-kpi-hint">Click to view details ↓</span>
      </span>
      <span className="ct-scope">{k.scope}</span>
    </button>
  );
}

function Cash({ cash, onShow }) {
  const W = 340; const H = 130; const L = 36; const B = 22; const T = 8; const R = 8;
  const max = Math.max(1, ...cash.months.map((m) => m.amount));
  const step = max <= 100000 ? 25000 : max <= 400000 ? 100000 : 200000;
  const top = Math.ceil(max / step) * step || step;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, cash.months.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const pts = cash.months.map((m, i) => `${x(i)},${y(m.amount)}`).join(' ');
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  return (
    <div className="ct-card ct-cash">
      <div className="ct-card-head"><b>Cash collection</b><span className="ct-chip" title={cash.definition}>{cash.scope}</span></div>
      <button type="button" className="ct-cash-big" onClick={() => onShow({ set: 'cash', title: 'Cash received' })}>{`₹${Number(cash.receivedAllTime).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}<small>Received (all time) · click for the payments</small></button>
      <svg viewBox={`0 0 ${W} ${H}`} className="ct-chart" role="group" aria-label="Cash received per month, last 6 months. Click a month for its payments.">
        {ticks.map((v) => (<g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="ct-grid" /><text x={L - 4} y={y(v) + 3} textAnchor="end" className="ct-axis">{v === 0 ? '0' : `${Math.round(v / 1000)}k`}</text></g>))}
        <polyline points={pts} className="ct-line" fill="none" />
        {cash.months.map((m, i) => (
          <g key={m.key} className="ct-pt" role="button" tabIndex={0} aria-label={`${m.label}: ${inr0(m.amount)}. Click for the payments.`} onClick={() => onShow({ set: 'cash', month: m.key, title: `Cash received in ${m.label}` })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShow({ set: 'cash', month: m.key, title: `Cash received in ${m.label}` }); } }}>
            <circle cx={x(i)} cy={y(m.amount)} r="11" className="ct-hit"><title>{`${m.label}: ${inr0(m.amount)}`}</title></circle>
            <circle cx={x(i)} cy={y(m.amount)} r="3.5" className="ct-dot" />
            <text x={x(i)} y={H - 6} textAnchor="middle" className="ct-axis">{m.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function ControlTower() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showChecks, setShowChecks] = useState(false);
  const [panel, setPanel] = useState(null);
  const mayExport = useDrillRight('admin');
  const load = useCallback(() => {
    setBusy(true); setError('');
    api.get('/dashboard/control-tower').then((r) => setD(r.data)).catch((e) => setError(e.response?.data?.error || 'The Control Tower could not be loaded.')).finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 120000); // quietly refresh every 2 minutes while the tab is open
    return () => clearInterval(t);
  }, [load]);
  const show = useCallback((p) => { setShowChecks(false); setPanel(p); }, []);
  const hide = useCallback(() => setPanel(null), []);

  if (error && !d) return <div className="notice red ct-err"><span>{error} <button type="button" className="link-btn" onClick={load}>Try again</button></span></div>;
  if (!d) return <div className="ct-loading">Loading the Control Tower…</div>;
  const dh = d.dataHealth;
  const failing = dh.checks.filter((c) => !c.ok);
  // The whole page as one file (founder 2026-10-24: an Export on this dashboard too): every figure on the screen, section by section.
  const buildPage = () => {
    const rows = [];
    const add = (section, item, value, note = '') => rows.push([section, item, value === null || value === undefined ? '' : value, note]);
    d.kpis.forEach((k) => add('Overview', k.label, k.value, [k.sub, k.scope].filter(Boolean).join(' · ')));
    d.attention.forEach((r) => add('Needs attention now', r.title, r.count, [r.unit, r.money ? inr0(r.money) : '', `Owner: ${r.owner}`, r.scope].filter(Boolean).join(' · ')));
    d.pipeline.stages.forEach((s) => add('Hiring pipeline', s.label, s.count, `${s.pct}% of ${d.pipeline.total} applications`));
    add('Hiring pipeline', 'Rejected (outside the chain)', d.pipeline.outside.rejected);
    add('Hiring pipeline', 'On hold (outside the chain)', d.pipeline.outside.hold);
    add('Cash collection', 'Received (all time)', d.cash.receivedAllTime, d.cash.scope);
    d.cash.months.forEach((m) => add('Cash collection', m.label, m.amount));
    add('System & integrations health', 'Connected', d.integrations.connected);
    add('System & integrations health', 'Needs attention', d.integrations.errors);
    add('System & integrations health', 'Not connected', d.integrations.notConnected);
    d.integrations.top.forEach((t) => add('Top connection issues', t.name, t.state, t.note));
    dh.checks.forEach((c) => add('Data health', c.label, c.ok ? 'OK' : 'Needs attention', c.detail));
    d.activity.forEach((a) => add('Recent critical activity', `${stamp(a.at)} · ${a.area}`, a.event, a.owner));
    return { headers: ['Section', 'Item', 'Value', 'Note'], rows };
  };
  return (
    <section className="ct" aria-label="360 degree Control Tower">
      <header className="ct-head">
        <div>
          <h1>360° Control Tower</h1>
          <p>Company-wide health, priorities and outcomes</p>
        </div>
        <div className="ct-head-r">
          <span className="ct-meta" title="When these figures were read from the database"><span aria-hidden="true">🕒</span> Last updated <b>{clock(d.generatedAt)}</b></span>
          <button type="button" className={`ct-meta ct-health ${failing.length ? 'warn' : 'ok'}`} onClick={() => setShowChecks((v) => !v)} aria-expanded={showChecks} title="Real checks of the data and the connections: click to see each one">
            <span className="ct-dotc" aria-hidden="true" /> Data health: <b>{dh.passing} of {dh.total} checks OK</b>
          </button>
          <span className={`ct-meta ct-need${d.needsAttention ? ' on' : ''}`}><span aria-hidden="true">⚠</span> {d.needsAttention} item{d.needsAttention === 1 ? '' : 's'} need attention</span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={load}>{busy ? 'Refreshing…' : 'Refresh'}</button>
          <DrillExport name="360 Control Tower" allowed={mayExport} build={buildPage} title="Download everything on this dashboard as one file (opens in Excel)" />
        </div>
      </header>
      {error && <div className="notice red" style={{ marginBottom: 8 }}><span>{error} (showing the last figures)</span></div>}

      <div className="ct-kpis">{d.kpis.map((k) => <Tile key={k.key} k={k} onShow={show} />)}</div>

      <div className="ct-grid2">
        <div className="ct-col">
          <div className="ct-card ct-attn">
            <div className="ct-card-head ct-attn-head"><b><span aria-hidden="true" className="ct-bang">!</span> Needs attention now</b><span className="ct-sub">Not date-filtered · every number opens its details here</span></div>
            <ul className="ct-rows">
              {d.attention.map((r) => (
                <li key={r.key} className={`ct-row ${r.count > 0 ? r.tone : 'zero'}`}>
                  <div className="ct-row-t"><b>{r.title}</b><span>{r.sub}</span><span className="ct-owner">Owner: {r.owner}</span></div>
                  <div className="ct-row-n"><b>{num(r.count)}</b><span>{r.unit}{r.money ? ` · ${inr0(r.money)}` : ''}</span><em>{r.scope}</em></div>
                  <button type="button" className="btn btn-sm ct-act" onClick={() => show({ set: r.set, title: r.title })}>{r.action} ›</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="ct-two">
            <div className="ct-card ct-pipe">
              <div className="ct-card-head"><b>Hiring pipeline</b><span className="ct-sub" title={d.pipeline.definition}>{num(d.pipeline.total)} applications · {d.pipeline.scope}</span></div>
              <div className="ct-chevrons">
                {d.pipeline.stages.map((s, i) => (
                  <button type="button" key={s.key} className={`ct-chev c${i}`} onClick={() => show({ set: s.set, stage: s.stage, title: `Hiring pipeline: ${s.label}` })} title={`${s.label}: ${num(s.count)} (${s.pct}%). Click for the list.`}>
                    <b>{num(s.count)}</b><span>{s.label}</span>
                    <small>{s.pct}%</small>
                  </button>
                ))}
              </div>
              <p className="ct-note">Where applications are today. Rejected {num(d.pipeline.outside.rejected)} and On hold {num(d.pipeline.outside.hold)} sit outside this chain.</p>
            </div>
            <Cash cash={d.cash} onShow={show} />
          </div>
        </div>

        <div className="ct-col">
          <div className="ct-card ct-int">
            <div className="ct-card-head"><b>System &amp; integrations health</b><span className="ct-chip" title={d.integrations.definition}>Now</span></div>
            <div className="ct-int3">
              <button type="button" className="ct-stat ok" onClick={() => show({ set: 'integrations', filter: 'Connected', title: 'Connected integrations' })}><span>Connected</span><b>{d.integrations.connected}</b></button>
              <button type="button" className="ct-stat err" onClick={() => show({ set: 'integrations', filter: 'Needs attention', title: 'Integrations that need attention' })}><span>Needs attention</span><b>{d.integrations.errors}</b></button>
              <button type="button" className="ct-stat off" onClick={() => show({ set: 'integrations', filter: 'Not connected', title: 'Integrations not connected' })}><span>Not connected</span><b>{d.integrations.notConnected}</b></button>
            </div>
            <div className="ct-issues">
              <b>Top connection issues</b>
              {d.integrations.top.map((t) => (
                <button type="button" key={t.id} className="ct-issue" onClick={() => show({ set: 'integrations', q: t.name, title: t.name })}>
                  <span className="ct-iname">{t.name}</span><span className="ct-inote" title={t.note}>{t.note}</span><span className={`ct-istate ${t.state === 'Needs attention' ? 'err' : 'off'}`}>{t.state}</span>
                </button>
              ))}
              <button type="button" className="link-btn" onClick={() => show({ set: 'integrations', title: 'Integrations' })}>View all integrations →</button>
            </div>
          </div>
          <div className="ct-card ct-dh" id="ct-checks">
            <div className="ct-card-head"><b>Data health</b><span className="ct-sub">{dh.passing} of {dh.total} checks OK</span></div>
            <ul className="ct-checks">
              {dh.checks.map((c) => (
                <li key={c.key} className={c.ok ? 'ok' : 'bad'}>
                  <span className="ct-tick" aria-hidden="true">{c.ok ? '✓' : '!'}</span>
                  <button type="button" className="link-btn" onClick={() => show({ set: c.set, filter: c.filter, title: c.label })}>{c.label}</button>
                  <em>{c.detail}</em>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="ct-card ct-act-card">
        <div className="ct-card-head"><b>Recent critical activity</b><button type="button" className="link-btn" onClick={() => show({ set: 'audit', title: 'Recent activity' })}>View all →</button></div>
        {!d.activity.length ? <div className="ct-note" style={{ padding: 12 }}>Nothing recorded yet.</div> : (
          <div className="tbl-wrap" style={{ border: 0 }}>
            <table>
              <thead><tr><th>Time</th><th>Area</th><th>Event</th><th>Owner</th></tr></thead>
              <tbody>{d.activity.map((a) => (
                <tr key={a.id} className="ct-d-row" tabIndex={0} onClick={() => show({ set: 'audit', open: a.id, title: 'Recent activity' })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show({ set: 'audit', open: a.id, title: 'Recent activity' }); } }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{stamp(a.at)}</td><td><span className="ct-area">{a.area}</span></td><td>{a.event}</td><td>{a.owner}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
      {showChecks && (
        <div className="ct-pop" role="dialog" aria-label="Data health checks">
          <b>Data health: {dh.passing} of {dh.total} checks OK</b>
          <ul>{dh.checks.map((c) => <li key={c.key} className={c.ok ? 'ok' : 'bad'}>{c.ok ? '✓' : '!'} <button type="button" className="link-btn" onClick={() => show({ set: c.set, filter: c.filter, title: c.label })}>{c.label}</button>: <em>{c.detail}</em></li>)}</ul>
          <button type="button" className="btn btn-sm" onClick={() => setShowChecks(false)}>Close</button>
        </div>
      )}
      {panel && <Drawer key={`${panel.set}|${panel.stage || ''}|${panel.month || ''}|${panel.filter || ''}|${panel.q || ''}|${panel.open || ''}`} panel={panel} onClose={hide} />}
    </section>
  );
}
