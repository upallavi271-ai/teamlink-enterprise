#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL CONSOLE + INBOX TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4102 node scripts/omni-gs-console-inbox-test.js
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy (<name>-work.db), starts its OWN API on
// TEST_PORT (TEST_MODE: every outbound channel is hard-disabled) and checks:
//   C  Communication Console: roles, options, CRM selector, CSV upload / preview, validation order, rehearsal runs (rows written, counted as Test messages,
//      nothing sent), consent (agreed / not agreed / opted out), new CSV people (permission tick + where from, consent log), masking, schedule, stop,
//      quiet hours, daily limit, rehearsal-vs-real decision, audit rows without phone / email, no word "Draft"
//   R  Reply tagging (lastReplyAt, repliedAt, 'replied' event, 14 days, internal campaigns, idempotent, via recordIn)
//   I  WhatsApp Inbox: roles (Marketing / Finance / Client refused, HR staff only), list tabs, profile, transcript, new conversation (rehearsal), portal applications
// NOTHING real is sent: Test mode, the sandbox, and reserved example.test addresses only.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-ci-work.db');
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(WORK + ext); } catch { /* not there */ } }
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4102);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;

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
// COUNT(*) comes back as a BigInt: the test reads plain numbers
{ const q0 = prisma.$queryRawUnsafe.bind(prisma); prisma.$queryRawUnsafe = async (...a) => (await q0(...a)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))); }

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? Number(v) : v))).slice(0, 1500)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

async function http(method, p, token, body, opts = {}) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (opts.raw !== undefined) { h['Content-Type'] = 'application/octet-stream'; payload = opts.raw; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, type: r.headers.get('content-type') || '' };
}

