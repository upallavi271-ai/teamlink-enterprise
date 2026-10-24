import { useEffect, useRef } from 'react';
import { pollDelay } from './waChatLogic.js';

// Run `fn(signal)` every `baseMs` while the page is visible (a hidden tab does not ask the server anything).
//   * a failed try waits longer (doubles, at most 8x: waChatLogic.pollDelay) and a good try goes back to the base time
//   * `fn` may return false to stop for good (for example when the server says this login has no chats)
//   * coming back to the tab asks again after a moment
//   * leaving the screen aborts the request in flight and stops the timer
export default function useVisiblePoll(fn, baseMs, { enabled = true, key = '' } = {}) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return undefined;
    let stop = false; let timer = null; let fails = 0;
    const ctrl = new AbortController();
    const arm = (ms) => { clearTimeout(timer); if (!stop) timer = setTimeout(tick, ms); }; // eslint-disable-line no-use-before-define
    async function tick() {
      if (stop) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { arm(baseMs); return; }
      try {
        const keep = await ref.current(ctrl.signal);
        if (keep === false) { stop = true; return; }
        fails = 0;
      } catch (e) {
        if (stop || (e && (e.code === 'ERR_CANCELED' || e.name === 'CanceledError' || e.name === 'AbortError'))) return;
        fails += 1;
      }
      arm(pollDelay(baseMs, fails));
    }
    arm(baseMs);
    const onVisible = () => { if (document.visibilityState === 'visible') arm(600); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; ctrl.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [baseMs, enabled, key]);
}
