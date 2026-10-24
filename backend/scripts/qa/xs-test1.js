// Exit paths free the seat. Run: TL_API=http://localhost:4011 NODE_PATH=<backend>/node_modules node xs-test1.js
const L = require('./xs-lib');
const { prisma, ok } = L;
const today = new Date().toISOString().slice(0, 10);

(async () => {
  const admin = await L.mkUser('Admin', { role: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true });
  const open = (pid) => prisma.positionAssignment.findFirst({ where: { positionId: pid, toDate: null } });
  const rows = (pid) => prisma.positionAssignment.findMany({ where: { positionId: pid }, orderBy: { fromDate: 'asc' } });

  // ---- 1. HR edit form: status -> Relieved -------------------------------
  console.log('1. Edit form: Relieved');
  const p1 = await L.mkSeat('S1');
  const a1 = await L.mkEmp('Leaver One'); await L.seatIn(p1.id, a1.id, '2026-10-01');
  let r = await L.call(admin, 'PUT', `/employees/${a1.id}`, { employmentStatus: 'Relieved' });
  ok(r.status === 200, 'PUT status Relieved -> 200', r);
  ok(!(await open(p1.id)), 'seat has no open tenure');
  let t = (await rows(p1.id))[0];
  ok(t && t.toDate === today && /^Exited/.test(t.note || ''), 'tenure ended today with an Exited note', t);
  const au = await prisma.auditLog.findMany({ where: { entityId: { in: [p1.id, a1.id] }, action: { startsWith: 'Seat ' } } });
  ok(au.length === 2 && au.every((x) => x.actorName === admin.name), 'two audit rows naming the actor', au.map((x) => [x.action, x.actorName]));
  // vacant in the lists + pickers
  const list = await L.get(admin, '/positions');
  const row = (list.body || []).find((x) => x.id === p1.id);
  ok(row && row.vacant === true && row.holder === null, 'GET /positions shows the seat vacant', row);
  const b1 = await L.mkEmp('Successor One');
  const det = await L.get(admin, `/employees/${b1.id}`);
  const opt = ((det.body || {}).positionOptions || []).find((o) => o.code === p1.code);
  ok(opt && opt.vacant === true && !opt.holder, 'Edit-employee Position picker lists the seat as vacant', opt);
  const mo = await L.get(admin, '/employees/management/options');
  const mp = ((mo.body || {}).positions || []).find((o) => o.code === p1.code);
  ok(mp && mp.vacant === true && mp.holder === null, 'Add Employee Position picker lists the seat as vacant', mp);
  ok(mo.body && mo.body.documents === undefined, 'Add Employee options carry NO documents block');
  // same-day successor
  r = await L.call(admin, 'PUT', `/employees/${b1.id}`, { position: p1.code });
  ok(r.status === 200, 'successor takes the seat the same day -> 200', r);
  const cur = await open(p1.id);
  ok(cur && cur.employeeId === b1.id, 'successor holds the seat now');
  ok((await rows(p1.id)).length === 2, 'history keeps both tenures');
  // exited holder not counted: leaver is not shown on the Positions list as holder
  const st = await L.get(admin, '/positions/structure');
  ok(st.status === 200, 'structure endpoint OK');

  // ---- 2. resignation marked Relieved ------------------------------------
  console.log('2. Resignation: Relieved');
  const p2 = await L.mkSeat('S2');
  const a2 = await L.mkEmp('Leaver Two', { employmentStatus: 'Notice Period' }); await L.seatIn(p2.id, a2.id, '2026-09-01');
  const rec = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: a2.id, title: 'ZZTEST resignation', status: 'Notice Period', date: '2026-10-05' } });
  L.made.records.push(rec.id);
  await prisma.resignationDetail.create({ data: { recordId: rec.id, employeeId: a2.id, resignationDate: '2026-09-05', requestedLastWorkingDate: '2026-10-05', approvedLastWorkingDate: '2026-10-05', reason: 'Other' } });
  r = await L.call(admin, 'PATCH', `/resignations/${rec.id}/status`, { status: 'Relieved' });
  ok(r.status === 200, 'resignation PATCH Relieved -> 200', r);
  t = (await rows(p2.id))[0];
  ok(t && t.toDate === '2026-10-05' && /last working day/.test(t.note || ''), 'tenure ended on the LAST WORKING DAY (evidence)', t);
  const emp2 = await prisma.employee.findUnique({ where: { id: a2.id } });
  ok(emp2.employmentStatus === 'Relieved', 'employee is Relieved');
  const rau = await prisma.auditLog.findFirst({ where: { entityId: p2.id, action: { startsWith: 'Seat ' } } });
  ok(rau && rau.actorName === admin.name, 'resignation path audit names the HR user', rau && rau.actorName);

  // ---- 3. offboarding checklist -----------------------------------------
  console.log('3. Offboarding checklist');
  const p3 = await L.mkSeat('S3');
  const a3 = await L.mkEmp('Leaver Three'); await L.seatIn(p3.id, a3.id, '2026-09-01');
  // exit approval rule (2026-10-13): the checklist relieves only an APPROVED exit whose last day has come
  const rec3 = await prisma.employeeRecord.create({ data: { type: 'RESIGNATION', employeeId: a3.id, title: 'ZZTEST resignation 3', status: 'Notice Period', date: '2026-10-05' } }); L.made.records.push(rec3.id);
  await prisma.resignationDetail.create({ data: { recordId: rec3.id, employeeId: a3.id, resignationDate: '2026-09-05', requestedLastWorkingDate: '2026-10-05', approvedLastWorkingDate: '2026-10-05', reason: 'Other' } });
  r = await L.call(admin, 'POST', `/employees/${a3.id}/offboarding`, {});
  ok(r.status === 200, 'offboarding started', r.body && r.body.error);
  ok(!!(await open(p3.id)), 'on Notice Period the seat is STILL held');
  const tasks = JSON.parse((await prisma.employee.findUnique({ where: { id: a3.id } })).offboardingTasks);
  for (let i = 0; i < tasks.length; i += 1) r = await L.call(admin, 'PATCH', `/employees/${a3.id}/offboarding/${i}`, {}); if (r.status !== 200) console.log('  note: checklist PATCH ->', r.status, JSON.stringify(r.body).slice(0, 240));
  ok((await prisma.employee.findUnique({ where: { id: a3.id } })).employmentStatus === 'Relieved', 'checklist done -> Relieved');
  ok(!(await open(p3.id)), 'checklist completion freed the seat');
  await prisma.fnfRequest.deleteMany({ where: { employeeId: a3.id } });

  // ---- 4. direct writes: bulk / import style -----------------------------
  console.log('4. Bulk status update / import style writes');
  const p4 = await L.mkSeat('S4'); const p5 = await L.mkSeat('S5');
  const a4 = await L.mkEmp('Leaver Four'); const a5 = await L.mkEmp('Leaver Five');
  await L.seatIn(p4.id, a4.id, '2026-09-01'); await L.seatIn(p5.id, a5.id, '2026-09-01');
  await prisma.employee.update({ where: { id: a4.id }, data: { employmentStatus: 'Exited' } });
  ok(!(await open(p4.id)), 'prisma update -> Exited frees the seat');
  await prisma.employee.updateMany({ where: { id: a5.id }, data: { employmentStatus: 'Exit Process' } });
  ok(!(await open(p5.id)), 'updateMany -> Exit Process frees the seat');
  const viaTx = await L.mkSeat('S6'); const a6 = await L.mkEmp('Leaver Six'); await L.seatIn(viaTx.id, a6.id, '2026-09-01');
  await prisma.$transaction([prisma.employee.update({ where: { id: a6.id }, data: { employmentStatus: 'Relieved' } })]);
  await new Promise((res) => setTimeout(res, 4500));
  ok(!(await open(viaTx.id)), 'update inside a transaction is freed a few seconds later');

  // ---- 5. Notice period ---------------------------------------------------
  console.log('5. Notice period');
  const pn = await L.mkSeat('N1');
  const n1 = await L.mkEmp('Noticer', { employmentStatus: 'Notice Period' }); await L.seatIn(pn.id, n1.id, '2026-09-01');
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  r = await L.call(admin, 'PUT', `/employees/management/${n1.id}/last-working-date`, { lastWorkingDate: future, reason: 'Handover agreed with the team lead' });
  ok(r.status === 200, 'last working date set', r);
  const lst = await L.get(admin, '/positions');
  const nrow = (lst.body || []).find((x) => x.id === pn.id);
  ok(nrow && !nrow.vacant && nrow.onNotice === true && nrow.freesOn === future, 'seat shows "frees on <date>" while on notice', nrow);
  const succ = await L.mkEmp('Successor Notice');
  r = await L.call(admin, 'POST', `/positions/${pn.id}/assign`, { employeeId: succ.id });
  ok(r.status === 409 && /on notice until/.test((r.body || {}).error || ''), 'assigning over a notice-period holder is refused in plain words', r.body);
  r = await L.call(admin, 'PUT', `/employees/${succ.id}`, { position: pn.code });
  ok(r.status === 409 && /on notice/.test((r.body || {}).error || ''), 'edit-form pick refused too', r.body);
  const sdet = await L.get(admin, `/employees/${succ.id}`);
  const sopt = ((sdet.body || {}).positionOptions || []).find((o) => o.code === pn.code);
  ok(sopt && sopt.onNotice === true && sopt.freesOn === future, 'edit picker labels it with the free-on date', sopt);
  // LWD passes -> sweep (sandbox sweeps on read)
  const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  r = await L.call(admin, 'PUT', `/employees/management/${n1.id}/last-working-date`, { lastWorkingDate: past, reason: 'Handover agreed with the team lead' });
  // force a fresh sweep: the throttle is 60 s, so poke the module the sandbox uses via a new request after waiting
  await new Promise((res) => setTimeout(res, 61000));
  await L.get(admin, '/positions');
  const nt = (await rows(pn.id))[0];
  ok(nt && nt.toDate === past && /^Notice ended/.test(nt.note || ''), 'last working day passed -> tenure ended on that day', nt);
  r = await L.call(admin, 'POST', `/positions/${pn.id}/assign`, { employeeId: succ.id });
  ok(r.status === 201, 'successor can take it now', r.body);

  // ---- 6. re-hire ---------------------------------------------------------
  console.log('6. Re-hire');
  r = await L.call(admin, 'POST', `/positions/${p4.id}/assign`, { employeeId: a4.id });
  ok(r.status === 409 && /left the company/.test((r.body || {}).error || ''), 'a person who has left cannot be given a seat');
  r = await L.call(admin, 'PUT', `/employees/${a4.id}`, { employmentStatus: 'Active' });
  r = await L.call(admin, 'PUT', `/employees/${a4.id}`, { position: p4.code });
  ok(r.status === 200, 're-hired person takes their old (still vacant) seat', r.body && r.body.error);
  const hist = await rows(p4.id);
  ok(hist.length === 2 && hist[0].toDate && hist[1].toDate === null, 'old ended tenure stays in history, new one is open', hist);
  const ph = await L.get(admin, `/positions/employee/${a4.id}`);
  ok(ph.status === 200 && ph.body.history.length === 2 && ph.body.history.some((h) => h.endedBecause === 'Exited'), 'person history shows the Exited end', ph.body && ph.body.history);

  const cl = await L.cleanup();
  console.log('cleanup', JSON.stringify(cl));
  process.exitCode = L.summary() ? 1 : 0;
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { console.log('cleanup', JSON.stringify(await L.cleanup())); } catch (x) { console.error(x); } process.exit(1); });
