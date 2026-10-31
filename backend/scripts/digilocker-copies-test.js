#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE TWO DIGILOCKER COPIES OF AN AGREEMENT (founder 2026-10-31) - COPY DATABASE ONLY, never dev.db.
//
//   cd backend && npm run sandbox -- --restart --detach --no-watch
//   TL_API=http://localhost:4011 TL_TEST_DB=<absolute path of prisma/sandbox.db> \
//   ESIGN_TEAMLINK=<a PDF eSigned in DigiLocker> ESIGN_CLIENT=<another PDF eSigned in DigiLocker> \
//   ESIGN_MERGED=<optional: a merged / printed copy with no signature> node scripts/digilocker-copies-test.js
//
// Real DigiLocker-signed PDFs carry a person's Aadhaar name, so they are NOT kept in the repository: point the test at them.
//   1. a merged / printed PDF (only pictures of signature boxes) is refused
//   2. a signed PDF changed after signing is refused
//   3. the TeamLink copy is taken with its signer's name; the agreement does not turn Active on one copy
//   4. the client copy is taken; both valid -> the agreement is Active (source: DigiLocker Aadhaar eSign)
//   5. GET signed-files shows each copy's check (valid, signer, certificate)
// A ZZTEST client is made and removed again.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (a copy-database server), never 4010.'); process.exit(2); }
const DB = process.env.TL_TEST_DB;
if (!DB || /dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to the absolute path of a COPY database (never dev.db).'); process.exit(2); }
const A = process.env.ESIGN_TEAMLINK; const C = process.env.ESIGN_CLIENT; const M = process.env.ESIGN_MERGED;
if (!A || !C || !fs.existsSync(A) || !fs.existsSync(C)) { console.log('SKIP  set ESIGN_TEAMLINK and ESIGN_CLIENT to two DigiLocker-signed PDFs'); process.exit(0); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
async function upload(clientId, type, buf, name, token) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/pdf' }), name);
  const r = await fetch(`${API}/api/agreement/${clientId}/signed-files?type=${type}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.1` }, body: fd });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
}

