import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../api';
import useAtsAlerts from '../utils/useAtsAlerts';
import './NotificationBell.css';

// ---------------------------------------------------------------------------
// 🔔 THE BELL — review #3 §26 (on top of §33 / review #2 §18).
//
//   "16 Notifications — Candidate Review 5 · Interview Feedback 3 ·
//    Client Decision 2 · Follow-up Due 4 · Joining Confirmation 2"
//
// COUNTS: GET /api/dashboard/ats/alerts — the reader's own pending-action
// queues, inside their scope, counted live (the same queues and the same scope
// as the ATS dashboard's Pending Actions, so the bell's queue total equals the
// dashboard's). The server's queue ids fold into the user's five groups:
//
//   Candidate Review      candidate-review + tl-review + bde-review
//   Interview Feedback    interview-feedback
//   Client Decision       client-decision
//   Follow-up Due         followups-overdue
//   Joining Confirmation  joining-confirmation
//   (Interview Scheduling schedule-interview + interview-confirm — shown only
//    when something is waiting there)
//
// ITEMS: opening a group lists the waiting items themselves, each opening the
// EXACT candidate (/candidates/:id — Candidate 360 with the application, its
// interview and its requirement) or, via the requirement link, the exact
// requirement. Read on demand from the dashboard's own Pending Actions rows
// (GET /api/dashboard/ats?take=100 — one row per waiting application, with the
// stage's next action from atsVocab NEXT_ACTION_BY_STAGE) and, for follow-ups,
// GET /api/followups/dashboard. "View all →" opens the filtered list.
//
// The ordinary notifications keep their own tab.
// ---------------------------------------------------------------------------
const GROUPS = [
  { id: 'review', label: 'Candidate Review', queues: ['candidate-review', 'tl-review', 'bde-review'], tone: 'amber' },
  { id: 'feedback', label: 'Interview Feedback', queues: ['interview-feedback'], tone: 'amber' },
  { id: 'client', label: 'Client Decision', queues: ['client-decision'], tone: 'amber' },
  { id: 'followup', label: 'Follow-up Due', queues: ['followups-overdue'], tone: 'red' },
  { id: 'joining', label: 'Joining Confirmation', queues: ['joining-confirmation'], tone: 'amber' },
  { id: 'schedule', label: 'Interview Scheduling', queues: ['schedule-interview', 'interview-confirm'], tone: 'blue', optional: true },
];
const ITEM_LIMIT = 8;

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');

