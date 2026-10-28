// THE VENDOR PORTAL MENU - EXACTLY FOUR MODULES (2026-10-19, founder; renamed 2026-10-23): Dashboard, Bills & Invoices, Payments & Outstanding, Services & Agreements.
// Pure data + pure functions (no React, no network), so a test can import it. The server sends the same list in /api/vendor-portal/me
// (backend config/vendorModules.js PORTAL_NAV) and the shell uses that; this copy is what shows before /me has answered and what the
// route guard checks. A test keeps the two lists identical.
// It belongs to the VENDOR portal only: staff navigation (src/nav.js) is not touched.
//
// Not modules (utilities in the top bar): Change password, Logout.
export const VENDOR_NAV = [
  { key: 'dashboard', label: 'Dashboard', route: '/vendor/dashboard' },
  { key: 'invoices', label: 'Bills & Invoices', route: '/vendor/invoices' },
  { key: 'payments', label: 'Payments & Outstanding', route: '/vendor/payments' },
  { key: 'services', label: 'Services & Agreements', route: '/vendor/services' },
];
// The finance vendors' sidebar (VendorShell draws it with its own header; the Assets / ID Card / Airtel portals keep SIDEBAR_KINDS below).
export const FINANCE_SIDEBAR = { roleLabel: 'Vendor', nav: VENDOR_NAV, title: 'Vendor Portal' };
// Desktop menu and mobile menu are the same four entries (one scrollable bar that fits a phone).
export const VENDOR_NAV_DESKTOP = VENDOR_NAV;
export const VENDOR_NAV_MOBILE = VENDOR_NAV;
export const VENDOR_HOME = '/vendor/dashboard';

// Where a browser address inside the vendor portal really goes: one of the four routes, or the Dashboard
// (/vendor, /vendor/assets, /vendor/documents, /vendor/profile, /vendor/m/anything ...).
export function vendorRouteFor(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  return VENDOR_NAV.some((n) => n.route === p) ? p : VENDOR_HOME;
}

// ---------------------------------------------------------------------------
// THE ASSETS VENDOR PORTAL (2026-10-19): an ASSET vendor (the server decides: /me -> kind 'assets') sees these four pages and none of the
// finance ones above. Same rules: one list for the desktop menu and the mobile menu, utilities (Change password, Logout) are not modules.
// A test keeps this list identical to the server's (backend config/vendorModules.js ASSET_PORTAL_NAV).
// ---------------------------------------------------------------------------
// FIVE MENUS IN TWO GROUPS (28 Oct 2026, replaces "exactly four"): Dashboard | ASSETS: Asset Register, My Bills, Repairs | ACCOUNTS:
// Invoices & Payments. Repair History is a tab of Repairs; Payments (with the bank payments) and Orders are tabs of Invoices & Payments.
export const ASSET_NAV = [
  { key: 'asset_dashboard', label: 'Dashboard', route: '/vendor/asset-portal/dashboard' },
  { key: 'asset_assets', label: 'Asset Register', route: '/vendor/asset-portal/assets', group: 'Assets' },
  { key: 'asset_bills', label: 'My Bills', route: '/vendor/asset-portal/bills', group: 'Assets' },
  { key: 'asset_repairs', label: 'Repairs', route: '/vendor/asset-portal/repairs', group: 'Assets' },
  { key: 'asset_invoices', label: 'Invoices & Payments', route: '/vendor/asset-portal/invoices', group: 'Accounts' },
];
export const ASSET_NAV_DESKTOP = ASSET_NAV;
export const ASSET_NAV_MOBILE = ASSET_NAV;
export const ASSET_HOME = '/vendor/asset-portal/dashboard';

// An asset vendor's browser address -> one of its four pages, else its Dashboard.
export function assetRouteFor(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  return ASSET_NAV.some((n) => n.route === p) ? p : ASSET_HOME;
}

// May this vendor be on this page? `nav` is what /me sent (the server's list for ITS kind). Pure.
export function routeAllowedFor(nav, pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  return (nav || []).some((n) => n.route === p);
}

