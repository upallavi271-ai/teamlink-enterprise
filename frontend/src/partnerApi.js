import axios from 'axios';

// THE PARTNER PORTAL'S OWN API CLIENT (B7). A partner token lives under its
// own key and is sent ONLY to /api/partner-portal — never through ../api.js,
// so a partner session and a staff (or vendor) session can never mix. The
// server refuses a partner token on every other API anyway (utils/partnerAuth.js).
export const PARTNER_TOKEN_KEY = 'tl_partner_token';
export const PARTNER_NOTICE_KEY = 'tl_partner_notice';

export function partnerToken() {
  try { return localStorage.getItem(PARTNER_TOKEN_KEY) || null; } catch { return null; }
}
export function setPartnerToken(t) {
  try { if (t) localStorage.setItem(PARTNER_TOKEN_KEY, t); else localStorage.removeItem(PARTNER_TOKEN_KEY); } catch { /* storage blocked */ }
}

const partnerApi = axios.create({ baseURL: '/api/partner-portal' });

partnerApi.interceptors.request.use((config) => {
  const t = partnerToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// Signed out on the server (logout elsewhere, 30 minutes idle, switched off,
// password reset): drop the token and go back to the partner sign-in page.
partnerApi.interceptors.response.use(undefined, (error) => {
  const data = error.response?.data || {};
  if (error.response?.status === 401 && data.partnerSignedOut && !String(error.config?.url || '').includes('/login')) {
    setPartnerToken(null);
    try { sessionStorage.setItem(PARTNER_NOTICE_KEY, data.error || 'You are signed out.'); } catch { /* ignore */ }
    if (!window.location.pathname.startsWith('/partner-login')) window.location.assign('/partner-login');
  }
  throw error;
});

export const partnerError = (err, fallback = 'Something went wrong. Please try again.') => {
  if (!err?.response) return 'Cannot reach the server. Check your internet and try again.';
  return err.response.data?.error || fallback;
};

export default partnerApi;
