import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import ListFilterBar, { useListFilters, ListEmpty } from '../../components/ui/ListFilters.jsx';
import Pager, { PAGE_SIZES } from '../../components/Pager.jsx';

// Notifications — the prototype's notificationsView() (line 10575): a central
// event log across Email / WhatsApp / SMS / In-App, five columns wide.
//
// Main-only behaviour kept: these are real per-user notifications pushed from
// the ATS pipeline and the client agreement flow (backend/src/utils/notify.js),
// so opening the screen marks them read — which is what the prototype does too
// — and the unread count in the header clears with it.
//
// PAGED + FILTERED ON THE SERVER: GET /admin/notifications?page=… (the paged
// mode of that route; the header bell keeps the plain latest-30 array). Only
// the signed-in person's own notifications, whatever the filters say.

// The password-changed alert ends with "Open: /admin/users?block=<id>": hidden from the text, shown as a button.
const OPEN_TAIL = new RegExp(String.raw`\nOpen: (/[^\s]+)\s*$`);
const noteText = (m) => String(m || '').replace(OPEN_TAIL, '');
const blockPath = (m) => { const p = (String(m || '').match(OPEN_TAIL) || [])[1]; return p && p.startsWith('/admin/users?block=') ? p : null; };

export default function Notifications() {
  const [notifications, setNotifications] = useState([]);
  const [total, setTotal] = useState(0);
  const [channels, setChannels] = useState([]);
  const [mail, setMail] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZES[0]);
  const markedRead = useRef(false);

  const lf = useListFilters(notifications, [
    { key: 'q', type: 'search', placeholder: 'Search event, message or recipient…' },
    { key: 'channel', label: 'Channel', allLabel: 'All channels', options: channels, primary: true },
    { key: 'date', type: 'daterange', label: 'Date range', primary: true },
  ], { server: true });

  useEffect(() => { setPage(1); }, [lf.paramsKey, size]);

  useEffect(() => {
    let cancelled = false;
    const { dateFrom, dateTo, ...rest } = lf.params;
    const params = { ...rest, page, pageSize: size };
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    api.get('/admin/notifications', { params }).then(async (res) => {
      if (cancelled) return;
      setNotifications(res.data.rows || []);
      setTotal(res.data.total || 0);
      if (res.data.channels) setChannels(res.data.channels);
      if (res.data.mail !== undefined) setMail(res.data.mail);
      setLoaded(true);
      // Opening the central log marks everything read, as the prototype does
      // — once per visit, not on every filter change.
      if (!markedRead.current && res.data.unread > 0) {
        markedRead.current = true;
        await api.post('/admin/notifications/read-all').catch(() => {});
      }
    }).catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [lf.paramsKey, page, size]);

  const pages = Math.max(1, Math.ceil(total / size));
  const pager = {
    total, pages, size, setSize, page: Math.min(page, pages), setPage,
    from: total === 0 ? 0 : (page - 1) * size + 1,
    to: Math.min(page * size, total),
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Notifications</h1>
          <div className="page-sub">Central event log across Email / WhatsApp / SMS / In-App</div></div>
      </div>

      {/* What really happens to email (was a fixed "Demo / Simulated" line, 2026-10-30) */}
      {mail && mail.emailsOn && mail.configured && (
        <div className="notice">Notification emails are ON: each note in the Email channel is sent to the person&apos;s email.</div>
      )}
      {mail && !mail.configured && (
        <div className="notice red">Mail is not set up, so no email can go out. <Link to="/admin/integrations">Set up Email in Integrations</Link>.</div>
      )}
      {mail && mail.configured && !mail.emailsOn && (
        <div className="notice amber">
          Notification emails are OFF, so the Email lines below say &quot;Not sent&quot;. Turn them on in <Link to="/attendance">Attendance</Link> → Who gets told, and how → Turn notification emails ON.
        </div>
      )}

      <ListFilterBar lf={lf} storageKey="admin-notifications" />

      <div className="tbl-wrap tbl-fit">
        <table>
          <thead><tr><th>Recipient</th><th>Channel</th><th>Event</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            {notifications.map((n) => (
              <tr key={n.id}>
                <td>{n.recipient || '—'}</td>
                <td>{n.channel || 'In-App'}</td>
                <td>{n.title}{n.message ? <div className="small-muted" style={{ fontSize: 11.5 }}>{noteText(n.message)}</div> : null}
                  {blockPath(n.message) && <Link className="btn btn-sm" style={{ marginTop: 4 }} to={blockPath(n.message)}>Block this login</Link>}</td>
                <td><span className={'status ' + (/^(failed|not sent)/i.test(n.status || '') ? 'failed' : /^(sent|delivered|read)/i.test(n.status || '') ? 'active' : 'pending')}>{n.status || 'Delivered'}</span></td>
                <td>{new Date(n.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {!loaded && (
              <tr><td colSpan="5" className="small-muted" style={{ padding: 16 }}>Loading…</td></tr>
            )}
            {loaded && notifications.length === 0 && (
              <tr><td colSpan="5"><ListEmpty lf={lf} noun="notifications" /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={pager} noun="notifications" />
    </div>
  );
}
