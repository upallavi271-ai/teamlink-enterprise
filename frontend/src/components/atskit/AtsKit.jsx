import { Link } from 'react-router-dom';
import './atskit.css';

// ---------------------------------------------------------------------------
// ATS KIT (2026-10-08) — the presentation pieces the redesigned ATS screens
// share: Dashboard, Clients & Requirements, Candidates & Pipeline, Interview
// Calendar, Reports and Team. PRESENTATION ONLY: every number a caller passes
// comes from the screen's existing API data; nothing here fetches, invents or
// defaults a business value. A missing value is drawn as "—".
//
//   <KpiRow>                       responsive row of KPI tiles (2..7 across)
//   <KpiTile icon label value ... /> tile with a round icon badge
//   <Panel title action>           a card with a header line
//   <StageStrip steps />           Applied › Screening › … chevron strip
//   <AttentionList items />        big number + label + action button rows
//   <BarList rows />               label · bar · value (· share)
//   <QuickActions items />         icon + title + sub, links/buttons
//   <Avatar name />                initials disc
//   <AtsGrid cols>                 the dashboard grid (12-col, collapses)
// ---------------------------------------------------------------------------

const IN = new Intl.NumberFormat('en-IN');
export const fmtNum = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isFinite(v) ? IN.format(v) : '—';
  return String(v);
};

