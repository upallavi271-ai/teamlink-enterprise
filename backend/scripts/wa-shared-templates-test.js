#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ONE WHATSAPP TEMPLATE FOR EVERY NUMBER - acceptance test (2026-10-22).
//   cd backend && node scripts/wa-shared-templates-test.js
//
// SAFE BY CONSTRUCTION (same as wa-multi-number-test.js)
//   * the real database is only OPENED READ-ONLY, to take a VACUUM INTO copy in the OS temp folder; every test runs on that copy (deleted at the end)
//   * the app under test is a SECOND server on a free port 4061..4099 with TEST_MODE=1; this process may only talk to loopback
//   * "Meta" is a LOCAL FAKE Graph API that knows two WhatsApp Business Accounts (WABAs), their tokens and their message templates
//   * no token is printed; every ZZTEST fixture lives only in the copy
//
// PHASES
//   L  one single connection (no number list): one account, one submit, the old single-account behaviour
//   M  two numbers in one WABA + one number in another WABA: one submit per WABA, mixed Approved / In review, chips
//   G  the send path: a number whose account has no approved copy is refused in plain words (nothing reaches Meta); the others send
//   P  permissions, idempotence, a template that already exists in Meta, editing resets, no secret anywhere
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SRC_DB = path.join(BACK, 'prisma', 'dev.db');
const RUN = Date.now().toString(36);
const TAG = 'ZZTEST WST';
let pass = 0; let fail = 0;
const failed = [];
const check = (n, ok, d) => {
  if (ok) pass += 1; else { fail += 1; failed.push(n); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---- the copy -------------------------------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shared-tpl-'));
const COPY = path.join(TMP, 'copy.db');
if (/dev\.db$/i.test(COPY)) { console.error('Refusing: the test database must not be dev.db'); process.exit(2); }
{
  const ro = new DatabaseSync(SRC_DB, { readOnly: true });
  ro.exec('PRAGMA busy_timeout = 30000');
  ro.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
  ro.close();
}
const DBURL = `file:${COPY.split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DBURL;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DBURL;
process.env.MESSAGE_JOB_DIR = path.join(TMP, 'jobs');
const raw = new DatabaseSync(COPY);
raw.exec('PRAGMA busy_timeout = 30000');
// the founder's real database may already hold real WhatsApp numbers: the COPY starts from the old single connection (nothing real is read or used)
raw.exec('DROP TABLE IF EXISTS "WaMessageMap"; DROP TABLE IF EXISTS "WaThread"; DROP TABLE IF EXISTS "WaNumberAccess"; DROP TABLE IF EXISTS "WaNumber"; DROP TABLE IF EXISTS "WaTemplateWaba";');
raw.exec("DELETE FROM AppSetting WHERE key LIKE 'wa.num.sec.%' OR key = 'wa.numbers.settings'");
const one = (sql, ...p) => raw.prepare(sql).get(...p);
const all = (sql, ...p) => raw.prepare(sql).all(...p);
const hasTable = (n) => !!one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", n);

// ---- the fake Meta Graph API (two WABAs with message templates) ------------------------------------------------------------
const phones = {}; // phone_number_id -> { token, meta }
const wabaToken = {}; // waba id -> token
const wabaPhones = {}; // waba id -> [phone ids]
const tpls = {}; // waba id -> { name -> { id, status, reason } }
const received = []; // { kind, id, auth, accepted, body }
let tplSeq = 0;
function startFake() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        const m = u.pathname.match(/^\/v\d+\.\d+\/([^/]+)(?:\/(messages|phone_numbers|subscribed_apps|message_templates))?$/);
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!m) return send(404, { error: { message: 'no such path', code: 100 } });
        const id = m[1]; const sub = m[2]; const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
        let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        if (sub === 'message_templates') {
          const ok = wabaToken[id] && auth === wabaToken[id];
          if (req.method === 'POST') {
            received.push({ kind: 'tpl_post', id, auth, accepted: !!ok, body: parsed });
            if (!ok) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
            tpls[id] = tpls[id] || {};
            if (tpls[id][parsed.name]) return send(400, { error: { message: 'Message template already exists', code: 100, error_subcode: 2388024, error_user_msg: 'A template with this name and language already exists.' } });
            tplSeq += 1;
            tpls[id][parsed.name] = { id: `9000${tplSeq}`, status: 'PENDING', reason: 'NONE', category: parsed.category };
            return send(200, { id: tpls[id][parsed.name].id, status: 'PENDING', category: parsed.category });
          }
          received.push({ kind: 'tpl_get', id, auth, accepted: !!ok });
          if (!ok) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
          const want = u.searchParams.get('name');
          const list = Object.entries(tpls[id] || {}).filter(([n]) => !want || n === want).map(([n, t]) => ({ id: t.id, name: n, status: t.status, category: t.category, rejected_reason: t.reason }));
          return send(200, { data: list });
        }
        if (sub === 'messages' && req.method === 'POST') {
          const p = phones[id];
          if (!p || auth !== p.token) { received.push({ kind: 'messages', id, auth, accepted: false, body: parsed }); return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } }); }
          received.push({ kind: 'messages', id, auth, accepted: true, body: parsed });
          return send(200, { messaging_product: 'whatsapp', contacts: [{ input: parsed.to, wa_id: parsed.to }], messages: [{ id: `wamid.${RUN}.${received.length}` }] });
        }
        if (sub === 'phone_numbers') return send(200, { data: (wabaPhones[id] || []).map((x) => ({ id: x })) });
        if (sub === 'subscribed_apps') return send(200, req.method === 'POST' ? { success: true } : { data: [{ id: 'app1' }] });
        if (!sub && req.method === 'GET') {
          const p = phones[id];
          if (!p) return send(400, { error: { message: 'Unsupported get request', code: 100 } });
          return send(200, { id, ...p.meta });
        }
        return send(404, { error: { message: 'nope', code: 100 } });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const posts = (from = 0) => received.slice(from).filter((r) => r.kind === 'tpl_post');
const msgs = (from = 0) => received.slice(from).filter((r) => r.kind === 'messages' && r.accepted);

// ---- helpers: ports, server, http -----------------------------------------------------------------------------------------------
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function freePort() {
  for (let p = 4061; p <= 4099; p += 1) {
    if (p === 4045) continue; // eslint-disable-line no-continue
    if (await portFree(p)) return p;
  }
  throw new Error('No free port between 4061 and 4099');
}
let API = ''; let serverProc = null; let serverLog = '';
async function startServer(port, env) {
  serverProc = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, ...env, PORT: String(port) } });
  serverProc.stdout.on('data', (d) => { serverLog += d; });
  serverProc.stderr.on('data', (d) => { serverLog += d; });
  API = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i += 1) {
    try { const r = await fetch(`${API}/api/health`); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(1000);
  }
  return false;
}
const bodies = [];
async function call(method, p, token, body) {
  const res = await fetch(`${API}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  bodies.push(text);
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text };
}

