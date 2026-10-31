#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CLIENT PUTS THEIR STAMP ON, TEAMLINK'S STAMP COMES BY ITSELF (founder 2026-10-31: "client ey stamp veyyali"). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/client-stamp-test.js
//
// Send to client -> the email carries the stamp link (no unstamped PDF attached) -> the PDF to eSign is refused until the client
// has put a stamp on -> stamp uploaded through the link -> the PDF to eSign comes with TeamLink's saved stamp and the client's.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('CST');

const { prisma, check, RUN } = Z;
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const imagesIn = (buf) => (buf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;

(async () => {
  await Z.preclean();
  const ours = require('./lib/teamlinkSigned')(prisma);
  const seal = require('../src/utils/teamlinkSeal');
  const att = require('../src/utils/attachments');
  const sealBefore = await prisma.appSetting.findUnique({ where: { key: seal.KEY } });
  let savedStamp = null;
  try {
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const tk = await Z.mint(admin);
    const c = await prisma.client.create({
      data: {
        name: `ZZTEST CST Client ${RUN}`, industry: 'IT', location: 'Hyderabad', ownerDepartment: 'IT', clientType: 'Client', agreementStatus: 'DRAFT',
        contactName: 'Ravi Kumar', contactEmail: `zz-cst-${RUN}@example.test`, contactPhone: '9000000004', agreementFeePercent: 8.33,
        guaranteePeriod: '30 Days', paymentTerms: 'Invoice 6 days after joining; payment due within 6 days of invoice', agreementId: `AGRZZ${RUN}`.slice(0, 12), agreementSource: 'Generated',
      },
    });
    Z.made.clients.push(c.id);
    const A = require('../src/utils/agreement');
    await prisma.client.update({ where: { id: c.id }, data: { agreementDocument: A.buildAgreementDocument(c, await A.consultantParty()) } });

    // TeamLink's stamp saved once in Agreement settings (a stand-in picture)
    savedStamp = att.store({ contentType: 'image/png', filename: 'zz-teamlink-stamp.png', data: PNG }).billFile;
    await prisma.appSetting.upsert({ where: { key: seal.KEY }, update: { value: JSON.stringify({ ...(sealBefore ? JSON.parse(sealBefore.value) : {}), stampFile: savedStamp }) }, create: { key: seal.KEY, value: JSON.stringify({ stampFile: savedStamp }) } });

    // TeamLink's own copy to eSign: TeamLink's stamp printed by itself
    const mine = await fetch(`${process.env.TL_API}/api/agreement/${c.id}/pdf?fresh=1`, { headers: { Authorization: `Bearer ${tk}` } });
    const mineBuf = Buffer.from(await mine.arrayBuffer());
    check('1 TeamLink\'s copy to eSign carries TeamLink\'s saved stamp (no client stamp yet)', mine.status === 200 && imagesIn(mineBuf) >= 2, [mine.status, imagesIn(mineBuf)]);

    await ours.add(c.id);
    const sent = await Z.call('POST', `/api/clients/${c.id}/agreement/send`, tk, {});
    check('2 Admin sends it to the client', sent.status === 200, [sent.status, sent.body && sent.body.error]);
    const fresh = await prisma.client.findUnique({ where: { id: c.id } });
    const token = require('../src/utils/agreementSigning').tokenFor(fresh);

    const noStamp = await fetch(`${process.env.TL_API}/api/agreement/token/${token}/esign-pdf`);
    check('3 the PDF to eSign is refused until the client has put a stamp on', noStamp.status === 409, noStamp.status);

    const fd = new FormData();
    fd.append('kind', 'client-stamp');
    fd.append('file', new Blob([PNG], { type: 'image/png' }), 'stamp.png');
    const up = await fetch(`${process.env.TL_API}/api/agreement/token/${token}/client-seal`, { method: 'POST', body: fd });
    const upBody = await up.json().catch(() => ({}));
    check('4 the client puts their stamp on through the link (no login)', up.status === 200 && upBody.hasStamp === true, [up.status, upBody.error]);

    const pdf = await fetch(`${process.env.TL_API}/api/agreement/token/${token}/esign-pdf`);
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    const words = require('../src/utils/pdfSignature').textOf(pdfBuf);
    check('5 the PDF to eSign: both stamps printed, the agreement number on it, no "Waiting for" words', pdf.status === 200 && pdfBuf.subarray(0, 5).toString() === '%PDF-' && imagesIn(pdfBuf) > imagesIn(mineBuf) && words.includes(fresh.agreementId) && !/Waiting for/.test(words), [pdf.status, imagesIn(pdfBuf), imagesIn(mineBuf)]);

    // the email: the stamp link, the DigiLocker steps, TeamLink's signed copy; no unstamped PDF to sign
    process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || require('path').join(require('os').homedir(), '.teamlink-sandbox', 'uploads');
    const M = require('../src/utils/messaging');
    const real = M.send; const out = [];
    M.send = async (ch, msg) => { out.push({ ch, msg }); return { ok: true, outcome: 'Sent' }; };
    try { await require('../src/utils/agreementLifecycle').dispatchSigningLink({ client: fresh, url: `https://teamlink.example/agreement/${token}` }); } finally { M.send = real; }
    const em = (out.find((x) => x.ch === 'Email') || {}).msg || {};
    check('6 the email has the stamp link and the steps; TeamLink\'s signed copy attached, no unstamped copy to sign',
      (em.text || '').includes(`https://teamlink.example/agreement/${token}/stamp`) && /company stamp/.test(em.text || '') && (em.attachments || []).length === 1 && /signed-by-TeamLink/.test(em.attachments[0].filename),
      [(em.attachments || []).map((a) => a.filename), (em.text || '').slice(0, 300)]);
    const sms = (out.find((x) => x.ch === 'SMS') || {}).msg || {};
    check('7 the SMS points to the stamp link too', (sms.text || '').includes('/stamp'), sms.text);
  } catch (e) {
    console.log('TEST CRASHED', (e && e.stack) || e);
    Z.fail += 1;
  }
  try {
    if (sealBefore) await prisma.appSetting.update({ where: { key: seal.KEY }, data: { value: sealBefore.value } });
    else await prisma.appSetting.deleteMany({ where: { key: seal.KEY } });
    if (savedStamp) att.remove(savedStamp);
    const cl = await prisma.client.findMany({ where: { name: { contains: 'ZZTEST CST' } }, select: { id: true, agreementClientStampFile: true } });
    cl.forEach((x) => x.agreementClientStampFile && att.remove(x.agreementClientStampFile));
    await ours.removeAll();
    await prisma.auditLog.deleteMany({ where: { entityId: { in: cl.map((x) => x.id) } } });
    console.log('cleanup left:', JSON.stringify(await Z.cleanup()));
  } catch (e) { console.log('cleanup problem', e.message); }
  await Z.finish();
})();
