#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHATSAPP TO AN EMPLOYEE -> OMNI-CHANNEL CHAT (src/utils/omniMirrorSend.js). npm run omni-mirror-test
//  1. who is mirrored and who is not (plain objects, a stub in place of Omni-Channel);
//  2. the whole way to a MOCK Green Start on a local port: sign-in, workspace, find the open chat, POST /conversations/import-outbound with the right words.
// It never talks to the real Green Start: GREENSTART_API_PORT points at the mock, and the database is a throw-away file.
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

// a throw-away database (the sign-in email and the number map are read from AppSetting)
const tmpDb = path.join(os.tmpdir(), `omni-mirror-test-${process.pid}.db`);
process.env.GREENSTART_SSO_SECRET = 'x'.repeat(40);
process.env.GREENSTART_SSO_EMAIL = 'company@example.test';
delete process.env.TEST_MODE; delete process.env.TEAMLINK_SANDBOX;

let passed = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { passed += 1; console.log(`  ok   ${name}`); }, (e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }); }

const base = { audience: 'employees', kind: 'individual', waNumberId: 'num1' };
const sent = { channel: 'WhatsApp', status: 'sent', address: '98765 43210', text: 'Hi Asha, a reminder', providerRef: 'wamid.ABC', numberId: 'num1' };

(async () => {
  console.log('WhatsApp to an employee -> Omni-Channel chat');
  const M = require('../src/utils/omniMirrorSend');

  await t('a one-person WhatsApp to an employee is mirrored, with the number, the words and the provider id', () => {
    const calls = [];
    const ok = M.afterSend(base, sent, { mirror: (...a) => { calls.push(a); return Promise.resolve(); } });
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(calls[0], ['919876543210', 'Hi Asha, a reminder', 'wamid.ABC', 'num1']);
  });
  await t('everything else is left alone', () => {
    const stub = { mirror: () => { throw new Error('must not be called'); } };
    [
      [{ ...base, audience: 'candidates' }, sent], [{ ...base, audience: 'clients' }, sent], [{ ...base, kind: 'bulk' }, sent],
      [base, { ...sent, channel: 'Email' }], [base, { ...sent, channel: 'SMS' }], [base, { ...sent, status: 'failed' }], [base, { ...sent, status: 'blocked' }],
      [base, { ...sent, sandbox: true }], [base, { ...sent, text: '   ' }], [base, { ...sent, address: 'not a number' }],
    ].forEach(([job, r]) => assert.strictEqual(M.afterSend(job, r, stub), false));
  });
  await t('where Omni-Channel is switched off (a second company) nothing is called', () => {
    const was = process.env.GREENSTART_ENABLED;
    process.env.GREENSTART_ENABLED = 'false';
    assert.strictEqual(M.afterSend(base, sent, { mirror: () => { throw new Error('must not be called'); } }), false);
    if (was === undefined) delete process.env.GREENSTART_ENABLED; else process.env.GREENSTART_ENABLED = was;
  });
  await t('a failing Omni-Channel never reaches the sender', () => {
    assert.strictEqual(M.afterSend(base, sent, { mirror: () => Promise.reject(new Error('down')) }), true);
    assert.strictEqual(M.afterSend(base, sent, { mirror: () => { throw new Error('boom'); } }), false);
  });

  // ---- the whole way, to a mock Green Start -----------------------------------------------------------------------------------------
  const got = { auth: 0, imports: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data })); };
      if (req.url.startsWith('/api/v1/auth/teamlink')) { got.auth += 1; return send({ accessToken: 'mock-token' }); }
      if (req.url.startsWith('/api/v1/workspaces')) return send([{ id: 'ws-medical', name: 'Medical', createdAt: '2026-01-01' }]);
      if (req.url.startsWith('/api/v1/conversations/import-outbound')) { got.imports.push({ ws: req.headers['x-workspace-id'], auth: req.headers.authorization, body: JSON.parse(body || '{}') }); return send({ stored: true }); }
      if (req.url.startsWith('/api/v1/conversations?')) return send({ items: [{ id: 'c1', lastMessageAt: new Date().toISOString() }] });
      res.statusCode = 404; return res.end('{"success":false}');
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.GREENSTART_API_PORT = String(server.address().port);
  process.env.DATABASE_URL = `file:${tmpDb.replace(/\\/g, '/')}`;
  let prisma = null;
  try {
    // an empty database file is enough: the helpers only read AppSetting, and a missing table just means "no setting"
    fs.writeFileSync(tmpDb, '');
    prisma = require('../src/db');
    await t('through gsCampaign.mirror: sign-in, the workspace with the open chat, and import-outbound with the right words', async () => {
      assert.strictEqual(M.afterSend(base, sent), true);
      for (let i = 0; i < 40 && !got.imports.length; i += 1) await new Promise((r) => { setTimeout(r, 100); }); // eslint-disable-line no-await-in-loop
      assert.strictEqual(got.auth, 1, 'signed in once');
      assert.strictEqual(got.imports.length, 1, 'one import');
      assert.strictEqual(got.imports[0].ws, 'ws-medical');
      assert.strictEqual(got.imports[0].auth, 'Bearer mock-token');
      assert.deepStrictEqual(got.imports[0].body, { phone: '919876543210', text: 'Hi Asha, a reminder', providerMessageId: 'wamid.ABC' });
    });
  } finally {
    server.close();
    if (prisma && prisma.$disconnect) await prisma.$disconnect().catch(() => {});
    for (const sfx of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + sfx); } catch { /* none */ } }
  }
  console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})();
