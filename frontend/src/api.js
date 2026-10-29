import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

// SUPER ADMIN "VIEW AS" (components/ViewAs.jsx): a read-only token kept in
// THIS TAB's sessionStorage wins over the normal login token, so viewing as
// somebody in one tab never changes the Super Admin's other tabs.
export const VIEW_AS_KEY = 'tl_viewas_token';
export function viewAsToken() {
  try { return sessionStorage.getItem(VIEW_AS_KEY) || null; } catch { return null; }
}
// "Act as" (edit) uses the same slot; this says which kind of token is in it.
export const ACT_MODE_KEY = 'tl_viewas_mode';
export function actAsMode() {
  try { return viewAsToken() && sessionStorage.getItem(ACT_MODE_KEY) === 'act'; } catch { return false; }
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
  // A SAVE while the server is restarting (2026-10-29: "Resume client" pressed during a deploy showed only "That did not
  // work"): never sent twice, but every screen now shows why - the screens read err.response.data.error.
  if (config && (config.method || 'get').toLowerCase() !== 'get' && error.response && [502, 503, 504].includes(status)) {
    const d = error.response.data;
    if (!d || typeof d !== 'object' || !d.error) error.response.data = { error: 'TeamLink is restarting for an update. Nothing was saved. Wait a minute and try again.', code: 'SERVER_RESTARTING' };
  }
  if (!config || (config.method || 'get').toLowerCase() !== 'get' || !unreachable) throw error;
  config.retryCount = (config.retryCount || 0) + 1;
  if (config.retryCount > RETRY_DELAYS.length) throw error;
  await new Promise((resolve) => { setTimeout(resolve, RETRY_DELAYS[config.retryCount - 1]); });
  return api(config);
});

// PASSWORD CHANGED ELSEWHERE (reset link / Admin reset): the server ends older
// sign-ins. This browser's token is dead, so go back to the sign-in page.
api.interceptors.response.use(undefined, (error) => {
  if (error.response?.status === 401 && error.response?.data?.code === 'PASSWORD_CHANGED' && !viewAsToken()) {
    try { localStorage.removeItem('tl_token'); } catch { /* nothing stored */ }
    if (!['/login', '/forgot-password', '/new-password'].includes(window.location.pathname)) window.location.assign('/login');
  }
  throw error;
});

// View as: a write the server refused as read-only is announced to the banner
// (a toast) as well as returned to the screen; an ended / expired View-as
// session drops this tab's token and goes back to the Super Admin.
api.interceptors.response.use(undefined, (error) => {
  const status = error.response?.status;
  const data = error.response?.data || {};
  if (status === 403 && (data.viewAsReadOnly || data.actAsBlocked)) {
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

// ACT AS: a send that really reaches a person (409 ACT_CONFIRM_SEND) asks first, in plain
// words, then repeats the same call with X-Act-Confirm. "No" leaves the original error.
api.interceptors.response.use(undefined, async (error) => {
  const config = error.config;
  const data = error.response?.data;
  if (!config || error.response?.status !== 409 || !data || data.code !== 'ACT_CONFIRM_SEND' || config.actConfirmed) throw error;
  const yes = await new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('tl:actas-confirm', { detail: { text: data.error, resolve } }));
    setTimeout(() => resolve(false), 120000);
  });
  if (!yes) { error.response.data = { ...data, error: 'Not sent.', cancelled: true }; throw error; }
  return api({ ...config, actConfirmed: true, headers: { ...(config.headers || {}), 'X-Act-Confirm': 'send' } });
});

// B8 OVERRIDE: adding a person who does not meet a job's rules (POST
// /applications → 409 NEEDS_OVERRIDE) asks for a reason, for EVERY "Add to
// job" button at once, and sends the same request again with it. Cancel
// leaves the original error with the caller (nothing is added).
api.interceptors.response.use(undefined, async (error) => {
  const config = error.config;
  const data = error.response?.data;
  if (!config || error.response?.status !== 409 || !data || data.code !== 'NEEDS_OVERRIDE' || config.b8OverrideAsked) throw error;
  // B9.11: POST /candidates with "Apply to job" asks the same question.
  if (!/\/(applications|candidates)\/?$/.test(String(config.url || '')) || (config.method || '').toLowerCase() !== 'post') throw error;
  const { askOverrideReason } = await import('./components/match/OverridePrompt.jsx');
  const reason = await askOverrideReason(data);
  if (!reason) {
    error.response.data = { ...data, error: 'Not added.', cancelled: true };
    throw error;
  }
  let body = config.data;
  try { body = typeof body === 'string' ? JSON.parse(body) : (body || {}); } catch { body = {}; }
  return api({ ...config, b8OverrideAsked: true, data: { ...body, overrideReason: reason } });
});

// ALREADY ON THIS JOB: POST /applications answers 409 ALREADY_APPLIED { application, others } when the person is already on
// the job. EVERY "Add application" button gets the same clear panel (where it is, the step, who added it, [Open this
// application]) - no screen keeps its own tiny red line for it. A bulk add passes { noAlreadyPanel: true } and reports per row.
api.interceptors.response.use(undefined, (error) => {
  const data = error.response?.data;
  if (error.response?.status === 409 && data && data.code === 'ALREADY_APPLIED' && data.application) {
    error.alreadyApplied = true;
    if (!error.config?.noAlreadyPanel) {
      import('./components/applications/AlreadyApplied.jsx').then((m) => m.openAlreadyApplied(data)).catch(() => null);
    }
  }
  throw error;
});

// DUPLICATE HOLD: a move out of the first step is refused (409 DUPLICATE_OPEN) while the person looks like someone already
// on file. Every screen shows the server's plain-words message; this opens the "Check duplicates" window for that person
// as well, so the way out is one click away wherever the move came from.
api.interceptors.response.use(undefined, (error) => {
  const data = error.response?.data;
  if (error.response?.status === 409 && data && data.code === 'DUPLICATE_OPEN' && data.candidateId) {
    import('./components/duplicates/openDup.jsx').then((m) => m.openDupPanel({ candidateId: data.candidateId, message: data.error })).catch(() => null);
  }
  throw error;
});

export default api;
