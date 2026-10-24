import { useEffect, useState } from 'react';
import ErrorBoundary from '../../components/ErrorBoundary.jsx';
import { stopCamera } from '../../utils/cameraHold.js';
import { distanceWords } from '../../utils/checkinGeo.js';
import { Link } from 'react-router-dom';
import api from '../../api';
import { to12h } from '../../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow } from '../../components/proto.jsx';
import FaceCheckIn from './FaceCheckIn.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import { SourceChips, SourceFilter, PunchToggle, PunchDetails } from '../../components/PunchSourceChip.jsx';
import { HalfLeaveChip } from './DayReport.jsx';
import { TellWhyDialog } from './LatePermission.jsx';
import '../../components/payroll/payrollCycleCard.css';
import './attendance-self.css';
import Combo from '../../components/Combo.jsx';

// A half day, and where the leave for the other half stands (from the day's own status).
const halfStateOf = (r) => (r.status === 'Half Day + Half Leave' || r.status === 'Half Leave + Absent' ? 'Approved' : r.status === 'Half Day, Under Review' ? 'Pending' : r.status === 'Half Day' ? 'None' : '');

// The day list's own filters (the period is the Month / Year / Custom picker).
const DAY_FIELDS = [
  { key: 'status', label: 'Status', get: (r) => r.status, primary: true },
  { key: 'method', label: 'Check-in method', get: (r) => r.how || r.method, primary: true },
  { key: 'location', label: 'Location', allLabel: 'Any location status', get: (r) => r.locationStatus },
  { key: 'regularization', label: 'Regularization', allLabel: 'Any regularization', get: (r) => r.regularization },
];
const DAY_SORTS = [
  { key: 'desc', label: 'Date (newest first)', cmp: (a, b) => String(b.date).localeCompare(String(a.date)) },
  { key: 'asc', label: 'Date (oldest first)', cmp: (a, b) => String(a.date).localeCompare(String(b.date)) },
];

// ---------------------------------------------------------------------------
// HRMS-24 §4 / §5 / §10 — MY ATTENDANCE, for everybody with an employee record:
// employees and every higher position alike (TL, STL, HR, Assistant Manager,
// Manager, Super Admin). Check in / out with a live face + location, and the
// person's OWN days with Month / Year / Custom (From → To → Apply) filters.
// The rows come from GET /attendance/my-days, which only ever reads the
// caller's own employee record.
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => localToday().slice(0, 7);

// The four colours of the simple-UX rule (same map as the server's
// utils/attendanceDays.js COLOUR): green done · blue going on · orange
// waiting · red problem. Days off carry no colour.
export const DAY_COLOUR = {
  Present: 'green', 'On Leave': 'green', 'Half Day + Half Leave': 'green',
  Late: 'orange', 'Early Logout': 'orange', 'Half Day, Under Review': 'orange', 'Leave Under Review': 'orange',
  'Checked In': 'blue', 'Not Checked In': 'blue', Informed: 'orange',
  Absent: 'red', 'Half Day': 'red', 'Missing Check-In': 'red', 'Missing Check-Out': 'red', 'Half Leave + Absent': 'red', 'No record': 'red',
};
const COLOUR_CLASS = { green: 'active', blue: 'applied', orange: 'pending', red: 'rejected' };
export function DayStatus({ status, colour, earlyLogout = false }) {
  const tone = colour || DAY_COLOUR[status] || '';
  const cls = COLOUR_CLASS[tone] || 'att-off';
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <span className={`status ${cls}`}>{status}</span>
      {earlyLogout && status !== 'Early Logout' && <span className="status pending" title="Checked out before the end of the working day">Left early</span>}
    </span>
  );
}

