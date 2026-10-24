#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CALIBRATE THE SELECTORS (the human step).   node scripts/portal-calibrate.js naukri   (npm run portal-calibrate -- naukri)
//
// WHY: the page settings for Naukri, Shine and Foundit (src/portals/selectors/<portal>.json) were written from the public
// look of those sites. They stay "UNVERIFIED" until a PERSON has looked at the real pages. This script is that look.
//
// WHAT IT DOES: opens a VISIBLE Chrome window (the portal's own saved browser profile) and walks you through three pages.
// On each one it only LOOKS: for every step of that page it reports which of the listed ways (CSS / role / label / text)
// finds the element, so you see "main way works", "only fallback 3 works (drift)" or "NOT FOUND". Then it saves a picture
// (passwords hidden) and a page-structure snapshot (no typed values, no personal text) in the private picture folder.
//
// WHAT IT NEVER DOES: type a login, solve a CAPTCHA or OTP, click anything, submit anything, post anything. YOU sign in.
//
// Pages (press Enter in this window after each is on screen):
//   1. the LOGIN page            (open it, do NOT sign in yet)
//   2. the POST-A-JOB form       (sign in yourself, open "Post a job", press Enter; the form must be EMPTY / untouched)
//   3. the MY-JOBS list          (optional: open the list of your jobs; the close/take-down buttons are looked for there)
//
// Afterwards: if everything you care about says "main way works", copy the page-settings file to a folder, set "verified": true
// and a new "version", point TL_PORTAL_SELECTORS_DIR at the folder (or the Admin screen setting) and run a Dry run.
// Steps that report drift: put the way that worked FIRST in the list. docs/job-publishing/CALIBRATION.md has the full guide.
//
// Test mode (only against the local MOCK portal, never a real site):  --auto  (needs TL_POSTING_STRICT_LOCAL=1 and the mock's
// made-up login in MOCK_USER / MOCK_PASS)  walks the three pages by itself and writes the report to --json <file>.
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
require('dotenv').config();
const path = require('path');
const readline = require('readline');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const portal = argv.find((a) => !a.startsWith('--'));
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const ask = (q) => new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, () => { rl.close(); resolve(); }); });

