import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../api';
import TabStrip from '../ui/TabStrip.jsx';
import {
  Card, Flash, Empty, useGet, useRun, day, downloadPdf,
} from '../mktb/kit.jsx';
import './stx.css';

// ---------------------------------------------------------------------------
// CLIENTS & REQUIREMENTS > CONTRACT STAFF (ATS wave 2, builder X). Placed contractors and temp staff, on the ATS side only:
//   Contractors   who is placed on contract, their dates, PO and pay / bill rates (markup and margin)        11.16
//   Timesheets    weekly hours: filled in by the contractor (their portal) or the recruiter, approved        11.15
//   Shifts        a week calendar of booked and open shifts, with clash checks                               11.17
//   Pay & bill    the money of the approved weeks per contractor and client                                  11.16
//   Billing       the check before billing, invoice-ready batches, the accounting files and push      09.15 06.12 06.11 14.08
//   More: VMS (jobs in, candidates out, status back: 02.15 06.14 14.14) · Settings (Admin switches, all OFF at first)
// The server (backend/src/routes/staffingX.js) decides what each login sees and may change: Manager view only; BDE bill side only.
// Posting into TeamLink Accounts is NOT built here: it needs a founder decision.
// ---------------------------------------------------------------------------
const X = '/ats/staffing';
const TABS = [
  { key: 'contractors', label: 'Contractors', hint: 'Placed contractors: dates, PO, pay and bill rates' },
  { key: 'timesheets', label: 'Timesheets', hint: 'Weekly hours: filled in, sent, approved' },
  { key: 'shifts', label: 'Shifts', hint: 'Book and fill shifts for temp staff, with clash checks' },
  { key: 'paybill', label: 'Pay & bill', hint: 'The money of the approved weeks: bill, pay, cost and margin' },
  { key: 'billing', label: 'Billing', hint: 'The check before billing, invoice-ready batches and the accounting files' },
  { key: 'vms', label: 'VMS', hint: 'Jobs from the client\'s VMS, candidates sent there and their status', more: true },
  { key: 'settings', label: 'Settings', hint: 'Who approves, reminders and notices (all OFF until you turn them on)', more: true },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const inr = (v) => (v == null ? '-' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, k) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return iso(d); };
const mondayOf = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
const THIS_MONDAY = mondayOf(iso(new Date()));
const TONE = { Approved: 'good', Submitted: 'new', Rejected: 'bad', Draft: '', 'Not started': '', Booked: 'good', Open: 'new', Cancelled: 'bad', Done: 'good', Ready: 'good', 'Sent to accounting': 'good' };
const Chip = ({ s }) => <span className={`mkb-chip ${TONE[s] || ''}`}>{s}</span>;

function Table({ head, rows, empty = 'Nothing here yet.' }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap mkb-table">
      <table className="table"><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows}</tbody></table>
    </div>
  );
}

// ---- Contractors ----------------------------------------------------------------------------------------------------------
function ContractorPanel({ c, meta, onDone }) {
  const hist = useGet(`${X}/contractors/${c.applicationId}/rates`);
  const [f, setF] = useState({ startOn: c.startOn || '', endOn: c.endOn || '', poNumber: c.poNumber || '', costCentre: c.costCentre || '', approverName: c.approverName || '', weeklyHours: c.weeklyHours || '', payType: c.payType || '', status: c.status || 'Active' });
  const [r, setR] = useState({ effectiveFrom: THIS_MONDAY, unit: 'Hour', payRate: '', billRate: '', otPay: '1.5', otBill: '1.5', loadPercent: '0', reason: '' });
  const { busy, msg, run } = useRun();
  const edit = meta.mayRates && !meta.viewOnly;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setRate = (k) => (e) => setR({ ...r, [k]: e.target.value });
  return (
    <Card title={`${c.name} · ${c.client}`} testid="stx-contractor" note={`${c.requirement}${c.reqCode ? ` (${c.reqCode})` : ''}. Joined ${c.joined || '-'}.`} right={<button type="button" className="mkb-link" onClick={onDone}>Close</button>}>
      <div className="stx-form">
        <label>Starts<input type="date" value={f.startOn} onChange={set('startOn')} disabled={!edit} /></label>
        <label>Ends<input type="date" value={f.endOn} onChange={set('endOn')} disabled={!edit} /></label>
        <label>PO number<input value={f.poNumber} onChange={set('poNumber')} disabled={!edit} /></label>
        <label>Cost centre<input value={f.costCentre} onChange={set('costCentre')} disabled={!edit} /></label>
        <label>Client approver<input value={f.approverName} onChange={set('approverName')} disabled={!edit} placeholder="Name at the client" /></label>
        <label>Hours a week<input type="number" min="1" max="84" value={f.weeklyHours} onChange={set('weeklyHours')} disabled={!edit} /></label>
        {meta.seesPay && <label>Paid as<select value={f.payType} onChange={set('payType')} disabled={!edit}><option value="">-</option>{meta.payTypes.map((p) => <option key={p}>{p}</option>)}</select></label>}
        <label>Status<select value={f.status} onChange={set('status')} disabled={!edit}><option>Active</option><option>Ended</option></select></label>
      </div>
      {edit && <div className="mkb-row"><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.put(`${X}/contractors/${c.applicationId}`, f), 'Contract saved.').then((x) => x && onDone(true))}>Save contract</button></div>}
      <h4 className="stx-h4">Rates</h4>
      {edit && meta.seesPay && (
        <div className="stx-form" data-testid="stx-rate-form">
          <label>From<input type="date" value={r.effectiveFrom} onChange={setRate('effectiveFrom')} /></label>
          <label>Per<select value={r.unit} onChange={setRate('unit')}>{meta.units.map((u) => <option key={u}>{u}</option>)}</select></label>
          <label>Pay rate<input type="number" min="0" value={r.payRate} onChange={setRate('payRate')} aria-label="Pay rate" /></label>
          <label>Bill rate<input type="number" min="0" value={r.billRate} onChange={setRate('billRate')} aria-label="Bill rate" /></label>
          <label>Overtime pay x<input type="number" step="0.1" value={r.otPay} onChange={setRate('otPay')} /></label>
          <label>Overtime bill x<input type="number" step="0.1" value={r.otBill} onChange={setRate('otBill')} /></label>
          <label>Employer load %<input type="number" min="0" max="60" value={r.loadPercent} onChange={setRate('loadPercent')} title="PF, ESI, insurance ... on top of the pay" /></label>
          <label>Why<input value={r.reason} onChange={setRate('reason')} placeholder="Start rate, revision ..." /></label>
          <div><button type="button" className="btn btn-sm btn-primary" disabled={busy || !r.payRate || !r.billRate} onClick={() => run(() => api.post(`${X}/contractors/${c.applicationId}/rates`, r), (x) => x.data.warning || 'Rate saved.').then((x) => { if (x) { hist.reload(); } })}>Save rate</button></div>
        </div>
      )}
      <Flash msg={msg} />
      <Table
        head={['From', 'Per', ...(meta.seesPay ? ['Pay', 'Cost'] : []), 'Bill', ...(meta.seesPay ? ['Markup', 'Margin'] : []), 'Why', 'By']}
        empty="No rate yet."
        rows={((hist.data && hist.data.rows) || []).map((x) => (
          <tr key={x.id}>
            <td>{x.effectiveFrom}</td><td>{x.unit}</td>
            {meta.seesPay && <><td>{inr(x.payRate)}</td><td>{inr(x.cost)}</td></>}
            <td>{inr(x.billRate)}</td>
            {meta.seesPay && <><td>{x.markupPercent != null ? `${x.markupPercent}%` : '-'}</td><td className={x.marginPercent < 0 ? 'mkb-score bad' : ''}>{x.marginPercent != null ? `${x.marginPercent}%` : '-'}</td></>}
            <td className="small-muted">{x.reason || ''}</td><td className="small-muted">{x.byName || ''}</td>
          </tr>
        ))}
      />
    </Card>
  );
}

