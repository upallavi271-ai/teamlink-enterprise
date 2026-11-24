#!/usr/bin/env node
/**
 * CRM WAVE B (founder 2026-11-24 "build to 90%"): email, phone / WhatsApp / SMS, marketing, customer portal (crm/b/*.js, routes/crmB*.js, routes/crmPortal.js).
 * One section per gap ID. SANDBOX ONLY: a private server on a COPY of the sandbox database; nothing real is sent (mail is captured to a file).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4xxx node scripts/crm-B-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-b-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" IN (\'crm.settings\', \'crm.b\', \'crm.website\')');
dbx.exec("DELETE FROM \"IntegrationEvent\" WHERE \"integrationId\" IN ('email', 'email-inbox', 'sms', 'crm-gmail', 'crm-outlook', 'crm-ads')");
dbx.exec("DELETE FROM \"Integration\" WHERE \"id\" IN ('email', 'email-inbox', 'sms', 'crm-gmail', 'crm-outlook', 'crm-ads')");
dbx.close();

const MAILS = path.join(os.tmpdir(), `zz-crm-b-mails-${process.pid}.jsonl`);
const PORT = Number(process.env.TEST_PORT) || 4520;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-b-test', INTEGRATION_SECRET_KEY: 'zz-crm-b-test-integration-key', TL_COMM_SEND_LIMIT: '500', TEST_MAIL_CAPTURE: MAILS, APP_BASE_URL: BASE, PUBLIC_API_URL: BASE, FRONTEND_URL: BASE, BROWSER_CALL_FAKE_STT: 'Hello sir, we need five Java developers, please send the proposal by Friday.', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { writeValues } = require('../src/utils/integrationStore');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, body, token, { raw, type } = {}) => {
  const r = await fetch(API + url, { method, redirect: 'manual', headers: { ...(raw ? { 'Content-Type': type || 'text/plain' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw != null ? raw : (body ? JSON.stringify(body) : undefined) });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
};
const pcall = async (method, url, body, token) => { const r = await fetch(`${API}/crm-portal${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CRM-Portal': token } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch { j = null; } return { status: r.status, body: j }; };
const form = (url, data) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString(), redirect: 'manual' });
const mails = () => (fs.existsSync(MAILS) ? fs.readFileSync(MAILS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastMailTo = (to) => mails().filter((m) => String(m.to || '').toLowerCase().includes(to.toLowerCase())).pop();
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const P = process.pid;
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ ${tag} ${P}`, email: `zz.crmb.${tag}.${P}@zz-crmb.in`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const setRow = async (id, fields, enabled = true) => {
  const w = await writeValues(id, fields);
  await prisma.integration.upsert({ where: { id }, create: { id, values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' }, update: { values: JSON.stringify(w.values), enabled, connected: enabled, state: enabled ? 'Connected' : 'Not Connected' } });
};
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.unlinkSync(MAILS); } catch { /* none */ } process.exit(code); }, 800);
}
const one = async (sql, ...p) => (await DB.all(sql, ...p))[0] || null;
const acts = (col, id) => DB.all(`SELECT * FROM "CrmActivity" WHERE "${col}" = ? ORDER BY "createdAt" DESC`, id);
const sw = (T, switches) => call('PUT', '/crm/b/settings', { switches }, T.X);
const mime = ({ from, to, subject, text, id, extra = '' }) => `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${id}@zz-crmb.in>\r\nDate: ${new Date().toUTCString()}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;

(async () => {
  await DB.ensure();
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const Bu = await mkUser('repB', { role: 'EMPLOYEE' });
  const V = await mkUser('viewer', { role: 'EMPLOYEE' });
  const phoneA = `9${String(P).padStart(9, '7').slice(-9)}`;
  await prisma.employee.create({ data: { employeeCode: `ZZ-CB-A-${P}`, name: A.name, userId: A.id, email: `a.work.${P}@zz-crmb.in`, phone: phoneA, designation: 'Employee', employmentStatus: 'Active', department: 'Sales' } });
  const T = { X: await tokenOf(X.id), M: await tokenOf(M.id), A: await tokenOf(A.id), B: await tokenOf(Bu.id), V: await tokenOf(V.id) };
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await wait(500); } // eslint-disable-line no-await-in-loop
  await wait(1200);
  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  const st0 = await call('PUT', '/crm/settings', { salesTeam: [{ userId: M.id, name: M.name, role: 'manager' }, { userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: Bu.id, name: Bu.name, role: 'rep', rights: own }, { userId: V.id, name: V.name, role: 'viewer' }] }, T.X);
  check('setup: the CRM sales team (manager, two reps, a viewer)', st0.status === 200, st0.body);
  await setRow('email', { 'SMTP host': 'smtp.zz-crmb.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'crm@zz-crmb.invalid', 'Default from name': 'TeamLink' });
  await wait(300);
  const leadEmail = `asha.${P}@zz-buyer.in`;
  const lead = (await call('POST', '/crm/leads', { company: `ZZ Buyer Co ${P}`, contactName: 'Asha Rao', phone: '9876500001', email: leadEmail, city: 'Hyderabad', source: 'LinkedIn' }, T.A)).body.lead;
  const leadB = (await call('POST', '/crm/leads', { company: `ZZ Other Co ${P}`, contactName: 'Ravi', phone: '9876500002', email: `ravi.${P}@zz-other.in` }, T.B)).body.lead;
  check('setup: a lead for rep A and one for rep B', lead && leadB, { lead, leadB });

  // ============================================================ settings / switches
  console.log('Settings: the wave switches are all OFF and only an Admin flips them');
  const s1 = await call('GET', '/crm/b/settings', null, T.M);
  check('every switch is off by default', s1.status === 200 && Object.values(s1.body.switches).every((v) => v === false), s1.body.switches);
  check('a manager sees the snippets / keys, cannot switch', !!s1.body.snippets && s1.body.canSwitch === false && !!s1.body.hookKey);
  check('a rep cannot switch anything on (403)', (await call('PUT', '/crm/b/settings', { switches: { mailTracking: true } }, T.A)).status === 403);
  check('a rep does not get the keys', !(await call('GET', '/crm/b/settings', null, T.A)).body.hookKey);
  const HOOK = s1.body.hookKey; const SITE = s1.body.siteId;

  // ============================================================ 06.03 templates
  console.log('06.03 templates with merge fields');
  const t1 = await call('POST', '/crm/b/templates', { name: 'Intro', channel: 'email', subject: 'Hiring help for {company}', body: 'Hi {first_name},\n\nWe help {company} in {city}.\n\n{sender}' }, T.A);
  check('rep A saves a private template', t1.status === 200 && t1.body.template.shared === 0, t1.body);
  const r1 = await call('POST', `/crm/b/templates/${t1.body.template.id}/render`, { kind: 'lead', id: lead.id }, T.A);
  check('rendered for the lead: first name, company, city and sender filled', r1.status === 200 && r1.body.subject === `Hiring help for ZZ Buyer Co ${P}` && /Hi Asha,/.test(r1.body.text) && /Hyderabad/.test(r1.body.text) && r1.body.text.includes(A.name), r1.body);
  check('rep B does not see A\'s private template', !(await call('GET', '/crm/b/templates', null, T.B)).body.templates.some((t) => t.id === t1.body.template.id));
  check('rep B cannot render it (404)', (await call('POST', `/crm/b/templates/${t1.body.template.id}/render`, { kind: 'lead', id: leadB.id }, T.B)).status === 404);
  const t2 = await call('POST', '/crm/b/templates', { name: 'Team follow-up', channel: 'whatsapp', body: 'Hello {first_name}, following up.', shared: true }, T.M);
  check('a manager shares a template with the whole team; rep B sees it', t2.status === 200 && (await call('GET', '/crm/b/templates', null, T.B)).body.templates.some((t) => t.id === t2.body.template.id && t.shared === 1));
  const t3 = await call('POST', '/crm/b/templates', { name: 'Try share', channel: 'sms', body: 'x', shared: true }, T.A);
  check('a rep asking to share gets a private one', t3.status === 200 && t3.body.template.shared === 0);
  check('the viewer cannot make templates (403)', (await call('POST', '/crm/b/templates', { name: 'v', channel: 'sms', body: 'x' }, T.V)).status === 403);

  // ============================================================ 06.10 signature
  console.log('06.10 per-person signature');
  check('rep A saves a signature', (await call('PUT', '/crm/b/signature', { text: `Asha's rep ${P}\nTeamLink Consultants\n+91 90000 00000` }, T.A)).status === 200);
  const sent1 = await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Hello', text: 'Hello Asha,\n\nShall we talk?' }, T.A);
  const m1 = lastMailTo(leadEmail);
  check('an email from the record carries the signature', sent1.status === 200 && m1 && String(m1.text).includes(`Asha's rep ${P}`), { s: sent1.status, b: sent1.body, m: m1 && m1.text });
  check('with tracking off there is no tracked HTML copy', m1 && !/crm-public\/b\/t\/o\//.test(String(m1.html || '')));

  // ============================================================ 06.04 open / click tracking
  console.log('06.04 open and click tracking');
  check('the Admin switches tracking on', (await sw(T, { mailTracking: true })).status === 200);
  await wait(3200);
  const sent2 = await call('POST', '/crm/contact/send', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Our profile', text: 'Hi Asha, see https://example.com/profile for our work.' }, T.A);
  const m2 = lastMailTo(leadEmail);
  const pixel = (/\/api\/crm-public\/b\/t\/o\/([A-Za-z0-9_-]+)\.gif/.exec(String(m2 && m2.html)) || [])[1];
  const clickPath = (/\/api\/crm-public\/b\/t\/c\/([A-Za-z0-9_-]+\/\d+)/.exec(String(m2 && m2.html)) || [])[1];
  check('the mail has an HTML copy with a 1-pixel image and the link through TeamLink, text unchanged', sent2.status === 200 && !!pixel && !!clickPath && String(m2.text).includes('https://example.com/profile'), { html: m2 && String(m2.html).slice(0, 300) });
  const px = await fetch(`${API}/crm-public/b/t/o/${pixel}.gif`);
  check('the pixel answers a GIF', px.status === 200 && /image\/gif/.test(px.headers.get('content-type') || ''));
  let line = (await acts('leadId', lead.id)).find((a) => /Our profile/.test(a.subject || ''));
  check('the timeline line of the mail says Opened', line && line.deliveryStatus === 'Opened' && /Opened 1 time/.test(line.deliveryDetail || ''), line && { s: line.deliveryStatus, d: line.deliveryDetail });
  const bot = await fetch(`${API}/crm-public/b/t/o/${pixel}.gif`, { headers: { 'User-Agent': 'Mimecast scanner bot' } });
  line = (await acts('leadId', lead.id)).find((a) => /Our profile/.test(a.subject || ''));
  check('a mail scanner opening it is not counted', bot.status === 200 && /Opened 1 time/.test(line.deliveryDetail || ''), line.deliveryDetail);
  const ck = await fetch(`${API}/crm-public/b/t/c/${clickPath}`, { redirect: 'manual' });
  check('a click goes on to the real page (302)', ck.status === 302 && ck.headers.get('location') === 'https://example.com/profile', [ck.status, ck.headers.get('location')]);
  line = (await acts('leadId', lead.id)).find((a) => /Our profile/.test(a.subject || ''));
  check('and the line says Clicked', line.deliveryStatus === 'Clicked' && /1 link click/.test(line.deliveryDetail || ''), line.deliveryDetail);
  const tr = await call('GET', `/crm/b/tracking/lead/${lead.id}`, null, T.A);
  check('the record\'s Web & engagement list shows it opened', tr.status === 200 && tr.body.mails.some((m) => m.opened && Number(m.clickCount) === 1));
  check('rep B cannot read the tracking of A\'s lead', (await call('GET', `/crm/b/tracking/lead/${lead.id}`, null, T.B)).status === 404);
  check('an unknown link id is refused, not redirected', (await fetch(`${API}/crm-public/b/t/c/nope/0`, { redirect: 'manual' })).status === 404);

  // ============================================================ 06.06 send later
  console.log('06.06 send later');
  const sl0 = await call('POST', '/crm/b/schedule', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Later', text: 'x', sendAt: new Date(Date.now() + 3600e3).toISOString() }, T.A);
  check('off by default: refused with the reason (409)', sl0.status === 409 && sl0.body.switchOff);
  await sw(T, { sendLater: true }); await wait(3200);
  check('a time in the past is refused', (await call('POST', '/crm/b/schedule', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Later', text: 'x', sendAt: new Date(Date.now() - 60e3).toISOString() }, T.A)).status === 400);
  check('rep B cannot schedule on A\'s lead', (await call('POST', '/crm/b/schedule', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Later', text: 'x', sendAt: new Date(Date.now() + 3600e3).toISOString() }, T.B)).status === 404);
  const sl1 = await call('POST', '/crm/b/schedule', { kind: 'lead', id: lead.id, channel: 'Email', subject: `Scheduled hello ${P}`, text: 'Hi, this went later.', sendAt: new Date(Date.now() + 2 * 3600e3).toISOString() }, T.A);
  check('rep A schedules an email in two hours', sl1.status === 200, sl1.body);
  const sl2 = await call('POST', '/crm/b/schedule', { kind: 'lead', id: lead.id, channel: 'Email', subject: 'Cancel me', text: 'x', sendAt: new Date(Date.now() + 2 * 3600e3).toISOString() }, T.A);
  check('rep B cannot cancel A\'s scheduled mail', (await call('POST', `/crm/b/scheduled/${sl2.body.id}/cancel`, null, T.B)).status === 404);
  check('rep A cancels one', (await call('POST', `/crm/b/scheduled/${sl2.body.id}/cancel`, null, T.A)).status === 200);
  let run = await call('POST', '/crm/b/run/queue', null, T.X);
  check('before its time nothing goes', run.status === 200 && run.body.result.sent === 0 && !lastMailTo(leadEmail).subject.includes('Scheduled hello'), run.body);
  await DB.run('UPDATE "CrmMailQueue" SET "sendAt" = ? WHERE "id" = ?', new Date(Date.now() - 1000).toISOString(), sl1.body.id);
  run = await call('POST', '/crm/b/run/queue', null, T.X);
  const q1 = await one('SELECT * FROM "CrmMailQueue" WHERE "id" = ?', sl1.body.id);
  check('at its time it is sent, as rep A, and marked Sent', run.body.result.sent === 1 && q1.status === 'Sent' && lastMailTo(leadEmail).subject === `Scheduled hello ${P}`, { r: run.body, q: q1 && q1.status, res: q1 && q1.result });
  check('a rep cannot run the job by hand', (await call('POST', '/crm/b/run/queue', null, T.A)).status === 403);
  const camp = await call('POST', '/crm/campaigns', { name: `ZZ camp ${P}`, channel: 'email', subject: 'News for {company}', body: 'Hi {first_name}, news.', audience: { kind: 'leads', status: 'open', owner: A.id } }, T.M);
  const cs = await call('POST', '/crm/b/schedule', { campaignId: camp.body.campaign && camp.body.campaign.id, sendAt: new Date(Date.now() + 3600e3).toISOString() }, T.M);
  check('a manager schedules a whole campaign: it shows Scheduled', camp.status === 200 && cs.status === 200 && (await one('SELECT "status" FROM "CrmCampaign" WHERE "id" = ?', camp.body.campaign.id)).status === 'Scheduled', [camp.body, cs.body]);
  await DB.run('UPDATE "CrmMailQueue" SET "sendAt" = ? WHERE "id" = ?', new Date(Date.now() - 1000).toISOString(), cs.body.id);
  await call('POST', '/crm/b/run/queue', null, T.X);
  await wait(1500);
  const cRow = await one('SELECT "status", "sent" FROM "CrmCampaign" WHERE "id" = ?', camp.body.campaign.id);
  check('at its time the campaign is sent', ['Sending', 'Sent'].includes(cRow.status), cRow);

  // ============================================================ 06.02 / 06.08 / 06.09 / 06.12 mail read from the mailboxes
  console.log('06.02 / 06.08 / 06.09 / 06.12 mailbox reading (webhook + IMAP + Gmail stub)');
  const inbound = (raw, q = '') => call('POST', `/crm-public/b/mail/inbound?key=${HOOK}${q}`, null, null, { raw });
  check('a wrong key is refused (401)', (await call('POST', '/crm-public/b/mail/inbound?key=nope', null, null, { raw: 'x' })).status === 401);
  const off = await inbound(mime({ from: leadEmail, to: 'sales@zz-crmb.in', subject: 'Re: hello', text: 'Yes', id: `off-${P}` }));
  check('with "Read the connected mailboxes" off nothing is read', off.status === 200 && off.body.off === true);
  await call('PUT', '/crm/b/settings', { bccAddress: 'crm-log@zz-crmb.in', teamMailbox: `sales.${P}@zz-crmb.in` }, T.M);
  await sw(T, { mailSync: true }); await wait(3200);
  const rep1 = await inbound(mime({ from: `Asha Rao <${leadEmail}>`, to: 'a@zz.in', subject: 'Re: Our profile', text: 'Yes, call me tomorrow at 11.', id: `rep-${P}` }));
  check('06.02 a customer reply is written on their lead ("Replied on Email")', rep1.body.result === 'logged reply' && (await acts('leadId', lead.id)).some((a) => /^Replied on Email: Re: Our profile/.test(a.subject || '') && /tomorrow at 11/.test(a.note || '')), rep1.body);
  const again = await inbound(mime({ from: leadEmail, to: 'a@zz.in', subject: 'Re: Our profile', text: 'Yes', id: `rep-${P}` }));
  check('the same mail twice is read once', again.body.result === 'already read');
  const bcc = await inbound(mime({ from: `a.work.${P}@zz-crmb.in`, to: leadEmail, subject: `Quote from Gmail ${P}`, text: 'Please find our quote.', id: `bcc-${P}`, extra: 'Bcc: crm-log@zz-crmb.in\r\n' }));
  check('06.08 mail rep A sent from outside TeamLink (BCC to the CRM address) is logged on the lead as sent by A', bcc.body.result === 'logged outgoing' && (await acts('leadId', lead.id)).some((a) => a.subject === `Email sent: Quote from Gmail ${P}` && a.byId === A.id && /logged/.test(a.byName || '')), bcc.body);
  const tm = await inbound(mime({ from: `New Person <new.${P}@zz-unknown.in>`, to: `sales.${P}@zz-crmb.in`, subject: `Need 10 nurses ${P}`, text: 'Can you help us hire 10 nurses?', id: `tm-${P}` }), '&team=1');
  check('06.09 customer mail to the team mailbox from somebody new is a team-inbox card', tm.body.result === 'team inbox', tm.body);
  const tmList = await call('GET', '/crm/b/team-mail', null, T.B);
  const card = tmList.body.rows.find((x) => x.subject === `Need 10 nurses ${P}`);
  check('every rep sees the unassigned card', !!card && tmList.body.counts.unassigned >= 1, tmList.body);
  check('a rep cannot give it to somebody else (403)', (await call('POST', `/crm/b/team-mail/${card.id}`, { action: 'assign', assigneeId: A.id }, T.B)).status === 403);
  check('rep B takes it', (await call('POST', `/crm/b/team-mail/${card.id}`, { action: 'assign' }, T.B)).status === 200);
  check('now rep A no longer sees it (it is B\'s)', !(await call('GET', '/crm/b/team-mail', null, T.A)).body.rows.some((x) => x.id === card.id));
  const tmr = await call('POST', `/crm/b/team-mail/${card.id}`, { action: 'reply', text: 'Yes, we can. Let us talk.' }, T.B);
  check('rep B replies: the mail goes to the sender with "Re:" and B\'s name', tmr.status === 200 && /^Re: Need 10 nurses/.test((lastMailTo(`new.${P}@zz-unknown.in`) || {}).subject || ''), tmr.body);
  check('and marks it done', (await call('POST', `/crm/b/team-mail/${card.id}`, { action: 'done' }, T.B)).status === 200 && (await one('SELECT "status" FROM "CrmTeamMail" WHERE "id" = ?', card.id)).status === 'Done');
  check('the viewer cannot act on team mail', (await call('POST', `/crm/b/team-mail/${card.id}`, { action: 'reopen' }, T.V)).status === 403);
  const dsn = `From: Mail Delivery Subsystem <mailer-daemon@zz-mx.in>\r\nTo: crm@zz-crmb.invalid\r\nSubject: Undelivered Mail Returned to Sender\r\nMessage-ID: <dsn-${P}@zz-mx.in>\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b1"\r\n\r\n--b1\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; ${leadB.email}\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 User unknown\r\n--b1--\r\n`;
  const b1 = await inbound(dsn);
  check('06.12 a bounce report: hard bounce recorded, the address goes on the suppression list', b1.body.result === 'bounce hard' && !!(await one('SELECT 1 AS x FROM "CrmOptOut" WHERE "value" = ? AND "channel" = \'email\'', leadB.email)), b1.body);
  check('and the bounce is on the lead\'s timeline', (await acts('leadId', leadB.id)).some((a) => /^Email bounced/.test(a.subject || '')));
  check('nothing is mailed to a bounced address again', (await call('POST', '/crm/contact/send', { kind: 'lead', id: leadB.id, channel: 'Email', subject: 'x', text: 'x' }, T.B)).status === 409);
  const sb = await call('POST', `/crm-public/b/mail/bounce?key=${HOOK}`, [{ email: `soft.${P}@zz-x.in`, type: 'soft' }, { email: `soft.${P}@zz-x.in`, type: 'soft' }, { email: `soft.${P}@zz-x.in`, type: 'soft' }]);
  check('the provider bounce webhook: three soft bounces in 30 days suppress the address', sb.status === 200 && sb.body.recorded === 3 && !!(await one('SELECT 1 AS x FROM "CrmOptOut" WHERE "value" = ?', `soft.${P}@zz-x.in`)), sb.body);
  const bl = await call('GET', '/crm/b/bounces', null, T.M);
  check('a manager sees the bounces and the suppression list; a rep cannot', bl.status === 200 && bl.body.bounces.length >= 4 && (await call('GET', '/crm/b/bounces', null, T.A)).status === 403);
  check('a manager can take an address off the list', (await call('POST', '/crm/b/bounces/unsuppress', { email: `soft.${P}@zz-x.in` }, T.M)).body.removed === 1);
  // the shared IMAP inbox + Gmail through OAuth, run in this process with a stand-in mailbox / Google
  const MAIL = require('../src/crm/b/mail');
  await setRow('email-inbox', { 'IMAP host': 'imap.zz-crmb.invalid', Port: '993', 'Mailbox address': `sales.${P}@zz-crmb.in`, 'Password / app key': 'zz' });
  const fakeImap = { fetchNew: async () => ({ messages: [{ uid: 7, raw: mime({ from: leadEmail, to: `sales.${P}@zz-crmb.in`, subject: `IMAP note ${P}`, text: 'From the shared inbox.', id: `imap-${P}` }) }], maxUid: 7 }) };
  const si = await MAIL.syncImap({ transport: fakeImap });
  check('06.02 the shared IMAP inbox is read: the mail lands on the lead (and on the team inbox, as it went to sales@)', si.mailboxes >= 1 && si.read === 1 && (await acts('leadId', lead.id)).some((a) => a.subject === `Replied on Email: IMAP note ${P}`) && !!(await one('SELECT 1 AS x FROM "CrmTeamMail" WHERE "subject" = ?', `IMAP note ${P}`)), si);
  check('the IMAP checkpoint is kept (read once)', JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'crm.b.ckpt.shared' } })).value).uid === 7);
  await setRow('crm-gmail', { 'Client ID': 'zz.apps.googleusercontent.com', 'Client secret': 'zz-secret' });
  const cu = await call('GET', '/crm/b/mail/connect/gmail', null, T.A);
  check('Gmail: with the OAuth client typed, "Connect" gives the Google sign-in address with a signed state', cu.status === 200 && /accounts\.google\.com/.test(cu.body.url) && /gmail\.readonly/.test(decodeURIComponent(cu.body.url)), cu.body);
  check('Outlook without its client says what is missing (409)', (await call('GET', '/crm/b/mail/connect/outlook', null, T.A)).status === 409);
  const state = new URL(cu.body.url).searchParams.get('state');
  const idTok = `x.${Buffer.from(JSON.stringify({ email: `a.gmail.${P}@gmail.com` })).toString('base64url')}.y`;
  const rawGmail = mime({ from: `Asha <${leadEmail}>`, to: `a.gmail.${P}@gmail.com`, subject: `From Gmail ${P}`, text: 'Sent to your Gmail.', id: `gm-${P}` });
  MAIL.setFetch(async (url) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (/oauth2\.googleapis\.com\/token/.test(url)) return ok({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: idTok });
    if (/users\/me\/messages\?/.test(url)) return ok({ messages: [{ id: 'g1' }] });
    if (/users\/me\/messages\/g1/.test(url)) return ok({ raw: Buffer.from(rawGmail).toString('base64url') });
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const cb = await MAIL.oauthCallback('gmail', { code: 'c1', state });
  check('the Google sign-in comes back: the account is kept (refresh token encrypted)', cb.ok && cb.email === `a.gmail.${P}@gmail.com` && !!(await one('SELECT 1 AS x FROM "CrmMailAccount" WHERE "userId" = ? AND "refreshEnc" IS NOT NULL AND "refreshEnc" != ?', A.id, 'rt-1')), cb);
  check('a tampered state is refused', !!(await MAIL.oauthCallback('gmail', { code: 'c1', state: `${state}x` })).error);
  const so = await MAIL.syncOAuth();
  check('06.02 the Gmail mailbox is read: the customer mail lands on the lead', so.accounts === 1 && so.read === 1 && (await acts('leadId', lead.id)).some((a) => a.subject === `Replied on Email: From Gmail ${P}`), so);
  check('read again: nothing new (each message once)', (await MAIL.syncOAuth()).read === 0);
  const ma = await call('GET', '/crm/b/mail/accounts', null, T.A);
  check('rep A sees the Gmail account connected', ma.status === 200 && ma.body.providers.gmail.account && ma.body.providers.gmail.account.email === `a.gmail.${P}@gmail.com`, ma.body);

  // ============================================================ 06.11 documents opened
  console.log('06.11 documents the customer opened');
  const acc = (await call('POST', '/crm/accounts', { name: `ZZ Portal Co ${P}`, email: `office.${P}@zz-portal.in` }, T.A)).body.account;
  const contact = (await call('POST', '/crm/contacts', { accountId: acc.id, name: 'Meena Iyer', email: `meena.${P}@zz-portal.in`, phone: '9876500003', role: 'Decision maker' }, T.A)).body.contact;
  const deal = (await call('POST', '/crm/deals', { title: `ZZ Portal deal ${P}`, accountId: acc.id, contactId: contact.id, value: '120000' }, T.A)).body.deal;
  const prop = (await call('POST', `/crm/deals/${deal.id}/proposals`, { roles: [{ title: 'Java developer', openings: 2, ctc: 600000 }], feePercent: 8.33, company: acc.name, toName: 'Meena', toEmail: contact.email, fromName: 'A' }, T.A)).body.proposal;
  const ps = await call('POST', `/crm/proposals/${prop.id}/send`, { to: contact.email, message: 'Please see.' }, T.A);
  const pm = lastMailTo(contact.email);
  const ptoken = (/\/api\/crm-public\/proposal\/([A-Za-z0-9_.-]+)/.exec(String(pm && pm.text)) || [])[1];
  check('setup: a proposal emailed with its answer link', ps.status === 200 && !!ptoken, { s: ps.status, b: ps.body });
  await fetch(`${API}/crm-public/proposal/${ptoken}`);
  await fetch(`${API}/crm-public/proposal/${ptoken}/pdf`);
  const dv = await call('GET', `/crm/b/deals/${deal.id}/doc-views`, null, T.A);
  check('the customer opening the proposal page and the PDF is counted on the deal', dv.status === 200 && dv.body.docs.reduce((s, d) => s + Number(d.views), 0) >= 2, dv.body);
  check('and written once on the deal\'s timeline', (await acts('dealId', deal.id)).filter((a) => /^The customer opened the proposal/.test(a.subject || '')).length === 1);
  check('rep B cannot read A\'s deal views', (await call('GET', `/crm/b/deals/${deal.id}/doc-views`, null, T.B)).status === 404);
  const fd = new FormData(); fd.append('kind', 'Quotation'); fd.append('file', new Blob([Buffer.from('%PDF-1.4 zz quote')], { type: 'application/pdf' }), 'quote.pdf');
  const up = await fetch(`${API}/crm/deals/${deal.id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${T.A}` }, body: fd }).then((r) => r.json());
  const fileId = up.file && up.file.id;
  const sh = fileId ? await call('POST', `/crm/b/deal-files/${fileId}/share`, null, T.A) : { status: 0 };
  check('a deal file gets a share link that expires', sh.status === 200 && /\/api\/crm-public\/b\/file\//.test(sh.body.url), [up, sh.body]);
  if (sh.status === 200) {
    const fget = await fetch(sh.body.url);
    check('the customer opens it (no login) and it is counted on the deal', fget.status === 200 && (await call('GET', `/crm/b/deals/${deal.id}/doc-views`, null, T.A)).body.docs.some((d) => d.docKind === 'file'));
  }
  check('rep B cannot share A\'s deal file', !fileId || (await call('POST', `/crm/b/deal-files/${fileId}/share`, null, T.B)).status === 404);

  // ============================================================ 07.01 / 07.02 / 07.03 / 07.05 office-line calls
  console.log('07.01 / 07.02 / 07.03 / 07.05 calls from the browser on the office lines');
  const CFG = require('../src/browsercall/config');
  const BCS = require('../src/browsercall/schema');
  check('browser calling Off: the CRM says so', (await call('GET', '/crm/b/calls/status', null, T.X)).body.canCall === false);
  await CFG.save({ mode: 'Test', testNumbers: '9876500061' });
  const cst = await call('GET', '/crm/b/calls/status', null, T.X);
  check('Test mode: the Admin may call on the office line', cst.body.canCall === true && cst.body.testMode && cst.body.lines.length >= 1, cst.body);
  check('a salesperson whose role is not allowed on the lines is told why', (await call('GET', '/crm/b/calls/status', null, T.A)).body.canCall === false);
  await BCS.run('INSERT OR IGNORE INTO "BrowserCallExtension" ("id","userId","extension","secretEnc","active","createdAt") VALUES (?,?,?,?,1,?)', `ext-${P}`, X.id, `79${String(P).slice(-3)}`, 'x', new Date().toISOString());
  const xLead = (await call('POST', '/crm/leads', { company: `ZZ Call Co ${P}`, contactName: 'Kiran', phone: '9876500061', email: `kiran.${P}@zz-call.in` }, T.X)).body.lead;
  check('a number not on the test list is refused in Test mode', (await call('POST', '/crm/b/calls', { kind: 'lead', id: xLead.id, to: '9876500099' }, T.X)).status === 403);
  const pc = await call('POST', '/crm/b/calls', { kind: 'lead', id: xLead.id }, T.X);
  check('07.01 a call placed: a token for the softphone, the row kept as crm:lead:<id>', pc.status === 200 && !!pc.body.token && pc.body.candidate.id === `crm:lead:${xLead.id}`, pc.body);
  check('one call at a time', (await call('POST', '/crm/b/calls', { kind: 'lead', id: xLead.id }, T.X)).status === 409);
  check('rep A cannot call on the Admin\'s lead', (await call('POST', '/crm/b/calls', { kind: 'lead', id: xLead.id }, T.A)).status === 404);
  let cl = (await acts('leadId', xLead.id)).find((a) => a.providerRef === `bc:${pc.body.callId}`);
  check('the timeline line says Calling', cl && cl.deliveryStatus === 'Calling');
  const now = new Date();
  await BCS.run('UPDATE "BrowserCall" SET "status" = \'completed\', "answerAt" = ?, "endAt" = ?, "talkSec" = 75, "recordingStatus" = \'done\', "recordingPath" = ?, "transcript" = ?, "transcriptSource" = \'Test transcriber\', "summaryText" = ?, "processedAt" = ? WHERE "id" = ?', new Date(now - 80000).toISOString(), now.toISOString(), 'zz-missing.mp3', 'Hello sir, we need five Java developers.', 'Discussed: five Java developers. Next step: send the proposal.', now.toISOString(), pc.body.callId);
  await call('POST', '/crm/b/run/calls', null, T.X);
  cl = (await acts('leadId', xLead.id)).find((a) => a.providerRef === `bc:${pc.body.callId}`);
  check('07.03 when the call ends the result is written by itself: answered, talk time, the line', cl.deliveryStatus === 'Done' && /Answered · talk 1:15/.test(cl.note || ''), cl && cl.note);
  check('07.02 / 07.05 and that it was recorded and what was said', /Recording kept/.test(cl.note || '') && /five Java developers/.test(cl.note || ''));
  const co = await call('GET', `/crm/b/calls/of/lead/${xLead.id}`, null, T.X);
  check('the record lists the call with its recording and transcript', co.status === 200 && co.body.calls[0].hasRecording && co.body.calls[0].hasTranscript, co.body);
  const tsc = await call('GET', `/crm/b/calls/${pc.body.callId}/transcript`, null, T.X);
  check('the transcript can be read', tsc.status === 200 && /five Java developers/.test(tsc.body.transcript));
  check('a rep who cannot see the lead cannot read it (404)', (await call('GET', `/crm/b/calls/${pc.body.callId}/transcript`, null, T.B)).status === 404);
  check('a missing recording file says so (404)', (await call('GET', `/crm/b/calls/${pc.body.callId}/recording`, null, T.X)).status === 404);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(200)]);
  const upw = await fetch(`${API}/crm/b/calls/upload?kind=lead&id=${lead.id}&name=my-call.wav`, { method: 'POST', headers: { Authorization: `Bearer ${T.A}`, 'Content-Type': 'application/octet-stream' }, body: wav }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check('07.05 a call made from the rep\'s own phone: its recording uploaded is transcribed onto the timeline', upw.status === 200 && /five Java developers/.test(upw.body.transcript) && (await acts('leadId', lead.id)).some((a) => /^Call recording transcribed/.test(a.subject || '')), upw.body);
  check('rep B cannot upload to A\'s lead', (await fetch(`${API}/crm/b/calls/upload?kind=lead&id=${lead.id}`, { method: 'POST', headers: { Authorization: `Bearer ${T.B}`, 'Content-Type': 'application/octet-stream' }, body: wav })).status === 404);
  await CFG.save({ mode: 'Off' });

  // ============================================================ 07.04 power dialer
  console.log('07.04 power dialer');
  const l2 = (await call('POST', '/crm/leads', { company: `ZZ Dial Two ${P}`, contactName: 'Two', phone: '9876500011' }, T.A)).body.lead;
  const l3 = (await call('POST', '/crm/leads', { company: `ZZ Dial Three ${P}`, contactName: 'Three' }, T.A)).body.lead;
  const dl = await call('POST', '/crm/b/dial-lists', { source: 'leads', ids: [lead.id, l2.id, l3.id, leadB.id] }, T.A);
  check('a call list of picked leads: only A\'s own leads with a phone (3 of 4 asked)', dl.status === 200 && dl.body.total === 2, dl.body);
  let dd = await call('GET', `/crm/b/dial-lists/${dl.body.id}`, null, T.A);
  check('the first person is up next', dd.body.next && dd.body.next.recordId === lead.id, dd.body.next);
  const o1 = await call('POST', `/crm/b/dial-items/${dd.body.next.id}`, { outcome: 'Spoke', note: 'wants a quote', followUpDate: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) }, T.A);
  check('what came of the call is saved on the lead and the next person comes up', o1.status === 200 && o1.body.next && o1.body.next.recordId === l2.id && (await acts('leadId', lead.id)).some((a) => a.subject === 'Call (dialer): Spoke'), o1.body);
  check('rep B cannot work A\'s list', (await call('POST', `/crm/b/dial-items/${o1.body.next.id}`, { skip: true }, T.B)).status === 404);
  const o2 = await call('POST', `/crm/b/dial-items/${o1.body.next.id}`, { skip: true }, T.A);
  dd = await call('GET', `/crm/b/dial-lists/${dl.body.id}`, null, T.A);
  check('skipping the last one finishes the list', o2.status === 200 && !o2.body.next && dd.body.list.status === 'Done' && dd.body.list.done === 2, dd.body.list);
  check('a list of follow-ups due today works too', (await call('POST', '/crm/b/dial-lists', { source: 'followups' }, T.A)).status !== 500);

  // ============================================================ 07.08 SMS
  console.log('07.08 SMS from the record');
  const sr = await call('GET', '/crm/b/sms/ready', null, T.A);
  check('with no SMS gateway it says so', sr.status === 200 && sr.body.ready === false && !!sr.body.reason);
  const s0 = await call('POST', '/crm/b/sms', { kind: 'lead', id: lead.id, text: 'Hello from TeamLink' }, T.A);
  check('sending then says SMS is not connected (409)', s0.status === 409 && s0.body.notConfigured, s0.body);
  const CAT = require('../src/utils/adminCatalog');
  await setRow('sms', { [CAT.SMS_FIELDS.provider]: 'MSG91', [CAT.SMS_FIELDS.sender]: 'TMLINK', [CAT.SMS_FIELDS.key]: 'zz-key', [CAT.SMS_FIELDS.bulkTpl]: 'zzflow' });
  const s1b = await call('POST', '/crm/b/sms', { kind: 'lead', id: lead.id, text: 'Hello from TeamLink' }, T.A);
  check('with a gateway connected the SMS goes (test server: not really) and is on the timeline', s1b.status === 200 && (await acts('leadId', lead.id)).some((a) => a.subject === 'SMS sent' && /Hello from TeamLink/.test(a.note || '')), s1b.body);
  await call('POST', '/crm/opt-out', { channel: 'whatsapp', value: '9876500011' }, T.A);
  check('a number that opted out is not messaged (409)', (await call('POST', '/crm/b/sms', { kind: 'lead', id: l2.id, text: 'x' }, T.A)).status === 409);
  check('the viewer cannot send', (await call('POST', '/crm/b/sms', { kind: 'lead', id: lead.id, text: 'x' }, T.V)).status === 404);

  // ============================================================ 07.09 incoming calls
  console.log('07.09 incoming call routing');
  const route = (from, q = '') => fetch(`${API}/crm-public/b/call/route?key=${HOOK}&CallFrom=0${from}&CallSid=sid-${P}-${from}${q}`).then(async (r) => ({ status: r.status, text: await r.text() }));
  check('a wrong key is refused', (await fetch(`${API}/crm-public/b/call/route?key=nope&CallFrom=09876500001`)).status === 401);
  check('switched off: nothing (Exotel uses its own fallback)', (await route('9876500001')).text === '');
  await sw(T, { inboundRouting: true }); await wait(3200);
  const rt = await route(lead.phone.replace(/\D/g, '').slice(-10));
  check('a call from rep A\'s lead is put through to A\'s phone', rt.status === 200 && rt.text === `0${phoneA}`, rt);
  check('the call is on the lead\'s timeline, and A gets a bell', (await acts('leadId', lead.id)).some((a) => /^Incoming call from/.test(a.subject || '')) && !!(await prisma.notification.findFirst({ where: { userId: A.id, title: { contains: 'is calling' } } })));
  const rj = await fetch(`${API}/crm-public/b/call/route?key=${HOOK}&CallFrom=09000011111&format=json`).then((r) => r.json());
  check('an unknown caller goes to the company line', rj.action === 'default');

  // ============================================================ 07.10 website chat
  console.log('07.10 the website chat bubble');
  const js0 = await fetch(`${API}/crm-public/b/w/chat.js?k=wrong`).then((r) => r.text());
  const js1r = await fetch(`${API}/crm-public/b/w/chat.js?k=${SITE}`);
  const js1 = await js1r.text();
  check('the bubble script is served only for the right site id, with open CORS', /unknown site/.test(js0) && /__tlChat/.test(js1) && js1r.headers.get('access-control-allow-origin') === '*');
  const cOff = await call('POST', '/crm-public/b/w/chat/start', { k: SITE, name: 'Visitor', message: 'Hi' });
  check('switched off: the visitor is told chat is offline', cOff.status === 200 && cOff.body.offline === true);
  await sw(T, { chatWidget: true }); await wait(3200);
  const cs1 = await call('POST', '/crm-public/b/w/chat/start', { k: SITE, visitorId: `vchat${P}`, name: 'Neha', email: `neha.${P}@zz-web.in`, message: 'Do you hire for hospitals?', pageUrl: 'https://teamlink.example/services' });
  check('a visitor starts a chat; giving an email makes a lead (source Website)', cs1.status === 200 && !!cs1.body.chatId && !!(await one('SELECT 1 AS x FROM "CrmLead" WHERE "email" = ? AND "source" = \'Website\'', `neha.${P}@zz-web.in`)), cs1.body);
  check('a wrong site id is refused', (await call('POST', '/crm-public/b/w/chat/start', { k: 'x', message: 'Hi' })).status === 401);
  const chats = await call('GET', '/crm/b/chats', null, T.M);
  const ch = chats.body.chats.find((c) => c.id === cs1.body.chatId);
  check('the team sees the open chat with an unread message (no secret token sent)', !!ch && Number(ch.unread) === 1 && ch.token === undefined, chats.body);
  check('a manager answers', (await call('POST', `/crm/b/chats/${ch.id}`, { action: 'reply', body: 'Yes, we do. May I call you?' }, T.M)).status === 200);
  const vr = await call('GET', `/crm-public/b/w/chat/${ch.id}?token=${encodeURIComponent(cs1.body.token)}&since=1970`);
  check('the visitor reads the answer (with the right token only)', vr.status === 200 && vr.body.messages.some((m) => m.side === 'agent' && /May I call you/.test(m.body)) && (await call('GET', `/crm-public/b/w/chat/${ch.id}?token=bad`)).status === 404);
  check('the visitor writes again', (await call('POST', `/crm-public/b/w/chat/${ch.id}/msg`, { token: cs1.body.token, body: 'Yes, 98765 00021' })).status === 200);
  check('the chat is the manager\'s now: a rep cannot open it', (await call('GET', `/crm/b/chats/${ch.id}`, null, T.A)).status === 404);
  check('closed: the conversation is kept on the lead\'s timeline', (await call('POST', `/crm/b/chats/${ch.id}`, { action: 'close' }, T.M)).status === 200 && !!(await one('SELECT 1 AS x FROM "CrmActivity" WHERE "leadId" = (SELECT "id" FROM "CrmLead" WHERE "email" = ?) AND "subject" = \'Website chat\' AND "note" LIKE \'%98765 00021%\'', `neha.${P}@zz-web.in`)));

  // ============================================================ 07.11 one inbox
  console.log('07.11 one inbox across all leads');
  const ib = await call('GET', '/crm/b/inbox', null, T.A);
  const th = ib.body.threads && ib.body.threads.find((t) => t.kind === 'lead' && t.id === lead.id);
  check('rep A\'s inbox has the lead\'s thread with every channel', ib.status === 200 && th && th.channels.includes('Email') && th.channels.includes('SMS') && th.channels.includes('Call'), th);
  check('rep A does not see rep B\'s leads', !ib.body.threads.some((t) => t.id === leadB.id));
  const ibw = await call('GET', '/crm/b/inbox?waiting=1', null, T.M);
  check('"waiting for our reply" lists the threads whose last message came from the customer', ibw.status === 200 && ibw.body.threads.every((t) => t.waiting), ibw.body.counts);
  check('the manager sees everybody\'s threads', (await call('GET', '/crm/b/inbox', null, T.M)).body.threads.some((t) => t.id === leadB.id));

  // ============================================================ 13.02 segments
  console.log('13.02 segments');
  const seg = await call('POST', '/crm/b/segments', { name: `Hyderabad ${P}`, audience: 'leads', filters: { city: 'Hyderabad', hasEmail: true } }, T.M);
  check('a manager saves a segment; it counts the people today', seg.status === 200 && seg.body.count >= 1, seg.body);
  const cp = await call('POST', '/crm/campaigns/preview', { channel: 'email', audience: { segmentId: seg.body.id } }, T.M);
  check('a campaign whose audience is the segment counts the same people', cp.status === 200 && cp.body.total === seg.body.count, cp.body);
  await call('POST', '/crm/leads', { company: `ZZ Hyd New ${P}`, contactName: 'New', email: `hyd.${P}@zz-new.in`, city: 'Hyderabad' }, T.M);
  const sp2 = await call('POST', '/crm/b/segments/preview', { id: seg.body.id }, T.M);
  check('a new lead that fits is in the segment by itself (self-updating)', sp2.body.count === seg.body.count + 1, sp2.body);
  const spA = await call('POST', '/crm/b/segments/preview', { id: seg.body.id }, T.A);
  check('a rep counting the same segment sees only their own leads', spA.body.count < sp2.body.count, spA.body);
  check('the viewer cannot make a segment', (await call('POST', '/crm/b/segments', { name: 'v', filters: {} }, T.V)).status === 403);

  // ============================================================ 13.03 landing pages
  console.log('13.03 landing pages and web forms');
  check('a rep cannot make a landing page (403)', (await call('POST', '/crm/b/landings', { title: 'x' }, T.A)).status === 403);
  const lp = await call('POST', '/crm/b/landings', { title: `Hire nurses ${P}`, headline: 'Nurses in 7 days', body: 'We hire for hospitals.', fields: ['name', 'company', 'phone', 'email', 'message'], campaign: `nurses-${P}`, status: 'Live' }, T.M);
  check('a manager makes a live landing page', lp.status === 200 && !!lp.body.slug, lp.body);
  const lpg = await fetch(`${API}/crm-public/b/p/${lp.body.slug}`);
  const lph = await lpg.text();
  check('the page opens with no login: the headline and the form', lpg.status === 200 && lph.includes('Nurses in 7 days') && /<form method="post"/.test(lph));
  const lps = await form(`/api/crm-public/b/p/${lp.body.slug}?utm_source=google`, { name: 'Dr Rao', company: `ZZ Hospital ${P}`, phone: '9876500031', email: `rao.${P}@zz-hosp.in`, message: 'Need 10 nurses' });
  const lpl = await one('SELECT * FROM "CrmLead" WHERE "email" = ?', `rao.${P}@zz-hosp.in`);
  check('a sent form is a lead with the page as its campaign', lps.status === 200 && lpl && lpl.utmCampaign === `nurses-${P}` && lpl.utmSource === 'google', lpl);
  const lrow = await one('SELECT "views", "submits" FROM "CrmLanding" WHERE "id" = ?', lp.body.id);
  check('views and forms sent are counted', Number(lrow.views) >= 1 && Number(lrow.submits) === 1, lrow);
  check('a robot filling the hidden field makes nothing', (await form(`/api/crm-public/b/p/${lp.body.slug}`, { name: 'bot', email: `bot.${P}@x.in`, website_url: 'http://spam' })).status === 200 && !(await one('SELECT 1 AS x FROM "CrmLead" WHERE "email" = ?', `bot.${P}@x.in`)));
  check('a Draft page is not shown', (await call('PUT', `/crm/b/landings/${lp.body.id}`, { title: `Hire nurses ${P}`, slug: lp.body.slug, fields: ['name', 'email'], status: 'Draft' }, T.M)).status === 200 && (await fetch(`${API}/crm-public/b/p/${lp.body.slug}`)).status === 404);

  // ============================================================ 13.04 campaign ROI
  console.log('13.04 campaign results and ROI');
  const roiC = camp.body.campaign.id;
  check('a manager sets the cost and code of a campaign', (await call('PUT', `/crm/b/campaign-meta/${roiC}`, { cost: 1000, code: `camp-${P}` }, T.M)).status === 200);
  check('a rep cannot', (await call('PUT', `/crm/b/campaign-meta/${roiC}`, { cost: 1 }, T.A)).status === 403);
  const roiLead = (await call('POST', '/crm/leads', { company: `ZZ ROI Co ${P}`, contactName: 'Roi', email: `roi.${P}@zz-roi.in` }, T.M)).body.lead;
  await DB.run('UPDATE "CrmLead" SET "utmCampaign" = ? WHERE "id" = ?', `camp-${P}`, roiLead.id);
  const conv = await call('POST', `/crm/leads/${roiLead.id}/convert`, { dealTitle: `ZZ ROI deal ${P}`, value: 5000, createDeal: true }, T.M);
  const roiDeal = conv.body && conv.body.deal;
  if (roiDeal) await DB.run('UPDATE "CrmDeal" SET "stage" = \'Won\', "wonAt" = ?, "value" = 5000, "finalValue" = 5000 WHERE "id" = ?', new Date().toISOString(), roiDeal.id);
  const roi = await call('GET', '/crm/b/roi', null, T.M);
  const rc = roi.body.campaigns.find((c) => c.id === roiC);
  check('the campaign shows the lead it brought, the deal won and the return on its cost', rc && rc.leads >= 1 && rc.wonDeals === 1 && rc.wonValue === 5000 && rc.roiPercent === 400, { rc, conv: conv.status });

  // ============================================================ 13.05 social
  console.log('13.05 social media');
  check('a rep cannot write company posts', (await call('POST', '/crm/b/social', { channel: 'facebook', text: 'x' }, T.A)).status === 403);
  const sp = await call('POST', '/crm/b/social', { channel: 'facebook', text: `We are hiring nurses ${P}`, link: 'https://teamlink.example/nurses' }, T.M);
  check('a manager saves a draft post', sp.status === 200, sp.body);
  const pn = await call('POST', `/crm/b/social/${sp.body.id}/post`, null, T.M);
  check('"Post now" on the test server: marked posted, nothing really goes out', pn.status === 200 && pn.body.sandbox === true && (await one('SELECT "status" FROM "CrmSocialPost" WHERE "id" = ?', sp.body.id)).status === 'Posted', pn.body);
  check('a scheduled post waits while "Social posts" is off', (await call('POST', '/crm/b/run/social', null, T.X)).body.result.off === true);
  check('social profile links are kept on a lead', (await call('PUT', `/crm/b/leads/${lead.id}/social`, { linkedinUrl: 'https://www.linkedin.com/in/asha', twitterUrl: 'not a url' }, T.A)).status === 200 && (await one('SELECT "linkedinUrl", "twitterUrl" FROM "CrmLead" WHERE "id" = ?', lead.id)).twitterUrl === null);

  // ============================================================ 13.06 website visits
  console.log('13.06 website visit tracking');
  const tj0 = await fetch(`${API}/crm-public/b/w/t.js?k=${SITE}`).then((r) => r.text());
  check('switched off: the tracker script does nothing', /tracking is off/.test(tj0));
  await sw(T, { webTracking: true }); await wait(3200);
  check('switched on: the tracker script is served', /__tlT/.test(await fetch(`${API}/crm-public/b/w/t.js?k=${SITE}`).then((r) => r.text())));
  const vid = `vweb${P}`;
  for (const u of ['https://teamlink.example/', 'https://teamlink.example/pricing?utm_source=fb&utm_campaign=nov']) await fetch(`${API}/crm-public/b/w/pv`, { method: 'POST', body: JSON.stringify({ k: SITE, v: vid, url: u, title: 'Page' }), headers: { 'Content-Type': 'text/plain' } }); // eslint-disable-line no-await-in-loop
  check('page views are stored for the visitor', Number((await one('SELECT COUNT(*) AS n FROM "CrmWebVisit" WHERE "visitorId" = ?', vid)).n) === 2);
  await fetch(`${API}/crm-public/b/w/id`, { method: 'POST', body: JSON.stringify({ k: SITE, v: vid, email: leadEmail }), headers: { 'Content-Type': 'text/plain' } });
  const vs = await call('GET', `/crm/b/leads/${lead.id}/visits`, null, T.A);
  check('once the visitor gives the lead\'s email, their pages show on the lead (with the UTM)', vs.status === 200 && vs.body.visits.length === 2 && vs.body.visits.some((v) => v.utmCampaign === 'nov'), vs.body);
  check('rep B cannot read them', (await call('GET', `/crm/b/leads/${lead.id}/visits`, null, T.B)).status === 404);
  check('a wrong site id stores nothing', (await fetch(`${API}/crm-public/b/w/pv`, { method: 'POST', body: JSON.stringify({ k: 'x', v: 'vzzzzzz1', url: 'u' }) })).status === 204 && !(await one('SELECT 1 AS x FROM "CrmWebVisit" WHERE "visitorId" = ?', 'vzzzzzz1')));

  // ============================================================ 13.07 nurture journeys
  console.log('13.07 several nurture journeys');
  check('a rep cannot make journeys', (await call('POST', '/crm/b/journeys', { name: 'x', steps: [{ channel: 'task', body: 'x' }] }, T.A)).status === 403);
  const jr = await call('POST', '/crm/b/journeys', { name: `Welcome ${P}`, trigger: 'new_lead', source: 'Event', steps: [{ channel: 'email', afterDays: 0, subject: 'Welcome {first_name}', body: 'Hi {first_name} from {company}, thanks.' }, { channel: 'task', afterDays: 2, body: 'Call {name}' }] }, T.M);
  const jr2 = await call('POST', '/crm/b/journeys', { name: `Hyd nurture ${P}`, trigger: 'segment', segmentId: seg.body.id, steps: [{ channel: 'task', afterDays: 0, body: 'Call {name} about Hyderabad hiring' }] }, T.M);
  check('a manager makes two journeys (new leads of a source; a segment); both start Off', jr.status === 200 && jr2.status === 200 && (await call('GET', '/crm/b/journeys', null, T.M)).body.journeys.every((j) => !j.on || ![jr.body.id, jr2.body.id].includes(j.id)));
  check('a journey switched on still waits while the "Nurture journeys" switch is off', (await call('POST', `/crm/b/journeys/${jr.body.id}/on`, { on: true }, T.M)).status === 200 && (await call('POST', '/crm/b/run/journeys', null, T.X)).body.result.off === true);
  await sw(T, { journeys: true }); await wait(3200);
  const jl = (await call('POST', '/crm/leads', { company: `ZZ Journey Co ${P}`, contactName: 'Jaya Menon', email: `jaya.${P}@zz-j.in`, source: 'Event' }, T.M)).body.lead;
  const jrun = await call('POST', '/crm/b/run/journeys', null, T.X);
  const jm = lastMailTo(`jaya.${P}@zz-j.in`);
  check('a new Event lead goes on the journey and gets step 1 (merge fields filled, unsubscribe line)', jrun.body.result.enrolled >= 1 && jm && jm.subject === 'Welcome Jaya' && /Unsubscribe/.test(jm.text) && /Choose what you get/.test(jm.text), { r: jrun.body, m: jm && jm.subject });
  const rn = await one('SELECT * FROM "CrmJourneyRun" WHERE "journeyId" = ? AND "recordId" = ?', jr.body.id, jl.id);
  check('the run waits for step 2 in two days', rn.status === 'Running' && rn.step === 1 && Date.parse(rn.nextAt) > Date.now() + 86400e3, rn);
  await DB.run('UPDATE "CrmLead" SET "autoPaused" = 1 WHERE "id" = ?', jl.id);
  await DB.run('UPDATE "CrmJourneyRun" SET "nextAt" = ? WHERE "id" = ?', new Date(Date.now() - 1000).toISOString(), rn.id);
  await call('POST', '/crm/b/run/journeys', null, T.X);
  check('once the lead replied, the journey stops for them', (await one('SELECT "status" FROM "CrmJourneyRun" WHERE "id" = ?', rn.id)).status === 'Stopped');
  check('a non-Event lead is not on that journey', !(await one('SELECT 1 AS x FROM "CrmJourneyRun" WHERE "journeyId" = ? AND "recordId" = ?', jr.body.id, roiLead.id)));
  await call('POST', `/crm/b/journeys/${jr2.body.id}/on`, { on: true }, T.M);
  const j2 = await call('POST', '/crm/b/run/journeys', null, T.X);
  check('the segment journey enrols the segment\'s people and makes their follow-up', j2.body.result.enrolled >= 2 && !!(await one('SELECT 1 AS x FROM "CrmTask" WHERE "leadId" = ? AND "origin" = \'journey\'', lead.id)), j2.body);

  // ============================================================ 13.08 ad leads
  console.log('13.08 ad leads (Google / Meta)');
  check('switched off: an ad lead is ignored quietly (no lead)', (await call('POST', '/crm-public/b/ads/google', { google_key: 'x' })).body.off === true);
  await setRow('crm-ads', { 'Facebook Page access token': 'zz-page-token', 'Facebook App secret': '', 'Webhook verify token (any text)': `verify-${P}`, 'Google Ads webhook key (any text)': `gkey-${P}` });
  await sw(T, { adsLeads: true }); await wait(3200);
  check('switched on, a wrong Google key is refused (401)', (await call('POST', '/crm-public/b/ads/google', { google_key: 'x' })).status === 401);
  const gl = await call('POST', '/crm-public/b/ads/google', { google_key: `gkey-${P}`, campaign_id: 123, user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Gopal K' }, { column_id: 'EMAIL', string_value: `gopal.${P}@zz-ads.in` }, { column_id: 'PHONE_NUMBER', string_value: '+919876500041' }, { column_id: 'COMPANY_NAME', string_value: `ZZ Ads Co ${P}` }] });
  check('a Google Ads lead form makes a lead (utm google-ads)', gl.status === 200 && (await one('SELECT "utmSource" FROM "CrmLead" WHERE "email" = ?', `gopal.${P}@zz-ads.in`)).utmSource === 'google-ads', gl.body);
  const ver = await fetch(`${API}/crm-public/b/ads/meta?hub.mode=subscribe&hub.verify_token=verify-${P}&hub.challenge=777`).then((r) => r.text());
  check('Facebook\'s webhook check is answered with the challenge', ver === '777');
  const ml = await call('POST', '/crm-public/b/ads/meta', { entry: [{ changes: [{ value: { leadgen_id: 'lg1', form_id: 'f1', field_data: [{ name: 'full_name', values: ['Farah'] }, { name: 'email', values: [`farah.${P}@zz-fb.in`] }, { name: 'phone_number', values: ['9876500042'] }] } }] }] });
  check('a Facebook lead ad makes a lead (utm facebook-ads)', ml.status === 200 && ml.body.made === 1 && !!(await one('SELECT 1 AS x FROM "CrmLead" WHERE "email" = ? AND "utmSource" = \'facebook-ads\'', `farah.${P}@zz-fb.in`)), ml.body);
  const af = await fetch(`${API}/crm/b/segments/${seg.body.id}/audience.csv`, { headers: { Authorization: `Bearer ${T.M}` } });
  const afText = await af.text();
  check('a segment downloads as a hashed audience file (no plain emails)', af.status === 200 && /^email_sha256,phone_sha256/.test(afText) && !afText.includes('@'), afText.slice(0, 120));
  check('a rep without the download right cannot', (await fetch(`${API}/crm/b/segments/${seg.body.id}/audience.csv`, { headers: { Authorization: `Bearer ${T.A}` } })).status === 403);

  // ============================================================ 13.09 events
  console.log('13.09 events and webinars');
  const ev = await call('POST', '/crm/b/events', { title: `Hiring webinar ${P}`, kind: 'Webinar', startsAt: new Date(Date.now() + 3 * 86400e3).toISOString(), link: 'https://meet.example/abc', capacity: 2, description: 'How to hire fast.' }, T.M);
  check('a manager makes a webinar', ev.status === 200 && !!ev.body.slug, ev.body);
  const evp = await fetch(`${API}/crm-public/b/e/${ev.body.slug}`).then((r) => r.text());
  check('its registration page opens with no login', evp.includes(`Hiring webinar ${P}`) && /name="name"/.test(evp));
  const rg = await form(`/api/crm-public/b/e/${ev.body.slug}`, { name: 'Lata', email: `lata.${P}@zz-ev.in`, company: `ZZ Event Co ${P}` });
  const rgt = await rg.text();
  check('a registration: thank-you with the joining link, a lead with source Event', rg.status === 200 && /registered/i.test(rgt) && rgt.includes('meet.example') && !!(await one('SELECT 1 AS x FROM "CrmLead" WHERE "email" = ? AND "source" = \'Event\'', `lata.${P}@zz-ev.in`)));
  check('the same email again is not counted twice', /already registered/i.test(await (await form(`/api/crm-public/b/e/${ev.body.slug}`, { name: 'Lata', email: `lata.${P}@zz-ev.in` })).text()));
  await form(`/api/crm-public/b/e/${ev.body.slug}`, { name: 'Second', email: `second.${P}@zz-ev.in` });
  check('a full event says so', /full/i.test(await (await form(`/api/crm-public/b/e/${ev.body.slug}`, { name: 'Third', email: `third.${P}@zz-ev.in` })).text()));
  const regs = await call('GET', `/crm/b/events/${ev.body.id}/registrations`, null, T.M);
  const reg1 = regs.body.registrations.find((r) => r.email === `lata.${P}@zz-ev.in`);
  check('attendance is marked and written on the lead', (await call('POST', `/crm/b/event-regs/${reg1.id}`, { status: 'Attended' }, T.M)).status === 200 && (await acts('leadId', reg1.leadId)).some((a) => /attended/.test(a.subject || '')));
  check('the events list counts registered / attended', (await call('GET', '/crm/b/events', null, T.A)).body.events.some((e) => e.id === ev.body.id && Number(e.registered) === 2 && Number(e.attended) === 1));

  // ============================================================ 13.10 preference centre
  console.log('13.10 unsubscribe / preference centre');
  const MK = require('../src/crm/b/marketing');
  const ptok = MK.prefToken(lead.email);
  const pp = await fetch(`${API}/crm-public/b/prefs?t=${ptok}`).then((r) => r.text());
  check('the preference page opens from its signed link (topics and channels)', pp.includes(lead.email.toLowerCase()) && /name="topic"/.test(pp) && /ch_whatsapp/.test(pp));
  check('a tampered link is refused', (await fetch(`${API}/crm-public/b/prefs?t=${ptok}x`)).status === 400);
  const ppost = await fetch(`${API}/crm-public/b/prefs?t=${ptok}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'topic=Events+and+webinars&ch_email=1' });
  const pref = await one('SELECT * FROM "CrmMailPref" WHERE "email" = ?', lead.email.toLowerCase());
  check('the person keeps only "Events and webinars" by email', ppost.status === 200 && JSON.parse(pref.topicsJson).join() === 'Events and webinars' && JSON.parse(pref.channelsJson).whatsapp === false);
  check('the choice is written on the lead', (await acts('leadId', lead.id)).some((a) => /preference centre/.test(a.subject || '')));
  await call('POST', '/crm/leads', { company: `ZZ Offer Ok ${P}`, contactName: 'Okay', email: `okay.${P}@zz-offer.in` }, T.A); // somebody who still gets offers
  const offerC = await call('POST', '/crm/campaigns', { name: `ZZ offers ${P}`, channel: 'email', subject: 'Offer', body: 'An offer.', audience: { kind: 'leads', status: 'open', owner: A.id } }, T.M);
  await call('PUT', `/crm/b/campaign-meta/${offerC.body.campaign.id}`, { topic: 'Offers' }, T.M);
  await call('POST', `/crm/campaigns/${offerC.body.campaign.id}/send`, null, T.M);
  const rcp = await one('SELECT * FROM "CrmCampaignRecipient" WHERE "campaignId" = ? AND "recordId" = ?', offerC.body.campaign.id, lead.id);
  const rcpOk = await one('SELECT * FROM "CrmCampaignRecipient" WHERE "campaignId" = ? AND "toAddr" = ?', offerC.body.campaign.id, `okay.${P}@zz-offer.in`);
  check('an "Offers" campaign skips the person who said no to offers, and still goes to the others', rcp && rcp.status === 'skipped' && /preferences/.test(rcp.error || '') && rcpOk && rcpOk.status !== 'skipped', [rcp, rcpOk]);
  await fetch(`${API}/crm-public/b/prefs?t=${ptok}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'all=off' });
  check('"Send me nothing" puts them on the opt-out list', !!(await one('SELECT 1 AS x FROM "CrmOptOut" WHERE "value" = ? AND "channel" = \'email\'', lead.email.toLowerCase())));
  const prefStaff = await call('GET', `/crm/b/prefs?email=${encodeURIComponent(lead.email)}`, null, T.A);
  check('the owner sees what they chose on the record; rep B cannot', prefStaff.status === 200 && prefStaff.body.prefs.unsubscribed === true && (await call('GET', `/crm/b/prefs?email=${encodeURIComponent(lead.email)}`, null, T.B)).status === 404);

  // ============================================================ 12.01 / 12.02 / 12.03 the customer portal
  console.log('12.01 customer portal login, quotes and invoices');
  const inv1 = await call('POST', '/crm/b/portal-users', { type: 'customer', accountId: acc.id, contactId: contact.id }, T.A);
  const inviteTok = (/invite=([A-Za-z0-9_-]+)/.exec(inv1.body.link || '') || [])[1];
  check('rep A invites the account\'s contact; the invite is emailed', inv1.status === 200 && !!inviteTok && inv1.body.mailed === true && /crm-portal\?invite=/.test((lastMailTo(contact.email) || {}).text || ''), inv1.body);
  check('rep B cannot invite on A\'s account', (await call('POST', '/crm/b/portal-users', { type: 'customer', accountId: acc.id, email: 'x@zz.in' }, T.B)).status === 404);
  check('while the portal switch is off nobody can set a password', (await pcall('POST', '/accept', { invite: inviteTok, password: 'Portal123' })).status === 403);
  await sw(T, { portal: true }); await wait(3200);
  check('a weak password is refused', (await pcall('POST', '/accept', { invite: inviteTok, password: 'short' })).status === 400);
  const ac = await pcall('POST', '/accept', { invite: inviteTok, password: 'Portal1234' });
  check('the customer sets a password from the link and is signed in', ac.status === 200 && !!ac.body.token && ac.body.me.company === acc.name, ac.body);
  check('the invite link works once only', (await pcall('POST', '/accept', { invite: inviteTok, password: 'Portal1234' })).status === 400);
  check('a wrong password is refused', (await pcall('POST', '/login', { email: contact.email, password: 'nope', type: 'customer' })).status === 401);
  const lg = await pcall('POST', '/login', { email: contact.email, password: 'Portal1234', type: 'customer' });
  const CT = lg.body && lg.body.token;
  check('the customer signs in at /crm-portal', lg.status === 200 && !!CT);
  check('without a session nothing is shown (401)', (await pcall('GET', '/quotes')).status === 401);
  check('a staff login token is not a portal session', (await pcall('GET', '/me', null, T.A)).status === 401);
  const pq = await pcall('GET', '/quotes', null, CT);
  check('the customer sees their own sent proposal', pq.status === 200 && pq.body.quotes.some((q) => q.id === prop.id && q.status === 'Sent'), pq.body);
  const otherAcc = (await call('POST', '/crm/accounts', { name: `ZZ Not Mine ${P}` }, T.B)).body.account;
  const otherDeal = (await call('POST', '/crm/deals', { title: `ZZ other deal ${P}`, accountId: otherAcc.id, value: '1000' }, T.B)).body.deal;
  const otherProp = (await call('POST', `/crm/deals/${otherDeal.id}/proposals`, { roles: [{ title: 'Tester', openings: 1, ctc: 300000 }], feePercent: 8, company: otherAcc.name, toName: 'X', toEmail: 'x@zz-other.in', fromName: 'B' }, T.B)).body.proposal;
  await DB.run('UPDATE "CrmProposal" SET "status" = \'Sent\', "sentAt" = ? WHERE "id" = ?', new Date().toISOString(), otherProp.id);
  check('another company\'s proposal is never shown or opened', !(await pcall('GET', '/quotes', null, CT)).body.quotes.some((q) => q.id === otherProp.id) && (await fetch(`${API}/crm-portal/quotes/${otherProp.id}/pdf`, { headers: { 'X-CRM-Portal': CT } })).status === 404);
  const qpdf = await fetch(`${API}/crm-portal/quotes/${prop.id}/pdf`, { headers: { 'X-CRM-Portal': CT } });
  check('the customer opens the proposal PDF from the portal', qpdf.status === 200 && Buffer.from(await qpdf.arrayBuffer()).slice(0, 4).toString() === '%PDF');
  const qd = await pcall('POST', `/quotes/${prop.id}/decision`, { decision: 'accept' }, CT);
  check('and accepts it: the deal\'s timeline says so', qd.status === 200 && qd.body.status === 'Accepted' && (await acts('dealId', deal.id)).some((a) => /accepted in the customer portal/.test(a.subject || '')), qd.body);
  const now2 = new Date().toISOString();
  await DB.run('INSERT INTO "CrmInvoice" ("id","code","dealId","accountId","accountName","title","status","issueDate","amount","taxPercent","taxAmount","total","paidAmount","ownerId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,\'Sent\',?,1000,18,180,1180,180,?,?,?)', `inv-${P}`, `ZZ-INV-${P}`, deal.id, acc.id, acc.name, 'Fee', now2.slice(0, 10), A.id, now2, now2);
  await DB.run('INSERT INTO "CrmInvoice" ("id","code","dealId","accountId","accountName","title","status","issueDate","amount","taxPercent","taxAmount","total","paidAmount","ownerId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,\'Draft\',?,1,0,0,1,0,?,?,?)', `invd-${P}`, `ZZ-DRAFT-${P}`, otherDeal.id, acc.id, acc.name, 'Draft', now2.slice(0, 10), A.id, now2, now2);
  const pi = await pcall('GET', '/invoices', null, CT);
  check('invoices: the sent one with what is due; never a Draft', pi.status === 200 && pi.body.invoices.length === 1 && pi.body.invoices[0].due === 1000, pi.body);
  console.log('12.02 support tickets raised and followed by the customer');
  const pt = await pcall('POST', '/tickets', { subject: `Replace a candidate ${P}`, description: 'The joined candidate left.', priority: 'High' }, CT);
  const tk = pt.body && pt.body.ticket;
  const tkRow = tk ? await one('SELECT * FROM "CrmTicket" WHERE "id" = ?', tk.id) : null;
  check('the customer raises a ticket: it is in the CRM on their account, with the SLA, owner = the account owner', pt.status === 200 && tkRow && tkRow.accountId === acc.id && tkRow.ownerId === A.id && !!tkRow.dueAt, tkRow);
  check('the account owner gets a bell', !!(await prisma.notification.findFirst({ where: { userId: A.id, title: { contains: `Replace a candidate ${P}` } } })));
  check('staff see it in CRM > Support tickets', (await call('GET', `/crm/tickets/${tk.id}`, null, T.A)).status === 200);
  await call('POST', `/crm/tickets/${tk.id}/comments`, { body: 'Internal: check replacement policy' }, T.A);
  await call('POST', `/crm/tickets/${tk.id}/comments`, { body: 'We will send two profiles tomorrow.', toCustomer: true, to: contact.email }, T.A);
  const ptd = await pcall('GET', `/tickets/${tk.id}`, null, CT);
  check('the customer sees our reply but never the internal note', ptd.status === 200 && ptd.body.comments.some((c) => /two profiles/.test(c.body)) && !ptd.body.comments.some((c) => /Internal/.test(c.body)), ptd.body);
  check('the customer writes in the ticket', (await pcall('POST', `/tickets/${tk.id}/comments`, { body: 'Thank you' }, CT)).status === 200);
  check('another company\'s ticket cannot be opened', (await pcall('GET', `/tickets/${tkRow.id}x`, null, CT)).status === 404);
  console.log('12.03 knowledge base');
  const kb1 = await call('POST', '/crm/b/kb', { title: `How replacement works ${P}`, category: 'Hiring', body: 'If a candidate leaves in 90 days we replace them.', published: true }, T.A);
  check('a rep\'s article is saved as a draft (a manager publishes)', kb1.status === 200 && kb1.body.published === false);
  check('a draft is not on the public help page', !(await fetch(`${API}/crm-public/b/kb`).then((r) => r.text())).includes(`How replacement works ${P}`));
  await call('PUT', `/crm/b/kb/${kb1.body.id}`, { title: `How replacement works ${P}`, category: 'Hiring', body: 'If a candidate leaves in 90 days we replace them.', published: true }, T.M);
  check('published: on the public help page and in the portal', (await fetch(`${API}/crm-public/b/kb`).then((r) => r.text())).includes(`How replacement works ${P}`) && (await pcall('GET', '/kb', null, CT)).body.articles.some((a) => a.id === kb1.body.id));
  await fetch(`${API}/crm-public/b/kb?a=${kb1.body.id}`);
  await pcall('POST', `/kb/${kb1.body.id}/helpful`, { yes: true }, CT);
  const kbRow = await one('SELECT "views", "helpfulYes" FROM "CrmKbArticle" WHERE "id" = ?', kb1.body.id);
  check('views and "did this help" are counted', Number(kbRow.views) >= 1 && Number(kbRow.helpfulYes) === 1, kbRow);
  check('the customer cannot reach the partner deals (403)', (await pcall('GET', '/deals', null, CT)).status === 403);

  // ============================================================ 12.04 partners
  console.log('12.04 partner / reseller portal');
  check('a rep cannot add partners', (await call('POST', '/crm/b/resellers', { name: 'x' }, T.A)).status === 403);
  const rs = await call('POST', '/crm/b/resellers', { name: `ZZ Reseller ${P}`, contactName: 'Prakash', email: `prakash.${P}@zz-res.in`, commissionPercent: 10, ownerId: A.id }, T.M);
  const pinv = await call('POST', '/crm/b/portal-users', { type: 'partner', resellerId: rs.body.id }, T.M);
  const ptok2 = (/invite=([A-Za-z0-9_-]+)/.exec(pinv.body.link || '') || [])[1];
  const pa = await pcall('POST', '/accept', { invite: ptok2, password: 'Partner123' });
  const PT = pa.body && pa.body.token;
  check('a manager adds a partner and invites them; the partner signs in', rs.status === 200 && pinv.status === 200 && pa.status === 200 && pa.body.me.type === 'partner', pa.body);
  check('the partner cannot see customer quotes (403)', (await pcall('GET', '/quotes', null, PT)).status === 403);
  const pd1 = await pcall('POST', '/deals', { company: `ZZ Partner Find ${P}`, contactName: 'Ganesh', phone: '9876500051', value: '200000' }, PT);
  check('the partner registers a new company: Submitted', pd1.status === 200 && pd1.body.status === 'Submitted', pd1.body);
  const pd2 = await pcall('POST', '/deals', { company: `ZZ Buyer Co ${P}`, phone: '9876500099' }, PT);
  check('a company already in the CRM is a Duplicate, and the partner is told', pd2.status === 200 && pd2.body.status === 'Duplicate' && /already with us/.test(pd2.body.note), pd2.body);
  const rd = await call('GET', '/crm/b/resellers', null, T.M);
  check('the manager sees the registered deals', rd.body.deals.some((d) => d.id === pd1.body.id));
  const acp = await call('POST', `/crm/b/reseller-deals/${pd1.body.id}`, { decision: 'accept' }, T.M);
  const pl = acp.body.leadId ? await one('SELECT * FROM "CrmLead" WHERE "id" = ?', acp.body.leadId) : null;
  check('accepted: a lead (source Referral) for the partner\'s manager, with the value', acp.status === 200 && pl && pl.ownerId === A.id && pl.source === 'Referral' && Number(pl.expectedValue) === 200000, pl);
  check('a reject needs a reason the partner sees', (await call('POST', `/crm/b/reseller-deals/${pd2.body.id}`, { decision: 'reject' }, T.M)).status === 400 && (await call('POST', `/crm/b/reseller-deals/${pd2.body.id}`, { decision: 'reject', reason: 'Already our customer' }, T.M)).status === 200);
  const myd = await pcall('GET', '/deals', null, PT);
  check('the partner sees what became of each deal', myd.body.deals.find((d) => d.id === pd1.body.id).status === 'Accepted' && myd.body.deals.find((d) => d.id === pd2.body.id).reason === 'Already our customer');
  check('removing a login ends its sessions', (await call('DELETE', `/crm/b/portal-users/${(await one('SELECT "id" FROM "CrmPortalUser" WHERE "resellerId" = ?', rs.body.id)).id}`, null, T.M)).status === 200 && (await pcall('GET', '/me', null, PT)).status === 401);

  // ============================================================ 12.06 surveys
  console.log('12.06 NPS / CSAT surveys');
  const sv = await call('POST', '/crm/b/surveys', { kind: 'account', id: acc.id, type: 'nps' }, T.A);
  const svm = lastMailTo(contact.email);
  const svTok = (/\/api\/crm-public\/b\/s\/([A-Za-z0-9_-]+)/.exec(String(svm && svm.text)) || [])[1];
  check('rep A sends an NPS survey to the account\'s decision maker', sv.status === 200 && !!svTok, sv.body);
  check('rep B cannot survey A\'s account', (await call('POST', '/crm/b/surveys', { kind: 'account', id: acc.id, type: 'nps' }, T.B)).status === 404);
  const svp = await fetch(`${API}/crm-public/b/s/${svTok}`).then((r) => r.text());
  check('the survey page shows 0 to 10', /value="0"/.test(svp) && /value="10"/.test(svp));
  check('a score out of range is refused', (await form(`/api/crm-public/b/s/${svTok}`, { score: '11' })).status === 400);
  const ans = await form(`/api/crm-public/b/s/${svTok}`, { score: '3', comment: 'Slow replies' });
  check('a low score: thank-you, on the account timeline, a call-back follow-up for the owner', ans.status === 200 && (await acts('accountId', acc.id)).some((a) => /NPS answer: 3\/10 \(unhappy\)/.test(a.subject || '')) && !!(await one('SELECT 1 AS x FROM "CrmTask" WHERE "accountId" = ? AND "origin" = \'survey\' AND "ownerId" = ?', acc.id, A.id)));
  check('a second answer is not taken', /already have your answer/.test(await (await form(`/api/crm-public/b/s/${svTok}`, { score: '10' })).text()));
  const res = await call('GET', '/crm/b/surveys', null, T.A);
  check('the results: NPS -100 from one detractor', res.status === 200 && res.body.nps.score === -100 && res.body.nps.detractors === 1, res.body.nps);
  check('surveys after a won deal wait while the switch is off', (await call('POST', '/crm/b/run/surveys', null, T.X)).body.result.off === true);
  await sw(T, { surveysAuto: true }); await wait(3200);
  await DB.run('UPDATE "CrmDeal" SET "stage" = \'Won\', "wonAt" = ? WHERE "id" = ?', new Date().toISOString(), deal.id);
  const au = await call('POST', '/crm/b/run/surveys', null, T.X);
  check('switched on: the won deal\'s contact gets an NPS survey by itself, once', au.body.result.sent >= 1 && !!(await one('SELECT 1 AS x FROM "CrmSurveyAsk" WHERE "kind" = \'deal\' AND "recordId" = ? AND "sentAt" IS NOT NULL', deal.id)) && (await call('POST', '/crm/b/run/surveys', null, T.X)).body.result.sent === 0, au.body);

  // ============================================================ the five CRM menu items stay five
  console.log('The CRM stays at five sidebar items; the new screens are tabs');
  const nav = fs.readFileSync(path.join(BACK, '..', 'frontend', 'src', 'nav.js'), 'utf8');
  check('no new CRM sidebar item was added (nav.js has no Inbox / Marketing / Portal entry)', !/crm\/(inbox|marketing|portal)/.test(nav));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
