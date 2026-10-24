#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FOUNDER 2026-10-24: (1) what a TL or HR uploads in Documents / LMS climbs the approval chain to the Super Admin; (2) any department can send
// feedback to the R&D team from the Timesheet; (3) a developer-team Admin login that is not headcount and shows no data. SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/upload-approvals-test.js
// ---------------------------------------------------------------------------
const path = require('path');
const { spawnSync } = require('child_process');
const Z = require('./lib/zzfix')('UPA');

const TAGGED = 'ZZTEST UPA';
const day = new Date().toISOString().slice(0, 10);

// Walk a record up its chain: the current approver decides, until nothing is pending. Returns the levels in the order they acted.
async function climb(patchPath, wf, recordId, decision = 'Approved', note = undefined, { stopBeforeLast = false } = {}) {
  const levels = [];
  for (let i = 0; i < 12; i += 1) {
    const steps = await Z.prisma.approvalStep.findMany({ where: { workflow: wf, recordId }, orderBy: { seq: 'asc' } });
    const cur = steps.find((s) => s.status === 'Pending');
    if (!cur) break;
    if (stopBeforeLast && !steps.some((s) => s.status === 'Waiting' && s.mode === 'required')) break;
    const tok = await Z.mint({ id: cur.approverUserId });
    // eslint-disable-next-line no-await-in-loop
    const r = await Z.call('PATCH', patchPath, tok, { status: decision, reason: note });
    levels.push({ level: cur.level, status: r.status });
    if (r.status !== 200) break;
    if (decision === 'Rejected') break;
  }
  return levels;
}

