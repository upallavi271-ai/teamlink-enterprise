#!/usr/bin/env node
// Pure-logic tests of the WhatsApp chat screen (frontend/src/components/messaging/waChatLogic.js): date separators and bubble grouping, merging polled
// messages and tick changes, ticks, the 24-hour rule helper, unread counts, polling pace, follow-up words.
//   cd backend && node scripts/wa-chat-ui-logic-test.js
/* eslint-disable no-console */
const path = require('path');
const { pathToFileURL } = require('url');
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d).slice(0, 300)}` : ''}`); };
(async () => {
  const H = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'messaging', 'waChatLogic.js')).href);
  // 21 Oct 2026, 10:00 India time = 04:30 UTC
  const NOW = Date.UTC(2026, 9, 21, 4, 30, 0);
  const at = (days, h = 10, m = 0) => NOW + days * 86400000 + (h - 10) * 3600000 + m * 60000;
  const m = (id, a, direction = 'in', extra = {}) => ({ id, at: a, direction, state: direction === 'in' ? 'received' : 'sent', text: id, ...extra });

  // ---- date separators
  check('L1 dayKey is the INDIA date (late evening UTC is already tomorrow in India)', H.dayKey(Date.UTC(2026, 9, 20, 20, 0, 0)) === '2026-10-21' && H.dayKey(Date.UTC(2026, 9, 20, 18, 0, 0)) === '2026-10-20');
  check('L2 labels: Today, Yesterday, a date this year, a date with the year for an older year', H.dayLabel(at(0), NOW) === 'Today' && H.dayLabel(at(-1), NOW) === 'Yesterday' && /^15 Oct$/.test(H.dayLabel(at(-6), NOW)) && /2025/.test(H.dayLabel(Date.UTC(2025, 11, 30, 5), NOW)), [H.dayLabel(at(-6), NOW), H.dayLabel(Date.UTC(2025, 11, 30, 5), NOW)]);
  const g = H.groupByDay([m('c', at(0, 10, 1), 'out'), m('a', at(-2, 9), 'in'), m('b', at(-2, 9, 1), 'in'), m('d', at(0, 10, 30), 'in')], NOW);
  check('L3 messages are sorted, with a separator line before each new day', g.map((x) => (x.kind === 'day' ? `#${x.label}` : x.m.id)).join(',') === `#${H.dayLabel(at(-2, 9), NOW)},a,b,#Today,c,d`, g.map((x) => (x.kind === 'day' ? `#${x.label}` : x.m.id)));
  check('L4 same side within 2 minutes is "tight"; another side, or a new day, is not', g.find((x) => x.m && x.m.id === 'b').tight === true && g.find((x) => x.m && x.m.id === 'a').tight === false && g.find((x) => x.m && x.m.id === 'c').tight === false && g.find((x) => x.m && x.m.id === 'd').tight === false);
  check('L4b empty / missing lists give no lines', H.groupByDay([], NOW).length === 0 && H.groupByDay(null, NOW).length === 0);
  check('L4c the same time stamp keeps a stable order (by id)', H.groupByDay([m('z', at(0)), m('y', at(0))], NOW).filter((x) => x.kind === 'msg').map((x) => x.m.id).join('') === 'yz');
  check('L5 the time of a message looks like "10:05 am"; the list time is the clock today, "Yesterday", then a date', /^10:00 am$/.test(H.timeLabel(at(0))) && /^4:30 pm$/.test(H.timeLabel(at(0, 16, 30))) && H.listTime(at(0, 9), NOW) === '9:00 am' && H.listTime(at(-1), NOW) === 'Yesterday' && H.listTime(at(-3), NOW) === '18 Oct', [H.timeLabel(at(0)), H.timeLabel(at(0, 16, 30)), H.listTime(at(-3), NOW)]);

  // ---- merge polled messages and ticks
  const cur = [m('1', at(0, 9), 'out', { state: 'sent' }), m('2', at(0, 9, 5), 'in')];
  const merged = H.mergeMessages(cur, [m('2', at(0, 9, 5), 'in'), m('3', at(0, 9, 6), 'in')], []);
  check('L6 a message that arrives twice (overlapping polls) is listed once; a new one is added in order', merged.length === 3 && merged.map((x) => x.id).join('') === '123', merged.map((x) => x.id));
  const ticked = H.mergeMessages(merged, [], [{ id: '1', state: 'delivered', stateWord: 'Delivered' }]);
  check('L7 a tick that moved forward is applied (sent -> delivered)', ticked.find((x) => x.id === '1').state === 'delivered');
  const back = H.mergeMessages(ticked, [], [{ id: '1', state: 'sent' }]);
  check('L7b a tick never goes back (delivered stays delivered)', back.find((x) => x.id === '1').state === 'delivered');
  const failed = H.mergeMessages(ticked, [], [{ id: '1', state: 'failed', failure: 'This number is not on WhatsApp.' }]);
  check('L7c "failed" always shows, with the plain reason', failed.find((x) => x.id === '1').state === 'failed' && /not on WhatsApp/.test(failed.find((x) => x.id === '1').failure));
  check('L7d an update for a message we do not have, or for an incoming one, changes nothing', H.mergeMessages(merged, [], [{ id: 'nope', state: 'read' }, { id: '2', state: 'read' }]).find((x) => x.id === '2').state === 'received');
  check('L8 ticks: clock / one grey / two grey / two blue / red mark', H.tickOf('queued').word === 'Waiting to send' && H.tickOf('sent').glyph === '✓' && H.tickOf('delivered').glyph === '✓✓' && H.tickOf('delivered').tone === 'grey' && H.tickOf('read').tone === 'blue' && H.tickOf('failed').tone === 'red' && H.tickOf('received').glyph === '');

  // ---- the 24-hour rule
  const open = H.windowInfo({ open: true, until: NOW + 5 * 3600000 + 20 * 60000, lastInboundAt: NOW - 1000 }, NOW);
  check('L9 inside the window: open, "5 h 20 min left to write freely"', open.open && /5 h 20 min left/.test(open.short) && open.banner === '', open);
  const closed = H.windowInfo({ open: false, until: NOW - 3600000, lastInboundAt: NOW - 25 * 3600000 }, NOW);
  check('L9b more than 24 hours: closed, the plain banner', !closed.open && closed.banner === 'More than 24 hours since they wrote: you can send only an approved template.', closed);
  check('L9c the server says open but the time has passed (a tab left open): closed', !H.windowInfo({ open: true, until: NOW - 1 }, NOW).open);
  check('L9d never wrote: closed with its own words', /not written/i.test(H.windowInfo({ open: false, until: null, lastInboundAt: null }, NOW).banner));
  check('L9e under an hour is said in minutes', /^45 min left/.test(H.windowInfo({ open: true, until: NOW + 45 * 60000 }, NOW).short));
  const chat = (x) => ({ canSend: true, blocked: null, blockedCode: null, window: { open: true, until: NOW + HOURS(3) }, ...x });
  function HOURS(n) { return n * 3600000; }
  check('L10 composer: free text inside the window', H.composerMode(chat({}), NOW).mode === 'text');
  check('L10b composer: template only outside the window (with the banner)', H.composerMode(chat({ window: { open: false, lastInboundAt: NOW - 30 * 3600000 } }), NOW).mode === 'template' && /More than 24 hours/.test(H.composerMode(chat({ window: { open: false, lastInboundAt: NOW - 30 * 3600000 } }), NOW).reason));
  check('L10c composer: blocked (STOP, no number, not connected) says why and beats the window', H.composerMode(chat({ canSend: false, blockedCode: 'OPTED_OUT', blocked: 'They replied STOP on WhatsApp, so nothing more can be sent to them there.', window: { open: false } }), NOW).mode === 'blocked');
  check('L10d composer: loading before the chat is here', H.composerMode(null, NOW).mode === 'loading');

  // ---- unread
  const rows = [{ key: 'a', unread: 2 }, { key: 'b', unread: 0 }, { key: 'c', unread: 1 }];
  check('L11 unread summary counts chats and messages', JSON.stringify(H.unreadSummary(rows)) === JSON.stringify({ chats: 2, messages: 3 }));
  check('L11b reading a chat clears only that row', H.markRowRead(rows, 'a').find((r) => r.key === 'a').unread === 0 && H.markRowRead(rows, 'a').find((r) => r.key === 'c').unread === 1);
  check('L11c a chat is marked read only while the screen is looked at', H.shouldMarkRead({ visible: true, unread: 2, newIncoming: false }) && H.shouldMarkRead({ visible: true, unread: 0, newIncoming: true }) && !H.shouldMarkRead({ visible: false, unread: 2, newIncoming: true }) && !H.shouldMarkRead({ visible: true, unread: 0, newIncoming: false }));

  // ---- polling pace
  check('L12 polling: base time when all is well, doubled per failure, at most 8x, never above the cap', H.pollDelay(10000, 0) === 10000 && H.pollDelay(10000, 1) === 20000 && H.pollDelay(10000, 3) === 80000 && H.pollDelay(10000, 9) === 80000 && H.pollDelay(60000, 3) === 240000);

  // ---- follow-up words
  check('L13 follow-up words: Today / Tomorrow / a date / Late', H.followUpWhen('2026-10-21', '16:30', NOW) === 'Today 16:30' && H.followUpWhen('2026-10-22', '10:00', NOW) === 'Tomorrow 10:00' && H.followUpWhen('2026-10-25', null, NOW) === '25 Oct' && H.followUpWhen('2026-10-19', null, NOW) === 'Late: 2 days' && H.followUpWhen('2026-10-20', '09:00', NOW) === 'Late: 1 day 09:00' && H.followUpWhen(null, null, NOW) === 'No date yet', [H.followUpWhen('2026-10-25', null, NOW), H.followUpWhen('2026-10-20', '09:00', NOW)]);
  check('L14 file size words and the "Sending from" line', H.sizeLabel(900) === '900 B' && H.sizeLabel(20480) === '20 KB' && H.sizeLabel(3 * 1024 * 1024) === '3.0 MB' && H.sizeLabel(0) === '' && H.sendingFromWords({ sendingFrom: 'Education desk' }) === 'Sending from Education desk' && H.sendingFromWords({ sendingFrom: null }) === '');
  const k1 = H.newSendKey(); const k2 = H.newSendKey();
  check('L15 each send gets a key of safe letters (8-80), and two keys differ', /^[A-Za-z0-9_-]{8,80}$/.test(k1) && k1 !== k2, [k1, k2]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(1); });
