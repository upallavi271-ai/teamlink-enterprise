// ---------------------------------------------------------------------------
// VENDOR MODULES — THE ONE PLACE TO EDIT (2026-10-14).
//
// Everything about "what does a vendor of this category see" lives in this file:
//   1. MODULES   the registry: moduleKey -> label, icon, route, screen, the
//                permission ticks the admin can set, and the dashboard summary.
//   2. CATEGORIES  the category -> default modules map, with aliases, so the
//                free-text Vendor Master category ("Airtel SIM", "Rent",
//                "AMC") lands on the right key. Unknown = 'other'.
// The backend reads it directly (utils/vendorModules.js) and serves it to the
// screens through GET /api/vendor-logins/options (admin drawer) and
// GET /api/vendor-portal/me (the portal's nav + dashboard). The frontend has NO
// copy: it only maps a registry `screen` name to a React component
// (frontend/src/pages/vendor/vendorScreens.js).
//
// ADD A MODULE:   one entry in MODULES (+ one screen component + one line in
//                 vendorScreens.js + its summary in utils/vendorModules.js).
// ADD A CATEGORY: one entry in CATEGORIES. No page, route or code per vendor.
//
// Plain data + two pure functions: no database, no Express.
// ---------------------------------------------------------------------------

// perm.default: what a freshly ticked module starts with (the admin can change it).
const yes = (key, label, hint) => ({ key, label, hint, default: true });
const no = (key, label, hint) => ({ key, label, hint, default: false });

const MODULES = {
  assets: {
    label: 'Assets', icon: '💻', route: '/vendor/assets', screen: 'assets', summary: 'assets', order: 10,
    assetScope: true, // the drawer shows "Which assets can they see?" only for this module
    permissions: [
      // ON BY DEFAULT (founder 2026-10-28: "switch on the editing and importing the bills for vendors").
      yes('canEdit', 'Allow editing', 'On (normal) = they may update serial no., warranty date, AMC date, service remarks, upload documents and import / send bills. Off = view only.'),
      no('canViewCost', 'Show purchase value', 'Off = they never see what the company paid (nor the purchase invoice no.).'),
      yes('download', 'Download lists (Export)', 'On = the Export Excel / Export CSV buttons work on every list. They only ever get the columns they can already see.'),
      no('hideAmounts', 'Hide amounts from this vendor', 'Off (normal) = they see the purchase amount, GST and warranty of the assets shown to them. On = amounts are hidden everywhere, in the lists and in the downloads. (The older "Show purchase value" tick now only controls the purchase invoice reference.)'),
    ],
  },
  office: {
    label: 'Office', icon: '🏢', route: '/vendor/m/office', screen: 'office', summary: 'office', order: 20,
    permissions: [
      yes('viewHistory', 'View rent / office bill history', 'They see the bills and payments booked for their office or building.'),
      yes('uploadReceipts', 'Upload receipts', 'They may upload rent or office receipts (PDF, JPG, PNG).'),
    ],
  },
  expenses: {
    label: 'Expenses', icon: '🧾', route: '/vendor/m/expenses', screen: 'expenses', summary: 'expenses', order: 30,
    permissions: [
      yes('viewEntries', 'View expense entries and payment status', 'They see what the company booked against them and whether it is paid.'),
    ],
  },
  id_card_orders: {
    label: 'ID Card Orders', icon: '🪪', route: '/vendor/m/id_card_orders', screen: 'id_card_orders', summary: 'id_card_orders', order: 40,
    permissions: [
      yes('updateStatus', 'Update order status', 'Received, Printing, Ready, Delivered (one step at a time).'),
      yes('download', 'Download employee data and photos', 'CSV of the lines and a ZIP with the photos, for their own orders only.'),
      yes('uploadProof', 'Upload delivery challan / proof and remarks', 'A delivery challan or proof file and a remark on the order.'),
    ],
  },
  // AIRTEL BILLS PORTAL (2026-10-19): ticking this gives the login the separate Airtel Bills portal (Bills, Monthly History, SIMs) - see utils/vendorKind.js.
  airtel_bills: {
    label: 'Airtel Bills', icon: '📱', route: '/vendor/airtel-portal/bills', screen: 'airtel_bills', summary: 'airtel_bills', order: 45,
    permissions: [
      yes('sendBill', 'Send a bill', 'They may send an Airtel bill (PDF, JPG or PNG) for Accounts to check. They can never mark a bill paid: payment comes only from Accounts and the bank statement.'),
      yes('download', 'Download lists (Export)', 'On = the Export Excel / Export CSV buttons work on Bills, Monthly History and SIMs (numbers stay hidden).'),
    ],
  },
  sim_connections: {
    label: 'SIM and Connections', icon: '📶', route: '/vendor/m/sim_connections', screen: 'sim_connections', summary: 'sim_connections', order: 40,
    permissions: [
      yes('updateStatus', 'Mark SIMs Active / Suspended / Disconnected', 'Every change is recorded and the company is told.'),
      yes('handleRequests', 'Update company requests', 'New connection, replacement SIM, port-out, plan change.'),
    ],
  },
  monthly_bills: {
    label: 'Monthly Bills', icon: '📅', route: '/vendor/m/monthly_bills', screen: 'monthly_bills', summary: 'monthly_bills', order: 50,
    permissions: [
      yes('upload', 'Upload monthly bills', 'Bill number, period, amount, due date and the bill PDF.'),
      yes('viewStatus', 'See Pending / Approved / Paid', 'The review and payment status of each bill.'),
    ],
  },
  invoices: {
    label: 'Invoices', icon: '📄', route: '/vendor/invoices', screen: 'invoices', summary: 'invoices', order: 60,
    permissions: [
      yes('raise', 'Raise / upload invoices', 'They may send an invoice (PDF, JPG or PNG).'),
      yes('viewStatus', 'View status and payments', 'Submitted, Approved, Paid or Rejected, with the payment.'),
      yes('download', 'Download lists (Export)', 'On = the Export Excel / Export CSV buttons work on Invoices, Payments and Purchase Orders.'),
    ],
  },
  payments: {
    label: 'Payments', icon: '💰', route: '/vendor/m/payments', screen: 'payments', summary: 'payments', order: 70,
    permissions: [
      yes('viewHistory', 'View payment history', 'Date, amount and reference number of every payment.'),
    ],
  },
};

