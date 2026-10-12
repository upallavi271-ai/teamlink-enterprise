// Accounts -> Journal & Ledger -> Journal: one salary voucher opened INSIDE the Journal
// (user spec 2026-10-09). Accounts roles and Super Admin / Admin only - the server sends
// this data to nobody else.
//
//   Payroll voucher     tab "Employee-wise": Emp ID | Employee | Department | Gross | PF | ESI | TDS |
//                       Other deductions | Net pay | Payment status | Paid on | Mode / Ref, a totals row
//                       equal to the voucher total, search, sortable columns, View payslip (read-only).
//                       tab "Accounting lines": ledger, Dr, Cr. One main button: Pay salary.
//   Payment voucher     who was paid how much, when, how, UTR.
//   Adjustment voucher  the correction for one employee.
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { EmptyMini, Modal } from '../proto.jsx';
import { money, errText } from '../payroll/payrollUi';
import PayslipView from '../payroll/PayslipView.jsx';
import './ledgerBooks.css';
import './salaryVoucher.css';

const num = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dash = (n) => (Number(n) ? num(n) : '—');
const today = () => new Date().toISOString().slice(0, 10);

export function StatusPill({ status, label }) {
  const cls = status === 'PAID' ? 'paid' : status === 'PARTIAL' ? 'partial' : 'unpaid';
  return <span className={`sv-st ${cls}`}>{label || (status === 'PAID' ? 'Paid' : status === 'PARTIAL' ? 'Partially paid' : 'Unpaid')}</span>;
}

function useSorted(rows, initial) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const list = [...rows];
    const { key, dir } = sort;
    list.sort((a, b) => {
      const x = a[key]; const y = b[key];
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
      return dir === 'asc' ? c : -c;
    });
    return list;
  }, [rows, sort]);
  const head = (key, label, cls = '') => (
    <th className={cls} onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key && <span className="sv-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
  return { sorted, head };
}

