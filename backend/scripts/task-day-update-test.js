// node scripts/task-day-update-test.js <copy of dev.db> - Timesheet daily tracking (utils/taskDayUpdate.js) on a COPY of the database.
// Makes its own ZZTEST people and tasks in that copy, stands in for the bell/email/popup, and removes what it made.
const path = require('path');
const assert = require('assert');

const db = process.argv[2];
if (!db) { console.error('Give a COPY of the database: node scripts/task-day-update-test.js <copy.db>'); process.exit(1); }
process.env.DATABASE_URL = `file:${path.resolve(db)}`;
process.env.NODE_ENV = 'test';
const prisma = require('../src/db');
const HN = require('../src/utils/hrmsNotify');
const nudges = require('../src/utils/dayNudges');
const U = require('../src/utils/taskDayUpdate');

const sent = [];
HN.notify = async (event, who, { title, message }) => { sent.push({ event, to: who.userId, title, message }); return { inApp: true, email: false }; };
HN.getSettings = async () => ({ emailsOn: false, events: {} });
nudges.popup = async () => true;

const DAY = '2026-11-10';
const now = new Date(`${DAY}T18:05:00`);
(async () => {
  const mk = (name) => prisma.user.create({ data: { name: `ZZTEST ${name}`, email: `zz-taskday-${name.toLowerCase()}-${Date.now()}@teamlink.local`, passwordHash: 'x', role: 'EMPLOYEE', status: 'Active' } });
  const [lead, asha, ravi] = [await mk('Lead'), await mk('Asha'), await mk('Ravi')];
  // the "ZZTEST" names would be skipped as test records, so the notes are checked with neutral employee names
  const emp = (u, name, tl) => prisma.employee.create({ data: { name, employeeCode: `TD-${u.id.slice(-6)}`, email: u.email.replace('zz-', 'tl-day-'), userId: u.id, employmentStatus: 'Active', ...(tl ? { reportingManagerId: tl } : {}) } });
  const eLead = await emp(lead, 'Day Lead');
  await emp(asha, 'Day Asha', eLead.id);
  await emp(ravi, 'Day Ravi', eLead.id);
  const task = (name, who, by, endDate, status = 'In Progress') => prisma.task.create({ data: { name, assigneeId: who.id, assigneeName: who.name, assignedById: by.id, assignedByName: by.name, endDate, status } });
  const t1 = await task('ZZ day: call list', asha, lead, DAY);
  const t2 = await task('ZZ day: report', asha, lead, '2026-11-07');
  const t3 = await task('ZZ day: own plan', ravi, ravi, DAY);
  const t4 = await task('ZZ day: later', ravi, lead, '2026-11-20');
  const made = [t1, t2, t3, t4].map((t) => t.id);
  try {
    // rules
    assert.match(U.check({ progress: 140, done: 'x' }, t1, DAY).error, /0 to 100/);
    assert.match(U.check({ progress: 50, done: '' }, t1, DAY).error, /what you did/);
    assert.match(U.check({ progress: 50, done: 'calls' }, t1, DAY).error, /why it is not finished/, 'due today and not finished needs a reason');
    assert.ok(!U.check({ progress: 50, done: 'calls' }, t4, DAY).error, 'not due yet: no reason needed');
    assert.ok(!U.check({ progress: 100, done: 'all done' }, t1, DAY).error, '100 % needs no reason');

    // only the person it is for
    const no = await U.save({ id: lead.id, name: lead.name }, t1, { progress: 40, done: 'x', why: 'y' }, DAY);
    assert.strictEqual(no.status, 403);

    // 18:00: Asha has 2 due (today + late), Ravi 1 (his own, due today); the later task is not asked
    const a1 = await U.ask(now);
    // the copy holds real late tasks too: only this test's people are looked at
    const ours = (s) => [lead.id, asha.id, ravi.id].includes(s.to);
    const asks = sent.filter((s) => s.event === 'taskDayAsk' && ours(s));
    assert.strictEqual(asks.length, 2, JSON.stringify(a1));
    const ashaAsk = asks.find((s) => s.to === asha.id);
    assert.match(ashaAsk.title, /2 tasks are not finished today/);
    assert.match(ashaAsk.message, /call list \(due today/);
    assert.match(ashaAsk.message, /report \(due 7 Nov, late/);
    assert.ok(!asks.some((s) => /later/.test(s.message)));

    // Asha answers one; a second save the same day replaces it
    let r = await U.save({ id: asha.id, name: asha.name }, t1, { progress: 40, done: 'Called 10 of 25', why: 'Client list came late' }, DAY);
    assert.strictEqual(r.progress, 40);
    r = await U.save({ id: asha.id, name: asha.name }, t1, { progress: 60, done: 'Called 15 of 25', why: 'Client list came late' }, DAY);
    assert.strictEqual((await U.history(t1.id)).length, 1, 'one line per day');
    assert.strictEqual((await prisma.task.findUnique({ where: { id: t1.id } })).progress, 60);
    r = await U.save({ id: asha.id, name: asha.name }, t2, { progress: 100, done: 'Finished' }, DAY);
    assert.match(r.finishHint, /Mark as done/);

    // asked again: only Ravi still owes one (titles are per day, so the real notify would not repeat Asha anyway)
    sent.length = 0;
    await U.ask(now);
    assert.deepStrictEqual(sent.filter(ours).map((s) => s.to), [ravi.id]);

    // 19:00: the lead hears all three - Asha's two (given by the lead) and Ravi's own task (the lead is his TL)
    sent.length = 0;
    await U.report(new Date(`${DAY}T19:05:00`));
    const rep = sent.filter((s) => s.event === 'taskDayReport' && ours(s));
    assert.strictEqual(rep.length, 1);
    assert.strictEqual(rep[0].to, lead.id);
    assert.match(rep[0].title, /3 tasks not finished today \(1 without an update\)/);
    assert.match(rep[0].message, /call list \(due today\) - 60% done\. Today: Called 15 of 25 Why not finished: Client list came late/);
    assert.match(rep[0].message, /own plan \(due today\) - 0% so far\. No update given today/);

    // done or cancelled: no update
    await prisma.task.update({ where: { id: t3.id }, data: { status: 'Completed' } });
    const done = await U.save({ id: ravi.id, name: ravi.name }, await prisma.task.findUnique({ where: { id: t3.id } }), { progress: 50, done: 'x' }, DAY);
    assert.strictEqual(done.status, 400);
    console.log('task-day-update-test: all checks passed');
  } finally {
    await prisma.task.deleteMany({ where: { id: { in: made } } });
    await prisma.employee.deleteMany({ where: { userId: { in: [lead.id, asha.id, ravi.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [lead.id, asha.id, ravi.id] } } });
    await prisma.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
