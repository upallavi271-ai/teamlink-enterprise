#!/usr/bin/env node
/**
 * The CRM for general sales leads, first part (crm/sales.js): the lead pipeline, the website form, timed reminders.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4037. Messages go to a stand-in; nothing real is called.
 *   node scripts/crm-general-sales-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-sales-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4037;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-sales-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const S = require('../src/crm/service');
const SALES = require('../src/crm/sales');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 320)}` : ''}`); } };
const call = async (method, url, body, headers = {}) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j, headers: r.headers };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  await SETTINGS.load({ fresh: true });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const token = jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const auth = { Authorization: `Bearer ${token}` };

  console.log('The lead pipeline');
  const me = await call('GET', '/crm/me', null, auth);
  check('the 7 stages come by default, Won and Lost last', me.status === 200 && me.body.lists.leadStages.map((s) => s.name).join() === 'New,Contacted,Qualified,Proposal,Negotiation,Won,Lost', me.body && me.body.lists && me.body.lists.leadStages);
  const add = await call('POST', '/crm/leads', { company: 'Zz Pipeline Ltd', contactName: 'Ravi', phone: '9000011111', email: 'ravi@zzpipeline.test', expectedValue: '250000' }, auth);
  check('a lead is added with an expected value', add.status === 200 && add.body.lead.expectedValue === 250000, add.body);
  const id = add.body.lead.id;
  const dup = await call('POST', '/crm/leads', { company: 'Other Co', phone: '9000011111' }, auth);
  check('the same phone is caught as a duplicate', dup.status === 409 && dup.body.duplicates.length > 0, dup.body);
  const stage = async (s, extra = {}) => call('POST', `/crm/leads/${id}/stage`, { stage: s, ...extra }, auth);
  check('a lead nobody has touched cannot move past the first stage (Phase 1 rule)', (await stage('Proposal')).status === 409);
  await call('POST', '/crm/activities', { kind: 'call', leadId: id, subject: 'First call' }, auth);
  const m1 = await stage('Proposal');
  check('a lead moves to a stage', m1.status === 200 && m1.body.lead.stage === 'Proposal', m1.body);
  const det = await call('GET', `/crm/leads/${id}`, null, auth);
  check('the move is on the timeline, with the user', det.body.activities.some((a) => a.subject === 'Stage: Contacted → Proposal' && a.byName), det.body.activities);
  check('the older status follows', det.body.lead.status === 'Qualified' && det.body.lead.stage === 'Proposal');
  check('a stage that does not exist is refused', (await stage('Nonsense')).status === 400);
  check('Lost needs a reason', (await stage('Lost')).status === 400);
  const lost = await stage('Lost', { lostReason: 'No response' });
  check('Lost with a reason', lost.status === 200 && lost.body.lead.lostReason === 'No response', lost.body);
  const open = await call('GET', '/crm/leads', null, auth);
  const all = await call('GET', '/crm/leads?status=all', null, auth);
  check('a lost lead leaves the open list and stays on the board', !open.body.rows.some((l) => l.id === id) && all.body.rows.some((l) => l.id === id && l.stage === 'Lost'));
  const won = await stage('Won');
  check('Won says a deal is needed', won.status === 200 && won.body.needsDeal === true, won.body);
  const filt = await call('GET', '/crm/leads?stage=Won', null, auth);
  check('the stage filter works', filt.body.rows.some((l) => l.id === id));

  console.log('Settings');
  const cfg = await call('PUT', '/crm/settings', { leadStages: [{ name: 'Fresh', color: '#123456' }, { name: 'Talking', color: 'red' }, { name: 'Won', color: '#00ff00' }, { name: 'won', color: '#000000' }], defaultRemindBefore: 60 }, auth);
  const stNames = cfg.body.settings.leadStages.map((s) => s.name).join();
  check('stages are renamed and reordered; Won and Lost stay, last; a bad colour falls back', stNames === 'Fresh,Talking,Won,Lost' && cfg.body.settings.leadStages[0].color === '#123456' && cfg.body.settings.leadStages[1].color === '#64748b' && cfg.body.settings.leadStages[2].color === '#00ff00', cfg.body.settings.leadStages);
  await new Promise((r) => { setTimeout(r, 16000); }); // the server's settings cache
  const old = await call('GET', '/crm/leads?status=all', null, auth);
  check('an old lead on a stage that is gone stands on the first stage', old.body.rows.every((l) => ['Fresh', 'Talking', 'Won', 'Lost'].includes(l.stage)), old.body.rows.slice(0, 3).map((l) => l.stage));
  await call('PUT', '/crm/settings', { leadStages: SETTINGS.DEFAULTS.leadStages, defaultRemindBefore: 15 }, auth);

  console.log('The website form');
  const w = await call('GET', '/crm/website', null, auth);
  check('a key is made the first time', w.status === 200 && /^tlcrm_/.test(w.body.key), w.body);
  const KEY = w.body.key;
  const pub = (b, h = { 'x-api-key': KEY }) => call('POST', '/crm/leads/public', b, h);
  check('no key: refused', (await pub({ name: 'A', phone: '9000022222' }, {})).status === 401);
  check('a wrong key: refused', (await pub({ name: 'A', phone: '9000022222' }, { 'x-api-key': 'tlcrm_wrong' })).status === 401);
  check('no phone or email: refused', (await pub({ name: 'A' })).status === 400);
  const hp = await pub({ name: 'Robot', phone: '9000033333', website_url: 'http://spam.example' });
  check('a robot that fills the hidden field looks fine, and nothing is saved', hp.status === 200 && !(await DB.one('SELECT "id" FROM "CrmLead" WHERE "phone" = ?', '9000033333')));
  const w1 = await pub({ name: 'Sita Rao', company: 'Sita Traders', phone: '90000 22222', email: 'sita@sitatraders.test', message: 'Need a quote', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'nov', page_url: 'https://example.test/contact' });
  const row = w1.body.id && await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', w1.body.id);
  check('a lead comes in: Source Website, UTM and page kept, no owner', w1.status === 200 && row && row.source === 'Website' && row.utmSource === 'google' && row.utmCampaign === 'nov' && row.pageUrl === 'https://example.test/contact' && !row.ownerId && row.notes === 'Need a quote', row);
  check('any website may post (open CORS)', (await fetch(`${API}/crm/leads/public`, { method: 'OPTIONS', headers: { Origin: 'https://example.test' } })).headers.get('access-control-allow-origin') === '*');
  const w2 = await pub({ name: 'Sita', email: 'SITA@sitatraders.test', message: 'Again' });
  check('the same email again: a note on the lead, no second lead', w2.body.duplicate === true && (await DB.all('SELECT "id" FROM "CrmLead" WHERE lower("email") = ?', 'sita@sitatraders.test')).length === 1 && !!(await DB.one('SELECT "id" FROM "CrmActivity" WHERE "leadId" = ? AND "subject" = ?', row.id, 'Filled the website form again')), w2.body);
  const form = await fetch(`${API}/crm/leads/public`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: KEY, name: 'Plain Form', phone: '9000044444' }) });
  check('a plain HTML form works too', form.status === 200 && !!(await DB.one('SELECT "id" FROM "CrmLead" WHERE "phone" = ?', '9000044444')));
  const owners = await S.ownerOptions();
  await call('PUT', '/crm/website', { autoAssign: true }, auth);
  const given = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pub({ name: `Round ${i}`, phone: `900005555${i}` });
    // eslint-disable-next-line no-await-in-loop
    given.push((await DB.one('SELECT "ownerId" FROM "CrmLead" WHERE "id" = ?', r.body.id)).ownerId);
  }
  check('round robin: each new lead goes to the next person', owners.length < 2 || (given[0] && given[0] !== given[1]), { owners: owners.length, given });
  const reKey = await call('POST', '/crm/website/key', null, auth);
  check('a new key: the old one stops', reKey.body.key !== KEY && (await pub({ name: 'Old', phone: '9000066666' })).status === 401);

  console.log('Follow-ups and reminders');
  const istIn = (min) => { const d = new Date(Date.now() + min * 60000 + 5.5 * 3600000).toISOString(); return { dueDate: d.slice(0, 10), dueTime: d.slice(11, 16) }; };
  const mk = (over) => call('POST', '/crm/tasks', { title: 'Call Ravi', leadId: row.id, ownerId: adminRow.id, type: 'Meeting', ...over }, auth);
  const t1 = await mk({ ...istIn(10), remindBefore: 15, notifyWhatsapp: true, notifySms: true });
  const t2 = await mk({ ...istIn(120), remindBefore: 15 });
  const t3 = await mk({ ...istIn(120), remindBefore: 1440, notifyApp: false });
  check('a follow-up keeps its type, time and reminder choices', t1.status === 200 && t1.body.task.type === 'Meeting' && t1.body.task.remindBefore === 15 && t1.body.task.notifyWhatsapp === 1, t1.body);
  const sent = [];
  const deps = { messaging: { channelStatus: async () => ({ WhatsApp: { configured: true }, SMS: { configured: true } }), send: async (ch, m) => { sent.push({ ch, to: m.to }); return { ok: true }; } }, normalizeMobile: () => ({ ok: true, e164: '+919000000000' }) };
  await prisma.employee.updateMany({ where: { userId: adminRow.id }, data: { phone: '9000077777' } });
  await prisma.$executeRawUnsafe('UPDATE "CrmTask" SET "notifyApp" = NULL WHERE "reminderSentAt" IS NULL AND "id" NOT IN (?, ?, ?)', t1.body.task.id, t2.body.task.id, t3.body.task.id);
  const n1 = await SALES.runDue({ deps });
  const row1 = await DB.one('SELECT * FROM "CrmTask" WHERE "id" = ?', t1.body.task.id);
  const row2 = await DB.one('SELECT * FROM "CrmTask" WHERE "id" = ?', t2.body.task.id);
  const row3 = await DB.one('SELECT * FROM "CrmTask" WHERE "id" = ?', t3.body.task.id);
  check('due within its "remind before": sent; not yet due: waits', n1 === 2 && !!row1.reminderSentAt && !row2.reminderSentAt, { n1, row2: row2.reminderSentAt });
  check('"1 day before" is due now', !!row3.reminderSentAt);
  const hasEmployee = await prisma.employee.findFirst({ where: { userId: adminRow.id } });
  check('WhatsApp and SMS go to the owner', !hasEmployee || (sent.some((x) => x.ch === 'WhatsApp') && sent.some((x) => x.ch === 'SMS')), { sent, note: row1.reminderNote });
  check('the bell has it, and it shows on screen', !!(await prisma.notification.findFirst({ where: { userId: adminRow.id, recipient: `crm-task|${row1.id}` } })));
  check('no bell when "in app" was not ticked', !(await prisma.notification.findFirst({ where: { recipient: `crm-task|${row3.id}` } })));
  const live = await call('GET', '/crm/reminders/live', null, auth);
  check('the on-screen reminder is served', live.status === 200 && live.body.reminders.some((x) => /CRM follow-up/.test(x.title)), live.body);
  check('a second pass sends nothing again', (await SALES.runDue({ deps })) === 0 && sent.length <= 2);
  check('later, the other one goes', (await SALES.runDue({ now: Date.now() + 2 * 3600000, deps })) === 1);
  check('a follow-up from before this has no reminder of its own', (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmTask" WHERE "notifyApp" IS NULL AND "reminderSentAt" IS NOT NULL'))[0].n == 0); // eslint-disable-line eqeqeq
  const up = await call('GET', '/crm/tasks?when=upcoming&all=1', null, auth);
  check('upcoming lists them', up.status === 200, up.body);
  const can = await call('POST', `/crm/tasks/${t2.body.task.id}/cancel`, null, auth);
  check('a follow-up can be cancelled', can.status === 200 && can.body.task.status === 'Cancelled', can.body);
  const dn = await call('POST', `/crm/tasks/${t1.body.task.id}/done`, { note: 'Spoke to them' }, auth);
  check('done keeps what happened', dn.status === 200 && dn.body.task.doneNote === 'Spoke to them');
  const dd = await call('GET', '/crm/tasks?when=done', null, auth);
  check('completed lists it', dd.body.tasks.some((x) => x.id === t1.body.task.id));

  console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
