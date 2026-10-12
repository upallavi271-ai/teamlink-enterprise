// Accounts -> Journal & Ledger -> "Employee salary" tab (user spec 2026-10-09):
//   * the SUB-LEDGER under Salary payable: one per employee. Pick a person (or open one
//     from the list) and see, month by month: salary credited, amount paid, balance
//     payable - each with a link to its Journal voucher;
//   * the EMPLOYEE SALARY STATEMENT: the same person and period as a printable report:
//     each month's gross, deductions, net pay and paid date. Export Excel / PDF.
// Accounts roles and Super Admin / Admin only (the API answers 403 to everyone else).
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../proto.jsx';
import { money, errText, downloadFile } from '../payroll/payrollUi';
import PayslipView from '../payroll/PayslipView.jsx';
import SearchSelect from './SearchSelect.jsx';
import { StatusPill } from './SalaryVoucherPanel.jsx';
import './ledgerBooks.css';
import './salaryVoucher.css';

const num = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dash = (n) => (Number(n) ? num(n) : '—');

export default function EmployeeSalaryTab({ initialEmployeeId = '', onOpenVoucher = () => {} }) {
  const [list, setList] = useState(null);
  const [employeeId, setEmployeeId] = useState(initialEmployeeId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [slip, setSlip] = useState('');
  useEffect(() => { api.get('/accounts/salary/subledger').then((r) => setList(r.data)).catch((err) => { setList({ employees: [], totals: {} }); setError(errText(err, 'Could not load the employees.')); }); }, []);
  useEffect(() => {
    if (!employeeId) { setData(null); return; }
    setError('');
    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
    api.get(`/accounts/salary/statement?employeeId=${employeeId}${qs ? `&${qs}` : ''}`).then((r) => setData(r.data)).catch((err) => { setData(null); setError(errText(err, 'Could not load this employee.')); });
  }, [employeeId, from, to]);
  const options = useMemo(() => (list?.employees || []).map((e) => ({ value: e.employeeId, label: e.name || '(unnamed)', sub: e.department || '' })), [list]);
  const [sub, setSub] = useState(null);
  useEffect(() => {
    if (!employeeId) { setSub(null); return; }
    api.get(`/accounts/salary/subledger/${employeeId}${from || to ? `?${[from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')}` : ''}`).then((r) => setSub(r.data)).catch(() => setSub(null));
  }, [employeeId, from, to]);
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const people = (list?.employees || []).filter((e) => !q.trim() || `${e.name} ${e.department || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Employee salary - sub-ledger and statement">
          {employeeId && data && <>
            <button type="button" className="btn btn-sm" onClick={() => downloadFile(`/accounts/salary/statement?employeeId=${employeeId}${qs ? `&${qs}` : ''}&format=xlsx`, `salary-statement-${data.name}.xlsx`).catch((e) => setError(errText(e, 'Export failed')))}>Export Excel</button>
            <button type="button" className="btn btn-sm" onClick={() => downloadFile(`/accounts/salary/statement?employeeId=${employeeId}${qs ? `&${qs}` : ''}&format=pdf`, `salary-statement-${data.name}.pdf`).catch((e) => setError(errText(e, 'Export failed')))}>Export PDF</button>
          </>}
        </PanelHead>
        <div className="lb-filters">
          <SearchSelect label="Employee" value={employeeId} onChange={setEmployeeId} options={options} allLabel="Pick an employee" />
          <label className="lb-f"><span>From month</span><input type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="lb-f"><span>To month</span><input type="month" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {(from || to) && <button type="button" className="btn btn-sm" onClick={() => { setFrom(''); setTo(''); }}>All months</button>}
        </div>
        {error && <div className="lb-err">{error}</div>}
        {!employeeId ? (
          !list ? <EmptyMini>Loading…</EmptyMini> : list.employees.length === 0 ? <EmptyMini>No salary has been booked employee-wise yet. It appears here as soon as a payroll month is posted.</EmptyMini> : (
            <>
              <div className="sv-cards">
                <div className="c"><div className="v">{money(list.totals.credited)}</div><div className="l">Salary credited (all employees)</div></div>
                <div className="c green"><div className="v">{money(list.totals.paid)}</div><div className="l">Paid</div></div>
                <div className="c orange"><div className="v">{money(list.totals.balance)}</div><div className="l">Still payable</div></div>
              </div>
              <div className="lb-filters"><label className="lb-f"><span>Search</span><input type="search" placeholder="Name or department…" value={q} onChange={(e) => setQ(e.target.value)} /></label></div>
              <div className="tbl-wrap">
                <table className="lb-tbl">
                  <thead><tr><th>Employee</th><th>Department</th><th className="lb-num">Credited</th><th className="lb-num">Paid</th><th className="lb-num">Balance payable</th><th /></tr></thead>
                  <tbody>
                    {people.map((e) => (
                      <tr key={e.employeeId}>
                        <td><b>{e.name}</b></td><td className="cell-muted">{e.department || '—'}</td>
                        <td className="lb-num">{num(e.credited)}</td><td className="lb-num">{num(e.paid)}</td><td className="lb-num"><b>{num(e.balance)}</b></td>
                        <td><button type="button" className="btn btn-sm" onClick={() => setEmployeeId(e.employeeId)}>Open</button></td>
                      </tr>
                    ))}
                    {people.length === 0 && <tr><td colSpan="6" className="cell-muted">Nobody matches that.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : !data ? <EmptyMini>{error ? '' : 'Loading…'}</EmptyMini> : (
          <>
            <div className="sv-cards">
              <div className="c"><div className="v">{data.name}</div><div className="l">{data.code || ''}{data.department ? ` · ${data.department}` : ''}</div></div>
              <div className="c"><div className="v">{money(data.totals.net)}</div><div className="l">Net pay credited</div></div>
              <div className="c green"><div className="v">{money(data.totals.paid)}</div><div className="l">Paid</div></div>
              <div className="c orange"><div className="v">{money(data.totals.balance)}</div><div className="l">Balance payable</div></div>
            </div>
            {data.months.length === 0 ? <EmptyMini>No salary booked for this person in these months.</EmptyMini> : (
              <div className="tbl-wrap">
                <table className="lb-tbl">
                  <thead>
                    <tr><th>Month</th><th className="lb-num">Gross</th><th className="lb-num">PF</th><th className="lb-num">ESI</th><th className="lb-num">TDS</th><th className="lb-num">Other deductions</th><th className="lb-num">Net pay</th><th className="lb-num">Paid</th><th className="lb-num">Balance</th><th>Status</th><th>Paid on</th><th>Mode / Ref</th><th>Vouchers</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td><b>{m.label}</b></td>
                        <td className="lb-num">{num(m.gross)}</td><td className="lb-num">{dash(m.pf)}</td><td className="lb-num">{dash(m.esi)}</td><td className="lb-num">{dash(m.tds)}</td><td className="lb-num">{dash(m.other)}</td>
                        <td className="lb-num"><b>{num(m.net)}</b>{m.adjustments ? <div className="lb-note">incl. corrections {m.adjustments > 0 ? '+' : '−'}{num(Math.abs(m.adjustments))}</div> : null}</td>
                        <td className="lb-num">{dash(m.paid)}</td><td className="lb-num"><b>{num(m.balance)}</b></td>
                        <td><StatusPill status={m.status} label={m.statusLabel} /></td>
                        <td>{m.paidOn || '—'}</td>
                        <td>{m.mode ? `${m.mode}${m.reference ? ` · ${m.reference}` : ''}` : '—'}</td>
                        <td style={{ whiteSpace: 'normal', minWidth: 130 }}>
                          {[...m.vouchers, ...m.paymentVouchers].map((v) => <button type="button" key={`${v.id}`} className="link-btn" style={{ marginRight: 8 }} onClick={() => onOpenVoucher(v.id)}>{v.voucherNo}</button>)}
                        </td>
                        <td>{m.payslipId && <button type="button" className="btn btn-sm" onClick={() => setSlip(m.payslipId)}>View payslip</button>}</td>
                      </tr>
                    ))}
                    <tr className="lb-tot">
                      <td>Total</td><td className="lb-num">{num(data.totals.gross)}</td><td className="lb-num">{num(data.totals.pf)}</td><td className="lb-num">{num(data.totals.esi)}</td><td className="lb-num">{num(data.totals.tds)}</td><td className="lb-num">{num(data.totals.other)}</td>
                      <td className="lb-num">{num(data.totals.net)}</td><td className="lb-num">{num(data.totals.paid)}</td><td className="lb-num">{num(data.totals.balance)}</td><td colSpan="5" />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {sub && sub.matchesLedger === false && <div className="lb-err">This sub-ledger and the Salary payable ledger differ by {money(sub.ledgerBalance - sub.balance)} - tell Accounts support.</div>}
            {sub && sub.matchesLedger === true && <div className="sv-note" style={{ padding: '0 18px 12px' }}>Sub-ledger under Salary payable ({sub.accountCode}): balance {money(sub.balance)} - agrees with the ledger.</div>}
          </>
        )}
      </Panel>
      {slip && <PayslipView payslipId={slip} onClose={() => setSlip('')} />}
    </>
  );
}
