import { useEffect, useState } from 'react';
import api from '../../api';
import { Panel, PanelHead } from '../proto.jsx';
import { usePayrollCycle, reloadPayrollCycle, monthShort } from './payrollCycleUi.jsx';
import { errText } from './payrollUi';
import './payrollCycleCard.css';

// ---------------------------------------------------------------------------
// PAYROLL CYCLE + ABSENT WITHOUT LEAVE (user, 2026-10-12) - on the Payroll
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
  const [msg, setMsg] = useState({ cycle: '', absent: '' });
  const [notes, setNotes] = useState([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    if (s.saved.cycle && s.cycle.startDay > 1) {
      setStartDay(s.cycle.startDay); setEffectiveFrom(s.cycle.effectiveFrom); setFirstFrom(s.cycle.firstFrom || '');
    }
    if (s.saved.absent && s.absent.days) { setAwlDays(s.absent.days); setHalfDays(s.absent.halfDayDays); setAwlFrom(s.absent.effectiveFrom); }
  }, [data]);

  if (!data) return null;
  const s = data.settings;
  const canEdit = isAdmin && data.canEdit;
  const sd = Number(startDay) || 1;
  const cycleOn = s.cycle.startDay > 1;
  const absentOn = !!s.absent.days;

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

  return (
    <Panel style={{ marginTop: 14 }}>
      <PanelHead title="Payroll cycle & absent days" />
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
      </div>
    </Panel>
  );
}
