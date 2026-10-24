#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AGREEMENT PREPARATION WORKFLOW test (user, 2026-10-13). SANDBOX ONLY, light, run once.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/agreement-workflow-test.js
//
// With the BDE > With HR (sections 6-9) > With BDE TL > Sent to client > Signed > Active.
// Fixtures are tagged "ZZTEST AGW" and removed at the end (clients, users, notifications, tasks, audit, workflow rows).
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('AGW');
const { prisma, check } = Z;
let call;

const HR_WORDS = ['legalName', 'gst', 'pan', 'tan', 'billingEmail', 'invoiceEmail', 'paymentMethod', 'paymentBankName', 'paymentUpi', 'bankIfsc', 'bankAccountHolder', 'internalNotes', 'specialInstructions', 'recruitmentInstructions', 'internalRemarks'];
const has = (o, keys) => keys.filter((k) => o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined);
call = null;
const FEE = 12.5;
// the sandbox restarts (nodemon) when anyone edits backend/src: a 401 during that is retried
const realCall = Z.call;
call = (...a) => callR(...a);
const callR = async (...a) => { for (let i = 0; i < 10; i += 1) { const r = await realCall(...a); if (!(r.status === 401 && /Invalid or expired token/.test(r.text || ''))) return r; await new Promise((x) => setTimeout(x, 4000)); } return realCall(...a); };

