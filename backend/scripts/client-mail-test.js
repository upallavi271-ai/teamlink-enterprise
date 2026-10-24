#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLIENT MAIL acceptance tests (2026-10-12). SANDBOX ONLY (mail goes to a FAKE transport).
//
//   cd backend && TL_API=http://localhost:4011 node scripts/client-mail-test.js
//
// The report: "I mailed the client, it never left" - the Mail button of the client
// dialog was greyed out, because the "Client agreement link" message had no link yet
// and nothing said so. What is proved here:
//   L  the link placeholder: unresolved -> the server will not send it; after "Create
//      agreement link" it is filled; the BDE TL / own BDE may make it (not only Admins)
//   S  success / not set up / provider failure each answer with the truth (Sent /
//      Blocked / Failed + reason + time) - never "Sent" when nothing went
//   A  Act as: link create + link email + one-person send + bulk send all ask first
//      (409 ACT_CONFIRM_SEND) and go through with X-Act-Confirm
//   D  a one-letter-off address domain gets a gentle warning; the address is never changed
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
// in-process sends (provider failure) use a private job folder, never the real one
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-mailjobs-'));
process.env.MESSAGE_JOB_DIR = JOBS;
process.env.BULK_WORKER_INTERVAL_MS = '0';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
const SANDBOX_JOBS = path.join(process.env.TEAMLINK_SANDBOX_FILES || path.join(os.homedir(), '.teamlink-sandbox'), 'message-jobs');
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''}`);
}
async function call(method, p, token, body, headers) {
  const h = { 'X-Forwarded-For': '10.9.7.8', ...(headers || {}) };
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

(async () => {
  const made = { users: [], emps: [], clients: [] };
  const sids = [];
  let emailRowBefore = null;
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST CM ${tag} ${RUN}`, email: `zz-cm-${tag}-${RUN}@example.test`, username: `zz-cm-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({
          data: { employeeCode: `ZZTEST-CM-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra },
        });
        made.emps.push(e.id);
      }
      return u;
    };
    const uSa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsAccess: true, hrmsRole: 'SUPER_ADMIN' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = { sa: await mint(uSa), tl: await mint(uBdeTl), rec: await mint(uRec) };

    // The sandbox copy has the company mail connected; remember it so a "not set up" test can switch it off and back.
    emailRowBefore = await prisma.integration.findUnique({ where: { id: 'email' } });
    check('0 the sandbox copy has company mail connected (needed for the send tests)', !!emailRowBefore && emailRowBefore.enabled && emailRowBefore.connected, emailRowBefore && { e: emailRowBefore.enabled, c: emailRowBefore.connected });

    const doc = 'ZZTEST AGREEMENT TEXT\nThis agreement is between TeamLink and the client.';
    const mkClient = async (tag, email) => {
      const c = await prisma.client.create({
        data: {
          name: `ZZTEST CM Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client', contactName: 'Zed Contact', contactEmail: email,
          agreementDocument: doc, agreementStatus: 'SENT' /* 2026-10-13 agreement workflow: an unsent agreement must go BDE > HR > BDE TL first; these tests are about the link and the message, so the agreement is already past that */,
        },
      });
      made.clients.push(c.id); return c;
    };
    const mail = (tag) => `zz-contact-${tag}-${RUN}@zzfixture.in`; // not a reserved test domain: the FAKE transport takes it
    const c1 = await mkClient('one', mail('one'));
    const body = (c, extra) => ({ audience: 'clients', id: c.id, channel: 'Email', purposeKey: 'CLIENT_AGREEMENT_LINK', language: 'English', ...(extra || {}) });
    const pvBody = (c) => ({ audience: 'clients', ids: [c.id], channels: ['Email'], kind: 'individual', purposeKey: 'CLIENT_AGREEMENT_LINK', language: 'English' });

    // =============================== L: the link placeholder ==================================
    const p1 = await call('POST', '/api/messaging/preview', T.tl, pvBody(c1));
    const f1 = p1.body && p1.body.first;
    check('L1 no link yet: the BDE TL sees the message with {{agreementLink}} unresolved and it is NOT sendable', p1.status === 200 && f1 && f1.status === 'skipped' && (f1.missing || []).includes('agreementLink') && /\{\{agreementLink\}\}/.test(f1.text), [p1.status, f1]);
    const s1 = await call('POST', '/api/messaging/send', T.tl, body(c1));
    check('L2 sending it anyway sends NOTHING (status skipped / Missing), never "sent"', s1.status === 200 && s1.body.result && s1.body.result.status !== 'sent', [s1.status, s1.body]);
    const sOwn = await call('POST', '/api/messaging/send', T.tl, { ...body(c1), perChannel: { Email: { subject: 'Agreement', body: 'Please sign here: {{agreementLink}}' } } });
    check('L3 a hand-edited message that still has {{agreementLink}} is not sent either', sOwn.status === 200 && sOwn.body.result && sOwn.body.result.status !== 'sent', [sOwn.status, sOwn.body]);
    const mk = await call('POST', `/api/agreement/${c1.id}/link`, T.tl, {});
    check('L4 the BDE TL can make the agreement link (Create agreement link)', mk.status === 200 && mk.body.live === true && /^https?:\/\//.test(mk.body.url || ''), [mk.status, mk.body]);
    const p2 = await call('POST', '/api/messaging/preview', T.tl, pvBody(c1));
    const f2 = p2.body && p2.body.first;
    check('L5 after the link exists the message is filled in and ready (queued, no placeholder left)', f2 && f2.status === 'queued' && !/\{\{/.test(f2.text) && f2.text.includes(mk.body.url), [p2.status, f2]);
    const pRec = await call('POST', '/api/messaging/preview', T.rec, pvBody(c1));
    check('L6 a recruiter (no client rights) cannot message the client at all', pRec.status === 403 || (pRec.body && pRec.body.first == null), [pRec.status, pRec.body]);

    // =============================== S: truthful answers ======================================
    const s2 = await call('POST', '/api/messaging/send', T.tl, body(c1));
    const r2 = s2.body && s2.body.result;
    check('S1 success: Sent + address + a time (fake transport says so)', s2.status === 200 && r2 && r2.status === 'sent' && r2.sandbox === true && !!r2.at && r2.address === c1.contactEmail, [s2.status, s2.body]);
    // not set up: the channel is switched off
    await prisma.integration.update({ where: { id: 'email' }, data: { enabled: false } });
    const p3 = await call('POST', '/api/messaging/preview', T.tl, pvBody(c1));
    const s3 = await call('POST', '/api/messaging/send', T.tl, body(c1));
    await prisma.integration.update({ where: { id: 'email' }, data: { enabled: emailRowBefore.enabled } });
    check('S2 mail switched off: the dialog is told (notSetUp + the reason) and a send is Blocked, not Sent', p3.body.first.notSetUp === true && /switched off|not set up|disconnected/i.test(p3.body.first.reason || '') && s3.body.result && s3.body.result.status === 'blocked', [p3.body && p3.body.first, s3.body]);
    // provider failure (in-process, the fake transport made to refuse like a real SMTP login failure)
    const sandbox = require(path.join(BACK, 'src/utils/sandbox'));
    const realFake = sandbox.fakeMailTransport;
    sandbox.fakeMailTransport = () => ({ sandbox: true, async verify() { return true; }, async sendMail() { const e = new Error('Invalid login: 535 5.7.8 Authentication failed'); e.code = 'EAUTH'; e.responseCode = 535; throw e; }, close() {} });
    const bulk = require(path.join(BACK, 'src/utils/bulkMessaging'));
    const userTl = await resolveIdentity(uBdeTl.id);
    const f = await bulk.sendIndividual(userTl, body(c1));
    sandbox.fakeMailTransport = realFake;
    check('S3 provider failure (535 login refused): status failed with the provider reason and a time, never sent', f.result && f.result.status === 'failed' && /535|Authentication/.test(f.result.reason || '') && !!f.result.at, f);
    const hist = await prisma.$queryRawUnsafe('SELECT status, statusDetail FROM "ConversationMessage" WHERE personId = ? ORDER BY createdAt DESC LIMIT 3', c1.id);
    check('S4 the client history keeps a Failed line with the reason (and a Sent line from S1)', hist.some((h) => h.status === 'FAILED' && /535|Authentication/.test(h.statusDetail || '')) && hist.some((h) => h.status === 'SENT'), hist);

    // =============================== D: a typo in the address =================================
    const dom = String((await require(path.join(BACK, 'src/utils/mailer')).emailConfig()).fromAddress || '').split('@')[1] || '';
    const warn = bulk.addressWarning;
    const oneOff = dom ? `${dom.slice(0, 1)}${dom.slice(2)}` : 'gmal.com'; // one letter missing
    check('D1 the company domain one letter off gets a gentle warning that names the right one', dom && /did you mean/.test(warn(`x@${oneOff}`, [dom]) || '') && warn(`x@${oneOff}`, [dom]).includes(dom), [dom, oneOff]);
    check('D2 gmial.com -> "did you mean gmail.com?"; the real company domain and gmail.com get no warning', /gmail\.com/.test(warn('x@gmial.com', [dom]) || '') && warn(`x@${dom}`, [dom]) === null && warn('x@gmail.com', [dom]) === null);
    check('D3 a far-away domain gets no warning', warn('x@somethingelse.org', [dom]) === null);
    const c2 = await mkClient('typo', `zz-typo-${RUN}@gmial.com`);
    const p4 = await call('POST', '/api/messaging/preview', T.tl, { ...pvBody(c2), purposeKey: undefined, purpose: 'Message', perChannel: { Email: { subject: 'ZZTEST hello', body: 'ZZTEST hello' } } });
    check('D4 the preview carries the warning, the address itself is unchanged', p4.body && p4.body.first && /gmail\.com/.test(p4.body.first.warning || '') && p4.body.first.address === `zz-typo-${RUN}@gmial.com`, p4.body && p4.body.first);

    // =============================== A: Act as asks first =====================================
    const act = await call('POST', `/api/admin/view-as/${uBdeTl.id}/act`, T.sa);
    if (act.body && act.body.token) sids.push(jwt.decode(act.body.token).actAs.sid);
    const aTok = act.body && act.body.token;
    check('A0 Super Admin starts Act as the BDE TL', act.status === 200 && !!aTok, [act.status, act.body]);
    const c3 = await mkClient('act', mail('act'));
    const pa = await call('POST', '/api/messaging/preview', aTok, pvBody(c3));
    check('A1 acting as the BDE TL: the dialog preview works and shows the missing link (not a silent grey button)', pa.status === 200 && pa.body.first && (pa.body.first.missing || []).includes('agreementLink'), [pa.status, pa.body]);
    const la = await call('POST', `/api/agreement/${c3.id}/link`, aTok, {});
    check('A2 acting as the BDE TL: Create agreement link works (it was wrongly refused as "signing")', la.status === 200 && la.body.live === true, [la.status, la.body]);
    const e1 = await call('POST', `/api/agreement/${c3.id}/link/email`, aTok, {});
    check('A3 acting: "Email to client" asks first (409 ACT_CONFIRM_SEND)', e1.status === 409 && e1.body.code === 'ACT_CONFIRM_SEND', [e1.status, e1.body]);
    const e2 = await call('POST', `/api/agreement/${c3.id}/link/email`, aTok, {}, { 'X-Act-Confirm': 'send' });
    check('A4 ... and after the yes it goes (fake transport) and says emailed', e2.status === 200 && e2.body.emailed === true && e2.body.sandbox === true, [e2.status, e2.body]);
    const m1 = await call('POST', '/api/messaging/send', aTok, body(c3));
    check('A5 acting: the one-person Send mail asks first', m1.status === 409 && m1.body.code === 'ACT_CONFIRM_SEND', [m1.status, m1.body]);
    const m2 = await call('POST', '/api/messaging/send', aTok, body(c3), { 'X-Act-Confirm': 'send' });
    check('A6 ... and after the yes the result is Sent (fake), with a time', m2.status === 200 && m2.body.result && m2.body.result.status === 'sent' && !!m2.body.result.at, [m2.status, m2.body]);
    const b1 = await call('POST', '/api/messaging/bulk', aTok, { audience: 'clients', ids: [c3.id], channels: ['Email'], purposeKey: 'CLIENT_AGREEMENT_LINK', language: 'English', confirmPeople: 1 });
    check('A7 acting: a BULK send asks first too (it did not before)', b1.status === 409 && b1.body.code === 'ACT_CONFIRM_SEND', [b1.status, b1.body]);
    const b2 = await call('POST', '/api/messaging/bulk', aTok, { audience: 'clients', ids: [c3.id], channels: ['Email'], purposeKey: 'CLIENT_AGREEMENT_LINK', language: 'English', confirmPeople: 1 }, { 'X-Act-Confirm': 'send' });
    check('A8 ... and goes through after the yes', b2.status === 202, [b2.status, b2.body]);
    const sg = await call('POST', `/api/agreement/${c3.id}/company-seal`, aTok, {});
    check('A9 signing / stamping as someone else is STILL refused while acting', sg.status === 403 && sg.body.actAsBlocked === true, [sg.status, sg.body]);
    const ex = await call('POST', '/api/admin/view-as/act-exit', aTok);
    check('A10 exit Act as', ex.status === 200, [ex.status, ex.body]);
  } catch (e) {
    fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      if (emailRowBefore) await prisma.integration.update({ where: { id: 'email' }, data: { enabled: emailRowBefore.enabled } });
      const byName = await prisma.user.findMany({ where: { name: { contains: 'ZZTEST CM' } }, select: { id: true } });
      const ids = [...new Set([...made.users, ...byName.map((u) => u.id)])];
      const empByName = await prisma.employee.findMany({ where: { OR: [{ userId: { in: ids } }, { name: { contains: 'ZZTEST CM' } }] }, select: { id: true } });
      made.emps = [...new Set([...made.emps, ...empByName.map((e) => e.id)])];
      const clientRows = await prisma.client.findMany({ where: { name: { contains: 'ZZTEST CM' } }, select: { id: true } });
      const clientIds = [...new Set([...made.clients, ...clientRows.map((c) => c.id)])];
      const allIds = [...ids, ...clientIds, ...made.emps];
      for (const cid of clientIds) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe('DELETE FROM "ConversationMessage" WHERE "personId" = ?', cid).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe('DELETE FROM "Conversation" WHERE "personId" = ?', cid).catch(() => {});
      }
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
      const sidFilters = sids.map((s) => ({ reason: { contains: s } }));
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: allIds } }, { reason: { contains: 'ZZTEST' } }, { actorName: { contains: 'ZZTEST CM' } }, ...sidFilters] } });
      await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      // message-job files of the sandbox server that mention a ZZTEST CM client
      try {
        for (const n of fs.readdirSync(SANDBOX_JOBS)) {
          const f = path.join(SANDBOX_JOBS, n);
          if (/^bj_.*\.(json|delivery|cancel)$/.test(n) && fs.readFileSync(f, 'utf8').includes('ZZTEST CM')) fs.unlinkSync(f);
        }
      } catch { /* no job folder */ }
      try { fs.rmSync(JOBS, { recursive: true, force: true }); } catch { /* temp */ }
      const leftover = {
        users: await prisma.user.count({ where: { name: { contains: 'ZZTEST CM' } } }),
        clients: await prisma.client.count({ where: { name: { contains: 'ZZTEST CM' } } }),
        audit: await prisma.auditLog.count({ where: { OR: [{ actorName: { contains: 'ZZTEST CM' } }, { reason: { contains: 'ZZTEST' } }, ...sidFilters] } }),
        emailEnabledRestored: (await prisma.integration.findUnique({ where: { id: 'email' } })).enabled === (emailRowBefore && emailRowBefore.enabled) ? 0 : 1,
      };
      console.log('leftovers after cleanup:', JSON.stringify(leftover));
      check('Z cleanup: nothing ZZTEST CM is left in the sandbox, mail channel back as it was', Object.values(leftover).every((n) => n === 0), leftover);
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