function Contractors({ meta }) {
  const [status, setStatus] = useState('Active');
  const list = useGet(`${X}/contractors?status=${status}`);
  const places = useGet(meta.mayRates && !meta.viewOnly ? `${X}/placements` : null);
  const [open, setOpen] = useState(null);
  const [mark, setMark] = useState('');
  const { busy, msg, run } = useRun();
  const rows = (list.data && list.data.rows) || [];
  return (
    <div>
      <Card title="Contractors" testid="stx-contractors" note="People placed on contract or temp work at a client. A contract / temporary requirement makes its joiners contractors; any other joined placement can be marked as one."
        right={<select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show"><option value="Active">Active</option><option value="Ended">Ended</option><option value="">All</option></select>}>
        {list.error && <Flash msg={{ ok: false, text: list.error }} />}
        <Table
          head={['Name', 'Client', 'Role', 'From', 'To', 'PO', 'Bill rate', ...(meta.seesPay ? ['Pay rate', 'Margin'] : []), '']}
          empty="No contractors yet."
          rows={rows.map((c) => (
            <tr key={c.applicationId}>
              <td><Link to={`/candidates/${c.candidateId}`}>{c.name}</Link></td><td>{c.client}</td><td>{c.requirement}</td>
              <td>{c.startOn || '-'}</td><td>{c.endOn || 'open'}</td><td>{c.poNumber || <span className="small-muted">none</span>}</td>
              <td>{c.rate ? `${inr(c.rate.billRate)}/${c.rate.unit.toLowerCase()}` : <span className="mkb-chip bad">No rate</span>}</td>
              {meta.seesPay && <><td>{c.rate ? inr(c.rate.payRate) : '-'}</td><td>{c.rate && c.rate.marginPercent != null ? `${c.rate.marginPercent}%` : '-'}</td></>}
              <td><button type="button" className="btn btn-sm" onClick={() => setOpen(c)}>Open</button></td>
            </tr>
          ))}
        />
        {meta.mayRates && !meta.viewOnly && ((places.data && places.data.rows) || []).length > 0 && (
          <div className="mkb-row">
            <select value={mark} onChange={(e) => setMark(e.target.value)} aria-label="Placement to mark as a contract" className="mkb-grow">
              <option value="">Mark another joined placement as a contract…</option>
              {places.data.rows.map((p) => <option key={p.applicationId} value={p.applicationId}>{`${p.name} · ${p.requirement} · ${p.client || ''}`}</option>)}
            </select>
            <button type="button" className="btn btn-sm" disabled={busy || !mark} onClick={() => run(() => api.put(`${X}/contractors/${mark}`, {}), 'Marked as a contract placement.').then((x) => { if (x) { setMark(''); list.reload(); places.reload(); } })}>Mark</button>
          </div>
        )}
        <Flash msg={msg} />
      </Card>
      {open && <ContractorPanel key={open.applicationId} c={open} meta={meta} onDone={(changed) => { setOpen(null); if (changed) list.reload(); }} />}
    </div>
  );
}

// ---- Timesheets -------------------------------------------------------------------------------------------------------------
export function WeekEditor({ base, applicationId, weeks, onSaved, testid = 'stx-week' }) {
  const [week, setWeek] = useState((weeks.find((w) => ['Not started', 'Draft', 'Rejected'].includes(w.status)) || weeks[0] || { weekStart: THIS_MONDAY }).weekStart);
  const cur = weeks.find((w) => w.weekStart === week) || { hours: [0, 0, 0, 0, 0, 0, 0], status: 'Not started' };
  const [hours, setHours] = useState(cur.hours);
  const [note, setNote] = useState(cur.note || '');
  const { busy, msg, run } = useRun();
  const locked = !['Not started', 'Draft', 'Rejected'].includes(cur.status);
  const pick = (w) => { setWeek(w); const c = weeks.find((x) => x.weekStart === w) || {}; setHours(c.hours || [0, 0, 0, 0, 0, 0, 0]); setNote(c.note || ''); };
  const total = hours.reduce((a, b) => a + (Number(b) || 0), 0);
  const save = (submit) => run(() => api.put(`${base}/${applicationId}/weeks/${week}`, { hours: hours.map((h) => Number(h) || 0), note, submit }), submit ? 'Sent for approval.' : 'Saved.').then((x) => x && onSaved && onSaved());
  return (
    <div className="stx-week" data-testid={testid}>
      <div className="mkb-row">
        <select value={week} onChange={(e) => pick(e.target.value)} aria-label="Week">{weeks.map((w) => <option key={w.weekStart} value={w.weekStart}>{`Week of ${day(w.weekStart)} · ${w.status}`}</option>)}</select>
        <Chip s={cur.status} />
        {cur.rejectReason && cur.status === 'Rejected' && <span className="mkb-chip bad">{`Sent back: ${cur.rejectReason}`}</span>}
      </div>
      <div className="stx-days">
        {DAYS.map((d, i) => (
          <label key={d}>{`${d} ${addDays(week, i).slice(8)}`}
            <input type="number" min="0" max="24" step="0.5" value={hours[i]} disabled={locked} aria-label={`Hours on ${d}`} onChange={(e) => { const h = [...hours]; h[i] = e.target.value; setHours(h); }} />
          </label>
        ))}
      </div>
      <div className="mkb-row">
        <input className="mkb-grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (leave, holiday, overtime reason …)" aria-label="Note" disabled={locked} />
        <b>{`${total} h`}</b>
      </div>
      {!locked && (
        <div className="mkb-row">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.get(`${base}/${applicationId}/weeks/${week}/from-shifts`)).then((x) => x && setHours(x.data.hours))}>Fill from shifts</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save(false)}>Save draft</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => save(true)}>Send for approval</button>
        </div>
      )}
      <Flash msg={msg} />
    </div>
  );
}