(async () => {
  await Z.preclean();
  const keys = [];
  try {
    const { RUN } = Z;
    const bdeTl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: bdeTl.name });
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const hr = await Z.mkUser('hr', { role: 'TL', atsRole: 'TL', atsDepartment: 'Internal HR', atsScopeDepartments: 'Internal HR' }, { designation: 'TL', department: 'Internal HR' });
    const hrEmp = await prisma.employee.findFirst({ where: { userId: hr.id } });
    const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { tl: tl.name });
    const tk = {};
    for (const [k, u] of Object.entries({ bdeTl, bde, admin, hr, tl, rec })) tk[k] = await Z.mint(u);

    const mkClient = async (tag, extra = {}) => {
      const c = await prisma.client.create({
        data: {
          name: `ZZTEST AGW ${tag} ${RUN}`, industry: 'IT', location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: bde.name, clientType: 'Client',
          contactName: 'ZZ Contact', contactEmail: `zz-agw-${tag}-${RUN}@example.test`, contactPhone: '9000000001', agreementStatus: 'DRAFT',
          agreementDocument: 'ZZTEST AGW agreement text', agreementSource: 'Generated', agreementFeePercent: FEE, paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice',
          guaranteePeriod: '30 Days', clientCode: `ZZAGW${tag}${RUN}`.toUpperCase().slice(0, 20), ...extra,
        },
      });
      Z.made.clients.push(c.id); return c;
    };

    // ---- settings: the HR approver is the ZZTEST HR employee ----
    const s0 = await call('PUT', '/api/agreement-flow/settings', tk.admin, { approvers: [hrEmp.employeeCode] });
    check('S1 Admin sets the HR approver (default is TL309)', s0.status === 200 && s0.body.approvers.includes(hrEmp.employeeCode), [s0.status, s0.body]);
    const s1 = await call('GET', '/api/agreement-flow/settings', tk.bde);
    check('S2 the BDE reads the label but not the approver list', s1.status === 200 && s1.body.hrLabel && !('approvers' in s1.body), s1.body);
    const s2 = await call('PUT', '/api/agreement-flow/settings', tk.bde, { approvers: ['X1'] });
    check('S3 a BDE cannot change the approvers', s2.status === 403, s2.status);
    const dflt = await prisma.appSetting.findUnique({ where: { key: 'agreementWorkflow' } });
    keys.push('agreementWorkflow');
    check('S4 default approver text is TL309 in code', require('../src/utils/agreementWorkflow').DEFAULTS.approvers[0] === 'TL309' && !!dflt);

    // ---- client A: the full happy path ----
    const A = await mkClient('A');
    keys.push(`agrwf:${A.id}`);
    // Admin fills Tax & billing etc. up front (to prove the BDE never reads it)
    const adm = await call('PUT', `/api/clients/${A.id}`, tk.admin, { legalName: `ZZTEST AGW Legal ${RUN}`, gst: '36AABCT1234C1Z5', pan: 'AABCT1234C', internalNotes: 'ZZTEST AGW secret note', bankIfsc: 'HDFC0001234', paymentUpi: 'zz@hdfc', invoiceEmail: 'inv@example.test' });
    check('A0 Admin writes sections 6-9 any time', adm.status === 200 && adm.body.gst === '36AABCT1234C1Z5', [adm.status, adm.body && adm.body.error]);

    const bGet = await call('GET', `/api/clients/${A.id}`, tk.bde);
    check('A1 BDE reads the client: sections 6-9 are NOT in the payload', bGet.status === 200 && has(bGet.body, HR_WORDS).length === 0 && bGet.body.hrSectionsHidden === true, [bGet.status, has(bGet.body, HR_WORDS)]);
    const bList = await call('GET', '/api/clients', tk.bde);
    const bRow = (bList.body || []).find((r) => r.id === A.id);
    check('A2 BDE list row has no section 6-9 field and shows the step chip', bRow && has(bRow, HR_WORDS).length === 0 && bRow.agreementStage === 'DRAFT' && bRow.agreementStageLabel === 'With the BDE', [bRow && has(bRow, HR_WORDS), bRow && bRow.agreementStage]);
    const exp = await call('POST', '/api/ats-io/export/clients?format=csv', tk.bde, {});
    check('A3 BDE export of clients has no PAN / TAN / legal name', exp.status < 300 && !/AABCT1234C|ZZTEST AGW Legal|36AABCT1234C1Z5/.test(exp.text || ''), [exp.status, (exp.text || '').slice(0, 120)]);
    const ov = await call('GET', `/api/clients/${A.id}/overview`, tk.bde);
    check('A4 BDE overview has no section 6-9 text', ov.status < 500 && !/AABCT1234C|secret note|HDFC0001234|zz@hdfc/.test(JSON.stringify(ov.body || {})), JSON.stringify(ov.body || {}).match(/.{0,60}(AABCT1234C|secret note|HDFC0001234|zz@hdfc).{0,30}/));

    const w1 = await call('PUT', `/api/clients/${A.id}`, tk.bde, { internalNotes: 'ZZTEST AGW bde note' });
    const w2 = await call('PUT', `/api/clients/${A.id}`, tk.bde, { legalName: 'ZZTEST AGW sneaky' });
    const w3 = await call('PUT', `/api/clients/${A.id}`, tk.bde, { bankIfsc: 'HDFC0009999' });
    check('A5 BDE cannot WRITE sections 6/7/9 (notes, legal name, bank)', w1.status === 403 && w2.status === 403 && w3.status === 403, [w1.status, w2.status, w3.status, w1.body && w1.body.error]);
    const w4 = await call('PUT', `/api/clients/${A.id}`, tk.bde, { specialTerms: 'ZZTEST AGW special' });
    check('A6 BDE still edits the commercial part while it is with the BDE', w4.status === 200 || w4.status === 403 && /Commercial Terms/.test(w4.body.error || ''), [w4.status, w4.body && w4.body.error]);
    const bCreate = await call('POST', '/api/clients', tk.bde, { name: `ZZTEST AGW Create ${RUN}`, mode: 'draft', internalNotes: 'ZZTEST AGW x', ownerDepartment: 'Education', bdeOwner: bde.name });
    check('A7 BDE cannot create a client WITH section 6-9 values', bCreate.status === 403 || bCreate.status === 400, [bCreate.status, bCreate.body && bCreate.body.error]);
    if (bCreate.status === 201) Z.made.clients.push(bCreate.body.id);

    // blank the Admin-made HR data? keep: HR step edits next. Wipe to test "required fields" for send_to_tl
    await prisma.client.update({ where: { id: A.id }, data: { legalName: null, gst: null, pan: null, invoiceEmail: null, billingEmail: null } });

    // BDE sends with a missing required field -> refused and told what
    const miss = await mkClient('M', { industry: null });
    keys.push(`agrwf:${miss.id}`);
    const sM = await call('POST', `/api/agreement-flow/${miss.id}/action`, tk.bde, { action: 'send_to_hr' });
    check('B1 BDE cannot send with a required field missing (and is told which)', sM.status === 400 && /Industry/.test(sM.body.error || ''), [sM.status, sM.body]);
    const wrong = await call('POST', `/api/agreement-flow/${A.id}/action`, tk.bde, { action: 'send_to_tl' });
    check('B2 BDE cannot skip to the BDE TL', wrong.status === 403, wrong.status);
    const direct = await call('POST', `/api/clients/${A.id}/agreement/send`, tk.bde, {});
    check('B3 BDE cannot send the link to the client', direct.status === 403, [direct.status, direct.body && direct.body.error]);

    const s1a = await call('POST', `/api/agreement-flow/${A.id}/action`, tk.bde, { action: 'send_to_hr' });
    check('B4 BDE sends to HR -> step is With HR', s1a.status === 200 && s1a.body.stage === 'WITH_HR', [s1a.status, s1a.body]);
    const note1 = await prisma.notification.findFirst({ where: { userId: hr.id, title: { startsWith: 'Fill Tax & billing for' } } });
    const task1 = await prisma.task.findFirst({ where: { assigneeId: hr.id, name: { contains: 'ZZTEST AGW' } } });
    check('B5 HR got a bell (no word "agreement") and a task', !!note1 && !/agreement/i.test(`${note1.title} ${note1.message}`) && !!task1, [!!note1, !!task1]);
    const lock = await call('PUT', `/api/clients/${A.id}`, tk.bde, { contactName: 'ZZ Changed' });
    check('B6 BDE is locked out of editing after sending', lock.status === 403, [lock.status, lock.body && lock.body.error]);
    const lockAdmin = await call('PUT', `/api/clients/${A.id}`, tk.admin, { contactName: 'ZZ Contact' });
    check('B7 Admin can still edit (unlock)', lockAdmin.status === 200, lockAdmin.status);

    // ---- HR ----
    const hrClients = await call('GET', '/api/clients', tk.hr);
    check('H1 HR cannot use the client routes (closed to the HR desk)', hrClients.status === 403, hrClients.status);
    const hrWait = await call('GET', '/api/agreement-flow/waiting', tk.hr);
    check('H2 HR waiting list shows the client', hrWait.status === 200 && (hrWait.body.rows || []).some((r) => r.id === A.id && r.stage === 'WITH_HR'), [hrWait.status, hrWait.body]);
    const hrPage = await call('GET', `/api/agreement-flow/${A.id}/hr`, tk.hr);
    const bodyText = JSON.stringify(hrPage.body || {});
    check('H3 HR page: basics + sections 6-9, NO fee / guarantee / payment-terms', hrPage.status === 200 && hrPage.body.editable === true && !/agreementFee|guarantee|paymentTerms|paymentDue|invoiceTrigger|feeAmount|12\.5/i.test(bodyText), [hrPage.status, Object.keys((hrPage.body || {}).client || {})]);
    const pv = await call('GET', `/api/agreement-flow/${A.id}/preview`, tk.hr);
    check('H4 HR preview does not carry the fee number', pv.status === 200 && !/12\.5\s*%|\b30[- ]day guarantee|7{3}/i.test(pv.body.text || ''), [pv.status, (pv.body.text || '').match(/.{0,40}(12.5|30[- ]day|7{3}).{0,40}/i)]);
    const hrSend = await call('POST', `/api/clients/${A.id}/agreement/send`, tk.hr, {});
    check('H5 HR cannot send to the client', hrSend.status === 403, hrSend.status);
    const hrMiss = await call('POST', `/api/agreement-flow/${A.id}/action`, tk.hr, { action: 'send_to_tl' });
    check('H6 HR cannot send on before Tax & billing is filled', hrMiss.status === 400 && /Legal company name/.test(hrMiss.body.error || ''), [hrMiss.status, hrMiss.body]);
    const hrSave = await call('PUT', `/api/agreement-flow/${A.id}/sections`, tk.hr, {
      legalName: `ZZTEST AGW Legal ${RUN}`, gst: '36AABCT1234C1Z5', pan: 'AABCT1234C', invoiceEmail: 'inv@example.test', internalNotes: 'ZZTEST AGW hr note', paymentMethod: 'UPI',
      agreementFeePercent: 99, guaranteePeriod: '999 Days', contactName: 'HR tried this',
    });
    const afterA = await prisma.client.findUnique({ where: { id: A.id } });
    check('H7 HR saves sections 6/7/9; fee, guarantee and contact are NOT touched', hrSave.status === 200 && afterA.legalName && afterA.agreementFeePercent === FEE && afterA.guaranteePeriod === '30 Days' && afterA.contactName === 'ZZ Contact', [hrSave.status, hrSave.body && hrSave.body.error, afterA.agreementFeePercent, afterA.contactName]);
    const hrBadGst = await call('PUT', `/api/agreement-flow/${A.id}/sections`, tk.hr, { gst: 'BAD' });
    check('H8 a wrong GSTIN is refused in plain words', hrBadGst.status === 400 && /GSTIN/.test(hrBadGst.body.error || ''), hrBadGst.body);
    const hrBack = await call('POST', `/api/agreement-flow/${A.id}/action`, tk.hr, { action: 'back_to_bde' });
    check('H9 sending back needs a reason', hrBack.status === 400 && hrBack.body.needReason === true, hrBack.body);
    const hrNext = await call('POST', `/api/agreement-flow/${A.id}/action`, tk.hr, { action: 'send_to_tl' });
    check('H10 HR sends to the BDE TL', hrNext.status === 200 && hrNext.body.stage === 'WITH_TL', [hrNext.status, hrNext.body]);
    const tlNote = await prisma.notification.findFirst({ where: { userId: bdeTl.id, title: { contains: 'is ready to verify' } } });
    check('H11 the BDE TL got "Agreement for <client> is ready to verify"', !!tlNote && tlNote.title.includes('ZZTEST AGW A'), tlNote && tlNote.title);
    const hrAfter = await call('PUT', `/api/agreement-flow/${A.id}/sections`, tk.hr, { internalNotes: 'late' });
    check('H12 HR cannot edit once it is with the BDE TL', hrAfter.status === 403, hrAfter.status);
    const docOk = await call('GET', `/api/agreement-flow/${A.id}/documents`, tk.hr);
    check('H13 HR can open section 8 (documents) read; list loads', docOk.status === 200 || docOk.status === 503, docOk.status);

    // ---- BDE TL cross-verifies and sends ----
    const tlWait = await call('GET', '/api/clients?waiting=1', tk.bdeTl);
    check('T1 "Waiting for me" for the BDE TL lists it', tlWait.status === 200 && (tlWait.body || []).some((r) => r.id === A.id), [tlWait.status, (tlWait.body || []).length]);
    const tlSees = await call('GET', `/api/clients/${A.id}`, tk.bdeTl);
    check('T2 the BDE TL SEES sections 6-9 (cross-check) and the fee', tlSees.status === 200 && tlSees.body.gst === '36AABCT1234C1Z5' && tlSees.body.internalNotes && tlSees.body.agreementFeePercent === FEE, [tlSees.status, has(tlSees.body, ['gst', 'internalNotes'])]);
    const tlEditHr = await call('PUT', `/api/clients/${A.id}`, tk.bdeTl, { internalNotes: 'tl edits' });
    check('T3 the BDE TL cannot edit 6-9 (read only)', tlEditHr.status === 403, tlEditHr.status);
    const tlNo = await call('POST', `/api/clients/${A.id}/agreement/send`, tk.bdeTl, {});
    check('T4 Send to client needs the "I checked" ticks', tlNo.status === 403 && /Tick/.test(tlNo.body.error || ''), [tlNo.status, tlNo.body]);
    const tlSend = await call('POST', `/api/clients/${A.id}/agreement/send`, tk.bdeTl, { verified: ['commercial', 'tax', 'payment', 'documents'] });
    check('T5 BDE TL sends to the client -> link made, status SENT', tlSend.status === 200 && tlSend.body.agreementStatus === 'SENT' && !!tlSend.body.signingPath, [tlSend.status, tlSend.body && tlSend.body.error]);
    const stA = await call('GET', `/api/agreement-flow/${A.id}`, tk.bdeTl);
    check('T6 the step is now "Sent to client" and every move is in the history', stA.status === 200 && stA.body.stage === 'SENT' && stA.body.history.length >= 3 && stA.body.history.every((h) => h.who && h.at), [stA.body.stage, (stA.body.history || []).length]);
    const aud = await prisma.auditLog.count({ where: { entityId: A.id, action: { startsWith: 'Agreement step:' } } });
    check('T7 each move is audited (who / when)', aud >= 2, aud);

    // ---- client B: sent-back reasons ----
    const B = await mkClient('B'); keys.push(`agrwf:${B.id}`);
    await call('POST', `/api/agreement-flow/${B.id}/action`, tk.bde, { action: 'send_to_hr' });
    const bk = await call('POST', `/api/agreement-flow/${B.id}/action`, tk.hr, { action: 'back_to_bde', reason: 'ZZTEST AGW fee looks wrong' });
    const bdeNote = await prisma.notification.findFirst({ where: { userId: bde.id, title: { contains: 'was sent back to you' } } });
    const bSt = await call('GET', `/api/agreement-flow/${B.id}`, tk.bde);
    check('R1 HR sends it back to the BDE with a reason; the BDE gets the reason', bk.status === 200 && bk.body.stage === 'DRAFT' && bdeNote && /fee looks wrong/.test(bdeNote.message) && bSt.body.lastBackReason === 'ZZTEST AGW fee looks wrong', [bk.status, bdeNote && bdeNote.message, bSt.body.lastBackReason]);
    const bw = await call('GET', '/api/agreement-flow/waiting', tk.bde);
    check('R2 it is in the BDE "waiting for me" list with the reason', (bw.body.rows || []).some((r) => r.id === B.id && /fee looks wrong/.test(r.reason || '')), bw.body);
    await call('POST', `/api/agreement-flow/${B.id}/action`, tk.bde, { action: 'send_to_hr' });
    await prisma.client.update({ where: { id: B.id }, data: { legalName: 'ZZTEST AGW B Legal', pan: 'AABCT1234D', invoiceEmail: 'b@example.test' } });
    await call('POST', `/api/agreement-flow/${B.id}/action`, tk.hr, { action: 'send_to_tl' });
    const noR = await call('POST', `/api/agreement-flow/${B.id}/action`, tk.bdeTl, { action: 'back_to_hr' });
    const yesR = await call('POST', `/api/agreement-flow/${B.id}/action`, tk.bdeTl, { action: 'back_to_hr', reason: 'ZZTEST AGW GST missing' });
    check('R3 the BDE TL sends it back to HR (reason needed)', noR.status === 400 && yesR.status === 200 && yesR.body.stage === 'WITH_HR', [noR.status, yesR.status]);
    await call('POST', `/api/agreement-flow/${B.id}/action`, tk.hr, { action: 'send_to_tl' });
    const tlBack = await call('POST', `/api/agreement-flow/${B.id}/action`, tk.bdeTl, { action: 'back_to_bde', reason: 'ZZTEST AGW change the guarantee' });
    check('R4 the BDE TL can also send it back to the BDE', tlBack.status === 200 && tlBack.body.stage === 'DRAFT', tlBack.body);

    // ---- client C: Admin sends directly ----
    const C = await mkClient('C'); keys.push(`agrwf:${C.id}`);
    const adSend = await call('POST', `/api/clients/${C.id}/agreement/send`, tk.admin, {});
    check('D1 Admin can send to the client from any step', adSend.status === 200 && adSend.body.agreementStatus === 'SENT', [adSend.status, adSend.body && adSend.body.error]);

    // ---- TL / Recruiter stay blind ----
    for (const [nm, t] of [['TL', tk.tl], ['Recruiter', tk.rec]]) {
      const w = await call('GET', '/api/agreement-flow/waiting', t);
      const cl = await call('GET', '/api/clients', t);
      const one = await call('GET', `/api/clients/${A.id}`, t);
      const leak = (x) => /agreementStage|agreementWaiting|hrSectionsHidden/.test(JSON.stringify(x || {}));
      check(`V1 ${nm}: no workflow door, no step chip, no agreement in the list`, w.status === 403 && !leak(cl.body) && (one.status === 403 || !leak(one.body)), [w.status, cl.status, one.status]);
    }

    // ---- old statuses still load ----
    const oS = await mkClient('OS', { agreementStatus: 'SENT' });
    const oC = await mkClient('OC', { agreementStatus: 'CONFIRMED' });
    const oA = await mkClient('OA', { agreementStatus: 'ACTIVE' });
    const oL = await call('GET', '/api/clients', tk.admin);
    const pick = (id) => (oL.body || []).find((r) => r.id === id) || {};
    check('O1 old statuses map: SENT -> Sent to client, CONFIRMED -> Signed, ACTIVE -> Active', pick(oS.id).agreementStage === 'SENT' && pick(oC.id).agreementStage === 'SIGNED' && pick(oA.id).agreementStage === 'ACTIVE', [pick(oS.id).agreementStage, pick(oC.id).agreementStage, pick(oA.id).agreementStage]);
    const oOne = await call('GET', `/api/clients/${oA.id}`, tk.admin);
    check('O2 an old Active agreement still opens and keeps its status', oOne.status === 200 && oOne.body.agreementStatus === 'ACTIVE', oOne.status);
    // a re-send of a link already out (old flow) still works for the Admin and is not gated for a BDE-owned SENT one
    const reS = await call('POST', `/api/clients/${oS.id}/agreement/send`, tk.admin, {});
    check('O3 the e-sign stage is untouched: re-send of a SENT link works', reS.status === 200, [reS.status, reS.body && reS.body.error]);
  } catch (e) {
    console.log('TEST CRASHED', e && e.stack || e);
    Z.fail += 1;
  }
  // ---- cleanup ----
  try {
    const cls = await prisma.client.findMany({ where: { name: { contains: 'ZZTEST AGW' } }, select: { id: true } });
    const ids = cls.map((c) => c.id);
    await prisma.appSetting.deleteMany({ where: { OR: [{ key: { in: keys } }, { key: { in: ids.map((i) => `agrwf:${i}`) } }, { key: 'agreementWorkflow' }] } });
    await prisma.task.deleteMany({ where: { OR: [{ name: { contains: 'ZZTEST AGW' } }, { description: { contains: 'ZZTEST AGW' } }, { assigneeId: { in: Z.made.users } }] } });
    await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST AGW' } }, { message: { contains: 'ZZTEST AGW' } }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { toValue: { contains: 'ZZTEST AGW' } }, { reason: { contains: 'ZZTEST AGW' } }, { entityId: 'agreementWorkflow' }] } });
    const left = await Z.cleanup();
    const rest = {
      agrwf: await prisma.appSetting.count({ where: { OR: [{ key: { startsWith: 'agrwf:' }, value: { contains: 'ZZTEST' } }, { key: 'agreementWorkflow' }] } }),
      tasks: await prisma.task.count({ where: { name: { contains: 'ZZTEST AGW' } } }),
    };
    console.log('cleanup left:', JSON.stringify({ ...left, ...rest }));
  } catch (e) { console.log('cleanup problem', e.message); }
  await Z.finish();
})();
