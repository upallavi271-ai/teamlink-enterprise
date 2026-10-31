import api from '../../api';

// ---------------------------------------------------------------------------
// Shared bits for the job distribution screens (backend: /api/job-dist, docs/job-publishing/DISTRIBUTE.md).
// Honest words: a place a PERSON marked is "Posted by <name> (not checked by the system)": the words come from the server.
// ---------------------------------------------------------------------------
export const dx = {
  get: (path, params) => api.get(`/job-dist${path}`, { params }).then((r) => r.data),
  post: (path, body) => api.post(`/job-dist${path}`, body || {}).then((r) => r.data),
  put: (path, body) => api.put(`/job-dist${path}`, body || {}).then((r) => r.data),
  del: (path) => api.delete(`/job-dist${path}`).then((r) => r.data),
};

export const NOT_ON_WORDS = 'Distribution is not switched on yet. Ask the team that looks after TeamLink to switch it on.';
export const isNotMigrated = (e) => !!(e && e.response && e.response.status === 503 && e.response.data && e.response.data.code === 'NOT_MIGRATED');
export function dxError(e, fallback = 'That did not work. Please try again.') {
  if (isNotMigrated(e)) return NOT_ON_WORDS;
  if (e && e.response && e.response.status === 429) return 'Too many tries. Wait a minute and try again.';
  return (e && e.response && e.response.data && e.response.data.error) || fallback;
}

export const KIND_WORDS = { auto: 'Automatic', semi: 'Copy and post', manual: 'By hand' };
export const KIND_HINT = {
  auto: 'TeamLink does this one by itself.',
  semi: 'TeamLink writes the text and the link. You open the site and post it.',
  manual: 'Send it yourself (e-mail or message). TeamLink writes the text.',
};
export const MEDIUM_WORDS = {
  job_board: 'Job site', social: 'Social media', careers: 'Our careers page', search: 'Search engine', feed: 'Job feed', campus: 'Colleges', referral: 'Our own team', messaging: 'Chat group',
};

// Copy to the clipboard (works on plain http too); -> true when it worked
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}

export const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const fmtDateTime = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
// <input type="datetime-local"> value for now, and <input type="date"> value for now + n days
const pad = (n) => String(n).padStart(2, '0');
export const localInput = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const plusDays = (n, from = new Date()) => new Date(from.getTime() + n * 86400000);

// the names of the default places (when the list is not loaded yet)
export const PLACE_NAMES = {
  career: 'Own job portal', google: 'Google for Jobs', feed: 'RSS / XML feed', telegram: 'Telegram channel', facebook: 'Facebook page', instagram: 'Instagram', threads: 'Threads', linkedinpost: 'LinkedIn post', linkedin: 'LinkedIn', indeed: 'Indeed', naukri: 'Naukri', shine: 'Shine', foundit: 'Foundit',
  apna: 'Apna', workindia: 'WorkIndia', freshersworld: 'Freshersworld', quikr: 'Quikr Jobs', olx: 'OLX Jobs', ncs: 'NCS portal', whatsapp: 'WhatsApp', college: 'College placement cells', referral: 'Employee referral',
};
export const placeName = (k) => PLACE_NAMES[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : '');
