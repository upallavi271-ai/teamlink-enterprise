import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import api, { viewAsToken, actAsMode } from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { OmniCtx } from './omniContext.js';
import { useOmniStore, startChrome, pollBadges } from './omniStore.js';
import { PAGES, SECTIONS, resolveRoute, openViews, pagePath, sectionOf, sectionPath, MK_SUBTABS, MK_SUB_PARENT } from './omniPages.js';
import { PAGE_COMPONENTS } from './pageComponents.js';
import './gs.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL (the Green Start prototype, built on TeamLink's real data). The sidebar group "Omni-Channel" lists the pages (omniPages.js); this
// component draws the open one at /omni-channel/<page>. What a login may open comes from GET /api/outreach/me (`pages`); the server checks every
// route again. Old five-hub addresses and /omni?mode=..&tab=.. are rewritten to their new page (legacyPage).
// ---------------------------------------------------------------------------
// `embedded` (2026-11-16): the bare AI Marketing page that Green Start shows inside its own "AI Marketing" (address /embed/ai-marketing/<screen>): no TeamLink sidebar around it, no tab bar (Green Start draws
// the tabs), the sub-tab pills stay, every link stays inside the frame, and the open screen is told to the page around it (postMessage) so its tab lights up.
export default function OmniApp({ embedded = false } = {}) {
  const { user } = useAuth();
  const { hub: hubParam, view: viewParam } = useParams();
  const segment = embedded ? 'aimarketing' : hubParam;
  const embedPath = (id) => `/embed/ai-marketing/${id}`;
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
    if (route && route.redirect && !embedded) navigate(route.redirect, { replace: true });
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps
  // embedded: tell the page around (Green Start) which screen is open, and which tab it belongs under
  useEffect(() => {
    if (!embedded || !page) return;
    try { if (window.parent && window.parent !== window) window.parent.postMessage({ source: 'teamlink-ai-marketing', view: page, tab: MK_SUB_PARENT[page] || page }, '*'); } catch { /* no page around */ }
  }, [embedded, page]);

  const toast = useCallback((text) => {
    setToastText(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(''), 3200);
  }, []);
  const go = useCallback((id, params) => {
    const q = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    navigate(`${embedded ? embedPath(id) : pagePath(id)}${q}`);
  }, [navigate, embedded]);
  const ctx = useMemo(() => ({ acc, go, toast, dept: store.dept, user }), [acc, go, toast, store.dept, user]);

  if (err) return <div className="gsx"><div className="content"><div className="card panel" role="alert" style={{ color: '#9b1c1c' }}>{err}</div></div></div>;
  if (!acc) return <div className="gsx"><div className="content"><div className="card panel">Loading…</div></div></div>;
  if (!page) return <div className="gsx"><div className="content"><div className="card panel" role="status">There is nothing for your login in Omni-Channel yet.</div></div></div>;
  const Page = PAGE_COMPONENTS[page];
  const sec = SECTIONS.find((x) => x.id === route.section);
  // AI Marketing: a screen that is a SUB-TAB (Lead generation, under Client projects) has no tab of its own: its parent tab stays lit and a row of sub-tabs shows under the bar
  const inMk = route.section === 'aimarketing';
  const openAll = openViews(acc, route.section);
  const tabsOf = openAll.filter((v) => !(inMk && MK_SUB_PARENT[v]));
  const lit = inMk ? (MK_SUB_PARENT[page] || page) : page;
  const subs = inMk && MK_SUBTABS[lit] ? MK_SUBTABS[lit].filter((v) => openAll.includes(v)) : [];
  const viewing = !!viewAsToken() && !actAsMode(); // View as = read-only
  return (
    <OmniCtx.Provider value={ctx}>
      <div className="gsx" data-page={page}>
        <div className="content">
          {viewing && <div role="status" style={{ background: '#fff1d6', border: '1px solid #f0b34a', color: '#7a4a00', borderRadius: 10, padding: '9px 12px', fontSize: 11, marginBottom: 12 }}><b>You are in View as mode: this page is read-only.</b> Changes need &quot;Switch to Act as (edit)&quot;.</div>}
          {!embedded && tabsOf.length > 1 && (
            <div className="tabs omni-sec-tabs" role="tablist" aria-label={sec ? sec.label : 'Omni-Channel'} style={{ marginBottom: 14 }}>
              {tabsOf.map((v) => <button key={v} type="button" role="tab" aria-selected={v === lit} className={`tab${v === lit ? ' active' : ''}`} onClick={() => navigate(sectionPath(route.section, v))}>{PAGES[v].label}{v === 'inbox' && store.badges.inboxUnread > 0 ? ` (${store.badges.inboxUnread})` : ''}{v === 'review' && store.badges.review > 0 ? ` (${store.badges.review})` : ''}</button>)}
            </div>
          )}
          {subs.length > 1 && (
            <div className="omni-sub-tabs" role="tablist" aria-label={`${PAGES[lit].label}: more`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '-6px 0 14px 2px' }}>
              {subs.map((v) => (
                <button key={v} type="button" role="tab" aria-selected={v === page} onClick={() => navigate(embedded ? embedPath(v) : sectionPath(route.section, v))}
                  style={{ border: `1px solid ${v === page ? '#0f766e' : 'var(--line)'}`, background: v === page ? '#0f766e' : '#fff', color: v === page ? '#fff' : 'inherit', borderRadius: 999, padding: '5px 13px', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {PAGES[v].label}
                </button>
              ))}
            </div>
          )}
          <Suspense fallback={<div className="card panel">Loading {PAGES[page].label}…</div>}>{Page ? <Page key={`${page}:${store.dept}`} /> : null}</Suspense>
        </div>
        <div className={`toast${toastText ? ' show' : ''}`} role="status" aria-live="polite">{toastText}</div>
      </div>
    </OmniCtx.Provider>
  );
}
