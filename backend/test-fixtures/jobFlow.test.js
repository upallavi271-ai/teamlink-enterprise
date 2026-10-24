// Naukri -> Shine by-hand workflow: rules + service, run against a COPY of the database (never the real one).
//   node backend/test-fixtures/jobFlow.test.js
// The copy is made with SQLite's VACUUM INTO (a read of the real file, written to a temp file) and deleted afterwards.
// No portal is contacted: the service never contacts one. The permission check and the audit log are replaced by recorders.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/jobFlow/logic');

const S = L.STATUS;
// ---- 1. pure rules ---------------------------------------------------------------------------------------------
assert.deepEqual(L.missingFields({ title: 'x' }), ['Location', 'Experience', 'Skills', 'Employment type', 'Job description']);
assert.deepEqual(L.missingFields({ title: 'a', location: 'b', experience: '2', skills: 's', employmentType: 'Full Time', jobDescription: 'd' }), []);
assert.equal(L.next('naukri', null, 'start'), S.READY_NAUKRI);
assert.equal(L.next('naukri', S.READY_NAUKRI, 'confirm'), null, 'a tab that was never opened can not be confirmed');
assert.equal(L.next('naukri', S.READY_NAUKRI, 'opened'), S.NAUKRI_OPENED);
assert.equal(L.next('naukri', S.NAUKRI_OPENED, 'await'), S.AWAIT_NAUKRI);
assert.equal(L.next('naukri', S.AWAIT_NAUKRI, 'confirm'), S.NAUKRI_CONFIRMED);
assert.equal(L.next('shine', null, 'opening', { naukri: S.AWAIT_NAUKRI }), null, 'Shine never opens before Naukri is confirmed');
assert.equal(L.next('shine', null, 'opening', { naukri: S.NAUKRI_CONFIRMED }), S.OPENING_SHINE);
assert.equal(L.next('shine', null, 'opening', { standalone: true }), S.OPENING_SHINE, 'the old Shine-only way still works');
assert.equal(L.next('shine', S.OPENING_SHINE, 'complete'), null, 'opening Shine is not posting on Shine');
assert.equal(L.next('shine', S.SHINE_PENDING, 'complete'), S.DONE);
assert.equal(L.next('naukri', S.NAUKRI_CONFIRMED, 'fail'), null, 'a confirmed step is not undone by a later failure');
assert.equal(L.next('naukri', S.NAUKRI_CONFIRMED, 'unconfirm'), S.AWAIT_NAUKRI, 'a wrong "I posted it" can be taken back');
assert.equal(L.next('naukri', S.AWAIT_NAUKRI, 'unconfirm'), null, 'nothing to undo before it was confirmed');
assert.equal(L.next('shine', S.DONE, 'unconfirm'), S.SHINE_PENDING);
assert.equal(L.next('shine', S.SHINE_OPENED, 'opening', { naukri: S.NAUKRI_CONFIRMED }), S.OPENING_SHINE, '"Open Shine again" always works');
assert.equal(L.resume([{ platform: 'naukri', status: S.AWAIT_NAUKRI }]).needs, 'confirm');
assert.deepEqual(L.resume([{ platform: 'naukri', status: S.NAUKRI_CONFIRMED }]), { step: 'shine', needs: 'open' });
assert.deepEqual(L.resume([{ platform: 'naukri', status: S.NAUKRI_CONFIRMED }, { platform: 'shine', status: S.DONE }]), { step: 'done', needs: null });
assert.deepEqual(L.resume([]), { step: 'none', needs: null });

