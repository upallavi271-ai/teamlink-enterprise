// Pure date helpers for Analytics (no React). Days are INDIA days written 'YYYY-MM-DD' ("Dates are shown in Kolkata Time"); all maths is done on UTC dates of those strings,
// so the browser's own time zone never moves a day.
export const PRESETS = ['Today', 'Yesterday', 'Today and yesterday', 'Last 7 days', 'Last 14 days', 'Last 28 days', 'Last 30 days', 'This week', 'Last week', 'This month'];
const IST = 5.5 * 3600 * 1000;
const ms = (s) => Date.parse(`${s}T00:00:00Z`);
export const todayIst = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
export const addDays = (s, n) => new Date(ms(s) + n * 86400000).toISOString().slice(0, 10);
export const dayOfWeek = (s) => new Date(ms(s)).getUTCDay(); // 0 = Sunday
export const diffDays = (a, b) => Math.round((ms(b) - ms(a)) / 86400000);
export const countDays = (a, b) => diffDays(a, b) + 1;
export const monthFirst = (s) => `${s.slice(0, 7)}-01`;
export const addMonths = (s, n) => { const d = new Date(ms(monthFirst(s))); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (s) => `${Number(s.slice(8, 10))} ${MON[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
export const monthTitle = (s) => new Date(ms(s)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// the prototype's presets: Last N days = N days back to today; This week = from Sunday; Last week = the Sunday-Saturday before
export function presetRange(p, t = todayIst()) {
  const dow = dayOfWeek(t);
  switch (p) {
    case 'Today': return { from: t, to: t };
    case 'Yesterday': return { from: addDays(t, -1), to: addDays(t, -1) };
    case 'Today and yesterday': return { from: addDays(t, -1), to: t };
    case 'Last 7 days': return { from: addDays(t, -7), to: t };
    case 'Last 14 days': return { from: addDays(t, -14), to: t };
    case 'Last 28 days': return { from: addDays(t, -28), to: t };
    case 'Last 30 days': return { from: addDays(t, -30), to: t };
    case 'This week': return { from: addDays(t, -dow), to: t };
    case 'Last week': return { from: addDays(t, -dow - 7), to: addDays(t, -dow - 1) };
    case 'This month': return { from: monthFirst(t), to: t };
    default: return { from: addDays(t, -30), to: t };
  }
}
// the cells of one month: leading blanks (Sunday first), then every day as 'YYYY-MM-DD'
export function monthCells(first) {
  const start = new Date(ms(monthFirst(first)));
  const lead = start.getUTCDay();
  const days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const out = []; for (let i = 0; i < lead; i += 1) out.push(null);
  for (let d = 1; d <= days; d += 1) out.push(`${monthFirst(first).slice(0, 8)}${String(d).padStart(2, '0')}`);
  return out;
}
export function downloadText(text, name, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([`﻿${text}`], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
