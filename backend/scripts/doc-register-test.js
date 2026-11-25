#!/usr/bin/env node
// ---------------------------------------------------------------------------
// DOCUMENT EXPIRY, NDAs AND POLICY VERSIONS - utils/docRegister.js and utils/policyRegister.js. It plants a few ZZ-DR people and one
// policy in the SANDBOX database, runs the whole life of an item and of a policy, and removes everything it made. It refuses to run
// outside the test sandbox.
//   cd backend && TEST_MODE=1 DATABASE_URL="file:./sandbox.db" node -r dotenv/config scripts/doc-register-test.js
// ---------------------------------------------------------------------------
/* eslint-disable no-console, global-require */
const assert = require('assert');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
if (!truthy(process.env.TEST_MODE) && !truthy(process.env.TEAMLINK_SANDBOX)) {
  console.error('Refusing to run: this test writes to the database. Run it with TEST_MODE=1 against the sandbox.');
  process.exit(2);
}
const prisma = require('../src/db');
const DR = require('../src/utils/docRegister');
const PR = require('../src/utils/policyRegister');

const DAY = 86400000;
const now = Date.now();
const stamp = String(now).slice(-6);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const made = { employees: [], users: [], policies: [] };
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

async function cleanup() {
  const del = async (fn) => { try { await fn(); } catch { /* already gone */ } };
  const eids = made.employees;
  const pids = made.policies;
  if (eids.length) {
    await del(() => prisma.trackedDocument.deleteMany({ where: { employeeId: { in: eids } } }));
    await del(() => prisma.employeeDocument.deleteMany({ where: { employeeId: { in: eids } } }));
  }
  if (pids.length) {
    await del(() => prisma.policyAckVersion.deleteMany({ where: { policyId: { in: pids } } }));
    await del(() => prisma.policyVersion.deleteMany({ where: { policyId: { in: pids } } }));
    await del(() => prisma.policyRegister.deleteMany({ where: { policyId: { in: pids } } }));
    await del(() => prisma.acknowledgment.deleteMany({ where: { documentId: { in: pids } } }));
    await del(() => prisma.policyDocument.deleteMany({ where: { id: { in: pids } } }));
  }
  if (eids.length) await del(() => prisma.employee.deleteMany({ where: { id: { in: eids } } }));
  if (made.users.length) {
    await del(() => prisma.notification.deleteMany({ where: { userId: { in: made.users } } }));
    await del(() => prisma.user.deleteMany({ where: { id: { in: made.users } } }));
  }
  await del(() => prisma.appSetting.deleteMany({ where: { key: { in: ['docregister.settings', 'docregister.sweep'] } } }));
}

