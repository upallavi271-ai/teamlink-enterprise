// Money and dates the way the accounting screens write them. Invoices.jsx
// re-exports these, so AccountsDashboard and InvoiceDetail keep importing them
// from there.

// Indian digit grouping, with and without paise — money() in tables and
// totals, money2() wherever the exact rupee matters (an invoice account, an
// instalment, the printed document).
export const money = (n) => (n === '' || n == null ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);
export const money2 = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "18 Aug 2026" — dates read the way the application writes them, never ISO.
export const fmtD = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).slice(0, 10));
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const pad = (n) => String(n).padStart(2, '0');
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Whole days from a yyyy-mm-dd to today (positive = in the past).
export const daysSince = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const then = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((now - then) / 86400000);
};
