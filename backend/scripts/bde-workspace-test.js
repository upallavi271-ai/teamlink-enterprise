#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BDE BUSINESS WORKSPACE (user spec 2026-10-10). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/bde-workspace-test.js
//
// Every row of the spec as the API answers it: Allow (200/201), Approval (a request, then a Manager / Admin decides),
// Restricted / No access (403), with ZZTEST users: Admin, two Managers (Education / Medical), BDE TL, three BDEs
// (two Education desk, one Medical desk), an Education TL, a recruiter and an Accountant.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('BW');
const { prisma, call, check } = Z;

(async () => {
  await Z.preclean();
  const touched = new Set(); // Role Catalog rows this test wrote (removed at the end)
  try {
    const { RUN } = Z;
    const ok = (r) => r.status >= 200 && r.status < 300;
    const uAdmin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uSa = await Z.mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uMgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'Manager' });
    const uMgrM = await Z.mkUser('mgrm', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, { designation: 'Manager' });
    const uBdeTl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uA = await Z.mkUser('bdea', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uB = await Z.mkUser('bdeb', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uM = await Z.mkUser('bdem', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: uBdeTl.name });
    const uRec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uTl = await Z.mkUser('tledu', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const uAcc = await Z.mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' }, {});
    const T = {};
    for (const [k, u] of Object.entries({ sa: uSa, admin: uAdmin, mgr: uMgr, mgrM: uMgrM, bdeTl: uBdeTl, A: uA, B: uB, M: uM, rec: uRec, tl: uTl, acc: uAcc })) T[k] = await Z.mint(u);

    const mkClient = async (tag, dept, owner, extra = {}) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST BW Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: owner ? owner.name : null, clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-bw-${tag}-${RUN}@example.test`, agreementStatus: 'ACTIVE', gst: '36ABCDE1234F1Z5', ...extra } });
      Z.made.clients.push(c.id); return c;
    };
    const C = {
      A: await mkClient('A', 'Education', uA),
      A2: await mkClient('A2', 'Education', uA),
      A3: await mkClient('A3', 'Education', uA),
      A4: await mkClient('A4', 'Education', uA),
      A5: await mkClient('A5', 'Education', uA),
      B: await mkClient('B', 'Education', uB),
      M: await mkClient('M', 'Medical', uM),
    };
    const mkJob = async (key, client, extra = {}) => {
      const j = await prisma.requirement.create({ data: { title: `ZZTEST BW Job ${key} ${RUN}`, clientId: client.id, status: 'OPEN', department: client.ownerDepartment, bdeId: uA.id, tlId: uTl.id, openings: 2, ...extra } });
      Z.made.reqs.push(j.id); return j;
    };
    const J = { A: await mkJob('A', C.A), A2: await mkJob('A2', C.A), A3: await mkJob('A3', C.A), B: await mkJob('B', C.B, { bdeId: uB.id }) };
    const inv = await prisma.invoice.create({ data: { clientId: C.A.id, invoiceNumber: `ZZBW-${RUN}`.slice(0, 30), amount: 12345, status: 'Pending', dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), invoiceDate: new Date().toISOString().slice(0, 10) } });
    const invB = await prisma.invoice.create({ data: { clientId: C.B.id, invoiceNumber: `ZZBWB-${RUN}`.slice(0, 30), amount: 999, status: 'Pending', dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), invoiceDate: new Date().toISOString().slice(0, 10) } });
    const note = async (u, re) => (await prisma.notification.findMany({ where: { userId: u.id }, select: { title: true, message: true } })).filter((n) => re.test(`${n.title} ${n.message || ''}`)).length;
    const auditOf = (entityId, action) => prisma.auditLog.findMany({ where: { entityId, ...(action ? { action: { contains: action } } : {}) }, orderBy: { createdAt: 'asc' } });
    const setBde = async (moduleId, feature, action, value) => {
      const got = await call('GET', '/api/admin/role-catalog/BDE/access', T.sa);
      const mod = got.body.modules.find((m) => m.id === moduleId);
      const features = JSON.parse(JSON.stringify(mod.features));
      features[feature] = { ...(features[feature] || {}), [action]: value };
      touched.add(moduleId);
      return call('PUT', `/api/admin/role-catalog/BDE/modules/${moduleId}/features`, T.sa, { features });
    };

    // ============================ CLIENTS: VIEW / CREATE / EDIT ============================
    const list = await call('GET', '/api/clients', T.A);
    const names = (list.body || []).map((c) => c.name);
    check('V1 View clients: the BDE sees the clients of their desk (own and colleague)', ok(list) && names.includes(C.A.name) && names.includes(C.B.name), [list.status, names.length]);
    check('V2 ... and not another desk\'s client', !names.includes(C.M.name), null);
    check('V3 opening another desk\'s client is refused', (await call('GET', `/api/clients/${C.M.id}`, T.A)).status === 403, null);
    const colleague = await call('GET', `/api/clients/${C.B.id}`, T.A);
    check('V4 [agreement workflow 2026-10-13] a colleague client of the same desk opens, but Tax & billing (GST) is for HR / BDE TL / Admin only', ok(colleague) && !colleague.body.gst, colleague.body && colleague.body.gst);
    const own = await call('GET', `/api/clients/${C.A.id}`, T.A);
    check('V5 [agreement workflow] the BDE desk does not read GST even on their own client (section 6 is the HR step)', ok(own) && !own.body.gst, own.body && own.body.gst);

    const add = await call('POST', '/api/clients', T.A, { name: `ZZTEST BW New ${RUN}`, mode: 'draft', ownerDepartment: 'Education', allowDuplicate: true });
    const newId = add.body && (add.body.id || (add.body.client && add.body.client.id));
    if (newId) Z.made.clients.push(newId);
    check('C1 Create client: allowed, and the creator is its owner BDE', [200, 201].includes(add.status) && !!newId && add.body.bdeOwner === uA.name, [add.status, add.body && add.body.error]);
    check('E1 Edit own client: allowed', ok(await call('PUT', `/api/clients/${C.A.id}`, T.A, { location: 'ZZ Edited' })), null);
    check('E2 Edit a colleague\'s client of the same desk: allowed (shared desk); another desk\'s client: refused', ok(await call('PUT', `/api/clients/${C.B.id}`, T.A, { location: 'ZZ Edited' })) && (await call('PUT', `/api/clients/${C.M.id}`, T.A, { location: 'ZZ Edited' })).status === 403, null);
    check('E3 Edit contact details of own client: allowed (ticked)', ok(await call('PUT', `/api/clients/${C.A.id}`, T.A, { contactName: 'ZZ Contact 2', contactPhone: '9000000012' })), null);
    check('E4 Status cannot be changed through the edit form', (await call('PUT', `/api/clients/${C.A.id}`, T.A, { status: 'Inactive' })).status === 400, null);
    check('E5 Owner change through the edit form: a BDE of another desk is refused (department rule), no approval step', (await call('PUT', `/api/clients/${C.A.id}`, T.A, { bdeOwner: uM.name })).status === 400, null);
    await setBde('clients', 'Client Contacts', 'create', false);
    const noContact = await call('PUT', `/api/clients/${C.A.id}`, T.A, { contactName: 'ZZ Contact 3' });
    check('E6 Untick "Add contacts" in the Role Catalog and contact edits are refused (the tick is real)', noContact.status === 403, [noContact.status, noContact.body && noContact.body.error]);
    check('E7 ... other edits still work', ok(await call('PUT', `/api/clients/${C.A.id}`, T.A, { location: 'ZZ Edited 2' })), null);
    await setBde('clients', 'Client Contacts', 'create', true);

    // ============================ PAUSE / RESUME (allowed, reason compulsory) ============================
    const histBefore = await prisma.requirement.count({ where: { clientId: C.A.id } });
    await call('POST', `/api/clients/${C.A.id}/notes`, T.A, { note: 'ZZTEST BW note kept', kind: 'meeting' });
    check('P1 Pause client without a reason is refused', (await call('POST', `/api/clients/${C.A.id}/pause`, T.A, {})).status === 400, null);
    const pz = await call('POST', `/api/clients/${C.A.id}/pause`, T.A, { reason: 'ZZTEST BW client asked to wait' });
    check('P2 Pause client with a reason: allowed, the client is Paused', ok(pz) && pz.body.client && pz.body.client.lifecycle === 'Paused', [pz.status, pz.body && pz.body.error]);
    const pAud = (await auditOf(C.A.id, 'Client paused'))[0];
    check('P3 The pause is in the audit log with reason + user + time', !!pAud && /ZZTEST BW client asked/.test(pAud.reason || '') && pAud.userId === uA.id && !!pAud.createdAt && pAud.toValue === 'Paused', pAud);
    check('P4 Pausing keeps the history: jobs, notes and people are untouched', (await prisma.requirement.count({ where: { clientId: C.A.id } })) === histBefore && (await auditOf(C.A.id, 'Client note')).length >= 1, null);
    const newWhilePaused = await call('POST', '/api/requirements/requests', T.A, { title: `ZZTEST BW Req paused ${RUN}`, clientId: C.A.id });
    check('P5 A paused client takes no new job', newWhilePaused.status === 409, [newWhilePaused.status, newWhilePaused.body && newWhilePaused.body.error]);
    check('P6 Resume without a reason is refused', (await call('POST', `/api/clients/${C.A.id}/reactivate`, T.A, {})).status === 400, null);
    const rs = await call('POST', `/api/clients/${C.A.id}/reactivate`, T.A, { reason: 'ZZTEST BW client is back' });
    check('P7 Resume with a reason: allowed, Active again', ok(rs) && rs.body.client.lifecycle === 'Active', [rs.status, rs.body && rs.body.error]);
    check('P8 Pause + resume a colleague\'s client of the same desk: allowed; another desk\'s: refused', ok(await call('POST', `/api/clients/${C.B.id}/pause`, T.A, { reason: 'ZZTEST BW desk' })) && ok(await call('POST', `/api/clients/${C.B.id}/reactivate`, T.A, { reason: 'ZZTEST BW desk back' })) && [403, 404].includes((await call('POST', `/api/clients/${C.M.id}/pause`, T.A, { reason: 'ZZTEST BW no' })).status), null);
    check('P9 Pause another desk\'s client: refused', [403, 404].includes((await call('POST', `/api/clients/${C.M.id}/pause`, T.A, { reason: 'ZZTEST BW no' })).status), null);

    // ============================ DEACTIVATE (DIRECT now: user rule 2026-10-13, everything but DELETE) ============================
    check('D1 Deactivate needs a reason', (await call('POST', `/api/clients/${C.A2.id}/deactivate`, T.A, {})).status === 400, null);
    check('D2 A BDE has no "Ask to deactivate" any more (nothing to ask)', (await call('POST', `/api/clients/${C.A2.id}/request-deactivate`, T.A, { reason: 'ZZTEST BW x' })).status === 403, null);
    const dDo = await call('POST', `/api/clients/${C.A2.id}/deactivate`, T.A, { reason: 'ZZTEST BW stop working with them' });
    check('D3 The BDE deactivates their own client DIRECTLY: Inactive, history kept', ok(dDo) && (await prisma.client.findUnique({ where: { id: C.A2.id } })).status === 'Inactive', [dDo.status, dDo.body]);
    const dAud = (await auditOf(C.A2.id, 'deactivated'))[0];
    check('D4 audit: reason + user + time', !!dAud && dAud.userId === uA.id && /stop working/.test(dAud.reason || '') && !!dAud.createdAt, dAud);
    check('D5 Another desk cannot be deactivated by me', [403, 404].includes((await call('POST', `/api/clients/${C.M.id}/deactivate`, T.A, { reason: 'ZZTEST BW no' })).status), null);
    check('D6 The BDE reactivates (resumes) it with a reason', ok(await call('POST', `/api/clients/${C.A2.id}/reactivate`, T.A, { reason: 'ZZTEST BW back again' })) && (await prisma.client.findUnique({ where: { id: C.A2.id } })).status === 'Active', null);
    const dDirect = await call('POST', `/api/clients/${C.A5.id}/deactivate`, T.mgr, { reason: 'ZZTEST BW manager direct' });
    check('D7 A Manager of the department still deactivates directly', ok(dDirect) && (await prisma.client.findUnique({ where: { id: C.A5.id } })).status === 'Inactive', dDirect.body);
    check('D8 The BDE TL deactivates any client directly', ok(await call('POST', `/api/clients/${C.B.id}/deactivate`, T.bdeTl, { reason: 'ZZTEST BW tl' })) && ok(await call('POST', `/api/clients/${C.B.id}/reactivate`, T.bdeTl, { reason: 'ZZTEST BW tl back' })), null);

    // ============================ DELETE (approval, soft delete, never permanent) ============================
    // 2026-10-16 (user): the whole BDE team DELETES a client of their own area directly (typed name + reason), never one that has jobs / invoices.
    // The old "Ask to delete -> an Admin approves -> archived" flow is gone for the BDE team.
    const delBody = (c) => ({ confirmName: c.name, reason: 'ZZTEST BW delete' });
    check('X1 A BDE of another desk cannot delete the client', [403, 404].includes((await call('DELETE', `/api/clients/${C.A3.id}`, T.M, delBody(C.A3))).status), null);
    check('X2 The typed-name check stays (wrong name -> 400)', (await call('DELETE', `/api/clients/${C.A3.id}`, T.A, { confirmName: 'wrong name', reason: 'ZZTEST BW delete' })).status === 400, null);
    check('X3 "Ask to delete" is gone for the BDE team (the BDE deletes directly)', (await call('POST', `/api/clients/${C.A3.id}/request-delete`, T.A, { reason: 'ZZTEST BW added by mistake' })).status === 403, null);
    const xDel = await call('DELETE', `/api/clients/${C.A3.id}`, T.A, { ...delBody(C.A3), confirmSignedAgreement: true }); // the client has a signed agreement: the box "Delete the signed agreement too" must be ticked
    check('X4 The desk BDE deletes their own empty client (200)', xDel.status === 200 && xDel.body && xDel.body.ok, [xDel.status, xDel.body]);
    check('X5 The client row is gone', !(await prisma.client.findUnique({ where: { id: C.A3.id } })), null);
    const listAfter = await call('GET', '/api/clients', T.A);
    check('X6 The deleted client is out of the BDE default list', !(listAfter.body || []).some((c) => c.id === C.A3.id), null);
    const xAud = (await prisma.auditLog.findMany({ where: { entity: 'Client', entityId: C.A3.id, action: 'Client deleted (permanent)' }, orderBy: { createdAt: 'desc' } }))[0];
    check('X7 audit: who and the reason', !!xAud && xAud.userId === uA.id && /ZZTEST BW delete/.test(xAud.reason || ''), xAud);
    check('X8 A client that has jobs is refused (409): the guard stays', (await call('DELETE', `/api/clients/${C.A.id}`, T.A, { ...delBody(C.A), confirmSignedAgreement: true })).status === 409, null);
    check('X9 A TL cannot delete a client', [401, 403, 404].includes((await call('DELETE', `/api/clients/${C.A4.id}`, T.tl, delBody(C.A4))).status), null);

    // ============================ CHANGE OF OWNER (DIRECT) ============================
    check('O1 Owner change to a BDE of another desk is refused', (await call('POST', `/api/clients/${C.A4.id}/change-owner`, T.A, { newOwner: uM.name, reason: 'ZZTEST BW' })).status === 400, null);
    check('O2 ... needs a reason', (await call('POST', `/api/clients/${C.A4.id}/change-owner`, T.A, { newOwner: uB.name })).status === 400, null);
    check('O3 A BDE of another desk cannot change the owner', [403, 404].includes((await call('POST', `/api/clients/${C.A4.id}/change-owner`, T.M, { newOwner: uB.name, reason: 'ZZTEST BW' })).status), null);
    const oOk = await call('POST', `/api/clients/${C.A4.id}/change-owner`, T.A, { newOwner: uB.name, reason: 'ZZTEST BW B knows this client' });
    check('O4 The BDE changes the owner DIRECTLY: now B owns it', ok(oOk) && (await prisma.client.findUnique({ where: { id: C.A4.id } })).bdeOwner === uB.name, [oOk.status, oOk.body && oOk.body.error]);
    check('O5 The new owner hears about it; audit has old -> new + reason', (await note(uB, /owner changed/i)) >= 1 && (await auditOf(C.A4.id, 'owner changed'))[0].fromValue === uA.name && /B knows/.test((await auditOf(C.A4.id, 'owner changed'))[0].reason || ''), null);
    check('O6 Both desk BDEs can edit it (the desk shares its clients)', ok(await call('PUT', `/api/clients/${C.A4.id}`, T.A, { location: 'ZZ X' })) && ok(await call('PUT', `/api/clients/${C.A4.id}`, T.B, { location: 'ZZ Y' })), null);
    check('O7 The BDE TL assigns any client to any BDE', ok(await call('POST', `/api/clients/${C.A4.id}/change-owner`, T.bdeTl, { newOwner: uA.name, reason: 'ZZTEST BW back to A' })), null);

    // ============================ MERGE DUPLICATES (DIRECT, own clients only) ============================
    const mkDup = async (tag, owner, dept = 'Education') => { const c = await prisma.client.create({ data: { name: `ZZTEST BW Dup ${tag} ${RUN}`, ownerDepartment: dept, bdeOwner: owner.name, clientType: 'Client', agreementStatus: 'DRAFT' } }); Z.made.clients.push(c.id); return c; };
    const dupA1 = await mkDup('Alpha', uA); const dupA2 = await mkDup('Alpha Ltd', uA); const dupB = await mkDup('Beta', uM, 'Medical'); const dupA3 = await mkDup('Gamma', uA); const dupA4 = await mkDup('Gamma Inc', uA);
    const mg = await call('GET', '/api/client-merge/groups', T.A);
    check('M1 The BDE opens the duplicate tool and sees ONLY their desk\'s clients', ok(mg) && !JSON.stringify(mg.body).includes(dupB.id), mg.status);
    check('M2 The company-wide tools stay Admin only (merge-safe, plan, apply-plan; history is scoped to the desk)', (await call('POST', '/api/client-merge/merge-safe', T.A, { all: true })).status === 403 && (await call('GET', '/api/client-merge/plan', T.A)).status === 403, null);
    check('M3 A BDE cannot merge another desk\'s client into theirs', (await call('POST', '/api/client-merge/merge', T.A, { primaryId: dupA1.id, donorIds: [dupB.id] })).status === 403, null);
    const dupJob = await prisma.requirement.create({ data: { title: `ZZTEST BW Dup job ${RUN}`, clientId: dupA2.id, status: 'OPEN', department: 'Education', openings: 1 } }); Z.made.reqs.push(dupJob.id);
    const mm = await call('POST', '/api/client-merge/merge', T.A, { primaryId: dupA1.id, donorIds: [dupA2.id], reason: 'ZZTEST BW same company' });
    check('M4 The BDE merges two of their own duplicates DIRECTLY (the donor is joined into the primary)', ok(mm) && !!(await prisma.client.findUnique({ where: { id: dupA1.id } })) && !(await prisma.client.findUnique({ where: { id: dupA2.id } })), [mm.status, mm.body && mm.body.error]);
    check('M5 audit: who merged, when, why; the merge snapshot is kept in the merge history', (await auditOf(dupA1.id, 'Clients merged')).some((a) => a.userId === uA.id && /same company/.test(a.reason || '')) && (await call('GET', '/api/client-merge/history', T.admin)).body.merges.length >= 1, null);
    check('MU0 After the merge the donor job sits on the survivor', (await prisma.requirement.findUnique({ where: { id: dupJob.id } })).clientId === dupA1.id, null);
    check('MU1 A BDE of another desk cannot undo it', [403, 404].includes((await call('POST', '/api/client-merge/undo', T.M, { mergeId: mm.body && mm.body.mergeId })).status), null);
    const hist = await call('GET', `/api/client-merge/history?primaryId=${dupA1.id}`, T.A);
    check('MU2 The BDE sees the merge of their desk in the history, marked undoable', ok(hist) && (hist.body.merges || []).some((m) => m.id === (mm.body && mm.body.mergeId) && m.undoable === true), hist.body);
    const und = await call('POST', '/api/client-merge/undo', T.A, { mergeId: mm.body && mm.body.mergeId, reason: 'ZZTEST BW wrong match' });
    check('MU3 The BDE UNDOES the merge (7 days): the donor is back with its job', ok(und) && !!(await prisma.client.findUnique({ where: { id: dupA2.id } })) && (await prisma.requirement.findUnique({ where: { id: dupJob.id } })).clientId === dupA2.id, [und.status, und.body]);
    check('MU4 Undo is audited (who, when, why) and cannot be repeated', (await auditOf(dupA1.id, 'merge undone')).some((x) => x.userId === uA.id && /wrong match/.test(x.reason || '')) && (await call('POST', '/api/client-merge/undo', T.A, { mergeId: mm.body && mm.body.mergeId })).status === 409, null);
    check('M6 The BDE TL merges any clients', ok(await call('POST', '/api/client-merge/merge', T.bdeTl, { primaryId: dupA3.id, donorIds: [dupA4.id], reason: 'ZZTEST BW tl merge' })), null);
    check('M7 A recruiter and a TL cannot use it', (await call('GET', '/api/client-merge/groups', T.rec)).status === 403 && (await call('GET', '/api/client-merge/groups', T.tl)).status === 403, null);

    // ============================ COMMERCIAL TERMS + CLIENT PORTAL LOGINS (DIRECT) ============================
    const ct = await call('PUT', `/api/clients/${C.A.id}`, T.A, { agreementFeePercent: 9.5, paymentTerms: 'ZZTEST BW 15 days', gst: '36ABCDE1234F1Z5' });
    check('CT1 The BDE edits the commercial terms of their own client (fee %, payment terms)', ok(ct) && Number(ct.body.agreementFeePercent) === 9.5, [ct.status, ct.body && ct.body.error]);
    check('CT2 ... not of another desk\'s client', (await call('PUT', `/api/clients/${C.M.id}`, T.A, { agreementFeePercent: 7 })).status === 403, null);
    const pl = await call('POST', `/api/portal/logins/client/${C.A.id}/users`, T.A, { name: 'ZZTEST BW Login', email: `zz-bw-login-${RUN}@example.test`, portalPerms: ['VIEW', 'DECIDE', 'INTERVIEW', 'FEEDBACK'], reason: 'ZZTEST BW' });
    check('PL1 The BDE adds a client login DIRECTLY with its ticks (created, not a request)', pl.status === 201 && pl.body.created === true || (pl.status === 409 && /most allowed/.test((pl.body && pl.body.error) || '')), [pl.status, pl.body]);
    const plRows = await prisma.user.findMany({ where: { email: `zz-bw-login-${RUN}@example.test` } });
    plRows.forEach((u) => Z.made.users.push(u.id));
    if (pl.status === 201) {
      check('PL2 ... the login exists with the ticks', plRows.length === 1 && /VIEW/.test(String(plRows[0].portalPerms || '')) && /FEEDBACK/.test(String(plRows[0].portalPerms || '')), plRows[0]);
      const dis = await call('POST', `/api/portal/logins/client/${C.A.id}/users/${plRows[0].id}/disable`, T.A, { reason: 'ZZTEST BW off' });
      check('PL3 The BDE switches it off DIRECTLY (no request)', ok(dis) ? dis.body.requested !== true : /already switched off/.test((dis.body && dis.body.error) || ''), dis.body);
      const perms = await call('POST', `/api/portal/logins/client/${C.A.id}/users/${plRows[0].id}/perms`, T.A, { portalPerms: ['VIEW', 'INVOICES'], reason: 'ZZTEST BW ticks' });
      check('PL4 The BDE changes the ticks DIRECTLY (no approval)', ok(perms) && perms.body.requested !== true, perms.body);
    }
    check('PL5 A BDE of another desk cannot add a login to my client', [403, 404].includes((await call('POST', `/api/portal/logins/client/${C.A.id}/users`, T.M, { name: 'x', email: `zz-bw-x-${RUN}@example.test`, portalPerms: ['VIEW'] })).status), null);
    check('PL6 The BDE TL adds a login on any client directly', [201, 409].includes((await call('POST', `/api/portal/logins/client/${C.M.id}/users`, T.bdeTl, { name: 'ZZTEST BW TL Login', email: `zz-bw-tl-login-${RUN}@example.test`, portalPerms: ['VIEW'] })).status), null);
    (await prisma.user.findMany({ where: { email: { contains: `zz-bw-tl-login-${RUN}` } } })).forEach((u) => Z.made.users.push(u.id));

    // ============================ CLIENT APPROVAL SUBMISSION + ONBOARDING ============================
    const bz0 = await call('GET', `/api/clients/${newId}/business`, T.A);
    check('S1 Track onboarding status: the steps are listed', ok(bz0) && bz0.body.onboarding.steps.length >= 6 && bz0.body.onboarding.steps[0].state === 'done', bz0.body);
    const sReq = await call('POST', `/api/clients/${newId}/submit-approval`, T.A, { note: 'ZZTEST BW please approve' });
    check('S2 Submit the client for approval: allowed', sReq.status === 201, [sReq.status, sReq.body]);
    check('S3 asking again while waiting is refused', (await call('POST', `/api/clients/${newId}/submit-approval`, T.A, { note: 'ZZTEST BW again' })).status === 409, null);
    const sOk = await call('POST', `/api/clients/requests/${sReq.body.requestId}/approve`, T.mgr, {});
    const bz1 = await call('GET', `/api/clients/${newId}/business`, T.A);
    check('S4 The Manager approves: onboarding shows Submitted + Approved', ok(sOk) && bz1.body.onboarding.steps.find((s) => s.key === 'approved').done === true, bz1.body && bz1.body.onboarding);

    // ============================ FOLLOW-UPS / MEETINGS / FEEDBACK ============================
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    check('F1 A follow-up needs a date from today on', (await call('POST', `/api/clients/${C.A.id}/followups`, T.A, { kind: 'followup', title: 'ZZTEST BW call back', dueDate: yday })).status === 400, null);
    const f1 = await call('POST', `/api/clients/${C.A.id}/followups`, T.A, { kind: 'followup', title: 'ZZTEST BW call back', dueDate: today, note: 'about the new job' });
    check('F2 Add follow-up date + reminder: allowed', f1.status === 201 && f1.body.item.dueToday === true, [f1.status, f1.body]);
    const f2 = await call('POST', `/api/clients/${C.A.id}/followups`, T.A, { kind: 'meeting', title: 'ZZTEST BW client meeting', dueDate: today, dueTime: '15:30', meetingLink: 'https://meet.example.test/zz' });
    check('F3 Schedule a client meeting: allowed', f2.status === 201 && f2.body.item.kind === 'meeting', [f2.status, f2.body]);
    check('F4 A BDE of another desk cannot add one to my client', [403, 404].includes((await call('POST', `/api/clients/${C.A.id}/followups`, T.M, { kind: 'followup', title: 'ZZTEST BW no', dueDate: today })).status), null);
    const fb = await call('POST', `/api/clients/${C.A.id}/feedback`, T.A, { note: 'ZZTEST BW client likes the profiles', kind: 'feedback' });
    const hu = await call('POST', `/api/clients/${C.A.id}/feedback`, T.A, { note: 'ZZTEST BW they will hire 3 more', kind: 'hiring' });
    check('F5 Client feedback + hiring updates: allowed, kept as history', fb.status === 201 && hu.status === 201, [fb.status, hu.status]);
    const bz2 = await call('GET', `/api/clients/${C.A.id}/business`, T.A);
    check('F6 The client page lists the open follow-ups and the history', ok(bz2) && bz2.body.open.length === 2 && bz2.body.history.filter((h) => h.kind === 'feedback' || h.kind === 'hiring').length === 2, bz2.body && [bz2.body.open.length, bz2.body.history.length]);
    const ws = await call('GET', '/api/clients/my-business', T.A);
    check('F7 Workspace: Follow-ups Due counts them (today)', ok(ws) && ws.body.counts.followUpsClient === 2 && ws.body.counts.followUpsDue >= 2, ws.body && ws.body.counts);
    check('F8 ... and the reminder reached the bell, once', (await note(uA, /Follow-up today|Meeting today/i)) === 2, await note(uA, /today/i));
    await call('GET', '/api/clients/my-business', T.A);
    check('F9 ... a second read does not send it again', (await note(uA, /Follow-up today|Meeting today/i)) === 2, null);
    const done = await call('POST', `/api/clients/followups/${f1.body.item.id}/done`, T.A, { note: 'ZZTEST BW spoke to them' });
    check('F10 Mark done: saved in the history', ok(done) && (await call('GET', '/api/clients/my-business', T.A)).body.counts.followUpsClient === 1, done.body);
    check('F11 A BDE of another desk cannot finish my follow-up', [403, 404].includes((await call('POST', `/api/clients/followups/${f2.body.item.id}/done`, T.M, {})).status), null);
    check('F12 Meeting / call note: allowed on my desk\'s clients, refused on another desk\'s', ok(await call('POST', `/api/clients/${C.A.id}/notes`, T.A, { note: 'ZZTEST BW call summary', kind: 'call' })) && ok(await call('POST', `/api/clients/${C.B.id}/notes`, T.A, { note: 'ZZTEST BW desk note' })) && [403, 404].includes((await call('POST', `/api/clients/${C.M.id}/notes`, T.A, { note: 'ZZTEST BW no' })).status), null);

    // ============================ DOCUMENTS ============================
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const upload = async (tok, id) => {
      const fd = new FormData(); fd.append('kind', 'AGREEMENT'); fd.append('name', 'ZZTEST BW agreement'); fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'zz-bw.pdf');
      const r = await fetch(`${Z.API}/api/clients/${id}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd });
      let body = null; try { body = await r.json(); } catch { /* none */ }
      return { status: r.status, body };
    };
    const up = await upload(T.A, C.A.id);
    check('U1 [agreement workflow] a BDE does not upload client documents: HR adds them (403 in plain words)', up.status === 403 && /HR/.test((up.body && up.body.error) || ''), up);
    check('U2 ... nor on a colleague client, nor on another desk', [403, 404].includes((await upload(T.A, C.B.id)).status) && [403, 404].includes((await upload(T.A, C.M.id)).status), null);
    if (up.body && up.body.id) check('U3 A BDE can replace / remove a document of their client (only DELETING a client is a request)', ok(await call('DELETE', `/api/clients/${C.A.id}/documents/${up.body.id}`, T.A)), null);
    const docB = await prisma.clientDocument.create({ data: { clientId: C.B.id, kind: 'GST', name: 'ZZTEST BW gst', fileStored: 'zz-none', fileName: 'x.pdf', fileMime: 'application/pdf', fileSize: 1, uploadedByName: 'ZZTEST BW' } });
    check('U4 [agreement workflow] a desk client GST paper is closed to the BDE desk (403); another desk\'s do not', (await call('GET', `/api/clients/${C.B.id}/documents/${docB.id}/file`, T.A)).status === 403 && [403, 404].includes((await call('GET', `/api/clients/${C.M.id}/documents/${docB.id}/file`, T.A)).status), null);

    // ============================ INVOICES: limited, read-only, own clients ============================
    const ovA = await call('GET', `/api/clients/${C.A.id}/overview`, T.A);
    const rowA = (ovA.body.invoices || [])[0];
    check('I1 Invoices: my client\'s invoice shows number, due date and status', ok(ovA) && !!rowA && rowA.invoiceNumber === inv.invoiceNumber && !!rowA.dueDate && !!rowA.status, ovA.body && ovA.body.invoices);
    check('I2 ... without the amount (earlier rule: status only; the amount is its own Role Catalog tick)', rowA && rowA.amount === undefined && rowA.gst === undefined && rowA.tds === undefined, rowA);
    const ovB = await call('GET', `/api/clients/${C.B.id}/overview`, T.A);
    check('I3 A desk colleague\'s client: its invoice status is visible too (shared desk)', ok(ovB) && (ovB.body.invoices || []).length === 1 && (ovB.body.tabs || []).includes('invoices'), ovB.body && ovB.body.tabs);
    await setBde('clients', 'Client Invoice Amount', 'view', true);
    const rowAmt = ((await call('GET', `/api/clients/${C.A.id}/overview`, T.A)).body.invoices || [])[0];
    check('I4 Tick "See invoice amount": the amount appears (still no GST / TDS)', rowAmt && Number(rowAmt.amount) === 12345 && rowAmt.gst === undefined, rowAmt);
    await setBde('clients', 'Client Invoice Amount', 'view', false);
    await setBde('clients', 'Client Invoice Status', 'view', false);
    const ovOff = await call('GET', `/api/clients/${C.A.id}/overview`, T.A);
    check('I5 Switch the invoice view OFF: nothing is sent', ok(ovOff) && !(ovOff.body.invoices || []).length && ovOff.body.invoiceMode === 'none', ovOff.body && ovOff.body.invoiceMode);
    await setBde('clients', 'Client Invoice Status', 'view', true);
    for (const [name, m, p, b] of [
      ['list invoices', 'GET', '/api/invoices'], ['open an invoice', 'GET', `/api/invoices/${inv.id}`], ['create an invoice', 'POST', '/api/invoices', { clientId: C.A.id, amount: 5 }],
      ['edit an invoice', 'PUT', `/api/invoices/${inv.id}`, { amount: 5 }], ['journal', 'GET', '/api/accounts/journal-entries'], ['ledger', 'GET', '/api/accounts/ledger'],
      ['trial balance', 'GET', '/api/accounts/reports/trial-balance'],
    ]) check(`N-ACC ${name}: no access`, (await call(m, p, T.A, b)).status === 403, null);
    for (const [name, p] of [['HRMS employees (salary, personal info)', '/api/employees'], ['users and roles', '/api/admin/users'], ['Role Catalog', '/api/admin/role-catalog'], ['audit logs', '/api/admin/audit-logs']]) {
      const r = await call('GET', p, T.A);
      check(`N-HR ${name}: no access`, [401, 403, 404].includes(r.status), r.status);
    }

    // ============================ REQUIREMENTS ============================
    const rq = await call('POST', '/api/requirements/requests', T.A, { title: `ZZTEST BW Teacher Opening ${RUN}`, clientId: C.A.id });
    if (rq.body && rq.body.id) Z.made.reqs.push(rq.body.id);
    check('R1 Create requirement (as a request a lead opens): allowed for my client', rq.status === 201, [rq.status, rq.body && rq.body.error]);
    check('R2 ... for another desk\'s client: refused', (await call('POST', '/api/requirements/requests', T.A, { title: `ZZTEST BW Req x ${RUN}`, clientId: C.M.id })).status === 403, null);
    check('R3 Edit my requirement: allowed', ok(await call('PUT', `/api/requirements/${J.A.id}`, T.A, { notes: 'ZZTEST BW edited' })), null);
    // 2026-10-13 (user): the whole BDE team of a desk shares the desk's jobs - a colleague's job of the same desk is editable too
    check('R8 The TL still assigns (cross-department rule unchanged)', ok(await call('POST', `/api/requirements/${J.A.id}/assign`, T.tl, { recruiterId: uRec.id })), null);
    // 2026-10-13 (user): a requirement is only Open or Closed - nobody pauses one any more ("On hold" is a reason in the Close dialog).
    // A requirement that is already On hold can still be resumed.
    const rp = await call('POST', `/api/requirements/${J.A2.id}/pause`, T.A, { reason: 'ZZTEST BW client on hold', until: '2099-01-01' });
    check('R9 Pause is gone: the BDE gets 403 in plain words', rp.status === 403 && /cannot pause/i.test((rp.body && rp.body.error) || ''), [rp.status, rp.body]);
    check('R10 ... and the requirement stays Open', (await prisma.requirement.findUnique({ where: { id: J.A2.id } })).status !== 'ON_HOLD', null);
    check('R11 ... and no pause is written to the audit log', !(await auditOf(J.A2.id, 'Requirement paused'))[0], null);
    await prisma.requirement.update({ where: { id: J.A2.id }, data: { status: 'ON_HOLD' } });
    check('R13 A requirement already On hold can be resumed by its BDE', ok(await call('POST', `/api/requirements/${J.A2.id}/resume`, T.A, {})) && (await prisma.requirement.findUnique({ where: { id: J.A2.id } })).status !== 'ON_HOLD', null);

    // ============================ EXPORT (assigned clients only) ============================
    const exC = await call('GET', '/api/ats-io/export/clients?format=csv', T.A);
    check('Y1 Export clients: the desk\'s clients are in it (mine and colleagues\'), another desk\'s are not', exC.status === 200 && exC.text.includes(C.A.name) && exC.text.includes(C.B.name) && !exC.text.includes(C.M.name), [exC.status, (exC.text || '').slice(0, 120)]);
    const exR = await call('GET', '/api/ats-io/export/requirements?format=csv', T.A);
    check('Y2 Export requirements: my clients\' jobs are in it', exR.status === 200 && exR.text.includes(`ZZTEST BW Job A ${RUN}`), [exR.status]);
    check('Y3 No candidate phone / e-mail / salary column in either', !/candidate (email|phone)|salary/i.test((exC.text || '').split('\n')[0] + (exR.text || '').split('\n')[0]), null);
    const exAll = await call('GET', '/api/ats-io/export/clients?format=csv', T.admin);
    check('Y4 The Admin still exports everything', exAll.status === 200 && exAll.text.includes(C.B.name), null);
    const acc = await call('GET', '/api/ats-io/access', T.A);
    check('Y5 Bulk import clients is DIRECT for the BDE now (not a request)', ok(acc) && /"clients":"direct"/.test(JSON.stringify(acc.body.importModes || acc.body)), acc.body && acc.body.importModes);

    // ============================ ROLE CATALOG ============================
    const cat = await call('GET', '/api/admin/role-catalog/BDE/access', T.sa);
    const cmod = cat.body.modules.find((m) => m.id === 'clients');
    const rmod = cat.body.modules.find((m) => m.id === 'requirements');
    const pmod = cat.body.modules.find((m) => m.id === 'reports');
    const lines = (m) => (m.groups || []).flatMap((g) => g.lines);
    const on = (m, f, a) => !!(m.features[f] && m.features[f][a]);
    check('G1 Role Catalog: the BDE Clients group lists View, Create, Edit, Pause, Resume, Deactivate, Delete request, Export', ['View', 'Create', 'Edit', 'Pause', 'Resume', 'Export'].every((l) => lines(cmod).some((x) => x.label === l)) && lines(cmod).some((x) => /Deactivate/.test(x.label)) && lines(cmod).some((x) => /Delete request/.test(x.label)), lines(cmod).map((x) => x.label));
    check('G2 ... Deactivate is now TICKED (direct), and so are the others', on(cmod, 'Deactivate Client', 'edit') && on(cmod, 'Commercial Terms', 'edit') && on(cmod, 'Bulk Import', 'create') && on(cmod, 'Client Portal Logins', 'create') && on(cmod, 'Client Ownership Request', 'create') && on(cmod, 'Client Detail', 'view') && on(cmod, 'Add Client', 'create') && on(cmod, 'Client Detail', 'edit') && on(cmod, 'Pause / Reactivate Client', 'edit') && on(cmod, 'Resume Client', 'edit') && on(cmod, 'Client Delete Request', 'create') && on(cmod, 'Client List', 'export'), null);
    check('G3 ... Business activities: contacts, meeting notes, follow-ups, documents, approval submission', ['Client Contacts', 'Client Notes', 'Client Follow-ups', 'Client Documents', 'Client Approval Submission'].every((f) => on(cmod, f, 'create')), null);
    // 2026-10-13 (user): the BDE team has every job option a Super Admin has, except DELETE
    check('G4 Requirements group (BDE): Create, Edit, Close, Post, Assign recruiter ticked; Delete ticked too (2026-10-16) and not fixed off', on(rmod, 'Create Requirement', 'create') && on(rmod, 'Requirement Detail', 'edit') && on(rmod, 'Requirement Detail', 'approve') && on(rmod, 'Requirement Detail', 'assign') && on(rmod, 'Job Posting', 'edit') && on(rmod, 'Pause Requirement', 'edit') && on(rmod, 'Requirement Detail', 'delete') && !(rmod.locked && (rmod.locked['Requirement Detail'] || []).includes('delete')) && !(rmod.locked && (rmod.locked['Create Requirement'] || []).includes('create')), [rmod.locked, rmod.features['Requirement Detail'], rmod.features['Create Requirement']]);
    check('G5 Reports group: my clients / requirements / follow-ups ticked; Export assigned data now TICKED', on(pmod, 'My Clients Report', 'view') && on(pmod, 'My Requirements Report', 'view') && on(pmod, 'My Follow-ups Report', 'view') && on(pmod, 'Export Assigned Data', 'export'), null);
    const meA = await call('GET', '/api/auth/me', T.A);
    check('G6 The browser matrix (/auth/me) carries the new switches for the BDE', ok(meA) && !!(meA.body.permissions || meA.body.matrix || meA.body.access), Object.keys(meA.body || {}).slice(0, 12));

    // ============================ WORKSPACE NUMBERS (real counts) ============================
    const w = (await call('GET', '/api/clients/my-business', T.A)).body;
    const realOwn = await prisma.client.count({ where: { id: { in: [C.A.id, C.A2.id, C.A5.id, newId].filter(Boolean) } } });
    check('W1 My Clients = the clients assigned to me (not the desk)', w.counts.clients >= 4 && !w.clients.some((c) => [C.B.id, C.M.id].includes(c.id)) && w.clients.some((c) => c.id === C.A.id), [w.counts, realOwn]);
    check('W2 My Requirements = the jobs of my clients, not a colleague\'s', !w.requirements.some((r) => r.id === J.B.id) && w.requirements.some((r) => r.id === J.A.id), w.counts);
    check('W3 Pending approvals = my requests waiting (the close request of J.A was rejected, none waiting)', w.counts.pending === 0, w.counts);
    await call('POST', `/api/clients/${C.A5.id}/submit-approval`, T.A, { note: 'ZZTEST BW pending one' }); // a request that waits for a lead (the delete request is gone for the BDE team, 2026-10-16)
    check('W4 ... and counts a new one at once', (await call('GET', '/api/clients/my-business', T.A)).body.counts.pending === 1, null);
    const home = await call('GET', '/api/dashboard/ats/home', T.A);
    const wsW = home.body && (home.body.widgets || []).find((x) => x.type === 'workspace');
    check('W5 The Dashboard carries "My Business Workspace" with 4 tiles for a BDE', ok(home) && !!wsW && wsW.tiles.length === 4 && wsW.title === 'My Business Workspace', home.status);
    const homeTl = await call('GET', '/api/dashboard/ats/home', T.bdeTl);
    check('W6 The BDE TL keeps the team page (no workspace widget, BDE team box present)', ok(homeTl) && !(homeTl.body.widgets || []).some((x) => x.type === 'workspace'), homeTl.status);

    // ============================ THE THREE BDE REPORTS (a tab of ATS Reports) ============================
    const rc = await call('GET', '/api/clients/my-reports/clients', T.A);
    check('Q1 Report "My clients": my clients only, with the real columns', ok(rc) && rc.body.rows.some((r) => r.id === C.A.id) && !rc.body.rows.some((r) => [C.B.id, C.M.id].includes(r.id)) && rc.body.columns.length >= 6, rc.body && rc.body.total);
    const rr2 = await call('GET', '/api/clients/my-reports/requirements', T.A);
    check('Q2 Report "My requirements": the jobs of my clients, not a colleague\'s', ok(rr2) && rr2.body.rows.some((r) => r.id === J.A.id) && !rr2.body.rows.some((r) => r.id === J.B.id), rr2.body && rr2.body.total);
    const rf = await call('GET', '/api/clients/my-reports/followups', T.A);
    check('Q3 Report "My follow-ups": lists the meeting I set, with its state', ok(rf) && rf.body.rows.some((r) => r.kind === 'Meeting' && r.state === 'Today'), rf.body && rf.body.rows);
    check('Q4 Download is ON by default now (Export assigned data ticked)', (await call('GET', '/api/clients/my-reports/clients?format=csv', T.A)).status === 200, null);
    const csvR = await call('GET', '/api/clients/my-reports/clients?format=csv', T.A);
    check('Q5 ... tick it and the BDE downloads their own rows only (and it is in the audit log)', csvR.status === 200 && csvR.text.includes(C.A.name) && !csvR.text.includes(C.B.name) && (await prisma.auditLog.count({ where: { action: 'Report exported', userId: uA.id } })) >= 1, [csvR.status]);
    await setBde('reports', 'Export Assigned Data', 'export', false);
    check('Q5b Untick it and the download is refused', (await call('GET', '/api/clients/my-reports/clients?format=csv', T.A)).status === 403, null);
    await setBde('reports', 'Export Assigned Data', 'export', true);
    check('Q6 A recruiter and a TL get no business reports', (await call('GET', '/api/clients/my-reports/clients', T.rec)).status === 403 && (await call('GET', '/api/clients/my-reports/clients', T.tl)).status === 403, null);
    check('Q7 The report catalog tells the page to draw the card', (await call('GET', '/api/ats-reports/catalog', T.A)).body.myBusiness === true, null);

    // ============================ OTHER ROLES UNCHANGED ============================
    const z1 = await call('POST', `/api/clients/${C.B.id}/pause`, T.bdeTl, { reason: 'ZZTEST BW tl' });
    check('Z1 BDE TL pauses any client directly with a reason', ok(z1) && ok(await call('POST', `/api/clients/${C.B.id}/reactivate`, T.bdeTl, { reason: 'ZZTEST BW tl back' })), z1.body);
    const otherMgr = (await call('POST', `/api/clients/${C.B.id}/pause`, T.mgrM, { reason: 'ZZTEST BW mgr x' })).status;
    check('Z2 The Manager pauses a client of their department, not of another', otherMgr === 403 && ok(await call('POST', `/api/clients/${C.B.id}/pause`, T.mgr, { reason: 'ZZTEST BW mgr' })), otherMgr);
    await call('POST', `/api/clients/${C.B.id}/reactivate`, T.mgr, { reason: 'ZZTEST BW mgr back' });
    check('Z3 An Education TL sees the department\'s clients but cannot pause or ask', (await call('POST', `/api/clients/${C.B.id}/pause`, T.tl, { reason: 'ZZTEST BW x' })).status === 403 && (await call('POST', `/api/clients/${C.B.id}/request-delete`, T.tl, { reason: 'ZZTEST BW x' })).status === 403, null);
    check('Z4 Accounts reads clients, never changes or asks', (await call('POST', `/api/clients/${C.A.id}/pause`, T.acc, { reason: 'ZZTEST BW x' })).status === 403 && (await call('PUT', `/api/clients/${C.A.id}`, T.acc, { location: 'x' })).status === 403, null);
    check('Z5 A recruiter has no client requests', [403, 404].includes((await call('POST', `/api/clients/${C.A.id}/request-delete`, T.rec, { reason: 'ZZTEST BW x' })).status), null);
    // the BDE TL works EVERY client: real Edit, contacts, follow-ups, documents, and the asks
    const z7 = await call('PUT', `/api/clients/${C.B.id}`, T.bdeTl, { location: 'ZZ TL edit', contactName: 'ZZ TL contact' });
    check('Z7 BDE TL edits any client (details + contact people)', ok(z7), [z7.status, z7.body && z7.body.error]);
    check('Z8 BDE TL adds a follow-up, a note and feedback on any client', ok(await call('POST', `/api/clients/${C.B.id}/followups`, T.bdeTl, { kind: 'followup', title: 'ZZTEST BW tl follow', dueDate: today })) && ok(await call('POST', `/api/clients/${C.B.id}/notes`, T.bdeTl, { note: 'ZZTEST BW tl note', kind: 'call' })) && ok(await call('POST', `/api/clients/${C.B.id}/feedback`, T.bdeTl, { note: 'ZZTEST BW tl feedback' })), null);
    const tlUp = await upload(T.bdeTl, C.B.id);
    check('Z9 BDE TL uploads a client document to any client', tlUp.status === 201, tlUp);
    const tlLc = await call('GET', `/api/clients/${C.B.id}`, T.bdeTl);
    check('Z10 BDE TL gets DIRECT Pause / Resume (no "Ask to pause") and DIRECT Delete (no "Ask to delete", 2026-10-16)', tlLc.body.lifecycleActions.pause === true && tlLc.body.lifecycleActions.requestPause === false && tlLc.body.lifecycleActions.delete === true && tlLc.body.lifecycleActions.requestDelete === false && tlLc.body.lifecycleActions.requestDeactivate === false, tlLc.body.lifecycleActions);
    const ownLc = await call('GET', `/api/clients/${C.A.id}`, T.A);
    check('Z11 BDE gets DIRECT Pause / Resume and DIRECT Delete on own client (owner, merge, deactivate are direct too)', ownLc.body.lifecycleActions.pause === true && ownLc.body.lifecycleActions.requestPause === false && ownLc.body.lifecycleActions.delete === true && ownLc.body.lifecycleActions.requestDelete === false && ownLc.body.lifecycleActions.changeOwner === true && ownLc.body.lifecycleActions.mergeNow === true && ownLc.body.lifecycleActions.deactivate === true && ownLc.body.lifecycleActions.requestDeactivate === false, ownLc.body.lifecycleActions);
    check('Z6 BDE TL still closes a job directly (their rule did not change)', ok(await call('POST', `/api/requirements/${J.A.id}/close`, T.bdeTl, { outcome: 'filled' })), null);
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      // remove the Role Catalog rows this test wrote (sandbox), then the follow-up rows and the documents
      if (touched.size) await prisma.roleAccess.deleteMany({ where: { role: 'BDE', moduleId: { in: [...touched] } } });
      const left = await Z.cleanup([
        (p) => p.clientMerge.deleteMany({ where: { OR: [{ primaryId: { in: Z.made.clients } }, { donorSnapshot: { contains: 'ZZTEST BW' } }] } }),
        (p) => p.appSetting.deleteMany({ where: { key: { startsWith: 'clientfu.' }, updatedByName: { contains: 'ZZTEST BW' } } }),
        (p) => p.appSetting.deleteMany({ where: { key: { startsWith: 'clientfu.' }, value: { contains: 'ZZTEST BW' } } }),
      ]);
      console.log('leftovers after cleanup:', JSON.stringify(left));
      Z.check('Z cleanup: nothing ZZTEST BW is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();
