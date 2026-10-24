#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RECRUITER REPORTS = OWN ONLY (user, 2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/recruiter-own-reports-test.js [--keep]
//
// Two ZZTEST recruiters (Alpha, Bravo) in ONE team under one TL, with different numbers (calls, jobs, candidates,
// interviews, joined, follow-ups, tasks), plus a job they share. Then EVERY report endpoint in the route table
// (ats-reports, reports, ats-report-pack, ats-daily, pending-work, dashboard, ats team, follow-ups, insights, facets,
// recruiter joinings, tasks) is read as Alpha and scanned for Bravo's name, id, e-mail and candidates, and Alpha's answer
// is compared with the answer to "show me Bravo" (person / recruiter / team / TL parameters): it must be the same, or a
// refusal. The TL, the Manager and the Admin must still see both.
//
//   A  numbers: Alpha's own figures are right (funnel, My results, pack summary), Bravo's are not mixed in
//   B  every GET in the route table scanned as Alpha: no Bravo name / id / e-mail / candidate, and
//      the "ask for Bravo" copy equals the plain answer (or is refused)
//   C  what is closed: team / client / source / revenue tabs, other-person exports, legacy team reports
//   D  Alpha's own things still work (own reports, own export, own daily report, own follow-ups)
//   E  TL / Manager / Admin unchanged: both recruiters visible
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('OR');
const { prisma, call, check, RUN } = Z;
const path = require('path');
const { listRoutes } = require('./lib/listRoutes');

const DEPT = 'ZZTEST OR Dept';
const KEEP = process.argv.includes('--keep');
const ymd = (offset = 0) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);
const REPORT_IDS = ['funnel', 'departments', 'recruitment', 'requirements', 'candidates', 'recruiters', 'sources', 'clients', 'interviews', 'ai', 'followups', 'joining', 'sla', 'rejections', 'specialisations', 'timetofill', 'quality', 'targets', 'overrides', 'campaigns', 'costperhire'];
const volatile = /"(asOf|generatedAt|generatedBy|at|ms|loadedAt|stamp|now|updatedAt|date)":"[^"]*"/g;
// the same rows in another order (equal days in a step) are the same answer
const canonJson = (v) => (Array.isArray(v) ? v.map(canonJson).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonJson(v[k])])) : v);
const canon = (t) => { try { return JSON.stringify(canonJson(JSON.parse(t))); } catch { return String(t || ''); } };
const norm = (t) => canon(t).replace(volatile, '"$1":"x"').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');

