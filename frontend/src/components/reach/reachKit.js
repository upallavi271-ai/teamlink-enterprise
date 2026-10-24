import { useEffect, useState } from 'react';
import api from '../../api';
import { useContactRule, useMayMessage } from '../messaging/useMayMessage.js';

// ---------------------------------------------------------------------------
// Shared bits of the bulk Call / Message (SMS) / WhatsApp / Email buttons.
// The SERVER decides who may use them (GET /messaging/channels):
//   one   = may contact ONE candidate and sees the number (BDE / BDE TL / Accounts: no)
//   bulk  = may also message MANY at once
// ---------------------------------------------------------------------------

export const REACH_MAX = 200;

// One shared retry for every component on the page (a list has many buttons).
let fbPromise = null;
const loadFallback = () => {
  if (!fbPromise) fbPromise = api.get('/messaging/channels').then((r) => r.data || null).catch(() => { fbPromise = null; return null; });
  return fbPromise;
};

export function useReachRights() {
  const rule = useContactRule('candidates');
  const bulk = useMayMessage('candidates', true); // GET /messaging/channels -> bulk.candidates (one shared answer)
  // The shared answer can come back empty when the server was busy or restarting for a moment:
  // then ask again (a few times) instead of silently hiding the buttons.
  const failed = rule.loaded && !rule.channels;
  const [fb, setFb] = useState(null);
  useEffect(() => {
    if (!failed || fb) return undefined;
    let on = true;
    let tries = 0;
    const go = () => loadFallback().then((d) => { if (!on) return; if (d) setFb(d); else { tries += 1; if (tries < 6) setTimeout(go, 3000); } });
    const t = setTimeout(go, 1500);
    return () => { on = false; clearTimeout(t); };
  }, [failed, fb]);
  if (failed && fb) {
    const mode = (fb.modes || {}).candidates;
    const one = !!(fb.audiences || {}).candidates && mode !== 'masked';
    return { loaded: true, one, bulk: one && !!(fb.bulk || {}).candidates, call: fb.call || null, channels: fb.channels || null };
  }
  const one = rule.loaded && rule.allowed && !rule.masked;
  return { loaded: rule.loaded && !failed, one, bulk: one && bulk, call: rule.call, channels: rule.channels };
}

export const intl = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
};
export const telHref = (phone) => `tel:+${intl(phone)}`;
export const waHref = (phone, text) => `https://wa.me/${intl(phone)}?text=${encodeURIComponent(text || '')}`;
export const smsHref = (phone, text) => `sms:+${intl(phone)}?body=${encodeURIComponent(text || '')}`;
export const mailHref = (email, subject, text) => `mailto:${email}?subject=${encodeURIComponent(subject || '')}&body=${encodeURIComponent(text || '')}`;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
      const ok = document.execCommand('copy'); t.remove(); return ok;
    } catch { return false; }
  }
}

// Plain words for the count line: "31 can be messaged, 4 no consent, 2 no phone".
export const SHORT = {
  no_consent: 'no consent', no_phone: 'no phone', no_email: 'no email', duplicate: 'duplicate', outside: 'outside your access',
  not_connected: 'not connected', limit: 'over today\'s limit', quiet: 'in quiet hours', opted_out: 'said STOP', test: 'test records',
  switch_off: 'emails switched off', skipped: 'skipped', failed: 'failed',
};
export const ORDER = ['no_consent', 'no_phone', 'no_email', 'duplicate', 'outside', 'not_connected', 'limit', 'quiet', 'opted_out', 'switch_off', 'test', 'skipped', 'failed'];
export function countLine(selected, okCount, okWord, counts) {
  const rest = ORDER.filter((k) => counts && counts[k]).map((k) => `${counts[k]} ${SHORT[k]}`);
  return `You selected ${selected}: ${okCount} ${okWord}${rest.length ? `, ${rest.join(', ')}` : ''}`;
}

export const CHANNEL_LABEL = { SMS: 'SMS', WhatsApp: 'WhatsApp', Email: 'Email', Call: 'Call' };
export const CHANNEL_NOUN = { SMS: 'text message', WhatsApp: 'WhatsApp message', Email: 'email', Call: 'call' };
