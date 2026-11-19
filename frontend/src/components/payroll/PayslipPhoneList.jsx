import { useState } from 'react';
import './payslipPhoneList.css';

// ---------------------------------------------------------------------------
// MY PAYSLIPS ON A PHONE (founder 2026-11-19: "payslip downloads ... in mobile application").
//
// The payslip register is a nine-column table (period, code, name, pay type, gross, deductions, LOP, net, buttons): on a phone the
// PDF button sat off the right edge. For a person's OWN payslips on a phone-width screen the same data is shown as one card per
// month: the month, the net pay, one line of the rest, and two big buttons, Download PDF and View. Nothing else changes: same data
// (GET /payroll), same PDF (GET /payroll/payslips/:id/pdf), same payslip sheet behind View; the table stays on every wider screen
// and for anyone who sees other people's payslips.
// ---------------------------------------------------------------------------
const FIRST = 6; // the newest six months; older ones one tap away

export default function PayslipPhoneList({ payslips, monthHeading, inr, totalDed, onView, onDownload }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const sorted = [...payslips].sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')));
  const shown = all ? sorted : sorted.slice(0, FIRST);

  async function download(p) {
    setError(''); setDone(''); setBusy(p.id);
    try { await onDownload(p); setDone(p.id); } catch { setError(`Could not download the ${monthHeading(p.month)} payslip. Please try again.`); }
    setBusy('');
  }

  return (
    <div className="psphone">
      {error && <div className="psphone-error" role="alert">{error}</div>}
      {shown.map((p) => (
        <div className="psphone-card" key={p.id}>
          <div className="psphone-top">
            <b>{monthHeading(p.month)}</b>
            <span className="psphone-net">{inr(p.netPay)}</span>
          </div>
          <div className="psphone-sub">
            Net pay · Gross {inr(p.gross)} · Deductions {inr(totalDed(p))}{p.lopDays ? ` · ${p.lopDays} LOP day${Number(p.lopDays) === 1 ? '' : 's'}` : ''}
          </div>
          <div className="psphone-btns">
            <button type="button" className="btn btn-primary" disabled={busy === p.id} onClick={() => download(p)}>
              {busy === p.id ? 'Preparing…' : done === p.id ? 'Downloaded ✓ Again' : 'Download PDF'}
            </button>
            <button type="button" className="btn" onClick={() => onView(p.id)}>View</button>
          </div>
          {done === p.id && <div className="psphone-hint">Saved to your phone&apos;s Downloads. Open it from the notification or the Files app.</div>}
        </div>
      ))}
      {sorted.length > FIRST && (
        <button type="button" className="btn psphone-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show older payslips (${sorted.length - FIRST})`}
        </button>
      )}
    </div>
  );
}
