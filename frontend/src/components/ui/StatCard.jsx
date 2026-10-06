import { Children } from 'react';
import { normTone } from './StatusChip.jsx';
import { Help } from './Guide.jsx';
import './StatCard.css';

// ---------------------------------------------------------------------------
// StatCard — one number that opens its list (ATS layout v3, 2026-10-03).
//
//   <StatCard label="Late" value={19} tone="red" onClick={() => open('late')}
//     delta={-12} deltaLabel="vs last month" zeroText="Nothing late" hint="…" />
//
//   label       what it counts, in plain words ("Open jobs")
//   value       the number (or a ready string like "₹4.2L")
//   zeroText    shown INSTEAD of a bare 0 ("None today") — never a lone zero
//   delta       % change; ▲ / ▼ with the sign. upIsGood (default true) decides
//               green or red: for "Late" pass upIsGood={false}.
//   deltaLabel  the period it compares with ("vs last month")
//   tone        green / yellow / red / blue / grey — a coloured edge + number
//   onClick     the card is a button that opens the list behind the number
//   hint        one short line under the number
//   help        a one-line "?" tooltip: what the number means (2026-10-05)
//   format      (n) -> string for numbers (default en-IN grouping)
//
// <StatRow> holds at most SIX cards (the spec's "max 6 cards per screen");
// more are dropped with a warning in development.
// ---------------------------------------------------------------------------
const IN = new Intl.NumberFormat('en-IN');

export default function StatCard({
  label, value, delta, deltaLabel, tone, onClick, hint, zeroText, format, upIsGood = true, loading = false, title, help,
}) {
  const t = normTone(tone);
  const num = typeof value === 'number' ? value : (value === null || value === undefined || value === '' ? null : value);
  const isZero = num === 0 || num === '0';
  let shown;
  if (loading) shown = '…';
  else if (num === null) shown = '—';
  else if (isZero) shown = null;
  else shown = typeof num === 'number' ? (format ? format(num) : IN.format(num)) : String(num);

  const d = Number(delta);
  const hasDelta = delta !== undefined && delta !== null && delta !== '' && Number.isFinite(d);
  const good = hasDelta && (d === 0 ? null : (d > 0) === !!upIsGood);
  const deltaTxt = hasDelta ? `${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(Math.round(d * 10) / 10)}%` : null;

  const body = (
    <>
      <span className="sc-label">{label}{help && <Help text={help} focusable={false} />}</span>
      {shown !== null
        ? <span className="sc-value">{shown}</span>
        : <span className="sc-zero">{zeroText || `No ${String(label || '').toLowerCase()}`}</span>}
      {hasDelta && (
        <span className={`sc-delta ${good === null ? 'flat' : good ? 'up' : 'down'}`}>
          {deltaTxt}
          {deltaLabel && <span className="sc-dlabel">{` ${deltaLabel}`}</span>}
        </span>
      )}
      {hint && <span className="sc-hint">{hint}</span>}
    </>
  );
  const cls = `sc-card${t ? ` sc-${t}` : ''}${onClick ? ' sc-click' : ''}`;
  const aria = `${label}: ${shown !== null ? shown : (zeroText || 'none')}${deltaTxt ? `, ${deltaTxt} ${deltaLabel || ''}` : ''}`;
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} aria-label={aria} title={help ? `${help}${title ? ` — ${title}` : ' — click to see the list'}` : (title || 'Open the list')}>
        {body}
      </button>
    );
  }
  return <div className={cls} aria-label={aria} title={help || title || undefined}>{body}</div>;
}

export function StatRow({ children, className = '' }) {
  const kids = Children.toArray(children).filter(Boolean);
  if (kids.length > 6 && typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`StatRow: ${kids.length} cards — the layout allows at most 6. Extra cards are not shown.`);
  }
  return <div className={`sc-row ${className}`}>{kids.slice(0, 6)}</div>;
}
