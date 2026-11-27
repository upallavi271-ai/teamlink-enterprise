import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { ago } from '../utils/noteTarget.js';
import './UpdatesPopupStack.css';

// ---------------------------------------------------------------------------
// CLIENT UPDATES ON SCREEN (founder 2026-11-23: "information that comes from a client must pop up for everyone concerned").
//
// A small stack of cards at the top right, on every page of the app (mounted once in components/Shell.jsx):
//   "Your interviews today"   once a day, at the first look after sign-in, while there are interviews left today
//   each client update        who / what / when, [Open] and [Got it]; it stays until one of the two is pressed, and an
//                             unseen one comes back at the next sign-in
// Where it comes from: GET /api/ats-updates/popups (this person's unseen updates) and /api/ats-updates/interviews-today,
// checked every 30 seconds while the tab is visible and when the tab comes back. The 60 / 15 minute interview reminders
// stay in their own pop-up (components/InterviewPopup.jsx) - never shown twice.
// ---------------------------------------------------------------------------
// (2026-11-27) every TEAM change pops up too (backend utils/teamPopups.js): new candidate, step move, interview, joined, rejected, new requirement,
// new client - for everyone concerned. Checked every 15 seconds; when TeamLink is in a background tab and the person allowed it, the same update
// also shows as a desktop notification (the browser's own), once per update.
const POLL_MS = 15000;
const TEAM_CHIP = { team_joined: 'ups-chip-ok', team_rejected: 'ups-chip-bad', team_interview: 'ups-chip-iv', team_candidate: 'ups-chip-new', team_requirement: 'ups-chip-new', team_client: 'ups-chip-new' };
const canDesk = () => typeof window !== 'undefined' && 'Notification' in window;
const SHOW = 3;

export default function UpdatesPopupStack() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [today, setToday] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const told = useRef(null); // the updates already shown on the desktop in this tab
  const [desk, setDesk] = useState(() => (canDesk() ? Notification.permission : 'denied'));

  const check = useCallback(() => {
    if (!user) return;
    api.get('/ats-updates/popups').then((r) => {
      if (!alive.current) return;
      const list = Array.isArray(r.data) ? r.data : [];
      setItems(list);
      // the desktop notification: only new ones, only while the tab is not in front (in front, the card itself shows)
      if (told.current === null) { told.current = new Set(list.map((i) => i.eventId)); return; }
      const fresh = list.filter((i) => !told.current.has(i.eventId));
      fresh.forEach((i) => told.current.add(i.eventId));
      if (document.hidden && canDesk() && Notification.permission === 'granted') {
        fresh.slice(0, 3).forEach((i) => {
          try {
            const n = new Notification(i.title, { body: [i.summary, i.by].filter(Boolean).join(' · ').slice(0, 180), tag: i.eventId, icon: '/teamlink-icon-32.png' });
            n.onclick = () => { window.focus(); if (i.open) navigate(i.open); n.close(); };
          } catch { /* the browser refused: the card shows when the tab is back */ }
        });
      }
    }).catch(() => { /* offline: next check */ });
    api.get('/ats-updates/interviews-today').then((r) => { if (alive.current) setToday(r.data && r.data.popup ? r.data : null); }).catch(() => {});
  }, [user]);

  useEffect(() => {
    alive.current = true;
    if (!user) return undefined;
    check();
    const timer = setInterval(() => { if (!document.hidden) check(); }, POLL_MS);
    const onShow = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
    };
  }, [user && user.id, check]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user || (!items.length && !today)) return null;

  const seen = async (ids, opened, then) => {
    if (busy) return;
    setBusy(true);
    setItems((list) => list.filter((i) => !ids.includes(i.eventId)));
    try { await api.post('/ats-updates/popups/seen', { ids, opened: !!opened }); } catch { /* it comes back at the next check */ }
    setBusy(false);
    if (then) then();
  };
  const todaySeen = async (then) => {
    setToday(null);
    try { await api.post('/ats-updates/interviews-today/seen'); } catch { /* shows again at the next check */ }
    if (then) then();
  };
  const left = (today ? today.items.filter((i) => !i.past) : []);
  const shown = items.slice(0, SHOW);

  return (
    <div className="ups" role="region" aria-label="Updates for you">
      {today && left.length > 0 && (
        <div className="ups-card ups-today" role="alertdialog" aria-labelledby="ups-today-h">
          <div className="ups-top"><span className="ups-chip ups-chip-iv">Interviews</span></div>
          <div className="ups-title" id="ups-today-h">{`Your interviews today: ${left.length}`}</div>
          <ul className="ups-ivlist">
            {left.slice(0, 5).map((i) => (
              <li key={i.applicationId}>
                <b>{i.time}</b>
                {` · ${i.candidate} · ${i.job}${i.client ? ` (${i.client})` : ''} · ${i.mode}`}
                {i.venue ? ` at ${i.venue}` : ''}
                {i.link && <a className="ups-join" href={i.link} target="_blank" rel="noreferrer">Join</a>}
                {i.noLink && <span className="ups-warn"> · no link yet</span>}
              </li>
            ))}
            {left.length > 5 && <li className="small-muted">{`+ ${left.length - 5} more`}</li>}
          </ul>
          <div className="ups-foot">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => todaySeen(() => navigate('/ats/calendar'))}>Open calendar</button>
            <button type="button" className="btn btn-sm" onClick={() => todaySeen()}>Got it</button>
          </div>
        </div>
      )}
      {shown.map((u) => (
        <div className="ups-card" key={u.eventId} role="alertdialog" aria-labelledby={`ups-${u.eventId}`}>
          <div className="ups-top">
            <span className={`ups-chip ${TEAM_CHIP[u.type] || ''}`}>{u.typeLabel}</span>
            <span className="ups-when" title={new Date(u.at).toLocaleString('en-IN')}>{ago(u.at)}</span>
          </div>
          <div className="ups-title" id={`ups-${u.eventId}`}>{u.title}</div>
          {u.summary && <div className="ups-text">{u.summary}</div>}
          {u.by && <div className="ups-by">{u.by}</div>}
          <div className="ups-foot">
            {u.open && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => seen([u.eventId], true, () => navigate(u.open))}>Open</button>}
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => seen([u.eventId], false)}>Got it</button>
          </div>
        </div>
      ))}
      {desk === 'default' && shown.length > 0 && (
        <div className="ups-more">
          <span>Show these on the desktop too, when TeamLink is in another tab?</span>
          <button type="button" className="link-btn" onClick={() => Notification.requestPermission().then((p) => setDesk(p)).catch(() => {})}>Yes, allow</button>
        </div>
      )}
      {items.length > SHOW && (
        <div className="ups-more">
          <span>{`${items.length - SHOW} more update${items.length - SHOW === 1 ? '' : 's'}`}</span>
          <button type="button" className="link-btn" onClick={() => navigate('/admin/notifications')}>See all</button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => seen(items.map((i) => i.eventId), false)}>Got it for all</button>
        </div>
      )}
    </div>
  );
}
