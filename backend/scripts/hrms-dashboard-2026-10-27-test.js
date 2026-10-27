#!/usr/bin/env node
// ---------------------------------------------------------------------------
// HRMS DASHBOARD + ANNOUNCEMENT PAUSE (founder 2026-10-27). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/hrms-dashboard-2026-10-27-test.js
// Proves: designations count only the people working now (a Status filter counts that status); the Headcount card = the people who have
// not left; Banka Mrudula is a reporting manager; a paused announcement leaves the dashboard, the employees' list and the bell, HR still
// sees it tagged, Resume brings everything back; only HR-side may pause.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('HDB');

(async () => {
  const { prisma } = Z;
  let annId = null;
  try {
    const hr = await Z.mkUser('hr', { role: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'HR Executive', department: 'HR' });
    const emp = await Z.mkUser('emp', { role: 'EMPLOYEE', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsRole: 'NONE', atsAccess: false }, { designation: 'Executive', department: 'R&D' });
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const H = await Z.mint(hr); const E = await Z.mint(emp); const S = await Z.mint(sa);

    // ---- dashboard filters + headcount ----
    const d = await Z.call('GET', '/api/hrms/dashboard', S);
    const o = d.body.filterOptions; const eo = d.body.employeeOverview;
    const working = await prisma.employee.count({ where: { employmentStatus: { notIn: ['Relieved', 'Exited'] } } });
    const sumDesig = Object.values(o.counts.designation).reduce((n, x) => n + x, 0);
    Z.check('D1 designations count only the people working now (no "Employee 325", no Recruiter who left)', d.status === 200 && (o.counts.designation.Employee || 0) < 100 && !o.designations.includes('Recruiter') && sumDesig <= eo.headcount, [o.counts.designation, eo.headcount]);
    const dr = await Z.call('GET', '/api/hrms/dashboard?status=Exit', S);
    Z.check('D2 with Status = Exit (left) the designations count the people who left (the left can still be found)', (dr.body.filterOptions.counts.designation.Employee || 0) > 100, dr.body.filterOptions.counts.designation);
    Z.check('D3 the Headcount card = everybody who has not left; Active + Notice + Exit process + Other add up to it', eo.headcount === eo.active + eo.servingNotice + eo.exitProcess + eo.other && eo.headcount === eo.total - eo.left, eo);
    const hl = await Z.call('GET', '/api/hrms/dashboard/list?tile=headcount', S);
    Z.check('D4 the Headcount card opens its list (same number)', hl.status === 200 && (hl.body.total === eo.headcount || (hl.body.rows || []).length === eo.headcount), [hl.status, hl.body.total]);
    Z.check('D5 Banka Mrudula is in Reporting manager (3 R&D people report to her)', o.managers.some((m) => /Mrudula/.test(m.name) && m.count >= 3), o.managers.map((m) => `${m.name}(${m.count})`));
    void working;

    // ---- pause ----
    const post = await Z.call('POST', '/api/announcements', H, { title: `ZZTEST HDB notice ${Z.RUN}`, body: 'ZZTEST HDB body', category: 'General', date: new Date().toISOString().slice(0, 10), target: 'All Employees', audience: { mode: 'everyone' } });
    annId = post.body && post.body.id;
    const myBell = async () => (await Z.call('GET', '/api/admin/notifications', E)).body;
    const inBell = (rows) => (Array.isArray(rows) ? rows : rows.rows || []).some((n) => String(n.title).includes(`ZZTEST HDB notice ${Z.RUN}`));
    Z.check('P0 HR posts a notice; the employee gets it in the bell and the list', post.status === 201 && inBell(await myBell()), [post.status, post.body && post.body.error]);
    const ep = await Z.call('PUT', `/api/announcements/${annId}/pause`, E, { paused: true });
    Z.check('P1 an employee cannot pause (403)', ep.status === 403, ep.status);
    const p1 = await Z.call('PUT', `/api/announcements/${annId}/pause`, H, { paused: true });
    Z.check('P2 HR pauses it', p1.status === 200 && p1.body.paused === true, p1.body);
    const el = await Z.call('GET', '/api/announcements', E);
    Z.check('P3 paused: not on the employee\'s Announcements list', !el.body.some((a) => a.id === annId), el.body.map((a) => a.title));
    Z.check('P4 paused: not in the employee\'s bell (first page and paged list)', !inBell(await myBell()) && !inBell((await Z.call('GET', '/api/admin/notifications?page=1', E)).body), 'still in the bell');
    const hl2 = await Z.call('GET', '/api/announcements', H);
    Z.check('P5 HR still sees it, tagged Paused', hl2.body.some((a) => a.id === annId && a.paused === true), hl2.body.map((a) => [a.title, a.paused]));
    const dash = await Z.call('GET', '/api/hrms/dashboard', S);
    Z.check('P6 paused: not on the HRMS dashboard', !(dash.body.announcements || []).some((a) => a.id === annId), (dash.body.announcements || []).map((a) => a.title));
    const p2 = await Z.call('PUT', `/api/announcements/${annId}/pause`, H, { paused: false });
    Z.check('P7 Resume: back on the employee\'s list and in the bell', p2.status === 200 && p2.body.paused === false && (await Z.call('GET', '/api/announcements', E)).body.some((a) => a.id === annId) && inBell(await myBell()), p2.body);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      if (annId) {
        const a = await prisma.announcement.findUnique({ where: { id: annId } });
        if (a) await prisma.notification.deleteMany({ where: { title: `Announcement: ${a.title}` } });
        await prisma.announcement.deleteMany({ where: { id: annId } });
      }
    } catch (e) { console.log('cleanup', String(e.message).slice(0, 160)); }
    await Z.cleanup([(p) => p.auditLog.deleteMany({ where: { OR: [{ entityId: annId || '-' }, { toValue: { contains: 'ZZTEST HDB' } }] } })]).catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
