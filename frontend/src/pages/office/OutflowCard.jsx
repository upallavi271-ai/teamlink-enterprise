// The Accounts dashboard's "Total Monthly Outflow" card (spec A §F): salary
// from payroll plus approved / paid office expenses for one month, from
// GET /api/accounts/combined-summary. Clicking it opens Office & Expenses on
// that month. Renders nothing for a login the API refuses.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';
import { money, MONTH_FULL } from './officeUtil';
import './office.css';

const monthOfDashSel = (sel) => {
  const m = /^M:(\d{4})-(\d{2})$/.exec(String(sel || ''));
  return m ? [Number(m[1]), Number(m[2]) - 1] : null;
};

export default function OutflowCard({ period }) {
  const navigate = useNavigate();
  const now = new Date();
  const [ym, setYm] = useState(() => monthOfDashSel(period) || [now.getFullYear(), now.getMonth()]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(false);

  // A month picked in the dashboard's own period filter moves the card too.
  useEffect(() => { const m = monthOfDashSel(period); if (m) setYm(m); }, [period]);

  const load = () => {
    setErr('');
    api.get('/accounts/combined-summary', { params: { month: ym[1] + 1, year: ym[0] } })
      .then((r) => setData(r.data))
      .catch((e) => {
        if (e.response?.status === 403 || e.response?.status === 401) setHidden(true);
        else setErr(e.response?.data?.error || 'The outflow could not be loaded.');
      });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [ym[0], ym[1]]);

  if (hidden) return null;
  const mk = `${ym[0]}-${String(ym[1] + 1).padStart(2, '0')}`;
  const go = () => navigate(`/office?month=${mk}`);
  const stop = (e) => e.stopPropagation();
  const years = [];
  for (let y = now.getFullYear() - 5; y <= now.getFullYear() + 1; y += 1) years.push(y);

  return (
    <div className="card section oe-outflow" role="link" tabIndex={0} onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
      title={`Open Office & Expenses for ${MONTH_FULL[ym[1]]} ${ym[0]}`}>
      <div className="oe-outflow-top">
        <div>
          <div className="oe-outflow-l">Total Monthly Outflow</div>
          <div className="oe-outflow-n">{data ? money(data.total_outflow) : (err ? '—' : '…')}</div>
        </div>
        <span className="oe-outflow-pick" onClick={stop} onKeyDown={stop} role="presentation">
          <select className="oe-sel" value={ym[1]} aria-label="Month" onChange={(e) => setYm([ym[0], Number(e.target.value)])}>
            {MONTH_FULL.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select className="oe-sel" value={ym[0]} aria-label="Year" onChange={(e) => setYm([Number(e.target.value), ym[1]])}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </span>
      </div>
      {err && <div className="oe-mb-err" onClick={stop} role="presentation">{err} <button type="button" className="link-btn" onClick={load}>Retry</button></div>}
      {data && (
        <>
          <div className="oe-outflow-split">
            Salary: <b>{money(data.total_salary_outflow)}</b>
            <span className="oe-outflow-bar">|</span>
            Office Expenses: <b>{money(data.total_office_expenses)}</b>
          </div>
          <div className="small-muted oe-outflow-note">
            Salary = approved/paid payroll net pay + employer PF/ESI
            {data.salary.source === 'none' ? ' (no payroll for this month)' : ''}
            {data.salary.not_yet_approved > 0 ? ` · ${data.salary.not_yet_approved} payroll record(s) not approved yet` : ''}
            {' · '}Office = approved + paid expenses after TDS. Open Office &amp; Expenses →
          </div>
          {data.possible_overlap > 0 && (
            <div className="oe-outflow-warn">
              {money(data.possible_overlap)} of the office expenses is booked under salary-type categories
              ({data.office.salary_like_list.join(', ')}) — if that is the same payroll, it is counted twice.
            </div>
          )}
        </>
      )}
    </div>
  );
}