(async () => {
  let clientId = null;
  const extra = []; // more clients made by D10 / D11
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, orderBy: { createdAt: 'asc' } });
    await prisma.user.update({ where: { id: admin.id }, data: { passwordChangedAt: new Date() } });
    const T = jwt.sign(tokenPayload(await resolveIdentity(admin.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const client = await prisma.client.create({ data: { name: `ZZTEST DL Client ${RUN}`, legalName: `ZZTEST DL Client ${RUN}`, status: 'Active', clientType: 'Direct', agreementStatus: 'SENT' } });
    clientId = client.id;
    const bufA = fs.readFileSync(A); const bufC = fs.readFileSync(C);

    if (M && fs.existsSync(M)) {
      const m = await upload(clientId, 'dlclient', fs.readFileSync(M), 'merged.pdf', T);
      check('D1 a merged / printed PDF (signature boxes as pictures only) is refused', m.status === 400 && /no digital signature/i.test(m.body && m.body.error), m);
    } else console.log('SKIP  D1 (set ESIGN_MERGED)');
    const bad = Buffer.from(bufA); const at = bad.indexOf('stream') + 20; bad[at] ^= 1;
    const t = await upload(clientId, 'dlteamlink', bad, 'changed.pdf', T);
    check('D2 a signed PDF changed after signing is refused', t.status === 400 && /not valid/i.test(t.body && t.body.error), t);

    const a = await upload(clientId, 'dlteamlink', bufA, 'teamlink-signed.pdf', T);
    check('D3 the TeamLink copy is taken, with a valid signature and its signer', a.status === 201 && /Valid Aadhaar eSign by/.test(a.body.message), a);
    let c1 = await prisma.client.findUnique({ where: { id: clientId }, select: { agreementStatus: true } });
    check('D4 one copy alone does not make the agreement Active', c1.agreementStatus !== 'ACTIVE', c1);

    const c = await upload(clientId, 'dlclient', bufC, 'client-signed.pdf', T);
    c1 = await prisma.client.findUnique({ where: { id: clientId }, select: { agreementStatus: true, agreementSource: true, agreementActivatedAt: true } });
    check('D5 the client copy is taken; both valid -> Active (source: DigiLocker Aadhaar eSign)', c.status === 201 && c1.agreementStatus === 'ACTIVE' && /DigiLocker/.test(c1.agreementSource || '') && !!c1.agreementActivatedAt, [c.status, c1]);

    const g = await fetch(`${API}/api/agreement/${clientId}/signed-files`, { headers: { Authorization: `Bearer ${T}` } }).then((r) => r.json());
    const dl = (g.files || []).filter((f) => /DigiLocker/.test(f.kind));
    check('D6 GET signed-files shows both copies with their check (valid, signer, certificate)', dl.length === 2 && dl.every((f) => f.esign && f.esign.valid && f.esign.signer && f.esign.issuer), dl.map((f) => [f.kind, f.esign]));
    const sum = await fetch(`${API}/api/agreement/${clientId}/esign-summary`, { headers: { Authorization: `Bearer ${T}` } });
    const sumBuf = Buffer.from(await sum.arrayBuffer());
    check('D7 the signature summary (both sides on one page) is a PDF', sum.status === 200 && sumBuf.subarray(0, 5).toString() === '%PDF-' && sumBuf.length > 2000, [sum.status, sumBuf.length]);
    // the web links on the summary open each signed copy in any browser, with no login (founder 2026-10-31)
    const urls = [...sumBuf.toString('latin1').matchAll(/\/URI \((http[^)]*esign-copy[^)]*)\)/g)].map((m) => m[1].split('\\').join(''));
    const got = await Promise.all(urls.map((u) => fetch(u.replace(/^https?:\/\/[^/]+/, API)).then(async (r) => ({ s: r.status, b: Buffer.from(await r.arrayBuffer()) }))));
    const want = [fs.readFileSync(A), fs.readFileSync(C)].map((b) => b.toString('base64'));
    check('D8 the summary has a browser link for each copy; each opens without login, byte for byte', urls.length === 2 && got.every((g) => g.s === 200 && want.includes(g.b.toString('base64'))), [urls, got.map((g) => g.s)]);
    const badLink = urls[0] ? await fetch(urls[0].replace(/^https?:\/\/[^/]+/, API).replace(/[a-f0-9]$/, (x) => (x === 'a' ? 'b' : 'a'))) : { status: 0 };
    check('D9 a changed link does not open anything', badLink.status === 404, badLink.status);
    // THANK YOU once Active (founder 2026-10-31): the history says it went out, and the email carries both copies + the summary
    await new Promise((ok) => setTimeout(ok, 2500));
    const ty = await prisma.auditLog.findFirst({ where: { entityId: clientId, action: 'Agreement thank-you sent to the client' } });
    check('D12 a thank-you to the client is written in the history once it is Active', !!ty, ty);
    {
      const os = require('os'); // eslint-disable-line global-require
      process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || require('path').join(process.env.TEAMLINK_SANDBOX_FILES || require('path').join(os.homedir(), '.teamlink-sandbox'), 'uploads'); // eslint-disable-line global-require
      const M = require('../src/utils/messaging'); // eslint-disable-line global-require
      const real = M.send; const sent = [];
      M.send = async (ch, msg) => { sent.push({ ch, msg }); return { ok: true, outcome: 'Sent' }; };
      await prisma.client.update({ where: { id: clientId }, data: { contactName: 'Ravi Kumar Name:', contactEmail: 'ravi@acme-zz.in', contactPhone: '9000000003' } });
      try { await require('../src/utils/agreementLifecycle').dispatchThankYou(clientId); } finally { M.send = real; } // eslint-disable-line global-require
      const em = (sent.find((x) => x.ch === 'Email') || {}).msg || {};
      const names = (em.attachments || []).map((a) => a.filename);
      check('D13 the thank-you email: "Dear Ravi Kumar", both signed copies and the summary attached, SMS + WhatsApp too',
        /^Dear Ravi Kumar,/.test(em.text || '') && /Thank you/.test(em.subject || '') && names.length === 3 && names.some((n) => /signed-by-client/.test(n)) && names.some((n) => /signed-by-TeamLink/.test(n)) && names.some((n) => /signature-summary/.test(n))
          && (em.attachments || []).every((a) => a.content && a.content.subarray(0, 5).toString() === '%PDF-') && sent.some((x) => x.ch === 'SMS') && sent.some((x) => x.ch === 'WhatsApp'),
        [em.subject, (em.text || '').slice(0, 40), names]);
    }
    // ESIGN_OTHER: optional, a DigiLocker copy of ANOTHER agreement (its pages carry a different AGR number), signed by the same
    // person as ESIGN_TEAMLINK - proves the two checks behind the green tick (founder 2026-10-31)
    const O = process.env.ESIGN_OTHER;
    if (O && fs.existsSync(O)) {
      const bufO = fs.readFileSync(O);
      const c2 = await prisma.client.create({ data: { name: `ZZTEST DL Client2 ${RUN}`, legalName: `ZZTEST DL Client2 ${RUN}`, status: 'Active', clientType: 'Direct', agreementStatus: 'SENT', agreementId: 'AGR9998', agreementSource: 'Generated' } });
      extra.push(c2.id);
      const w = await upload(c2.id, 'dlteamlink', bufO, 'other-agreement.pdf', T);
      check('D10 a signed PDF of another agreement (other AGR number) is refused', w.status === 400 && /is not agreement AGR9998/.test(w.body && w.body.error), w);
      const c3 = await prisma.client.create({ data: { name: `ZZTEST DL Client3 ${RUN}`, legalName: `ZZTEST DL Client3 ${RUN}`, status: 'Active', clientType: 'Direct', agreementStatus: 'SENT' } });
      extra.push(c3.id);
      await upload(c3.id, 'dlteamlink', bufA, 'teamlink.pdf', T);
      const same = await upload(c3.id, 'dlclient', bufO, 'client.pdf', T);
      check('D11 the client copy signed by the same person as TeamLink is refused', same.status === 400 && /same person/.test(same.body && same.body.error), same);
    } else console.log('SKIP  D10 / D11 (set ESIGN_OTHER)');
  } catch (e) {
    check('no error', false, e.stack || e.message);
  } finally {
    for (const id of [clientId, ...extra].filter(Boolean)) {
      const docs = await prisma.clientDocument.findMany({ where: { clientId: id }, select: { id: true } }).catch(() => []); // eslint-disable-line no-await-in-loop
      await prisma.appSetting.deleteMany({ where: { key: { in: docs.map((d) => `agrsigned.${d.id}`) } } }).catch(() => null); // eslint-disable-line no-await-in-loop
      await prisma.clientDocument.deleteMany({ where: { clientId: id } }).catch(() => null); // eslint-disable-line no-await-in-loop
      await prisma.auditLog.deleteMany({ where: { entityId: id } }).catch(() => null); // eslint-disable-line no-await-in-loop
      await prisma.client.delete({ where: { id } }).catch((e) => console.log('cleanup:', e.message)); // eslint-disable-line no-await-in-loop
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
