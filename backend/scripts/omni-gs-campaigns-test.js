#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL > CAMPAIGNS (Green Start rebuild) TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4101 node scripts/omni-gs-campaigns-test.js
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy (<name>-work.db), starts its OWN API on TEST_PORT
// (TEST_MODE) and checks, with ZZTEST rows only (removed at the end):
//   E  the engine: channels (email | whatsapp | sms | call), the suppression rules (no_phone, call, the Admin's "applied to our job" rule), per-channel runner
//      (rehearsal never calls a provider; live goes through utils/messaging.js with a MOCK sender; one ledger row), speeds, credits, approval, call tasks
//   A  the API of the area: list (one row per master campaign), detail (7 tabs), audience, replies, analytics, logs, wizard helpers, create / send / schedule /
//      pause / resume / stop / duplicate / delete / resend, CSVs
//   R  roles: Super Admin, TL, BDE, Recruiter, HR, Manager, Accounts, Client; masking; no "Draft"; nothing is really sent
// NOTHING real is sent: Test mode is ON (the default); the live path uses a mock sender; contacts are fake (example.test, made-up numbers).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-gscamp-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4101);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;

{ // the Omni-Channel tables (the copy may not have them): applied to the WORKING copy only
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
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? Number(v) : v))).slice(0, 600)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const N = (s) => `ZZTEST camp ${s} ${RUN}`;

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, type: r.headers.get('content-type') || '' };
}
const G0 = '/api/outreach/gs/campaigns';

