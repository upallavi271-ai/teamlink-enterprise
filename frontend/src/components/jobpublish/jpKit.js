import { useEffect, useRef, useState } from 'react';
import api from '../../api';

// ---------------------------------------------------------------------------
// Shared bits for the job publishing screens (backend: /api/job-publish, docs/job-publishing/API.md).
// Honest words: "Posted" ONLY when the API says PUBLISHED. Nothing here posts by itself.
// ---------------------------------------------------------------------------
export const PORTALS = [
  { key: 'naukri', name: 'Naukri', kind: 'browser' },
  { key: 'foundit', name: 'Foundit', kind: 'browser' },
  { key: 'shine', name: 'Shine', kind: 'browser' },
  { key: 'linkedin', name: 'LinkedIn (manual)', short: 'LinkedIn', kind: 'manual' },
  { key: 'career', name: 'Internal careers page', short: 'Careers page', kind: 'internal' },
  { key: 'telegram', name: 'Telegram channel', short: 'Telegram', kind: 'api' },
  { key: 'facebook', name: 'Facebook page', short: 'Facebook', kind: 'api' },
  { key: 'instagram', name: 'Instagram', short: 'Instagram', kind: 'api' },
  { key: 'threads', name: 'Threads', short: 'Threads', kind: 'api' },
  { key: 'linkedinpost', name: 'LinkedIn post', short: 'LinkedIn post', kind: 'api' },
];
export const portalName = (k) => (PORTALS.find((p) => p.key === k) || { name: k }).name;

export const jp = {
  get: (path, params) => api.get(`/job-publish${path}`, { params }).then((r) => r.data),
  post: (path, body, cfg) => api.post(`/job-publish${path}`, body || {}, cfg).then((r) => r.data),
  put: (path, body) => api.put(`/job-publish${path}`, body || {}).then((r) => r.data),
  del: (path) => api.delete(`/job-publish${path}`).then((r) => r.data),
};

export const NOT_ON_WORDS = 'Job publishing is not switched on yet. Ask the team that looks after TeamLink to switch it on.';
export const isNotMigrated = (e) => !!(e && e.response && e.response.status === 503 && (!e.response.data || !e.response.data.code || e.response.data.code === 'NOT_MIGRATED'));
export function jpError(e, fallback = 'That did not work. Please try again.') {
  if (isNotMigrated(e)) return NOT_ON_WORDS;
  const s = e && e.response && e.response.status;
  if (s === 429) return 'Too many tries. Wait a minute and try again.';
  return (e && e.response && e.response.data && e.response.data.error) || fallback;
}

export const when = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const dur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// Run `fn` every `ms` while `active` and the tab is visible. Stops on unmount. (5-10 s, only while a run is going)
export function useVisiblePoll(fn, active, ms = 7000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const tick = () => { if (!document.hidden) ref.current(); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [active, ms]);
}

// Is the engine switched on? null = still asking.
export function useEngineHealth() {
  const [h, setH] = useState(null);
  useEffect(() => {
    let live = true;
    jp.get('/health').then((d) => { if (live) setH(d); }).catch((e) => { if (live) setH({ migrated: false, failed: !isNotMigrated(e), error: jpError(e) }); });
    return () => { live = false; };
  }, []);
  return h;
}

// CSV for the rows that are on screen (the API has no export for the queue or logs)
export function downloadCsv(name, header, rows) {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const text = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// Format hints for a login typed in a form (the server checks again and is the one that refuses; this only catches slips
// while typing). -> { problems: [], warnings: [] }   Same rules as backend/src/jobPublish/credentials.js validateLogin.
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE_RE = /^\+?[0-9][0-9 -]{8,14}[0-9]$/;
export function checkLoginFormat(name, { username = '', password = '' } = {}, first = false) {
  const problems = []; const warnings = [];
  const u = String(username).trim(); const p = String(password).trim();
  if (first && !u) problems.push('Type the login name (usually the work e-mail).');
  if (first && !p) problems.push('Type the password.');
  if (u) {
    if (u.length < 3) problems.push('The login name is too short.');
    else if (u.includes('@') && !EMAIL_RE.test(u)) problems.push('This looks like an e-mail but is not complete (for example name@company.com).');
    else if (!u.includes('@') && !MOBILE_RE.test(u)) warnings.push(`${name} logins are usually an e-mail address or a mobile number.`);
    if (/\s/.test(u)) problems.push('The login name has a space inside it.');
  }
  if (p) {
    if (p.length < 6) problems.push('The password is too short (at least 6 characters).');
    if (u && p.toLowerCase() === u.toLowerCase()) problems.push('The password is the same as the login name.');
  }
  return { problems, warnings };
}

// The result of Test connection: icon colour for each state
export const TEST_TONE = {
  NOT_TESTED: 'grey', TESTING: 'blue', CONNECTED: 'green', NOT_ADMIN: 'yellow', CHANNEL_NOT_FOUND: 'yellow', WRONG_LOGIN: 'red', NEEDS_OTP: 'yellow', NEEDS_CAPTCHA: 'yellow', NEEDS_CHECK: 'yellow', BLOCKED: 'red', PORTAL_DOWN: 'yellow', PAGE_CHANGED: 'red', NO_BROWSER: 'red', ERROR: 'red',
};
export const fileSize = (b) => (b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