// Always on for every login, no ticks: the files the company shared and the vendor's own details.
const CORE = {
  documents: { label: 'Documents', icon: '📁', route: '/vendor/documents', screen: 'documents', order: 90 },
  profile: { label: 'Your details', icon: '👤', route: '/vendor/profile', screen: 'profile', order: 95 },
};

// What a login saved before modules existed sees: exactly what it saw before (Assets, Bills / Invoices, Documents, Profile).
const LEGACY_MODULES = ['assets', 'invoices'];

// key -> default modules, label, aliases (matched on the normalised Vendor Master category text).
const CATEGORIES = {
  office_rent: {
    label: 'Office Rent / Building', modules: ['office', 'expenses', 'invoices', 'payments'],
    aliases: ['office rent', 'rent', 'building', 'office building', 'lease', 'rental', 'property', 'premises', 'landlord', 'electricity', 'water', 'utilities', 'housekeeping', 'maintenance charges'],
  },
  id_cards: {
    label: 'ID Cards', modules: ['id_card_orders', 'invoices', 'payments'],
    aliases: ['id card', 'id cards', 'idcard', 'idcards', 'identity card', 'identity cards', 'id-card', 'badge', 'badges', 'lanyard', 'lanyards', 'card printing'],
  },
  telecom: {
    label: 'Airtel SIM / Telecom', modules: ['sim_connections', 'monthly_bills', 'invoices', 'payments'],
    aliases: ['airtel', 'airtel sim', 'sim', 'sim card', 'sim cards', 'telecom', 'telephone', 'mobile', 'mobile connection', 'jio', 'vi', 'vodafone', 'idea', 'bsnl', 'internet', 'broadband', 'internet & phone', 'internet and phone', 'leased line', 'connectivity', 'isp'],
  },
  it_service: {
    label: 'IT / Hardware / AMC / Service', modules: ['assets', 'invoices', 'payments'],
    aliases: ['it', 'it services', 'it service', 'it hardware', 'hardware', 'computers', 'computer', 'laptop', 'laptops', 'amc', 'service', 'services', 'repair', 'repairs', 'it amc', 'it support', 'electronics', 'printer', 'printers', 'software', 'equipment'],
  },
  other: {
    label: 'Other / Custom', modules: ['invoices', 'payments'], aliases: ['other', 'custom', 'misc', 'miscellaneous', 'general'],
  },
};
const DEFAULT_CATEGORY = 'other';

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Vendor Master category text -> a CATEGORIES key. Exact alias / label first, then
// "contains an alias as whole words" (longest alias wins), else the safe default.
function resolveCategory(text) {
  const t = norm(text);
  if (!t) return DEFAULT_CATEGORY;
  const hay = ` ${t} `;
  let best = null;
  for (const [key, c] of Object.entries(CATEGORIES)) {
    const names = [norm(c.label), key.replace(/_/g, ' '), ...c.aliases.map(norm)];
    if (names.includes(t)) return key;
    for (const n of names) {
      if (n && hay.includes(` ${n} `) && (!best || n.length > best.len)) best = { key, len: n.length };
    }
  }
  return best ? best.key : DEFAULT_CATEGORY;
}

