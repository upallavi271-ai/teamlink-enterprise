#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PROBATION AND CONFIRMATION - utils/probation.js. It plants a few ZZ-PROB people in the SANDBOX database, runs the whole life of a
// probation, and removes everything it made. It refuses to run outside the test sandbox.
//   cd backend && TEST_MODE=1 DATABASE_URL="file:./sandbox.db" node -r dotenv/config scripts/probation-test.js
// ---------------------------------------------------------------------------
/* eslint-disable no-console, global-require */
const assert = require('assert');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
if (!truthy(process.env.TEST_MODE) && !truthy(process.env.TEAMLINK_SANDBOX)) {
  console.error('Refusing to run: this test writes to the database. Run it with TEST_MODE=1 against the sandbox.');
  process.exit(2);
}
const prisma = require('../src/db');
const P = require('../src/utils/probation');

const DAY = 86400000;
const now = Date.now();
const stamp = String(now).slice(-6);
const made = { employees: [], users: [] };
let beforeIds;
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function cleanup() {
  const del = async (fn) => { try { await fn(); } catch { /* already gone */ } };
  const ids = made.employees;
  if (ids.length) {
    await del(() => prisma.employeeDocument.deleteMany({ where: { employeeId: { in: ids } } }));
    await del(() => prisma.probationEvent.deleteMany({ where: { record: { employeeId: { in: ids } } } }));
    await del(() => prisma.probationRecord.deleteMany({ where: { employeeId: { in: ids } } }));
    await del(() => prisma.employee.deleteMany({ where: { id: { in: ids } } }));
  }
  if (made.users.length) {
    await del(() => prisma.notification.deleteMany({ where: { userId: { in: made.users } } }));
    await del(() => prisma.user.deleteMany({ where: { id: { in: made.users } } }));
  }
  if (beforeIds) await del(() => prisma.probationRecord.deleteMany({ where: { id: { notIn: [...beforeIds] } } }));
  await del(() => prisma.appSetting.deleteMany({ where: { key: { in: ['probation.settings', 'probation.sweep'] } } }));
}

