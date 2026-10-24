// ---------------------------------------------------------------------------
// THE BROWSER LAUNCHER (Playwright, driving the machine's own Google Chrome or Edge).
//
//   * dependency: playwright-core ONLY. No browser is downloaded. The browser is the one installed on the worker
//     machine: channel 'chrome' (then 'msedge'), or the file named in PLAYWRIGHT_CHROME_PATH.
//   * one browser, one context per portal run, a persistent per-portal profile (playwright/session.js) so the
//     sign-in is reused. Headless by default; HEADED only for a person's own sign-in session (portal-session).
//   * tight timeouts: 20 s to open a page, 8 s for a click / fill (the run as a whole has its own deadline).
//   * NO stealth: no evasion plugin, no fingerprint change, no user-agent spoofing, no proxy rotation.
//   * NETWORK GUARD: a page may only navigate to the portal's own domains (config.allowedHosts). In tests / the
//     sandbox (strict mode) the browser may reach localhost ONLY, so a test can never touch a real portal:
//     every other address is aborted before it leaves the machine.
// ---------------------------------------------------------------------------
const fs = require('fs');
const session = require('./session');
const sandbox = require('../utils/sandbox');

const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'];
const MEMORY_FLAGS = [
  '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-component-update', '--disable-default-apps',
];

function windowsCandidates() {
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    ['chrome', `${pf}\\Google\\Chrome\\Application\\chrome.exe`], ['chrome', `${pf86}\\Google\\Chrome\\Application\\chrome.exe`],
    ['chrome', local && `${local}\\Google\\Chrome\\Application\\chrome.exe`],
    ['msedge', `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`], ['msedge', `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`],
  ].filter(([, p]) => p);
}
function posixCandidates() {
  return [
    ['chrome', '/usr/bin/google-chrome'], ['chrome', '/usr/bin/google-chrome-stable'], ['chrome', '/opt/google/chrome/chrome'],
    ['chrome', '/usr/bin/chromium'], ['chrome', '/usr/bin/chromium-browser'], ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['msedge', '/usr/bin/microsoft-edge'],
  ];
}

// -> { executablePath, label } | null
function findBrowser() {
  const forced = process.env.PLAYWRIGHT_CHROME_PATH;
  if (forced) return fs.existsSync(forced) ? { executablePath: forced, label: 'PLAYWRIGHT_CHROME_PATH' } : null;
  const list = process.platform === 'win32' ? windowsCandidates() : posixCandidates();
  const hit = list.find(([, p]) => fs.existsSync(p));
  return hit ? { executablePath: hit[1], label: hit[0] } : null;
}

// host matches "naukri.com" / "*.naukri.com" (and a bare name matches its sub-domains too)
function hostAllowed(host, patterns) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (patterns || []).some((p) => {
    const x = String(p).toLowerCase().replace(/^\*\./, '');
    return h === x || h.endsWith(`.${x}`);
  });
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
// Tests and the sandbox may reach localhost only.
function strictLocal(cfg) {
  return truthy(process.env.TL_POSTING_STRICT_LOCAL) || sandbox.isSandbox() || !!(cfg && cfg.mock);
}

// opts: { portal, headed, allowedHosts, strict, navTimeoutMs, actionTimeoutMs, onBlocked }
// -> { context, page, blocked: [], close() }
async function launch(opts) {
  const found = findBrowser();
  if (!found) {
    const e = new Error('No Chrome or Edge was found on this machine.');
    e.code = 'NO_BROWSER';
    throw e;
  }
  // eslint-disable-next-line global-require
  const { chromium } = require('playwright-core');
  const profile = session.ensureDir(opts.portal);
  const strict = opts.strict !== undefined ? opts.strict : strictLocal({});
  const allowed = strict ? LOCAL : (opts.allowedHosts || []);
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: found.executablePath,
      headless: !opts.headed,
      viewport: { width: 1280, height: 860 },
      locale: 'en-IN',
      acceptDownloads: false,
      args: MEMORY_FLAGS,
      timeout: 45000,
    });
  } catch (err) {
    const m = String(err && err.message);
    const e = new Error(/user data directory|ProcessSingleton|in use|already running/i.test(m)
      ? `The browser profile for ${opts.portal} is already open (is a portal-session window still open?).`
      : `The browser could not start: ${m.split('\n')[0].slice(0, 160)}`);
    e.code = /user data directory|ProcessSingleton|in use|already running/i.test(m) ? 'PROFILE_IN_USE' : 'BROWSER_START';
    throw e;
  }
  context.setDefaultNavigationTimeout(opts.navTimeoutMs || 20000);
  context.setDefaultTimeout(opts.actionTimeoutMs || 8000);
  const blocked = [];
  // The network guard. Strict: EVERY request must be local. Normal: a page NAVIGATION must stay on the portal's own domains.
  await context.route('**/*', (route) => {
    const req = route.request();
    let host = '';
    try { host = new URL(req.url()).hostname; } catch { host = ''; }
    const scheme = (() => { try { return new URL(req.url()).protocol; } catch { return ''; } })();
    if (scheme === 'data:' || scheme === 'blob:' || scheme === 'about:') return route.continue();
    const isNav = req.isNavigationRequest();
    const mustCheck = strict || isNav;
    if (mustCheck && !hostAllowed(host, allowed)) {
      blocked.push({ url: req.url().slice(0, 200), host });
      if (opts.onBlocked) opts.onBlocked(host);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = context.pages()[0] || await context.newPage();
  return {
    context, page, blocked, strict, browser: found.label,
    async close() { try { await context.close(); } catch { /* already closed */ } },
  };
}

module.exports = { launch, findBrowser, hostAllowed, strictLocal, LOCAL };
