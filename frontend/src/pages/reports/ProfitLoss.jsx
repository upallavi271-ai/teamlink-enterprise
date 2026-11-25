import { useEffect, useState } from 'react';
import api from '../../api';
import './profitLoss.css';

// ---------------------------------------------------------------------------
// PROFIT & LOSS + FORECAST (founder 2026-11-25: "Give me the profit and loss predictions for this invoice and expenses" -> "i need this in
// accounts"). Accounts > Reports > "Profit & Loss". Month by month for the financial year, what is owed, a what-if forecast to March, and
// the entries worth a second look. GET /api/reports/accounts/pnl (utils/profitLoss.js) - read-only.
// ---------------------------------------------------------------------------
const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const lakh = (n) => `${n < 0 ? '−' : ''}₹${(Math.abs(Number(n) || 0) / 100000).toFixed(1)} L`;
const big = (n) => (Math.abs(n) >= 10000000 ? `${n < 0 ? '−' : ''}₹${(Math.abs(n) / 10000000).toFixed(2)} Cr` : lakh(n));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (k) => `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const sign = (n) => (n < 0 ? 'pl-neg' : 'pl-pos');

function Bars({ rows }) {
  const closed = rows.filter((r) => r.result !== null);
  if (!closed.length) return null;
  const top = Math.max(...closed.map((r) => Math.max(r.income, r.costs)), 1);
  return (
    <div className="pl-bars" role="img" aria-label="Income and costs by month">
      {closed.map((r) => (
        <div key={r.month} className="pl-bar-col" title={`${monthName(r.month)}: income ${rs(r.income)}, costs ${rs(r.costs)}, result ${rs(r.result)}`}>
          <div className="pl-bar-pair">
            <span className="pl-bar inc" style={{ height: `${(r.income / top) * 100}%` }} />
            <span className="pl-bar cost" style={{ height: `${(r.costs / top) * 100}%` }} />
          </div>
          <b className={sign(r.result)}>{lakh(r.result)}</b>
          <span className="small-muted">{monthName(r.month).slice(0, 3)}</span>
        </div>
      ))}
    </div>
  );
}

function Slider({ id, label, value, set, min, max, step, show, hint }) {
  return (
    <div className="pl-ctl">
      <label htmlFor={id}><span>{label}</span><output>{show(value)}</output></label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
      {hint && <small className="small-muted">{hint}</small>}
    </div>
  );
}

export default function ProfitLoss() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState(null); // the forecast inputs
  const [open, setOpen] = useState('');
  useEffect(() => {
    api.get('/reports/accounts/pnl')
      .then((r) => { setD(r.data); const x = r.data.forecast.defaults; setF({ joinings: x.joinings || 20, fee: x.fee || 30000, payroll: x.payroll, office: x.office, statutory: x.statutory }); })
      .catch((e) => setErr(e.response?.data?.error || 'The profit and loss could not be loaded.'));
  }, []);
  if (err) return <div className="notice red"><span>{err}</span></div>;
  if (!d || !f) return <div className="small-muted">Working out the profit and loss…</div>;

  const t = d.totals;
  const def = d.forecast.defaults;
  const inc = f.joinings * f.fee;
  const cost = f.payroll + f.office + f.statutory;
  const pl = inc - cost;
  const rest = pl * d.forecast.remainingMonths;
  const fy = d.forecast.actualSoFar + rest;
  const breakEven = f.fee > 0 ? Math.ceil(cost / f.fee) : 0;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const scenario = (j, fee) => setF((x) => ({ ...x, joinings: j, fee }));
  const lastMonth = d.rows.length ? d.rows[d.rows.length - 1] : null;

  return (
    <div className="pl" data-testid="profit-loss">
      <div className="page-head">
        <div>
          <h1>Profit &amp; Loss</h1>
          <div className="page-sub">Financial year {d.fy}: month by month, and a forecast to March</div>
        </div>
      </div>

      <div className="pl-kpis">
        <div className="card pl-kpi"><span>Result, {t.months} month{t.months === 1 ? '' : 's'} closed</span><b className={sign(t.result)}>{lakh(t.result)}</b><small className="small-muted">about {lakh(t.averageResult)} a month</small></div>
        <div className="card pl-kpi"><span>Running cost a month</span><b>{lakh(def.payroll + def.office + def.statutory)}</b><small className="small-muted">payroll {lakh(def.payroll)} · office {lakh(def.office)} · PF/ESI {lakh(def.statutory)}</small></div>
        <div className="card pl-kpi"><span>Unpaid invoices</span><b>{lakh(d.owed.amount)}</b><small className="small-muted">{d.owed.invoices} invoices waiting for payment</small></div>
        <div className="card pl-kpi"><span>Break-even</span><b>{breakEven} joinings</b><small className="small-muted">a month, at {rs(f.fee)} a joining</small></div>
      </div>

      <div className="card pl-sec">
        <div className="pl-sec-head"><h3>Month by month</h3><span className="pl-legend"><i className="inc" />Income <i className="cost" />Costs</span></div>
        <Bars rows={d.rows} />
        <div className="pl-scroll">
          <table className="pl-table">
            <thead><tr><th>Month</th><th>Joinings</th><th>Invoiced (before GST)</th><th>Payroll</th><th>Office bills</th><th>PF / ESI / PT</th><th>Profit / loss</th><th>Money received</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.month} className={r.result === null ? 'pl-open' : ''}>
                  <td>{monthName(r.month)}{r.open ? ' (so far)' : ''}</td>
                  <td>{r.joinings}</td><td>{rs(r.income)}</td><td>{rs(r.payroll)}</td>
                  <td>{r.noBills ? 'not entered' : rs(r.office)}</td><td>{r.noBills ? '—' : rs(r.statutory)}</td>
                  <td className={r.result === null ? '' : sign(r.result)}>{r.result === null ? '—' : rs(r.result)}</td>
                  <td>{rs(r.received)}</td>
                </tr>
              ))}
              <tr className="pl-total"><td>Closed months</td><td /><td>{rs(t.income)}</td><td colSpan={3}>costs {rs(t.costs)}</td><td className={sign(t.result)}>{rs(t.result)}</td><td>{rs(t.received)}</td></tr>
            </tbody>
          </table>
        </div>
        <p className="small-muted">{d.rules}</p>
      </div>

      <div className="card pl-sec">
        <div className="pl-sec-head"><h3>Forecast to March</h3><span className="small-muted">{d.forecast.remainingMonths} month{d.forecast.remainingMonths === 1 ? '' : 's'} left, from {lastMonth ? monthName(lastMonth.month) : 'now'}</span></div>
        <div className="pl-chips" role="group" aria-label="Quick scenario">
          <button type="button" className="btn btn-sm" onClick={() => scenario(Math.max(1, Math.round(def.joinings * 0.75)), Math.round((def.fee * 0.85) / 1000) * 1000)}>Low</button>
          <button type="button" className="btn btn-sm" onClick={() => setF({ joinings: def.joinings, fee: def.fee, payroll: def.payroll, office: def.office, statutory: def.statutory })}>Like the last 3 months</button>
          <button type="button" className="btn btn-sm" onClick={() => scenario(Math.round(def.joinings * 1.25), Math.round((def.fee * 1.15) / 1000) * 1000)}>High</button>
        </div>
        <div className="pl-what">
          <div className="pl-ctls">
            <Slider id="pl-j" label="Joinings a month" value={f.joinings} set={set('joinings')} min={0} max={80} step={1} show={(v) => v} hint={`Last 3 months: ${def.joinings} a month`} />
            <Slider id="pl-f" label="Fee per joining" value={f.fee} set={set('fee')} min={10000} max={80000} step={1000} show={rs} hint={`Last 3 months: ${rs(def.fee)}`} />
            <Slider id="pl-p" label="Payroll a month" value={f.payroll} set={set('payroll')} min={0} max={Math.max(1500000, def.payroll * 2)} step={10000} show={lakh} hint={`Latest run: ${lakh(def.payroll)}`} />
            <Slider id="pl-o" label="Office bills a month" value={f.office} set={set('office')} min={0} max={Math.max(1500000, def.office * 2)} step={10000} show={lakh} hint={`Last 6 months: ${lakh(def.office)}`} />
          </div>
          <div className="pl-result" aria-live="polite">
            <div><span>Income a month</span><b>{lakh(inc)}</b></div>
            <div><span>Costs a month</span><b>{lakh(cost)}</b></div>
            <div className="pl-big"><span>Profit / loss a month</span><b className={sign(pl)}>{lakh(pl)}</b></div>
            <div><span>Closed months (actual)</span><b className={sign(d.forecast.actualSoFar)}>{lakh(d.forecast.actualSoFar)}</b></div>
            <div><span>Rest of the year ({d.forecast.remainingMonths} months)</span><b className={sign(rest)}>{lakh(rest)}</b></div>
            <div className="pl-big"><span>Full year {d.fy}</span><b className={sign(fy)}>{big(fy)}</b></div>
            <div><span>Joinings needed to break even</span><b>{breakEven} a month</b></div>
          </div>
        </div>
      </div>

      {d.checks.length > 0 && (
        <div className="card pl-sec">
          <h3>Entries to check</h3>
          <p className="small-muted">These make the books harder to read. Nothing is changed here; open Office / Business to correct an entry.</p>
          <ul className="pl-checks">
            {d.checks.map((g) => (
              <li key={g.kind}>
                <button type="button" className="pl-check-head" aria-expanded={open === g.kind} onClick={() => setOpen(open === g.kind ? '' : g.kind)}>
                  <b>{g.title}</b> <span className="small-muted">({g.count}{g.amount ? `, ${rs(g.amount)}` : ''})</span>
                </button>
                <div className="small-muted">{g.effect}</div>
                {open === g.kind && (
                  <div className="pl-scroll"><table className="pl-table pl-mini">
                    <thead><tr><th>Date</th><th>Category</th><th>Amount</th><th>Note on the entry</th></tr></thead>
                    <tbody>{g.items.map((x, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <tr key={i}><td>{x.date}</td><td>{x.category || '—'}</td><td>{x.amount ? rs(x.amount) : '—'}</td><td className="pl-note">{x.note || '—'}</td></tr>
                    ))}</tbody>
                  </table></div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
