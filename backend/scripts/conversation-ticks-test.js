#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TICKS ON WHAT WAS SENT TO AN EMPLOYEE OR A CLIENT - checks of utils/conversations.js applyStatus (the delivery / read report of Meta moves the tick).
// No server and no real database: the database module is replaced by a small recorder.   npm run conversation-ticks-test
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const assert = require('assert');
const Module = require('module');

const rows = []; // ConversationMessage rows: { id, status, providerRef, direction, statusDetail }
const fakeDb = {
  $queryRawUnsafe: async (sql, ...p) => {
    if (/sqlite_master/.test(sql)) return [{ name: 'Conversation' }, { name: 'ConversationMessage' }];
    if (/FROM "ConversationMessage" WHERE "providerRef"/.test(sql)) return rows.filter((r) => r.providerRef === p[0] && r.direction === p[1]).map(({ id, status }) => ({ id, status }));
    return [];
  },
  $executeRawUnsafe: async (sql, ...p) => {
    const m = /UPDATE "ConversationMessage" SET "status" = \?(, "statusDetail" = \?)? WHERE "id" = \?/.exec(sql);
    if (!m) return 0;
    const row = rows.find((r) => r.id === p[p.length - 1]);
    row.status = p[0];
    if (m[1]) row.statusDetail = p[1];
    return 1;
  },
};
const origLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === '../db') return fakeDb;
  return origLoad.call(this, request, parent, ...rest);
};
// eslint-disable-next-line global-require
const convo = require('../src/utils/conversations');

let passed = 0;
async function t(name, fn) {
  rows.length = 0;
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const out = (id, status, providerRef, extra = {}) => rows.push({ id, status, providerRef, direction: 'OUT', statusDetail: null, ...extra });

(async () => {
  console.log('Ticks on a message sent to an employee');
  await t('Sent -> Delivered -> Read, matched by the provider message id', async () => {
    out('m1', 'SENT', 'wamid.A');
    assert.strictEqual(await convo.applyStatus('wamid.A', 'delivered'), 1);
    assert.strictEqual(rows[0].status, 'DELIVERED');
    assert.strictEqual(await convo.applyStatus('wamid.A', 'READ'), 1);
    assert.strictEqual(rows[0].status, 'READ');
  });
  await t('a row never goes backwards: a late "sent" or "delivered" after "read" changes nothing', async () => {
    out('m1', 'READ', 'wamid.A');
    assert.strictEqual(await convo.applyStatus('wamid.A', 'SENT'), 0);
    assert.strictEqual(await convo.applyStatus('wamid.A', 'DELIVERED'), 0);
    assert.strictEqual(rows[0].status, 'READ');
  });
  await t('the same report twice changes nothing the second time', async () => {
    out('m1', 'SENT', 'wamid.A');
    assert.strictEqual(await convo.applyStatus('wamid.A', 'DELIVERED'), 1);
    assert.strictEqual(await convo.applyStatus('wamid.A', 'DELIVERED'), 0);
  });
  await t('a failure is kept with the provider\'s reason', async () => {
    out('m1', 'SENT', 'wamid.A');
    assert.strictEqual(await convo.applyStatus('wamid.A', 'FAILED', { error: 'Message undeliverable' }), 1);
    assert.strictEqual(rows[0].status, 'FAILED');
    assert.strictEqual(rows[0].statusDetail, 'Not delivered: Message undeliverable');
  });
  await t('only OUT rows with THAT id are touched; an incoming row or another id is left alone', async () => {
    out('m1', 'SENT', 'wamid.A');
    out('m2', 'SENT', 'wamid.B');
    rows.push({ id: 'in1', status: 'RECEIVED', providerRef: 'wamid.A', direction: 'IN', statusDetail: null });
    assert.strictEqual(await convo.applyStatus('wamid.A', 'READ'), 1);
    assert.deepStrictEqual(rows.map((r) => r.status), ['READ', 'SENT', 'RECEIVED']);
  });
  await t('no message id, or a word that is not a tick, does nothing', async () => {
    out('m1', 'SENT', 'wamid.A');
    assert.strictEqual(await convo.applyStatus('', 'READ'), 0);
    assert.strictEqual(await convo.applyStatus('wamid.A', 'banana'), 0);
    assert.strictEqual(rows[0].status, 'SENT');
  });
  console.log(`\n${passed} checks passed${process.exitCode ? ' - SOME FAILED' : ''}`);
})();
