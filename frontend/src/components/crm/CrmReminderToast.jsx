import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api';

// A CRM follow-up that has come due shows on screen on any page (founder 2026-11-06: "bell icon + toast"). It is the same note as in the bell; Open or x hides it here.
// A login that does not use the CRM gets a 403 once and stops asking. Mounted once, in the app shell.
const POLL_MS = 30000; // 30 s: a customer's Accept / Decline should show soon after it is pressed
const SEEN = 'tl_crm_toasts';
const readSeen = () => { try { return JSON.parse(sessionStorage.getItem(SEEN) || '[]'); } catch { return []; } };

export default function CrmReminderToast() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const stop = useRef(false);
  useEffect(() => {
    let live = true;
    const check = () => {
      if (stop.current || document.hidden) return;
      api.get('/crm/reminders/live').then((r) => {
        if (!live) return;
        const seen = readSeen();
        const fresh = (r.data.reminders || []).filter((x) => !seen.includes(x.id));
        if (fresh.length) {
          try { sessionStorage.setItem(SEEN, JSON.stringify([...seen, ...fresh.map((x) => x.id)].slice(-50))); } catch { /* it shows again at the next check */ }
          setItems((list) => [...fresh, ...list].slice(0, 3));
        }
      }).catch((e) => { if (e.response && e.response.status === 403) stop.current = true; });
    };
    check();
    const t = setInterval(check, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!items.length) return null;
  const hide = (id) => setItems((l) => l.filter((x) => x.id !== id));
  const pathOf = (m) => (String(m || '').match(/Open: (\/\S+)/) || [])[1];
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1100, display: 'flex', flexDirection: 'column', gap: 8, width: 320, maxWidth: 'calc(100vw - 32px)' }} role="status" aria-live="polite">
      {items.map((x) => (
        <div key={x.id} className="card" style={{ padding: 12, boxShadow: '0 6px 24px rgba(0,0,0,.18)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <b style={{ flex: 1, fontSize: 13.5 }}>{x.title}</b>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="Hide" onClick={() => hide(x.id)}>×</button>
          </div>
          <div className="small-muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>{String(x.message || '').split('\n')[0]}</div>
          {pathOf(x.message) && <button type="button" className="btn btn-sm btn-primary" onClick={() => { hide(x.id); navigate(pathOf(x.message)); }}>Open</button>}
        </div>
      ))}
    </div>
  );
}
