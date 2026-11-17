import { useEffect, useRef, useState } from 'react';
import api from '../api';
import { useAuth } from '../context/AuthContext.jsx';

// COMPANY SWITCHER (utils/companyBridge.js on the server; docs/second-company.md section 9).
//   * On TeamLink, a Super Admin sees "Companies": each company that was set up opens in a NEW tab, signed in, with no second password.
//     With nothing set up the server answers an empty list and this renders nothing at all.
//   * Inside a company nothing is shown here (founder 2026-11-17: no "Back to TeamLink" link in the company's screens; the company was opened in its OWN tab,
//     so closing that tab is the way back).
// The tab is opened first (a browser only allows a new tab straight after a click) and sent to the company when the server has signed the pass.
export default function CompanySwitcher() {
  const { user } = useAuth();
  const [companies, setCompanies] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const box = useRef(null);
  const isSuper = !!user && user.role === 'SUPER_ADMIN' && !user.hrSuper && !user.viewAs;

  useEffect(() => {
    if (!isSuper) return undefined;
    let live = true;
    api.get('/company-bridge/companies').then((r) => { if (live) setCompanies((r.data && r.data.companies) || []); }).catch(() => {});
    return () => { live = false; };
  }, [isSuper]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!isSuper) return null;

  // a company's own copy has no companies to open (the server answers an empty list): nothing is drawn
  if (!companies.length) return null;

  async function pick(c) {
    setErr(''); setBusy(c.key);
    const tab = window.open('', '_blank');
    try {
      const r = await api.post(`/company-bridge/open/${encodeURIComponent(c.key)}`);
      if (tab) { tab.opener = null; tab.location.href = r.data.url; } else { window.location.href = r.data.url; }
      setOpen(false);
    } catch (e) {
      if (tab) tab.close();
      setErr((e.response && e.response.data && e.response.data.error) || 'Could not open that company. Please try again.');
    } finally { setBusy(''); }
  }

  return (
    <div ref={box} style={{ position: 'relative' }} data-testid="company-switcher">
      <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen((v) => !v); setErr(''); }}>
        Companies ▾
      </button>
      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: '110%', zIndex: 60, minWidth: 260, background: '#fff', border: '1px solid #d9dee7', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.18)', padding: 6 }}>
          <div className="small-muted" style={{ padding: '4px 10px' }}>Open another company (new tab)</div>
          {companies.map((c) => (
            <button key={c.key} type="button" role="menuitem" className="btn btn-ghost btn-sm" disabled={!!busy}
              style={{ display: 'block', width: '100%', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => pick(c)}>
              {busy === c.key ? 'Opening…' : c.name}
            </button>
          ))}
          {err && <div className="error-text" style={{ padding: '6px 10px' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