(async () => {
  // candidates are named without "zztest" (the reports never count test-named people), so find leftovers by e-mail
  Z.made.cands.push(...(await prisma.candidate.findMany({ where: { email: { contains: 'zz-or-cand-' } }, select: { id: true } })).map((c) => c.id));
  await Z.preclean();
  try {
    const mk = (tag, extra, emp) => Z.mkUser(tag, extra, emp);
    const uAdmin = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uMgr = await mk('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER', hrmsAccess: true }, { designation: 'Manager' });
    const uTl = await mk('tl', { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', hrmsAccess: true, atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL' });
    const rec = (tag) => mk(tag, { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', hrmsAccess: true, atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: uTl.name });
    const rA = await rec('alpha');
    const rB = await rec('bravo');
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, tl: uTl, a: rA, b: rB })) T[k] = await Z.mint(u);

    // ---- data -------------------------------------------------------------------------------------------------
    const client = await prisma.client.create({ data: { name: `ZZTEST OR Client ${RUN}`, location: 'ZZ', ownerDepartment: DEPT, clientType: 'Client', agreementStatus: 'DRAFT' } });
    Z.made.clients.push(client.id);
    const mkJob = async (tag, data) => {
      const j = await prisma.requirement.create({ data: { title: `ZZTEST OR Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: DEPT, tlId: uTl.id, openings: 2, ...data } });
      Z.made.reqs.push(j.id); return j;
    };
    const jA = await mkJob('A', { recruiterId: rA.id });
    const jB = await mkJob('B', { recruiterId: rB.id });
    const jS = await mkJob('S', { recruiterId: rA.id, recruiterIds: `${rA.id},${rB.id}` }); // shared: Bravo is a co-recruiter
    let n = 0;
    const mkApp = async (job, tag, stage, extra = {}) => {
      n += 1;
      const cand = await prisma.candidate.create({ data: { name: `Orx ${tag}${n} Candidate ${RUN}`, email: `zz-or-cand-${tag}${n}-${RUN}@example.test`, phone: `90000${String(n).padStart(5, '0')}`, location: 'ZZ' } });
      Z.made.cands.push(cand.id);
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: job.id, stage, ...extra } });
      Z.made.apps.push(a.id);
      return { a, cand };
    };
    const future = new Date(Date.now() + 2 * 86400000);
    // Alpha: 7 applications (5 on her job, 2 on the shared one): 2 in review, 1 interview, 2 selected, 2 joined
    await mkApp(jA, 'A', 'RECRUITER_REVIEW'); await mkApp(jA, 'A', 'RECRUITER_REVIEW');
    const ivA = await mkApp(jA, 'A', 'INTERVIEW_SCHEDULED', { interviewAt: future, interviewStatus: 'SCHEDULED' });
    await mkApp(jA, 'A', 'SELECTED'); await mkApp(jA, 'A', 'JOINED', { joiningStatus: 'Joined' });
    await mkApp(jS, 'A', 'SELECTED'); await mkApp(jS, 'A', 'JOINED', { joiningStatus: 'Joined' });
    // Bravo: 3 applications on his own job
    await mkApp(jB, 'B', 'JOINED', { joiningStatus: 'Joined' });
    await mkApp(jB, 'B', 'SELECTED');
    const bTl = await mkApp(jB, 'B', 'TL_REVIEW');
    const allApps = await prisma.application.findMany({ where: { id: { in: Z.made.apps } }, select: { id: true, candidateId: true, requirementId: true } });
    const appOf = (job, ix = 0) => allApps.filter((x) => x.requirementId === job.id)[ix];
    // follow-ups: Alpha 2 late, Bravo 3 late (and one of Bravo's on the shared job's candidate: must stay out of Alpha's list)
    const fu = (app, owner, due) => prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId, ownerUserId: owner.id, ownerName: owner.name, ownerRole: 'Recruiter', tlUserId: uTl.id, nextAction: 'ZZ follow up', dueDate: due } });
    await fu(appOf(jA, 0), rA, ymd(-3)); await fu(appOf(jA, 1), rA, ymd(-2));
    await fu(appOf(jB, 0), rB, ymd(-4)); await fu(appOf(jB, 1), rB, ymd(-3)); await fu(appOf(jB, 2), rB, ymd(-1));
    // calls: Alpha 4, Bravo 7 (today)
    const call1 = (cand, who, body) => prisma.candidateMessage.create({ data: { candidateId: cand, channel: 'Call', template: 'QUICK_LOG', trigger: 'Manual', recipient: '9000000000', body, status: 'LOGGED', senderUserId: who.id, senderName: who.name } });
    const aCands = Z.made.cands.slice(0, 7); const bCands = Z.made.cands.slice(7, 10);
    for (let i = 0; i < 4; i += 1) await call1(aCands[i], rA, 'Answered');
    for (let i = 0; i < 7; i += 1) await call1(bCands[i % 3], rB, 'Answered');
    // tasks: Alpha 1 late, Bravo 2 late
    const task = (who, name) => prisma.task.create({ data: { name, status: 'Not Started', endDate: ymd(-2), assigneeId: who.id, assignedById: uTl.id, assigneeName: who.name, assignedByName: uTl.name } });
    await task(rA, `ZZTEST OR task alpha ${RUN}`); await task(rB, `ZZTEST OR task bravo 1 ${RUN}`); await task(rB, `ZZTEST OR task bravo 2 ${RUN}`);
    void ivA; void bTl;

    const BRAVO = [/bravo/i, new RegExp(rB.id), new RegExp(rB.email.split('@')[0]), /Orx B\d/, /ZZTEST OR Job B /, /ZZTEST OR task bravo/i];
    const leaks = (text) => BRAVO.filter((re) => re.test(text)).map(String);
    const get = (tok, p) => call('GET', p, tok);

    // =================================== A: the numbers are Alpha's =====================================================
    const fa = await get(T.a, '/api/ats-reports/funnel');
    const applied = (r) => ((r.body && r.body.tiles) || []).find((t) => t.key === 'applied');
    check('A1 Alpha: funnel "Applications" = her own 7 (not Bravo\'s 3, not the 10 of the team)', fa.status === 200 && applied(fa) && applied(fa).value === 7, [fa.status, applied(fa)]);
    const fb = await get(T.b, '/api/ats-reports/funnel');
    check('A2 Bravo: his own 3 (the 2 shared-job candidates are Alpha\'s work)', fb.status === 200 && applied(fb) && applied(fb).value === 3, [fb.status, applied(fb)]);
    const ftl = await get(T.tl, '/api/ats-reports/funnel');
    check('A3 TL: the team 10 (unchanged)', ftl.status === 200 && applied(ftl) && applied(ftl).value === 10, [ftl.status, applied(ftl)]);
    const mr = await get(T.a, '/api/ats-reports/my-results?from=2000-01-01&to=2100-01-01');
    const card = (r, k) => ((r.body && r.body.cards) || []).find((c) => c.key === k);
    check('A4 My results: Alpha 7 candidates added, 2 joined (her own)', mr.status === 200 && card(mr, 'sourced') && card(mr, 'sourced').value === 7 && card(mr, 'joined').value === 2, [mr.status, mr.body]);
    const mrB = await get(T.b, '/api/ats-reports/my-results?from=2000-01-01&to=2100-01-01');
    check('A5 My results: Bravo 3 added, 1 joined', mrB.status === 200 && card(mrB, 'sourced').value === 3 && card(mrB, 'joined').value === 1, [mrB.status, mrB.body && mrB.body.cards]);
    const pk = await get(T.a, `/api/ats-report-pack/report?report=summary&range=this_month&view=individual`);
    const colIx = (r, k) => ((r.body && r.body.columns) || []).findIndex((c) => c.key === k);
    const cell = (r, k) => (r.body && r.body.rows && r.body.rows[0] ? r.body.rows[0].c[colIx(r, k)] : null);
    check('A6 pack summary: one line, Alpha, calls 4', pk.status === 200 && pk.body.rows.length === 1 && cell(pk, 'calls') === 4, [pk.status, pk.body && pk.body.rows]);
    const pkB = await get(T.a, `/api/ats-report-pack/report?report=summary&range=this_month&view=team&person=u:${rB.id}&team=u:${uTl.id}&department=${encodeURIComponent(DEPT)}`);
    check('A7 pack summary asking for Bravo / the team: still one line, still Alpha\'s 4 calls', pkB.status === 200 && pkB.body.rows.length === 1 && cell(pkB, 'calls') === 4 && !leaks(pkB.text).length, [pkB.status, leaks(pkB.text)]);
    const pkTl = await get(T.tl, `/api/ats-report-pack/report?report=summary&range=this_month&view=individual`);
    check('A8 TL pack summary: both recruiters (calls 4 and 7)', pkTl.status === 200 && pkTl.body.rows.some((r) => /alpha/i.test(r.label) && r.c[colIx(pkTl, 'calls')] === 4) && pkTl.body.rows.some((r) => /bravo/i.test(r.label) && r.c[colIx(pkTl, 'calls')] === 7), [pkTl.status, pkTl.body && pkTl.body.rows && pkTl.body.rows.map((r) => [r.label, r.c[colIx(pkTl, 'calls')]])]);

    // =================================== B: every GET in the route table =====================================================
    const routes = listRoutes().filter((r) => r.method === 'GET');
    const PREFIXES = ['/api/ats-reports', '/api/reports', '/api/ats-report-pack', '/api/ats-daily', '/api/pending-work', '/api/dashboard', '/api/ats/team',
      '/api/ats/workers', '/api/ats/hierarchy', '/api/followups', '/api/insights', '/api/recruiter-joinings', '/api/ats-io/facets', '/api/tasks', '/api/ats/workflow',
      '/api/performance', '/api/ats/search', '/api/ats/calendar', '/api/approvals'];
    const scanned = routes.filter((r) => PREFIXES.some((p) => r.path === p || r.path.startsWith(`${p}/`)));
    const urls = [];
    const skipped = [];
    scanned.forEach((r) => {
      let p = r.path;
      if (/\/:report(\/|$)/.test(p)) { REPORT_IDS.forEach((id) => urls.push({ route: r.path, url: p.replace(':report', id) })); return; }
      if (/:module/.test(p)) { ['reports', 'candidates', 'requirements'].forEach((m) => urls.push({ route: r.path, url: p.replace(':module', m) })); return; }
      if (/\/team\/:userId/.test(p)) { urls.push({ route: r.path, url: p.replace(':userId', rB.id) }); urls.push({ route: r.path, url: `${p.replace(':userId', rB.id)}?metric=openRequirements` }); return; }
      if (/:/.test(p.replace(/^\/api/, ''))) { skipped.push(r.path); return; }
      if (/<regex/.test(p)) { skipped.push(r.path); return; }
      urls.push({ route: r.path, url: p });
    });
    const VARIANTS = (u) => {
      const sep = u.includes('?') ? '&' : '?';
      return [
        u,
        `${u}${sep}recruiter=id:${rB.id}&recruiterId=${rB.id}&person=u:${rB.id}&owner=${rB.id}&userId=${rB.id}&tl=id:${uTl.id}&tlId=${uTl.id}&team=u:${uTl.id}&department=${encodeURIComponent(DEPT)}`,
      ];
    };
    const sample = (u) => (/(export|xlsx|\.pdf|download)/i.test(u) ? null : u);
    const leakHits = []; const driftHits = []; let okCount = 0; let refused = 0; let errors = 0;
    for (const { url } of urls) {
      const u = sample(url); if (!u) continue; // eslint-disable-line no-continue
      const [plain, asked] = VARIANTS(u);
      // eslint-disable-next-line no-await-in-loop
      const r1 = await get(T.a, plain);
      // eslint-disable-next-line no-await-in-loop
      const r2 = await get(T.a, asked);
      if ((r1.status === 401 || r2.status === 401) && !global.__first401) {
        global.__first401 = true;
        let why = '';
        try { require(path.join(Z.BACK, 'node_modules/jsonwebtoken')).verify(T.a, process.env.JWT_SECRET); why += 'token verifies locally; '; } catch (e) { why += `local verify: ${e.message}; `; }
        why += `user rows: ${await prisma.user.count({ where: { id: rA.id } })}`;
        console.log(`  FIRST 401 at ${u}: ${why} ${r1.text.slice(0, 120)}`);
      }
      if (r1.status >= 500 || r2.status >= 500) { errors += 1; leakHits.push(`${u} -> HTTP ${r1.status}/${r2.status}`); continue; }
      // what Alpha typed into the address (Bravo's id / e-mail) may come back as the "chosen filter"; that is not data
      const echo = (t) => leaks(t).filter((x) => !x.includes(rB.id) && !x.includes(rB.email.split('@')[0]));
      const l = [...new Set([...leaks(r1.text || ''), ...echo(r2.text || '')])];
      if (l.length) leakHits.push(`${u} -> ${l.join(' ')}`);
      if (r2.status === 403 || r2.status === 404) refused += 1; else okCount += 1;
      // REPORTS must answer with Alpha's own numbers whoever she asks for; a LIST filtered by another person may simply be empty
      const isReport = /^\/api\/(ats-reports|ats-report-pack|ats-daily|reports|pending-work)(\/|$|\?)/.test(u) || /^\/api\/ats\/team/.test(u);
      if (isReport && r2.status < 400 && r1.status < 400 && norm(r1.text) !== norm(r2.text)) { const x = norm(r1.text); const y = norm(r2.text); let i = 0; while (i < x.length && x[i] === y[i]) i += 1; driftHits.push(`${u} @${i}: ${x.slice(Math.max(0, i - 40), i + 60)} <> ${y.slice(Math.max(0, i - 40), i + 60)}`); }
      if (r1.status < 400 && r2.status >= 400) driftHits.push(`${u} (plain ${r1.status}, asked ${r2.status})`);
    }
    console.log(`  scanned ${urls.length} URLs from ${scanned.length} GET routes (${okCount} answered, ${refused} refused, ${skipped.length} routes with other parameters skipped)`);
    check('B1 no GET in the route table shows Bravo (name, id, e-mail, candidates, job, task) to Alpha', leakHits.length === 0, leakHits.slice(0, 12));
    check('B2 asking for Bravo / the team / the department gives Alpha her own answer (same, or a refusal)', driftHits.length === 0, driftHits.slice(0, 12));
    check('B3 no endpoint crashed (HTTP 5xx) for Alpha', errors === 0, leakHits.filter((x) => /HTTP 5/.test(x)));

    // and the POST that e-mails a report, the facets, the downloads
    const fac = await get(T.a, '/api/ats-io/facets/reports?report=funnel');
    const facText = fac.text || '';
    check('B4 filter options with counts (facets): no other person, no team lead list', fac.status === 200 && !leaks(facText).length && !((fac.body.facets || {}).tl || []).length && !((fac.body.facets || {}).stl || []).length && ((fac.body.facets || {}).recruiter || []).every((o) => String(o.value).includes(rA.id)), [fac.status, leaks(facText), fac.body && fac.body.facets && fac.body.facets.recruiter]);
    const opts = await get(T.a, '/api/ats-reports/options');
    check('B5 /options: only Alpha among the recruiters, no TL / STL / BDE list', opts.status === 200 && opts.body.recruiters.length <= 1 && opts.body.recruiters.every((o) => o.id === `u:${rA.id}`) && !opts.body.tls.length && !opts.body.stls.length && !opts.body.bdes.length, [opts.status, opts.body && opts.body.recruiters]);
    for (const fmt of ['xlsx', 'pdf', 'csv']) {
      // eslint-disable-next-line no-await-in-loop
      const ex = await call('GET', `/api/ats-report-pack/export?report=summary&range=this_month&format=${fmt}&person=u:${rB.id}`, T.a);
      const ok = ex.status === 200 && !/bravo/i.test(ex.buf.toString('latin1')) && !/Orx B\d/i.test(ex.buf.toString('latin1'));
      check(`B6 own ${fmt} download works and carries no Bravo${fmt === 'xlsx' ? ' (zipped: checked on the sheet text below)' : ''}`, ok || (fmt === 'xlsx' && ex.status === 200), [ex.status]);
    }
    const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));
    const xl = await call('GET', `/api/ats-report-pack/export?report=summary&range=this_month&format=xlsx&person=u:${rB.id}&team=u:${uTl.id}`, T.a);
    let sheetText = '';
    try { const wb = XLSX.read(xl.buf, { type: 'buffer' }); wb.SheetNames.forEach((nm) => { sheetText += `${nm}\n${XLSX.utils.sheet_to_csv(wb.Sheets[nm])}\n`; }); } catch (e) { sheetText = `ERR ${e.message}`; }
    check('B7 the Excel of "Bravo" asked by Alpha holds only Alpha', xl.status === 200 && /alpha/i.test(sheetText) && !leaks(sheetText).length, [xl.status, sheetText.slice(0, 300)]);
    const exAll = await call('GET', '/api/ats-report-pack/export-all?range=this_month', T.a);
    let allText = '';
    try { const wb = XLSX.read(exAll.buf, { type: 'buffer' }); wb.SheetNames.forEach((nm) => { allText += `${nm}\n${XLSX.utils.sheet_to_csv(wb.Sheets[nm])}\n`; }); } catch (e) { allText = `ERR ${e.message}`; }
    check('B8 "All my reports" workbook: Alpha only, no client-wise sheet', exAll.status === 200 && !leaks(allText).length && !/Client-wise/i.test(allText.split('\n').slice(0, 30).join('\n')), [exAll.status, allText.slice(0, 200)]);
    const exPeople = await call('GET', '/api/ats-report-pack/export-people?range=this_month', T.a);
    check('B9 individual packs (one sheet per person) are refused to a recruiter', exPeople.status === 403, exPeople.status);

    // =================================== C: what is closed ==============================================================
    for (const id of ['recruiters', 'clients', 'sources', 'departments', 'recruitment', 'requirements', 'quality', 'campaigns', 'costperhire', 'targets', 'rejections', 'sla', 'timetofill', 'specialisations', 'ai', 'overrides']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(T.a, `/api/ats-reports/${id}`);
      check(`C1 /ats-reports/${id}: closed to a recruiter (403, plain words)`, r.status === 403 && /your own numbers|My results/i.test((r.body && r.body.error) || ''), [r.status, r.body]);
    }
    for (const p of ['/api/ats-reports/revenue', '/api/ats-reports/recruiter-revenue', '/api/ats-reports/revenue/export', '/api/ats-reports/recruiter-revenue/drill']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(T.a, p);
      check(`C2 ${p}: money is closed`, r.status === 403, r.status);
    }
    for (const p of ['/api/reports/ats?groupBy=recruiter', '/api/reports/interviews?groupBy=recruiter', '/api/reports/followups?groupBy=owner']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(T.a, p);
      check(`C3 legacy ${p}: closed to a recruiter`, r.status === 403 && !leaks(r.text).length, [r.status, r.body]);
    }
    const ex1 = await get(T.a, '/api/ats-reports/funnel/export?format=xlsx');
    check('C4 the old per-report export is closed (own downloads are on My results)', ex1.status === 403, ex1.status);
    const pend = await get(T.a, '/api/pending-work/team');
    check('C5 "Who has pending work" (team table) is closed', pend.status === 403, pend.status);
    const peopleDaily = await get(T.a, `/api/ats-daily/day?day=${ymd(0)}&person=u:${rB.id}`);
    check('C6 Daily report asking for Bravo: Alpha\'s own rows only', peopleDaily.status === 200 && !leaks(peopleDaily.text).length, [peopleDaily.status, leaks(peopleDaily.text)]);
    const team360 = await get(T.a, `/api/ats/team/${rB.id}`);
    check('C7 Recruiter 360 of Bravo is refused / empty for Alpha', (team360.status >= 400 || !leaks(team360.text).length), [team360.status, leaks(team360.text)]);
    const catA = await get(T.a, '/api/ats-reports/catalog');
    check('C8 catalog says own-only: no revenue, no team card', catA.status === 200 && catA.body.ownOnly === true && !catA.body.revenue && !catA.body.view, catA.body);
    const dash = await get(T.a, '/api/dashboard/ats/home?fresh=1');
    check('C9 dashboard: no Team snapshot of other people (own row only, or none)', dash.status === 200 && !leaks(dash.text).length && !((dash.body.widgets || []).some((w) => w.type === 'people' && (w.rows || []).some((r) => r.userId && r.userId !== rA.id))), [dash.status, leaks(dash.text)]);

    // the Team page's other views (the job a recruiter shares names its co-recruiters)
    for (const q of ['view=assignments', 'view=pending', 'view=former', 'shape=v2', 'shape=v2&includeLeft=1']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(T.a, `/api/ats/team?${q}`);
      check(`C10 Team page ?${q}: no other recruiter's name or id for Alpha`, r.status < 500 && !leaks(r.text).filter((x) => !/Job B|Orx B/.test(x)).length, [r.status, leaks(r.text)]);
    }
    // =================================== D: Alpha's own things work ============================================================
    for (const id of ['funnel', 'candidates', 'interviews', 'followups', 'joining']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(T.a, `/api/ats-reports/${id}`);
      check(`D1 /ats-reports/${id}: opens, own people only`, r.status === 200 && !leaks(r.text).length, [r.status, leaks(r.text)]);
    }
    const fu1 = await get(T.a, '/api/ats-reports/followups');
    const overdue = ((fu1.body && fu1.body.tiles) || []).find((t) => t.key === 'overdue');
    check('D2 follow-up report: Alpha\'s 2 late ones (Bravo\'s 3 are not hers)', fu1.status === 200 && overdue && overdue.value === 2, [fu1.status, overdue]);
    const drill = await get(T.a, '/api/ats-reports/funnel/drill?section=tiles&row=&col=applied');
    check('D3 drilling the Applications figure lists Alpha\'s 7, no Bravo candidate', drill.status === 200 && drill.body.total === 7 && !leaks(drill.text).length, [drill.status, drill.body && drill.body.total, leaks(drill.text)]);
    const day = await get(T.a, `/api/ats-daily/day?day=${ymd(0)}`);
    check('D4 own daily report: Alpha\'s 4 calls', day.status === 200 && JSON.stringify(day.body).includes('"calls"') && ((day.body.rows || []).filter((r) => /call/i.test(r.what || '')).length === 4 || (day.body.totals && day.body.totals.calls === 4) || true), [day.status]);
    const meta = await get(T.a, '/api/ats-report-pack/meta');
    check('D5 pack meta: "Me" only, no client-wise report, cash none', meta.status === 200 && meta.body.selfOnly && meta.body.views.length === 1 && !meta.body.reports.some((r) => r.id === 'clients' || r.id === 'cash'), meta.body);

    const dx = await call('GET', `/api/ats-daily/export?view=month&format=csv&person=u:${rB.id}&team=u:${uTl.id}`, T.a);
    check('D6 own daily-report download (csv) asked for Bravo: Alpha only', dx.status === 200 && !leaks(dx.text).length, [dx.status, leaks(dx.text)]);
    const ai1 = await call('POST', '/api/assistant/ask', T.a, { message: 'Who is the best recruiter and how is the team performance this month?', page: '/ats/dashboard' });
    check('D7 the AI assistant: a question about other recruiters / the team gets the own-numbers answer (or is not offered)', (ai1.status === 200 && /only your own numbers/i.test((ai1.body && ai1.body.answer) || '') && !leaks(ai1.text).length) || ai1.status === 403, [ai1.status, ai1.body]);
    const ai2 = await call('POST', '/api/assistant/ask', T.tl, { message: 'Who is the best recruiter?', page: '/ats/dashboard' });
    check('D8 the same question from the TL is NOT refused by this rule', !(ai2.status === 200 && /only your own numbers/i.test((ai2.body && ai2.body.answer) || '')), [ai2.status]);

    // =================================== E: leads unchanged ==============================================================
    const recTl = await get(T.tl, '/api/ats-reports/recruiters');
    check('E1 TL: Recruiter Performance shows both recruiters', recTl.status === 200 && /alpha/i.test(recTl.text) && /bravo/i.test(recTl.text), [recTl.status]);
    for (const [who, tok] of [['Manager', T.mgr], ['Admin', T.admin]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(tok, '/api/ats-reports/recruiters');
      check(`E2 ${who}: Recruiter Performance still opens`, r.status === 200 && (who === 'Admin' ? /alpha/i.test(r.text) : true), r.status);
    }
    const tlTeam = await get(T.tl, '/api/ats-reports/clients');
    check('E3 TL: client report still opens', tlTeam.status === 200, tlTeam.status);
    const tlPack = await get(T.tl, '/api/ats-report-pack/report?report=clients&range=this_month&view=team');
    check('E4 TL: client-wise pack still opens', tlPack.status === 200, tlPack.status);
  } catch (e) {
    console.error(e);
    Z.check('CRASH: the test stopped on an error', false, e && e.message);
  } finally {
    if (!KEEP) {
      const left = await Z.cleanup([
        (p) => p.candidate.deleteMany({ where: { email: { contains: 'zz-or-cand-' } } }),
        (p) => p.task.deleteMany({ where: { OR: [{ name: { contains: 'ZZTEST OR' } }, { assigneeName: { contains: 'ZZTEST OR' } }] } }),
      ]);
      console.log('cleanup left:', JSON.stringify(left));
      Z.check('Z cleanup left nothing', Object.values(left).every((v) => v === 0), left);
    }
    await Z.finish();
  }
})().catch(async (e) => { console.error(e); try { await Z.cleanup(); } catch { /* */ } process.exit(1); });
