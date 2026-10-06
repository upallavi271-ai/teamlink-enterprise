#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TeamLink uptime check — run by Windows Task Scheduler every 5 minutes.
//
// It asks the server "are you there?" (GET /api/health). If the server does
// not answer twice in a row, it raises ONE alert for that outage, and a
// "server is back" note when it answers again. Alerts are sent only when a
// Super Admin has switched on "Uptime alert" in Administration → System
// (it is OFF until then). See utils/uptimeAlert.js for where alerts go.
//
// HOW TO INSTALL (plain words) — do this once, on the computer that runs the
// TeamLink server:
//   1. Open the Start menu, type "PowerShell", open it (no admin needed).
//   2. Paste this one line and press Enter (it makes a task that runs every
//      5 minutes while you are logged in, with no window popping up — the
//      small healthcheck-hidden.vbs next to this file starts node quietly):
//
//      schtasks /Create /TN "TeamLink uptime check" /SC MINUTE /MO 5 /F /TR "wscript.exe \"C:\Users\user\Desktop\All_Projects\teamlink-enterprise\backend\scripts\healthcheck-hidden.vbs\""
//
//      (If the project is in another folder, change the path to match.)
//   3. Test it: `schtasks /Run /TN "TeamLink uptime check"`, then open
//      Administration → System — "Outside check" shows the time it last ran.
//   4. To remove it: `schtasks /Delete /TN "TeamLink uptime check" /F`.
//
// By hand: `npm run healthcheck` (prints what it found).
// Options: --url <health url>  (default http://127.0.0.1:<PORT from .env>/api/health)
//          --timeout <ms>      (default 10000)
// ---------------------------------------------------------------------------
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
require('dotenv').config({ path: path.join(BACKEND, '.env') });
// The TEST SANDBOX (TEST_MODE=1) replaces mail with a fake transport.
require('../src/utils/sandbox').installGuards();

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const URL_ = opt('--url') || process.env.TL_HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 4000}/api/health`;
const TIMEOUT = Number(opt('--timeout')) || 10000;

async function ping() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(URL_, { signal: ctl.signal });
    const body = await r.json().catch(() => null);
    if (r.ok && body && body.ok) return { ok: true, ms: Date.now() - t0 };
    return { ok: false, detail: `answered ${r.status}` };
  } catch (err) {
    return { ok: false, detail: err.name === 'AbortError' ? `no answer in ${TIMEOUT / 1000} s` : (err.cause && err.cause.code) || err.message };
  } finally { clearTimeout(t); }
}

async function main() {
  // eslint-disable-next-line global-require
  const up = require('../src/utils/uptimeAlert');
  const now = new Date().toISOString();
  const res = await ping();
  const s = up.readState() || { history: [] };
  s.url = URL_;
  s.lastCheckAt = now;
  s.lastResult = res.ok ? 'ok' : res.detail;
  let settings = { failuresBeforeAlert: 2 };
  try { settings = await up.uptimeSettings(); } catch { /* DB unreadable — keep defaults */ }

  if (res.ok) {
    s.lastOkAt = now;
    s.consecutiveFails = 0;
    if (s.down) {
      const outage = { since: s.down.since, upAt: now, alerted: !!s.down.alertedAt };
      if (s.down.alertedAt) {
        try { outage.backAlert = await up.sendUptimeAlert('up', { since: s.down.since, upAt: now, url: URL_ }); } catch (err) { outage.backAlert = { error: err.message }; }
      }
      s.history = [outage, ...(s.history || [])].slice(0, 20);
      s.down = null;
    }
    console.log(`[healthcheck ${now}] OK ${URL_} (${res.ms} ms)`);
  } else {
    s.consecutiveFails = (s.consecutiveFails || 0) + 1;
    if (!s.down) s.down = { since: now, alertedAt: null };
    if (!s.down.alertedAt && s.consecutiveFails >= settings.failuresBeforeAlert) {
      try {
        const r = await up.sendUptimeAlert('down', { since: s.down.since, url: URL_, detail: res.detail });
        s.down.alert = r;
        // Switched off: remember that we did not send, so switching it on
        // during this same outage still alerts on the next check.
        if (r.sent) s.down.alertedAt = now;
      } catch (err) { s.down.alert = { error: err.message }; }
    }
    console.log(`[healthcheck ${now}] DOWN ${URL_} — ${res.detail} (${s.consecutiveFails} in a row)`);
  }
  up.writeState(s);
  try { await require('../src/db').$disconnect(); } catch { /* not connected */ }
  return res.ok ? 0 : 1;
}

main().then((c) => { process.exitCode = c; }).catch((err) => { console.error(err); process.exitCode = 1; });
