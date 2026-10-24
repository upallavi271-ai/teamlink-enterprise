#!/usr/bin/env node
// ---------------------------------------------------------------------------
// FOUNDER 2026-10-24: (1) after a password change every older session ends; (4) every employee posts 4 unique ideas a month for the R&D team;
// (5) anyone can give a task to anyone; (6) HR (Divya, Purna) and the Super Admin edit the resignation, notice and exit dates. SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/ideas-dates-test.js
// ---------------------------------------------------------------------------
const bcrypt = require('bcryptjs');
const Z = require('./lib/zzfix')('IDE');

const TAGGED = 'ZZTEST IDE';
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const today = iso(new Date());

(async () => {
  const { prisma } = Z;
  const madeIdeas = []; const madeTasks = [];
  try {
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', passwordResetRequired: false, employee: { isNot: null } }, orderBy: { createdAt: 'asc' } })
      || await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', passwordResetRequired: false }, orderBy: { createdAt: 'asc' } });
    if (!sa) throw new Error('the sandbox has no Super Admin');
    const saTok = await Z.mint(sa);

    const mk = (tag, role, dept, desig = 'Executive', extra = {}) => Z.mkUser(tag, { role, hrmsRole: role, hrmsAccess: true, atsRole: 'NONE', atsAccess: false, passwordChangedAt: new Date(Date.now() - 86400000), ...extra }, { designation: desig, department: dept });
    const ann = await mk('ann', 'EMPLOYEE', 'Medical');
    const bob = await mk('bob', 'EMPLOYEE', 'Education');
    const cat = await mk('cat', 'EMPLOYEE', 'Medical');
    const rd = await mk('rd', 'EMPLOYEE', 'R&D', 'Developer');
    const hr = await mk('hr', 'HR', 'HR', 'HR Executive');
    const rec = await mk('rec', 'EMPLOYEE', 'Recruitment', 'Recruiter', { atsRole: 'RECRUITER', atsAccess: true });
    const tl = await mk('tl', 'TL', 'Medical', 'TL');
    const admin = await Z.mkUser('admin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, passwordChangedAt: new Date(Date.now() - 86400000) }); // login only
    const T = {};
    for (const [k, u] of Object.entries({ ann, bob, cat, rd, hr, rec, tl, admin })) T[k] = await Z.mint(u); // eslint-disable-line no-await-in-loop
    const post = (tok, title, details) => Z.call('POST', '/api/ideas', tok, { title, details });

    // ---- 4. IDEAS ---------------------------------------------------------------------------------------------------------------------------
    const first = await post(T.ann, 'Voice robot that confirms interviews with candidates', 'A small calling robot phones every shortlisted candidate the evening before the interview and records yes or no, so recruiters stop calling one by one.');
    madeIdeas.push(first.body && first.body.idea && first.body.idea.id);
    Z.check('I1 an employee can post an idea; it counts 1 of 4', first.status === 201 && first.body.posted === 1 && first.body.left === 3 && first.body.quota === 4, [first.status, first.text.slice(0, 200)]);
    const sameTitle = await post(T.bob, 'Voice robot that confirms interviews with candidates', 'Something else entirely about the canteen menu planning and food orders for the office floor.');
    Z.check('I2 the same title by somebody else is refused as a copy (409)', sameTitle.status === 409 && sameTitle.body.duplicate === true && sameTitle.body.own === false, [sameTitle.status, sameTitle.text.slice(0, 200)]);
    Z.check('I3 and the refusal shows nothing of the first idea (no words, no name)', !/robot|interview|candidate|ann|ZZTEST/i.test(sameTitle.body.error || ''), sameTitle.body);
    const nearCopy = await post(T.bob, 'Robots confirming the interviews with candidate', 'Calling robots that phone every shortlisted candidates on the evening before interviews, recording yes or no answers so that recruiters do not call one by one.');
    Z.check('I4 a re-worded near-copy (plurals, filler words, reordered) is refused too (409)', nearCopy.status === 409 && nearCopy.body.duplicate === true, [nearCopy.status, nearCopy.text.slice(0, 200)]);
    const own = await post(T.ann, 'Voice robot that confirms interviews with candidates', 'The very same thing again by the same person writing a longer explanation of the calling robot for interviews.');
    Z.check('I5 the same person repeating their own idea is refused and told it is their own (409)', own.status === 409 && own.body.own === true, [own.status, own.text.slice(0, 200)]);
    const chk1 = await Z.call('POST', '/api/ideas/check', T.cat, { title: 'Voice robot that confirms interviews with candidates', details: 'whatever words are here for the check call to read through' });
    const chk2 = await Z.call('POST', '/api/ideas/check', T.cat, { title: 'Garden on the office terrace', details: 'Plants and benches on the terrace so people can take a short break outside in the evening.' });
    Z.check('I6 the live check says "copy" for the taken idea and "fine" for a new one', chk1.status === 200 && chk1.body.copy === true && chk2.status === 200 && chk2.body.copy === false, [chk1.body, chk2.body]);
    const other = await post(T.bob, 'Weekly lunch swap board', 'A shared board where people offer their spare home lunch and swap with a colleague, to save money and make friends across departments.');
    madeIdeas.push(other.body && other.body.idea && other.body.idea.id);
    Z.check('I7 a different idea by somebody else is accepted', other.status === 201, [other.status, other.text.slice(0, 200)]);
    const short = await post(T.cat, 'abc', 'too short');
    Z.check('I8 a too-short idea is refused with a plain message (400)', short.status === 400 && short.body.field === 'title', [short.status, short.text.slice(0, 160)]);
    const shortDet = await post(T.cat, 'A proper name here', 'few words');
    Z.check('I9 an idea with no explanation is refused (400)', shortDet.status === 400 && shortDet.body.field === 'details', [shortDet.status, shortDet.text.slice(0, 160)]);

    // the quota: 4 a month, the 5th is refused
    const topics = [
      ['Garden on the office terrace', 'Plants and benches on the terrace so people can take a short break outside in the evening hours.'],
      ['Salary advance request button', 'A simple button in the employee page to ask for a small salary advance with the reason, approved by the manager quickly.'],
      ['Birthday cake corner monthly', 'One monthly celebration for everybody whose birthday falls in the month, planned by a rotating volunteer group.'],
      ['Quiet hour for deep work', 'Every afternoon one hour without meetings or calls so recruiters and developers can concentrate on hard tasks.'],
    ];
    const got = [];
    for (const [t, d] of topics) { const r = await post(T.ann, t, d); got.push(r); if (r.body && r.body.idea) madeIdeas.push(r.body.idea.id); } // eslint-disable-line no-await-in-loop
    Z.check('I10 the 2nd, 3rd and 4th ideas are accepted', got.slice(0, 3).every((r) => r.status === 201) && got[2].body.left === 0 && got[2].body.posted === 4, got.map((r) => r.status));
    Z.check('I11 the 5th idea in the same month is refused: 4 is the limit (409)', got[3].status === 409 && got[3].body.quotaReached === true, [got[3].status, got[3].text.slice(0, 200)]);
    const mineAnn = await Z.call('GET', '/api/ideas/mine', T.ann);
    Z.check('I12 /mine shows exactly my 4 ideas and 0 left', mineAnn.status === 200 && mineAnn.body.ideas.length === 4 && mineAnn.body.posted === 4 && mineAnn.body.left === 0, [mineAnn.status, mineAnn.body && mineAnn.body.ideas && mineAnn.body.ideas.length]);
    const mineBob = await Z.call('GET', '/api/ideas/mine', T.bob);
    Z.check('I13 another employee sees none of them in /mine', mineBob.body.ideas.every((i) => !/robot|terrace/i.test(i.title)), mineBob.body.ideas.map((i) => i.title));

    // privacy: only the R&D team, HR and Admin read everybody's ideas
    const denied = await Z.call('GET', '/api/ideas/all', T.cat);
    const deniedTl = await Z.call('GET', '/api/ideas/all', T.tl);
    Z.check('I14 an ordinary employee or a TL cannot read everybody\'s ideas (403)', denied.status === 403 && deniedTl.status === 403, [denied.status, deniedTl.status]);
    const rdAll = await Z.call('GET', '/api/ideas/all', T.rd);
    const mineIds = new Set(madeIdeas.filter(Boolean));
    Z.check('I15 an R&D team member sees every idea with its author', rdAll.status === 200 && [...mineIds].every((id) => (rdAll.body.rows || []).some((r) => r.id === id)) && rdAll.body.rows.some((r) => r.author === ann.name), [rdAll.status, rdAll.text.slice(0, 200)]);
    const annRow = (rdAll.body.people || []).find((p) => p.name === ann.name);
    Z.check('I16 the "who has posted" list says Ann has 4 of 4 and Bob has 1 of 4', !!annRow && annRow.posted === 4 && annRow.missing === 0 && (rdAll.body.people.find((p) => p.name === bob.name) || {}).posted === 1, [annRow]);
    const hrAll = await Z.call('GET', '/api/ideas/all', T.hr);
    const adminAll = await Z.call('GET', '/api/ideas/all', T.admin);
    Z.check('I17 HR and an Admin can read them all too', hrAll.status === 200 && adminAll.status === 200, [hrAll.status, adminAll.status]);
    const adminPost = await post(T.admin, 'Anything at all from an admin login', 'An admin login that has no employee record cannot post ideas because ideas belong to employees only.');
    Z.check('I18 a login with no employee record cannot post an idea (403)', adminPost.status === 403, adminPost.status);

    // R&D was told, can mark an idea, and the author is told
    const noteRd = await prisma.notification.count({ where: { userId: rd.id, title: { startsWith: 'New idea:' }, recipient: { startsWith: 'idea|' } } });
    Z.check('I19 the R&D team member was told about the new ideas', noteRd >= 2, noteRd);
    const mark = await Z.call('PATCH', `/api/ideas/${first.body.idea.id}`, T.rd, { status: 'Accepted', note: 'We will build this next month' });
    Z.check('I20 R&D can mark an idea Accepted with a note', mark.status === 200 && mark.body.status === 'Accepted' && mark.body.rdNote === 'We will build this next month', [mark.status, mark.text.slice(0, 160)]);
    const annNotes = await prisma.notification.count({ where: { userId: ann.id, title: 'Your idea: Accepted' } });
    Z.check('I21 the person who posted it is told', annNotes === 1, annNotes);
    const markBad = await Z.call('PATCH', `/api/ideas/${first.body.idea.id}`, T.cat, { status: 'Done' });
    const markWrong = await Z.call('PATCH', `/api/ideas/${first.body.idea.id}`, T.rd, { status: 'Whatever' });
    Z.check('I22 an ordinary employee cannot mark an idea (403) and a made-up status is refused (400)', markBad.status === 403 && markWrong.status === 400, [markBad.status, markWrong.status]);
    const mineAnn2 = await Z.call('GET', '/api/ideas/mine', T.ann);
    Z.check('I23 the author sees the R&D status and note on their idea', mineAnn2.body.ideas.some((i) => i.status === 'Accepted' && i.rdNote), mineAnn2.body.ideas.map((i) => i.status));

    // a new month starts again at 0 of 4, but an idea of an OLD month is still taken
    const oldMonth = new Date(Date.now() + 330 * 60000); oldMonth.setUTCMonth(oldMonth.getUTCMonth() - 2);
    const om = oldMonth.toISOString().slice(0, 7);
    const mkOld = (userId, title, tokens) => prisma.employeeIdea.create({ data: { userId, authorName: `${TAGGED} old`, title, details: 'An idea posted in an earlier month, kept for the test of the monthly count.', month: om, titleKey: title.toLowerCase().replace(/[^a-z0-9]+/g, ''), tokens: JSON.stringify(tokens) } });
    for (let i = 0; i < 4; i += 1) madeIdeas.push((await mkOld(cat.id, `Old month idea number ${['alpha', 'beta', 'gamma', 'delta'][i]}`, [`old${i}`, 'month'])).id); // eslint-disable-line no-await-in-loop
    const fresh = await post(T.cat, 'Plant a mango tree at the front gate', 'Plant a mango tree at the gate so that the whole office can eat the fruit in summer and enjoy shade through the year.');
    madeIdeas.push(fresh.body && fresh.body.idea && fresh.body.idea.id);
    Z.check('I24 4 ideas in an EARLIER month do not use up this month (the count starts again)', fresh.status === 201 && fresh.body.posted === 1, [fresh.status, fresh.text.slice(0, 160)]);
    const oldOwn = await mkOld(bob.id, 'Tablet stand for every desk', ['tablet', 'stand', 'desk']);
    madeIdeas.push(oldOwn.id);
    const takeOld = await post(T.rd, 'Tablet stand for every desk', 'Give every employee a tablet stand for the desk so that screens are at eye height and necks stay healthy.');
    Z.check('I25 an idea from an earlier month is still taken: nobody can post it again (409)', takeOld.status === 409 && takeOld.body.duplicate === true, [takeOld.status, takeOld.text.slice(0, 160)]);

    // ---- 5. ANYONE CAN GIVE A TASK TO ANYONE --------------------------------------------------------------------------------------------------
    const opt = await Z.call('GET', '/api/tasks/options', T.rec);
    const names = ((opt.body && opt.body.assignable) || []).map((p) => p.userId);
    Z.check('T1 a recruiter is offered everybody to give a task to: canAssignOthers, the TL and the Super Admin are in the list', opt.status === 200 && opt.body.canAssignOthers === true && names.includes(tl.id) && names.includes(sa.id), [opt.status, opt.body && opt.body.canAssignOthers, names.length]);
    const tBody = (n, ids) => ({ name: `${TAGGED} ${n}`, description: 'test', startDate: today, endDate: addDays(today, 3), priority: 'Medium', assigneeIds: ids });
    const toTl = await Z.call('POST', '/api/tasks', T.rec, tBody('recruiter to TL', [tl.id]));
    const toSa = await Z.call('POST', '/api/tasks', T.rec, tBody('recruiter to Super Admin', [sa.id]));
    const toEmp = await Z.call('POST', '/api/tasks', T.ann, tBody('employee to another department', [bob.id]));
    const toRd = await Z.call('POST', '/api/tasks', T.ann, tBody('employee to R&D', [rd.id]));
    const toMany = await Z.call('POST', '/api/tasks', T.cat, tBody('employee to many', [bob.id, tl.id, hr.id]));
    for (const r of [toTl, toSa, toEmp, toRd, toMany]) { (r.body && (r.body.ids || [r.body.id]) || []).forEach((id) => madeTasks.push(id)); }
    Z.check('T2 a recruiter can give a task to a TL and to the Super Admin (201)', toTl.status === 201 && toSa.status === 201, [toTl.status, toTl.text.slice(0, 160), toSa.status]);
    Z.check('T3 a plain employee can give a task to another department and to R&D (201)', toEmp.status === 201 && toRd.status === 201, [toEmp.status, toEmp.text.slice(0, 160), toRd.status, toRd.text.slice(0, 160)]);
    Z.check('T4 and to several people at once, one task each (201)', toMany.status === 201 && toMany.body.created === 3, [toMany.status, toMany.text.slice(0, 160)]);
    const saTasks = await prisma.task.findMany({ where: { assigneeId: sa.id, name: { contains: TAGGED } } });
    Z.check('T5 the Super Admin really has the task, given by the recruiter', saTasks.length === 1 && saTasks[0].assignedById === rec.id, saTasks.map((t) => [t.name, t.assignedById]));
    const recList = await Z.call('GET', '/api/tasks', T.rec);
    const recSees = (recList.body && (recList.body.tasks || recList.body) || []);
    const seen = Array.isArray(recSees) ? recSees.filter((t) => String(t.name).includes(TAGGED)).length : 0;
    Z.check('T6 the recruiter sees the tasks they gave in their own list', recList.status === 200 && seen >= 2, [recList.status, seen]);
    const bobList = await Z.call('GET', '/api/tasks', T.bob);
    const bobTasks = (bobList.body && (bobList.body.tasks || bobList.body)) || [];
    Z.check('T7 the receiver (another department) sees it in theirs', Array.isArray(bobTasks) && bobTasks.some((t) => String(t.name).includes('employee to another department')), bobList.status);
    // the giver can hand it on or cancel their own task; the receiver cannot rename it
    const gaveTaskId = toEmp.body.id || (toEmp.body.ids || [])[0];
    const cancel = await Z.call('PUT', `/api/tasks/${gaveTaskId}`, T.bob, { name: `${TAGGED} renamed by receiver`, startDate: today });
    Z.check('T8 the receiver still cannot rename a task somebody gave them (403)', cancel.status === 403, [cancel.status, cancel.text.slice(0, 120)]);
    const exitedEmp = await prisma.employee.create({ data: { employeeCode: `ZZTEST-IDE-gone-${Z.RUN}`, name: `${TAGGED} gone ${Z.RUN}`, userId: (await Z.mkUser('gone', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, passwordChangedAt: new Date() })).id, designation: 'Executive', employmentStatus: 'Relieved', department: 'Medical' } });
    Z.made.emps.push(exitedEmp.id);
    const opt2 = await Z.call('GET', '/api/tasks/options', T.rec);
    Z.check('T9 a person who has left is never offered a task', !((opt2.body.assignable || []).some((p) => p.userId === exitedEmp.userId)), 'offered');

    // ---- 6. EXIT DATES (HR + Super Admin) -----------------------------------------------------------------------------------------------------
    const leaver = await mk('leaver', 'EMPLOYEE', 'Medical');
    const lEmp = await prisma.employee.findFirst({ where: { userId: leaver.id } });
    await prisma.employee.update({ where: { id: lEmp.id }, data: { dateOfJoining: new Date('2025-01-10T00:00:00Z'), employmentStatus: 'Notice Period' } });
    const resDate = addDays(today, -10); const lwd0 = addDays(resDate, 45);
    const rrec = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: lEmp.id, title: `${TAGGED} resignation`, status: 'Notice Period', date: lwd0, raisedBy: 'test' } });
    const rdet = await prisma.resignationDetail.create({ data: { recordId: rrec.id, employeeId: lEmp.id, employeeName: lEmp.name, resignationDate: resDate, approvedLastWorkingDate: lwd0, reason: 'Other', reasonOther: 'test', noticePeriodDays: 45, source: 'TeamLink' } });
    const base = `/api/resignations/exit/${rrec.id}`;
    const view0 = await Z.call('GET', base, T.hr);
    Z.check('E1 the exit record shows resignation date, notice days and last working day, and HR may edit them', view0.status === 200 && view0.body.resignationDate === resDate && view0.body.noticeDays === 45 && view0.body.lastWorkingDate === lwd0 && view0.body.actions.canEditDate === true, [view0.status, view0.text.slice(0, 250)]);
    const tlTry = await Z.call('PUT', `${base}/dates`, T.tl, { noticeDays: 30, reason: 'test reason' });
    const empTry = await Z.call('PUT', `${base}/dates`, T.ann, { noticeDays: 30, reason: 'test reason' });
    Z.check('E2 a TL or an employee cannot change the dates (403)', tlTry.status === 403 && empTry.status === 403, [tlTry.status, empTry.status]);
    const noWhy = await Z.call('PUT', `${base}/dates`, T.hr, { noticeDays: 30 });
    Z.check('E3 a change without a reason is refused (400)', noWhy.status === 400, [noWhy.status, noWhy.text.slice(0, 120)]);
    const badDays = await Z.call('PUT', `${base}/dates`, T.hr, { noticeDays: 'abc', reason: 'testing' });
    const badLwd = await Z.call('PUT', `${base}/dates`, T.hr, { lastWorkingDate: addDays(resDate, -3), reason: 'testing' });
    const nothing = await Z.call('PUT', `${base}/dates`, T.hr, { noticeDays: 45, reason: 'testing' });
    Z.check('E4 bad notice days, a last day before the resignation date, and "nothing changed" are all refused (400)', badDays.status === 400 && badLwd.status === 400 && nothing.status === 400, [badDays.status, badLwd.status, nothing.status]);
    const newRes = addDays(today, -4);
    const chg = await Z.call('PUT', `${base}/dates`, T.hr, { resignationDate: newRes, noticeDays: 30, recalculate: true, reason: 'ZZTEST IDE agreed with the employee' });
    const wantLwd = addDays(newRes, 30);
    const recAfter = await prisma.employeeRecord.findUnique({ where: { id: rrec.id } });
    const detAfter = await prisma.resignationDetail.findUnique({ where: { id: rdet.id } });
    Z.check('E5 HR changes resignation date + notice days and the last working day follows (resigned + notice)', chg.status === 200 && detAfter.resignationDate === newRes && detAfter.noticePeriodDays === 30 && recAfter.date === wantLwd, [chg.status, chg.text.slice(0, 200), detAfter.resignationDate, detAfter.noticePeriodDays, recAfter.date, wantLwd]);
    Z.check('E6 the new values come back in the record', chg.body.resignationDate === newRes && chg.body.noticeDays === 30 && chg.body.lastWorkingDate === wantLwd, chg.body && [chg.body.resignationDate, chg.body.noticeDays, chg.body.lastWorkingDate]);
    const aud = await prisma.auditLog.findMany({ where: { entityId: rrec.id, action: { in: ['Exit dates edited', 'Exit date changed'] } } });
    Z.check('E7 each change is written down: resignation date, notice days and last working day, with who and why', aud.some((a) => a.field === 'resignationDate' && a.fromValue === resDate && a.toValue === newRes) && aud.some((a) => a.field === 'noticeDays' && a.toValue === '30') && aud.some((a) => a.action === 'Exit date changed' && a.toValue === wantLwd) && aud.every((a) => /ZZTEST IDE/.test(a.reason || '')), aud.map((a) => [a.action, a.field, a.fromValue, a.toValue]));
    const saChg = await Z.call('PUT', `${base}/dates`, saTok, { lastWorkingDate: addDays(wantLwd, 5), reason: 'ZZTEST IDE Super Admin moved the day' });
    Z.check('E8 the Super Admin can change the last working day too', saChg.status === 200 && saChg.body.lastWorkingDate === addDays(wantLwd, 5), [saChg.status, saChg.text.slice(0, 160)]);
    const notice = await prisma.notification.count({ where: { title: { startsWith: 'Exit dates changed' }, message: { contains: lEmp.name } } });
    const noticeLwd = await prisma.notification.count({ where: { title: { contains: lEmp.name }, message: { contains: 'last working day' } } });
    Z.check('E9 the people around the exit are told', notice + noticeLwd >= 1, [notice, noticeLwd]);
    const early = await Z.call('PUT', `${base}/dates`, T.hr, { resignationDate: '2024-12-31', reason: 'testing before joining' });
    Z.check('E10 a resignation date before the joining date is refused (400)', early.status === 400, [early.status, early.text.slice(0, 160)]);

    // ---- 1. PASSWORD CHANGE ENDS THE SESSION --------------------------------------------------------------------------------------------------
    const pw0 = `Zz-${Z.RUN}-Old-Pass-77!`; const pw1 = `Zz-${Z.RUN}-New-Pass-88!`;
    const pu = await mk('pw', 'EMPLOYEE', 'Medical');
    await prisma.user.update({ where: { id: pu.id }, data: { passwordHash: await bcrypt.hash(pw0, 10), passwordChangedAt: new Date(Date.now() - 86400000) } });
    const login = await Z.call('POST', '/api/auth/login', null, { email: pu.email, password: pw0 });
    const tok0 = login.body && login.body.token;
    const meBefore = await Z.call('GET', '/api/auth/me', tok0);
    await new Promise((res) => setTimeout(res, 1300)); // the session gate compares whole seconds (a person never signs in and changes the password within one second)
    const chPw = await Z.call('POST', '/api/auth/change-password', tok0, { currentPassword: pw0, newPassword: pw1, confirmPassword: pw1 });
    const meAfter = await Z.call('GET', '/api/auth/me', tok0);
    Z.check('P1 after the password is changed the old session is dead (401) - the screen then shows the sign-in page', login.status === 200 && meBefore.status === 200 && chPw.status === 200 && meAfter.status === 401, [login.status, meBefore.status, chPw.status, meAfter.status]);
    const oldLogin = await Z.call('POST', '/api/auth/login', null, { email: pu.email, password: pw0 });
    const newLogin = await Z.call('POST', '/api/auth/login', null, { email: pu.email, password: pw1 });
    Z.check('P2 the old password no longer signs in, the new one does', oldLogin.status === 401 && newLogin.status === 200 && !!newLogin.body.token, [oldLogin.status, newLogin.status]);

    // ---- clean up -----------------------------------------------------------------------------------------------------------------------------
    const ideaIds = madeIdeas.filter(Boolean);
    const extras = [
      (p) => p.notification.deleteMany({ where: { OR: [{ recipient: { startsWith: 'idea|' }, message: { contains: 'ZZTEST' } }, { recipient: { in: ideaIds.flatMap((id) => [`idea|${id}`]) } }, ...ideaIds.map((id) => ({ recipient: { startsWith: `idea|${id}|` } }))] } }),
      (p) => p.employeeIdea.deleteMany({ where: { OR: [{ id: { in: ideaIds } }, { authorName: { contains: TAGGED } }] } }),
      (p) => p.taskComment.deleteMany({ where: { taskId: { in: madeTasks.filter(Boolean) } } }),
      (p) => p.task.deleteMany({ where: { OR: [{ id: { in: madeTasks.filter(Boolean) } }, { name: { contains: TAGGED } }] } }),
      (p) => p.fnfRequest.deleteMany({ where: { employeeId: lEmp.id } }),
      (p) => p.resignationDetail.deleteMany({ where: { employeeId: lEmp.id } }),
      (p) => p.employeeRecord.deleteMany({ where: { employeeId: lEmp.id } }),
      (p) => p.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...ideaIds, ...madeTasks.filter(Boolean), rrec.id, lEmp.id] } }, { reason: { contains: TAGGED } }, { toValue: { contains: TAGGED } }] } }),
      (p) => p.notification.deleteMany({ where: { OR: [{ title: { contains: TAGGED } }, { message: { contains: TAGGED } }, { message: { contains: lEmp.name } }, { title: { contains: lEmp.name } }] } }),
    ];
    for (const fn of extras) { try { await fn(prisma); } catch (e) { console.log('  pre-clean step failed:', String(e.message).slice(-160)); } } // eslint-disable-line no-await-in-loop
    const left = await Z.cleanup(extras);
    Z.check('Z cleanup left nothing behind', Object.values(left).every((n) => n === 0), left);
    const strays = (await prisma.employeeIdea.count({ where: { authorName: { contains: TAGGED } } })) + (await prisma.task.count({ where: { name: { contains: TAGGED } } }));
    Z.check('Z no ZZTEST idea or task is left', strays === 0, strays);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); try { await Z.cleanup(); } catch { /* best effort */ } } finally {
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
