import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../../api';
import Modal from '../Modal.jsx';
import { ago } from '../../utils/noteTarget.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { hasAtsWork } from '../../utils/useAtsAlerts';
import './updatesCentre.css';

// ---------------------------------------------------------------------------
// THE DASHBOARD "UPDATES & REPORTS" CENTRE (founder 2026-11-23: "every report and every notification must be displayed on
// the dashboard"; "if anyone has interviews, it must pop up on the dashboard").
//   Your interviews today   time · candidate · requirement (client) · mode / link / venue (GET /api/ats-updates/interviews-today)
//   Updates & reports       every notification of this person + the day's reports, newest first, with the unread count per
//                           type; a row opens its record; "See all" opens the full view (type, from / to, read / unread,
//                           mark read, mark all read). GET /api/ats-updates/feed - the person's own rows only.
// No sidebar item: the full view is a window over the dashboard (?updates=1 opens it, the pop-up stack's "See all" uses it).
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const PREVIEW = 6;

async function download(path) {
  const r = await api.get(path, { responseType: 'blob' });
  const cd = String(r.headers['content-disposition'] || '');
  const name = (cd.match(/filename="?([^";]+)"?/) || [])[1] || 'report.xlsx';
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function Row({ i, onOpen, onRead }) {
  return (
    <li className={`uc-row${i.read ? '' : ' unread'}`}>
      <button type="button" className="uc-main" onClick={() => onOpen(i)} title={i.open ? 'Open' : 'Mark read'}>
        <span className="uc-dot" aria-hidden="true" />
        <span className="uc-body">
          <span className="uc-title">{i.title}</span>
          {i.text && <span className="uc-text">{i.text}</span>}
        </span>
        <span className="uc-side">
          <span className={`uc-kind k-${i.kind}`}>{i.subLabel || i.kindLabel}</span>
          <span className="uc-when">{ago(i.at)}</span>
        </span>
      </button>
      <span className="uc-acts">
        {i.download && <button type="button" className="link-btn" onClick={() => download(i.download).catch(() => {})}>Download</button>}
        {!i.read && <button type="button" className="link-btn" onClick={() => onRead(i)}>Mark read</button>}
      </span>
    </li>
  );
}

function useFeed(params, enabled) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const key = JSON.stringify(params);
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve();
    return api.get('/ats-updates/feed', { params: JSON.parse(key) }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load your updates.')));
  }, [key, enabled]);
  useEffect(() => { load(); }, [load]);
  return { d, err, load, setD };
}