(async () => {
  const fake = await startFake();
  const FAKE = `http://127.0.0.1:${fake.port}`;
  process.env.TL_DEV_MESSAGING_BASE_URL = FAKE;
  process.env.TL_TEST_FAKE_GRAPH = '1';
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = function netGuard(input, init) {
    const u = new URL(typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url));
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return Promise.reject(new TypeError(`TEST BLOCKED outbound to ${u.hostname}`));
    return guardedFetch(input, init);
  };
  const port = await freePort();
  const prisma = require(path.join(BACK, 'src/db'));
  const CAT = require(path.join(BACK, 'src/utils/adminCatalog'));
  const { writeValues } = require(path.join(BACK, 'src/utils/integrationStore'));
  const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
  const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
  const WN = require(path.join(BACK, 'src/utils/waNumbers'));
  const WABA = require(path.join(BACK, 'src/outreach/tplWaba'));
  const wa = require(path.join(BACK, 'src/utils/whatsappCloud'));

  const T0 = `EAAZZLEGACY${RUN}${'x'.repeat(24)}`; const T1 = `EAAZZEDU${RUN}${'e'.repeat(26)}`;
  const P0 = '100000000000001'; const P1 = '100000000000011'; const P2 = '100000000000022';
  const W0 = '200000000000001'; const W1 = '200000000000002';
  const okMeta = (display, name) => ({ display_phone_number: display, verified_name: name, quality_rating: 'GREEN', code_verification_status: 'VERIFIED', name_status: 'APPROVED', status: 'CONNECTED' });
  phones[P0] = { token: T0, meta: okMeta('+91 90000 00000', 'ZZ Main') };
  phones[P1] = { token: T1, meta: okMeta('+91 90000 10001', 'ZZ Education') };
  phones[P2] = { token: T0, meta: okMeta('+91 90000 10002', 'ZZ Medical') };
  wabaToken[W0] = T0; wabaToken[W1] = T1; wabaPhones[W0] = [P0, P2]; wabaPhones[W1] = [P1];

  const w0 = await writeValues('whatsapp', { [CAT.WA_FIELDS.display]: '+91 90000 00000', [CAT.WA_FIELDS.phoneId]: P0, [CAT.WA_FIELDS.wabaId]: W0, [CAT.WA_FIELDS.token]: T0, [CAT.WA_FIELDS.language]: 'en', [CAT.WA_FIELDS.bulkTpl]: 'zz_bulk' });
  await prisma.integration.upsert({ where: { id: 'whatsapp' }, create: { id: 'whatsapp', values: JSON.stringify(w0.values), enabled: true, connected: true, state: 'Connected' }, update: { values: JSON.stringify(w0.values), enabled: true, connected: true, state: 'Connected', error: null } });

  const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
  const mkUser = async (tag, extra) => {
    const u = await prisma.user.create({ data: { ...base, name: `${TAG} ${tag} ${RUN}`, email: `zz-wst-${tag}-${RUN}@example.test`, username: `zz-wst-${tag}-${RUN}@example.test`, ...extra } });
    await prisma.employee.create({ data: { employeeCode: `ZZTEST-WST-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, email: u.email, phone: '9000000003', designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null } });
    return u;
  };
  const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
  const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
  const uEdu = await mkUser('edu', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
  const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '3h' });
  const TK = { admin: await mint(uAdmin), bde: await mint(uBde), edu: await mint(uEdu) };

  const SERVER_ENV = { TEST_MODE: '1', TL_TEST_FAKE_GRAPH: '1', TL_DEV_MESSAGING_BASE_URL: FAKE, TEST_MOCK_PORTS: String(fake.port), DATABASE_URL: DBURL, TEAMLINK_SANDBOX_FILES: path.join(TMP, 'files'), MESSAGE_JOB_DIR: path.join(TMP, 'jobs') };
  const up = await startServer(port, SERVER_ENV);
  check('0 the test server (copy database, fake Meta, TEST_MODE) is up', up, serverLog.slice(-400));
  if (!up) { await finish(1); return; }

  const G = '/api/outreach/gs/templates';
  const mkTpl = async (name, bodyText) => {
    const r = await call('POST', `${G}/outreach`, TK.admin, { name, channel: 'whatsapp', category: 'Utility', promotional: false, waLanguage: 'en_US', body: bodyText || 'Hi {{name}}, we have a {{job_title}} opening at {{company}} for you.' });
    return r.body && r.body.template ? r.body.template : { error: r };
  };
  const slugOf = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let marker = 0;

  try {
    // =================================================================================================================
    // L: ONE SINGLE CONNECTION
    // =================================================================================================================
    const tA = await mkTpl(`${TAG} legacy ${RUN}`);
    check('L0 an Admin writes a WhatsApp template', !!tA.id, tA);
    check('L0b the new table does not exist yet (reads and creating a template never make it)', !hasTable('WaTemplateWaba'));
    const vA0 = await call('GET', `${G}/outreach/${tA.id}/accounts`, TK.edu);
    check('L1 anybody who may read it sees ONE chip for the single connection: "Not sent yet"; no WABA id for a non-Admin', vA0.status === 200 && vA0.body.chips.length === 1 && vA0.body.chips[0].status === 'draft' && vA0.body.chips[0].word === 'Not sent yet' && vA0.body.canFix === false && !vA0.text.includes(W0), vA0.body);
    check('L1b looking made no table', !hasTable('WaTemplateWaba'));
    marker = received.length;
    const sA = await call('POST', `${G}/outreach/${tA.id}/submit-all`, TK.admin);
    check('L2 the Admin sends it to every account: ONE submit (the single connection), In review', sA.status === 200 && sA.body.results.length === 1 && sA.body.results[0].action === 'sent' && posts(marker).length === 1 && posts(marker)[0].id === W0 && posts(marker)[0].auth === T0 && sA.body.template.waApprovalStatus === 'pending', [sA.status, sA.body && sA.body.error, posts(marker).length]);
    check('L2b the same name is used: the slug of the template name', posts(marker)[0] && posts(marker)[0].body.name === slugOf(`${TAG} legacy ${RUN}`), posts(marker)[0] && posts(marker)[0].body);
    check('L2c the per-account table exists now with one row for the account', hasTable('WaTemplateWaba') && one('select count(*) n from WaTemplateWaba where templateId=?', tA.id).n === 1);
    const nameA = slugOf(`${TAG} legacy ${RUN}`);
    tpls[W0][nameA].status = 'APPROVED';
    const cA = await call('POST', `${G}/outreach/${tA.id}/check-all`, TK.admin);
    check('L3 "Check with Meta" copies ONLY Meta\'s answer: Approved', cA.status === 200 && cA.body.template.waApprovalStatus === 'approved' && cA.body.chips[0].status === 'approved', [cA.status, cA.body && cA.body.chips]);
    const oldSync = await call('POST', `${G}/outreach/${tA.id}/sync`, TK.admin, {});
    check('L3b the old single-account "Check with Meta" keeps its test-mode behaviour (409, Meta is not asked)', oldSync.status === 409 && oldSync.body.code === 'test_mode', [oldSync.status, oldSync.body]);

    // =================================================================================================================
    // M: THREE NUMBERS, TWO ACCOUNTS (Main + Medical in W0, Education in W1)
    // =================================================================================================================
    const mEdu = await call('POST', '/api/wa-numbers', TK.admin, { label: 'Education desk', displayNumber: '+91 90000 10001', phoneNumberId: P1, wabaId: W1, tokenMode: 'own', token: T1, language: 'en', check: false });
    const mMed = await call('POST', '/api/wa-numbers', TK.admin, { label: 'Medical desk', displayNumber: '+91 90000 10002', phoneNumberId: P2, wabaId: W0, tokenMode: 'shared', check: false });
    check('M0 the Admin adds Education (account 2) and Medical (account 1, shared token); the Main number joins the list', mEdu.status === 200 && mMed.status === 200 && mEdu.body.ok && mMed.body.ok, [mEdu.body, mMed.body]);
    const idEdu = mEdu.body.id; const idMed = mMed.body.id;
    const idMain = ((await call('GET', '/api/wa-numbers', TK.admin)).body.numbers.find((n) => n.isMain) || {}).id;
    WN.bust(); WABA.bust();
    const acc = await WABA.accounts();
    check('M1 two numbers of one WABA are ONE account: 3 numbers -> 2 accounts', acc.listed && acc.accounts.length === 2 && acc.accounts.find((a) => a.wabaId === W0).numbers.length === 2, acc.accounts.map((a) => [a.key, a.numbers.length]));

    const tB = await mkTpl(`${TAG} shared ${RUN}`);
    const nameB = slugOf(`${TAG} shared ${RUN}`);
    const vB = await call('GET', `${G}/outreach/${tB.id}/accounts`, TK.admin);
    check('M2 before sending: three chips, all "Not sent yet"', vB.status === 200 && vB.body.chips.length === 3 && vB.body.chips.every((c) => c.status === 'draft'), vB.body);
    marker = received.length;
    const sB = await call('POST', `${G}/outreach/${tB.id}/submit-all`, TK.admin);
    const pb = posts(marker);
    check('M3 submit to every account: exactly TWO submits (one per WABA, never one per number), each with its own token', sB.status === 200 && pb.length === 2 && pb.some((p) => p.id === W0 && p.auth === T0) && pb.some((p) => p.id === W1 && p.auth === T1), [sB.status, sB.body && sB.body.error, pb.map((p) => [p.id, p.accepted])]);
    check('M3b the same template name was sent to both accounts', pb.every((p) => p.body.name === nameB) && pb[0].body.language === 'en_US', pb.map((p) => p.body && p.body.name));
    check('M3c both accounts In review; three chips In review', sB.body.chips.length === 3 && sB.body.chips.every((c) => c.status === 'pending' && c.word === 'In review'), sB.body.chips);
    check('M3d results name the numbers per account, not the ids', sB.body.results.length === 2 && sB.body.results.some((r) => r.numbers.includes('Medical desk') && r.numbers.includes('Main number')) && !sB.text.includes(W1), sB.body.results);

    // mixed: account 1 approves, account 2 still reviewing
    tpls[W0][nameB].status = 'APPROVED';
    const cB = await call('POST', `${G}/outreach/${tB.id}/check-all`, TK.admin);
    const byLabel = Object.fromEntries((cB.body.chips || []).map((c) => [c.label, c.status]));
    check('M4 mixed: Main + Medical Approved, Education In review (each account\'s own answer)', cB.status === 200 && byLabel['Main number'] === 'approved' && byLabel['Medical desk'] === 'approved' && byLabel['Education desk'] === 'pending', byLabel);
    check('M4b the summary (the old column) says Approved because one account approved it', cB.body.template.waApprovalStatus === 'approved');
    const lst = await call('GET', `${G}/list?channel=whatsapp&where=all`, TK.admin);
    const rowB = (lst.body.items || []).find((i) => i.id === tB.id);
    check('M5 the templates list carries the chips of every number', rowB && Array.isArray(rowB.accountChips) && rowB.accountChips.length === 3 && rowB.accountChips.some((c) => c.label === 'Education desk' && c.word === 'In review'), rowB && rowB.accountChips);

    // =================================================================================================================
    // G: THE SEND PATH
    // =================================================================================================================
    WN.bust(); WABA.bust();
    const cfgEdu = await WN.configOf(idEdu); const cfgMed = await WN.configOf(idMed);
    const probEdu = await wa.templateAccountProblem(cfgEdu, nameB);
    const probMed = await wa.templateAccountProblem(cfgMed, nameB);
    check('G1 the guard: Education (account 2, still in review) is refused in plain words; Medical (account 1, approved) is fine', /still being checked by Meta/.test(probEdu || '') && /Education desk/.test(probEdu || '') && probMed === null, [probEdu, probMed]);
    marker = received.length;
    const tplSend = (numberId, to) => wa.sendWhatsApp({ to, kind: 'bulk', text: 'x', vars: ['Anita'], template: { name: nameB, language: 'en_US', vars: ['Anita'] }, numberId, automatic: true });
    const rEdu = await tplSend(idEdu, '9000000771');
    check('G2 sending the template from Education: blocked BEFORE Meta (no message request, code TEMPLATE_OTHER_ACCOUNT, plain reason)', rEdu.ok === false && rEdu.blocked === true && rEdu.code === 'TEMPLATE_OTHER_ACCOUNT' && /still being checked/.test(rEdu.error) && msgs(marker).length === 0, [rEdu, msgs(marker).length]);
    const rMed = await tplSend(idMed, '9000000772');
    check('G3 the same template from Medical goes out (fake Meta got it on the Medical phone id, with the shared name)', rMed.ok === true && msgs(marker).length === 1 && msgs(marker)[0].id === P2 && msgs(marker)[0].body.template.name === nameB, [rMed, msgs(marker).map((m) => m.id)]);
    const rMain = await tplSend(idMain, '9000000773');
    check('G3b ...and from the Main number (same account)', rMain.ok === true && msgs(marker).some((m) => m.id === P0), rMain);
    const rPlain = await wa.sendWhatsApp({ to: '9000000774', kind: 'bulk', text: 'ZZTEST plain', vars: ['ZZTEST plain'], numberId: idEdu, automatic: true });
    check('G4 a message with no library template (the number\'s default templates / plain text) is not touched by the guard', rPlain.ok === true && msgs(marker).some((m) => m.id === P1), rPlain);
    // console: ONE list, per-number status
    const opt = await call('GET', '/api/outreach/gs/console/options', TK.admin);
    const ctpl = opt.body && opt.body.templates && opt.body.templates.whatsapp ? opt.body.templates.whatsapp.find((t) => t.key === `outreach:${tB.id}`) : null;
    check('G5 the Communication Console lists the template ONCE for every sender, with the status per sender number', !!ctpl && ctpl.byNumber && ctpl.byNumber[`wan:${idMed}`].ok === true && ctpl.byNumber[`wan:${idEdu}`].ok === false && /Education desk/.test(ctpl.byNumber[`wan:${idEdu}`].reason), ctpl);
    check('G5b the console says who may press the fix (Admin yes)', opt.body.isAdmin === true);
    const optB = await call('GET', '/api/outreach/gs/console/options', TK.bde);
    check('G5c ...and a BDE (not an Admin) is told isAdmin=false, so the screen says "Ask an Admin"', optB.status !== 200 || optB.body.isAdmin === false, [optB.status, optB.body && optB.body.isAdmin]);
    const run = await call('POST', '/api/outreach/gs/console/send', TK.admin, { channel: 'whatsapp', accountId: `wan:${idEdu}`, templateKey: `outreach:${tB.id}`, name: `${TAG} run ${RUN}`, source: 'crm', contactIds: [] });
    check('G6 the console refuses the send from Education with the plain reason (409), instead of letting Meta fail', run.status === 409 && /Education desk/.test((run.body && run.body.error) || '') && run.body.code === 'TEMPLATE_OTHER_ACCOUNT', [run.status, run.body]);

    // Education approves; everybody can use it
    tpls[W1][nameB].status = 'APPROVED';
    const cB2 = await call('POST', `${G}/outreach/${tB.id}/check-all`, TK.admin);
    WABA.bust();
    const rEdu2 = await tplSend(idEdu, '9000000775');
    check('G7 once Meta approves it for account 2 too, Education sends the same template', cB2.body.chips.every((c) => c.status === 'approved') && rEdu2.ok === true && msgs(marker).some((m) => m.id === P1 && m.body.template && m.body.template.name === nameB), [cB2.body.chips, rEdu2]);

    // =================================================================================================================
    // P: PERMISSIONS, IDEMPOTENCE, EXISTING IN META, EDITS, SECRETS
    // =================================================================================================================
    marker = received.length;
    const again = await call('POST', `${G}/outreach/${tB.id}/submit-all`, TK.admin);
    check('P1 a second "send to every account" changes nothing: no new submit, every account "already" there', again.status === 200 && posts(marker).length === 0 && again.body.results.every((r) => r.action === 'already'), [again.status, posts(marker).length, again.body && again.body.results]);
    check('P1b ...and it asked Meta nothing that creates anything (only no POST)', posts(marker).length === 0);
    marker = received.length;
    const nb = await call('POST', `${G}/outreach/${tB.id}/submit-all`, TK.bde);
    const ne = await call('POST', `${G}/outreach/${tB.id}/submit-all`, TK.edu);
    check('P2 a BDE and a recruiter (not Admins) cannot send to every account: 403, nothing reached Meta', nb.status === 403 && ne.status === 403 && posts(marker).length === 0 && received.slice(marker).filter((r) => r.kind === 'tpl_get').length === 0, [nb.status, ne.status]);
    const ec = await call('POST', `${G}/outreach/${tB.id}/check-all`, TK.edu);
    check('P2b a recruiter cannot ask Meta either (403)', ec.status === 403, ec.status);
    const anon = await call('POST', `${G}/outreach/${tB.id}/submit-all`, null);
    check('P2c no login -> 401', anon.status === 401, anon.status);

    // a template that already exists in Meta (made by hand in Business Manager) in account 2 only
    const tC = await mkTpl(`${TAG} byhand ${RUN}`);
    const nameC = slugOf(`${TAG} byhand ${RUN}`);
    tplSeq += 1; tpls[W1] = tpls[W1] || {}; tpls[W1][nameC] = { id: `9000${tplSeq}`, status: 'APPROVED', reason: 'NONE', category: 'UTILITY' };
    marker = received.length;
    const sC = await call('POST', `${G}/outreach/${tC.id}/submit-all`, TK.admin);
    const pc = posts(marker);
    check('P3 a template Meta already has in account 2 is NOT created again there (Meta\'s answer is copied: Approved); only account 1 gets a submit', sC.status === 200 && pc.length === 1 && pc[0].id === W0 && sC.body.results.some((r) => r.action === 'found' && r.status === 'approved') && sC.body.results.some((r) => r.action === 'sent'), [sC.status, sC.body && sC.body.error, pc.map((p) => p.id), sC.body && sC.body.results]);
    const chipsC = Object.fromEntries((sC.body.chips || []).map((c) => [c.label, c.status]));
    check('P3b chips: Education Approved, Main + Medical In review', chipsC['Education desk'] === 'approved' && chipsC['Medical desk'] === 'pending' && chipsC['Main number'] === 'pending', chipsC);

    // Meta refuses one account: the failure is kept as a plain reason, the other account is still done
    const tD = await mkTpl(`${TAG} refused ${RUN}`);
    const nameD = slugOf(`${TAG} refused ${RUN}`);
    wabaToken[W1] = `${T1}-expired`; // account 2 now answers 190 to every call
    const sD = await call('POST', `${G}/outreach/${tD.id}/submit-all`, TK.admin);
    wabaToken[W1] = T1;
    check('P4 when one account does not answer, the other is still done and the failure is shown in plain words', sD.status === 200 && sD.body.results.some((r) => r.action === 'sent') && sD.body.results.some((r) => r.action === 'failed' && /Meta/.test(r.error)) && sD.body.chips.some((c) => c.label === 'Education desk' && c.status === 'draft'), [sD.status, sD.body && sD.body.results]);

    // editing the words sends every account back to Meta
    const ed = await call('PUT', `${G}/outreach/${tB.id}`, TK.admin, { body: 'Hello {{name}}, a different opening: {{job_title}} at {{company}}.' });
    const vB2 = await call('GET', `${G}/outreach/${tB.id}/accounts`, TK.admin);
    WABA.bust();
    check('P5 changing the words resets every account to "Not sent yet" (the old approval was for the old words)', ed.status === 200 && ed.body.resubmit === true && vB2.body.chips.every((c) => c.status === 'draft') && /has not been sent to Meta/.test((await wa.templateAccountProblem(await WN.configOf(idMed), nameB)) || ''), [ed.status, ed.body && ed.body.resubmit, vB2.body.chips]);

    // no secret anywhere
    const allText = bodies.join('\n') + serverLog;
    const auditText = JSON.stringify(all("select action, entity, entityId, fromValue, toValue, reason, actorName from AuditLog where entity='OutreachTemplate'"));
    const dbText = JSON.stringify(all('select * from WaTemplateWaba'));
    const leaks = [['T0', T0], ['T1', T1]].filter(([, v]) => allText.includes(v) || auditText.includes(v) || dbText.includes(v)).map(([k]) => k);
    check('P6 no access token appears in any response, the server log, the audit log or the new table', leaks.length === 0, leaks);
    const nonAdminText = [vA0.text, ne.text, nb.text, optB.text].join('');
    check('P6b a non-Admin never sees a WhatsApp Business Account id', !nonAdminText.includes(W0) && !nonAdminText.includes(W1));
    const audits = all("select action from AuditLog where entity='OutreachTemplate'").map((r) => r.action);
    check('P7 the audit log has a row for "sent to every WhatsApp account"', audits.includes('WhatsApp template sent to every WhatsApp account'), audits.slice(-5));
    check('P8 no template of the old kind was touched: the summary column still has only the five known words', all('select distinct waApprovalStatus s from OutreachTemplate where name like ?', `${TAG}%`).every((r) => ['draft', 'pending', 'approved', 'rejected', null].includes(r.s)));

    // the files
    const mig = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261022120000_wa_template_waba', 'migration.sql'), 'utf8');
    const rb = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261022120000_wa_template_waba', 'rollback.sql'), 'utf8');
    let e1 = null; try { raw.exec(mig); raw.exec(mig); } catch (e) { e1 = e.message; }
    check('P9 migration.sql applies twice cleanly (additive, IF NOT EXISTS)', e1 === null && hasTable('WaTemplateWaba'), e1);
    await stopServer();
    let e2 = null; try { raw.exec(rb); } catch (e) { e2 = e.message; }
    check('P9b rollback.sql removes the table and nothing else (templates keep their summary status)', e2 === null && !hasTable('WaTemplateWaba') && one('select count(*) n from OutreachTemplate where name like ?', `${TAG}%`).n >= 4, e2);

    // the real database was not touched
    const ro = new DatabaseSync(SRC_DB, { readOnly: true });
    const left = ro.prepare("select count(*) n from OutreachTemplate where name like 'ZZTEST WST%'").get().n;
    const hasNew = ro.prepare("select count(*) n from sqlite_master where name='WaTemplateWaba'").get().n;
    ro.close();
    check('P10 the real database has no ZZTEST WST row and no new table (everything ran in the copy)', left === 0 && hasNew === 0, [left, hasNew]);
  } catch (e) {
    check('FATAL test error', false, `${e && e.stack}`.slice(0, 900));
  }
  await finish(0);

  async function stopServer() {
    const pr = serverProc; if (!pr) return;
    await new Promise((res) => { pr.once('exit', res); pr.kill(); setTimeout(res, 6000); });
    serverProc = null;
  }
  async function finish(code) {
    try { if (serverProc) serverProc.kill(); } catch { /* done */ }
    try { fake.srv.close(); } catch { /* done */ }
    try { raw.close(); } catch { /* done */ }
    try { await prisma.$disconnect(); } catch { /* done */ }
    await sleep(500);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
    console.log(`\n${pass} passed, ${fail} failed${failed.length ? `\nFailed: ${failed.join(' | ')}` : ''}`);
    process.exit(fail || code ? 1 : 0);
  }
})().catch((e) => { console.error('crash', e); process.exit(1); });
