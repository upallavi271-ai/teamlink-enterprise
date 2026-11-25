import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead } from '../proto.jsx';
import { usePayrollCycle, reloadPayrollCycle, monthShort } from './payrollCycleUi.jsx';
import { errText } from './payrollUi';
import './payrollCycleCard.css';

// ---------------------------------------------------------------------------
// PAYROLL CYCLE + ABSENT WITHOUT LEAVE (user, 2026-10-12) + LATE COMING (founder 2026-11-25: "3 late = 1 LOP, 4 = 1, 6 = 2") - on the Payroll
// policy screen. Super Admin / Admin edit; everyone else reads. Nothing changes
// until it is saved: with nothing saved payroll is the calendar month.
// ---------------------------------------------------------------------------
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const dm = (iso) => `${Number(iso.slice(8, 10))} ${MON3[Number(iso.slice(5, 7)) - 1]}`;

// The same arithmetic as the server (backend utils/payrollCycle.js), for the preview only.
function previewCycle(mk, startDay, effectiveFrom, firstFrom) {
  const [y, m] = mk.split('-').map(Number);
  const on = startDay > 1 && effectiveFrom && mk >= effectiveFrom;
  let from = `${mk}-01`;
  let to = `${mk}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
  if (on) {
    to = `${mk}-${pad(startDay - 1)}`;
    from = `${addMonths(mk, -1)}-${pad(startDay)}`;
    if (firstFrom && mk === effectiveFrom && firstFrom > from && firstFrom <= to) from = firstFrom;
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  return { key: mk, label: `${MON3[m - 1]} ${y}`, range: `${dm(from)} – ${dm(to)}`, days };
}

export default function PayrollCycleCard({ isAdmin }) {
  const data = usePayrollCycle();
  const [startDay, setStartDay] = useState(16);
  const [effectiveFrom, setEffectiveFrom] = useState('2026-09');
  const [firstFrom, setFirstFrom] = useState('');
  const [awlDays, setAwlDays] = useState(2);
  const [halfDays, setHalfDays] = useState(1);
  const [awlFrom, setAwlFrom] = useState('2026-09');
  const [lateEvery, setLateEvery] = useState(3);
  const [lateDays, setLateDays] = useState(1);
  const [lateFrom, setLateFrom] = useState('');
  const [unDays, setUnDays] = useState(2);
  const [unFrom, setUnFrom] = useState('');
  const [msg, setMsg] = useState({ cycle: '', absent: '', late: '', un: '' });
  const [notes, setNotes] = useState([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    if (s.saved.cycle && s.cycle.startDay > 1) {
      setStartDay(s.cycle.startDay); setEffectiveFrom(s.cycle.effectiveFrom); setFirstFrom(s.cycle.firstFrom || '');
    }
    if (s.saved.absent && s.absent.days) { setAwlDays(s.absent.days); setHalfDays(s.absent.halfDayDays); setAwlFrom(s.absent.effectiveFrom); }
    if (s.late && s.late.every) { setLateEvery(s.late.every); setLateDays(s.late.days); setLateFrom(s.late.effectiveFrom); } else if (data.current) setLateFrom((f) => f || data.current.key);
    if (s.unapproved && s.unapproved.days) { setUnDays(s.unapproved.days); setUnFrom(s.unapproved.effectiveFrom); } else if (data.current) setUnFrom((f) => f || data.current.key);
  }, [data]);

  if (!data) return null;
  const s = data.settings;
  const canEdit = isAdmin && data.canEdit;
  const sd = Number(startDay) || 1;
  const cycleOn = s.cycle.startDay > 1;
  const absentOn = !!s.absent.days;
  const lateOn = !!(s.late && s.late.every);
  const unOn = !!(s.unapproved && s.unapproved.days);

  const upcoming = [];
  if (sd > 1) {
    let mk = addMonths(effectiveFrom || '2026-09', -1);
    for (let i = 0; i < 5; i += 1) { upcoming.push(previewCycle(mk, sd, effectiveFrom, firstFrom || null)); mk = addMonths(mk, 1); }
  }

  async function saveCycle() {
    setBusy('cycle'); setMsg((m) => ({ ...m, cycle: '' })); setNotes([]);
    try {
      const body = sd === 1 ? { startDay: 1 } : { startDay: sd, effectiveFrom, ...(firstFrom ? { firstFrom } : {}) };
      const r = await api.put('/payroll/cycle', { cycle: body });
      setNotes(r.data.notes || []);
      setMsg((m) => ({ ...m, cycle: sd === 1 ? 'Saved. Payroll uses the normal calendar month.' : `Saved. From the ${monthShort(effectiveFrom)} payroll, a payroll month runs from day ${sd} to day ${sd - 1}.` }));
      await reloadPayrollCycle();
    } catch (err) { setMsg((m) => ({ ...m, cycle: errText(err, 'Could not save.') })); }
    setBusy('');
  }
  async function saveAbsent() {
    setBusy('absent'); setMsg((m) => ({ ...m, absent: '' }));
    try {
      await api.put('/payroll/cycle', { absent: { days: Number(awlDays), halfDayDays: Number(halfDays), effectiveFrom: awlFrom } });
      setMsg((m) => ({ ...m, absent: `Saved. From the ${monthShort(awlFrom)} payroll, a day absent with no leave applied counts as ${awlDays} LOP days.` }));
      await reloadPayrollCycle();
    } catch (err) { setMsg((m) => ({ ...m, absent: errText(err, 'Could not save.') })); }
    setBusy('');
  }

  async function saveUnapproved(off) {
    setBusy('un'); setMsg((m) => ({ ...m, un: '' }));
    try {
      await api.put('/payroll/cycle', { unapproved: off ? { off: true } : { days: Number(unDays), effectiveFrom: unFrom } });
      setMsg((m) => ({ ...m, un: off ? 'Switched off. Payroll counts leave the old way again.' : `Saved. From the ${monthShort(unFrom)} payroll, a leave day that is not approved counts ${unDays} LOP days.` }));
      await reloadPayrollCycle();
    } catch (err) { setMsg((m) => ({ ...m, un: errText(err, 'Could not save.') })); }
    setBusy('');
  }
  async function saveLate(off) {
    setBusy('late'); setMsg((m) => ({ ...m, late: '' }));
    try {
      await api.put('/payroll/cycle', { late: off ? { off: true } : { every: Number(lateEvery), days: Number(lateDays), effectiveFrom: lateFrom } });
      setMsg((m) => ({ ...m, late: off ? 'Switched off. Payroll counts late arrivals the old way again (the free ones, then half a day each).' : `Saved. From the ${monthShort(lateFrom)} payroll, every ${lateEvery} late arrivals count as ${lateDays} LOP day${Number(lateDays) === 1 ? '' : 's'}.` }));
      await reloadPayrollCycle();
    } catch (err) { setMsg((m) => ({ ...m, late: errText(err, 'Could not save.') })); }
    setBusy('');
  }

  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead title="Payroll cycle, absent days, late coming & leave" />
      <div style={{ padding: '6px 18px 16px' }} className="pc-card">
        <div className="pc-sentence">
          <b>Payroll month</b> runs from day{' '}
          <input type="number" min="1" max="28" value={startDay} disabled={!canEdit} onChange={(e) => setStartDay(e.target.value)} aria-label="Start day" />{' '}
          of the previous month to day <b>{sd > 1 ? sd - 1 : 'last'}</b>, and is named after the month it ends in.
        </div>
        <div className="pc-help">
          {sd > 1
            ? 'Example: 16 Aug – 15 Sep is the Sep payroll. Day 1 means the normal calendar month.'
            : 'Day 1 = the normal calendar month (1st to last day).'}
        </div>
        {sd > 1 && (
          <>
            <div className="pc-row">
              <span>Starts with the</span>
              <input type="month" value={effectiveFrom} disabled={!canEdit} onChange={(e) => setEffectiveFrom(e.target.value)} aria-label="First payroll month on the new cycle" />
              <span>payroll. Earlier months keep their old dates and money.</span>
            </div>
            <div className="pc-row">
              <span>First period starts on (only if some of its days were already paid):</span>
              <input type="date" value={firstFrom} disabled={!canEdit} onChange={(e) => setFirstFrom(e.target.value)} aria-label="First period starts on" />
            </div>
            <div className="pc-months">
              {upcoming.map((c) => (
                <div key={c.key} className={`pc-m ${data.current && data.current.key === c.key ? 'now' : ''}`}><b>{c.label} payroll</b>{c.range} · {c.days} days</div>
              ))}
            </div>
          </>
        )}
        {!s.saved.cycle && <div className="pc-note">Not saved yet: payroll still uses the normal calendar month. {canEdit ? 'Press Save to start the new cycle.' : 'Super Admin or Admin can turn it on.'}</div>}
        {s.saved.cycle && cycleOn && <div className="pc-ok">On: {monthShort(s.cycle.effectiveFrom)} payroll onwards runs from day {s.cycle.startDay} to day {s.cycle.startDay - 1}.</div>}
        {notes.map((n) => <div key={n} className="pc-note">{n}</div>)}
        {canEdit && <button className="btn btn-primary btn-sm" disabled={busy === 'cycle'} onClick={saveCycle}>Save payroll cycle</button>}
        {msg.cycle && <div className="pc-ok">{msg.cycle}</div>}

        <div className="pc-sep" />
        <div className="pc-sentence">
          <b>Absent without applying leave</b> counts as{' '}
          <input type="number" min="1" max="5" step="0.5" value={awlDays} disabled={!canEdit} onChange={(e) => setAwlDays(e.target.value)} aria-label="LOP days for an absent day with no leave" /> LOP days.
        </div>
        <div className="pc-row">
          <span>A half day with no leave counts as</span>
          <input type="number" min="0.5" max="5" step="0.5" value={halfDays} disabled={!canEdit} onChange={(e) => setHalfDays(e.target.value)} aria-label="LOP days for a half day with no leave" />
          <span>LOP day(s). From the</span>
          <input type="month" value={awlFrom} disabled={!canEdit} onChange={(e) => setAwlFrom(e.target.value)} aria-label="First payroll month" />
          <span>payroll.</span>
        </div>
        <div className="pc-help">
          One LOP day = monthly salary ÷ days in the pay period (31 for 16 Aug – 15 Sep). Leave that is applied and approved is decided by the leave type instead.
          Late coming, missing check-out, Sundays and holidays are never counted as absent.
        </div>
        {!s.saved.absent && <div className="pc-note">Not saved yet: an absent day still counts as 1 LOP day.</div>}
        {s.saved.absent && absentOn && <div className="pc-ok">On: from the {monthShort(s.absent.effectiveFrom)} payroll a day absent with no leave counts as {s.absent.days} LOP days.</div>}
        {canEdit && <button className="btn btn-primary btn-sm" disabled={busy === 'absent'} onClick={saveAbsent}>Save absent rule</button>}
        {msg.absent && <div className="pc-ok">{msg.absent}</div>}

        <div className="pc-sep" />
        <div className="pc-sentence">
          <b>Late coming</b>: every{' '}
          <input type="number" min="2" max="10" step="1" value={lateEvery} disabled={!canEdit} onChange={(e) => setLateEvery(e.target.value)} aria-label="Late arrivals per LOP step" /> late arrivals in a payroll month count as{' '}
          <input type="number" min="0.5" max="5" step="0.5" value={lateDays} disabled={!canEdit} onChange={(e) => setLateDays(e.target.value)} aria-label="LOP days for each step" /> LOP day(s).
        </div>
        <div className="pc-row">
          <span>Starts with the</span>
          <input type="month" value={lateFrom} disabled={!canEdit} onChange={(e) => setLateFrom(e.target.value)} aria-label="First payroll month for the late coming rule" />
          <span>payroll. Earlier months keep their numbers.</span>
        </div>
        <div className="pc-help">
          Example with 3: 2 late = 0 LOP, 3 late = 1 LOP, 4 = 1, 5 = 1, 6 = 2, 9 = 3. A late arrival whose late-coming request was approved is not counted.
          This replaces the old way (the free late arrivals of the Attendance policy, then half a day for each one more) for the months it applies to.
        </div>
        {!lateOn && <div className="pc-note">Not on yet: payroll still counts the free late arrivals of the Attendance policy, then half a day for each one more.</div>}
        {lateOn && <div className="pc-ok">On: from the {monthShort(s.late.effectiveFrom)} payroll every {s.late.every} late arrivals count as {s.late.days} LOP day{Number(s.late.days) === 1 ? '' : 's'}.</div>}
        {canEdit && <button className="btn btn-primary btn-sm" disabled={busy === 'late' || !lateFrom} onClick={() => saveLate(false)}>Save late coming rule</button>}
        {canEdit && lateOn && <button className="btn btn-sm" style={{ marginLeft: 8 }} disabled={busy === 'late'} onClick={() => saveLate(true)}>Switch off</button>}
        {msg.late && <div className="pc-ok">{msg.late}</div>}

        <div className="pc-sep" />
        <div className="pc-sentence">
          <b>Leave that is not approved</b>: a leave day that was applied but is not approved counts as{' '}
          <input type="number" min="1" max="5" step="0.5" value={unDays} disabled={!canEdit} onChange={(e) => setUnDays(e.target.value)} aria-label="LOP days for a leave day that is not approved" /> LOP days.
        </div>
        <div className="pc-row">
          <span>Starts with the</span>
          <input type="month" value={unFrom} disabled={!canEdit} onChange={(e) => setUnFrom(e.target.value)} aria-label="First payroll month for the leave not approved rule" />
          <span>payroll. Earlier months keep their numbers.</span>
        </div>
        <div className="pc-help">
          One leave day a month is free, approved or not. An approved leave beyond it counts 1 LOP day. A leave day that is not approved (still waiting when the payroll is calculated, or rejected while the person was absent) counts the number above.
          Absent with no leave applied is the rule above (absent without leave). Approve a waiting leave and calculate again to change it from {unDays} to 1.
        </div>
        {!unOn && <div className="pc-note">Not on yet: a waiting leave still counts 1 LOP day, and only approved leave uses the free leave day.</div>}
        {unOn && <div className="pc-ok">On: from the {monthShort(s.unapproved.effectiveFrom)} payroll a leave day that is not approved counts {s.unapproved.days} LOP days.</div>}
        {canEdit && <button className="btn btn-primary btn-sm" disabled={busy === 'un' || !unFrom} onClick={() => saveUnapproved(false)}>Save leave rule</button>}
        {canEdit && unOn && <button className="btn btn-sm" style={{ marginLeft: 8 }} disabled={busy === 'un'} onClick={() => saveUnapproved(true)}>Switch off</button>}
        {msg.un && <div className="pc-ok">{msg.un}</div>}
      </div>
    </Panel>
  );
}