// The default modules of a category (a fresh array each time).
const modulesForCategory = (key) => [...(CATEGORIES[key] || CATEGORIES[DEFAULT_CATEGORY]).modules];

// The default ticks of one module: { key: bool }.
function defaultPermissions(moduleKey) {
  const m = MODULES[moduleKey];
  return Object.fromEntries(((m && m.permissions) || []).map((p) => [p.key, p.default === true]));
}

// A permission is ON unless explicitly false (so a new permission added later is on for old rows only if its default is on).
function permAllowed(moduleKey, saved, permKey) {
  const m = MODULES[moduleKey];
  const def = m && (m.permissions || []).find((p) => p.key === permKey);
  if (!def) return false;
  if (saved && Object.prototype.hasOwnProperty.call(saved, permKey)) return saved[permKey] === true;
  return def.default === true;
}

// The registry as the screens get it (nothing secret in it).
function publicRegistry() {
  const mod = (k, m) => ({
    key: k, label: m.label, icon: m.icon, route: m.route, screen: m.screen, order: m.order, assetScope: !!m.assetScope,
    permissions: (m.permissions || []).map((p) => ({ key: p.key, label: p.label, hint: p.hint || '', default: p.default === true })),
  });
  return {
    modules: Object.entries(MODULES).map(([k, m]) => mod(k, m)).sort((a, b) => a.order - b.order),
    core: Object.entries(CORE).map(([k, m]) => ({ key: k, label: m.label, icon: m.icon, route: m.route, screen: m.screen, order: m.order })),
    categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label, modules: [...c.modules] })),
    defaultCategory: DEFAULT_CATEGORY,
    legacyModules: [...LEGACY_MODULES],
  };
}

