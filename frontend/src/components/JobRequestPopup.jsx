import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import './JobRequestPopup.css';

// ---------------------------------------------------------------------------
// THE NEW-JOB-REQUEST POP-UP (user, 2026-10-09).
//
// When a client presses "Send request" in the client portal, the client's BDE
// (and second BDE, or the desk's BDEs when no BDE is named) and the BDE TL get
// this pop-up ON SCREEN, at once if they are online and on their next sign-in if
// they were not. A bell note alone is not enough.
//
//   "New job request from <Client>: <Job title>, <N openings>."
//   [Open the request]   [Later]
//
// Where it comes from: GET /api/admin/notifications/popups - the caller's own
// unread "New job request from <Client>" notifications (utils/requirementRequest.js
// writes one per person). Polled every 20 seconds while the tab is open and again
// the moment the tab comes back into view, and after sign-in.
//   - [Open the request] acknowledges THIS person's note (PATCH /admin/notifications/
//     :id/read) and opens the job. Nobody else's pop-up is touched.
//   - [Later] hides it for 30 minutes on this computer; it comes back (and on the next
//     sign-in) until the request is opened. Nothing is lost.
// The pop-up has no "x" and does not close when you click outside it.
// Mounted once, in the app shell (components/Shell.jsx).
// ---------------------------------------------------------------------------
const POLL_MS = 20000;
const SNOOZE_MS = 30 * 60 * 1000;
const SNOOZE_KEY = 'tl_jobreq_later';

function readSnooze() {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeSnooze(map) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(map)); } catch { /* no storage: it simply comes back at the next check */ }
}

const plural = (n) => `${n} opening${Number(n) === 1 ? '' : 's'}`;

export default function JobRequestPopup() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [later, setLater] = useState(() => readSnooze());
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const check = useCallback(() => {
    if (!user) return;
    api.get('/admin/notifications/popups')
      .then((res) => { if (alive.current) setItems(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { /* offline or signed out: try again at the next check */ });
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

  // A snooze that has run out lets the pop-up come back by itself.
  useEffect(() => {
    const t = setInterval(() => setLater(readSnooze()), 30000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const waiting = items.filter((i) => !(later[i.id] && later[i.id] > now));
  const cur = waiting[0];
  if (!user || !cur) return null;

  async function open() {
    if (busy) return;
    setBusy(true);
    try { await api.patch(`/admin/notifications/${cur.id}/read`); } catch { /* still open it */ }
    setItems((list) => list.filter((i) => i.id !== cur.id));
    setBusy(false);
    navigate(cur.path);
  }
  function snooze() {
    const map = { ...readSnooze() };
    Object.keys(map).forEach((k) => { if (map[k] <= Date.now()) delete map[k]; });
    map[cur.id] = Date.now() + SNOOZE_MS;
    writeSnooze(map);
    setLater(map);
  }

  const more = waiting.length - 1;
  const handled = cur.status && cur.status !== 'DRAFT';
  return (
    <div className="overlay show jrp-overlay" role="alertdialog" aria-modal="true" aria-labelledby="jrp-title" aria-describedby="jrp-text">
      <div className="modal jrp-box">
        <div className="jrp-head">
          <span className="jrp-ico" aria-hidden="true">📨</span>
          <h3 id="jrp-title">New job request</h3>
          {more > 0 && <span className="jrp-more">{`+${more} more waiting`}</span>}
        </div>
        <div className="jrp-body" id="jrp-text">
          <p className="jrp-line">
            <b>{cur.client}</b>
            {' sent a new job request:'}
          </p>
          <p className="jrp-job">{`${cur.jobTitle}, ${plural(cur.openings)}`}</p>
          {cur.reqCode && <p className="jrp-sub">{`Request ${cur.reqCode}`}</p>}
          {handled && <p className="jrp-done">Someone has already opened this request. Open it to see where it stands.</p>}
        </div>
        <div className="jrp-foot">
          <button type="button" className="btn btn-primary jrp-open" onClick={open} disabled={busy} autoFocus>Open the request</button>
          <button type="button" className="btn jrp-later" onClick={snooze} disabled={busy}>Later</button>
        </div>
      </div>
    </div>
  );
}
