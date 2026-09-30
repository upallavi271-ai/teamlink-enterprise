// Shared helpers for Office & Expenses — money, dates, the financial year and
// the statutory due dates.

export const money = (n) => {
  const v = Number(n);
  return `₹${Math.round(Number.isFinite(v) ? v : 0).toLocaleString('en-IN')}`;
};
export const money2 = (n) => {
  const v = Number(n);
  return `₹${(Number.isFinite(v) ? v : 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => isoOf(new Date());
export const fmtD = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return m ? `${d} ${MON[Number(m) - 1]} ${y}` : String(iso);
};
const lastDay = (y, m0) => new Date(y, m0 + 1, 0).getDate();

// FY = 1 April to 31 March. The FY that contains today.
export const fyOf = (d = new Date()) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
export const fyLabel = (y) => `FY ${y}-${y + 1}`;

export const QUARTERS = [
  { k: 'Q1', label: 'Q1 Apr–Jun', m0: 3 },
  { k: 'Q2', label: 'Q2 Jul–Sep', m0: 6 },
  { k: 'Q3', label: 'Q3 Oct–Dec', m0: 9 },
  { k: 'Q4', label: 'Q4 Jan–Mar', m0: 0 },
];
export const HALVES = [
  { k: 'H1', label: 'First Half · Apr–Sep', m0: 3 },
  { k: 'H2', label: 'Second Half · Oct–Mar', m0: 9 },
];

// A period selection string (the same one the API reads) -> its dates.
//   all | FY:<y> | Q1..Q4:<y> | H1/H2:<y> | C:<from>:<to>
export function rangeOfSel(sel) {
  const s = String(sel || 'all');
  if (s === 'all') return { all: true, from: null, to: null, label: 'All time' };
  if (s.startsWith('C:')) {
    const [, from, to] = s.split(':');
    return { all: false, from, to, label: `${fmtD(from)} – ${fmtD(to)}` };
  }
  const [kind, yRaw] = s.split(':');
  const y = Number(yRaw);
  if (kind === 'FY') return { all: false, from: `${y}-04-01`, to: `${y + 1}-03-31`, label: fyLabel(y), kind, fy: y };
  const q = QUARTERS.find((x) => x.k === kind);
  if (q) {
    const yy = q.k === 'Q4' ? y + 1 : y;
    return {
      all: false, from: `${yy}-${pad(q.m0 + 1)}-01`, to: `${yy}-${pad(q.m0 + 3)}-${lastDay(yy, q.m0 + 2)}`, label: `${q.label} · ${fyLabel(y)}`, kind, fy: y,
    };
  }
  const h = HALVES.find((x) => x.k === kind);
  if (h) {
    return kind === 'H1'
      ? { all: false, from: `${y}-04-01`, to: `${y}-09-30`, label: `${h.label} · ${fyLabel(y)}`, kind, fy: y }
      : { all: false, from: `${y}-10-01`, to: `${y + 1}-03-31`, label: `${h.label} · ${fyLabel(y)}`, kind, fy: y };
  }
  return { all: true, from: null, to: null, label: 'All time' };
}

// ---------------------------------------------------------------------------
// Statutory due dates, from today.
//   TDS challan   7th of the following month — March's is due 30 April
//   GSTR-1        11th of the following month
//   GSTR-3B       20th of the following month
//   24Q / 26Q     31st of the month after the quarter ends — Q4 (Jan–Mar) is
//                 due 31 May
// Each card shows the next date on or after today. Holidays and extensions
// notified by the department are not known here.
// ---------------------------------------------------------------------------
const at = (y, m0, d) => new Date(y, m0, d);
const monthName = (d) => `${MON[d.getMonth()]} ${d.getFullYear()}`;

export function dueDates(now = new Date()) {
  const today = at(now.getFullYear(), now.getMonth(), now.getDate());
  const next = (cands) => cands.filter((c) => c.date >= today).sort((a, b) => a.date - b.date)[0];
  const months = (fn) => [-1, 0, 1, 2].map((k) => {
    const first = at(now.getFullYear(), now.getMonth() + k, 1);
    return fn(first);
  });

  const tds = next(months((first) => {
    const prev = at(first.getFullYear(), first.getMonth() - 1, 1);
    const date = first.getMonth() === 3 ? at(first.getFullYear(), 3, 30) : at(first.getFullYear(), first.getMonth(), 7);
    return { date, for: `Tax deducted in ${monthName(prev)}` };
  }));
  const gstr = (day) => next(months((first) => {
    const prev = at(first.getFullYear(), first.getMonth() - 1, 1);
    return { date: at(first.getFullYear(), first.getMonth(), day), for: `For ${monthName(prev)}` };
  }));
  const fy = fyOf(now);
  const tdsReturn = next([fy - 1, fy, fy + 1].flatMap((y) => [
    { date: at(y, 6, 31), for: `Q1 Apr–Jun ${y}` },
    { date: at(y, 9, 31), for: `Q2 Jul–Sep ${y}` },
    { date: at(y + 1, 0, 31), for: `Q3 Oct–Dec ${y}` },
    { date: at(y + 1, 4, 31), for: `Q4 Jan–Mar ${y + 1}` },
  ]));

  const shape = (key, title, x) => {
    const days = Math.round((x.date - today) / 86400000);
    return {
      key, title, date: isoOf(x.date), for: x.for, days,
      when: days === 0 ? 'today' : days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} overdue`,
    };
  };
  return [
    shape('tds', 'TDS Payment Challan', tds),
    shape('gstr1', 'GSTR-1 · Outward Supplies', gstr(11)),
    shape('gstr3b', 'GSTR-3B · Payment of Tax', gstr(20)),
    shape('tdsret', 'TDS Return 24Q/26Q', tdsReturn),
  ];
}

// Download a blob the API sent back, under the name it gave.
export function saveBlob(res, fallback) {
  const cd = res.headers?.['content-disposition'] || '';
  const m = cd.match(/filename="?([^";]+)"?/i);
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = m ? m[1] : fallback;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ---------------------------------------------------------------------------
// One calendar month as a period selection (the Month / Year quick pick sets
// the same custom range the period picker would), and back.
// ---------------------------------------------------------------------------
export const monthKey = (y, m0) => `${y}-${pad(m0 + 1)}`;
export const monthSel = (y, m0) => `C:${y}-${pad(m0 + 1)}-01:${y}-${pad(m0 + 1)}-${pad(lastDay(y, m0))}`;
export const currentMonthSel = () => { const d = new Date(); return monthSel(d.getFullYear(), d.getMonth()); };
// [year, month0] when the selection is exactly one whole calendar month.
export function monthOfSel(sel) {
  const m = /^C:(\d{4})-(\d{2})-01:(\d{4})-(\d{2})-(\d{2})$/.exec(String(sel || ''));
  if (!m || m[1] !== m[3] || m[2] !== m[4]) return null;
  const y = Number(m[1]); const m0 = Number(m[2]) - 1;
  return Number(m[5]) === lastDay(y, m0) ? [y, m0] : null;
}
export const monthLabelOf = (y, m0) => `${MONTH_FULL[m0]} ${y}`;
// A YYYY-MM from a URL (?month=2026-09) -> its selection, or null.
export function selOfMonthKey(mk) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mk || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return monthSel(Number(m[1]), Number(m[2]) - 1);
}
