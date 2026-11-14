/* eslint-disable no-console */
// Live Dashboard status of a PC (utils/monitoring.js liveStatus). Founder 2026-11-09: two people working, both shown Offline -
// someone who pressed "Stop recording and close" or clocked out must stay shown that way, not turn into a plain Offline after 3 minutes.
// Run: node scripts/monitoring-status-test.js
const M = require('../src/utils/monitoring');

let failed = 0; let total = 0;
function check(name, ok, got) {
  total += 1;
  if (ok) console.log(`  ok   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`); }
}

const now = Date.parse('2026-11-09T08:00:00Z'); // 1:30 pm IST
const ago = (min) => new Date(now - min * 60000);
const dev = (min, extra = {}) => ({ lastSeenAt: ago(min), currentIdle: false, pausedState: null, ...extra });

console.log('A PC that reported in the last 3 minutes');
check('working: Online', M.liveStatus(dev(1), false, now) === 'Online');
check('no key or mouse for a while: Idle', M.liveStatus(dev(1, { currentIdle: true }), false, now) === 'Idle');
check('paused for a break: On break', M.liveStatus(dev(1, { pausedState: 'break' }), false, now) === 'On break');
check('just stopped: Stopped', M.liveStatus(dev(1, { pausedState: 'stopped' }), false, now) === 'Stopped');

console.log('A PC that has not reported for longer');
check('stopped 40 minutes ago: still Stopped, not Offline', M.liveStatus(dev(40, { pausedState: 'stopped' }), false, now) === 'Stopped', M.liveStatus(dev(40, { pausedState: 'stopped' }), false, now));
check('stopped yesterday and not started since: still Stopped', M.liveStatus(dev(60 * 20, { pausedState: 'stopped' }), false, now) === 'Stopped');
check('clocked out an hour ago today: Clocked out', M.liveStatus(dev(60, { pausedState: 'clockout' }), false, now) === 'Clocked out');
check('clocked out yesterday: Offline today', M.liveStatus(dev(60 * 20, { pausedState: 'clockout' }), false, now) === 'Offline');
check('a break that went quiet: Offline (the PC went off)', M.liveStatus(dev(30, { pausedState: 'break' }), false, now) === 'Offline');
check('just went quiet: Offline', M.liveStatus(dev(10), false, now) === 'Offline');
check('on approved leave: On leave, even if it was stopped', M.liveStatus(dev(40, { pausedState: 'stopped' }), true, now) === 'On leave');
check('no PC at all: Offline', M.liveStatus(null, false, now) === 'Offline');
console.log('Leave applied but not approved yet (founder 2026-11-14: Navya, sick leave, board said Offline)');
check('leave waiting, PC quiet: Leave pending, not Offline', M.liveStatus(dev(60 * 20), false, now, true) === 'Leave pending', M.liveStatus(dev(60 * 20), false, now, true));
check('leave waiting, no PC at all: Leave pending', M.liveStatus(null, false, now, true) === 'Leave pending');
check('leave waiting but the PC is in use: Online (she came in)', M.liveStatus(dev(1), false, now, true) === 'Online');
check('approved beats waiting', M.liveStatus(dev(60 * 20), true, now, true) === 'On leave');
check('leave waiting, was stopped: Leave pending', M.liveStatus(dev(40, { pausedState: 'stopped' }), false, now, true) === 'Leave pending');

console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
process.exit(failed ? 1 : 0);