// ---------------------------------------------------------------------------
// THE ID CARD VENDOR PORTAL (2026-10-19): the THIRD kind of vendor. Its Dashboard link and its FOUR modules sit in a vertical LEFT SIDEBAR
// (no top tabs). A test keeps these lists identical to the server's (backend config/vendorModules.js IDCARD_PORTAL_*).
// ---------------------------------------------------------------------------
export const IDCARD_MODULES = [
  { key: 'idcard_requests', label: 'ID Card Requests', route: '/vendor/idcard-portal/requests', bucket: 'all' },
  { key: 'idcard_pending', label: 'Pending ID Cards', route: '/vendor/idcard-portal/pending', bucket: 'pending' },
  { key: 'idcard_completed', label: 'Completed ID Cards', route: '/vendor/idcard-portal/completed', bucket: 'completed' },
  { key: 'idcard_delivered', label: 'Delivered / Printed', route: '/vendor/idcard-portal/delivered', bucket: 'delivered' },
];
export const IDCARD_HOME = '/vendor/idcard-portal/dashboard';
export const IDCARD_NAV = [{ key: 'idcard_dashboard', label: 'Dashboard', route: IDCARD_HOME, home: true }, ...IDCARD_MODULES.map(({ key, label, route }) => ({ key, label, route }))];

export function idCardRouteFor(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  return IDCARD_NAV.some((n) => n.route === p) ? p : IDCARD_HOME;
}
// ---------------------------------------------------------------------------
// THE AIRTEL BILLS PORTAL (2026-10-19): the FOURTH kind of vendor ('telecom'). A separate portal with EXACTLY three pages in the same left
// sidebar: Bills, Monthly History, SIMs. A test keeps this list identical to the server's (backend config/vendorModules.js TELECOM_PORTAL_NAV).
// ---------------------------------------------------------------------------
export const TELECOM_NAV = [
  { key: 'airtel_bills', label: 'Bills', route: '/vendor/airtel-portal/bills' },
  { key: 'airtel_history', label: 'Monthly History', route: '/vendor/airtel-portal/history' },
  { key: 'airtel_sims', label: 'SIMs', route: '/vendor/airtel-portal/sims' },
];
export const TELECOM_HOME = '/vendor/airtel-portal/bills';
export function telecomRouteFor(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  return TELECOM_NAV.some((n) => n.route === p) ? p : TELECOM_HOME;
}
// The sidebar: sticky on a desktop, collapsible on a tablet, a drawer (opened by a button) on a phone. Pure, so a test can check it.
export const SIDEBAR_BREAKPOINTS = { drawerBelow: 768, collapsibleBelow: 1024 };
export function sidebarModeFor(width) {
  const w = Number(width) || 0;
  if (w < SIDEBAR_BREAKPOINTS.drawerBelow) return 'drawer';
  return w < SIDEBAR_BREAKPOINTS.collapsibleBelow ? 'collapsible' : 'sticky';
}
export const IDCARD_BUCKET_OF = Object.fromEntries(IDCARD_MODULES.map((m) => [m.route, m.bucket]));

// ---------------------------------------------------------------------------
// ONE vendor SIDEBAR (VendorSidebar.jsx) with two configurations - the Assets Vendor Portal and the ID Card Vendor Portal. The finance
// vendors keep their top tabs. Same structure as the Recruiter Portal's sidebar (brand, menu = icon + label, profile block with avatar, name,
// role and Exit at the bottom); the Recruiter Portal's own menu items are NOT used. The name and the role label come from /me.
// ---------------------------------------------------------------------------
export const SIDEBAR_KINDS = {
  assets: { roleLabel: 'Assets Vendor', nav: ASSET_NAV, title: 'Assets Vendor Portal' },
  idcards: { roleLabel: 'ID Card Vendor', nav: IDCARD_NAV, title: 'ID Card Vendor Portal' },
  telecom: { roleLabel: 'Airtel Bills Vendor', nav: TELECOM_NAV, title: 'Airtel Bills Portal' },
};
// Initials for the avatar: 'Sri Lakshmi Traders' -> 'SL', 'Alpha' -> 'AL', '' -> 'V'.
export function initialsOf(name) {
  const words = String(name || '').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!words.length) return 'V';
  const out = words.length === 1 ? Array.from(words[0]).slice(0, 2).join('') : Array.from(words[0])[0] + Array.from(words[1])[0];
  return out.toUpperCase();
}
