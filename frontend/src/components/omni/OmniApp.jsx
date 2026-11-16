import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import api, { viewAsToken, actAsMode } from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { OmniCtx } from './omniContext.js';
import { useOmniStore, startChrome, pollBadges } from './omniStore.js';
import { PAGES, SECTIONS, resolveRoute, openViews, pagePath, sectionOf, sectionPath } from './omniPages.js';
import { PAGE_COMPONENTS } from './pageComponents.js';
import './gs.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL (the Green Start prototype, built on TeamLink's real data). The sidebar group "Omni-Channel" lists the pages (omniPages.js); this
// component draws the open one at /omni-channel/<page>. What a login may open comes from GET /api/outreach/me (`pages`); the server checks every
// route again. Old five-hub addresses and /omni?mode=..&tab=.. are rewritten to their new page (legacyPage).
// ---------------------------------------------------------------------------
export default function OmniApp() {
  const { user } = useAuth();
  const { hub: segment, view: viewParam } = useParams();
  const { search } = useLocation();
  const navigate = useNavigate();
  const [acc, setAcc] = useState(null);
  const [err, setErr] = useState('');
  const [toastText, setToastText] = useState('');
  const toastTimer = useRef(null);
  const store = useOmniStore();

  useEffect(() => {
    let on = true;
    api.get('/outreach/me').then(async (me) => {
      let old = {};
      try { old = (await api.get('/outreach/access')).data; } catch { old = { ready: false, campaignsReady: false }; } // Finance has no recruitment access: only /me
      if (on) setAcc({ ...old, ...me.data });
    }).catch((e) => { if (on) setErr((e.response && e.response.data && e.response.data.error) || 'Omni-Channel could not be opened.'); });
    return () => { on = false; };
  }, []);
  useEffect(() => { if (user && user.id) startChrome(user.id); pollBadges(true); return () => pollBadges(false); }, [user && user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ONE rule (omniPages.js resolveRoute): a section address shows its first allowed tab; an old page address is rewritten to its section and tab;
  // a tab this login may not open falls back to the first one it may
  const route = useMemo(() => (acc ? resolveRoute(acc, segment, viewParam, search) : null), [acc, segment, viewParam, search]);
  const page = route && !route.none ? route.view : null;
  useEffect(() => {
    if (route && route.redirect) navigate(route.redirect, { replace: true });
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  const toast = useCallback((text) => {
    setToastText(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 3200);
  }, []);
  const go = useCallback((id, params) => {
    const q = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    navigate(`${pagePath(id)}${q}`);
  }, [navigate]);
  const ctx = useMemo(() => ({ acc, go, toast, dept: store.dept, user }), [acc, go, toast, store.dept, user]);

  if (err) return <div className="gsx"><div className="content"><div className="card panel" role="alert" style={{ color: '#9b1c1c' }}>{err}</div></div></div>;
  if (!acc) return <div className="gsx"><div className="content"><div className="card panel">Loading…</div></div></div>;
  if (!page) return <div className="gsx"><div className="content"><div className="card panel" role="status">There is nothing for your login in Omni-Channel yet.</div></div></div>;
  const Page = PAGE_COMPONENTS[page];
  const sec = SECTIONS.find((x) => x.id === route.section);
  const tabsOf = openViews(acc, route.section);
  const viewing = !!viewAsToken() && !actAsMode(); // View as = read-only
  return (
    <OmniCtx.Provider value={ctx}>
      <div className="gsx" data-page={page}>
        <div className="content">
          {viewing && <div role="status" style={{ background: '#fff1d6', border: '1px solid #f0b34a', color: '#7a4a00', borderRadius: 10, padding: '9px 12px', fontSize: 11, marginBottom: 12 }}><b>You are in View as mode: this page is read-only.</b> Changes need &quot;Switch to Act as (edit)&quot;.</div>}
          {tabsOf.length > 1 && (
            <div className="tabs omni-sec-tabs" role="tablist" aria-label={sec ? sec.label : 'Omni-Channel'} style={{ marginBottom: 14 }}>
              {tabsOf.map((v) => <button key={v} type="button" role="tab" aria-selected={v === page} className={`tab${v === page ? ' active' : ''}`} onClick={() => navigate(sectionPath(route.section, v))}>{PAGES[v].label}{v === 'inbox' && store.badges.inboxUnread > 0 ? ` (${store.badges.inboxUnread})` : ''}{v === 'review' && store.badges.review > 0 ? ` (${store.badges.review})` : ''}</button>)}
            </div>
          )}
          <Suspense fallback={<div className="card panel">Loading {PAGES[page].label}…</div>}>{Page ? <Page key={`${page}:${store.dept}`} /> : null}</Suspense>
        </div>
        <div className={`toast${toastText ? ' show' : ''}`} role="status" aria-live="polite">{toastText}</div>
      </div>
    </OmniCtx.Provider>
  );
}