// Inline icons (stroke, 24 grid) — no icon library is added for this.
const PATHS = {
  briefcase: 'M4 8h16v11H4zM9 8V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M4 13h16',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  user: 'M20 20v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8 12l3 3 5-6',
  x: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 9l6 6M15 9l-6 6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
  chat: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5',
  pause: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M10 9v6M14 9v6',
  alert: 'M12 3l10 18H2zM12 10v4M12 17h.01',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
  building: 'M4 21V5l8-3v19M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2',
  handshake: 'M3 12l4-4 4 3 3-3 4 4 3-1M7 8l-4 4 6 6 2-2M14 18l2 2 5-5',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  rupee: 'M7 5h10M7 9h10M7 5c5 0 7 1.5 7 4s-2 4-7 4l7 7',
  send: 'M4 12l16-8-6 16-3-7z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  team: 'M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M5 20v-1a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v1M4.5 11a2 2 0 1 0 0-4M19.5 11a2 2 0 1 0 0-4',
  leave: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 10h.01M15 10h.01M9 16c1.5-1.5 4.5-1.5 6 0',
  pin: 'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};
export function Icon({ name, size = 18, className = '' }) {
  const d = PATHS[name] || PATHS.list;
  return (
    <svg className={`ak-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const TONES = ['blue', 'green', 'amber', 'violet', 'red', 'teal', 'pink', 'slate'];
const toneOf = (t) => (TONES.includes(t) ? t : 'blue');

// --- KPI tiles ---------------------------------------------------------------
export function KpiRow({ children, className = '' }) {
  return <div className={`ak-kpis ${className}`}>{children}</div>;
}

//   delta      a real % change the caller computed from its own data, or
//              omit it — never a decorative number.
//   upIsGood   for "Late"/"Rejected" pass false so ▲ draws red.
export function KpiTile({
  icon = 'chart', label, value, sub, delta, deltaLabel, upIsGood = true, tone = 'blue', onClick, active, title, loading,
}) {
  const t = toneOf(tone);
  const d = Number(delta);
  const hasDelta = delta !== undefined && delta !== null && delta !== '' && Number.isFinite(d);
  const good = hasDelta && d !== 0 ? (d > 0) === !!upIsGood : null;
  const inner = (
    <>
      <span className={`ak-kpi-ic ak-t-${t}`}><Icon name={icon} size={20} /></span>
      <span className="ak-kpi-body">
        <span className="ak-kpi-label">{label}</span>
        <span className="ak-kpi-value">{loading ? '…' : fmtNum(value)}</span>
        {hasDelta ? (
          <span className={`ak-kpi-delta ${good === null ? 'flat' : good ? 'up' : 'down'}`}>
            {d > 0 ? '↑' : d < 0 ? '↓' : '•'} {Math.abs(Math.round(d))}%
            {deltaLabel && <span className="ak-kpi-dlabel"> {deltaLabel}</span>}
          </span>
        ) : sub ? <span className="ak-kpi-sub">{sub}</span> : null}
      </span>
    </>
  );
  const cls = `ak-kpi${onClick ? ' ak-click' : ''}${active ? ' ak-active' : ''}`;
  return onClick
    ? <button type="button" className={cls} onClick={onClick} title={title} aria-pressed={!!active}>{inner}</button>
    : <div className={cls} title={title}>{inner}</div>;
}

// --- Panels --------------------------------------------------------------------
//   action: { label, to } | { label, onClick } | a node
export function Panel({ title, sub, icon, iconTone, action, children, className = '', bodyClass = '', flush = false, extra }) {
  let act = null;
  if (action && action.label) {
    act = action.to
      ? <Link className="ak-panel-link" to={action.to}>{action.label} <span aria-hidden="true">→</span></Link>
      : <button type="button" className="ak-panel-link" onClick={action.onClick}>{action.label} <span aria-hidden="true">→</span></button>;
  } else if (action) act = action;
  return (
    <section className={`ak-panel ${className}`}>
      {(title || act) && (
        <header className="ak-panel-head">
          <div className="ak-panel-title">
            {icon && <span className={`ak-panel-ic ak-tx-${toneOf(iconTone || 'blue')}`}><Icon name={icon} size={17} /></span>}
            <span>
              <h3>{title}</h3>
              {sub && <span className="ak-panel-sub">{sub}</span>}
            </span>
          </div>
          <div className="ak-panel-actions">{extra}{act}</div>
        </header>
      )}
      <div className={`ak-panel-body${flush ? ' ak-flush' : ''} ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function AtsGrid({ children, className = '' }) {
  return <div className={`ak-grid ${className}`}>{children}</div>;
}

// --- Stage strip ----------------------------------------------------------------
//   steps: [{ key, label, value, icon, tone, onClick, active }]
export function StageStrip({ steps = [], compact = false }) {
  return (
    <ol className={`ak-stages${compact ? ' ak-compact' : ''}`}>
      {steps.map((s, i) => {
        const t = toneOf(s.tone || TONES[i % TONES.length]);
        const inner = (
          <>
            <span className={`ak-stage-ic ak-t-${t}`}><Icon name={s.icon || 'user'} size={18} /></span>
            <span className="ak-stage-txt">
              <span className="ak-stage-label">{s.label}</span>
              <span className="ak-stage-value">{fmtNum(s.value)}</span>
            </span>
          </>
        );
        return (
          <li key={s.key || s.label} className={`ak-stage ak-bg-${t}${s.active ? ' ak-active' : ''}`}>
            {s.onClick
              ? <button type="button" onClick={s.onClick} aria-pressed={!!s.active}>{inner}</button>
              : <div>{inner}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// --- Attention list ---------------------------------------------------------------
//   items: [{ key, count, label, sub, tone, action: { label, onClick | to } }]
export function AttentionList({ items = [], empty = 'Nothing needs attention right now.' }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return <div className="ak-empty">{empty}</div>;
  return (
    <ul className="ak-attn">
      {shown.map((it) => (
        <li key={it.key || it.label}>
          <span className={`ak-attn-n ak-t-${toneOf(it.tone || 'red')}`}>{fmtNum(it.count)}</span>
          <span className="ak-attn-txt">
            <span className="ak-attn-label">{it.label}</span>
            {it.sub && <span className="ak-attn-sub">{it.sub}</span>}
          </span>
          {it.action && (it.action.to
            ? <Link className="ak-btn-sm" to={it.action.to}>{it.action.label} →</Link>
            : <button type="button" className="ak-btn-sm" onClick={it.action.onClick}>{it.action.label} →</button>)}
        </li>
      ))}
    </ul>
  );
}

// --- Bar list -----------------------------------------------------------------------
//   rows: [{ key, label, value, onClick, tone }]; share shown when showShare
export function BarList({ rows = [], showShare = true, empty = 'No data available', format = fmtNum }) {
  const list = rows.filter((r) => r && Number(r.value) > 0);
  if (!list.length) return <div className="ak-empty">{empty}</div>;
  const max = Math.max(...list.map((r) => Number(r.value)));
  const total = list.reduce((n, r) => n + Number(r.value), 0);
  return (
    <ul className="ak-bars">
      {list.map((r, i) => {
        const pct = total ? Math.round((Number(r.value) / total) * 100) : 0;
        const body = (
          <>
            <span className="ak-bar-label" title={r.label}>{r.label}</span>
            <span className="ak-bar-track"><span className={`ak-bar-fill ak-f-${toneOf(r.tone || TONES[i % 4])}`} style={{ width: `${Math.max(3, (Number(r.value) / max) * 100)}%` }} /></span>
            <span className="ak-bar-val">{format(Number(r.value))}</span>
            {showShare && <span className="ak-bar-pct">{pct}%</span>}
          </>
        );
        return (
          <li key={r.key || r.label}>
            {r.onClick ? <button type="button" onClick={r.onClick}>{body}</button> : <div>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

// --- Quick actions -----------------------------------------------------------------
//   items: [{ key, icon, label, sub, to | onClick, tone }]
export function QuickActions({ items = [] }) {
  return (
    <ul className="ak-quick">
      {items.filter(Boolean).map((it, i) => {
        const inner = (
          <>
            <span className={`ak-quick-ic ak-t-${toneOf(it.tone || TONES[i % TONES.length])}`}><Icon name={it.icon} size={17} /></span>
            <span className="ak-quick-txt">
              <span className="ak-quick-label">{it.label}</span>
              {it.sub && <span className="ak-quick-sub">{it.sub}</span>}
            </span>
            <span className="ak-quick-go" aria-hidden="true">›</span>
          </>
        );
        return (
          <li key={it.key || it.label}>
            {it.to ? <Link to={it.to}>{inner}</Link> : <button type="button" onClick={it.onClick}>{inner}</button>}
          </li>
        );
      })}
    </ul>
  );
}

// --- Avatar ---------------------------------------------------------------------------
const AV_TONES = ['blue', 'violet', 'teal', 'amber', 'pink', 'green'];
export function Avatar({ name = '', size = 28 }) {
  const parts = String(name || '?').trim().split(/\s+/);
  const ini = ((parts[0] || '')[0] || '?') + ((parts.length > 1 ? parts[parts.length - 1][0] : '') || '');
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`ak-avatar ak-t-${AV_TONES[h % AV_TONES.length]}`} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {ini.toUpperCase()}
    </span>
  );
}

export function Pill({ tone = 'slate', children }) {
  return <span className={`ak-pill ak-t-${toneOf(tone)}`}>{children}</span>;
}

// % change between two real counts; null when there is no base to compare.
export function pctChange(now, before) {
  const a = Number(now);
  const b = Number(before);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}
