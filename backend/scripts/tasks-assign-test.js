#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TASKS GIVEN BY A TEAM LEAD - acceptance tests (2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/tasks-assign-test.js
//
//   A  who may be picked: a TL sees only their own team, never another team,
//      never an exited person; the BDE TL only the BDE desk
//   B  creating: one person (201), many people (one task each), another team's
//      member (403, nothing written), exited (403)
//   C  rights table: Employee / Recruiter cannot give to others; Manager is
//      view-only; STL / HR / Admin by scope
//   D  assignee experience: sees it, bell, may only change progress, hours
//      (only the assignee), done + note, the giver hears
//   E  the giver: extend, reassign (both hear), cancel with a reason, hours
//      corrected with an audit row, one-click approve
//   F  overdue: the giver gets one bell for the late tasks
//   G  scope + export: another team sees nothing, export is scoped
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));

const RUN = Date.now().toString(36);
const STARTED = new Date();
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '2h' });
async function call(u, method, p, body, raw) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, Authorization: `Bearer ${tok(u)}` };
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}/api${p}`, { method, headers: h, body: payload });
      if (raw) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const made = { users: [], emps: [], tasks: new Set() };
const track = (r) => { const b = r && r.body; if (b) { if (b.id) made.tasks.add(b.id); (b.ids || []).forEach((i) => made.tasks.add(i)); } return r; };

async function person(label, { role = 'EMPLOYEE', hrmsRole, dept, team = null, atsRole, status = 'Active', employmentStatus = 'Active' }) {
  const u = await prisma.user.create({
    data: {
      name: `ZZTEST TK ${label}`, email: `zztest.tk.${label.toLowerCase()}.${RUN}@example.test`, username: `zztest.tk.${label.toLowerCase()}.${RUN}@example.test`,
      passwordHash: 'x', status, role, hrmsRole: hrmsRole || role, atsRole: atsRole || 'NONE', accountsRole: 'NONE',
      hrmsAccess: true, atsAccess: !!atsRole, accountsAccess: false,
    },
  });
  made.users.push(u.id);
  const e = await prisma.employee.create({
    data: { userId: u.id, employeeCode: `ZZT-TK-${label}-${RUN}`.slice(0, 40), name: u.name, email: u.email, department: dept, team, designation: role, employmentStatus },
  });
  made.emps.push(e.id);
  return { u, e, name: u.name };
}
const notes = (u, like) => prisma.notification.findMany({ where: { userId: u.id, channel: 'In-App', title: { contains: like } } });
const auditOf = (taskId, action) => prisma.auditLog.findMany({ where: { entity: 'Task', entityId: taskId, ...(action ? { action } : {}) } });

async function cleanup() {
  const taskIds = [...made.tasks];
  const extraTasks = await prisma.task.findMany({ where: { OR: [{ assigneeId: { in: made.users } }, { assignedById: { in: made.users } }] }, select: { id: true } });
  extraTasks.forEach((t) => taskIds.push(t.id));
  await prisma.employeeRecord.deleteMany({ where: { employeeId: { in: made.emps } } });
  await prisma.taskComment.deleteMany({ where: { taskId: { in: taskIds } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: taskIds } }, { AND: [{ createdAt: { gte: STARTED } }, { OR: [{ actorName: { contains: 'ZZTEST' } }, { toValue: { contains: 'ZZTEST' } }, { reason: { contains: 'ZZTEST' } }] }] }] } });
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { AND: [{ createdAt: { gte: STARTED } }, { OR: [{ title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }, { recipient: { contains: 'example.test' } }, { recipient: { contains: 'ZZTEST' } }] }] }] } });
  await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
}

(async () => {
  try {
    // ---- the world -------------------------------------------------------
    const tlA = await person('TLA', { role: 'TL', dept: 'Education', team: 'ZZ-A' });
    const a1 = await person('A1', { dept: 'Education', team: 'ZZ-A' });
    const a2 = await person('A2', { dept: 'Education', team: 'ZZ-A' });
    const a3 = await person('A3', { dept: 'Education', team: 'ZZ-A' });
    const rec = await person('Rec', { role: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsRole: 'RECRUITER', dept: 'Education', team: 'ZZ-A' });
    const gone = await person('Gone', { dept: 'Education', team: 'ZZ-A', employmentStatus: 'Exited' });
    const noLogin = await person('Locked', { dept: 'Education', team: 'ZZ-A', status: 'Inactive' });
    const tlB = await person('TLB', { role: 'TL', dept: 'Education', team: 'ZZ-B' });
    const b1 = await person('B1', { dept: 'Education', team: 'ZZ-B' });
    const med = await person('Med', { dept: 'Medical' });
    const mgr = await person('Mgr', { role: 'MANAGER', dept: 'Administration' });
    const stl = await person('STL', { role: 'STL', dept: 'Education' });
    const adm = await person('Adm', { role: 'ADMIN', dept: 'Administration' });
    const hr = await person('HR', { role: 'HR', dept: 'HR' });
    const bdeTl = await person('BDETL', { role: 'TL', dept: 'BDE' });
    const bde1 = await person('BDE1', { dept: 'BDE' });

    // ================= A - who may be picked ===============================
    const optA = await call(tlA.u, 'GET', '/tasks/options');
    const pickA = (optA.body.assignable || []).map((p) => p.name);
    check('A1 TL: canGive is true', optA.body.canGive === true && optA.body.canAssignOthers === true, optA.body);
    check('A2 TL sees own team members + self', [a1, a2, a3, rec, tlA].every((p) => pickA.includes(p.name)), pickA);
    check('A3 TL does not see another team (B1, TL B), another department, a manager', ![b1, tlB, med, mgr, stl, adm].some((p) => pickA.includes(p.name)), pickA);
    check('A4 exited and disabled people are never listed', !pickA.includes(gone.name) && !pickA.includes(noLogin.name), pickA);
    check('A5 list carries department/team/open-task counts for the cascade', (optA.body.assignable || []).every((p) => 'open' in p && 'department' in p && 'team' in p));
    const optB = await call(bdeTl.u, 'GET', '/tasks/options');
    const pickB = (optB.body.assignable || []).map((p) => p.name);
    check('A6 BDE TL picks only the BDE desk', pickB.includes(bde1.name) && !pickB.includes(a1.name) && !pickB.includes(med.name), pickB);

    // ================= B - creating ========================================
    const due = day(5);
    const c1 = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST call 20 leads', description: 'Use the new list', assigneeIds: [a1.u.id], priority: 'High', startDate: day(0), endDate: due, estimatedHours: 6 }));
    check('B1 TL gives a task to one team member (201)', c1.status === 201 && c1.body.created === 1, c1.body);
    const t1 = c1.body.tasks && c1.body.tasks[0];
    check('B2 task defaults: Not Started, department of the assignee, priority kept', t1 && t1.status === 'Not Started' && t1.department === 'Education' && t1.priority === 'High' && t1.assignedById === tlA.u.id, t1);
    const before = await prisma.task.count({ where: { assignedById: tlA.u.id } });
    const c2 = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST other team', assigneeIds: [b1.u.id], startDate: day(0) }));
    check('B3 another team\'s member is refused (403)', c2.status === 403, c2.body);
    const c2b = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST mixed', assigneeIds: [a1.u.id, b1.u.id], startDate: day(0) }));
    check('B4 a mixed list is refused as a whole and nothing is written', c2b.status === 403 && (await prisma.task.count({ where: { assignedById: tlA.u.id } })) === before, c2b.body);
    const c3 = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST exited', assigneeIds: [gone.u.id], startDate: day(0) }));
    check('B5 an exited person is refused (403)', c3.status === 403, c3.body);
    const c4 = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST team drive', description: 'Everyone does it', assigneeIds: [a1.u.id, a2.u.id, a3.u.id], startDate: day(0), endDate: day(3) }));
    check('B6 many people: ONE TASK PER PERSON (3 tasks, 3 different assignees)', c4.status === 201 && c4.body.created === 3 && new Set(c4.body.tasks.map((t) => t.assigneeId)).size === 3, c4.body);
    const c5 = track(await call(tlA.u, 'POST', '/tasks', { name: '   ', assigneeIds: [a1.u.id], startDate: day(0) }));
    check('B7 missing name is a plain 400', c5.status === 400 && /task name/i.test(c5.body.error), c5.body);
    const c6 = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST bad dates', assigneeIds: [a1.u.id], startDate: day(2), endDate: day(1) }));
    check('B8 due date before start date is a 400', c6.status === 400 && c6.body.field === 'endDate', c6.body);
    const c7 = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST bad est', assigneeIds: [a1.u.id], startDate: day(0), estimatedHours: -3 }));
    check('B9 negative estimate is a 400', c7.status === 400 && c7.body.field === 'estimatedHours', c7.body);
    const legacy = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST old style', department: 'Education', status: 'Not Started', assigneeId: a2.u.id, startDate: day(0) }));
    check('B10 the old single-assignee call still works', legacy.status === 201 && legacy.body.assigneeId === a2.u.id, legacy.body);
    const outsideOld = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST old outside', department: 'Education', status: 'Not Started', assigneeId: b1.u.id, startDate: day(0) }));
    check('B11 the old single-assignee call is also refused for another team (403)', outsideOld.status === 403, outsideOld.body);

    // ================= C - the rights table ================================
    const eSelf = track(await call(a1.u, 'POST', '/tasks', { name: 'ZZTEST my own list', assigneeIds: [a1.u.id], startDate: day(0) }));
    check('C1 Employee can create a task for themselves', eSelf.status === 201, eSelf.body);
    const eOther = track(await call(a1.u, 'POST', '/tasks', { name: 'ZZTEST for a friend', assigneeIds: [a2.u.id], startDate: day(0) }));
    check('C2 Employee cannot give a task to someone else (403)', eOther.status === 403, eOther.body);
    const rOther = track(await call(rec.u, 'POST', '/tasks', { name: 'ZZTEST recruiter gives', assigneeIds: [a2.u.id], startDate: day(0) }));
    const rSelf = track(await call(rec.u, 'POST', '/tasks', { name: 'ZZTEST recruiter own', assigneeIds: [rec.u.id], startDate: day(0) }));
    check('C3 Recruiter cannot give to others (403) but can plan their own', rOther.status === 403 && rSelf.status === 201, [rOther.status, rSelf.status]);
    const optE = await call(a1.u, 'GET', '/tasks/options');
    check('C4 Employee options: canGive false, only themselves offered', optE.body.canGive === false && (optE.body.assignable || []).length === 1, optE.body.assignable);
    const mTry = track(await call(mgr.u, 'POST', '/tasks', { name: 'ZZTEST manager gives', assigneeIds: [a1.u.id], startDate: day(0) }));
    check('C5 Manager is view-only by the permission matrix (403) - flagged to main', mTry.status === 403, mTry.body);
    const sTry = track(await call(stl.u, 'POST', '/tasks', { name: 'ZZTEST stl gives', assigneeIds: [a1.u.id, b1.u.id], startDate: day(0) }));
    check('C6 STL (Education) can give to both Education teams', sTry.status === 201 && sTry.body.created === 2, sTry.body);
    const sOut = track(await call(stl.u, 'POST', '/tasks', { name: 'ZZTEST stl outside', assigneeIds: [med.u.id], startDate: day(0) }));
    check('C7 STL cannot give to another department (403)', sOut.status === 403, sOut.body);
    const aTry = track(await call(adm.u, 'POST', '/tasks', { name: 'ZZTEST admin gives', assigneeIds: [med.u.id, a1.u.id, bde1.u.id], startDate: day(0) }));
    check('C8 Admin can give across departments', aTry.status === 201 && aTry.body.created === 3, aTry.body);
    const hTry = track(await call(hr.u, 'POST', '/tasks', { name: 'ZZTEST hr gives', assigneeIds: [med.u.id, b1.u.id], startDate: day(0) }));
    check('C9 HR can give company-wide', hTry.status === 201 && hTry.body.created === 2, hTry.body);
    const bTry = track(await call(bdeTl.u, 'POST', '/tasks', { name: 'ZZTEST bde desk', assigneeIds: [bde1.u.id], startDate: day(0) }));
    const bOut = track(await call(bdeTl.u, 'POST', '/tasks', { name: 'ZZTEST bde outside', assigneeIds: [a1.u.id], startDate: day(0) }));
    check('C10 BDE TL gives to the BDE desk only', bTry.status === 201 && bOut.status === 403, [bTry.status, bOut.status]);

    // ================= D - the assignee ====================================
    const mine = await call(a1.u, 'GET', '/tasks');
    const seen = (mine.body || []).filter((t) => t.id === t1.id)[0];
    check('D1 assignee sees the task in their Timesheet with giver, due date, priority, estimate', seen && seen.assignedByName === tlA.name && seen.endDate === due && seen.priority === 'High' && seen.estimatedHours === 6 && seen.rights.assignee === true && seen.rights.manage === false, seen);
    const bell = await notes(a1.u, 'New task from');
    check('D2 the assignee got a bell: "New task from <TL>: <task> (due ...)"', bell.some((n) => n.title.includes(tlA.name) && n.title.includes('ZZTEST call 20 leads') && /due \d\d-[A-Z]{3}-\d{4}/.test(n.title)), bell.map((n) => n.title));
    const mail = await prisma.notification.findMany({ where: { userId: a1.u.id, channel: 'Email', title: { contains: 'New task from' } } });
    check('D3 the same notice waits for the daily email (nothing sent while emails are off)', mail.length >= 1, mail.map((m) => m.status));
    const other = await call(a2.u, 'GET', '/tasks');
    check('D4 A2 does not see A1\'s task', !(other.body || []).some((t) => t.id === t1.id));
    const bList = await call(b1.u, 'GET', '/tasks');
    check('D5 a member of another team sees none of team A\'s tasks', !(bList.body || []).some((t) => (c4.body.ids || []).includes(t.id) || t.id === t1.id));

    const p1 = await call(a1.u, 'PUT', `/tasks/${t1.id}`, { name: 'ZZTEST renamed by me' });
    check('D6 the assignee cannot rename the task (403, plain words)', p1.status === 403 && /Only/.test(p1.body.error), p1.body);
    const p2 = await call(a1.u, 'PUT', `/tasks/${t1.id}`, { endDate: day(30) });
    const p3 = await call(a1.u, 'PUT', `/tasks/${t1.id}`, { assigneeId: a2.u.id });
    const p4 = await call(a1.u, 'PUT', `/tasks/${t1.id}`, { priority: 'Low', estimatedHours: 1 });
    check('D7 the assignee cannot change the due date, the person, the priority or the estimate (403)', [p2, p3, p4].every((r) => r.status === 403), [p2.status, p3.status, p4.status]);
    const p5 = await call(a1.u, 'PUT', `/tasks/${t1.id}`, { status: 'On Hold' });
    check('D8 the assignee can move it to On Hold (progress)', p5.status === 200 && p5.body.status === 'On Hold', p5.body);
    const p6 = await call(a1.u, 'PUT', `/tasks/${t1.id}`, { status: 'Completed' });
    check('D9 "Completed" must go through Done (400)', p6.status === 400, p6.body);
    const st = await call(a1.u, 'POST', `/tasks/${t1.id}/start`, {});
    check('D10 Start works', st.status === 200 && st.body.status === 'In Progress', st.body);

    const h0 = await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 2.5, date: day(0), note: 'First pass' });
    check('D11 the assignee adds hours (201)', h0.status === 201 && h0.body.hoursLogged === 2.5, h0.body);
    const h1 = await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 1, date: day(-1) });
    check('D12 hours for yesterday are fine', h1.status === 201 && h1.body.hoursLogged === 3.5, h1.body);
    const hBad = [
      await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 25, date: day(0) }),
      await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 0, date: day(0) }),
      await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 1, date: day(1) }),
      await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 1, date: day(-40) }),
      await call(a1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 'abc', date: day(0) }),
    ];
    check('D13 bad hours are plain 400s (over 24, zero, tomorrow, too old, text)', hBad.every((r) => r.status === 400 && r.body.error), hBad.map((r) => `${r.status} ${r.body && r.body.error}`));
    const hTl = await call(tlA.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 1, date: day(0) });
    check('D14 the TL cannot add hours for the assignee (403)', hTl.status === 403, hTl.body);
    const hOut = await call(b1.u, 'POST', `/tasks/${t1.id}/hours`, { hours: 1, date: day(0) });
    check('D15 someone from another team cannot add hours (403)', hOut.status === 403, hOut.body);
    const list2 = (await call(a1.u, 'GET', '/tasks')).body.find((t) => t.id === t1.id);
    check('D16 the list carries hours logged vs estimated (3.5 of 6)', list2.hoursLogged === 3.5 && list2.estimatedHours === 6, [list2.hoursLogged, list2.estimatedHours]);
    const hGet = await call(a1.u, 'GET', `/tasks/${t1.id}/hours`);
    check('D17 the hours list has both entries and the total', hGet.status === 200 && hGet.body.entries.length === 2 && hGet.body.logged === 3.5 && hGet.body.estimated === 6, hGet.body);
    const hAud = await auditOf(t1.id, 'Task hours added');
    check('D18 hours added are in the audit log', hAud.length === 2, hAud.length);

    // done with a note -> the TL hears
    const done = await call(a1.u, 'POST', `/tasks/${t1.id}/complete`, { note: 'All 20 called' });
    check('D19 the assignee marks it Done with a note', done.status === 200 && done.body.status === 'Completed' && done.body.reviewState === 'Pending Review', done.body);
    const tlBell = await notes(tlA.u, 'Task finished');
    check('D20 the TL got a bell: task finished', tlBell.some((n) => n.title.includes('ZZTEST call 20 leads')), tlBell.map((n) => n.title));
    const cm = await call(tlA.u, 'GET', `/tasks/${t1.id}/comments`);
    check('D21 the note is in the task\'s thread', (cm.body.comments || []).some((c) => /All 20 called/.test(c.text)));

    // ================= E - the giver =======================================
    const rev = await call(tlA.u, 'POST', '/tasks/review-batch', { ids: [t1.id] });
    check('E1 one-click approve: the TL approves the finished task', rev.status === 200 && rev.body.approved === 1, rev.body);
    const approvedBell = await notes(a1.u, 'Task approved');
    check('E2 the assignee hears it was approved', approvedBell.length >= 1);
    const rev2 = await call(a1.u, 'POST', '/tasks/review-batch', { ids: [c4.body.ids[0]] });
    check('E3 an employee cannot approve (403)', rev2.status === 403, rev2.body);

    const tB = c4.body.tasks.find((t) => t.assigneeId === a2.u.id);
    const ex0 = await call(a2.u, 'POST', `/tasks/${tB.id}/extend`, { endDate: day(10) });
    check('E4 the assignee cannot move the due date (403)', ex0.status === 403, ex0.body);
    const ex = await call(tlA.u, 'POST', `/tasks/${tB.id}/extend`, { endDate: day(10), reason: 'Client asked for more time' });
    check('E5 the TL extends the due date', ex.status === 200 && ex.body.endDate === day(10), ex.body);
    const exAud = await auditOf(tB.id, 'Task updated');
    check('E6 audit has old -> new for the due date', exAud.some((a) => a.field === 'endDate' && a.fromValue === day(3) && a.toValue === day(10) && a.userId === tlA.u.id), exAud.map((a) => `${a.field}:${a.fromValue}->${a.toValue}`));
    const exBell = await notes(a2.u, 'Due date changed');
    check('E7 the assignee hears about the new date', exBell.length === 1);
    const exBad = await call(tlA.u, 'POST', `/tasks/${tB.id}/extend`, { endDate: '2026-02-31' });
    check('E8 an impossible date is a 400', exBad.status === 400, exBad.body);

    // hours by a2 then reassign
    await call(a2.u, 'POST', `/tasks/${tB.id}/hours`, { hours: 2, date: day(0) });
    const re = await call(tlA.u, 'POST', `/tasks/${tB.id}/reassign`, { assigneeId: a3.u.id, note: 'A2 is overloaded' });
    check('E9 the TL reassigns to another member of the team', re.status === 200 && re.body.assigneeId === a3.u.id && re.body.status === 'Not Started', re.body);
    const reAud = await auditOf(tB.id, 'Task given to someone else');
    check('E10 audit: Given to ' + a2.name + ' -> ' + a3.name, reAud.some((a) => a.field === 'assignee' && a.fromValue === a2.name && a.toValue === a3.name), reAud.map((a) => `${a.field}:${a.fromValue}->${a.toValue}`));
    check('E11 both people were told (old: moved; new: new task)', (await notes(a2.u, 'Task moved to someone else')).length === 1 && (await notes(a3.u, 'New task from')).length >= 2);
    const reOut = await call(tlA.u, 'POST', `/tasks/${tB.id}/reassign`, { assigneeId: b1.u.id });
    check('E12 reassigning outside the team is refused (403)', reOut.status === 403, reOut.body);
    const keep = await call(tlA.u, 'GET', `/tasks/${tB.id}/hours`);
    check('E13 hours already worked stay with the task after the move (2h by ' + a2.name + ')', keep.body.logged === 2 && keep.body.entries[0].byName === a2.name, keep.body);
    const a2NoLog = await call(a2.u, 'POST', `/tasks/${tB.id}/hours`, { hours: 1, date: day(0) });
    check('E14 the old assignee can no longer add hours (403)', a2NoLog.status === 403, a2NoLog.body);

    // TL corrects someone's hours (audit)
    const eid = keep.body.entries[0].id;
    const fixNoWhy = await call(tlA.u, 'PUT', `/tasks/${tB.id}/hours/${eid}`, { hours: 1.5 });
    check('E15 the TL must say why when changing someone else\'s hours (400)', fixNoWhy.status === 400, fixNoWhy.body);
    const fix = await call(tlA.u, 'PUT', `/tasks/${tB.id}/hours/${eid}`, { hours: 1.5, reason: 'Lunch was counted' });
    const fixAud = await auditOf(tB.id, 'Task hours changed by a lead');
    check('E16 the TL corrects the hours; audit has 2 -> 1.5 with the reason', fix.status === 200 && fixAud.some((a) => a.field === 'hours' && a.fromValue === '2' && a.toValue === '1.5' && a.reason === 'Lunch was counted' && a.userId === tlA.u.id), [fix.status, fixAud.map((a) => `${a.fromValue}->${a.toValue}`)]);
    check('E17 the person whose hours changed was told', (await notes(a2.u, 'Your hours were changed')).length === 1);
    const fixOut = await call(tlB.u, 'PUT', `/tasks/${tB.id}/hours/${eid}`, { hours: 9, reason: 'x' });
    check('E18 a TL of another team cannot touch those hours (403)', fixOut.status === 403, fixOut.body);
    const own = await call(a2.u, 'PUT', `/tasks/${tB.id}/hours/${eid}`, { hours: 3 });
    check('E19 the person can correct their own entry (audited)', own.status === 200 && (await auditOf(tB.id, 'Task hours changed')).some((a) => a.fromValue === '1.5' && a.toValue === '3'), own.body);
    const del = await call(a2.u, 'DELETE', `/tasks/${tB.id}/hours/${eid}`);
    check('E20 and can remove it (audited)', del.status === 200 && (await auditOf(tB.id, 'Task hours removed')).length === 1, del.body);

    // cancel
    const tC = c4.body.tasks.find((t) => t.assigneeId === a1.u.id);
    const cn0 = await call(a1.u, 'POST', `/tasks/${tC.id}/cancel`, { reason: 'no' });
    check('E21 the assignee cannot cancel (403)', cn0.status === 403, cn0.body);
    const cn1 = await call(tlA.u, 'POST', `/tasks/${tC.id}/cancel`, {});
    check('E22 cancel asks for a reason (400)', cn1.status === 400 && /why/i.test(cn1.body.error), cn1.body);
    const cn = await call(tlA.u, 'POST', `/tasks/${tC.id}/cancel`, { reason: 'Campaign stopped' });
    check('E23 the TL cancels with a reason', cn.status === 200 && cn.body.status === 'Cancelled', cn.body);
    const cnAud = await auditOf(tC.id, 'Task cancelled');
    check('E24 audit: status -> Cancelled with the reason', cnAud.length === 1 && cnAud[0].toValue === 'Cancelled' && cnAud[0].reason === 'Campaign stopped');
    check('E25 the assignee was told', (await notes(a1.u, 'Task cancelled')).length === 1);
    const cnList = (await call(a1.u, 'GET', '/tasks')).body.find((t) => t.id === tC.id);
    check('E26 the list shows the cancel reason', cnList.cancelReason === 'Campaign stopped');
    const cnHours = await call(a1.u, 'POST', `/tasks/${tC.id}/hours`, { hours: 1, date: day(0) });
    check('E27 no hours on a cancelled task (400)', cnHours.status === 400, cnHours.body);
    const cnDone = await call(tlA.u, 'POST', `/tasks/${t1.id}/cancel`, { reason: 'late' });
    check('E28 a Done task cannot be cancelled (400)', cnDone.status === 400, cnDone.body);

    // edit by the giver
    const ed = await call(tlA.u, 'PUT', `/tasks/${legacy.body.id}`, { name: 'ZZTEST old style v2', priority: 'Low', estimatedHours: 4, description: 'new notes' });
    const edAud = await auditOf(legacy.body.id, 'Task updated');
    check('E29 the TL edits name, priority, notes, estimate; each change is in the audit', ed.status === 200 && ['name', 'priority', 'description', 'estimatedHours'].every((f) => edAud.some((a) => a.field === f)), edAud.map((a) => a.field));
    const sentBack = await call(tlA.u, 'PUT', `/tasks/${legacy.body.id}`, { status: 'Cancelled' });
    check('E30 cancelling through Edit is refused (it must ask why)', sentBack.status === 400, sentBack.body);

    // ================= F - overdue =========================================
    const late = track(await call(tlA.u, 'POST', '/tasks', { name: 'ZZTEST late one', assigneeIds: [a3.u.id], startDate: day(-10), endDate: day(-3) }));
    const hn = require(path.join(BACK, 'src/utils/hrmsNotify'));
    await hn.reminders({ testMode: true, scope: { userIds: [a3.u.id, tlA.u.id] }, settings: { ...(await hn.getSettings()), emailsOn: false } });
    const lateA = await prisma.notification.findMany({ where: { userId: a3.u.id, channel: 'In-App', title: { contains: 'Task overdue: ZZTEST late one' } } });
    const lateTl = await prisma.notification.findMany({ where: { userId: tlA.u.id, channel: 'In-App', title: { contains: 'you gave' } } });
    check('F1 the assignee gets the overdue reminder', lateA.length === 1, lateA.length);
    check('F2 the giver gets ONE bell listing the late tasks they gave', lateTl.length === 1 && /ZZTEST late one/.test(lateTl[0].message || ''), lateTl.map((n) => n.title));
    await hn.reminders({ testMode: true, scope: { userIds: [a3.u.id, tlA.u.id] }, settings: { ...(await hn.getSettings()), emailsOn: false } });
    check('F3 a second run the same day does not repeat either bell', (await prisma.notification.count({ where: { userId: tlA.u.id, channel: 'In-App', title: { contains: 'you gave' } } })) === 1);

    // a task given TO the lead by someone above is not the lead's to rewrite
    const up = track(await call(adm.u, 'POST', '/tasks', { name: 'ZZTEST from the boss', assigneeIds: [tlA.u.id], startDate: day(0), endDate: day(4) }));
    const upId = up.body.ids[0];
    const upPut = await call(tlA.u, 'PUT', `/tasks/${upId}`, { name: 'ZZTEST I rename it' });
    const upCancel = await call(tlA.u, 'POST', `/tasks/${upId}/cancel`, { reason: 'no' });
    const upRe = await call(tlA.u, 'POST', `/tasks/${upId}/reassign`, { assigneeId: a1.u.id });
    const upMine = (await call(tlA.u, 'GET', '/tasks')).body.find((x) => x.id === upId);
    check('F4 a task the boss gave the TL: the TL cannot rename, cancel or hand it on (403) - only do it', upPut.status === 403 && upCancel.status === 403 && upRe.status === 403 && upMine.rights.manage === false && upMine.rights.assignee === true, [upPut.status, upCancel.status, upRe.status, upMine && upMine.rights]);
    const upHours = await call(tlA.u, 'POST', `/tasks/${upId}/hours`, { hours: 1, date: day(0) });
    check('F5 ...but the TL can log hours on it, and the boss sees them', upHours.status === 201 && (await call(adm.u, 'GET', `/tasks/${upId}/hours`)).body.logged === 1, upHours.body);

    // ================= G - scope + export ===================================
    const g1 = await call(tlB.u, 'GET', `/tasks?assigneeId=${a1.u.id}`);
    check('G1 a TL of another team cannot list team A\'s person (403)', g1.status === 403, g1.body);
    const g2 = await call(tlB.u, 'GET', '/tasks');
    check('G2 the other TL\'s list has none of team A\'s tasks', !(g2.body || []).some((t) => [a1, a2, a3].some((p) => p.u.id === t.assigneeId) && t.assignedById === tlA.u.id));
    const g3 = await call(tlA.u, 'GET', '/tasks');
    check('G3 team A\'s TL sees team A\'s tasks, none for the other team', (g3.body || []).some((t) => t.id === t1.id) && !(g3.body || []).some((t) => t.assigneeId === b1.u.id && t.assignedById === tlA.u.id));
    const ex1 = await call(tlA.u, 'GET', '/tasks/export?format=csv&given=1', undefined, true);
    const csvText = ex1.buf.toString('utf8');
    check('G4 export (CSV) of "tasks I gave" is 200 and has team A\'s tasks and hours columns', ex1.status === 200 && /ZZTEST call 20 leads/.test(csvText) && /Hours logged/.test(csvText) && /Estimated hours/.test(csvText), csvText.slice(0, 300));
    check('G5 the export has no other team\'s task', !/ZZTEST stl gives/.test(csvText.split('\n').filter((l) => /B1/.test(l)).join('\n')));
    const ex2 = await call(tlA.u, 'GET', '/tasks/export?format=xlsx&given=1', undefined, true);
    check('G6 Excel export is a real .xlsx', ex2.status === 200 && ex2.buf.slice(0, 2).toString() === 'PK', ex2.status);
    const ex3 = await call(tlA.u, 'GET', '/tasks/export?format=pdf&given=1', undefined, true);
    check('G7 PDF export is a real PDF', ex3.status === 200 && ex3.buf.slice(0, 4).toString() === '%PDF', ex3.status);
    const ex4 = await call(tlB.u, 'GET', '/tasks/export?format=csv&given=1', undefined, true);
    check('G8 the other TL\'s export has none of team A\'s tasks', ex4.status === 200 && !/ZZTEST call 20 leads/.test(ex4.buf.toString('utf8')));
    const ex5 = await call(tlB.u, 'GET', `/tasks/export?format=csv&assigneeId=${a1.u.id}`, undefined, true);
    check('G9 exporting another team\'s person is refused (403)', ex5.status === 403, ex5.status);
    const ex6 = await call(a1.u, 'GET', '/tasks/export?format=csv', undefined, true);
    check('G10 an Employee exports only their own tasks (or is refused) - never the team', ex6.status === 403 || !/ZZTEST team drive[^\n]*ZZTEST TK A2/.test(ex6.buf.toString('utf8')));
    const ex7 = await call(tlA.u, 'GET', `/tasks/export?format=csv&from=${day(0)}&to=${day(0)}&given=1`, undefined, true);
    check('G11 export for a chosen period works', ex7.status === 200 && /in these dates/.test(ex7.buf.toString('utf8')), ex7.status);

    // ================= H - Act as / View as ==================================
    const actAs = require(path.join(BACK, 'src/utils/actAs'));
    check('H1 "Act as" does not block the task routes', ['/tasks', `/tasks/${t1.id}/hours`, `/tasks/${t1.id}/cancel`, `/tasks/${t1.id}/extend`, '/tasks/review-batch'].every((p) => !actAs.blockedFor('POST', p)));
    const dash = await call(a1.u, 'GET', '/tasks/reports');
    check('H2 reports carry hours per person', dash.status === 200 && Array.isArray(dash.body.byPerson) && dash.body.byPerson.every((r) => 'hoursLogged' in r), dash.body && dash.body.byPerson);
  } catch (e) {
    console.error(e);
    fail += 1;
  } finally {
    await cleanup();
    const left = await prisma.user.count({ where: { email: { contains: `zztest.tk.` } } });
    const leftT = await prisma.task.count({ where: { name: { contains: 'ZZTEST' } } });
    console.log(`\nCleanup: ZZTEST TK users left ${left}, ZZTEST tasks left ${leftT}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
