// SANDBOX test: Save & Post lists all boards, by-hand tasks, summary, by-hand done, reminders, queue, list, roles.
const path = require('path');
const { prisma, call, check, fails, sleep } = require('./zp-lib');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const ALL = ['jobportal', 'website', 'naukri', 'shine', 'indeed', 'linkedin'];
const NAMES = 'TeamLink Job Portal, TeamLink Website, Google Jobs, Naukri, Shine, Indeed, LinkedIn';
(async () => {
  const tag = Date.now().toString(36);
  const made = { users: [], reqs: [], clients: [] };
  let indeedBefore;
  try {
    const mk = (d) => prisma.user.create({ data: { passwordHash: 'x-not-a-login', status: 'Active', atsAccess: true, role: 'EMPLOYEE', ...d } }).then((u) => { made.users.push(u.id); return u; });
    // non-ZZTEST names for the people who may be reminded (the sweep skips ZZTEST on purpose); deleted by id below.
    const bde = await mk({ name: `Zpt Poster ${tag}`, email: `zpt-poster-${tag}@zpt.invalid`, atsRole: 'BDE', atsDepartment: 'Medical' });
    const tl = await mk({ name: `Zpt Tl ${tag}`, email: `zpt-tl-${tag}@zpt.invalid`, atsRole: 'TL', atsDepartment: 'Medical' });
    const rec = await mk({ name: `Zpt Rec ${tag}`, email: `zpt-rec-${tag}@zpt.invalid`, atsRole: 'RECRUITER', atsDepartment: 'Medical' });
    const otherBde = await mk({ name: `ZZTEST OtherBde ${tag}`, email: `zz-obde-${tag}@example.test`, atsRole: 'BDE', atsDepartment: 'Education' });
    const acct = await mk({ name: `ZZTEST Acct ${tag}`, email: `zz-acct-${tag}@example.test`, atsRole: 'ACCOUNTANT' });
    const admin = await mk({ name: `ZZTEST Admin ${tag}`, email: `zz-admin-${tag}@example.test`, role: 'ADMIN', atsRole: 'ADMIN' });
    const sa = await mk({ name: `ZZTEST SA ${tag}`, email: `zz-sa-${tag}@example.test`, role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' }); // own ZZTEST Super Admin: the real one may still be on a starting password
    const client = await prisma.client.create({ data: { name: `ZZTEST Client ${tag}`, status: 'Active', agreementStatus: 'ACTIVE', ownerDepartment: 'Medical' } });
    made.clients.push(client.id);
    const mkJob = async (extra) => {
      const j = await prisma.requirement.create({ data: { title: `ZZTEST Job ${tag} ${made.reqs.length}`, clientId: client.id, department: 'Medical', status: 'DRAFT', bdeId: bde.id, reqCode: `ZZT-${tag}-${made.reqs.length}`, ...extra } });
      made.reqs.push(j.id);
      return j;
    };

    // DATA: the copy of the real database may hold a saved usual set (the founder saved one); the test starts from the factory set
    await prisma.appSetting.deleteMany({ where: { key: 'posting.defaultSites' } });
    // 1. the list of sites before saving, per role
    for (const [label, u] of [['BDE', bde], ['Admin', admin], ['Super Admin', sa]]) {
      const r = await call(u.id, 'GET', '/requirements/posting-sources');
      const ids = (r.data.sources || []).map((s) => s.id);
      check(`${label}: all six boards + Google are listed`, r.status === 200 && ALL.every((i) => ids.includes(i)), ids.join(','));
      const byId = Object.fromEntries((r.data.sources || []).map((s) => [s.id, s]));
      check(`${label}: portal/website say "Goes out by itself"`, byId.jobportal.mode === 'auto' && /by itself/.test(byId.jobportal.line) && byId.website.mode === 'auto');
      check(`${label}: Naukri/Shine/LinkedIn/Indeed say "post it by hand"`, ['naukri', 'shine', 'linkedin', 'indeed'].every((i) => byId[i].mode === 'hand' && /by hand: we prepare the text/.test(byId[i].line)), ['naukri', 'shine', 'linkedin', 'indeed'].map((i) => byId[i].mode));
      check(`${label}: all six ticked by default`, ALL.every((i) => byId[i].isDefault));
      check(`${label}: reason + who to ask on a by-hand board`, byId.naukri.why && byId.naukri.ask && byId.naukri.ask.who, byId.naukri.ask);
      check(`${label}: Connect card link only for people who can set it up`, label === 'Super Admin' ? !!byId.naukri.cardLink : (!byId.naukri.cardLink && byId.naukri.askAdmin), byId.naukri.cardLink);
    }
    // 2. the usual set (Admin only)
    const d0 = await call(bde.id, 'GET', '/requirements/posting/defaults');
    check('BDE reads the usual set, cannot change it', d0.status === 200 && d0.data.canEdit === false && d0.data.ids.length === 7, d0.data);
    const dput = await call(bde.id, 'PUT', '/requirements/posting/defaults', { sites: ['jobportal'] });
    check('BDE cannot change the usual set (403)', dput.status === 403, dput.data);
    const a1 = await call(admin.id, 'PUT', '/requirements/posting/defaults', { sites: ['jobportal', 'website', 'naukri'] });
    const a2 = await call(bde.id, 'GET', '/requirements/posting-sources');
    const defIds = (a2.data.sources || []).filter((s) => s.isDefault).map((s) => s.id).sort().join();
    check('Admin changes the usual set; the form follows', a1.status === 200 && defIds === 'jobportal,naukri,website', defIds);
    await prisma.appSetting.deleteMany({ where: { key: 'posting.defaultSites' } });
    const a3 = await call(admin.id, 'GET', '/requirements/posting/defaults');
    check('Setting removed again: back to the six + Google', a3.data.ids.length === 7 && !a3.data.custom);

    // 3. Save & Post of a draft with everything ticked (what the BDE does)
    const job = await mkJob({ postingSources: NAMES, tlId: tl.id, recruiterId: rec.id });
    const act = await call(bde.id, 'POST', `/requirements/${job.id}/activate`, {});
    check('BDE opens the draft (Save & Post)', act.status === 200 && ['OPEN', 'RECRUITER_ASSIGNED'].includes(act.data.status), act.data.status || act.data);
    await sleep(2500);
    let ps = await call(bde.id, 'GET', `/requirements/${job.id}/posting-sites`);
    const by = () => Object.fromEntries(ps.data.sites.map((s) => [s.id, s]));
    const FOUR = ['naukri', 'shine', 'indeed', 'linkedin'];
    check('Four boards show "Waiting for you to post (by hand)"', FOUR.every((i) => by()[i].code === 'WAITING_BY_HAND' && /Waiting for you to post/.test(by()[i].label)), FOUR.map((i) => by()[i].code));
    check('By-hand boards are NEVER shown Posted', FOUR.every((i) => by()[i].code !== 'POSTED' && by()[i].tone === 'orange'));
    const rows = await prisma.requirementPosting.findMany({ where: { requirementId: job.id } });
    check('A task row exists per board (created at once)', FOUR.every((i) => rows.some((r) => r.source === i && /Required/.test(r.status))), rows.map((r) => `${r.source}:${r.status}`).join(' '));
    check('Summary line lists the four boards', /you must post by hand: Naukri, Shine, Indeed, LinkedIn\./.test(ps.data.summary.line) && ps.data.summary.waitingHand.length === 4, ps.data.summary.line);
    check('Reason + who to ask travel with the row', by().naukri.why && by().naukri.ask && by().naukri.hand.openUrl, by().naukri.hand);
    const audit = await prisma.auditLog.findFirst({ where: { entity: 'RequirementPosting', entityId: job.id, action: 'Waiting to post by hand', userId: bde.id } });
    check('Audit names who pressed Save & Post', !!audit, audit && audit.fromValue);

    // 4. the by-hand helper: text generated automatically, gaps listed, link check, "I posted it"
    const hp = await call(bde.id, 'GET', `/requirements/${job.id}/posting-sites/naukri/by-hand`);
    check('Helper has job text without being saved first', hp.status === 200 && hp.data.text && hp.data.text.length > 20 && hp.data.openUrl, hp.data.text && hp.data.text.slice(0, 60));
    check('Helper lists the [ ] gaps', hp.data.gapMarks > 0 ? (hp.data.gaps && hp.data.gaps.length > 0) : hp.data.gaps.length === 0, { marks: hp.data.gapMarks, gaps: hp.data.gaps });
    const bad = await call(bde.id, 'POST', `/requirements/${job.id}/posting-sites/naukri/by-hand/done`, { url: 'https://example.com/x' });
    check('A link from the wrong site is refused', bad.status === 400, bad.data.error);
    const dn = await call(bde.id, 'POST', `/requirements/${job.id}/posting-sites/naukri/by-hand/done`, { url: 'https://www.naukri.com/job-listings-zzt-123' });
    ps = dn;
    check('"I posted it": Posted (by hand) with who/when/link', dn.status === 200 && by().naukri.code === 'POSTED_BY_HAND' && /Posted \(by hand\)/.test(by().naukri.label) && /Zpt Poster/.test(by().naukri.hand.by) && by().naukri.hand.url, by().naukri.label);
    check('It counts in the summary', /posted \(.*1 by hand: Naukri\)/.test(ps.data.summary.line) && ps.data.summary.waitingHand.length === 3, ps.data.summary.line);
    check('Other three still wait', ['shine', 'indeed', 'linkedin'].every((i) => by()[i].code === 'WAITING_BY_HAND'));
    for (const b of ['shine', 'indeed', 'linkedin']) ps = await call(bde.id, 'POST', `/requirements/${job.id}/posting-sites/${b}/by-hand/done`, { url: '' });
    check('All four by hand done: count reaches the ticked total', ps.data.summary.waitingHand.length === 0 && ps.data.summary.posted >= 4, ps.data.summary.line);
    await call(bde.id, 'POST', `/requirements/${job.id}/posting-sites/shine/by-hand/undo`, {});
    const sh = (await call(bde.id, 'GET', `/requirements/${job.id}/posting-sites`)).data.sites.find((s) => s.id === 'shine');
    check('Undo puts Shine back to waiting', sh.code === 'WAITING_BY_HAND', sh.code);

    // 5. a second job: reminders + queue + list
    const job2 = await mkJob({ postingSources: 'TeamLink Job Portal, TeamLink Website, Naukri, Shine', tlId: tl.id, recruiterId: rec.id });
    const act2 = await call(bde.id, 'POST', `/requirements/${job2.id}/activate`, { duplicateOverride: true, duplicateReason: 'ZZTEST second job on the same client on purpose' }); if (act2.status !== 200) console.log('  note: job2 activate ->', act2.status, JSON.stringify(act2.data).slice(0, 200));
    await sleep(2500);
    const q = await call(bde.id, 'POST', '/requirements/posting/hand-queue', { ids: [job.id, job2.id] });
    check('Hand queue: (job, board) pairs for the BDE', q.status === 200 && q.data.pairs.length === 3 && q.data.pairs.some((p) => p.requirementId === job2.id && p.board === 'naukri'), q.data.perBoard);
    const qo = await call(otherBde.id, 'POST', '/requirements/posting/hand-queue', { ids: [job.id, job2.id] });
    check("Another desk's BDE sees none of them", qo.status === 200 && qo.data.pairs.length === 0, qo.data);
    const lst = await call(bde.id, 'GET', '/requirements?page=1&pageSize=50');
    const row2 = (lst.data.rows || []).find((r) => r.id === job2.id);
    check('Jobs list row: "Posted on N/M sites" + waiting text', row2 && row2.posting && /(Posted on \d\/4 sites|Not posted anywhere yet)/.test(row2.posting.text) && /2 waiting for you to post by hand/.test(row2.posting.waitText), row2 && row2.posting);
    check('Jobs list counts.postWait', lst.data.counts && lst.data.counts.postWait >= 2, lst.data.counts && lst.data.counts.postWait);
    const fl = await call(bde.id, 'GET', '/requirements?page=1&pageSize=50&postWait=1');
    check('Filter postWait=1 keeps only waiting requirements', fl.status === 200 && fl.data.rows.length >= 2 && fl.data.rows.every((r) => r.posting && r.posting.waitingHand > 0), fl.data.rows.map((r) => r.reqCode));

    // reminders: back-date the tasks past 6 h, run the sweep twice
    await prisma.requirementPosting.updateMany({ where: { requirementId: job2.id }, data: { createdAt: new Date(Date.now() - 8 * 3600000) } });
    const manual = require(path.join(BACK, 'src/utils/jobBoards/manual'));
    const s1 = await manual.sweep();
    const note = (uid) => prisma.notification.count({ where: { userId: uid, title: { contains: job2.reqCode }, NOT: { title: { startsWith: 'New requirement' } } } });
    const [nB, nT, nR] = [await note(bde.id), await note(tl.id), await note(rec.id)];
    check('Sweep reminds the poster, the TL and the recruiter (one message for both boards)', nB === 1 && nT === 1 && nR === 1 && s1.reminded >= 2, { nB, nT, nR, s1 });
    const nm = await prisma.notification.findFirst({ where: { userId: tl.id, title: { contains: 'waiting to be posted' } } });
    check('Message names the boards, in plain words', nm && /Naukri, Shine/.test(nm.title) && /Post by hand/.test(nm.message), nm && nm.title);
    const s2 = await manual.sweep();
    check('Second sweep the same day: no repeat', (await note(bde.id)) === 1, s2);

    // 6. Indeed in feed mode: "In our Indeed feed", never Posted, not waiting-by-hand
    indeedBefore = await prisma.integration.findUnique({ where: { id: 'indeed' } });
    const vals = JSON.stringify({ 'Posting method (Job Sync API / XML feed)': 'XML feed', 'Contact email for Indeed': 'zpt@zpt.invalid' });
    await prisma.integration.upsert({ where: { id: 'indeed' }, create: { id: 'indeed', values: vals, connected: true, enabled: true }, update: { values: vals, connected: true, enabled: true } });
    const pc = await call(bde.id, 'GET', '/requirements/posting-sources');
    const ind = pc.data.sources.find((s) => s.id === 'indeed');
    check('Indeed feed mode: line says feed, not by hand', ind.mode === 'feed' && /feed/.test(ind.line), ind.line);
    await call(bde.id, 'PUT', `/requirements/${job2.id}/posting-sites`, { sites: ['jobportal', 'website', 'naukri', 'shine', 'indeed'] });
    await sleep(3500);
    const ps2 = await call(bde.id, 'GET', `/requirements/${job2.id}/posting-sites`);
    const ind2 = ps2.data.sites.find((s) => s.id === 'indeed');
    check('Indeed row: "In our Indeed feed", not Posted', ind2.code === 'IN_FEED' && /In our Indeed feed/.test(ind2.label), { code: ind2.code, label: ind2.label, reason: ind2.reason });
    check('Summary: waiting on the site, not posted', /sent and waiting for the site to show it: Indeed/.test(ps2.data.summary.line) && !/Indeed.*posted automatically/.test(ps2.data.summary.line), ps2.data.summary.line);
    const lst2 = await call(bde.id, 'GET', '/requirements?page=1&pageSize=50');
    const r2 = lst2.data.rows.find((r) => r.id === job2.id);
    check('Feed row is not counted as posted in the list', r2.posting && !/Posted on 5\//.test(r2.posting.text), r2.posting);
    await prisma.integration.update({ where: { id: 'indeed' }, data: { values: indeedBefore ? indeedBefore.values : null, connected: indeedBefore ? indeedBefore.connected : false, enabled: indeedBefore ? indeedBefore.enabled : false } }).catch(() => {});
    indeedBefore = undefined;

    // 7. roles on the posting routes
    const roleCheck = async (label, u) => {
      const put = await call(u.id, 'PUT', `/requirements/${job2.id}/posting-sites`, { sites: ['jobportal', 'website', 'naukri', 'shine', 'indeed'] });
      const done = await call(u.id, 'POST', `/requirements/${job2.id}/posting-sites/shine/by-hand/done`, { url: '' });
      console.log(`  info  ${label}: PUT ${put.status}, by-hand done ${done.status}`);
      return { put: put.status, done: done.status };
    };
    const rb = await roleCheck('BDE (own job)', bde); check('BDE posts own client job', rb.put === 200 && rb.done === 200, rb);
    await call(bde.id, 'POST', `/requirements/${job2.id}/posting-sites/shine/by-hand/undo`, {});
    const ra = await roleCheck('Admin', admin); check('Admin allowed', ra.put === 200 && ra.done === 200, ra);
    await call(admin.id, 'POST', `/requirements/${job2.id}/posting-sites/shine/by-hand/undo`, {});
    const ro = await roleCheck('Other desk BDE', otherBde); check('Other desk BDE refused', ro.put === 403 && ro.done === 403, ro);
    const rc = await roleCheck('Accounts', acct); check('Accounts refused', rc.put === 403 && rc.done === 403, rc);
    console.log('  note: Recruiter on the job ->', JSON.stringify(await roleCheck('Recruiter on the job', rec)));
    console.log('  note: TL on the job ->', JSON.stringify(await roleCheck('TL on the job', tl)));
    const tl2 = await prisma.user.create({ data: { name: `Zpt Tl2 ${tag}`, email: `zpt-tl2-${tag}@zpt.invalid`, passwordHash: 'x', status: 'Active', atsAccess: true, role: 'EMPLOYEE', atsRole: 'TL', atsDepartment: 'Medical' } }); made.users.push(tl2.id);
    const rec2 = await prisma.user.create({ data: { name: `Zpt Rec2 ${tag}`, email: `zpt-rec2-${tag}@zpt.invalid`, passwordHash: 'x', status: 'Active', atsAccess: true, role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical' } }); made.users.push(rec2.id);
    const rt = await roleCheck('TL NOT on the job', tl2); check('TL not on the job refused', rt.put === 403 && rt.done === 403, rt);
    const rr2 = await roleCheck('Recruiter NOT on the job', rec2); check('Recruiter not on the job refused', rr2.put === 403 && rr2.done === 403, rr2);
    const qa = await call(acct.id, 'POST', '/requirements/posting/hand-queue', {});
    check('Accounts: queue empty', qa.status === 200 && qa.data.pairs.length === 0, qa.data.total);
  } catch (e) { console.error('TEST ERROR', e); process.exitCode = 1; } finally {
    if (indeedBefore !== undefined) await prisma.integration.update({ where: { id: 'indeed' }, data: { values: indeedBefore ? indeedBefore.values : null, connected: indeedBefore ? indeedBefore.connected : false, enabled: indeedBefore ? indeedBefore.enabled : false } }).catch(() => {});
    await prisma.appSetting.deleteMany({ where: { key: { in: ['posting.defaultSites'] } } });
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'posting.handReminded.' } } });
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: `ZZT-${tag}` } }] } });
    await prisma.requirementPosting.deleteMany({ where: { requirementId: { in: made.reqs } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: made.reqs } }] } });
    await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
    await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    const left = await prisma.requirement.count({ where: { title: { contains: tag } } });
    console.log(`\nfailures: ${fails()}  left-over jobs: ${left}`);
    await prisma.$disconnect();
  }
})();
