// ---------------------------------------------------------------------------
// The sidebar "Omni-Channel" entry for the logins that may open Green Start (Admin, Manager, TL, HR). Pure decisions, no React, so a test can run them
// (backend/scripts/green-start-link-test.js). Nothing here is secret: the door pass (cookie tl_gs) is handed out by POST /api/omni-gs/session.
//
//   resolveGreenStartUrl   which address Omni-Channel opens:
//                            VITE_GREENSTART_URL = an address  -> that address (new tab)
//                            VITE_GREENSTART_URL = 'local'     -> '' (the in-page frame at /omni-channel, as on the PC)
//                            not set, host is *.teamlinks.in    -> https://greenstart.teamlinks.in (new tab)
//                            not set, anything else (localhost) -> '' (in-page frame, exactly as before)
//   openGreenStart         what a click does: no address = go to the in-page frame; otherwise open a tab FIRST (a browser only allows a new tab
//                          straight from the click), then ask TeamLink for the pass, then send the tab to Green Start. If TeamLink says no, the tab is
//                          closed and a plain message is shown. If the browser blocked the tab, Green Start opens in this tab instead.
// ---------------------------------------------------------------------------
export const LIVE_GREENSTART_URL = 'https://greenstart.teamlinks.in';

export function resolveGreenStartUrl({ envUrl, hostname } = {}) {
  const v = String(envUrl == null ? '' : envUrl).trim();
  if (v) return v.toLowerCase() === 'local' ? '' : v;
  return /(^|\.)teamlinks\.in$/i.test(String(hostname || '').trim()) ? LIVE_GREENSTART_URL : '';
}

// A plain-words reason from whatever went wrong.
export function reasonOf(err) {
  const data = err && err.response && err.response.data;
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error.trim();
  if (data && data.error && typeof data.error.message === 'string') return data.error.message;
  const st = err && err.response && err.response.status;
  if (st === 401) return 'Your TeamLink sign-in has ended. Please sign in again.';
  if (st === 403) return 'Green Start is not open for your login.';
  if (st === 404) return 'Green Start is switched off on this server.';
  if (st >= 500) return 'TeamLink had a problem. Please try again in a minute.';
  if (err && !err.response) return 'TeamLink did not answer. Please check your internet and try again.';
  return 'Please try again in a minute.';
}

const WAIT_PAGE = '<p style="font-family:system-ui,sans-serif;padding:24px;color:#123">Opening Green Start...</p>';

// deps: { postSession(): Promise, openWindow(url, target): Window|null, assign(url), goLocal(), notify(msg) }
// returns { mode: 'local' | 'tab' | 'same-tab' | 'cancelled' | 'error', reason? }
export async function openGreenStart({ url, postSession, openWindow, assign, goLocal, notify }) {
  if (!url) { if (goLocal) goLocal(); return { mode: 'local' }; }
  // 1. the tab, synchronously (before any await), so a pop-up blocker sees a real click
  let tab = null;
  try { tab = openWindow('about:blank', '_blank'); } catch { tab = null; }
  if (tab) { try { tab.document.title = 'Green Start'; tab.document.body.innerHTML = WAIT_PAGE; } catch { /* a blank tab is fine */ } }
  // 2. the pass
  try {
    await postSession();
  } catch (err) {
    if (tab) { try { tab.close(); } catch { /* gone */ } }
    const reason = reasonOf(err);
    if (notify) notify(`Could not open Green Start: ${reason}`);
    return { mode: 'error', reason };
  }
  // 3. send the tab on; it must not be able to reach back into TeamLink
  if (tab && tab.closed) return { mode: 'cancelled' }; // the person closed the new tab while waiting: nothing more to do
  if (tab) {
    try { tab.opener = null; } catch { /* ignore */ }
    try { tab.location.href = url; return { mode: 'tab' }; } catch { /* fall through */ }
  }
  assign(url); // pop-ups are blocked: open it in this tab; the pass is already set
  return { mode: 'same-tab' };
}