(async () => {
  console.log('Probation and confirmation');
  const savedSettings = await prisma.appSetting.findUnique({ where: { key: 'probation.settings' } }).catch(() => null);
  beforeIds = new Set((await prisma.probationRecord.findMany({ select: { id: true } })).map((r) => r.id)); // switching ON also makes records for the sandbox's own staff: they are removed at the end
  try {
    // the sandbox seed has its own staff: this test only looks at the ZZ people it plants
    await prisma.appSetting.deleteMany({ where: { key: { in: ['probation.settings', 'probation.sweep'] } } });
    const mkUser = async (tag, extra = {}) => {
      const u = await prisma.user.create({ data: { name: `ZZ Prob ${tag}`, email: `zzprob-${tag}-${stamp}@example.test`, passwordHash: 'x', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', status: 'Active', ...extra } });
      made.users.push(u.id); return u;
    };
    const mkEmp = async (tag, extra = {}) => {
      const e = await prisma.employee.create({ data: { employeeCode: `ZZP-${tag}-${stamp}`, name: `ZZ Prob ${tag}`, department: 'ZZ Prob Dept', designation: 'Executive', employmentStatus: 'Active', dateOfJoining: new Date(now - 20 * DAY), ...extra } });
      made.employees.push(e.id); return e;
    };
    const uHr = await mkUser('HR', { role: 'HR', hrmsRole: 'HR' });
    const uTl = await mkUser('TL', { role: 'TL', hrmsRole: 'TL' });
    const uOther = await mkUser('Other');
    const uNew = await mkUser('NewJoiner');
    const eTl = await mkEmp('TL', { userId: uTl.id, dateOfJoining: new Date(now - 900 * DAY) });
    const eNew = await mkEmp('NewJoiner', { userId: uNew.id, reportingManagerId: eTl.id, tl: uTl.name, dateOfJoining: new Date(now - 20 * DAY) });
    const eByTlName = await mkEmp('ByTlName', { tl: uTl.name, dateOfJoining: new Date(now - 60 * DAY) });
    const eOld = await mkEmp('Old', { dateOfJoining: new Date(now - 400 * DAY) });
    const eGone = await mkEmp('Gone', { employmentStatus: 'Relieved', dateOfJoining: new Date(now - 10 * DAY) });
    const eNoDate = await mkEmp('NoDate', { dateOfJoining: null });
    const hr = await prisma.user.findUnique({ where: { id: uHr.id } });
    const tl = await prisma.user.findUnique({ where: { id: uTl.id } });
    const other = await prisma.user.findUnique({ where: { id: uOther.id } });
    const mine = (rows) => rows.filter((r) => String(r.employeeCode || '').startsWith('ZZP-') && r.employeeCode.endsWith(stamp));
    const rec = (e) => prisma.probationRecord.findUnique({ where: { employeeId: e.id } });

    await t('dates: a 3 month probation from 10 Nov ends on 9 Feb; month ends are clamped', async () => {
      assert.strictEqual(P.endFor('2026-11-10', 3), '2027-02-09');
      assert.strictEqual(P.endFor('2026-11-30', 3), '2027-02-27');
      assert.strictEqual(P.addMonths('2026-01-31', 1), '2026-02-28');
      assert.strictEqual(P.endFor('2026-10-01', 6), '2027-03-31');
    });

    await t('it is OFF by default: nothing is made while it is off', async () => {
      const s = await P.getSettings();
      assert.strictEqual(s.enabled, false);
      const out = await P.sync({});
      assert.ok(out.skipped);
      assert.strictEqual(await prisma.probationRecord.count({ where: { employeeId: { in: made.employees } } }), 0);
      const r = await P.remind({ force: true });
      assert.ok(r.skipped);
    });

    await t('only HR style settings are accepted: months 1-12, letter text not tiny', async () => {
      assert.ok((await P.saveSettings({ months: 0 }, hr)).error);
      assert.ok((await P.saveSettings({ months: 13 }, hr)).error);
      assert.ok((await P.saveSettings({ letterText: 'short' }, hr)).error);
    });

    await t('switching ON makes records: new joiner in probation, earlier joiner Not tracked, left / no-date people none', async () => {
      const out = await P.saveSettings({ enabled: true }, hr);
      assert.ok(out.sync && out.sync.created >= 3, JSON.stringify(out.sync));
      const a = await rec(eNew); const b = await rec(eByTlName); const c = await rec(eOld);
      assert.strictEqual(a.status, 'In probation');
      assert.strictEqual(P.endFor(ymd(now - 20 * DAY), 3), new Date(a.endDate.getTime() + 330 * 60000).toISOString().slice(0, 10));
      assert.strictEqual(b.status, 'In probation');
      assert.strictEqual(c.status, 'Not tracked');
      assert.strictEqual(await rec(eGone), null);
      assert.strictEqual(await rec(eNoDate), null);
      // the TL joined long ago: Not tracked
      assert.strictEqual((await rec(eTl)).status, 'Not tracked');
    });

    await t('the reviewer is the reporting manager, else the login named as TL', async () => {
      assert.strictEqual((await rec(eNew)).reviewerUserId, uTl.id);
      assert.strictEqual((await rec(eByTlName)).reviewerUserId, uTl.id);
      assert.strictEqual((await rec(eOld)).reviewerUserId, null);
    });

    await t('running sync again makes no duplicates', async () => {
      const before = await prisma.probationRecord.count({ where: { employeeId: { in: made.employees } } });
      const out = await P.sync({});
      assert.strictEqual(out.created, 0);
      assert.strictEqual(await prisma.probationRecord.count({ where: { employeeId: { in: made.employees } } }), before);
    });

    await t('the Employee row and its status are not touched', async () => {
      const e = await prisma.employee.findUnique({ where: { id: eNew.id } });
      assert.strictEqual(e.employmentStatus, 'Active');
    });

    await t('HR sees the planted people; the Team Lead sees the two on their team; an outsider sees nobody', async () => {
      const a = await P.list(hr, { bucket: 'all' });
      assert.ok(a.canDecide && a.enabled);
      assert.strictEqual(mine(a.rows).length, 4); // TL, NewJoiner, ByTlName, Old
      const b = await P.list(tl, { bucket: 'all' });
      const names = mine(b.rows).map((r) => r.name).sort();
      assert.deepStrictEqual(names, ['ZZ Prob ByTlName', 'ZZ Prob NewJoiner']);
      assert.strictEqual(b.canDecide, false);
      const c = await P.list(other, { bucket: 'all' });
      assert.strictEqual(mine(c.rows).length, 0);
    });

    await t('tabs: a joiner 20 days in is In probation and not due yet; Not tracked is its own tab', async () => {
      const a = await P.list(hr, { bucket: 'inProbation' });
      assert.ok(mine(a.rows).some((r) => r.name === 'ZZ Prob NewJoiner'));
      assert.ok(!mine((await P.list(hr, { bucket: 'overdue' })).rows).length);
      assert.ok(mine((await P.list(hr, { bucket: 'notTracked' })).rows).some((r) => r.name === 'ZZ Prob Old'));
    });

    await t('reminders: 30 days, 7 days, today, and every week overdue, each ONCE, to the Team Lead and HR', async () => {
      const r = await prisma.probationRecord.findUnique({ where: { employeeId: eNew.id } });
      const endMs = r.endDate.getTime();
      const at = (daysBefore) => endMs - daysBefore * DAY + 10 * 3600e3 + 30 * 60e3; // 10:00 + 30 min UTC = after 9 am IST that day
      const sent = [];
      const notify = async (ids, msg) => { sent.push({ ids, title: msg.title }); };
      const onlyMine = (told) => told.filter((x) => x.id === r.id);
      let out = await P.remind({ now: at(45), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 0);
      out = await P.remind({ now: at(25), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 1);
      assert.ok(sent.some((s) => /ends in 25 days/.test(s.title)));
      const first = sent.find((s) => /ZZ Prob NewJoiner/.test(s.title));
      assert.ok(first.ids.includes(uTl.id) && first.ids.includes(uHr.id));
      out = await P.remind({ now: at(24), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 0, 'the 30 day reminder must not repeat');
      out = await P.remind({ now: at(5), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 1);
      out = await P.remind({ now: at(0), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 1);
      assert.ok(sent.some((s) => /ends today/.test(s.title)));
      out = await P.remind({ now: at(-3), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 1);
      out = await P.remind({ now: at(-5), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 0, 'overdue is told once a week');
      out = await P.remind({ now: at(-10), notify, force: true });
      assert.strictEqual(onlyMine(out.told).length, 1);
      assert.ok(sent.some((s) => /overdue/.test(s.title)));
    });

    await t('the once-a-day guard: not before 9 am India time, and not twice on a day', async () => {
      const r = await prisma.probationRecord.findUnique({ where: { employeeId: eByTlName.id } });
      const endMs = r.endDate.getTime();
      const early = endMs - 3 * DAY + 2 * 3600e3; // 07:30 IST
      const out = await P.remind({ now: early, notify: async () => {} });
      assert.ok(out.skipped);
    });

    await t('review: the Team Lead can add one; an outsider cannot; a bad score or a missing reason is refused', async () => {
      const r = await rec(eNew);
      assert.strictEqual((await P.review(other, r.id, { recommendation: 'Confirm' })).status, 403);
      assert.ok((await P.review(tl, r.id, { recommendation: 'Maybe' })).error);
      assert.ok((await P.review(tl, r.id, { recommendation: 'Confirm', score: 101 })).error);
      assert.ok((await P.review(tl, r.id, { recommendation: 'Extend' })).error, 'Extend needs a reason');
      const ok = await P.review(tl, r.id, { recommendation: 'Confirm', score: 82, note: 'Meets every target' });
      assert.ok(!ok.error, ok.error);
      assert.strictEqual(ok.record.review.score, 82);
      assert.strictEqual(ok.record.review.recommendation, 'Confirm');
      const hrNote = await prisma.notification.count({ where: { userId: uHr.id, title: { contains: 'Probation review' } } });
      assert.ok(hrNote >= 1, 'HR is told about the review');
    });

    await t('the person under review cannot review themselves', async () => {
      const r = await rec(eNew);
      const self = await prisma.user.findUnique({ where: { id: uNew.id } });
      const out = await P.review(self, r.id, { recommendation: 'Confirm', score: 100 });
      assert.strictEqual(out.status, 403);
    });

    await t('extend: the end date moves, the old date stays in the history, a reason is needed', async () => {
      const r = await rec(eByTlName);
      const oldEnd = new Date(r.endDate.getTime() + 330 * 60000).toISOString().slice(0, 10);
      assert.ok((await P.extend(hr, r.id, { months: 2 })).error);
      assert.ok((await P.extend(hr, r.id, { months: 0, reason: 'x y z' })).error);
      const out = await P.extend(hr, r.id, { months: 2, reason: 'Needs more time on the process' });
      assert.ok(!out.error, out.error);
      assert.strictEqual(out.record.status, 'Extended');
      assert.strictEqual(out.record.endDate, P.addMonths(oldEnd, 2));
      assert.strictEqual(out.record.originalEndDate, oldEnd);
      const d = await P.detail(hr, r.id);
      const ev = d.events.find((e) => e.kind === 'Extended');
      assert.strictEqual(ev.fromEnd, oldEnd);
      assert.strictEqual(ev.toEnd, P.addMonths(oldEnd, 2));
      assert.strictEqual((await rec(eByTlName)).remindState, null);
    });

    await t('confirm: status, date and a confirmation letter filed in the employee documents', async () => {
      const r = await rec(eNew);
      const out = await P.confirm(hr, r.id, { note: 'Good work' });
      assert.ok(!out.error, out.error);
      assert.strictEqual(out.record.status, 'Confirmed');
      assert.ok(out.record.confirmedOn);
      assert.ok(!out.letterNote, out.letterNote);
      const docs = await prisma.employeeDocument.findMany({ where: { employeeId: eNew.id, docType: 'Confirmation Letter' } });
      assert.strictEqual(docs.length, 1);
      assert.ok(/pdf/i.test(docs[0].mime || docs[0].fileName));
      assert.strictEqual((await P.confirm(hr, r.id, {})).status, 409, 'cannot confirm twice');
      const again = await P.letterFile(hr, r.id);
      assert.ok(!again.error, again.error);
      assert.strictEqual(await prisma.employeeDocument.count({ where: { employeeId: eNew.id, docType: 'Confirmation Letter' } }), 1, 'a newer letter replaces the older one');
    });

    await t('the letter preview is a real PDF and uses the editable text', async () => {
      const r = await rec(eNew);
      const pre = await P.letterPreview(r.id);
      assert.ok(!pre.error, pre.error);
      assert.strictEqual(pre.pdf.slice(0, 4).toString(), '%PDF');
      const s = await P.saveSettings({ letterText: 'Dear team member, you are confirmed as {{designation}} from {{confirmedOn}}.\n\nWelcome to the permanent staff of {{company}}.' }, hr);
      assert.ok(!s.error, s.error);
      assert.ok((await P.getSettings()).letterText.startsWith('Dear team member'));
      const reset = await P.saveSettings({ letterText: P.DEFAULT_LETTER }, hr);
      assert.ok(!reset.error);
    });

    await t('end service only records the decision: the Employee row is not changed and no exit is started', async () => {
      const r = await rec(eByTlName);
      const out = await P.endService(hr, r.id, { note: 'Not meeting the role' });
      assert.ok(!out.error, out.error);
      assert.strictEqual(out.record.status, 'Service ending');
      assert.ok(/Exit Center/.test(out.next));
      const e = await prisma.employee.findUnique({ where: { id: eByTlName.id } });
      assert.strictEqual(e.employmentStatus, 'Active');
    });

    await t('reopen undoes a decision (and goes back to Extended when it had been extended)', async () => {
      const r = await rec(eByTlName);
      assert.ok((await P.reopen(hr, r.id, { note: '' })).error);
      const out = await P.reopen(hr, r.id, { note: 'Decided too early' });
      assert.ok(!out.error, out.error);
      assert.strictEqual(out.record.status, 'Extended');
      const r2 = await rec(eNew);
      const out2 = await P.reopen(hr, r2.id, { note: 'Confirmed by mistake' });
      assert.strictEqual(out2.record.status, 'In probation');
      assert.strictEqual(out2.record.confirmedOn, null);
    });

    await t('track brings a Not tracked person into tracking from a date HR chooses', async () => {
      const r = await rec(eOld);
      const start = ymd(now - 10 * DAY);
      assert.ok((await P.track(hr, r.id, { startDate: 'nonsense' })).error);
      const out = await P.track(hr, r.id, { startDate: start, months: 6 });
      assert.ok(!out.error, out.error);
      assert.strictEqual(out.record.status, 'In probation');
      assert.strictEqual(out.record.endDate, P.endFor(start, 6));
      assert.strictEqual((await P.track(hr, r.id, {})).status, 409);
    });

    await t('a person who has left is not reminded', async () => {
      const r = await rec(eOld);
      await prisma.employee.update({ where: { id: eOld.id }, data: { employmentStatus: 'Exit Process' } });
      const sent = [];
      const out = await P.remind({ now: r.endDate.getTime() - 5 * DAY + 10 * 3600e3, notify: async (ids, m) => sent.push(m.title), force: true });
      assert.ok(!sent.some((x) => /ZZ Prob Old/.test(x)));
      void out;
    });

    await t('the settings screen data: only HR / Admin can reach the decision routes (route guard)', async () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/probation.js'), 'utf8');
      ['confirm', 'extend', 'end', 'reopen', 'track'].forEach((a) => assert.ok(new RegExp(`router\\.post\\('/:id/${a}', hrOnly`).test(src), a));
      assert.ok(/router\.put\('\/settings', hrOnly/.test(src));
    });
  } finally {
    await cleanup();
    if (savedSettings) await prisma.appSetting.upsert({ where: { key: 'probation.settings' }, update: { value: savedSettings.value }, create: { key: 'probation.settings', value: savedSettings.value } }).catch(() => {});
    console.log(`${passed} checks passed`);
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch { /* */ } process.exit(1); });
