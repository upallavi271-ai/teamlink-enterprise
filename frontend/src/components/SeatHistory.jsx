import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import ListFilterBar, { useListFilters, ListEmpty } from './ui/ListFilters.jsx';
import Pager, { usePaged } from './Pager.jsx';

// ---------------------------------------------------------------------------
// SEAT HISTORY — who sat in each position, from when to when, and who took
// over. One screen for HRMS (Employee Management) and ATS (Recruiter & BDE):
//
//   MED-2   Niveditha ───────── Keerthana ────────── Renuka A ────────▶ now
//           Oct 2025 – Jan 2026  Jan 2026 – Apr 2026  Apr 2026 – today
//
// Each seat is a timeline strip (segment width = time held) with the table of
// holders under it: from, to, how long, the applications worked from the seat
// in that time and how many joined. A TL seat counts its team's work.
// GET /api/positions/history.
// ---------------------------------------------------------------------------

const month = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—');
const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
function duration(days) {
  if (days < 31) return `${days} day${days === 1 ? '' : 's'}`;
  const m = Math.floor(days / 30.44);
  const d = Math.round(days - m * 30.44);
  return d > 3 ? `${m} mo ${d} d` : `${m} month${m === 1 ? '' : 's'}`;
}
// Distinct, calm fills for the segments; the current holder is always navy.
const FILLS = ['#CFDAEC', '#FBF3DE', '#E4F4EC', '#F0E3F5', '#FDE8E4', '#E3F2F7'];

export default function SeatHistory({ defaultDepartment = '' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  // One read: the server already limits it to the viewer's scope, so the
  // Department filter below only narrows what came back.
  useEffect(() => {
    setError('');
    api.get('/positions/history')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the seat history.'));
  }, []);

  // Only seats that have ever had someone in them.
  const allSeats = (data?.seats || []).filter((s) => s.tenures.length);
  // THE FILTER STANDARD (components/ui/ListFilters.jsx): Search · Department
  // · Status (now) · Held by, chips and Clear All; the seat cards are paged.
  const lf = useListFilters(allSeats, [
    { key: 'q', type: 'search', placeholder: 'Search position or person…',
      get: (s) => `${s.code} ${s.name || ''} ${s.tenures.map((t) => `${t.name} ${t.employeeCode || ''}`).join(' ')}` },
    { key: 'department', label: 'Department', allLabel: 'All departments', primary: true, get: (s) => s.department },
    { key: 'now', label: 'Status', allLabel: 'Filled or vacant', primary: true,
      options: [{ value: 'filled', label: 'Filled now' }, { value: 'vacant', label: 'Vacant now' }],
      match: (s, v) => (v === 'filled') === s.tenures.some((t) => t.current) },
    { key: 'person', label: 'Held by', allLabel: 'Anyone', primary: true, get: (s) => s.tenures.map((t) => t.name) },
  ], {
    initial: defaultDepartment ? { department: defaultDepartment } : undefined,
    sorts: [
      { key: 'dept', label: 'Department, code', cmp: (a, b) => String(a.department || '~').localeCompare(String(b.department || '~')) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }) },
      { key: 'holders', label: 'Most holders', cmp: (a, b) => b.tenures.length - a.tenures.length },
    ],
  });
  const seats = lf.rows;
  const page = usePaged(seats);
  // One shared time axis for every strip, so the seats line up month for month.
  const starts = seats.flatMap((s) => s.tenures.map((t) => Date.parse(t.from)));
  const axisFrom = starts.length ? Math.min(...starts) : 0;
  const axisTo = Date.now();
  const span = Math.max(1, axisTo - axisFrom);

  return (
    <div>
      <ListFilterBar
        lf={lf}
        storageKey="seat-history"
        noun="positions"
        extra={axisFrom ? <span className="small-muted">{`${month(new Date(axisFrom).toISOString().slice(0, 10))} to today`}</span> : null}
      />
      {error && <div className="notice red">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {data && !seats.length && <ListEmpty lf={lf} noun="positions" title="No seat history recorded yet." />}

      {page.slice.map((s) => (
        <div className="card section" key={s.id} style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{s.code}</h3>
            <span className="small-muted">{[s.name, s.department].filter(Boolean).join(' · ')}</span>
            <span className="small-muted" style={{ marginLeft: 'auto' }}>
              {s.tenures.length} holder{s.tenures.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* The strip: who held it across time. */}
          <div style={{ display: 'flex', height: 30, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--card2)', position: 'relative' }}>
            <div style={{ width: `${((Date.parse(s.tenures[0].from) - axisFrom) / span) * 100}%` }} />
            {s.tenures.map((t, i) => {
              const from = Date.parse(t.from);
              const to = t.to ? Date.parse(t.to) + 86400000 : axisTo;
              const w = Math.max(0.8, ((to - from) / span) * 100);
              return (
                <div
                  key={`${t.name}-${t.from}`}
                  title={`${t.name}: ${day(t.from)} – ${t.to ? day(t.to) : 'today'} (${duration(t.days)})`}
                  style={{
                    width: `${w}%`, background: t.current ? 'var(--navy)' : FILLS[i % FILLS.length],
                    color: t.current ? '#fff' : 'var(--ink)', fontSize: 11.5, fontWeight: 600,
                    display: 'flex', alignItems: 'center', padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden',
                    borderRight: '2px solid #fff',
                  }}
                >
                  {t.name}
                </div>
              );
            })}
          </div>

          <div className="tbl-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr><th>#</th><th>Held by</th><th>From</th><th>To</th><th>Duration</th><th style={{ textAlign: 'right' }}>Applications</th><th style={{ textAlign: 'right' }}>Joined</th><th>Status</th></tr>
              </thead>
              <tbody>
                {s.tenures.map((t, i) => (
                  <tr key={`${t.name}-${t.from}`}>
                    <td className="cell-muted">{i + 1}</td>
                    <td>
                      {t.employeeId ? <Link to={`/employees/${t.employeeId}`}>{t.name}</Link> : t.name}
                      {t.employeeCode && <span className="small-muted"> · {t.employeeCode}</span>}
                      {i > 0 && <div className="small-muted" style={{ fontSize: 11.5 }}>replaced {s.tenures[i - 1].name}</div>}
                    </td>
                    <td>{day(t.from)}</td>
                    <td>{t.current ? <b>today</b> : day(t.to)}</td>
                    <td className="cell-muted">{duration(t.days)}</td>
                    <td style={{ textAlign: 'right' }}>{t.applications}</td>
                    <td style={{ textAlign: 'right' }}>{t.joined}</td>
                    <td>
                      {t.current
                        ? <span className="status active">Current</span>
                        : <span className="status pending">{['Relieved', 'Exited', 'Exit Process'].includes(t.employmentStatus) ? 'Left company' : 'Moved on'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {seats.length > 0 && <Pager page={page} noun="positions" />}
    </div>
  );
}
