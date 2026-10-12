import { createElement, Fragment, useEffect, useState } from 'react';
import api from '../../api';

// Shared pieces of the messaging screens (Message templates, Send a message,
// Send to many): the details a message can contain, a live preview renderer
// that matches the server's, the SMS length counter, and plain status words.

let tokenPromise = null;
export function loadTokens() {
  if (!tokenPromise) {
    tokenPromise = api.get('/messaging/templates/tokens').then((r) => r.data).catch((e) => { tokenPromise = null; throw e; });
  }
  return tokenPromise;
}
export function useTokens() {
  const [data, setData] = useState(null);
  useEffect(() => { let on = true; loadTokens().then((d) => { if (on) setData(d); }).catch(() => {}); return () => { on = false; }; }, []);
  return data;
}

const RE = /\{\{\s*([A-Za-z_]\w*)\s*\}\}|\{([A-Za-z_]\w*)\}/g;

export function canonMap(tokens) {
  const m = {};
  (tokens || []).forEach((t) => { m[t.key] = t.key; (t.aliases || []).forEach((a) => { m[a] = t.key; }); });
  return m;
}

// Fill with sample values -> { text, parts } where parts marks which pieces are filled (for highlighting).
export function renderSample(text, tokens) {
  const canon = canonMap(tokens);
  const sample = Object.fromEntries((tokens || []).map((t) => [t.key, t.sample]));
  const parts = [];
  let last = 0;
  const s = String(text || '');
  s.replace(RE, (m, a, b, idx) => {
    if (idx > last) parts.push({ t: s.slice(last, idx) });
    const c = canon[a || b];
    parts.push(c ? { t: sample[c], filled: true } : { t: m, unknown: true });
    last = idx + m.length;
    return m;
  });
  if (last < s.length) parts.push({ t: s.slice(last) });
  return { text: parts.map((p) => p.t).join(''), parts };
}

export function unknownIn(text, tokens) {
  const canon = canonMap(tokens);
  const out = [];
  String(text || '').replace(RE, (m, a) => { if (a && !canon[a] && !out.includes(a)) out.push(a); return m; });
  return out;
}

const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const EXT = '^{}\\[~]|€';
export function smsInfo(text) {
  const s = String(text || '');
  let len = 0; let gsm = true;
  for (const ch of s) { if (GSM.includes(ch)) len += 1; else if (EXT.includes(ch)) len += 2; else { gsm = false; break; } }
  if (!gsm) { const n = [...s].length; return { chars: n, unicode: true, segments: n === 0 ? 0 : (n <= 70 ? 1 : Math.ceil(n / 67)), per: n <= 70 ? 70 : 67 }; }
  return { chars: len, unicode: false, segments: len === 0 ? 0 : (len <= 160 ? 1 : Math.ceil(len / 153)), per: len <= 160 ? 160 : 153 };
}

// Plain words for a send result.
export const STATUS_WORD = { queued: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped', blocked: 'Blocked' };
export const STATUS_CLASS = { sent: 'active', failed: 'rejected', blocked: 'rejected', skipped: 'pending', queued: 'review', sending: 'review' };
export const CHANNEL_ICON = { Email: '✉️', SMS: '💬', WhatsApp: '🟢', Call: '📞' };
export const WA_STATUS_CLASS = { Approved: 'active', Pending: 'pending', Rejected: 'rejected', None: 'pending' };
export const WA_STATUS_WORD = { Approved: 'Approved by Meta', Pending: 'Waiting for Meta', Rejected: 'Rejected by Meta', None: 'Not sent to Meta yet' };

export function canManageTemplates(user) {
  const roles = [user && user.role, user && user.hrmsRole, user && user.atsRole].filter(Boolean);
  return roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'HR', 'TL'].includes(r));
}
export function canSeeTemplates(user) {
  const roles = [user && user.role, user && user.hrmsRole, user && user.atsRole].filter(Boolean);
  return roles.some((r) => ['SUPER_ADMIN', 'ADMIN', 'HR', 'TL', 'MANAGER', 'ASSISTANT_MANAGER', 'STL'].includes(r));
}

// --- shared by the send windows -------------------------------------------------
const ONE = { candidates: 'candidate', clients: 'client', employees: 'employee' };

export function useUsable(audience) {
  const [list, setList] = useState(null);
  useEffect(() => {
    let on = true;
    let tries = 0;
    const load = () => api.get('/messaging/templates/usable', { params: { audience: ONE[audience] || 'candidate' } })
      .then((r) => { if (on) setList(r.data.templates || []); })
      .catch(() => { tries += 1; if (on && tries < 5) setTimeout(load, 1500); else if (on) setList([]); });
    load();
    return () => { on = false; };
  }, [audience]);
  return list;
}

export function useChannels() {
  const [st, setSt] = useState(null);
  useEffect(() => { api.get('/messaging/channels').then((r) => setSt(r.data.channels)).catch(() => setSt(null)); }, []);
  return st;
}

// purposes that have a template on at least one of the chosen channels
export function purposesFor(list, channels) {
  const map = new Map();
  (list || []).filter((t) => channels.includes(t.channel)).forEach((t) => {
    if (!map.has(t.purpose)) map.set(t.purpose, { key: t.purpose, label: t.purposeLabel, languages: new Set(), channels: new Set() });
    const e = map.get(t.purpose);
    e.languages.add(t.language); e.channels.add(t.channel);
  });
  // the "Contact button" purposes (Interview Reminder, Document Request …) come first, then the rest A-Z
  const rank = (p) => (String(p.key).startsWith('FU_') ? 0 : 1);
  return [...map.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
export function templateFor(list, purpose, channel, language) {
  const rows = (list || []).filter((t) => t.purpose === purpose && t.channel === channel);
  return rows.find((t) => t.language === language && t.isDefault) || rows.find((t) => t.language === language)
    || rows.find((t) => t.language === 'English' && t.isDefault) || rows.find((t) => t.language === 'English') || rows[0] || null;
}


export function Highlighted({ text }) {
  // {{details}} that could not be filled stay visible, in red.
  const parts = String(text || '').split(/({{s*w+s*}})/g);
  return createElement(Fragment, null, parts.map((p, i) => (/^{{/.test(p) ? createElement('mark', { key: i, className: 'bad' }, p) : createElement('span', { key: i }, p))));
}