(async () => {
  try {
    const { prisma } = Z;
    // the Super Admin the chain itself picks (the one linked to an employee record); the starting-password test logins cannot call the API
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', passwordResetRequired: false, employee: { isNot: null } }, orderBy: { createdAt: 'asc' } })
      || await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', passwordResetRequired: false }, orderBy: { createdAt: 'asc' } });
    if (!sa) throw new Error('the sandbox has no Super Admin to act as the last approver');
    const saTok = await Z.mint(sa);

    // people ---------------------------------------------------------------------------------------------------------------------------------------
    const tl = await Z.mkUser('tl', { role: 'TL', hrmsRole: 'TL', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'TL', department: 'Medical' });
    const worker = await Z.mkUser('worker', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'Medical' });
    const outsider = await Z.mkUser('outsider', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'Education' });
    const hr = await Z.mkUser('hr', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'HR Executive', department: 'HR' });
    const hrDesk = await Z.mkUser('hrdesk', { role: 'EMPLOYEE', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }); // a shared desk login: NO employee record
    const admin = await Z.mkUser('admin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true }); // a login-only Admin
    const wEmp = await prisma.employee.findFirst({ where: { userId: worker.id } });
    const tTok = await Z.mint(tl); const wTok = await Z.mint(worker); const oTok = await Z.mint(outsider);
    const hTok = await Z.mint(hr); const dTok = await Z.mint(hrDesk); const aTok = await Z.mint(admin);
    const aud = { mode: 'individuals', employeeIds: [wEmp.id] };
    const docBody = (title, extra = {}) => ({ title: `${TAGGED} ${title}`, category: 'Policy', mandatory: false, uploadedDate: day, audience: aud, ...extra });
    const madeDocs = []; const madeCourses = []; const madeMaterials = []; const madeTasks = [];

    // ---- 1. DOCUMENTS ---------------------------------------------------------------------------------------------------------------------------
    const up = await Z.call('POST', '/api/documents', tTok, docBody('TL doc'));
    madeDocs.push(up.body && up.body.id);
    Z.check('D1 a TL can submit a document; it comes back Pending, not published', up.status === 201 && up.body.pendingApproval === true && up.body.approvalStatus === 'Pending' && up.body.published === false, [up.status, up.text.slice(0, 200)]);
    const row = await prisma.policyDocument.findUnique({ where: { id: up.body.id } });
    Z.check('D2 stored as Pending and unpublished', row.approvalStatus === 'Pending' && row.published === false);
    const steps0 = await prisma.approvalStep.findMany({ where: { workflow: 'document', recordId: up.body.id }, orderBy: { seq: 'asc' } });
    const cur0 = steps0.find((s) => s.status === 'Pending');
    Z.check('D3 a chain was laid down with somebody to decide first, above the TL (never the TL)', !!cur0 && cur0.level !== 'TL' && cur0.approverUserId !== tl.id, steps0.map((s) => `${s.level}:${s.status}`));
    Z.check('D4 the last required rung is the Super Admin', steps0.filter((s) => s.mode === 'required' && s.status !== 'Skipped').slice(-1)[0]?.level === 'SUPER_ADMIN', steps0.map((s) => `${s.level}:${s.status}:${s.mode}`));
    const wList = await Z.call('GET', '/api/documents', wTok);
    Z.check('D5 the employee it was sent to does not see it yet', wList.status === 200 && !wList.text.includes(up.body.id), wList.status);
    const oList = await Z.call('GET', '/api/documents', oTok);
    Z.check('D6 nor does an unrelated employee', oList.status === 200 && !oList.text.includes(up.body.id));
    const tList = await Z.call('GET', '/api/documents', tTok);
    const mine = (tList.body || []).find((d) => d.id === up.body.id);
    Z.check('D7 the uploader sees it, marked Pending, with who it waits for', !!mine && mine.approvalStatus === 'Pending' && mine.workflow && mine.workflow.currentOwnerName, mine);
    const ack = await Z.call('POST', `/api/documents/${up.body.id}/acknowledge`, wTok);
    Z.check('D8 it cannot be acknowledged while Pending (403)', ack.status === 403, ack.status);
    const vis = await Z.call('PUT', `/api/documents/${up.body.id}/visibility`, hTok);
    Z.check('D9 HR cannot flip it to published by hand while it waits (409)', vis.status === 409, [vis.status, vis.text.slice(0, 150)]);
    const bad = await Z.call('PATCH', `/api/documents/${up.body.id}/decision`, wTok, { status: 'Approved' });
    Z.check('D10 an ordinary employee cannot decide it (403)', bad.status === 403, bad.status);
    // rejection needs a reason
    const noReason = await Z.call('PATCH', `/api/documents/${up.body.id}/decision`, await Z.mint({ id: cur0.approverUserId }), { status: 'Rejected' });
    Z.check('D11 a rejection without a reason is refused (400)', noReason.status === 400, [noReason.status, noReason.text.slice(0, 150)]);

    // climb the ladder, one rung at a time
    const nBefore = await prisma.notification.count({ where: { userId: worker.id, OR: [{ title: { contains: TAGGED } }, { message: { contains: TAGGED } }] } });
    const levels = await climb(`/api/documents/${up.body.id}/decision`, 'document', up.body.id);
    const after = await prisma.policyDocument.findUnique({ where: { id: up.body.id } });
    Z.check('D12 every rung decided in turn and the last one was the Super Admin', levels.length >= 1 && levels.every((l) => l.status === 200) && levels[levels.length - 1].level === 'SUPER_ADMIN', levels);
    Z.check('D13 after the last approval it is Approved and published', after.approvalStatus === 'Approved' && after.published === true, after);
    const wList2 = await Z.call('GET', '/api/documents', wTok);
    Z.check('D14 now the employee it was sent to sees it', (wList2.body || []).some((d) => d.id === up.body.id), wList2.status);
    const nAfter = await prisma.notification.count({ where: { userId: worker.id, OR: [{ title: { contains: TAGGED } }, { message: { contains: TAGGED } }] } });
    Z.check('D15 and was told about it only then (one new notice at the end)', nAfter === nBefore + 1, [nBefore, nAfter]);
    const ack2 = await Z.call('POST', `/api/documents/${up.body.id}/acknowledge`, wTok);
    Z.check('D16 and can acknowledge it', ack2.status === 201, ack2.status);

    // a rejection ends it
    const rej = await Z.call('POST', '/api/documents', tTok, docBody('TL doc to reject'));
    madeDocs.push(rej.body && rej.body.id);
    const rl = await climb(`/api/documents/${rej.body.id}/decision`, 'document', rej.body.id, 'Rejected', 'ZZTEST UPA not needed');
    const rrow = await prisma.policyDocument.findUnique({ where: { id: rej.body.id } });
    Z.check('D17 a rejection keeps it unpublished and marks it Rejected', rl.length === 1 && rl[0].status === 200 && rrow.approvalStatus === 'Rejected' && rrow.published === false, [rl, rrow.approvalStatus]);
    const again = await Z.call('PATCH', `/api/documents/${rej.body.id}/decision`, saTok, { status: 'Approved' });
    Z.check('D18 a decided document cannot be decided again (409)', again.status === 409, again.status);

    // HR climbs too, starting ABOVE HR
    const hu = await Z.call('POST', '/api/documents', hTok, docBody('HR doc'));
    madeDocs.push(hu.body && hu.body.id);
    const hSteps = await prisma.approvalStep.findMany({ where: { workflow: 'document', recordId: hu.body.id }, orderBy: { seq: 'asc' } });
    Z.check('D19 an HR upload is Pending and starts above HR (TL, STL and HR rungs skipped)', hu.status === 201 && hu.body.pendingApproval === true
      && hSteps.filter((s) => ['TL', 'STL', 'HR'].includes(s.level)).every((s) => s.status === 'Skipped'), hSteps.map((s) => `${s.level}:${s.status}`));
    // the shared HR desk login (no employee record) is NOT let through
    const du = await Z.call('POST', '/api/documents', dTok, docBody('HR desk doc'));
    madeDocs.push(du.body && du.body.id);
    Z.check('D20 the shared HR desk login (no employee record) also goes through the chain', du.status === 201 && du.body.pendingApproval === true, [du.status, du.text.slice(0, 200)]);
    // company documents: approved, but never published
    const cu = await Z.call('POST', '/api/documents', hTok, { title: `${TAGGED} company paper`, category: 'Company Documents', uploadedDate: day, target: 'Internal only' });
    madeDocs.push(cu.body && cu.body.id);
    await climb(`/api/documents/${cu.body.id}/decision`, 'document', cu.body.id);
    const crow = await prisma.policyDocument.findUnique({ where: { id: cu.body.id } });
    Z.check('D21 a Company Document is approved through the chain and is STILL never published to employees', crow.approvalStatus === 'Approved' && crow.published === false, crow);
    // a real Admin publishes at once
    const au = await Z.call('POST', '/api/documents', aTok, docBody('Admin doc'));
    madeDocs.push(au.body && au.body.id);
    const aSteps = await prisma.approvalStep.count({ where: { workflow: 'document', recordId: au.body.id } });
    Z.check('D22 a real Admin\'s document publishes straight away (no chain)', au.status === 201 && !au.body.pendingApproval && au.body.published === true && aSteps === 0, [au.status, au.body && au.body.published, aSteps]);
    // an employee cannot upload at all
    const eu = await Z.call('POST', '/api/documents', wTok, docBody('Employee doc'));
    Z.check('D23 an ordinary employee still cannot upload (403)', eu.status === 403, eu.status);

    // ---- 2. LMS ---------------------------------------------------------------------------------------------------------------------------------
    const course = await Z.call('POST', '/api/lms/courses', aTok, { title: `${TAGGED} course`, category: 'Test', requireAssessment: false });
    madeCourses.push(course.body && course.body.id);
    Z.check('L1 a login-only Admin\'s course is live at once', course.status === 201 && course.body.approvalStatus === 'Approved', [course.status, course.text.slice(0, 160)]);
    const hc = await Z.call('POST', '/api/lms/courses', dTok, { title: `${TAGGED} desk course`, category: 'Test' });
    madeCourses.push(hc.body && hc.body.id);
    Z.check('L2 the shared HR desk login (no employee record) no longer publishes a course by itself - it waits for the chain', hc.status === 201 && hc.body.approvalStatus === 'Pending', [hc.status, hc.body && hc.body.approvalStatus]);
    await prisma.courseAssignment.create({ data: { courseId: course.body.id, employeeId: wEmp.id } }).catch((e) => console.log('assign failed', e.message.slice(-200)));
    const lm = await Z.call('POST', `/api/lms/courses/${course.body.id}/materials`, hTok, { title: `${TAGGED} link`, url: 'https://example.test/guide', kind: 'Link', required: true });
    madeMaterials.push(lm.body && lm.body.id);
    Z.check('L3 HR adds a material to a LIVE course: it is Pending and says so', lm.status === 201 && lm.body.pendingApproval === true && lm.body.approvalStatus === 'Pending', [lm.status, lm.text.slice(0, 200)]);
    const my1 = await Z.call('GET', `/api/lms/my/courses/${course.body.id}`, wTok);
    Z.check('L4 the learner does not see the Pending material, and it does not count toward completion', my1.status === 200 && !(my1.body.materials || []).some((m) => m.id === lm.body.id), [my1.status, (my1.body && my1.body.materials || []).length]);
    const mg = await Z.call('GET', `/api/lms/courses/${course.body.id}/manage`, hTok);
    const mrow = ((mg.body && mg.body.materials) || []).find((m) => m.id === lm.body.id);
    Z.check('L5 the manager screen still lists it, marked Pending', !!mrow && mrow.approvalStatus === 'Pending', mg.status);
    const lvl = await climb(`/api/lms/materials/${lm.body.id}/decision`, 'courseMaterial', lm.body.id);
    const m2 = await prisma.courseMaterial.findUnique({ where: { id: lm.body.id } });
    Z.check('L6 it climbs to the Super Admin and is then Approved', lvl.length >= 1 && lvl.every((l) => l.status === 200) && lvl[lvl.length - 1].level === 'SUPER_ADMIN' && m2.approvalStatus === 'Approved', [lvl, m2.approvalStatus]);
    const my2 = await Z.call('GET', `/api/lms/my/courses/${course.body.id}`, wTok);
    Z.check('L7 now the learner sees it', my2.status === 200 && (my2.body.materials || []).some((m) => m.id === lm.body.id), my2.status);
    const lm2 = await Z.call('POST', `/api/lms/courses/${course.body.id}/materials`, hTok, { title: `${TAGGED} link 2`, url: 'https://example.test/guide2', kind: 'Link', required: true });
    madeMaterials.push(lm2.body && lm2.body.id);
    const rl2 = await climb(`/api/lms/materials/${lm2.body.id}/decision`, 'courseMaterial', lm2.body.id, 'Rejected', 'ZZTEST UPA wrong file');
    const my3 = await Z.call('GET', `/api/lms/my/courses/${course.body.id}`, wTok);
    Z.check('L8 a rejected material never reaches the learner', rl2.length === 1 && rl2[0].status === 200 && !(my3.body.materials || []).some((m) => m.id === lm2.body.id), [rl2, my3.status]);
    const lm3 = await Z.call('POST', `/api/lms/courses/${course.body.id}/materials`, aTok, { title: `${TAGGED} link 3`, url: 'https://example.test/guide3', kind: 'Link', required: true });
    madeMaterials.push(lm3.body && lm3.body.id);
    Z.check('L9 a real Admin\'s material goes live at once', lm3.status === 201 && !lm3.body.pendingApproval && lm3.body.approvalStatus === 'Approved', [lm3.status, lm3.text.slice(0, 160)]);
    const stray = await Z.call('PATCH', `/api/lms/materials/${lm2.body.id}/decision`, wTok, { status: 'Approved' });
    Z.check('L10 an ordinary employee cannot decide a material (403)', stray.status === 403, stray.status);

    // ---- 3. FEEDBACK TO R&D ---------------------------------------------------------------------------------------------------------------------
    const rd1 = await Z.mkUser('rd1', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Developer', department: 'R&D' });
    const rd2 = await Z.mkUser('rd2', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Developer', department: 'R&D' });
    const r1Tok = await Z.mint(rd1);
    const opts = await Z.call('GET', '/api/tasks/feedback/options', wTok);
    const names = ((opts.body && opts.body.people) || []).map((p) => p.userId);
    Z.check('F1 any employee is offered the R&D team to send feedback to', opts.status === 200 && opts.body.department === 'R&D' && names.includes(rd1.id) && names.includes(rd2.id), [opts.status, opts.text.slice(0, 200)]);
    Z.check('F2 the list carries names and workload only (no phone, e-mail or salary)', !/phone|email|salary|mobile/i.test(JSON.stringify(opts.body.people)), opts.body.people[0]);
    const direct = await Z.call('POST', '/api/tasks', wTok, { name: `${TAGGED} direct`, startDate: day, assigneeId: rd1.id });
    madeTasks.push(direct.body && direct.body.id);
    Z.check('F3 (2026-10-24: anyone can give a task to anyone) an ordinary employee can hand a normal task to R&D too (201)', direct.status === 201 && direct.body.assigneeId === rd1.id, [direct.status, direct.text.slice(0, 120)]);
    const fb = await Z.call('POST', '/api/tasks/feedback', wTok, { subject: `${TAGGED} slow page`, details: 'The attendance page takes a long time to open.', priority: 'High', assigneeId: rd1.id });
    madeTasks.push(fb.body && fb.body.id);
    Z.check('F4 the employee sends feedback to a named R&D person (201)', fb.status === 201 && fb.body.assigneeId === rd1.id && fb.body.department === 'R&D' && fb.body.assignedById === worker.id && fb.body.subTaskName === 'Feedback to R&D', [fb.status, fb.text.slice(0, 250)]);
    const r1Tasks = await Z.call('GET', '/api/tasks', r1Tok);
    Z.check('F5 the R&D person sees it in their Timesheet, with who sent it', r1Tasks.status === 200 && (r1Tasks.body || []).some((t) => t.id === fb.body.id && /ZZTEST UPA/.test(t.assignedByName)), [r1Tasks.status, r1Tasks.text.slice(0, 160)]);
    const wTasks = await Z.call('GET', '/api/tasks', wTok);
    Z.check('F6 the sender follows it in theirs', (wTasks.body || []).some((t) => t.id === fb.body.id), wTasks.status);
    const oTasks = await Z.call('GET', '/api/tasks', oTok);
    Z.check('F7 an unrelated employee does not see it', !(oTasks.body || []).some((t) => t.id === fb.body.id), oTasks.status);
    const note = await prisma.notification.count({ where: { userId: rd1.id } });
    Z.check('F8 the R&D person was told', note >= 1, note);
    const fbAny = await Z.call('POST', '/api/tasks/feedback', tTok, { subject: `${TAGGED} anyone`, details: 'Please add a filter.' });
    madeTasks.push(fbAny.body && fbAny.body.id);
    const rdNames = (await prisma.employee.findMany({ where: { department: 'R&D' }, select: { userId: true } })).map((e) => e.userId);
    Z.check('F9 with "anyone" it goes to an R&D person (the least busy)', fbAny.status === 201 && rdNames.includes(fbAny.body.assigneeId), [fbAny.status, fbAny.text.slice(0, 200)]);
    const notRd = await Z.call('POST', '/api/tasks/feedback', wTok, { subject: 'x', details: 'y', assigneeId: tl.id });
    Z.check('F10 it cannot be aimed at somebody outside R&D (400)', notRd.status === 400, [notRd.status, notRd.text.slice(0, 120)]);
    const empty = await Z.call('POST', '/api/tasks/feedback', wTok, { subject: '', details: '' });
    Z.check('F11 an empty feedback is refused (400)', empty.status === 400, empty.status);
    const sneaky = await Z.call('PUT', `/api/tasks/${fb.body.id}`, wTok, { assigneeId: tl.id });
    // (2026-10-24: anyone can give a task to anyone, so the old "outside their own scope" refusal no longer applies; the point that stays is
    // that the feedback task is still the sender's own task to manage and nobody else can take it over)
    const stranger = await Z.call('PUT', `/api/tasks/${fb.body.id}`, oTok, { name: `${TAGGED} hijacked` });
    Z.check('F12 an unrelated employee cannot change somebody else\'s feedback task (403)', stranger.status === 403 && sneaky.status !== 500, [stranger.status, sneaky.status]);

    // ---- 4. THE DEVELOPER-TEAM ADMIN LOGIN ----------------------------------------------------------------------------------------------------
    const DEV_EMAIL = `zz-upa-dev-${Z.RUN}@example.test`;
    const DEV_NAME = `${TAGGED} Developer Team`;
    const sandboxDb = path.join(Z.BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db');
    const empBefore = await prisma.employee.count();
    const dry = spawnSync(process.execPath, [path.join(Z.BACK, 'scripts', 'create-developer-login.js'), '--db', sandboxDb, '--email', DEV_EMAIL, '--name', DEV_NAME, '--out', path.join(require('os').tmpdir(), `upa-dev-${Z.RUN}`)], { encoding: 'utf8' });
    Z.check('G1 the dry run creates nothing', dry.status === 0 && /DRY RUN/.test(dry.stdout) && !(await prisma.user.findFirst({ where: { email: DEV_EMAIL } })), dry.stdout + dry.stderr);
    const noPw = spawnSync(process.execPath, [path.join(Z.BACK, 'scripts', 'create-developer-login.js'), '--apply', '--db', sandboxDb, '--email', DEV_EMAIL], { encoding: 'utf8', env: { ...process.env, TL_NEW_PASSWORD: '' } });
    Z.check('G2 without a password it refuses', noPw.status !== 0 && !(await prisma.user.findFirst({ where: { email: DEV_EMAIL } })), noPw.stdout + noPw.stderr);
    const PW = `Zz-${Z.RUN}-Dev#1`;
    const mk = spawnSync(process.execPath, [path.join(Z.BACK, 'scripts', 'create-developer-login.js'), '--apply', '--db', sandboxDb, '--email', DEV_EMAIL, '--name', DEV_NAME, '--out', path.join(require('os').tmpdir(), `upa-dev-${Z.RUN}`)], { encoding: 'utf8', env: { ...process.env, TL_NEW_PASSWORD: PW } });
    const dev = await prisma.user.findFirst({ where: { email: DEV_EMAIL } });
    if (dev) Z.made.users.push(dev.id);
    // (founder, later on 2026-10-24: "Super Admin and developer are one person" -> the developer login is a SUPER ADMIN)
    Z.check('G3 the apply creates a SUPER ADMIN login', mk.status === 0 && dev && dev.role === 'SUPER_ADMIN' && dev.hrmsRole === 'SUPER_ADMIN' && dev.atsRole === 'SUPER_ADMIN' && dev.accountsRole === 'SUPER_ADMIN' && dev.status === 'Active', mk.stdout + mk.stderr);
    Z.check('G4 it has NO employee record (so it is not headcount)', !!dev && !(await prisma.employee.findFirst({ where: { userId: dev.id } })) && (await prisma.employee.count()) === empBefore);
    Z.check('G5 the password is stored hashed, never in the output', !!dev && dev.passwordHash !== PW && !(mk.stdout + mk.stderr).includes(PW));
    const again2 = spawnSync(process.execPath, [path.join(Z.BACK, 'scripts', 'create-developer-login.js'), '--apply', '--db', sandboxDb, '--email', DEV_EMAIL], { encoding: 'utf8', env: { ...process.env, TL_NEW_PASSWORD: PW } });
    Z.check('G6 running it twice does nothing the second time', /Already there/.test(again2.stdout), again2.stdout);
    const login = await Z.call('POST', '/api/auth/login', null, { email: DEV_EMAIL, password: PW });
    Z.check('G7 the developer team can sign in', login.status === 200 && !!(login.body && (login.body.token || login.body.accessToken)), [login.status, login.text.slice(0, 160)]);
    // it shows in none of the people lists / counts
    const sweep = ['/api/employees/management', '/api/employees', '/api/tasks/options', '/api/tasks/people', '/api/attendance', '/api/leave', '/api/hrms/dashboard', '/api/dashboard', '/api/payroll', '/api/audience/people', '/api/documents', '/api/ats-io/export'];
    let seen = 0; let leaks = [];
    for (const p of sweep) {
      // eslint-disable-next-line no-await-in-loop
      const r = await Z.call('GET', p, saTok);
      if (r.status === 200) {
        seen += 1;
        const hit = [DEV_EMAIL, DEV_NAME].find((needle) => r.text.includes(needle));
        if (hit) leaks.push(`${p}: ...${r.text.slice(Math.max(0, r.text.indexOf(hit) - 120), r.text.indexOf(hit) + 80)}...`);
      }
    }
    Z.check('G8 it appears in none of the employee / attendance / dashboard / task lists (swept ' + seen + ' screens)', seen >= 3 && leaks.length === 0, leaks);
    const sheet = await Z.call('GET', '/api/tasks/options', await Z.mint(dev));
    Z.check('G9 and as an Admin it can still use the app (a screen opens for it)', sheet.status === 200, [sheet.status, sheet.text.slice(0, 120)]);
    const undo = spawnSync(process.execPath, [path.join(Z.BACK, 'scripts', 'create-developer-login.js'), '--undo', path.join(require('os').tmpdir(), `upa-dev-${Z.RUN}`, 'undo-manifest.json'), '--db', sandboxDb], { encoding: 'utf8' });
    Z.check('G10 undo removes it', /Undone/.test(undo.stdout) && !(await prisma.user.findFirst({ where: { email: DEV_EMAIL } })), undo.stdout + undo.stderr);

    // clean up everything the test made -------------------------------------------------------------------------------------------------------------
    const ids = [...madeDocs, ...madeCourses, ...madeMaterials, ...madeTasks].filter(Boolean);
    // The rows that point at the fixture employees / users go first, or their deletion is refused by the database.
    const extras = [
      (p) => p.approvalStep.deleteMany({ where: { recordId: { in: ids } } }),
      (p) => p.acknowledgment.deleteMany({ where: { documentId: { in: madeDocs.filter(Boolean) } } }),
      (p) => p.policyDocument.deleteMany({ where: { OR: [{ id: { in: madeDocs.filter(Boolean) } }, { title: { contains: TAGGED } }] } }),
      (p) => p.courseAssignment.deleteMany({ where: { courseId: { in: madeCourses.filter(Boolean) } } }),
      (p) => p.course.deleteMany({ where: { OR: [{ id: { in: madeCourses.filter(Boolean) } }, { title: { contains: TAGGED } }] } }),
      (p) => p.taskComment.deleteMany({ where: { taskId: { in: madeTasks.filter(Boolean) } } }),
      (p) => p.task.deleteMany({ where: { OR: [{ id: { in: madeTasks.filter(Boolean) } }, { name: { contains: TAGGED } }] } }),
      (p) => p.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { toValue: { contains: TAGGED } }, { toValue: { contains: 'zz-upa-dev' } }] } }),
      (p) => p.notification.deleteMany({ where: { OR: [{ title: { contains: TAGGED } }, { message: { contains: TAGGED } }] } }),
    ];
    for (const fn of extras) { try { await fn(prisma); } catch (e) { console.log('  pre-clean step failed:', String(e.message).slice(-160)); } } // eslint-disable-line no-await-in-loop
    const left = await Z.cleanup(extras);
    Z.check('Z cleanup left nothing behind', Object.values(left).every((n) => n === 0), left);
    const strays = (await prisma.policyDocument.count({ where: { title: { contains: TAGGED } } })) + (await prisma.course.count({ where: { title: { contains: TAGGED } } })) + (await prisma.task.count({ where: { name: { contains: TAGGED } } }));
    Z.check('Z no ZZTEST document, course or task is left', strays === 0, strays);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); try { await Z.cleanup(); } catch { /* best effort */ } } finally {
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
