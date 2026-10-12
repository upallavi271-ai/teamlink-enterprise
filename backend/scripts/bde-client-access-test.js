#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BDE ACCESS TO EVERYTHING CLIENT-RELATED (2026-10-10). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/bde-client-access-test.js [--matrix]
//
// "Everything related to a client must be accessible to the BDE, from the moment the client is
// added." Builds ZZTEST fixtures (two Education BDEs, one Medical BDE, the BDE TL, a recruiter,
// an Education TL, an Admin) and five clients (owned by A, owned by B, Education with no BDE, owned
// by the Medical BDE, no department no BDE), each with a job, people at every step, a client
// interview + feedback, a follow-up, an invoice, a login request, then for EVERY client sub-resource
// asks the API as every actor and checks the answer against the design:
//
//   BDE (own client, or an Education client nobody owns)  view everything + the actions the BDE role allows
//   BDE on a colleague's client of the same desk          view; no edit (bdeEditRefusal)
//   BDE on another desk's client                          nothing (403)
//   BDE TL                                                every client, view + act
//
// --matrix prints the allowed / denied table. Privacy checks: a BDE never receives candidate
// contact / salary, internal notes, panel feedback or an AI score, and sees candidates only from the
// BDE step onward.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('CA');
const { prisma, call, check } = Z;
const SHOW = process.argv.includes('--matrix');

