// VICIDIAL click to dial (2026-11-24): the office ViciDial is on the office LAN (plain http, a private address). This HTTPS page cannot fetch it
// (mixed content / private network), so the dial link the server hands back is opened as a small POPUP window (a top-level navigation), nothing is
// read back from it, and it is closed from here after ~4 seconds. The popup must be opened inside the click (a popup opened after a wait is blocked),
// so openBlank() runs first, synchronously, and sendTo() points it at the link once the server answered.
const NAME = 'tl_vicidial';
const FEATURES = 'popup=yes,width=480,height=320,left=60,top=60';

/** Open the empty popup now (inside the click). null = the browser blocked it. */
export function openBlank() {
  let w = null;
  try { w = window.open('', NAME, FEATURES); } catch { w = null; }
  if (!w) return null;
  try {
    w.document.title = 'ViciDial';
    w.document.body.innerHTML = '<p style="font:14px system-ui,sans-serif;margin:24px">Asking ViciDial to dial&hellip; this window closes by itself.</p>';
  } catch { /* a window left over from before, already on ViciDial */ }
  return w;
}

/** Point the popup at the dial link and close it after `ms`. Answers false when there is no usable popup (blocked / closed). */
export function sendTo(w, url, ms = 4000) {
  if (!w || w.closed) return false;
  try { w.opener = null; } catch { /* not ours any more */ }
  try { w.location.replace(url); } catch { try { w.location.href = url; } catch { return false; } }
  setTimeout(() => { try { w.close(); } catch { /* the person closed it */ } }, ms);
  return true;
}

/** The "pop-ups are blocked" fallback: the person clicks the link once (a click may open a popup). */
export function openFromClick(url, ms = 4000) {
  const w = openBlank();
  if (!w) return false;
  return sendTo(w, url, ms);
}

export const closeBlank = (w) => { try { if (w && !w.closed) w.close(); } catch { /* gone */ } };
export const popupHost = () => (typeof window !== 'undefined' && window.location ? window.location.hostname : 'teamlink.teamlinks.in');
