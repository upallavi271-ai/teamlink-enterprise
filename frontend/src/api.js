import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// SUPER ADMIN "VIEW AS" (components/ViewAs.jsx): a read-only token kept in
// THIS TAB's sessionStorage wins over the normal login token, so viewing as
// somebody in one tab never changes the Super Admin's other tabs.
export const VIEW_AS_KEY = 'tl_viewas_token';
export function viewAsToken() {
  try { return sessionStorage.getItem(VIEW_AS_KEY) || null; } catch { return null; }
}

api.interceptors.request.use((config) => {
  const token = viewAsToken() || localStorage.getItem('tl_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// A READ THAT MEETS A RESTARTING SERVER TRIES AGAIN. While the backend
// reloads (a deploy, a dev-server restart) it answers nothing for a few
// seconds, and a screen that loaded in that window used to show its empty
// state — "No recruiters in your scope" — as if that were the truth. GETs
// only: they are safe to repeat; a save is never sent twice.
const RETRY_DELAYS = [700, 1200, 1800, 2500];
api.interceptors.response.use(undefined, async (error) => {
  const config = error.config;
  const status = error.response?.status;
  const unreachable = !error.response || [502, 503, 504].includes(status)
    // Vite's dev proxy answers 500 with an empty body when the API is down.
    || (status === 500 && !error.response.data);
  if (!config || (config.method || 'get').toLowerCase() !== 'get' || !unreachable) throw error;
  config.retryCount = (config.retryCount || 0) + 1;
  if (config.retryCount > RETRY_DELAYS.length) throw error;
  await new Promise((resolve) => { setTimeout(resolve, RETRY_DELAYS[config.retryCount - 1]); });
  return api(config);
});

// View as: a write the server refused as read-only is announced to the banner
// (a toast) as well as returned to the screen; an ended / expired View-as
// session drops this tab's token and goes back to the Super Admin.
api.interceptors.response.use(undefined, (error) => {
  const status = error.response?.status;
  const data = error.response?.data || {};
  if (status === 403 && data.viewAsReadOnly) {
    window.dispatchEvent(new CustomEvent('tl:viewas-blocked', { detail: data.error }));
  } else if (status === 401 && viewAsToken()) {
    try {
      sessionStorage.removeItem(VIEW_AS_KEY);
      sessionStorage.setItem('tl_viewas_notice', data.error || 'View as ended.');
    } catch { /* nothing stored */ }
    window.location.assign('/admin/view-as');
  }
  throw error;
});

export default api;
