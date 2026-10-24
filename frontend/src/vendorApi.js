import axios from 'axios';

// THE VENDOR PORTAL'S OWN API CLIENT (P3). A vendor token lives under its own
// key and is sent ONLY to /api/vendor-portal — never through ../api.js, so a
// vendor session and a staff session can never mix. The server refuses a
// vendor token on every other API anyway (utils/vendorAuth.js).
export const VENDOR_TOKEN_KEY = 'tl_vendor_token';
export const VENDOR_NOTICE_KEY = 'tl_vendor_notice';

// An Admin PREVIEW session lives in this TAB only (sessionStorage), so the
// staff Admin's other tabs keep their own staff session untouched.
export const VENDOR_PREVIEW_KEY = 'tl_vendor_preview_token';
export function setPreviewToken(t) {
  try { if (t) sessionStorage.setItem(VENDOR_PREVIEW_KEY, t); else sessionStorage.removeItem(VENDOR_PREVIEW_KEY); } catch { /* storage blocked */ }
}
export function vendorToken() {
  try { return sessionStorage.getItem(VENDOR_PREVIEW_KEY) || localStorage.getItem(VENDOR_TOKEN_KEY) || null; } catch { return null; }
}
export function setVendorToken(t) {
  try {
    if (!t) sessionStorage.removeItem(VENDOR_PREVIEW_KEY);
    if (t) localStorage.setItem(VENDOR_TOKEN_KEY, t);
    else { localStorage.removeItem(VENDOR_TOKEN_KEY); localStorage.removeItem(VENDOR_HOME_KEY); }
  } catch { /* storage blocked */ }
}
// Where this vendor lands (the server says: Assets if any are assigned, else Invoices).
export const VENDOR_HOME_KEY = 'tl_vendor_home';
// (2026-10-19: a vendor always lands on the Dashboard; the other values are only ever accepted if the server sends them.)
const LANDINGS = ['/vendor/dashboard', '/vendor/invoices', '/vendor/payments', '/vendor/purchase-orders', '/vendor/services', '/vendor/asset-portal/dashboard', '/vendor/idcard-portal/dashboard', '/vendor/airtel-portal/bills']; // the last three: an asset vendor's, an ID card vendor's and an Airtel Bills vendor's first page
export function setVendorHome(p) {
  try { if (LANDINGS.includes(p)) localStorage.setItem(VENDOR_HOME_KEY, p); } catch { /* storage blocked */ }
}
export function vendorHome() {
  try { const p = localStorage.getItem(VENDOR_HOME_KEY); return LANDINGS.includes(p) ? p : '/vendor/dashboard'; } catch { return '/vendor/dashboard'; }
}

const vendorApi = axios.create({ baseURL: '/api/vendor-portal' });

vendorApi.interceptors.request.use((config) => {
  const t = vendorToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// Signed out on the server (logout elsewhere, 30 minutes idle, switched off,
// password reset): drop the token and go back to the vendor sign-in page.
vendorApi.interceptors.response.use(undefined, (error) => {
  const data = error.response?.data || {};
  if (error.response?.status === 401 && data.vendorSignedOut && !String(error.config?.url || '').includes('/login')) {
    setVendorToken(null);
    try { sessionStorage.setItem(VENDOR_NOTICE_KEY, data.error || 'You are signed out.'); } catch { /* ignore */ }
    if (!window.location.pathname.startsWith('/vendor-login')) window.location.assign('/vendor-login');
  }
  throw error;
});

export const vendorError = (err, fallback = 'Something went wrong. Please try again.') => {
  if (!err?.response) return 'Cannot reach the server. Check your internet and try again.';
  return err.response.data?.error || fallback;
};

// Downloads a stored file through the API (the token rides in the header).
export async function vendorDownload(url, name) {
  const res = await vendorApi.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export default vendorApi;
