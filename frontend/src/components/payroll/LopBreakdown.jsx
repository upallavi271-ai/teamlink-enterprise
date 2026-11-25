// WHICH DATES ARE THE LOP DAYS? (founder 2026-11-19: "when I click the LOP count, like Navya's 2, a screen should show which date the
// LOP is deducted, is it leave or absent, is it approved or not - every detail".)
//
//   <LopLink value={2} onOpen={...}>      the LOP number as a link-styled button (payroll run table, payslip, payslip history)
//   <LopBreakdown entryId | payslipId>    the drawer: GET /payroll/entries/:id/lop-breakdown  (the payroll record's Details rights + scope)
//                                                  or GET /payroll/payslips/:id/lop-breakdown  (whoever may read that payslip)
//
// The server rebuilds the dates from the payroll's own rules (backend utils/payrollLopBreakdown.js) and says plainly when the stored LOP
// differs from attendance (typed by HR, edited by hand, or attendance changed since the payroll was calculated). Read-only: no salary
// amounts, nothing to save.
import { useEffect, useState } from 'react';
import api from '../../api';
import { errText, STATUS_LABEL, STATUS_CLS } from './payrollUi';
import './lopBreakdown.css';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const num = (n) => String(Math.round((Number(n) || 0) * 100) / 100);
const plural = (n, w) => `${num(n)} ${w}${Number(n) === 1 ? '' : 's'}`;
// "2026-10-21" -> "Wed 21 Oct 2026"
function fmtDate(d) {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return d || '';
  const x = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return `${DOW[x.getUTCDay()]} ${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
const fmtShort = (d) => (d ? `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}` : '');
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const day = (t) => (t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
// "09:05" -> "9:05 AM"
function clock(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return '—';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}
// a request's free text: no markdown stars, not a wall of words
const clip = (t, n = 220) => { const x = String(t || '').split('**').join('').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
const STATE_CLS = { Approved: 'approved', Pending: 'pending', Rejected: 'rejected' };
const stateCls = (s) => STATE_CLS[s] || 'lop-neutral';
const STATE_TEXT = { Pending: 'Pending', 'Cancellation Requested': 'Cancellation requested' };
const stateText = (s) => STATE_TEXT[s] || s;
const SOURCE = {
  ATTENDANCE: 'Worked out from attendance', OVERRIDE: 'Typed or imported by HR',
};

// The LOP number as a link-styled button.
export function LopLink({ value, onOpen, title }) {
  const v = Number(value) || 0;
  return (
    <button type="button" className={`lop-link${v ? '' : ' zero'}`} title={title || 'Click to see which dates were counted as loss of pay, and why'} onClick={onOpen}>{num(v)}</button>
  );
}

// One request (leave / correction / late coming) of a date, in words.
function RequestLine({ kind, r }) {
  if (kind === 'leave') {
    const range = r.from === r.to ? fmtShort(r.from) : `${fmtShort(r.from)} to ${fmtShort(r.to)}`;
    return (
      <li>
        <span className={`status ${stateCls(r.status)}`}>{stateText(r.status)}</span>{' '}
        <b>{r.type ? (/leave/i.test(r.type) ? r.type : `${r.type} leave`) : 'Leave'}</b>{r.half ? ` (${r.half})` : ''} · {range} · {plural(r.days || 1, 'day')}
        <div className="lop-sub">
          Applied {day(r.appliedAt)}{r.reason ? ` · “${clip(r.reason)}”` : ''}
          {r.status === 'Approved' && <> · Approved{r.decidedBy ? ` by ${r.decidedBy}` : ''}{r.decidedAt ? ` on ${when(r.decidedAt)}` : ''}{r.note ? ` · ${r.note}` : ''}</>}
          {r.status === 'Rejected' && <> · Rejected{r.decidedBy ? ` by ${r.decidedBy}` : ''}{r.decidedAt ? ` on ${when(r.decidedAt)}` : ''}{r.note ? ` · ${r.note}` : ''}</>}
          {r.status === 'Pending' && <> · {r.waitingFor ? `waiting for ${r.waitingFor}` : 'waiting for approval'}</>}
          {r.status === 'Cancelled' && <> · Cancelled{r.cancelledBy ? ` by ${r.cancelledBy}` : ''}{r.cancelledAt ? ` on ${when(r.cancelledAt)}` : ''}{r.cancelReason ? ` · ${r.cancelReason}` : ''}</>}
          {r.chain && r.chain.length > 0 && <> · Steps: {r.chain.map((c) => `${c.level}${c.who ? ` (${c.who})` : ''} ${c.status.toLowerCase()}${c.at ? ` ${day(c.at)}` : ''}`).join(', ')}</>}
          {' · '}<a href={`/leave?tab=requests&open=${r.id}`} target="_blank" rel="noreferrer">Open leave request</a>
        </div>
      </li>
    );
  }
  if (kind === 'reg') {
    return (
      <li>
        <span className={`status ${stateCls(r.status)}`}>{stateText(r.status)}</span>{' '}
        <b>Attendance correction</b>{r.requestedCheckIn || r.requestedCheckOut ? ` · asked for ${clock(r.requestedCheckIn)} to ${clock(r.requestedCheckOut)}` : ''}
        <div className="lop-sub">
          Applied {day(r.appliedAt)}{r.reason ? ` · “${clip(r.reason)}”` : ''}
          {r.status !== 'Pending' && <> · {r.status}{r.decidedBy ? ` by ${r.decidedBy}` : ''}{r.decidedAt ? ` on ${when(r.decidedAt)}` : ''}</>}
          {r.status === 'Pending' && r.chain && r.chain.some((c) => c.status === 'Pending') && <> · waiting for {r.chain.filter((c) => c.status === 'Pending').map((c) => c.who || c.level).join(' / ')}</>}
        </div>
      </li>
    );
  }
  return (
    <li>
      <span className={`status ${stateCls(r.status)}`}>{stateText(r.status)}</span>{' '}
      <b>Late-coming request</b>{r.expectedTime ? ` · ${r.kind === 'Explain' ? 'came' : 'by'} ${clock(r.expectedTime)}` : ''}
      <div className="lop-sub">
        Applied {day(r.appliedAt)}{r.appliedBy ? ` by ${r.appliedBy}` : ''}{r.reason ? ` · “${clip(r.reason)}”` : ''}
        {r.status !== 'Pending' && <> · {r.status}{r.decidedBy ? ` by ${r.decidedBy}` : ''}{r.decidedAt ? ` on ${when(r.decidedAt)}` : ''}{r.decisionNote ? ` · ${r.decisionNote}` : ''}</>}
      </div>
    </li>
  );
}

function DayCard({ d, counted }) {
  const hasReq = d.leave.length + d.regularization.length + d.late.length > 0;
  return (
    <div className={`lop-day${counted ? '' : ' light'}`} data-testid={counted ? 'lop-day' : 'lop-day-light'}>
      <div className="lop-day-head">
        <b className="lop-date">{fmtDate(d.date)}</b>
        {counted ? <span className="lop-badge">{plural(d.lop, 'LOP day')}</span> : <span className="lop-badge ok">Not counted</span>}
        <span className={`lop-att att-${d.colour || 'none'}`}>{d.status}</span>
      </div>
      <div className="lop-line"><span>Attendance</span><div>{d.attendance}</div></div>
      <div className="lop-line">
        <span>Punches</span>
        <div>
          In {clock(d.checkIn)} · Out {clock(d.checkOut)}{d.hours != null ? ` · ${d.hours} h` : ''}{d.source ? ` · ${d.source}` : ' · no punch'}
          {d.punches && d.punches.length > 1 && <div className="lop-sub">All punches: {d.punches.map((p) => `${clock(p.time)} ${p.direction}${p.source ? ` (${p.source})` : ''}`).join(', ')}</div>}
        </div>
      </div>
      {counted ? (
        <div className="lop-line">
          <span>Why it counted</span>
          <ul className="lop-why">{d.reasons.map((r) => <li key={r.code}><b>{plural(r.days, 'day')}</b> — {r.text}</li>)}</ul>
        </div>
      ) : (
        <div className="lop-line"><span>Why not</span><ul className="lop-why">{(d.notes || []).map((n, i) => <li key={`${n.kind}${i}`}>{n.text}</li>)}</ul></div>
      )}
      <div className="lop-line">
        <span>Requests</span>
        {hasReq ? (
          <ul className="lop-req">
            {d.leave.map((r) => <RequestLine key={r.id} kind="leave" r={r} />)}
            {d.regularization.map((r) => <RequestLine key={r.id} kind="reg" r={r} />)}
            {d.late.map((r) => <RequestLine key={r.id} kind="late" r={r} />)}
          </ul>
        ) : <div className="lop-sub">No leave, correction or late-coming request for this date.</div>}
      </div>
    </div>
  );
}

// Plain-text and CSV of the list, to paste to the employee or keep.
function requestText(d) {
  const bits = [];
  d.leave.forEach((r) => bits.push(`Leave ${r.type || ''}${r.half ? ` (${r.half})` : ''} ${r.from}${r.to !== r.from ? ` to ${r.to}` : ''}: ${r.status}${r.decidedBy ? ` by ${r.decidedBy}` : ''}${r.decidedAt ? ` on ${day(r.decidedAt)}` : ''}${r.status === 'Pending' && r.waitingFor ? ` (waiting for ${r.waitingFor})` : ''}`));
  d.regularization.forEach((r) => bits.push(`Attendance correction: ${r.status}${r.decidedBy ? ` by ${r.decidedBy}` : ''}${r.decidedAt ? ` on ${day(r.decidedAt)}` : ''}`));
  d.late.forEach((r) => bits.push(`Late-coming request: ${r.status}${r.decidedBy ? ` by ${r.decidedBy}` : ''}${r.decidedAt ? ` on ${day(r.decidedAt)}` : ''}`));
  return bits.join(' | ');
}
const whyText = (d) => (d.reasons || []).map((r) => `${num(r.days)} day: ${r.text}`).join(' ');
function asText(b) {
  const head = `LOP days: ${b.employee.name}${b.employee.code ? ` (${b.employee.code})` : ''} · ${b.monthLabel} (pay period ${b.cycle.rangeText}, ${b.cycle.days} days). LOP days in the payroll: ${num(b.record.daysLop)}.`;
  const lines = b.dates.map((d) => `${fmtDate(d.date)} — ${num(d.lop)} LOP day — ${d.status}. ${d.attendance}. In ${clock(d.checkIn)}, out ${clock(d.checkOut)}. Why: ${whyText(d)}${requestText(d) ? ` Requests: ${requestText(d)}` : ' No leave or request for this date.'}`);
  return [head, ...lines, ...b.notes].join('\n');
}
const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
function asCsv(b) {
  const head = ['Date', 'Weekday', 'LOP days', 'Attendance status', 'Attendance', 'Check-in', 'Check-out', 'Source', 'Why counted', 'Requests and approval'];
  const rows = b.dates.map((d) => [d.date, d.weekday, num(d.lop), d.status, d.attendance, d.checkIn || '', d.checkOut || '', d.source, whyText(d), requestText(d)]);
  rows.push(['TOTAL', '', num(b.listedLop), '', '', '', '', '', '', '']);
  return `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
}

