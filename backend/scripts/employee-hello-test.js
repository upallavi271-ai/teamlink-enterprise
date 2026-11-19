#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE "SAY HELLO" OPENER FOR AN EMPLOYEE'S WHATSAPP CHAT (Organization Chart, founder 2026-11-18) - checks of the built-in wording.
// No server and no real database: the database module is replaced by a recorder.   npm run employee-hello-test
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const assert = require('assert');
const Module = require('module');

const created = [];
const fakeDb = {
  messageTemplate: {
    findMany: async () => [],
    create: async ({ data }) => { created.push(data); return { id: `t${created.length}`, ...data }; },
    findFirst: async () => null,
    update: async () => ({}),
  },
  messageTemplateVersion: { updateMany: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === '../db') return fakeDb;
  return origLoad.call(this, request, parent, ...rest);
};
// eslint-disable-next-line global-require
const defaults = require('../src/utils/messageDefaults');
// eslint-disable-next-line global-require
const T = require('../src/utils/messageTemplates');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('Say hello (employee WhatsApp opener)');
  await t('there is a built-in "Say hello" message for employees on WhatsApp', () => {
    const hello = defaults.list().filter((d) => d.purpose === 'EMPLOYEE_HELLO');
    assert.ok(hello.some((d) => d.channel === 'WhatsApp'), 'WhatsApp wording');
    hello.forEach((d) => { assert.strictEqual(d.audience, 'employee'); assert.strictEqual(d.label, 'Say hello'); });
  });
  await t('it asks them to reply (that is what opens the 24 hours) and only uses words the sender knows', () => {
    const d = defaults.find('EMPLOYEE_HELLO', 'WhatsApp');
    assert.ok(/reply/i.test(d.body), 'asks for a reply');
    const keys = new Set((T.TOKENS || []).map((x) => x.key));
    (d.body.match(/\{\{\s*(\w+)\s*\}\}/g) || []).map((m) => m.replace(/[{}\s]/g, '')).forEach((k) => assert.ok(keys.has(k), `unknown word {{${k}}}`));
  });
  await t('the first time messages are listed it is saved as a normal, editable template', async () => {
    const out = await T.ensureDefaults();
    assert.ok(out && out.supported !== false, 'supported');
    const row = created.find((r) => r.purpose === 'EMPLOYEE_HELLO' && r.channel === 'WhatsApp');
    assert.ok(row, 'EMPLOYEE_HELLO saved');
    assert.strictEqual(row.audience, 'employee');
    assert.strictEqual(row.builtIn, true);
    assert.strictEqual(row.active, true);
  });
  await t('the other employee messages are still there', () => {
    const purposes = defaults.list().filter((d) => d.audience === 'employee' && d.channel === 'WhatsApp').map((d) => d.purpose).sort();
    assert.deepStrictEqual(purposes, ['EMPLOYEE_HELLO', 'EMPLOYEE_NOTICE', 'EMPLOYEE_REMINDER']);
  });
  console.log(`\n${passed} checks passed${process.exitCode ? ' - SOME FAILED' : ''}`);
})();
