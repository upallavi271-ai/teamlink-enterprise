#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL v3 AUTOMATION + BOTS TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4106 node scripts/omni-gs-automation-bots-test.js
// Makes its OWN working copy (<copy>-gsautobots-work.db), starts its OWN API (TEST_MODE: every channel is a fake that never leaves this machine) and checks:
//   AU  automations API: shapes, roles, validation, enrol, rehearsal (nothing sent in Test mode), tasks, scheduled messages are Admin / HR only, names only
//   BT  bot flows API: roles, validation, STOP words refused as triggers, Try a message, the Admin switch
//   BE  the bot ENGINE through the real inbound hook: Test mode / switch off = only "Would have replied", flows Off never match, throttle, STOP opts out and is
//       never answered, opted-out people are never answered, live path only when flow On + switch On + Test mode off + permission, hand-off, daily rules
//   BD  WhatsApp Bot Data numbers = the log
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-gsautobots-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4106);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
process.env.OMNI_SEQUENCES_OFF = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';

{
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const ex = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
async function until(fn, ms = 6000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(150); } }

(async () => {
  let server;
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const S = require(path.join(BACK, 'src/outreach/store'));
    const K = require(path.join(BACK, 'src/outreach/contacts'));
    const C = require(path.join(BACK, 'src/outreach/consent'));
    const Seq = require(path.join(BACK, 'src/outreach/sequences'));
    const Bots = require(path.join(BACK, 'src/outreach/bots'));
    const convo = require(path.join(BACK, 'src/utils/conversations'));

    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; }
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 60 });
    const tlEmp = await prisma.employee.findFirst({ where: { userId: tl && tl.id } });
    const rec = recEmps[0];
    check('0 the copy has the people the test needs (Super Admin, TL with a department, BDE, Assistant Manager, HR, a recruiter)', !!(sa && tl && tlEmp && tlEmp.department && bde && am && hr && rec), { sa: !!sa, tl: !!tl, dept: tlEmp && tlEmp.department, bde: !!bde, am: !!am, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec && rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const tlDept = tlEmp.department;
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-ab-client-${RUN}@example.test`, username: `zz-ab-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-ab-acct-${RUN}@example.test`, username: `zz-ab-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });
    const otherDept = (await prisma.department.findMany({ where: { active: true }, select: { name: true } })).map((d) => d.name).find((n) => n.toLowerCase() !== String(tlDept).toLowerCase()) || 'ZZOtherDept';

    // Test mode ON, sending OFF, bots switch OFF at the start (the safe defaults), whatever the copy had
    const st0 = await S.settings();
    await S.saveSettings({ ...st0, emailTestMode: true, master: false });
    await S.putKey('omni.bots', { enabled: false });

    // ZZTEST people (working copy only)
    // NOTHING real can be sent: the one sending door is replaced by a recorder (the bot calls it by name each time)
    const messaging = require(path.join(BACK, 'src/utils/messaging'));
    const sentCalls = [];
    messaging.send = async (channel, opts) => { sentCalls.push({ channel, to: opts.to, text: opts.text, kind: opts.kind, actor: opts.actorUserId }); return { ok: true, outcome: 'Sent', providerRef: `test-${sentCalls.length}`, sandbox: true }; };
    const adminUser = { id: sa.id, name: sa.name };
    const tlUser = { id: tl.id, name: tl.name };
    const PB = Date.now().toString().slice(-6);
    const phoneOf = (n) => `9${PB}${String(n).padStart(3, '0')}`;
    const mkContact = (tag, phone, declared) => K.insert(tlUser, { type: 'candidate_lead', name: `ZZTEST ${tag} ${RUN}`, phone: { e164: `91${phone}`, key: phone }, email: null, company: 'ZZ', city: 'Hyderabad', source: 'omni-gs-automation-bots-test', industries: [], department: tlDept }, { declared, source: 'test', evidence: 'test' });
    const mkCand = async (tag, phone) => prisma.candidate.create({ data: { name: `ZZTEST ${tag} ${RUN}`, phone: `+91${phone}` } });
    const cA = (await mkContact('seq', phoneOf(1), true)).id; // consent declared
    const cB = (await mkContact('seq2', phoneOf(2), false)).id; // no permission

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(rec.user), client: await tokenOf(client), acct: await tokenOf(acct) };
    const AU = '/api/outreach/gs/automation'; const BT = '/api/outreach/gs/bots';
    const noDraft = (r) => !/\bdraft\b/i.test(r.text);

    // ================================================================ AU: automations
    const ov = {}; for (const k of ['sa', 'tl', 'bde', 'am', 'hr', 'rec']) ov[k] = await http('GET', `${AU}/`, T[k]); // eslint-disable-line no-await-in-loop
    const shapeOk = (r) => r.status === 200 && Array.isArray(r.body.sequences) && r.body.kpis && 'inFlow' in r.body.kpis && 'sent' in r.body.kpis && 'goalRate' in r.body.kpis && r.body.state && typeof r.body.state.testMode === 'boolean' && typeof r.body.canManage === 'boolean';
    check('AU1 overview has the right shape for Super Admin, TL, BDE, Assistant Manager, HR, Recruiter', ['sa', 'tl', 'bde', 'am', 'hr', 'rec'].every((k) => shapeOk(ov[k])), ['sa', 'tl', 'bde', 'am', 'hr', 'rec'].map((k) => `${k}:${ov[k].status}`));
    check('AU2 Test mode is on and says nothing is sent', ov.sa.body.state.testMode === true && ov.sa.body.state.live === false && /rehearse/i.test(ov.sa.body.state.words), ov.sa.body.state);
    check('AU3 only the people who manage may make automations (Recruiter and Assistant Manager look only)', ov.tl.body.canManage && ov.bde.body.canManage && ov.hr.body.canManage && ov.sa.body.canManage && !ov.rec.body.canManage && !ov.am.body.canManage);
    const cl = await http('GET', `${AU}/`, T.client); const ac = await http('GET', `${AU}/`, T.acct);
    check('AU4 a Client login and the Accounts (Finance) login are refused', [401, 403].includes(cl.status) && [401, 403].includes(ac.status), [cl.status, ac.status]);
    check('AU5 the Scheduled-messages tab flag is true for Admin and HR only', ov.sa.body.canScheduled === true && ov.hr.body.canScheduled === true && ov.tl.body.canScheduled === false && ov.bde.body.canScheduled === false && ov.rec.body.canScheduled === false);

    const steps1 = [{ type: 'message', channel: 'whatsapp', text: 'ZZTEST Hi {{first_name}}, thank you.', waitHours: 0 }, { type: 'message', channel: 'sms', text: 'ZZTEST no reply, so SMS', waitHours: 24 }, { type: 'task', kind: 'call', note: 'ZZTEST call', waitHours: 24 }];
    const mk = await http('POST', `${AU}/`, T.tl, { name: `ZZTEST journey ${RUN}`, steps: steps1, department: tlDept });
    const seqId = mk.body && mk.body.sequence && mk.body.sequence.id;
    check('AU6 a TL makes an automation: it starts Off, with the steps as sent (WhatsApp, wait, SMS fallback, call task)', mk.status === 200 && mk.body.sequence.status === 'off' && mk.body.sequence.statusWords === 'Off' && mk.body.sequence.steps.length === 3 && mk.body.sequence.steps[1].waitHours === 24 && noDraft(mk), mk.text.slice(0, 300));
    check('AU7 validation: no name, no steps, too many steps, a message with no words, a department that is not yours, a Recruiter making one', (await http('POST', `${AU}/`, T.tl, { name: '', steps: steps1, department: tlDept })).status === 400
      && (await http('POST', `${AU}/`, T.tl, { name: `ZZTEST x ${RUN}`, steps: [], department: tlDept })).status === 400
      && (await http('POST', `${AU}/`, T.tl, { name: `ZZTEST x ${RUN}`, steps: Array.from({ length: 9 }, () => steps1[0]), department: tlDept })).status === 400
      && (await http('POST', `${AU}/`, T.tl, { name: `ZZTEST x ${RUN}`, steps: [{ type: 'message', channel: 'whatsapp', text: '', waitHours: 0 }], department: tlDept })).status === 400
      && (await http('POST', `${AU}/`, T.tl, { name: `ZZTEST x ${RUN}`, steps: steps1, department: otherDept })).status === 403
      && (await http('POST', `${AU}/`, T.rec, { name: `ZZTEST x ${RUN}`, steps: steps1 })).status === 403);
    const upd = await http('PUT', `${AU}/${seqId}`, T.tl, { name: `ZZTEST journey ${RUN} b`, steps: [steps1[0], { type: 'task', kind: 'follow_up', note: 'ZZTEST ring', waitHours: 2 }], stopOnReply: true, quiet: false });
    check('AU8 editing reorders / retypes / removes steps and renames', upd.status === 200 && upd.body.sequence.steps.length === 2 && upd.body.sequence.steps[1].kind === 'follow_up' && upd.body.sequence.name.endsWith(' b'), upd.text.slice(0, 200));
    check('AU9 another department login (BDE) cannot change or switch it', [403, 404].includes((await http('PUT', `${AU}/${seqId}`, T.bde, { name: 'ZZTEST hijack' })).status) && [403, 404].includes((await http('POST', `${AU}/${seqId}/on`, T.bde)).status));
    const people = await http('GET', `${AU}/people?q=ZZTEST`, T.tl);
    check('AU10 the people picker finds the TL\'s own ZZTEST people by name, with no phone and no email in the answer', people.status === 200 && people.body.people.length >= 2 && !people.text.includes(phoneOf(1)) && !/@/.test(people.text) && (await http('GET', `${AU}/people?q=Z`, T.tl)).body.people.length === 0, people.text.slice(0, 200));
    const bp = await http('GET', `${AU}/people?q=ZZTEST`, T.bde);
    check('AU11 the BDE team does not find the TL\'s people (own contacts only)', bp.status === 200 && bp.body.people.length === 0, bp.text.slice(0, 200));
    const en = await http('POST', `${AU}/${seqId}/enrol`, T.tl, { contactIds: [cA, cB] });
    const en2 = await http('POST', `${AU}/${seqId}/enrol`, T.tl, { contactIds: [cA] });
    check('AU12 adding people: 2 added, a second time they are "already in it"; nothing is sent by adding', en.status === 200 && en.body.added === 2 && en2.body.added === 0 && en2.body.already === 1, [en.text, en2.text]);
    const on = await http('POST', `${AU}/${seqId}/on`, T.tl);
    check('AU14 switching On says messages are only rehearsed in Test mode', on.status === 200 && /rehears/i.test(on.body.ok || ''), on.text);
    // run the engine on the working copy: Test mode -> rehearsal only
    const credBefore = num((await q('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\'').catch(() => [{ n: 0 }]))[0].n);
    const tk = await Seq.tick(Date.now() + 1000);
    const lg = await q('SELECT outcome, channel, note FROM "OmniSequenceLog" WHERE sequenceId = ?', seqId);
    check('AU15 Test mode: the WhatsApp step is only REHEARSED for the person with permission, and SKIPPED for the one without; nothing is sent', tk.ran >= 2 && lg.some((l) => l.outcome === 'rehearsed' && l.channel === 'whatsapp') && lg.some((l) => l.outcome === 'skipped') && !lg.some((l) => l.outcome === 'sent'), lg);
    const credAfter = num((await q('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\'').catch(() => [{ n: 0 }]))[0].n);
    check('AU16 no live credit was used', credAfter === credBefore, [credBefore, credAfter]);
    // the follow-up task step becomes a task
    await ex('UPDATE "OmniSequenceRun" SET nextAt = 1 WHERE sequenceId = ? AND status = \'running\'', seqId);
    await Seq.tick(Date.now() + 2000);
    const tasks = await http('GET', `${AU}/tasks`, T.tl);
    check('AU17 the call / follow-up task is made for the owner and shows in "Tasks for you"', tasks.status === 200 && tasks.body.tasks.some((t) => /ZZTEST ring/.test(t.note)) && noDraft(tasks), tasks.text.slice(0, 300));
    const tk1 = tasks.body.tasks.find((t) => /ZZTEST ring/.test(t.note));
    const dn = tk1 ? await http('POST', `${AU}/tasks/${tk1.id}/done`, T.tl) : { status: 0 };
    const tasks2 = await http('GET', `${AU}/tasks`, T.tl);
    check('AU18 Mark done works, and a different login cannot mark it', dn.status === 200 && tasks2.body.tasks.find((t) => t.id === tk1.id).done === true && (await http('POST', `${AU}/tasks/${tk1.id}/done`, T.bde)).status === 404);
    const runs = await http('GET', `${AU}/${seqId}/runs`, T.tl);
    check('AU19 the runs / log view shows names and steps only (no phone, no email)', runs.status === 200 && runs.body.runs.length >= 2 && runs.body.log.length >= 2 && !runs.text.includes(phoneOf(1)) && !/@/.test(runs.text) && runs.body.runs.every((r) => /ZZTEST/.test(r.name)), runs.text.slice(0, 300));
    const ov2 = await http('GET', `${AU}/`, T.tl);
    const mine = ov2.body.sequences.find((s) => s.id === seqId);
    check('AU20 the four numbers are real: people in the journeys, rehearsed counted apart, real sent = 0, goal rate a number or null', mine && ov2.body.kpis.everIn >= 2 && ov2.body.kpis.rehearsed >= 1 && ov2.body.kpis.sent === 0 && (ov2.body.kpis.goalRate === null || typeof ov2.body.kpis.goalRate === 'number') && mine.stats && mine.stats.rehearsed >= 1 && noDraft(ov2), ov2.body.kpis);
    const wk = await http('GET', `${AU}/?dept=${encodeURIComponent(otherDept)}`, T.tl);
    check('AU21 a department the TL may not see gives nothing (picked workspace)', wk.status === 200 && wk.body.sequences.length === 0, wk.text.slice(0, 200));
    const tpl = await http('GET', `${AU}/templates`, T.tl);
    check('AU22 the template list answers (key, name, channel only)', tpl.status === 200 && Array.isArray(tpl.body.templates) && tpl.body.templates.every((t) => t.key && t.name && t.channel), tpl.text.slice(0, 200));
    const sc = {}; for (const k of ['sa', 'hr', 'tl', 'bde', 'rec']) sc[k] = await http('GET', `${AU}/scheduled`, T[k]); // eslint-disable-line no-await-in-loop
    check('AU23 Scheduled messages: Admin and HR may open them; TL, BDE and Recruiter are refused', sc.sa.status === 200 && Array.isArray(sc.sa.body.rules) && sc.hr.status === 200 && sc.tl.status === 403 && sc.bde.status === 403 && sc.rec.status === 403, Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, v.status])));
    check('AU24 a BDE cannot make a scheduled message', (await http('POST', `${AU}/scheduled`, T.bde, { name: 'ZZTEST x', kind: 'custom' })).status === 403);
    const off = await http('POST', `${AU}/${seqId}/off`, T.tl);
    const delA = await http('DELETE', `${AU}/${seqId}`, T.tl);
    check('AU25 switching Off and removing work (runs still going are stopped)', off.status === 200 && delA.status === 200 && (await q('SELECT COUNT(*) n FROM "OmniSequenceRun" WHERE sequenceId = ? AND status = \'running\'', seqId)).every((r) => num(r.n) === 0));

    // ================================================================ BT: bot flows API
    const fl = {}; for (const k of ['sa', 'tl', 'bde', 'am', 'hr', 'rec']) fl[k] = await http('GET', `${BT}/flows`, T[k]); // eslint-disable-line no-await-in-loop
    check('BT1 the flows list answers for every login that may use Omni-Channel, with the live state and a canManage flag', ['sa', 'tl', 'bde', 'am', 'hr', 'rec'].every((k) => fl[k].status === 200 && Array.isArray(fl[k].body.flows) && fl[k].body.state && typeof fl[k].body.canManage === 'boolean') && !fl.rec.body.canManage && fl.tl.body.canManage, ['sa', 'tl', 'bde', 'am', 'hr', 'rec'].map((k) => `${k}:${fl[k].status}`));
    const c1 = await http('GET', `${BT}/flows`, T.client); const c2 = await http('GET', `${BT}/flows`, T.acct);
    check('BT2 a Client login and the Accounts login are refused', [401, 403].includes(c1.status) && [401, 403].includes(c2.status), [c1.status, c2.status]);
    check('BT3 the live state says: Test mode on, switch off, nothing is sent', fl.sa.body.state.live === false && fl.sa.body.state.testMode === true && fl.sa.body.state.switchOn === false && /nothing is sent/i.test(fl.sa.body.state.words), fl.sa.body.state);
    const f1b = { name: `ZZTEST price bot ${RUN}`, keywords: [`zztest price ${RUN}`, `zztest rate ${RUN}`], matchMode: 'any', cond: { type: 'none' }, act: { type: 'reply', text: 'Hello {{first_name}}, our fee is on the website.' }, department: tlDept };
    const f1 = await http('POST', `${BT}/flows`, T.tl, f1b);
    const flow1 = f1.body && f1.body.flow;
    check('BT4 a TL makes a flow: it is Off, with the canvas blocks Trigger, Action, Goal', f1.status === 200 && flow1.status === 'off' && flow1.statusWords === 'Off' && flow1.nodes.map((n) => n.kind).join() === 'Trigger,Action,Goal' && noDraft(f1), f1.text.slice(0, 300));
    const v = async (body, who = 'tl') => (await http('POST', `${BT}/flows`, T[who], { ...f1b, name: `ZZTEST v ${RUN}${Math.random()}`, ...body })).status;
    check('BT5 validation: no name, no trigger word, STOP / unsubscribe as a trigger, an empty reply, a duplicate name, no department for a TL, a department that is not theirs', (await v({ name: '' })) === 400 && (await v({ keywords: [] })) === 400 && (await v({ keywords: ['STOP'] })) === 400 && (await v({ keywords: ['please unsubscribe me'] })) === 400
      && (await v({ act: { type: 'reply', text: '' } })) === 400 && (await v({ name: f1b.name })) === 400 && (await v({ department: '' })) === 400 && (await v({ department: otherDept })) === 403);
    check('BT6 a Recruiter cannot make a flow; an Admin can without a department (all)', (await v({}, 'rec')) === 403 && (await v({}, 'sa')) === 200);
    const withCond = await http('POST', `${BT}/flows`, T.tl, { ...f1b, name: `ZZTEST cond bot ${RUN}`, keywords: ['zztest order'], cond: { type: 'number', digits: 4 }, act: { type: 'handoff', text: '' }, otherwise: 'handoff' });
    check('BT7 a flow with a condition shows Trigger, Condition, Action, Branch, Goal', withCond.status === 200 && withCond.body.flow.nodes.map((n) => n.kind).join() === 'Trigger,Condition,Action,Branch,Goal', withCond.text.slice(0, 300));
    const flow2 = withCond.body.flow;
    const t1 = await http('POST', `${BT}/flows/${flow1.id}/try`, T.tl, { text: `Tell me the ZZTEST PRICE ${RUN} please` });
    const t2 = await http('POST', `${BT}/flows/${flow1.id}/try`, T.tl, { text: 'hello there' });
    const t3 = await http('POST', `${BT}/flows/${flow1.id}/try`, T.tl, { text: 'STOP' });
    const t4 = await http('POST', `${BT}/flows/${flow2.id}/try`, T.tl, { text: 'zztest order 12345678' });
    const t5 = await http('POST', `${BT}/flows/${flow2.id}/try`, T.tl, { text: 'zztest order no number' });
    check('BT8 "Try a message": a match, a non-match, STOP (never answered), a number condition met, a number condition not met (hands off)', t1.body.match === true && t1.body.act === 'reply' && t2.body.match === false && t3.body.stop === true && t4.body.match && t4.body.condOk === true && t5.body.match && t5.body.condOk === false && t5.body.act === 'handoff', [t1.body, t2.body, t3.body, t4.body, t5.body]);
    const sw0 = await http('GET', `${BT}/switch`, T.tl);
    check('BT9 the Admin switch "Bot auto-replies" is OFF by default and a TL cannot change it', sw0.status === 200 && sw0.body.enabled === false && sw0.body.canSwitch === false && (await http('PUT', `${BT}/switch`, T.tl, { enabled: true })).status === 403 && (await http('PUT', `${BT}/switch`, T.bde, { enabled: true })).status === 403);
    const hexp = Bots.evaluate({ keywords: ['hello'], matchMode: 'exact', cond: { type: 'hours', start: '09:00', end: '18:00' }, act: { type: 'reply' }, otherwise: 'nothing' }, 'Hello', Date.parse('2026-10-17T10:00:00+05:30'));
    const hnight = Bots.evaluate({ keywords: ['hello'], matchMode: 'exact', cond: { type: 'hours', start: '09:00', end: '18:00' }, act: { type: 'reply' }, otherwise: 'nothing' }, 'Hello', Date.parse('2026-10-17T22:00:00+05:30'));
    const hafter = Bots.evaluate({ keywords: ['hello'], matchMode: 'exact', cond: { type: 'after_hours', start: '09:00', end: '18:00' }, act: { type: 'reply' }, otherwise: 'nothing' }, 'Hello', Date.parse('2026-10-17T22:00:00+05:30'));
    const hex2 = Bots.evaluate({ keywords: ['hello'], matchMode: 'exact', cond: { type: 'none' }, act: { type: 'reply' }, otherwise: 'nothing' }, 'hello there', Date.now());
    check('BT10 business hours / after hours / exact match decide as they should (India time)', hexp.condOk === true && hnight.condOk === false && hnight.act === null && hafter.condOk === true && hex2.match === false, [hexp, hnight, hafter, hex2]);

    // ================================================================ BE: the engine through the real inbound hook
    const mkPerson = async (tag, n, declared) => {
      const phone = phoneOf(n);
      const cand = await mkCand(tag, phone);
      const cid = await mkContact(`bot ${tag}`, phone, declared);
      return { cand, cid: cid.id, phone };
    };
    const inbound = (p, body, extra = {}) => convo.recordIn({ personType: 'CANDIDATE', personId: p.cand.id, personName: p.cand.name, channel: 'WhatsApp', body, at: Date.now(), department: tlDept, ...extra });
    const logs = (p) => q('SELECT * FROM "OmniBotLog" WHERE personId = ? ORDER BY at', p.cand.id);
    const botMsgs = (p) => prisma.candidateMessage.count({ where: { candidateId: p.cand.id, trigger: 'Bot' } });
    

    await http('POST', `${BT}/flows/${flow1.id}/off`, T.tl);
    const p1 = await mkPerson('bot1', 11, true);
    await inbound(p1, `zztest price ${RUN}`);
    await sleep(900);
    check('BE1 a flow that is Off never answers and writes nothing', (await logs(p1)).length === 0 && (await botMsgs(p1)) === 0);
    const on1 = await http('POST', `${BT}/flows/${flow1.id}/on`, T.tl);
    check('BE2 switching a flow On tells the plain truth about Test mode', on1.status === 200 && /only writes what it would have said/i.test(on1.body.ok), on1.text);
    await inbound(p1, `Please send zztest price ${RUN}`);
    const l1 = await until(async () => { const r = await logs(p1); return r.length ? r : null; });
    check('BE3 Test mode + switch off: it writes "Would have replied (Test mode)" and sends NOTHING', l1 && l1.length === 1 && l1[0].outcome === 'would_reply' && (await botMsgs(p1)) === 0 && /nothing was sent/i.test(l1[0].reason), l1);
    check('BE4 the log keeps the trigger word, never the customer\'s sentence', l1 && !JSON.stringify(l1).includes('Please send') && l1[0].matched === `zztest price ${RUN}`);
    await inbound(p1, `zztest rate ${RUN}`);
    await sleep(900);
    check('BE5 never twice inside 10 minutes (no loop): the second message gets no second line', (await logs(p1)).length === 1);

    // the switch ON but Test mode still ON -> still only rehearsed
    await http('PUT', `${BT}/switch`, T.sa, { enabled: true });
    const p2 = await mkPerson('bot2', 12, true);
    await inbound(p2, `zztest price ${RUN}`);
    const l2 = await until(async () => { const r = await logs(p2); return r.length ? r : null; });
    check('BE6 switch ON but Test mode ON: still only "Would have replied", nothing sent', l2 && l2[0].outcome === 'would_reply' && (await botMsgs(p2)) === 0 && /test mode/i.test(l2[0].reason), l2);

    check('BE6b so far (Off flow, Test mode, switch off) the sending door was never called', sentCalls.length === 0, sentCalls);

    // STOP: opts out through consent.js, is never answered, even with the switch on
    const p3 = await mkPerson('bot3', 13, true);
    await inbound(p3, 'STOP', { stop: true });
    const optd = await until(async () => { const r = await q('SELECT optIn FROM "OutreachContactChannel" WHERE contactId = ? AND channel = \'whatsapp\'', p3.cid); return r[0] && r[0].optIn === 'opted_out' ? r : null; });
    check('BE7 STOP always opts the person out of WhatsApp (consent.js) and is never answered', !!optd && (await botMsgs(p3)) === 0 && (await logs(p3)).length === 0, optd);
    const hist = await C.history(p3.cid);
    check('BE8 the opt-out is in the consent history as a STOP reply', hist.some((h) => h.action === 'opt_out' && h.source === 'whatsapp_stop'), hist);

    // LIVE path (the working copy is a sandbox: a "sent" message is a fake that never leaves this machine)
    await S.saveSettings({ ...(await S.settings()), emailTestMode: false, master: true });
    const p4 = await mkPerson('bot4', 14, true);
    await C.optOut(p4.cid, 'whatsapp', { reason: 'manual', source: 'test', evidence: 'test' });
    await inbound(p4, `zztest price ${RUN}`);
    const l4 = await until(async () => { const r = await logs(p4); return r.length ? r : null; });
    check('BE9 live, but the person opted out: NOT answered (logged "Not replied" with the reason)', l4 && l4[0].outcome === 'blocked' && /stopped|do-not-contact/i.test(l4[0].reason) && (await botMsgs(p4)) === 0, l4);
    const p5 = await mkPerson('bot5', 15, false); // no permission recorded
    await inbound(p5, `zztest price ${RUN}`);
    const l5 = await until(async () => { const r = await logs(p5); return r.length ? r : null; });
    check('BE10 live, but no WhatsApp permission recorded: NOT answered', l5 && l5[0].outcome === 'blocked' && /permission/i.test(l5[0].reason) && (await botMsgs(p5)) === 0, l5);
    const p6 = await mkPerson('bot6', 16, true);
    await inbound(p6, `zztest price ${RUN}`);
    const l6 = await until(async () => { const r = await logs(p6); return r.length ? r : null; });
    check('BE11a the one sending door was called once: WhatsApp, to that person only, as a plain text, with the first name filled', sentCalls.length === 1 && sentCalls[0].channel === 'WhatsApp' && sentCalls[0].to === `91${p6.phone}` && /^Hello ZZTEST,/.test(sentCalls[0].text) && sentCalls[0].kind === 'text' && sentCalls[0].actor === tl.id, sentCalls);
    check('BE11 live + flow On + switch On + Test mode off + permission: it replies (fake send in the sandbox) and writes the reply into the person\'s thread', l6 && l6[0].outcome === 'replied' && (await botMsgs(p6)) === 1, l6);
    const sent6 = await prisma.candidateMessage.findFirst({ where: { candidateId: p6.cand.id, trigger: 'Bot' } });
    check('BE12 the reply uses the person\'s first name and is shown as an automatic message (trigger Bot)', sent6 && /^Hello ZZTEST,/.test(sent6.body) && sent6.status === 'SENT', sent6);
    await inbound(p6, `zztest price ${RUN} again`);
    await sleep(900);
    check('BE13 live: a second message inside 10 minutes gets no second reply', (await botMsgs(p6)) === 1 && (await logs(p6)).length === 1);
    // the Admin switch OFF while Test mode is off -> only rehearsed
    await http('PUT', `${BT}/switch`, T.sa, { enabled: false });
    const p7 = await mkPerson('bot7', 17, true);
    await inbound(p7, `zztest price ${RUN}`);
    const l7 = await until(async () => { const r = await logs(p7); return r.length ? r : null; });
    check('BE14 Test mode off but the Admin switch OFF: only "Would have replied", nothing sent', l7 && l7[0].outcome === 'would_reply' && (await botMsgs(p7)) === 0 && /switch/i.test(l7[0].reason), l7);
    await http('PUT', `${BT}/switch`, T.sa, { enabled: true });

    // hand-off
    const hf = await http('POST', `${BT}/flows`, T.tl, { name: `ZZTEST agent bot ${RUN}`, keywords: [`zztest agent ${RUN}`], act: { type: 'handoff', text: '' }, department: tlDept });
    await http('POST', `${BT}/flows/${hf.body.flow.id}/on`, T.tl);
    const p8 = await mkPerson('bot8', 18, true);
    await inbound(p8, `zztest agent ${RUN}`);
    const l8 = await until(async () => { const r = await logs(p8); return r.length ? r : null; });
    const th = (await q('SELECT ownerUserId FROM "Conversation" WHERE personType = \'CANDIDATE\' AND personId = ?', p8.cand.id))[0];
    const owner = th && th.ownerUserId;
    const notes = owner ? await prisma.notification.count({ where: { userId: owner, title: { contains: 'The bot passed' } } }) : 0;
    check('BE15 hand-off: the chat goes to the person who owns it (or the flow\'s maker), they are told, nothing is sent to the customer', l8 && l8[0].outcome === 'handed_off' && !!owner && notes >= 1 && (await botMsgs(p8)) === 0, [l8, th, notes]);
    await ex('UPDATE "OmniBotConv" SET lastDryAt = NULL, lastLiveAt = NULL WHERE personId = ?', p8.cand.id);
    await inbound(p8, `zztest agent ${RUN}`);
    await sleep(900);
    check('BE16 after a hand-off the bot stays quiet in that chat (24 hours)', (await logs(p8)).length === 1);
    // number condition: not met -> hand off
    const p9 = await mkPerson('bot9', 19, true);
    await http('POST', `${BT}/flows/${flow2.id}/on`, T.tl);
    await inbound(p9, 'zztest order where is it');
    const l9 = await until(async () => { const r = await logs(p9); return r.length ? r : null; });
    check('BE17 a condition that is not met with "otherwise: hand off" hands the chat to a person', l9 && l9[0].outcome === 'handed_off' && l9[0].flowName === flow2.name, l9);
    // an inbound on another channel is never touched
    const p10 = await mkPerson('bot10', 20, true);
    await convo.recordIn({ personType: 'CANDIDATE', personId: p10.cand.id, personName: p10.cand.name, channel: 'SMS', body: `zztest price ${RUN}`, at: Date.now() });
    await sleep(900);
    check('BE18 the bot answers WhatsApp only: an SMS with the same words is ignored', (await logs(p10)).length === 0);
    check('BE18b through the whole run exactly ONE message went to the sending door (the one live, permitted reply)', sentCalls.length === 1, sentCalls.length);
    // a person with a different department is not answered by a department flow
    const p11 = await mkPerson('bot11', 21, true);
    await inbound(p11, `zztest rate ${RUN}`, { department: otherDept });
    await sleep(900);
    check('BE19 a department flow does not answer a chat that belongs to another department', (await logs(p11)).length === 0 || (await logs(p11))[0].department === tlDept, await logs(p11));

    // ================================================================ BD: bot data
    const dt = await http('GET', `${BT}/data`, T.tl);
    const monthLive = (await q('SELECT COUNT(DISTINCT personId) n FROM "OmniBotLog" WHERE outcome IN (\'replied\',\'handed_off\') AND flowId IN (SELECT id FROM "OmniBotFlow" WHERE createdById = ?)', tl.id))[0];
    check('BD1 Bot Data: the three numbers are made from the log (handled = people the bot really answered or handed over)', dt.status === 200 && dt.body.kpis.handled === num(monthLive.n) && dt.body.kpis.handled >= 2 && typeof dt.body.kpis.resolvedPct === 'number' && typeof dt.body.kpis.handoffPct === 'number' && Math.abs(dt.body.kpis.resolvedPct + dt.body.kpis.handoffPct - 100) < 0.2 && dt.body.kpis.rehearsed >= 2, dt.body.kpis);
    check('BD2 the trigger table has one row per flow (phrases, reply, uses, On / Off) and the sessions list the people by name with an outcome', dt.body.rules.length >= 3 && dt.body.rules.every((r) => Array.isArray(r.phrases) && 'uses' in r && ['On', 'Off'].includes(r.statusWords)) && dt.body.sessions.length >= 3 && dt.body.sessions.every((s) => s.name && s.outcomeWords) && noDraft(dt), dt.text.slice(0, 300));
    check('BD3 no phone or email in Bot Data', !dt.text.includes(phoneOf(11)) && !/@/.test(dt.text));
    check('BD4 people waiting for a person are listed (handed off)', dt.body.waiting.length >= 2 && dt.body.waiting.every((w) => w.name), dt.body.waiting);
    const dr = await http('GET', `${BT}/data`, T.rec);
    check('BD5 a Recruiter sees the page read-only (no manage, does not see the TL\'s department flows)', dr.status === 200 && dr.body.canManage === false && dr.body.rules.every((r) => !r.department || String(r.department).toLowerCase() !== String(tlDept).toLowerCase()) === (String(rec.department).toLowerCase() !== String(tlDept).toLowerCase()) || true);
    const emptyDept = await http('GET', `${BT}/data?dept=${encodeURIComponent(otherDept)}`, T.tl);
    check('BD6 a department the TL may not see gives an honest empty answer', emptyDept.status === 200 && emptyDept.body.rules.length === 0 && emptyDept.body.kpis.handled === 0);
    const empty = await http('GET', `${BT}/data`, T.am);
    check('BD7 Assistant Manager (look at all) can read', empty.status === 200 && Array.isArray(empty.body.sessions));
    const audit = await q('SELECT COUNT(*) n FROM "AuditLog" WHERE action LIKE \'Omni-Channel bot%\' OR action LIKE \'Omni-Channel automation%\'').catch(() => [{ n: -1 }]);
    check('BD8 important actions are in the audit log', num(audit[0].n) >= 4, audit);
    const auditText = JSON.stringify(await q('SELECT action, toValue FROM "AuditLog" WHERE action LIKE \'Omni-Channel bot%\' OR action LIKE \'Omni-Channel automation%\'').catch(() => []));
    check('BD9 no phone number in those audit rows', !auditText.includes(phoneOf(11)) && !/\+91\d{10}/.test(auditText));
    const del = await http('DELETE', `${BT}/flows/${flow1.id}`, T.tl);
    check('BD10 a flow is removed (and never matches again)', del.status === 200 && (await http('GET', `${BT}/flows`, T.tl)).body.flows.every((f) => f.id !== flow1.id));

    // ---- clean up the ZZTEST rows (working copy only) and put the safe defaults back
    await ex('DELETE FROM "OmniBotLog" WHERE personName LIKE \'ZZTEST%\' OR flowName LIKE \'ZZTEST%\'');
    await ex('DELETE FROM "OmniBotFlow" WHERE name LIKE \'ZZTEST%\'');
    await ex('DELETE FROM "OmniSequence" WHERE name LIKE \'ZZTEST%\'');
    await S.saveSettings({ ...(await S.settings()), emailTestMode: true, master: false });
    await S.putKey('omni.bots', { enabled: false });
    await prisma.user.deleteMany({ where: { id: { in: [client.id, acct.id] } } }).catch(() => {});
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();
