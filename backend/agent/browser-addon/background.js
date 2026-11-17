// TeamLink Website Reporter — Chrome / Edge, Manifest V3.
//
// It reads ONLY the hostname of the active tab of the focused window and sends it to the TeamLink monitor agent running on this same
// PC (a local listener on 127.0.0.1:47811). It is sent whenever the active tab or its host changes, and once every 60 seconds.
//
// What it NEVER sends: the full URL, the path, the query string, page content, form data, or anything at all from an incognito /
// private window. No remote server is ever contacted — only 127.0.0.1 on this machine.

const AGENT_URL = 'http://127.0.0.1:47811/host';
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

let lastHost = '';

// The hostname of a normal http/https page, lower-cased, or '' for anything we must not report (incognito, chrome:// pages, files…).
function hostOf(tab) {
  if (!tab || tab.incognito || !tab.url) return '';
  let u;
  try { u = new URL(tab.url); } catch (e) { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const h = String(u.hostname || '').toLowerCase();
  return HOST_RE.test(h) && h.includes('.') ? h : '';
}

// Fire-and-forget POST of just { host, at } as a plain-text body (a CORS-safe simple request: no preflight). Errors are ignored —
// the agent may be switched off or not yet started.
function send(host) {
  if (!host) return;
  try {
    fetch(AGENT_URL, {
      method: 'POST',
      body: JSON.stringify({ host, at: Date.now() }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// Look at the active tab of the currently focused browser window and report its host. `force` re-sends even if the host is unchanged
// (used by the 60-second heartbeat).
function report(force) {
  try {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const host = hostOf(tabs && tabs[0]);
      if (!host) { lastHost = ''; return; }
      if (force || host !== lastHost) { lastHost = host; send(host); }
    });
  } catch (e) { /* ignore */ }
}

// The active tab changed, a tab finished loading or changed its URL, or the focused window changed.
chrome.tabs.onActivated.addListener(() => report(false));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'complete' || info.url) report(false); });
chrome.windows.onFocusChanged.addListener(() => report(false));

// Every 60 seconds, re-send the current host so the agent always has a fresh value (it ignores anything older than 2 minutes).
chrome.alarms.create('teamlink-host', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'teamlink-host') report(true); });

// On install / browser start, report once.
chrome.runtime.onInstalled.addListener(() => report(true));
chrome.runtime.onStartup.addListener(() => report(true));
