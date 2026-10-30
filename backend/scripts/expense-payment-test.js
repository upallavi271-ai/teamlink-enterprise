// ---------------------------------------------------------------------------
// Expense claims: how the claimant is paid (routes/employeeRecords.js payData + /pay/* + /:id/pay-qr, utils/claimPayPhone.js).
// Runs the real router on a COPY of the database (VACUUM INTO a temp file - the real one is only read) with the SMS door replaced
// by a stand-in that captures the code; the uploaded QR test files are removed at the end.
//   node scripts/expense-payment-test.js
// ---------------------------------------------------------------------------
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { PrismaClient } = require('@prisma/client');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };

(async () => {
  // 1. a copy of the database
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-exp-'));
  const copy = path.join(tmp, 'copy.db').replace(/\\/g, '/');
  const real = new PrismaClient();
  await real.$executeRawUnsafe(`VACUUM INTO '${copy}'`);
  await real.$disconnect();
  process.env.DATABASE_URL = `file:${copy}`;

  // 2. the SMS door: deliverable, and the code is captured here instead of sent
  let lastCode = null;
  const realV = require('../src/utils/employeeVerification');
  stub('../src/utils/employeeVerification', { ...realV, smsChannel: async () => ({ configured: true, deliverable: true, provider: 'test' }), sendCode: async ({ otp }) => { lastCode = otp; return { ok: true, provider: 'test' }; } });
  const prisma = require('../src/db');
  const withBank = await prisma.employee.findFirst({ where: { userId: { not: null }, AND: [{ bankAccountNumber: { not: null } }, { bankAccountNumber: { not: '' } }, { ifscCode: { not: null } }, { ifscCode: { not: '' } }] }, select: { id: true, userId: true, name: true, bankAccountNumber: true } });
  const noBank = await prisma.employee.findFirst({ where: { userId: { not: null }, OR: [{ bankAccountNumber: null }, { ifscCode: null }] }, select: { id: true, userId: true } });
  if (!withBank || !noBank) { console.log('the copy has no employee with / without bank details to test with'); process.exit(1); }
  // the signed-in employee (self-service)
  let me = withBank;
  stub('../src/middleware/auth', {
    ...require('../src/middleware/auth'),
    requireAuth: (req, _res, next) => { req.user = { id: me.userId, employeeId: me.id, name: 'Test', role: 'EMPLOYEE', caps: { hrmsSelfOnly: true } }; next(); },
  });
  stub('../src/utils/audit', { logAudit: async () => null });
  const app = express(); app.use(express.json());
  app.use('/api/expenses', require('../src/routes/employeeRecords')('EXPENSE', { attachments: true }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/expenses`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json', ...headers } : headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: /json/.test(type) ? await r.json() : await r.arrayBuffer(), type };
  };
  const made = [];
  try {
    // ---- bank ----
    let r = await call('GET', '/pay/bank');
    ok('bank on the profile: shown masked on the form (only the last 4 digits)', r.status === 200 && r.body.onFile === true && r.body.account === `****${withBank.bankAccountNumber.replace(/\s+/g, '').slice(-4)}` && !JSON.stringify(r.body).includes(withBank.bankAccountNumber), r.body.account);
    r = await call('POST', '/', { title: 'ZZ test taxi', amount: 250, payMethod: 'BANK', employeeId: me.id });
    made.push(r.body.id);
    ok('claim paid to the bank account: saved with the masked account', r.status === 201 && r.body.payMethod === 'BANK' && /A\/c \*{4}/.test(r.body.payBank), r.body.payBank);
    me = noBank;
    r = await call('POST', '/', { title: 'ZZ test bus', amount: 90, payMethod: 'BANK', employeeId: me.id });
    ok('no bank account on the profile: refused with what to do', r.status === 400 && /My Profile/.test(r.body.error));
    me = withBank;

    // ---- phone ----
    r = await call('POST', '/pay/phone/start', { phone: '12345' });
    ok('phone: a wrong number is refused before any SMS', r.status === 400 && lastCode === null);
    r = await call('POST', '/pay/phone/start', { phone: '+91 98765 43210' });
    ok('phone: the code goes out by SMS (never returned to the screen)', r.status === 200 && r.body.sent === true && /^\d{6}$/.test(lastCode) && !JSON.stringify(r.body).includes(lastCode), r.body.to);
    r = await call('POST', '/pay/phone/start', { phone: '9876543210' });
    ok('phone: one code a minute', r.status === 429);
    r = await call('POST', '/pay/phone/confirm', { phone: '9876543210', code: lastCode === '000000' ? '111111' : '000000' });
    ok('phone: a wrong code is refused, tries counted', r.status === 400 && /tries left/.test(r.body.error));
    r = await call('POST', '/pay/phone/confirm', { phone: '9876543210', code: lastCode });
    const proof = r.body.proof;
    ok('phone: the right code proves the number', r.status === 200 && r.body.verified === true && proof);
    r = await call('POST', '/', { title: 'ZZ test auto', amount: 120, payMethod: 'PHONE', payPhone: '9876543210', payPhoneProof: 'bad.proof', employeeId: me.id });
    ok('phone: a claim without the real proof is refused', r.status === 400 && /Verify the phone/.test(r.body.error));
    r = await call('POST', '/', { title: 'ZZ test auto', amount: 120, payMethod: 'PHONE', payPhone: '9999999999', payPhoneProof: proof, employeeId: me.id });
    ok('phone: the proof for one number does not cover another', r.status === 400);
    r = await call('POST', '/', { title: 'ZZ test auto', amount: 120, payMethod: 'PHONE', payPhone: '9876543210', payPhoneProof: proof, employeeId: me.id });
    made.push(r.body.id);
    ok('phone: claim saved with the proved number, marked verified', r.status === 201 && r.body.payPhone === '9876543210' && !!r.body.payPhoneVerifiedAt);

    // ---- QR ----
    r = await call('POST', '/', { title: 'ZZ test lunch', amount: 300, payMethod: 'QR', employeeId: me.id });
    made.push(r.body.id);
    const qrId = r.body.id;
    ok('QR: the claim is saved first', r.status === 201 && r.body.payMethod === 'QR');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    let fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'my-upi-qr.png');
    r = await call('POST', `/${qrId}/pay-qr`, fd);
    ok('QR: the picture is stored on the claim', r.status === 200 && !!r.body.payQrFile && r.body.payQrName === 'my-upi-qr.png', r.body.error);
    r = await call('GET', `/${qrId}/pay-qr`);
    ok('QR: it can be opened again (same scope as the claim)', r.status === 200 && /image\/png/.test(r.type) && Buffer.from(r.body).equals(png));
    fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%test\n')], { type: 'application/pdf' }), 'bill.pdf');
    r = await call('POST', `/${qrId}/pay-qr`, fd);
    ok('QR: a PDF is refused (a QR is a picture)', r.status === 400 && /picture/.test(r.body.error));

    r = await call('POST', '/', { title: 'ZZ test misc', amount: 10, payMethod: 'CASH', employeeId: me.id });
    ok('an unknown payment method is refused', r.status === 400);
  } finally {
    server.close();
    const attachments = require('../src/utils/attachments');
    for (const id of made.filter(Boolean)) {
      // eslint-disable-next-line no-await-in-loop
      const rec = await prisma.employeeRecord.findUnique({ where: { id } }).catch(() => null);
      if (rec && rec.payQrFile) attachments.remove(rec.payQrFile);
    }
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
