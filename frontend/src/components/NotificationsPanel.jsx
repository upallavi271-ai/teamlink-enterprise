import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import useVisiblePoll from './messaging/useVisiblePoll.js';
import { splitMeeting } from './MeetingLink.jsx';
import { noteTarget, noteText, ago } from '../utils/noteTarget.js';
import './NotificationsPanel.css';

// ---------------------------------------------------------------------------
// NOTIFICATIONS ON THE DASHBOARD AND THE ORGANIZATION CHART (founder 2026-11-18: "all notifications on the dashboard, and a click goes straight to where it
// belongs; the organization chart too"). The person's own latest notifications (the same list as the bell: GET /api/admin/notifications), unread in bold with a
// dot. A click marks it read and opens the screen it is about (utils/noteTarget.js: the "Open: /path" line, an announcement, or what the title is about);
// a notification that leads nowhere in particular opens the full Notifications list. Nothing new is stored. Fresh ones arrive by themselves (every minute,
// only while the page is visible). The panel folds away (and remembers it) so a busy screen can keep it closed.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

export default function NotificationsPanel({ limit = 6, storageKey = 'home', title = 'Notifications' }) {
  const navigate = useNavigate();
  const [items, setItems] = useState(null); // null = loading
  const [err, setErr] = useState('');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(`tl_np_closed_${storageKey}`) !== '1'; } catch { return true; } });

  const load = useCallback(async (signal) => {
    const r = await api.get('/admin/notifications', { signal });
    // the Email lines are the mail log of the same events (one per person); the list shows each event once
    setItems((Array.isArray(r.data) ? r.data : []).filter((n) => (n.channel || 'In-App') !== 'Email'));
    setErr('');
    return true;
  }, []);
  // the first look right away; useVisiblePoll then asks again every minute
  useEffect(() => { load().catch((e) => { setErr(errOf(e, 'Could not load your notifications.')); setItems((cur) => cur || []); }); }, [load]);
  useVisiblePoll(async (signal) => {
    try { return await load(signal); } catch (e) {
      if (e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError')) throw e;
      setErr(errOf(e, 'Could not load your notifications.'));
      throw e;
    }
  }, 60000, { enabled: true, key: `np-${storageKey}` });
  const retry = () => { setErr(''); setItems(null); load().catch((e) => { setErr(errOf(e, 'Could not load your notifications.')); setItems([]); }); };

  const toggle = () => { const next = !open; setOpen(next); try { localStorage.setItem(`tl_np_closed_${storageKey}`, next ? '0' : '1'); } catch { /* not kept */ } };
  const unread = (items || []).filter((n) => !n.read).length;
  const shown = (items || []).slice(0, all ? 20 : limit);

  const go = (n) => {
    if (!n.read) {
      setItems((list) => (list || []).map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      api.patch(`/admin/notifications/${n.id}/read`).catch(() => {});
    }
    const t = noteTarget(n);
    navigate(t ? t.to : '/admin/notifications');
  };
  const readAll = async () => {
    setItems((list) => (list || []).map((x) => ({ ...x, read: true })));
    api.post('/admin/notifications/read-all').catch(() => {});
  };

  return (
    <div className="panel np" aria-label={title}>
      <div className="panel-head np-head">
        <button type="button" className="np-fold" onClick={toggle} aria-expanded={open} aria-label={open ? `Fold away ${title}` : `Show ${title}`}>{open ? '▾' : '▸'}</button>
        <h3>{`🔔 ${title}`}</h3>
        {unread > 0 && <span className="np-count" aria-label={`${unread} unread`}>{`${unread} new`}</span>}
        <span className="np-right">
          {open && unread > 0 && <button type="button" className="link-btn np-linkbtn" onClick={readAll}>Mark all read</button>}
          <Link className="link-btn np-linkbtn" to="/admin/notifications">All notifications ›</Link>
        </span>
      </div>
      {open && (
        <>
          {err && !items && <div className="np-note" role="alert">{err} <button type="button" className="btn btn-sm" onClick={retry}>Try again</button></div>}
          {err && items && items.length === 0 && <div className="np-note" role="alert">{err} <button type="button" className="btn btn-sm" onClick={retry}>Try again</button></div>}
          {!items && !err && <div className="np-skel" aria-busy="true"><span /><span /><span /></div>}
          {items && items.length === 0 && !err && <div className="empty-mini">No notifications yet. They show here when something needs you.</div>}
          {shown.length > 0 && (
            <ul className="np-list">
              {shown.map((n) => {
                const t = noteTarget(n);
                const text = splitMeeting(noteText(n.message)).text;
                return (
                  <li key={n.id}>
                    <button type="button" className={`np-row${n.read ? '' : ' unread'}`} onClick={() => go(n)} title={t ? t.label : 'Open all notifications'}>
                      <span className="np-dot" aria-hidden="true" />
                      <span className="np-main">
                        <span className="np-title">{n.title}</span>
                        {text && <span className="np-text">{text}</span>}
                      </span>
                      <span className="np-side">
                        <span className="np-when">{ago(n.createdAt)}</span>
                        <span className="np-go">{t ? `${t.label} ›` : 'See all ›'}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {items && items.length > limit && (
            <div className="np-more"><button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show more (${Math.min(20, items.length) - limit} more)`}</button></div>
          )}
        </>
      )}
    </div>
  );
}