// ---- 2. the service, on a copy ---------------------------------------------------------------------------------
(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const envUrl = (fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^DATABASE_URL=["']?file:([^"'\r\n]+)/m) || [])[1];
  const real = path.resolve(path.join(__dirname, '..', 'prisma'), envUrl);
  const copy = path.join(os.tmpdir(), `jobflow-test-${Date.now()}.db`);
  const src = new DatabaseSync(real, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  src.close();
  process.env.DATABASE_URL = `file:${copy.replace(/\\/g, '/')}`;
  assert.notEqual(path.resolve(copy), path.resolve(real));
  const prisma = require('../src/db');
  const { create } = require('../src/jobFlow/service');
  try {
    const job = await prisma.requirement.findFirst({ where: { status: 'OPEN' } });
    assert.ok(job, 'the copy has an open job');
    // make the COPY's job complete; it is only a copy
    await prisma.requirement.update({ where: { id: job.id }, data: { title: job.title || 'T', location: 'Hyderabad', experience: '2-5', skills: 'ICU', employmentType: 'Full Time', jobDescription: 'Care for patients.' } });
    const events = [];
    let may = true;
    const real1 = await prisma.user.findFirst({ select: { id: true, name: true } });
    const user = { id: real1 ? real1.id : 'u-test', name: real1 ? real1.name : 'Test Recruiter' };
    const F = create({
      prisma,
      access: { inScope: () => true, mayPost: async () => may, mayViewJob: async () => may },
      audit: async (e) => { events.push(e); },
    });
    const ok = async (p, ev, body) => { const r = await F.act(user, job.id, p, ev, body); assert.ok(r.ok, `${p} ${ev}: ${r.error}`); return r; };
    const st = (r, p) => r.rows.find((x) => x.platform === p).status;
    const posting = (board) => prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId: job.id, source: board } } });

    // 8. a login that may not post this job
    may = false;
    let r = await F.act(user, job.id, 'naukri', 'start');
    assert.equal(r.status, 403);
    assert.equal((await F.state(user, job.id)).status, 403);
    may = true;
    assert.deepEqual((await F.state(user, job.id)).rows, [], 'nothing was saved for the refused login');

    // 1. start: the official recruiter site is named, nothing is posted
    r = await ok('naukri', 'start');
    assert.equal(st(r, 'naukri'), S.READY_NAUKRI);
    assert.equal(r.urls.naukri, 'https://www.naukri.com/recruit/login');
    assert.equal(r.urls.shine, 'https://recruiter.shine.com/');
    // 5. confirming without opening, or opening Shine early, does not advance
    r = await F.act(user, job.id, 'naukri', 'confirm'); assert.equal(r.status, 409);
    r = await F.act(user, job.id, 'shine', 'opening'); assert.equal(r.status, 409);
    r = await ok('naukri', 'opened'); assert.equal(st(r, 'naukri'), S.NAUKRI_OPENED);
    r = await ok('naukri', 'await'); assert.equal(st(r, 'naukri'), S.AWAIT_NAUKRI);
    r = await F.act(user, job.id, 'shine', 'opening'); assert.equal(r.status, 409, 'still waiting for Naukri');
    assert.equal(await posting('naukri'), null, 'opening the tab is not posted');
    // 6. a refresh: the same state comes back, a second start makes no second row
    r = await F.state(user, job.id); assert.equal(r.resume.needs, 'confirm');
    await ok('naukri', 'start');
    assert.equal((await prisma.$queryRawUnsafe('SELECT COUNT(*) c FROM "JobPostFlow" WHERE "requirementId"=? AND "platform"=?', job.id, 'naukri'))[0].c.toString(), '1');
    // 2. the recruiter confirms: Naukri is "Posted by hand" (the recruiter's word), Shine may open
    r = await ok('naukri', 'confirm');
    assert.equal(st(r, 'naukri'), S.NAUKRI_CONFIRMED);
    assert.equal((await posting('naukri')).status, 'Posted by hand');
    // 3. nothing is recorded for Shine until the recruiter says so
    assert.equal(await posting('shine'), null);
    r = await ok('shine', 'opening'); assert.equal(st(r, 'shine'), S.OPENING_SHINE);
    assert.equal(await posting('shine'), null, 'opening Shine is not posted');
    // 4. popup blocked -> a safe, recoverable state, then a retry
    r = await ok('shine', 'action', { code: 'popup_blocked' });
    assert.equal(st(r, 'shine'), S.ACTION);
    assert.match(r.rows.find((x) => x.platform === 'shine').lastError, /blocked/);
    r = await ok('shine', 'retry'); assert.equal(st(r, 'shine'), S.OPENING_SHINE);
    assert.equal(r.rows.find((x) => x.platform === 'shine').retryCount, 2);
    r = await ok('shine', 'opened'); r = await ok('shine', 'await'); assert.equal(st(r, 'shine'), S.SHINE_PENDING);
    assert.equal(await posting('shine'), null);
    r = await ok('shine', 'complete'); assert.equal(st(r, 'shine'), S.DONE);
    assert.equal((await posting('shine')).status, 'Posted by hand');
    // 10. "I pressed it by mistake": Shine first, then Naukri; each goes back to Not posted and the flow waits for Naukri again
    r = await F.act(user, job.id, 'naukri', 'unconfirm'); assert.equal(r.status, 409, 'Naukri can not be undone while Shine is still marked posted');
    r = await ok('shine', 'unconfirm'); assert.equal(st(r, 'shine'), S.SHINE_PENDING);
    assert.equal(await posting('shine'), null, 'Shine is not Posted by hand any more');
    r = await ok('shine', 'opening'); assert.equal(st(r, 'shine'), S.OPENING_SHINE, 'Open Shine again works from a pending Shine');
    r = await ok('naukri', 'unconfirm'); assert.equal(st(r, 'naukri'), S.AWAIT_NAUKRI);
    assert.equal(await posting('naukri'), null, 'Naukri is not Posted by hand any more');
    assert.equal(st(r, 'shine'), S.SAVED, 'Shine waits again');
    assert.equal(r.resume.step, 'naukri'); assert.equal(r.resume.needs, 'confirm');
    r = await F.act(user, job.id, 'shine', 'opening'); assert.equal(r.status, 409, 'Shine does not open until Naukri is confirmed again');
    r = await ok('naukri', 'confirm'); assert.equal(st(r, 'naukri'), S.NAUKRI_CONFIRMED);
    // 9. every step is in the audit log, with the before and after
    assert.ok(events.length >= 11, `audit events: ${events.length}`);
    assert.ok(events.every((e) => e.entity === 'Requirement' && e.entityId === job.id && /Post workflow/.test(e.action)));
    // missing fields are listed and block the start
    await prisma.requirement.update({ where: { id: job.id }, data: { skills: '' } });
    await prisma.$executeRawUnsafe('DELETE FROM "JobPostFlow" WHERE "requirementId"=?', job.id);
    r = await F.act(user, job.id, 'naukri', 'start');
    assert.equal(r.code, 'MISSING_FIELDS'); assert.deepEqual(r.missing, ['Skills']);
    console.log(`jobFlow: all checks passed (${events.length} audit events, run on a copy of the database)`);
  } finally {
    await prisma.$disconnect().catch(() => {});
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) { try { fs.unlinkSync(f); } catch { /* ok */ } }
  }
})().catch((e) => { console.error(e); process.exit(1); });