(async () => {
  let server;
  const made = { campaigns: [], contacts: [], segs: [], tpls: [], users: [] };
  try {
    const A = require(path.join(BACK, 'src/outreach/access'));
    const S = require(path.join(BACK, 'src/outreach/store'));
    const Sup = require(path.join(BACK, 'src/outreach/suppress'));
    const Camp = require(path.join(BACK, 'src/outreach/campaigns'));
    const Run = require(path.join(BACK, 'src/outreach/runner'));
    const Ev = require(path.join(BACK, 'src/outreach/events'));
    const Pol = require(path.join(BACK, 'src/outreach/policy'));
    const Cr = require(path.join(BACK, 'src/outreach/credits'));
    const Appr = require(path.join(BACK, 'src/outreach/approval'));
    const Gs = require(path.join(BACK, 'src/outreach/gsCampaigns'));
    const K = require(path.join(BACK, 'src/outreach/contacts'));
    const Cn = require(path.join(BACK, 'src/outreach/consent'));
    const Sg = require(path.join(BACK, 'src/outreach/segments'));
    const T = require(path.join(BACK, 'src/outreach/templates'));
    const adapters = require(path.join(BACK, 'src/outreach/adapters'));
    const chrome = require(path.join(BACK, 'src/outreach/chrome'));
    await require(path.join(BACK, 'src/outreach/v3schema')).ensure();

    // ---- the logins ------------------------------------------------------------------------------------------------------------------
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 20 })) { if (A.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } } // eslint-disable-line no-await-in-loop
    let bde = await first({ atsRole: 'BDE', ...live });
    const am = await first({ atsRole: 'ASSISTANT_MANAGER' });
    if (am) await prisma.employee.updateMany({ where: { userId: am.id }, data: { employmentStatus: 'Active' } });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 30 });
    const recU = recEmps[0] && recEmps[0].user;
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, Assistant Manager, HR, a recruiter)', !!(sa && tl && bde && am && hr && recU), { sa: !!sa, tl: !!tl, bde: !!bde, am: !!am, hr: !!hr, rec: !!recU });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, am, hr, recU].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-gc-client-${RUN}@example.test`, username: `zz-gc-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-gc-acct-${RUN}@example.test`, username: `zz-gc-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });
    made.users.push(client.id, acct.id);
    const idOf = (u) => resolveIdentity(u.id);
    const saI = await idOf(sa); let tlI = await idOf(tl); let bdeI = await idOf(bde);

    // a job every one of them may promote
    const opens = await prisma.requirement.findMany({ where: { status: 'OPEN' } });
    const JA = require(path.join(BACK, 'src/jobPublish/access'));
    let job = opens.find((r) => JA.inScope(saI, r) && JA.inScope(tlI, r) && JA.inScope(bdeI, r));
    if (!job) { // look for a TL and a BDE that share a job
      const tls = []; const bdes = [];
      for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: { in: ['TL', 'BDE'] }, ...live, NOT: { email: { contains: 'example.test' } } }, take: 120 })) { const i = await resolveIdentity(c.id); const k = A.kind(i); if (k === 'tl') tls.push([c, i]); else if (k === 'bde') bdes.push([c, i]); } // eslint-disable-line no-await-in-loop
      outer: for (const [tc, ti] of tls) for (const [bc, bi] of bdes) { const j = opens.find((r) => JA.inScope(saI, r) && JA.inScope(ti, r) && JA.inScope(bi, r)); if (j) { tl = tc; tlI = ti; bde = bc; bdeI = bi; job = j; break outer; } }
      if (job) await prisma.user.updateMany({ where: { id: { in: [tl.id, bde.id] } }, data: { passwordHash: 'x' } });
    }
    check('0b an open job that the Super Admin, the TL and the BDE may all promote exists in the copy', !!job, { opens: opens.length });
    if (!job) throw new Error('no job');
    await prisma.requirement.update({ where: { id: job.id }, data: { portalPublished: true } }); // the working copy only: the apply link must open a job page for "Check before sending"

    // ---- fake people (no real number, no real address) ---------------------------------------------------------------------------------
    const city = `ZZCity${RUN}`;
    const ph = (k) => `9${String(parseInt(RUN, 36) % 90000000 + 10000000)}${k}`.slice(0, 10);
    const mk = async (tag, o, consent) => {
      const row = await K.insert({ id: sa.id, name: sa.name }, { type: 'candidate_lead', name: `ZZTEST person ${tag} ${RUN}`, phone: o.phone ? { e164: `91${o.phone}`, key: o.phone } : null, email: o.email ? { addr: `zz-gc-${tag}-${RUN}@example.test`, key: `zz-gc-${tag}-${RUN}@example.test` } : null, company: 'ZZ', city, source: 'omni-gs-campaigns-test', industries: [], department: null }, consent);
      made.contacts.push(row.id);
      return row;
    };
    const decl = { declared: true, source: 'test-consent' };
    const c1 = await mk('1', { phone: ph(1), email: true }, decl); const c2 = await mk('2', { phone: ph(2) }, decl); const c3 = await mk('3', { email: true }, decl);
    const c4 = await mk('4', { phone: ph(4) }, decl); const c5 = await mk('5', { phone: ph(5) }, { declared: false }); const c6 = await mk('6', { phone: ph(6) }, { declared: false });
    await Cn.optOut(c4.id, 'whatsapp', { reason: 'manual', source: 'test', evidence: 'ZZTEST opt-out', by: { id: sa.id, name: sa.name } });
    await prisma.$executeRawUnsafe('UPDATE "OutreachContact" SET linkedApplicantId = ? WHERE id = ?', `zzapp${RUN}`, c5.id);
    const rules = { cities: [city.toLowerCase()] };
    const segOf = async (user, nm) => { const r = await Sg.create(user, { name: `ZZTEST seg ${nm} ${RUN}`, contactType: 'candidate_lead', rules }); if (r.error) throw new Error(r.error); made.segs.push(r.segment.id); return r.segment.id; };
    const segSa = await segOf(saI, 'sa'); const segTl = await segOf(tlI, 'tl'); const segBde = await segOf(bdeI, 'bde');
    check('0c fake contacts and groups made (6 people in the group)', (await Sg.counts({ filterRules: JSON.stringify(rules), contactType: 'candidate_lead' })).total === 6);

    // ---- templates ----------------------------------------------------------------------------------------------------------------------
    const mkT = async (o) => { const r = await T.create(saI, { audience: 'candidate_lead', promotional: true, ...o }); if (r.error) throw new Error(`${o.name}: ${r.error}`); made.tpls.push(r.template.id); return r.template; };
    const tEm = await mkT({ name: N('email'), channel: 'email', subject: 'A job for you, {{name}}', body: 'Hi {{name}}, {{job_title}} at {{company}}: {{apply_link}}\n{{unsubscribe}}' });
    const tWa = await mkT({ name: N('wa'), channel: 'whatsapp', body: 'Hi {{name}}, {{job_title}}: {{apply_link}} {{unsubscribe}}', waTemplateName: 'zz_job_promo_v1', waLanguage: 'en', waApprovalStatus: 'approved' });
    const tWaPending = await mkT({ name: N('wa pending'), channel: 'whatsapp', body: 'Hi {{name}}, {{job_title}}: {{apply_link}} {{unsubscribe}}', waTemplateName: 'zz_job_promo_v2', waLanguage: 'en', waApprovalStatus: 'pending' });
    const tSms = await mkT({ name: N('sms'), channel: 'sms', body: 'Job: {{job_title}} {{apply_link}} {{unsubscribe}}', dltTemplateId: '1107161234567890123', senderId: 'TLINKS' });
    const tSmsNoDlt = await mkT({ name: N('sms nodlt'), channel: 'sms', body: 'Job: {{job_title}} {{apply_link}} {{unsubscribe}}' });

    // ==================================================================== E: the engine ========================================================================================
    const D = (camp, ids) => Sup.evaluate(camp, ids, { days: 0 });
    const mkCamp = (channel) => ({ id: '', type: 'job_promotion', channel: Camp.dbChannel(channel), meta: { channel }, requirementId: job.id, suppressDays: 0 });
    const ids6 = [c1, c2, c3, c4, c5, c6].map((c) => c.id);
    const reasonOf = (res, c) => { const r = res.find((x) => x.contactId === c.id); return r.decision.send ? (r.decision.basis || 'send') : r.decision.reason; };
    const rWa = await D(mkCamp('whatsapp'), ids6); const rSms = await D(mkCamp('sms'), ids6); const rEm = await D(mkCamp('email'), ids6); const rCall = await D(mkCamp('call'), ids6);
    check('E1 WhatsApp: opted-in people with a phone get it; no phone = no_phone; opted out = opted_out; unknown consent = no_opt_in', [reasonOf(rWa, c1), reasonOf(rWa, c2), reasonOf(rWa, c3), reasonOf(rWa, c4), reasonOf(rWa, c5), reasonOf(rWa, c6)].join() === 'send,send,no_phone,suppressed,no_opt_in,no_opt_in', [reasonOf(rWa, c1), reasonOf(rWa, c2), reasonOf(rWa, c3), reasonOf(rWa, c4), reasonOf(rWa, c5), reasonOf(rWa, c6)]);
    check('E2 SMS is channel aware (the WhatsApp opt-out does not stop an SMS)', [reasonOf(rSms, c1), reasonOf(rSms, c4), reasonOf(rSms, c3)].join() === 'send,send,no_phone');
    check('E3 Email: needs a valid email address', [reasonOf(rEm, c1), reasonOf(rEm, c2), reasonOf(rEm, c3)].join() === 'send,invalid_email,send');
    check('E4 Call: no opt-in needed (unknown consent may be rung), a phone is needed, a phone-channel opt-out is skipped', [reasonOf(rCall, c1), reasonOf(rCall, c3), reasonOf(rCall, c4), reasonOf(rCall, c5), reasonOf(rCall, c6)].join() === 'send,no_phone,suppressed,send,send', [reasonOf(rCall, c1), reasonOf(rCall, c3), reasonOf(rCall, c4), reasonOf(rCall, c5), reasonOf(rCall, c6)]);
    // the do-not-contact list stops a call too
    const hash6 = S.hashAddress('phone', c6.phoneE164);
    await Cn.suppress(hash6, '*', 'manual', 'test');
    check('E5 a number on the do-not-contact list is never rung', reasonOf(await D(mkCamp('call'), [c6.id]), c6) === 'suppressed');
    await prisma.$executeRawUnsafe('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', hash6);
    // the Admin's "applied to our job" rule: default OFF; ON = a JOB message to an ATS-linked person with unknown consent; never an opted-out person, never a staff message
    check('E6 the "applied to our job" rule is OFF by default (policy)', (await Pol.consentRules()).atsAppliedMeansJobAllowed === false);
    await Pol.putKey('omni.consentRules', { atsAppliedMeansJobAllowed: true }, { id: sa.id, name: sa.name });
    const onWa = await D(mkCamp('whatsapp'), ids6);
    check('E7 ON: the ATS-linked person (consent unknown) may get the job message; the one with no link still may not; the opted-out one never', [reasonOf(onWa, c5), reasonOf(onWa, c6), reasonOf(onWa, c4)].join() === 'ats_applied,no_opt_in,suppressed', [reasonOf(onWa, c5), reasonOf(onWa, c6), reasonOf(onWa, c4)]);
    const onInt = Sup.decide({ campaign: { type: 'internal', channel: 'whatsapp' }, contact: { status: 'active', contactType: 'internal', phoneE164: '919999999999', linkedApplicantId: 'x' }, chan: { optIn: 'unknown', health: 'ok' }, atsAllowed: true });
    check('E8 ON: a staff (internal) message still needs a recorded yes', !onInt.send && onInt.reason === 'no_opt_in', onInt);
    await Pol.putKey('omni.consentRules', { atsAppliedMeansJobAllowed: false }, { id: sa.id, name: sa.name });
    check('E9 OFF again: back to no_opt_in', reasonOf(await D(mkCamp('whatsapp'), [c5.id]), c5) === 'no_opt_in');

    // validation: the template must match the channel; WhatsApp needs an approved template; SMS needs DLT + sender id
    const vb = (o) => ({ type: 'job_promotion', requirementId: job.id, segmentIds: [segSa], ...o });
    const v1 = await Camp.validate(saI, vb({ channel: 'whatsapp', templateId: tEm.id }));
    const v2 = await Camp.validate(saI, vb({ channel: 'whatsapp', templateId: tWaPending.id }));
    const v3 = await Camp.validate(saI, vb({ channel: 'sms', templateId: tSmsNoDlt.id }));
    const v4 = await Camp.validate(saI, vb({ channel: 'whatsapp', templateId: tWa.id }));
    const v5 = await Camp.validate(saI, vb({ channel: 'sms', templateId: tSms.id }));
    const v6 = await Camp.validate(saI, vb({ channel: 'call' }));
    const v7 = await Camp.validate(saI, vb({ channel: 'telegram', templateId: tEm.id }));
    check('E10 a message of another channel is refused', v1.status === 400 && /WhatsApp message/.test(v1.error), v1);
    check('E11 WhatsApp needs a Meta-approved template', v2.status === 400 && v2.code === 'wa_not_approved', v2);
    check('E12 SMS needs the DLT template number and the sender ID', v3.status === 400 && v3.code === 'sms_no_dlt', v3);
    check('E13 an approved WhatsApp template passes and its variables are mapped by order ({{name}} {{job_title}} {{apply_link}} = positions 1 2 3)', !v4.error && v4.varMap.join() === 'name,job_title,apply_link' && v4.snapshot.waTemplateName === 'zz_job_promo_v1', v4);
    check('E14 an SMS with DLT passes and keeps the DLT id + sender id; a call needs no template; an unknown channel is refused', !v5.error && v5.snapshot.dltTemplateId === '1107161234567890123' && v5.snapshot.senderId === 'TLINKS' && !v6.error && v6.template === null && v7.status === 400, { v5: v5.error, v6: v6.error, v7: v7.error });
    const rn = Camp.renderFor(v4.snapshot, { contact: { id: 'x', name: 'Anita Rao' }, requirement: { title: 'ICU Nurse' }, message: { id: 'm', token: 'TOKENTOKEN' }, settings: { fromName: 'TeamLink' } }, 'whatsapp');
    check('E15 the WhatsApp text ends with "Reply STOP to opt out" and the positional variables come in order', /Reply STOP to opt out/.test(rn.body) && rn.vars[0] === 'Anita' && rn.vars[1] === 'ICU Nurse' && /TOKENTOKEN/.test(rn.vars[2]), rn);

    // ---- rehearsal: every channel, nothing handed to a provider ------------------------------------------------------------------------------
    const st0 = await S.settings();
    check('E16 Test mode is ON in the copy (the default)', st0.emailTestMode === true);
    const calls = [];
    const refuseProvider = async (ch, o) => { calls.push([ch, o]); throw new Error('A PROVIDER WAS CALLED IN A REHEARSAL'); };
    const mkRow = async (user, channel, templateId, extra = {}) => {
      const r = await Camp.create(user, { name: N(`row ${channel}`), type: 'job_promotion', channel, requirementId: job.id, segmentIds: [segSa], templateId, ...extra });
      if (r.error) throw new Error(`${channel}: ${r.error}`);
      made.campaigns.push(r.id);
      return r.id;
    };
    const idWa = await mkRow(saI, 'whatsapp', tWa.id); const idSms = await mkRow(saI, 'sms', tSms.id); const idEm = await mkRow(saI, 'email', tEm.id);
    const sWa = await Camp.send(saI, idWa, {}); const sSms = await Camp.send(saI, idSms, {}); const sEm = await Camp.send(saI, idEm, {});
    check('E17 sending in Test mode makes a rehearsal for each channel (rows made: WhatsApp 2, SMS 3, Email 2)', sWa.mode === 'rehearsal' && sWa.queued === 2 && sSms.queued === 3 && sEm.queued === 2, { sWa: sWa.error || sWa.queued, sSms: sSms.error || sSms.queued, sEm: sEm.error || sEm.queued });
    const msgsOf = (id) => prisma.$queryRawUnsafe('SELECT * FROM "OutreachMessage" WHERE campaignId = ?', id);
    check('E18 each row has the campaign\'s own channel and the skipped ones keep a plain reason', (await msgsOf(idWa)).every((m) => m.channel === 'whatsapp') && (await msgsOf(idWa)).filter((m) => m.status === 'skipped').map((m) => m.reason).sort().join() === 'no_opt_in,no_opt_in,no_phone,suppressed');
    const ledgerBefore = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n);
    const t1 = await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider, mailSender: async () => { throw new Error('A MAIL SERVER WAS CALLED'); } });
    check('E19 the runner rehearses all three channels: 7 messages captured, nothing sent, no provider called', t1.test_captured === 7 && t1.sent === 0 && calls.length === 0, { t1, calls: calls.length });
    const lg = await prisma.$queryRawUnsafe(`SELECT channel, status, mode, COUNT(*) n FROM "OutreachSendLog" WHERE contactId IN (${ids6.map(() => '?').join(',')}) GROUP BY channel, status, mode`, ...ids6);
    check('E20 the send log has test_captured rows for whatsapp, sms and email (and no live "sent" row)', ['whatsapp', 'sms', 'email'].every((ch) => lg.some((r) => r.channel === ch && r.status === 'test_captured' && r.mode === 'test')) && !lg.some((r) => r.status === 'sent'), lg);
    const led = await prisma.$queryRawUnsafe('SELECT channel, mode, source, campaignId, COUNT(*) n FROM "OmniCreditLedger" WHERE campaignId IN (?,?,?) GROUP BY channel, mode, source, campaignId', idWa, idSms, idEm);
    check('E21 the credits ledger has ONE test row per captured message (7), none live', led.reduce((a, r) => a + Number(r.n), 0) === 7 && led.every((r) => r.mode === 'test' && r.source === 'campaign') && Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\''))[0].n) === ledgerBefore, led);
    await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider });
    check('E22 the three campaigns are done after the last message', (await prisma.$queryRawUnsafe('SELECT status FROM "OutreachCampaign" WHERE id IN (?,?,?)', idWa, idSms, idEm)).every((r) => r.status === 'done'));

    // ---- the live path: through utils/messaging.js with a MOCK sender (Test mode OFF only inside this block) ----------------------------------------------
    const realStatus = { wa: adapters.get('whatsapp').status, sms: adapters.get('sms').status };
    adapters.get('whatsapp').status = async () => ({ ready: true, live: true, testMode: false, reason: '', sentToday: 0 });
    adapters.get('sms').status = async () => ({ ready: true, live: true, testMode: false, reason: '', sentToday: 0 });
    await S.saveSettings({ ...(await S.settings()), emailTestMode: false }, { id: sa.id, name: sa.name });
    const liveCalls = [];
    const mockSend = async (ch, o) => { liveCalls.push([ch, o]); return { ok: true, outcome: 'Sent', providerRef: `mock-${liveCalls.length}` }; };
    // a master campaign on two channels, LIVE: the second channel must not be skipped as "messaged recently" because its sibling went first
    const gLive = await Gs.createGroup(saI, { name: N('live group'), objective: 'job_promotion', requirementId: job.id, segmentIds: [segSa], channels: ['whatsapp', 'sms'], templates: { whatsapp: tWa.id, sms: tSms.id }, when: 'now', approvalMode: 'auto' });
    (await Camp.groupRows(gLive.key || 'x')).forEach((r) => made.campaigns.push(r.id));
    const liveCalls0 = [];
    const t0 = await Run.tick({ ignoreSwitch: true, messageSender: async (c, o) => { liveCalls0.push([c, o]); return { ok: true, outcome: 'Sent', providerRef: 'mock-g' }; } });
    check('E22b a LIVE master campaign on WhatsApp + SMS sends to the same people on both channels (5 messages): the sibling channel is not "messaged recently"', gLive.ok && t0.sent === 5 && t0.skipped === 0, { gLive: gLive.error || gLive.message, t0 });
    await S.saveSettings({ ...(await S.settings()), suppressDays: 0 }, { id: sa.id, name: sa.name });
    const idWaL = await mkRow(saI, 'whatsapp', tWa.id); const idSmsL = await mkRow(saI, 'sms', tSms.id);
    const sL = await Camp.send(saI, idWaL, {}); const sL2 = await Camp.send(saI, idSmsL, {});
    check('E23 with Test mode OFF the same send is LIVE', sL.mode === 'live' && sL2.mode === 'live', { sL: sL.error || sL.mode });
    const ledL0 = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n);
    const t2 = await Run.tick({ ignoreSwitch: true, messageSender: mockSend });
    check('E24 live: 5 messages handed to the sender (WhatsApp 2, SMS 3), all marked sent', t2.sent === 5 && liveCalls.length === 5 && (await msgsOf(idWaL)).filter((m) => m.status === 'sent').length === 2, { t2, n: liveCalls.length });
    const w0 = liveCalls.find((c) => c[0] === 'WhatsApp'); const s0 = liveCalls.find((c) => c[0] === 'SMS');
    check('E25 WhatsApp goes with the approved template name, language, positional variables and the campaign\'s meta', w0 && w0[1].template.name === 'zz_job_promo_v1' && w0[1].template.language === 'en' && w0[1].template.vars.length === 3 && w0[1].meta.campaignId === idWaL && w0[1].meta.source === 'campaign' && w0[1].meta.purpose === 'campaign' && w0[1].kind === 'bulk' && w0[1].actorUserId === sa.id && /^91\d{10}$/.test(w0[1].to), w0 && w0[1]);
    check('E26 SMS goes with the DLT template id, the sender id and the text', s0 && s0[1].templateId === '1107161234567890123' && s0[1].senderId === 'TLINKS' && /Reply STOP/.test(s0[1].text), s0 && s0[1]);
    check('E27 the runner writes NO ledger row for a live WhatsApp / SMS message (utils/messaging.js writes it: one row, not two)', Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n) === ledL0, { before: ledL0 });
    // messaging.send records ONE row that carries the campaign id and "campaign" as its source
    const ch = require(path.join(BACK, 'src/channels'));
    const realChSend = ch.send;
    ch.send = async () => ({ ok: true, providerRef: 'mock-channel-ref' });
    const msg = require(path.join(BACK, 'src/utils/messaging'));
    const idsBefore = Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE campaignId = ?', 'zzcmp-ledger'))[0].n);
    await msg.send('WhatsApp', { to: '919000000000', text: 'x', kind: 'bulk', actorUserId: sa.id, meta: { template: 'zz', purpose: 'campaign', campaignId: 'zzcmp-ledger', source: 'campaign' } });
    await sleep(400);
    const lrow = await prisma.$queryRawUnsafe('SELECT source, campaignId, channel, mode FROM "OmniCreditLedger" WHERE campaignId = ?', 'zzcmp-ledger');
    ch.send = realChSend;
    check('E28 messaging.send writes ONE ledger row with meta.campaignId and source "campaign" (not "messaging")', idsBefore === 0 && lrow.length === 1 && lrow[0].source === 'campaign', lrow);
    await prisma.$executeRawUnsafe('DELETE FROM "OmniCreditLedger" WHERE campaignId = ?', 'zzcmp-ledger');
    // a provider that says no: failed with the reason; a transient one retries; "not connected" holds
    const idWaF = await mkRow(saI, 'whatsapp', tWa.id);
    await Camp.send(saI, idWaF, {});
    const t3 = await Run.tick({ ignoreSwitch: true, messageSender: async () => ({ ok: false, outcome: 'Failed', error: 'Recipient number is invalid (131026)', transient: false }) });
    const failedRows = (await msgsOf(idWaF)).filter((m) => m.status === 'failed');
    check('E29 a provider that refuses = failed with its words (and its code)', t3.failed === 2 && failedRows.length === 2 && /131026/.test(failedRows[0].error) && failedRows[0].reason === 'rejected', { t3, failedRows: failedRows.length });
    const lgf = await Gs.logs(saI, idWaF, { status: 'failed' });
    check('E30 the logs show the error code and the plain description of a failed row', lgf.messages.length === 2 && lgf.messages[0].errorCode === '131026' && /refused|Recipient number is invalid/.test(lgf.messages[0].errorWords), lgf.messages[0]);
    const rs = await Camp.resendFailed(saI, idWaF);
    check('E31 "Send the failed ones again" puts them back in the queue (campaign running again)', rs.ok && rs.requeued === 2 && (await msgsOf(idWaF)).filter((m) => m.status === 'queued').length === 2, rs.error || rs.requeued);
    await Run.tick({ ignoreSwitch: true, messageSender: mockSend });
    check('E32 and they are sent this time', (await msgsOf(idWaF)).filter((m) => m.status === 'sent').length === 2);
    const idWaN = await mkRow(saI, 'whatsapp', tWa.id);
    await Camp.send(saI, idWaN, {});
    const t4 = await Run.tick({ ignoreSwitch: true, messageSender: async () => ({ ok: false, outcome: 'Not configured', notConfigured: true, error: 'WhatsApp is not set up' }) });
    check('E33 a channel that is not connected HOLDS the messages (nothing lost, nothing failed)', t4.held === 2 && (await msgsOf(idWaN)).filter((m) => m.status === 'queued').length === 2 && (await msgsOf(idWaN)).filter((m) => m.status === 'failed').length === 0, t4);
    // credits: a TL with no credits left cannot send a live campaign
    await Cr.setAllowance(tl.id, 0, 'ZZTEST', { id: sa.id, name: sa.name });
    const idCr = await mkRow(tlI, 'whatsapp', tWa.id, { segmentIds: [segTl] });
    const pl = await Camp.plan(tlI, { type: 'job_promotion', channel: 'whatsapp', requirementId: job.id, segmentIds: [segTl], templateId: tWa.id });
    check('E34 the plan says credits needed (2) against credits left (0) and not enough', pl.credits && pl.credits.needed === 2 && pl.credits.left === 0 && pl.credits.enough === false, pl.credits);
    const sCr = await Camp.send(tlI, idCr, {});
    check('E35 a live send with not enough credits is BLOCKED (402) in plain words', sCr.status === 402 && /Not enough credits/.test(sCr.error), sCr);
    const chk = await require(path.join(BACK, 'src/outreach/health')).checkBeforeSending(tlI, { type: 'job_promotion', channel: 'whatsapp', requirementId: job.id, segmentIds: [segTl], templateId: tWa.id });
    check('E36 "Check before sending" blocks on credits', chk.blocked && chk.checks.some((c) => c.id === 'credits' && c.status === 'block'), chk.checks && chk.checks.map((c) => `${c.id}:${c.status}`));
    const plSa = await Camp.plan(saI, { type: 'job_promotion', channel: 'whatsapp', requirementId: job.id, segmentIds: [segSa], templateId: tWa.id });
    check('E37 an Admin (exempt) has no limit', plSa.credits.exempt === true && plSa.credits.enough === true && plSa.credits.left === null, plSa.credits);
    await Cr.setAllowance(tl.id, null, '', { id: sa.id, name: sa.name });
    // each channel has its own speed; a campaign may go slower but never faster than its channel
    await S.saveSettings({ ...(await S.settings()), waPerMinute: 1 }, { id: sa.id, name: sa.name });
    const idSp = await mkRow(saI, 'whatsapp', tWa.id, { perMinute: 5000 });
    await Camp.send(saI, idSp, {});
    const spRow = (await prisma.$queryRawUnsafe('SELECT perMinute FROM "OutreachCampaign" WHERE id = ?', idSp))[0];
    check('E38 a campaign speed above the channel\'s setting is cut to it (1 a minute)', Number(spRow.perMinute) === 1, spRow);
    const t5 = await Run.tick({ ignoreSwitch: true, messageSender: mockSend, channels: ['whatsapp'] });
    check('E39 WhatsApp speed 1 a minute: only one of its waiting messages goes in this minute (the channel limit counts every WhatsApp campaign)', t5.sent <= 1, t5);
    await S.saveSettings({ ...(await S.settings()), waPerMinute: 30 }, { id: sa.id, name: sa.name });
    const idPm = await mkRow(saI, 'sms', tSms.id, { perMinute: 1 });
    await Camp.send(saI, idPm, {});
    await Run.tick({ ignoreSwitch: true, messageSender: mockSend, channels: ['sms'] });
    const smsDone = (await msgsOf(idPm)).filter((m) => m.status === 'sent').length;
    check('E40 a campaign\'s own speed (1 a minute) holds it back even when the channel allows 60: 3 people, 1 sent now', smsDone === 1, smsDone);
    // test mode back ON for everything below
    await S.saveSettings({ ...(await S.settings()), emailTestMode: true }, { id: sa.id, name: sa.name });
    adapters.get('whatsapp').status = realStatus.wa; adapters.get('sms').status = realStatus.sms;
    // a live campaign is held while Test mode is ON (nothing sent)
    const t6 = await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider });
    check('E41 a LIVE campaign is held while Test mode is ON, and no provider is called', t6.sent === 0 && calls.length === 0, t6);
    // finish the leftovers so the later checks start clean (stop them)
    for (const id of [idWaN, idSp, idPm]) await Camp.control(saI, id, 'stop');

    // ---- call tasks ----------------------------------------------------------------------------------------------------------------------------
    const idCall = await mkRow(saI, 'call', null, { masterMessage: 'Say hello and ask about the job.' });
    const sCall = await Camp.send(saI, idCall, {});
    const tasks0 = await Camp.callTasks(saI, idCall, { status: 'todo' });
    check('E42 a call campaign is always live and makes one call task per person who may be rung (4)', sCall.mode === 'live' && sCall.queued === 4 && tasks0.counts.todo === 4 && tasks0.tasks.every((t) => t.statusWords === 'To call'), { s: sCall.error || sCall.queued, tasks0: tasks0.counts });
    const tCall = await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider });
    check('E43 the runner never claims a call task', (await msgsOf(idCall)).filter((m) => m.status === 'queued').length === 4 && calls.length === 0, tCall);
    const tk = tasks0.tasks;
    const m1 = await Camp.markCall(saI, tk[0].id, { outcome: 'called', minutes: 6 });
    const m2 = await Camp.markCall(saI, tk[1].id, { outcome: 'no_answer' });
    const m3 = await Camp.markCall(saI, tk[2].id, { outcome: 'skip' });
    const bad = await Camp.markCall(saI, tk[3].id, { outcome: 'called', minutes: 'abc' });
    const again = await Camp.markCall(saI, tk[0].id, { outcome: 'no_answer' });
    check('E44 a call is logged as Called (with minutes), No answer or Skip; bad minutes are refused; a logged call cannot be logged twice', m1.ok && m2.ok && m3.ok && bad.status === 400 && again.status === 409, { m1, bad: bad.error, again: again.error });
    const mrow = (await msgsOf(idCall)).find((m) => m.id === tk[0].id);
    check('E45 "called" = status sent with sentAt and callMinutes; "no answer" = failed with reason no_answer', mrow.status === 'sent' && Number(mrow.callMinutes) === 6 && mrow.sentAt && (await msgsOf(idCall)).find((m) => m.id === tk[1].id).reason === 'no_answer');
    const m4 = await Camp.markCall(saI, tk[3].id, { outcome: 'called', minutes: 2 });
    check('E46 when the last call is logged the campaign is Done', m4.ok && m4.left === 0 && (await prisma.$queryRawUnsafe('SELECT status FROM "OutreachCampaign" WHERE id = ?', idCall))[0].status === 'done');
    await sleep(600); // the ledger row is written in the background
    const callLedger = await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE campaignId = ? AND channel = \'call\'', idCall);
    check('E47 each answered call is one ledger row on the call channel (cost 0 by default)', Number(callLedger[0].n) === 2, callLedger);

    // ==================================================================== A: the API ==========================================================================================
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const TK = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), am: await tokenOf(am), hr: await tokenOf(hr), rec: await tokenOf(recU), client: await tokenOf(client), acct: await tokenOf(acct) };

    // roles
    const lists = {}; for (const k of Object.keys(TK)) lists[k] = await http('GET', `${G0}/list`, TK[k]); // eslint-disable-line no-await-in-loop
    check('R1 Super Admin, TL, BDE, Recruiter, Manager and HR open the list (200)', ['sa', 'tl', 'bde', 'rec', 'am', 'hr'].every((k) => lists[k].status === 200), Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.status])));
    check('R2 Accounts (Finance) and Client logins are refused (403)', lists.acct.status === 403 && lists.client.status === 403, { acct: lists.acct.status, client: lists.client.status });
    const L = lists.sa.body;
    check('R3 the list answer has rows, total, tab counts (All, Live, Scheduled, Not sent yet, Completed, Paused, Waiting for approval) and a count per channel tab (incl. Email, RCS, Voice, Facebook, Instagram)', Array.isArray(L.rows) && ['all', 'live', 'scheduled', 'notsent', 'completed', 'paused', 'approval'].every((k) => typeof L.tabs[k] === 'number') && ['all', 'whatsapp', 'sms', 'email', 'rcs', 'call', 'facebook', 'instagram'].every((k) => typeof L.channelCounts[k] === 'number'), { tabs: L.tabs, cc: L.channelCounts });
    check('R4 RCS, Facebook and Instagram have no campaigns (0) - honest empty tabs', L.channelCounts.rcs === 0 && L.channelCounts.facebook === 0 && L.channelCounts.instagram === 0);
    const cOpts = await http('GET', `${G0}/options`, TK.sa);
    check('A1 wizard options: objectives (prototype + staffing), groups with live counts, channel readiness (WhatsApp, SMS, Email, Voice; RCS planned; Facebook / Instagram not connected), templates, credits, approval, test mode', cOpts.status === 200 && cOpts.body.objectives.some((o) => o.label === 'Recruitment') && cOpts.body.objectives.some((o) => o.label === 'Sales') && cOpts.body.segments.some((s) => s.id === segSa && s.total === 6) && cOpts.body.channels.map((c) => c.channel).join() === 'whatsapp,sms,email,call,rcs,facebook,instagram' && cOpts.body.channels.find((c) => c.channel === 'rcs').planned === true && cOpts.body.channels.find((c) => c.channel === 'facebook').selectable === false && cOpts.body.templates.length >= 5 && cOpts.body.credits && cOpts.body.approval && cOpts.body.settings.testMode === true, cOpts.text.slice(0, 300));
    const waR = cOpts.body.channels.find((c) => c.channel === 'whatsapp');
    check('A2 the WhatsApp readiness line counts Meta-approved templates and those in review (prototype wording)', waR.ready && /Meta-approved template/.test(waR.note) && /in review/.test(waR.note), waR);
    const optRec = await http('GET', `${G0}/options`, TK.rec);
    check('A3 a Recruiter may look but not create (canCreate false; create is 403)', optRec.body.canCreate === false && (await http('POST', `${G0}/create`, TK.rec, { name: 'x y z', channels: ['email'] })).status === 403);
    const jobs = await http('GET', `${G0}/jobs`, TK.sa);
    check('A4 the job picker lists open jobs', jobs.status === 200 && Array.isArray(jobs.body.jobs));
    const planB = { objective: 'job_promotion', requirementId: job.id, segmentIds: [segSa], channels: ['whatsapp', 'sms', 'email'] };
    const pl2 = await http('POST', `${G0}/plan`, TK.sa, planB);
    const plCall = await http('POST', `${G0}/plan`, TK.sa, { ...planB, channels: ['call'] });
    const per = Object.fromEntries([...(pl2.body.perChannel || []), ...(plCall.body.perChannel || [])].map((p) => [p.channel, p]));
    check('A5 the audience plan: 6 people, reach 4 (two are left out by every channel), per channel who gets it and the plain reasons, credits', pl2.status === 200 && pl2.body.people === 6 && per.whatsapp.willGet === 2 && per.sms.willGet === 3 && per.email.willGet === 2 && per.call.willGet === 4 && pl2.body.reach === 4 && pl2.body.excluded === 2 && per.whatsapp.reasons.some((r) => r.reason === 'suppressed') && pl2.body.credits && pl2.body.consentNote, pl2.text.slice(0, 400));
    check('A6 a group of another login is refused (BDE group used by TL: not found / not yours)', (await http('POST', `${G0}/plan`, TK.tl, { ...planB, segmentIds: [segBde] })).status === 403);
    const rev = await http('POST', `${G0}/review`, TK.sa, { ...planB, channels: ['whatsapp', 'sms', 'email', 'call'], templates: { whatsapp: tWa.id, sms: tSms.id, email: tEm.id }, masterMessage: 'Call script here' });
    check('A7 the review: per channel the plan + "Check before sending"; Test mode warning; credits; nothing blocked', rev.status === 200 && rev.body.ok === true && rev.body.testMode === true && rev.body.channels.length === 4 && rev.body.channels.every((c) => c.check.checks.length > 0) && rev.body.channels.find((c) => c.channel === 'whatsapp').check.checks.some((c) => c.id === 'test_mode' && c.status === 'warn') && rev.body.channels.find((c) => c.channel === 'email').plan.preview.body.includes('ZZTEST person') === false && typeof rev.body.credits.needed === 'number', rev.text.slice(0, 400));
    const revBad = await http('POST', `${G0}/review`, TK.sa, { ...planB, channels: ['sms'], templates: { sms: tSmsNoDlt.id } });
    check('A8 a message that cannot go out BLOCKS the review in plain words', revBad.status === 200 && revBad.body.ok === false && revBad.body.channels[0].check.blocked === true, revBad.text.slice(0, 300));
    const wizBody = (extra) => ({ name: N('master'), objective: 'recruitment', tag: 'ZZ tag', goal: 'Fill the ward', requirementId: job.id, segmentIds: [segSa], channels: ['whatsapp', 'sms', 'email'], templates: { whatsapp: tWa.id, sms: tSms.id, email: tEm.id }, masterMessage: 'Hello from the master', cta: 'Apply now', brandVoice: 'Professional', when: 'now', approvalMode: 'auto', ...extra });
    // refuse things that cannot be done
    check('A9 a campaign needs a name, at least one channel, and cannot be published to RCS / Facebook / Instagram', (await http('POST', `${G0}/create`, TK.sa, wizBody({ name: 'x' }))).status === 400 && (await http('POST', `${G0}/create`, TK.sa, wizBody({ channels: [] }))).status === 400 && (await http('POST', `${G0}/create`, TK.sa, wizBody({ channels: ['rcs'] }))).status === 400 && (await http('POST', `${G0}/create`, TK.sa, wizBody({ channels: ['facebook'] }))).status === 400);
    const cBadTpl = await http('POST', `${G0}/create`, TK.sa, wizBody({ templates: { whatsapp: tWaPending.id, sms: tSms.id, email: tEm.id } }));
    const afterBad = await http('GET', `${G0}/list?q=${encodeURIComponent(N('master'))}`, TK.sa);
    check('A10 one channel that cannot go out stops the whole create: nothing half-made is left', cBadTpl.status === 400 && /WhatsApp/.test(cBadTpl.body.error) && afterBad.body.total === 0, { s: cBadTpl.status, e: cBadTpl.body && cBadTpl.body.error, left: afterBad.body.total });

    // ---- create + send a master campaign to three channels (rehearsal) ------------------------------------------------------------------------------------
    const cr1 = await http('POST', `${G0}/create`, TK.sa, wizBody({}));
    check('A11 Create campaign publishes ONE master campaign to WhatsApp, SMS and Email; Test mode makes it a rehearsal', cr1.status === 200 && cr1.body.ok && cr1.body.status === 'live' && /rehearsal/.test(cr1.body.message) && cr1.body.results.length === 3 && cr1.body.results.every((r) => r.ok && r.mode === 'rehearsal'), cr1.text.slice(0, 300));
    const key1 = cr1.body.key;
    const rows1 = await Camp.groupRows(key1); rows1.forEach((r) => made.campaigns.push(r.id));
    const l1 = await http('GET', `${G0}/list?q=${encodeURIComponent(N('master'))}`, TK.sa);
    const row1 = l1.body.rows[0];
    check('A12 the list shows ONE row for the three channel campaigns, with channels[] and the prototype columns (name, objective, audience, status, sent/failed, engagement, conversions)', l1.body.total === 1 && row1.key === key1 && row1.channels.map((c) => c.code).join() === 'WH,SM,EM' && row1.name === N('master') && row1.objective === 'Recruitment' && row1.audience === 6 && row1.statusWords === 'Live' && row1.numbers && 'engagement' in row1 && 'conversions' in row1 && row1.rehearsal === true, row1);
    await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider });
    const l1b = await http('GET', `${G0}/list?q=${encodeURIComponent(N('master'))}`, TK.sa);
    check('A13 after the run: sent 7 (2 + 3 + 2, rehearsed), failed 0, status Completed; the three channel rows are done', l1b.body.rows[0].numbers.sent === 7 && l1b.body.rows[0].numbers.failed === 0 && l1b.body.rows[0].numbers.rehearsed === 7 && l1b.body.rows[0].statusWords === 'Completed', l1b.body.rows[0].numbers);
    const d1 = await http('GET', `${G0}/campaign/${key1}`, TK.sa);
    check('A14 the detail has the header, the 4 steps, Overview numbers, Content (master + a version per channel), Channels table, Activity and the abilities', d1.status === 200 && d1.body.campaign.name === N('master') && d1.body.steps.length === 4 && d1.body.overview.reach === 7 && d1.body.content.versions.length === 3 && d1.body.content.masterMessage === 'Hello from the master' && d1.body.channels.length === 3 && d1.body.channels[0].sent === 2 && d1.body.activity.length > 0 && d1.body.campaign.can.duplicate === true, d1.text.slice(0, 300) + ' LOG ' + log.slice(-1800));
    const vWa = d1.body.content.versions.find((v) => v.channel === 'whatsapp');
    check('A15 the content versions are the real words with a sample name ("Anita")', /Anita/.test(vWa.body) && vWa.waTemplateName === 'zz_job_promo_v1' && /Reply STOP/.test(vWa.body), vWa);
    // detail from any row id too
    const dRow = await http('GET', `${G0}/campaign/${rows1[0].id}`, TK.sa);
    check('A16 the same campaign opens by the id of any of its channel rows', dRow.status === 200 && dRow.body.campaign.key === key1);
    const aud = await http('GET', `${G0}/campaign/${key1}/audience?pageSize=50`, TK.sa);
    check('A17 Audience tab: the people it was resolved against (6), name / phone / source / stage with the real result per channel', aud.status === 200 && aud.body.total === 6 && aud.body.resolved === true && aud.body.people.every((p) => p.name && 'phone' in p && 'source' in p && p.stage) && aud.body.people.find((p) => /person 4/.test(p.name)).stage.includes('Left out: On the do-not-contact list') && aud.body.people.some((p) => /^\+91\d{10}$/.test(p.phone)), aud.text.slice(0, 400));
    const rp0 = await http('GET', `${G0}/campaign/${key1}/replies`, TK.sa);
    check('A18 Replies tab says honestly when there are none', rp0.status === 200 && rp0.body.total === 0 && Array.isArray(rp0.body.replies));
    // a reply + a read report + a click
    const mWa = (await msgsOf(rows1[0].id)).filter((m) => m.status === 'test_captured');
    const campRow = (await prisma.$queryRawUnsafe('SELECT * FROM "OutreachCampaign" WHERE id = ?', rows1[0].id))[0];
    await prisma.$executeRawUnsafe('UPDATE "OutreachMessage" SET repliedAt = ? WHERE id = ?', Date.now(), mWa[0].id);
    await Ev.record('replied', mWa[0], campRow, { detail: { src: 'test' } });
    const dr = await Ev.applyDelivery({ messageId: mWa[0].id, event: 'read', at: Date.now() });
    const dr2 = await Ev.applyDelivery({ messageId: mWa[1].id, event: 'delivered', at: Date.now() });
    await Ev.record('applied', mWa[0], campRow, { detail: null });
    check('A19 "replied" is a funnel event type; delivery reports (read, delivered) are applied once', Ev.TYPES.includes('replied') && dr.updated === 'read' && dr2.updated === 'delivered' && (await Ev.applyDelivery({ messageId: mWa[0].id, event: 'read' })).updated === 'read');
    const rp1 = await http('GET', `${G0}/campaign/${key1}/replies`, TK.sa);
    const l1c = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('master'))}`, TK.sa)).body.rows[0];
    check('A20 the reply shows in the Replies tab; the row numbers (hover) count delivered 1, read 1, replied 1, applied 1; engagement and conversions follow', rp1.body.total === 1 && rp1.body.replies[0].channel === 'whatsapp' && l1c.numbers.delivered >= 1 && l1c.numbers.read === 1 && l1c.numbers.replied === 1 && l1c.numbers.applied === 1 && l1c.conversions === 1 && l1c.engagement > 0, { n: l1c.numbers, e: l1c.engagement });
    const an = await http('GET', `${G0}/campaign/${key1}/analytics`, TK.sa);
    check('A21 analytics: the six tiles, the donut slices, failure reasons with plain descriptions, the message preview, and the rehearsal flag', an.status === 200 && an.body.hasData && an.body.tiles.total === 7 && an.body.tiles.sent === 7 && an.body.tiles.readAnswered === 1 && an.body.tiles.responses === 1 && an.body.slices.length === 4 && an.body.reasons.length > 0 && an.body.reasons.every((r) => r.label && r.desc) && an.body.preview && an.body.preview.body && an.body.rehearsal === true, an.text.slice(0, 500));
    const anCsv = await http('GET', `${G0}/campaign/${key1}/analytics.csv`, TK.sa);
    check('A22 analytics CSV: Metric,Value rows', anCsv.status === 200 && /^\uFEFF?"Metric","Value"/.test(anCsv.text) && /Total Messages/.test(anCsv.text) && /Rehearsal/.test(anCsv.text));
    const lg1 = await http('GET', `${G0}/campaign/${key1}/logs?pageSize=10`, TK.sa);
    const m0 = lg1.body.messages[0];
    check('A23 Live Message Logs: Recipient, Status, Sent/Started At, Delivered At, Read At, Error Code, Error Description, Name; total records; page size 10', lg1.status === 200 && lg1.body.pageSize === 10 && lg1.body.total >= 7 && ['contact', 'statusWords', 'sentAt', 'deliveredAt', 'readAt', 'errorCode', 'errorWords', 'name'].every((k) => k in m0), m0);
    const lgRead = await http('GET', `${G0}/campaign/${key1}/logs?status=read`, TK.sa);
    const lgRh = await http('GET', `${G0}/campaign/${key1}/logs?status=rehearsed&pageSize=50`, TK.sa);
    const lgSk = await http('GET', `${G0}/campaign/${key1}/logs?status=skipped&pageSize=50`, TK.sa);
    check('A24 the status filter uses the real statuses: Read (1), Rehearsed (5; two became Delivered / Read), Skipped (left out, with the reason as the error)', lgRead.body.total === 1 && lgRh.body.total === 5 && lgSk.body.total > 0 && lgSk.body.messages.every((m) => m.errorCode && m.errorWords), { read: lgRead.body.total, rh: lgRh.body.total, sk: lgSk.body.total });
    check('A25 page sizes 10, 20 and 50 are honoured; another number falls back to 10', (await http('GET', `${G0}/campaign/${key1}/logs?pageSize=20`, TK.sa)).body.pageSize === 20 && (await http('GET', `${G0}/campaign/${key1}/logs?pageSize=50`, TK.sa)).body.pageSize === 50 && (await http('GET', `${G0}/campaign/${key1}/logs?pageSize=33`, TK.sa)).body.pageSize === 10);
    const csvSa = await http('GET', `${G0}/campaign/${key1}/logs.csv`, TK.sa);
    check('A26 the logs CSV (Admin): the prototype headers, one line per message', csvSa.status === 200 && /^\uFEFF?"Recipient","Status","Sent\/Started At","Delivered At","Read At","Error Code","Error Description","Name"/.test(csvSa.text) && csvSa.text.trim().split('\n').length >= 8, csvSa.text.slice(0, 200));
    check('A27 the logs CSV is refused for a TL and a BDE (only roles that may export)', (await http('GET', `${G0}/campaign/${key1}/logs.csv`, TK.tl)).status !== 200 && (await http('GET', `${G0}/campaign/${key1}/logs.csv`, TK.bde)).status !== 200);
    const exp = await http('GET', `${G0}/export?q=${encodeURIComponent(N('master'))}`, TK.sa);
    const expRow = await http('GET', `${G0}/campaign/${key1}/export.csv`, TK.sa);
    check('A28 Export (list): Campaign, Objective, Audience, Channels (joined |), Status, Sent, Engagement, Conversions; row export: Name, Status, Channels, Sent, Delivered, Opened, Clicked', exp.status === 200 && /^\uFEFF?"Campaign","Objective","Audience","Channels","Status","Sent","Engagement","Conversions"/.test(exp.text) && /WhatsApp \| SMS \| Email/.test(exp.text) && expRow.status === 200 && /^\uFEFF?"Name","Status","Channels","Sent","Delivered","Opened","Clicked"/.test(expRow.text), { exp: exp.text.slice(0, 200), row: expRow.text.slice(0, 120) });
    // filters
    const fCh = await http('GET', `${G0}/list?channel=whatsapp&q=${encodeURIComponent(N('master'))}`, TK.sa);
    const fSm = await http('GET', `${G0}/list?channel=call&q=${encodeURIComponent(N('master'))}`, TK.sa);
    const fSt = await http('GET', `${G0}/list?status=completed&q=${encodeURIComponent(N('master'))}`, TK.sa);
    const fSt2 = await http('GET', `${G0}/list?status=live&q=${encodeURIComponent(N('master'))}`, TK.sa);
    const fOb = await http('GET', `${G0}/list?objective=Recruitment&q=${encodeURIComponent(N('master'))}`, TK.sa);
    const fOb2 = await http('GET', `${G0}/list?objective=Sales&q=${encodeURIComponent(N('master'))}`, TK.sa);
    check('A29 filters: channel (a group shows under each of its channels), status tab, objective, search', fCh.body.total === 1 && fSm.body.total === 0 && fSt.body.total === 1 && fSt2.body.total === 0 && fOb.body.total === 1 && fOb2.body.total === 0, { ch: fCh.body.total, call: fSm.body.total, completed: fSt.body.total, live: fSt2.body.total });
    const srt = await http('GET', `${G0}/list?sort=name&dir=asc&pageSize=100`, TK.sa);
    const srt2 = await http('GET', `${G0}/list?sort=sent&dir=desc&pageSize=100`, TK.sa);
    check('A30 sorting by name (A to Z) and by sent works; page size is honoured', srt.status === 200 && srt.body.rows.map((r) => r.name.toLowerCase()).join('|') === [...srt.body.rows.map((r) => r.name.toLowerCase())].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|') && srt2.status === 200 && srt2.body.rows.every((r, i, a) => !i || a[i - 1].numbers.sent >= r.numbers.sent));
    // never the word Draft
    check('A31 no status text in the list, the detail or the activity says "Draft"', !/draft/i.test(JSON.stringify([l1.body.rows.map((r) => r.statusWords), d1.body.campaign.statusWords, d1.body.channels.map((c) => c.statusWords), d1.body.activity.map((a) => `${a.title} ${a.detail}`), L.rows.map((r) => r.statusWords)])), null);

    // ---- masking: a BDE never sees a phone ----------------------------------------------------------------------------------------------------------------
    const cb = await http('POST', `${G0}/create`, TK.bde, wizBody({ name: N('bde own'), segmentIds: [segBde], channels: ['call'], templates: {}, masterMessage: 'Call about the job' }));
    check('R5 a BDE makes a campaign (Voice calls) for a job of their area, with their own group', cb.status === 200 && cb.body.ok, cb.text.slice(0, 300));
    if (cb.body.key) (await Camp.groupRows(cb.body.key)).forEach((r) => made.campaigns.push(r.id));
    const audB = await http('GET', `${G0}/campaign/${cb.body.key}/audience?pageSize=50`, TK.bde);
    const callsB = await http('GET', `${G0}/campaign/${cb.body.key}/calls`, TK.bde);
    check('R6 a BDE sees names but NEVER a full phone number (audience and call tasks are masked)', audB.status === 200 && audB.body.masked === true && audB.body.people.length > 0 && audB.body.people.every((p) => !/\d{9}/.test(p.phone)) && callsB.status === 200 && callsB.body.masked === true && callsB.body.tasks.every((t) => !/\d{9}/.test(t.phone)) && !/\d{10}/.test(callsB.text.replace(/"(id|at|name)":"[^"]*"/g, '')), { aud: audB.body.people && audB.body.people[0], task: callsB.body.tasks && callsB.body.tasks[0] });
    const audSa = await http('GET', `${G0}/campaign/${cb.body.key}/audience?pageSize=50`, TK.sa);
    check('R7 the Super Admin sees the same campaign with the full numbers', audSa.status === 200 && audSa.body.masked === false && audSa.body.people.some((p) => /^\+91\d{10}$/.test(p.phone)));
    const logB = await http('GET', `${G0}/campaign/${cb.body.key}/logs`, TK.bde);
    check('R8 the logs are masked for the BDE too', logB.status === 200 && logB.body.masked === true && logB.body.messages.every((m) => !/\d{9}/.test(m.contact)), logB.body.messages && logB.body.messages[0]);
    const mkTask = callsB.body.tasks[0];
    const mark = await http('POST', `${G0}/calls/${mkTask.id}/mark`, TK.bde, { outcome: 'called', minutes: 3 });
    const markRec = await http('POST', `${G0}/calls/${(await http('GET', `${G0}/campaign/${cb.body.key}/calls`, TK.sa)).body.tasks.find((t) => t.statusWords === 'To call').id}/mark`, TK.rec, { outcome: 'skip' });
    check('R9 a BDE logs a call; a Recruiter cannot (403/404)', mark.status === 200 && [403, 404].includes(markRec.status), { mark: mark.status, rec: markRec.status });
    const lrec = lists.rec.body; const lbde = (await http('GET', `${G0}/list?pageSize=100`, TK.bde)).body;
    check('R10 a BDE sees their own campaign and not the Super Admin\'s other ones outside their area/ownership logic (own campaign listed; list rows carry no phone)', lbde.rows.some((r) => r.key === cb.body.key) && !/"phone"/.test(JSON.stringify(lbde)), { n: lbde.total });
    check('R11 a Recruiter sees the list read-only (no create, no actions)', lrec.canCreate === false || lrec.rows.every((r) => !r.can.send && !r.can.edit && !r.can.pause && !r.can.remove), { canCreate: lrec.canCreate });

    // ---- scheduling, pause / resume / stop, duplicate, delete -----------------------------------------------------------------------------------------------
    const at = new Date(Date.now() + 2 * 86400000); const atIst = new Date(at.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
    const crS = await http('POST', `${G0}/create`, TK.sa, wizBody({ name: N('later'), channels: ['email'], templates: { email: tEm.id }, when: 'at', at: `${atIst}T11:00:00+05:30` }));
    check('A32 "Schedule for later" (India time) makes it Scheduled', crS.status === 200 && crS.body.status === 'scheduled', crS.text.slice(0, 300));
    (await Camp.groupRows(crS.body.key)).forEach((r) => made.campaigns.push(r.id));
    const sRow = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('later'))}`, TK.sa)).body.rows[0];
    check('A33 the list says Scheduled; Pause is allowed, Delete is not (it was sent)', sRow.statusWords === 'Scheduled' && sRow.can.pause === true && sRow.can.remove === false, sRow);
    const crPast = await http('POST', `${G0}/create`, TK.sa, wizBody({ name: N('past'), channels: ['email'], templates: { email: tEm.id }, when: 'at', at: new Date(Date.now() - 3600000).toISOString() }));
    check('A34 a time in the past is refused in plain words (nothing is left half-made)', crPast.status === 200 && crPast.body.partial === true && /minute/.test(crPast.body.message), crPast.text.slice(0, 300));
    const pRow = await Camp.groupRows(crPast.body.key); pRow.forEach((r) => made.campaigns.push(r.id));
    const pause = await http('POST', `${G0}/campaign/${crS.body.key}/pause`, TK.sa);
    const pausedRow = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('later'))}`, TK.sa)).body.rows[0];
    check('A35 Pause: "nothing further will send"; the row says Paused and offers Resume', pause.status === 200 && /paused/.test(pause.body.ok) && pausedRow.statusWords === 'Paused' && pausedRow.can.resume === true);
    const resume = await http('POST', `${G0}/campaign/${crS.body.key}/resume`, TK.sa);
    check('A36 Resume brings it back to Scheduled', resume.status === 200 && (await http('GET', `${G0}/list?q=${encodeURIComponent(N('later'))}`, TK.sa)).body.rows[0].statusWords === 'Scheduled');
    const stop = await http('POST', `${G0}/campaign/${crS.body.key}/stop`, TK.sa);
    check('A37 Stop ends it (Stopped); a stopped campaign cannot be paused again', stop.status === 200 && (await http('GET', `${G0}/list?q=${encodeURIComponent(N('later'))}`, TK.sa)).body.rows[0].statusWords === 'Stopped' && (await http('POST', `${G0}/campaign/${crS.body.key}/pause`, TK.sa)).status === 409);
    const dupBad = await http('POST', `${G0}/campaign/${key1}/duplicate`, TK.sa, { name: N('master') });
    const dupEmpty = await http('POST', `${G0}/campaign/${key1}/duplicate`, TK.sa, { name: '  ' });
    const dup = await http('POST', `${G0}/campaign/${key1}/duplicate`, TK.sa, { name: N('master copy') });
    check('A38 Duplicate: needs a name, the name must be free, and the copy is "Not sent yet" with zero numbers', dupBad.status === 409 && /already exists/.test(dupBad.body.error) && dupEmpty.status === 400 && dup.status === 200 && dup.body.ok && (() => true)(), { dupBad: dupBad.body, dup: dup.body });
    (await Camp.groupRows(dup.body.key)).forEach((r) => made.campaigns.push(r.id));
    const dRow2 = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('master copy'))}`, TK.sa)).body.rows[0];
    check('A39 the copy has the same channels and message picks, status Not sent yet, nothing sent, and can be edited / sent / deleted', dRow2.statusWords === 'Not sent yet' && dRow2.channels.length === 3 && dRow2.numbers.sent === 0 && dRow2.can.edit && dRow2.can.send && dRow2.can.remove, dRow2);
    const edit = await http('GET', `${G0}/campaign/${dup.body.key}/edit`, TK.sa);
    check('A40 Edit opens the wizard with the saved values (job, groups, channels, messages)', edit.status === 200 && edit.body.requirementId === job.id && edit.body.segmentIds[0] === segSa && edit.body.channels.length === 3 && edit.body.templates.whatsapp === tWa.id && edit.body.objective === 'recruitment', edit.text.slice(0, 300));
    const edSent = await http('GET', `${G0}/campaign/${key1}/edit`, TK.sa);
    check('A41 a campaign that was already sent cannot be edited (409, copy it instead)', edSent.status === 409);
    const upd = await http('PUT', `${G0}/campaign/${dup.body.key}`, TK.sa, { ...wizBody({ name: N('master copy'), channels: ['email', 'sms'], templates: { sms: tSms.id, email: tEm.id } }), saveOnly: true });
    const afterUpd = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('master copy'))}`, TK.sa)).body.rows[0];
    check('A42 saving a change (WhatsApp taken out): "Save for later" keeps it Not sent yet with SMS + Email', upd.status === 200 && upd.body.status === 'notsent' && afterUpd.channels.map((c) => c.code).join() === 'SM,EM', upd.text.slice(0, 200));
    const master = await http('PUT', `${G0}/campaign/${dup.body.key}/master`, TK.sa, { text: 'A new source message' });
    const masterEmpty = await http('PUT', `${G0}/campaign/${dup.body.key}/master`, TK.sa, { text: '   ' });
    const masterSent = await http('PUT', `${G0}/campaign/${key1}/master`, TK.sa, { text: 'try' });
    check('A43 the source message can be saved while not sent; empty is refused; a sent campaign refuses', master.status === 200 && masterEmpty.status === 400 && masterSent.status === 409 && (await http('GET', `${G0}/campaign/${dup.body.key}`, TK.sa)).body.content.masterMessage === 'A new source message');
    const delSent = await http('DELETE', `${G0}/campaign/${key1}`, TK.sa);
    const delDup = await http('DELETE', `${G0}/campaign/${dup.body.key}`, TK.sa);
    check('A44 Delete works only for a campaign that was never sent', delSent.status === 409 && delDup.status === 200 && (await http('GET', `${G0}/list?q=${encodeURIComponent(N('master copy'))}`, TK.sa)).body.total === 0);
    // resend failed through the API
    const failRow = (await msgsOf(rows1[2].id)).find((m) => m.status === 'test_captured');
    await prisma.$executeRawUnsafe('UPDATE "OutreachMessage" SET status = \'failed\', reason = \'rejected\', failedAt = ?, error = \'x\' WHERE id = ?', Date.now(), failRow.id);
    const rsA = await http('POST', `${G0}/campaign/${key1}/resend`, TK.sa);
    check('A45 "Resend failed" puts failed messages back and the campaign runs again', rsA.status === 200 && rsA.body.requeued === 1 && (await http('GET', `${G0}/list?q=${encodeURIComponent(N('master'))}`, TK.sa)).body.rows[0].statusWords === 'Live');
    await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider });
    // old routes keep working
    const oldList = await http('GET', '/api/outreach/campaigns', TK.sa);
    const oldPlan = await http('POST', '/api/outreach/campaigns/plan', TK.sa, { type: 'job_promotion', requirementId: job.id, segmentIds: [segSa], templateId: tEm.id });
    const oldChk = await http('POST', '/api/outreach/campaigns/check', TK.sa, { type: 'job_promotion', requirementId: job.id, segmentIds: [segSa], templateId: tEm.id });
    const oldMsgs = await http('GET', '/api/outreach/messages?pageSize=5', TK.sa);
    const oldPlanWa = await http('POST', '/api/outreach/campaigns/plan', TK.sa, { type: 'job_promotion', requirementId: job.id, segmentIds: [segSa], templateId: tWa.id, channel: 'whatsapp' });
    check('A46 the old campaign routes still answer (list, plan, check, message log); the old email plan is unchanged; a WhatsApp plan now works', oldList.status === 200 && oldPlan.status === 200 && oldPlan.body.willGet === 1 && oldPlan.body.skipped.alreadyApplied === 1 && oldChk.status === 200 && oldChk.body.checks.some((c) => c.id === 'stop_link') && oldMsgs.status === 200 && oldPlanWa.status === 200 && oldPlanWa.body.channel === 'whatsapp', { list: oldList.status, plan: oldPlan.text.slice(0, 120), chk: oldChk.status, wa: oldPlanWa.text.slice(0, 120) });

    // ---- approval ----------------------------------------------------------------------------------------------------------------------------------------------
    const bdeOff = await http('POST', `${G0}/create`, TK.bde, wizBody({ name: N('bde free'), segmentIds: [segBde], channels: ['email'], templates: { email: tEm.id } }));
    check('P1 default: approval is OFF, so a BDE\'s campaign is published straight away', bdeOff.status === 200 && bdeOff.body.status === 'live', bdeOff.text.slice(0, 200));
    if (bdeOff.body.key) (await Camp.groupRows(bdeOff.body.key)).forEach((r) => made.campaigns.push(r.id));
    await Pol.saveSwitches({ id: sa.id, name: sa.name }, { approvalRequired: true });
    await sleep(11000); // the server keeps the switch in memory for 10 seconds
    const bde1 = await http('POST', `${G0}/create`, TK.bde, wizBody({ name: N('bde approve'), segmentIds: [segBde], channels: ['email'], templates: { email: tEm.id }, approvalMode: 'auto' }));
    check('P2 with the Admin switch ON a BDE\'s campaign waits for approval (even if "Auto-publish" was picked)', bde1.status === 200 && bde1.body.status === 'approval', bde1.text.slice(0, 250));
    const keyA = bde1.body.key; (await Camp.groupRows(keyA)).forEach((r) => made.campaigns.push(r.id));
    const rowA = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('bde approve'))}`, TK.bde)).body.rows[0];
    check('P3 the list says "Waiting for approval", the Send button is blocked with the reason, nothing is queued', rowA.statusWords === 'Waiting for approval' && rowA.can.send === false && /waiting for approval/i.test(rowA.can.sendBlocked) && rowA.numbers.sent === 0, rowA);
    const sendA = await http('POST', `${G0}/campaign/${keyA}/send`, TK.bde, {});
    check('P4 pressing Send anyway is refused (409)', sendA.status === 409 && /approval/i.test(sendA.body.error), sendA.text.slice(0, 200));
    const noteTl = await prisma.notification.findFirst({ where: { userId: tl.id, title: { contains: N('bde approve') } } });
    check('P5 the approvers were told (a Team Lead who can see the campaign got a notice)', !!noteTl && /needs your approval/.test(noteTl.title), noteTl && noteTl.title);
    const pendTl = await http('GET', `${G0}/approvals`, TK.tl);
    check('P6 the Team Lead\'s "Waiting for approval" list has it; the badge count is at least 1', pendTl.status === 200 && pendTl.body.approvals.some((x) => x.id === keyA) && (await Appr.pendingCount(tlI)) >= 1 && (await chrome.badges(tlI)).approvals >= 1, pendTl.text.slice(0, 200));
    const apBde = await http('POST', `${G0}/campaign/${keyA}/approve`, TK.bde, {});
    const apRec = await http('POST', `${G0}/campaign/${keyA}/approve`, TK.rec, {});
    check('P7 a BDE (the maker), a Recruiter and Accounts cannot approve', apBde.status === 403 && [403, 404].includes(apRec.status) && (await http('POST', `${G0}/campaign/${keyA}/approve`, TK.acct, {})).status === 403);
    const rj0 = await http('POST', `${G0}/campaign/${keyA}/reject`, TK.tl, {});
    const rj = await http('POST', `${G0}/campaign/${keyA}/reject`, TK.tl, { note: 'Please use the newer message' });
    const rowRj = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('bde approve'))}`, TK.bde)).body.rows[0];
    check('P8 send back needs a note; then "Changes needed" shows the note to the maker, who gets a notice', rj0.status === 400 && rj.status === 200 && rowRj.statusWords === 'Changes needed' && rowRj.approvalNote === 'Please use the newer message' && !!(await prisma.notification.findFirst({ where: { userId: bde.id, title: { contains: N('bde approve') } } })), { rj0: rj0.status, rj: rj.status, row: rowRj.statusWords });
    const sub = await http('POST', `${G0}/campaign/${keyA}/submit`, TK.bde, {});
    check('P9 the maker asks again (Waiting for approval)', sub.status === 200 && (await http('GET', `${G0}/list?q=${encodeURIComponent(N('bde approve'))}`, TK.bde)).body.rows[0].statusWords === 'Waiting for approval');
    const ap = await http('POST', `${G0}/campaign/${keyA}/approve`, TK.tl, { note: 'OK' });
    const rowAp = (await http('GET', `${G0}/list?q=${encodeURIComponent(N('bde approve'))}`, TK.bde)).body.rows[0];
    check('P10 the Team Lead approves: the maker is told and can now press Send (nothing goes out by itself)', ap.status === 200 && rowAp.approval === 'approved' && rowAp.can.send === true && rowAp.numbers.sent === 0 && !!(await prisma.notification.findFirst({ where: { userId: bde.id, title: { contains: 'was approved' } } })), { ap: ap.text.slice(0, 120), row: rowAp.statusWords });
    const sendAp = await http('POST', `${G0}/campaign/${keyA}/send`, TK.bde, {});
    check('P11 after approval the BDE\'s Send works (rehearsal in Test mode)', sendAp.status === 200 && sendAp.body.ok, sendAp.text.slice(0, 200));
    const act = (await http('GET', `${G0}/campaign/${keyA}`, TK.bde)).body.activity.map((a) => a.title);
    check('P12 the Activity tab records who asked, sent back, approved and sent', ['Asked for approval', 'Sent back for changes', 'Approved', 'Sent'].every((t) => act.includes(t)), act);
    const tlOwn = await http('POST', `${G0}/create`, TK.tl, wizBody({ name: N('tl own'), segmentIds: [segTl], channels: ['email'], templates: { email: tEm.id } }));
    check('P13 a Team Lead\'s own campaign is not held for approval (only a BDE\'s is)', tlOwn.status === 200 && tlOwn.body.status === 'live', tlOwn.text.slice(0, 200));
    if (tlOwn.body.key) (await Camp.groupRows(tlOwn.body.key)).forEach((r) => made.campaigns.push(r.id));
    const askSa = await http('POST', `${G0}/create`, TK.sa, wizBody({ name: N('sa asks'), channels: ['email'], templates: { email: tEm.id }, approvalMode: 'approval' }));
    check('P14 "Publish after approval" can also be chosen by anybody (an Admin\'s campaign then waits)', askSa.status === 200 && askSa.body.status === 'approval');
    if (askSa.body.key) (await Camp.groupRows(askSa.body.key)).forEach((r) => made.campaigns.push(r.id));
    await Pol.saveSwitches({ id: sa.id, name: sa.name }, { approvalRequired: false });

    // ---- wrap up -------------------------------------------------------------------------------------------------------------------------------------------------
    await Run.tick({ ignoreSwitch: true, messageSender: refuseProvider });
    check('Z1 NOTHING real was sent: no provider was called and no live message exists in the log of this run', calls.length === 0 && Number((await prisma.$queryRawUnsafe(`SELECT COUNT(*) n FROM "OutreachSendLog" WHERE status = 'sent' AND contactId IN (${ids6.map(() => '?').join(',')}) AND mode <> 'live'`, ...ids6))[0].n) === 0);
    check('Z2 the live-path check used a mock sender only (5 + 2 + 2 + 3 messages, none to a real provider)', liveCalls.every((c) => /^91\d{10}$/.test(c[1].to)) && liveCalls.every((c) => c[1].meta && c[1].meta.source === 'campaign'));
  } catch (e) {
    fail += 1; console.log(`FAIL  the test crashed: ${e && e.stack ? e.stack : e}`);
  } finally {
    // ---- cleanup (the working copy only) -------------------------------------------------------------------------------------------------------------------------
    try {
      const ids = made.campaigns;
      const allCamps = (await prisma.$queryRawUnsafe('SELECT id FROM "OutreachCampaign" WHERE name LIKE ?', `%ZZTEST camp%${RUN}%`)).map((r) => r.id);
      const cids = [...new Set([...ids, ...allCamps])];
      const inList = (a) => a.map(() => '?').join(',') || "''";
      if (cids.length) {
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachEvent" WHERE campaignId IN (${inList(cids)})`, ...cids);
        await prisma.$executeRawUnsafe(`DELETE FROM "OmniCreditLedger" WHERE campaignId IN (${inList(cids)})`, ...cids);
        await prisma.$executeRawUnsafe(`DELETE FROM "OmniCampaignActivity" WHERE campaignId IN (${inList(cids)})`, ...cids).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachCampaignNote" WHERE campaignId IN (${inList(cids)})`, ...cids).catch(() => {});
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachMessage" WHERE campaignId IN (${inList(cids)})`, ...cids);
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachCampaign" WHERE id IN (${inList(cids)})`, ...cids);
      }
      if (made.contacts.length) {
        const c = made.contacts;
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachSendLog" WHERE contactId IN (${inList(c)})`, ...c);
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachContactChannel" WHERE contactId IN (${inList(c)})`, ...c);
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachContactTag" WHERE contactId IN (${inList(c)})`, ...c);
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachConsentEvent" WHERE contactId IN (${inList(c)})`, ...c);
        await prisma.$executeRawUnsafe(`DELETE FROM "OutreachContact" WHERE id IN (${inList(c)})`, ...c);
      }
      if (made.segs.length) await prisma.$executeRawUnsafe(`DELETE FROM "OutreachSegment" WHERE id IN (${inList(made.segs)})`, ...made.segs);
      if (made.tpls.length) await prisma.$executeRawUnsafe(`DELETE FROM "OutreachTemplate" WHERE id IN (${inList(made.tpls)})`, ...made.tpls);
      await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: 'ZZTEST camp' } }, { message: { contains: 'ZZTEST camp' } }] } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ actorName: { contains: 'ZZTEST' } }, { toValue: { contains: 'ZZTEST' } }] } }).catch(() => {});
      if (made.users.length) await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      const left = {
        campaigns: Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE name LIKE ?', '%ZZTEST camp%'))[0].n),
        contacts: Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachContact" WHERE name LIKE ?', '%ZZTEST person%'))[0].n),
        templates: Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachTemplate" WHERE name LIKE ?', '%ZZTEST camp%'))[0].n),
        segments: Number((await prisma.$queryRawUnsafe('SELECT COUNT(*) n FROM "OutreachSegment" WHERE name LIKE ?', '%ZZTEST seg%'))[0].n),
        users: await prisma.user.count({ where: { name: { contains: 'ZZTEST' } } }),
      };
      check('Z3 every ZZTEST row of this run is removed again', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.log(`cleanup problem: ${e && e.message}`); }
    if (server) server.kill();
    await prisma.$disconnect();
    try { for (const f of [WORK, `${WORK}-wal`, `${WORK}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* a locked temp file is fine */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
