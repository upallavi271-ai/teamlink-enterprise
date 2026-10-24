// OMNICHANNEL TEST 1 - access matrix, masked contact (BDE), Manager, Accountant, role catalog. SANDBOX ONLY.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, cleanup, L } = require('./fx');
const E = require('./env');
const { check } = L;
const P = L.prisma;
const jobs = [];

const D = 'direct'; const M = 'masked';
const EXP = {
  sa: { candidates: D, clients: D, employees: D },
  admin: { candidates: D, clients: D, employees: D },
  mgr: { candidates: D, clients: D, employees: D },
  am: { candidates: D, clients: M, employees: D },
  stl: { candidates: D, clients: null, employees: D },
  tl: { candidates: D, clients: null, employees: D },
  rec: { candidates: D, clients: null, employees: null },
  bde: { candidates: M, clients: D, employees: null },
  bdetl: { candidates: M, clients: D, employees: D },
  hr: { candidates: D, clients: null, employees: D },
  acct: { candidates: null, clients: D, employees: null },
  emp: { candidates: null, clients: null, employees: null },
};

(async () => {
  let W;
  try {
    W = await build();
    const U = W.u;
    await E.setup(U.sa);
    const ids = { candidates: W.c1.c.id, clients: W.client.id, employees: W.empRow.id };
    const keyFor = { candidates: 'FU_INTERVIEW_REMINDER', clients: 'FU_CLIENT_REQUIREMENT_FOLLOW_UP', employees: 'EMPLOYEE_NOTICE' };
    const pv = (u, aud, id, ch, key, extra) => L.post(u, '/messaging/preview', { audience: aud, ids: [id], channels: [ch], kind: 'individual', purposeKey: key, ...(extra || {}) });

    // ---------------- A. the role matrix: role x audience x channel -----------------------------------
    for (const [role, exp] of Object.entries(EXP)) {
      const u = U[role];
      const ch = await L.get(u, '/messaging/channels');
      for (const aud of ['candidates', 'clients', 'employees']) {
        const want = exp[aud];
        const got = ch.body && ch.body.audiences ? (ch.body.audiences[aud] ? ch.body.modes[aud] : null) : 'ERR';
        check(`A matrix ${role} -> ${aud}: ${want || 'denied'}`, got === want, `${ch.status} ${got}`);
        if (ch.body && ch.body.reasons && !want) check(`A ${role} -> ${aud} denied with a plain reason line`, typeof ch.body.reasons[aud] === 'string' && ch.body.reasons[aud].length > 15, ch.body.reasons);
        // the SERVER enforces the same thing on every channel (a hidden button is not security)
        for (const channel of ['Email', 'SMS', 'WhatsApp']) {
          // HR works internal candidates only: use the internal hire for the candidate audience
          const pid = role === 'hr' && aud === 'candidates' ? W.ci.c.id : ids[aud];
          const r = await pv(u, aud, pid, channel, role === 'acct' && aud === 'clients' ? 'CLIENT_PAYMENT_REMINDER' : keyFor[aud]);
          // a lead of the BDE team is allowed to contact employees, but only those of her own team: the test employee is not
          const scopeOnly = role === 'bdetl' && aud === 'employees';
          const okStatus = scopeOnly ? (r.status === 403 && /outside your access/.test(r.body.error)) : (want ? r.status !== 403 : r.status === 403);
          check(`A server ${role} ${aud} ${channel}: ${want ? 'allowed' : '403'}`, okStatus, `${r.status} ${r.body && r.body.error}`);
        }
        const call = await L.post(u, '/messaging/call', { audience: aud, id: role === 'hr' && aud === 'candidates' ? W.ci.c.id : ids[aud] });
        const callScopeOnly = role === 'bdetl' && aud === 'employees';
        check(`A call ${role} ${aud}: ${want ? 'allowed (not 403)' : '403'}`, callScopeOnly ? /outside your access/.test(call.body.error) : (want ? call.status !== 403 : call.status === 403), `${call.status} ${call.body && call.body.error}`);
      }
    }
    // bulk: Manager / Assistant Manager / masked roles never send to a list
    for (const role of ['mgr', 'am', 'bde']) {
      const r = await L.post(U[role], '/messaging/preview', { audience: 'candidates', ids: [W.c1.c.id], channels: ['Email'], kind: 'bulk', purposeKey: 'BULK_NEW_OPENING' });
      check(`A bulk candidates ${role}: refused`, r.status === 403, `${r.status}`);
    }
    {
      const r = await L.post(U.rec, '/messaging/preview', { audience: 'candidates', ids: [W.c1.c.id], channels: ['Email'], kind: 'bulk', purposeKey: 'BULK_NEW_OPENING' });
      check('A bulk candidates recruiter: allowed', r.status === 200, `${r.status} ${r.body && r.body.error}`);
    }
    // follow-ups: who sees / creates / logs
    const fu = {};
    for (const role of Object.keys(U)) {
      fu[role] = {
        view: (await L.get(U[role], '/followups?page=1&pageSize=3')).status,
        create: (await L.post(U[role], '/followups', { applicationId: W.c1.a.id, dueDate: '2031-01-01' })).status,
        log: (await L.post(U[role], '/followups/quick-log', { candidateId: role === 'hr' ? W.ci.c.id : W.c1.c.id, applicationId: role === 'hr' ? W.ci.a.id : W.c1.a.id, channel: 'Call' })).status,
      };
    }
    check('A follow-ups view: everyone who follows up sees them; Accountant / Employee do not', ['sa', 'admin', 'mgr', 'am', 'stl', 'tl', 'rec', 'bde', 'bdetl', 'hr'].every((r) => fu[r].view === 200) && fu.acct.view === 403 && fu.emp.view === 403, fu);
    check('A log a contact: allowed for every role that has the Contact right', ['sa', 'admin', 'mgr', 'am', 'stl', 'tl', 'rec', 'bde', 'bdetl', 'hr'].every((r) => fu[r].log === 201) && fu.acct.log === 403 && fu.emp.log === 403, fu);
    check('A create a follow-up stays with the working roles: Manager / AM / STL / HR cannot', [fu.mgr.create, fu.am.create, fu.stl.create, fu.hr.create].every((x) => x === 403) && [fu.sa.create, fu.tl.create, fu.rec.create, fu.bde.create].every((x) => x === 201), fu);

    // ---------------- B. a BDE contacts a candidate and NEVER receives the number ---------------------
    const phone = W.c1.c.phone; const mailLocal = W.c1.c.email.split('@')[0]; const mailFull = W.c1.c.email;
    const bag = [];
    const keep = (r) => { bag.push(r.text || JSON.stringify(r.body)); return r; };
    keep(await L.get(U.bde, '/messaging/channels'));
    for (const channel of ['Email', 'SMS', 'WhatsApp']) keep(await pv(U.bde, 'candidates', W.c1.c.id, channel, 'FU_INTERVIEW_REMINDER'));
    const sendB = keep(await L.post(U.bde, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c1.a.id }));
    check('B BDE sends mail to the candidate through the system (sent on the test server)', sendB.status === 200 && sendB.body.result && sendB.body.result.status === 'sent', `${sendB.status} ${sendB.text.slice(0, 200)}`);
    check('B the send result shows a masked address', sendB.body.masked === true && sendB.body.result && /•/.test(sendB.body.result.address) && !sendB.body.result.address.includes(mailLocal), sendB.body.result);
    if (sendB.body.jobId) { jobs.push(sendB.body.jobId); keep(await L.get(U.bde, `/messaging/bulk/${sendB.body.jobId}`)); keep(await L.get(U.bde, `/messaging/bulk/${sendB.body.jobId}/report.csv`)); }
    keep(await L.post(U.bde, '/messaging/script', { audience: 'candidates', id: W.c1.c.id, purposeKey: 'FU_INTERVIEW_REMINDER' }));
    keep(await L.get(U.bde, `/conversations/person/candidates/${W.c1.c.id}`));
    keep(await L.get(U.bde, `/candidates/${W.c1.c.id}/communications`));
    keep(await L.get(U.bde, `/candidates/${W.c1.c.id}`));
    keep(await L.get(U.bde, '/followups?page=1&pageSize=50'));
    keep(await L.get(U.bde, '/conversations/inbox?state=all'));
    const asked = await L.post(U.bde, '/conversations/request-contact', { audience: 'candidates', id: W.c1.c.id, channel: 'Call', applicationId: W.c1.a.id, note: 'Client wants to confirm the slot' });
    keep(asked);
    check('B BDE asks the recruiter to call (fallback when calls are not connected)', asked.status === 200 && asked.body.ok, `${asked.status} ${asked.text.slice(0, 200)}`);
    const note = await P.notification.findFirst({ where: { userId: U.rec.id, title: { contains: 'asks you to call' } } });
    check('B the recruiter got the request in the bell', !!note);
    const everything = bag.join('\n');
    check('B no payload given to the BDE contains the candidate phone number', !everything.includes(phone) && !everything.includes(`91${phone}`), phone);
    check('B no payload given to the BDE contains the candidate mail address', !everything.includes(mailFull) && !everything.includes(mailLocal), mailLocal);
    const calls = await L.post(U.bde, '/messaging/call', { audience: 'candidates', id: W.c1.c.id });
    check('B BDE "Call" goes through TeamLink only: with calls not connected it says so, number not shown', calls.status === 409 && !(calls.text || '').includes(phone), `${calls.status} ${calls.text.slice(0, 160)}`);
    const dev = await L.post(U.bde, '/messaging/script', { audience: 'candidates', id: W.c1.c.id, purposeKey: 'FU_INTERVIEW_REMINDER' });
    check('B the call script for a BDE carries a hint, not the number', dev.body && dev.body.phone === null && /•/.test(dev.body.phoneHint || ''), dev.body);
    const outside = await pv(U.bde, 'candidates', W.c0.c.id, 'Email', 'FU_INTERVIEW_REMINDER');
    check('B a candidate not yet at the BDE step is outside the BDE access (403)', outside.status === 403, outside.status);
    // an inbound reply that contains a number is hidden from the BDE, shown to the recruiter
    await E.waInbound(`91${phone}`, `Please call me on ${phone} or mail ${mailFull}`, 'wamid.ZZB1');
    const conv = await L.get(U.bde, `/conversations/person/candidates/${W.c1.c.id}`);
    const convRec = await L.get(U.rec, `/conversations/person/candidates/${W.c1.c.id}`);
    const inB = (conv.body.timeline || []).find((m) => m.direction === 'in');
    const inR = (convRec.body.timeline || []).find((m) => m.direction === 'in');
    check('B the BDE sees the reply with the number and address hidden', inB && /hidden/.test(inB.body) && !inB.body.includes(phone) && !inB.body.includes(mailFull), inB && inB.body);
    check('B the recruiter sees the same reply in full', inR && inR.body.includes(phone) && inR.body.includes(mailFull), inR && inR.body);
    check('B conversation of a masked viewer carries the masked mode', conv.body.mode === 'masked' && convRec.body.mode === 'direct');

    // ---------------- C. Manager: contact allowed, edit denied ----------------------------------
    const mSend = await L.post(U.mgr, '/messaging/send', { audience: 'candidates', id: W.c1.c.id, channel: 'Email', purposeKey: 'FU_INTERVIEW_REMINDER', applicationId: W.c1.a.id });
    if (mSend.body && mSend.body.jobId) jobs.push(mSend.body.jobId);
    check('C Manager sends a mail to a candidate in their view', mSend.status === 200 && mSend.body.result.status === 'sent', `${mSend.status} ${mSend.text.slice(0, 200)}`);
    check('C Manager sees the real address (direct)', mSend.body.masked === false && /@/.test(mSend.body.result.address), mSend.body.result);
    const mEdit = await L.put(U.mgr, `/candidates/${W.c1.c.id}`, { name: 'ZZTEST OC Edited' });
    check('C Manager cannot edit the candidate (403)', mEdit.status === 403, `${mEdit.status}`);
    const mFu = await L.post(U.mgr, '/followups', { applicationId: W.c1.a.id });
    check('C Manager cannot create a follow-up (403)', mFu.status === 403, `${mFu.status}`);
    const mLog = fu.mgr.log;
    check('C Manager logs a contact (201)', mLog === 201);
    const lastFu = await P.applicationFollowUp.findFirst({ where: { applicationId: W.c1.a.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
    check('C the contact is shown as "last contact" on the follow-up', !!(lastFu && lastFu.lastContactedAt && lastFu.contactMode), lastFu && [lastFu.contactMode, lastFu.lastContactedAt]);
    const cmsg = await P.candidateMessage.count({ where: { candidateId: W.c1.c.id, senderUserId: U.mgr.id } });
    check('C the contact is on the candidate history', cmsg >= 2, cmsg);

    // ---------------- D. Accountant: payment reminder to the BILLING contact only -----------------------
    const aOk = await pv(U.acct, 'clients', W.client.id, 'Email', 'CLIENT_PAYMENT_REMINDER');
    check('D Accountant: payment reminder to the client billing contact is queued', aOk.status === 200 && aOk.body.first.status === 'queued', `${aOk.status} ${aOk.text.slice(0, 200)}`);
    check('D ...to the BILLING address, not the primary contact', aOk.body.first.address === W.client.billingContactEmail, aOk.body.first && aOk.body.first.address);
    const aSend = await L.post(U.acct, '/messaging/send', { audience: 'clients', id: W.client.id, channel: 'Email', purposeKey: 'CLIENT_PAYMENT_REMINDER' });
    if (aSend.body && aSend.body.jobId) jobs.push(aSend.body.jobId);
    check('D Accountant sends it (test server)', aSend.status === 200 && aSend.body.result.status === 'sent', `${aSend.status} ${aSend.text.slice(0, 200)}`);
    const aOther = await pv(U.acct, 'clients', W.client.id, 'Email', 'FU_CLIENT_DECISION_REMINDER');
    check('D Accountant cannot use another template (403)', aOther.status === 403, `${aOther.status} ${aOther.text.slice(0, 120)}`);
    const aOwn = await L.post(U.acct, '/messaging/preview', { audience: 'clients', ids: [W.client.id], channels: ['Email'], kind: 'individual', subject: 'Hi', body: 'Hello there' });
    check('D Accountant cannot write own words (403)', aOwn.status === 403, `${aOwn.status}`);
    for (const aud of ['candidates', 'employees']) {
      const r = await pv(U.acct, aud, ids[aud], 'Email', keyFor[aud]);
      check(`D Accountant -> ${aud}: denied (403)`, r.status === 403, r.status);
    }
    const tpls = await L.get(U.acct, '/messaging/templates/usable?audience=client');
    check('D Accountant is offered only the payment templates', tpls.status === 200 && tpls.body.templates.length > 0 && tpls.body.templates.every((t) => ['CLIENT_PAYMENT_REMINDER', 'CLIENT_INVOICE_NOTICE'].includes(t.purpose)), tpls.body && tpls.body.templates && tpls.body.templates.map((t) => t.purpose));
    const aConv = await L.get(U.acct, `/conversations/person/clients/${W.client.id}`);
    check('D the reminder is on the client conversation (timeline)', aConv.status === 200 && aConv.body.timeline.some((m) => m.channel === 'Email' && m.direction === 'out' && /payment/i.test(m.body)), aConv.status);
    check('D Accountant sees the billing contact conversation, mode direct, kind billing', aConv.body.mode === 'direct' && aConv.body.kind === 'billing', [aConv.body.mode, aConv.body.kind]);

    // ---------------- E. Role Catalog: a Super Admin switches Contact per role -----------------------------
    const acc = await L.get(U.sa, '/admin/role-catalog/MANAGER/access');
    const mod = acc.body.modules.find((m) => m.id === 'candidates');
    check('E Role Catalog lists "Contact (Mail / WhatsApp / SMS / Call)" with a hint, ON for the Manager', mod && mod.features['Contact (Mail / WhatsApp / SMS / Call)'].view === true && mod.featureInfo && /Follow-ups/.test(mod.featureInfo['Contact (Mail / WhatsApp / SMS / Call)'].hint), mod && mod.features['Contact (Mail / WhatsApp / SMS / Call)']);
    const accB = await L.get(U.sa, '/admin/role-catalog/EMPLOYEE/access');
    check('E ...and OFF for a plain Employee', accB.body.modules.find((m) => m.id === 'candidates').features['Contact (Mail / WhatsApp / SMS / Call)'].view === false);
    const feat = JSON.parse(JSON.stringify(mod.features));
    feat['Contact (Mail / WhatsApp / SMS / Call)'].view = false;
    const off = await L.put(U.sa, '/admin/role-catalog/MANAGER/modules/candidates/features', { features: feat });
    check('E Super Admin switches Contact OFF for the Manager', off.status === 200, off.status);
    const mOff = await pv(U.mgr, 'candidates', W.c1.c.id, 'Email', 'FU_INTERVIEW_REMINDER');
    const mOffCh = await L.get(U.mgr, '/messaging/channels');
    check('E the Manager is refused by the server and told why', mOff.status === 403 && /switched off/i.test(mOff.body.error) && /switched off/i.test(mOffCh.body.reasons.candidates), `${mOff.status} ${mOff.text.slice(0, 160)}`);
    const mMe = await L.get(U.mgr, '/auth/me');
    check('E /auth/me tells the screen (caps.contact = false)', mMe.body.caps && mMe.body.caps.contact === false, mMe.body.caps);
    feat['Contact (Mail / WhatsApp / SMS / Call)'].view = true;
    const on = await L.put(U.sa, '/admin/role-catalog/MANAGER/modules/candidates/features', { features: feat });
    const mOn = await pv(U.mgr, 'candidates', W.c1.c.id, 'Email', 'FU_INTERVIEW_REMINDER');
    check('E switched back ON: the Manager contacts again', on.status === 200 && mOn.status === 200);
    // remove the saved catalog row so nothing of the test stays
    await P.roleAccess.deleteMany({ where: { role: 'MANAGER', moduleId: 'candidates' } });
    await L.get(U.sa, '/admin/role-catalog');
  } catch (e) {
    console.log('FATAL', e);
    check('no crash', false, e.message);
  } finally {
    try { await E.restore(); } catch (e) { console.log('restore', e.message); }
    jobs.forEach((j) => { for (const ext of ['json', 'delivery', 'cancel']) { try { fs.unlinkSync(path.join(os.homedir(), '.teamlink-sandbox', 'message-jobs', `${j}.${ext}`)); } catch { /* */ } } });
    if (W) console.log(await cleanup());
    console.log(JSON.stringify(L.results()));
    process.exit(0);
  }
})();
