#!/usr/bin/env node
/**
 * THE CRM MONEY GAPS (crm/moneyMore.js, crm/sequences.js), 2026-11-26: payment receipts (PDF, number, WhatsApp link, email), credit / debit notes
 * (limits, balance and Paid / Partly paid follow, PDF, cancel), repeating invoices (Draft copy, by hand always, by itself only when switched on),
 * commission (live statement, approve a finished month, paid), SLA hours from settings, sales sequences (enrol, sends, follow-up, stop on reply).
 * Never touches the ATS Accounts Invoice / Client tables.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> [TEST_PORT=4093] node scripts/crm-money-gaps-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-gaps-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" = 'email'");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" = 'email'"); // email NOT set up
dbx.close();

const PORT = Number(process.env.TEST_PORT) || 4093;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-gaps-test', INTEGRATION_SECRET_KEY: 'zz-crm-gaps-test-integration-key',
  APP_BASE_URL: `http://localhost:${PORT}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');
const MM = require('../src/crm/moneyMore');
const SEQ = require('../src/crm/sequences');
const AUTO = require('../src/crm/autopilot');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 460)}` : ''}`); } };
let auth = {};
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
const raw = async (url, headers = auth) => { const r = await fetch(API + url, { headers }); const b = Buffer.from(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type') || '', b }; };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const istDay = (plus = 0) => new Date(Date.now() + 5.5 * 3600000 + plus * 86400000).toISOString().slice(0, 10);
const lastMonth = () => { const d = new Date(Date.now() + 5.5 * 3600000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  console.log('0. The pure rules');
  check('rupees in words, the Indian way', MM.rupeesInWords(123456.5) === 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only', MM.rupeesInWords(123456.5));
  check('crores and a round amount', MM.rupeesInWords(25000000) === 'Rupees Two Crore Fifty Lakh Only', MM.rupeesInWords(25000000));
  check('a month on: 31 January -> 28 February, 30 November -> 30 December', MM.addMonths('2027-01-31', 1) === '2027-02-28' && MM.addMonths('2026-11-30', 1) === '2026-12-30' && MM.addMonths('2026-11-15', 12) === '2027-11-15');
  const tk = MM.tokenFor('receipt', 'pay_1');
  check('a receipt link opens only its receipt; a changed one opens nothing', MM.idOfToken('receipt', tk) === 'pay_1' && MM.idOfToken('receipt', `${tk}x`) === null && MM.idOfToken('invoice', tk) === null);
  check('sequence steps: a day out of order is refused', !!SEQ.cleanSteps([{ channel: 'sms', afterDays: 3, body: 'a' }, { channel: 'sms', afterDays: 1, body: 'b' }]).error);

  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  await SETTINGS.load({ fresh: true });
  const atsInvoicesBefore = await prisma.invoice.count();
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; // eslint-disable-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); }); // eslint-disable-line no-await-in-loop
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };
  const P = process.pid;
  await call('PUT', '/crm/settings', { invoiceFrom: { name: 'TeamLink Consultants', gstin: '36AAACT1234A1Z5', state: 'Telangana', address: 'Hyderabad' }, invoiceTaxPercent: 18 });
  const mkAccount = async (name, extra = {}) => (await call('POST', '/crm/accounts', { name: `${name} ${P}`, address: '1 Road', state: 'Telangana', phone: '9876500011', email: `zz.gaps.${P}@example.com`, ...extra })).body.account;
  const win = async (account, title, value) => {
    const d = await call('POST', '/crm/deals', { title: `${title} ${P}`, accountId: account.id, value: String(value) });
    const w = await call('POST', `/crm/deals/${d.body.deal.id}/stage`, { stage: 'Won' });
    return w.body.invoice;
  };
  const detail = async (id) => (await call('GET', `/crm/invoices/${id}`)).body.invoice;
  const acc = await mkAccount('ZZ Gaps Customer');

  console.log('1. Payment receipts');
  const A = await win(acc, 'ZZ Gaps Receipts', 100000); // 1,18,000 with GST
  await call('POST', `/crm/invoices/${A.id}/status`, { status: 'Sent' });
  const p1 = await call('POST', `/crm/invoices/${A.id}/payments`, { amount: 50000, mode: 'UPI', reference: 'UTR123' });
  const pay1 = p1.body.invoice.payments[0];
  const r1 = await raw(`/crm/invoices/${A.id}/payments/${pay1.id}/receipt`);
  check('the receipt is a PDF', r1.status === 200 && /pdf/.test(r1.type) && r1.b.slice(0, 4).toString() === '%PDF', [r1.status, r1.type]);
  const no1 = (await DB.one('SELECT "receiptNo" FROM "CrmPayment" WHERE "id" = ?', pay1.id)).receiptNo;
  check('it has its own number RCT-0001 style', /^RCT-\d{4}$/.test(no1 || ''), no1);
  await raw(`/crm/invoices/${A.id}/payments/${pay1.id}/receipt`);
  check('the number is given once: the same receipt again keeps it', (await DB.one('SELECT "receiptNo" FROM "CrmPayment" WHERE "id" = ?', pay1.id)).receiptNo === no1);
  const p2 = await call('POST', `/crm/invoices/${A.id}/payments`, { amount: 10000, mode: 'Cheque' });
  const pay2 = p2.body.invoice.payments.find((x) => x.id !== pay1.id);
  await raw(`/crm/invoices/${A.id}/payments/${pay2.id}/receipt`);
  const no2 = (await DB.one('SELECT "receiptNo" FROM "CrmPayment" WHERE "id" = ?', pay2.id)).receiptNo;
  check('the next payment gets the next number', Number(no2.slice(4)) === Number(no1.slice(4)) + 1, [no1, no2]);
  const sh = await call('POST', `/crm/invoices/${A.id}/payments/${pay1.id}/receipt/share`);
  check('WhatsApp: a link and the message with the customer\'s number', sh.status === 200 && /\/api\/crm-public\/receipt\//.test(sh.body.url) && /wa\.me\/919876500011/.test(sh.body.waUrl) && sh.body.text.includes(no1), sh.body);
  const pub = await raw(sh.body.url.replace(`http://localhost:${PORT}/api`, ''), {});
  check('the customer opens the receipt PDF without a login', pub.status === 200 && pub.b.slice(0, 4).toString() === '%PDF', [pub.status, pub.type]);
  check('a changed link opens nothing', (await raw(`${sh.body.url.replace(`http://localhost:${PORT}/api`, '')}x`, {})).status === 404);
  const dr = await call('GET', `/crm/invoices/${A.id}/payments/${pay1.id}/receipt/email-draft`);
  check('email: the customer\'s address and words are ready', dr.status === 200 && dr.body.to === `zz.gaps.${P}@example.com` && /receipt/i.test(dr.body.subject), dr.body);
  const em = await call('POST', `/crm/invoices/${A.id}/payments/${pay1.id}/receipt/email`, { to: dr.body.to, subject: dr.body.subject, text: dr.body.text });
  check('email not set up (or a test address): said plainly, nothing sent', (em.status === 409 && em.body.notConfigured) || (em.status === 400 && /not sent/i.test(em.body.error || '')), em);

  console.log('2. Credit / debit notes');
  // A: total 1,18,000, received 60,000 -> 58,000 left
  const tooBig = await call('POST', `/crm/invoices/${A.id}/notes`, { kind: 'credit', amount: 60000, reason: 'Discount agreed later' });
  check('a credit note above what is unpaid is refused (60,000 + GST > 58,000 left)', tooBig.status === 400 && near(tooBig.body.left, 58000), tooBig.body);
  check('a reason is needed', (await call('POST', `/crm/invoices/${A.id}/notes`, { kind: 'credit', amount: 1000, reason: '' })).status === 400);
  const cn = await call('POST', `/crm/invoices/${A.id}/notes`, { kind: 'credit', amount: 10000, reason: 'One position not filled' });
  check('credit note CN-0001: 10,000 + 18% GST = 11,800', cn.status === 200 && /^CN-\d{4}/.test(cn.body.note.code) && near(cn.body.note.total, 11800) && near(cn.body.note.taxAmount, 1800), cn.body);
  check('the invoice: printed total stays 1,18,000; worth 1,06,200; 46,200 left', near(cn.body.invoice.total, 118000) && near(cn.body.invoice.netTotal, 106200) && near(cn.body.invoice.balance, 46200) && near(cn.body.invoice.creditAmount, 11800), [cn.body.invoice.total, cn.body.invoice.netTotal, cn.body.invoice.balance]);
  const npdf = await raw(`/crm/invoices/${A.id}/notes/${cn.body.note.id}/pdf`);
  check('the credit note is a PDF', npdf.status === 200 && npdf.b.slice(0, 4).toString() === '%PDF');
  check('the invoice PDF still opens with the note on it', (await raw(`/crm/invoices/${A.id}/pdf`)).status === 200);
  const rest = await call('POST', `/crm/invoices/${A.id}/payments`, { amount: 46200, mode: 'Bank transfer' });
  check('paying what is left after the credit note makes it Paid', rest.status === 200 && rest.body.invoice.status === 'Paid' && near(rest.body.invoice.balance, 0), rest.body.invoice && [rest.body.invoice.status, rest.body.invoice.balance]);
  check('a credit note on a fully paid invoice is refused (refund outside)', (await call('POST', `/crm/invoices/${A.id}/notes`, { kind: 'credit', amount: 100, reason: 'x late' })).status === 400);
  const dn = await call('POST', `/crm/invoices/${A.id}/notes`, { kind: 'debit', amount: 5000, reason: 'Extra interview rounds' });
  check('debit note DN-0001 on a Paid invoice: 5,900 more is owed, back to Partly paid', dn.status === 200 && /^DN-/.test(dn.body.note.code) && dn.body.invoice.status === 'Partly paid' && near(dn.body.invoice.balance, 5900), dn.body.invoice && [dn.body.invoice.status, dn.body.invoice.balance]);
  const cx = await call('POST', `/crm/invoices/${A.id}/notes/${dn.body.note.id}/cancel`);
  check('the debit note cancelled: Paid again', cx.status === 200 && cx.body.invoice.status === 'Paid' && near(cx.body.invoice.balance, 0), cx.body.invoice && cx.body.invoice.status);
  check('a cancelled note cannot be cancelled twice', (await call('POST', `/crm/invoices/${A.id}/notes/${dn.body.note.id}/cancel`)).status === 400);
  const list = await call('GET', `/crm/invoices/${A.id}/notes`);
  check('the notes list: both, one cancelled', list.body.notes.length === 2 && list.body.notes.some((x) => x.status === 'Cancelled'), list.body);
  const B = await win(acc, 'ZZ Gaps Unpaid', 20000); // 23,600
  check('a note on a Draft is refused (edit the Draft instead)', (await call('POST', `/crm/invoices/${B.id}/notes`, { kind: 'credit', amount: 100, reason: 'x y z' })).status === 400);
  await call('POST', `/crm/invoices/${B.id}/status`, { status: 'Sent' });
  check('crediting the whole of an unpaid invoice is a Cancel instead', (await call('POST', `/crm/invoices/${B.id}/notes`, { kind: 'credit', amount: 20000, reason: 'Not needed' })).status === 400);
  await call('POST', `/crm/invoices/${B.id}/notes`, { kind: 'credit', amount: 2000, reason: 'Fee lowered' });
  const toCancel = await call('POST', `/crm/invoices/${B.id}/status`, { status: 'Cancelled' });
  check('an invoice with an issued note cannot be cancelled until the note is', toCancel.status === 409 && toCancel.body.hasNotes, toCancel.body);
  const rep = await call('GET', '/crm/invoices?status=Sent');
  const bRow = rep.body.invoices.find((x) => x.id === B.id);
  check('the invoice list shows the balance after the note (23,600 - 2,360)', bRow && near(bRow.balance, 21240), bRow && bRow.balance);

  console.log('3. Repeating invoices');
  const C = await win(acc, 'ZZ Gaps Retainer', 30000);
  await call('POST', `/crm/invoices/${C.id}/status`, { status: 'Sent' });
  check('a last date before the next one is refused', (await call('PUT', `/crm/invoices/${C.id}/repeat`, { every: 'month', untilDate: istDay(1) })).status === 400);
  const set = await call('PUT', `/crm/invoices/${C.id}/repeat`, { every: 'month' });
  check('repeats every month: next on the same day next month; switched off by default', set.status === 200 && set.body.repeat.nextDate === MM.addMonths(C.issueDate, 1) && set.body.autoOn === false, set.body);
  const next = await call('POST', `/crm/invoices/${C.id}/repeat/next`);
  check('"Make the next one now": a Draft copy, same lines and total, its own number', next.status === 200 && next.body.invoice.status === 'Draft' && near(next.body.invoice.total, C.total) && next.body.invoice.code !== C.code && next.body.invoice.repeatOfId === C.id && next.body.invoice.issueDate === MM.addMonths(C.issueDate, 1), next.body.invoice);
  const after = await call('GET', `/crm/invoices/${C.id}/repeat`);
  check('the repeat moved on a month and counts 1 made', after.body.repeat.made === 1 && after.body.repeat.nextDate === MM.addMonths(C.issueDate, 2) && after.body.made.length === 1, after.body.repeat);
  await DB.run('UPDATE "CrmInvoiceRepeat" SET "nextDate" = ? WHERE "invoiceId" = ?', istDay(0), C.id);
  check('switched off: the day comes and nothing is made by itself', (await MM.repeatTick()) === 0);
  check('only a Sales manager / Admin switches it on (an Admin here)', (await call('PUT', '/crm/money-settings', { recurringOn: true })).status === 200);
  const madeNow = await MM.repeatTick();
  check('switched on: the due repeat makes its Draft, once', madeNow === 1 && (await MM.repeatTick()) === 0, madeNow);
  check('two made from it now', Number((await DB.one('SELECT COUNT(*) AS "n" FROM "CrmInvoice" WHERE "repeatOfId" = ?', C.id)).n) === 2);
  check('a repeat of a repeat is refused (change the first one)', (await call('PUT', `/crm/invoices/${next.body.invoice.id}/repeat`, { every: 'month' })).status === 400);
  const off = await call('PUT', `/crm/invoices/${C.id}/repeat`, { active: false });
  check('the repeat can be stopped', off.status === 200 && off.body.repeat.active === false);

  console.log('4. Commission');
  check('a commission % above 50 is refused', (await call('PUT', '/crm/money-settings', { commission: { percent: 80 } })).status === 400);
  await call('PUT', '/crm/money-settings', { commission: { percent: 5, byUser: { [admin.id]: 10 } } });
  const thisMonth = istDay(0).slice(0, 7);
  const sNow = await call('GET', `/crm/commission?month=${thisMonth}`);
  const mine = sNow.body.rows.find((x) => x.ownerId === admin.id);
  // A: 50,000 + 10,000 + 46,200 cash on a 1,00,000 + GST invoice -> before GST = 1,06,200 x 100/118 = 90,000
  check('this month: collected 1,06,200, before GST 90,000, at 10% = 9,000 (not approved)', mine && near(mine.collected, 106200) && near(mine.base, 90000) && mine.percent === 10 && near(mine.amount, 9000) && mine.status === 'Not approved', mine);
  check('a month that is not over cannot be approved', (await call('POST', '/crm/commission/approve', { month: thisMonth, ownerId: admin.id })).status === 400);
  const D = await win(acc, 'ZZ Gaps Last Month', 10000); // 11,800
  await call('POST', `/crm/invoices/${D.id}/status`, { status: 'Sent' });
  const lm = lastMonth();
  await call('POST', `/crm/invoices/${D.id}/payments`, { amount: 11800, paidOn: `${lm}-15` });
  const sLast = await call('GET', `/crm/commission?month=${lm}`);
  const mineLast = sLast.body.rows.find((x) => x.ownerId === admin.id);
  check('last month: 11,800 collected, 10,000 before GST, 1,000 commission', mineLast && near(mineLast.base, 10000) && near(mineLast.amount, 1000), mineLast);
  const lines = await call('GET', `/crm/commission/lines?month=${lm}&ownerId=${admin.id}`);
  check('the lines behind it: the payment with its invoice', lines.body.rows.length >= 1 && lines.body.rows.some((x) => x.invoice === D.code && near(x.base, 10000)), lines.body);
  const ap = await call('POST', '/crm/commission/approve', { month: lm, ownerId: admin.id });
  const apRow = ap.body.rows && ap.body.rows.find((x) => x.ownerId === admin.id);
  check('approved: frozen at 1,000', ap.status === 200 && apRow.status === 'Approved' && near(apRow.amount, 1000), ap.body);
  check('approving twice is refused', (await call('POST', '/crm/commission/approve', { month: lm, ownerId: admin.id })).status === 409);
  await call('PUT', '/crm/money-settings', { commission: { byUser: { [admin.id]: 20 } } });
  const frozen = (await call('GET', `/crm/commission?month=${lm}`)).body.rows.find((x) => x.ownerId === admin.id);
  check('a later % change does not move an approved month', frozen.percent === 10 && near(frozen.amount, 1000), frozen);
  const pd = await call('POST', '/crm/commission/paid', { month: lm, ownerId: admin.id, reference: 'Salary Nov' });
  check('marked paid', pd.status === 200 && pd.body.rows.find((x) => x.ownerId === admin.id).status === 'Paid');
  check('a paid month cannot be undone', (await call('POST', '/crm/commission/undo', { month: lm, ownerId: admin.id })).status === 400);

  console.log('5. SLA hours');
  check('an SLA of 0 hours is refused', (await call('PUT', '/crm/money-settings', { slaHours: { Urgent: 0 } })).status === 400);
  await call('PUT', '/crm/money-settings', { slaHours: { Urgent: 2 } });
  const t = await call('POST', '/crm/tickets', { subject: `ZZ Gaps urgent ${P}`, priority: 'Urgent', accountId: acc.id });
  const dueIn = (Date.parse(t.body.ticket.dueAt) - Date.now()) / 3600000;
  check('a new Urgent ticket is due in 2 hours, not 4', t.status === 200 && dueIn > 1.9 && dueIn < 2.05, [t.status, dueIn]);
  await new Promise((r) => { setTimeout(r, 300); });
  const me = (await call('GET', '/crm/me')).body;
  check('the screen reads the new SLA hours', me.lists && me.lists.slaHours && me.lists.slaHours.Urgent === 2 && me.lists.slaHours.Low === 120, me.lists && me.lists.slaHours);

  console.log('6. Sales sequences');
  check('a sequence without steps is refused', (await call('POST', '/crm/sequences', { name: 'Empty', steps: [] })).status === 400);
  const sq = await call('POST', '/crm/sequences', { name: `ZZ Warm ${P}`, steps: [{ channel: 'email', afterDays: 0, subject: 'Hello {name}', body: 'Hi {name}, can we talk?' }, { channel: 'task', afterDays: 0, body: 'Call them about the proposal' }, { channel: 'sms', afterDays: 3, body: 'Hi {name}' }] });
  check('a sequence of 3 steps is made', sq.status === 200 && sq.body.sequence.steps.length === 3, sq.body);
  const lead = (await call('POST', '/crm/leads', { company: `ZZ Seq Co ${P}`, contactName: 'Asha Rao', email: `zz.seq.${P}@example.com`, phone: '9876500022' })).body.lead;
  const en = await call('POST', `/crm/leads/${lead.id}/sequences`, { sequenceId: sq.body.sequence.id });
  check('the lead is put on it', en.status === 200 && en.body.ok, en.body);
  check('one sequence at a time', (await call('POST', `/crm/leads/${lead.id}/sequences`, { sequenceId: sq.body.sequence.id })).status === 409);
  const sentMail = [];
  const out = await SEQ.tick({ deps: { noQuiet: true, sendMail: async (m) => { sentMail.push(m); return { ok: true }; }, sendSms: async () => ({ ok: true }) } });
  check('day 0: the mail goes and the follow-up is made; the SMS waits for day 3', out.sent === 1 && out.tasks === 1 && sentMail.length === 1 && sentMail[0].to === `zz.seq.${P}@example.com` && /Asha/.test(sentMail[0].text), [out, sentMail.length]);
  check('the mail carries the unsubscribe line', /unsubscribe|stop/i.test(sentMail[0].text || ''));
  const task = await DB.one('SELECT * FROM "CrmTask" WHERE "leadId" = ? AND "origin" = \'sequence\'', lead.id);
  check('the follow-up is the owner\'s, for today', task && task.ownerId === lead.ownerId && /Call them/.test(task.title), task);
  const steps1 = (await call('GET', `/crm/leads/${lead.id}/sequences`)).body.enrolments[0];
  check('the lead shows the steps: two done, one waiting', steps1.status === 'active' && steps1.steps.filter((x) => x.status === 'sent').length === 2 && steps1.steps[2].status === 'waiting', steps1);
  const n = await AUTO.onReply({ channel: 'Email', email: `zz.seq.${P}@example.com`, subject: 'Re: Hello', text: 'Yes, call me tomorrow' });
  const steps2 = (await call('GET', `/crm/leads/${lead.id}/sequences`)).body.enrolments[0];
  check('they replied: the sequence stops, the SMS never goes', n >= 1 && steps2.status === 'stopped' && /replied/.test(steps2.stopWhy || '') && steps2.steps[2].status === 'stopped', steps2);
  const lead2 = (await call('POST', '/crm/leads', { company: `ZZ Seq Two ${P}`, contactName: 'Ravi', phone: '9876500033' })).body.lead;
  const en2 = await call('POST', `/crm/leads/${lead2.id}/sequences`, { sequenceId: sq.body.sequence.id });
  check('a lead with no email: put on it, with a warning that the mail is skipped', en2.status === 200 && /email/.test(en2.body.warn || ''), en2.body);
  check('Stop', (await call('POST', `/crm/leads/${lead2.id}/sequences/stop`)).status === 200 && (await call('GET', `/crm/leads/${lead2.id}/sequences`)).body.enrolments[0].status === 'stopped');

  check('the ATS Accounts invoices are untouched', (await prisma.invoice.count()) === atsInvoicesBefore);
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log(`FAIL  crashed: ${e.stack || e.message}`); await stop(1); });
