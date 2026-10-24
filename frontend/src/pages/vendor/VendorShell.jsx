import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import vendorApi, { setVendorToken, vendorToken, VENDOR_NOTICE_KEY } from '../../vendorApi';
import { PasswordModal } from './VendorAssets.jsx';
import { VENDOR_NAV, ASSET_NAV, SIDEBAR_KINDS, FINANCE_SIDEBAR, routeAllowedFor } from './vendorNav.js';
import VendorSidebar, { useSidebarMode } from './VendorSidebar.jsx';
import IdCardBell from './IdCardBell.jsx';
import './vendorPortal.css';
import './vendorPortal2.css';

// The Vendor Portal's page frame: a left sidebar with EXACTLY FOUR modules - Dashboard, Bills & Invoices, Payments & Outstanding, Services & Agreements
// (2026-10-23; before that top tabs). Collapsible on a tablet, a drawer on a phone. Change password and Logout are utilities in the top bar, not modules. Signs the vendor
// out after the server's idle limit; a vendor never reaches anything else.
// The menu comes from /me (the server's list, vendorNav.js is the same list for the moment before it answers).
// A screen reads /me with useVendorMe(); `preview` is the staff name when this is an Admin preview (view only).
const VendorMeContext = createContext(null);
export const useVendorMe = () => useContext(VendorMeContext);

