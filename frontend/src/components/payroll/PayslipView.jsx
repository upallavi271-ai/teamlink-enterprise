import { useEffect, useState } from 'react';
import api from '../../api';
import { Modal } from '../proto.jsx';
import logo from '../../assets/teamlink-full-logo.png';

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
const show = (v) => (v === null || v === undefined || v === '' ? DASH : String(v));
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
.ps-foot{text-align:center;color:#1f4fa0;font-size:14px;margin-top:14px;font-family:Georgia,"Times New Roman",serif}
`;

export async function downloadPayslipPdf(slip) {
  const res = await api.get(`/payroll/payslips/${slip.id}/pdf`, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Payslip-${(slip.employee?.employeeCode || slip.employee?.name || 'employee').replace(/[^A-Za-z0-9_-]+/g, '-')}-${slip.month}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// The sheet itself — an 8-column grid so the three bands (header, 4-column
// details, earnings | deductions) can each keep the sample's proportions.
export function PayslipSheet({ p }) {
  const e = p.employee;
  const grid = [
    ['Employee Code', e.employeeCode, 'PAN Number', e.panNumber],
    ['Employee Name', e.name, 'UAN Number', e.uanNumber],
    ['ESI Number', e.esiNumber, 'PF Number', e.pfNumber],
    ['Days Worked', p.daysWorked, 'LOP Days', p.lopDays],
    ['DOJ', e.dateOfJoining, 'Month', p.period],
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
      <div className="ps-foot">This is a computer generated payslip, needs no signature</div>
    </div>
  );
}

export default function PayslipView({ payslipId, onClose }) {
  const [slip, setSlip] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    const html = node.innerHTML.replace(/src="([^"]+)"/g, (m, src) => `src="${new URL(src, window.location.href).href}"`);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip — ${slip.employee.name} — ${slip.period}</title>
<style>@page{size:A4 portrait;margin:12mm}body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>
</head><body>${html}<script>window.onload=function(){window.focus();window.print();}</script></body></html>`);
    w.document.close();
  }

  return (
    <Modal
      title={slip ? `Payslip — ${slip.employee.name} — ${slip.period}` : 'Payslip'}
      onClose={onClose}
      wide
      footer={slip && (
        <>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button className="btn btn-sm" onClick={print}>Print</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={download}>{busy ? 'Preparing…' : 'Download PDF'}</button>
        </>
      )}
    >
      {error && <div className="error-text">{error}</div>}
      {!slip && !error && <div className="small-muted">Loading payslip…</div>}
      {slip && <div id="payslip-sheet" style={{ overflowX: 'auto' }}><div style={{ minWidth: 620 }}><PayslipSheet p={slip} /></div></div>}
    </Modal>
  );
}
