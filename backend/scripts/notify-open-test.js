#!/usr/bin/env node
// ---------------------------------------------------------------------------
// NOTIFICATIONS THAT KNOW WHERE THEY LEAD - checks of utils/notify.js (the "Open: /path" last line).
// No server and no real database: the database module is replaced by a recorder.   npm run notify-open-test
// ---------------------------------------------------------------------------
/* eslint-disable no-console */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const written = [];
const fakeDb = {
  notification: { create: async ({ data }) => { written.push(data); return { id: `n${written.length}`, ...data }; } },
  user: { findMany: async () => [] },
};
const dbPath = path.resolve(__dirname, '../src/db.js');
const origLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (parent && /utils[\\/]notify\.js$/.test(parent.filename) && request === '../db') return fakeDb;
  return origLoad.call(this, request, parent, ...rest);
};
// eslint-disable-next-line global-require
const { withOpen, pushNotification, notifyUsers } = require('../src/utils/notify');
void dbPath;

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

(async () => {
  console.log('Notifications: where they lead');
  await t('a path becomes the last line "Open: /path"', () => {
    assert.strictEqual(withOpen('Hello', '/a/b?x=1'), 'Hello\nOpen: /a/b?x=1');
    assert.strictEqual(withOpen('Line 1\n  ', '/p'), 'Line 1\nOpen: /p');
  });
  await t('no words: the message is only the Open line', () => {
    assert.strictEqual(withOpen('', '/a'), 'Open: /a');
    assert.strictEqual(withOpen(undefined, '/z'), 'Open: /z');
  });
  await t('no path, or a path that is not one of ours, leaves the message as it was', () => {
    assert.strictEqual(withOpen('Hi', undefined), 'Hi');
    assert.strictEqual(withOpen('Hi', 'http://elsewhere.example'), 'Hi');
    assert.strictEqual(withOpen('Hi', '/has space'), 'Hi');
    assert.strictEqual(withOpen('Hi', '//evil.example'), 'Hi'); // never a link to another site
  });
  await t('pushNotification stores the Open line with the message', async () => {
    written.length = 0;
    await pushNotification({ userId: 'u1', title: 'New application', message: 'Asha -> Nurse', open: '/candidates/c1' });
    assert.deepStrictEqual(written, [{ userId: 'u1', title: 'New application', message: 'Asha -> Nurse\nOpen: /candidates/c1' }]);
  });
  await t('notifyUsers gives every person the same line, skips the actor, and without `open` nothing changes', async () => {
    written.length = 0;
    await notifyUsers(['a', 'b', 'actor'], { title: 'T', message: 'M', exceptUserId: 'actor', open: '/requirements/r1' });
    assert.deepStrictEqual(written.map((w) => [w.userId, w.message]), [['a', 'M\nOpen: /requirements/r1'], ['b', 'M\nOpen: /requirements/r1']]);
    written.length = 0;
    await notifyUsers(['a'], { title: 'T', message: 'M' });
    assert.strictEqual(written[0].message, 'M');
  });
  console.log(`\n${passed} checks passed${process.exitCode ? ' - SOME FAILED' : ''}`);
})();
