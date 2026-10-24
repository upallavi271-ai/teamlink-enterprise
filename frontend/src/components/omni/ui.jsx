import { useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL UI KIT: the small building blocks of the Green Start prototype, with the prototype's own class names (gs.css, scoped under .gsx).
// Every Omni-Channel page is made from these, so every page has the same look: PageHead, Btn, Kpi, Panel, Pill, Tag, Tabs, DataTable, Empty,
// GsModal, Field, NotConnected, Banner. Wording rules: never the word "Draft" on screen (the pill class stays, the text is "Not sent yet").
// ---------------------------------------------------------------------------
export const fmtNum = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en-IN'));
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '—');
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

export function PageHead({ eyebrow, title, lead, children }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {lead && <div className="lead">{lead}</div>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Btn({ primary, danger, ghost, dark, small, className = '', children, ...rest }) {
  const cls = `btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}${ghost ? ' ghost' : ''}${dark ? ' dark' : ''}${small ? ' small' : ''} ${className}`.trim();
  return <button type="button" className={cls} {...rest}>{children}</button>;
}
export function TinyBtn({ className = '', children, ...rest }) { return <button type="button" className={`tiny-btn ${className}`.trim()} {...rest}>{children}</button>; }

export function Kpi({ label, icon = '◈', value, meta, tone, onClick, hint }) {
  return (
    <div className="card kpi" onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={(e) => { if (onClick && e.key === 'Enter') onClick(); }} title={hint}>
      <div className="kpi-head"><span>{label}</span><span className="kpi-icon">{icon}</span></div>
      <div className="kpi-value">{value}</div>
      {meta !== undefined && meta !== null && meta !== '' && <div className={`kpi-meta ${tone || 'neutral'}`}>{meta}</div>}
    </div>
  );
}
export const Kpis = ({ children }) => <div className="grid kpis">{children}</div>;

export function Panel({ title, sub, right, children, className = '', style }) {
  return (
    <div className={`card panel ${className}`.trim()} style={style}>
      {(title || right) && <div className="panel-top"><div>{title && <div className="panel-title">{title}</div>}{sub && <div className="panel-sub">{sub}</div>}</div>{right}</div>}
      {children}
    </div>
  );
}

// tone: live (green) | scheduled (blue) | draft (grey) | warn (amber) | red
export const Pill = ({ tone = 'draft', children, dot }) => <span className={`pill ${tone}`}>{dot ? '● ' : ''}{children}</span>;
export const Tag = ({ green, children, title }) => <span className={`tag${green ? ' green' : ''}`} title={title}>{children}</span>;

// campaign / message status words -> [pill tone, words]. Never "Draft".
export const STATUS = {
  draft: ['draft', 'Not sent yet'], notsent: ['draft', 'Not sent yet'], waiting_approval: ['warn', 'Waiting for approval'], changes: ['red', 'Changes needed'],
  preparing: ['live', 'Getting ready'], scheduled: ['scheduled', 'Scheduled'], running: ['live', 'Live'], live: ['live', 'Live'], sending: ['live', 'Sending'],
  paused: ['warn', 'Paused'], done: ['warn', 'Completed'], completed: ['warn', 'Completed'], sent: ['live', 'Sent'], stopped: ['draft', 'Stopped'], failed: ['red', 'Failed'],
};
export function StatusPill({ status, words }) { const [tone, w] = STATUS[status] || ['draft', status]; return <Pill tone={tone} dot>{words || w}</Pill>; }

export function Tabs({ tabs, value, onChange, className = '' }) {
  return (
    <div className={`tabs ${className}`.trim()} role="tablist">
      {tabs.map(([id, label, count]) => (
        <button type="button" role="tab" aria-selected={value === id} key={id} className={`tab${value === id ? ' active' : ''}`} onClick={() => onChange(id)}>
          {label}{count !== undefined && count !== null ? <b style={{ marginLeft: 5, opacity: 0.65 }}>{count}</b> : null}
        </button>
      ))}
    </div>
  );
}

export const Empty = ({ title = 'Nothing here yet', children, action }) => (
  <div className="ca-empty" style={{ padding: '38px 20px' }}>
    <div style={{ fontWeight: 800, color: 'var(--ink)', marginBottom: 4 }}>{title}</div>
    {children && <div style={{ fontSize: 11 }}>{children}</div>}
    {action && <div style={{ marginTop: 12 }}>{action}</div>}
  </div>
);

export const Banner = ({ tone = 'info', children }) => {
  const c = { info: ['#eef6ff', '#c9defa', '#1d4fa8'], warn: ['#fff6df', '#f0e0b4', '#8a6410'], error: ['#fdeced', '#f4c9cc', '#9b1c1c'], ok: ['#e8f7ef', '#bfe3d0', '#087844'], test: ['#fff6df', '#f0e0b4', '#8a6410'] }[tone] || ['#eef6ff', '#c9defa', '#1d4fa8'];
  return <div role={tone === 'error' ? 'alert' : 'status'} style={{ background: c[0], border: `1px solid ${c[1]}`, color: c[2], borderRadius: 10, padding: '9px 12px', fontSize: 11, margin: '8px 0' }}>{children}</div>;
};

export function Field({ label, full, hint, children }) {
  return <div className={`field${full ? ' full' : ''}`}>{label && <label>{label}</label>}{children}{hint && <small style={{ fontSize: 9, color: 'var(--muted)' }}>{hint}</small>}</div>;
}

// the prototype's modal: .modal-bg.show > .modal > .modal-head / .modal-body / .modal-foot
export function GsModal({ title, sub, width, onClose, foot, children, bodyStyle }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg show" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={width ? { width: `min(${width}px,100%)` } : undefined}>
        <div className="modal-head"><div><b>{title}</b>{sub && <p>{sub}</p>}</div><button type="button" className="close" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body" style={{ maxHeight: '72vh', overflow: 'auto', ...(bodyStyle || {}) }}>{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

// the prototype's "Connect ... / Not connected" block for a service that needs an account Omni-Channel does not have yet.
// steps = plain steps to connect; fields = [{ id, label, secret }] saved by onSave({ id: value }) (the page stores them encrypted through the integration store).
export function NotConnected({ name, why, steps = [], children }) {
  return (
    <div className="card panel" style={{ marginBottom: 14 }}>
      <div className="panel-top"><div><div className="panel-title">Connection status</div><div className="panel-sub">{name}</div></div><Pill tone="draft" dot>Not connected</Pill></div>
      <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>{why}</p>
      {steps.length > 0 && <ol style={{ fontSize: 11, lineHeight: 1.7, paddingLeft: 18, margin: '8px 0' }}>{steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      {children}
    </div>
  );
}
export const Planned = ({ children = 'Planned: this part is not built yet. Nothing here is faked.' }) => (
  <div style={{ fontSize: 10.5, color: '#5b6b85', background: '#f1f4f9', borderRadius: 9, padding: '7px 10px', margin: '8px 0' }}><b>Planned. </b>{children}</div>
);

// ---------------------------------------------------------------------------
// DataTable: the prototype's table card with search, sortable columns, a Columns chooser, rows-per-page and a pager. It works on rows you already have
// (client side) OR on a page the server sent (pass server={ total, page, pageSize, onPage, onPageSize, onQuery, query }).
//   columns: [{ id, label, render(row), sort(row) -> comparable, search(row) -> text, hide: true (off by default), className, num }]
//   persistKey: remembers the chosen columns per person in localStorage ('tl_omni_cols_<key>')
// ---------------------------------------------------------------------------
const colKey = (k) => `tl_omni_cols_${k}`;
function readCols(k) { try { const v = window.localStorage.getItem(colKey(k)); return v ? JSON.parse(v) : null; } catch { return null; } }
function writeCols(k, v) { try { window.localStorage.setItem(colKey(k), JSON.stringify(v)); } catch { /* fine */ } }

export function DataTable({ columns, rows, rowKey = (r) => r.id, onRow, empty, emptyText = 'No results found.', persistKey, searchPlaceholder = 'Search…', toolbar, pageSizes = [10, 20, 50], server, defaultSort, loading, compact }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(defaultSort || null); // { id, dir }
  const [pageSize, setPageSize] = useState(pageSizes[0]);
  const [page, setPage] = useState(1);
  const [colsOpen, setColsOpen] = useState(false);
  const [shown, setShown] = useState(() => {
    const saved = persistKey ? readCols(persistKey) : null;
    return saved || columns.filter((c) => !c.hide).map((c) => c.id);
  });
  const vis = columns.filter((c) => shown.includes(c.id));
  const toggleCol = (id) => { const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id]; if (!next.length) return; setShown(next); if (persistKey) writeCols(persistKey, next); };

  const list = useMemo(() => {
    if (server) return rows;
    let out = rows || [];
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((r) => columns.map((c) => (c.search ? c.search(r) : (c.sort ? c.sort(r) : ''))).join(' ').toLowerCase().includes(needle));
    if (sort) {
      const c = columns.find((x) => x.id === sort.id);
      const f = c && (c.sort || c.search);
      if (f) out = [...out].sort((a, b) => { const x = f(a); const y = f(b); const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), undefined, { numeric: true }); return sort.dir === 'desc' ? -r : r; });
    }
    return out;
  }, [rows, q, sort, columns, server]);

  const total = server ? server.total : list.length;
  const ps = server ? server.pageSize : pageSize;
  const pg = server ? server.page : page;
  const pages = Math.max(1, Math.ceil(total / ps));
  const slice = server ? list : list.slice((pg - 1) * ps, pg * ps);
  const from = total ? (pg - 1) * ps + 1 : 0; const to = Math.min(total, pg * ps);
  const goPage = (p) => { const n = Math.min(pages, Math.max(1, p)); if (server) server.onPage(n); else setPage(n); };
  const clickSort = (c) => { if (!(c.sort || c.search) || server) return; setSort((s) => (s && s.id === c.id ? { id: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { id: c.id, dir: 'asc' })); setPage(1); };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 12px' }}>
        <input className="search" aria-label="Search" placeholder={searchPlaceholder} value={server ? (server.query || '') : q} onChange={(e) => { if (server) server.onQuery(e.target.value); else { setQ(e.target.value); setPage(1); } }} />
        {toolbar}
        <div className="dropdown" style={{ marginLeft: 'auto' }}>
          <button type="button" className="tiny-btn" style={{ height: 36, padding: '0 12px' }} onClick={() => setColsOpen(!colsOpen)} aria-expanded={colsOpen}>⇅ Columns</button>
          {colsOpen && (
            <div className="menu show" style={{ width: 230, right: 0 }}>
              <div className="menu-label">Show columns</div>
              {columns.map((c) => <button type="button" key={c.id} onClick={() => toggleCol(c.id)}><span>{c.label}</span><span>{shown.includes(c.id) ? '✓' : ''}</span></button>)}
            </div>
          )}
        </div>
      </div>
      <div className="card table-card">
        <div className="table-scroll">
          <table className="table" style={compact ? { minWidth: 0 } : undefined}>
            <thead><tr>{vis.map((c) => {
              const active = sort && sort.id === c.id;
              return <th key={c.id} className={c.className} style={{ cursor: (c.sort || c.search) && !server ? 'pointer' : 'default', whiteSpace: 'nowrap' }} onClick={() => clickSort(c)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>{c.label}{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>;
            })}</tr></thead>
            <tbody>
              {loading && !slice.length && <tr><td colSpan={vis.length} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>Loading…</td></tr>}
              {!loading && !slice.length && <tr><td colSpan={vis.length} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>{empty || emptyText}</td></tr>}
              {slice.map((r) => (
                <tr key={rowKey(r)} className={onRow ? 'clickable' : undefined} onClick={onRow ? () => onRow(r) : undefined}>
                  {vis.map((c) => <td key={c.id} className={c.className} style={{ overflowWrap: 'anywhere' }}>{c.render ? c.render(r) : r[c.id]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 12, fontSize: 10, color: 'var(--muted)' }}>
        <span>{total ? `Showing ${from} to ${to} of ${fmtNum(total)} entries` : 'Showing 0 entries'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Rows per page</span>
          <select className="select" style={{ height: 30 }} value={ps} onChange={(e) => { const n = Number(e.target.value); if (server) server.onPageSize(n); else { setPageSize(n); setPage(1); } }}>{pageSizes.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          <button type="button" className="tiny-btn" disabled={pg <= 1} onClick={() => goPage(pg - 1)} aria-label="Previous page">‹</button>
          <span>Page {pg} of {pages}</span>
          <button type="button" className="tiny-btn" disabled={pg >= pages} onClick={() => goPage(pg + 1)} aria-label="Next page">›</button>
        </div>
      </div>
    </div>
  );
}

// a confirm that stays inside the page style (the prototype's uiConfirm)
export function ConfirmModal({ title = 'Are you sure?', text, yes = 'Confirm', onYes, onNo, danger }) {
  return <GsModal title={title} onClose={onNo} width={420} foot={<><Btn onClick={onNo}>Cancel</Btn><Btn primary={!danger} danger={danger} onClick={onYes}>{yes}</Btn></>}><p style={{ fontSize: 12, lineHeight: 1.6, margin: 0 }}>{text}</p></GsModal>;
}
