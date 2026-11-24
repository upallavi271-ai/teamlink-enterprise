#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AI CALLING BRAIN ON OPENAI - utils/openaiCalling.js, calling/brain.js and the Integrations entry "AI Calling brain (OpenAI)".
// OpenAI itself is NEVER contacted: global fetch is replaced by a recorder. Runs on the SANDBOX database only and removes what it saves.
//   cd backend && TEST_MODE=1 node -r dotenv/config scripts/openai-calling-test.js
// ---------------------------------------------------------------------------
/* eslint-disable no-console, global-require */
const assert = require('assert');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
if (!truthy(process.env.TEST_MODE) && !truthy(process.env.TEAMLINK_SANDBOX)) {
  console.error('Refusing to run: this test writes to the database. Run it with TEST_MODE=1 against the sandbox.');
  process.exit(2);
}
const prisma = require('../src/db');
const store = require('../src/utils/integrationStore');
const catalog = require('../src/utils/adminCatalog');
const O = require('../src/utils/openaiCalling');
const Brain = require('../src/calling/brain');

const CH = O.CHANNEL;
const KEY = 'sk-test-1234567890abcdefghijkl';
const realFetch = global.fetch;
let calls = [];
let reply = () => ({ status: 200, body: {} });
global.fetch = async (url, opts) => {
  calls.push({ url, opts, body: JSON.parse(opts.body) });
  const r = reply(calls[calls.length - 1]);
  if (r.throw) throw r.throw;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};

process.env.TEST_ALLOW_AI = '1'; // OpenAI is a recorder here; the guard test below switches this off for one check
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
async function save(values) {
  const w = await store.writeValues(CH, values);
  await prisma.integration.update({ where: { id: CH }, data: { values: JSON.stringify(w.values), enabled: true, connected: true, state: 'Connected' } });
  O.resetCache(); Brain.resetChannel();
}
const answer = (obj, extra = {}) => ({ status: 200, body: { model: 'gpt-4.1-mini', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(obj) }, ...extra }] } });
const GOOD = { intent: 'answer', language: 'English', experienceYears: 3, location: '', noticeDays: -1, noticeText: '', callbackText: '', callbackAt: '', callbackClear: false, question: '', answeredFromFacts: false, declineReason: '', leadIn: 'Okay, three years, noted.' };
const dlg = () => ({ data: { jobTitle: 'Staff Nurse' }, fields: {}, purpose: 'Screening', language: 'English', st: { transcript: [], lastAsk: 'How many years of experience do you have?' }, knowledge: [] });

