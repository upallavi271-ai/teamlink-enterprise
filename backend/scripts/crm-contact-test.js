#!/usr/bin/env node
/**
 * CALL, WHATSAPP AND EMAIL FROM A CRM RECORD (crm/contact.js) - founder 2026-11-14: "call, mail, wtsp dheyni meedha click chesina work avvali; integrations
 * lo vuntadhi, akkada nundi techukoni configure chesko; proper ga integrate avvali".
 * The buttons use what Administration -> Integrations has connected (Email SMTP, WhatsApp, Cloud Telephony). Nothing real is contacted: the sandbox's fake
 * mail transport captures the email, WhatsApp and Exotel answer as test servers.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4059.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-contact-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-contact-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" = \'crm.settings\'');
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'whatsapp', 'whatsapp-qr', 'telephony')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'whatsapp', 'whatsapp-qr', 'telephony')"); // nothing connected to start with
dbx.close();

const MAILS = path.join(os.tmpdir(), `zz-crm-contact-mails-${process.pid}.jsonl`);
const PORT = 4059;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-contact-test', INTEGRATION_SECRET_KEY: 'zz-crm-contact-test-integration-key', TL_COMM_SEND_LIMIT: '500', TEST_MAIL_CAPTURE: MAILS, APP_BASE_URL: `http://localhost:${PORT}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const CAT = require('../src/utils/adminCatalog');
const GW = require('../src/utils/callGateway');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 460)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
const mails = () => (fs.existsSync(MAILS) ? fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ ${tag}`, email: `zz.crmcontact.${tag}.${process.pid}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const setRow = async (id, fields, enabled = true) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' } });
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.unlinkSync(MAILS); } catch { /* none */ } process.exit(code); }, 800);
}
const timeline = async (kind, id) => (await call('GET', `/crm/${kind}s/${id}`, null, T.X)).body.activities || [];
let T = {};