// ---------------------------------------------------------------------------
// THE VENDOR PORTAL SHOWS EXACTLY FOUR MODULES (2026-10-19, founder; renamed 2026-10-23): Dashboard, Bills & Invoices, Payments & Outstanding, Services & Agreements.
// This list is the ONE source for the vendor's desktop menu AND mobile menu (both read /api/vendor-portal/me -> nav), for the screen
// route guard (frontend/src/pages/vendor/vendorNav.js mirrors it for the pure-logic test) and for the server's API allow-list below.
// It is vendor-only: staff navigation, roles and permissions are not touched. The older modules (Assets, Office, ID cards, SIM, ...)
// stay in the registry above - the Admin login screen still lists them - but a vendor session no longer reaches their pages or APIs.
// Utility actions that are NOT modules: Change password, Logout (top bar).
// ---------------------------------------------------------------------------
const PORTAL_NAV = [
  { key: 'dashboard', label: 'Dashboard', route: '/vendor/dashboard' },
  { key: 'invoices', label: 'Bills & Invoices', route: '/vendor/invoices' },
  { key: 'payments', label: 'Payments & Outstanding', route: '/vendor/payments' },
  { key: 'services', label: 'Services & Agreements', route: '/vendor/services' },
];
const PORTAL_HOME = '/vendor/dashboard';
// Vendor API paths (under /api/vendor-portal) a SIGNED-IN vendor may call. Everything else answers 403 "not available".
//   public (no session needed): status, login, preview/redeem, invite/*, forgot-password, email/verify/*, files/:token
//   signed in: me, logout, change-password, records/* (the four modules), download-link, module-bills (the existing invoice upload + its file)
const PORTAL_PUBLIC_PREFIXES = ['/status', '/login', '/preview', '/invite', '/forgot-password', '/email', '/files'];
// '/vendor-io' (2026-10-19): Export + Import for every kind of vendor; the route itself decides what the vendor's KIND may use.
const PORTAL_SESSION_PREFIXES = ['/me', '/logout', '/change-password', '/records', '/download-link', '/module-bills', '/vendor-io'];
function portalPathAllowed(p) {
  const path = String(p || '').split('?')[0].replace(/\/+$/, '') || '/';
  return [...PORTAL_PUBLIC_PREFIXES, ...PORTAL_SESSION_PREFIXES].some((x) => path === x || path.startsWith(`${x}/`));
}
// A browser address inside the vendor portal -> where it really goes (pure function; the router uses the same rule).
const PORTAL_ROUTES = PORTAL_NAV.map((n) => n.route);
function portalRouteFor(pathname) {
  const p = String(pathname || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (PORTAL_ROUTES.includes(p)) return p;
  return PORTAL_HOME; // /vendor, /vendor/assets, /vendor/documents, /vendor/profile, /vendor/m/anything ... -> Dashboard
}

// ---------------------------------------------------------------------------
// THE ASSETS VENDOR PORTAL (2026-10-19, founder: "Assets Vendor Portal - asset, order and repair synchronisation").
// A vendor is EITHER an asset vendor OR one of the other vendors; it is decided on the server (utils/assetVendorPortal.js kindOf):
//   * asset vendor  = the login has the Assets module ticked (when the login's modules were set by Admin), otherwise the vendor-master
//                     category is the one the old Assets menu belonged to ("IT / Hardware / AMC / Service", key it_service);
//   * everyone else = EXACTLY the four modules above, as before.
// An asset vendor sees ONLY these six pages (no Invoices / Payments / Purchase Orders of the finance portal, no HRMS, ATS, Accounts, Admin).
// Its API is the /asset-portal/* prefix below plus the same account utilities (me, logout, change-password) and its own signed downloads.
// ---------------------------------------------------------------------------
// EXACTLY FOUR MODULES (Assets Vendor Portal master prompt, 27 Oct 2026): Orders sits in Invoices & Payments, Repair History in Repairs & HRMS Tickets
const ASSET_PORTAL_NAV = [
  { key: 'asset_dashboard', label: 'Dashboard', route: '/vendor/asset-portal/dashboard' },
  { key: 'asset_assets', label: 'Assets', route: '/vendor/asset-portal/assets' },
  { key: 'asset_repairs', label: 'Repairs & HRMS Tickets', route: '/vendor/asset-portal/repairs' },
  { key: 'asset_invoices', label: 'Invoices & Payments', route: '/vendor/asset-portal/invoices' },
];
// The label under the vendor's name in the sidebar's profile block (one per kind).
const ROLE_LABEL = { assets: 'Assets Vendor', idcards: 'ID Card Vendor', telecom: 'Airtel Bills Vendor', finance: 'Vendor' };
const ASSET_PORTAL_HOME = '/vendor/asset-portal/dashboard';
const ASSET_API_PREFIX = '/asset-portal';
// The vendor API paths the FINANCE portal owns: an asset vendor is refused on these (403 "not available").
const FINANCE_ONLY_PREFIXES = ['/records', '/module-bills'];
const pathOf = (p) => String(p || '').split('?')[0].replace(/\/+$/, '') || '/';
const isAssetApiPath = (p) => { const x = pathOf(p); return x === ASSET_API_PREFIX || x.startsWith(`${ASSET_API_PREFIX}/`); };
const isFinanceOnlyPath = (p) => { const x = pathOf(p); return FINANCE_ONLY_PREFIXES.some((f) => x === f || x.startsWith(`${f}/`)); };
// ---------------------------------------------------------------------------
// THE ID CARD VENDOR PORTAL (2026-10-19): the THIRD kind. A vendor is exactly one of three kinds (utils/vendorKind.js kindOfRow):
//   'assets'  (Assets ticked, or category IT / Hardware / AMC / Service)      -> the four Assets-portal pages
//   'idcards' (ID Card Orders ticked, or category ID Cards)                   -> Dashboard + the four ID-card modules in a left sidebar
//   'finance' (everyone else)                                                  -> EXACTLY the four finance modules, as before
// If a login has both Assets and ID Card Orders ticked, Assets wins (a vendor has one portal).
// ---------------------------------------------------------------------------
const IDCARD_PORTAL_MODULES = [
  { key: 'idcard_requests', label: 'ID Card Requests', route: '/vendor/idcard-portal/requests', bucket: 'all' },
  { key: 'idcard_pending', label: 'Pending ID Cards', route: '/vendor/idcard-portal/pending', bucket: 'pending' },
  { key: 'idcard_completed', label: 'Completed ID Cards', route: '/vendor/idcard-portal/completed', bucket: 'completed' },
  { key: 'idcard_delivered', label: 'Delivered / Printed', route: '/vendor/idcard-portal/delivered', bucket: 'delivered' },
];
const IDCARD_PORTAL_HOME = '/vendor/idcard-portal/dashboard';
// /me sends the home link first, then the four modules; the sidebar shows the home link above the four modules.
const IDCARD_PORTAL_NAV = [{ key: 'idcard_dashboard', label: 'Dashboard', route: IDCARD_PORTAL_HOME, home: true }, ...IDCARD_PORTAL_MODULES.map(({ key, label, route }) => ({ key, label, route }))];
const IDCARD_API_PREFIX = '/idcard-portal';
const isIdCardApiPath = (p) => { const x = pathOf(p); return x === IDCARD_API_PREFIX || x.startsWith(`${IDCARD_API_PREFIX}/`); };
// ---------------------------------------------------------------------------
// THE AIRTEL BILLS PORTAL (2026-10-19): the FOURTH kind, 'telecom'. Exactly three pages: Bills, Monthly History, SIMs.
//   'telecom' = the login has the Airtel Bills module ticked by Admin (never decided by the vendor-master category). Assets and ID Cards win
//               over it when ticked (a vendor has one portal).
// Its API is /airtel-portal/* only (+ the shared account utilities and its own signed bill download). It is read-only apart from 'Send a bill'.
// ---------------------------------------------------------------------------
const TELECOM_PORTAL_NAV = [
  { key: 'airtel_bills', label: 'Bills', route: '/vendor/airtel-portal/bills' },
  { key: 'airtel_history', label: 'Monthly History', route: '/vendor/airtel-portal/history' },
  { key: 'airtel_sims', label: 'SIMs', route: '/vendor/airtel-portal/sims' },
];
const TELECOM_PORTAL_HOME = '/vendor/airtel-portal/bills';
const TELECOM_API_PREFIX = '/airtel-portal';
const isTelecomApiPath = (p) => { const x = pathOf(p); return x === TELECOM_API_PREFIX || x.startsWith(`${TELECOM_API_PREFIX}/`); };
const TELECOM_ROUTES = TELECOM_PORTAL_NAV.map((n) => n.route);
function telecomPortalRouteFor(pathname) {
  const p = pathOf(pathname);
  return TELECOM_ROUTES.includes(p) ? p : TELECOM_PORTAL_HOME;
}
// The kind that owns an API path (null = a shared path: utilities, sign-in, downloads).
function kindOwningPath(p) {
  if (isAssetApiPath(p)) return 'assets';
  if (isIdCardApiPath(p)) return 'idcards';
  if (isTelecomApiPath(p)) return 'telecom';
  if (isFinanceOnlyPath(p)) return 'finance';
  return null;
}
// Pure: may a SIGNED-IN vendor of this kind ('assets' | 'idcards' | 'telecom' | 'finance') call this API path? (the server wall uses it; the test checks it)
function portalPathAllowedFor(kind, p) {
  const owner = kindOwningPath(p);
  if (owner) return owner === kind && (owner !== 'finance' || portalPathAllowed(p));
  return portalPathAllowed(p);
}
const IDCARD_ROUTES = IDCARD_PORTAL_NAV.map((n) => n.route);
function idCardPortalRouteFor(pathname) {
  const p = pathOf(pathname);
  return IDCARD_ROUTES.includes(p) ? p : IDCARD_PORTAL_HOME;
}
// The ID-card statuses (the existing order flow) and the four modules' buckets. Printing and delivery are DERIVED from the one real status:
// the app keeps one status per order (New > Received > Printing > Ready > Delivered), nothing is invented.
const IDCARD_FLOW = ['New', 'Received', 'Printing', 'Ready', 'Delivered'];
const IDCARD_BUCKETS = { all: [...IDCARD_FLOW], pending: ['New', 'Received', 'Printing'], completed: ['Ready'], delivered: ['Delivered'] };
const IDCARD_PRINTING = { New: 'Not started', Received: 'Not started', Printing: 'Printing', Ready: 'Printed', Delivered: 'Printed' };
const IDCARD_DELIVERY = { New: 'Not yet', Received: 'Not yet', Printing: 'Not yet', Ready: 'Ready to deliver', Delivered: 'Delivered' };
const ASSET_ROUTES = ASSET_PORTAL_NAV.map((n) => n.route);
// A browser address of an asset vendor -> where it really goes: one of its four pages, else its Dashboard.
function assetPortalRouteFor(pathname) {
  const p = pathOf(pathname);
  return ASSET_ROUTES.includes(p) ? p : ASSET_PORTAL_HOME;
}

module.exports = {
  ROLE_LABEL,
  TELECOM_PORTAL_NAV, TELECOM_PORTAL_HOME, TELECOM_API_PREFIX, isTelecomApiPath, telecomPortalRouteFor,
  IDCARD_PORTAL_MODULES, IDCARD_PORTAL_NAV, IDCARD_PORTAL_HOME, IDCARD_API_PREFIX, IDCARD_FLOW, IDCARD_BUCKETS, IDCARD_PRINTING, IDCARD_DELIVERY, isIdCardApiPath, kindOwningPath, idCardPortalRouteFor,
  ASSET_PORTAL_NAV, ASSET_PORTAL_HOME, ASSET_API_PREFIX, FINANCE_ONLY_PREFIXES, isAssetApiPath, isFinanceOnlyPath, portalPathAllowedFor, assetPortalRouteFor,
  PORTAL_NAV, PORTAL_HOME, PORTAL_PUBLIC_PREFIXES, PORTAL_SESSION_PREFIXES, portalPathAllowed, portalRouteFor,
  MODULES, CORE, CATEGORIES, DEFAULT_CATEGORY, LEGACY_MODULES,
  resolveCategory, modulesForCategory, defaultPermissions, permAllowed, publicRegistry, norm,
};