(async () => {
  const C = require(path.join(BACK, 'src/jobPublish/constants'));
  if (!portal || !C.PORTALS[portal] || C.PORTALS[portal].kind !== 'browser') {
    console.error(`Usage: node scripts/portal-calibrate.js <${C.PORTAL_KEYS.filter((k) => C.PORTALS[k].kind === 'browser').join('|')}> [--auto --json report.json]`);
    process.exit(1);
  }
  const cfgLib = require(path.join(BACK, 'src/portals/config'));
  const browser = require(path.join(BACK, 'src/playwright/browser'));
  const shots = require(path.join(BACK, 'src/playwright/screenshot'));
  const structure = require(path.join(BACK, 'src/playwright/structure'));
  const entries = require(path.join(BACK, 'src/playwright/locate'));
  const loaded = await cfgLib.load(portal);
  if (!loaded.ok) { console.error(`The ${portal} page settings are not valid: ${loaded.problems.join('; ')}`); process.exit(1); }
  const cfg = loaded.cfg;
  const strict = browser.strictLocal(cfg);
  const auto = flag('--auto');
  if (auto && !strict) { console.error('--auto is only for the local mock portal (set TL_POSTING_STRICT_LOCAL=1). Refusing: a real site is never driven automatically.'); process.exit(1); }

  const steps = cfgLib.stepList(cfg);
  const stages = [
    { name: 'login page', url: cfg.urls.login, keys: (k) => k.startsWith('login.'), ask: 'Open the LOGIN page (do not sign in yet), then press Enter: ' },
    { name: 'post-a-job form', url: cfg.urls.postJob, keys: (k) => k.startsWith('field.') || k.startsWith('post.') || k.startsWith('form.next'), ask: 'Sign in yourself, open the empty POST-A-JOB form, then press Enter: ' },
    { name: 'my-jobs list', url: cfg.urls.myJobs, keys: (k) => k.startsWith('close.'), ask: 'Open your MY JOBS list (or just press Enter to skip), then press Enter: ' },
  ];

  console.log(`\nCalibrating ${C.portalName(portal)}  (page settings ${loaded.version || '?'}, ${cfg.verified ? 'VERIFIED' : 'UNVERIFIED'}; file: ${loaded.file})`);
  console.log(auto ? 'Automatic test mode against the local mock portal.' : 'A Chrome window opens. YOU sign in. This tool only looks: it types and clicks nothing.');
  const h = await browser.launch({ portal, headed: !auto, allowedHosts: cfg.allowedHosts, strict, navTimeoutMs: 60000 });
  const report = { portal, version: loaded.version, verified: !!cfg.verified, at: new Date().toISOString(), steps: [], files: [] };
  try {
    for (let si = 0; si < stages.length; si += 1) {
      const st = stages[si];
      if (auto) {
        await h.page.goto(st.url).catch(() => {});
        if (si === 1) {
          // mock only: the made-up login of the local mock portal (refused above unless strict-local)
          await h.page.goto(cfg.urls.login).catch(() => {});
          const user = await firstVisible(h.page, cfg.login.username, entries);
          const pass = await firstVisible(h.page, cfg.login.password, entries);
          const btn = await firstVisible(h.page, cfg.login.submit, entries);
          if (user && pass && btn) { await user.fill(process.env.MOCK_USER || ''); await pass.fill(process.env.MOCK_PASS || ''); await btn.click(); await h.page.waitForTimeout(800); }
          await h.page.goto(st.url).catch(() => {});
        }
      } else {
        if (si === 0) await h.page.goto(st.url).catch(() => {});
        await ask(`\n[${si + 1}/3] ${st.ask}`);
      }
      const mine = steps.filter((s) => st.keys(s.key));
      console.log(`\n--- ${st.name}: ${mine.length} steps looked for on this page ---`);
      for (const s of mine) {
        const ways = [];
        for (let i = 0; i < s.list.length; i += 1) {
          let n = 0; let visible = 0;
          try { const loc = entries.build(h.page, s.list[i], { value: 'x', id: 'x' }, (x) => x); n = await loc.count(); visible = n ? (await loc.first().isVisible().catch(() => false) ? n : 0) : 0; } catch { n = 0; }
          ways.push({ index: i, family: entries.family(s.list[i]), described: entries.describe(s.list[i], { value: 'x', id: 'x' }), matches: n, visible });
        }
        const firstHit = ways.find((w) => w.visible > 0);
        const state = !firstHit ? 'NOT FOUND' : firstHit.index === 0 ? 'main way works' : `DRIFT: only way ${firstHit.index + 1} works`;
        report.steps.push({ key: s.key, label: s.label, page: st.name, state, hit: firstHit ? firstHit.index : null, ways });
        console.log(`${(!firstHit ? '  [--]' : firstHit.index === 0 ? '  [OK]' : '  [~~]')} ${s.label.padEnd(38)} ${state}${firstHit && firstHit.visible > 1 ? `  (${firstHit.visible} matches: a button must match exactly one before TeamLink will click it)` : ''}`);
      }
      const text = await structure.capture(h.page, { portal, step: `calibrate-${st.name}` });
      const f1 = shots.saveText({ queueId: 'calibrate', portal, step: st.name.replace(/\s+/g, '-'), text });
      const png = await shots.shot(h.page, { queueId: 'calibrate', portal, step: st.name.replace(/\s+/g, '-') });
      [f1, png].filter(Boolean).forEach((f) => report.files.push(f));
    }
  } finally { await h.close(); }
  const ok = report.steps.filter((s) => s.state === 'main way works').length;
  const drift = report.steps.filter((s) => s.state.startsWith('DRIFT')).length;
  const missing = report.steps.filter((s) => s.state === 'NOT FOUND').length;
  console.log(`\nResult: ${ok} work through the main way, ${drift} drift, ${missing} not found.`);
  console.log(`Saved to ${shots.root()}: ${report.files.join(', ') || '(nothing)'}`);
  console.log(missing || drift
    ? 'Fix the page settings (put the way that worked first, add a new way for NOT FOUND steps), then run this again.'
    : 'All steps found. If the form was the real, EMPTY one: mark the page settings "verified": true (see docs/job-publishing/CALIBRATION.md), then run a Dry run.');
  console.log('Nothing was typed, clicked or posted by this tool.');
  if (val('--json')) fs.writeFileSync(val('--json'), JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });

async function firstVisible(page, list, entries) {
  for (const e of [].concat(list)) {
    try { const loc = entries.build(page, e, {}, (x) => x).first(); if (await loc.isVisible()) return loc; } catch { /* next */ }
  }
  return null;
}
