#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BULK CALL / MESSAGE / WHATSAPP / EMAIL (ATS > Candidates & Pipeline) acceptance tests. SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/candidate-reach-test.js
//   ... --keep             leaves the ZZTEST fixtures (for screenshots) and prints their tokens to
//                          <TL_REACH_OUT or ./.reach-fixture.json outside the repo>
//   ... --cleanup          removes the fixtures of the last --keep run (and any ZZTEST Reach rows)
//
//   C  check: counts for a mixed selection (ok / no consent / no phone / duplicate / outside)
//   S  select-all-matching helpers (list idsOnly, board idsOnly by column)
//   R  roles: Recruiter / TL / Admin allowed; BDE / BDE TL / Accounts get 403 on every route
//   M  Email: real send through the connected channel (sandbox transport) + result with plain words
//   W  WhatsApp / SMS: not connected -> honest fallback rows, device log (never "Sent")
//   K  call queue + call log (outcomes, follow-up touched, consent respected)
//   L  limits (200), candidate never sees the client name
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const KEEP = process.argv.includes('--keep');
const CLEAN_ONLY = process.argv.includes('--cleanup');
const OUT = process.env.TL_REACH_OUT || path.join(os.homedir(), '.teamlink-sandbox', 'reach-fixture.json');
const RUN = Date.now().toString(36);
const TAG = 'ZZTEST Reach';
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function cleanup(made) {
  const ids = made.users;
  const candIds = (await prisma.candidate.findMany({ where: { OR: [{ id: { in: made.cands } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id);
  const reqIds = (await prisma.requirement.findMany({ where: { OR: [{ id: { in: made.reqs } }, { title: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id);
  const appIds = (await prisma.application.findMany({ where: { OR: [{ candidateId: { in: candIds } }, { requirementId: { in: reqIds } }] }, select: { id: true } })).map((x) => x.id);
  await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } }).catch((e) => console.error('cm', e.message));
  await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ applicationId: { in: appIds } }, { candidateId: { in: candIds } }] } }).catch(() => {});
  await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: appIds } } }).catch(() => {});
  await prisma.application.deleteMany({ where: { id: { in: appIds } } });
  await prisma.requirement.deleteMany({ where: { id: { in: reqIds } } });
  const clientIds = (await prisma.client.findMany({ where: { OR: [{ id: { in: made.clients } }, { name: { startsWith: TAG } }] }, select: { id: true } })).map((x) => x.id);
  try { await prisma.$executeRawUnsafe(`DELETE FROM "ConversationMessage" WHERE "personId" IN (${candIds.map((i) => `'${i}'`).join(',') || "''"})`); } catch { /* table may not exist */ }
  try { await prisma.$executeRawUnsafe(`DELETE FROM "Conversation" WHERE "personId" IN (${candIds.map((i) => `'${i}'`).join(',') || "''"})`); } catch { /* table may not exist */ }
  await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...candIds, ...reqIds, ...clientIds, ...ids] } }] } });
  await prisma.candidate.deleteMany({ where: { id: { in: candIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  // the bulk job files this test made
  try {
    const bulk = require(path.join(BACK, 'src/utils/bulkMessaging'));
    (made.jobs || []).forEach((j) => { try { bulk.removeJob(j); } catch { /* gone */ } });
  } catch { /* none */ }
  return {
    users: await prisma.user.count({ where: { email: { endsWith: '@example.test' }, name: { contains: TAG } } }),
    cands: await prisma.candidate.count({ where: { name: { startsWith: TAG } } }),
    reqs: await prisma.requirement.count({ where: { title: { startsWith: TAG } } }),
    clients: await prisma.client.count({ where: { name: { startsWith: TAG } } }),
    msgs: await prisma.candidateMessage.count({ where: { OR: [{ recipient: { contains: 'example.test' } }, { body: { contains: 'ZZTEST' } }] } }).catch(() => 0),
  };
}

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [], jobs: [] };
  if (CLEAN_ONLY) {
    let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).made || {}; } catch { /* none */ }
    const left = await cleanup({ users: [], emps: [], clients: [], reqs: [], cands: [], apps: [], jobs: [], ...prev });
    // users of earlier keep-runs: by name
    const us = await prisma.user.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.employee.deleteMany({ where: { userId: { in: us.map((u) => u.id) } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: us.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: us.map((u) => u.id) } } });
    try { fs.unlinkSync(OUT); } catch { /* none */ }
    console.log('cleaned', JSON.stringify(left));
    await prisma.$disconnect();
    return;
  }
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `${TAG} ${tag} ${RUN}`, email: `zz-reach-${tag}-${RUN}@example.test`, username: `zz-reach-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      const e = await prisma.employee.create({
        data: { employeeCode: `ZZTEST-RCH-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, email: u.email, phone: '9000000001', designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...(empExtra || {}) },
      });
      made.emps.push(e.id);
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uRecOther = await mkUser('recother', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uAcc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'ACCOUNTANT', accountsRole: 'ACCOUNTANT', accountsAccess: true, atsAccess: false });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '3h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, tl: uTl, rec: uRec, recOther: uRecOther, mgr: uMgr, bdeTl: uBdeTl, bde: uBde, acc: uAcc })) T[k] = await mint(u);

    const client = await prisma.client.create({ data: { name: `${TAG} Client Secret Name ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client' } });
    made.clients.push(client.id);
    const req = await prisma.requirement.create({ data: { title: `${TAG} Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, tlId: uTl.id, bdeId: uBde.id, openings: 3 } });
    made.reqs.push(req.id);
    // 12 people: 1-7 fine, 8-9 consent withdrawn, 10 no phone, 11 same phone as 1 (duplicate), 12 no email
    const cands = [];
    for (let i = 1; i <= 12; i += 1) {
      const n = String(i).padStart(2, '0');
      const phone = i === 10 ? null : (i === 11 ? '9876500001' : `98765000${n}`);
      const c = await prisma.candidate.create({
        data: {
          name: `${TAG} Cand ${n} ${RUN}`, email: i === 12 ? null : `zz-reach-c${n}-${RUN}@example.test`, phone, location: 'ZZ',
          ...((i === 8 || i === 9) ? { consentStatus: 'WITHDRAWN' } : {}),
        },
      });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: i <= 6 ? 'NEW' : 'RECRUITER_SCREEN' } });
      made.apps.push(a.id);
      cands.push({ ...c, appId: a.id, n: i });
    }
    // a candidate on another department's job (outside the recruiter's access)
    const outsider = await prisma.candidate.create({ data: { name: `${TAG} Outsider ${RUN}`, email: `zz-reach-out-${RUN}@example.test`, phone: '9876500999' } });
    made.cands.push(outsider.id);
    const reqMed = await prisma.requirement.create({ data: { title: `${TAG} Job Medical ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: uRecOther.id, openings: 1 } });
    made.reqs.push(reqMed.id);
    const appMed = await prisma.application.create({ data: { candidateId: outsider.id, requirementId: reqMed.id, stage: 'NEW' } });
    made.apps.push(appMed.id);
    // an open follow-up for candidate 1 (the call log must touch it)
    try {
      await prisma.applicationFollowUp.create({ data: { applicationId: cands[0].appId, candidateId: cands[0].id, requirementId: req.id, dueDate: new Date().toISOString().slice(0, 10), status: 'Upcoming', ownerUserId: uRec.id, ownerName: uRec.name } });
    } catch (e) { console.log('(follow-up fixture skipped:', e.message.split('\n').pop(), ')'); }

    const ids12 = cands.map((c) => c.id);
    const ids = (a, b) => ids12.slice(a - 1, b);

    // ========================= C: check =========================
    const ch = await call('POST', '/api/messaging/reach/check', T.rec, { channel: 'WhatsApp', ids: [...ids12, outsider.id] });
    check('C1 check answers 200', ch.status === 200, [ch.status, ch.body]);
    const cn = (ch.body && ch.body.counts) || {};
    // WhatsApp: ok = 1-7 (7) ; no consent 2 ; no phone 1 ; duplicate 1 ; outside 1  (12 has phone, only no email)
    check('C2 WhatsApp counts: 8 can be reached (1-7 + 12), 2 no consent, 1 no phone, 1 duplicate, 1 outside', cn.ok === 8 && cn.no_consent === 2 && cn.no_phone === 1 && cn.duplicate === 1 && cn.outside === 1, cn);
    check('C3 selected = 13 and max = 200', ch.body && ch.body.selected === 13 && ch.body.max === 200, ch.body && [ch.body.selected, ch.body.max]);
    const chMail = await call('POST', '/api/messaging/reach/check', T.rec, { channel: 'Email', ids: ids12 });
    const mn = (chMail.body && chMail.body.counts) || {};
    check('C4 Email counts: no email 1, no consent 2, ok 9', mn.no_email === 1 && mn.no_consent === 2 && mn.ok === 9, mn);
    const chCall = await call('POST', '/api/messaging/reach/check', T.rec, { channel: 'Call', ids: ids12 });
    check('C5 Call check works (no bulk right needed)', chCall.status === 200 && chCall.body.counts.ok === 7, chCall.body && chCall.body.counts);
    check('C6 check never returns phone numbers or emails', !/\d{10}/.test(JSON.stringify(ch.body)) && !/example\.test/.test(JSON.stringify(ch.body)), 'leak');
    const tooMany = await call('POST', '/api/messaging/reach/check', T.admin, { channel: 'Email', ids: Array.from({ length: 201 }, (_, i) => `x${i}`) });
    check('L1 201 people -> 400 with a plain message', tooMany.status === 400 && /At most 200/.test((tooMany.body || {}).error || ''), tooMany.body);
    const none = await call('POST', '/api/messaging/reach/check', T.rec, { channel: 'Email', ids: [] });
    check('L2 nobody ticked -> 400', none.status === 400, none.body);
    const badCh = await call('POST', '/api/messaging/reach/check', T.rec, { channel: 'Fax', ids: ids12 });
    check('L3 unknown channel -> 400', badCh.status === 400, badCh.body);

    // ========================= S: select-all helpers =========================
    const idl = await call('GET', `/api/candidates?idsOnly=1&requirementId=${req.id}`, T.rec);
    check('S1 list idsOnly returns the 12 rows with phone', idl.status === 200 && idl.body && idl.body.items && idl.body.items.filter((x) => String(x.name).includes(RUN)).length === 12, idl.body && [idl.body.total, idl.status]);
    const idb = await call('GET', `/api/candidates/board?idsOnly=1&requirementId=${req.id}`, T.rec);
    check('S2 board idsOnly (all live steps) returns the 12 people', idb.status === 200 && idb.body && idb.body.items && idb.body.items.length === 12, idb.body && [idb.status, idb.body.total]);
    const idbc = await call('GET', `/api/candidates/board?idsOnly=1&requirementId=${req.id}&column=sourced`, T.rec);
    check('S3 board idsOnly for ONE step (column=sourced) returns only that step', idbc.status === 200 && idbc.body && idbc.body.total > 0 && idbc.body.total < 12, idbc.body && [idbc.status, idbc.body.total]);

    // ========================= R: roles =========================
    const probes = [
      ['POST', '/api/messaging/reach/check', { channel: 'Call', ids: ids12 }],
      ['POST', '/api/messaging/reach/check', { channel: 'Email', ids: ids12 }],
      ['POST', '/api/messaging/reach/compose', { channel: 'WhatsApp', ids: ids12, purposeKey: 'x' }],
      ['POST', '/api/messaging/reach/send', { channel: 'Email', ids: ids12, confirmPeople: 1 }],
      ['POST', '/api/messaging/reach/call-queue', { items: ids12.map((id) => ({ id })) }],
      ['POST', '/api/messaging/reach/call-log', { candidateId: ids12[0], outcome: 'Answered' }],
      ['POST', '/api/messaging/reach/device-log', { candidateId: ids12[0], channel: 'WhatsApp', text: 'hi' }],
      ['GET', '/api/messaging/reach/result/bj_abcdefgh12', null],
    ];
    for (const [who, label] of [['bde', 'BDE'], ['bdeTl', 'BDE TL'], ['acc', 'Accounts']]) {
      const codes = [];
      for (const [m, p, b] of probes) { const r = await call(m, p, T[who], b === null ? undefined : b); codes.push(r.status); }
      check(`R1 ${label}: every reach route answers 403`, codes.every((c) => c === 403), codes);
    }
    const mgrCall = await call('POST', '/api/messaging/reach/check', T.mgr, { channel: 'Call', ids: ids12 });
    const mgrMail = await call('POST', '/api/messaging/reach/check', T.mgr, { channel: 'Email', ids: ids12 });
    console.log(`INFO  Manager: call check ${mgrCall.status}, mail check ${mgrMail.status} (${(mgrMail.body || {}).error || 'ok'})`);
    check('R2 Manager: may run a call list, and the bulk mail right follows the old bulk rule (see report)', mgrCall.status === 200 && [200, 403].includes(mgrMail.status), [mgrCall.status, mgrMail.status]);
    for (const [who, label] of [['rec', 'Recruiter'], ['tl', 'TL'], ['admin', 'Admin']]) {
      const r = await call('POST', '/api/messaging/reach/check', T[who], { channel: 'Email', ids: ids12 });
      check(`R3 ${label} may check a mail list`, r.status === 200, [r.status, r.body]);
    }
    const out = await call('POST', '/api/messaging/reach/check', T.recOther, { channel: 'Email', ids: ids12 });
    check('R4 a recruiter of another department: all 12 are "outside your access"', out.status === 200 && out.body.outside === 12 && out.body.canReach === 0, out.body && [out.body.outside, out.body.canReach]);
    const chan = await call('GET', '/api/messaging/channels', T.bde);
    check('R5 /channels tells the screen: BDE masked, no bulk', chan.status === 200 && chan.body.modes.candidates === 'masked' && chan.body.bulk.candidates === false, chan.body && [chan.body.modes, chan.body.bulk]);
    const chanRec = await call('GET', '/api/messaging/channels', T.rec);
    check('R6 /channels for the recruiter: direct and bulk allowed', chanRec.status === 200 && chanRec.body.modes.candidates === 'direct' && chanRec.body.bulk.candidates === true, chanRec.body && [chanRec.body.modes, chanRec.body.bulk, chanRec.body.audiences]);

    // ========================= M: email (connected channel) =========================
    const status = chanRec.body.channels;
    console.log(`INFO  channels: Email ${status.Email.configured}, SMS ${status.SMS.configured}, WhatsApp ${status.WhatsApp.configured}`);
    const tpls = await call('GET', '/api/messaging/templates/usable?audience=candidate', T.rec);
    const list = (tpls.body && tpls.body.templates) || [];
    const mailTpl = list.find((t) => t.channel === 'Email' && /^FU_/.test(t.purpose)) || list.find((t) => t.channel === 'Email');
    check('M0 there is an email template to use', !!mailTpl, list.length);
    if (mailTpl) {
      const cmp = await call('POST', '/api/messaging/reach/compose', T.rec, { channel: 'Email', ids: ids12, purposeKey: mailTpl.purpose, language: 'English' });
      check('M1 compose answers per person with text', cmp.status === 200 && cmp.body.people.length === 12 && cmp.body.people.every((p) => p.text), cmp.body && [cmp.status, cmp.body.error]);
      const all = JSON.stringify(cmp.body || {});
      check('M2 the message never contains the client name', !/Secret Name/.test(all), 'client name leaked');
      const p1 = cmp.body.people.find((p) => p.name.includes(`Cand 01 ${RUN}`));
      check('M3 the text is personal (has the candidate\'s first name)', p1 && /ZZTEST/.test(p1.text), p1 && p1.text.slice(0, 120));
      if (status.Email.configured) {
        const sent = await call('POST', '/api/messaging/reach/send', T.rec, { channel: 'Email', ids: ids12, purposeKey: mailTpl.purpose, language: 'English', confirmPeople: 7 });
        check('M4 send is accepted (202) as a job', sent.status === 202 && sent.body && sent.body.id, [sent.status, sent.body]);
        if (sent.body && sent.body.id) {
          made.jobs.push(sent.body.id);
          await call('POST', '/api/messaging/bulk/none', T.rec).catch(() => {});
          let res = null;
          for (let i = 0; i < 40; i += 1) {
            res = await call('GET', `/api/messaging/reach/result/${sent.body.id}`, T.rec);
            if (res.body && res.body.finished) break;
            // sandbox: no interval worker; kick the queue through the module
            try { await require(path.join(BACK, 'src/utils/bulkMessaging')).runOnce(); } catch { /* ignore */ }
            await sleep(500);
          }
          const rc = (res.body && res.body.counts) || {};
          check('M5 result: sent 7 (test transport), no consent 2, no email 1, duplicate 0 (emails differ)', res.body && res.body.finished && rc.sent === 7 && rc.no_consent === 2 && rc.no_email === 1, rc);
          check('M6 every row has a plain word', res.body && res.body.people.every((p) => p.word), res.body && res.body.people.slice(0, 3));
          const logged = await prisma.candidateMessage.count({ where: { candidateId: { in: ids12 }, channel: 'Email', status: 'SENT' } });
          check('M7 every sent mail is on the candidate\'s history (CandidateMessage SENT = 7)', logged === 7, logged);
          const rOther = await call('GET', `/api/messaging/reach/result/${sent.body.id}`, T.recOther);
          check('M8 another recruiter cannot read this result (403)', rOther.status === 403, rOther.status);
        }
        const over = await call('POST', '/api/messaging/reach/send', T.rec, { channel: 'Email', ids: ids12, purposeKey: mailTpl.purpose, language: 'English', confirmPeople: 3 });
        check('M9 a wrong confirm number is refused (409)', over.status === 409, [over.status, over.body]);
      } else console.log('SKIP  M4-M9 (Email is not connected in this sandbox)');
    }

    // ========================= W: WhatsApp / SMS fallback =========================
    for (const channel of ['WhatsApp', 'SMS']) {
      const tp = list.find((t) => t.channel === channel && /^FU_/.test(t.purpose)) || list.find((t) => t.channel === channel);
      if (!tp) { console.log(`SKIP  W ${channel}: no template`); continue; }
      const cmp = await call('POST', '/api/messaging/reach/compose', T.rec, { channel, ids: [...ids12, outsider.id], purposeKey: tp.purpose, language: 'English' });
      check(`W1 ${channel} compose 200`, cmp.status === 200, [cmp.status, cmp.body]);
      if (cmp.status !== 200) continue;
      const cc = cmp.body.counts;
      if (!cmp.body.connected) {
        check(`W2 ${channel} not connected: 8 can be opened in the own app, 2 no consent, 1 no phone, 1 duplicate, 1 outside`, cmp.body.canOpen === 8 && cc.no_consent === 2 && cc.no_phone === 1 && cc.duplicate === 1 && cc.outside === 1, [cmp.body.canOpen, cc]);
        check(`W3 ${channel}: nobody is marked "sent" and nobody gets "ok"`, !cmp.body.people.some((p) => p.code === 'sent' || p.code === 'ok'), cc);
        const first = cmp.body.people.find((p) => p.canOpen);
        const log = await call('POST', '/api/messaging/reach/device-log', T.rec, { candidateId: first.id, channel, text: first.text, purpose: 'Reach test' });
        check(`W4 ${channel} device-log accepted`, log.status === 200, [log.status, log.body]);
        const row = await prisma.candidateMessage.findFirst({ where: { candidateId: first.id, channel, template: 'BULK_DEVICE' } });
        check(`W5 ${channel} logged as OPENED_ON_DEVICE with the text, never SENT`, row && row.status === 'OPENED_ON_DEVICE' && row.body === first.text, row && [row.status]);
        const noC = cmp.body.people.find((p) => p.code === 'no_consent');
        const logNo = await call('POST', '/api/messaging/reach/device-log', T.rec, { candidateId: noC.id, channel, text: 'x' });
        check(`W6 ${channel} device-log for a no-consent person is refused (409)`, logNo.status === 409, [logNo.status, logNo.body]);
        const sendNc = await call('POST', '/api/messaging/reach/send', T.rec, { channel, ids: ids12, purposeKey: tp.purpose, language: 'English', confirmPeople: 0 });
        check(`W7 ${channel} real send while not connected: nobody is sent (no queued rows)`, sendNc.status === 409 || (sendNc.status === 202 && !sendNc.body.counts.sent), [sendNc.status, sendNc.body && sendNc.body.counts]);
        if (sendNc.body && sendNc.body.id) made.jobs.push(sendNc.body.id);
      } else {
        console.log(`INFO  ${channel} is connected here: connected path counts`, JSON.stringify(cc));
      }
    }

    // ========================= K: call queue =========================
    const cq = await call('POST', '/api/messaging/reach/call-queue', T.rec, { items: [...ids12.map((id, i) => ({ id, applicationId: cands[i].appId })), { id: outsider.id }] });
    check('K1 call queue 200', cq.status === 200, [cq.status, cq.body]);
    const q = cq.body || {};
    check('K2 queue = 8 people (1-7, 12); skipped: 2 no consent, 1 no phone, 1 duplicate, 1 outside', q.queue && q.queue.length === 8 && q.skipped.length === 5, [q.queue && q.queue.length, q.skipped && q.skipped.map((s) => s.code)]);
    check('K3 the queue has numbers for the recruiter and keeps the order', q.queue && q.queue[0].phone === '9876500001' && q.queue[0].applicationId === cands[0].appId, q.queue && q.queue[0]);
    check('K4 outcomes offered: Answered / Not answered / Busy / Wrong number / Call back', JSON.stringify(q.outcomes) === JSON.stringify(['Answered', 'Not answered', 'Busy', 'Wrong number', 'Call back']), q.outcomes);
    for (const outcome of ['Answered', 'Not answered', 'Busy', 'Wrong number', 'Call back']) {
      const lg = await call('POST', '/api/messaging/reach/call-log', T.rec, { candidateId: cands[0].id, applicationId: cands[0].appId, outcome, note: `ZZTEST note ${outcome}` });
      check(`K5 call log "${outcome}" accepted`, lg.status === 200, [lg.status, lg.body]);
    }
    const calls = await prisma.candidateMessage.findMany({ where: { candidateId: cands[0].id, channel: 'Call', template: 'CALL_QUEUE' } });
    check('K6 five Call rows (status LOGGED) on the candidate\'s history', calls.length === 5 && calls.every((c) => c.status === 'LOGGED'), calls.length);
    const fu = await prisma.applicationFollowUp.findFirst({ where: { candidateId: cands[0].id } });
    if (fu) check('K7 the open follow-up shows the last call (mode Call, outcome Call Back)', fu.contactMode === 'Call' && fu.outcome === 'Call Back', [fu.contactMode, fu.outcome]);
    const lgNo = await call('POST', '/api/messaging/reach/call-log', T.rec, { candidateId: cands[7].id, outcome: 'Answered' });
    check('K8 call log for a no-consent person is refused (409)', lgNo.status === 409, [lgNo.status, lgNo.body]);
    const lgBad = await call('POST', '/api/messaging/reach/call-log', T.rec, { candidateId: cands[0].id, outcome: 'Maybe' });
    check('K9 unknown outcome -> 400', lgBad.status === 400, lgBad.body);
    const lgOut = await call('POST', '/api/messaging/reach/call-log', T.rec, { candidateId: outsider.id, outcome: 'Answered' });
    check('K10 call log for a candidate outside your access -> 403', lgOut.status === 403, lgOut.status);
  } catch (e) {
    fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      if (KEEP) {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        const tokens = {};
        // long tokens for the UI: re-mint 6 hours
        for (const [k, id] of Object.entries({ admin: made.users[0], tl: made.users[1], rec: made.users[2], bdeTl: made.users[5], bde: made.users[6], acc: made.users[7] })) {
          tokens[k] = jwt.sign(tokenPayload(await resolveIdentity(id)), process.env.JWT_SECRET, { expiresIn: '6h' });
        }
        fs.writeFileSync(OUT, JSON.stringify({ made, tokens, run: RUN }, null, 1));
        console.log('KEPT fixtures; tokens in', OUT);
      } else {
        const left = await cleanup(made);
        console.log('leftovers after cleanup:', JSON.stringify(left));
        check('Z cleanup: nothing ZZTEST Reach is left in the sandbox', Object.values(left).every((n) => n === 0), left);
      }
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
