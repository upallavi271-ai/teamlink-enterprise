import { Fragment, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { TeamLinkMark } from '../../components/Logo.jsx';
import { sidebarModeFor, initialsOf } from './vendorNav.js';
import './vendorSidebar.css';

// THE VENDOR SIDEBAR (2026-10-19) - one component, two configurations (vendorNav.js SIDEBAR_KINDS): the Assets Vendor Portal and the ID Card
// Vendor Portal. Built like the Recruiter Portal's sidebar: white, fixed on the left, brand on top, the menu (icon on the left + label),
// and at the BOTTOM the profile block (round avatar with initials, the vendor's name from /me, the role label, Exit). Sticky on a desktop,
// icon-only and collapsible on a tablet, a drawer with its own menu button on a phone. Real links and buttons: Tab / Enter work, Esc closes
// the drawer, the focus is visible, the active page is marked with aria-current.
const P = {
  dashboard: 'M3 3h7v7H3V3zm11 0h7v4h-7V3zM14 10h7v11h-7V10zM3 14h7v7H3v-7z',
  invoices: 'M6 2h12v20l-3-2-3 2-3-2-3 2V2zm3 5v2h6V7H9zm0 4v2h6v-2H9z',
  payments: 'M3 6h18v12H3V6zm2 2v2h14V8H5zm0 4v4h6v-4H5zm9 1h4v2h-4v-2z',
  services: 'M4 4h16v4H4V4zm0 6h16v4H4v-4zm0 6h10v4H4v-4zm12 0h4v4h-4v-4z',
  asset_assets: 'M4 5h16v10H4V5zm-2 12h20v2H2v-2z',
  asset_orders: 'M3 7l9-4 9 4v10l-9 4-9-4V7zm9-1.8L6.2 7.8 12 10.4l5.8-2.6L12 5.2zM5 9.4v6.3l6 2.7v-6.3L5 9.4z',
  asset_repairs: 'M21 7.5a5 5 0 01-6.6 4.7L7 19.6A2 2 0 014.4 17l7.4-7.4A5 5 0 0116.5 3l-3 3 1 3 3 1 3-3a5 5 0 01.1.5z',
  asset_history: 'M12 3a9 9 0 11-8.5 6H1l3.5-4L8 9H5.6A7 7 0 1112 19a7 7 0 004.9-2l1.4 1.4A9 9 0 0112 3zm1 4v5l4 2.3-.8 1.4L11 13V7h2z',
  asset_invoices: 'M6 2h12v20l-3-2-3 2-3-2-3 2V2zm3 5v2h6V7H9zm0 4v2h6v-2H9z',
  asset_bills: 'M5 3h10l4 4v14H5V3zm9 1.5V8h3.5L14 4.5zM8 11v2h8v-2H8zm0 4v2h8v-2H8z',
  airtel_bills: 'M6 2h12v20l-3-2-3 2-3-2-3 2V2zm3 5v2h6V7H9zm0 4v2h6v-2H9z',
  airtel_history: 'M12 3a9 9 0 11-8.5 6H1l3.5-4L8 9H5.6A7 7 0 1112 19a7 7 0 004.9-2l1.4 1.4A9 9 0 0112 3zm1 4v5l4 2.3-.8 1.4L11 13V7h2z',
  airtel_sims: 'M7 2h7l4 4v16H7V2zm2 7v3h6V9H9zm0 5v4h6v-4H9z',
  idcard_requests: 'M4 4h16v16H4V4zm3 4v2h10V8H7zm0 4v2h10v-2H7zm0 4v2h6v-2H7z',
  idcard_pending: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5h-2v6l5 3 1-1.7-4-2.3V7z',
  idcard_completed: 'M12 2a10 10 0 100 20 10 10 0 000-20zm-1.2 14.4L6.6 12.2 8 10.8l2.8 2.8 5.2-5.2 1.4 1.4-6.6 6.6z',
  idcard_delivered: 'M2 6h12v9H2V6zm12 3h4l4 4v2h-8V9zM6 17.5a2 2 0 104 0 2 2 0 00-4 0zm9 0a2 2 0 104 0 2 2 0 00-4 0z',
};
const pathFor = (key) => P[key] || (/dashboard$/.test(key) ? P.dashboard : P.asset_assets);
export const NavIcon = ({ name }) => (
  <svg className="vsb-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" data-icon={name}><path d={pathFor(name)} fill="currentColor" /></svg>
);

export function useSidebarMode() {
  const [mode, setMode] = useState(() => sidebarModeFor(typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setMode(sidebarModeFor(window.innerWidth));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return mode;
}

// kind: 'assets' | 'idcards' (config comes in as `nav` + `roleLabel`); me: the /me answer; onExit: the existing sign-out.
// badges: { <menu key>: number } - a small count on a menu entry (the Repairs menu shows the jobs the company is waiting for you to take).
export default function VendorSidebar({ nav, roleLabel, title, me, mode, open, onClose, onExit, badges }) {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(true);
  const ref = useRef(null);
  const drawer = mode === 'drawer';
  const narrow = mode === 'collapsible' && collapsed;
  const company = (me && (me.vendorName || me.name)) || '';

  useEffect(() => { if (drawer && open) onClose(); }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!drawer || !open) return undefined;
    const first = ref.current && ref.current.querySelector('a');
    if (first) first.focus();
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [drawer, open, onClose]);

  return (
    <>
      {drawer && open && <div className="vsb-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside
        ref={ref}
        id="vendor-sidebar"
        className={`vsb ${mode}${drawer && open ? ' open' : ''}${narrow ? ' narrow' : ''}`}
        aria-label={title}
        data-testid="vendor-sidebar"
        {...(drawer && !open ? { 'aria-hidden': 'true', inert: '' } : {})}
      >
        <div className="vsb-brand">
          <TeamLinkMark width={narrow ? 40 : 112} />
          {!narrow && <span className="vsb-tag">Vendor</span>}
          {drawer && <button type="button" className="vsb-x" onClick={onClose} aria-label="Close the menu">&times;</button>}
          {mode === 'collapsible' && (
            <button type="button" className="vsb-toggle" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-controls="vendor-sidebar" aria-label={collapsed ? 'Show the menu names' : 'Hide the menu names'}>
              {collapsed ? '»' : '«'}
            </button>
          )}
        </div>
        <nav className="vsb-nav" aria-label={`${title} menu`} data-testid="vendor-nav">
          {nav.map((n, i) => (
            <Fragment key={n.key}>
            {/* a group heading ("Assets", "Accounts") where a group starts; a thin line in the icon-only menu */}
            {n.group && n.group !== (nav[i - 1] || {}).group && (narrow ? <hr className="vsb-sep" aria-hidden="true" /> : <div className="vsb-group" role="presentation">{n.group}</div>)}
            <NavLink to={n.route} end className={({ isActive }) => `vsb-link${isActive ? ' active' : ''}`} title={narrow ? n.label : undefined}>
              <NavIcon name={n.key} />
              <span className="vsb-lbl">{n.label}</span>
              {badges && badges[n.key] > 0 && <span className="vsb-badge" title={`${badges[n.key]} new ${badges[n.key] === 1 ? 'job' : 'jobs'} waiting for you`}>{badges[n.key]}<span className="vsb-sr"> new {badges[n.key] === 1 ? 'job' : 'jobs'} waiting</span></span>}
            </NavLink>
            </Fragment>
          ))}
        </nav>
        <div className="vsb-foot" data-testid="vendor-profile">
          <div className="vsb-avatar" aria-hidden="true">{initialsOf(company)}</div>
          <div className="vsb-who"><b title={company}>{company || 'Vendor'}</b><span>{roleLabel}</span></div>
          <button type="button" className="vsb-exit" onClick={onExit} aria-label="Exit (sign out)">Exit</button>
        </div>
      </aside>
    </>
  );
}
