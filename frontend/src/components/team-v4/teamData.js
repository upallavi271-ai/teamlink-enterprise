// ---------------------------------------------------------------------------
// TEAM v4 (2026-10-08) — the small date and number helpers behind the Team
// overview (components/team-v4/TeamOverview.jsx). Nothing here invents a
// value: every figure is computed from the API rows the caller passes in.
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00`);
export const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
export const monthOf = (s) => String(s).slice(0, 7);
export const prevMonth = (m) => { const d = parseDay(`${m}-01`); d.setMonth(d.getMonth() - 1); return isoDay(d).slice(0, 7); };
export const lastDayOf = (m) => { const d = parseDay(`${m}-01`); d.setMonth(d.getMonth() + 1); d.setDate(0); return isoDay(d); };
export const todayLocal = () => isoDay(new Date());

// "06-10-2026" — the reference's range style.
export const dmy = (s) => (s ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : '—');
export const shortDay = (s) => parseDay(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

export const PERIODS = [
  ['this_week', 'This Week'],
  ['this_month', 'This Month'],
  ['last_month', 'Last Month'],
];

// The from–to of a period, as plain local days.
export function periodRange(period, today = todayLocal()) {
  if (period === 'this_month') { const m = monthOf(today); return { from: `${m}-01`, to: lastDayOf(m) }; }
  if (period === 'last_month') { const m = prevMonth(monthOf(today)); return { from: `${m}-01`, to: lastDayOf(m) }; }
  const dow = (parseDay(today).getDay() + 6) % 7; // Monday = 0
  const from = addDays(today, -dow);
  return { from, to: addDays(from, 6) };
}

export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

// Role words as the Team screen shows them.
export const ROLE_GROUP_WORD = { RECRUITER: 'Recruiter', BDE: 'Client manager', TL: 'Team lead' };
export const roleText = (r) => (r.role === 'STL' ? 'Senior team lead' : ROLE_GROUP_WORD[r.roleGroup] || r.roleLabel || '—');

// Join % (Top performers / Key insights): of the people a person has at the
// client stage or beyond — sent to client, at interview, selected, joined —
// the share who joined. All four are the team row's own counts.
export function joinRate(c = {}) {
  const joined = Number(c.joined) || 0;
  const base = (Number(c.submitted) || 0) + (Number(c.interviews) || 0) + (Number(c.selected) || 0) + joined;
  return base ? (joined / base) * 100 : null;
}

export const lcName = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();

// "2h ago" / "3d ago" from a real timestamp.
export function timeAgo(at, now = Date.now()) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
