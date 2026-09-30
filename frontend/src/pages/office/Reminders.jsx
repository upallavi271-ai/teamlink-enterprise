// REMINDERS — the main Dashboard's card for what falls due (Accounts spec 3,
// part 1: "Upcoming due dates" moved here from Office & Expenses).
//
// The data is Office & Expenses' own: GET /office-expenses/due-dates (the
// same dues officeFacts() builds — vendor bills not yet paid and client
// invoices still open, each on its own due date) plus the standard statutory
// dates (GST / TDS filing and payment) from officeUtil.dueDates(), exactly as
// the old list combined them. Only a login that can open Office & Expenses
// is shown the card (canViewOffice); the endpoint refuses everyone else.
//
// Status, from today: Overdue (past its date), Due today, Due soon (within
// the next WINDOW days). Earliest first.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import {
  money2, fmtD, dueDates, isoOf,
} from './officeUtil';

const DAY = 86400000;
const WINDOW = 45;
const SHOW = 8;

const daysTo = (iso, today) => Math.round((new Date(`${iso}T00:00:00`) - today) / DAY);

// The next date on or after today that falls on day `d` of a month.
function nextOnDay(d, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let k = 0; k < 3; k += 1) {
    const last = new Date(now.getFullYear(), now.getMonth() + k + 1, 0).getDate();
    const x = new Date(now.getFullYear(), now.getMonth() + k, Math.min(d, last));
    if (x >= today) return x;
  }
  return null;
}

function statusOf(days) {
  if (days < 0) return { label: 'Overdue', cls: 'overdue', sub: `${-days} day${days === -1 ? '' : 's'} late` };
  if (days === 0) return { label: 'Due today', cls: 'pending', sub: 'today' };
  return { label: 'Due soon', cls: 'new', sub: `in ${days} day${days === 1 ? '' : 's'}` };
}

export function buildReminders(data, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = dueDates(now).map((d) => ({
    key: `s-${d.key}`, date: d.date, kind: 'Statutory', name: d.title, sub: d.for, amount: null, to: '/office?tab=business',
  }));
  // PF / ESI on the 15th and PMT-06 on the 25th, as the old list had them.
  (data?.statutory || []).filter((c) => c.d === 15 || c.d === 25).forEach((c) => {
    const x = nextOnDay(c.d, now);
    if (x) out.push({ key: `c-${c.d}`, date: isoOf(x), kind: 'Statutory', name: c.t, sub: c.s, amount: null, to: '/office?tab=business' });
  });
  (data?.dues?.bills || []).forEach((b) => out.push({
    key: `b-${b.id}`, date: b.date, kind: 'Vendor bill', name: b.who, sub: `${b.title}${b.status === 'APPROVED' ? ' · approved' : ''}`, amount: b.amount, to: '/office?tab=expenses',
  }));
  (data?.dues?.invoices || []).forEach((i) => out.push({
    key: `i-${i.id}`, date: i.date, kind: 'Client invoice', name: i.who, sub: `${i.title} · to receive`, amount: i.amount, to: `/invoices/${i.id}`,
  }));
  return out
    .map((x) => ({ ...x, days: daysTo(x.date, today) }))
    // Overdue items and the next WINDOW days; a statutory date is only ever the next one.
    .filter((x) => x.days <= WINDOW && (x.days >= 0 || x.kind !== 'Statutory'))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.name).localeCompare(String(b.name)));
}

// Search · Type · Status on the card (the list filter standard).
const STATUS_WORDS = ['Overdue', 'Due today', 'Due soon'];
const REM_FIELDS = [
  { key: 'q', type: 'search', placeholder: 'Search name, vendor or client…', minWidth: 180, get: (x) => `${x.name || ''} ${x.sub || ''}` },
  { key: 'kind', label: 'Type', allLabel: 'All types', get: (x) => x.kind, primary: true },
  { key: 'status', label: 'Status', allLabel: 'All statuses', options: STATUS_WORDS, get: (x) => statusOf(x.days).label, primary: true },
];

export default function Reminders() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/office-expenses/due-dates')
      .then((r) => { if (live) setData(r.data); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const items = useMemo(() => (data ? buildReminders(data) : []), [data]);
  const overdue = items.filter((x) => x.days < 0).length;
  const lf = useListFilters(items, REM_FIELDS);
  const list = lf.rows;
  const shown = all ? list : list.slice(0, SHOW);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Reminders</h3>
        <span className="small-muted">
          {data ? `${items.length} due${overdue ? ` · ${overdue} overdue` : ''} · next ${WINDOW} days` : 'Bills and payments due'}
        </span>
      </div>
      {!data && !failed && <div className="small-muted" style={{ padding: '10px 18px' }}>Loading…</div>}
      {failed && <div className="empty-mini">The reminders could not be read just now.</div>}
      {data && items.length === 0 && <div className="empty-mini">Nothing due</div>}
      {data && items.length > 0 && (
        <div style={{ padding: '8px 18px 0' }}><ListFilterBar lf={lf} storageKey="dash-reminders" /></div>
      )}
      {data && items.length > 0 && list.length === 0 && <ListEmpty lf={lf} noun="reminders" />}
      {data && list.length > 0 && (
        <div className="tbl-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table>
            <thead>
              <tr><th>Due date</th><th>Name / vendor</th><th className="num">Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {shown.map((x) => {
                const st = statusOf(x.days);
                return (
                  <tr key={x.key}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtD(x.date)}</td>
                    <td>
                      <Link to={x.to} className="link-btn" style={{ textAlign: 'left' }}>{x.name}</Link>
                      <div className="small-muted">{x.kind} · {x.sub}</div>
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{x.amount != null ? money2(x.amount) : <span className="small-muted">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={`status ${st.cls}`}>{st.label}</span>
                      <div className="small-muted">{st.sub}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && list.length > SHOW && (
        <div className="small-muted" style={{ padding: '8px 18px' }}>
          <button type="button" className="link-btn" onClick={() => setAll(!all)}>
            {all ? `Show the first ${SHOW} only` : `Show all ${list.length}`}
          </button>
        </div>
      )}
    </div>
  );
}
