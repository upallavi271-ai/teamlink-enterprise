import axios from 'axios';

// THE VENDOR PORTAL'S OWN API CLIENT (P3). A vendor token lives under its own
// key and is sent ONLY to /api/vendor-portal — never through ../api.js, so a
// vendor session and a staff session can never mix. The server refuses a
// vendor token on every other API anyway (utils/vendorAuth.js).
export const VENDOR_TOKEN_KEY = 'tl_vendor_token';
export const VENDOR_NOTICE_KEY = 'tl_vendor_notice';

export function vendorToken() {
  try { return localStorage.getItem(VENDOR_TOKEN_KEY) || null; } catch { return null; }
}
export function setVendorToken(t) {
  try { if (t) localStorage.setItem(VENDOR_TOKEN_KEY, t); else localStorage.removeItem(VENDOR_TOKEN_KEY); } catch { /* storage blocked */ }
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