function EnterWeek({ contractors }) {
  const [app, setApp] = useState('');
  const w = useGet(app ? `${X}/contractors/${app}/weeks?weeks=8` : null);
  return (
    <Card title="Fill in a week for a contractor" testid="stx-enter" note="For a contractor without a portal login, or when the client sends a paper / mailed timesheet. The contractor can also fill it in from their own portal.">
      <select value={app} onChange={(e) => setApp(e.target.value)} aria-label="Contractor"><option value="">Pick the contractor…</option>{contractors.map((c) => <option key={c.applicationId} value={c.applicationId}>{`${c.name} · ${c.client}`}</option>)}</select>
      {w.data && <WeekEditor key={`${app}-${w.data.weeks.length}`} base={`${X}/contractors`} applicationId={app} weeks={w.data.weeks} onSaved={w.reload} />}
    </Card>
  );
}

function Timesheets({ meta }) {
  const [status, setStatus] = useState('Submitted');
  const list = useGet(`${X}/timesheets${status ? `?status=${status}` : ''}`);
  const cs = useGet(`${X}/contractors?status=Active`);
  const miss = useGet(`${X}/timesheets/missing`);
  const [why, setWhy] = useState({});
  const { busy, msg, run } = useRun();
  const rows = (list.data && list.data.rows) || [];
  const decide = (t, approve) => run(() => api.post(`${X}/timesheets/${t.id}/decision`, { approve, reason: why[t.id] || '' }), approve ? 'Approved.' : 'Sent back.').then((x) => x && list.reload());
  return (
    <div>
      <Card title="Timesheets" testid="stx-timesheets" note={`Approved by ${meta.approvalMode === 'client' ? 'the client only' : meta.approvalMode === 'tl' ? 'a TeamLink team lead only' : 'the client or a TeamLink team lead'}. Whoever entered a week can never approve it. An approved week is priced at the rate of that week.`}
        right={<select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show"><option value="Submitted">Waiting for approval</option><option value="Draft">Draft</option><option value="Rejected">Sent back</option><option value="Approved">Approved</option><option value="">All</option></select>}>
        <Table
          head={['Contractor', 'Client', 'Week', 'Hours', 'Overtime', 'Status', 'Entered by', 'Bill', ...(meta.seesPay ? ['Pay'] : []), '']}
          empty="No timesheets here."
          rows={rows.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td><td>{t.client}</td><td>{day(t.weekStart)}</td><td>{t.totalHours}</td><td>{t.otHours || '-'}</td><td><Chip s={t.status} />{t.billed && <span className="mkb-chip" style={{ marginLeft: 4 }}>Billed</span>}</td>
              <td className="small-muted">{`${t.submittedByName || '-'}${t.submittedByKind === 'Contractor' ? ' (portal)' : ''}`}</td>
              <td>{inr(t.billAmount)}</td>{meta.seesPay && <td>{inr(t.payAmount)}</td>}
              <td>
                {t.status === 'Submitted' && meta.mayApprove && !meta.viewOnly && (
                  <span className="mkb-row">
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(t, true)}>Approve</button>
                    <input value={why[t.id] || ''} onChange={(e) => setWhy({ ...why, [t.id]: e.target.value })} placeholder="What is wrong?" aria-label="Reason to send back" />
                    <button type="button" className="btn btn-sm" disabled={busy || !(why[t.id] || '').trim()} onClick={() => decide(t, false)}>Send back</button>
                  </span>
                )}
                {t.status === 'Approved' && !t.billed && meta.isAdmin && <button type="button" className="mkb-link" onClick={() => { const r = window.prompt('Why is this week reopened?'); if (r) run(() => api.post(`${X}/timesheets/${t.id}/reopen`, { reason: r }), 'Reopened.').then(list.reload); }}>Reopen</button>}
              </td>
            </tr>
          ))}
        />
        <Flash msg={msg} />
      </Card>
      {meta.mayTimesheets && !meta.viewOnly && <EnterWeek contractors={(cs.data && cs.data.rows) || []} />}
      <Card title="Missing last week" testid="stx-missing" note="Active contractors with no timesheet sent for last week. Reminders (a bell to the contractor and their recruiter, every Monday) are OFF until an Admin turns them on in Settings.">
        <Table head={['Contractor', 'Client']} empty="Nothing missing." rows={((miss.data && miss.data.rows) || []).map((r) => <tr key={r.applicationId}><td>{r.name}</td><td>{r.client}</td></tr>)} />
        {meta.isAdmin && ((miss.data && miss.data.rows) || []).length > 0 && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${X}/timesheets/remind`), (x) => (x.data.already ? 'Already reminded for this week.' : `${x.data.sent} reminded.`))}>Remind now</button>}
      </Card>
    </div>
  );
}

// ---- Shifts ---------------------------------------------------------------------------------------------------------------
function Shifts({ meta }) {
  const [from, setFrom] = useState(THIS_MONDAY);
  const list = useGet(`${X}/shifts?from=${from}&to=${addDays(from, 6)}`);
  const [f, setF] = useState({ applicationId: '', clientId: '', day: addDays(THIS_MONDAY, 1), start: '09:00', end: '18:00', role: '', location: '', repeat: 1 });
  const [sel, setSel] = useState(null);
  const sug = useGet(sel && sel.status === 'Open' ? `${X}/shifts/${sel.id}/suggestions` : null);
  const { busy, msg, run } = useRun();
  const data = list.data || { rows: [], contractors: [] };
  const people = data.contractors || [];
  const clients = useMemo(() => [...new Map(people.map((p) => [p.clientId, p.client])).entries()], [people]);
  const lanes = [...people.map((p) => ({ key: p.applicationId, label: p.name, sub: p.client })), ...(data.rows.some((s) => !s.applicationId) ? [{ key: '', label: 'Open shifts', sub: 'nobody yet' }] : [])];
  const may = meta.mayTimesheets && !meta.viewOnly;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const book = () => run(() => api.post(`${X}/shifts`, { ...f, applicationId: f.applicationId || undefined, clientId: f.applicationId ? undefined : f.clientId }), (x) => `Booked.${x.data.warnings.length ? ` Note: ${x.data.warnings.join(' ')}` : ''}`).then((x) => x && list.reload());
  const change = (body, ok) => run(() => api.put(`${X}/shifts/${sel.id}`, body), (x) => `${ok}${x.data.warnings && x.data.warnings.length ? ` Note: ${x.data.warnings.join(' ')}` : ''}`).then((x) => { if (x) { setSel(null); list.reload(); } });
  return (
    <div>
      <Card title="Shift calendar" testid="stx-shifts" note="Booked shifts per contractor and the open shifts still to fill. A clash (the same person twice at once, outside their contract) is stopped; short rest and long weeks are warned. Telling the contractor is OFF until an Admin turns it on."
        right={<span className="mkb-row"><button type="button" className="btn btn-sm" onClick={() => setFrom(addDays(from, -7))} aria-label="Previous week">‹</button><b>{`Week of ${day(from)}`}</b><button type="button" className="btn btn-sm" onClick={() => setFrom(addDays(from, 7))} aria-label="Next week">›</button></span>}>
        <div className="stx-cal" role="grid" aria-label="Shift calendar">
          <div className="stx-cal-row stx-cal-head" role="row"><div role="columnheader">Who</div>{DAYS.map((d, i) => <div key={d} role="columnheader">{`${d} ${addDays(from, i).slice(8)}`}</div>)}</div>
          {!lanes.length && <Empty>No contractors yet.</Empty>}
          {lanes.map((l) => (
            <div className="stx-cal-row" role="row" key={l.key || 'open'}>
              <div role="rowheader"><b>{l.label}</b><div className="small-muted">{l.sub}</div></div>
              {DAYS.map((d, i) => {
                const dd = addDays(from, i);
                const here = data.rows.filter((s) => (s.applicationId || '') === l.key && s.day === dd);
                return (
                  <div role="gridcell" key={d}>
                    {here.map((s) => <button type="button" key={s.id} className={`stx-shift ${s.status.toLowerCase()}`} onClick={() => setSel(s)} title={`${s.role || ''} ${s.location || ''}`}>{`${s.start}-${s.end}`}<span>{s.role || s.status}</span></button>)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {sel && (
          <div className="stx-sel" data-testid="stx-shift-sel">
            <b>{`${day(sel.day)} ${sel.start}-${sel.end}`}</b> <Chip s={sel.status} /> <span className="small-muted">{[sel.name, sel.role, sel.location, `${sel.hours} h`].filter(Boolean).join(' · ')}</span>
            {may && (
              <div className="mkb-row">
                {sel.status === 'Open' && ((sug.data && sug.data.rows) || []).map((p) => <button type="button" key={p.applicationId} className="btn btn-sm" disabled={busy || !p.free} title={p.why.join(' ')} onClick={() => change({ applicationId: p.applicationId }, `${p.name} is booked.`)}>{`Fill: ${p.name}${p.free ? '' : ' (clash)'}`}</button>)}
                {sel.status === 'Booked' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => change({ status: 'Done' }, 'Marked as worked.')}>Worked</button>}
                {['Booked', 'Open'].includes(sel.status) && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => change({ status: 'Cancelled' }, 'Cancelled.')}>Cancel shift</button>}
                {sel.status === 'Open' && <button type="button" className="mkb-link" onClick={() => run(() => api.delete(`${X}/shifts/${sel.id}`), 'Deleted.').then((x) => { if (x) { setSel(null); list.reload(); } })}>Delete</button>}
                <button type="button" className="mkb-link" onClick={() => setSel(null)}>Close</button>
              </div>
            )}
          </div>
        )}
        <Flash msg={msg} />
      </Card>
      {may && (
        <Card title="Book a shift" testid="stx-book">
          <div className="stx-form">
            <label>Who<select value={f.applicationId} onChange={set('applicationId')}><option value="">Nobody yet (open shift)</option>{people.map((p) => <option key={p.applicationId} value={p.applicationId}>{`${p.name} · ${p.client}`}</option>)}</select></label>
            {!f.applicationId && <label>Client<select value={f.clientId} onChange={set('clientId')}><option value="">Pick…</option>{clients.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>}
            <label>Day<input type="date" value={f.day} onChange={set('day')} /></label>
            <label>From<input type="time" value={f.start} onChange={set('start')} /></label>
            <label>To<input type="time" value={f.end} onChange={set('end')} /></label>
            <label>Role<input value={f.role} onChange={set('role')} placeholder="Picker, nurse …" /></label>
            <label>Place<input value={f.location} onChange={set('location')} /></label>
            <label>Days in a row<input type="number" min="1" max="31" value={f.repeat} onChange={set('repeat')} /></label>
          </div>
          <div className="mkb-row"><button type="button" className="btn btn-sm btn-primary" disabled={busy || (!f.applicationId && !f.clientId)} onClick={book}>Book</button></div>
        </Card>
      )}
    </div>
  );
}

// ---- Pay & bill -------------------------------------------------------------------------------------------------------------
function PayBill({ meta }) {
  const [from, setFrom] = useState(`${iso(new Date()).slice(0, 7)}-01`);
  const [to, setTo] = useState(iso(new Date()));
  const pb = useGet(`${X}/paybill?from=${from}&to=${to}`);
  const d = pb.data || { rows: [], byClient: [], totals: {} };
  return (
    <div>
      <Card title="Pay and bill" testid="stx-paybill" note={meta.seesPay ? 'From the approved weeks: what the clients are billed, what the contractors are paid, the cost with the employer load, and the margin.' : 'From the approved weeks: what the clients are billed.'}
        right={<span className="mkb-row"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /></span>}>
        <div className="stx-stats">
          <div><b>{d.totals.hours || 0}</b><span>Hours</span></div>
          <div><b>{inr(d.totals.bill || 0)}</b><span>Billed (before GST)</span></div>
          {meta.seesPay && <><div><b>{inr(d.totals.pay || 0)}</b><span>Pay</span></div><div><b>{inr(d.totals.cost || 0)}</b><span>Cost with load</span></div><div><b>{inr(d.totals.margin || 0)}</b><span>Margin</span></div></>}
        </div>
        <Table head={['Contractor', 'Client', 'Rate', 'Weeks', 'Hours', 'Bill', ...(meta.seesPay ? ['Pay', 'Cost', 'Margin'] : [])]}
          rows={d.rows.map((r) => (
            <tr key={r.applicationId}><td>{r.name}</td><td>{r.client}</td><td>{r.rate ? `${inr(r.rate.billRate)}/${r.rate.unit.toLowerCase()}` : '-'}</td><td>{r.weeks}</td><td>{r.hours}</td><td>{inr(r.bill)}</td>
              {meta.seesPay && <><td>{inr(r.pay)}</td><td>{inr(r.cost)}</td><td className={r.margin < 0 ? 'mkb-score bad' : ''}>{`${inr(r.margin)}${r.marginPercent != null ? ` (${r.marginPercent}%)` : ''}`}</td></>}
            </tr>
          ))} />
      </Card>
      <Card title="Per client">
        <Table head={['Client', 'Contractors', 'Hours', 'Bill', ...(meta.seesPay ? ['Margin'] : [])]} rows={d.byClient.map((c) => <tr key={c.clientId}><td>{c.client}</td><td>{c.contractors}</td><td>{c.hours}</td><td>{inr(c.bill)}</td>{meta.seesPay && <td>{inr(c.margin)}</td>}</tr>)} />
      </Card>
    </div>
  );
}

// ---- Billing ------------------------------------------------------------------------------------------------------------------
function Check({ meta }) {
  const au = useGet(`${X}/audit`);
  const [ex, setEx] = useState({});
  const [ai, setAi] = useState(false);
  const { busy, run } = useRun();
  const rows = (au.data && au.data.rows) || [];
  return (
    <Card title="Check before billing" testid="stx-check" note="Each placement is checked by rules: rates set and earning a margin, ID proof and offer / contract letter on file, background check, the client's standing, PO, and the approved weeks (hours, who approved, rate in force). A MUST-FIX stops the batch."
      right={<label className="small-muted"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Explain with AI (optional; the AI gets the check results only, never names)</label>}>
      <div className="mkb-row small-muted">{`${(au.data && au.data.ready) || 0} ready · ${(au.data && au.data.blocked) || 0} to fix`}</div>
      <Table head={['Contractor', 'Client', 'Result', 'Must fix', 'Look at', '']} empty="No contractors to check."
        rows={rows.map((r) => (
          <tr key={r.applicationId}>
            <td>{r.name}</td><td>{r.client}</td><td>{r.ready ? <span className="mkb-chip good">Ready</span> : <span className="mkb-chip bad">Fix first</span>}</td>
            <td className="small-muted">{r.errors.map((e) => e.text).join(' ') || '-'}</td><td className="small-muted">{r.warnings.map((w) => w.text).join(' ') || '-'}</td>
            <td>
              <button type="button" className="mkb-link" disabled={busy} onClick={() => run(() => api.post(`${X}/audit/${r.applicationId}/explain`, { useAi: ai })).then((x) => x && setEx({ ...ex, [r.applicationId]: x.data }))}>Explain</button>
              {ex[r.applicationId] && <div className="mkb-pre">{ex[r.applicationId].text}<div className="small-muted">{`(${ex[r.applicationId].source})`}</div></div>}
            </td>
          </tr>
        ))} />
      {meta.viewOnly && <div className="small-muted">View only.</div>}
    </Card>
  );
}
function Billing({ meta }) {
  const ub = useGet(`${X}/billing/unbilled`);
  const bl = useGet(`${X}/billing/batches`);
  const [why, setWhy] = useState({});
  const [open, setOpen] = useState(null);
  const det = useGet(open ? `${X}/billing/batches/${open}` : null);
  const { busy, msg, run } = useRun();
  const mayBill = meta.mayBill && !meta.viewOnly;
  const make = (g) => run(() => api.post(`${X}/billing/batches`, { clientId: g.clientId, override: why[g.clientId] || undefined }), (x) => `Batch ${x.data.number} made: ${x.data.lines} weeks, ${inr(x.data.total)} with GST.${x.data.pushed && x.data.pushed.ok ? ' Sent to accounting.' : ''}`).then((x) => { if (x) { ub.reload(); bl.reload(); } });
  const files = [['csv', 'CSV'], ['zoho', 'Zoho Books'], ['tally', 'Tally XML'], ['json', 'JSON']];
  return (
    <div>
      <Check meta={meta} />
      <Card title="Approved weeks not billed yet" testid="stx-unbilled" note="One invoice-ready batch per client: the approved weeks, the PO, the GST. The batch is a file for your accounting software; it is not an invoice in TeamLink Accounts.">
        <Table head={['Client', 'Contractors', 'Weeks', 'Hours', 'Bill (before GST)', '']} empty="Nothing to bill."
          rows={((ub.data && ub.data.rows) || []).map((g) => (
            <tr key={g.clientId}>
              <td>{g.client}</td><td>{g.contractors}</td><td>{`${g.weeks} (${day(g.from)} - ${day(addDays(g.to, 6))})`}</td><td>{g.hours}</td><td>{inr(g.bill)}</td>
              <td>{mayBill && (
                <span className="mkb-row">
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => make(g)}>Make batch</button>
                  {meta.isAdmin && <input value={why[g.clientId] || ''} onChange={(e) => setWhy({ ...why, [g.clientId]: e.target.value })} placeholder="Bill past the check? Why" aria-label="Reason to bill past the check" />}
                </span>
              )}</td>
            </tr>
          ))} />
        <Flash msg={msg} />
      </Card>
      <Card title="Billing batches" testid="stx-batches" note={meta.boundary}
        right={meta.seesPay && mayBill ? <button type="button" className="btn btn-sm" onClick={() => downloadPdf(`${X}/billing/pay-register`, 'contractor-pay.csv')}>Pay register (CSV)</button> : null}>
        <Table head={['Number', 'Client', 'Weeks', 'Bill', 'GST', 'Total', ...(meta.seesPay ? ['Margin'] : []), 'Status', '']} empty="No batches yet."
          rows={((bl.data && bl.data.rows) || []).map((b) => (
            <tr key={b.id}>
              <td><button type="button" className="mkb-link" onClick={() => setOpen(open === b.id ? null : b.id)}>{b.number}</button></td><td>{b.client}</td><td>{`${b.lines} (${day(b.fromWeek)} - ${day(b.toWeek)})`}</td>
              <td>{inr(b.billTotal)}</td><td>{inr(b.gstAmount)}</td><td><b>{inr(b.grandTotal)}</b></td>{meta.seesPay && <td>{inr(b.margin)}</td>}
              <td><Chip s={b.status} />{b.override && <div className="small-muted">{`Billed past the check: ${b.override}`}</div>}{b.pushResult && <div className="small-muted">{b.pushResult}</div>}</td>
              <td>{b.status !== 'Cancelled' && mayBill && (
                <span className="mkb-row">
                  {files.map(([k, l]) => <button type="button" key={k} className="btn btn-sm" onClick={() => downloadPdf(`${X}/billing/batches/${b.id}/export?format=${k}`, `${b.number}-${k}.${k === 'tally' ? 'xml' : k === 'json' ? 'json' : 'csv'}`)}>{l}</button>)}
                  <button type="button" className="btn btn-sm" disabled={busy || !meta.push.ready} title={meta.push.ready ? 'Send to the accounting address' : meta.push.state} onClick={() => run(() => api.post(`${X}/billing/batches/${b.id}/push`), (x) => x.data.result).then(bl.reload)}>Send</button>
                  <button type="button" className="btn btn-sm" disabled title="Needs a founder decision">Post into Accounts</button>
                  <button type="button" className="mkb-link" onClick={() => { const r = window.prompt('Why is this batch cancelled?'); if (r) run(() => api.post(`${X}/billing/batches/${b.id}/cancel`, { reason: r }), (x) => x.data.warning || 'Cancelled: the weeks can be billed again.').then(() => { bl.reload(); ub.reload(); }); }}>Cancel</button>
                </span>
              )}</td>
            </tr>
          ))} />
        {!meta.push.ready && <div className="small-muted">{`Send: ${meta.push.state}.`}</div>}
        {det.data && (
          <Table head={['Contractor', 'Role', 'Week', 'Regular', 'Overtime', 'Rate', 'Bill', 'PO', 'Approved by']}
            rows={det.data.lines.map((l) => <tr key={l.timesheetId}><td>{l.name}</td><td>{l.role}</td><td>{`${day(l.weekStart)} - ${day(l.weekEnd)}`}</td><td>{l.regHours}</td><td>{l.otHours}</td><td>{`${inr(l.billRate)}/${l.unit.toLowerCase()}`}</td><td>{inr(l.billAmount)}</td><td>{l.poNumber || '-'}</td><td className="small-muted">{l.approvedBy}</td></tr>)} />
        )}
      </Card>
    </div>
  );
}

// ---- VMS ----------------------------------------------------------------------------------------------------------------------
function SendToVms({ job, onSent }) {
  const c = useGet(`${X}/vms/jobs/${job.id}/candidates`);
  const [f, setF] = useState({ applicationId: '', billRate: '', availableFrom: '', withContact: false });
  const { busy, msg, run } = useRun();
  const rows = ((c.data && c.data.rows) || []).filter((r) => !r.sent);
  return (
    <div className="stx-sel">
      <div className="mkb-row">
        <select value={f.applicationId} onChange={(e) => setF({ ...f, applicationId: e.target.value })} aria-label="Candidate to send"><option value="">{rows.length ? 'Pick a candidate (approved by the BDE)…' : 'Nobody ready to send yet'}</option>{rows.map((r) => <option key={r.applicationId} value={r.applicationId}>{`${r.name} · ${r.stage}`}</option>)}</select>
        <input type="number" min="0" value={f.billRate} onChange={(e) => setF({ ...f, billRate: e.target.value })} placeholder={c.data && c.data.maxBillRate ? `Bill rate (max ${c.data.maxBillRate})` : 'Bill rate'} aria-label="Bill rate" />
        <input type="date" value={f.availableFrom} onChange={(e) => setF({ ...f, availableFrom: e.target.value })} aria-label="Available from" />
        <label className="small-muted"><input type="checkbox" checked={f.withContact} onChange={(e) => setF({ ...f, withContact: e.target.checked })} /> Send phone and e-mail too</label>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !f.applicationId || !f.billRate} onClick={() => run(() => api.post(`${X}/vms/submit/${f.applicationId}`, f), (x) => `Sent: VMS id ${x.data.externalId}.`).then((x) => { if (x) { c.reload(); onSent(); } })}>Send to the VMS</button>
      </div>
      <Flash msg={msg} />
    </div>
  );
}
function Vms({ meta }) {
  const v = useGet(`${X}/vms`);
  const clients = useGet(meta.mayVms ? '/clients?limit=500' : null);
  const [pickClient, setPickClient] = useState({});
  const [sendFor, setSendFor] = useState(null);
  const { busy, msg, run } = useRun();
  const d = v.data || { status: {}, jobs: [], submissions: [] };
  const may = meta.mayVms && !meta.viewOnly;
  const clientList = Array.isArray(clients.data) ? clients.data : ((clients.data && (clients.data.rows || clients.data.clients)) || []);
  return (
    <div>
      <Card title="VMS connector" testid="stx-vms" note="Contract jobs from a client's Vendor Management System (SAP Fieldglass, Beeline, Workday VNDLY or another), the candidates you send there and their status. Set up in Administration > Integrations > VMS with the supplier account the client gives you."
        right={may ? (
          <span className="mkb-row">
            <button type="button" className="btn btn-sm" disabled={busy || !d.status.ready} onClick={() => run(() => api.post(`${X}/vms/pull`), (x) => `${x.data.system}: ${x.data.seen} open, ${x.data.added} new.`).then(v.reload)}>Read jobs now</button>
            <button type="button" className="btn btn-sm" disabled={busy || !d.status.ready} onClick={() => run(() => api.post(`${X}/vms/sync`), (x) => `${x.data.checked} checked, ${x.data.changed} changed.`).then(v.reload)}>Check status</button>
            {meta.isAdmin && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${X}/vms/test`), (x) => x.data.message)}>Test</button>}
          </span>
        ) : null}>
        <div className="mkb-row"><span className={`mkb-chip ${d.status.ready ? 'good' : 'new'}`}>{d.status.ready ? `${d.status.name}: set up` : 'Not set up yet'}</span>{!d.status.ready && <span className="small-muted">{d.status.state}</span>}</div>
        <Flash msg={msg} />
      </Card>
      <Card title="VMS jobs" testid="stx-vms-jobs" note="A new job is filed as a requirement request for the client's BDE (the usual BDE > BDE TL > TL steps), never posted by itself unless the Admin switch says so.">
        <Table head={['Job', 'VMS client', 'Where', 'Openings', 'Highest bill rate', 'Starts', 'Status', '']} empty="No VMS jobs read yet."
          rows={d.jobs.map((j) => (
            <tr key={j.id}>
              <td><b>{j.title}</b><div className="small-muted">{`${j.systemName} ${j.externalId}`}</div></td><td>{j.client || j.clientName || '-'}</td><td>{j.location || '-'}</td><td>{j.openings || '-'}</td><td>{inr(j.maxBillRate)}</td><td>{j.startOn || '-'}</td>
              <td><Chip s={j.state} />{j.reqCode && <div><Link to={`/requirements/${j.requirementId}`}>{j.reqCode}</Link></div>}{j.submissions > 0 && <div className="small-muted">{`${j.submissions} sent`}</div>}</td>
              <td>{may && j.state === 'New' && (
                <span className="mkb-row">
                  {!j.clientId && <select value={pickClient[j.id] || ''} onChange={(e) => setPickClient({ ...pickClient, [j.id]: e.target.value })} aria-label="TeamLink client"><option value="">Which client?</option>{clientList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy || (!j.clientId && !pickClient[j.id])} onClick={() => run(() => api.post(`${X}/vms/jobs/${j.id}/import`, { clientId: pickClient[j.id] || undefined }), (x) => x.data.message || 'Filed.').then(v.reload)}>File as requirement request</button>
                  <button type="button" className="mkb-link" onClick={() => run(() => api.post(`${X}/vms/jobs/${j.id}/dismiss`)).then(v.reload)}>Not for us</button>
                </span>
              )}
              {may && j.requirementId && <button type="button" className="btn btn-sm" onClick={() => setSendFor(sendFor === j.id ? null : j.id)}>Send a candidate</button>}</td>
            </tr>
          ))} />
        {sendFor && <SendToVms job={d.jobs.find((j) => j.id === sendFor)} onSent={v.reload} />}
      </Card>
      <Card title="Sent to the VMS" testid="stx-vms-subs">
        <Table head={['Candidate', 'Job', 'Bill rate', 'VMS status', 'Sent', 'Checked']} empty="Nobody sent yet."
          rows={d.submissions.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.job}</td><td>{inr(s.billRate)}</td><td><Chip s={s.status || 'Not sent'} />{s.error && <div className="small-muted">{s.error}</div>}</td><td className="small-muted">{`${day(s.sentAt)} by ${s.sentByName || '-'}`}</td><td className="small-muted">{day(s.checkedAt)}</td></tr>)} />
      </Card>
      {meta.isAdmin && (
        <Card title="VMS call log" note="Every call to the VMS (Admin only).">
          <Table head={['When', 'System', 'Call', 'Result']} rows={(d.log || []).map((l) => <tr key={l.id}><td className="small-muted">{new Date(l.at).toLocaleString('en-GB')}</td><td>{l.system}</td><td>{l.action}</td><td>{l.ok ? 'OK' : `HTTP ${l.status} ${l.detail || ''}`}</td></tr>)} />
        </Card>
      )}
    </div>
  );
}

