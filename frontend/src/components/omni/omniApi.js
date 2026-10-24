// Calls to /api/outreach with the picked workspace (department) added as ?dept= when one is picked.
// omni.get('/gs/campaigns/list', { channel: 'whatsapp' }) ...  Server routes ignore a dept this login may not see.
import api from '../../api';
import { getState } from './omniStore.js';

const withDept = (params) => { const d = getState().dept; return d ? { dept: d, ...(params || {}) } : (params || {}); };
export const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
export const omni = {
  get: (path, params, cfg) => api.get(`/outreach${path}`, { ...(cfg || {}), params: withDept(params) }).then((r) => r.data),
  post: (path, body, cfg) => api.post(`/outreach${path}`, body || {}, cfg).then((r) => r.data),
  put: (path, body, cfg) => api.put(`/outreach${path}`, body || {}, cfg).then((r) => r.data),
  del: (path, params) => api.delete(`/outreach${path}`, { params }).then((r) => r.data),
  blob: (path, params) => api.get(`/outreach${path}`, { params: withDept(params), responseType: 'blob' }).then((r) => r.data),
};
export default omni;

// The shared Omni-Channel API (/api/omni): the template library, campaigns from app screens, replies, connections. Used by the Omni-Channel tabs AND by the app screens
// (ATS, Job Portal, HRMS, Accounts), so it has no workspace parameter: the server holds every call to what the login may see.
export const shared = {
  get: (path, params) => api.get(`/omni${path}`, { params }).then((r) => r.data),
  post: (path, body) => api.post(`/omni${path}`, body || {}).then((r) => r.data),
  put: (path, body) => api.put(`/omni${path}`, body || {}).then((r) => r.data),
  del: (path) => api.delete(`/omni${path}`).then((r) => r.data),
};
