// Month by month on the Accounts Dashboard (founder 2026-11-28): what each month's invoices brought in without GST, what the
// office spent, and whether the month made a PROFIT or a LOSS, and how much. GET /dashboard/accounts/monthly-pl.
import { useEffect, useState } from 'react';
import api from '../../../api';

const money = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (k) => `${NAMES[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const Word = ({ v }) => (
  <b style={{ color: v >= 0 ? 'var(--teal)' : 'var(--red)' }}>{v >= 0 ? 'Profit' : 'Loss'} {money(Math.abs(v))}</b>
);

export default function MonthlyProfit() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [month, setMonth] = useState('');
  useEffect(() => {
    api.get('/dashboard/accounts/monthly-pl')
      .then((r) => {
        const list = r.data.rows || [];
        setRows(list);
        const now = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
        setMonth((list.find((x) => x.month === now) || list.find((x) => x.month < now) || list[0] || {}).month || '');
      })
      .catch((e) => setError(e.response?.data?.error || 'The monthly figures could not be loaded.'));
  }, []);
  if (error) return <div className="notice red"><span>{error}</span></div>;
  if (!rows) return <div className="card section small-muted">Loading the monthly profit…</div>;
  if (!rows.length) return null;
  const m = rows.find((x) => x.month === month) || rows[0];
  return (
    <section className="card section" data-testid="acc-monthly-pl">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Profit or loss, month by month</h3>
        <span style={{ flex: 1 }} />
        <label className="small-muted">Month{' '}
          <select value={m.month} onChange={(e) => setMonth(e.target.value)} style={{ padding: '4px 8px' }}>
            {rows.map((x) => <option key={x.month} value={x.month}>{monthName(x.month)}</option>)}
          </select>
        </label>
      </div>
      <div className="statbar" style={{ marginTop: 10 }}>
        <div className="stat"><div className="small-muted">Invoices without GST</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(m.income)}</div><div className="small-muted">{money(m.total)} total − {money(m.gst)} GST · {m.invoices} invoice line(s)</div></div>
        <div className="stat"><div className="small-muted">Expenses</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(m.expenses)}</div><div className="small-muted">before GST ({money(m.expensesWithGst)} with GST) · {m.bills} bill(s)</div></div>
        <div className="stat"><div className="small-muted">{monthName(m.month)}</div><div style={{ fontSize: 22 }}><Word v={m.result} /></div><div className="small-muted">{money(m.income)} − {money(m.expenses)}</div></div>
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 320, marginTop: 10 }}>
        <table>
          <thead>
            <tr><th>Month</th><th className="num">Invoice total</th><th className="num">GST</th><th className="num">Without GST</th><th className="num">Expenses (before GST)</th><th>Profit / Loss</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.month} onClick={() => setMonth(x.month)} style={{ cursor: 'pointer', fontWeight: x.month === m.month ? 600 : 400 }}>
                <td>{monthName(x.month)}</td>
                <td className="num">{money(x.total)}</td>
                <td className="num">{money(x.gst)}</td>
                <td className="num">{money(x.income)}</td>
                <td className="num">{money(x.expenses)}</td>
                <td><Word v={x.result} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small-muted" style={{ marginBottom: 0 }}>Income is counted in the month the candidate joined (the invoice date if no joining date is recorded). Expenses are the office bills of that month. TDS cut by clients is not taken off here.</p>
    </section>
  );
}
