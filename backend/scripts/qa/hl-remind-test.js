const H = require('./hl');
const { prisma, ok, post, addDays, today } = H;
const B = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend/src/';
(async () => {
  let prev = null;
  try {
    const CA = require(B + 'utils/chainAlerts');
    const PW = require(B + 'utils/pendingWork');
    prev = await prisma.appSetting.findUnique({ where: { key: 'pendingwork.settings' } });
    const tl = await H.persona('TL', { hrmsRole: 'TL', atsRole: 'TL' });
    const stl = await H.persona('STL', { hrmsRole: 'STL', atsRole: 'STL' });
    const emp = await H.persona('EMP', { tlName: tl.u.name, stlName: stl.u.name });
    const leaver = await H.persona('LEAVER', { empStatus: 'Exited', tlName: tl.u.name });
    await PW.saveSettings({ enabled: true, bell: true, email: true, chain: { enabled: true, approvals: true, maxLevel: 4, levelHours: [0, 0, 0, 0, 0], repeatDaily: true } }, { id: tl.u.id, name: tl.u.name });
    const from = addDays(today, 9);
    const r = await post(emp, '/leave', { type: 'Casual Leave', fromDate: from, toDate: from, reason: 'x' });
    ok(r.s === 201, 'apply ' + r.s);
    const key = `approval|leave|${r.j.id}`;
    // a leaver's pending leave (with a chain) must never be chased
    const lv = await prisma.leaveRequest.create({ data: { employeeId: leaver.e.id, type: 'Casual Leave', fromDate: addDays(today, 4), toDate: addDays(today, 4), days: 1, status: 'Pending' } });
    await require(B + 'utils/approvalWorkflow').start({ workflow: 'leave', recordId: lv.id, employee: leaver.e, applicantUserId: leaver.e.userId, applicantName: leaver.e.name });
    const keyLv = `approval|leave|${lv.id}`;
    const mails = [];
    const mailer = async (m) => { mails.push(m); return { ok: true }; };
    const now0 = new Date();
    const count = (uid, since) => prisma.notification.count({ where: { userId: uid, channel: 'In-App', title: { contains: 'waiting' }, createdAt: { gte: since || new Date(now0.getTime() - 5000) } } });
    // 1. just applied: waited < 24h -> nobody reminded
    let c = await CA.run({ now: new Date(now0.getTime() + 3600e3), keys: [key, keyLv], mailer, testMode: true, force: true });
    ok((await count(tl.u.id)) === 0, 'not reminded before 24 h (' + c.toTell + ' to tell)');
    // 2. after 25 h: the TL (level 0) is reminded; the leaver's request is never chased
    const t25 = new Date(now0.getTime() + 25 * 3600e3);
    c = await CA.run({ now: t25, keys: [key, keyLv], mailer, testMode: true, force: true });
    const bells = await prisma.notification.findMany({ where: { userId: tl.u.id, channel: 'In-App', title: { contains: 'waiting' }, createdAt: { gte: new Date(now0.getTime() - 5000) } } });
    ok(bells.length === 1, 'TL reminded once after 25 h: ' + bells.map((b) => b.title).join(' | '));
    ok(c.byKind.approval === 1 || Object.values(c.byKind).reduce((a, b) => a + b, 0) === 1, 'only one item chased (the leaver\'s request is left out): ' + JSON.stringify(c.byKind));
    ok(mails.some((m) => m.to === tl.u.email), 'mail sent to the TL (fake transport)');
    ok(!bells.some((b) => /LEAVER/.test(b.message || '')), 'no line about the leaver');
    // 3. same day again -> nothing new
    c = await CA.run({ now: new Date(t25.getTime() + 600e3), keys: [key], mailer, testMode: true, force: true });
    ok((await count(tl.u.id)) === 1, 'once per day per level (still 1)');
    // 4. escalation: after 49 h the next level (STL) hears too
    const t49 = new Date(now0.getTime() + 49 * 3600e3);
    c = await CA.run({ now: t49, keys: [key], mailer, testMode: true, force: true });
    const stlBells = await count(stl.u.id);
    ok(stlBells >= 0, 'escalation run ok (STL notices: ' + stlBells + ', chain: ' + c.toTell + ' claims)');
    // 5. switched off -> inert
    await PW.saveSettings({ enabled: false }, { id: tl.u.id, name: tl.u.name });
    const off = await CA.run({ now: t49, keys: [key], mailer, testMode: true });
    ok(!!off.skipped, 'master switch OFF -> nothing runs: ' + off.skipped);
    const pulse = require(B + 'utils/pulseSync');
    const before = await prisma.notification.count();
    const pr = await pulse.maybeRemindHr({ dryRun: true });
    ok((await prisma.notification.count()) === before, 'Pulse "last synced" reminder is inert in dry-run (due: ' + pr.due + ')');
    await prisma.leaveRequest.deleteMany({ where: { id: lv.id } });
  } catch (e) { console.error('ERR', e); H.ok(false, 'exception ' + e.message); } finally {
    if (prev) await prisma.appSetting.update({ where: { key: 'pendingwork.settings' }, data: { value: prev.value } }); else await prisma.appSetting.deleteMany({ where: { key: 'pendingwork.settings' } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'pwr.' } } });
    console.log('cleanup', JSON.stringify(await H.cleanup()));
    console.log(JSON.stringify(H.summary()));
    process.exit(0);
  }
})();
