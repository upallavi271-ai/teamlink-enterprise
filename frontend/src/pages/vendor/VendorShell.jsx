import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import vendorApi, { setVendorToken, vendorToken, VENDOR_NOTICE_KEY } from '../../vendorApi';
import { PasswordModal } from './VendorAssets.jsx';
import './vendorPortal.css';
import './vendorPortal2.css';

// The Vendor Portal's page frame (2026-10-09): top bar + four tabs - Bills and
// payments, Documents, Your assets, Your details. No sidebar. Signs the vendor
// out after the server's idle limit; a vendor never reaches anything else.
export default function VendorShell({ title, sub, children }) {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [pwOpen, setPwOpen] = useState(false);
  const [toast, setToast] = useState('');

  const signOut = useCallback(async (notice) => {
    try { await vendorApi.post('/logout'); } catch { /* already out */ }
    setVendorToken(null);
    if (notice) { try { sessionStorage.setItem(VENDOR_NOTICE_KEY, notice); } catch { /* ignore */ } }
    navigate('/vendor-login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!vendorToken()) { navigate('/vendor-login', { replace: true }); return; }
    vendorApi.get('/me').then((r) => {
      if (r.data.mustChangePassword) navigate('/vendor-login', { replace: true });
      else { setMe(r.data); if (r.data.idleMinutes) setIdleMinutes(r.data.idleMinutes); }
    }).catch(() => {});
  }, [navigate]);

  const last = useRef(Date.now());
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    const evs = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last.current > idleMinutes * 60000) signOut(`Your session expired after ${idleMinutes} minutes without activity. Please sign in again.`);
    }, 30000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [signOut, idleMinutes]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  return (
    <div className="vp-page">
      <header className="vp-top">
        <div className="vp-brand"><TeamLinkMark width={104} /><span className="vp-top-title">Vendor Portal</span></div>
        <div className="vp-top-right">
          <span className="vp-top-name" title={me?.email}>{me?.vendorName}{me?.name ? <small> · {me.name}</small> : null}</span>
          <button type="button" className="btn btn-sm" onClick={() => setPwOpen(true)}>Change password</button>
          <button type="button" className="btn btn-sm" onClick={() => signOut()}>Logout</button>
        </div>
      </header>
      <nav className="vp-tabs" aria-label="Vendor Portal">
        <NavLink to="/vendor/invoices" className={({ isActive }) => `vp-tab${isActive ? ' on' : ''}`}>Bills and payments</NavLink>
        <NavLink to="/vendor/documents" className={({ isActive }) => `vp-tab${isActive ? ' on' : ''}`}>Documents</NavLink>
        <NavLink to="/vendor/assets" className={({ isActive }) => `vp-tab${isActive ? ' on' : ''}`}>Your assets</NavLink>
        <NavLink to="/vendor/profile" className={({ isActive }) => `vp-tab${isActive ? ' on' : ''}`}>Your details</NavLink>
      </nav>
      <main className="vp-main">
        <div className="vp-head">
          <h1>{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
        {toast && <div className="notice green" style={{ marginBottom: 10 }}><span>{toast}</span></div>}
        {me ? children : <div className="empty-mini">Loading…</div>}
      </main>
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); setToast('Password changed.'); }} />}
    </div>
  );
}

// A short-lived, signed link for one file (the server checks it is yours, and again when you open it).
export async function openVendorFile(body) {
  const r = await vendorApi.post('/download-link', body);
  window.open(r.data.url, '_blank', 'noopener');
}
