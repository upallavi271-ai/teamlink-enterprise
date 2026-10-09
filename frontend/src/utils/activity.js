// When the person last touched the page (2026-10-09, sign-in sessions).
//
// api.js sends `x-tl-idle-ms` on every request: the milliseconds since the
// last keypress, click, scroll or mouse movement. The server counts THAT as
// activity, not the request itself, so the screens that refresh themselves
// every minute never keep an unattended session alive (backend
// utils/authSessions.js). The Job Portal does the same, and the two share one
// 30-minute inactivity timeout.
let last = Date.now();
let lastMove = 0;

function mark() { last = Date.now(); }

if (typeof window !== 'undefined') {
  ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => {
    window.addEventListener(ev, mark, { passive: true, capture: true });
  });
  window.addEventListener('mousemove', () => {
    const now = Date.now();
    if (now - lastMove > 5000) { lastMove = now; mark(); }
  }, { passive: true, capture: true });
}

export function idleMs() {
  return Math.max(0, Date.now() - last);
}
