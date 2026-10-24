import { useEffect, useRef, useState } from 'react';
import { shouldRefresh, clock, EVERY_MS, FOCUS_MIN_MS } from './autoRefreshRule.js';

// A list that keeps itself fresh WITHOUT a page reload (2026-10-19). New assets and new repair jobs reach the vendor by themselves (HRMS and Accounts feed the
// same tables); this hook only asks the server again: every 60 seconds while the tab is visible (a hidden tab asks nothing), and at once when the tab comes
// back into view or the window gets focus if the data is older than 15 seconds. It shows "Updated 14:32". No AI model, no socket: one ordinary request a minute.
export { shouldRefresh, clock, EVERY_MS, FOCUS_MIN_MS };

export default function useAutoRefresh(load, data) {
  const [updatedAt, setUpdatedAt] = useState(null);
  const last = useRef(Date.now());
  const fn = useRef(load);
  fn.current = load;
  useEffect(() => { if (data) { last.current = Date.now(); setUpdatedAt(new Date()); } }, [data]);
  useEffect(() => {
    const go = (reason) => {
      if (shouldRefresh({ hidden: document.hidden, now: Date.now(), last: last.current, reason })) { last.current = Date.now(); fn.current(); }
    };
    const timer = setInterval(() => go('timer'), 15000);
    const onVis = () => go('focus');
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, []);
  return { updatedAt, text: updatedAt ? `Updated ${clock(updatedAt)}` : '' };
}
