import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import logo from '../../assets/teamlink-full-logo.png';
import { useMediaQuery, PHONE_MQ } from '../useMobileDrawer.js';
import './payslipPhoneList.css';
import LopBreakdown, { LopLink } from './LopBreakdown.jsx'; // the LOP number opens the dates behind it (2026-11-19)

// ---------------------------------------------------------------------------
// PAYSLIP — on screen, laid out exactly like the user's sample payslip and like
// the PDF the server draws (backend utils/payslipPdf.js). Both read ONE payload,
// GET /payroll/payslips/:id, so the screen and the file cannot disagree.
//
// Who can open one is decided by the server: your own always; HR / Accounts /
// Admin inside their scope; a Manager / Assistant Manager may view inside
// theirs. Download PDF is GET /payroll/payslips/:id/pdf.
// ---------------------------------------------------------------------------

const DASH = '—';
const show = (v) => (v === null || v === undefined || v === '' ? DASH : (typeof v === 'object' ? v : String(v))); // (a React element - the LOP link - passes through)
const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Inline so the print window (which has none of the app's CSS) gets it too.
const SHEET_CSS = `
.ps-sheet{font-family:Georgia,"Times New Roman",serif;color:#111;background:#fff}
.ps-table{width:100%;border-collapse:collapse;border:2px solid #222;table-layout:fixed}
.ps-table td{border:1px solid #222;padding:7px 9px;font-size:13.5px;vertical-align:middle;overflow-wrap:anywhere}
.ps-table .ps-l{font-weight:700}
.ps-table .ps-head-logo{text-align:center}
.ps-table .ps-head-logo img{width:190px;max-width:100%;height:auto}
.ps-table .ps-co-title{font-weight:700;font-size:17px;margin-bottom:6px}
.ps-table .ps-co-addr{font-size:13.5px;line-height:1.55}
.ps-table tr.ps-thick td{border-top:2px solid #222}
.ps-table tr.ps-sec td{font-weight:700;text-align:center}
.ps-table tr.ps-spacer td{padding:4px}
.ps-table tr.ps-tot td{font-weight:700;font-size:14px}
.ps-table .ps-net-sub{font-weight:400;font-size:11.5px;display:block}
.ps-table .ps-amt{white-space:nowrap}
.ps-sheet .lop-link{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:none;cursor:pointer}
.ps-awl{font-size:12.5px;margin-top:10px;color:#7c2d12;font-family:Arial,Helvetica,sans-serif}
.ps-foot{text-align:center;color:#1f4fa0;font-size:14px;margin-top:14px;font-family:Georgia,"Times New Roman",serif}
`;

export async function downloadPayslipPdf(slip) {
  const res = await api.get(`/payroll/payslips/${slip.id}/pdf`, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Payslip-${(slip.employee?.employeeCode || slip.employee?.name || 'employee').replace(/[^A-Za-z0-9_-]+/g, '-')}-${slip.month}${slip.provisional ? '-provisional' : ''}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// The sheet itself — an 8-column grid so the three bands (header, 4-column
// details, earnings | deductions) can each keep the sample's proportions.
export function PayslipSheet({ p, onLop = null }) {
  const e = p.employee;
  const grid = [
    ['Employee Code', e.employeeCode, 'PAN Number', e.panNumber],
    ['Employee Name', e.name, 'UAN Number', e.uanNumber],
    ['ESI Number', e.esiNumber, 'PF Number', e.pfNumber],
    ['Days Worked', p.daysWorked, 'LOP Days', onLop ? <LopLink value={p.lopDays} onOpen={onLop} /> : p.lopDays],
    ['DOJ', e.dateOfJoining, 'Salary month', p.periodLabel || p.period],
    ...(p.periodRange ? [['Pay period', p.periodRange, 'Days in period', p.periodDays]] : []),
    ['Department', e.department, 'Designation', e.designation],
    ['Location', e.location, 'Bank A/C Number', e.bankAccountNumber],
    ['Monthly Gross', `₹${money(p.monthlyGross)}`, 'Bank Name', e.bankName],
  ];
  const n = Math.max(p.earnings.length, p.deductions.length);
  const items = Array.from({ length: n }, (_, i) => [p.earnings[i], p.deductions[i]]);
  // Column plan, in 1/100ths of the width (matches the PDF):
  //   header   : logo 33 | company 67
  //   details  : 22 | 20 | 22 | 36
  //   money    : earn label 27 | earn amt 17 | ded label 38 | ded amt 18
  // Union of those boundaries: 0 22 27 33 42 44 64 82 100.
  const cols = [22, 5, 6, 9, 2, 20, 18, 18];
  return (
    <div className="ps-sheet">
      <style>{SHEET_CSS}</style>
      <table className="ps-table">
        <colgroup>{cols.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
        <tbody>
          <tr>
            <td colSpan={3} className="ps-head-logo"><img src={logo} alt="TeamLink Consultants" /></td>
            <td colSpan={5}>
              <div className="ps-co-title">Company</div>
              <div className="ps-co-addr">{show(p.company.address)}</div>
            </td>
          </tr>
          {grid.map((r, i) => (
            <tr key={r[0]} className={i === 0 ? 'ps-thick' : undefined}>
              <td className="ps-l">{r[0]}</td>
              <td colSpan={3}>{show(r[1])}</td>
              <td colSpan={2} className="ps-l">{r[2]}</td>
              <td colSpan={2}>{show(r[3])}</td>
            </tr>
          ))}
          <tr className="ps-thick ps-sec">
            <td colSpan={5}>EARNINGS</td>
            <td colSpan={3}>DEDUCTIONS</td>
          </tr>
          {n === 0 && (
            <tr className="ps-spacer"><td colSpan={2} /><td colSpan={3} /><td colSpan={2} /><td /></tr>
          )}
          {items.map(([er, dr], i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i}>
              <td colSpan={2}>{er ? er.label : ''}</td>
              <td colSpan={3} className="ps-amt">{er ? money(er.amount) : ''}</td>
              <td colSpan={2}>{dr ? dr.label : ''}</td>
              <td className="ps-amt">{dr ? money(dr.amount) : ''}</td>
            </tr>
          ))}
          <tr className="ps-tot">
            <td colSpan={2}>GROSS SALARY</td>
            <td colSpan={3} className="ps-amt">{money(p.gross)}</td>
            <td colSpan={2}>TOTAL DEDUCTIONS</td>
            <td className="ps-amt">{money(p.totalDeductions)}</td>
          </tr>
          <tr className="ps-tot">
            <td colSpan={5} />
            <td colSpan={2}>NET SALARY<span className="ps-net-sub">(Bank Transfer)</span></td>
            <td className="ps-amt">₹ {money(p.netPay)}</td>
          </tr>
        </tbody>
      </table>
      {p.absentNoLeave && (
        <div className="ps-awl" data-testid="payslip-awl">
          <b>{p.absentNoLeave.text}</b> — ₹{money(p.absentNoLeave.amount)} (inside the LOP line).
          {(p.absentNoLeave.dates.length + p.absentNoLeave.halfDates.length) > 0 && <> Dates: {[...p.absentNoLeave.dates, ...p.absentNoLeave.halfDates].join(', ')}.</>}
        </div>
      )}
      <div className="ps-foot">This is a computer generated payslip, needs no signature</div>
    </div>
  );
}

// THE SAME PAYSLIP, STACKED, for a phone-width screen (founder 2026-11-19): the printed-style sheet above is an 8-column grid that does not fit a
// phone, so on a phone the View window shows the very same payload (GET /payroll/payslips/:id) as short lists: net pay first, then earnings,
// deductions, and the employee / statutory / bank lines. The PDF is unchanged.
export function PayslipPhoneSheet({ p, onLop = null }) {
  const e = p.employee;
  const rows = (list) => list.map(([k, v]) => (
    <div className="pssheet-row" key={k}><span>{k}</span><b>{show(v)}</b></div>
  ));
  const lines = (list) => list.map((x, i) => (
    // eslint-disable-next-line react/no-array-index-key
    <div className="pssheet-row" key={i}><span>{x.label}</span><b>{money(x.amount)}</b></div>
  ));
  return (
    <div className="pssheet">
      <div className="pssheet-net">
        <span>Net salary (bank transfer)</span>
        <b>₹ {money(p.netPay)}</b>
        <small>{p.periodLabel || p.period}{p.periodRange ? ` · ${p.periodRange}` : ''}</small>
      </div>
      <h4>Earnings</h4>
      {lines(p.earnings)}
      <div className="pssheet-row pssheet-tot"><span>Gross salary</span><b>{money(p.gross)}</b></div>
      <h4>Deductions</h4>
      {p.deductions.length ? lines(p.deductions) : <div className="pssheet-row"><span>None</span><b>{DASH}</b></div>}
      <div className="pssheet-row pssheet-tot"><span>Total deductions</span><b>{money(p.totalDeductions)}</b></div>
      <h4>Days</h4>
      {rows([['Days worked', p.daysWorked], ['LOP days', onLop ? <LopLink value={p.lopDays} onOpen={onLop} /> : p.lopDays], ...(p.periodRange ? [['Days in period', p.periodDays]] : []), ['Monthly gross', `₹${money(p.monthlyGross)}`]])}
      {p.absentNoLeave && (
        <div className="pssheet-note">
          <b>{p.absentNoLeave.text}</b> — ₹{money(p.absentNoLeave.amount)} (inside the LOP line).
          {(p.absentNoLeave.dates.length + p.absentNoLeave.halfDates.length) > 0 && <> Dates: {[...p.absentNoLeave.dates, ...p.absentNoLeave.halfDates].join(', ')}.</>}
        </div>
      )}
      <h4>Employee</h4>
      {rows([['Employee code', e.employeeCode], ['Name', e.name], ['Department', e.department], ['Designation', e.designation], ['Location', e.location], ['Date of joining', e.dateOfJoining]])}
      <details className="pssheet-more">
        <summary>Statutory and bank details</summary>
        {rows([['PAN', e.panNumber], ['UAN', e.uanNumber], ['ESI number', e.esiNumber], ['PF number', e.pfNumber], ['Bank', e.bankName], ['Bank A/C', e.bankAccountNumber]])}
      </details>
      <div className="pssheet-foot">This is a computer generated payslip, needs no signature</div>
    </div>
  );
}

export default function PayslipView({ payslipId, onClose }) {
  const [slip, setSlip] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lopOpen, setLopOpen] = useState(false); // the LOP dates drawer
  const phone = useMediaQuery(PHONE_MQ); // a phone gets the stacked payslip and no Print button (a print window is not a phone thing)

  useEffect(() => {
    api.get(`/payroll/payslips/${payslipId}`)
      .then((res) => setSlip(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not open this payslip.'));
  }, [payslipId]);

  async function download() {
    setBusy(true); setError('');
    try { await downloadPayslipPdf(slip); } catch { setError('Could not download the payslip.'); } finally { setBusy(false); }
  }

  function print() {
    const node = document.getElementById('payslip-sheet');
    if (!node) return;
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { setError('Allow pop-ups for this site to print.'); return; }
    const note = slip.provisional ? '<p style="font:bold 13px Arial,sans-serif;color:#8a5a00;margin:0 0 8px">PROVISIONAL PAYSLIP - calculated, not yet approved. The figures can still change until payroll is approved.</p>' : '';
    const html = note + node.innerHTML.replace(/src="([^"]+)"/g, (m, src) => `src="${new URL(src, window.location.href).href}"`);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${slip.periodTitle || 'Payslip'} — ${slip.employee.name}</title>
<style>@page{size:A4 portrait;margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>
</head><body>${html}<script>window.onload=function(){window.focus();window.print();}</script></body></html>`);
    w.document.close();
  }

  return (
    <Modal
      title={slip ? `${slip.periodTitle || 'Payslip'} — ${slip.employee.name}` : 'Payslip'}
      onClose={onClose}
      wide
      footer={slip && (
        <>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          {!phone && <button className="btn btn-sm" onClick={print}>Print</button>}
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={download}>{busy ? 'Preparing…' : 'Download PDF'}</button>
        </>
      )}
    >
      {error && <div className="error-text">{error}</div>}
      {!slip && !error && <div className="small-muted">Loading payslip…</div>}
      {slip && slip.provisional && (
        <div className="ps-prov-note" data-testid="payslip-provisional-note">
          <b>Provisional.</b> This month is calculated but not approved yet, so the figures can still change. It becomes your payslip once payroll is approved.
        </div>
      )}
      {slip && slip.editInfo && (
        <div className="small-muted" style={{ marginBottom: 8 }} data-testid="payslip-edit-info">
          <span style={{ background: '#fff4d6', color: '#8a5a00', borderRadius: 8, padding: '1px 8px', fontWeight: 700, fontSize: 11 }}>Edited</span>{' '}
          Changed by {slip.editInfo.lastBy || 'payroll'}{slip.editInfo.lastReason ? ` (${slip.editInfo.lastReason})` : ''}. Only payroll staff see this note.
          {(slip.editInfo.superseded || []).map((s, i) => (
            <div key={i}><span style={{ background: '#fdecec', color: '#8f1d17', borderRadius: 8, padding: '1px 8px', fontWeight: 700, fontSize: 11 }}>Superseded</span>{' '}
              Older payslip issued {new Date(s.generatedAt).toLocaleDateString('en-GB')}: gross ₹{money(s.gross)}, net ₹{money(s.netPay)}.</div>
          ))}
        </div>
      )}
      {slip && phone && <div id="payslip-sheet"><PayslipPhoneSheet p={slip} onLop={() => setLopOpen(true)} /></div>}
      {slip && !phone && <div id="payslip-sheet" style={{ overflowX: 'auto' }}><div style={{ minWidth: 620 }}><PayslipSheet p={slip} onLop={() => setLopOpen(true)} /></div></div>}
      {slip && lopOpen && <LopBreakdown payslipId={slip.id} onClose={() => setLopOpen(false)} />}
    </Modal>
  );
}
