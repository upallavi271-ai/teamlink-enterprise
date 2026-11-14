#!/usr/bin/env node
/**
 * Employee Monitoring: the WEEKLY BREAK (founder 2026-11-14: "every Saturday 4 to 4:20 pm 20 mins break vuntadhi, only Saturday - adhi note chesko").
 * Part 1 is pure (workDayOf, gapFill, weeklyBreakOn, inBreakNow, cleanWeeklyBreaks). Part 2 saves the setting and ingests a record that crosses the
 * break, on a COPY of a sandbox database (nothing real).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/monitoring-weekly-break-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-weekly-break-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.TEAMLINK_SANDBOX = '1';
const prisma = require('../src/db');
const M = require('../src/utils/monitoring');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const IST = (day, hm) => Date.parse(`${day}T${hm}:00+05:30`);

const rules = { workStart: '09:30', workEnd: '18:30', breakStart: '12:30', breakEnd: '13:15', weeklyBreaks: M.DEFAULT_WEEKLY_BREAKS };
const SAT = '2026-11-14'; const FRI = '2026-11-13';

console.log('Which day has the break');
check('2026-11-14 is a Saturday and has it, 16:00 - 16:20', (M.weeklyBreakOn(rules, SAT) || {}).start === '16:00' && (M.weeklyBreakOn(rules, SAT) || {}).end === '16:20', M.weeklyBreakOn(rules, SAT));
check('the Friday before has none', M.weeklyBreakOn(rules, FRI) === null);
check('nor has the Sunday after', M.weeklyBreakOn(rules, '2026-11-15') === null);
check('the next Saturday has it again', !!M.weeklyBreakOn(rules, '2026-11-21'));
check('bad day or no rules: none, no crash', M.weeklyBreakOn(rules, 'x') === null && M.weeklyBreakOn(null, SAT) === null && M.weeklyBreakOn({}, SAT) === null);
check('the default is the Saturday break', M.DEFAULT_WEEKLY_BREAKS.length === 1 && M.DEFAULT_WEEKLY_BREAKS[0].weekday === 6 && M.DEFAULT_WEEKLY_BREAKS[0].label === 'Saturday break');

console.log('Is it break time now');
check('Saturday 16:00 is the break', M.inBreakNow(rules, SAT, '16:00') === true);
check('Saturday 16:19 still', M.inBreakNow(rules, SAT, '16:19') === true);
check('Saturday 16:20 it is over', M.inBreakNow(rules, SAT, '16:20') === false);
check('Saturday 15:59 not yet', M.inBreakNow(rules, SAT, '15:59') === false);
check('Friday 16:10 is NOT a break (only Saturday)', M.inBreakNow(rules, FRI, '16:10') === false);
check('lunch is still lunch, any day', M.inBreakNow(rules, FRI, '12:40') === true && M.inBreakNow(rules, SAT, '12:40') === true);

console.log('The list of breaks is cleaned');
const cl = M.cleanWeeklyBreaks([{ weekday: 6, start: '16:00', end: '16:20', label: '  Tea  ' }, { weekday: 9, start: '16:00', end: '16:20' }, { weekday: 2, start: '17:00', end: '16:00' }, { weekday: 1, start: 'x', end: '10:00' }, { weekday: '3', start: '10:00', end: '10:15' }]);
check('good rows stay, bad weekday / backwards / unreadable time go', cl.length === 2 && cl[0].label === 'Tea' && cl[1].weekday === 3 && cl[1].label === 'Wednesday break', cl);
check('not a list: empty', M.cleanWeeklyBreaks(null).length === 0 && M.cleanWeeklyBreaks('x').length === 0);

console.log('Work hours that day');
const wdSat = M.workDayOf(SAT, rules, IST(SAT, '17:00'));
const wdFri = M.workDayOf(FRI, rules, IST(FRI, '17:00'));
check('a Friday is 9 h - 45 min lunch - 15 min personal = 8 h', wdFri.workSeconds === 8 * 3600 && wdFri.weeklySeconds === 0, wdFri);
check('a Saturday also loses 20 minutes: 7 h 40 min', wdSat.workSeconds === 8 * 3600 - 20 * 60 && wdSat.weeklySeconds === 20 * 60, wdSat);
check('and says which break and when', wdSat.weeklyLabel === 'Saturday break' && wdSat.weeklyFrom === IST(SAT, '16:00') && wdSat.weeklyTo === IST(SAT, '16:20'), wdSat);
const shortDay = M.workDayOf(SAT, { ...rules, workEnd: '15:00' }, IST(SAT, '14:00'));
check('a shift that ends before 16:00 loses nothing', shortDay.weeklySeconds === 0, shortDay);
const cutDay = M.workDayOf(SAT, { ...rules, workEnd: '16:10' }, IST(SAT, '14:00'));
check('a shift that ends in the middle of it loses only the part inside', cutDay.weeklySeconds === 10 * 60, cutDay);
const noList = M.workDayOf(SAT, { ...rules, weeklyBreaks: [] }, IST(SAT, '17:00'));
check('an emptied list means no break at all', noList.workSeconds === 8 * 3600 && noList.weeklySeconds === 0, noList);

console.log('Nothing recorded in the break: it is Break, not "not on the PC"');
const gSat = M.gapFill([], wdSat, 'Online', false);
check('an empty Saturday window counts 20 minutes of Break', gSat.brk === 20 * 60 && gSat.lunch === 45 * 60, gSat);
const gFri = M.gapFill([], wdFri, 'Online', false);
check('a Friday has no such Break', gFri.brk === 0, gFri);
const rec = [{ startTime: new Date(IST(SAT, '16:00')), endTime: new Date(IST(SAT, '16:20')) }];
check('already recorded: not counted twice', M.gapFill(rec, wdSat, 'Online', false).brk === 0);
const half = [{ startTime: new Date(IST(SAT, '16:00')), endTime: new Date(IST(SAT, '16:05')) }];
check('half recorded: only the rest is added', M.gapFill(half, wdSat, 'Online', false).brk === 15 * 60, M.gapFill(half, wdSat, 'Online', false));
const liveMid = M.gapFill([{ startTime: new Date(IST(SAT, '15:00')), endTime: new Date(IST(SAT, '15:50')) }], wdSat, 'On break', true, IST(SAT, '16:10'));
check('live in the middle of the break: the time since the last piece is Break and counted once (20 min)', liveMid.brk === 20 * 60, liveMid);
const liveOnline = M.gapFill([{ startTime: new Date(IST(SAT, '15:00')), endTime: new Date(IST(SAT, '15:50')) }], wdSat, 'Online', true, IST(SAT, '16:30'));
check('live after it, still working: the break is Break (20 min), the other 20 min since the last piece (15:50 - 16:00 and 16:20 - 16:30) are active', liveOnline.brk === 20 * 60 && liveOnline.active === 20 * 60, liveOnline);

console.log('Saving and ingesting (sandbox copy)');
(async () => {
  const s0 = await M.settings();
  check('with nothing saved, the Saturday break is the default', s0.weeklyBreaks.length === 1 && s0.weeklyBreaks[0].weekday === 6, s0.weeklyBreaks);
  const bad = await M.saveSettings(null, { weeklyBreaks: 'nope' });
  check('a list that is not a list is refused', bad && bad.status === 400, bad);
  const bad2 = await M.saveSettings(null, { weeklyBreaks: [{ weekday: 6, start: '16:30', end: '16:00' }] });
  check('a list with nothing usable in it is refused', bad2 && bad2.status === 400, bad2);

  // yesterday and the day before, in India time, so the 7-day window of ingest never matters
  const todayIst = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const y = M.addDays(todayIst, -1); const y2 = M.addDays(todayIst, -2);
  const wdOfY = new Date(`${y}T00:00:00Z`).getUTCDay();
  const saved = await M.saveSettings({ id: null, name: 'test' }, { weeklyBreaks: [{ weekday: wdOfY, start: '16:00', end: '16:20', label: 'Test break' }] });
  check('a good list is saved', saved && (saved.status === undefined || saved.status === 200 || saved.ok !== false) && !saved.error, saved);
  const s1 = await M.settings();
  check('and read back, with its label', s1.weeklyBreaks.length === 1 && s1.weeklyBreaks[0].weekday === wdOfY && s1.weeklyBreaks[0].label === 'Test break', s1.weeklyBreaks);
  check('saving only the lunch window keeps the list', (await M.saveSettings(null, { breakStart: '12:30', breakEnd: '13:15' })) && (await M.settings()).weeklyBreaks.length === 1);

  const emp = await prisma.employee.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
  const dev = await prisma.monitoringDevice.create({ data: { employeeId: emp.id, deviceName: 'ZZ-WB', tokenHash: `zz-wb-${Date.now()}`, isActive: true, approved: true, lastSeenAt: new Date() } });
  await M.recordConsent(emp.id, s1.policyVersion, '127.0.0.1', 'test');
  const device = { id: dev.id, employeeId: emp.id, approved: true, employee: { id: emp.id } };
  const iso = (day, hm) => new Date(IST(day, hm)).toISOString();
  const r = await M.ingest(device, [{ appName: 'excel', windowTitle: 'joinings - Excel', start: iso(y, '15:50'), end: iso(y, '16:30'), isIdle: true }]);
  check('a record across the break is accepted', r.status === 200 && r.saved === 3, r);
  const rows = await prisma.activityLog.findMany({ where: { deviceId: dev.id, day: y }, orderBy: { startTime: 'asc' } });
  check('it is cut in three: before, the break, after', rows.length === 3 && rows[0].appName === 'excel' && rows[1].appName === 'Scheduled break' && rows[2].appName === 'excel', rows.map((x) => x.appName));
  check('the break piece is exactly 16:00 - 16:20', rows[1] && rows[1].startTime.getTime() === IST(y, '16:00') && rows[1].endTime.getTime() === IST(y, '16:20') && rows[1].durationSeconds === 1200, rows[1]);
  check('the break piece is a Break, never idle, and keeps no title', rows[1].isBreak === true && rows[1].isIdle === false && rows[1].windowTitle === null, rows[1]);
  check('the pieces around it stay as they were (idle stays idle)', rows[0].isIdle === true && rows[2].isIdle === true && rows[0].windowTitle === 'joinings - Excel', [rows[0], rows[2]]);

  const T = M.totalsOf(rows.map((x) => ({ ...x })), () => 'neutral');
  check('totals: the 20 minutes are Break (plus the first 15 min of idle, the personal break), the other 5 min idle', T.breakSeconds === 1200 + 900 && T.idleSeconds === 300, T);
  check('and none of it is Lunch', T.lunchSeconds === 0, T);

  // the day before has no break on its weekday (different weekday), so the same hour is plain work
  const r2 = await M.ingest(device, [{ appName: 'excel', windowTitle: 'joinings - Excel', start: iso(y2, '15:50'), end: iso(y2, '16:30') }]);
  const rows2 = await prisma.activityLog.findMany({ where: { deviceId: dev.id, day: y2 } });
  check('on another weekday the same hour is not cut', r2.saved === 1 && rows2.length === 1 && rows2[0].appName === 'excel' && rows2[0].isBreak === false, rows2.map((x) => x.appName));

  // lunch and the weekly break in one record (a lunch window moved next to the break, as an odd setting)
  await M.saveSettings(null, { breakStart: '15:30', breakEnd: '15:45' });
  await prisma.activityLog.deleteMany({ where: { deviceId: dev.id, day: y } });
  const r3 = await M.ingest(device, [{ appName: 'word', windowTitle: 'offer.docx - Word', start: iso(y, '15:25'), end: iso(y, '16:25') }]);
  const rows3 = await prisma.activityLog.findMany({ where: { deviceId: dev.id, day: y, appName: { in: ['word', 'Break', 'Scheduled break'] } }, orderBy: { startTime: 'asc' } });
  check('a record across both windows is cut at both, in order, none overlapping', rows3.map((x) => x.appName).join() === 'word,Break,word,Scheduled break,word' && rows3.every((x, i, a) => i === 0 || a[i - 1].endTime.getTime() <= x.startTime.getTime()), rows3.map((x) => [x.appName, x.startTime.toISOString().slice(11, 16), x.endTime.toISOString().slice(11, 16)]));

  // the founder clearing the list means "no weekly break"
  await M.saveSettings(null, { weeklyBreaks: [] });
  check('an emptied list is kept as none (not turned back into the default)', (await M.settings()).weeklyBreaks.length === 0);
  await prisma.$disconnect();
  console.log(`\n${total - failed}/${total} passed`);
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(failed ? 1 : 0); }, 500);
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch { /* none */ } try { fs.unlinkSync(COPY); } catch { /* none */ } process.exit(1); });
