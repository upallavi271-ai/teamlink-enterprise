import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import useAtsAlerts from '../../utils/useAtsAlerts';
import Modal from '../Modal.jsx';
import StatusChip from '../ui/StatusChip.jsx';
import { tourPending } from './FirstTour.jsx';

// ---------------------------------------------------------------------------
// MY TASKS — one number, used in three places (spec §3 / §14):
//   the greeting   "Good morning, Ravi — 6 tasks, 2 late."
//   the login popup (this component, once per sign-in)
//   the 🔔 bell     (its "My tasks" line)
// A TASK = a step that is MINE (the named owner, or my role's step in my
// area) and is late or due today — GET /api/dashboard/ats/alerts →
// important.lines['my-actions'] (utils/nextAction.js; Stale backlog never
// counts). Red = late, orange = due today.
// ---------------------------------------------------------------------------
export function myTasks(alerts) {
  const imp = alerts && alerts.important;
  if (!imp) return null;
  const l = (imp.lines || []).find((x) => x.id === 'my-actions');
  if (!l) return null;
  const items = imp.items || [];
  const late = typeof l.late === 'number' ? l.late : items.filter((x) => x.overdue).length;
  return { count: l.count, late, items };
}

export function taskLine(alerts) {
  const t = myTasks(alerts);
  if (!t) return null;
  // `short` is the dashboard greeting's half: "Good morning, Ravi — 6 tasks, 2 late."
  if (!t.count) return { text: 'Nothing is waiting on you right now.', short: 'nothing waiting on you.', late: 0, count: 0 };
  const s = t.count === 1 ? 'task' : 'tasks';
  const late = t.late ? `, ${t.late} ${t.late === 1 ? 'is' : 'are'} late` : '';
  return { text: `You have ${t.count} ${s}${late}.`, short: `${t.count} ${s}${t.late ? `, ${t.late} late` : ''}.`, late: t.late, count: t.count };
}

const SEEN_KEY = 'tl_taskpop_seen';
const tokenTail = () => { try { return String(localStorage.getItem('tl_token') || '').slice(-24); } catch { return ''; } };
const seen = () => { try { return localStorage.getItem(SEEN_KEY) === tokenTail(); } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(SEEN_KEY, tokenTail()); } catch { /* no storage */ } };

// The login popup: once per sign-in, only when there is something to do.
export default function TaskPopup() {
  const { user } = useAuth();
  const alerts = useAtsAlerts();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const t = myTasks(alerts);
  useEffect(() => {
    if (!user || !t || !t.count || seen() || tourPending(user)) return;
    // Not on top of a form the person is filling in.
    if (/\/(new|edit)\b/.test(pathname)) return;
    setOpen(true);
    markSeen();
  }, [user && user.id, t && t.count]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !t) return null;
  const line = taskLine(alerts);
  const close = () => setOpen(false);
  const go = (to) => { close(); navigate(to); };
  return (
    <Modal
      title={line.text.replace(/\.$/, '')}
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close}>Later</button>
          <button type="button" className="btn btn-primary" onClick={() => go(t.items[0] ? `/candidates/${t.items[0].candidateId}` : '/ats/dashboard')}>Do this now →</button>
        </>
      )}
    >
      <div className="tpop">
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {t.items.slice(0, 6).map((it) => (
            <li key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-soft, #eef1f6)' }}>
              {it.overdue ? <StatusChip tone="red">Late</StatusChip> : <StatusChip tone="amber">Due today</StatusChip>}
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{it.candidate}</b>
                <span className="small-muted" style={{ display: 'block' }}>{[it.action, it.requirement].filter(Boolean).join(' · ')}</span>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => go(`/candidates/${it.candidateId}`)}>Open</button>
            </li>
          ))}
        </ul>
        {t.count > 6 && <p className="small-muted" style={{ margin: '8px 0 0' }}>…and {t.count - 6} more on <button type="button" className="link-btn" onClick={() => go('/ats/dashboard')}>your dashboard</button>.</p>}
      </div>
    </Modal>
  );
}
