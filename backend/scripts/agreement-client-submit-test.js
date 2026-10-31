#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CLIENT HANDS IN THEIR eSIGNED COPY ON THE LINK; THE BDE EDITS THE WORDS (founder 2026-10-31). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 ESIGN_CLIENT=<a PDF eSigned in DigiLocker> node scripts/agreement-client-submit-test.js
//
// Text edit: the BDE changes a point; a broken signature block is refused; TeamLink's copy of the earlier words stops counting and
// Send to client waits for a new TeamLink eSign. The link: check (nothing saved) -> submit -> the copy is on file, the agreement turns
// Active, a thank-you is written; the agreement PDF then fills both sides' Sign / Date from DigiLocker.
// ---------------------------------------------------------------------------
const fs = require('fs');
const Z = require('./lib/zzfix')('ACS');

const { prisma, check, RUN } = Z;
const C = process.env.ESIGN_CLIENT;

async function post(path, buf, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), name);
  const r = await fetch(`${process.env.TL_API}${path}`, { method: 'POST', body: fd, headers: { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.1` } });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
}

(async () => {
  await Z.preclean();
  const ours = require('./lib/teamlinkSigned')(prisma);
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const bde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,IT' }, { department: 'BDE' });
    const tk = { admin: await Z.mint(admin), bde: await Z.mint(bde) };
    const c0 = await prisma.client.create({
      data: {
        name: `ZZTEST ACS Client ${RUN}`, industry: 'IT', location: 'Hyderabad', ownerDepartment: 'IT', bdeOwner: bde.name, clientType: 'Client', agreementStatus: 'DRAFT',
        contactName: 'Ravi Kumar', contactEmail: `zz-acs-${RUN}@example.test`, contactPhone: '9000000005', agreementFeePercent: 8.33, guaranteePeriod: '30 Days',
        paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice', agreementId: `AGRZA${RUN}`.slice(0, 12), agreementSource: 'Generated',
      },
    });
    Z.made.clients.push(c0.id);
    const A = require('../src/utils/agreement');
    const P = require('../src/utils/agreementPdf');
    const c = await prisma.client.update({ where: { id: c0.id }, data: { agreementDocument: A.buildAgreementDocument(c0, await A.consultantParty()) } });

    // ---- TeamLink eSigned the first words ----
    const docId = await ours.add(c.id);
    const key = `agrsigned.${docId}`;
    const meta = JSON.parse((await prisma.appSetting.findUnique({ where: { key } })).value);
    meta.esign.textHash = P.textHash(c);
    await prisma.appSetting.update({ where: { key }, data: { value: JSON.stringify(meta) } });

    // ---- the BDE edits the words ----
    const newText = c.agreementDocument.replace('7. Service Tax:', '7. Service Tax (as the client asked, ZZTEST):');
    const e1 = await Z.call('PUT', `/api/clients/${c.id}/agreement/text`, tk.bde, { text: newText, reason: 'ZZTEST client asked' });
    check('E1 the BDE changes a point of the agreement (with the BDE)', e1.status === 200 && e1.body.changed === true && /earlier words/.test(e1.body.message || ''), [e1.status, e1.body]);
    const e2 = await Z.call('PUT', `/api/clients/${c.id}/agreement/text`, tk.bde, { text: newText.replace(/^\s*Sign:.*$/gm, '') });
    check('E2 removing the signature block is refused', e2.status === 400 && /signature block/.test(e2.body.error || ''), [e2.status, e2.body]);
    const SF = require('../src/routes/agreementSignedFiles');
    const tlCopy = (await SF.filesOf(c.id)).find((f) => f.id === docId);
    check('E3 TeamLink\'s copy of the earlier words is an earlier version (no longer counts)', tlCopy && tlCopy.esign.stale === true && tlCopy.esign.valid === false, tlCopy && tlCopy.esign);
    const s1 = await Z.call('POST', `/api/clients/${c.id}/agreement/send`, tk.admin, {});
    check('E4 Send to client waits for TeamLink to eSign the new version', s1.status === 409 && /TeamLink signs first/.test(s1.body.error || ''), [s1.status, s1.body && s1.body.error]);
    const e5 = await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'Agreement text edited' } });
    check('E5 the edit is in the history with the reason', !!e5 && /client asked/.test(e5.reason || ''), e5);

    // ---- TeamLink eSigns the new version, sends ----
    await ours.add(c.id);
    const s2 = await Z.call('POST', `/api/clients/${c.id}/agreement/send`, tk.admin, {});
    check('S1 with TeamLink\'s new copy it goes to the client', s2.status === 200, [s2.status, s2.body && s2.body.error]);
    const fresh = await prisma.client.findUnique({ where: { id: c.id } });
    const token = require('../src/utils/agreementSigning').tokenFor(fresh);

    const bad = await post(`/api/agreement/token/${token}/esigned/check`, Buffer.from('not a pdf'), 'x.pdf');
    check('L1 the link refuses a file that is not a PDF', bad.status === 400, bad);
    if (C && fs.existsSync(C)) {
      const buf = fs.readFileSync(C);
      const chk = await post(`/api/agreement/token/${token}/esigned/check`, buf, 'signed.pdf');
      const before = await prisma.clientDocument.count({ where: { clientId: c.id } });
      check('L2 check & preview: valid, the signer named, nothing saved yet', chk.status === 200 && chk.body.signer && before === 2, [chk.status, chk.body, before]);
      const sub = await post(`/api/agreement/token/${token}/esigned`, buf, 'signed.pdf');
      check('L3 submit: kept as the client\'s DigiLocker copy; with TeamLink\'s copy the agreement is Active', sub.status === 201 && sub.body.agreementStatus === 'ACTIVE', [sub.status, sub.body]);
      const files = await SF.filesOf(c.id);
      check('L4 it shows in View agreement on the right (Client eSigned copy, valid)', files.some((f) => f.kind === 'Client eSigned copy (DigiLocker)' && f.esign && f.esign.valid), files.map((f) => [f.kind, f.esign && f.esign.valid]));
      await new Promise((ok) => setTimeout(ok, 2500));
      check('L5 a thank-you to the client is in the history', !!(await prisma.auditLog.findFirst({ where: { entityId: c.id, action: 'Agreement thank-you sent to the client' } })), null);
      const again = await post(`/api/agreement/token/${token}/esigned`, buf, 'signed.pdf');
      check('L6 the link is closed once it is signed', again.status === 409, again.status);
      // the agreement PDF fills Sign / Date from DigiLocker
      const done = await prisma.client.findUnique({ where: { id: c.id } });
      const parts = [];
      const sink = new (require('stream').PassThrough)();
      sink.on('data', (b) => parts.push(b));
      const end = new Promise((ok) => sink.on('end', ok));
      await P.renderAgreementPdf(done, { trail: [], consultantName: 'TeamLink' }, sink);
      await end;
      const words = require('../src/utils/pdfSignature').textOf(Buffer.concat(parts));
      check('P1 the agreement shows both sides signed with Aadhaar eSign (DigiLocker), no "Waiting for ... signature"', /Aadhaar eSign \(DigiLocker\): ZZTEST signer/.test(words) && /Aadhaar eSign \(DigiLocker\): (?!ZZTEST)\S+/.test(words) && !/Waiting for (TeamLink|client) signature/.test(words), (words.match(/Sign:.{0,80}/g) || []).slice(0, 2));
    } else console.log('SKIP  L2-L6, P1 (set ESIGN_CLIENT)');
  } catch (e) {
    console.log('TEST CRASHED', (e && e.stack) || e);
    Z.fail += 1;
  }
  try {
    const cl = await prisma.client.findMany({ where: { name: { contains: 'ZZTEST ACS' } }, select: { id: true } });
    const ids = cl.map((x) => x.id);
    const docs = await prisma.clientDocument.findMany({ where: { clientId: { in: ids } } });
    await prisma.appSetting.deleteMany({ where: { key: { in: docs.map((d) => `agrsigned.${d.id}`) } } });
    docs.forEach((d) => require('../src/utils/attachments').remove(d.fileStored));
    await prisma.clientDocument.deleteMany({ where: { clientId: { in: ids } } });
    await ours.removeAll();
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } });
    console.log('cleanup left:', JSON.stringify(await Z.cleanup()));
  } catch (e) { console.log('cleanup problem', e.message); }
  await Z.finish();
})();
