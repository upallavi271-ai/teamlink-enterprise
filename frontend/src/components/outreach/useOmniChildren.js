import { useEffect, useMemo, useState } from 'react';
import api from '../../api';
import { omniAllowed } from './access.js';
import { omniChildren } from '../omni/omniPages.js';
import { useOmniStore, startChrome } from '../omni/omniStore.js';

// The sidebar children of Omni-Channel for the signed-in login (null = not known yet / no Omni-Channel). Asks the server once per login
// (GET /api/outreach/me) so the children are exactly the pages the server will open (the Green Start page tree, omni/omniPages.js); a login the
// server refuses sees no Omni-Channel group. The numbers next to WhatsApp (unread replies) and Campaigns (waiting for approval) come from the shared store.
let cache = null;
// GREEN START (2026-10-21): also tells the Shell whether this login gets the founder's Green Start product when it clicks Omni-Channel (acc.greenStart,
// from outreach/access.js mayGreenStart: Admin, Manager / AM, TL / STL, HR). The others keep the native Omni-Channel group with its pages.
export function useOmniEntry(user) {
  const kids = useOmniChildren(user);
  return { kids, greenStart: !!(kids && kids.length && cache && cache.uid === (user && user.id) && cache.acc && cache.acc.greenStart) };
}
export default function useOmniChildren(user) {
  const uid = user && user.id;
  const [acc, setAcc] = useState(cache && cache.uid === uid ? cache.acc : null);
  const store = useOmniStore();
  useEffect(() => {
    if (!omniAllowed(user)) { setAcc(null); return undefined; }
    let on = true;
    let timer = null;
    // Only a real refusal (401/403) hides the group. A failed request while the server restarts (network error, 5xx) must NOT make
    // Omni-Channel vanish: try again every 3 seconds (founder, 2026-10-17: 'the entire Omni-Channel was gone').
    const load = (attempt) => api.get('/outreach/me')
      .then((r) => { cache = { uid, acc: r.data }; if (on) setAcc(r.data); startChrome(uid); })
      .catch((e) => {
        const st = e && e.response && e.response.status;
        if (st === 401 || st === 403) { if (on) setAcc({ level: 'none', pages: [] }); return; }
        if (on && attempt < 40) timer = setTimeout(() => load(attempt + 1), 3000);
      });
    load(0);
    return () => { on = false; if (timer) clearTimeout(timer); };
  }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => (acc ? omniChildren(acc, store.badges) : null), [acc, store.badges]);
}
