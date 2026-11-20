// CRM > FOLLOW-UPS > CALENDAR (2026-11-17): a month and a week view. Each follow-up sits on its day (and hour in the week), coloured by its type,
// red when it is late, struck through when done. A click opens the lead / deal / account; dragging an open follow-up to another day (or hour)
// moves it - the same "move" as Snooze (POST /crm/tasks/:id/snooze: it reminds again, and the managers are told again if it goes late again).
// Only a follow-up the person may change can be dragged (the server says so: canMove). GET /crm/tasks/calendar (crm/analytics.js)
import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { useCrm, errOf, dateOf, istToday, addDays } from './crmShared.jsx';

export const TYPE_COLOR = { Call: '#1baf7a', Meeting: '#2a78d6', WhatsApp: '#008300', Visit: '#eb6834', Email: '#6250d6', Other: '#52514e' };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 08:00 .. 20:00
const dowOf = (ymd) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
const mondayOf = (ymd) => addDays(ymd, -dowOf(ymd));
const monthTitle = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function Chip({ t, onOpen, onDragStart }) {
  const color = TYPE_COLOR[t.type] || TYPE_COLOR.Other;
  return (
    <button type="button" className={`crm-cal-chip${t.late ? ' late' : ''}${t.status === 'Done' ? ' done' : ''}`} style={{ '--c': color }}
      draggable={t.canMove} onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(t); }}
      onClick={() => onOpen(t)} title={`${t.dueTime ? `${t.dueTime} · ` : ''}${t.type}: ${t.title}${t.recordName ? ` — ${t.recordName}` : ''}${t.ownerName ? ` (${t.ownerName})` : ''}${t.late ? ' · LATE' : ''}${t.status === 'Done' ? ' · done' : ''}${t.canMove ? '\nDrag to another day to move it' : ''}`}>
      {t.dueTime ? `${t.dueTime} ` : ''}{t.title}
    </button>
  );
}

