import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';
import { can, workRoleLabel } from '../permissions';
import { groupsForUser, isExternalUser } from '../nav';
import useAtsAlerts from '../utils/useAtsAlerts';
import { noteLink, noteText } from '../components/NotificationBell.jsx';
import { CheckInPanel } from './attendance/MyAttendance.jsx';
import PhoneAlerts from '../components/PhoneAlerts.jsx';
import './mobile-home.css';

// ---------------------------------------------------------------------------
// MOBILE HOME (2026-11-17): the screen the TeamLink app opens on, on a phone.
//
// It adds no feature of its own. Every block is the same thing the full app already has, in one thumb-friendly column:
//   1. Check in / out     the very same panel as Attendance -> My Attendance (live face + location, one punch per tap)
//   2. Needs you          what the 🔔 bell's "Important" list counts: your overdue / due-today follow-ups, approvals waiting on you,
//                         mentions and alerts, each one tap away
//   3. Latest messages    the bell's messages; a tap opens the screen the message is about
//   4. TeamLink on this phone    install the app, switch phone alerts on or off
//   5. Open a section     every screen THIS login may open (the same permission-filtered menu as the sidebar), as big tiles
// A client or candidate login has none of this: it goes to its own portal.
// ---------------------------------------------------------------------------
const hello = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const when = (d) => {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const firstTo = (item) => (item.children && item.children.length ? item.children[0].to : item.to);

export default function MobileHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const alerts = useAtsAlerts();
  const [notes, setNotes] = useState(null);
  const groups = useMemo(() => groupsForUser(user), [user]);

  useEffect(() => {
    let alive = true;
    api.get('/admin/notifications')
      .then((r) => { if (alive) setNotes(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setNotes([]); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (hash !== '#checkin') return undefined;
    const t = setTimeout(() => { const el = document.getElementById('checkin'); if (el) el.scrollIntoView({ block: 'start' }); }, 250);
    return () => clearTimeout(t);
  }, [hash]);

  if (!user) return null;
  if (isExternalUser(user)) return <Navigate to="/" replace />;

  const imp = alerts && alerts.important;
  const lines = imp ? imp.lines.filter((l) => l.count > 0) : [];
  const items = imp && imp.items ? imp.items.slice(0, 6) : [];
  const unread = (notes || []).filter((n) => !n.read);
  const showCheckIn = can(user, 'hrms', 'hrms', 'Attendance & Time', 'view');
  const first = String(user.name || '').trim().split(/\s+/)[0] || '';

  function open(n) {
    if (!n.read) {
      setNotes((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      api.patch(`/admin/notifications/${n.id}/read`).catch(() => {});
    }
    const to = noteLink(n);
    if (to) navigate(to); else navigate('/admin/notifications');
  }

  return (
    <div className="mh">
      <header className="mh-hello">
        <h2>{hello()}{first ? `, ${first}` : ''}</h2>
        <div className="mh-sub">
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          {workRoleLabel(user) ? ` · ${workRoleLabel(user)}` : ''}
        </div>
      </header>

      {showCheckIn && (
        <section className="mh-flat" id="checkin" aria-label="Check in or out">
          <CheckInPanel />
        </section>
      )}

      <section className="mh-card" aria-label="Needs you">
        <h3>Needs you now</h3>
        {imp ? (
          <>
            {lines.length === 0 && <div className="mh-empty">Nothing needs you right now. You are all caught up 🎉</div>}
            {lines.map((l) => (
              <button key={l.id} type="button" className="mh-row" onClick={() => navigate(l.to)}>
                <span className={`mh-n tone-${l.tone || 'amber'}`}>{fmt(l.count)}</span>
                <span className="mh-t">{l.label}{l.sub && <small>{l.sub}</small>}</span>
                <span className="mh-go" aria-hidden="true">›</span>
              </button>
            ))}
            {items.length > 0 && <div className="mh-h">Follow-ups to do</div>}
            {items.map((it) => (
              <button key={it.id} type="button" className="mh-row" onClick={() => navigate(`/candidates/${it.candidateId}`)}>
                <span className={`mh-n tone-${it.overdue ? 'red' : 'amber'}`} style={{ fontSize: 11 }}>{it.overdue ? 'Late' : 'Today'}</span>
                <span className="mh-t">{it.candidate}<small>{[it.action, it.requirement].filter(Boolean).join(' · ')}</small></span>
                <span className="mh-go" aria-hidden="true">›</span>
              </button>
            ))}
          </>
        ) : (
          <button type="button" className="mh-row" onClick={() => navigate('/admin/notifications')}>
            <span className={`mh-n tone-${unread.length ? 'amber' : 'green'}`}>{notes === null ? '…' : fmt(unread.length)}</span>
            <span className="mh-t">{notes === null ? 'Checking messages…' : unread.length ? 'Unread messages' : 'No unread messages'}</span>
            <span className="mh-go" aria-hidden="true">›</span>
          </button>
        )}
      </section>

      <section className="mh-card" aria-label="Latest messages">
        <h3>Latest messages</h3>
        {notes === null && <div className="mh-empty">Loading…</div>}
        {notes && notes.length === 0 && <div className="mh-empty">No messages yet.</div>}
        {(notes || []).slice(0, 5).map((n) => (
          <button key={n.id} type="button" className={`mh-note${n.read ? '' : ' unread'}`} onClick={() => open(n)}>
            <span className="mh-note-t">{n.title}</span>
            {n.message && <span className="mh-note-m">{noteText(n.message)}</span>}
            <span className="mh-note-d">{when(n.createdAt)}</span>
          </button>
        ))}
        {notes && notes.length > 0 && <Link className="mh-more" to="/admin/notifications">All notifications ›</Link>}
      </section>

      <PhoneAlerts />

      <section className="mh-card" aria-label="Open a section">
        <h3>Open a section</h3>
        {groups.map(([s, label, list, icon], i) => (
          <details key={s} className="mh-group" open={i < 2}>
            <summary><span aria-hidden="true">{icon}</span> {label}</summary>
            <div className="mh-tiles">
              {list.map((item) => (
                <Link key={item.id || item.to} className="mh-tile" to={firstTo(item)}>
                  <span className="mh-ico" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