// ---- Settings -----------------------------------------------------------------------------------------------------------------
function Settings({ meta }) {
  const s = useGet(meta.isAdmin || meta.viewOnly ? `${X}/settings` : null);
  const [text, setText] = useState({});
  const { busy, msg, run } = useRun();
  if (!meta.isAdmin && !meta.viewOnly) return <Card title="Settings"><Empty>Only a Super Admin or an Admin changes these.</Empty></Card>;
  const save = (key, value) => run(() => api.put(`${X}/settings`, { key, value }), 'Saved.').then(s.reload);
  return (
    <Card title="Contract staffing settings" testid="stx-settings" note="Anything that tells people something or works by itself starts OFF. Every change is in the audit log. The VMS and accounting keys are in Administration > Integrations.">
      <ul className="mkb-list">
        {((s.data && s.data.switches) || []).map((w) => (
          <li key={w.key}>
            <span className="mkb-grow"><b>{w.label}</b><div className="small-muted">{w.note}</div></span>
            {w.type === 'bool' && <label><input type="checkbox" checked={!!w.value} disabled={busy || !s.data.mayEdit} onChange={(e) => save(w.key, e.target.checked)} aria-label={w.label} />{w.value ? ' On' : ' Off'}</label>}
            {w.type === 'choice' && <select value={w.value} disabled={busy || !s.data.mayEdit} onChange={(e) => save(w.key, e.target.value)} aria-label={w.label}>{w.choices.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
            {(w.type === 'number' || w.type === 'text') && (
              <span className="mkb-row">
                <input type={w.type === 'number' ? 'number' : 'text'} value={text[w.key] ?? w.value ?? ''} disabled={!s.data.mayEdit} onChange={(e) => setText({ ...text, [w.key]: e.target.value })} aria-label={w.label} style={{ width: w.type === 'number' ? 90 : 200 }} />
                {s.data.mayEdit && <button type="button" className="btn btn-sm" disabled={busy || text[w.key] === undefined} onClick={() => save(w.key, text[w.key])}>Save</button>}
              </span>
            )}
          </li>
        ))}
      </ul>
      {meta.isAdmin && <div className="mkb-row"><Link className="btn btn-sm" to="/admin/integrations">Administration › Integrations (VMS, Accounting push)</Link><button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.post(`${X}/accounting/test`), (x) => x.data.message)}>Test the accounting push</button></div>}
      <Flash msg={msg} />
    </Card>
  );
}

export default function ContractStaffX() {
  const [params, setParams] = useSearchParams();
  const meta = useGet(`${X}/meta`);
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'contractors';
  const m = meta.data;
  const P = { contractors: Contractors, timesheets: Timesheets, shifts: Shifts, paybill: PayBill, billing: Billing, vms: Vms, settings: Settings }[tab];
  return (
    <div className="stx" data-testid="stx-page">
      <div className="page-head"><div><h1>Contract staff</h1><div className="page-sub">Contractors and temp staff after joining: timesheets, shifts, pay and bill, billing files and the client&apos;s VMS</div></div></div>
      <TabStrip label="Contract staff" tabs={TABS.map((t) => ({ ...t, hidden: t.key === 'settings' && m && !m.isAdmin && !m.viewOnly }))} value={tab} onChange={(k) => setParams({ tab: k })} maxMain={5} />
      {meta.error && <Flash msg={{ ok: false, text: meta.error }} />}
      {!m && !meta.error && <div className="small-muted">Loading…</div>}
      {m && m.viewOnly && <div className="small-muted" style={{ margin: '0 0 8px' }}>Your login is view only here.</div>}
      {m && <P meta={m} />}
    </div>
  );
}
