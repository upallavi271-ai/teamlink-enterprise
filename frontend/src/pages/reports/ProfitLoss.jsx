import { useEffect, useState } from 'react';
import api from '../../api';
import './profitLoss.css';

// ---------------------------------------------------------------------------
// PROFIT & LOSS (Accounts Dashboard > "Profit & Loss" button). Founder 2026-11-26: "konchem clumsy vundhi, simplify cheyyu" and
// "evari valla entha profit, evari valla entha loss, dheyni valla profit, dheyni valla loss... clear ga vundali".
// One answer at the top, then one view at a time: People (who earned, who cost), Clients (where income came from), Expenses (where the
// money went), Months, Forecast, To check. GET /api/reports/accounts/pnl[?month=YYYY-MM] (utils/profitLoss.js) - read-only.
// ---------------------------------------------------------------------------
const rs = (n) => `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-IN')}`;
const lakh = (n) => `${n < 0 ? '−' : ''}₹${(Math.abs(Number(n) || 0) / 100000).toFixed(1)} L`;
const big = (n) => (Math.abs(n) >= 10000000 ? `${n < 0 ? '−' : ''}₹${(Math.abs(n) / 10000000).toFixed(2)} Cr` : lakh(n));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (k) => (k ? `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : '');
const tone = (n) => (n < 0 ? 'pl-neg' : 'pl-pos');
const roleOf = (r) => String(r || '').replace(/^Employee\s*·\s*/i, '').replace(/^Employee$/i, '');

function Share({ pct, kind }) {
  return <span className="pl-share" aria-hidden="true"><i className={kind} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></span>;
}

function People({ d }) {
  const earners = d.people.filter((p) => p.income > 0 && p.key !== 'none');
  const staff = d.people.filter((p) => p.income <= 0 && p.pay > 0);
  const none = d.people.find((p) => p.key === 'none');
  const staffPay = staff.reduce((t, p) => t + p.pay, 0);
  return (
    <div className="pl-view">
      <p className="pl-lead">Each recruiter: the fees from the joinings they made, against their salary for the same months.</p>
      <div className="pl-scroll"><table className="pl-table">
        <thead><tr><th>Recruiter</th><th>Joinings billed</th><th>Fees brought in</th><th>Salary</th><th>Profit / loss</th></tr></thead>
        <tbody>
          {earners.map((p) => (
            <tr key={p.key}>
              <td><b>{p.name}</b>{roleOf(p.role) && <div className="small-muted">{roleOf(p.role)}</div>}</td>
              <td>{p.invoices}</td><td>{rs(p.income)}</td><td>{p.pay ? rs(p.pay) : <span className="small-muted">not on payroll</span>}</td>
              <td className={tone(p.result)}>{rs(p.result)}</td>
            </tr>
          ))}
          {none && none.income > 0 && (
            <tr className="pl-dim"><td>Not linked to a recruiter</td><td>{none.invoices}</td><td>{rs(none.income)}</td><td>—</td><td className="pl-pos">{rs(none.income)}</td></tr>
          )}
        </tbody>
      </table></div>
      {staff.length > 0 && (
        <>
          <h4 className="pl-sub">Staff who bring no fees <span className="small-muted">({staff.length} people, {lakh(staffPay)} salary)</span></h4>
          <p className="pl-lead">TLs, HR, admin, founders and recruiters with no joining billed in this period. Their salary is a cost.</p>
          <div className="pl-scroll"><table className="pl-table pl-narrow">
            <thead><tr><th>Name</th><th>Role</th><th>Salary (cost)</th></tr></thead>
            <tbody>{staff.sort((a, b) => b.pay - a.pay).map((p) => (
              <tr key={p.key}><td>{p.name}</td><td className="small-muted">{roleOf(p.role) || '—'}</td><td className="pl-neg">{rs(-p.pay)}</td></tr>
            ))}</tbody>
          </table></div>
        </>
      )}
    </div>
  );
}

function Clients({ d }) {
  return (
    <div className="pl-view">
      <p className="pl-lead">Where the income came from: fees invoiced to each client, before GST.</p>
      <div className="pl-scroll"><table className="pl-table pl-narrow">
        <thead><tr><th>Client</th><th>Invoices</th><th>Income</th><th>Share</th></tr></thead>
        <tbody>{d.clients.map((c) => (
          <tr key={c.name}><td>{c.name}</td><td>{c.invoices}</td><td className="pl-pos">{rs(c.income)}</td><td className="pl-share-cell"><Share pct={c.share} kind="inc" /> {c.share}%</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function Expenses({ d }) {
  return (
    <div className="pl-view">
      <p className="pl-lead">Where the money went, biggest first. Office bills are before GST.</p>
      <div className="pl-scroll"><table className="pl-table pl-narrow">
        <thead><tr><th>Expense</th><th>Amount</th><th>Share</th></tr></thead>
        <tbody>{d.costLines.map((c) => (
          <tr key={c.name}><td>{c.name}</td><td className="pl-neg">{rs(-c.amount)}</td><td className="pl-share-cell"><Share pct={c.share} kind="cost" /> {c.share}%</td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function Months({ d }) {
  return (
    <div className="pl-view">
      <div className="pl-scroll"><table className="pl-table pl-narrow">
        <thead><tr><th>Month</th><th>Joinings</th><th>Earned</th><th>Spent</th><th>Profit / loss</th><th>Money received</th></tr></thead>
        <tbody>{d.rows.map((r) => (
          <tr key={r.month} className={r.result === null ? 'pl-dim' : ''}>
            <td>{monthName(r.month)}{r.open ? ' (running)' : ''}</td><td>{r.joinings}</td><td>{rs(r.income)}</td>
            <td>{r.noBills ? 'bills not entered' : rs(r.costs)}</td>
            <td className={r.result === null ? '' : tone(r.result)}>{r.result === null ? '—' : rs(r.result)}</td><td>{rs(r.received)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function Forecast({ d }) {
  const def = d.forecast.defaults;
  const [f, setF] = useState({ joinings: def.joinings || 20, fee: def.fee || 30000, cost: def.payroll + def.office + def.statutory });
  const inc = f.joinings * f.fee;
  const pl = inc - f.cost;
  const fy = d.forecast.actualSoFar + pl * d.forecast.remainingMonths;
  const be = f.fee > 0 ? Math.ceil(f.cost / f.fee) : 0;
  const row = (id, label, k, min, max, step, show) => (
    <div className="pl-ctl">
      <label htmlFor={id}><span>{label}</span><output>{show(f[k])}</output></label>
      <input id={id} type="range" min={min} max={max} step={step} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: Number(e.target.value) }))} />
    </div>
  );
  return (
    <div className="pl-view pl-what">
      <div className="pl-ctls">
        {row('pl-j', 'Joinings a month', 'joinings', 0, 80, 1, (v) => v)}
        {row('pl-f', 'Fee per joining', 'fee', 10000, 80000, 1000, rs)}
        {row('pl-c', 'Total costs a month', 'cost', 300000, 3000000, 10000, lakh)}
        <small className="small-muted">Starts from the last 3 months: {def.joinings} joinings at {rs(def.fee)}; costs {lakh(def.payroll + def.office + def.statutory)} a month.</small>
      </div>
      <div className="pl-result" aria-live="polite">
        <div><span>Each month from now</span><b className={tone(pl)}>{lakh(pl)}</b></div>
        <div><span>Full year {d.fy} (to March)</span><b className={tone(fy)}>{big(fy)}</b></div>
        <div><span>Joinings needed to break even</span><b>{be} a month</b></div>
      </div>
    </div>
  );
}

function Checks({ d }) {
  const [open, setOpen] = useState('');
  return (
    <div className="pl-view">
      <p className="pl-lead">Entries that make the books harder to read. Nothing is changed here; correct them in Office / Business.</p>
      <ul className="pl-checks">
        {d.checks.map((g) => (
          <li key={g.kind}>
            <button type="button" className="pl-check-head" aria-expanded={open === g.kind} onClick={() => setOpen(open === g.kind ? '' : g.kind)}>
              <b>{g.title}</b> <span className="small-muted">({g.count}{g.amount ? `, ${rs(g.amount)}` : ''})</span>
            </button>
            <div className="small-muted">{g.effect}</div>
            {open === g.kind && (
              <div className="pl-scroll"><table className="pl-table pl-narrow">
                <thead><tr><th>Date</th><th>Category</th><th>Amount</th><th>Note</th></tr></thead>
                {/* eslint-disable-next-line react/no-array-index-key */}
                <tbody>{g.items.map((x, i) => <tr key={i}><td>{x.date}</td><td>{x.category || '—'}</td><td>{x.amount ? rs(x.amount) : '—'}</td><td className="pl-note">{x.note || '—'}</td></tr>)}</tbody>
              </table></div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIEWS = [['people', 'People'], ['clients', 'Clients'], ['expenses', 'Expenses'], ['months', 'Month by month'], ['forecast', 'Forecast'], ['checks', 'To check']];

export default function ProfitLoss() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [month, setMonth] = useState('');
  const [view, setView] = useState('people');
  useEffect(() => {
    setErr('');
    api.get('/reports/accounts/pnl', { params: month ? { month } : {} })
      .then((r) => setD(r.data))
      .catch((e) => setErr(e.response?.data?.error || 'The profit and loss could not be loaded.'));
  }, [month]);
  if (err) return <div className="notice red"><span>{err}</span></div>;
  if (!d) return <div className="small-muted">Working out the profit and loss…</div>;

  const s = d.summary;
  const closed = d.rows.filter((r) => r.result !== null);
  const periodText = d.period.months.length === 1 ? monthName(d.period.months[0])
    : d.period.months.length ? `${monthName(d.period.months[0])} to ${monthName(d.period.months[d.period.months.length - 1])}` : '';
  const topEarner = d.people.find((p) => p.key !== 'none' && p.income > 0);
  const topClient = d.clients[0];
  const topCost = d.costLines[0];
  const checks = d.checks.reduce((t, g) => t + g.count, 0);

  return (
    <div className="pl" data-testid="profit-loss">
      <div className="pl-top">
        <div>
          <h2>Profit &amp; Loss</h2>
          <div className="small-muted">Financial year {d.fy} · closed months only (the running month waits for its bills)</div>
        </div>
        <label className="pl-period">
          <span className="small-muted">Period</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Period">
            <option value="">All closed months</option>
            {closed.slice().reverse().map((r) => <option key={r.month} value={r.month}>{monthName(r.month)}</option>)}
          </select>
        </label>
      </div>

      <div className={`pl-answer ${s.result < 0 ? 'is-loss' : 'is-profit'}`}>
        <div className="pl-answer-text">
          {periodText}: earned <b>{lakh(s.income)}</b>, spent <b>{lakh(s.costs)}</b>, so a <b>{s.result < 0 ? 'loss' : 'profit'} of {lakh(Math.abs(s.result))}</b>.
        </div>
        <div className="pl-answer-facts">
          {topEarner && <span>Top recruiter: <b>{topEarner.name}</b> ({lakh(topEarner.result)} after salary)</span>}
          {topClient && <span>Top client: <b>{topClient.name}</b> ({topClient.share}% of income)</span>}
          {topCost && <span>Biggest cost: <b>{topCost.name}</b> ({topCost.share}%)</span>}
          <span>Clients still owe: <b>{lakh(d.owed.amount)}</b> on {d.owed.invoices} invoices</span>
        </div>
      </div>

      <div className="pl-tabs" role="tablist" aria-label="Profit and loss views">
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={`pl-tab${view === id ? ' is-on' : ''}`} onClick={() => setView(id)}>
            {label}{id === 'checks' && checks ? <em>{checks}</em> : null}
          </button>
        ))}
      </div>

      {view === 'people' && <People d={d} />}
      {view === 'clients' && <Clients d={d} />}
      {view === 'expenses' && <Expenses d={d} />}
      {view === 'months' && <Months d={d} />}
      {view === 'forecast' && <Forecast d={d} />}
      {view === 'checks' && <Checks d={d} />}

      <p className="small-muted pl-rules">{d.rules}</p>
    </div>
  );
}