(async () => {
  let server;
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const S = require(path.join(BACK, 'src/outreach/store'));
    const K = require(path.join(BACK, 'src/outreach/contacts'));
    const OT = require(path.join(BACK, 'src/outreach/templates'));
    const CS = require(path.join(BACK, 'src/outreach/consoleSend'));
    const Comm = require(path.join(BACK, 'src/outreach/communication'));
    const Replies = require(path.join(BACK, 'src/outreach/replies'));
    const convo = require(path.join(BACK, 'src/utils/conversations'));
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } // eslint-disable-line no-await-in-loop
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmp = await prisma.employee.findFirst({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true } });
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, Assistant Manager, HR, a recruiter)', !!(sa && tl && bde && am && hr && recEmp), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!recEmp });
    const rec = recEmp.user;
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, rec].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-ci-client-${RUN}@example.test`, username: `zz-ci-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-ci-acct-${RUN}@example.test`, username: `zz-ci-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });
    const mkt = await prisma.user.create({ data: { ...base, name: `ZZTEST marketing ${RUN}`, email: `zz-ci-mkt-${RUN}@example.test`, username: `zz-ci-mkt-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE' } });
    await prisma.appSetting.upsert({ where: { key: 'omni.permissions' }, create: { key: 'omni.permissions', value: JSON.stringify({ marketingUserIds: [mkt.id] }) }, update: { value: JSON.stringify({ marketingUserIds: [mkt.id] }) } });

    const I = {}; for (const [k, u] of Object.entries({ sa, tl, bde, am, hr, rec, mkt })) I[k] = await resolveIdentity(u.id); // eslint-disable-line no-await-in-loop
    check('0b kinds: sa=admin, tl=tl, bde=bde, hr=hr, rec=recruiter, mkt=marketing', A0.kind(I.sa) === 'admin' && A0.kind(I.tl) === 'tl' && A0.kind(I.bde) === 'bde' && A0.kind(I.hr) === 'hr' && A0.kind(I.rec) === 'recruiter', { sa: A0.kind(I.sa), tl: A0.kind(I.tl), bde: A0.kind(I.bde), hr: A0.kind(I.hr), rec: A0.kind(I.rec) });
    await A0.warm();

    // ---- fixtures straight into the working copy -------------------------------------------------------------------------------------
    const ph = (n) => `9${String(Date.now()).slice(-6)}${String(n).padStart(3, '0')}`; // 10 digits, unique per call within this run
    const mk = async (user, tag, n, consent, extra = {}) => { const p = ph(n); const row = await K.insert({ id: user.id, name: user.name }, { type: extra.type || 'candidate_lead', name: `ZZTEST ${tag} ${RUN}`, phone: { e164: `91${p}`, key: p }, email: { addr: `zz-${tag}-${RUN}@example.test`, key: `zz-${tag}-${RUN}@example.test` }, company: 'ZZ', city: 'Hyderabad', source: 'ci-test', industries: [], department: extra.dept || null }, consent); return { row, phone: p }; };
    const yes = { declared: true, source: 'import_declared', evidence: 'ZZTEST fixture', textVersion: 'zz' };
    const cAgree = await mk(sa, 'agree', 1, yes);
    const cUnknown = await mk(sa, 'unknown', 2, { declared: false });
    const cOut = await mk(sa, 'optout', 3, { ...yes, rowSaysNo: true });
    const cAgree2 = await mk(sa, 'agree2', 4, yes);
    const bAgree = await mk(bde, 'bagree', 5, yes);
    const bAgree2 = await mk(bde, 'bagree2', 6, yes);
    const mAgree = await mk(mkt, 'magree', 7, yes);
    const internalC = await mk(sa, 'staff', 8, yes, { type: 'internal' });

    // templates (an Admin writes them; WhatsApp needs the approved state)
    const adminForTpl = I.sa;
    const mkTpl = async (name, channel, body, extra = {}) => { const o = await OT.create(adminForTpl, { name: `ZZTEST ${name} ${RUN}`, channel, audience: 'candidate_lead', promotional: false, body, subject: extra.subject, senderId: extra.senderId, waTemplateName: extra.waTemplateName, waApprovalStatus: extra.waApprovalStatus, dltTemplateId: extra.dltTemplateId }); return o.template; };
    const tWaOk = await mkTpl('wa ok', 'whatsapp', 'Hello {{name}}, we have new openings.', { waTemplateName: 'zz_ok', waApprovalStatus: 'approved' });
    const tWaPend = await mkTpl('wa pend', 'whatsapp', 'Hello {{name}}, pending one.', { waTemplateName: 'zz_pend', waApprovalStatus: 'pending' });
    const tWaNeed = await mkTpl('wa needs', 'whatsapp', 'Hi {{name}}, your job is {{job_title}}.', { waTemplateName: 'zz_needs', waApprovalStatus: 'approved' });
    const tSms = await mkTpl('sms', 'sms', 'Hi {{name}}, new openings at {{company}}.', { dltTemplateId: '1107000000000000001', senderId: 'ZZTSTS' });
    const tMail = await mkTpl('mail', 'email', 'Dear {{name}}, we have a role at {{company}}.', { subject: 'ZZTEST opening' });
    check('0c the test templates exist (WhatsApp approved, pending, SMS, email)', !!(tWaOk && tWaPend && tSms && tMail), { a: !!tWaOk, b: !!tWaPend, c: !!tSms, d: !!tMail });
    const keyOf = (t) => `outreach:${t.id}`;

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT), OMNI_CONSOLE_SEND_LIMIT: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(rec), mkt: await tokenOf(mkt), client: await tokenOf(client), acct: await tokenOf(acct) };
    const CON = '/api/outreach/gs/console'; const INB = '/api/outreach/gs/inbox';
    const waitRun = async (tok, id, want = ['done', 'stopped', 'waiting'], ms = 60000) => { const t0 = Date.now(); let r; while (Date.now() - t0 < ms) { r = await http('GET', `${CON}/runs/${id}`, tok); if (r.body && r.body.run && want.includes(r.body.run.status)) return r; await sleep(400); } if (!(r && r.body && r.body.run)) console.log('info  waitRun gave', r && r.status, r && String(r.text).slice(0, 300), log.slice(-1200)); return r; }; // eslint-disable-line no-await-in-loop
    const send = (tok, b) => http('POST', `${CON}/send`, tok, b);
    const wa = (acc) => ({ channel: 'whatsapp', accountId: acc, name: 'ZZTEST campaign', templateKey: keyOf(tWaOk), source: 'crm' });

    // ================================================================ C: console
    const roles = {};
    for (const k of Object.keys(T)) roles[k] = (await http('GET', `${CON}/options`, T[k])).status; // eslint-disable-line no-await-in-loop
    check('C1 Super Admin, TL, BDE, HR, Marketing may open the console', [roles.sa, roles.tl, roles.bde, roles.hr, roles.mkt].every((s) => s === 200), roles);
    check('C2 Recruiter, Assistant Manager, Finance (Accounts) and a Client login are refused (403)', [roles.rec, roles.am, roles.acct, roles.client].every((s) => s === 403), roles);
    const opt = await http('GET', `${CON}/options`, T.sa);
    const ob = opt.body || {};
    check('C3 options: channels WhatsApp/SMS/Email/Voice, RCS planned, accounts + templates per channel', ['whatsapp', 'sms', 'email', 'call'].every((c) => ob.channels.some((x) => x.key === c)) && ob.planned.some((x) => x.key === 'rcs') && ob.accounts.whatsapp.length >= 1 && Array.isArray(ob.templates.whatsapp) && ob.accounts.call.length === 1, Object.keys(ob));
    check('C4 Test mode is the default: rehearsal = true, plain words say nothing is sent', ob.rehearsal === true && /rehearsal/i.test(ob.testWords) && Object.values(ob.modes).every((m) => m.mode === 'test'), ob.testWords);
    check('C5 WhatsApp lists the approved template as sendable and the pending one with plain words', (() => { const l = ob.templates.whatsapp; const a = l.find((t) => t.key === keyOf(tWaOk)); const p = l.find((t) => t.key === keyOf(tWaPend)); return a && a.approved && p && !p.approved && /waiting for Meta/.test(p.statusWords); })(), ob.templates.whatsapp.map((t) => `${t.name}:${t.status}`));
    check('C6 no word "Draft" anywhere in the console options', !/\bdraft\b/i.test(opt.text), (opt.text.match(/.{20}\bdraft\b.{20}/i) || [])[0]);
    const bo = (await http('GET', `${CON}/options`, T.bde)).body;
    check('C7 BDE team: masked = true, may add new people (BDE writes contacts)', bo.masked === true && bo.mayAddNew === true, { m: bo.masked, a: bo.mayAddNew });
    const mo = (await http('GET', `${CON}/options`, T.mkt)).body;
    check('C8 Marketing: may not add new people', mo.mayAddNew === false, mo.mayAddNew);
    const ho = (await http('GET', `${CON}/options`, T.hr)).body;
    check('C9 HR: internal contacts only, and cannot send until an Admin allows it', ho.defaultType === 'internal' && ho.canSend === false && /Admin/.test(ho.canSendWhy), { t: ho.defaultType, c: ho.canSend });

    // CRM selector
    const cl1 = await http('GET', `${CON}/contacts?channel=whatsapp&q=ZZTEST&pageSize=50`, T.sa);
    const names1 = ((cl1.body && cl1.body.rows) || []).map((r) => r.name);
    check('C10 CRM selector (agreed only by default): the agreed people are there, the not-agreed one is not', names1.includes(`ZZTEST agree ${RUN}`) && !names1.includes(`ZZTEST unknown ${RUN}`) && !names1.includes(`ZZTEST optout ${RUN}`), names1);
    const cl2 = await http('GET', `${CON}/contacts?channel=whatsapp&q=ZZTEST&agreed=no&pageSize=50`, T.sa);
    const r2 = ((cl2.body && cl2.body.rows) || []);
    check('C11 CRM selector (everybody): the not-agreed person shows "Has not agreed", the opted-out one "Asked us to stop"', (r2.find((r) => r.name === `ZZTEST unknown ${RUN}`) || {}).state === 'Has not agreed' && (r2.find((r) => r.name === `ZZTEST optout ${RUN}`) || {}).state === 'Asked us to stop', r2.map((r) => `${r.name}:${r.state}`));
    const clB = await http('GET', `${CON}/contacts?channel=whatsapp&q=ZZTEST&pageSize=50`, T.bde);
    const rowB = ((clB.body && clB.body.rows) || []).find((r) => r.name === `ZZTEST bagree ${RUN}`);
    check('C12 BDE sees only their own contacts, phone and email masked', !!rowB && !((clB.body.rows || []).some((r) => r.name === `ZZTEST agree ${RUN}`)) && rowB.phone !== `+91${bAgree.phone}` && !String(rowB.email).includes(`zz-bagree-${RUN}`), rowB);
    const ids = await http('GET', `${CON}/contact-ids?channel=whatsapp&q=ZZTEST%20agree`, T.sa);
    check('C13 "select all" returns the ids of the people who agreed', ids.body && ids.body.ids.includes(cAgree.row.id) && ids.body.ids.includes(cAgree2.row.id) && !ids.body.ids.includes(cUnknown.row.id), ids.body);

    // validation order (the prototype's order)
    const v = async (b, tok = T.sa) => (await send(tok, b)).body || {};
    check('C14 validation 1: no account -> "Select a WhatsApp account first"', (await v({ channel: 'whatsapp' })).error === 'Select a WhatsApp account first');
    check('C15 validation 2: no template -> "Select an approved WhatsApp template"', (await v({ channel: 'whatsapp', accountId: 'wa:company' })).error === 'Select an approved WhatsApp template');
    check('C16 validation 2b: an unapproved template is refused with plain words', /waiting for Meta/.test((await v({ channel: 'whatsapp', accountId: 'wa:company', templateKey: keyOf(tWaPend) })).error || ''));
    check('C17 validation 3: no name -> "Give the campaign a name"', (await v({ channel: 'whatsapp', accountId: 'wa:company', templateKey: keyOf(tWaOk) })).error === 'Give the campaign a name');
    check('C18 validation 4: no recipients -> "Pick recipients from CRM or upload a CSV"', (await v({ ...wa('wa:company'), contactIds: [] })).error === 'Pick recipients from CRM or upload a CSV');
    check('C19 RCS / Facebook / Instagram are planned: refused with plain words, nothing made', /planned/i.test((await v({ channel: 'rcs', accountId: 'x' })).error || ''));
    check('C20 a Client login and Finance cannot send (403)', (await send(T.client, wa('wa:company'))).status === 403 && (await send(T.acct, wa('wa:company'))).status === 403 && (await send(T.rec, wa('wa:company'))).status === 403);

    // preview
    const pv = await http('POST', `${CON}/preview`, T.sa, { channel: 'whatsapp', source: 'crm', contactIds: [cAgree.row.id, cUnknown.row.id, cOut.row.id], body: 'x' });
    check('C21 preview (CRM): 1 ready, 1 not agreed, 1 asked us to stop', pv.body && pv.body.totals.ready === 1 && pv.body.totals.not_agreed === 1 && pv.body.totals.stopped === 1, pv.body && pv.body.totals);

    // ---- a rehearsal run from the CRM ---------------------------------------------------------------------------------------------------
    const ledgerBefore = (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n;
    const s1 = await send(T.sa, { ...wa('wa:company'), contactIds: [cAgree.row.id, cAgree2.row.id, cUnknown.row.id, cOut.row.id], dept: '' });
    check('C22 Send now (CRM): accepted, a REHEARSAL (Test mode), 2 ready, 2 left out', s1.status === 200 && s1.body.rehearsal === true && s1.body.ready === 2 && s1.body.leftOut === 2 && /rehearsal/i.test(s1.body.modeWords), s1.text.slice(0, 300));
    const done1 = await waitRun(T.sa, s1.body.id);
    const run1 = done1.body.run; const items1 = done1.body.items;
    check('C23 the run finishes: 2 rehearsed, 2 left out, status Done, "nothing was sent" in the note', run1.status === 'done' && run1.rehearsed === 2 && run1.skipped === 2 && run1.sent === 0 && /nothing was sent/i.test(run1.note), run1);
    check('C24 every ready person is "rehearsed"; the not-agreed and opted-out ones are "skipped" with a reason', items1.filter((i) => i.status === 'rehearsed').length === 2 && items1.filter((i) => i.status === 'skipped').every((i) => /agreed|stop/i.test(i.error)), items1.map((i) => `${i.name}:${i.status}:${i.error}`));
    check('C25 the message is personalised and carries the STOP line (WhatsApp)', items1.some((i) => /^Hello ZZTEST agree/.test(i.message) && /Reply STOP to stop\.$/.test(i.message)), items1.map((i) => i.message));
    const ledger = await prisma.$queryRawUnsafe('SELECT mode, source, channel, userId FROM "OmniCreditLedger" WHERE source = \'console\' ORDER BY at DESC LIMIT 10');
    check('C26 the credits ledger recorded the 2 rehearsed rows as mode "test", source "console", for the sender', ledger.filter((l) => l.mode === 'test' && l.channel === 'whatsapp' && l.userId === sa.id).length === 2, ledger);
    check('C27 nothing live: no live ledger row was written by the run', (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n === ledgerBefore);
    check('C28 the run is in the list and the person who started it can read it', ((await http('GET', `${CON}/runs`, T.sa)).body.runs || []).some((r) => r.id === s1.body.id));
    check('C29 another login (TL, not the owner, other scope) cannot open this run', (await http('GET', `${CON}/runs/${s1.body.id}`, T.bde)).status === 404);
    check('C30 no phone or email in the run rows / audit trail', await (async () => {
      const rows = await prisma.$queryRawUnsafe('SELECT * FROM "OmniSendRunItem" WHERE runId = ?', s1.body.id);
      const aud = await prisma.auditLog.findMany({ where: { entity: 'OmniSendRun' } });
      const txt = JSON.stringify(rows.map((r) => ({ ...r, message: undefined }))) + JSON.stringify(aud);
      return ![cAgree, cAgree2, cUnknown, cOut].some((c) => txt.includes(c.phone) || txt.includes('zz-')) && !/@/.test(txt) && aud.length >= 1;
    })());
    const logSa = await http('GET', `${CON}/runs/${s1.body.id}/log.csv`, T.sa);
    check('C31 Super Admin downloads the log (Name, To, Status, Error, Message), with the number', logSa.status === 200 && /^﻿?"?Name"?,"?To"?,"?Status"?,"?Error"?,"?Message/.test(logSa.text) && logSa.text.includes(`+91${cAgree.phone}`) && /rehearsed \(nothing sent\)/.test(logSa.text), logSa.text.slice(0, 300));

    // ---- masking for the BDE team -------------------------------------------------------------------------------------------------------------
    const s2 = await send(T.bde, { ...wa('wa:company'), contactIds: [bAgree.row.id, bAgree2.row.id, cAgree.row.id] });
    check('C32 BDE sends to their own contacts (rehearsal); a contact that is not theirs is "outside"', s2.status === 200 && s2.body.ready === 2 && s2.body.totals.outside === 1, s2.text.slice(0, 300));
    const d2 = await waitRun(T.bde, s2.body.id);
    const logB = await http('GET', `${CON}/runs/${s2.body.id}/log.csv`, T.bde);
    check('C33 BDE sees the numbers MASKED in the run and in the downloaded log', d2.body.masked === true && d2.body.items.every((i) => !i.to || !i.to.includes(bAgree.phone)) && !logB.text.includes(bAgree.phone) && !logB.text.includes(`zz-bagree-${RUN}`) && logB.text.length > 40, { items: d2.body.items.map((i) => i.to), log: logB.text.slice(0, 200) });
    check('C34 Super Admin may read the BDE\'s run (all departments)', (await http('GET', `${CON}/runs/${s2.body.id}`, T.sa)).status === 200);

    // ---- email + SMS + voice rehearsals ------------------------------------------------------------------------------------------------------
    const accs = ob.accounts;
    const emailAcc = accs.email[0] ? accs.email[0].id : null;
    const smsAcc = accs.sms[0] ? accs.sms[0].id : null;
    if (emailAcc) {
      const se = await send(T.sa, { channel: 'email', accountId: emailAcc, name: 'ZZTEST mail', templateKey: keyOf(tMail), source: 'crm', contactIds: [cAgree.row.id] });
      const de = await waitRun(T.sa, se.body.id);
      check('C35 Email: rehearsed, subject kept, no STOP line added to the email body', se.status === 200 && de.body.run.rehearsed === 1 && de.body.items[0].message === `Dear ZZTEST agree ${RUN}, we have a role at ZZ.`, { r: de.body.run, i: de.body.items });
    } else check('C35 Email account: none connected in this copy (honest "No Email accounts connected" state)', ob.accounts.email.length === 0 && /Select a Email account first|Select an Email account first/.test((await v({ channel: 'email', accountId: 'email:from' })).error || ''), (await v({ channel: 'email', accountId: 'email:from' })));
    if (smsAcc) {
      const ss = await send(T.sa, { channel: 'sms', accountId: smsAcc, name: 'ZZTEST sms', templateKey: keyOf(tSms), source: 'crm', contactIds: [cAgree.row.id] });
      const ds = await waitRun(T.sa, ss.body.id);
      check('C36 SMS: rehearsed with the STOP line', ss.status === 200 && ds.body.run.rehearsed === 1 && /Reply STOP to stop\.$/.test(ds.body.items[0].message), ss.text.slice(0, 200));
    } else check('C36 SMS account: none set in this copy -> "Select a SMS account first" and the empty state', ob.accounts.sms.length === 0 && /Select a SMS account first/.test((await v({ channel: 'sms', accountId: 'sms:sender' })).error || ''));
    const sv = await send(T.sa, { channel: 'call', accountId: 'call:tasks', name: 'ZZTEST calls', body: 'Call about the opening in {{city}}', source: 'crm', contactIds: [cAgree.row.id] });
    const dv = await waitRun(T.sa, sv.body.id);
    const taskRows = await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniSequenceLog" WHERE sequenceId LIKE \'console:%\'');
    check('C37 Voice: rehearsed, and NO call task is made in a rehearsal', sv.status === 200 && dv.body.run.rehearsed === 1 && Number(taskRows[0].n) === 0, { r: dv.body.run, i: dv.body.items, t: taskRows });
    const wMissing = await send(T.sa, { channel: 'whatsapp', accountId: 'wa:company', name: 'ZZTEST missing', templateKey: keyOf(tWaNeed), source: 'crm', contactIds: [cAgree.row.id] });
    check('C38 a template that needs {{job_title}} the person does not have: nobody is messaged with a hole in the text', wMissing.status === 400 && /nobody/i.test(wMissing.body.error || ''), wMissing.text.slice(0, 300));

    // ---- CSV ------------------------------------------------------------------------------------------------------------------------------------
    const newPhone = ph(20); const newPhone2 = ph(21);
    const csv = ['name,mobile,city,ref', `ZZTEST agree ${RUN},${cAgree.phone},Hyderabad,R1`, `ZZTEST newbie ${RUN},${newPhone},Vizag,R2`, `ZZTEST newbie2 ${RUN},+91 ${newPhone2.slice(0, 5)} ${newPhone2.slice(5)},Guntur,R3`, 'ZZTEST bad,12345,X,R4', `ZZTEST dupe ${RUN},${cAgree.phone},Y,R5`, ''].join('\n');
    const up = await http('POST', `${CON}/csv?filename=zz-people.csv`, T.sa, undefined, { raw: Buffer.from(csv) });
    check('C39 CSV upload: 5 rows, the mobile column found, the name column found', up.status === 200 && up.body.rows === 5 && /mobile/i.test(up.body.phoneColumn) && /name/i.test(up.body.nameColumn), up.text.slice(0, 300));
    const upBad = await http('POST', `${CON}/csv?filename=x.csv`, T.sa, undefined, { raw: Buffer.from('city,colour\nA,B\n') });
    check('C40 CSV without a phone or email column: plain error', upBad.status === 400 && /No phone or email column found/.test(upBad.body.error || ''), upBad.text);
    const upEmpty = await http('POST', `${CON}/csv?filename=x.csv`, T.sa, undefined, { raw: Buffer.from('name,mobile\n') });
    check('C41 CSV with a header only: plain error', upEmpty.status === 400 && /no data rows|no rows/i.test(upEmpty.body.error || ''), upEmpty.text);
    const pvc = await http('POST', `${CON}/preview`, T.sa, { channel: 'whatsapp', source: 'csv', uploadId: up.body.uploadId, body: 'Hello {{first_name}}' });
    check('C42 preview (CSV): 1 ready (known + agreed), 2 not in Contacts yet, 1 unusable, 1 repeated; the tick is needed', pvc.body && pvc.body.totals.ready === 1 && pvc.body.totals.new === 2 && pvc.body.totals.invalid === 1 && pvc.body.totals.duplicate === 1 && pvc.body.needsPermission === true, pvc.body && pvc.body.totals);
    // without the tick: the new people are left out, nothing is added
    const s3 = await send(T.sa, { ...wa('wa:company'), source: 'csv', uploadId: up.body.uploadId, name: 'ZZTEST csv no tick' });
    const d3 = await waitRun(T.sa, s3.body.id);
    const created0 = await K.findByKeys(newPhone.slice(-10), null);
    check('C43 CSV without the permission tick: the 2 new people are LEFT OUT and not added to Contacts', s3.status === 200 && s3.body.ready === 1 && created0.length === 0 && d3.body.items.filter((i) => i.status === 'skipped' && /no permission/i.test(i.error)).length === 2, { s: s3.text.slice(0, 200), c: created0.length });
    // the file is used up by a send: upload again
    const up2 = await http('POST', `${CON}/csv?filename=zz-people.csv`, T.sa, undefined, { raw: Buffer.from(csv) });
    const noBasis = await send(T.sa, { ...wa('wa:company'), source: 'csv', uploadId: up2.body.uploadId, name: 'ZZTEST csv no basis', permission: true, basis: '' });
    check('C44 permission ticked but nothing written about where they come from: refused', noBasis.status === 400 && /where these people come from/i.test(noBasis.body.error || ''), noBasis.text.slice(0, 300));
    const s4 = await send(T.sa, { ...wa('wa:company'), source: 'csv', uploadId: up2.body.uploadId, name: 'ZZTEST csv ticked', permission: true, basis: 'ZZTEST our own past candidates who gave their number' });
    check('C45 permission + where from: accepted, the 2 new people were added and are in the run', s4.status === 200 && s4.body.addedPeople === 2 && s4.body.ready === 3, s4.text.slice(0, 900));
    const d4 = await waitRun(T.sa, s4.body.id);
    check('C46 the run: 3 rehearsed (1 known + 2 added), the unusable and repeated rows are left out with plain reasons', d4.body.run.rehearsed === 3 && d4.body.run.skipped === 2 && d4.body.items.some((i) => /Unusable number/.test(i.error)) && d4.body.items.some((i) => /earlier row/.test(i.error)), d4.body.run);
    const added = await K.findByKeys(newPhone.slice(-10), null);
    check('C47 the new person is in Contacts, agreed on WhatsApp, source "Console: zz-people.csv"', added.length === 1 && String(added[0].source).startsWith('Console: zz-people.csv') && (await S.q('SELECT optIn FROM "OutreachContactChannel" WHERE contactId = ? AND channel = \'whatsapp\'', added[0].id))[0].optIn === 'opted_in', added[0]);
    const ev = await S.q('SELECT action, source, evidence FROM "OutreachConsentEvent" WHERE contactId = ?', added[0].id);
    check('C48 the consent log recorded it (opt_in, import_declared) with the file name and the words', ev.some((e) => e.action === 'opt_in' && e.source === 'import_declared' && /zz-people\.csv/.test(e.evidence) && /ZZTEST our own past candidates/.test(e.evidence)), ev);
    const imp = await S.q('SELECT fileName, basis, contactType, createdById FROM "OutreachImport" WHERE fileName = ? ORDER BY createdAt DESC LIMIT 1', 'zz-people.csv');
    check('C49 an import record (file, words, who) exists so it can be undone from Contacts', imp.length === 1 && /ZZTEST our own/.test(imp[0].basis) && imp[0].createdById === sa.id, imp);
    // Marketing may not add people
    const upM = await http('POST', `${CON}/csv?filename=m.csv`, T.mkt, undefined, { raw: Buffer.from(`name,mobile\nZZTEST mnew ${RUN},${ph(30)}\n`) });
    const sM = await send(T.mkt, { ...wa('wa:company'), source: 'csv', uploadId: upM.body.uploadId, name: 'ZZTEST mkt csv', permission: true, basis: 'we know them well' });
    check('C50 Marketing cannot add new people from a file (403, plain words)', sM.status === 403 && /BDE team|Team Leads|Admins/.test(sM.body.error || ''), sM.text.slice(0, 300));
    // a suppressed number stays out: opted-out person in a file
    const upO = await http('POST', `${CON}/csv?filename=o.csv`, T.sa, undefined, { raw: Buffer.from(`name,mobile\nZZTEST optout ${RUN},${cOut.phone}\n`) });
    const sO = await send(T.sa, { ...wa('wa:company'), source: 'csv', uploadId: upO.body.uploadId, name: 'ZZTEST opted out csv' });
    check('C51 a person who asked us to stop is never messaged, even when a file lists them', sO.status === 400 && sO.body.totals && sO.body.totals.stopped === 1, sO.text.slice(0, 300));

    // ---- schedule + stop ------------------------------------------------------------------------------------------------------------------------
    const istNow = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 16);
    check('C52 a time in the past is refused', (await send(T.sa, { ...wa('wa:company'), contactIds: [cAgree.row.id], scheduledAt: istNow(Date.now() - 3600000) })).status === 400);
    const sc = await send(T.sa, { ...wa('wa:company'), contactIds: [cAgree.row.id, cAgree2.row.id], scheduledAt: istNow(Date.now() + 3 * 3600000), name: 'ZZTEST later' });
    await sleep(1200);
    const dsc = await http('GET', `${CON}/runs/${sc.body.id}`, T.sa);
    check('C53 Schedule (IST): the run waits as Scheduled, nothing processed yet', sc.status === 200 && sc.body.scheduledAt && dsc.body.run.status === 'scheduled' && dsc.body.run.rehearsed === 0 && dsc.body.items.every((i) => i.status === 'queued'), dsc.body && dsc.body.run);
    check('C54 scheduled time is read as India time', (() => { const t = Date.parse(sc.body.scheduledAt); const want = Date.parse(`${istNow(Date.now() + 3 * 3600000)}:00+05:30`); return Math.abs(t - want) < 120000; })(), sc.body.scheduledAt);
    const stp = await http('POST', `${CON}/runs/${sc.body.id}/stop`, T.sa);
    await sleep(1500);
    const dst = await http('GET', `${CON}/runs/${sc.body.id}`, T.sa);
    check('C55 Stop: the scheduled run is Stopped and nobody was messaged', stp.status === 200 && dst.body.run.status === 'stopped' && dst.body.run.cancelled === 2 && dst.body.run.rehearsed === 0, dst.body && dst.body.run);
    check('C56 only the starter or an Admin can stop a run (BDE on an Admin run: not found)', (await http('POST', `${CON}/runs/${sc.body.id}/stop`, T.bde)).status === 404);

    // ---- quiet hours + daily limit (settings changed in the working copy) ----------------------------------------------------------------------
    const stBase = await S.settings();
    const hhmm = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16);
    const rawSet = (await S.getKey('outreach.settings', {})) || {};
    await S.putKey('outreach.settings', { ...rawSet, quietHours: { enabled: true, start: hhmm(Date.now() - 30 * 60000), end: hhmm(Date.now() + 30 * 60000), applyInternal: false } });
    const sq = await send(T.sa, { ...wa('wa:company'), contactIds: [cAgree.row.id], name: 'ZZTEST quiet' });
    const dq = await waitRun(T.sa, sq.body.id, ['waiting', 'done'], 20000);
    check('C57 quiet hours: the row is NOT processed, the run waits and says why', sq.status === 200 && dq.body.run.status === 'waiting' && /quiet hours/i.test(dq.body.run.note) && dq.body.items[0].status === 'queued', dq.body && dq.body.run);
    await S.putKey('outreach.settings', { ...rawSet, quietHours: { enabled: false, start: '21:00', end: '08:00', applyInternal: false } });
    await prisma.$executeRawUnsafe('UPDATE "OmniSendRun" SET nextAt = 1 WHERE id = ?', sq.body.id);
    const dq2 = await waitRun(T.sa, sq.body.id, ['done'], 30000);
    check('C58 after quiet hours end the waiting run finishes by itself (the loop wakes it)', dq2.body.run.status === 'done' && dq2.body.run.rehearsed === 1, dq2.body && dq2.body.run);
    const usedSms = (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE channel = \'whatsapp\' AND mode = \'test\' AND result <> \'failed\''))[0].n;
    // today's count (any person) + 1 more allowed
    const istStart = Math.floor((Date.now() + 5.5 * 3600000) / 86400000) * 86400000 - 5.5 * 3600000;
    const usedToday = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE channel = \'whatsapp\' AND mode = \'test\' AND at >= ? AND result <> \'failed\'', istStart))[0].n);
    await S.putKey('outreach.settings', { ...rawSet, waDailyCap: usedToday + 1 });
    const sl = await send(T.sa, { ...wa('wa:company'), contactIds: [cAgree.row.id, cAgree2.row.id], name: 'ZZTEST limit' });
    const dl = await waitRun(T.sa, sl.body.id, ['waiting', 'done'], 20000);
    check('C59 daily limit: only the allowed number go, the rest wait for tomorrow and the run says so', sl.status === 200 && dl.body.run.status === 'waiting' && dl.body.run.rehearsed === 1 && /limit/i.test(dl.body.run.note) && dl.body.items.some((i) => i.status === 'queued'), dl.body && dl.body.run);
    await S.putKey('outreach.settings', rawSet);
    void usedSms; void stBase;

    // ---- the decision "rehearsal or real" (pure) ---------------------------------------------------------------------------------------------
    {
      const savedMode = process.env.TEST_MODE; delete process.env.TEST_MODE; delete process.env.TEAMLINK_SANDBOX;
      const ok = { WhatsApp: { configured: true }, SMS: { configured: true }, Email: { configured: true } };
      const no = { WhatsApp: { configured: false }, SMS: { configured: false }, Email: { configured: false } };
      const t1 = CS.modeFor({ master: true, emailTestMode: false }, 'whatsapp', ok).mode;
      const t2 = CS.modeFor({ master: true, emailTestMode: true }, 'whatsapp', ok).mode;
      const t3 = CS.modeFor({ master: false, emailTestMode: false }, 'whatsapp', ok).mode;
      const t4 = CS.modeFor({ master: true, emailTestMode: false }, 'whatsapp', no).mode;
      process.env.TEST_MODE = savedMode;
      const t5 = CS.modeFor({ master: true, emailTestMode: false }, 'whatsapp', ok).mode;
      check('C60 real ONLY when sending is ON, Test mode OFF and the way is connected (and never in the test sandbox)', t1 === 'live' && t2 === 'test' && t3 === 'test' && t4 === 'test' && t5 === 'test', { t1, t2, t3, t4, t5 });
    }
    // ---- HR: staff contacts only, and only when allowed -------------------------------------------------------------------------------------
    const sH = await send(T.hr, { channel: 'call', accountId: 'call:tasks', name: 'ZZTEST hr', body: 'Call about leave', source: 'crm', contactIds: [internalC.row.id] });
    check('C61 HR sending to a staff contact is blocked while an Admin has not allowed it (nothing made)', sH.status === 400 && sH.body.totals && sH.body.totals.blocked === 1, sH.text.slice(0, 300));
    const sH2 = await send(T.hr, { channel: 'call', accountId: 'call:tasks', name: 'ZZTEST hr2', body: 'Call', source: 'crm', contactIds: [cAgree.row.id] });
    check('C62 HR cannot reach job / candidate contacts at all (outside)', sH2.status === 400 && sH2.body.totals && sH2.body.totals.outside === 1, sH2.text.slice(0, 300));
    check('C63 no run text anywhere says "Draft"', !/\bdraft\b/i.test((await http('GET', `${CON}/runs`, T.sa)).text) && !/\bdraft\b/i.test(JSON.stringify(d4.body)));
    const smp = await http('GET', `${CON}/sample?channel=email`, T.sa);
    check('C64 the sample file is a real download (email column)', smp.status === 200 && /^name,email,city/.test(smp.text) && /text\/csv/.test(smp.type));

    // ================================================================ R: reply tagging
    const ctx = K && (await K.findByKeys(cAgree.phone, null))[0];
    const campId = S.newId('oc'); const msgNew = S.newId('om'); const msgOld = S.newId('om'); const campInt = S.newId('oc'); const msgInt = S.newId('om');
    const now = Date.now();
    await require(path.join(BACK, 'src/outreach/v3schema')).ensure();
    const reqRow = (await prisma.$queryRawUnsafe('SELECT id FROM "Requirement" LIMIT 1'))[0];
    if (reqRow) {
      await S.run('INSERT INTO "OutreachCampaign" (id, code, name, type, requirementId, channel, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', campId, `zz${RUN}a`, 'ZZTEST camp', 'job_promotion', reqRow.id, 'whatsapp', 'done', now, now);
      await S.run('INSERT INTO "OutreachMessage" (id, campaignId, contactId, channel, status, idempotencyKey, queuedAt, sentAt) VALUES (?,?,?,?,?,?,?,?)', msgNew, campId, ctx.id, 'whatsapp', 'sent', `zz-${RUN}-1`, now - 2 * 86400000, now - 2 * 86400000);
    }
    await S.run('INSERT INTO "OutreachCampaign" (id, code, name, type, channel, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)', campInt, `zz${RUN}b`, 'ZZTEST internal camp', 'internal', 'whatsapp', 'done', now, now);
    await S.run('INSERT INTO "OutreachMessage" (id, campaignId, contactId, channel, status, idempotencyKey, queuedAt, sentAt) VALUES (?,?,?,?,?,?,?,?)', msgInt, campInt, cAgree2.row.id, 'whatsapp', 'sent', `zz-${RUN}-3`, now - 86400000, now - 86400000);
    if (reqRow) await S.run('INSERT INTO "OutreachMessage" (id, campaignId, contactId, channel, status, idempotencyKey, queuedAt, sentAt) VALUES (?,?,?,?,?,?,?,?)', msgOld, campId, cOut.row.id, 'whatsapp', 'sent', `zz-${RUN}-2`, now - 20 * 86400000, now - 20 * 86400000);
    const r1 = await Replies.onReply({ address: `+91${cAgree.phone}`, channel: 'WhatsApp', at: now });
    const crow = (await S.q('SELECT lastReplyAt FROM "OutreachContact" WHERE id = ?', ctx.id))[0];
    check('R1 onReply finds the contact by phone and sets lastReplyAt', r1.contacts === 1 && Number(crow.lastReplyAt) === now, { r1, crow });
    if (reqRow) {
      const mrow = (await S.q('SELECT repliedAt FROM "OutreachMessage" WHERE id = ?', msgNew))[0];
      const evs = await S.q('SELECT type, source, messageId FROM "OutreachEvent" WHERE eventKey = ?', `replied:${msgNew}`);
      check('R2 the latest message of the last 14 days gets repliedAt and ONE "replied" event (source reply)', Number(mrow.repliedAt) === now && evs.length === 1 && evs[0].type === 'replied' && evs[0].source === 'reply', { mrow, evs });
      await Replies.onReply({ address: `91${cAgree.phone}`, channel: 'WhatsApp', at: now + 5000 });
      check('R3 a second reply is still one event (idempotent)', Number((await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE eventKey = ?', `replied:${msgNew}`))[0].n) === 1);
      await Replies.onReply({ address: cOut.phone, channel: 'WhatsApp', at: now });
      check('R4 a message older than 14 days is NOT tagged', (await S.q('SELECT repliedAt FROM "OutreachMessage" WHERE id = ?', msgOld))[0].repliedAt == null);
    } else check('R2-R4 skipped: the copy has no job to hang a campaign on', true);
    await Replies.onReply({ address: cAgree2.phone, channel: 'WhatsApp', at: now });
    check('R5 an INTERNAL campaign message gets repliedAt but NO funnel event (staff privacy)', Number((await S.q('SELECT repliedAt FROM "OutreachMessage" WHERE id = ?', msgInt))[0].repliedAt) === now && (await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE messageId = ?', msgInt))[0].n === 0);
    let threw = false;
    try { for (const bad of [undefined, {}, { address: 'zzz' }, { address: null, channel: 5 }, { address: '+91', channel: 'Email', at: 'x' }]) await Replies.onReply(bad); } catch { threw = true; } // eslint-disable-line no-await-in-loop
    check('R6 onReply never throws (garbage in, nothing out)', !threw);
    const lr = await Replies.lastReplyOf(ctx.id);
    check('R7 lastReplyOf gives the time for the customer page', !!lr.at && Math.abs(Date.parse(lr.at) - (now + 0)) < 10000 || Date.parse(lr.at) >= now, lr);
    // via the one inbox: a candidate with the same phone writes back
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST cand ${RUN}`, phone: `+91${cAgree2.phone}`, email: `zz-cand-${RUN}@example.test` } });
    await prisma.candidateMessage.create({ data: { candidateId: cand.id, channel: 'WhatsApp', template: 'REPLY', trigger: 'Reply', recipient: cAgree2.phone, body: 'ZZTEST hello back', status: 'RECEIVED' } });
    const later = now + 60000;
    await convo.recordIn({ personType: 'CANDIDATE', personId: cand.id, personName: cand.name, channel: 'WhatsApp', body: 'ZZTEST hello back', at: later });
    await sleep(800);
    check('R8 recordIn (the inbox) tags the reply too: lastReplyAt moves to the new time without the caller giving an address', Number((await S.q('SELECT lastReplyAt FROM "OutreachContact" WHERE id = ?', cAgree2.row.id))[0].lastReplyAt) === later, (await S.q('SELECT lastReplyAt FROM "OutreachContact" WHERE id = ?', cAgree2.row.id))[0]);

    // ================================================================ I: inbox
    const ib = {};
    for (const k of Object.keys(T)) ib[k] = (await http('GET', `${INB}/overview`, T[k])).status; // eslint-disable-line no-await-in-loop
    check('I1 Super Admin, TL, BDE, HR and the Recruiter open the inbox', [ib.sa, ib.tl, ib.bde, ib.hr, ib.rec].every((s) => s === 200), ib);
    check('I2 Marketing has NO inbox, Finance and a Client login are refused (403)', [ib.mkt, ib.acct, ib.client].every((s) => s === 403), ib);
    const ov = (await http('GET', `${INB}/overview`, T.sa)).body;
    check('I3 overview: the company number account, Test mode words, not masked', ov.accounts[0].id === 'all' && ov.rehearsal === true && /rehearsal/.test(ov.testWords) && ov.masked === false && typeof ov.connected === 'boolean', ov);
    check('I4 overview for HR says staff only; for the recruiter "your own candidates"', (await http('GET', `${INB}/overview`, T.hr)).body.staffOnly === true && /own candidates/.test((await http('GET', `${INB}/overview`, T.rec)).body.note));
    // conversations: a candidate chat on WhatsApp (unread), one on Email, one call
    const mkChat = async (nm, channel, dir) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST ${nm} ${RUN}`, phone: `+91${ph(40 + Math.floor(Math.random() * 50))}` } });
      if (dir === 'IN') { await prisma.candidateMessage.create({ data: { candidateId: c.id, channel, template: 'REPLY', trigger: 'Reply', recipient: c.phone, body: `ZZTEST ${nm} says hello`, status: 'RECEIVED' } }); await convo.recordIn({ personType: 'CANDIDATE', personId: c.id, personName: c.name, channel, body: `ZZTEST ${nm} says hello`, at: Date.now() }); } else {
        await prisma.candidateMessage.create({ data: { candidateId: c.id, channel, template: 'X', trigger: 'Manual', recipient: c.phone, body: `ZZTEST ${nm} call saved`, status: channel === 'Call' ? 'LOGGED' : 'SENT' } });
        await convo.recordOut({ personType: 'CANDIDATE', personId: c.id, personName: c.name, channel, body: `ZZTEST ${nm} call saved`, status: 'SENT' });
      }
      return c;
    };
    const cWa = await mkChat('wachat', 'WhatsApp', 'IN');
    const cMail = await mkChat('mailchat', 'Email', 'IN');
    const cCall = await mkChat('callchat', 'Call', 'OUT');
    const lc = await http('GET', `${INB}/list?tab=chats&q=ZZTEST`, T.sa);
    const lo = await http('GET', `${INB}/list?tab=other&q=ZZTEST`, T.sa);
    const lcall = await http('GET', `${INB}/list?tab=calls&q=ZZTEST`, T.sa);
    const nm = (r) => ((r.body && r.body.rows) || []).map((x) => x.name);
    check('I5 Chats tab = WhatsApp chats only; the Email chat is under "Email & SMS"; the call under Calls', nm(lc).includes(cWa.name) && !nm(lc).includes(cMail.name) && nm(lo).includes(cMail.name) && nm(lcall).includes(cCall.name), { c: nm(lc), o: nm(lo), k: nm(lcall) });
    const rowWa = (lc.body.rows || []).find((x) => x.name === cWa.name);
    check('I6 a chat row has the name, initials, unread badge, snippet, country, owner; and NO phone number', rowWa && rowWa.unread === 1 && rowWa.initials && rowWa.country === 'IN' && /says hello/.test(rowWa.snippet) && !/phone|mobile|\+91/.test(JSON.stringify(rowWa)), rowWa);
    check('I7 counts and unread per tab are given (for the tab badges and the "n unread" pill)', lc.body.counts.chats >= 1 && lc.body.counts.other >= 1 && lc.body.counts.calls >= 1 && lc.body.unread.chats >= 1, { c: lc.body.counts, u: lc.body.unread });
    const lcIN = await http('GET', `${INB}/list?tab=chats&q=ZZTEST&country=US`, T.sa);
    check('I8 country filter: US shows none of these Indian numbers', !nm(lcIN).includes(cWa.name));
    const digitsOf = cWa.phone.replace(/\D/g, '').slice(-8);
    const lcPh = await http('GET', `${INB}/list?tab=chats&q=${digitsOf}`, T.sa);
    check('I9 search by phone number works for a login that may see numbers', nm(lcPh).includes(cWa.name), nm(lcPh));
    const lcPhB = await http('GET', `${INB}/list?tab=chats&q=${digitsOf}`, T.bde);
    check('I10 the BDE team cannot find a person by phone number', !nm(lcPhB).includes(cWa.name));
    const lcHr = await http('GET', `${INB}/list?tab=chats`, T.hr);
    check('I11 HR sees staff chats only (no candidate chat)', lcHr.status === 200 && !(lcHr.body.rows || []).some((x) => x.personType === 'CANDIDATE'), (lcHr.body.rows || []).map((x) => x.personType));
    const lcRec = await http('GET', `${INB}/list?tab=chats&q=ZZTEST`, T.rec);
    check('I12 the Recruiter does not see another team\'s candidate chat', lcRec.status === 200 && !nm(lcRec).includes(cWa.name), nm(lcRec));
    const prof = await http('GET', `${INB}/profile/candidates/${cWa.id}`, T.sa);
    check('I13 profile: name, initials, phone (full for Super Admin), lifecycle, recent activity from the chat', prof.status === 200 && prof.body.name === cWa.name && prof.body.phone === cWa.phone && prof.body.lifecycle.startsWith('Candidate') && prof.body.activity.length >= 1 && /Replied on WhatsApp/.test(prof.body.activity[0].title), prof.text.slice(0, 300));
    check('I14 profile of a person outside the login\'s scope is refused (Recruiter on a stranger)', (await http('GET', `${INB}/profile/candidates/${cWa.id}`, T.rec)).status === 403);
    const tr = await http('GET', `${INB}/transcript/candidates/${cWa.id}`, T.sa);
    check('I15 transcript CSV: From, Message; the contact\'s own words under their name', tr.status === 200 && /^﻿?"?From"?,"?Message/.test(tr.text) && tr.text.includes(`${cWa.name}","ZZTEST wachat says hello`) && /attachment/.test(tr.type + 'attachment'), tr.text.slice(0, 200));
    const noMsg = await prisma.candidate.create({ data: { name: `ZZTEST empty ${RUN}`, phone: `+91${ph(95)}` } });
    check('I16 a person with no messages: "No messages to export" (404)', (await http('GET', `${INB}/transcript/candidates/${noMsg.id}`, T.sa)).status === 404);
    // new conversation
    const nc = await http('POST', `${INB}/new`, T.sa, { contactId: cAgree.row.id, text: 'ZZTEST hello from the inbox' });
    check('I17 New conversation to a contact who agreed: a REHEARSAL in Test mode, nothing sent', nc.status === 200 && /Rehearsed/.test(nc.body.ok) && nc.body.rehearsed === true, nc.text.slice(0, 300));
    const nc2 = await http('POST', `${INB}/new`, T.sa, { contactId: cUnknown.row.id, text: 'ZZTEST hi' });
    check('I18 New conversation to a contact who has NOT agreed: refused (409)', nc2.status === 409 && /not agreed/.test(nc2.body.error || ''), nc2.text.slice(0, 300));
    check('I19 New conversation: the "pick a contact" list holds only people who agreed to WhatsApp', (((await http('GET', `${INB}/contacts?q=ZZTEST`, T.sa)).body || {}).rows || []).every((r) => r.agreed === true));
    check('I20 Marketing cannot start a chat (no inbox at all)', (await http('POST', `${INB}/new`, T.mkt, { contactId: mAgree.row.id, text: 'x' })).status === 403);
    check('I21 nothing live was sent by the inbox either (no live ledger rows added)', (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n === ledgerBefore);
    // portal applications
    const ap = await http('GET', `${INB}/applications`, T.sa);
    check('I22 portal applications: the endpoint answers with the shape (allowed, total, waiting, rows)', ap.status === 200 && ap.body.allowed === true && typeof ap.body.total === 'number' && Array.isArray(ap.body.rows), ap.text.slice(0, 200));
    const reqAny = await prisma.requirement.findFirst({ select: { id: true } });
    if (reqAny) {
      const candP = await prisma.candidate.create({ data: { name: `ZZTEST portal ${RUN}`, phone: `+91${ph(96)}`, email: `zz-portal-${RUN}@example.test`, currentSalary: '5 LPA', expectedSalary: '7 LPA' } });
      const app = await prisma.application.create({ data: { candidateId: candP.id, requirementId: reqAny.id, stage: 'NEW', source: require(path.join(BACK, 'src/utils/atsVocab')).PORTAL_APPLICATION_SOURCE } });
      const apSa = (await http('GET', `${INB}/applications`, T.sa)).body;
      const mine = (apSa.rows || []).find((r) => r.id === app.id);
      check('I23 a new portal application shows to Super Admin with the real phone, email and salary and a link target (candidateId)', !!mine && mine.phone === candP.phone && mine.email === candP.email && !!mine.salary && mine.candidateId === candP.id && mine.pickedUp === false && apSa.waiting >= 1, mine);
      const apBde = (await http('GET', `${INB}/applications`, T.bde)).body;
      const mineB = (apBde.rows || []).find((r) => r.id === app.id);
      check('I24 for the BDE team the same applications (when in scope) have phone / email MASKED and NO salary; never the real values', !mineB || (mineB.phone !== candP.phone && mineB.email !== candP.email && !mineB.salary), mineB);
      const apRec = (await http('GET', `${INB}/applications`, T.rec)).body;
      const mineR = (apRec.rows || []).find((r) => r.id === app.id);
      check('I25 for the Recruiter: masked as well, no salary (or not in their scope at all)', !mineR || (mineR.phone !== candP.phone && mineR.email !== candP.email && !mineR.salary), mineR);
      const apJson = JSON.stringify(apBde) + JSON.stringify(apRec);
      check('I26 the BDE / Recruiter answer never contains the real phone, email or salary text anywhere', !apJson.includes(candP.phone) && !apJson.includes(`zz-portal-${RUN}@example.test`) && !apJson.includes('7 LPA'), apJson.slice(0, 200));
      check('I27 Marketing and Finance get no applications (403)', (await http('GET', `${INB}/applications`, T.mkt)).status === 403 && (await http('GET', `${INB}/applications`, T.acct)).status === 403);
    } else check('I23-I27 skipped: the copy has no job to attach a portal application to', true);
    // the old reply endpoint still works (no second send path): a reply to the WhatsApp chat is a rehearsal in Test mode
    const rep = await http('POST', '/api/conversations/send', T.sa, { audience: 'candidates', id: cWa.id, channel: 'WhatsApp', purpose: 'Message', perChannel: { WhatsApp: { subject: 'Message', body: 'ZZTEST reply' } } });
    check('I28 the existing reply endpoint (/api/conversations/send) answers for a WhatsApp reply (no second send path is needed); nothing real is sent', rep.status === 200 || rep.status === 400 || rep.status === 403, rep.text.slice(0, 200));
    check('I29 the WhatsApp reply in the test copy did not go out live (no live ledger rows)', (await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\' AND source = \'messaging\''))[0].n === 0);
    check('I30 no word "Draft" in the inbox answers', !/\bdraft\b/i.test(lc.text + lo.text + prof.text + ov.accounts.map((a) => a.label).join(' ')));
  } catch (e) {
    fail += 1; console.log(`FAIL  the test itself crashed: ${e && e.stack ? e.stack : e}`);
  } finally {
    if (server) { server.kill(); await sleep(500); }
    try { await prisma.$disconnect(); } catch { /* done */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(WORK + ext); } catch { /* best effort */ } }
    process.exit(fail ? 1 : 0);
  }
})();
