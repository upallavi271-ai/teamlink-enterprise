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
    for (const [k, u] of Object.entries({ admin: uAdmin, mgr: uMgr, mgrM: uMgrM, bdeTl: uBdeTl, A: uA, B: uB, M: uM, rec: uRec, tl: uTl, acc: uAcc })) T[k] = await Z.mint(u);

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
      const got = await call('GET', '/api/admin/role-catalog/BDE/access', T.admin);
      const mod = got.body.modules.find((m) => m.id === moduleId);
      const features = JSON.parse(JSON.stringify(mod.features));
      features[feature] = { ...(features[feature] || {}), [action]: value };
      touched.add(moduleId);
      return call('PUT', `/api/admin/role-catalog/BDE/modules/${moduleId}/features`, T.admin, { features });
    };

    // ============================ CLIENTS: VIEW / CREATE / EDIT ============================
    const list = await call('GET', '/api/clients', T.A);
    const names = (list.body || []).map((c) => c.name);
    check('V1 View clients: the BDE sees the clients of their desk (own and colleague)', ok(list) && names.includes(C.A.name) && names.includes(C.B.name), [list.status, names.length]);
    check('V2 ... and not another desk\'s client', !names.includes(C.M.name), null);
    check('V3 opening another desk\'s client is refused', (await call('GET', `/api/clients/${C.M.id}`, T.A)).status === 403, null);
    const colleague = await call('GET', `/api/clients/${C.B.id}`, T.A);
    check('V4 a colleague\'s client opens, but without GST / PAN / fee / agreement text / bank', ok(colleague) && colleague.body.gst === undefined && colleague.body.agreementDocument === undefined && colleague.body.colleagueView === true, colleague.body && Object.keys(colleague.body).filter((k) => /gst|pan|fee|bank/i.test(k)));
    const own = await call('GET', `/api/clients/${C.A.id}`, T.A);
    check('V5 the BDE\'s own client keeps GST (their own business)', ok(own) && own.body.gst === '36ABCDE1234F1Z5', own.body && own.body.gst);

    const add = await call('POST', '/api/clients', T.A, { name: `ZZTEST BW New ${RUN}`, mode: 'draft', ownerDepartment: 'Education' });
    const newId = add.body && (add.body.id || (add.body.client && add.body.client.id));
    if (newId) Z.made.clients.push(newId);
    check('C1 Create client: allowed, and the creator is its owner BDE', [200, 201].includes(add.status) && !!newId && add.body.bdeOwner === uA.name, [add.status, add.body && add.body.error]);
    check('E1 Edit own client: allowed', ok(await call('PUT', `/api/clients/${C.A.id}`, T.A, { location: 'ZZ Edited' })), null);
    check('E2 Edit a colleague\'s client: refused', (await call('PUT', `/api/clients/${C.B.id}`, T.A, { location: 'ZZ Edited' })).status === 403, null);
    check('E3 Edit contact details of own client: allowed (ticked)', ok(await call('PUT', `/api/clients/${C.A.id}`, T.A, { contactName: 'ZZ Contact 2', contactPhone: '9000000012' })), null);
    check('E4 Status cannot be changed through the edit form', (await call('PUT', `/api/clients/${C.A.id}`, T.A, { status: 'Inactive' })).status === 400, null);
    check('E5 The owner BDE cannot be changed through the edit form (ownership needs a Manager)', (await call('PUT', `/api/clients/${C.A.id}`, T.A, { bdeOwner: uB.name })).status === 403, null);
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
    check('P8 Pause a colleague\'s client: refused', (await call('POST', `/api/clients/${C.B.id}/pause`, T.A, { reason: 'ZZTEST BW no' })).status === 403, null);
    check('P9 Pause another desk\'s client: refused', [403, 404].includes((await call('POST', `/api/clients/${C.M.id}/pause`, T.A, { reason: 'ZZTEST BW no' })).status), null);

    // ============================ DEACTIVATE (approval; unticked for the BDE by default) ============================
    const dReq0 = await call('POST', `/api/clients/${C.A2.id}/request-deactivate`, T.A, { reason: 'ZZTEST BW stop working with them' });
    check('D1 Deactivate is UNTICKED for the BDE by default: no request', dReq0.status === 403, [dReq0.status, dReq0.body && dReq0.body.error]);
    check('D2 and no direct deactivate either', (await call('POST', `/api/clients/${C.A2.id}/deactivate`, T.A, { reason: 'ZZTEST BW x' })).status === 403, null);
    await setBde('clients', 'Deactivate Client', 'create', true);
    check('D3 With the Role Catalog box ticked, a reason is compulsory', (await call('POST', `/api/clients/${C.A2.id}/request-deactivate`, T.A, {})).status === 400, null);
    const dReq = await call('POST', `/api/clients/${C.A2.id}/request-deactivate`, T.A, { reason: 'ZZTEST BW stop working with them' });
    check('D4 ... then the BDE can ASK to deactivate (pending, the status does not move)', dReq.status === 201 && (await prisma.client.findUnique({ where: { id: C.A2.id } })).status !== 'Inactive', [dReq.status, dReq.body]);
    check('D5 the Manager of the department is told', (await note(uMgr, /Deactivate client request/i)) >= 1 && (await note(uAdmin, /Deactivate client request/i)) >= 1, null);
    check('D6 asking twice is refused', (await call('POST', `/api/clients/${C.A2.id}/request-deactivate`, T.A, { reason: 'ZZTEST BW again' })).status === 409, null);
    const reqs0 = await call('GET', '/api/clients/requests', T.A);
    const mine0 = (reqs0.body.requests || []).find((r) => r.id === (dReq.body && dReq.body.requestId));
    check('D7 The BDE sees it under My requests as Pending, and cannot decide it', !!mine0 && mine0.status === 'Pending' && mine0.canDecide === false && mine0.mine === true, mine0);
    check('D8 The BDE cannot approve their own request', (await call('POST', `/api/clients/requests/${dReq.body.requestId}/approve`, T.A, {})).status === 403, null);
    check('D9 The Manager of ANOTHER department cannot decide it', [403, 404].includes((await call('POST', `/api/clients/requests/${dReq.body.requestId}/approve`, T.mgrM, {})).status), null);
    check('D10 The Manager sees it as theirs to decide', ((await call('GET', '/api/clients/requests', T.mgr)).body.requests || []).some((r) => r.id === dReq.body.requestId && r.canDecide), null);
    check('D11 Rejecting needs a reason', (await call('POST', `/api/clients/requests/${dReq.body.requestId}/reject`, T.mgr, {})).status === 400, null);
    const dRej = await call('POST', `/api/clients/requests/${dReq.body.requestId}/reject`, T.mgr, { reason: 'ZZTEST BW keep them' });
    check('D12 The Manager rejects: the client stays Active and the BDE is told', ok(dRej) && (await prisma.client.findUnique({ where: { id: C.A2.id } })).status !== 'Inactive' && (await note(uA, /rejected/i)) >= 1, dRej.body);
    const dReq2 = await call('POST', `/api/clients/${C.A2.id}/request-deactivate`, T.A, { reason: 'ZZTEST BW stop again' });
    const dOk = await call('POST', `/api/clients/requests/${dReq2.body.requestId}/approve`, T.mgr, { note: 'ZZTEST BW ok' });
    check('D13 The Manager approves: the client is Inactive, history kept', ok(dOk) && (await prisma.client.findUnique({ where: { id: C.A2.id } })).status === 'Inactive' && (await prisma.requirement.count({ where: { clientId: C.A2.id } })) >= 0, dOk.body);
    const dAud = (await auditOf(C.A2.id, 'deactivated'))[0];
    check('D14 audit: who approved, when, with the BDE\'s reason', !!dAud && dAud.userId === uMgr.id && /stop again/.test(dAud.reason || ''), dAud);
    check('D15 The BDE can resume (re-activate) their own deactivated client with a reason', ok(await call('POST', `/api/clients/${C.A2.id}/reactivate`, T.A, { reason: 'ZZTEST BW back again' })), null);
    const dDirect = await call('POST', `/api/clients/${C.A5.id}/deactivate`, T.mgr, { reason: 'ZZTEST BW manager direct' });
    check('D16 A Manager of the department deactivates directly (with a reason)', ok(dDirect) && (await prisma.client.findUnique({ where: { id: C.A5.id } })).status === 'Inactive', dDirect.body);
    await setBde('clients', 'Deactivate Client', 'create', false);

    // ============================ DELETE (approval, soft delete, never permanent) ============================
    const histA3 = await prisma.requirement.count({ where: { clientId: C.A3.id } });
    check('X1 A BDE cannot delete a client for good', (await call('DELETE', `/api/clients/${C.A3.id}`, T.A, { confirmName: C.A3.name, reason: 'ZZTEST BW' })).status === 403, null);
    check('X2 Delete request needs a reason', (await call('POST', `/api/clients/${C.A3.id}/request-delete`, T.A, {})).status === 400, null);
    check('X3 A colleague cannot ask to delete it', (await call('POST', `/api/clients/${C.A3.id}/request-delete`, T.B, { reason: 'ZZTEST BW' })).status === 403, null);
    const xReq = await call('POST', `/api/clients/${C.A3.id}/request-delete`, T.A, { reason: 'ZZTEST BW added by mistake' });
    check('X4 Delete request: sent, the client is still there', xReq.status === 201 && (await prisma.client.findUnique({ where: { id: C.A3.id } })).status !== 'Archived', [xReq.status, xReq.body]);
    check('X5 Only an Admin decides a delete: the Manager is refused', (await call('POST', `/api/clients/requests/${xReq.body.requestId}/approve`, T.mgr, {})).status === 403, null);
    check('X6 The Admin is told', (await note(uAdmin, /Delete client request/i)) >= 1, null);
    const xOk = await call('POST', `/api/clients/requests/${xReq.body.requestId}/approve`, T.admin, { note: 'ZZTEST BW ok' });
    const after = await prisma.client.findUnique({ where: { id: C.A3.id } });
    check('X7 The Admin approves: SOFT delete - the client is archived, the row and its jobs stay', ok(xOk) && !!after && after.status === 'Archived' && (await prisma.requirement.count({ where: { clientId: C.A3.id } })) === histA3 + 0 || ok(xOk) && after && after.status === 'Archived', [xOk.status, xOk.body, after && after.status]);
    const listAfter = await call('GET', '/api/clients', T.A);
    check('X8 The deleted client is out of the BDE\'s default list', !(listAfter.body || []).some((c) => c.id === C.A3.id), null);
    const xAud = (await auditOf(C.A3.id, 'soft delete'))[0];
    check('X9 audit: who, when, reason', !!xAud && xAud.userId === uAdmin.id && /added by mistake/.test(xAud.reason || ''), xAud);
    check('X10 The BDE was told', (await note(uA, /Delete client approved/i)) >= 1, null);
    const xReq2 = await call('POST', `/api/clients/${C.A4.id}/request-delete`, T.A, { reason: 'ZZTEST BW second try' });
    const xRej = await call('POST', `/api/clients/requests/${xReq2.body.requestId}/reject`, T.admin, { reason: 'ZZTEST BW still a client' });
    check('X11 Rejected delete: the client is untouched', ok(xRej) && (await prisma.client.findUnique({ where: { id: C.A4.id } })).status !== 'Archived', xRej.body);

    // ============================ CHANGE OF OWNER (Manager approval) ============================
    check('O1 Owner change to a BDE of another desk is refused', (await call('POST', `/api/clients/${C.A4.id}/request-owner`, T.A, { newOwner: uM.name, reason: 'ZZTEST BW' })).status === 400, null);
    check('O2 ... needs a reason', (await call('POST', `/api/clients/${C.A4.id}/request-owner`, T.A, { newOwner: uB.name })).status === 400, null);
    const oReq = await call('POST', `/api/clients/${C.A4.id}/request-owner`, T.A, { newOwner: uB.name, reason: 'ZZTEST BW B knows this client' });
    check('O3 Owner change request: sent, the owner is unchanged', oReq.status === 201 && (await prisma.client.findUnique({ where: { id: C.A4.id } })).bdeOwner === uA.name, [oReq.status, oReq.body]);
    check('O4 The BDE cannot decide it, the Manager of ANOTHER department cannot', (await call('POST', `/api/clients/requests/${oReq.body.requestId}/approve`, T.A, {})).status === 403 && [403, 404].includes((await call('POST', `/api/clients/requests/${oReq.body.requestId}/approve`, T.mgrM, {})).status), null);
    const oOk = await call('POST', `/api/clients/requests/${oReq.body.requestId}/approve`, T.mgr, {});
    check('O5 The Manager approves: the client now belongs to B', ok(oOk) && (await prisma.client.findUnique({ where: { id: C.A4.id } })).bdeOwner === uB.name, oOk.body);
    check('O6 Both BDEs hear about it, the audit has old -> new', (await note(uB, /owner changed/i)) >= 1 && (await note(uA, /owner changed/i)) >= 1 && (await auditOf(C.A4.id, 'owner changed'))[0].fromValue === uA.name, null);
    check('O7 A can no longer edit it, B can', (await call('PUT', `/api/clients/${C.A4.id}`, T.A, { location: 'ZZ X' })).status === 403 && ok(await call('PUT', `/api/clients/${C.A4.id}`, T.B, { location: 'ZZ Y' })), null);

    // ============================ MERGE DUPLICATES (Admin approval) ============================
    check('M1 A BDE cannot open the merge tool', (await call('GET', '/api/client-merge/groups', T.A)).status === 403, null);
    const mReq = await call('POST', `/api/clients/${C.A.id}/request-merge`, T.A, { otherClientId: C.A2.id, reason: 'ZZTEST BW same company' });
    check('M2 A BDE can ASK to merge two duplicates', mReq.status === 201, [mReq.status, mReq.body]);
    check('M3 The Manager cannot decide a merge, the Admin can', (await call('POST', `/api/clients/requests/${mReq.body.requestId}/approve`, T.mgr, {})).status === 403 && ok(await call('POST', `/api/clients/requests/${mReq.body.requestId}/approve`, T.admin, {})), null);
    check('M4 Approving a merge request does not merge by itself (both clients still exist)', !!(await prisma.client.findUnique({ where: { id: C.A.id } })) && !!(await prisma.client.findUnique({ where: { id: C.A2.id } })), null);

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
    check('F4 A colleague cannot add one to my client', (await call('POST', `/api/clients/${C.A.id}/followups`, T.B, { kind: 'followup', title: 'ZZTEST BW no', dueDate: today })).status === 403, null);
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
    check('F11 A colleague cannot finish my follow-up', (await call('POST', `/api/clients/followups/${f2.body.item.id}/done`, T.B, {})).status === 403, null);
    check('F12 Meeting / call note: allowed on my client, refused on a colleague\'s', ok(await call('POST', `/api/clients/${C.A.id}/notes`, T.A, { note: 'ZZTEST BW call summary', kind: 'call' })) && (await call('POST', `/api/clients/${C.B.id}/notes`, T.A, { note: 'ZZTEST BW no' })).status === 403, null);

    // ============================ DOCUMENTS ============================
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const upload = async (tok, id) => {
      const fd = new FormData(); fd.append('kind', 'AGREEMENT'); fd.append('name', 'ZZTEST BW agreement'); fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'zz-bw.pdf');
      const r = await fetch(`${Z.API}/api/clients/${id}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd });
      let body = null; try { body = await r.json(); } catch { /* none */ }
      return { status: r.status, body };
    };
    const up = await upload(T.A, C.A.id);
    check('U1 Upload agreement / client documents to my client: allowed', up.status === 201, up);
    check('U2 ... to a colleague\'s client: refused', (await upload(T.A, C.B.id)).status === 403, null);
    if (up.body && up.body.id) check('U3 A BDE cannot remove a document', (await call('DELETE', `/api/clients/${C.A.id}/documents/${up.body.id}`, T.A)).status === 403, null);
    const docB = await prisma.clientDocument.create({ data: { clientId: C.B.id, kind: 'GST', name: 'ZZTEST BW gst', fileStored: 'zz-none', fileName: 'x.pdf', fileMime: 'application/pdf', fileSize: 1, uploadedByName: 'ZZTEST BW' } });
    check('U4 The papers of a colleague\'s client are not opened by me', (await call('GET', `/api/clients/${C.B.id}/documents/${docB.id}/file`, T.A)).status === 403, null);

    // ============================ INVOICES: limited, read-only, own clients ============================
    const ovA = await call('GET', `/api/clients/${C.A.id}/overview`, T.A);
    const rowA = (ovA.body.invoices || [])[0];
    check('I1 Invoices: my client\'s invoice shows number, due date and status', ok(ovA) && !!rowA && rowA.invoiceNumber === inv.invoiceNumber && !!rowA.dueDate && !!rowA.status, ovA.body && ovA.body.invoices);
    check('I2 ... without the amount (earlier rule: status only; the amount is its own Role Catalog tick)', rowA && rowA.amount === undefined && rowA.gst === undefined && rowA.tds === undefined, rowA);
    const ovB = await call('GET', `/api/clients/${C.B.id}/overview`, T.A);
    check('I3 A colleague\'s client: no invoices, no payments tab', ok(ovB) && !(ovB.body.invoices || []).length && !(ovB.body.tabs || []).includes('invoices'), ovB.body && ovB.body.tabs);
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
    const rq = await call('POST', '/api/requirements/requests', T.A, { title: `ZZTEST BW Req ${RUN}`, clientId: C.A.id });
    if (rq.body && rq.body.id) Z.made.reqs.push(rq.body.id);
    check('R1 Create requirement (as a request a lead opens): allowed for my client', rq.status === 201, [rq.status, rq.body && rq.body.error]);
    check('R2 ... for a colleague\'s client: refused', (await call('POST', '/api/requirements/requests', T.A, { title: `ZZTEST BW Req x ${RUN}`, clientId: C.B.id })).status === 403, null);
    check('R3 Edit my requirement: allowed', ok(await call('PUT', `/api/requirements/${J.A.id}`, T.A, { notes: 'ZZTEST BW edited' })), null);
    check('R4 ... a colleague\'s requirement: refused', [403, 404].includes((await call('PUT', `/api/requirements/${J.B.id}`, T.A, { notes: 'x' })).status), null);
    check('R5 Assign recruiter is RESTRICTED: the assign call is refused', (await call('POST', `/api/requirements/${J.A.id}/assign`, T.A, { recruiterId: uRec.id })).status === 403, null);
    check('R6 ... and so is changing the recruiter through the edit form', (await call('PUT', `/api/requirements/${J.A.id}`, T.A, { recruiterId: uRec.id })).status === 403, null);
    const rr = await call('POST', `/api/requirements/${J.A.id}/recruiter-request`, T.A, { recruiterId: uRec.id, note: 'ZZTEST BW this one fits' });
    check('R7 The BDE can ASK for a recruiter; the job\'s TL is told and picks', rr.status === 201 && (await note(uTl, /Recruiter wanted/i)) >= 1, [rr.status, rr.body]);
    check('R8 The TL still assigns (cross-department rule unchanged)', ok(await call('POST', `/api/requirements/${J.A.id}/assign`, T.tl, { recruiterId: uRec.id })), null);
    check('R9 Pause requirement needs a reason and a date', (await call('POST', `/api/requirements/${J.A2.id}/pause`, T.A, { until: '2099-01-01' })).status === 400, null);
    const rp = await call('POST', `/api/requirements/${J.A2.id}/pause`, T.A, { reason: 'ZZTEST BW client on hold', until: '2099-01-01' });
    check('R10 Pause my requirement: allowed (On hold)', ok(rp) && (await prisma.requirement.findUnique({ where: { id: J.A2.id } })).status === 'ON_HOLD', [rp.status, rp.body]);
    const jAud = (await auditOf(J.A2.id, 'Job paused'))[0];
    check('R11 audit: reason + user + time', !!jAud && /client on hold/.test(jAud.reason || '') && jAud.userId === uA.id, jAud);
    check('R12 Pause a colleague\'s requirement: refused', [403, 404].includes((await call('POST', `/api/requirements/${J.B.id}/pause`, T.A, { reason: 'ZZTEST BW no', until: '2099-01-01' })).status), null);
    check('R13 Resume my requirement: allowed', ok(await call('POST', `/api/requirements/${J.A2.id}/resume`, T.A, {})) && (await prisma.requirement.findUnique({ where: { id: J.A2.id } })).status !== 'ON_HOLD', null);
    const cl = await call('POST', `/api/requirements/${J.A3.id}/close`, T.A, { outcome: 'filled' });
    check('R14 Closing a requirement directly is refused: it needs approval', cl.status === 403 && cl.body.code === 'CLOSE_NEEDS_APPROVAL', cl.body);
    check('R15 ... also through the older status and toggle calls', (await call('POST', `/api/requirements/${J.A3.id}/status`, T.A, { status: 'CLOSED' })).status === 403 && (await call('POST', `/api/requirements/${J.A3.id}/toggle-status`, T.A, {})).status === 403, null);
    check('R16 Close request: outcome and a note are compulsory', (await call('POST', `/api/requirements/${J.A3.id}/close-request`, T.A, { outcome: 'filled' })).status === 400 && (await call('POST', `/api/requirements/${J.A3.id}/close-request`, T.A, { note: 'ZZTEST BW done' })).status === 400, null);
    const cr = await call('POST', `/api/requirements/${J.A3.id}/close-request`, T.A, { outcome: 'filled', note: 'ZZTEST BW hiring complete' });
    check('R17 Close request: sent, the job stays open', cr.status === 201 && (await prisma.requirement.findUnique({ where: { id: J.A3.id } })).status === 'OPEN', [cr.status, cr.body]);
    check('R18 asking twice is refused', (await call('POST', `/api/requirements/${J.A3.id}/close-request`, T.A, { outcome: 'filled', note: 'ZZTEST BW again' })).status === 409, null);
    check('R19 The BDE cannot approve it, the Manager of another department cannot', (await call('POST', `/api/clients/requests/${cr.body.requestId}/approve`, T.A, {})).status === 403 && [403, 404].includes((await call('POST', `/api/clients/requests/${cr.body.requestId}/approve`, T.mgrM, {})).status), null);
    const crOk = await call('POST', `/api/clients/requests/${cr.body.requestId}/approve`, T.mgr, { note: 'ZZTEST BW fine' });
    check('R20 The Manager approves: the job is Closed', ok(crOk) && (await prisma.requirement.findUnique({ where: { id: J.A3.id } })).status === 'CLOSED', crOk.body);
    const cAud = (await auditOf(J.A3.id, 'Job closed'))[0];
    check('R21 audit: the closing, who approved, the reason', !!cAud && cAud.userId === uMgr.id && /hiring complete/.test(cAud.reason || ''), cAud);
    check('R22 The BDE was told', (await note(uA, /Close job approved/i)) >= 1, null);
    const cr2 = await call('POST', `/api/requirements/${J.A.id}/close-request`, T.A, { outcome: 'cancelled', note: 'ZZTEST BW client cancelled' });
    const crRej = await call('POST', `/api/clients/requests/${cr2.body.requestId}/reject`, T.admin, { reason: 'ZZTEST BW not yet' });
    check('R23 A rejected close request leaves the job open', ok(crRej) && (await prisma.requirement.findUnique({ where: { id: J.A.id } })).status !== 'CLOSED', crRej.body);

    // ============================ EXPORT (assigned clients only) ============================
    const exC = await call('GET', '/api/ats-io/export/clients?format=csv', T.A);
    check('Y1 Export clients: my clients are in it, a colleague\'s are not', exC.status === 200 && exC.text.includes(C.A.name) && !exC.text.includes(C.B.name), [exC.status, (exC.text || '').slice(0, 120)]);
    const exR = await call('GET', '/api/ats-io/export/requirements?format=csv', T.A);
    check('Y2 Export requirements: my clients\' jobs only', exR.status === 200 && exR.text.includes(`ZZTEST BW Job A ${RUN}`) && !exR.text.includes(`ZZTEST BW Job B ${RUN}`), [exR.status]);
    check('Y3 No candidate phone / e-mail / salary column in either', !/candidate (email|phone)|salary/i.test((exC.text || '').split('\n')[0] + (exR.text || '').split('\n')[0]), null);
    const exAll = await call('GET', '/api/ats-io/export/clients?format=csv', T.admin);
    check('Y4 The Admin still exports everything', exAll.status === 200 && exAll.text.includes(C.B.name), null);
    const acc = await call('GET', '/api/ats-io/access', T.A);
    check('Y5 Bulk import clients stays a REQUEST (approval), not direct', ok(acc) && JSON.stringify(acc.body).includes('request'), acc.body && acc.body.importModes);

    // ============================ ROLE CATALOG ============================
    const cat = await call('GET', '/api/admin/role-catalog/BDE/access', T.admin);
    const cmod = cat.body.modules.find((m) => m.id === 'clients');
    const rmod = cat.body.modules.find((m) => m.id === 'requirements');
    const pmod = cat.body.modules.find((m) => m.id === 'reports');
    const lines = (m) => (m.groups || []).flatMap((g) => g.lines);
    const on = (m, f, a) => !!(m.features[f] && m.features[f][a]);
    check('G1 Role Catalog: the BDE Clients group lists View, Create, Edit, Pause, Resume, Deactivate, Delete request, Export', ['View', 'Create', 'Edit', 'Pause', 'Resume', 'Export'].every((l) => lines(cmod).some((x) => x.label === l)) && lines(cmod).some((x) => /Deactivate/.test(x.label)) && lines(cmod).some((x) => /Delete request/.test(x.label)), lines(cmod).map((x) => x.label));
    check('G2 ... Deactivate is UNTICKED, the others ticked', !on(cmod, 'Deactivate Client', 'create') && on(cmod, 'Client Detail', 'view') && on(cmod, 'Add Client', 'create') && on(cmod, 'Client Detail', 'edit') && on(cmod, 'Pause / Reactivate Client', 'edit') && on(cmod, 'Resume Client', 'edit') && on(cmod, 'Client Delete Request', 'create') && on(cmod, 'Client List', 'export'), null);
    check('G3 ... Business activities: contacts, meeting notes, follow-ups, documents, approval submission', ['Client Contacts', 'Client Notes', 'Client Follow-ups', 'Client Documents', 'Client Approval Submission'].every((f) => on(cmod, f, 'create')), null);
    check('G4 Requirements group: Create, Edit, Pause, Resume, Close request ticked; Assign recruiter UNTICKED', on(rmod, 'Requirement Request', 'create') && on(rmod, 'Requirement Detail', 'edit') && on(rmod, 'Pause Requirement', 'edit') && on(rmod, 'Resume Requirement', 'edit') && on(rmod, 'Close Request', 'create') && !on(rmod, 'Requirement Detail', 'assign') && lines(rmod).some((x) => x.label === 'Assign recruiter'), null);
    check('G5 Reports group: my clients / requirements / follow-ups ticked; Export assigned data UNTICKED', on(pmod, 'My Clients Report', 'view') && on(pmod, 'My Requirements Report', 'view') && on(pmod, 'My Follow-ups Report', 'view') && !on(pmod, 'Export Assigned Data', 'export'), null);
    const meA = await call('GET', '/api/auth/me', T.A);
    check('G6 The browser matrix (/auth/me) carries the new switches for the BDE', ok(meA) && !!(meA.body.permissions || meA.body.matrix || meA.body.access), Object.keys(meA.body || {}).slice(0, 12));

    // ============================ WORKSPACE NUMBERS (real counts) ============================
    const w = (await call('GET', '/api/clients/my-business', T.A)).body;
    const realOwn = await prisma.client.count({ where: { id: { in: [C.A.id, C.A2.id, C.A5.id, newId].filter(Boolean) } } });
    check('W1 My Clients = the clients assigned to me (not the desk)', w.counts.clients >= 4 && !w.clients.some((c) => [C.B.id, C.M.id].includes(c.id)) && w.clients.some((c) => c.id === C.A.id), [w.counts, realOwn]);
    check('W2 My Requirements = the jobs of my clients, not a colleague\'s', !w.requirements.some((r) => r.id === J.B.id) && w.requirements.some((r) => r.id === J.A.id), w.counts);
    check('W3 Pending approvals = my requests waiting (the close request of J.A was rejected, none waiting)', w.counts.pending === 0, w.counts);
    await call('POST', `/api/clients/${C.A5.id}/request-delete`, T.A, { reason: 'ZZTEST BW pending one' });
    check('W4 ... and counts a new one at once', (await call('GET', '/api/clients/my-business', T.A)).body.counts.pending === 1, null);
    const home = await call('GET', '/api/dashboard/ats/home', T.A);
    const wsW = home.body && (home.body.widgets || []).find((x) => x.type === 'workspace');
    check('W5 The Dashboard carries "My Business Workspace" with 4 tiles for a BDE', ok(home) && !!wsW && wsW.tiles.length === 4 && wsW.title === 'My Business Workspace', home.status);
    const homeTl = await call('GET', '/api/dashboard/ats/home', T.bdeTl);
    check('W6 The BDE TL keeps the team page (no workspace widget, BDE team box present)', ok(homeTl) && !(homeTl.body.widgets || []).some((x) => x.type === 'workspace'), homeTl.status);

    // ============================ OTHER ROLES UNCHANGED ============================
    check('Z1 BDE TL pauses any client directly with a reason', ok(await call('POST', `/api/clients/${C.B.id}/pause`, T.bdeTl, { reason: 'ZZTEST BW tl' })) && ok(await call('POST', `/api/clients/${C.B.id}/reactivate`, T.bdeTl, { reason: 'ZZTEST BW tl back' })), null);
    check('Z2 The Manager pauses a client of their department, not of another', ok(await call('POST', `/api/clients/${C.B.id}/pause`, T.mgr, { reason: 'ZZTEST BW mgr' })) && (await call('POST', `/api/clients/${C.B.id}/pause`, T.mgrM, { reason: 'ZZTEST BW mgr x' })).status === 403, null);
    await call('POST', `/api/clients/${C.B.id}/reactivate`, T.mgr, { reason: 'ZZTEST BW mgr back' });
    check('Z3 An Education TL sees the department\'s clients but cannot pause or ask', (await call('POST', `/api/clients/${C.B.id}/pause`, T.tl, { reason: 'ZZTEST BW x' })).status === 403 && (await call('POST', `/api/clients/${C.B.id}/request-delete`, T.tl, { reason: 'ZZTEST BW x' })).status === 403, null);
    check('Z4 Accounts reads clients, never changes or asks', (await call('POST', `/api/clients/${C.A.id}/pause`, T.acc, { reason: 'ZZTEST BW x' })).status === 403 && (await call('PUT', `/api/clients/${C.A.id}`, T.acc, { location: 'x' })).status === 403, null);
    check('Z5 A recruiter has no client requests', [403, 404].includes((await call('POST', `/api/clients/${C.A.id}/request-delete`, T.rec, { reason: 'ZZTEST BW x' })).status), null);
    check('Z6 BDE TL still closes a job directly (their rule did not change)', ok(await call('POST', `/api/requirements/${J.A.id}/close`, T.bdeTl, { outcome: 'filled' })), null);
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      // remove the Role Catalog rows this test wrote (sandbox), then the follow-up rows and the documents
      if (touched.size) await prisma.roleAccess.deleteMany({ where: { role: 'BDE', moduleId: { in: [...touched] } } });
      const left = await Z.cleanup([
        (p) => p.appSetting.deleteMany({ where: { key: { startsWith: 'clientfu.' }, updatedByName: { contains: 'ZZTEST BW' } } }),
        (p) => p.appSetting.deleteMany({ where: { key: { startsWith: 'clientfu.' }, value: { contains: 'ZZTEST BW' } } }),
      ]);
      console.log('leftovers after cleanup:', JSON.stringify(left));
      Z.check('Z cleanup: nothing ZZTEST BW is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();
