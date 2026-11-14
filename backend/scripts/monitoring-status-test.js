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

// ABSENT: founder 2026-11-14, "After 4 hours" - no signal at all today, no leave, a working day, 4 hours of the work day gone
console.log('Absent (no signal all day, 4 hours into the work day)');
const H = 3600 * 1000;
const day1 = Date.parse('2026-11-14T09:00:00Z'); // 2:30 pm IST, a Saturday (a working day)
const wd = (hoursIn) => ({ ws: day1 - hoursIn * H, elapsedSeconds: hoursIn * 3600 });
const absent = (o) => M.absentNow({ status: 'Offline', workingDay: true, wd: wd(5), lastSeenAt: new Date(day1 - 20 * H), now: day1, ...o });
check('nothing today, 5 h into the day: Absent', absent({}) === true);
check('exactly 4 h into the day: Absent', absent({ wd: wd(4) }) === true);
check('3 h 59 min into the day: not yet', absent({ wd: { ws: day1 - 4 * H, elapsedSeconds: 4 * 3600 - 60 } }) === false);
check('never seen at all (no PC signal ever): Absent', absent({ lastSeenAt: null }) === true);
check('seen today, then went quiet: Offline, not Absent', absent({ lastSeenAt: new Date(day1 - 3 * H) }) === false);
check('has activity records today: not Absent', absent({ hasLogs: true }) === false);
check('a day off (Sunday / holiday): not Absent', absent({ workingDay: false }) === false);
check('laptop closed since yesterday: Absent', absent({ status: 'Laptop closed' }) === true);
check('Stopped stays Stopped', absent({ status: 'Stopped' }) === false);
check('Old agent stays Old agent', absent({ status: 'Old agent' }) === false);
check('On leave / Leave pending / Online are never Absent', ['On leave', 'Leave pending', 'Online', 'Idle', 'On break', 'Clocked out'].every((s) => absent({ status: s }) === false));

console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
process.exit(failed ? 1 : 0);
