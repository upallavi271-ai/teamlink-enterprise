// Payroll edit HISTORY drawer + the run's "Changes in this run" list (user spec 2026-10-13, item 5).
//
//   drawer   one employee-month: every version (who / when / why / IP), what changed in it, the
//            before -> after totals, "View as of this version" against today's figures, and any
//            payslip that a later change marked Superseded.
//   list     for the approver: every edited record of the month with the deltas, so nothing is
//            approved without seeing what was changed.
import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead, EmptyMini } from '../proto.jsx';
import { errText, monthLabel } from './payrollUi';
import './payrollEdit.css';

// Paise are shown when there are any (pay-register months, 2026-10-28).
const inr = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`; };
const STEP = { DRAFT: 'Calculated', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved', SYNCED_TO_ACCOUNTS: 'Posted to Accounts', PAID: 'Paid' };
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const KIND = { calculated: 'As calculated', edit: 'Edited', recalculated: 'Recalculated from attendance', adjustment: 'Adjustment added' };
const FIELD_ROWS = [
  ['basic', 'Basic'], ['hra', 'HRA'], ['conveyance', 'Conveyance'], ['specialAllowance', 'Special allowance'], ['bonus', 'Bonus'], ['incentive', 'Incentive'], ['arrears', 'Other earnings'],
  ['pfEmployee', 'PF (employee)'], ['esiEmployee', 'ESI (employee)'], ['professionalTax', 'Professional tax'], ['tds', 'TDS'], ['lopDeduction', 'Absent / LOP amount'], ['loan', 'Loan / Advance'], ['otherDeductions', 'Other deductions'],
  ['pfEmployer', 'PF (employer)'], ['esiEmployer', 'ESI (employer)'], ['gratuity', 'Gratuity'], ['workingDays', 'Working days'], ['daysLop', 'LOP days'],
];
const TOTAL_ROWS = [['grossPay', 'Gross pay'], ['totalDeductions', 'Total deductions'], ['netPay', 'Net pay'], ['ctc', 'CTC this month']];

export default function PayrollEditHistory({ entryId, onClose }) {
  const [h, setH] = useState(null);
  const [error, setError] = useState('');
  const [asOf, setAsOf] = useState(null);
  useEffect(() => {
    api.get(`/payroll/entries/${entryId}/history`).then((r) => setH(r.data)).catch((err) => setError(errText(err, 'Could not load the history.')));
  }, [entryId]);
  const versions = h ? h.versions : [];
  const latest = versions.length ? versions[versions.length - 1] : null;
  const picked = asOf === null ? null : versions.find((v) => v.n === asOf);
  return (
    <>
      <div className="pe-drawer-back" onClick={onClose} />
      <aside className="pe-drawer" data-testid="history-drawer" role="dialog" aria-label="Payroll history">
        <div className="pe-drawer-head"><h3>History of this pay record</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="pe-drawer-body">
          {error && <div className="pe-problem">{error}</div>}
          {!h ? <div className="small-muted">Loading…</div> : (
            <>
              {h.lock && <div className="pe-lock">{h.lock.message}</div>}
              {h.calculatedAt && <div className="small-muted" style={{ marginBottom: 8 }}>Last calculated {when(h.calculatedAt)}{h.calculatedBy ? ` by ${h.calculatedBy}` : ''}. Now: {STEP[h.status] || h.statusLabel}.</div>}
              {versions.length <= 1 && <div className="small-muted" style={{ marginBottom: 10 }}>Nobody has changed this record since it was calculated.</div>}
              <ul className="pe-tl">
                {[...versions].reverse().map((v) => (
                  <li key={v.n} className={v.kind === 'calculated' ? 'base' : v.kind === 'recalculated' ? 'recalc' : ''}>
                    <div className="who">{KIND[v.kind] || v.kind} · version {v.n}{v.byName ? ` · ${v.byName}` : ''}</div>
                    <div className="when">{when(v.at)}{v.ip ? ` · IP ${v.ip}` : ''}</div>
                    {v.reason && v.kind !== 'calculated' && <div className="why">Why: {v.reason}</div>}
                    {v.changes && v.changes.length > 0 && (
                      <ul className="chg">{v.changes.map((c, i) => <li key={i}><b>{c.label}</b>: {Math.round(c.old).toLocaleString('en-IN')} → {Math.round(c.new).toLocaleString('en-IN')}</li>)}</ul>
                    )}
                    {v.before && v.after && v.kind !== 'calculated' && (
                      <div className="small-muted">Net pay {inr(v.before.totals.netPay)} → {inr(v.after.totals.netPay)} · Gross {inr(v.before.totals.grossPay)} → {inr(v.after.totals.grossPay)} · Deductions {inr(v.before.totals.totalDeductions)} → {inr(v.after.totals.totalDeductions)} · CTC {inr(v.before.totals.ctc)} → {inr(v.after.totals.ctc)}</div>
                    )}
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => setAsOf(asOf === v.n ? null : v.n)}>{asOf === v.n ? 'Hide' : `View as of version ${v.n}`}</button>
                  </li>
                ))}
              </ul>
              {h.transitions && h.transitions.length > 0 && (
                <>
                  <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-soft)', margin: '16px 0 6px' }}>Approvals and other steps</h4>
                  <ul className="chg" style={{ paddingLeft: 16, fontSize: 12.5, lineHeight: 1.6 }} data-testid="history-steps">
                    {[...h.transitions].reverse().map((t, i) => (
                      <li key={i}>
                        <b>{String(t.action || '').replace(/^Payroll /, '').replace(/^./, (c) => c.toUpperCase())}</b>
                        {t.fromValue && t.toValue && STEP[t.fromValue] ? ` (${STEP[t.fromValue]} → ${STEP[t.toValue] || t.toValue})` : ''}
                        {' — '}{t.actorName || 'System'}, {when(t.createdAt)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {picked && latest && (
                <div className="pe-compare" data-testid="as-of">
                  <b>Version {picked.n} compared with now (version {latest.n})</b>
                  <table className="pe-asof">
                    <thead><tr><th /><th>Version {picked.n}</th><th>Now</th></tr></thead>
                    <tbody>
                      {TOTAL_ROWS.map(([k, l]) => {
                        const a = picked.after.totals[k]; const b = latest.after.totals[k];
                        return <tr key={k} className={a !== b ? 'diff' : ''}><td>{l}</td><td>{inr(a)}</td><td>{inr(b)}</td></tr>;
                      })}
                      {FIELD_ROWS.map(([k, l]) => {
                        const a = Number(picked.after.fields[k]) || 0; const b = Number(latest.after.fields[k]) || 0;
                        return (a || b) ? <tr key={k} className={a !== b ? 'diff' : ''}><td>{l}</td><td>{a.toLocaleString('en-IN')}</td><td>{b.toLocaleString('en-IN')}</td></tr> : null;
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {h.superseded.length > 0 && (
                <>
                  <h4 style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--ink-soft)', margin: '16px 0 6px' }}>Older payslips <span className="pe-badge sup">Superseded</span></h4>
                  <ul className="chg" style={{ paddingLeft: 16, fontSize: 12.5, lineHeight: 1.6 }}>
                    {h.superseded.map((s, i) => <li key={i}>Issued {when(s.generatedAt)}: gross {inr(s.gross)}, deductions {inr((Number(s.deductions) || 0) + (Number(s.lopDeduction) || 0))}, net {inr(s.netPay)}. Replaced after a change by {s.byName}{s.reason ? ` (${s.reason})` : ''}.</li>)}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// "Changes in this run": for the approver. Shown on the run board when somebody edited a record of the month.
export function ChangesInRun({ month, reloadKey = 0 }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  const [hist, setHist] = useState(null);
  useEffect(() => { api.get(`/payroll/runs/${month}/changes`).then((r) => setD(r.data)).catch(() => setD({ rows: [], totals: null })); }, [month, reloadKey]);
  if (!d || !d.rows.length) return null;
  const t = d.totals;
  const col = (n, goodUp = true) => { const x = Math.round(n); return x === 0 ? <span className="pe-same">0</span> : <span className={(goodUp ? x > 0 : x < 0) ? 'pe-up' : 'pe-down'}>{x > 0 ? '+' : '−'}{inr(Math.abs(x))}</span>; };
  return (
    <Panel style={{ marginTop: 16 }}>
      <PanelHead title={`Changes in this run: ${monthLabel(month)}`}>
        <span className="small-muted">{t.employees} edited · Net {col(t.delta.netPay)} · Gross {col(t.delta.grossPay)} · CTC {col(t.delta.ctc)}</span>
      </PanelHead>
      <div className="small-muted" style={{ padding: '0 18px 8px' }}>Check these before you approve. The person who edited a record cannot approve it.</div>
      <div className="tbl-wrap pe-changes" data-testid="changes-in-run">
        <table>
          <thead><tr><th>Employee</th><th>Status</th><th>Edits</th><th>Last change</th><th>Gross</th><th>Deductions</th><th>Net</th><th>CTC</th><th /></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <FragmentRow key={r.entryId} r={r} col={col} open={open === r.entryId} toggle={() => setOpen(open === r.entryId ? null : r.entryId)} history={() => setHist(r.entryId)} />
            ))}
            <tr><td><b>Total</b></td><td /><td /><td /><td>{col(t.delta.grossPay)}</td><td>{col(t.delta.totalDeductions, false)}</td><td>{col(t.delta.netPay)}</td><td>{col(t.delta.ctc)}</td><td /></tr>
          </tbody>
        </table>
      </div>
      {hist && <PayrollEditHistory entryId={hist} onClose={() => setHist(null)} />}
    </Panel>
  );
}

function FragmentRow({ r, col, open, toggle, history }) {
  return (
    <>
      <tr>
        <td><b>{r.employeeCode}</b> {r.name}</td>
        <td className="cell-muted">{r.statusLabel}</td>
        <td>{r.edits}</td>
        <td className="cell-muted">{r.lastBy}, {when(r.lastAt)}{r.lastReason ? ` · ${r.lastReason}` : ''}</td>
        <td>{col(r.delta.grossPay)}</td><td>{col(r.delta.totalDeductions, false)}</td><td>{col(r.delta.netPay)}</td><td>{col(r.delta.ctc)}</td>
        <td><button className="btn btn-sm" onClick={toggle}>{open ? 'Hide' : 'What changed'}</button> <button className="btn btn-sm" onClick={history}>History</button></td>
      </tr>
      {open && (
        <tr className="pe-more"><td colSpan="9">
          <ul className="pe-changed-list">
            {r.changes.map((c, i) => <li key={i}><b>{c.label}</b>: {Math.round(c.old).toLocaleString('en-IN')} → {Math.round(c.new).toLocaleString('en-IN')} <span className="small-muted">({c.byName}{c.reason ? `, ${c.reason}` : ''})</span></li>)}
          </ul>
        </td></tr>
      )}
    </>
  );
}
