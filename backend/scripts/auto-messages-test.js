#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AUTOMATIC STAGE MESSAGES acceptance tests (2026-10-10). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/auto-messages-test.js
//
// Fixtures are ZZTEST rows in sandbox.db (users, client, job, people) and are removed again.
// Mail goes to the sandbox's fake transport; SMS / WhatsApp are stubbed in this process.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const R = require(path.join(BACK, 'src/utils/autoMessageRules'));
const AM = require(path.join(BACK, 'src/utils/autoMessages'));
const W = require(path.join(BACK, 'src/utils/autoMessageWriter'));
const messaging = require(path.join(BACK, 'src/utils/messaging'));
const { ALL_STAGE_CODES } = require(path.join(BACK, 'src/utils/atsVocab'));
const { recordStageCommunications } = require(path.join(BACK, 'src/utils/candidateComms'));

const RUN = Date.now().toString(36);
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
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const OK_DOMAIN = 'zztest-sandbox.in'; // not a reserved test domain, so the fake mail transport "sends"

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [], settings: [] };
  const keepSetting = await prisma.appSetting.findUnique({ where: { key: 'auto-messages' } });
  const keepSwitch = await prisma.appSetting.findUnique({ where: { key: 'interview-reminders' } });
  const realStatus = messaging.channelStatus;
  // The shared sandbox's SMS / WhatsApp accounts may be set up by other tests: in THIS process only Email is connected unless a test says otherwise.
  const emailOnly = async () => ({ Email: { configured: true, reason: null }, WhatsApp: { configured: false, reason: 'Not configured' }, SMS: { configured: false, reason: 'Not configured' } });
  messaging.channelStatus = emailOnly;
  const realAi = { chatJson: null, checkStatus: null };
  const aiMod = require(path.join(BACK, 'src/utils/ai'));
  realAi.chatJson = aiMod.chatJson; realAi.checkStatus = aiMod.checkStatus;
  try {
    // ---------------------------------------------------------------- fixtures
    await prisma.appSetting.deleteMany({ where: { key: 'auto-messages' } });
    R.invalidate();
    await prisma.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: JSON.stringify({ enabled: true }) }, update: { value: JSON.stringify({ enabled: true }) } });
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST AM ${tag} ${RUN}`, email: `zz-am-${tag}-${RUN}@example.test`, username: `zz-am-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({
          data: { employeeCode: `ZZTEST-AM-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, phone: '9111100000', email: `zz-am-emp-${tag}-${RUN}@${OK_DOMAIN}`, ...empExtra },
        });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uHr = await mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsAccess: true, hrmsRole: 'MANAGER' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uRecOther = await mkUser('recother', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, hr: uHr, mgr: uMgr, tl: uTl, rec: uRec, recOther: uRecOther, bde: uBde })) T[k] = await mint(u);
    const idAdmin = await resolveIdentity(uAdmin.id);

    const client = await prisma.client.create({ data: { name: `ZZTEST AM Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client' } });
    made.clients.push(client.id);
    const mkReq = async (tag, over = {}) => {
      const r = await prisma.requirement.create({
        data: {
          title: `ZZTEST AM Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, bdeId: uBde.id, tlId: uTl.id, openings: 3, ...over,
        },
      });
      made.reqs.push(r.id); return r;
    };
    const job = await mkReq('main');
    const jobB = await mkReq('other');
    const EMAIL = (tag) => `zz-am-cand-${tag}-${RUN}@${OK_DOMAIN}`;
    let seq = 0;
    const mkApp = async (stage, over = {}, candOver = {}, reqId = job.id) => {
      seq += 1;
      const c = await prisma.candidate.create({ data: { name: `ZZTEST AM Cand${seq} ${RUN}`, email: EMAIL(seq), phone: `98000${String(10000 + seq).slice(-5)}`, location: 'ZZ', ...candOver } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: reqId, stage, ...over } });
      made.apps.push(a.id);
      return { c, a };
    };
    const ctxOf = async (appId, user) => {
      const a = await prisma.application.findUnique({ where: { id: appId }, include: { candidate: true, requirement: { include: { client: true } } } });
      return { application: a, candidate: a.candidate, requirement: a.requirement, user: user || idAdmin };
    };
    // a step move in this process (the same call the routes make), with its own stage event
    let evSeq = 0;
    const move = async (appId, toStage, extra = {}) => {
      const cx = await ctxOf(appId);
      const fromStage = cx.application.stage;
      await prisma.application.update({ where: { id: appId }, data: { stage: toStage } });
      let eventId = extra.stageEventId;
      if (!eventId) {
        evSeq += 1;
        const ev = await prisma.applicationStageEvent.create({ data: { applicationId: appId, candidateId: cx.candidate.id, fromStage, toStage, action: 'ZZTEST move', actorUserId: uAdmin.id, actorName: uAdmin.name } });
        eventId = ev.id;
      }
      return AM.handleStageMove({ ...cx, application: { ...cx.application, stage: toStage }, fromStage, toStage, stageEventId: eventId, ...extra });
    };
    const rowsOf = (appId) => q('SELECT * FROM "ScheduledMessage" WHERE applicationId = ? ORDER BY createdAt ASC', appId);
    const lastRow = async (appId) => (await rowsOf(appId)).slice(-1)[0];
    const cmsgs = (candId) => prisma.candidateMessage.findMany({ where: { candidateId: candId }, orderBy: { createdAt: 'asc' } });
    const put = (token, body) => call('PUT', '/api/auto-messages/rules', token, body);
    const allOff = { quiet: { enabled: false } };

    // ============================================================== A. dormant until the first save
    {
      const r0 = await call('GET', '/api/auto-messages/rules', T.admin);
      check('A1 before any save: not started, defaults mirror today (11 steps ON)', r0.status === 200 && r0.body.started === false && r0.body.rules.filter((x) => x.rule.on).length === 11 && r0.body.rules.length === ALL_STAGE_CODES.length, { st: r0.status, started: r0.body && r0.body.started });
      const onSteps = r0.body.rules.filter((x) => x.rule.on).map((x) => x.stage).sort();
      const { TEMPLATES } = require(path.join(BACK, 'src/utils/candidateComms'));
      check('A2 the ON steps are exactly the ones that send today', JSON.stringify(onSteps) === JSON.stringify(Object.keys(TEMPLATES).sort()));
      const { a, c } = await mkApp('INTERVIEW_COMPLETED');
      const mv = await call('PATCH', `/api/applications/${a.id}/stage`, T.admin, { stage: 'SELECTED' });
      check('A3 a real move works (board/step popup path)', mv.status === 200, mv.body);
      const sm = await rowsOf(a.id);
      const msgs = await cmsgs(c.id);
      check('A4 dormant: the OLD path wrote its rows ("Stage change"), no scheduled row', sm.length === 0 && msgs.length >= 1 && msgs.every((m) => /^Stage change/.test(m.trigger)), { sm: sm.length, msgs: msgs.map((m) => m.trigger) });
    }

    // ============================================================== B. who may change the rules
    {
      for (const k of ['rec', 'tl', 'mgr', 'bde', 'recOther']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await put(T[k], { quiet: { enabled: false } });
        check(`B1 ${k} cannot change the rules`, r.status === 403, r.status);
      }
      for (const k of ['rec', 'tl', 'mgr', 'bde']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await call('GET', '/api/auto-messages/rules', T[k]);
        check(`B2 ${k} can read the rules`, r.status === 200 && r.body.canManage === false, r.status);
      }
      const bad = await put(T.admin, { rules: { SELECTED: { on: true, channels: [] } } });
      check('B3 a step ON with no way to send is refused in plain words', bad.status === 400 && /tick at least one/i.test(bad.body.error), bad.body);
      const bad2 = await put(T.admin, { rules: { SELECTED: { when: { mode: 'delay', minutes: 0 } } } });
      check('B4 "after 0 minutes" is refused', bad2.status === 400 && /between 1 and/.test(bad2.body.error), bad2.body);
      const bad3 = await put(T.admin, { quiet: { from: '25:99' } });
      check('B5 a bad quiet time is refused', bad3.status === 400, bad3.body);
      const still = await call('GET', '/api/auto-messages/rules', T.admin);
      check('B6 refused saves do not start the scheduler', still.body.started === false);
      const first = await put(T.hr, { ...allOff, supersedeMinutes: 10 });
      check('B7 HR can save; the first save starts the scheduler from "now"', first.status === 200 && first.body.started === true && first.body.justStarted === true && /Nobody who moved earlier/.test(first.body.message), first.body);
      const st = await call('GET', '/api/auto-messages/rules', T.admin);
      const goLive = Date.parse(st.body.settings.goLiveAt);
      check('B8 go-live time is set to about now', Math.abs(Date.now() - goLive) < 60000, st.body.settings.goLiveAt);
      const aud = await prisma.auditLog.findMany({ where: { entityId: 'auto-messages' }, orderBy: { createdAt: 'asc' } });
      check('B9 audit rows: started + quiet hours old -> new with who', aud.some((x) => x.action === 'Automatic messages started') && aud.some((x) => x.action === 'Automatic message rule changed' && /quiet/.test(x.fieldLabel || '') && x.fromValue === 'true' && x.toValue === 'false' && x.actorName === uHr.name), aud.map((x) => [x.action, x.fieldLabel, x.fromValue, x.toValue]));
      const second = await put(T.admin, { supersedeMinutes: 10 });
      check('B10 saving the same thing again changes nothing', second.status === 200 && second.body.changed === 0 && !second.body.justStarted, second.body);
      const h = await call('GET', '/api/auto-messages/history', T.rec);
      check('B11 history lists who changed what', h.status === 200 && h.body.rows.length >= 2, h.body);
    }
    R.invalidate();

    // ============================================================== C. every step creates a scheduled row; send-at is right
    {
      const settings = await R.loadSettings({ fresh: true });
      const results = {};
      for (const stage of ALL_STAGE_CODES) {
        // eslint-disable-next-line no-await-in-loop
        const { a } = await mkApp('NEW');
        // eslint-disable-next-line no-await-in-loop
        await move(a.id, stage);
        // eslint-disable-next-line no-await-in-loop
        const rows = await rowsOf(a.id);
        results[stage] = rows;
      }
      const onStages = ALL_STAGE_CODES.filter((s) => R.effectiveRule(s, settings).on);
      const offStages = ALL_STAGE_CODES.filter((s) => !R.effectiveRule(s, settings).on);
      check('C1 every step that is ON made exactly one row', onStages.every((s) => results[s].length === 1), onStages.filter((s) => results[s].length !== 1));
      check('C2 steps that are OFF made no row', offStages.every((s) => results[s].length === 0), offStages.filter((s) => results[s].length !== 0));
      check('C3 right-away rows were handed over at once (Email connected -> Sent)', onStages.every((s) => results[s][0].status === 'SENT'), onStages.map((s) => [s, results[s][0].status, results[s][0].statusReason]).filter((x) => x[1] !== 'SENT'));
      check('C4 all 21 step codes are known to the rules', ALL_STAGE_CODES.length === 21 && R.allRules(settings).length === 21);
    }

    // ============================================================== D. timing
    {
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'delay', minutes: 30 } } } });
      R.invalidate();
      const { a, c } = await mkApp('INTERVIEW_COMPLETED');
      const t0 = Date.now();
      await move(a.id, 'SELECTED');
      const row = await lastRow(a.id);
      const due = Number(row.sendAt);
      check('D1 "after 30 minutes": scheduled, send-at = now + 30 min', row.status === 'SCHEDULED' && Math.abs(due - (t0 + 30 * 60000)) < 15000, { st: row.status, diff: (due - t0) / 60000 });
      check('D2 nothing was sent yet', (await cmsgs(c.id)).length === 0);
      const early = await AM.processDue({ now: due - 60000 });
      check('D3 the sweep does not send before the time', (await lastRow(a.id)).status === 'SCHEDULED' && !early.sent);
      const late = await AM.processDue({ now: due + 1000 });
      const row2 = await lastRow(a.id);
      check('D4 the sweep sends it once the time has come (it reads the table)', row2.status === 'SENT' && late.sent >= 1 && (await cmsgs(c.id)).length >= 1, { row2: row2.status, late });
      check('D5 the log row says "Automatic: Selected" and which channel was used', (await cmsgs(c.id)).every((m) => /^Automatic: Selected/.test(m.trigger)) && JSON.parse(row2.resultJson).length >= 1);
      const again = await AM.processDue({ now: due + 5000 });
      check('D6 a second sweep sends nothing more', (await cmsgs(c.id)).length === JSON.parse(row2.resultJson).length && !again.sent);

      // next working hour (pure clock checks, IST)
      const ist = (y, m, d, h, mi) => R.istMs(y, m, d, h, mi);
      const s0 = await R.loadSettings();
      const sat2am = ist(2026, 9, 10, 2, 0); // Sat 10 Oct 2026 02:00
      const a1 = R.nextWorking(sat2am, s0);
      check('D7 next working hour: 02:00 -> same day 09:00', a1 === ist(2026, 9, 10, 9, 0), new Date(a1).toISOString());
      const sat10 = ist(2026, 9, 10, 10, 0);
      check('D8 inside working time it is now', R.nextWorking(sat10, s0) === sat10);
      const sat22 = ist(2026, 9, 10, 22, 0);
      const a2 = R.nextWorking(sat22, s0);
      check('D9 Saturday 22:00 -> Sunday is off -> Monday 09:00', a2 === ist(2026, 9, 12, 9, 0), new Date(a2).toISOString());
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'working' } } } });
      R.invalidate();
      const { a: a3 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a3.id, 'SELECTED', { now: sat22 });
      const r3 = await lastRow(a3.id);
      check('D10 "next working hour" row gets Monday 09:00 as its time', r3.status === 'SCHEDULED' && Number(r3.sendAt) === ist(2026, 9, 12, 9, 0), { st: r3.status, at: new Date(Number(r3.sendAt)).toISOString() });

      // approval first
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'approval' } } } });
      R.invalidate();
      const { a: a4, c: c4 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a4.id, 'SELECTED');
      const r4 = await lastRow(a4.id);
      check('D11 "wait for the recruiter": Waiting approval, nothing sent, a draft is ready', r4.status === 'WAITING_APPROVAL' && !r4.sendAt && /selected/i.test(r4.body || '') && (await cmsgs(c4.id)).length === 0, r4);
      const bell = await prisma.notification.findMany({ where: { userId: uRec.id, title: { contains: c4.name } } });
      check('D12 the job\'s recruiter got a bell line', bell.length === 1, bell.length);
      const sumRec = await call('GET', '/api/auto-messages/summary', T.rec);
      check('D13 the bell summary counts "waiting for an OK" for the recruiter', sumRec.status === 200 && sumRec.body.waitingApproval >= 1, sumRec.body);
      const sumOther = await call('GET', '/api/auto-messages/summary', T.recOther);
      check('D14 another department\'s recruiter does not count it', sumOther.body.waitingApproval === 0, sumOther.body);
      const noApprove = await call('POST', `/api/auto-messages/scheduled/${r4.id}/approve`, T.recOther);
      check('D15 an outside recruiter cannot approve (404)', noApprove.status === 404, noApprove.status);
      const mgrApprove = await call('POST', `/api/auto-messages/scheduled/${r4.id}/approve`, T.mgr);
      check('D16 a manager can see but not approve (403)', mgrApprove.status === 403, mgrApprove.status);
      const ed = await call('POST', `/api/auto-messages/scheduled/${r4.id}/edit`, T.rec, { subject: 'Great news', body: 'Hi {{firstName}}, we are happy to tell you about {{role}}. - {{recruiterName}}' });
      check('D17 the recruiter can reword the draft', ed.status === 200 && ed.body.row.edited === true && /happy to tell you/.test(ed.body.row.body), ed.body);
      const edBad = await call('POST', `/api/auto-messages/scheduled/${r4.id}/edit`, T.rec, { body: 'Hello {{nonsense}}' });
      check('D18 an unknown placeholder is refused', edBad.status === 400, edBad.body);
      const ap = await call('POST', `/api/auto-messages/scheduled/${r4.id}/approve`, T.rec);
      const m4 = await cmsgs(c4.id);
      check('D19 Approve & send: sent, and the reworded text is what went', ap.status === 200 && ap.body.row.status === 'SENT' && m4.some((m) => /happy to tell you/.test(m.body || '')), { st: ap.status, b: ap.body, msgs: m4.map((m) => m.body) });
      check('D20 the first name and the job were filled in; the client name was not', m4.every((m) => !(m.body || '').includes(client.name)) && m4.some((m) => (m.body || '').includes('ZZTEST')), m4.map((m) => m.body));
      const again2 = await call('POST', `/api/auto-messages/scheduled/${r4.id}/approve`, T.rec);
      check('D21 approving twice is refused', again2.status === 409, again2.status);
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'now' } } } });
      R.invalidate();
    }

    // ============================================================== E. one message per step move
    {
      const { a, c } = await mkApp('INTERVIEW_COMPLETED');
      const cx = await ctxOf(a.id);
      await prisma.application.update({ where: { id: a.id }, data: { stage: 'SELECTED' } });
      const ev = await prisma.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: c.id, fromStage: 'INTERVIEW_COMPLETED', toStage: 'SELECTED', action: 'ZZTEST', actorUserId: uAdmin.id, actorName: uAdmin.name } });
      const args = { ...cx, application: { ...cx.application, stage: 'SELECTED' }, fromStage: 'INTERVIEW_COMPLETED', toStage: 'SELECTED', stageEventId: ev.id };
      const r1 = await AM.handleStageMove(args);
      const r2 = await AM.handleStageMove(args);
      check('E1 the same step move twice makes ONE row and ONE message', (await rowsOf(a.id)).length === 1 && r2.duplicate === true && (await cmsgs(c.id)).length === (r1.rows || []).length, { rows: (await rowsOf(a.id)).length, r2 });
      // moved again later to the same step (a new event): the duplicate guard skips it
      await prisma.application.update({ where: { id: a.id }, data: { stage: 'INTERVIEW_COMPLETED' } });
      await move(a.id, 'SELECTED');
      const rows = await rowsOf(a.id);
      check('E2 the same step again within 24 h: a second row, SKIPPED as a repeat', rows.length === 2 && rows[1].status === 'SKIPPED' && /already went/.test(rows[1].statusReason), rows.map((x) => [x.status, x.statusReason]));
    }

    // ============================================================== F. moving again cancels the waiting one
    {
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'delay', minutes: 30 } } } });
      R.invalidate();
      const { a } = await mkApp('INTERVIEW_COMPLETED');
      await move(a.id, 'SELECTED');
      const w = await lastRow(a.id);
      await move(a.id, 'INTERVIEW_COMPLETED');
      const w2 = (await rowsOf(a.id)).find((x) => x.id === w.id);
      check('F1 moving back within the window cancels the waiting message', w.status === 'SCHEDULED' && w2.status === 'CANCELLED' && /moved to another step/.test(w2.statusReason), { was: w.status, now: w2.status, why: w2.statusReason });
      await AM.processDue({ now: Date.now() + 3 * 3600000 });
      check('F2 the cancelled message never goes out', (await rowsOf(a.id)).find((x) => x.id === w.id).status === 'CANCELLED');
      // outside the window it stays
      const { a: b } = await mkApp('INTERVIEW_COMPLETED');
      await move(b.id, 'SELECTED');
      const wb = await lastRow(b.id);
      await q('UPDATE "ScheduledMessage" SET createdAt = ? WHERE id = ?', Date.now() - 20 * 60000, wb.id);
      await move(b.id, 'INTERVIEW_COMPLETED');
      check('F3 older than the window (10 min) it is left alone', (await rowsOf(b.id)).find((x) => x.id === wb.id).status === 'SCHEDULED');
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'now' } } } });
      R.invalidate();
    }

    // ============================================================== G. bulk move: one message per application
    {
      const apps = [];
      for (let i = 0; i < 3; i += 1) apps.push((await mkApp('INTERVIEW_COMPLETED')).a);
      const r = await call('POST', '/api/applications/bulk', T.admin, { action: 'stage', stage: 'SELECTED', applicationIds: apps.map((x) => x.id) });
      const counts = await Promise.all(apps.map(async (x) => (await rowsOf(x.id)).length));
      check('G1 a bulk move made exactly one row per application', r.status === 200 && counts.every((n) => n === 1), { st: r.status, counts, b: r.body && r.body.failed });
    }

    // ============================================================== H. silent flag, no history
    {
      const { a, c } = await mkApp('INTERVIEW_COMPLETED');
      const cx = await ctxOf(a.id);
      const rows = await recordStageCommunications({ ...cx, fromStage: 'INTERVIEW_COMPLETED', toStage: 'SELECTED', silent: true });
      check('H1 silent move (imports / historical loads): no row, no message, nothing', rows.length === 0 && (await rowsOf(a.id)).length === 0 && (await cmsgs(c.id)).length === 0);
      const sw = await recordStageCommunications({ ...cx, fromStage: 'INTERVIEW_COMPLETED', toStage: 'SELECTED' });
      check('H2 the same move without the flag is scheduled and sent', (await rowsOf(a.id)).length === 1 && sw.length >= 1);
      const sweepOld = await AM.processDue({ now: Date.now() + 86400000 });
      const dormantApp = await prisma.applicationStageEvent.findFirst({ where: { action: { not: 'ZZTEST move' }, actorUserId: uAdmin.id, toStage: 'SELECTED' } });
      check('H3 a move made BEFORE go-live (step A3) has no scheduled row and never gets one', dormantApp ? (await rowsOf(dormantApp.applicationId)).length === 0 : true, sweepOld);
    }

    // ============================================================== I. the gates
    {
      // I1 consent withdrawn
      const { a: a1, c: c1 } = await mkApp('INTERVIEW_COMPLETED', {}, { consentStatus: 'WITHDRAWN', doNotContact: true });
      await move(a1.id, 'SELECTED');
      const r1 = await lastRow(a1.id);
      check('I1 consent withdrawn: skipped with the reason, nothing logged as sent', r1.status === 'SKIPPED' && /asked not to be contacted/.test(r1.statusReason) && (await cmsgs(c1.id)).length === 0, r1);
      // I2 the "Candidate emails" switch off
      await prisma.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: JSON.stringify({ enabled: false }) } });
      const { a: a2, c: c2 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a2.id, 'SELECTED');
      const r2 = await lastRow(a2.id);
      const m2 = await cmsgs(c2.id);
      check('I2 "Candidate emails" switch off: skipped, recorded "switched off", nothing queued', r2.status === 'SKIPPED' && /switched off/.test(r2.statusReason) && m2.length >= 1 && m2.every((m) => m.status === 'NOT_SENT_SWITCHED_OFF'), { r2: r2.statusReason, m2: m2.map((m) => m.status) });
      await prisma.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: JSON.stringify({ enabled: true }) } });
      // I3 kill switch
      await put(T.admin, { killSwitch: true });
      R.invalidate();
      const { a: a3, c: c3 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a3.id, 'SELECTED');
      const r3 = await lastRow(a3.id);
      check('I3 kill switch: a row says "switched off for the whole company", nothing sent', r3.status === 'SKIPPED' && /whole company/.test(r3.statusReason) && (await cmsgs(c3.id)).length === 0, r3);
      await put(T.admin, { killSwitch: false });
      R.invalidate();
      // I4 per-job
      const noJob = await call('PUT', `/api/auto-messages/jobs/${job.id}`, T.recOther, { mode: 'off' });
      const mgrJob = await call('PUT', `/api/auto-messages/jobs/${job.id}`, T.mgr, { mode: 'off' });
      check('I4 outside recruiter 404, manager 403 on a job\'s own setting', noJob.status === 404 && mgrJob.status === 403, [noJob.status, mgrJob.status]);
      const jo = await call('PUT', `/api/auto-messages/jobs/${job.id}`, T.rec, { mode: 'off' });
      const { a: a4, c: c4 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a4.id, 'SELECTED');
      const r4 = await lastRow(a4.id);
      check('I5 a job switched off: skipped "switched off for this job"', jo.status === 200 && r4.status === 'SKIPPED' && /for this requirement/.test(r4.statusReason) && (await cmsgs(c4.id)).length === 0, r4);
      await call('PUT', `/api/auto-messages/jobs/${job.id}`, T.rec, { mode: 'approval' });
      const { a: a5 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a5.id, 'SELECTED');
      check('I6 a job set to "recruiter approves first": Waiting approval even though the rule says right away', (await lastRow(a5.id)).status === 'WAITING_APPROVAL');
      const jg = await call('GET', `/api/auto-messages/jobs/${job.id}`, T.rec);
      check('I7 the job setting can be read back', jg.body.mode === 'approval' && jg.body.canSet === true, jg.body);
      await call('PUT', `/api/auto-messages/jobs/${job.id}`, T.rec, { mode: 'inherit' });
      check('I8 back to "follow the rules" removes the override', (await call('GET', `/api/auto-messages/jobs/${job.id}`, T.rec)).body.mode === 'inherit');
      // I9 pause a person
      const { a: a6, c: c6 } = await mkApp('INTERVIEW_COMPLETED');
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'delay', minutes: 30 } } } });
      R.invalidate();
      await move(a6.id, 'SELECTED');
      const pOut = await call('POST', `/api/auto-messages/people/${c6.id}/pause`, T.recOther, { paused: true });
      const pRec = await call('POST', `/api/auto-messages/people/${c6.id}/pause`, T.rec, { paused: true, reason: 'asked on the phone' });
      check('I9 pausing: outside recruiter 404; the recruiter can, and the waiting message is cancelled', pOut.status === 404 && pRec.status === 200 && pRec.body.cancelled === 1 && (await lastRow(a6.id)).status === 'CANCELLED', { pOut: pOut.status, pRec: pRec.body });
      await prisma.application.update({ where: { id: a6.id }, data: { stage: 'INTERVIEW_COMPLETED' } });
      await move(a6.id, 'SELECTED');
      const r6 = await lastRow(a6.id);
      check('I10 a paused person: the next move is skipped "paused"', r6.status === 'SKIPPED' && /paused/.test(r6.statusReason), r6);
      const sendPaused = await call('GET', `/api/auto-messages/scheduled?candidateId=${c6.id}`, T.rec);
      check('I11 the list marks them paused and offers Resume, not Pause', sendPaused.body.rows.every((x) => x.paused && x.can.resume && !x.can.pause), sendPaused.body.rows[0]);
      await call('POST', `/api/auto-messages/people/${c6.id}/pause`, T.rec, { paused: false });
      check('I12 resuming works', (await call('GET', `/api/auto-messages/people/${c6.id}`, T.rec)).body.paused === false);
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'now' } } } });
      R.invalidate();
      // I13 quiet hours (a window around NOW so the test works at any hour)
      const p = R.istParts(Date.now());
      const hh = (h) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
      await put(T.admin, { quiet: { enabled: true, from: hh(p.h - 1), to: hh(p.h + 2) } });
      R.invalidate();
      const { a: a7, c: c7 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a7.id, 'SELECTED');
      const r7 = await lastRow(a7.id);
      check('I13 quiet hours: deferred to the end of quiet time, nothing sent now', r7.status === 'SCHEDULED' && /quiet hours/.test(r7.statusReason) && Number(r7.sendAt) > Date.now() && (await cmsgs(c7.id)).length === 0, r7);
      const end = Number(r7.sendAt);
      check('I14 ...and goes out after quiet time ends', (await AM.processDue({ now: end + 1000 })).sent >= 1 && (await lastRow(a7.id)).status === 'SENT');
      const { a: a8, c: c8 } = await mkApp('SHARED_WITH_CLIENT');
      await move(a8.id, 'INTERVIEW_SCHEDULED');
      check('I15 an urgent step (interview booked) ignores quiet hours', (await lastRow(a8.id)).status === 'SENT' && (await cmsgs(c8.id)).length >= 1, await lastRow(a8.id));
      await put(T.admin, { quiet: { enabled: false } });
      R.invalidate();
      // I16 per-person daily cap
      await put(T.admin, { caps: { perCandidatePerDay: 1 } });
      R.invalidate();
      const { a: a9 } = await mkApp('RECRUITER_REVIEW');
      await put(T.admin, { rules: { RECRUITER_APPROVED: { on: true, channels: ['Email'] }, TL_REVIEW: { on: true, channels: ['Email'] } } });
      R.invalidate();
      await move(a9.id, 'RECRUITER_APPROVED');
      await move(a9.id, 'TL_REVIEW');
      const r9 = await rowsOf(a9.id);
      check('I16 per-person daily limit: the second message waits for tomorrow', r9.length === 2 && r9[0].status === 'SENT' && r9[1].status === 'SCHEDULED' && /limit 1/.test(r9[1].statusReason) && Number(r9[1].sendAt) > Date.now() + 3 * 3600000, r9.map((x) => [x.status, x.statusReason]));
      await put(T.admin, { caps: { perCandidatePerDay: 3 }, rules: { RECRUITER_APPROVED: { on: false }, TL_REVIEW: { on: false } } });
      R.invalidate();
      // I17 channel daily cap
      await put(T.admin, { caps: { perChannelPerDay: { Email: 1 } } });
      R.invalidate();
      const { a: a10, c: c10 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a10.id, 'SELECTED');
      const r10 = await lastRow(a10.id);
      check('I17 channel daily limit reached: skipped with the number', r10.status === 'SKIPPED' && /today's limit \(1\)/.test(r10.statusReason) && (await cmsgs(c10.id)).every((m) => !['QUEUED', 'SENT'].includes(m.status)), r10);
      await put(T.admin, { caps: { perChannelPerDay: { Email: 300 } } });
      R.invalidate();
      // I18 too late
      await put(T.admin, { maxAgeHours: 1, rules: { SELECTED: { when: { mode: 'delay', minutes: 30 } } } });
      R.invalidate();
      const { a: a11, c: c11 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a11.id, 'SELECTED');
      const r11 = await lastRow(a11.id);
      await AM.processDue({ now: Number(r11.sendAt) + 2 * 3600000 });
      const r11b = await lastRow(a11.id);
      check('I18 a message that could not go for the set time is dropped, not sent late', r11b.status === 'SKIPPED' && /could not go within 1 hours/.test(r11b.statusReason) && (await cmsgs(c11.id)).length === 0, r11b);
      await put(T.admin, { maxAgeHours: 48, rules: { SELECTED: { when: { mode: 'now' } } } });
      R.invalidate();
      // I19 phoned today (optional rule, off by default)
      const { a: a12, c: c12 } = await mkApp('INTERVIEW_COMPLETED');
      await prisma.candidateMessage.create({ data: { candidateId: c12.id, channel: 'Call', template: 'MANUAL', trigger: 'Manual', recipient: '', status: 'LOGGED' } });
      await move(a12.id, 'SELECTED');
      check('I19 phoned today but the rule is OFF by default: the message still goes', (await lastRow(a12.id)).status === 'SENT');
      await put(T.admin, { skipIfCalledToday: true });
      R.invalidate();
      const { a: a13, c: c13 } = await mkApp('INTERVIEW_COMPLETED');
      await prisma.candidateMessage.create({ data: { candidateId: c13.id, channel: 'Call', template: 'MANUAL', trigger: 'Manual', recipient: '', status: 'LOGGED' } });
      await move(a13.id, 'SELECTED');
      const r13 = await lastRow(a13.id);
      check('I20 with the rule ON: skipped "already phoned today"', r13.status === 'SKIPPED' && /phoned this person today/.test(r13.statusReason), r13);
      await put(T.admin, { skipIfCalledToday: false });
      R.invalidate();
      // I21 moved on before a rejection note goes
      await put(T.admin, { rules: { REJECTED: { when: { mode: 'delay', minutes: 30 } } } });
      R.invalidate();
      const { a: a14 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a14.id, 'REJECTED');
      const w14 = await lastRow(a14.id);
      await prisma.application.update({ where: { id: a14.id }, data: { stage: 'INTERVIEW_COMPLETED' } });
      await AM.processDue({ now: Number(w14.sendAt) + 1000 });
      const r14 = await lastRow(a14.id);
      check('I21 rejection reopened before it went: skipped "moved on", the candidate is never told', r14.status === 'SKIPPED' && /moved on/.test(r14.statusReason), r14);
      await put(T.admin, { rules: { REJECTED: { when: { mode: 'now' } } } });
      R.invalidate();
    }

    // ============================================================== J. channels, order and fallback
    {
      const wired = (over) => async () => {
        const base = { Email: { configured: true, reason: null }, WhatsApp: { configured: false, reason: 'Not configured' }, SMS: { configured: false, reason: 'Not configured' } };
        return { Email: { ...base.Email, ...(over.Email || {}) }, WhatsApp: { ...base.WhatsApp, ...(over.WhatsApp || {}) }, SMS: { ...base.SMS, ...(over.SMS || {}) } };
      };
      messaging.channelStatus = wired({ WhatsApp: { configured: true, reason: null } });
      // J1 first-that-works: WhatsApp has no approved template -> Email
      await put(T.admin, { rules: { SELECTED: { channels: ['WhatsApp', 'Email'], strategy: 'first' } } });
      R.invalidate();
      const { a: a1, c: c1 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a1.id, 'SELECTED');
      const r1 = await lastRow(a1.id);
      const m1 = await cmsgs(c1.id);
      check('J1 channel order with a fallback: Email used, and the log says why', r1.status === 'SENT' && m1.length === 1 && m1[0].channel === 'Email' && /Sent by Email because WhatsApp:/.test(m1[0].statusDetail), { r1: r1.status, m1: m1.map((m) => [m.channel, m.statusDetail]) });
      // J2 approved WhatsApp template -> WhatsApp first
      const waT = await prisma.messageTemplate.findFirst({ where: { purpose: 'SELECTED', channel: 'WhatsApp', builtIn: true } });
      const keepWa = { waTemplateName: waT.waTemplateName, waStatus: waT.waStatus };
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: { waTemplateName: 'zztest_selected', waStatus: 'Approved' } });
      const { a: a2, c: c2 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a2.id, 'SELECTED');
      const m2 = await cmsgs(c2.id);
      check('J2 WhatsApp approved + first in order: only WhatsApp is used (one channel)', m2.length === 1 && m2[0].channel === 'WhatsApp' && m2[0].status !== 'NOT_SENT_BLOCKED', m2.map((m) => [m.channel, m.status]));
      // J3 person's own preferred channel (Conversation) beats the order
      const { a: a3, c: c3 } = await mkApp('INTERVIEW_COMPLETED');
      await q('INSERT INTO "Conversation" (id, personType, personId, preferredChannel, createdAt, updatedAt) VALUES (?, \'CANDIDATE\', ?, \'Email\', ?, ?)', `zzconv${RUN}`, c3.id, Date.now(), Date.now());
      await move(a3.id, 'SELECTED');
      const m3 = await cmsgs(c3.id);
      check('J3 the person\'s preferred channel (Email) goes first', m3.length === 1 && m3[0].channel === 'Email', m3.map((m) => m.channel));
      await q('DELETE FROM "Conversation" WHERE id = ?', `zzconv${RUN}`);
      // J4 STOP on WhatsApp
      const { a: a4, c: c4 } = await mkApp('INTERVIEW_COMPLETED');
      const delivery = require(path.join(BACK, 'src/utils/messageDelivery'));
      const stopKey = `${delivery.OPTOUT_PREFIX}WhatsApp.${delivery.digitsOf(c4.phone)}`;
      await prisma.appSetting.create({ data: { key: stopKey, value: '1' } });
      await move(a4.id, 'SELECTED');
      const m4 = await cmsgs(c4.id);
      check('J4 replied STOP on WhatsApp: WhatsApp skipped, Email used with the reason', m4.length === 1 && m4[0].channel === 'Email' && /STOP/.test(m4[0].statusDetail), m4.map((m) => [m.channel, m.statusDetail]));
      await prisma.appSetting.delete({ where: { key: stopKey } });
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: keepWa });
      // J5 all channels, strategy "all": today's behaviour (a row per channel, honest states)
      messaging.channelStatus = wired({});
      await put(T.admin, { rules: { SELECTED: { channels: ['Email', 'WhatsApp', 'SMS'], strategy: 'all' } } });
      R.invalidate();
      const { a: a5, c: c5 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a5.id, 'SELECTED');
      const m5 = await cmsgs(c5.id);
      const by5 = Object.fromEntries(m5.map((m) => [m.channel, m.status]));
      check('J5 "all ticked": Email queued, WhatsApp/SMS recorded as not connected (as today)', m5.length === 3 && ['QUEUED', 'SENT'].includes(by5.Email) && by5.WhatsApp === 'NOT_SENT_NO_PROVIDER' && by5.SMS === 'NOT_SENT_NO_PROVIDER', by5);
      // J6 nothing can carry it
      messaging.channelStatus = wired({ Email: { configured: false, reason: 'No SMTP' } });
      await put(T.admin, { rules: { SELECTED: { channels: ['Email', 'WhatsApp'], strategy: 'first' } } });
      R.invalidate();
      const { a: a6 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a6.id, 'SELECTED');
      const r6 = await lastRow(a6.id);
      check('J6 no channel connected: SKIPPED with a reason for each channel; never "Sent"', r6.status === 'SKIPPED' && /Email is not connected/.test(r6.statusReason) && /WhatsApp is not connected/.test(r6.statusReason), r6);
      // J7 no address
      messaging.channelStatus = wired({});
      const { a: a7 } = await mkApp('INTERVIEW_COMPLETED', {}, { email: null });
      await put(T.admin, { rules: { SELECTED: { channels: ['Email'], strategy: 'first' } } });
      R.invalidate();
      await move(a7.id, 'SELECTED');
      const r7 = await lastRow(a7.id);
      check('J7 no email on record: skipped "No email address"', r7.status === 'SKIPPED' && /No email address/.test(r7.statusReason), r7);
      messaging.channelStatus = emailOnly;
      await put(T.admin, { rules: { SELECTED: { channels: ['Email', 'WhatsApp', 'SMS'], strategy: 'all' } } });
      R.invalidate();
    }

    // ============================================================== K. AI wording
    {
      const calls = [];
      let answer = null;
      aiMod.checkStatus = async () => ({ provider: 'stub', available: true, modelPulled: true, model: 'stub', reason: null });
      const stubChat = async (system, history) => { calls.push({ system, history }); return typeof answer === 'function' ? answer() : answer; };
      aiMod.chatJson = stubChat;
      const setWording = async (extra = {}) => {
        // in this process: the route would refuse AI while the real AI is off in the sandbox server
        const sv = await R.saveSettings(idAdmin, { rules: { SELECTED: { wording: 'AI', instruction: 'tone: friendly, short', channels: ['Email'], strategy: 'first', ...extra } } });
        if (sv.error) throw new Error(`setWording: ${sv.error}`);
        R.invalidate();
        const eff = R.effectiveRule('SELECTED', await R.loadSettings({ fresh: true }));
        if (eff.wording !== 'AI') throw new Error(`setWording did not stick: ${JSON.stringify(eff)}`);
      };
      const route = await put(T.admin, { rules: { OFFER: { wording: 'AI' } } });
      check('K1 the server refuses "AI writes it" while no AI is connected, in plain words', route.status === 409 && /cannot be switched on yet/.test(route.body.error), route.body);
      const rulesApi = await call('GET', '/api/auto-messages/rules', T.admin);
      check('K2 the rules screen says AI is not available and why', rulesApi.body.ai.available === false && !!rulesApi.body.ai.reason, rulesApi.body.ai);
      await setWording();
      const { a, c } = await mkApp('INTERVIEW_COMPLETED');
      const first = c.name.split(' ')[0];
      answer = {
        subject: `Good news ${first}`,
        body: `Hi ${first}, you have been selected for ${job.title}.\nYour package will be 12 LPA and we guarantee a joining date of 5 November.\nSee https://evil.example/offer for details.\nMr Sharma from ${client.name} will call you.\nYour recruiter ${uRec.name} will call you with the next steps.`,
      };
      await move(a.id, 'SELECTED');
      const row = await lastRow(a.id);
      const m = await cmsgs(c.id);
      const body = (m[0] && m[0].body) || '';
      check('K3 AI mode: sent, marked "AI-written" in the log trigger and on the row', row.status === 'SENT' && row.aiWritten === 1 && m.length === 1 && /^Automatic \(AI-written\): Selected/.test(m[0].trigger), { row: row.status, ai: row.aiWritten, trig: m.map((x) => x.trigger) });
      check('K4 the checker dropped the invented number, the pay, the link, the client name, the made-up person', !/LPA|guarantee|evil|Sharma|5 November/.test(body) && !body.includes(client.name) && /selected for/.test(body), body);
      check('K5 the real facts survived (name, job, recruiter)', body.includes(first) && body.includes(job.title) && body.includes(uRec.name), body);
      const prompt = JSON.stringify(calls[0]);
      check('K6 the prompt holds only real facts: first name, job, "our client"; never the client name, address or phone', prompt.includes(first) && prompt.includes('our client') && !prompt.includes(client.name) && !prompt.includes(c.email) && !prompt.includes(c.phone), prompt.slice(0, 600));
      check('K7 the prompt carries the rules (no invention, no salary promise, no discrimination) and the manager\'s instruction', /Never invent/.test(calls[0].system) && /age, gender/.test(calls[0].system) && /tone: friendly, short/.test(prompt));
      // recruiter contact is always there
      answer = { subject: 'Update', body: `Hi ${first}, you have been selected for ${job.title}. We will be in touch about the next step soon.` };
      const { a: a2, c: c2 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a2.id, 'SELECTED');
      const m2 = await cmsgs(c2.id);
      check('K8 the recruiter\'s name and phone are added from real data when the AI leaves them out', m2.length === 1 && m2[0].body.includes(uRec.name) && m2[0].body.includes('9111100000'), m2.map((x) => x.body));
      // everything invented -> template
      answer = { subject: 'x', body: 'Salary 15 LPA guaranteed. Call 9999911111 now. Visit https://x.example. Mr Verma is waiting.' };
      const { a: a3, c: c3 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a3.id, 'SELECTED');
      const r3 = await lastRow(a3.id); const m3 = await cmsgs(c3.id);
      check('K9 the AI text fails the check -> the template is used, the message is still sent, the reason is kept', r3.status === 'SENT' && r3.aiWritten === 0 && /did not pass the safety check/.test(r3.aiNote) && /selected for/i.test(m3[0].body) && !/^Automatic \(AI/.test(m3[0].trigger), { r3: r3.aiNote, m3: m3.map((x) => x.body) });
      // the AI call fails
      answer = () => { throw new Error('connection refused'); };
      const { a: a4, c: c4 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a4.id, 'SELECTED');
      const r4 = await lastRow(a4.id);
      check('K10 the AI fails: template used, nothing blocked', r4.status === 'SENT' && /could not write/.test(r4.aiNote) && (await cmsgs(c4.id)).length === 1, r4);
      // timeout
      aiMod.chatJson = () => new Promise(() => {});
      const t0 = Date.now();
      const wr = await W.write({ channel: 'Email', facts: { candidateFirstName: 'A', jobTitle: 'B' }, timeoutSeconds: 0.05 });
      check('K11 an AI that never answers is given up on (timeout)', wr.ok === false && /did not answer/.test(wr.reason) && Date.now() - t0 < 3000, wr);
      aiMod.chatJson = stubChat;
      // not for SMS / a WhatsApp chat that has to be started
      check('K12 AI wording is allowed on Email only (SMS and a new WhatsApp chat need templates)', W.channelAllowsAi('Email').ok && !W.channelAllowsAi('SMS').ok && !W.channelAllowsAi('WhatsApp').ok && W.channelAllowsAi('WhatsApp', { windowOpen: true }).ok);
      // two channels: AI called for Email only
      messaging.channelStatus = async () => ({ Email: { configured: true }, WhatsApp: { configured: true }, SMS: { configured: false, reason: 'x' } });
      const waT = await prisma.messageTemplate.findFirst({ where: { purpose: 'SELECTED', channel: 'WhatsApp', builtIn: true } });
      const keepWa = { waTemplateName: waT.waTemplateName, waStatus: waT.waStatus };
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: { waTemplateName: 'zztest_selected', waStatus: 'Approved' } });
      await setWording({ channels: ['Email', 'WhatsApp'], strategy: 'all' });
      answer = { subject: 'Hello', body: `Hi ${first}, you have been selected for ${job.title}. Your recruiter ${uRec.name} will call you.` };
      calls.length = 0;
      const { a: a5, c: c5 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a5.id, 'SELECTED');
      const m5 = await cmsgs(c5.id);
      const em = m5.find((x) => x.channel === 'Email'); const wa = m5.find((x) => x.channel === 'WhatsApp');
      check('K13 two channels: the AI wrote the Email only; WhatsApp used the approved template wording', calls.length === 1 && em && /^Automatic \(AI/.test(em.trigger) && wa && !/^Automatic \(AI/.test(wa.trigger), { calls: calls.length, t: m5.map((x) => x.trigger) });
      await prisma.messageTemplate.update({ where: { id: waT.id }, data: keepWa });
      messaging.channelStatus = emailOnly;
      // daily AI cap
      await R.saveSettings(idAdmin, { ai: { perDay: 0 } });
      R.invalidate();
      await setWording({ channels: ['Email'], strategy: 'first' });
      calls.length = 0;
      const { a: a6 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a6.id, 'SELECTED');
      const r6 = await lastRow(a6.id);
      check('K14 the daily AI limit stops AI writing (template used, no AI call)', calls.length === 0 && r6.status === 'SENT' && /AI limit/.test(r6.aiNote), { calls: calls.length, r6: r6.aiNote });
      await R.saveSettings(idAdmin, { ai: { perDay: 50 } });
      R.invalidate();
      // language
      await setWording({ language: 'Telugu' });
      answer = { subject: 'Hello', body: `Hi ${first}, you have been selected for ${job.title}. Your recruiter ${uRec.name} will call you.` };
      calls.length = 0;
      const { a: a7 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a7.id, 'SELECTED');
      check('K15 the language of the rule goes to the model', calls.length === 1 && /Write in Telugu/.test(calls[0].system), calls[0] && calls[0].system.slice(0, 120));
      // approval flow with AI: the draft is the AI text; approving sends exactly the draft, no second AI call
      await setWording({ language: 'Auto', when: { mode: 'approval' } });
      calls.length = 0;
      const { a: a8, c: c8 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a8.id, 'SELECTED');
      const r8 = await lastRow(a8.id);
      check('K16 waiting-for-OK with AI: the draft is AI-written and shown before anything goes', r8.status === 'WAITING_APPROVAL' && r8.aiWritten === 1 && /selected for/.test(r8.body) && (await cmsgs(c8.id)).length === 0, r8);
      const ap = await call('POST', `/api/auto-messages/scheduled/${r8.id}/approve`, T.rec);
      const m8 = await cmsgs(c8.id);
      check('K17 Approve & send sends exactly the draft (no second AI call), still marked AI-written', ap.status === 200 && m8.length === 1 && m8[0].body === r8.body && calls.length === 1 && /^Automatic \(AI/.test(m8[0].trigger), { st: ap.status, same: m8[0] && m8[0].body === r8.body, calls: calls.length, trig: m8[0] && m8[0].trigger });
      aiMod.chatJson = realAi.chatJson; aiMod.checkStatus = realAi.checkStatus;
      // back to template mode for the rest
      await R.saveSettings(idAdmin, { rules: { SELECTED: { wording: 'TEMPLATE', instruction: '', language: 'Auto', when: { mode: 'now' }, channels: ['Email', 'WhatsApp', 'SMS'], strategy: 'all' } } });
      R.invalidate();
    }

    // ============================================================== L. who sees what
    {
      await put(T.admin, { rules: { SELECTED: { channels: ['Email'], strategy: 'first' } } });
      R.invalidate();
      const { a: aSel, c: cSel } = await mkApp('INTERVIEW_COMPLETED');
      await move(aSel.id, 'SELECTED');
      const { a: aNew } = await mkApp('NEW');
      await put(T.admin, { rules: { NEW: { on: true, channels: ['Email'] } } });
      R.invalidate();
      await move(aNew.id, 'NEW');
      await put(T.admin, { rules: { NEW: { on: false } } });
      R.invalidate();
      await prisma.requirement.update({ where: { id: jobB.id }, data: { department: 'Medical', recruiterId: uRecOther.id, tlId: null, bdeId: null } });
      const { a: aOther } = await mkApp('INTERVIEW_COMPLETED', {}, {}, jobB.id);
      await move(aOther.id, 'SELECTED');
      const lAdmin = await call('GET', `/api/auto-messages/scheduled?candidateId=${cSel.id}`, T.admin);
      check('L1 admin sees the row and may act', lAdmin.body.rows.length === 1 && lAdmin.body.canAct === true);
      const lRec = await call('GET', '/api/auto-messages/scheduled?pageSize=200', T.rec);
      const idsRec = lRec.body.rows.map((r) => r.applicationId);
      check('L2 the recruiter sees their own job\'s messages, not another department\'s', idsRec.includes(aSel.id) && idsRec.includes(aNew.id) && !idsRec.includes(aOther.id), { n: idsRec.length });
      const lOther = await call('GET', '/api/auto-messages/scheduled?pageSize=200', T.recOther);
      check('L3 the other department\'s recruiter sees only theirs', lOther.body.rows.every((r) => r.applicationId === aOther.id) && lOther.body.rows.length === 1, lOther.body.rows.map((r) => r.candidateName));
      const lTl = await call('GET', '/api/auto-messages/scheduled?pageSize=200', T.tl);
      check('L4 the team lead sees the team\'s messages', lTl.body.rows.some((r) => r.applicationId === aSel.id) && !lTl.body.rows.some((r) => r.applicationId === aOther.id));
      const lBde = await call('GET', '/api/auto-messages/scheduled?pageSize=200', T.bde);
      const idsBde = lBde.body.rows.map((r) => r.applicationId);
      check('L5 the BDE sees only candidates at client steps (the "New" one is hidden)', idsBde.includes(aSel.id) && !idsBde.includes(aNew.id), { n: idsBde.length });
      check('L6 the BDE payload holds no candidate e-mail or phone', !/zz-am-cand|zztest-sandbox\.in|"phone"|"email"|98000\d{5}/.test(lBde.text), lBde.text.slice(0, 300));
      const lMgr = await call('GET', '/api/auto-messages/scheduled?pageSize=200', T.mgr);
      check('L7 the manager sees them but every button is off', lMgr.status === 200 && lMgr.body.rows.length > 0 && lMgr.body.rows.every((r) => Object.values(r.can).every((v) => v === false)), lMgr.body.rows[0] && lMgr.body.rows[0].can);
      check('L8 admin / recruiter / team lead payloads also hold no address or number', !/zztest-sandbox\.in|98000\d{5}/.test(lAdmin.text + lRec.text + lTl.text));
      // actions on a row
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'delay', minutes: 30 } } } });
      R.invalidate();
      const { a: aW, c: cW } = await mkApp('INTERVIEW_COMPLETED');
      await move(aW.id, 'SELECTED');
      const rowW = await lastRow(aW.id);
      const sBde = await call('POST', `/api/auto-messages/scheduled/${rowW.id}/send-now`, T.bde);
      const sOther = await call('POST', `/api/auto-messages/scheduled/${rowW.id}/cancel`, T.recOther);
      check('L9 BDE cannot send, an outside recruiter cannot cancel', sBde.status === 403 && sOther.status === 404, [sBde.status, sOther.status]);
      const sNow = await call('POST', `/api/auto-messages/scheduled/${rowW.id}/send-now`, T.rec);
      check('L10 "Send now" by the recruiter sends it at once', sNow.status === 200 && sNow.body.outcome === 'SENT' && (await cmsgs(cW.id)).length === 1, sNow.body);
      const cc = await call('POST', `/api/auto-messages/scheduled/${rowW.id}/cancel`, T.rec);
      check('L11 a sent message cannot be cancelled', cc.status === 409, cc.body);
      const { a: aC, c: cC } = await mkApp('INTERVIEW_COMPLETED');
      await move(aC.id, 'SELECTED');
      const rowC = await lastRow(aC.id);
      const can = await call('POST', `/api/auto-messages/scheduled/${rowC.id}/cancel`, T.tl, { reason: 'wrong person' });
      await AM.processDue({ now: Date.now() + 5 * 3600000 });
      check('L12 Cancel by the team lead: cancelled with who and why, nothing goes later', can.status === 200 && can.body.row.status === 'CANCELLED' && /wrong person/.test(can.body.row.statusReason) && (await cmsgs(cC.id)).length === 0, can.body);
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'now' } } } });
      R.invalidate();
      // filters with counts
      const all = await call('GET', '/api/auto-messages/scheduled?pageSize=200', T.admin);
      const sent = await call('GET', '/api/auto-messages/scheduled?status=SENT&pageSize=200', T.admin);
      check('L13 filters: status SENT narrows the list; stage options shrink to steps that have SENT rows, each with a count', sent.body.total < all.body.total && sent.body.rows.every((r) => r.status === 'SENT') && sent.body.facets.stages.every((s) => s.count > 0) && sent.body.facets.stages.reduce((n, s) => n + s.count, 0) === sent.body.total, { sent: sent.body.total, all: all.body.total, f: sent.body.facets.stages });
      check('L14 the status facet ignores its own filter (other states stay clickable, with counts)', sent.body.facets.statuses.length > 1 && sent.body.facets.statuses.reduce((n, s) => n + s.count, 0) === all.body.total);
      const dep = await call('GET', '/api/auto-messages/scheduled?department=Medical&pageSize=200', T.admin);
      check('L15 department filter', dep.body.total >= 1 && dep.body.rows.every((r) => r.department === 'Medical'));
      const ch = await call('GET', '/api/auto-messages/scheduled?channel=SMS&pageSize=200', T.admin);
      check('L16 channel filter (a rule that plans SMS)', ch.status === 200 && ch.body.rows.every((r) => r.channels.includes('SMS')));
      const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
      const dd = await call('GET', `/api/auto-messages/scheduled?from=${today}&to=${today}&pageSize=200`, T.admin);
      const todayRows = all.body.rows.filter((r) => new Date(Date.parse(r.sendAt || r.createdAt) + 330 * 60000).toISOString().slice(0, 10) === today).length;
      check('L17 date filter (today): rows planned for tomorrow drop out', dd.body.total === todayRows && todayRows <= all.body.total, [dd.body.total, todayRows, all.body.total]);
      const sum = await call('GET', '/api/auto-messages/summary', T.admin);
      check('L18 summary counts', sum.status === 200 && typeof sum.body.waitingApproval === 'number' && typeof sum.body.scheduled === 'number');
    }

    // ============================================================== M. restart survival
    {
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'delay', minutes: 30 }, channels: ['Email'], strategy: 'first' } } });
      R.invalidate();
      const { a, c } = await mkApp('INTERVIEW_COMPLETED');
      await move(a.id, 'SELECTED');
      const row = await lastRow(a.id);
      const { spawnSync } = require('child_process');
      const code = `process.env.DATABASE_URL=${JSON.stringify(SBX)};process.env.TEST_MODE='1';const AM=require(${JSON.stringify(path.join(BACK, 'src/utils/autoMessages'))});AM.processDue({now:${Number(row.sendAt) + 1000}}).then(r=>{console.log(JSON.stringify(r));process.exit(0)})`;
      const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', cwd: BACK });
      const after = await lastRow(a.id);
      check('M1 a brand-new process (a restart) finds the waiting row in the table and sends it', after.status === 'SENT' && (await cmsgs(c.id)).length === 1, { out: (child.stdout || '').slice(-200), err: (child.stderr || '').slice(-200), st: after.status });
      // a row stuck mid-send is never sent twice
      const { a: a2 } = await mkApp('INTERVIEW_COMPLETED');
      await move(a2.id, 'SELECTED');
      const r2 = await lastRow(a2.id);
      await q('UPDATE "ScheduledMessage" SET status = \'SENDING\', updatedAt = ? WHERE id = ?', Date.now() - 20 * 60000, r2.id);
      const sw = await AM.processDue({ now: Date.now() });
      const r2b = await lastRow(a2.id);
      check('M2 a row left "Sending" by a crash is marked as a problem, not sent again', sw.recovered >= 1 && r2b.status === 'FAILED' && /not sent again/.test(r2b.statusReason), r2b);
      await put(T.admin, { rules: { SELECTED: { when: { mode: 'now' }, channels: ['Email', 'WhatsApp', 'SMS'], strategy: 'all' } } });
      R.invalidate();
    }

    // ============================================================== N. preview with a real example
    {
      const pv = await call('POST', '/api/auto-messages/preview', T.rec, { stage: 'SELECTED', rule: { channels: ['Email', 'WhatsApp'] } });
      check('N1 preview uses a REAL person and job from the caller\'s area and shows each channel', pv.status === 200 && /^ZZTEST AM Cand/.test(pv.body.candidateName) && pv.body.channels.length === 2 && /selected/i.test(pv.body.channels[0].body), pv.body);
      check('N2 the preview holds no address or number, and not the client\'s name', !/zztest-sandbox\.in|98000\d{5}/.test(pv.text) && !pv.text.includes(client.name));
      const wa = pv.body.channels.find((x) => x.channel === 'WhatsApp');
      check('N3 a channel that cannot send says what is missing; AI is shown as not allowed on WhatsApp', wa && (wa.ready === true || (!!wa.why && wa.why.length > 10)) && wa.aiAllowed === false && !!wa.aiBlockedBecause, wa);
      check('N4 the preview says whether AI is available', pv.body.ai && pv.body.ai.available === false);
      const pvBde = await call('POST', '/api/auto-messages/preview', T.bde, { stage: 'SELECTED' });
      check('N5 a BDE can preview without contact data', pvBde.status === 200 && !/zztest-sandbox\.in|98000\d{5}/.test(pvBde.text));
      const sm = await call('GET', '/api/auto-messages/samples?stage=SELECTED', T.rec);
      check('N6 the real-example picker lists people with steps', sm.status === 200 && sm.body.rows.length >= 1 && sm.body.rows[0].atThisStep === true, sm.body.rows[0]);
      const out = await call('POST', '/api/auto-messages/preview', T.recOther, { stage: 'SELECTED', applicationId: (await prisma.application.findFirst({ where: { requirementId: job.id } })).id });
      check('N7 previewing with someone outside your area is refused', out.status === 404, out.status);
      const before = Number((await q('SELECT COUNT(*) AS n FROM "ScheduledMessage"'))[0].n);
      await call('POST', '/api/auto-messages/preview', T.rec, { stage: 'OFFER' });
      check('N8 a preview writes nothing', before === Number((await q('SELECT COUNT(*) AS n FROM "ScheduledMessage"'))[0].n));
    }

    // ============================================================== O. the daily summary and access
    {
      const ds = await call('GET', '/api/auto-messages/daily-summary', T.admin);
      check('O1 the daily summary line says what was sent / not sent', ds.status === 200 && /Automatic messages today:/.test(ds.body.line || '') && ds.body.sent > 0, ds.body);
      const run = await call('POST', '/api/auto-messages/run', T.rec);
      const run2 = await call('POST', '/api/auto-messages/run', T.hr);
      check('O2 only Admin / HR may press "send what is due"', run.status === 403 && run2.status === 200, [run.status, run2.status]);
      const ext = await call('GET', '/api/auto-messages/rules', undefined);
      check('O3 no login, no access', ext.status === 401, ext.status);
    }

    console.log(`\n(done) ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail += 1;
    console.error('TEST SCRIPT CRASHED:', e && e.stack ? e.stack : e);
  } finally {
    // ---------------------------------------------------------------- clean up
    messaging.channelStatus = realStatus;
    aiMod.chatJson = realAi.chatJson; aiMod.checkStatus = realAi.checkStatus;
    try {
      const candIds = made.cands;
      await q(`DELETE FROM "ScheduledMessage" WHERE candidateName LIKE 'ZZTEST AM%' OR candidateId IN (${candIds.map(() => '?').join(',') || "''"})`, ...candIds);
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: candIds } } });
      await prisma.applicationFollowUp.deleteMany({ where: { OR: [{ candidateId: { in: candIds } }, { applicationId: { in: made.apps } }] } });
      await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ candidateId: { in: candIds } }, { applicationId: { in: made.apps } }] } });
      if (prisma.interviewEvent) await prisma.interviewEvent.deleteMany({ where: { applicationId: { in: made.apps } } });
      await prisma.application.deleteMany({ where: { OR: [{ id: { in: made.apps } }, { candidateId: { in: candIds } }] } });
      await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'auto-messages.' } }, ...candIds.map((id) => ({ key: { contains: id } }))] } });
      await prisma.candidate.deleteMany({ where: { id: { in: candIds } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: 'auto-messages' }, { entityId: { in: [...made.apps, ...candIds, ...made.reqs] } }] } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      if (prisma.session) await prisma.session.deleteMany({ where: { userId: { in: made.users } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      await prisma.appSetting.deleteMany({ where: { key: 'auto-messages' } });
      if (keepSetting) await prisma.appSetting.create({ data: { key: keepSetting.key, value: keepSetting.value } });
      if (keepSwitch) await prisma.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: keepSwitch.value } });
      R.invalidate();
    } catch (e) { console.error('CLEANUP PROBLEM:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
