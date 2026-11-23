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
const POLL_MS = 30000;
const SHOW = 3;

export default function UpdatesPopupStack() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [today, setToday] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const check = useCallback(() => {
    if (!user) return;
    api.get('/ats-updates/popups').then((r) => { if (alive.current) setItems(Array.isArray(r.data) ? r.data : []); }).catch(() => { /* offline: next check */ });
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
            <span className="ups-chip">{u.typeLabel}</span>
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
      {items.length > SHOW && (
        <div className="ups-more">
          <span>{`${items.length - SHOW} more update${items.length - SHOW === 1 ? '' : 's'}`}</span>
          <button type="button" className="link-btn" onClick={() => navigate('/ats/dashboard?updates=1')}>See all</button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => seen(items.map((i) => i.eventId), false)}>Got it for all</button>
        </div>
      )}
    </div>
  );
}
