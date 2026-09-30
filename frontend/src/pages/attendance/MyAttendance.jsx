import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { to12h } from '../../utils/csv.js';
import { Panel, PanelPad, PanelHead, StatRow } from '../../components/proto.jsx';
import FaceCheckIn from './FaceCheckIn.jsx';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { usePaged } from '../../components/Pager.jsx';
import './attendance-self.css';

// The day list's own filters (the period is the Month / Year / Custom picker).
const DAY_FIELDS = [
  { key: 'status', label: 'Status', get: (r) => r.status, primary: true },
  { key: 'method', label: 'Method', get: (r) => r.method, primary: true },
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

export function DayStatus({ status }) {
  const cls = {
    Present: 'active', Late: 'pending', 'Half Day': 'pending', Absent: 'rejected',
    'On Leave': 'applied', 'Missing Check-In': 'rejected', 'Missing Check-Out': 'pending',
    'Checked In': 'active', 'Not Checked In': 'hold', Holiday: 'interview', 'Weekly Off': 'interview',
  }[status] || 'pending';
  return <span className={`status ${cls}`}>{status}</span>;
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
      <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Range type">
        <option value="month">Month</option>
        {allowYear && <option value="year">Year</option>}
        <option value="custom">Custom range</option>
      </select>
      {mode === 'month' && <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />}
      {mode === 'year' && (
        <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
          {years.map((y) => <option key={y}>{y}</option>)}
        </select>
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
            <button type="button" className="btn btn-sm btn-primary" disabled={!st.hasPhoto} onClick={() => { setMessage(''); setOpen({ method: web[0].key, direction: 'In' }); }}>Check In</button>
            <button type="button" className="btn btn-sm" disabled={!st.hasPhoto} onClick={() => { setMessage(''); setOpen({ method: web[0].key, direction: 'Out' }); }}>Check Out</button>
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
        <FaceCheckIn
          direction={open.direction}
          method={open.method}
          onClose={() => { setOpen(null); load(); }}
          onDone={(d) => { setMessage(`${d.punch.direction === 'In' ? 'Checked in' : 'Checked out'} at ${to12h(d.punch.time)} — face verified.`); load(); }}
        />
      )}
    </PanelPad>
  );
}

export default function MyAttendance() {
  const [params, setParams] = useState({ month: thisMonth() });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError('');
    api.get('/attendance/my-days', { params })
      .then((r) => setData(r.data))
      .catch((e) => { setData(null); setError(e.response?.data?.error || 'Could not load your attendance.'); });
  }, [params]);

  async function exportAs(format) {
    setBusy(true);
    try {
      const tag = params.month || params.year || `${params.from}_${params.to}`;
      await downloadFrom('/attendance/my-days', { ...params, format }, `my-attendance-${tag}.${format}`);
    } catch { setError('Could not export.'); } finally { setBusy(false); }
  }

  const s = data && data.summary;
  const lf = useListFilters(data?.rows || [], DAY_FIELDS, { sorts: DAY_SORTS });
  const page = usePaged(lf.rows, 50);
  return (
    <div className="att-self">
      <CheckInPanel />
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
                { value: s.present, label: 'Present' },
                { value: s.late, label: 'Late' },
                { value: s.halfDay, label: 'Half Day' },
                { value: s.absent, label: 'Absent' },
                { value: s.onLeave, label: 'On Leave' },
                { value: s.missingCheckIn, label: 'Missing Check-In' },
                { value: s.missingCheckOut, label: 'Missing Check-Out' },
              ]} />
            </div>
          )}
          {data && data.rows && data.rows.length > 0 && <ListFilterBar lf={lf} storageKey="my-attendance-days" noun="days" />}
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Check-In</th><th>Check-Out</th><th>Total Hours</th><th>Status</th>
                <th>Method</th><th>Location</th><th>Regularization</th>
              </tr>
            </thead>
            <tbody>
              {page.slice.map((r) => (
                <tr key={r.date}>
                  <td>{r.date}</td>
                  <td className="cell-muted">{r.checkIn ? to12h(r.checkIn) : '—'}</td>
                  <td className="cell-muted">{r.checkOut ? to12h(r.checkOut) : '—'}</td>
                  <td className="cell-muted">{r.hours != null ? r.hours : '—'}</td>
                  <td><DayStatus status={r.status} />{r.note ? <div className="small-muted att-note">{r.note}</div> : null}</td>
                  <td className="cell-muted">{r.method || '—'}{r.verification ? <div className="small-muted att-note">{r.verification}</div> : null}</td>
                  <td className="cell-muted">{r.locationStatus || '—'}</td>
                  <td className="cell-muted">{r.regularization || '—'}</td>
                </tr>
              ))}
              {data && data.rows && data.rows.length === 0 && <tr><td colSpan="8" className="small-muted" style={{ padding: 16 }}>No days in this range.</td></tr>}
              {data && data.rows && data.rows.length > 0 && lf.rows.length === 0 && <tr><td colSpan="8"><ListEmpty lf={lf} noun="days" /></td></tr>}
            </tbody>
          </table>
        </div>
        {page.total > 0 && <Pager page={page} noun="days" />}
        {data && data.from && <div className="small-muted" style={{ padding: '10px 18px' }}>{data.from} → {data.to} · {data.rows.length} day(s)</div>}
      </Panel>
    </div>
  );
}