export default function LopBreakdown({ entryId = null, payslipId = null, onClose }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    setB(null); setError('');
    const url = entryId ? `/payroll/entries/${entryId}/lop-breakdown` : `/payroll/payslips/${payslipId}/lop-breakdown`;
    api.get(url).then((r) => setB(r.data)).catch((err) => setError(errText(err, 'Could not load the LOP days.')));
  }, [entryId, payslipId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    try { await navigator.clipboard.writeText(asText(b)); setCopied('Copied'); } catch { setCopied('Could not copy'); }
    setTimeout(() => setCopied(''), 2500);
  }
  function csv() {
    const url = URL.createObjectURL(new Blob([asCsv(b)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `lop-days-${(b.employee.code || b.employee.name || 'employee').replace(/[^A-Za-z0-9_-]+/g, '-')}-${b.month}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const r = b ? b.record : null;
  const terms = b ? [
    ['Absent days and unworked half days', b.terms.absent],
    [b.policy.unapprovedRule ? `Leave not approved (${num(b.policy.unapprovedRule.days)} LOP days a day)` : 'Waiting for approval (unpaid until approved)', b.terms.pending],
    ['Extra for a rejected leave', b.terms.rejectedLeave],
    ['No check-in days', b.terms.missingCheckIn],
    ['Extra for absent without leave', b.terms.awlExtra],
    [b.policy.lateRule ? `Late arrivals (every ${b.policy.lateRule.every} = ${num(b.policy.lateRule.days)} LOP day)` : 'Late arrivals beyond the free ones', b.terms.lateArrivals],
    ['Paid leave beyond the allowance', b.terms.leaveBeyondAllowance],
    ['Pay days before joining', b.terms.beforeJoining],
    ['Pay days after the last working day', b.terms.afterLeaving],
  ].filter(([, v]) => Number(v) > 0) : [];

  return (
    <>
      <div className="lop-back" onClick={onClose} />
      <aside className="lop-drawer" data-testid="lop-drawer" role="dialog" aria-label="LOP days">
        <div className="lop-head">
          <div>
            <h3>{b ? `LOP days: ${b.employee.name}${b.employee.code ? ` (${b.employee.code})` : ''} · ${b.monthLabel}` : 'LOP days'}</h3>
            {b && <div className="lop-subhead">Pay period {b.cycle.rangeText} ({b.cycle.days} days){b.employee.department ? ` · ${b.employee.department}` : ''}</div>}
          </div>
          <button className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="lop-body">
          {error && <div className="error-text">{error}</div>}
          {!b && !error && <div className="small-muted">Loading the dates…</div>}
          {b && (
            <>
              <div className="lop-tiles">
                <div><span>LOP days in payroll</span><b data-testid="lop-total">{num(r.daysLop)}</b></div>
                <div><span>Paid days</span><b>{num(r.paidDays)}</b></div>
                <div><span>Days in the pay period</span><b>{num(r.workingDays)}</b></div>
                <div><span>Where the number came from</span><b className="small">{SOURCE[r.source] || 'Payslip figure'}{b.adjustments.edits.length ? ' · edited by hand' : ''}</b></div>
                {r.status && <div><span>Payroll status</span><b className="small"><span className={`status ${STATUS_CLS[r.status]}`}>{STATUS_LABEL[r.status] || r.status}</span></b></div>}
              </div>

              {b.carry && (b.carry.saved > 0 || b.carry.applied) && (
                <div className="lop-carry" data-testid="lop-carry">
                  <b>Carry-forward leaves: {num(b.carry.saved)} day{Number(b.carry.saved) === 1 ? '' : 's'} saved</b>{' '}
                  from the earlier pay periods of this year (each pay period has 1 free leave day; the unused ones are saved until 31 Dec).{' '}
                  {b.carry.applied
                    ? <>This pay period used <b>{num(b.carry.used)}</b>, <b>{num(b.carry.left)}</b> left to take later. They cover approved leave before any LOP is cut.</>
                    : <>Pay does not use them yet: the Carry-forward leave rule on Payroll policy is off, so leave beyond the free day is cut as LOP.</>}
                  {b.carry.months.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary>Month by month</summary>
                      <ul>{b.carry.months.map((m) => <li key={m.month}>{m.label}: {num(m.used)} leave day(s) taken{m.saved > 0 ? `, ${num(m.saved)} saved` : ''}{m.covered > 0 ? `, ${num(m.covered)} paid from saved leave` : ''}</li>)}</ul>
                    </details>
                  )}
                </div>
              )}
              {b.status === 'match' && (
                <div className="lop-ok" data-testid="lop-match">The dates below add up to the {num(r.daysLop)} LOP day{Number(r.daysLop) === 1 ? '' : 's'} in the payroll.</div>
              )}
              {b.status !== 'match' && (
                <div className="lop-warn" data-testid="lop-differ">
                  <b>The dates below do not add up to the payroll’s {num(r.daysLop)} LOP day{Number(r.daysLop) === 1 ? '' : 's'}.</b>
                  {' '}Attendance gives {num(b.attendanceLop)} (difference {num(Math.abs(Number(r.daysLop) - Number(b.attendanceLop)))}).
                </div>
              )}
              {b.notes.length > 0 && <ul className="lop-notes">{b.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}

              {(b.adjustments.override || b.adjustments.edits.length > 0) && (
                <div className="lop-manual" data-testid="lop-manual">
                  <h4>Changed by hand</h4>
                  <ul>
                    {b.adjustments.override && (
                      <li>
                        {b.adjustments.override.by ? `Set by ${b.adjustments.override.by}` : 'Set by HR'}{b.adjustments.override.at ? ` on ${when(b.adjustments.override.at)}` : ''}: LOP days {b.adjustments.override.autoDaysLop != null ? `${num(b.adjustments.override.autoDaysLop)} (from attendance) → ` : ''}<b>{num(b.adjustments.override.daysLop)}</b>
                        {b.adjustments.override.reason ? ` · Reason: ${b.adjustments.override.reason}` : ''}
                      </li>
                    )}
                    {b.adjustments.edits.map((e, i) => (
                      <li key={i}>
                        {e.kind === 'recalculated' ? 'Recalculated from attendance' : 'Edited'}{e.by ? ` by ${e.by}` : ''} on {when(e.at)}: LOP days {num(e.from)} → <b>{num(e.to)}</b> ({e.change > 0 ? '+' : ''}{num(e.change)}){e.reason ? ` · Reason: ${e.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {terms.length > 0 && (
                <div className="lop-terms">
                  <h4>How the {num(b.attendanceLop)} days from attendance are made up</h4>
                  <ul>{terms.map(([k, v]) => <li key={k}><b>{num(v)}</b> {k}</li>)}</ul>
                  {b.capped > 0 && <div className="lop-sub">Total {num(b.listedLop)}, but a pay period cannot lose more than its {num(r.workingDays)} days.</div>}
                </div>
              )}

              <h4 className="lop-h">Days counted as LOP · {b.dates.length} date{b.dates.length === 1 ? '' : 's'}, {plural(b.listedLop, 'day')}</h4>
              {b.dates.length === 0 && <div className="lop-empty" data-testid="lop-empty">No date in this pay period was counted as loss of pay by attendance.</div>}
              {b.dates.map((d) => <DayCard key={d.date} d={d} counted />)}

              {(b.notCounted.length > 0 || b.weeklyOffs > 0) && (
                <details className="lop-light" data-testid="lop-not-counted">
                  <summary>Not counted as LOP · {b.notCounted.length} date{b.notCounted.length === 1 ? '' : 's'} that look like an absence but did not cost pay</summary>
                  {b.notCounted.map((d) => <DayCard key={d.date} d={d} counted={false} />)}
                  {b.weeklyOffs > 0 && <div className="lop-sub" style={{ padding: '6px 2px' }}>{b.weeklyOffs} week off day{b.weeklyOffs === 1 ? '' : 's'} (not working days) are not listed.</div>}
                </details>
              )}

              <div className="lop-rules">
                The rules used: {b.policy.paidLeaveDays} paid leave day{b.policy.paidLeaveDays === 1 ? '' : 's'} per pay period{b.policy.unapprovedRule ? ` (free whether the leave is approved or not; an approved leave beyond it counts 1 LOP day; a leave day that is not approved counts ${num(b.policy.unapprovedRule.days)} LOP days)` : ''}{b.policy.leaveCarry ? '; unused free leave days of the earlier pay periods of the year are saved and cover approved leave before LOP' : ''}; {b.policy.lateRule ? <>every {b.policy.lateRule.every} late arrivals count as {plural(b.policy.lateRule.days, 'LOP day')} (3 late = 1, 6 = 2);</> : <>the first {b.policy.freeLateArrivals} late arrivals are free, then half a day each;</>}
                working days with no check-in are {b.policy.unmarkedDaysUnpaid ? 'unpaid' : 'not counted as LOP'}; a holiday or week off between two leave days counts as leave{b.policy.sandwichLeave ? ' (sandwich rule on)' : ' (sandwich rule off)'}
                {b.policy.absentWithoutLeave ? `; absent without applying for leave counts as ${b.policy.absentWithoutLeave.days} LOP days (a half day: ${b.policy.absentWithoutLeave.halfDayDays})` : ''}.
                {' '}Where an allowance covers a whole pay period, it is given to the earliest days and the later days carry the cost.
              </div>
            </>
          )}
        </div>
        <div className="lop-foot">
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          {b && <button className="btn btn-sm" onClick={copy}>{copied || 'Copy'}</button>}
          {b && <button className="btn btn-sm" onClick={csv}>Download CSV</button>}
        </div>
      </aside>
    </>
  );
}
