#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OPEN THE PORTAL SESSION (the human step).   node scripts/portal-session.js naukri    (npm run portal-session -- naukri)
//
// Opens a VISIBLE Chrome window with the portal's saved browser profile and the portal's login page. YOU sign in
// yourself (password, CAPTCHA, OTP, 2-step: whatever the site asks). TeamLink types nothing and solves nothing.
// Close the window when you are signed in. The worker then reuses the cookies in that profile.
// Afterwards the sign-in is checked (a quiet headless look at the account page); if it is signed in, the login is marked
// Connected and the portal's "needs a person" hold is cleared. The status is only written when TL_ALLOW_REAL_POSTING=1
// (or the database is not the real dev.db).
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
require('dotenv').config();
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const portal = process.argv[2];

(async () => {
  const C = require(path.join(BACK, 'src/jobPublish/constants'));
  if (!portal || !C.PORTALS[portal] || C.PORTALS[portal].kind !== 'browser') {
    console.error(`Usage: node scripts/portal-session.js <${C.PORTAL_KEYS.filter((k) => C.PORTALS[k].kind === 'browser').join('|')}>`);
    process.exit(1);
  }
  const cfgLib = require(path.join(BACK, 'src/portals/config'));
  const browser = require(path.join(BACK, 'src/playwright/browser'));
  const session = require(path.join(BACK, 'src/playwright/session'));
  const loaded = await cfgLib.load(portal);
  if (!loaded.ok) { console.error(`The ${portal} page settings are not valid: ${loaded.problems.join('; ')}`); process.exit(1); }
  console.log(`Opening ${C.portalName(portal)} in a visible Chrome window. Sign in yourself, then CLOSE the window.`);
  console.log(`Profile folder (private, outside the repo): ${session.profileDir(portal)}`);
  const h = await browser.launch({ portal, headed: true, allowedHosts: loaded.cfg.allowedHosts, strict: false, navTimeoutMs: 60000 });
  await h.page.goto(loaded.cfg.urls.login).catch(() => {});
  await new Promise((r) => h.context.on('close', r));
  console.log('Window closed. Checking the sign-in quietly ...');
  // a quiet headless look: is the account page reachable now?
  const h2 = await browser.launch({ portal, headed: false, allowedHosts: loaded.cfg.allowedHosts, strict: false });
  let ok = false;
  try {
    await h2.page.goto(loaded.cfg.urls.dashboard || loaded.cfg.urls.postJob);
    for (const s of [].concat(loaded.cfg.login.loggedInProbe)) { if (await h2.page.locator(s).first().isVisible().catch(() => false)) { ok = true; break; } }
  } finally { await h2.close(); }
  console.log(ok ? 'Signed in. The worker can now reuse this session.' : 'Not signed in yet. Run this command again and finish the sign-in.');
  const D = require(path.join(BACK, 'src/jobPublish/db'));
  if (D.usesRealDevDb() && process.env.TL_ALLOW_REAL_POSTING !== '1') { console.log('(Status not recorded: set TL_ALLOW_REAL_POSTING=1 to record it in the real database.)'); process.exit(0); }
  if (ok && (await D.supported())) {
    await require(path.join(BACK, 'src/jobPublish/credentials')).recordCheck(portal, 'CONNECTED', null);
    await require(path.join(BACK, 'src/jobPublish/settings')).clearHumanHold(portal);
    console.log('Recorded: Connected. The portal is no longer on hold.');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
