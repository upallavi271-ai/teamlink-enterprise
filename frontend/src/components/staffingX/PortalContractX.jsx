import { useState } from 'react';
import api from '../../api';
import { Flash, Empty, useGet, useRun, day } from '../mktb/kit.jsx';
import { WeekEditor } from './ContractStaffX.jsx';
import './stx.css';

// ---------------------------------------------------------------------------
// CONTRACT STAFFING in the two outside portals (ATS wave 2, builder X; backend routes/staffingXPortal.js).
//   ClientTimesheetsX     client portal > Timesheets: the weeks of the company's contractors, approve or send back with a reason,
//                         and the shifts booked for them. The bill side only (hours and the amount billed).
//   CandidateContractX    candidate portal > My timesheets: a placed contractor fills in and sends their own weeks and sees
//                         their shifts. Their own pay only.
// ---------------------------------------------------------------------------
const PC = '/portal/client/contract';
const PK = '/portal/candidate/contract';
const inr = (v) => (v == null ? '-' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const TONE = { Approved: 'good', Submitted: 'new', Rejected: 'bad' };
const Chip = ({ s }) => <span className={`mkb-chip ${TONE[s] || ''}`}>{s === 'Submitted' ? 'Waiting for you' : s === 'Rejected' ? 'Sent back' : s}</span>;

export function ClientTimesheetsX({ onChanged }) {
  const [status, setStatus] = useState('Submitted');
  const sum = useGet(`${PC}/summary`);
  const list = useGet(`${PC}/timesheets${status ? `?status=${status}` : ''}`);
  const shifts = useGet(`${PC}/shifts`);
  const [why, setWhy] = useState({});
  const { busy, msg, run } = useRun();
  const may = !!(sum.data && sum.data.mayApprove);
  const rows = (list.data && list.data.rows) || [];
  const decide = (t, approve) => run(() => api.post(`${PC}/timesheets/${t.id}/decision`, { approve, reason: why[t.id] || '' }), approve ? 'Approved. Thank you.' : 'Sent back to the contractor.').then((x) => { if (x) { list.reload(); sum.reload(); if (onChanged) onChanged(); } });
  return (
    <div className="tlp-card" data-testid="stx-client-ts">
      <div className="mkb-row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Contractor timesheets</h3>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show"><option value="Submitted">Waiting for you</option><option value="Approved">Approved</option><option value="Rejected">Sent back</option><option value="">All</option></select>
      </div>
      <div className="tlp-meta" style={{ margin: '4px 0 10px' }}>{may ? 'Check the hours of each week and approve them, or send a week back with what is wrong. Approved weeks are billed.' : 'You can see the weeks here. Approving is done by your company\'s approver or by TeamLink.'}</div>
      {!rows.length && <Empty>Nothing here.</Empty>}
      {rows.map((t) => (
        <div className="stx-week" key={t.id}>
          <div className="mkb-row"><b>{t.name}</b><span className="tlp-meta">{`${t.requirement || ''} · week of ${day(t.weekStart)}`}</span><Chip s={t.status} /></div>
          <div className="tlp-meta">{`Mon-Sun: ${(t.hours || []).join(' · ')} = ${t.totalHours} h${t.otHours ? ` (${t.otHours} h overtime)` : ''}${t.note ? ` · "${t.note}"` : ''}${t.billAmount != null ? ` · billed ${inr(t.billAmount)} + GST` : ''}`}</div>
          {t.status === 'Rejected' && t.rejectReason && <div className="tlp-meta">{`Sent back: ${t.rejectReason}`}</div>}
          {t.status === 'Submitted' && may && (
            <div className="mkb-row">
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide(t, true)}>Approve</button>
              <input value={why[t.id] || ''} onChange={(e) => setWhy({ ...why, [t.id]: e.target.value })} placeholder="What is wrong?" aria-label="Reason to send back" />
              <button type="button" className="btn btn-sm" disabled={busy || !(why[t.id] || '').trim()} onClick={() => decide(t, false)}>Send back</button>
            </div>
          )}
        </div>
      ))}
      <Flash msg={msg} />
      <h3 style={{ margin: '16px 0 6px' }}>Shifts booked</h3>
      {!((shifts.data && shifts.data.rows) || []).length && <Empty>No shifts in the next two weeks.</Empty>}
      <ul className="mkb-list">{((shifts.data && shifts.data.rows) || []).map((s) => <li key={s.id}><span>{`${day(s.day)} ${s.start}-${s.end}`}</span><span>{s.name}</span><span className="tlp-meta">{[s.role, s.location].filter(Boolean).join(' · ')}</span></li>)}</ul>
    </div>
  );
}

export function CandidateContractX() {
  const d = useGet(PK);
  if (d.error) return <div className="notice red"><span>{d.error}</span></div>;
  if (!d.data) return <div className="small-muted">Loading…</div>;
  const { contracts, shifts } = d.data;
  if (!contracts.length) return <Empty>You have no contract work with us right now.</Empty>;
  return (
    <div className="tlp-grid" data-testid="stx-my-ts">
      {contracts.map((c) => (
        <div className="tlp-card" key={c.applicationId}>
          <h3>{`${c.role} · ${c.company}`}</h3>
          <div className="tlp-meta">{`From ${c.startOn || '-'}${c.endOn ? ` to ${c.endOn}` : ''} · ${c.weeklyHours} hours a week${c.rate ? ` · your rate ${inr(c.rate.payRate)} per ${String(c.rate.unit).toLowerCase()}` : ''}`}</div>
          {c.ended ? <Empty>This contract has ended.</Empty> : <WeekEditor base={PK} applicationId={c.applicationId} weeks={c.weeks} onSaved={d.reload} testid="stx-my-week" />}
          <div className="tlp-meta" style={{ marginTop: 6 }}>{c.weeks.filter((w) => w.status !== 'Not started').map((w) => `${day(w.weekStart)}: ${w.status}${w.payAmount != null ? ` (${inr(w.payAmount)})` : ''}`).join(' · ') || 'No weeks sent yet.'}</div>
        </div>
      ))}
      <div className="tlp-card">
        <h3>My shifts</h3>
        {!shifts.length && <Empty>No shifts booked.</Empty>}
        <ul className="mkb-list">{shifts.map((s) => <li key={s.id}><span>{`${day(s.day)} ${s.start}-${s.end}`}</span><span className="tlp-meta">{[s.role, s.location, `${s.hours} h`].filter(Boolean).join(' · ')}</span></li>)}</ul>
      </div>
    </div>
  );
}