(async () => {
  console.log('Document expiry, NDAs and policy versions');
  const saved = await prisma.appSetting.findUnique({ where: { key: 'docregister.settings' } }).catch(() => null);
  try {
    await prisma.appSetting.deleteMany({ where: { key: { in: ['docregister.settings', 'docregister.sweep'] } } });
    const mkUser = async (tag, extra = {}) => {
      const u = await prisma.user.create({ data: { name: `ZZ DR ${tag}`, email: `zzdr-${tag}-${stamp}@example.test`, passwordHash: 'x', role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', status: 'Active', ...extra } });
      made.users.push(u.id); return u;
    };
    const mkEmp = async (tag, extra = {}) => {
      const e = await prisma.employee.create({ data: { employeeCode: `ZZD-${tag}-${stamp}`, name: `ZZ DR ${tag}`, department: 'ZZ DR One', designation: 'Executive', employmentStatus: 'Active', dateOfJoining: new Date(now - 400 * DAY), ...extra } });
      made.employees.push(e.id); return e;
    };
    const uHr = await mkUser('HR', { role: 'HR', hrmsRole: 'HR' });
    const uA = await mkUser('A'); const uB = await mkUser('B'); const uC = await mkUser('C'); const uGone = await mkUser('Gone');
    const eA = await mkEmp('A', { userId: uA.id });
    const eB = await mkEmp('B', { userId: uB.id });
    const eC = await mkEmp('C', { userId: uC.id, department: 'ZZ DR Two' });
    const eGone = await mkEmp('Gone', { userId: uGone.id, employmentStatus: 'Relieved' });
    const hr = await prisma.user.findUnique({ where: { id: uHr.id } });
    const mine = (rows) => rows.filter((r) => String(r.employeeCode || '').startsWith('ZZD-') && String(r.employeeCode).endsWith(stamp));
    const ids = {};
    const add = async (key, body) => { const o = await DR.createItem(hr, body); assert.ok(!o.error, o.error); ids[key] = o.item.id; return o.item; };

    await t('milestones: 60, 30, 7, today and weekly when overdue', async () => {
      assert.strictEqual(DR.milestoneOf(90), null);
      assert.strictEqual(DR.milestoneOf(60).mark, 'm60');
      assert.strictEqual(DR.milestoneOf(30).mark, 'm30');
      assert.strictEqual(DR.milestoneOf(7).mark, 'm7');
      assert.strictEqual(DR.milestoneOf(0).mark, 'm0');
      assert.strictEqual(DR.milestoneOf(-3).mark, 'o0');
      assert.strictEqual(DR.milestoneOf(-8).mark, 'o1');
    });

    await t('adding an item: it needs an employee, a known kind, a name, an expiry for a document and sane dates', async () => {
      assert.ok((await DR.createItem(hr, { kind: 'Document', title: 'Passport', expiresOn: ymd(now + DAY) })).error);
      assert.ok((await DR.createItem(hr, { employeeId: eA.id, kind: 'Selfie', title: 'x', expiresOn: ymd(now + DAY) })).error);
      assert.ok((await DR.createItem(hr, { employeeId: eA.id, kind: 'Document', expiresOn: ymd(now + DAY) })).error, 'a name is needed');
      assert.ok((await DR.createItem(hr, { employeeId: eA.id, kind: 'Document', title: 'Passport' })).error, 'a document needs an expiry');
      assert.ok((await DR.createItem(hr, { employeeId: eA.id, kind: 'Document', title: 'Passport', expiresOn: 'soon' })).error);
      assert.ok((await DR.createItem(hr, { employeeId: eA.id, kind: 'Document', title: 'Passport', issuedOn: ymd(now + 5 * DAY), expiresOn: ymd(now + DAY) })).error, 'expiry before issue');
    });

    await t('statuses: expired, due soon, valid, and an NDA with no end date', async () => {
      await add('expired', { employeeId: eA.id, kind: 'Document', title: 'Driving licence', issuedOn: ymd(now - 900 * DAY), expiresOn: ymd(now - 3 * DAY) });
      await add('soon', { employeeId: eA.id, kind: 'Document', title: 'Visa', expiresOn: ymd(now + 10 * DAY) });
      await add('valid', { employeeId: eB.id, kind: 'Document', title: 'Passport', expiresOn: ymd(now + 200 * DAY) });
      await add('nda', { employeeId: eA.id, kind: 'NDA', title: 'NDA', issuedOn: ymd(now - 30 * DAY) });
      const st = async (b) => mine((await DR.list({ bucket: b })).rows).map((r) => r.title).sort();
      assert.deepStrictEqual(await st('expired'), ['Driving licence']);
      assert.deepStrictEqual(await st('soon'), ['Visa']);
      assert.deepStrictEqual(await st('valid'), ['Passport']);
      assert.deepStrictEqual(await st('noExpiry'), ['NDA']);
      assert.deepStrictEqual(await st('agreements'), ['NDA']);
      assert.strictEqual((await st('all')).length, 4);
      const e = mine((await DR.list({ bucket: 'expired' })).rows)[0];
      assert.strictEqual(e.daysLeft, -3);
      assert.strictEqual(e.status, 'Expired');
    });

    await t('the list is sorted with the soonest expiry first and searchable', async () => {
      const rows = mine((await DR.list({ bucket: 'all' })).rows);
      const withDays = rows.filter((r) => r.daysLeft !== null).map((r) => r.daysLeft);
      assert.deepStrictEqual(withDays, [...withDays].sort((a, b) => a - b));
      assert.strictEqual(rows[rows.length - 1].title, 'NDA', 'no-date items last');
      assert.strictEqual(mine((await DR.list({ bucket: 'all', q: 'visa' })).rows).length, 1);
      assert.strictEqual(mine((await DR.list({ bucket: 'all', kind: 'NDA' })).rows).length, 1);
    });

    await t('who has no NDA on record: A has one, B does not, and a person who left is not listed', async () => {
      let r = mine((await DR.noNda({})).rows).map((x) => x.name);
      assert.ok(r.includes(eB.name) && r.includes(eC.name));
      assert.ok(!r.includes(eA.name));
      assert.ok(!r.includes(eGone.name));
      await add('ndaB', { employeeId: eB.id, kind: 'NDA', title: 'NDA' });
      r = mine((await DR.noNda({})).rows).map((x) => x.name);
      assert.ok(!r.includes(eB.name));
    });

    await t('linking to an uploaded file: allowed for the same person, refused for another person', async () => {
      const f = await prisma.employeeDocument.create({ data: { employeeId: eA.id, docType: 'Passport', docName: 'x', file: 'x', fileName: 'passport-A.pdf' } });
      const other = await prisma.employeeDocument.create({ data: { employeeId: eB.id, docType: 'Passport', docName: 'x', file: 'x', fileName: 'passport-B.pdf' } });
      assert.ok((await DR.createItem(hr, { employeeId: eA.id, kind: 'Document', title: 'Passport', expiresOn: ymd(now + 400 * DAY), documentId: other.id })).error);
      const o = await DR.createItem(hr, { employeeId: eA.id, kind: 'Document', title: 'Passport', expiresOn: ymd(now + 400 * DAY), documentId: f.id });
      assert.ok(!o.error, o.error);
      ids.linked = o.item.id;
      assert.strictEqual(o.item.file.fileName, 'passport-A.pdf');
      const docs = await DR.documentsOf(eA.id);
      assert.ok(docs.rows.some((d) => d.id === f.id));
      assert.ok(!docs.rows.some((d) => d.id === other.id));
      const found = await DR.peopleFind('ZZ DR A');
      assert.ok(found.rows.some((p) => p.employeeId === eA.id));
    });

    await t('edit: dates change and are kept in the history; a document cannot lose its expiry', async () => {
      const o = await DR.updateItem(hr, ids.soon, { expiresOn: ymd(now + 15 * DAY), note: 'Renewal applied' });
      assert.ok(!o.error, o.error);
      assert.strictEqual(o.item.daysLeft, 15);
      assert.strictEqual(o.item.note, 'Renewal applied');
      assert.ok(o.item.history.some((h) => h.action === 'Edited' && h.to === ymd(now + 15 * DAY)));
      assert.ok((await DR.updateItem(hr, ids.soon, { expiresOn: '' })).error);
      assert.ok((await DR.updateItem(hr, 'nope', { title: 'x' })).error);
    });

    await t('renew: the new date must be later, the old one stays in the history, reminders start again', async () => {
      assert.ok((await DR.renewItem(hr, ids.expired, { expiresOn: ymd(now - 10 * DAY) })).error);
      assert.ok((await DR.renewItem(hr, ids.expired, { expiresOn: 'x' })).error);
      await prisma.trackedDocument.update({ where: { id: ids.expired }, data: { remindState: JSON.stringify({ o0: 'x' }) } });
      const o = await DR.renewItem(hr, ids.expired, { expiresOn: ymd(now + 365 * DAY), note: 'New licence' });
      assert.ok(!o.error, o.error);
      assert.strictEqual(o.item.status, 'Valid');
      const h = o.item.history.find((x) => x.action === 'Renewed');
      assert.strictEqual(h.from, ymd(now - 3 * DAY)); assert.strictEqual(h.to, ymd(now + 365 * DAY));
      assert.strictEqual((await prisma.trackedDocument.findUnique({ where: { id: ids.expired } })).remindState, null);
    });

    await t('remove takes it off the list but keeps the row and its history', async () => {
      assert.ok((await DR.removeItem(hr, ids.valid, { note: 'wrong person' })).ok);
      assert.ok(!mine((await DR.list({ bucket: 'all' })).rows).some((r) => r.id === ids.valid));
      const row = await prisma.trackedDocument.findUnique({ where: { id: ids.valid } });
      assert.strictEqual(row.status, 'Removed');
      assert.ok(JSON.parse(row.history).some((h) => h.action === 'Removed'));
      assert.ok((await DR.removeItem(hr, ids.valid, {})).error, 'cannot remove twice');
    });

    await t('reminders are OFF by default and say nothing; the employee is reminded too by default once they are on', async () => {
      const d = await DR.getSettings();
      assert.strictEqual(d.enabled, false); assert.strictEqual(d.tellEmployee, true);
      const sent = [];
      const out = await DR.remindExpiry({ now, notify: async (to, m) => sent.push({ to, m }) });
      assert.ok(out.skipped); assert.strictEqual(sent.length, 0);
    });

    await t('settings: due soon days 1-90; switching on works', async () => {
      assert.ok((await DR.saveSettings({ soonDays: 0 }, hr)).error);
      assert.ok((await DR.saveSettings({ soonDays: 91 }, hr)).error);
      const o = await DR.saveSettings({ enabled: true, soonDays: 20 }, hr);
      assert.strictEqual(o.settings.enabled, true); assert.strictEqual(o.settings.soonDays, 20);
      // 10 days is still "due soon", 25 days is not any more
      await DR.updateItem(hr, ids.soon, { expiresOn: ymd(now + 25 * DAY) });
      assert.strictEqual(mine((await DR.list({ bucket: 'soon' })).rows).length, 0);
      await DR.updateItem(hr, ids.soon, { expiresOn: ymd(now + 10 * DAY) });
      assert.strictEqual(mine((await DR.list({ bucket: 'soon' })).rows).length, 1);
    });

    await t('expiry reminders go to HR once per milestone, and not to the employee when HR switched that off', async () => {
      await DR.saveSettings({ tellEmployee: false }, hr);
      const sent = [];
      const notify = async (to, m) => sent.push({ to, title: m.title });
      let out = await DR.remindExpiry({ now, notify });
      const forVisa = sent.filter((s) => /Visa/.test(s.title));
      assert.strictEqual(forVisa.length, 1, JSON.stringify(sent.map((s) => s.title)));
      assert.ok(forVisa[0].to.includes(uHr.id));
      assert.ok(!sent.some((s) => s.to.includes(uA.id)), 'the employee is not told when HR switched that off');
      const before = sent.length;
      out = await DR.remindExpiry({ now, notify });
      assert.strictEqual(sent.length, before, 'a milestone is told once');
      void out;
    });

    await t('with "remind the employee too" the employee is told as well; a person who left is never reminded', async () => {
      await DR.saveSettings({ tellEmployee: true }, hr);
      const o = await DR.createItem(hr, { employeeId: eB.id, kind: 'Document', title: 'Medical certificate', expiresOn: ymd(now + 5 * DAY) });
      const g = await DR.createItem(hr, { employeeId: eGone.id, kind: 'Document', title: 'Gone passport', expiresOn: ymd(now + 5 * DAY) });
      assert.ok(!o.error && !g.error);
      const sent = [];
      await DR.remindExpiry({ now, notify: async (to, m) => sent.push({ to, title: m.title }) });
      assert.ok(sent.some((s) => s.to.includes(uB.id) && /Your Medical certificate/.test(s.title)), 'employee told');
      assert.ok(sent.some((s) => s.to.includes(uHr.id) && /Medical certificate/.test(s.title)), 'HR told');
      assert.ok(!sent.some((s) => /Gone passport/.test(s.title)), 'a person who left is skipped');
    });

    await t('an overdue item is told weekly, not every day', async () => {
      const it = await DR.createItem(hr, { employeeId: eC.id, kind: 'Document', title: 'Old permit', expiresOn: ymd(now - 2 * DAY) });
      const sent = [];
      const notify = async (to, m) => sent.push(m.title);
      await DR.remindExpiry({ now, notify });
      assert.ok(sent.some((s) => /Expired: Old permit/.test(s)));
      sent.length = 0;
      await DR.remindExpiry({ now: now + 3 * DAY, notify });
      assert.ok(!sent.some((s) => /Old permit/.test(s)), 'not again within the week');
      await DR.remindExpiry({ now: now + 8 * DAY, notify });
      assert.ok(sent.some((s) => /Old permit/.test(s)), 'again after a week');
      void it;
    });

    // ---- policies ----------------------------------------------------------------------------------------------------------------
    const policy = await prisma.policyDocument.create({ data: { title: `ZZ DR Code of Conduct ${stamp}`, category: 'Policy', mandatory: true, published: true, approvalStatus: 'Approved', departments: 'ZZ DR One', uploadedBy: 'ZZ DR HR', uploadedDate: ymd(now - 200 * DAY), createdAt: new Date(now - 200 * DAY) } });
    made.policies.push(policy.id);
    await prisma.acknowledgment.create({ data: { documentId: policy.id, employeeId: eA.id, acknowledgedAt: new Date(now - 150 * DAY) } });
    const people = async () => Object.fromEntries((await PR.detail(policy.id)).people.filter((p) => String(p.employeeCode).endsWith(stamp)).map((p) => [p.name, p]));

    await t('a policy with no revisions is version 1: A accepted it, B did not, C (another department) is not in its audience', async () => {
      const d = await PR.detail(policy.id);
      assert.strictEqual(d.policy.currentVersion, 1);
      assert.strictEqual(d.versions.length, 0);
      const p = await people();
      assert.strictEqual(p[eA.name].state, 'Current'); assert.strictEqual(p[eA.name].versionRead, 1);
      assert.strictEqual(p[eB.name].state, 'Not acknowledged');
      assert.ok(!p[eC.name]);
      assert.ok(!p[eGone.name]);
    });

    await t('recording a version: version 1 is made as the original issue, then version 2; an ordinary change does not ask for re-acceptance', async () => {
      assert.ok((await PR.recordVersion(hr, policy.id, { summary: 'x' })).error);
      assert.ok((await PR.recordVersion(hr, 'nope', { summary: 'Something changed' })).status === 404);
      const o = await PR.recordVersion(hr, policy.id, { summary: 'Typo and layout fixes', effectiveOn: ymd(now - 20 * DAY) });
      assert.ok(!o.error, o.error);
      assert.deepStrictEqual(o.versions.map((v) => v.versionNo), [2, 1]);
      assert.strictEqual(o.versions[1].summary, 'Original issue');
      assert.strictEqual(o.policy.currentVersion, 2);
      assert.strictEqual((await people())[eA.name].state, 'Current');
      assert.ok(o.history.some((h) => /Version 2/.test(h.action)));
    });

    await t('a version that must be accepted again turns the people who read an older one into "Needs re-acknowledgement"', async () => {
      await prisma.policyVersion.updateMany({ where: { policyId: policy.id, versionNo: 2 }, data: { recordedAt: new Date(now - 100 * DAY) } });
      await prisma.acknowledgment.create({ data: { documentId: policy.id, employeeId: eB.id, acknowledgedAt: new Date(now - 50 * DAY) } });
      const o = await PR.recordVersion(hr, policy.id, { summary: 'New leave rules; everybody must accept again', requireReack: true });
      assert.ok(!o.error, o.error);
      assert.strictEqual(o.policy.currentVersion, 3);
      const p = await people();
      assert.strictEqual(p[eA.name].state, 'Needs re-acknowledgement');
      assert.strictEqual(p[eA.name].versionRead, 1);
      assert.strictEqual(p[eB.name].state, 'Needs re-acknowledgement');
      assert.strictEqual(p[eB.name].versionRead, 2, 'B accepted it while version 2 was in force');
      assert.strictEqual(o.told, 2, 'the two people who must accept again are told');
      assert.ok(await prisma.notification.count({ where: { userId: uA.id, title: { contains: 'Policy updated' } } }) >= 1);
    });

    await t('the employee side: pending list, accept the current version, not twice, not when never accepted, not outside the audience', async () => {
      const a = await prisma.user.findUnique({ where: { id: uA.id } });
      const mp = await PR.myPending(a);
      assert.strictEqual(mp.rows.length, 1); assert.strictEqual(mp.rows[0].currentVersion, 3);
      const ok = await PR.reack(a, policy.id);
      assert.ok(ok.ok, ok.error); assert.strictEqual(ok.version, 3);
      assert.strictEqual((await people())[eA.name].state, 'Current');
      assert.strictEqual((await people())[eA.name].versionRead, 3);
      assert.strictEqual((await PR.reack(a, policy.id)).status, 409);
      assert.strictEqual((await PR.myPending(a)).rows.length, 0);
      const c = await prisma.user.findUnique({ where: { id: uC.id } });
      assert.strictEqual((await PR.reack(c, policy.id)).status, 403);
      // a person who has never accepted it must use the Documents page first
      await prisma.acknowledgment.deleteMany({ where: { documentId: policy.id, employeeId: eB.id } });
      const b = await prisma.user.findUnique({ where: { id: uB.id } });
      assert.strictEqual((await PR.reack(b, policy.id)).status, 409);
      await prisma.acknowledgment.create({ data: { documentId: policy.id, employeeId: eB.id, acknowledgedAt: new Date(now - 50 * DAY) } });
    });

    await t('the old Acknowledgment rows are never changed', async () => {
      const rows = await prisma.acknowledgment.findMany({ where: { documentId: policy.id } });
      assert.strictEqual(rows.length, 2);
      assert.ok(rows.every((r) => r.acknowledgedAt.getTime() < now - 40 * DAY));
    });

    await t('review plan: every N months from the last review (or the issue date); marking it reviewed moves the date', async () => {
      assert.ok((await PR.setReview(hr, policy.id, { reviewEveryMonths: 0 })).error);
      assert.ok((await PR.setReview(hr, policy.id, { reviewEveryMonths: 61 })).error);
      let o = await PR.setReview(hr, policy.id, { reviewEveryMonths: 6, ownerName: 'HR Head' });
      assert.ok(!o.error, o.error);
      assert.strictEqual(o.policy.review.everyMonths, 6);
      assert.strictEqual(o.policy.review.nextReviewOn, PR.addMonths(ymd(now - 200 * DAY), 6));
      assert.strictEqual(o.policy.review.state, 'Overdue', 'issued 200 days ago, 6 months = 183 days');
      o = await PR.markReviewed(hr, policy.id, { note: 'Read through with legal' });
      assert.ok(!o.error, o.error);
      assert.strictEqual(o.policy.review.lastReviewedOn, ymd(now));
      assert.strictEqual(o.policy.review.nextReviewOn, PR.addMonths(ymd(now), 6));
      assert.strictEqual(o.policy.review.state, 'On track');
      assert.ok(o.history.some((h) => h.action === 'Reviewed' && /legal/.test(h.note)));
      o = await PR.setReview(hr, policy.id, { reviewEveryMonths: '' });
      assert.strictEqual(o.policy.review.state, 'No plan');
    });

    await t('review reminders: HR is told 30 days before, on the day, and weekly when late; each once', async () => {
      await PR.setReview(hr, policy.id, { reviewEveryMonths: 6 });
      const reg = await prisma.policyRegister.findUnique({ where: { policyId: policy.id } });
      await prisma.policyRegister.update({ where: { id: reg.id }, data: { nextReviewOn: new Date(`${ymd(now + 10 * DAY)}T00:00:00Z`), remindState: null } });
      const sent = [];
      const notify = async (to, m) => sent.push({ to, title: m.title });
      const mineTold = (r) => r.told.filter((x) => x.policyId === policy.id).length;
      let out = await PR.remindReviews({ now, notify });
      assert.strictEqual(mineTold(out), 1);
      assert.ok(sent.some((s) => /review due in 10 days/.test(s.title) && s.to.includes(uHr.id)));
      out = await PR.remindReviews({ now, notify });
      assert.strictEqual(mineTold(out), 0, 'once');
      out = await PR.remindReviews({ now: now + 10 * DAY, notify });
      assert.strictEqual(mineTold(out), 1, 'on the day');
      out = await PR.remindReviews({ now: now + 12 * DAY, notify });
      assert.strictEqual(mineTold(out), 1, 'overdue the first time');
      out = await PR.remindReviews({ now: now + 14 * DAY, notify });
      assert.strictEqual(mineTold(out), 0, 'overdue is weekly');
    });

    await t('the register list and its tabs: mandatory, needs re-acknowledgement, not accepted, review due, no plan', async () => {
      const all = await PR.listPolicies({ bucket: 'all', q: stamp });
      assert.strictEqual(all.rows.length, 1);
      const r = all.rows[0];
      assert.strictEqual(r.mandatory, true); assert.strictEqual(r.currentVersion, 3); assert.strictEqual(r.audience, 2);
      assert.strictEqual(r.current, 1); assert.strictEqual(r.needsReack, 1); assert.strictEqual(r.notAcknowledged, 0);
      assert.strictEqual((await PR.listPolicies({ bucket: 'reack', q: stamp })).rows.length, 1);
      assert.strictEqual((await PR.listPolicies({ bucket: 'pending', q: stamp })).rows.length, 0);
      assert.strictEqual((await PR.listPolicies({ bucket: 'mandatory', q: stamp })).rows.length, 1);
      const ov = await PR.overview();
      assert.ok(ov.needsReack >= 1);
    });

    await t('the acceptance list names every person with status, version read and date', async () => {
      const d = await PR.detail(policy.id);
      const a = d.people.find((p) => p.name === eA.name);
      assert.strictEqual(a.versionRead, 3); assert.ok(a.acknowledgedOn);
      assert.ok(d.people.every((p) => ['Current', 'Needs re-acknowledgement', 'Not acknowledged'].includes(p.state)));
      assert.ok(!('userId' in d.people[0]), 'no login ids in the list');
    });

    await t('route guard: only the employee routes are open to any login, everything else is HR / Admin', async () => {
      const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/docRegister.js'), 'utf8');
      const guard = src.indexOf('router.use(hrOnly)');
      assert.ok(guard > 0);
      assert.ok(src.indexOf("router.get('/my-policies'") < guard);
      assert.ok(src.indexOf("router.post('/policies/:id/reack'") < guard);
      ['/items', '/settings', '/policies', '/people', '/sweep', '/overview'].forEach((p) => assert.ok(src.indexOf(`router.get('${p}'`) > guard || src.indexOf(`router.put('${p}'`) > guard || src.indexOf(`router.post('${p}'`) > guard, p));
    });

    await t('the nightly sweep does both jobs once a day, and not before 9 am India time', async () => {
      await prisma.appSetting.deleteMany({ where: { key: 'docregister.sweep' } });
      const early = await DR.sweep({ now: new Date(`${ymd(now)}T01:00:00Z`).getTime(), notify: async () => {} }); // 06:30 IST
      assert.ok(early.skipped);
      const ran = await DR.sweep({ now: new Date(`${ymd(now)}T08:00:00Z`).getTime(), notify: async () => {} }); // 13:30 IST
      assert.ok(ran.expiry && ran.reviews);
      const again = await DR.sweep({ now: new Date(`${ymd(now)}T09:00:00Z`).getTime(), notify: async () => {} });
      assert.ok(again.skipped, 'a second run on the same day does nothing');
    });
  } finally {
    await cleanup();
    if (saved) await prisma.appSetting.upsert({ where: { key: 'docregister.settings' }, update: { value: saved.value }, create: { key: 'docregister.settings', value: saved.value } }).catch(() => {});
    console.log(`${passed} checks passed`);
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error(e); try { await cleanup(); } catch { /* */ } process.exit(1); });
