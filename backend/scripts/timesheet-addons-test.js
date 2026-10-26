#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TIMESHEET TASKS, founder 2026-10-26: the cancel day shows, add-ons instead of changing a task, Task Reports by dates,
// an unfinished task can be given to someone else, and the Hours at Work cards say what they count. SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/timesheet-addons-test.js
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('TSA');

(async () => {
  const { prisma } = Z;
  try {
    const mk = (tag, role, hrmsRole) => Z.mkUser(tag, { role, hrmsRole, hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'R&D' });
    const lead = await mk('lead', 'TL', 'TL');
    const emp = await mk('emp', 'EMPLOYEE', 'EMPLOYEE');
    const emp2 = await mk('emp2', 'EMPLOYEE', 'EMPLOYEE');
    const L = await Z.mint(lead); const E = await Z.mint(emp);
    const mkTask = async (name, startDate, endDate) => {
      const r = await Z.call('POST', '/api/tasks', L, { name: `ZZTEST TSA ${name} ${Z.RUN}`, startDate, endDate, assigneeIds: [emp.id], priority: 'Medium' });
      const t = Array.isArray(r.body) ? r.body[0] : (r.body && (r.body.tasks ? r.body.tasks[0] : r.body));
      return { r, t };
    };
    const a = await mkTask('A', '2026-10-01', '2026-10-05');
    Z.check('T0 the lead gives a task', a.r.status >= 200 && a.r.status < 300 && a.t && a.t.id, [a.r.status, a.r.text.slice(0, 200)]);

    // add-ons
    const ad = await Z.call('POST', `/api/tasks/${a.t.id}/addons`, L, { text: 'Also call the 5 from last week', dueDate: '2026-10-06' });
    const empAdd = await Z.call('POST', `/api/tasks/${a.t.id}/addons`, E, { text: 'I add my own' });
    Z.check('A1 the lead adds an add-on; the person cannot add one', ad.status === 201 && empAdd.status === 403, [ad.status, empAdd.status]);
    const tick = await Z.call('PATCH', `/api/tasks/${a.t.id}/addons/${ad.body.id}`, E, { done: true });
    Z.check('A2 the person ticks the add-on as done', tick.status === 200 && tick.body.done === true && !!tick.body.doneByName, [tick.status, tick.body]);
    const list = await Z.call('GET', '/api/tasks?view=mine', E);
    const row = (Array.isArray(list.body) ? list.body : []).find((x) => x.id === a.t.id);
    Z.check('A3 the task list carries its add-ons; the task text itself is unchanged', row && row.addOns && row.addOns.length === 1 && row.name === a.t.name, row && { addOns: row.addOns && row.addOns.length, name: row.name });
    const delDone = await Z.call('DELETE', `/api/tasks/${a.t.id}/addons/${ad.body.id}`, L);
    Z.check('A4 a done add-on stays (cannot be removed)', delDone.status === 400, delDone.status);

    // reassign an unfinished task
    const re = await Z.call('POST', `/api/tasks/${a.t.id}/reassign`, L, { assigneeId: emp2.id, note: 'ZZTEST TSA' });
    Z.check('R1 an unfinished task is given to someone else', re.status === 200 && re.body.assigneeId === emp2.id, [re.status, re.text.slice(0, 160)]);

    // cancel day
    const c = await Z.call('POST', `/api/tasks/${a.t.id}/cancel`, L, { reason: 'ZZTEST TSA client stopped it' });
    const tc = await prisma.task.findUnique({ where: { id: a.t.id } });
    Z.check('C1 cancelling records the day and who cancelled', c.status === 200 && tc.cancelledAt && tc.cancelledByName === lead.name, [c.status, tc.cancelledAt, tc.cancelledByName]);
    const addLate = await Z.call('POST', `/api/tasks/${a.t.id}/addons`, L, { text: 'too late' });
    Z.check('C2 no add-on on a cancelled task', addLate.status === 400, addLate.status);
    const ro = await Z.call('PUT', `/api/tasks/${a.t.id}`, L, { status: 'In Progress' });
    const tr = await prisma.task.findUnique({ where: { id: a.t.id } });
    Z.check('C3 opening it again clears the cancel day', ro.status === 200 && !tr.cancelledAt && tr.status === 'In Progress', [ro.status, tr.status, tr.cancelledAt]);

    // reports by date
    const b = await mkTask('B', '2026-11-10', '2026-11-12');
    const inOct = await Z.call('GET', '/api/tasks/reports?from=2026-10-01&to=2026-10-31', L);
    const inNov = await Z.call('GET', '/api/tasks/reports?from=2026-11-01&to=2026-11-30', L);
    const all = await Z.call('GET', '/api/tasks/reports', L);
    const names = (r) => JSON.stringify(r.body || {});
    Z.check('D1 Task Reports filter by From - To dates', inOct.status === 200 && inNov.status === 200 && inOct.body.range.from === '2026-10-01' && all.body.total >= inOct.body.total && all.body.total >= inNov.body.total && b.t && b.t.id, [inOct.status, inNov.status, inOct.body && inOct.body.total, inNov.body && inNov.body.total, all.body && all.body.total]);
    const bad = await Z.call('GET', '/api/tasks/reports?from=2026-11-30&to=2026-11-01', L);
    Z.check('D2 a To before From is refused in plain words', bad.status === 400, [bad.status, names(bad).slice(0, 100)]);

    // files on a task (mark as done with photos / documents)
    {
      const d = await mkTask('D', '2026-10-02', '2026-10-03');
      const E2 = await Z.call('POST', `/api/tasks/${d.t.id}/complete`, E, { note: 'ZZTEST TSA done' });
      const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082', 'hex');
      const up = async (tok, buf, name, type) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); const r = await fetch(`${Z.API}/api/tasks/${d.t.id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
      const u1 = await up(E, png, 'site-photo.png', 'image/png');
      Z.check('U1 after Mark as done the person uploads a photo', E2.status >= 200 && E2.status < 300 && u1.status === 201 && u1.body.fileName === 'site-photo.png', [E2.status, u1.status, u1.body]);
      const lst = await Z.call('GET', '/api/tasks', L);
      const row = (Array.isArray(lst.body) ? lst.body : []).find((x) => x.id === d.t.id);
      const get = await Z.call('GET', `/api/tasks/${d.t.id}/files/${u1.body.id}`, L);
      Z.check('U2 the lead sees the file on the task and opens it', row && row.files && row.files.length === 1 && get.status === 200 && get.buf.length === png.length, [row && row.files && row.files.length, get.status]);
      const bad = await up(E, Buffer.from('MZ fake exe'), 'virus.exe', 'application/octet-stream');
      Z.check('U3 a file that is not a photo / PDF / Word is refused in plain words', bad.status === 400 && /photos|PDF|Word/.test(bad.body.error || ''), [bad.status, bad.body]);
      const E3 = await Z.mint(emp2);
      const other = await up(E3, png, 'x.png', 'image/png');
      Z.check('U4 somebody not on the task cannot attach files to it', other.status === 403 || other.status === 404, other.status);
    }

    // the cards
    const ins = await Z.call('GET', '/api/insights/timesheet', L);
    const tiles = (ins.body && ins.body.tiles) || [];
    Z.check('H1 every Hours at Work card has a one-line explanation', ins.status === 200 && tiles.length === 6 && tiles.every((t) => t.hint), tiles.map((t) => [t.label, t.hint]));
    // team-wise: a department picked lists its teams; a team narrows to it
    await prisma.employee.updateMany({ where: { userId: emp.id }, data: { team: 'ZZTEST TSA Team A' } });
    await prisma.employee.updateMany({ where: { userId: emp2.id }, data: { team: 'ZZTEST TSA Team B' } });
    const dp = await Z.call('GET', '/api/insights/timesheet?department=R%26D', L);
    const tA = await Z.call('GET', '/api/insights/timesheet?department=R%26D&team=ZZTEST%20TSA%20Team%20A', L);
    const teamChart = (dp.body && dp.body.charts || []).find((c) => c.id === 'ts-team');
    Z.check('H2 picking a department shows its teams (Team A / Team B) and a team narrows to it', dp.status === 200 && (dp.body.teams || []).includes('ZZTEST TSA Team A') && (dp.body.teams || []).includes('ZZTEST TSA Team B') && !!teamChart && tA.status === 200, [dp.status, dp.body && dp.body.teams, !!teamChart, tA.status]);
    const tl = await Z.call('GET', '/api/tasks', L);
    const anyTeam = (Array.isArray(tl.body) ? tl.body : []).some((x) => x.assignee && x.assignee.team);
    Z.check('H3 the task list carries the team of each person (for the Team filter)', tl.status === 200 && anyTeam, tl.status);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    try { await prisma.task.deleteMany({ where: { name: { contains: 'ZZTEST TSA' } } }); } catch (e) { console.log('task cleanup', String(e.message).slice(0, 140)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { reason: { contains: 'ZZTEST TSA' } } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