export default function UpdatesCentre() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const on = hasAtsWork(user);
  const [today, setToday] = useState(null);
  const [full, setFull] = useState(false);
  const { d, err, load, setD } = useFeed({ limit: PREVIEW }, on);

  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    api.get('/ats-updates/interviews-today').then((r) => { if (live) setToday(r.data); }).catch(() => {});
    const t = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => { live = false; clearInterval(t); };
  }, [on, load]);
  useEffect(() => { if (sp.get('updates') === '1') setFull(true); }, [sp]);
  if (!on) return null;

  const kinds = (d && d.kinds) || {};
  const label = (i) => ({ ...i, kindLabel: kinds[i.kind] || i.kind });
  const read = async (ids) => {
    setD((cur) => (cur ? { ...cur, rows: cur.rows.map((r) => (ids.includes(r.id) ? { ...r, read: true } : r)) } : cur));
    await api.post('/ats-updates/read', { ids }).catch(() => {});
    load();
  };
  const open = (i) => {
    if (!i.read) read([i.id]);
    if (i.open) navigate(i.open);
  };
  const closeFull = () => {
    setFull(false);
    if (sp.get('updates')) { const n = new URLSearchParams(sp); n.delete('updates'); setSp(n, { replace: true }); }
    load();
  };
  const items = (today && today.items) || [];

  return (
    <section className="card uc" aria-label="Updates and reports">
      {items.length > 0 && (
        <div className="uc-today">
          <div className="uc-head"><h3>{`📅 Your interviews today (${items.length})`}</h3><button type="button" className="link-btn" onClick={() => navigate('/ats/calendar')}>Interview calendar ›</button></div>
          <ul className="uc-ivs">
            {items.map((i) => (
              <li key={i.applicationId} className={i.past ? 'past' : ''}>
                <b className="uc-time">{i.time}</b>
                <span className="uc-ivmain">
                  <button type="button" className="link-btn" onClick={() => navigate(`/candidates/${i.candidateId}?app=${i.applicationId}`)}>{i.candidate}</button>
                  {` · ${i.job}${i.client ? ` (${i.client})` : ''} · Round ${i.round}`}
                </span>
                <span className="uc-ivwhere">
                  {i.mode}
                  {i.venue ? ` · ${i.venue}` : ''}
                  {i.link && <a href={i.link} target="_blank" rel="noreferrer" className="uc-join">Join</a>}
                  {i.noLink && <span className="uc-warn"> · no link yet</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="uc-head">
        <h3>{`🔔 Updates & reports${d && d.unread ? ` · ${d.unread} new` : ''}`}</h3>
        <span className="uc-right">
          {d && d.unread > 0 && <button type="button" className="link-btn" onClick={async () => { await api.post('/ats-updates/read-all', {}).catch(() => {}); load(); }}>Mark all read</button>}
          <button type="button" className="btn btn-sm" onClick={() => setFull(true)}>See all</button>
        </span>
      </div>
      {d && (
        <div className="uc-counts">
          {Object.entries(d.counts || {}).filter(([, c]) => c.total > 0).map(([k, c]) => (
            <button key={k} type="button" className={`uc-count k-${k}${c.unread ? ' has' : ''}`} onClick={() => { setFull(k); }}>
              {c.label}
              <b>{c.unread || 0}</b>
            </button>
          ))}
        </div>
      )}
      {err && <div className="small-muted" role="alert">{err} <button type="button" className="link-btn" onClick={load}>Try again</button></div>}
      {!d && !err && <div className="small-muted">Loading your updates…</div>}
      {d && d.rows.length === 0 && <div className="small-muted">Nothing yet. Client updates, interviews, alerts and reports show here.</div>}
      {d && d.rows.length > 0 && <ul className="uc-list">{d.rows.map((i) => <Row key={i.id} i={label(i)} onOpen={open} onRead={(x) => read([x.id])} />)}</ul>}
      {full && <FullView initialType={typeof full === 'string' ? full : ''} kinds={kinds} onClose={closeFull} onOpen={(i) => { closeFull(); open(i); }} />}
    </section>
  );
}

function FullView({ initialType, kinds, onClose, onOpen }) {
  const [f, setF] = useState({ type: initialType || '', from: '', to: '', read: '' });
  const [limit, setLimit] = useState(50);
  const { d, err, load } = useFeed({ ...f, limit }, true);
  const read = async (ids) => { await api.post('/ats-updates/read', { ids }).catch(() => {}); load(); };
  const readAll = async () => { await api.post('/ats-updates/read-all', { type: f.type, from: f.from, to: f.to }).catch(() => {}); load(); };
  const set = (patch) => { setF({ ...f, ...patch }); setLimit(50); };
  return (
    <Modal title="Updates & reports" size="xwide" onClose={onClose} note={d ? `${d.total} shown · ${d.unread} unread in all` : ''}>
      <div className="uc-filters">
        <label>Type
          <select value={f.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">Everything</option>
            {Object.entries(kinds).map(([k, l]) => <option key={k} value={k}>{`${l}${d && d.counts[k] ? ` (${d.counts[k].unread} new)` : ''}`}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label>To<input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
        <label>Show
          <select value={f.read} onChange={(e) => set({ read: e.target.value })}>
            <option value="">Read and unread</option>
            <option value="unread">Unread only</option>
            <option value="read">Read only</option>
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={readAll}>Mark all read</button>
      </div>
      {err && <div className="notice red">{err}</div>}
      {!d && !err && <div className="small-muted">Loading…</div>}
      {d && d.rows.length === 0 && <div className="small-muted" style={{ padding: 12 }}>Nothing matches these filters.</div>}
      {d && d.rows.length > 0 && <ul className="uc-list uc-full">{d.rows.map((i) => <Row key={i.id} i={{ ...i, kindLabel: kinds[i.kind] || i.kind }} onOpen={onOpen} onRead={(x) => read([x.id])} />)}</ul>}
      {d && d.total > d.rows.length && <div style={{ padding: 10 }}><button type="button" className="btn btn-sm" onClick={() => setLimit(limit + 50)}>Show more</button></div>}
    </Modal>
  );
}
