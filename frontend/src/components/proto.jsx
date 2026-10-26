import { Link } from 'react-router-dom';

// The prototype's own presentational primitives, one component per CSS block in
// styles.css. Screens are written against these so a panel, a stat row or a
// status pill renders exactly the markup the prototype renders.

export function Panel({ children, style, className = '' }) {
  return <div className={`panel ${className}`.trim()} style={style}>{children}</div>;
}

export function PanelPad({ children, style, className = '' }) {
  return <div className={`panel panel-pad ${className}`.trim()} style={style}>{children}</div>;
}

export function PanelHead({ title, children }) {
  return (
    <div className="panel-head">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// A panel-pad heading with the prototype's numbered "① Key Features" badge.
export function NumHead({ n, title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span className="status active">{n}</span>
      <h3 style={{ fontSize: 14, margin: 0 }}>{title}</h3>
    </div>
  );
}

export function PanelBody({ children, style }) {
  return <div style={{ padding: '10px 18px 14px', ...style }}>{children}</div>;
}

// `cells` is [{ value, label, to }] — `to` makes the cell a router link, which
// is what the prototype's data-goto stat cells do.
export function StatRow({ cells, columns }) {
  const style = columns ? { gridTemplateColumns: `repeat(${columns},1fr)` } : undefined;
  return (
    <div className="stat-row" style={style}>
      {cells.map((c) => {
        // optional `hint`: one plain line under the label saying what the number counts
        const inner = <><div className="v">{c.value}</div><div className="l">{c.label}</div>{c.hint && <div className="small-muted" style={{ marginTop: 2, fontSize: 12 }}>{c.hint}</div>}</>;
        return c.to
          ? <Link key={c.label} className="stat-cell" data-goto="1" to={c.to} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link>
          : <div key={c.label} className="stat-cell">{inner}</div>;
      })}
    </div>
  );
}

export function AssignRow({ children, flush = false, style }) {
  return (
    <div className="assign-row" style={flush ? { paddingLeft: 0, paddingRight: 0, ...style } : style}>
      {children}
    </div>
  );
}

export function EmptyMini({ children }) {
  return <div className="empty-mini">{children}</div>;
}

export function SectionLabel({ children, style }) {
  return <div className="section-label" style={style}>{children}</div>;
}

export function ScopeNote({ children, amber = false }) {
  return (
    <div className="scope-note" style={amber ? { background: 'var(--amber-tint)', color: 'var(--amber)' } : undefined}>
      <span>{children}</span>
    </div>
  );
}

export function TwoCol({ children, style }) {
  return <div className="two-col" style={style}>{children}</div>;
}

// The prototype colours a status pill by vocabulary, not by a separate prop.
const STATUS_TONE = {
  active: ['Approved', 'Active', 'Present', 'WFH', 'Completed', 'Achieved', 'Resolved', 'Closed within SLA', 'Available', 'Relieved', 'Paid', 'Processed', 'Granted', 'On time', 'Today', 'Reimbursed', 'Awarded', 'Selected', 'Joined'],
  rejected: ['Rejected', 'Absent', 'Retired', 'Withdrawn', 'Denied', 'Escalated', 'Missed', 'Termination', 'Suspension', 'Overdue'],
  review: ['In Progress', 'Under Review', 'Review'],
};
export function tone(status) {
  const s = String(status || '');
  if (STATUS_TONE.active.includes(s)) return 'active';
  if (STATUS_TONE.rejected.includes(s)) return 'rejected';
  if (STATUS_TONE.review.includes(s)) return 'review';
  return 'pending';
}

export function Status({ children, cls }) {
  return <span className={`status ${cls || tone(children)}`}>{children}</span>;
}

// The prototype's openModal()/closeModal() overlay, as a component.
export function Modal({ title, onClose, footer, children, wide = false }) {
  return (
    <div className="overlay show" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head">
          <h3 style={{ fontSize: 15 }}>{title}</h3>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// The prototype's inline progress bar (progressBarHtml, line 5463).
export function perfBand(pct) { return pct >= 75 ? 'High' : pct >= 50 ? 'Medium' : 'Low'; }
export function bandColor(band) { return band === 'High' ? 'var(--teal)' : band === 'Medium' ? 'var(--amber)' : 'var(--red)'; }
export function ProgressBar({ pct, band }) {
  const b = band || perfBand(pct);
  return (
    <div style={{ flex: 1, height: 7, background: 'var(--line-soft)', borderRadius: 4, overflow: 'hidden', minWidth: 70 }}>
      <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: bandColor(b) }} />
    </div>
  );
}

export function QaRow({ children, style }) {
  return <div className="qa-row" style={style}>{children}</div>;
}

// The Employee Services "Key Features" tile grid: a count badge, an intro line
// and one button per feature screen.
export function FeatureTiles({ features, onOpen }) {
  return (
    <PanelPad>
      <NumHead n={features.length} title="Key Features" />
      <div className="cell-muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {features.length} features in this module — click any tile to open its screen.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
        {features.map(([key, label]) => (
          <button key={key} className="btn btn-sm" style={{ textAlign: 'left' }} onClick={() => onOpen(key)}>{label}</button>
        ))}
      </div>
    </PanelPad>
  );
}

// A feature screen: back link, its own head, then whatever the screen renders.
export function FeatureScreen({ title, sub, onBack, children }) {
  return (
    <div>
      <button className="btn btn-sm" onClick={onBack}>← Back</button>
      {/* Not .page-head: styles.css hides a .page-head nested inside .tab-content,
          and a feature screen always renders inside one. Same rules, inline. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18, gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
        <div>
          <h1 style={{ fontSize: 19 }}>{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

export function FeatureTable({ heads, rows, empty }) {
  return (
    <Panel style={{ marginTop: 14 }}>
      <div className="tbl-wrap">
        <table>
          <thead><tr>{heads.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={heads.length} className="small-muted" style={{ padding: 16 }}>{empty}</td></tr>
              : rows}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
