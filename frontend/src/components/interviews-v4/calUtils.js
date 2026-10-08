// ---------------------------------------------------------------------------
// INTERVIEW CALENDAR v4 (2026-10-08) — date helpers and the status → colour
// rule the redesigned calendar uses. PRESENTATION ONLY: every value comes from
// the interview records GET /ats/calendar already returns.
// ---------------------------------------------------------------------------
import { isLateFeedback } from '../interviews/InterviewCalendarGrid.jsx';

export const DAY_MS = 86400000;
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const sameDay = (a, b) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export const mondayOf = (d) => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const cleanName = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '');

const D2 = { day: '2-digit', month: 'short' };
export const fmtDay = (d, year = false) => d.toLocaleDateString('en-GB', year ? { ...D2, year: 'numeric' } : D2);
export const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

// The days a Day / Week / Month view covers, its title and the range label.
export function viewRange(mode, anchor) {
  const a = startOfDay(anchor);
  if (mode === 'day') {
    return { days: [a], from: a, to: a, title: a.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }) };
  }
  if (mode === 'month') {
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    const start = mondayOf(first);
    const weeks = Math.ceil((((first.getDay() + 6) % 7) + last.getDate()) / 7);
    return {
      days: Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i)),
      from: first,
      to: last,
      title: a.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    };
  }
  const mon = mondayOf(a);
  const days = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  return { days, from: days[0], to: days[6], title: `${fmtDay(days[0])} – ${fmtDay(days[6], true)}` };
}

export function stepAnchor(mode, anchor, dir) {
  if (mode === 'day') return addDays(anchor, dir);
  if (mode === 'week') return addDays(anchor, 7 * dir);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

// Interviews grouped by local day, each day in time order.
export function groupByDay(rows) {
  const m = new Map();
  (rows || []).forEach((r) => {
    if (!r.interviewAt) return;
    const k = dayKey(new Date(r.interviewAt));
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  m.forEach((list) => list.sort((x, y) => new Date(x.interviewAt) - new Date(y.interviewAt)));
  return m;
}

const LIVE = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];

// One colour per interview status (the reference's status colours):
//   blue booked · amber in progress · teal done, feedback owed · green
//   feedback in / decided · violet rescheduled · red cancelled / did not attend.
export function statusTone(r, now = Date.now()) {
  const st = r.status;
  if (st === 'CANCELLED' || st === 'NO_SHOW') return 'red';
  if (st === 'FEEDBACK_SUBMITTED' || DECIDED.includes(r.stage)) return 'green';
  if (st === 'STARTED') return 'amber';
  if (st === 'COMPLETED' || st === 'PENDING_FEEDBACK') return 'teal';
  if (LIVE.includes(st) && r.interviewAt && new Date(r.interviewAt).getTime() < now) return 'teal';
  if (st === 'RESCHEDULED') return 'violet';
  return 'blue';
}
export const STATUS_LEGEND = [
  ['blue', 'Booked'], ['amber', 'In progress'], ['teal', 'Feedback owed'],
  ['green', 'Feedback in'], ['violet', 'Rescheduled'], ['red', 'Cancelled / did not attend'],
];
export { isLateFeedback };

export const panelNames = (r) => ((r.panel && r.panel.length ? r.panel.map((p) => p.name).join(', ') : r.interviewer) || '');
