#!/usr/bin/env node
// Pure-logic tests of the WhatsApp sender helper used by every window that sends WhatsApp (frontend/src/components/messaging/waSender.js):
// which line is shown, whether Send is switched off, what goes to the server, and how a connection status is worded and coloured.
//   cd backend && node scripts/wa-multi-number-ui-logic-test.js
/* eslint-disable no-console */
const path = require('path');
const { pathToFileURL } = require('url');
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d).slice(0, 300)}` : ''}`); };
(async () => {
  const H = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'messaging', 'waSender.js')).href);
  const n = (id, label, usable = true, extra = {}) => ({ id, label, displayNumber: '+91900001000' + id.length, usable, ...extra });
  // modes
  check('U1 nothing loaded yet: show nothing, do not block', JSON.stringify(H.senderState(null)) === JSON.stringify({ mode: 'loading', show: false, canSend: true, message: '', selected: null, usable: [] }));
  check('U2 only the old single number exists (legacy): show nothing, send allowed', (() => { const s = H.senderState({ legacy: true, numbers: [] }); return s.mode === 'legacy' && !s.show && s.canSend; })());
  const none = H.senderState({ legacy: false, numbers: [], message: '' });
  check('U3 no number assigned: clear message, Send switched off', none.mode === 'none' && none.show && !none.canSend && /No WhatsApp number is assigned to you yet\. Ask the Admin/.test(none.message), none);
  const down = H.senderState({ legacy: false, numbers: [n('a', 'Education', false)] });
  check('U4 every assigned number is off / not connected: message, Send switched off', down.mode === 'down' && !down.canSend && /switched off or not connected/.test(down.message), down);
  const one = H.senderState({ legacy: false, numbers: [n('a', 'Education'), n('b', 'Old', false)] });
  check('U5 one usable number: it is selected, no list, Send allowed', one.mode === 'one' && one.selected === 'a' && one.canSend && one.usable.length === 1, one);
  const info = { legacy: false, defaultId: 'b', numbers: [n('a', 'Education'), n('b', 'Medical'), n('c', 'BDE')] };
  const many = H.senderState(info, '');
  check('U6 several numbers: a list; the default is preselected', many.mode === 'many' && many.selected === 'b' && many.usable.length === 3, many);
  check('U6b a chosen number is kept', H.senderState(info, 'c').selected === 'c');
  check('U6c a chosen number that is NOT in the person\'s list is ignored (only authorised numbers can be picked)', H.senderState(info, 'zzz').selected === 'b');
  check('U6d switched-off numbers are not offered in the list', H.senderState({ ...info, numbers: [...info.numbers, n('d', 'Off', false)] }, 'd').usable.every((x) => x.id !== 'd'));
  // what goes to the server
  check('U7 nothing is sent as waNumberId unless the person chose from several (the server then keeps an existing chat on its number)', H.numberToSend(many, '') === undefined && H.numberToSend(one, 'a') === undefined && H.numberToSend(none, 'a') === undefined);
  check('U7b a chosen number goes to the server', H.numberToSend(many, 'c') === 'c');
  check('U7c a chosen number that is not usable never goes to the server', H.numberToSend(many, 'zzz') === undefined);
  // words
  check('U8 the line above Send', H.senderLine(one) === 'Sending from: Education (+91 90000 10001)' || /^Sending from: Education \(\+91 /.test(H.senderLine(one)), H.senderLine(one));
  check('U8b the line uses the number the server picked when it says so', /^Sending from: Medical desk \(\+91 90000 10002\)$/.test(H.senderLine(many, { label: 'Medical desk', displayNumber: '+919000010002' })), H.senderLine(many, { label: 'Medical desk', displayNumber: '+919000010002' }));
  check('U8c no number: the line is the clear message', H.senderLine(none) === none.message);
  check('U9 number format: +91 90000 10001', H.fmtNumber('+919000010001') === '+91 90000 10001' && H.fmtNumber('+14155550123') === '+14155550123');
  // chips
  const codes = ['connected', 'verification_required', 'disconnected', 'switched_off', 'test_mode', 'unchecked'];
  check('U10 status words: Connected / Verification Required / Disconnected / Switched off / Test mode', H.chipWords('connected') === 'Connected' && H.chipWords('verification_required') === 'Verification Required' && H.chipWords('disconnected') === 'Disconnected' && H.chipWords('switched_off') === 'Switched off' && H.chipWords('test_mode') === 'Test mode', codes.map(H.chipWords));
  check('U10b status colours: green / yellow / red / grey / blue', H.chipTone('connected') === 'green' && H.chipTone('verification_required') === 'yellow' && H.chipTone('disconnected') === 'red' && H.chipTone('switched_off') === 'grey' && H.chipTone('test_mode') === 'blue', codes.map(H.chipTone));
  check('U10c an unknown code is grey with the "not checked yet" words (never a made-up green)', H.chipTone('whatever') === 'grey' && H.chipWords('whatever') === 'Not checked yet');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
