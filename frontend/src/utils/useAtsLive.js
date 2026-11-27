import { useEffect, useRef, useState } from 'react';
import api from '../api';

// ---------------------------------------------------------------------------
// KEEP AN OPEN ATS SCREEN UP TO DATE (founder 2026-11-27: "ats lo updates ayina prathi saari, annitlo update avvali. search bar lo kuda, including
// joinings, rejections etc... anni... yeppatikappudu modify avvali").
//
//   const live = useAtsLive();   ... useEffect(load, [id, key, live]);
//
// Every 20 seconds (while the tab is in front) it asks the server whether ATS data changed (GET /ats/history/version - one number, raised by every
// write: a screen, an import, the portal sync, a bulk move). When it did, `live` goes up and the screen loads its numbers again - at most once a
// minute, and at once when the person comes back to the tab. Nothing is asked while the tab is hidden.
// ---------------------------------------------------------------------------
export default function useAtsLive({ every = 60000 } = {}) {
  const [tick, setTick] = useState(0);
  const seen = useRef(null);
  const last = useRef(Date.now());
  useEffect(() => {
    let alive = true;
    const check = async (now) => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const r = await api.get('/ats/history/version');
        const v = r && r.data ? r.data.v : null;
        if (!alive || v == null) return;
        if (seen.current === null) { seen.current = v; return; }
        if (v !== seen.current && (now || Date.now() - last.current >= every)) {
          seen.current = v;
          last.current = Date.now();
          setTick((t) => t + 1);
        }
      } catch { /* offline: the next look */ }
    };
    check(false);
    const timer = setInterval(() => check(false), 20000);
    const onShow = () => { if (!document.hidden) check(true); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
    };
  }, [every]);
  return tick;
}