(async () => {
  await Z.preclean();
  try {
    const { RUN } = Z;
    const ok = (r) => r.status >= 200 && r.status < 300;
    const uAdmin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uA = await Z.mkUser('bdea', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uB = await Z.mkUser('bdeb', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uM = await Z.mkUser('bdem', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: uBdeTl.name });
    const uRec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uTl = await Z.mkUser('tledu', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, bdeTl: uBdeTl, A: uA, B: uB, M: uM, rec: uRec, tl: uTl })) T[k] = await Z.mint(u);

    const mkClient = async (tag, dept, owner) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST CA Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: owner ? owner.name : null, clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-ca-${tag}-${RUN}@example.test`, agreementStatus: 'ACTIVE' } });
      Z.made.clients.push(c.id); return c;
    };
    const C = {
      A: await mkClient('A', 'Education', uA),
      B: await mkClient('B', 'Education', uB),
      U: await mkClient('U', 'Education', null),
      M: await mkClient('M', 'Medical', uM),
      N: await mkClient('N', null, null),
    };
    const SECRET = { email: `zz-ca-cand-${RUN}@example.test`, phone: '9000000055', currentSalary: '7L', expectedSalary: '9L' };
    const J = {}; const APPS = {};
    for (const [k, c] of Object.entries(C)) {
      // the job names NO bde (the BDE is only named on the client) and one recruiter
      J[k] = await prisma.requirement.create({ data: { title: `ZZTEST CA Job ${k} ${RUN}`, clientId: c.id, status: 'OPEN', department: c.ownerDepartment || 'Education', recruiterId: uRec.id, tlId: uTl.id, openings: 2 } });
      Z.made.reqs.push(J[k].id);
      APPS[k] = {};
      for (const [tag, stage] of [['review', 'RECRUITER_REVIEW'], ['bde', 'WITH_BDE'], ['shared', 'SHARED_WITH_CLIENT'], ['done', 'INTERVIEW_COMPLETED']]) {
        const cand = await prisma.candidate.create({ data: { name: `ZZTEST CA Cand ${k}${tag} ${RUN}`, ...SECRET, location: 'ZZ' } });
        Z.made.cands.push(cand.id);
        const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: J[k].id, stage, ...(stage === 'INTERVIEW_COMPLETED' ? { interviewAt: new Date(Date.now() - 2 * 86400000), interviewStatus: 'PENDING_FEEDBACK' } : {}) } });
        Z.made.apps.push(a.id);
        APPS[k][tag] = a;
        await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: cand.id, fromStage: null, toStage: stage, actorUserId: uRec.id, actorName: uRec.name, actorRole: 'Recruiter', action: 'Moved' } }).catch((e) => console.log('stage event fixture', e.message.slice(-120)));
      }
      await prisma.applicationFollowUp.create({ data: { applicationId: APPS[k].shared.id, candidateId: APPS[k].shared.candidateId, requirementId: J[k].id, ownerUserId: uA.id, ownerName: uA.name, ownerRole: 'BDE', nextAction: 'Follow up for client decision', dueDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) } }).catch((e) => console.log('followup fixture', e.message));
      await prisma.portalRequest.create({ data: { kind: 'CLIENT_LOGIN', status: 'Pending', clientId: c.id, name: 'ZZ Login', email: `zz-ca-login-${k}-${RUN}@example.test`, requestedByName: 'ZZTEST' } }).catch((e) => console.log('portalrequest fixture', e.message));
      await prisma.invoice.create({ data: { clientId: c.id, invoiceNumber: `ZZCA-${k}-${RUN}`.slice(0, 30), amount: 1000, status: 'Pending', dueDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), invoiceDate: new Date().toISOString().slice(0, 10) } }).catch((e) => console.log('invoice fixture', e.message));
    }

    // ---- who may do what, by design -------------------------------------------------------------
    // expectation per actor per client: 'own' = full access, 'view' = read only, 'none' = refused
    const DESIGN = {
      A: { A: 'own', B: 'view', U: 'own', M: 'none', N: 'none' },
      B: { A: 'view', B: 'own', U: 'own', M: 'none', N: 'none' },
      M: { A: 'none', B: 'none', U: 'none', M: 'own', N: 'none' },
      bdeTl: { A: 'own', B: 'own', U: 'own', M: 'own', N: 'own' },
    };
    const probes = (cid, appsOf, jobId, actor = 'x') => [
      { id: 'details', method: 'GET', path: `/api/clients/${cid}`, kind: 'read' },
      { id: 'overview', method: 'GET', path: `/api/clients/${cid}/overview`, kind: 'read' },
      { id: 'sla', method: 'GET', path: `/api/clients/${cid}/sla`, kind: 'read' },
      { id: 'documents', method: 'GET', path: `/api/clients/${cid}/documents`, kind: 'read' },
      { id: 'portal logins', method: 'GET', path: `/api/portal/logins/client/${cid}`, kind: 'read' },
      { id: 'all activity', method: 'GET', path: `/api/clients/${cid}/work`, kind: 'read' },
      { id: 'agreement link', method: 'GET', path: `/api/agreement/${cid}/link`, kind: 'read', jobLevel: true },
      { id: 'job', method: 'GET', path: `/api/requirements/${jobId}`, kind: 'read', jobLevel: true },
      { id: 'follow-ups of a shared person', method: 'GET', path: `/api/followups/application/${appsOf.shared.id}`, kind: 'read', jobLevel: true },
      { id: 'note (write)', method: 'POST', path: `/api/clients/${cid}/notes`, body: { note: `ZZTEST CA note ${RUN}` }, kind: 'write' },
      { id: 'edit client (write)', method: 'PUT', path: `/api/clients/${cid}`, body: { location: 'ZZ Edited' }, kind: 'write' },
      { id: 'login request (write)', method: 'POST', path: `/api/portal/logins/client/${cid}/users`, body: { name: 'ZZ Person', email: `zz-ca-new-${actor}-${cid.slice(-5)}-${RUN}@example.test`, portalType: 'VIEWER', reason: 'ZZTEST CA' }, kind: 'write' },
    ];
    const matrix = {};
    const run = async (actor, tok, clientKey) => {
      const out = {};
      for (const p of probes(C[clientKey].id, APPS[clientKey], J[clientKey].id, actor)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await call(p.method, p.path, tok, p.body);
        out[p.id] = { status: r.status, kind: p.kind, jobLevel: !!p.jobLevel, body: r.body };
      }
      matrix[`${actor}:${clientKey}`] = out;
      return out;
    };
    for (const actor of ['A', 'B', 'M', 'bdeTl']) for (const ck of Object.keys(C)) await run(actor, T[actor], ck); // eslint-disable-line no-await-in-loop

    if (SHOW) {
      const ids = probes('x', APPS.A, 'x').map((p) => p.id);
      console.log(`\n${'sub-resource'.padEnd(32)}${['A', 'B', 'M', 'bdeTl'].flatMap((a) => Object.keys(C).map((c) => `${a}>${c}`)).map((s) => s.padEnd(8)).join('')}`);
      ids.forEach((id) => {
        console.log(`${id.padEnd(32)}${['A', 'B', 'M', 'bdeTl'].flatMap((a) => Object.keys(C).map((c) => String(matrix[`${a}:${c}`][id].status).padEnd(8))).join('')}`);
      });
    }

    // ---- assertions against the design -------------------------------------------------------------
    const allowedRead = (s) => s === 200;
    for (const actor of ['A', 'B', 'M', 'bdeTl']) {
      for (const ck of Object.keys(C)) {
        const level = DESIGN[actor][ck];
        const m = matrix[`${actor}:${ck}`];
        const reads = Object.entries(m).filter(([, v]) => v.kind === 'read');
        if (level === 'none') {
          check(`${actor} on ${ck}: every sub-resource is refused (another desk / no desk)`, reads.every(([, v]) => [403, 404].includes(v.status)), reads.map(([k, v]) => [k, v.status]));
        } else {
          const need = level === 'view' ? reads.filter(([, v]) => !v.jobLevel) : reads;
          check(`${actor} on ${ck}: ${level === 'view' ? 'the client record and everything on it can be viewed (jobs, follow-ups and the agreement link stay with the client own BDE (Q3 2026-10-09))' : 'every sub-resource can be viewed'}`, need.every(([, v]) => allowedRead(v.status)), need.filter(([, v]) => !allowedRead(v.status)).map(([k, v]) => [k, v.status, v.body && v.body.error]));
          if (level === 'view') check(`${actor} on ${ck}: the colleague's jobs / follow-ups / agreement link are refused`, reads.filter(([, v]) => v.jobLevel).every(([, v]) => v.status === 403), reads.filter(([, v]) => v.jobLevel).map(([k, v]) => [k, v.status]));
        }
        const w = Object.entries(m).filter(([, v]) => v.kind === 'write');
        // (a login request that meets the company's login cap, "the most allowed is 3", was allowed by the role: the cap is a separate rule)
        const wOk = (v) => ok(v) || (v.status === 409 && /most allowed|already waiting/.test((v.body && v.body.error) || ''));
        if (level === 'own') check(`${actor} on ${ck}: the actions the BDE role allows work (note, edit, login request)`, w.every(([, v]) => wOk(v)), w.filter(([, v]) => !wOk(v)).map(([k, v]) => [k, v.status, v.body && v.body.error]));
        if (level === 'view') check(`${actor} on ${ck}: a colleague's client cannot be edited (a login REQUEST is only a request to the approver, so it stays open)`, w.filter(([k]) => k === 'edit client (write)').every(([, v]) => v.status === 403), w.map(([k, v]) => [k, v.status]));
      }
    }

    // ---- the data inside: jobs of a client the BDE is only named on the CLIENT for, stages, privacy ----
    const ovA = matrix['A:A']['overview'].body || {};
    check('J1 the client page lists the job although the job names no BDE (named on the client only)', (ovA.requirements || []).some((r) => r.id === J.A.id), (ovA.requirements || []).length);
    const candNames = (ovA.candidates || []).map((c) => c.candidateName);
    check('J2 candidates from the BDE step onward only (the Recruiter-review one is hidden)', candNames.some((n) => /Abde/.test(n)) && !candNames.some((n) => /Areview/.test(n)), candNames);
    check('J3 the client interviews tab holds the interview waiting for feedback', (ovA.interviews || []).some((i) => /Adone/.test(i.candidateName)), (ovA.interviews || []).length);
    const flat = JSON.stringify([matrix['A:A'], matrix['bdeTl:M']]);
    check('P1 no candidate phone / e-mail / salary reaches the BDE or the BDE TL', !/9000000055|zz-ca-cand-|"currentSalary"|"expectedSalary"|"candidateEmail"|"candidatePhone"/.test(flat), (flat.match(/9000000055|zz-ca-cand-[^"]*|currentSalary|expectedSalary|candidateEmail|candidatePhone/) || [])[0]);
    check('P2 no AI score / internal match score key in the client overview for a BDE', !/"(matchScore|resumeScore|aiInterviewScore|aiInterviewFeedback)"/.test(JSON.stringify(ovA)), null);
    const workA = matrix['A:A']['all activity'].body || {};
    check('K1 the Client work timeline has events (client added, job raised, steps)', Array.isArray(workA.events) && workA.events.length >= 3, workA.events && workA.events.length);
    check('K2 the Client work timeline shows nothing of the recruiter-review step (BDE steps onward)', !JSON.stringify(workA.events || []).includes('Areview'), null);
    check('K3 the pending part of Client work has the follow-up / feedback items of THIS client only', workA.pending && workA.pending.lists && Object.values(workA.pending.lists).every((l) => l.every((i) => !i.clientId || i.clientId === C.A.id)), workA.pending && Object.keys(workA.pending.lists || {}));

    // ---- the moment a client is ADDED by a BDE ---------------------------------------------------------
    const add = await call('POST', '/api/clients', T.A, { name: `ZZTEST CA Fresh ${RUN}`, mode: 'draft', ownerDepartment: 'Education' });
    const freshId = add.body && (add.body.id || (add.body.client && add.body.client.id));
    if (freshId) Z.made.clients.push(freshId);
    check('N1 a BDE adds a client', [200, 201].includes(add.status) && !!freshId, [add.status, add.body]);
    if (freshId) {
      const list = await call('GET', '/api/clients?view=mine', T.A);
      const rows = (list.body && (list.body.rows || list.body.clients || list.body)) || [];
      check('N2 the new client is in that BDE\'s client list at once (no assignment step)', Array.isArray(rows) && rows.some((r) => r.id === freshId), list.status);
      const det = await call('GET', `/api/clients/${freshId}`, T.A);
      check('N3 the BDE who added it is its owner BDE', det.status === 200 && det.body && det.body.bdeOwner === uA.name, det.body && det.body.bdeOwner);
      // a job requested for it afterwards shows up with no extra step
      const rq = await call('POST', '/api/requirements/requests', T.A, { title: `ZZTEST CA Fresh job ${RUN}`, clientId: freshId });
      if (rq.body && rq.body.id) Z.made.reqs.push(rq.body.id);
      const ov = await call('GET', `/api/clients/${freshId}/overview`, T.A);
      check('N4 a job requested for the new client appears in its Requirements at once', ov.status === 200 && (ov.body.requirements || []).some((r) => r.id === (rq.body && rq.body.id)), [rq.status, ov.body && ov.body.requirements && ov.body.requirements.length]);
      const wk = await call('GET', `/api/clients/${freshId}/work`, T.A);
      check('N5 and in Client work → All activity (client added, job requested) at once', wk.status === 200 && (wk.body.events || []).length >= 2, [wk.status, wk.body && wk.body.events && wk.body.events.length]);
      const other = await call('GET', `/api/clients/${freshId}`, T.M);
      check('N6 the other desk\'s BDE cannot open it', other.status === 403, other.status);
      const tlSees = await call('GET', `/api/clients/${freshId}/work`, T.bdeTl);
      check('N7 the BDE TL sees it too', tlSees.status === 200, tlSees.status);
    }
    // the old rule kept: a recruiter and an ordinary TL never get the client work
    for (const [who, tok] of [['recruiter', T.rec], ['education TL', T.tl]]) {
      const r = await call('GET', `/api/clients/${C.A.id}/work`, tok);
      check(`X1 the ${who} gets no Client work (403)`, [403, 404].includes(r.status) || (r.status === 200 && !(r.body.events || []).length), r.status);
    }

    // ---- NOTHING ABOUT A CLIENT MISSES ITS BDE (the BDE is named on the CLIENT, the job names none) ----------
    const seen = async (user, re) => (await prisma.notification.findMany({ where: { userId: user.id }, select: { title: true, message: true } })).filter((n) => re.test(`${n.title} ${n.message || ''}`)).length;
    const mv = await call('PATCH', `/api/applications/${APPS.A.bde.id}/stage`, T.admin, { stage: 'SHARED_WITH_CLIENT', comment: 'ZZTEST CA share' });
    check('V1 a person is moved to "Shared with client"', mv.status === 200, [mv.status, mv.body]);
    check('V2 the owner BDE of the client is told (the job names no BDE)', (await seen(uA, /moved to Shared/i)) >= 1, null);
    check('V3 the BDE of the other desk and the same-desk colleague are NOT told', (await seen(uM, /moved to Shared/i)) === 0 && (await seen(uB, /moved to Shared/i)) === 0, null);
    const fu = await prisma.applicationFollowUp.findFirst({ where: { applicationId: APPS.A.bde.id, purpose: 'Client Review' } });
    check('V4 the chase-the-client follow-up is owned by the owner BDE of the client (not left to the recruiter)', !!fu && fu.ownerUserId === uA.id && fu.ownerRole === 'BDE' && fu.bdeUserId === uA.id, fu && [fu.ownerName, fu.ownerRole]);
    const mv2 = await call('PATCH', `/api/applications/${APPS.A.review.id}/stage`, T.admin, { stage: 'TL_REVIEW', comment: 'ZZTEST CA tl' });
    check('V5 a move inside the recruiter steps (before the BDE step) does not tell the BDE', mv2.status === 200 && (await seen(uA, /moved to (TL|Team lead)/i)) === 0, [mv2.status, mv2.body && mv2.body.error]);
    const fb = await call('POST', `/api/ats/interviews/${APPS.A.done.id}/client-feedback`, T.admin, { overall: 'ZZTEST CA good fit', recommendation: 'Selected' });
    check('V6 client feedback is saved', fb.status === 200, [fb.status, fb.body]);
    check('V7 the owner BDE is told the client has answered', (await seen(uA, /Client feedback/i)) >= 1, null);
    const wk2 = await call('GET', `/api/clients/${C.A.id}/work?kind=interviews`, T.A);
    check('V8 the client feedback shows in Client work → All activity (Interviews)', wk2.status === 200 && (wk2.body.events || []).some((e) => /Client feedback/.test(e.title)), (wk2.body.events || []).map((e) => e.title));
    const wk3 = await call('GET', `/api/clients/${C.A.id}/work?kind=people`, T.A);
    check('V9 the share shows in All activity (People) with the step name', (wk3.body.events || []).some((e) => /Shared with client/i.test(e.title)), (wk3.body.events || []).map((e) => e.title));
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      const left = await Z.cleanup();
      console.log('leftovers after cleanup:', JSON.stringify(left));
      Z.check('Z cleanup: nothing ZZTEST CA is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();
