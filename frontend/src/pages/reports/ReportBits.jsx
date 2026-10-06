import { useEffect, useState } from 'react';
import api from '../../api';
import './ReportBits.css';

// ---------------------------------------------------------------------------
// Small pieces of the Reports screens (section 17, 2026-10-03):
//   Delta          ▲ 12% / ▼ 5% beside a number when two periods are compared
//   OfBar          "12 of 20" with a bar — a result against its target
//   CompareToggle  Off · This month vs last · This quarter vs last
//   ExportButtons  Excel · PDF · CSV as separate buttons (no dropdown)
//   useReportCatalog  which report cards this login may open (server decides)
// ---------------------------------------------------------------------------

// A rising number is good unless the figure counts a problem.
const BAD = /late|overdue|reject|pending|waiting|not add up|no joining|still to come|drop|no-show|did not/i;

export function deltaOf(cur, prev, type) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  const c = Number(cur);
  const p = Number(prev);
  if (Number.isNaN(c) || Number.isNaN(p)) return null;
  if (type === 'pct') {
    const d = Math.round((c - p) * 10) / 10;
    return { dir: Math.sign(d), text: d === 0 ? 'same' : `${Math.abs(d)} pts` };
  }
  // Nothing then and nothing now is not news: no arrow at all.
  if (p === 0) return c === 0 ? null : { dir: 1, text: 'new' };
  const d = Math.round(((c - p) / p) * 100);
  return { dir: Math.sign(c - p), text: d === 0 ? (c === p ? 'same' : '<1%') : `${Math.abs(d)}%` };
}

export function Delta({
  cur, prev, type, label = '', small = false, title,
}) {
  const d = deltaOf(cur, prev, type);
  if (!d) return null;
  const bad = BAD.test(label);
  const tone = d.dir === 0 ? 'same' : ((d.dir > 0) !== bad ? 'up' : 'down');
  const arrow = d.dir > 0 ? '▲' : d.dir < 0 ? '▼' : '=';
  const prevText = type === 'money' ? `₹${Math.round(Number(prev)).toLocaleString('en-IN')}` : `${Number(prev).toLocaleString('en-IN')}${type === 'pct' ? '%' : ''}`;
  return (
    <span className={`rpb-delta rpb-${tone}${small ? ' rpb-small' : ''}`} title={title || `Before: ${prevText}`}>
      {arrow} {d.text}
    </span>
  );
}

// "12 of 20" — the result against its target, with a bar. No target: the
// number alone, and the word "no target" (never a bare zero target).
export function OfBar({ value, target, children }) {
  if (!target) {
    return (
      <span className="rpb-of">
        {children}
        <span className="rpb-of-none">no target</span>
      </span>
    );
  }
  const share = Math.max(0, Math.min(100, Math.round((Number(value || 0) / target) * 100)));
  const tone = share >= 100 ? 'done' : share >= 50 ? 'going' : 'behind';
  return (
    <span className="rpb-of" title={`${share}% of the target`}>
      <span className="rpb-of-txt">{children}<span className="rpb-of-t"> of {Number(target).toLocaleString('en-IN')}</span></span>
      <span className={`rpb-bar rpb-${tone}`}><i style={{ width: `${share}%` }} /></span>
    </span>
  );
}

export const COMPARE_CHOICES = [['', 'Off'], ['month', 'This month vs last'], ['quarter', 'This quarter vs last']];
export function CompareToggle({ value, onChange }) {
  return (
    <span className="rpb-compare" role="group" aria-label="Compare periods">
      <span className="rpb-compare-lbl">Compare</span>
      {COMPARE_CHOICES.map(([id, label]) => (
        <button
          key={id || 'off'}
          type="button"
          className={`rpb-seg${(value || '') === id ? ' on' : ''}`}
          aria-pressed={(value || '') === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

export function ExportButtons({ busy, onPick, small = true }) {
  const cls = `btn${small ? ' btn-sm' : ''}`;
  return (
    <span className="rpb-export">
      <button type="button" className={cls} disabled={!!busy} onClick={() => onPick('xlsx')} title="Download this report as an Excel file">
        {busy === 'xlsx' ? 'Preparing…' : '⬇ Excel'}
      </button>
      <button type="button" className={cls} disabled={!!busy} onClick={() => onPick('pdf')} title="Download this report as a PDF">
        {busy === 'pdf' ? 'Preparing…' : '⬇ PDF'}
      </button>
      <button type="button" className={cls} disabled={!!busy} onClick={() => onPick('csv')} title="Download this report as a CSV file">
        {busy === 'csv' ? 'Preparing…' : '⬇ CSV'}
      </button>
    </span>
  );
}

let CATALOG = null;
export function useReportCatalog() {
  const [state, setState] = useState(CATALOG);
  useEffect(() => {
    let live = true;
    api.get('/ats-reports/catalog')
      .then((res) => { CATALOG = res.data; if (live) setState(res.data); })
      .catch(() => { if (live) setState((s) => s || { view: false, export: false, revenue: false }); });
    return () => { live = false; };
  }, []);
  return state;
}
