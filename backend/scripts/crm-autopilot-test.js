#!/usr/bin/env node
/**
 * The CRM running by itself (crm/autopilot.js). SANDBOX ONLY: a COPY of the sandbox database, in this process. Every send goes to a stand-in: nothing real is mailed, texted or called.
 *   node scripts/crm-autopilot-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-auto-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', TEST_MODE: '1', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` });
const prisma = require('../src/db');
const DB = require('../src/crm/schema');
const S = require('../src/crm/service');
const AP = require('../src/crm/autopilot');
const CMP = require('../src/crm/campaigns');
const SALES = require('../src/crm/sales');
const { resolveIdentity } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 320)}` : ''}`); } };
const HOUR = 3600000;
const sent = [];
let callEnd = {};
const deps = {
  sendMail: async (m) => { sent.push({ ch: 'mail', ...m }); return { ok: true }; },
  sendSms: async (to, text) => { sent.push({ ch: 'sms', to, text }); return { ok: true }; },
  sendWa: async (to, text) => { sent.push({ ch: 'wa', to, text }); return { ok: true }; },
  call: async (a) => { sent.push({ ch: 'call', ...a }); return { ok: true, id: `call-${a.externalId}` }; },
  callStatus: async (id) => callEnd[id] || { ended: false },
};
// noon in India, a working day: outside quiet hours
const NOON = Date.parse('2026-11-10T06:30:00Z');
const NIGHT = Date.parse('2026-11-10T18:00:00Z'); // 11:30 pm in India

(async () => {
  await DB.ensure();
  const row = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  const admin = await resolveIdentity(row.id);
  const lead = async (company, over = {}) => (await S.create(admin, 'lead', { company, contactName: 'Ravi', phone: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, email: `${company.toLowerCase().replace(/\W/g, '')}@example.test`, force: true, ...over })).body.lead;
  const backdate = (id, t) => DB.run('UPDATE "CrmLead" SET "createdAt" = ? WHERE "id" = ?', new Date(t).toISOString(), id);
  const acts = async (id) => (await DB.all('SELECT * FROM "CrmActivity" WHERE "leadId" = ?', id)).map((a) => a.subject);
  const tick = (now, d = deps) => AP.tick({ now, deps: d });
  const steps = async (id) => DB.all('SELECT * FROM "CrmAutoStep" WHERE "recordId" = ? ORDER BY "dueAt"', id);

  console.log('The switch');
  const before = await lead('Old Lead Ltd');
  await backdate(before.id, NOON - 5 * HOUR);
  check('off by default: nothing happens', (await tick(NOON)).off === true && sent.length === 0);
  const on = await AP.save(admin, { on: true });
  check('turning it on notes the moment', on.status === 200 && !!on.body.settings.armedAt, on.body);
  await prisma.$executeRawUnsafe('UPDATE "AppSetting" SET "value" = json_set("value", \'$.armedAt\', ?) WHERE "key" = ?', new Date(NOON - HOUR).toISOString(), 'crm.autopilot');
  await tick(NOON);
  check('a lead from before it was turned on is never contacted', sent.length === 0 && (await steps(before.id)).length === 0, sent);

  console.log('A new lead');
  const a = await lead('Fresh Co');
  await backdate(a.id, NOON - 60000);
  const t1 = await tick(NOON);
  check('it gets its six steps', (await steps(a.id)).length === 6, await steps(a.id));
  check('a mail and an SMS go at once', t1.sent === 2 && sent.some((x) => x.ch === 'mail') && sent.some((x) => x.ch === 'sms'), t1);
  check('the words are filled in, with an unsubscribe line', /Hello Ravi/.test(sent.find((x) => x.ch === 'mail').text) && /unsubscribe/i.test(sent.find((x) => x.ch === 'mail').text), sent[0]);
  check('nothing is logged by hand: both are on the timeline', (await acts(a.id)).includes('SMS sent') && (await acts(a.id)).some((s) => /Thank you/.test(s)), await acts(a.id));
  check('the lead moved to Contacted by itself', (await S.getRow('lead', a.id)).stage === 'Contacted');
  const again = sent.length;
  await tick(NOON + 60000);
  check('the next pass sends nothing twice', sent.length === again);
  await tick(NOON + 2 * HOUR);
  check('the AI call goes after 2 hours, with the phone number', sent.some((x) => x.ch === 'call' && x.toNumber));

  console.log('What the AI call hears');
  const callId = (await steps(a.id)).find((s) => s.status === 'calling').callId;
  callEnd = { [callId]: { ended: true, status: 'completed', outcome: 'Interested', interest: 'yes', summary: 'Wants to talk' } };
  await tick(NOON + 3 * HOUR);
  const a2 = await S.getRow('lead', a.id);
  check('interested: Qualified by itself', a2.stage === 'Qualified', a2);
  const meet = await DB.one('SELECT * FROM "CrmTask" WHERE "leadId" = ? AND "type" = \'Meeting\'', a.id);
  check('a meeting is booked for the owner, with a reminder', meet && meet.dueTime === '11:00' && meet.notifyApp === 1 && meet.remindBefore === 60, meet);
  const inv = sent.find((x) => x.ch === 'mail' && /Meeting with/.test(x.subject));
  check('the invite goes with a calendar file', inv && inv.attachments[0].content.includes('BEGIN:VEVENT') && inv.attachments[0].content.includes('DTSTART') && inv.to.includes('freshco@example.test'), inv && inv.to);
  const left = sent.length;
  await tick(NOON + 30 * HOUR);
  check('qualified: the rest of the sequence stops', sent.length === left && (await steps(a.id)).filter((s) => s.status === 'stopped').length >= 1, await steps(a.id));

  const b = await lead('Nope Ltd');
  await backdate(b.id, NOON - 50 * 60000);
  await tick(NOON + 2 * HOUR);
  const cb = (await steps(b.id)).find((s) => s.status === 'calling');
  callEnd[cb.callId] = { ended: true, status: 'completed', outcome: 'Not Interested', interest: 'no', optOut: false };
  await tick(NOON + 2 * HOUR + 60000);
  check('not interested: Lost by itself, with the reason', (await S.getRow('lead', b.id)).stage === 'Lost' && (await S.getRow('lead', b.id)).lostReason === 'Not interested on the AI call', await S.getRow('lead', b.id));

  const c = await lead('Stop Calling Ltd');
  await backdate(c.id, NOON - 50 * 60000);
  await tick(NOON + 2 * HOUR + 120000);
  const cc = (await steps(c.id)).find((s) => s.status === 'calling');
  callEnd[cc.callId] = { ended: true, status: 'completed', outcome: 'Not Interested', optOut: true };
  await tick(NOON + 2 * HOUR + 180000);
  const row3 = await S.getRow('lead', c.id);
  check('"do not call": opted out on mail and phone', (await CMP.optedOut('email', row3.email)) && (await CMP.optedOut('whatsapp', row3.phone)));

  console.log('The limits');
  const n0 = sent.length;
  const d = await lead('Night Owl Ltd');
  await backdate(d.id, NIGHT - 60000);
  const q = await tick(NIGHT);
  check('nothing goes at night', q.quiet === true && sent.length === n0, q);
  await tick(NIGHT + 11 * HOUR);
  check('it goes in the morning', sent.length > n0);
  const e = await lead('Opted Out Ltd');
  await CMP.optOut('email', e.email, {}); await CMP.optOut('whatsapp', e.phone, {});
  await backdate(e.id, NOON + 86400000 - 60000);
  const n1 = sent.filter((x) => x.to === e.email || x.to === e.phone).length;
  await tick(NOON + 86400000);
  check('an opted-out person gets nothing', n1 === 0 && sent.filter((x) => x.to === e.email || x.to === e.phone).length === 0 && (await steps(e.id)).every((s) => ['skipped', 'waiting'].includes(s.status)), await steps(e.id));
  const f = await lead('Paused Ltd');
  await backdate(f.id, NOON + 86400000 + HOUR);
  await AP.pauseLead(admin, f.id, true);
  const n2 = sent.length;
  await tick(NOON + 86400000 + 2 * HOUR);
  check('Stop on a lead: nothing goes', sent.length === n2 && (await steps(f.id)).length === 0);
  const g = await lead('Moved Ltd');
  await backdate(g.id, NOON + 86400000 + 2 * HOUR);
  await tick(NOON + 86400000 + 2 * HOUR + 60000); // queued; both first steps sent
  await require('../src/crm/service').addActivity(admin, { kind: 'call', leadId: g.id, subject: 'Spoke to them' }); // a person moves a lead on only after working it (Phase 1 rule)
  await SALES.moveLead(admin, g.id, { stage: 'Proposal' });
  const n3 = sent.length;
  await tick(NOON + 86400000 + 7 * HOUR);
  check('a lead a person moved on is left to them', sent.length === n3, sent.slice(n3));
  const h = await lead('Sample · Demo Co');
  await backdate(h.id, NOON + 86400000 + 8 * HOUR);
  await tick(NOON + 86400000 + 8 * HOUR + 60000);
  check('sample records are never contacted', (await steps(h.id)).length === 0);
  const mail = await lead('No Phone Ltd', { phone: '' });
  await backdate(mail.id, NOON + 86400000 + 3 * HOUR);
  await tick(NOON + 86400000 + 3 * HOUR + 60000);
  check('no phone: the SMS step is skipped with the reason, the mail still goes', (await steps(mail.id)).some((s) => s.status === 'skipped' && s.result === 'no phone') && (await steps(mail.id)).some((s) => s.status === 'sent'), await steps(mail.id));
  const broke = await lead('Failing Ltd');
  await backdate(broke.id, NOON + 86400000 + 3 * HOUR);
  await tick(NOON + 86400000 + 3 * HOUR + 60000, { ...deps, sendMail: async () => ({ ok: false, error: 'mail is down' }) });
  check('a failed send is recorded on the lead, and the call does not crash', (await steps(broke.id)).some((s) => s.status === 'failed' && s.result === 'mail is down') && (await acts(broke.id)).includes('email did not go'), await acts(broke.id));
  const off = await AP.save(admin, { on: false });
  const n4 = sent.length;
  check('turning it off stops everything', off.status === 200 && (await tick(NOON + 200 * HOUR)).off === true && sent.length === n4);

  console.log('Customers');
  await AP.save(admin, { on: true });
  await prisma.$executeRawUnsafe('UPDATE "AppSetting" SET "value" = json_set("value", \'$.armedAt\', ?) WHERE "key" = ?', new Date(NOON - 40 * 24 * HOUR).toISOString(), 'crm.autopilot');
  await prisma.$executeRawUnsafe('UPDATE "CrmAutoStep" SET "status" = \'stopped\' WHERE "status" = \'waiting\'');
  await DB.run('UPDATE "CrmAccount" SET "kind" = \'Prospect\'');
  const stamp = DB.nowIso();
  const acc = await S.insert('CrmAccount', { id: S.newId('account'), name: 'Loyal Customer Ltd', email: 'hello@loyal.example.test', kind: 'Client', ownerId: row.id, ownerName: row.name, createdAt: stamp, updatedAt: stamp });
  const cu = await tick(NOON + HOUR);
  const m1 = await DB.one('SELECT * FROM "CrmTask" WHERE "accountId" = ? AND "type" = \'Meeting\'', acc.id);
  check('a customer gets a check-in meeting and an invite', cu.customers === 1 && !!m1 && sent.some((x) => /Check-in with Loyal/.test(x.subject || '')), cu);
  check('and not again until the next round', (await tick(NOON + 2 * HOUR)).customers === 0);
  const slot = await AP.nextSlot(row.id, await AP.load(), Date.parse('2026-11-14T06:30:00Z')); // a Saturday in India
  check('a meeting is never put on a Sunday', slot.day === '2026-11-16', slot);

  console.log('They wrote back');
  await AP.save(admin, { on: false }); await AP.save(admin, { on: true });
  await prisma.$executeRawUnsafe('UPDATE "AppSetting" SET "value" = json_set("value", \'$.armedAt\', ?) WHERE "key" = ?', new Date(NOON - HOUR).toISOString(), 'crm.autopilot');
  await prisma.$executeRawUnsafe('UPDATE "CrmAutoStep" SET "status" = \'stopped\' WHERE "status" IN (\'waiting\', \'calling\')');
  const DLV = require('../src/utils/messageDelivery');
  const IMAP = require('../src/utils/imapInbox');
  const waiting = async (id) => (await steps(id)).filter((s) => s.status === 'waiting').length;
  const started = async (name, over) => { const l = await lead(name, over); await backdate(l.id, NOON - 60000); await tick(NOON); return l; };
  const taskOf = (id) => DB.one('SELECT * FROM "CrmTask" WHERE "leadId" = ? AND "title" LIKE \'Answer %\'', id);
  const bell = (id) => prisma.notification.findFirst({ where: { recipient: { startsWith: `crm-reply|${id}|` } } });

  const r1 = await started('Sms Reply Ltd');
  check('(the sequence is waiting)', (await waiting(r1.id)) > 0, await steps(r1.id));
  const out1 = await DLV.applyInbound({ channel: 'SMS', from: `+91${r1.phone}`, text: 'Yes please call me', id: 'zz-sms-1', provider: 'sms.test' });
  check('an SMS reply through the real inbound path: every waiting step stops', (await waiting(r1.id)) === 0 && (await steps(r1.id)).some((s) => s.result === 'they replied on SMS'), { out1, steps: await steps(r1.id) });
  check('it is on the timeline with their words', (await acts(r1.id)).includes('Replied on SMS') && !!(await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "note" = ?', r1.id, 'Yes please call me')));
  check('the owner is told, and gets a follow-up to answer it', !!(await bell(r1.id)) && !!(await taskOf(r1.id)), await taskOf(r1.id));
  const k1 = sent.length;
  await tick(NOON + 200 * HOUR);
  check('nothing more goes to them after a week', sent.filter((x, i) => i >= k1 && (x.to === r1.email || x.to === r1.phone || x.toNumber === r1.phone)).length === 0);
  await DLV.applyInbound({ channel: 'SMS', from: `+91${r1.phone}`, text: 'Yes please call me', id: 'zz-sms-1', provider: 'sms.test' });
  check('the provider sending the same reply twice counts once', (await acts(r1.id)).filter((s) => s === 'Replied on SMS').length === 1, await acts(r1.id));

  const r2 = await started('Wa Reply Ltd');
  await DLV.applyInbound({ channel: 'WhatsApp', from: `91${r2.phone}`, text: 'Send details', id: 'zz-wa-1' });
  check('a WhatsApp reply stops it too', (await waiting(r2.id)) === 0 && (await acts(r2.id)).includes('Replied on WhatsApp'), await acts(r2.id));

  const rawMail = (from, subject, extra = '') => `From: Ravi <${from}>\r\nSubject: ${subject}\r\nMessage-ID: <zz-${Math.random()}@example.test>\r\nDate: Tue, 10 Nov 2026 10:00:00 +0530\r\n${extra}Content-Type: text/plain\r\n\r\nYes, let us talk on Monday.\r\n`;
  const r3 = await started('Mail Reply Ltd');
  await IMAP.pollOnce({ messages: [rawMail(r3.email, 'Re: Thank you')] });
  check('a mail reply through the real mailbox reader stops it too', (await waiting(r3.id)) === 0 && (await acts(r3.id)).includes('Replied on mail'), await acts(r3.id));

  const r4 = await started('Out Of Office Ltd');
  const w4 = await waiting(r4.id);
  await IMAP.pollOnce({ messages: [rawMail(r4.email, 'Automatic reply: Thank you'), rawMail(r4.email, 'Out of office'), rawMail(r4.email, 'Re: hello', 'Auto-Submitted: auto-replied\r\n')] });
  check('an out-of-office is not a reply: the sequence goes on', w4 > 0 && (await waiting(r4.id)) === w4 && !(await acts(r4.id)).includes('Replied on mail'), await acts(r4.id));

  const r5 = await started('Stop Word Ltd');
  await DLV.applyInbound({ channel: 'SMS', from: `+91${r5.phone}`, text: 'STOP', id: 'zz-sms-5', provider: 'sms.test' });
  const l5 = await S.getRow('lead', r5.id);
  check('"STOP": out of every channel, Lost, and no follow-up to chase them', (await CMP.optedOut('email', r5.email)) && (await CMP.optedOut('whatsapp', r5.phone)) && l5.stage === 'Lost' && !(await taskOf(r5.id)) && (await waiting(r5.id)) === 0, l5);

  const r6 = await lead('New Stage Ltd');
  await DLV.applyInbound({ channel: 'SMS', from: `+91${r6.phone}`, text: 'hello', id: 'zz-sms-6', provider: 'sms.test' });
  check('a reply moves a New lead to Contacted', (await S.getRow('lead', r6.id)).stage === 'Contacted');
  const orphan = await lead('No Owner Ltd');
  await DB.run('UPDATE "CrmLead" SET "ownerId" = NULL, "ownerName" = NULL WHERE "id" = ?', orphan.id);
  await DLV.applyInbound({ channel: 'SMS', from: `+91${orphan.phone}`, text: 'hello', id: 'zz-sms-7', provider: 'sms.test' });
  check('no owner: it still lands on the timeline, nothing breaks', (await acts(orphan.id)).includes('Replied on SMS'));
  const stranger = await DLV.applyInbound({ channel: 'SMS', from: '+919999900000', text: 'who is this', id: 'zz-sms-8', provider: 'sms.test' }).catch((e) => ({ threw: e.message }));
  check('a number no lead has: the normal path is untouched', !stranger.threw, stranger);
  const r7 = await lead('Early Reply Ltd');
  await backdate(r7.id, NOON - 60000);
  await DLV.applyInbound({ channel: 'SMS', from: `+91${r7.phone}`, text: 'hi', id: 'zz-sms-10', provider: 'sms.test' });
  await tick(NOON);
  check('a lead who writes before the first step is queued is never started', (await steps(r7.id)).length === 0, await steps(r7.id));
  await DLV.applyInbound({ channel: 'WhatsApp', from: `91${r1.phone}`, text: 'one more thing', id: 'zz-wa-2' });
  await DLV.applyInbound({ channel: 'WhatsApp', from: `91${r1.phone}`, text: 'and another', id: 'zz-wa-3' });
  check('three messages, one follow-up', (await DB.all('SELECT "id" FROM "CrmTask" WHERE "leadId" = ? AND "title" LIKE \'Answer %\'', r1.id)).length === 1);
  const owner = await resolveIdentity(r1.ownerId);
  check('the on-screen note carries the reply', (await SALES.liveReminders(owner)).body.reminders.some((n) => JSON.stringify(n).includes('Sms Reply Ltd replied on')), await SALES.liveReminders(owner));
  const r8 = await started('Real Reply Ltd');
  await IMAP.pollOnce({ messages: [rawMail(r8.email, 'Re: Delivery status of our order')] });
  check('a person writing about "delivery status" is still a reply', (await acts(r8.id)).includes('Replied on mail'), await acts(r8.id));
  const ahead = (await steps(r8.id)).filter((s) => s.status === 'stopped' && Date.parse(s.dueAt) > Date.now()).length;
  await AP.pauseLead(admin, r8.id, false);
  check('"Start again" after a reply wakes only the steps still ahead', (await waiting(r8.id)) === ahead, { ahead, steps: await steps(r8.id) });
  const won = await lead('Won Client Ltd');
  await DB.run('UPDATE "CrmLead" SET "stage" = \'Won\' WHERE "id" = ?', won.id);
  await DLV.applyInbound({ channel: 'SMS', from: `+91${won.phone}`, text: 'STOP', id: 'zz-sms-11', provider: 'sms.test' });
  check('"STOP" from a won client opts them out but never turns the win into Lost', (await S.getRow('lead', won.id)).stage === 'Won' && (await CMP.optedOut('whatsapp', won.phone)));
  let polled = 0;
  await AP.checkMailbox({ pollOnce: async () => { polled += 1; return {}; } });
  await AP.save(admin, { on: false });
  const offCheck = await AP.checkMailbox({ pollOnce: async () => { polled += 1; return {}; } });
  check('the mailbox is read on a timer while it is on, not while it is off', polled === 1 && offCheck.off === true, { polled, offCheck });
  const r9 = await lead('Off Reply Ltd');
  await DLV.applyInbound({ channel: 'SMS', from: `+91${r9.phone}`, text: 'hi', id: 'zz-sms-9', provider: 'sms.test' });
  check('with the switch off a reply is still seen by the owner', (await acts(r9.id)).includes('Replied on SMS') && !!(await bell(r9.id)));

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await prisma.$disconnect().catch(() => {});
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
