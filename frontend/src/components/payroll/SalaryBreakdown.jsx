// THE SALARY BREAKUP IN THE DETAILS WINDOW (founder 2026-11-27: "give me the clear salary break down on the process payroll in detail
// button"): the big figures first, then the days, what was earned part by part, what was cut, the take-home, and what the company pays
// on top. Every figure comes from the server (backend utils/payrollSalaryLines.js), from the stored record: nothing is worked out here.
import { LopLink } from './LopBreakdown.jsx';

// rupees; paise only when there are any (pay-register months)
const rs = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${v < 0 ? '−' : ''}₹${Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const dayCount = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;
const shortDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

function Tile({ label, value, note, strong }) {
  return (
    <div className={`psb-tile${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {note && <small>{note}</small>}
    </div>
  );
}

export default function SalaryBreakdown({ entry: e, lines: l, onLop, ctcNote }) {
  const join = e.join;
  const lopDays = join ? join.lopDays : l.days.unpaidDays;
  const cutAnything = l.totals.cut !== 0;
  return (
    <div className="psb" data-testid="salary-breakdown">
      <div className="psb-tiles">
        <Tile label="Monthly CTC" value={e.monthlyCtc ? rs(e.monthlyCtc) : '—'} note={ctcNote} />
        <Tile label="Full-month salary (gross)" value={rs(l.totals.full)} />
        <Tile label="Earned this month" value={rs(l.totals.earned)} note={cutAnything ? `${rs(l.totals.cut)} cut for unpaid days` : 'Nothing cut for days'} />
        <Tile label="Deductions" value={rs(l.deductionsTotal)} />
        <Tile label="Take-home (net pay)" value={rs(l.netPay)} strong />
      </div>

      <h4>Days</h4>
      <div className="psb-days" data-testid="psb-days">
        <span><b>{dayCount(l.days.workingDays)}</b> days in the pay period</span>
        {join && <><i>−</i><span><b>{dayCount(join.beforeDays)}</b> before joining ({shortDay(join.joinedOn)})</span></>}
        <i>−</i>
        <span><b>{onLop ? <LopLink value={lopDays} onOpen={onLop} title="See which dates were counted as loss of pay, and why" /> : dayCount(lopDays)}</b> loss of pay (LOP)</span>
        <i>=</i>
        <span className="psb-paid"><b>{dayCount(l.days.paidDays)}</b> paid days</span>
      </div>
      <div className="psb-note">{l.imported ? 'Days from the pay register.' : e.attendanceSource === 'OVERRIDE' ? 'Days typed or imported by HR.' : 'Days from the attendance module.'}{onLop && lopDays > 0 ? ' Click the LOP number to see the dates.' : ''}</div>

      <h4>Earnings</h4>
      <div className="psb-scroll">
        <table className="psb-table" data-testid="psb-earnings">
          <thead><tr><th>Salary part</th><th>Full month</th><th>Cut for unpaid days</th><th>Earned</th></tr></thead>
          <tbody>
            {l.earnings.map((x) => (
              <tr key={x.key}><td>{x.label}</td><td>{x.full ? rs(x.full) : '—'}</td><td className={x.cut ? 'psb-cut' : 'psb-zero'}>{x.cut ? `− ${rs(x.cut)}` : '—'}</td><td>{rs(x.earned)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td>{rs(l.totals.full)}</td><td className={l.totals.cut ? 'psb-cut' : 'psb-zero'}>{l.totals.cut ? `− ${rs(l.totals.cut)}` : '—'}</td><td>{rs(l.totals.earned)}</td></tr></tfoot>
        </table>
      </div>
      {join && <div className="psb-note">The cut is {rs(join.amounts.beforeJoining)} for the days before joining and {rs(join.amounts.lop)} for loss of pay.</div>}
      {Number(e.incentive) > 0 && <div className="psb-note">Incentive: recruiter joinings, given by Super Admin.</div>}

      <h4>Deductions (cut from the salary)</h4>
      <div className="psb-scroll">
        <table className="psb-table psb-ded" data-testid="psb-deductions">
          <thead><tr><th>Deduction</th><th>How it is worked out</th><th>Amount</th></tr></thead>
          <tbody>
            {l.deductions.map((x) => (
              <tr key={x.key}><td>{x.label}</td><td className="psb-how">{x.how}</td><td className={x.amount ? undefined : 'psb-zero'}>{rs(x.amount)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan="2">Total deductions</td><td>{rs(l.deductionsTotal)}</td></tr></tfoot>
        </table>
      </div>

      <div className="psb-net" data-testid="psb-net">
        <span>Earned {rs(l.totals.earned)} − deductions {rs(l.deductionsTotal)}</span>
        <b>Take-home {rs(l.netPay)}</b>
      </div>
      {!l.addsUp && (
        <div className="error-text" data-testid="psb-gap">
          {l.imported
            ? `These are the pay register's own figures: its net pay is ${rs(Math.abs(l.gap))} ${l.gap > 0 ? 'more' : 'less'} than earned minus deductions.`
            : `The stored figures differ by ${rs(Math.abs(l.gap))} from the net pay. Open Edit and check this record.`}
        </div>
      )}

      <h4>Paid by the company on top (not cut from the salary)</h4>
      <div className="psb-scroll">
        <table className="psb-table psb-two" data-testid="psb-employer">
          <tbody>
            {l.employer.map((x) => (
              <tr key={x.key}><td>{x.label}</td><td className={x.amount ? undefined : 'psb-zero'}>{rs(x.amount)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td>Cost to the company this month (earned + company share)</td><td>{rs(l.costThisMonth)}</td></tr></tfoot>
        </table>
      </div>
    </div>
  );
}