export async function downloadFrom(url, params, filename) {
  const res = await api.get(url, { params, responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

// Month / Year / Custom, with an explicit Apply. Returns the query params.
export function RangePicker({ onApply, allowYear = true }) {
  const [mode, setMode] = useState('month');
  const [month, setMonth] = useState(thisMonth());
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [from, setFrom] = useState(`${thisMonth()}-01`);
  const [to, setTo] = useState(localToday());
  const [err, setErr] = useState('');
  const years = Array.from({ length: 4 }, (_, i) => String(new Date().getFullYear() - i));

  function apply() {
    setErr('');
    if (mode === 'custom') {
      if (!from || !to) { setErr('Pick both dates.'); return; }
      if (from > to) { setErr('The From date is after the To date.'); return; }
      onApply({ from, to });
    } else if (mode === 'year') onApply({ year });
    else onApply({ month });
  }

  return (
    <div className="filter-row att-range">
      <Combo value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Range type">
        <option value="month">Month</option>
        {allowYear && <option value="year">Year</option>}
        <option value="custom">Custom range</option>
      </Combo>
      {mode === 'month' && <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />}
      {mode === 'year' && (
        <Combo value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
          {years.map((y) => <option key={y}>{y}</option>)}
        </Combo>
      )}
      {mode === 'custom' && (
        <>
          <label className="small-muted">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <label className="small-muted">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </>
      )}
      <button type="button" className="btn btn-sm btn-primary" onClick={apply}>Apply</button>
      {err && <span className="error-text">{err}</span>}
    </div>
  );
}

function CheckInPanel() {
  const [st, setSt] = useState(null);
  const [open, setOpen] = useState(null); // { method, direction }
  const [message, setMessage] = useState('');

  function load() {
    api.get('/attendance/checkin/status').then((r) => setSt(r.data)).catch(() => setSt({ hasEmployee: false, methods: [] }));
  }
  useEffect(load, []);
  // Get the face models and my registered photo ready on the server NOW, so Check In is quick when tapped.
  useEffect(() => {
    api.post('/attendance/face/warm', {}, { timeout: 10000 }).catch(() => {});
    return () => stopCamera(); // leaving the page switches the camera off
  }, []);

  if (!st) return <PanelPad><div className="small-muted">Loading…</div></PanelPad>;
  const web = (st.methods || []).filter((m) => m.web);
  const bio = (st.methods || []).some((m) => m.key === 'Biometric');
  // No employee record (e.g. Super Admin, a system account) means no punches.
  const todayPunches = st.todayPunches || [];
  const last = todayPunches[todayPunches.length - 1];

  return (
    <PanelPad>
      <h3 style={{ fontSize: 14, marginBottom: 10 }}>Check in / Check out</h3>
      {!st.hasEmployee && <div className="notice amber">No employee record is linked to this login, so there is no attendance to record.</div>}
      {st.hasEmployee && !st.methods.length && (
        <div className="notice amber">No check-in method has been assigned to you yet. Super Admin assigns them under Check-in Methods.</div>
      )}
      {st.hasEmployee && web.length > 0 && !st.hasPhoto && (
        <div className="notice amber">
          Add your photo in My Employee Profile first — web and mobile check-in compares a live picture with it.
          {' '}<Link to="/my-profile">Open My Employee Profile</Link>
        </div>
      )}
      {web.length > 0 && (
        <div className="att-checkin-row">
          <span>
            <b>Web / mobile check-in</b>
            <span className="small-muted" style={{ display: 'block' }}>
              Opens your camera for a live picture (a quick head turn or blink) that is matched to your registered photo,
              and records your location{st.geofence && st.geofence.enabled ? ` — it must be within ${st.geofence.radiusM} m of the office` : ''}.
            </span>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={!st.hasPhoto || !!st.open} title={st.open ? `Already checked in at ${to12h(last.time)}` : undefined} onClick={() => { setMessage(''); setOpen({ method: web[0].key, direction: 'In' }); }}>Check In</button>
            <button type="button" className="btn btn-sm" disabled={!st.hasPhoto || !st.open} title={!st.open ? 'Check in first' : undefined} onClick={() => { setMessage(''); setOpen({ method: web[0].key, direction: 'Out' }); }}>Check Out</button>
          </span>
        </div>
      )}
      {bio && (
        <div className="small-muted" style={{ marginTop: 6 }}>
          <b>Biometric</b> — check in and out on the fingerprint device; those punches appear here once the device sends them.
        </div>
      )}
      {message && <div className="notice" style={{ marginTop: 10 }}>{message}</div>}
      <div className="small-muted" style={{ marginTop: 8 }}>
        {st.todayPunches && st.todayPunches.length
          ? `Today: ${st.todayPunches.length} punch(es) — last ${last.direction === 'In' ? 'check-in' : 'check-out'} at ${to12h(last.time)}${last.verificationStatus ? ` (${last.verificationStatus})` : ''}.`
          : 'No punches recorded today yet.'}
      </div>
      {open && (
        <ErrorBoundary compact onClose={() => { setOpen(null); load(); }}>
          <FaceCheckIn
            direction={open.direction}
            method={open.method}
            geofence={st.geofence}
            onClose={() => { setOpen(null); load(); }}
            onDone={(d) => { setMessage(d.duplicate ? d.message : `${d.punch.direction === 'In' ? 'Checked in' : 'Checked out'} at ${to12h(d.punch.time)} — face verified.`); load(); }}
          />
        </ErrorBoundary>
      )}
    </PanelPad>
  );
}

// LATE COMING on a day: where the person's request stands, and ONE clear button when they have not explained yet.
function LateChip({ r, windowDays, onTell }) {
  if (!(r.late || r.lateExcused)) return null;
  if (r.lateState === 'approved') return <div><span className="hl-chip tone-green" title="A manager approved. You stay Present and this is not counted as a late arrival.">{r.latePermissionText || 'Late (approved)'}</span></div>;
  if (r.lateState === 'pending') return <div><span className="hl-chip tone-orange" title="Waiting for your approver. It still counts as late until it is approved.">{r.latePermissionText || 'Late - waiting for approval'}</span></div>;
  if (r.lateState === 'rejected') return <div><span className="hl-chip tone-red" title="The reason was not accepted. It counts as late.">{r.latePermissionText || 'Late - rejected'}</span></div>;
  const ago = Math.round((Date.parse(localToday() + 'T00:00:00Z') - Date.parse(r.date + 'T00:00:00Z')) / 86400000);
  return (
    <div>
      <span className="hl-chip tone-red">{r.latePermissionText || 'Not explained'}</span>
      {ago <= windowDays && <button type="button" className="btn btn-sm btn-primary att-tellwhy" onClick={() => onTell(r.date)}>Tell why I was late</button>}
    </div>
  );
}

// A gentle note to the employee after a day absent with no leave applied (payroll rule, 2026-10-12).
function AwlBanner() {
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/payroll/cycle/my-absences').then((r) => setD(r.data)).catch(() => setD(null)); }, []);
  if (!d || !d.days || !d.days.length) return null;
  const open = d.days.filter((x) => x.canFix);
  if (!open.length) return null;
  const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const lop = open.reduce((n, x) => n + x.lop, 0);
  return (
    <div className="pc-banner" data-testid="awl-banner">
      You were absent on <b>{open.map((x) => fmt(x.date)).join(', ')}</b> and did not apply leave: <b>{lop} LOP day{lop === 1 ? '' : 's'}</b> will be deducted from the {open[0].payrollLabel} salary.
      {' '}Apply leave for {open.length === 1 ? 'that day' : 'those days'} before the payroll is locked to correct it. <Link to="/leave">Apply leave</Link>
    </div>
  );
}

const srcTotalsOf = (rows) => { const t = { all: rows.length }; ['web', 'biometric', 'pulse', 'hr'].forEach((g) => { t[g] = rows.filter((x) => x.sourceCounts && x.sourceCounts[g] > 0).length; }); return t; };

export default function MyAttendance() {
  const [params, setParams] = useState({ month: thisMonth() });
  const [data, setData] = useState(null);
  const [tellFor, setTellFor] = useState(null); // the date the "Tell why I was late" popup is open for
  const [windowDays, setWindowDays] = useState(7);
  const [reload, setReload] = useState(0);
  const [src, setSrc] = useState('');
  const [openRow, setOpenRow] = useState(null);
  useEffect(() => { api.get('/late-permissions/settings').then((r) => setWindowDays(r.data.pastDays)).catch(() => {}); }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError('');
    api.get('/attendance/my-days', { params })
      .then((r) => setData(r.data))
      .catch((e) => { setData(null); setError(e.response?.data?.error || 'Could not load your attendance.'); });
  }, [params, reload]);

  async function exportAs(format) {
    setBusy(true);
    try {
      const tag = params.month || params.year || `${params.from}_${params.to}`;
      await downloadFrom('/attendance/my-days', { ...params, format }, `my-attendance-${tag}.${format}`);
    } catch { setError('Could not export.'); } finally { setBusy(false); }
  }

  const s = data && data.summary;
  const lf = useListFilters(data?.rows || [], DAY_FIELDS, { sorts: DAY_SORTS });
  const srcRows = src ? lf.rows.filter((x) => x.sourceCounts && x.sourceCounts[src] > 0) : lf.rows;
  const page = usePaged(srcRows, 50);
  return (
    <div className="att-self">
      <CheckInPanel />
      <AwlBanner />
      <Panel>
        <PanelHead title="My attendance">
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm" disabled={!data || busy} onClick={() => exportAs('csv')}>Export CSV</button>
            <button type="button" className="btn btn-sm" disabled={!data || busy} onClick={() => exportAs('xlsx')}>Export Excel</button>
          </div>
        </PanelHead>
        <div style={{ padding: '12px 18px 0' }}>
          <RangePicker onApply={setParams} />
          {data && data.hasEmployee === false && <div className="notice amber">No employee record is linked to this login.</div>}
          {error && <div className="notice red">{error}</div>}
          {s && (
            <div style={{ margin: '4px 0 12px' }}>
              <StatRow cells={[
                { value: s.paidDays ?? 0, label: 'Paid days' },
                // The same cards as HR's Attendance report (server: kpiOf / classifyDay).
                ...(s.kpi ? [
                  { value: s.kpi.present, label: 'Present' },
                  { value: s.kpi.absent, label: 'Absent' },
                  { value: s.kpi.halfDay, label: `Half day (1st ${s.halfFirst || 0} · 2nd ${s.halfSecond || 0})` },
                  { value: s.kpi.earlyLogout, label: 'Early logout' },
                  { value: s.kpi.late, label: 'Late' },
                  { value: s.kpi.missingCheckIn, label: 'Missing check-in' },
                  { value: s.kpi.missingCheckOut, label: 'Missing check-out' },
                  { value: s.kpi.onLeave, label: 'On leave' },
                ] : []),
              ]} />
            </div>
          )}
          {s && s.kpi && s.kpi.late > 0 && (
            <div className="att-late-line" data-testid="my-late-chips">
              <b>Late {s.kpi.late}</b> · Approved {s.lateApproved || 0} · Waiting {s.latePending || 0}{s.lateRejected ? ` · Rejected ${s.lateRejected}` : ''} · Not explained {s.lateNotExplained || 0}
              <span className="small-muted"> — an approved late day stays Present and is not counted as a late arrival.</span>
            </div>
          )}
          {data && data.rows && data.rows.length > 0 && <ListFilterBar lf={lf} storageKey="my-attendance-days" noun="days" />}
          {data && data.rows && data.rows.length > 0 && <SourceFilter value={src} onChange={setSrc} totals={srcTotalsOf(lf.rows.filter((x) => (x.punchList || []).length))} />}
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Check-In</th><th>Check-Out</th><th>Total Hours</th><th>Status</th>
                <th>Check-in method</th><th>Punches by source</th><th>Location</th><th>Regularization</th>
              </tr>
            </thead>
            <tbody>
              {page.slice.map((r) => [(
                <tr key={r.date}>
                  <td>{r.date}</td>
                  <td className="cell-muted">{r.checkIn ? to12h(r.checkIn) : '—'}</td>
                  <td className="cell-muted">{r.checkOut ? to12h(r.checkOut) : '—'}</td>
                  <td className="cell-muted">{r.hours != null ? r.hours : '—'}</td>
                  <td><DayStatus status={r.status} colour={r.colour} earlyLogout={r.earlyLogout} />{r.reason || r.note ? <div className="small-muted att-note">{r.reason || r.note}</div> : null}{(r.notes || []).map((k) => <span key={k} className="hl-chip tone-orange">{{ late: 'Late', earlyLogout: 'Early logout', missingCheckIn: 'Missing check-in', missingCheckOut: 'Missing check-out', noPunches: 'No punches', punchOnLeave: 'Punch on a leave day', leaveRejected: 'Half-day leave rejected' }[k] || k}</span>)}{halfStateOf(r) ? <div><HalfLeaveChip state={halfStateOf(r)} half={r.leaveHalf ? (/first/i.test(r.leaveHalf) ? '1st half' : /second/i.test(r.leaveHalf) ? '2nd half' : '') : ''} /></div> : null}<LateChip r={r} windowDays={windowDays} onTell={setTellFor} />{r.awlText ? <div><span className="pc-tag" data-testid="awl-tag" title="No leave was applied for this day, so payroll counts extra loss of pay. Apply leave before the payroll is locked to correct it.">{r.awlText}</span></div> : null}</td>
                  <td className="cell-muted">{r.howText || r.method || '—'}{r.verification ? <div className="small-muted att-note">{r.verification}</div> : null}</td>
                  <td className="cell-muted"><SourceChips counts={r.sourceCounts} />{(r.punchList || []).length > 0 && <div><PunchToggle open={openRow === r.date} count={r.punchList.length} onClick={() => setOpenRow(openRow === r.date ? null : r.date)} /></div>}</td>
                  <td className="cell-muted">{r.locationStatus || '—'}{r.distanceM != null ? ` · ${distanceWords(r.distanceM, r.accuracyM)}` : ''}</td>
                  <td className="cell-muted">{r.regularization || '—'}</td>
                </tr>
              ), openRow === r.date && <tr key={`${r.date}-d`}><td colSpan="9"><PunchDetails list={r.punchList} /></td></tr>])}
              {data && data.rows && data.rows.length === 0 && <tr><td colSpan="9" className="small-muted" style={{ padding: 16 }}>No days in this range.</td></tr>}
              {data && data.rows && data.rows.length > 0 && srcRows.length === 0 && <tr><td colSpan="9"><ListEmpty lf={lf} noun="days" /></td></tr>}
            </tbody>
          </table>
        </div>
        {page.total > 0 && <Pager page={page} noun="days" />}
        {data && data.from && <div className="small-muted" style={{ padding: '10px 18px' }}>{data.from} → {data.to} · {data.rows.length} day(s)</div>}
      </Panel>
      {tellFor && <TellWhyDialog date={tellFor} kind="Explain" onClose={() => setTellFor(null)} onDone={() => setReload((n) => n + 1)} />}
    </div>
  );
}