export default function VendorShell({ title, sub, children, moduleKey }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [me, setMe] = useState(null);
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [pwOpen, setPwOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [toast, setToast] = useState('');
  const mode = useSidebarMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const [badges, setBadges] = useState(null);

  const signOut = useCallback(async (notice) => {
    try { await vendorApi.post('/logout'); } catch { /* already out */ }
    setVendorToken(null);
    if (notice) { try { sessionStorage.setItem(VENDOR_NOTICE_KEY, notice); } catch { /* ignore */ } }
    // A plain sign-out goes back to the ONE login page; a notice (expired / signed out) is shown on /vendor-login.
    navigate(notice ? '/vendor-login' : '/login', { replace: true });
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
  // UI ROUTE GUARD: a vendor has ONE portal - the four finance pages, or (asset vendors) the four Assets-portal pages. A page of the other
  // portal sends the vendor to its own Dashboard once /me has said which portal it is (the API refuses the other portal's calls with 403 too).
  const allowed = !me || routeAllowedFor(me.nav, pathname);
  useEffect(() => { if (me && !allowed) navigate(me.landing || '/vendor/dashboard', { replace: true }); }, [me, allowed, navigate]);
  // Before /me has answered, the menu of the portal this address belongs to (so an asset vendor never sees the finance tabs flash by).
  const fallbackNav = pathname.startsWith('/vendor/asset-portal') ? ASSET_NAV : VENDOR_NAV;
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);
  // A count on the Repairs menu of an asset vendor: repair jobs the company approved in HRMS that are still "Awaiting repair" (computed from the repairs themselves; it clears when the vendor takes the job).
  useEffect(() => {
    if (!me || me.kind !== 'assets' || me.preview) return undefined;
    let live = true;
    const ask = () => { if (!document.hidden) vendorApi.get('/asset-portal/overview').then((r) => { if (live) setBadges({ asset_repairs: (r.data.repairs && r.data.repairs.fromCompany) || 0 }); }).catch(() => {}); };
    ask();
    const t = setInterval(ask, 60000);
    return () => { live = false; clearInterval(t); };
  }, [me, pathname]);

  // ASSETS and ID CARD vendors (2026-10-19): ONE sidebar layout (VendorSidebar.jsx, two configurations). The finance vendors keep the top tabs below.
  const pathKind = pathname.startsWith('/vendor/asset-portal') ? 'assets' : (pathname.startsWith('/vendor/idcard-portal') ? 'idcards' : (pathname.startsWith('/vendor/airtel-portal') ? 'telecom' : null));
  const sideKind = me ? (SIDEBAR_KINDS[me.kind] ? me.kind : null) : pathKind;
  if (sideKind) {
    const cfg = SIDEBAR_KINDS[sideKind];
    return (
      <div className="vp-page vp-sidepage">
        <div className="vp-sidelayout">
          <VendorSidebar nav={me?.nav || cfg.nav} roleLabel={me?.roleLabel || cfg.roleLabel} title={cfg.title} me={me} mode={mode} open={drawerOpen} onClose={closeDrawer} onExit={() => signOut()} badges={badges} />
          <div className="vp-sidemain">
            <header className="vp-slimtop">
              {mode === 'drawer' && <button type="button" className="vp-menu-btn" onClick={() => setDrawerOpen(true)} aria-expanded={drawerOpen} aria-controls="vendor-sidebar">&#9776; Menu</button>}
              <span className="vp-slim-title">{cfg.title}</span>
              <span className="vp-spacer" />
              {sideKind === 'idcards' && me && !me.preview ? <IdCardBell /> : null}
              <button type="button" className="btn btn-sm" onClick={() => setPwOpen(true)}>Change password</button>
            </header>
            {me?.preview && (
              <div className="notice amber" style={{ margin: 0, borderRadius: 0, textAlign: 'center' }}>
                <span><strong>Preview as {me.vendorName}</strong> &mdash; opened by {me.preview}. Read only: nothing can be changed here.</span>
              </div>
            )}
            <main className="vp-main">
              <div className="vp-head">
                <h1>{title}</h1>
                {sub && <div className="page-sub">{sub}</div>}
              </div>
              {toast && <div className="notice green" style={{ marginBottom: 10 }}><span>{toast}</span></div>}
              {me && allowed ? <VendorMeContext.Provider value={me}>{children}</VendorMeContext.Provider> : <div className="empty-mini">Loading&hellip;</div>}
            </main>
          </div>
        </div>
        {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); setToast('Password changed.'); }} />}
      </div>
    );
  }

  // THE FINANCE VENDORS (2026-10-23, founder): the same left sidebar as the other portals, with EXACTLY FOUR modules - Dashboard, Bills & Invoices,
  // Payments & Outstanding, Services & Agreements. The header carries the registered company name and category, and one account menu
  // (Change password, Logout). The Assets / ID Card / Airtel portals above are not touched.
  return (
    <div className="vp-page vp-sidepage" data-testid="vendor-finance-portal">
      <div className="vp-sidelayout">
        <VendorSidebar nav={me?.nav || FINANCE_SIDEBAR.nav} roleLabel={FINANCE_SIDEBAR.roleLabel} title={FINANCE_SIDEBAR.title} me={me} mode={mode} open={drawerOpen} onClose={closeDrawer} onExit={() => signOut()} />
        <div className="vp-sidemain">
          <header className="vp-slimtop">
            {mode === 'drawer' && <button type="button" className="vp-menu-btn" onClick={() => setDrawerOpen(true)} aria-expanded={drawerOpen} aria-controls="vendor-sidebar">&#9776; Menu</button>}
            <span className="vp-slim-title">Vendor Portal</span>
            <span className="vp-spacer" />
            <span className="vp-top-name" title={me?.email}>
              <strong>{me?.vendorName || ''}</strong>
              {me?.vendorCategory ? <small> · {me.vendorCategory}</small> : null}
            </span>
            <span className="vp-acct">
              <button type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={acctOpen} onClick={() => setAcctOpen((o) => !o)}>{me?.name || 'Account'} &#9662;</button>
              {acctOpen && (
                <span className="vp-acct-menu" role="menu">
                  <button type="button" role="menuitem" className="btn btn-sm" onClick={() => { setAcctOpen(false); setPwOpen(true); }}>Change password</button>
                  <button type="button" role="menuitem" className="btn btn-sm" onClick={() => { setAcctOpen(false); signOut(); }}>Logout</button>
                </span>
              )}
            </span>
          </header>
          {me?.preview && (
            <div className="notice amber" style={{ margin: 0, borderRadius: 0, textAlign: 'center' }}>
              <span><strong>Preview as {me.vendorName}</strong> &mdash; opened by {me.preview}. Read only: nothing can be changed here.</span>
            </div>
          )}
          <main className="vp-main">
            <div className="vp-head">
              <h1>{title}</h1>
              {sub && <div className="page-sub">{sub}</div>}
            </div>
            {toast && <div className="notice green" style={{ marginBottom: 10 }}><span>{toast}</span></div>}
            {me && allowed ? <VendorMeContext.Provider value={me}>{children}</VendorMeContext.Provider> : <div className="empty-mini">Loading&hellip;</div>}
          </main>
        </div>
      </div>
      {pwOpen && <PasswordModal onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); setToast('Password changed.'); }} />}
    </div>
  );
}

// A short-lived, signed link for one file (the server checks it is yours, and again when you open it).
export async function openVendorFile(body) {
  const r = await vendorApi.post('/download-link', body);
  window.open(r.data.url, '_blank', 'noopener');
}
