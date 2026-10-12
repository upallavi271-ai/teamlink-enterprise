import { useEffect, useState } from 'react';
import api from '../../api';
import './pendingWork.css';

// ---------------------------------------------------------------------------
// SMALL PIECES SHARED BY THE PENDING-WORK SCREENS (Team -> Pending work, the
// Recruiter 360 "Remind" button, the Tasks tab, settings, end-of-day report).
// Backend: /api/pending-work/* (routes/pendingWork.js).
// ---------------------------------------------------------------------------

export const errText = (e, fallback) => (e && e.response && e.response.data && e.response.data.error) || fallback;

// 10:42 in Indian time, whatever the browser's own zone.
export function istTime(at) {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
}

// "3 days late" / "due today" / "coming up"
export function whenWords(item) {
  if (!item) return '';
  if (item.status === 'late') {
    const n = Number(item.daysLate || 0);
    if (n <= 0) return 'late';
    return `${n} day${n === 1 ? '' : 's'} late`;
  }
  if (item.status === 'due_today') return 'due today';
  return 'coming up';
}
export const whenTone = (status) => (status === 'late' ? 'red' : status === 'due_today' ? 'orange' : 'blue');

// A count that is never a bare zero.
export const nz = (n) => (Number(n) > 0 ? Number(n).toLocaleString('en-IN') : '—');

// ---- may this viewer press Remind? (asked once, kept for a minute) ----------
let ACCESS = null;
let ACCESS_AT = 0;
export function fetchRemindAccess() {
  if (ACCESS && Date.now() - ACCESS_AT < 60000) return ACCESS;
  ACCESS_AT = Date.now();
  ACCESS = api.get('/pending-work/team', { params: { recruiter: '-' } })
    .then((r) => !!(r.data && r.data.canRemind))
    .catch(() => false);
  return ACCESS;
}
export function useCanRemind(enabled = true) {
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    fetchRemindAccess().then((v) => { if (live) setCan(v); });
    return () => { live = false; };
  }, [enabled]);
  return can;
}

// ---- the Remind button -------------------------------------------------------
// One click sends a polite nudge. After it: a disabled "Reminded 10:42".
// "Already reminded today" (429) is not an error - it is shown calmly.
export function RemindButton({
  recruiterId, applicationId, reminded, small = true, label = 'Remind', title, onDone,
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { at }
  const [note, setNote] = useState('');
  const [bad, setBad] = useState('');
  const was = done || (reminded && reminded.at ? reminded : null);
  async function press(e) {
    if (e) e.stopPropagation();
    setBusy(true); setBad(''); setNote('');
    try {
      const r = await api.post('/pending-work/remind', { recruiterId, ...(applicationId ? { applicationId } : {}) });
      setDone({ at: new Date().toISOString() });
      if (onDone) onDone(r.data);
    } catch (err) {
      const status = err.response && err.response.status;
      const msg = errText(err, 'The reminder could not be sent. Please try again.');
      if (status === 429) { setDone({ at: new Date().toISOString(), earlier: true }); setNote(msg); } else setBad(msg);
    } finally { setBusy(false); }
  }
  if (was) {
    const t = istTime(was.at);
    return (
      <span className="pwk-reminded-wrap">
        <button type="button" className={`btn${small ? ' btn-sm' : ''} pwk-reminded`} disabled title={note || `Reminded today${was.by ? ` by ${was.by}` : ''}`}>
          {t ? `Reminded ${t}` : 'Reminded today'}
        </button>
        {note && <span className="pwk-note-inline">{note}</span>}
      </span>
    );
  }
  return (
    <span className="pwk-reminded-wrap">
      <button type="button" className={`btn${small ? ' btn-sm' : ''} pwk-remind`} disabled={busy} onClick={press} title={title || 'Send a polite reminder to this person'}>
        {busy ? 'Sending…' : label}
      </button>
      {bad && <span className="pwk-err-inline">{bad}</span>}
    </span>
  );
}

// ---- Recruiter 360: "Late 2 · Due today 1 · Waiting 5" and one Remind button ----
// Shown only to leads who may remind and only for a person on their pending-work list.
export function PendingStrip({ personId }) {
  const [row, setRow] = useState(null);
  const [can, setCan] = useState(false);
  useEffect(() => {
    let live = true;
    setRow(null);
    api.get('/pending-work/team', { params: { recruiter: personId } })
      .then((r) => {
        if (!live) return;
        setCan(!!r.data.canRemind);
        setRow((r.data.rows || []).find((x) => x.userId === personId) || null);
      })
      .catch(() => { if (live) setRow(null); });
    return () => { live = false; };
  }, [personId]);
  if (!row) return null;
  const c = row.counts || {};
  const bits = [
    Number(c.late) > 0 && <span key="l" className="pwk-tag pwk-tag-red">{`Late ${c.late}`}</span>,
    Number(c.dueToday) > 0 && <span key="d" className="pwk-tag pwk-tag-orange">{`Due today ${c.dueToday}`}</span>,
    Number(c.waiting) > 0 && <span key="w" className="pwk-tag pwk-tag-blue">{`Waiting ${c.waiting}`}</span>,
  ].filter(Boolean);
  const own = Number(row.mine || 0) > 0;
  return (
    <div className="pwk-r360">
      <div className="pwk-r360-line">
        <b>Work waiting</b>
        {bits.length ? bits : <span className="pwk-tag pwk-tag-green">Nothing is waiting</span>}
      </div>
      {can && own && <RemindButton recruiterId={personId} reminded={row.reminded} small={false} label="Remind" />}
    </div>
  );
}