export default function FollowupCalendar({ owner, type, priority }) {
  const { me, toast, openRecord, version } = useCrm();
  const today = istToday();
  const [view, setView] = useState('month'); // month | week
  const [anchor, setAnchor] = useState(today);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(null); // the cell a follow-up is dragged over
  const [dragging, setDragging] = useState(null);
  const [tick, setTick] = useState(0);
  const range = useMemo(() => {
    if (view === 'week') { const f = mondayOf(anchor); return { from: f, to: addDays(f, 6) }; }
    const first = `${anchor.slice(0, 7)}-01`;
    const f = mondayOf(first);
    const lastDay = addDays(`${new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 1)).toISOString().slice(0, 10)}`, -1);
    return { from: f, to: addDays(lastDay, 6 - dowOf(lastDay)) };
  }, [view, anchor]);
  useEffect(() => {
    let alive = true;
    api.get('/crm/tasks/calendar', { params: { from: range.from, to: range.to, owner: owner || undefined } })
      .then((r) => { if (alive) { setRows(r.data.tasks); setErr(''); } }).catch((e) => { if (alive) setErr(errOf(e, 'The calendar could not be read.')); });
    return () => { alive = false; };
  }, [range, owner, version, tick]);
  // type / priority may be several ticked values (a comma list)
  const has = (csv, v) => !csv || String(csv).split(',').includes(v);
  const shown = (rows || []).filter((t) => has(type, t.type) && has(priority, t.priority));
  const byDay = useMemo(() => { const m = new Map(); shown.forEach((t) => { if (!m.has(t.dueDate)) m.set(t.dueDate, []); m.get(t.dueDate).push(t); }); return m; }, [shown]);
  const open = (t) => openRecord(t.recordKind, t.recordId);
  async function move(id, dueDate, dueTime) {
    setOver(null); setDragging(null);
    const t = (rows || []).find((x) => x.id === id);
    if (!t || !t.canMove) return;
    if (t.dueDate === dueDate && (dueTime === undefined || dueTime === t.dueTime)) return;
    if (dueDate < today) { toast('A follow-up can be moved to today or a later day.'); return; }
    try {
      await api.post(`/crm/tasks/${id}/snooze`, { dueDate, ...(dueTime !== undefined ? { dueTime } : {}) });
      toast(`Moved to ${dateOf(dueDate)}${dueTime ? ` at ${dueTime}` : (t.dueTime && dueTime === undefined ? ` at ${t.dueTime}` : '')}.`);
      setTick((n) => n + 1);
    } catch (e) { toast(errOf(e, 'This could not be moved.')); }
  }
  const dropProps = (key, dueDate, dueTime) => ({
    onDragOver: (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== key) setOver(key); } },
    onDragLeave: () => { if (over === key) setOver(null); },
    onDrop: (e) => { e.preventDefault(); move(e.dataTransfer.getData('text/plain') || (dragging && dragging.id), dueDate, dueTime); },
  });
  const step = (n) => {
    if (view === 'week') setAnchor(addDays(anchor, 7 * n));
    else { const d = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1 + n, 1)); setAnchor(d.toISOString().slice(0, 10)); }
  };
  const title = view === 'week' ? `${dateOf(range.from)} – ${dateOf(range.to)}` : monthTitle(`${anchor.slice(0, 7)}-01`);
  const days = []; for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  const lateN = shown.filter((t) => t.late).length;

  return (
    <div>
      <div className="crm-cal-bar">
        <button type="button" className="btn btn-sm" onClick={() => step(-1)} aria-label="Before">‹</button>
        <button type="button" className="btn btn-sm" onClick={() => setAnchor(today)}>Today</button>
        <button type="button" className="btn btn-sm" onClick={() => step(1)} aria-label="Next">›</button>
        <h3>{title}</h3>
        <span style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <button type="button" className={`btn btn-sm${view === 'month' ? ' btn-primary' : ''}`} onClick={() => setView('month')} aria-pressed={view === 'month'}>Month</button>
          <button type="button" className={`btn btn-sm${view === 'week' ? ' btn-primary' : ''}`} onClick={() => setView('week')} aria-pressed={view === 'week'}>Week</button>
        </span>
      </div>
      {err && <div className="notice" role="alert">{err}</div>}
      {rows == null && !err && <div className="small-muted">Loading…</div>}
      {rows && view === 'month' && (
        <div className="crm-cal-month" role="grid" aria-label={title}>
          {DOW.map((d) => <div key={d} className="crm-cal-dow">{d}</div>)}
          {days.map((d) => {
            const list = byDay.get(d) || [];
            const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
            return (
              <div key={d} className={`crm-cal-day${inMonth ? '' : ' out'}${d === today ? ' today' : ''}${over === d ? ' drop' : ''}`} {...dropProps(d, d, undefined)}>
                <span className="n">{Number(d.slice(8, 10))}</span>
                {list.slice(0, 4).map((t) => <Chip key={t.id} t={t} onOpen={open} onDragStart={setDragging} />)}
                {list.length > 4 && <button type="button" className="crm-linkbtn crm-cal-more" onClick={() => { setAnchor(d); setView('week'); }}>+{list.length - 4} more</button>}
              </div>
            );
          })}
        </div>
      )}
      {rows && view === 'week' && (
        <div className="crm-cal-week-wrap">
          <div className="crm-cal-week" role="grid" aria-label={title}>
            <div className="h" />
            {days.map((d, i) => <div key={d} className={`h${d === today ? ' today' : ''}`}>{DOW[i]} {Number(d.slice(8, 10))}</div>)}
            <div className="t">No time</div>
            {days.map((d) => (
              <div key={d} className={`crm-cal-slot${over === `${d}-x` ? ' drop' : ''}`} {...dropProps(`${d}-x`, d, undefined)}>
                {(byDay.get(d) || []).filter((t) => !t.dueTime || Number(t.dueTime.slice(0, 2)) < 8 || Number(t.dueTime.slice(0, 2)) > 20).map((t) => <Chip key={t.id} t={t} onOpen={open} onDragStart={setDragging} />)}
              </div>
            ))}
            {HOURS.map((h) => {
              const hh = String(h).padStart(2, '0');
              return [
                <div key={`t${h}`} className="t">{hh}:00</div>,
                ...days.map((d) => (
                  <div key={`${d}${h}`} className={`crm-cal-slot${over === `${d}-${h}` ? ' drop' : ''}`} {...dropProps(`${d}-${h}`, d, `${hh}:00`)}>
                    {(byDay.get(d) || []).filter((t) => t.dueTime && Number(t.dueTime.slice(0, 2)) === h).map((t) => <Chip key={t.id} t={t} onOpen={open} onDragStart={setDragging} />)}
                  </div>
                )),
              ];
            })}
          </div>
        </div>
      )}
      <div className="crm-cal-legend">
        {Object.entries(TYPE_COLOR).filter(([k]) => me.lists.taskTypes.includes(k)).map(([k, c]) => <span key={k}><i style={{ background: c }} />{k}</span>)}
        <span><i style={{ background: '#d03b3b' }} />Late{lateN ? ` (${lateN})` : ''}</span>
        <span>{me.canEdit ? 'Drag a follow-up to another day to move it; click it to open the record.' : 'Click a follow-up to open its record.'}</span>
      </div>
    </div>
  );
}
