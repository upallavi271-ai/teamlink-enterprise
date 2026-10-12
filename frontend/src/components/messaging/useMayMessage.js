import { useEffect, useState } from 'react';
import api from '../../api';

// Does the SERVER let this login message this kind of person?
// (GET /messaging/channels -> audiences.{candidates|clients|employees} = ONE person, bulk.{…} = MANY at once;
// the same rules the send routes enforce.) null while loading, false = show no button.
// One short-lived shared answer so a page with many buttons asks once.
let cached = null;
let cachedAt = 0;
let cachedFor = '';
const who = () => { try { return localStorage.getItem('tl_token') || ''; } catch { return ''; } };
function load() {
  if (!cached || cachedFor !== who() || Date.now() - cachedAt > 60000) {
    cachedAt = Date.now(); cachedFor = who();
    cached = api.get('/messaging/channels').then((r) => r.data || {}).catch(() => { cached = null; return {}; });
  }
  return cached;
}

// useMayMessage('clients')            may I contact ONE client contact (the Contact button)
// useMayMessage('clients', true)      may I message MANY clients at once (the bulk button)
export function useMayMessage(audience, bulk = false) {
  const [ok, setOk] = useState(null);
  useEffect(() => {
    let on = true;
    load().then((d) => { if (on) setOk(!!((bulk ? d.bulk : d.audiences) || {})[audience]); });
    return () => { on = false; };
  }, [audience, bulk]);
  return ok === true;
}

// The full answer for one kind of person: { loaded, allowed, masked, reason, purposes, channels, call, switchOn }.
// masked = the login must not see the number: the server uses it, the screen shows a hint.
export function useContactRule(audience) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let on = true;
    load().then((x) => { if (on) setD(x); });
    return () => { on = false; };
  }, []);
  if (!d) return { loaded: false, allowed: false, masked: false, reason: '', purposes: null, channels: null, call: null };
  return {
    loaded: true,
    allowed: !!(d.audiences || {})[audience],
    masked: (d.modes || {})[audience] === 'masked',
    reason: (d.reasons || {})[audience] || '',
    purposes: (d.purposes || {})[audience] || null,
    channels: d.channels || null,
    call: d.call || null,
    switchOn: d.switchOn,
    quiet: d.quiet,
  };
}
export default useMayMessage;
