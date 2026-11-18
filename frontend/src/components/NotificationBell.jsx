import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import useAtsAlerts from '../utils/useAtsAlerts';
import { JoinMeeting, splitMeeting } from './MeetingLink.jsx';
import './NotificationBell.css';

// An announcement's notification opens that announcement (Employee Services
// → Announcements); its "Join meeting: https://…" line becomes a button.
const ANN_PREFIX = 'Announcement: ';
const announcementLink = (n) => (String(n.title || '').startsWith(ANN_PREFIX)
  ? `/employee-services?tab=announcements&open=${encodeURIComponent(n.title.slice(ANN_PREFIX.length))}&at=${encodeURIComponent(n.createdAt || '')}`
  : null);
// A notice whose last line is "Open: /some/path" opens that screen (e.g. the
// client's Agreement card, 2026-10-05); the line itself is not shown.
const OPEN_RE = /\nOpen: (\/[^\s]+)\s*$/;
const noteLink = (n) => announcementLink(n) || ((String(n.message || '').match(OPEN_RE) || [])[1] || null);
const noteText = (m) => String(m || '').replace(OPEN_RE, '');

// ---------------------------------------------------------------------------
// 🔔 THE BELL — dashboard review 2026-10-03 §A8: "🔔 7,030 → nobody reads
// that → count only role-relevant and IMPORTANT notifications".
//
// THE BADGE (GET /api/dashboard/ats/alerts → `important`, built on the
// server from utils/nextAction.js) counts only:
//   · my own actions that are overdue or due today (never Stale backlog, never
//     the whole scope's queues)
//   · approvals waiting on me
//   · unread mentions / assignments addressed to me
//   · system alerts — only for those allowed to see them
// and shows "99+" above 99.
//
// Ordinary notifications are listed under "Messages" and never inflate the
// badge (a small dot says there are unread ones). A login without ATS work
// gets the Messages list only.
// ---------------------------------------------------------------------------
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const cap = (n) => (n > 99 ? '99+' : fmt(n));

function when(d) {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function NotificationBell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const alerts = useAtsAlerts();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('important');
  const wrap = useRef(null);

  useEffect(() => {
    api.get('/admin/notifications')
      .then((res) => setItems(Array.isArray(res.data) ? res.data : []))
      .catch(() => setItems([]));
  }, [pathname]);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const imp = alerts && alerts.important;
  const unread = items.filter((n) => !n.read).length;
  const lines = imp ? imp.lines.filter((l) => l.count > 0) : [];
  const badge = imp ? imp.total : 0;
  const title = imp
    ? `${fmt(badge)} important — ${lines.map((l) => `${l.label} ${fmt(l.count)}`).join(' · ') || 'nothing waiting on you'}${unread ? ` · ${fmt(unread)} unread message${unread === 1 ? '' : 's'}` : ''}`
    : `${fmt(unread)} unread message${unread === 1 ? '' : 's'}`;

  function toggle() {
    if (!open) setTab(imp ? 'important' : 'messages');
    setOpen(!open);
  }
  function go(to) { setOpen(false); navigate(to); }
  async function markRead(n) {
    if (n.read) return;
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    api.patch(`/admin/notifications/${n.id}/read`).catch(() => {});
  }

  return (
    <div className="nbell" ref={wrap}>
      <button type="button" className="rolechip nbell-btn" onClick={toggle} aria-expanded={open} aria-haspopup="dialog" title={title} aria-label={title}>
        {/* Never a bare zero: the bell alone when nothing is waiting. */}
        🔔{imp ? (badge > 0 ? ` ${imp.badge || cap(badge)}` : '') : (unread > 0 ? ` ${cap(unread)}` : '')}
        {imp && unread > 0 && <span className="nbell-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="nbell-pop" role="dialog" aria-label="Notifications">
          {imp && (
            <div className="nbell-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'important'} className={tab === 'important' ? 'on' : ''} onClick={() => setTab('important')}>
                Important{badge > 0 ? ` (${cap(badge)})` : ''}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'messages'} className={tab === 'messages' ? 'on' : ''} onClick={() => setTab('messages')}>
                Messages{unread ? ` (${fmt(unread)} new)` : ''}
              </button>
            </div>
          )}

          {imp && tab === 'important' && (
            <div className="nbell-body">
              {badge === 0 && <div className="nbell-empty">Nothing needs you right now. You&apos;re all caught up 🎉</div>}
              {lines.map((l) => (
                <button key={l.id} type="button" className="nbell-row nbell-row-btn" onClick={() => go(l.to)}>
                  <span className={`nbell-n tone-${l.tone || 'amber'}`}>{fmt(l.count)}</span>
                  <span className="nbell-text">{l.label}{l.sub && <span className="nbell-item-s" style={{ display: 'block' }}>{l.sub}</span>}</span>
                  <span className="nbell-go">Open →</span>
                </button>
              ))}
              {imp.items && imp.items.length > 0 && (
                <div className="nbell-items" style={{ paddingLeft: 14 }}>
                  {imp.items.map((it) => (
                    <div key={it.id} className="nbell-item">
                      <button type="button" className="nbell-item-main" onClick={() => go(`/candidates/${it.candidateId}`)} title="Open the candidate">
                        <span className="nbell-item-t">{it.candidate}</span>
                        <span className="nbell-item-s">
                          <span className={`nbell-n tone-${it.overdue ? 'red' : 'amber'}`} style={{ fontSize: 11, padding: '0 6px', marginRight: 6 }}>{it.overdue ? 'Late' : 'Due today'}</span>
                          {[it.action, it.requirement, it.overdue ? `was due ${it.due}` : null].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(!imp || tab === 'messages') && (
            <div className="nbell-body">
              {items.length === 0 && <div className="nbell-empty">No messages yet.</div>}
              {items.slice(0, 8).map((n) => (
                <div key={n.id} className={`nbell-note${n.read ? '' : ' unread'}`} style={noteLink(n) ? { cursor: 'pointer' } : undefined} onClick={() => { markRead(n); const to = noteLink(n); if (to) go(to); }}>
                  <div className="nbell-note-t">{n.title}</div>
                  {n.message && <div className="nbell-note-m">{splitMeeting(noteText(n.message)).text}</div>}
                  {splitMeeting(n.message).link && <JoinMeeting small href={splitMeeting(n.message).link} />}
                  <div className="nbell-note-d">{when(n.createdAt)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="nbell-foot">
            {imp && tab === 'important'
              ? <Link to="/ats/dashboard" onClick={() => setOpen(false)}>My dashboard →</Link>
              : <Link to="/admin/notifications" onClick={() => setOpen(false)}>All notifications →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
