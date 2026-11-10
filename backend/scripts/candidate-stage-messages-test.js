#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CANDIDATE STAGE MESSAGES ON EMAIL, SMS AND WHATSAPP (founder 2026-11-10: "ATS ki move ayite you are shortlisted, client interview ki
// adigithe 2nd round interview, client reject chesthe rejected, shortlist ayite shortlisted, joining date ki follow-ups ... whatsapp, sms kuda").
// SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/candidate-stage-messages-test.js
// Calls utils/candidateComms.recordStageCommunications and utils/clientTrack.runReminders on the sandbox database (no real send: every row is
// recorded with its honest status). Checks the rows a candidate would get.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('STGM');
const path = require('path');

(async () => {
  try {
    const { prisma } = Z;
    const C = require(path.join(Z.BACK, 'src/utils/candidateComms'));
    const CT = require(path.join(Z.BACK, 'src/utils/clientTrack'));
    const admin = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, accountsAccess: true });
    const client = await prisma.client.create({ data: { name: `ZZTEST STGM Client ${Z.RUN}` } });
    Z.made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `ZZTEST STGM Staff Nurse ${Z.RUN}`, clientId: client.id, status: 'OPEN' } });
    Z.made.reqs.push(req.id);
    const mkCand = async (s) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST STGM ${s} ${Z.RUN}`, email: `zz-stgm-${s}-${Z.RUN}@example.test`, phone: `98${String(Date.now()).slice(-6)}${s.length}${s.charCodeAt(0) % 10}` } });
      Z.made.cands.push(c.id);
      return c;
    };
    const mkApp = async (cand, data) => {
      const a = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'NEW', ...data } });
      Z.made.apps.push(a.id);
      return prisma.application.findUnique({ where: { id: a.id }, include: { candidate: true, requirement: { include: { client: true } } } });
    };
    const move = (app, from, to) => C.recordStageCommunications({ application: app, candidate: app.candidate, requirement: app.requirement, fromStage: from, toStage: to, user: admin });
    const rowsOf = (appId, template) => prisma.candidateMessage.findMany({ where: { applicationId: appId, ...(template ? { template } : {}) }, orderBy: { createdAt: 'asc' } });
    const chans = (rows) => rows.map((r) => r.channel).sort().join(',');

    // 1. sent to the ATS after the AI interview -> "You are shortlisted", three channels
    const anu = await mkCand('anu');
    const a1 = await mkApp(anu, { aiInterviewStatus: 'Completed', aiInterviewScore: 80, stage: 'RECRUITER_APPROVED', portalImportedAt: new Date() });
    await move(a1, 'AI_INTERVIEW_COMPLETED', 'SENT_TO_ATS');
    let r = await rowsOf(a1.id, 'ATS_SHORTLISTED');
    Z.check('1 sent to ATS: "You are shortlisted" on Email, SMS and WhatsApp', chans(r) === 'Email,SMS,WhatsApp' && r.every((x) => /shortlisted/i.test(x.body)), r.map((x) => `${x.channel}:${x.body.slice(0, 60)}`));
    Z.check('1b the email subject says shortlisted and the client is never named', /shortlisted/i.test((r.find((x) => x.channel === 'Email') || {}).subject || '') && r.every((x) => !x.body.includes(client.name)));

    // 2. client interview -> "2nd round interview" after the AI interview; "interview" otherwise
    await move({ ...a1, stage: 'INTERVIEW_SCHEDULED' }, 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED');
    r = await rowsOf(a1.id, 'INTERVIEW_SCHEDULED');
    Z.check('2 client interview after the AI interview: "2nd round interview", three channels', chans(r) === 'Email,SMS,WhatsApp' && r.every((x) => /2nd round interview/.test(x.body)), r.map((x) => x.body.slice(0, 70)));
    const bala = await mkCand('bala');
    const a2 = await mkApp(bala, { stage: 'CLIENT_SHORTLISTED' });
    await move({ ...a2, stage: 'INTERVIEW_SCHEDULED' }, 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED');
    r = await rowsOf(a2.id, 'INTERVIEW_SCHEDULED');
    Z.check('2b no AI interview: just "interview" (not "2nd round")', r.length === 3 && r.every((x) => /your interview/i.test(x.body) && !/2nd round/.test(x.body)), r.map((x) => x.body.slice(0, 70)));

    // 3. client shortlists -> shortlisted; client rejects -> rejected; both on three channels
    await move({ ...a2, stage: 'CLIENT_SHORTLISTED' }, 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED');
    r = await rowsOf(a2.id, 'STAGE_CLIENT_SHORTLISTED');
    Z.check('3 client shortlisted: "shortlisted" on Email, SMS and WhatsApp', chans(r) === 'Email,SMS,WhatsApp' && r.every((x) => /shortlisted/i.test(x.body)), r.map((x) => x.body.slice(0, 60)));
    await move({ ...a2, stage: 'REJECTED' }, 'INTERVIEW_COMPLETED', 'REJECTED');
    r = await rowsOf(a2.id, 'REJECTED');
    Z.check('3b client rejected: the closing message on Email, SMS and WhatsApp', chans(r) === 'Email,SMS,WhatsApp', chans(r));

    // 4. joining date in 1 day (India time) -> joining reminder on three channels, once
    const chitra = await mkCand('chitra');
    const ist = new Date(Date.now() + 330 * 60000);
    const tomorrow = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1)).toISOString().slice(0, 10);
    const a3 = await mkApp(chitra, { stage: 'OFFER_ACCEPTED', joiningDate: tomorrow });
    const run1 = await CT.runReminders({ force: true });
    r = await rowsOf(a3.id, 'JOINING_REMINDER');
    Z.check('4 joining tomorrow: a reminder on Email, SMS and WhatsApp', chans(r) === 'Email,SMS,WhatsApp' && r.every((x) => /tomorrow/.test(x.body) || /reminder/i.test(x.body)), [run1 && run1.joiningReminders, r.map((x) => x.body.slice(0, 70))]);
    await CT.runReminders({ force: true });
    Z.check('4b a second run the same day sends nothing again', (await rowsOf(a3.id, 'JOINING_REMINDER')).length === 3);
    const later = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 2)).toISOString().slice(0, 10);
    const deepa = await mkCand('deepa');
    const a4 = await mkApp(deepa, { stage: 'OFFER_ACCEPTED', joiningDate: later });
    await CT.runReminders({ force: true });
    Z.check('4c joining in 2 days: no reminder (only 3 days / 1 day / the day)', (await rowsOf(a4.id, 'JOINING_REMINDER')).length === 0);
    Z.check('4d the reminders switch is ON unless an Admin turned it off', (await CT.loadReminders()).armed === true);

    // 5. an approved Meta template / a DLT ID on the Message template -> the row keeps it, the worker sends exactly that
    const T = require(path.join(Z.BACK, 'src/utils/messageTemplates'));
    await T.ensureDefaults();
    const waT = await prisma.messageTemplate.findFirst({ where: { purpose: 'ATS_SHORTLISTED', channel: 'WhatsApp', language: 'English' } });
    const smsT = await prisma.messageTemplate.findFirst({ where: { purpose: 'ATS_SHORTLISTED', channel: 'SMS', language: 'English' } });
    const keepWa = { waTemplateName: waT.waTemplateName, waStatus: waT.waStatus, waLanguageCode: waT.waLanguageCode, waVars: waT.waVars };
    const keepSms = { dltTemplateId: smsT.dltTemplateId, senderId: smsT.senderId };
    try {
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: { waTemplateName: 'zz_stgm_shortlisted', waStatus: 'Approved', waLanguageCode: 'en', waVars: JSON.stringify(['name', 'role']) } });
      await prisma.messageTemplate.update({ where: { id: smsT.id }, data: { dltTemplateId: '1107000000000000001', senderId: 'TMLINK' } });
      const esha = await mkCand('esha');
      const a5 = await mkApp(esha, { aiInterviewStatus: 'Completed', stage: 'RECRUITER_APPROVED' });
      await move(a5, 'AI_INTERVIEW_COMPLETED', 'SENT_TO_ATS');
      r = await rowsOf(a5.id, 'ATS_SHORTLISTED');
      const wa = JSON.parse((r.find((x) => x.channel === 'WhatsApp') || {}).sendSpec || 'null');
      const sms = JSON.parse((r.find((x) => x.channel === 'SMS') || {}).sendSpec || 'null');
      Z.check('5 WhatsApp row keeps the approved Meta template and its two blanks (name, role)', wa && wa.wa.name === 'zz_stgm_shortlisted' && wa.wa.language === 'en' && wa.vars.length === 2 && wa.vars[0] === esha.name && wa.vars[1] === req.title, wa);
      Z.check('5b SMS row keeps the DLT template ID and the sender', sms && sms.dlt.templateId === '1107000000000000001' && sms.dlt.senderId === 'TMLINK' && sms.vars.length >= 1, sms);
      Z.check('5c the Email row has no send spec', (r.find((x) => x.channel === 'Email') || {}).sendSpec == null);
      // a template marked Pending is not used yet
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: { waStatus: 'Pending' } });
      const farah = await mkCand('farah');
      const a6 = await mkApp(farah, { stage: 'RECRUITER_APPROVED' });
      await move(a6, 'AI_INTERVIEW_COMPLETED', 'SENT_TO_ATS');
      Z.check('5d a Meta template still Pending is not used (sent as before)', (await rowsOf(a6.id, 'ATS_SHORTLISTED')).find((x) => x.channel === 'WhatsApp').sendSpec == null);
      // the worker hands the template to the provider (messaging.send stubbed: nothing leaves this PC)
      const msgPath = require.resolve(path.join(Z.BACK, 'src/utils/messaging'));
      const M = require(msgPath);
      const realSend = M.send; const seen = [];
      M.send = async (channel, opts) => { seen.push({ channel, opts }); return { ok: false, transient: false, invalid: true, outcome: 'Skipped', error: 'test stub' }; };
      try {
        const W = require(path.join(Z.BACK, 'src/utils/mailWorker'));
        const waRow = r.find((x) => x.channel === 'WhatsApp'); const smsRow = r.find((x) => x.channel === 'SMS');
        const proc = W.processRow || W._processRow;
        if (proc) {
          await proc({ ...waRow, recipient: waRow.recipient || '+919800000001' }, { sent: 0, failed: 0, retried: 0 });
          await proc({ ...smsRow, recipient: smsRow.recipient || '+919800000001' }, { sent: 0, failed: 0, retried: 0 });
          const w = seen.find((s) => s.channel === 'WhatsApp'); const s = seen.find((x) => x.channel === 'SMS');
          Z.check('5e the worker sends WhatsApp as the Meta template with its blanks', w && w.opts.template && w.opts.template.name === 'zz_stgm_shortlisted' && w.opts.vars.length === 2, w && w.opts);
          Z.check('5f the worker sends SMS with the DLT template ID', s && s.opts.templateId === '1107000000000000001' && s.opts.senderId === 'TMLINK', s && s.opts);
        } else Z.check('5e/5f mailWorker exports processRow for the check', false, Object.keys(W));
      } finally { M.send = realSend; }
    } finally {
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: keepWa });
      await prisma.messageTemplate.update({ where: { id: smsT.id }, data: keepSms });
    }
  } catch (err) {
    Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err);
  } finally {
    await Z.prisma.candidateMessage.deleteMany({ where: { candidateId: { in: Z.made.cands } } }).catch(() => {});
    await Z.cleanup().catch((err) => console.log('cleanup problem', String(err.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
