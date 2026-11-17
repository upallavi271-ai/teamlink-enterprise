#!/usr/bin/env node
/**
 * THE WHATSAPP AI SALES ASSISTANT: ONE BOOKING, THE RIGHT PITCH, A KNOWN DELIVERY (founder 2026-11-17, lead L-0013): "ok" booked a second meeting
 * on top of the call already booked, "ok, i will..." and "10:00am" booked a third and a fourth; a product-demo lead got the recruitment pitch;
 * one message both asked "shall we book?" and said "I have booked"; the AI answer had no WhatsApp reference.
 * SANDBOX ONLY: a COPY of the sandbox database, in this process; the model and every send are stand-ins.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-sales-agent-booking-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SOURCE = process.env.TEST_SOURCE_DB || path.resolve(__dirname, '..', 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-sab-${process.pid}.db`).split(path.sep).join('/');
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY}'`);
src.close();
Object.assign(process.env, { TEAMLINK_SANDBOX: '1', TEST_MODE: '1', DATABASE_URL: `file:${COPY}` });
const prisma = require('../src/db');
const DB = require('../src/crm/schema');
const S = require('../src/crm/service');
const AP = require('../src/crm/autopilot');
const SA = require('../src/crm/salesAgent');
const PS = require('../src/crm/productSales');
const CT = require('../src/crm/contact');
const { resolveIdentity } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const sent = [];
let prompts = [];
let answer = { reply: 'Thanks for reaching out. Would you like to schedule a call to discuss further? I have booked a call for you.', action: 'meeting' };
let waFails = null;
let ref = 0;
const deps = {
  chat: async (sys) => { prompts.push(sys); return answer; },
  sendMail: async (m) => { sent.push({ ch: 'mail', ...m }); return { ok: true }; },
  sendWa: async (to, text) => { if (waFails) return { ok: false, error: waFails }; ref += 1; sent.push({ ch: 'wa', to, text }); return { ok: true, providerRef: `wamid.TEST${process.pid}${ref}` }; },
};

(async () => {
  await DB.ensure();
  await PS.ensure();
  const row = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  const admin = await resolveIdentity(row.id);
  await SA.save(admin, { on: true, maxPerDay: 20 });
  const R = String(Date.now()).slice(-5);
  let n = 0;
  const mk = async (company, extra = {}) => { n += 1; const l = (await S.create(admin, 'lead', { company: `${company} ${R}`, contactName: 'Pallavi', phone: `96${R}${String(n).padStart(3, '0')}`, email: `zz-sab-${R}-${n}@example.test`, ownerId: row.id, source: 'Website', ...extra })).body.lead; if (extra.products) await DB.run('UPDATE "CrmLead" SET "products" = ? WHERE "id" = ?', extra.products, l.id); return DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', l.id); };
  const say = (l, text) => AP.onReply({ channel: 'WhatsApp', phone: `+91${l.phone}`, text }, { wait: true, deps });
  const meetings = async (id) => DB.all('SELECT "title", "dueDate", "dueTime" FROM "CrmTask" WHERE "leadId" = ? AND "status" = \'Open\' AND ("type" = \'Meeting\' OR "title" LIKE \'%booked by the lead%\') ORDER BY "dueDate", "dueTime"', id);
  const lastAi = async (id) => DB.one('SELECT "subject", "note", "providerRef", "deliveryStatus", "deliveryDetail" FROM "CrmActivity" WHERE "leadId" = ? AND "byName" = ? ORDER BY "at" DESC LIMIT 1', id, SA.AI_NAME);
  const unpause = (l) => DB.run('UPDATE "CrmLead" SET "autoPaused" = 0 WHERE "id" = ?', l.id);

  // ---- 1. a product lead with a call already booked from the AI meeting ("Talk to a person" at 10:00 tomorrow)
  const L = await mk('ZZTEST SAB Teamlink', { products: 'ATS' });
  const tomorrow = new Date(Date.now() + 5.5 * 3600000 + 86400000).toISOString().slice(0, 10);
  const stamp = new Date().toISOString();
  await S.insert('CrmTask', { id: S.newId('task'), title: 'Call Pallavi at 10:00 - booked by the lead', dueDate: tomorrow, dueTime: '10:00', status: 'Open', leadId: L.id, ownerId: row.id, ownerName: row.name, createdAt: stamp, updatedAt: stamp });
  const before = sent.length;
  await say(L, 'ok');
  check('1 "ok" books nothing (the model even said "meeting")', (await meetings(L.id)).length === 1, await meetings(L.id));
  const ackMsg = sent.slice(before).map((x) => x.text).join(' ');
  check('2 "ok" with a call booked: one short line that confirms it ("You are booked for ... 10:00"), no sales push', /You are booked for .*10:00/i.test(ackMsg) && !/schedule|recruitment/i.test(ackMsg), ackMsg);
  const b2 = sent.length;
  await say(L, 'thanks');
  check('3 "thanks" right after: nothing more is sent (already confirmed)', sent.length === b2 && (await meetings(L.id)).length === 1);
  for (const m of ['👍', 'OK.', 'Thank you so much!']) {
    await say(L, m); // eslint-disable-line no-await-in-loop
  }
  check('4 a thumbs up, "OK.", "Thank you so much!": still one booking', (await meetings(L.id)).length === 1);

  prompts = [];
  answer = { reply: 'Sure. TeamLink ATS sends jobs to your Job Portal. Would you like to schedule a call? I have booked a call for you.', action: 'meeting' };
  await say(L, 'can we have a call to discuss?');
  const m5 = await meetings(L.id);
  const body5 = sent[sent.length - 1].text;
  check('5 asking for a call while one is booked: no second booking; the reply points to the call booked for 10:00', m5.length === 1 && /You are booked for .*10:00/.test(body5) && !/would you like to schedule|I have booked/i.test(body5), { m5, body5 });
  check('6 the product lead gets the product facts, not the recruitment pitch', prompts.length && /interested in TeamLink ATS/.test(prompts[0]) && !/ABOUT TEAMLINK:\nTeamLink Consultants is a recruitment company/.test(prompts[0]) && /A call is ALREADY booked/.test(prompts[0]), prompts[0] && prompts[0].slice(0, 400));

  answer = { reply: 'Sure.', action: 'meeting' };
  await say(L, '10:00am');
  check('7 "10:00am" when 10:00 is booked: no new booking, it confirms 10:00', (await meetings(L.id)).length === 1 && /booked for .*10:00/.test(sent[sent.length - 1].text), sent[sent.length - 1].text);
  answer = { reply: 'Sure, noted.', action: 'none' };
  await say(L, 'can we do 3 pm instead?');
  const move = await DB.all('SELECT "title" FROM "CrmTask" WHERE "leadId" = ? AND "title" LIKE \'Move the call%\'', L.id);
  check('8 another time asked for: still one booking, a follow-up for a person to move it to 15:00, and the lead is told', (await meetings(L.id)).length === 1 && move.length === 1 && /15:00/.test(move[0].title) && /move it to 15:00/.test(sent[sent.length - 1].text), { move, last: sent[sent.length - 1].text });

  // ---- 2. delivery
  const ai = await lastAi(L.id);
  check('9 the AI answer keeps its WhatsApp reference: the timeline shows "Sent"', /^wamid\.TEST/.test(ai.providerRef || '') && ai.deliveryStatus === 'Sent', ai);
  await CT.applyDeliveryStatus(ai.providerRef, 'read', null, new Date().toISOString());
  const ai2 = await lastAi(L.id);
  check('10 the WhatsApp read receipt reaches it: "Read"', ai2.deliveryStatus === 'Read', ai2);
  waFails = 'More than 24 hours since their last message: only an approved template can go now.';
  answer = { reply: 'TeamLink ATS has a client portal for your clients.', action: 'none' };
  const L3 = await mk('ZZTEST SAB Fail', { products: 'ATS' });
  await say(L3, 'what is the client portal?');
  const fail = await DB.one('SELECT "subject", "deliveryStatus" FROM "CrmActivity" WHERE "leadId" = ? AND "subject" LIKE \'AI answer not sent:%\'', L3.id);
  check('11 a send that fails is said plainly: "AI answer not sent: <reason>", marked Failed', fail && /24 hours/.test(fail.subject) && fail.deliveryStatus === 'Failed', fail);
  waFails = null;

  // ---- 3. no booking yet: the time the lead asks for, one clean line
  const L2 = await mk('ZZTEST SAB Fresh', { products: 'HRMS' });
  answer = { reply: 'Happy to talk. Would you like to schedule a call? I have booked it.', action: 'meeting' };
  await say(L2, 'please call me tomorrow at 11am');
  const m12 = await meetings(L2.id);
  const b12 = sent[sent.length - 1].text;
  check('12 no booking yet and a time asked for: booked at 11:00, and the message says it once, with no "would you like to schedule"', m12.length === 1 && m12[0].dueTime === '11:00' && (b12.match(/booked/gi) || []).length === 1 && !/would you like to schedule/i.test(b12), { m12, b12 });
  await unpause(L2);
  answer = { reply: 'Sure.', action: 'meeting' };
  await say(L2, 'yes');
  check('13 a second "yes" to a call: still one booking', (await meetings(L2.id)).length === 1);

  // ---- 4. a recruitment lead still gets the recruitment pitch
  prompts = [];
  answer = { reply: 'We find and screen candidates for IT roles.', action: 'none' };
  const L4 = await mk('ZZTEST SAB Hiring');
  await say(L4, 'what services do you offer?');
  check('14 a recruitment lead (no product) still gets the recruitment facts', prompts.length && /ABOUT TEAMLINK:/.test(prompts[0]) && !/interested in TeamLink/.test(prompts[0]));
  // ---- 5. a false job-board claim to a product lead is replaced
  answer = { reply: 'Yes, TeamLink ATS posts your jobs to LinkedIn and Indeed with one click.', action: 'none' };
  await say(L, 'can it post to linkedin?');
  const b15 = sent[sent.length - 1].text;
  check('15 a product lead is never told "one click to LinkedIn / Indeed"', !/one click/i.test(b15) && /Job Portal/.test(b15), b15);

  await prisma.$disconnect();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