// ---- Pay salary ------------------------------------------------------------------------------
function PayDialog({ detail, entryId, onClose, onDone }) {
  const owed = detail.rows.filter((r) => r.balance > 0);
  const [mode, setMode] = useState('Bank transfer');
  const [date, setDate] = useState(today());
  const [ref, setRef] = useState('');
  const [bank, setBank] = useState('');
  const [banks, setBanks] = useState([]);
  const [pick, setPick] = useState(() => Object.fromEntries(owed.map((r) => [r.employeeId, { on: true, amount: String(r.balance), ref: '' }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/accounts/salary/banks').then((r) => setBanks(r.data)).catch(() => setBanks([])); }, []);
  const chosen = owed.filter((r) => pick[r.employeeId]?.on);
  const total = chosen.reduce((n, r) => n + Math.round((Number(pick[r.employeeId].amount) || 0) * 100), 0) / 100;
  async function submit() {
    setBusy(true); setError('');
    try {
      const items = chosen.map((r) => ({ employeeId: r.employeeId, amount: Number(pick[r.employeeId].amount), reference: pick[r.employeeId].ref || undefined }));
      const r = await api.post(`/accounts/salary/vouchers/${entryId}/pay`, {
        items, date, mode, reference: ref || undefined, bankAccountId: mode === 'Cash' ? undefined : (bank || undefined),
      });
      onDone(r.data.already ? 'Already paid - nothing changed.' : `Saved - ${r.data.paid} employee${r.data.paid === 1 ? '' : 's'} paid ${money(total)}${r.data.voucherNo ? ` (${r.data.voucherNo})` : ''}.`, r.data.detail);
    } catch (err) { setError(errText(err, 'Could not save the payment.')); } finally { setBusy(false); }
  }
  return (
    <Modal
      wide
      title="Pay salary"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !chosen.length || total <= 0} onClick={submit}>{busy ? 'Saving…' : `Pay ${chosen.length} employee${chosen.length === 1 ? '' : 's'} · ${money(total)}`}</button>
        </>
      )}
    >
      <div className="sv-form" style={{ marginBottom: 12 }}>
        <label className="sv-full">How was it paid?
          <div className="sv-modes">
            {['Bank transfer', 'Cash', 'Cheque'].map((m) => <button type="button" key={m} className={`btn btn-sm ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m}</button>)}
          </div>
        </label>
        <label>Paid on<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {mode !== 'Cash' && (
          <label>From which bank
            <select value={bank} onChange={(e) => setBank(e.target.value)}>
              <option value="">Main bank account</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </label>
        )}
        <label>{mode === 'Cheque' ? 'Cheque no.' : 'UTR / reference'} (for everyone)<input type="text" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. batch UTR" /></label>
      </div>
      {error && <div className="lb-err" style={{ margin: '0 0 10px' }}>{error}</div>}
      <div className="tbl-wrap">
        <table className="lb-tbl sv-pay-tbl">
          <thead>
            <tr>
              <th><input type="checkbox" checked={chosen.length === owed.length} onChange={(e) => setPick(Object.fromEntries(owed.map((r) => [r.employeeId, { ...pick[r.employeeId], on: e.target.checked }])))} aria-label="Select all" /></th>
              <th>Employee</th><th className="lb-num">Still to pay</th><th className="lb-num">Pay now</th><th>Own UTR / ref (optional)</th>
            </tr>
          </thead>
          <tbody>
            {owed.map((r) => (
              <tr key={r.employeeId}>
                <td><input type="checkbox" checked={!!pick[r.employeeId]?.on} onChange={(e) => setPick((p) => ({ ...p, [r.employeeId]: { ...p[r.employeeId], on: e.target.checked } }))} aria-label={`Pay ${r.name}`} /></td>
                <td><b>{r.name}</b><div className="lb-note">{r.employeeCode || ''}{r.department ? ` · ${r.department}` : ''}</div></td>
                <td className="lb-num">{money(r.balance)}</td>
                <td className="lb-num"><input type="number" min="0" step="0.01" value={pick[r.employeeId]?.amount ?? ''} onChange={(e) => setPick((p) => ({ ...p, [r.employeeId]: { ...p[r.employeeId], amount: e.target.value } }))} /></td>
                <td><input type="text" value={pick[r.employeeId]?.ref ?? ''} onChange={(e) => setPick((p) => ({ ...p, [r.employeeId]: { ...p[r.employeeId], ref: e.target.value } }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sv-note">Paying less than what is owed makes the employee &quot;Partially paid&quot;. One payment voucher is booked: Salary payable − each name, and {mode === 'Cash' ? 'Cash' : 'the bank'}.</div>
    </Modal>
  );
}

// ---- A correction (adjustment voucher) ------------------------------------------------------------
function FixDialog({ row, entryId, onClose, onDone }) {
  const [v, setV] = useState({ earnedGross: '', pf: '', esi: '', tds: '', professionalTax: '', otherDeductions: '' });
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = (k) => Math.round((Number(v[k]) || 0) * 100);
  const net = (n('earnedGross') - n('pf') - n('esi') - n('tds') - n('professionalTax') - n('otherDeductions')) / 100;
  async function submit() {
    setBusy(true); setError('');
    try {
      const deltas = Object.fromEntries(Object.keys(v).map((k) => [k, Number(v[k]) || 0]));
      const r = await api.post(`/accounts/salary/vouchers/${entryId}/adjust`, { employeeId: row.employeeId, deltas, reason, date });
      onDone(`Saved - correction ${r.data.voucherNo || ''} booked for ${row.name}. The original voucher is unchanged.`, r.data.detail);
    } catch (err) { setError(errText(err, 'Could not save the correction.')); } finally { setBusy(false); }
  }
  const field = (k, label, hint) => (
    <label>{label}<input type="number" step="0.01" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} placeholder="0" />{hint && <span className="lb-note" style={{ fontWeight: 400 }}>{hint}</span>}</label>
  );
  return (
    <Modal
      title={`Correct ${row.name}'s salary`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !reason.trim() || (!Object.values(v).some((x) => Number(x)))} onClick={submit}>{busy ? 'Saving…' : 'Save correction'}</button>
        </>
      )}
    >
      <div className="sv-note" style={{ marginTop: 0 }}>The posted voucher is never changed. This books a separate <b>correction voucher</b> for {row.name}. Use a minus sign (−) to take an amount off.</div>
      {error && <div className="lb-err" style={{ margin: '8px 0' }}>{error}</div>}
      <div className="sv-form" style={{ marginTop: 10 }}>
        {field('earnedGross', 'Gross pay change', 'e.g. arrears 5000')}
        {field('pf', 'PF change')}
        {field('esi', 'ESI change')}
        {field('tds', 'TDS change')}
        {field('professionalTax', 'Professional tax change')}
        {field('otherDeductions', 'Other deductions change', 'advance, loan recovery')}
        <label>Date of correction<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="sv-full">Why? (required)<textarea rows="2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. arrears for the missed increment" /></label>
      </div>
      <div className="sv-diff">Net pay changes by {net >= 0 ? '+' : '−'}{money(Math.abs(net))}</div>
    </Modal>
  );
}

// ---- The voucher ------------------------------------------------------------------------------------
export default function SalaryVoucherPanel({ entry, canPost = false, focusEmployeeId = '', onChanged = () => {} }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState('emp');
  const [q, setQ] = useState('');
  const [paying, setPaying] = useState(false);
  const [fixing, setFixing] = useState(null);
  const [slip, setSlip] = useState('');
  const rowsAll = useMemo(() => detail?.rows || detail?.payments || [], [detail]);
  const { sorted, head } = useSorted(rowsAll, { key: 'name', dir: 'asc' });
  useEffect(() => {
    setDetail(null); setError('');
    api.get(`/accounts/salary/vouchers/${entry.id}`).then((r) => setDetail(r.data)).catch((err) => setError(errText(err, 'Could not open this voucher.')));
  }, [entry.id]);
  if (error) return <div className="lb-err">{error}</div>;
  if (!detail) return <div className="sv-wrap"><EmptyMini>Loading…</EmptyMini></div>;
  const s = q.trim().toLowerCase();
  const shown = sorted.filter((r) => !s || `${r.employeeCode || ''} ${r.name || ''} ${r.department || ''}`.toLowerCase().includes(s));
  const done = (m, d) => { setMsg(m); if (d) setDetail(d); setPaying(false); setFixing(null); onChanged(); };
  const t = detail.totals || {};
  const isPayroll = detail.kind === 'PAYROLL';
  const sumShown = (k) => Math.round(shown.reduce((n, r) => n + Math.round((Number(r[k]) || 0) * 100), 0)) / 100;
  const filtering = !!s;
  const canPay = canPost && isPayroll && !detail.voucher.reversed && (t.balance || 0) > 0;

  return (
    <div className="sv-wrap">
      <div className="sv-head">
        <h4>{detail.voucher.voucherNo} · {detail.voucher.narration}</h4>
        {detail.voucher.reversed && <span className="sv-st red">Reversed</span>}
        <span className="sv-grow" />
        {canPay && <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>Pay salary</button>}
      </div>
      {msg && <div className="lb-ok" style={{ margin: '0 0 8px' }}>{msg}</div>}
      {detail.kind === 'TOTALS_ONLY' ? (
        <div className="sv-note">This voucher was booked before employee-wise lines existed, so it shows totals only. See the Accounting lines in the table above.</div>
      ) : (
        <>
          {isPayroll && (
            <div className="sv-mini">
              <div><div className="v">{t.employees}</div><div className="l">Employees</div></div>
              <div><div className="v">{money(t.gross)}</div><div className="l">Gross pay</div></div>
              <div><div className="v">{money(t.net)}</div><div className="l">Net pay</div></div>
              <div><div className="v">{money(t.paid)}</div><div className="l">Paid so far</div></div>
              <div><div className="v">{money(t.balance)}</div><div className="l">Still to pay</div></div>
            </div>
          )}
          <div className="sv-tabs">
            <button type="button" className={`btn btn-sm ${tab === 'emp' ? 'on' : ''}`} onClick={() => setTab('emp')}>Employee-wise</button>
            <button type="button" className={`btn btn-sm ${tab === 'lines' ? 'on' : ''}`} onClick={() => setTab('lines')}>Accounting lines</button>
            {tab === 'emp' && <input className="sv-search" type="search" placeholder="Find an employee…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: 'auto' }} />}
          </div>
          {tab === 'lines' ? (
            <div className="tbl-wrap">
              <table className="lb-tbl sv-tbl">
                <thead><tr><th className="sv-nosort">Ledger</th><th className="sv-nosort">Employee</th><th className="sv-nosort lb-num">Debit</th><th className="sv-nosort lb-num">Credit</th></tr></thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.id}>
                      <td style={{ paddingLeft: l.credit ? 28 : 10 }}>{l.credit ? 'Cr' : 'Dr'} {l.accountCode} · {l.accountName}</td>
                      <td className="cell-muted">{l.employeeName || '—'}</td>
                      <td className="lb-num">{l.debit ? num(l.debit) : ''}</td><td className="lb-num">{l.credit ? num(l.credit) : ''}</td>
                    </tr>
                  ))}
                  <tr className="sv-total"><td colSpan="2">Total</td><td className="lb-num">{num(detail.voucher.totalDebit)}</td><td className="lb-num">{num(detail.voucher.totalCredit)}</td></tr>
                </tbody>
              </table>
            </div>
          ) : detail.kind === 'PAYMENT' ? (
            <div className="tbl-wrap">
              <table className="lb-tbl sv-tbl">
                <thead><tr>{head('employeeCode', 'Emp ID')}{head('name', 'Employee')}{head('department', 'Department')}{head('amount', 'Amount paid', 'lb-num')}{head('paidOn', 'Paid on')}{head('mode', 'Mode')}{head('reference', 'UTR / ref')}<th className="sv-nosort">Status now</th><th className="sv-nosort" /></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.employeeCode || '—'}</b></td><td>{r.name}</td><td className="cell-muted">{r.department || '—'}</td>
                      <td className="lb-num">{num(r.amount)}</td><td>{r.paidOn}</td><td>{r.mode}</td><td>{r.reference || '—'}</td>
                      <td>{r.status ? <StatusPill status={r.status} label={r.statusLabel} /> : '—'}</td>
                      <td>{r.payslipId && <button type="button" className="btn btn-sm" onClick={() => setSlip(r.payslipId)}>View payslip</button>}</td>
                    </tr>
                  ))}
                  <tr className="sv-total"><td colSpan="3">{filtering ? `Total (${shown.length} shown)` : `Total · ${shown.length} employee${shown.length === 1 ? '' : 's'}`}</td><td className="lb-num">{num(sumShown('amount'))}</td><td colSpan="5" /></tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table className="lb-tbl sv-tbl">
                <thead>
                  <tr>
                    {head('employeeCode', 'Emp ID')}{head('name', 'Employee')}{head('department', 'Department')}
                    {head('gross', 'Gross', 'lb-num')}{head('pf', 'PF', 'lb-num')}{head('esi', 'ESI', 'lb-num')}{head('tds', 'TDS', 'lb-num')}{head('other', 'Other deductions', 'lb-num')}{head('net', 'Net pay', 'lb-num')}
                    {isPayroll && <>{head('status', 'Payment status')}{head('paidOn', 'Paid on')}{head('mode', 'Mode / Ref')}</>}
                    <th className="sv-nosort" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} style={focusEmployeeId && r.employeeId === focusEmployeeId ? { background: '#eef6ff' } : undefined}>
                      <td><b>{r.employeeCode || '—'}</b></td>
                      <td>{r.name}</td>
                      <td className="cell-muted">{r.department || '—'}</td>
                      <td className="lb-num">{num(r.gross)}</td><td className="lb-num">{dash(r.pf)}</td><td className="lb-num">{dash(r.esi)}</td><td className="lb-num">{dash(r.tds)}</td><td className="lb-num">{dash(r.other)}</td>
                      <td className="lb-num"><b>{num(r.net)}</b></td>
                      {isPayroll && (
                        <>
                          <td><StatusPill status={r.status} label={r.statusLabel} />{r.status === 'PARTIAL' && <div className="lb-note">Paid {money(r.paid)} · owes {money(r.balance)}</div>}{r.adjustments ? <div className="lb-note">Corrections {r.adjustments > 0 ? '+' : '−'}{money(Math.abs(r.adjustments))}</div> : null}</td>
                          <td>{r.paidOn || '—'}</td>
                          <td className="sv-wrap-cell">{r.mode ? `${r.mode}${r.reference ? ` · ${r.reference}` : ''}` : '—'}</td>
                        </>
                      )}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.payslipId && <button type="button" className="btn btn-sm" onClick={() => setSlip(r.payslipId)}>View payslip</button>}
                        {isPayroll && canPost && !detail.voucher.reversed && <> <button type="button" className="btn btn-sm" onClick={() => setFixing(r)}>Correct</button></>}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan="14" className="cell-muted">Nobody matches &quot;{q}&quot;.</td></tr>}
                  <tr className="sv-total">
                    <td colSpan="3">{filtering ? `Total (${shown.length} of ${rowsAll.length} shown)` : `Total · ${shown.length} employee${shown.length === 1 ? '' : 's'}`}</td>
                    <td className="lb-num">{num(sumShown('gross'))}</td><td className="lb-num">{num(sumShown('pf'))}</td><td className="lb-num">{num(sumShown('esi'))}</td><td className="lb-num">{num(sumShown('tds'))}</td><td className="lb-num">{num(sumShown('other'))}</td><td className="lb-num">{num(sumShown('net'))}</td>
                    {isPayroll && <td colSpan="3" />}<td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {isPayroll && !filtering && (t.employerPf + t.employerEsi) > 0 && (
            <div className="sv-note">Voucher total {money(detail.voucher.totalDebit)} = gross {money(t.gross)} + employer PF / ESI {money(t.employerPf + t.employerEsi)}. Net pay {money(t.net)} is what is credited to Salary payable.</div>
          )}
          {isPayroll && (detail.adjustments || []).length > 0 && (
            <div className="sv-adj">
              <h5>Corrections booked after this voucher</h5>
              <div className="tbl-wrap">
                <table className="lb-tbl sv-tbl">
                  <thead><tr><th className="sv-nosort">Voucher</th><th className="sv-nosort">Employee</th><th className="sv-nosort lb-num">Gross</th><th className="sv-nosort lb-num">Net pay</th><th className="sv-nosort">Why</th></tr></thead>
                  <tbody>{detail.adjustments.map((a) => <tr key={a.id}><td><b>{a.voucherNo}</b> · {a.date}</td><td>{a.name}</td><td className="lb-num">{num(a.gross)}</td><td className="lb-num">{num(a.net)}</td><td className="sv-wrap-cell">{a.note}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {paying && <PayDialog detail={detail} entryId={entry.id} onClose={() => setPaying(false)} onDone={done} />}
      {fixing && <FixDialog row={fixing} entryId={entry.id} onClose={() => setFixing(null)} onDone={done} />}
      {slip && <PayslipView payslipId={slip} onClose={() => setSlip('')} />}
    </div>
  );
}
