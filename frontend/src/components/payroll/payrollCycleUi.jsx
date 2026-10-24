import { useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// PAYROLL CYCLE on every payroll screen (user, 2026-10-12): a payroll month is
// shown with its NAME and its DATES - "Sep 2026 payroll · 16 Aug – 15 Sep" -
// so nobody is confused. One fetch of GET /payroll/cycle, shared by all screens.
// ---------------------------------------------------------------------------
let cached = null;
let inflight = null;
const listeners = new Set();

function load(force = false) {
  if (cached && !force) return Promise.resolve(cached);
  if (inflight && !force) return inflight;
  inflight = api.get('/payroll/cycle').then((res) => {
    cached = res.data;
    inflight = null;
    listeners.forEach((fn) => fn(cached));
    return cached;
  }).catch(() => { inflight = null; return null; });
  return inflight;
}
export const reloadPayrollCycle = () => load(true);

export function usePayrollCycle() {
  const [data, setData] = useState(cached);
  useEffect(() => {
    listeners.add(setData);
    load();
    return () => { listeners.delete(setData); };
  }, []);
  return data;
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthShort = (m) => (/^\d{4}-\d{2}$/.test(String(m || '')) ? `${MON3[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}` : String(m || ''));

// "Sep 2026 payroll · 16 Aug – 15 Sep" when the dates are known, else "Sep 2026".
export function monthHeading(m, data = cached) {
  const row = data && data.months ? data.months.find((x) => x.key === m) : null;
  if (row) return row.heading;
  return monthShort(m);
}
// "16 Aug – 15 Sep" or ''.
export function monthRange(m, data = cached) {
  const row = data && data.months ? data.months.find((x) => x.key === m) : null;
  return row ? row.rangeText : '';
}

// The payroll month to open on: the latest one whose days are over and that is not paid
// yet, else the one running now.
export function suggestedMonth(data) {
  if (!data || !data.months || !data.months.length) return new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);
  // Months newer than the last payroll that exists, whose days are over: the oldest of them is next to run.
  const last = data.months.filter((m) => m.status).map((m) => m.key).sort().pop() || '';
  const due = data.months.filter((m) => m.key > last && m.to < today).map((m) => m.key).sort();
  if (due.length) return due[0];
  return (data.current || data.months[0]).key;
}

// [month, setMonth] that starts on the suggested payroll month once the cycle is known.
export function useSuggestedMonth() {
  const data = usePayrollCycle();
  const [month, setMonth] = useState(() => suggestedMonth(cached));
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (data && !touched) setMonth(suggestedMonth(data)); }, [data, touched]);
  return [month, (m) => { setTouched(true); setMonth(m); }];
}

// A picker that lists the NAME and the DATES of each payroll month.
export function PayrollMonthSelect({ value, onChange, style, id, label = 'Payroll month' }) {
  const data = usePayrollCycle();
  const rows = data && data.months ? data.months : [];
  const has = rows.some((m) => m.key === value);
  return (
    <Combo id={id} className="pc-month-select" aria-label={label} title={label} style={style} value={value} onChange={(e) => onChange(e.target.value)}>
      {!has && value ? <option value={value}>{monthShort(value)}</option> : null}
      {rows.map((m) => (
        <option key={m.key} value={m.key}>{`${m.label} · ${m.rangeText}${m.status ? ` · ${m.status}` : ''}`}</option>
      ))}
    </Combo>
  );
}