(async () => {
  await DB.ensure();
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const A = await mkUser('repA', { role: 'EMPLOYEE' }); // a Salesperson WITHOUT a phone on the employee profile
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const V = await mkUser('viewer', { role: 'EMPLOYEE' });
  await prisma.employee.create({ data: { employeeCode: `ZZ-CC-X-${process.pid}`, name: X.name, userId: X.id, email: X.email, phone: '9000000002', designation: 'Employee', employmentStatus: 'Active', department: 'Sales' } });
  T = { X: await tokenOf(X.id), A: await tokenOf(A.id), B: await tokenOf(B.id), V: await tokenOf(V.id) };
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  await new Promise((r) => { setTimeout(r, 1100); });
  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  await call('PUT', '/crm/settings', { salesTeam: [{ userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own }, { userId: V.id, name: V.name, role: 'viewer' }] }, T.X);
  await new Promise((r) => { setTimeout(r, 300); });

  const lead = (await call('POST', '/crm/leads', { company: `ZZ Contact Co ${process.pid}`, contactName: 'Asha Rao', phone: '+91 98765 43210', email: `asha.${process.pid}@example.test`, expectedValue: 50000 }, T.X)).body.lead;
  const leadA = (await call('POST', '/crm/leads', { company: `ZZ Contact A ${process.pid}`, contactName: 'Ravi', phone: '9876500011', email: `ravi.${process.pid}@example.test` }, T.A)).body.lead;
  const bare = (await call('POST', '/crm/leads', { company: `ZZ Contact Bare ${process.pid}` }, T.X)).body.lead;

  console.log('1. Nothing connected yet: the screen says so, and nothing is "sent"');
  const r0 = (await call('GET', '/crm/contact/ready', null, T.X)).body;
  check('Email, WhatsApp and calling are all reported as not connected, each with its reason', r0.email && !r0.email.ready && r0.email.reason && r0.whatsapp && !r0.whatsapp.ready && r0.whatsapp.reason && r0.call && !r0.call.clickToCall && r0.call.reason, r0);
  const e0 = await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Hi', text: 'Hello' }, T.X);
  check('an email is refused with "Email is not connected", not pretended', e0.status === 409 && e0.body.notConfigured === true && /not connected|never been configured/i.test(e0.body.error), e0.body);
  const w0 = await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'WhatsApp', text: 'Hello' }, T.X);
  check('a WhatsApp message is refused the same way', w0.status === 409 && w0.body.notConfigured === true, w0.body);
  const c0 = await call('POST', '/crm/contact/call', { kind: 'lead', id: lead.id }, T.X);
  check('a call through TeamLink is refused the same way', c0.status === 409 && c0.body.notConfigured === true, c0.body);
  check('none of those wrote anything on the timeline', (await timeline('lead', lead.id)).filter((a) => /sent|Call through/.test(a.subject || '')).length === 0);
  const op = await call('POST', '/crm/contact/opened', { kind: 'lead', id: lead.id, channel: 'WhatsApp' }, T.X);
  const tl0 = await timeline('lead', lead.id);
  check('"opened in my own WhatsApp" is written on the timeline, and says TeamLink cannot see if it was sent', op.status === 200 && tl0.some((a) => /WhatsApp opened/.test(a.subject || '') && /cannot see/.test(a.note || '')), tl0.map((a) => a.subject));

  console.log('2. The integrations are connected in Administration (nothing is typed again here)');
  await setRow('email', { 'SMTP host': 'smtp.zz-test.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'crm@zz-test.invalid', 'Default from name': 'TeamLink' });
  await setRow('whatsapp', { [CAT.WA_FIELDS.phoneId]: '1234567890', [CAT.WA_FIELDS.token]: 'zz-test-token', [CAT.WA_FIELDS.display]: '+91 90000 00001' });
  await setRow('telephony', { [GW.F.provider]: 'Exotel', [GW.F.sid]: 'zzsid', [GW.F.key]: 'zzkey', [GW.F.token]: 'zztoken', [GW.F.callerId]: '08000000000', [GW.F.record]: 'Yes', [GW.F.secret]: 'zz-call-secret' });
  await new Promise((r) => { setTimeout(r, 400); });
  const r1 = (await call('GET', '/crm/contact/ready', null, T.X)).body;
  check('the screen now reads Email, WhatsApp and click-to-call as ready, from what is in Integrations', r1.email.ready && r1.email.from === 'crm@zz-test.invalid' && r1.whatsapp.ready && r1.call.clickToCall && r1.call.provider === 'Exotel' && r1.call.myPhone === true && r1.call.recording === true, r1);
  check('a login with no phone on the employee profile is told so', (await call('GET', '/crm/contact/ready', null, T.A)).body.call.myPhone === false);

  console.log('3. Email: really sent, from the person, written on the timeline');
  const dr = (await call('GET', `/crm/contact/draft?kind=lead&id=${lead.id}`, null, T.X)).body;
  check('the first words are ready: the contact\'s first name, the company in the subject, the sender at the foot', dr.to.email === lead.email && /^Hello Asha,/.test(dr.email.text) && /ZZ Contact Co/.test(dr.email.subject) && /ZZ admin/.test(dr.email.text) && /^Hello Asha, this is ZZ admin/.test(dr.whatsapp.text), dr);
  const em = await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Our recruitment services', text: 'Hello Asha,\n\nWe can help you hire.\n\nRegards' }, T.X);
  check('the email is sent', em.status === 200 && em.body.ok && em.body.to === lead.email, em.body);
  const sent = mails().filter((m) => /Our recruitment services/.test(m.subject));
  check('the mail server was handed it: right address, subject and text, from the person with the company relay', sent.length === 1 && String(sent[0].to).includes(lead.email) && /We can help you hire/.test(sent[0].text) && /ZZ admin/.test(sent[0].from + sent[0].replyTo), sent[0]);
  const tl1 = await timeline('lead', lead.id);
  check('it is on the lead\'s timeline with the message', tl1.some((a) => a.kind === 'email' && /Email sent: Our recruitment services/.test(a.subject) && /We can help you hire/.test(a.note)), tl1.map((a) => a.subject));
  check('and the New lead is now Contacted (a person wrote to it)', (await call('GET', `/crm/leads/${lead.id}`, null, T.X)).body.lead.status === 'Contacted');
  check('no subject: refused', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', text: 'x' }, T.X)).status === 400);
  check('no message: refused', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 's' }, T.X)).status === 400);
  check('an address that is not an address: refused', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', to: 'not-an-email', subject: 's', text: 'x' }, T.X)).status === 400);
  const noMail = await call('POST', '/crm/contact/send', { kind: 'lead', id: bare.id, channel: 'Email', subject: 's', text: 'x' }, T.X);
  check('a record with no email and nothing typed: asks for the address', noMail.status === 400 && /no email address/i.test(noMail.body.error), noMail.body);
  const typed = await call('POST', '/crm/contact/send', { kind: 'lead', id: bare.id, channel: 'Email', to: `typed.${process.pid}@example.test`, subject: 'Typed address', text: 'x' }, T.X);
  check('an address typed in the To box is used', typed.status === 200 && mails().some((m) => String(m.to).includes('typed.')), typed.body);
  await call('POST', '/crm/opt-out', { channel: 'email', value: lead.email }, T.X);
  check('an address that unsubscribed is not mailed', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 's2', text: 'x' }, T.X)).status === 409);

  console.log('4. WhatsApp: really sent through the connected number, written on the timeline');
  const wa = await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'WhatsApp', text: 'Hello Asha, this is TeamLink.' }, T.X);
  check('the message is sent to the number written as +91 98765 43210 (cleaned to +919876543210)', wa.status === 200 && wa.body.ok && wa.body.to === '+919876543210', wa.body);
  check('and it is on the timeline with the message', (await timeline('lead', lead.id)).some((a) => a.kind === 'whatsapp' && /WhatsApp message sent/.test(a.subject) && /\+919876543210/.test(a.note) && /this is TeamLink/.test(a.note)));
  check('an empty message is refused', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'WhatsApp', text: '  ' }, T.X)).status === 400);
  check('a number that is not a number is refused, with the reason', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'WhatsApp', to: '12345', text: 'x' }, T.X)).status === 400);
  check('a record with no number and nothing typed asks for the number', /no phone number/i.test((await call('POST', '/crm/contact/send', { kind: 'lead', id: bare.id, channel: 'WhatsApp', text: 'x' }, T.X)).body.error));
  await call('POST', '/crm/opt-out', { channel: 'whatsapp', value: '9876500011' }, T.X);
  check('a number that asked to stop is not messaged', (await call('POST', '/crm/contact/send', { kind: 'lead', id: leadA.id, channel: 'WhatsApp', text: 'x' }, T.X)).status === 409);

  console.log('5. Call: the person\'s phone rings first, the result lands on the timeline');
  const cl = await call('POST', '/crm/contact/call', { kind: 'lead', id: lead.id }, T.X);
  check('the call is started (test server)', cl.status === 200 && cl.body.ok && cl.body.sandbox === true && cl.body.activityId && /will ring first/.test(cl.body.message), cl.body);
  const tl2 = await timeline('lead', lead.id);
  const callLine = tl2.find((a) => a.id === cl.body.activityId);
  check('it is on the timeline as a call to the contact', callLine && callLine.kind === 'call' && /Call through TeamLink to Asha Rao/.test(callLine.subject) && /rings first/.test(callLine.note), callLine);
  const hook = await call('POST', `/webhooks/call/exotel?key=zz-call-secret`, { CallSid: cl.body.callSid, Status: 'completed', ConversationDuration: 75, CustomField: `crm:${cl.body.activityId}`, RecordingUrl: 'https://example.test/rec.mp3' });
  check('Exotel reports the end of the call', hook.status === 200 && hook.body.ok && hook.body.matched >= 1, hook.body);
  const callAfter = (await timeline('lead', lead.id)).find((a) => a.id === cl.body.activityId);
  check('the result is written on that call line: completed, talked 1 min 15 s, with the recording', /Call completed/.test(callAfter.note) && /talked 1 min 15 s/.test(callAfter.note) && /rec\.mp3/.test(callAfter.note), callAfter.note);
  check('a wrong webhook key is refused', (await call('POST', `/webhooks/call/exotel?key=wrong`, { CallSid: 'x', Status: 'completed', CustomField: `crm:${cl.body.activityId}` })).status === 403);
  const noAnswer = await call('POST', '/crm/contact/call', { kind: 'lead', id: lead.id }, T.X);
  await call('POST', `/webhooks/call/exotel?key=zz-call-secret`, { CallSid: noAnswer.body.callSid, Status: 'no-answer', CustomField: `crm:${noAnswer.body.activityId}` });
  check('a call nobody answered says so', /No answer|did not answer|no-answer|not answered/i.test(((await timeline('lead', lead.id)).find((a) => a.id === noAnswer.body.activityId) || {}).note || ''));
  check('with no phone on the person\'s profile, the call asks for it (and starts nothing)', (await call('POST', '/crm/contact/call', { kind: 'lead', id: leadA.id }, T.A)).body.needsMyPhone === true);
  check('a record with no number asks for the number', (await call('POST', '/crm/contact/call', { kind: 'lead', id: bare.id }, T.X)).status === 400);
  check('calling the person\'s own number is refused', (await call('POST', '/crm/contact/call', { kind: 'lead', id: lead.id, to: '9000000002' }, T.X)).status === 400);

  console.log('6. Whose record it is');
  check('another Salesperson cannot mail, message or call a lead that is not theirs', (await call('POST', '/crm/contact/send', { kind: 'lead', id: leadA.id, channel: 'Email', subject: 's', text: 'x' }, T.B)).status === 404 && (await call('POST', '/crm/contact/send', { kind: 'lead', id: leadA.id, channel: 'WhatsApp', text: 'x' }, T.B)).status === 404 && (await call('POST', '/crm/contact/call', { kind: 'lead', id: leadA.id }, T.B)).status === 404);
  check('the Viewer cannot contact anyone from here', (await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 's', text: 'x' }, T.V)).status === 404 && (await call('GET', `/crm/contact/draft?kind=lead&id=${lead.id}`, null, T.V)).status === 404);
  check('the owner can mail their own lead', (await call('POST', '/crm/contact/send', { kind: 'lead', id: leadA.id, channel: 'Email', subject: 'Own lead', text: 'x' }, T.A)).status === 200);

  console.log('7. Deals and customers use the contact who decides');
  const acc = (await call('POST', '/crm/accounts', { name: `ZZ Contact Acc ${process.pid}` }, T.X)).body.account;
  await call('POST', '/crm/contacts', { accountId: acc.id, name: 'Meera Rao', role: 'Decision maker', phone: '098111 22233', email: `meera.${process.pid}@example.test` }, T.X);
  const deal = (await call('POST', '/crm/deals', { title: 'ZZ Contact Deal', accountId: acc.id, value: '10000' }, T.X)).body.deal;
  const dr2 = (await call('GET', `/crm/contact/draft?kind=deal&id=${deal.id}`, null, T.X)).body;
  check('a deal\'s draft is for the account\'s decision maker: her name, number and email', dr2.to.name === 'Meera Rao' && dr2.to.phone === '098111 22233' && dr2.to.email === `meera.${process.pid}@example.test` && /^Hello Meera,/.test(dr2.email.text), dr2);
  const dm = await call('POST', '/crm/contact/send', { kind: 'deal', id: deal.id, channel: 'WhatsApp', text: 'About the deal' }, T.X);
  check('a WhatsApp message from the deal goes to her (leading 0 cleaned), and is on the deal\'s timeline', dm.status === 200 && dm.body.to === '+919811122233' && (await timeline('deal', deal.id)).some((a) => /WhatsApp message sent/.test(a.subject)), dm.body);
  const da = await call('POST', '/crm/contact/send', { kind: 'account', id: acc.id, channel: 'Email', subject: 'Hello customer', text: 'x' }, T.X);
  check('an email from the customer record goes to the same person', da.status === 200 && da.body.to === `meera.${process.pid}@example.test`, da.body);
  check('something that is not a lead, deal, customer or contact is refused', (await call('POST', '/crm/contact/send', { kind: 'ticket', id: deal.id, channel: 'Email', subject: 's', text: 'x' }, T.X)).status === 400);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
