import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../../api';
import './dashboard.css';

// "Today's tasks" in the top bar (user spec 2026-09-29, common for everyone):
// my follow-ups due today (overdue ones in red), my interviews today, my
// pending actions falling due today, and — for the Accounts desk — invoices
// whose payment falls due today. Each line opens the item.
// GET /api/dashboard/today; read on open and every few minutes.
const REFRESH_MS = 3 * 60 * 1000;
const timeOf = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

export default function TodayTasks() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const load = () => api.get('/dashboard/today').then((r) => setData(r.data)).catch(() => setData(null));
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (open) load(); }, [open]);
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!data) return null;
  const c = data.counts || {};
  const tone = c.followUpsOverdue ? 'red' : data.total ? 'amber' : '';
  const go = (to) => { setOpen(false); navigate(to); };
  const Section = ({ title, items, render, none }) => (
    <>
      <div className="tt-sec">{title} · {items.length}</div>
      {items.length === 0 ? <div className="tt-none">{none}</div> : items.map((x) => (
        <button key={x.id} type="button" className="tt-item" onClick={() => go(x.to)}>
          <span className={`st-chip st-${x.tone}`} style={{ minWidth: 54, justifyContent: 'center' }}>{render.badge(x)}</span>
          <span className="tt-main"><div><b>{render.title(x)}</b></div><div className="tt-s">{render.sub(x)}</div></span>
        </button>
      ))}
    </>
  );
  return (
    <div className="tt" ref={ref}>
      <button type="button" className="tt-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Today's tasks">
        <span aria-hidden="true">🗓️</span> Today <b className={tone ? `t-${tone}` : ''}>{data.total}</b>
      </button>
      {open && (
        <div className="tt-pop" role="dialog" aria-label="Today's tasks">
          <div className="tt-h"><span>Today&apos;s tasks</span><span className="tt-s">{new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}</span></div>
          <Section
            title="My follow-ups due"
            items={data.followUps || []}
            none="No follow-up due today."
            render={{ badge: (x) => (x.tone === 'red' ? 'Overdue' : (x.time || 'Today')), title: (x) => x.candidate, sub: (x) => `${x.what}${x.requirement ? ` · ${x.requirement}` : ''}` }}
          />
          <Section
            title="My interviews today"
            items={data.interviews || []}
            none="No interview today."
            render={{ badge: (x) => timeOf(x.at), title: (x) => x.candidate, sub: (x) => `${x.requirement || ''}${x.round ? ` · round ${x.round}` : ''}` }}
          />
          <Section
            title="My pending actions due today"
            items={data.actions || []}
            none="No action falls due today."
            render={{ badge: () => 'Today', title: (x) => x.candidate, sub: (x) => `${x.what} · ${x.stage}` }}
          />
          {(data.invoices || []).length > 0 && (
            <Section
              title="Payments due today"
              items={data.invoices}
              none=""
              render={{ badge: () => 'Due', title: (x) => `${x.invoiceNumber || 'Invoice'} · ${x.client}`, sub: (x) => `₹${Math.round(x.outstanding).toLocaleString('en-IN')} outstanding` }}
            />
          )}
        </div>
      )}
    </div>
  );
}