function when(d) {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Fold the server's queue lines into the five groups.
export function bellGroups(alerts) {
  const lines = (alerts && alerts.groups) || [];
  return GROUPS.map((g) => {
    const parts = lines.filter((l) => g.queues.includes(l.id));
    const count = parts.reduce((n, l) => n + (l.count || 0), 0);
    const main = parts.find((l) => l.count > 0) || parts[0];
    return { ...g, count, to: main ? main.to : '/ats/dashboard#pending', present: parts.length > 0 };
  }).filter((g) => g.present && (!g.optional || g.count > 0));
}

export default function NotificationBell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const alerts = useAtsAlerts();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('actions');
  const [expanded, setExpanded] = useState(null);
  const [rows, setRows] = useState(null);        // { queueId: [row] } from /dashboard/ats
  const [followRows, setFollowRows] = useState(null);
  const [rowsError, setRowsError] = useState('');
  const wrap = useRef(null);

  useEffect(() => {
    api.get('/admin/notifications')
      .then((res) => setItems(Array.isArray(res.data) ? res.data : []))
      .catch(() => setItems([]));
  }, [pathname]);

  // Close on navigation, outside click and Escape. Item lists are re-read on
  // the next open (an action on one screen shows on the next).
  useEffect(() => { setOpen(false); setExpanded(null); setRows(null); setFollowRows(null); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const unread = items.filter((n) => !n.read).length;
  const hasActions = !!alerts;
  const groups = bellGroups(alerts);
  const actionTotal = groups.reduce((n, g) => n + g.count, 0);

  function toggle() {
    if (!open) setTab(hasActions ? 'actions' : 'notes');
    setOpen(!open);
  }

  function loadItems(g) {
    setRowsError('');
    if (g.id === 'followup') {
      if (followRows) return;
      api.get('/followups/dashboard')
        .then((res) => setFollowRows(((res.data && res.data.mine && res.data.mine.rows) || [])
          .filter((f) => f.status === 'Overdue' || f.status === 'Due Today')))
        .catch((e) => { setFollowRows([]); setRowsError(e.response?.data?.error || 'Could not load the items.'); });
      return;
    }
    if (rows) return;
    api.get('/dashboard/ats', { params: { take: 100 } })
      .then((res) => {
        const by = {};
        ((res.data && res.data.queue) || []).forEach((r) => { (by[r.queueId] = by[r.queueId] || []).push(r); });
        setRows(by);
      })
      .catch((e) => { setRows({}); setRowsError(e.response?.data?.error || 'Could not load the items.'); });
  }

  function expand(g) {
    if (expanded === g.id) { setExpanded(null); return; }
    setExpanded(g.id);
    if (g.count > 0) loadItems(g);
  }

  function go(to) { setOpen(false); navigate(to); }

  async function markRead(n) {
    if (n.read) return;
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    api.patch(`/admin/notifications/${n.id}/read`).catch(() => {});
  }

  function itemsOf(g) {
    if (g.id === 'followup') {
      if (!followRows) return null;
      return followRows.slice(0, ITEM_LIMIT).map((f) => ({
        key: f.followUpId || f.applicationId,
        title: f.candidateName || 'Candidate',
        sub: [f.nextAction, f.status === 'Overdue' ? `Overdue · due ${f.dueDate || '—'}` : 'Due today'].filter(Boolean).join(' · '),
        to: `/candidates/${f.candidateId}`,
        reqTo: f.requirementId ? `/requirements/${f.requirementId}` : null,
      }));
    }
    if (!rows) return null;
    return g.queues.flatMap((q) => rows[q] || []).slice(0, ITEM_LIMIT).map((r) => ({
      key: r.id,
      title: r.candidate,
      sub: [r.actionLabel || r.nextAction, r.requirement, r.overdue ? 'Overdue' : (r.due ? `due ${r.due}` : null)].filter(Boolean).join(' · '),
      to: r.to || `/candidates/${r.candidateId}`,
      reqTo: r.requirementId ? `/requirements/${r.requirementId}` : null,
    }));
  }

  const summary = groups.filter((g) => !g.optional || g.count > 0).map((g) => `${g.label} ${fmt(g.count)}`).join(' · ');
  const title = hasActions
    ? `${fmt(actionTotal)} Notifications — ${summary}${unread ? ` · ${fmt(unread)} unread message${unread === 1 ? '' : 's'}` : ''}`
    : `${fmt(unread)} unread notification${unread === 1 ? '' : 's'}`;
  const badge = hasActions ? actionTotal : unread;

  return (
    <div className="nbell" ref={wrap}>
      <button type="button" className="rolechip nbell-btn" onClick={toggle} aria-expanded={open} aria-haspopup="dialog" title={title} aria-label={title}>
        🔔 {fmt(badge)}
        {hasActions && unread > 0 && <span className="nbell-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="nbell-pop" role="dialog" aria-label="Notifications">
          {hasActions && (
            <div className="nbell-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'actions'} className={tab === 'actions' ? 'on' : ''} onClick={() => setTab('actions')}>
                Actions ({fmt(actionTotal)})
              </button>
              <button type="button" role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
                Messages{unread ? ` (${fmt(unread)} new)` : ''}
              </button>
            </div>
          )}

          {hasActions && tab === 'actions' && (
            <div className="nbell-body">
              <div className="nbell-head">
                <b>{fmt(actionTotal)} Notification{actionTotal === 1 ? '' : 's'}</b>
                {summary && <span className="nbell-head-s"> — {summary}</span>}
              </div>
              <div className="nbell-scope">Waiting in {alerts.scope || 'your scope'}</div>
              {actionTotal === 0 && <div className="nbell-empty">No pending actions 🎉 You&apos;re all caught up.</div>}
              {groups.map((g) => {
                const open1 = expanded === g.id;
                const list = open1 ? itemsOf(g) : null;
                return (
                  <div key={g.id} className={`nbell-grp${open1 ? ' open' : ''}`}>
                    <button type="button" className="nbell-row nbell-row-btn" onClick={() => expand(g)} aria-expanded={open1}>
                      <span className={`nbell-n tone-${g.count ? g.tone : 'zero'}`}>{fmt(g.count)}</span>
                      <span className="nbell-text">{g.label}</span>
                      <span className="nbell-chev" aria-hidden="true">{open1 ? '▾' : '▸'}</span>
                    </button>
                    {open1 && (
                      <div className="nbell-items">
                        {g.count === 0 && <div className="nbell-item-note">Nothing waiting here.</div>}
                        {g.count > 0 && list === null && <div className="nbell-item-note">Loading…</div>}
                        {g.count > 0 && list && list.length === 0 && (
                          <div className="nbell-item-note">{rowsError || 'The items are on the list behind this count.'}</div>
                        )}
                        {list && list.map((it) => (
                          <div key={it.key} className="nbell-item">
                            <button type="button" className="nbell-item-main" onClick={() => go(it.to)} title="Open the candidate">
                              <span className="nbell-item-t">{it.title}</span>
                              <span className="nbell-item-s">{it.sub}</span>
                            </button>
                            {it.reqTo && (
                              <button type="button" className="nbell-item-req" onClick={() => go(it.reqTo)} title="Open the requirement">Req →</button>
                            )}
                          </div>
                        ))}
                        {g.count > 0 && (
                          <button type="button" className="nbell-item-all" onClick={() => go(g.to)}>View all {fmt(g.count)} →</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {(!hasActions || tab === 'notes') && (
            <div className="nbell-body">
              {items.length === 0 && <div className="nbell-empty">No notifications yet.</div>}
              {items.slice(0, 8).map((n) => (
                <div key={n.id} className={`nbell-note${n.read ? '' : ' unread'}`} onClick={() => markRead(n)}>
                  <div className="nbell-note-t">{n.title}</div>
                  {n.message && <div className="nbell-note-m">{n.message}</div>}
                  <div className="nbell-note-d">{when(n.createdAt)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="nbell-foot">
            {hasActions && tab === 'actions'
              ? <Link to="/ats/dashboard#pending" onClick={() => setOpen(false)}>{(alerts.my && alerts.my.title) || 'Pending Actions'} →</Link>
              : <Link to="/admin/notifications" onClick={() => setOpen(false)}>All notifications →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
