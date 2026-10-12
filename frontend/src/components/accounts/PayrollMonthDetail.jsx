// Accounts -> Journal & Ledger -> Payroll Mapping -> Payroll months -> Open
// (Accounts fixes, 2026-10-09). Clicking Open shows the whole month at once,
// one row per employee, no more clicks. Accounts roles and Super Admin / Admin
// only - the API answers 403 to everyone else (routes/journal.js).
//
//   * the month is named at the top, with "Back to Payroll months";
//   * the cards (gross, deductions, net pay, total paid) are the sum of the very
//     rows in the table - they cannot disagree;
//   * search, Department and Payment status filters (the options carry counts and
//     narrow each other);
//   * Export Excel / Export CSV: separate plain buttons, the filters apply;
//   * an empty part of the pay ("—") is shown as a dash.
import { useEffect, useRef, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../proto.jsx';
import { money, monthLabel, errText, downloadFile } from '../payroll/payrollUi';
import PayrollAccountsStrip from '../payroll/PayrollAccountsStrip.jsx';
import { FacetSelect } from '../ui/ListPageHeader.jsx';
import './ledgerBooks.css';
import './accountsScroll.css';
import './payrollMonthDetail.css';

const num = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const part = (n) => (Number(n) ? num(n) : '—'); // an empty optional part

export default function PayrollMonthDetail({ month, onBack, onChanged = () => {} }) {
  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [dept, setDept] = useState('');
  const [pay, setPay] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQDeb(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const qs = () => [qDeb && `q=${encodeURIComponent(qDeb)}`, dept && `department=${encodeURIComponent(dept)}`, pay && `paymentStatus=${encodeURIComponent(pay)}`].filter(Boolean).join('&');

  useEffect(() => {
    const mine = seq.current + 1;
    seq.current = mine;
    setBusy(true); setError('');
    api.get(`/accounts/payroll-months/${month}/details?${qs()}`).then((r) => {
      if (seq.current === mine) setData(r.data);
    }).catch((err) => {
      if (seq.current === mine) setError(err?.response?.status === 403 ? 'Payroll details are for the Accounts team and Admin only.' : errText(err, 'Could not load this month. Please try again.'));
    }).finally(() => { if (seq.current === mine) setBusy(false); });
  }, [month, qDeb, dept, pay, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // A month change starts clean.
  useEffect(() => { setQ(''); setQDeb(''); setDept(''); setPay(''); setData(null); }, [month]);

  const filtered = !!(q.trim() || dept || pay);
  const clear = () => { setQ(''); setQDeb(''); setDept(''); setPay(''); };
  function exportAs(fmt) {
    setError('');
    downloadFile(`/accounts/payroll-months/${month}/details?${[qs(), `format=${fmt}`].filter(Boolean).join('&')}`, `payroll-${month}.${fmt}`)
      .catch(async (e) => {
        let msg = errText(e, 'Export failed');
        const blob = e?.response?.data;
        if (blob instanceof Blob) { try { msg = JSON.parse(await blob.text()).error || msg; } catch { /* keep */ } }
        setError(msg);
      });
  }
  const t = data?.totals;
  const rows = data?.rows || [];
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title={`Payroll — ${monthLabel(month)}`}>
        <span className="pmd-actions">
          <button type="button" className="btn btn-sm" onClick={onBack}>← Back to Payroll months</button>
          <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={() => exportAs('xlsx')}>Export Excel</button>
          <button type="button" className="btn btn-sm" disabled={!rows.length} onClick={() => exportAs('csv')}>Export CSV</button>
        </span>
      </PanelHead>
      <PayrollAccountsStrip month={month} onChanged={() => { setReload((x) => x + 1); onChanged(); }} compact />
      {error && <div className="lb-err">{error} <button type="button" className="link-btn" onClick={() => setReload((x) => x + 1)}>Try again</button></div>}
      {!data && !error ? <EmptyMini>Loading the salary sheet for {monthLabel(month)}…</EmptyMini> : null}
      {data && (
        <>
          <div className="pmd-sel">
            Showing <b>{monthLabel(month)}</b> · {data.records} employee{data.records === 1 ? '' : 's'}
            {data.importedCount ? <> · {data.importedCount} from the pay register sheet</> : null}
            {filtered && <> · <b>{data.shown}</b> match your filters</>}
          </div>
          <div className="lb-cards">
            <div className="lb-card"><div className="v">{t.employees}</div><div className="l">{filtered ? 'Employees shown' : 'Employees'}</div></div>
            <div className="lb-card"><div className="v">{money(t.gross)}</div><div className="l">Gross pay</div></div>
            <div className="lb-card"><div className="v">{money(t.totalDeductions)}</div><div className="l">Deductions</div></div>
            <div className="lb-card"><div className="v">{money(t.netPay)}</div><div className="l">Net pay</div></div>
            <div className="lb-card"><div className="v">{money(t.totalPaid)}</div><div className="l">Total paid · {t.paidEmployees} of {t.employees}</div></div>
          </div>
          {filtered && <div className="lb-note" style={{ padding: '0 18px' }}>These cards add up only the {data.shown} employee{data.shown === 1 ? '' : 's'} shown. Whole month: net pay {money(data.monthTotals.netPay)}.</div>}
          <div className="lb-filters">
            <label className="lb-f"><span>Search</span><input type="search" placeholder="Name or employee ID" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <FacetSelect label="Department" value={dept} onChange={setDept} options={data.facets.departments} allLabel="All departments" />
            <FacetSelect label="Payment status" value={pay} onChange={setPay} options={data.facets.statuses} allLabel="Paid and not paid" />
            {filtered && <button type="button" className="btn btn-sm" onClick={clear}>Clear filters</button>}
            {busy && <span className="lb-note">Updating…</span>}
          </div>
          {rows.length === 0 ? (
            <EmptyMini>
              {data.records === 0
                ? `There are no payroll records for ${monthLabel(month)} yet.`
                : <>No employee matches these filters. <button type="button" className="link-btn" onClick={clear}>Clear filters</button></>}
            </EmptyMini>
          ) : (
            <div className="tbl-wrap acc-scroll pmd-wrap">
              <table className="lb-tbl pmd-tbl">
                <thead>
                  <tr>
                    <th>Employee ID</th><th>Name</th><th>Department</th><th>Designation</th>
                    <th className="lb-num">Working days</th><th className="lb-num">Paid days</th>
                    <th className="lb-num">Basic</th><th className="lb-num">HRA</th><th className="lb-num">Conveyance</th><th className="lb-num">Arrears</th>
                    <th className="lb-num">Other allowances</th><th className="lb-num">Incentives</th><th className="lb-num">Gross</th>
                    <th className="lb-num">PF</th><th className="lb-num">ESI</th><th className="lb-num">TDS</th><th className="lb-num" title="Pay cut for days not worked">Loss of pay</th>
                    <th className="lb-num" title="Professional tax and any other deduction">Other deductions</th><th className="lb-num">Total deductions</th>
                    <th className="lb-num">Net pay</th><th>Payment status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.employeeCode || '—'}</b></td>
                      <td>{r.name}</td>
                      <td className="cell-muted">{r.department || '—'}</td>
                      <td className="cell-muted">{r.designation || '—'}</td>
                      <td className="lb-num">{num(r.workingDays)}</td>
                      <td className="lb-num">{num(r.paidDays)}</td>
                      <td className="lb-num">{part(r.basic)}</td><td className="lb-num">{part(r.hra)}</td>
                      <td className="lb-num">{part(r.conveyance)}</td><td className="lb-num">{part(r.arrears)}</td>
                      <td className="lb-num">{part(r.otherAllowances)}</td><td className="lb-num">{part(r.incentive)}</td>
                      <td className="lb-num"><b>{num(r.gross)}</b></td>
                      <td className="lb-num">{part(r.pf)}</td><td className="lb-num">{part(r.esi)}</td><td className="lb-num">{part(r.tds)}</td>
                      <td className="lb-num">{part(r.lossOfPay)}</td><td className="lb-num">{part(r.otherDeductions)}</td>
                      <td className="lb-num">{num(r.totalDeductions)}</td>
                      <td className="lb-num"><b>{num(r.netPay)}</b>{r.netNote && <span className="pmd-info" title={r.netNote} aria-label={r.netNote}> ⓘ</span>}</td>
                      <td>
                        {r.paymentStatus === 'Paid'
                          ? <span className="lb-badge green">Paid{r.paidOn ? ` · ${r.paidOn}` : ''}</span>
                          : <span className="lb-badge orange" title={r.stage}>Not paid yet</span>}
                      </td>
                    </tr>
                  ))}
                  <tr className="lb-tot">
                    <td colSpan="4">TOTAL · {t.employees} employee{t.employees === 1 ? '' : 's'}</td>
                    <td /><td />
                    <td className="lb-num">{part(t.basic)}</td><td className="lb-num">{part(t.hra)}</td><td className="lb-num">{part(t.conveyance)}</td><td className="lb-num">{part(t.arrears)}</td>
                    <td className="lb-num">{part(t.otherAllowances)}</td><td className="lb-num">{part(t.incentive)}</td><td className="lb-num">{num(t.gross)}</td>
                    <td className="lb-num">{part(t.pf)}</td><td className="lb-num">{part(t.esi)}</td><td className="lb-num">{part(t.tds)}</td><td className="lb-num">{part(t.lossOfPay)}</td><td className="lb-num">{part(t.otherDeductions)}</td>
                    <td className="lb-num">{num(t.totalDeductions)}</td><td className="lb-num">{num(t.netPay)}</td><td>Paid {num(t.totalPaid)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <div className="lb-note" style={{ padding: '8px 18px 14px' }}>
            Salary parts are the full-month figures; days not worked show as <b>Loss of pay</b>. Figures from the pay register sheets are shown exactly as stored. A dash (—) means nothing in that part. {data.rows.some((r) => r.netNote) ? 'ⓘ marks a net pay that is the register’s figure and differs from gross minus deductions — hover to read why.' : ''}
          </div>
        </>
      )}
    </Panel>
  );
}