(async () => {
  console.log('AI calling brain on OpenAI');
  try {
    await prisma.integrationEvent.deleteMany({ where: { integrationId: CH } }).catch(() => null);
    await prisma.integration.delete({ where: { id: CH } }).catch(() => null);
    O.resetCache(); Brain.resetChannel();

    await t('the Integrations entry exists in the Calling group, is live, and its key field is a secret', () => {
      const c = catalog.integrationById(CH);
      assert.ok(c); assert.strictEqual(c.group, 'Calling');
      assert.deepStrictEqual(c.fields.map((f) => f[0]), ['OpenAI API key', 'Model']);
      assert.ok(catalog.LIVE_CHANNELS.includes(CH));
      assert.ok(store.isSecretField(CH, 'OpenAI API key')); assert.ok(!store.isSecretField(CH, 'Model'));
    });
    await t('nothing saved: not configured, the test says so, the brain does not use OpenAI and OpenAI is never contacted', async () => {
      assert.strictEqual(await O.configured(), false);
      const r = await O.testConnection();
      assert.strictEqual(r.ok, false); assert.ok(/No key is saved/.test(r.message));
      const prevEnv = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'sk-env-should-never-be-used-1234567';
      O.resetCache();
      assert.strictEqual(await O.configured(), false, 'an OPENAI_API_KEY in .env must NOT switch calls to OpenAI');
      if (prevEnv === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevEnv;
      assert.strictEqual(calls.length, 0);
    });
    await t('the saved key is stored encrypted, never as plain text', async () => {
      await save({ 'OpenAI API key': KEY, Model: '' });
      const row = await prisma.integration.findUnique({ where: { id: CH } });
      assert.ok(!row.values.includes(KEY)); assert.ok(/enc:|v1:|"ey|[A-Za-z0-9+/=]{20,}/.test(row.values));
      const pub = store.publicValuesFor(catalog.integrationById(CH), row);
      assert.strictEqual(pub.values['OpenAI API key'], ''); assert.ok(!JSON.stringify(pub).includes(KEY));
    });
    await t('the test sandbox refuses to contact OpenAI unless TEST_ALLOW_AI=1 (a copy of live data must never use the real key)', async () => {
      delete process.env.TEST_ALLOW_AI; calls = []; reply = () => answer(GOOD);
      try { await O.chatJson({ system: 'S', user: 'U', schema: Brain.SCHEMA }); assert.fail('should have refused'); } catch (e) { assert.ok(/TEST SANDBOX/.test(e.message), e.message); }
      const r = await O.testConnection(); assert.ok(!r.ok && /TEST SANDBOX/.test(r.message));
      assert.strictEqual(calls.length, 0, 'fetch was never called');
      process.env.TEST_ALLOW_AI = '1';
    });
    await t('with a key saved it is configured and the default model is used', async () => {
      assert.strictEqual(await O.configured(), true);
      assert.strictEqual(await O.modelName(), 'gpt-4.1-mini');
    });
    await t('Turn off keeps the saved key but stops AI calls from using it; saving again turns it back on', async () => {
      await prisma.integration.update({ where: { id: CH }, data: { connected: false, state: 'Not Connected' } });
      O.resetCache(); Brain.resetChannel();
      assert.strictEqual(await O.configured(), false);
      assert.strictEqual(await Brain.think(dlg(), 'ok'), null, 'a switched-off channel is not asked');
      await save({ 'OpenAI API key': '', Model: '' });
      assert.strictEqual(await O.configured(), true, 'the saved key is still there after turning on again');
    });
    await t('a question is sent to OpenAI with the key, the model, both messages and a strict JSON shape; the answer is parsed', async () => {
      calls = []; reply = () => answer(GOOD);
      const out = await O.chatJson({ system: 'SYS', user: 'USR', schema: Brain.SCHEMA, name: 'call_brain', maxTokens: 600, timeoutMs: 2500 });
      assert.strictEqual(out.leadIn, 'Okay, three years, noted.');
      const c = calls[0];
      assert.strictEqual(c.url, 'https://api.openai.com/v1/chat/completions');
      assert.strictEqual(c.opts.headers.Authorization, `Bearer ${KEY}`);
      assert.strictEqual(c.body.model, 'gpt-4.1-mini');
      assert.deepStrictEqual(c.body.messages.map((m) => m.role), ['system', 'user']);
      assert.strictEqual(c.body.max_completion_tokens, 600);
      assert.strictEqual(c.body.response_format.type, 'json_schema'); assert.strictEqual(c.body.response_format.json_schema.strict, true);
      assert.strictEqual(c.body.temperature, undefined, 'no temperature: reasoning models refuse anything but the default');
    });
    await t('the Model field overrides the default', async () => {
      await save({ 'OpenAI API key': '', Model: 'gpt-5-mini' });
      assert.strictEqual(await O.modelName(), 'gpt-5-mini');
      calls = []; reply = () => answer(GOOD);
      await O.chatJson({ system: 'S', user: 'U', schema: Brain.SCHEMA });
      assert.strictEqual(calls[0].body.model, 'gpt-5-mini');
      assert.strictEqual(calls[0].opts.headers.Authorization, `Bearer ${KEY}`, 'a blank key box keeps the saved key');
      await save({ 'OpenAI API key': '', Model: '' });
    });
    await t('the brain uses OpenAI when a key is saved and returns the same checked shape (intent, years, safe lead-in)', async () => {
      calls = []; reply = () => answer(GOOD);
      assert.strictEqual(await Brain.available(), true);
      const r = await Brain.think(dlg(), 'Haan ji, 3 years experience');
      assert.ok(r); assert.strictEqual(r.intent, 'answer'); assert.strictEqual(r.experienceYears, 3);
      assert.ok(/three years/.test(r.leadIn));
      assert.strictEqual(calls.length, 1); assert.ok(calls[0].url.startsWith('https://api.openai.com/'));
    });
    await t('the brain still checks what OpenAI says: a number from nowhere, a question or a wrong intent is not spoken', async () => {
      reply = () => answer({ ...GOOD, leadIn: 'Okay, we pay 99999 per month.' });
      assert.strictEqual((await Brain.think(dlg(), 'ok')).leadIn, '');
      reply = () => answer({ ...GOOD, leadIn: 'Where do you live?' });
      assert.strictEqual((await Brain.think(dlg(), 'ok')).leadIn, '');
      reply = () => answer({ ...GOOD, intent: 'made-up' });
      assert.strictEqual(await Brain.think(dlg(), 'ok'), null);
    });
    await t('a slow, failed, refused or cut-off answer gives nothing (the script carries on) and never throws', async () => {
      for (const r of [
        () => ({ status: 500, body: { error: { message: 'server broke' } } }),
        () => ({ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{"intent"' } }] } }),
        () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: null } }] } }),
        () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] } }),
        () => ({ throw: new Error('socket hang up') }),
      ]) { reply = r; assert.strictEqual(await Brain.think(dlg(), 'ok'), null); }
    });
    await t('an error never carries the key, even when OpenAI or the network echoes it', async () => {
      reply = () => ({ status: 400, body: { error: { message: `Bad request for key ${KEY} please check` } } });
      try { await O.chatJson({ system: 'S', user: 'U', schema: Brain.SCHEMA }); assert.fail('should have thrown'); } catch (e) { assert.ok(!e.message.includes(KEY), e.message); assert.ok(!e.message.includes('sk-test')); }
      reply = () => ({ throw: new Error(`fetch failed for ${KEY}`) });
      try { await O.chatJson({ system: 'S', user: 'U', schema: Brain.SCHEMA }); assert.fail('should have thrown'); } catch (e) { assert.ok(!e.message.includes(KEY), e.message); }
    });
    await t('a refused key (401) or an empty account rests OpenAI for a while, so calls fall back to what they used before', async () => {
      O.resetCache(); reply = () => ({ status: 401, body: { error: { message: 'Incorrect API key', code: 'invalid_api_key' } } });
      assert.strictEqual(await Brain.think(dlg(), 'ok'), null);
      assert.strictEqual(await O.configured(), false, 'resting after a refused key');
      calls = []; assert.strictEqual(await Brain.think(dlg(), 'ok'), null);
      assert.strictEqual(calls.length, 0, 'a resting OpenAI is not asked again on every answer');
      O.resetCache(); assert.strictEqual(await O.configured(), true, 'saving again ends the rest');
      reply = () => ({ status: 429, body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } });
      await Brain.think(dlg(), 'ok'); assert.strictEqual(await O.configured(), false);
      O.resetCache();
    });
    await t('Test connection explains each outcome in plain words', async () => {
      reply = () => answer({}, {}); reply = () => ({ status: 200, body: { model: 'gpt-4.1-mini', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] } });
      let r = await O.testConnection(); assert.ok(r.ok && /OK in/.test(r.message) && /phone calls now use it/.test(r.message));
      reply = () => ({ status: 401, body: { error: { message: 'bad', code: 'invalid_api_key' } } });
      r = await O.testConnection(); assert.ok(!r.ok && /does not accept this key/.test(r.message)); O.resetCache();
      reply = () => ({ status: 404, body: { error: { message: 'The model does not exist', code: 'model_not_found' } } });
      r = await O.testConnection(); assert.ok(!r.ok && /does not know the model/.test(r.message)); O.resetCache();
      reply = () => ({ status: 429, body: { error: { message: 'quota', code: 'insufficient_quota' } } });
      r = await O.testConnection(); assert.ok(!r.ok && /no credit/.test(r.message)); O.resetCache();
    });
    await t('with the key removed the brain is off again (no Claude set up in the sandbox) and OpenAI is not contacted', async () => {
      await save({ 'OpenAI API key': '-', Model: '' });
      calls = [];
      assert.strictEqual(await O.configured(), false);
      assert.strictEqual(await Brain.think(dlg(), 'ok'), null);
      assert.strictEqual(calls.length, 0);
    });
  } finally {
    global.fetch = realFetch;
    await prisma.integrationEvent.deleteMany({ where: { integrationId: CH } }).catch(() => null);
    await prisma.integration.delete({ where: { id: CH } }).catch(() => null);
    await prisma.$disconnect();
  }
  console.log(`${passed} checks passed${process.exitCode ? ', with failures' : ''}`);
})();
