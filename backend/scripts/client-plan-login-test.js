#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PLANS > "Client login" (2026-11-25): acceptance test. SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4063 node scripts/client-plan-login-test.js
//
// What it proves (routes/portalLogins.js /marketing-plan/..., marketing/clientServices.js planRow, db.js "mkonly_" middleware, migration 20261125160000):
//   A  an Admin presses "Client login" on a client plan whose company has NO AI Marketing record: a record is made FOR AI MARKETING ONLY (Client.marketingOnly, no ATS client ID, no agreement),
//      the "Social posts" login is added with the one-time set-password link, no password in any answer, the person sets a password and signs in and lands on the dashboard
//   B  a refused login (no name, bad email) leaves NO empty record behind; the same email twice is refused; the 3-login limit is kept; a login can be switched off and on again from the plan
//   C  the company's own AI Marketing record is reused (any letter case / spaces round the name), never doubled; an ATS client with the same name is NEVER touched (no login on it, nothing changed)
//   D  who may: a client login, a non-approver staff login and an unknown plan are refused; the plan's own screen data reads back (record, logins, seats left)
//   E  a post the team sends for approval under the company's name reaches that login (the company is matched by name)
//   F  the older Add user route still works the same way (a Reviewer login for a client whose agreement is Active; refused while it is not)
//   G  FOUNDER 2026-11-25: such a company never shows as an ATS client: not in the Clients list (API), not in a count or a find, while AI Marketing finds it by asking for it; a record made by the
//      first version of the button (before the column existed) is flagged by the migration
// Builds ZZTEST fixtures in sandbox.db and removes them again. Nothing real is sent (TEST_MODE).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4063 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const DB = path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db');
if (!/sandbox\.db$/i.test(DB) || !fs.existsSync(DB)) { console.error('Refusing: this test only runs against prisma/sandbox.db.'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}?socket_timeout=60`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}?socket_timeout=60`;

const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const S = require(path.join(BACK, 'src/outreach/store'));
const Content = require(path.join(BACK, 'src/marketing/content'));
const CR = require(path.join(BACK, 'src/marketing/clientReview'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload; if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(60000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const MP = '/api/portal/logins/marketing-plan';
const PW = `Zz-Plan-${RUN}-7!`;
// the db.js middleware hides marketingOnly companies from an ordinary read; a where that names the field sees them (how AI Marketing finds its own)
const ANY = { OR: [{ marketingOnly: true }, { marketingOnly: false }] };
const anyClients = (where) => prisma.client.findMany({ where: { AND: [where, ANY] } });
const rawCount = async (name) => Number((await prisma.$queryRaw`SELECT COUNT(*) AS n FROM Client WHERE lower(trim(name)) = ${String(name).trim().toLowerCase()}`)[0].n);

(async () => {
  const made = { users: [], clients: [], plans: [], content: [], reviews: [] };
  try {
    // ---------------------------------------------------------------- fixtures
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
    check('0 the sandbox copy has a Super Admin', !!sa);
    await prisma.user.update({ where: { id: sa.id }, data: { passwordHash: 'x' } });
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => { const u = await prisma.user.create({ data: { ...base, name: `ZZTEST ${tag} ${RUN}`, email: `zz-pl-${tag}-${RUN}@example.test`, username: `zz-pl-${tag}-${RUN}@example.test`, ...extra } }); made.users.push(u.id); return u; };
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const rec = await mkUser('recruiter', { role: 'EMPLOYEE', atsRole: 'RECRUITER' });
    const anyClient = await prisma.client.create({ data: { name: `ZZTEST Plan Other Client ${RUN}`, agreementStatus: 'DRAFT' } });
    made.clients.push(anyClient.id);
    const cl = await mkUser('clientlogin', { role: 'CLIENT', atsRole: 'CLIENT', clientId: anyClient.id, portalPerms: 'CREATIVE', portalType: 'MARKETING' });
    const T = { sa: await mint(sa), rec: await mint(rec), cl: await mint(cl) };
    const saId = await resolveIdentity(sa.id);

    const newPlan = async (company, extra) => {
      const r = await http('POST', '/api/outreach/gs/marketing/services/plans', T.sa, { clientName: company, plan: 'basic', months: 3, startDate: new Date().toISOString().slice(0, 10), contactName: `ZZTEST Owner ${RUN}`, contactPhone: '9999900000', ...(extra || {}) });
      const id = r.body && r.body.plan && r.body.plan.id; if (id) made.plans.push(id);
      return { r, id };
    };
    const company = `ZZTEST Marketing Only ${RUN}`;
    const { r: pr, id: planId } = await newPlan(company);
    check('1 a client plan for a company that is NOT in Clients (made the way the team does it)', pr.status < 300 && !!planId, pr.body);
    check('1b there is no company record with that name yet', (await rawCount(company)) === 0);
    const atsBefore = await prisma.client.count();

    // ---------------------------------------------------------------- D: what the screen reads
    const g0 = await http('GET', `${MP}/${planId}`, T.sa);
    check('D1 the panel data: no record yet, no logins, all seats free', g0.status === 200 && g0.body.client === null && g0.body.logins.length === 0 && g0.body.seatsLeft === g0.body.max && g0.body.max >= 1, g0.body);
    check('D2 the contact person of the plan is offered as the name to give the login to', g0.body && g0.body.suggestedName === `ZZTEST Owner ${RUN}`, g0.body);
    check('D3 a client login is refused (403)', (await http('GET', `${MP}/${planId}`, T.cl)).status === 403);
    check('D4 a staff login that cannot approve client logins is refused (403)', (await http('GET', `${MP}/${planId}`, T.rec)).status === 403 && (await http('POST', `${MP}/${planId}/login`, T.rec, { name: 'x y', email: `zz-pl-no-${RUN}@example.test` })).status === 403);
    check('D5 an unknown plan is not found (404)', (await http('GET', `${MP}/nope-${RUN}`, T.sa)).status === 404);
    check('D6 nobody signed in: refused (401)', (await http('GET', `${MP}/${planId}`, null)).status === 401);

    // ---------------------------------------------------------------- B: a refused login leaves nothing behind
    const noName = await http('POST', `${MP}/${planId}/login`, T.sa, { name: '  ', email: `zz-pl-a-${RUN}@example.test` });
    check('B1 no name: refused (400)', noName.status === 400, noName.body);
    const badMail = await http('POST', `${MP}/${planId}/login`, T.sa, { name: `ZZTEST Person ${RUN}`, email: 'not-an-email' });
    check('B2 a bad email: refused (409)', badMail.status === 409 && /email/i.test((badMail.body && badMail.body.error) || ''), badMail.body);
    check('B3 and no empty company record was left behind', (await rawCount(company)) === 0);

    // ---------------------------------------------------------------- A: the first login makes the record and the login
    const em1 = `zz-pl-one-${RUN}@example.test`;
    const add = await http('POST', `${MP}/${planId}/login`, T.sa, { name: `ZZTEST Person One ${RUN}`, email: em1 });
    check('A1 "Give client login" answers 201: login added and a company record made', add.status === 201 && add.body && add.body.created === true && add.body.clientCreated === true, add.body);
    const rows = await anyClients({ name: company });
    if (rows[0]) made.clients.push(rows[0].id);
    const client = rows[0];
    check('A2 exactly one record, FOR AI MARKETING ONLY: marketingOnly, no ATS client ID, no agreement', rows.length === 1 && client.marketingOnly === true && client.clientCode === null && client.agreementStatus === 'DRAFT' && !client.agreementDocument, client && { m: client.marketingOnly, c: client.clientCode, a: client.agreementStatus });
    check('A3 its contact is the plan\'s contact and the login\'s email', !!client && client.contactName === `ZZTEST Owner ${RUN}` && client.contactPhone === '9999900000' && client.contactEmail === em1, client && { n: client.contactName, p: client.contactPhone, e: client.contactEmail });
    const u1 = await prisma.user.findFirst({ where: { email: em1 } });
    if (u1) made.users.push(u1.id);
    check('A4 the login is a CLIENT of that record with the Social posts type and only the creative tick', !!u1 && u1.role === 'CLIENT' && u1.clientId === client.id && u1.portalType === 'MARKETING' && u1.portalPerms === 'CREATIVE', u1 && { r: u1.role, t: u1.portalType, p: u1.portalPerms });
    check('A5 no password in the answer; a one-time set-password link (or the mailed note) is', !/password["']?\s*:\s*["'][^"']{6,}/i.test(JSON.stringify(add.body || {})) && (add.body.link ? /\/set-password\/[0-9a-f]{64}$/.test(add.body.link) : /sent/i.test(add.body.message)), add.body);
    check('A6 the stored password is not a usable one (the person must set their own)', !!u1 && u1.passwordHash !== 'x' && String(u1.passwordHash).length > 20 && !!u1.setPasswordTokenHash);
    check('A7 the answer says the record is for AI Marketing only (not in ATS Clients)', !!add.body.client && add.body.client.id === client.id && /does not show in ATS Clients/i.test(add.body.message || ''), add.body);
    const audits = await prisma.auditLog.findMany({ where: { OR: [{ entityId: client.id }, { entityId: planId }] }, select: { action: true, toValue: true } });
    check('A8 the audit log has the record made, the login created and the client login given', ['Client created', 'Client portal login created (Social posts)', 'Omni-Channel AI Marketing: client login given (web and phone)'].every((a) => audits.some((x) => x.action === a)), audits.map((x) => x.action));
    check('A8b the "record made" line starts with the words the migration looks for', audits.some((x) => x.action === 'Client created' && /^Made from AI Marketing > Client plans/.test(x.toValue || '')), audits);
    const req = await prisma.portalRequest.findFirst({ where: { clientId: client.id, kind: 'CLIENT_LOGIN' } });
    check('A9 the usual "Approved" request row keeps the history', !!req && req.status === 'Approved' && req.email === em1, req && { s: req.status });
    const tok = add.body && add.body.link ? add.body.link.split('/set-password/')[1] : null;
    if (tok) {
      const set = await http('POST', `/api/public/set-password/${tok}`, null, { password: PW });
      check('A10 the person sets their own password from the one-time link', set.status === 200, set.body);
      const login = await http('POST', '/api/auth/login', null, { email: em1, password: PW });
      const lt = login.body && (login.body.token || (login.body.data && login.body.data.token));
      check('A11 and signs in, landing on the dashboard', login.status === 200 && !!lt && login.body.user && login.body.user.landingPath === '/client-home', { s: login.status, l: login.body && login.body.user && login.body.user.landingPath });
      if (lt) {
        const me = await http('GET', '/api/auth/me', lt);
        const mu = me.body && (me.body.user || me.body);
        check('A12 /auth/me: a CLIENT of that company whose only tick is the creative one', me.status === 200 && mu.role === 'CLIENT' && mu.clientId === client.id && Array.isArray(mu.portalCaps) && mu.portalCaps.length === 1 && mu.portalCaps[0] === 'CREATIVE', mu && { r: mu.role, c: mu.portalCaps });
        // E: a post sent under the company's name (no company id on the row) reaches this login
        const w = await Content.create(saId, { title: `ZZTEST Plan words ${RUN}`, brief: 'zz test', channels: ['facebook'], texts: { facebook: 'Our plan test post.' } });
        if (w.item) made.content.push(w.item.id);
        const cr = await CR.create(saId, { kind: 'content', itemId: w.item.id, mode: 'decide', clientName: company, contactName: 'ZZTEST Contact', days: 14 });
        if (cr.review) made.reviews.push(cr.review.id);
        const list = await http('GET', '/api/portal/client/posts', lt);
        check('E1 a post sent under the company name shows in this login\'s "To approve" list', list.status === 200 && list.body && (list.body.waiting || []).some((x) => x.id === (cr.review && cr.review.id)), list.body && { w: (list.body.waiting || []).length, s: list.status });
        const note = await prisma.notification.findFirst({ where: { userId: u1.id } });
        check('E2 and the login got a bell about it', !!note && /waiting for your approval/i.test(note.title || ''), note && note.title);
        const dash = await http('GET', '/api/portal/client/posts/dashboard', lt);
        check('E3 and its dashboard opens for the company (the record is found by id although it is hidden from ATS)', dash.status === 200 && dash.body.company === company, dash.body && { s: dash.status, e: dash.body.error });
      }
    } else check('A10-A12 skipped: no link in the answer (mail was sent)', false, add.body);

    // ---------------------------------------------------------------- the panel after the first login
    const g1 = await http('GET', `${MP}/${planId}`, T.sa);
    check('D7 the panel now shows the company record, one login and one seat used', g1.status === 200 && g1.body.client && g1.body.client.id === client.id && g1.body.logins.length === 1 && g1.body.seatsLeft === g1.body.max - 1, g1.body);
    check('D8 the login is shown without a password or token', !/hash|token/i.test(JSON.stringify(g1.body.logins)), g1.body.logins);

    // ---------------------------------------------------------------- B/C: more logins on the same company
    const em2 = `zz-pl-two-${RUN}@example.test`;
    const add2 = await http('POST', `${MP}/${planId}/login`, T.sa, { name: `ZZTEST Person Two ${RUN}`, email: em2 });
    check('C1 a second login for the same company reuses the AI Marketing record (clientCreated false, same id)', add2.status === 201 && add2.body.clientCreated === false && add2.body.client.id === client.id, add2.body);
    const u2 = await prisma.user.findFirst({ where: { email: em2 } }); if (u2) made.users.push(u2.id);
    check('C2 still ONE record with that name', (await rawCount(company)) === 1);
    const dup = await http('POST', `${MP}/${planId}/login`, T.sa, { name: `ZZTEST Again ${RUN}`, email: em1.toUpperCase() });
    check('B4 the same email again (any letter case): refused (409)', dup.status === 409 && /already has/i.test((dup.body && dup.body.error) || ''), dup.body);
    const em3 = `zz-pl-three-${RUN}@example.test`;
    const add3 = await http('POST', `${MP}/${planId}/login`, T.sa, { name: `ZZTEST Person Three ${RUN}`, email: em3 });
    const u3 = await prisma.user.findFirst({ where: { email: em3 } }); if (u3) made.users.push(u3.id);
    const max = g1.body.max;
    const em4 = `zz-pl-four-${RUN}@example.test`;
    if (max === 3) {
      check('B5 a third login is fine', add3.status === 201, add3.body);
      const add4 = await http('POST', `${MP}/${planId}/login`, T.sa, { name: `ZZTEST Person Four ${RUN}`, email: em4 });
      const u4 = await prisma.user.findFirst({ where: { email: em4 } }); if (u4) made.users.push(u4.id);
      check('B6 a fourth is refused: the company limit is kept (409)', add4.status === 409 && /most allowed/i.test((add4.body && add4.body.error) || ''), add4.body);
      const g3 = await http('GET', `${MP}/${planId}`, T.sa);
      check('D9 the panel shows no seats left', g3.status === 200 && g3.body.seatsLeft === 0 && g3.body.logins.length === 3, g3.body);
      // switch a login off from the plan (this company is not in Clients, so the buttons are in the panel) and on again
      const off = await http('POST', `/api/portal/logins/client/${client.id}/users/${u3.id}/disable`, T.sa, { reason: 'test' });
      const g4 = await http('GET', `${MP}/${planId}`, T.sa);
      check('B7 a login can be switched off from the plan and its seat is free again', off.status === 200 && g4.body.seatsLeft === 1 && g4.body.logins.find((x) => x.id === u3.id).off === true, { s: off.status, left: g4.body.seatsLeft });
      const on = await http('POST', `/api/portal/logins/client/${client.id}/users/${u3.id}/enable`, T.sa, {});
      const g5 = await http('GET', `${MP}/${planId}`, T.sa);
      check('B8 and switched on again', on.status === 200 && g5.body.seatsLeft === 0 && g5.body.logins.find((x) => x.id === u3.id).off === false, { s: on.status, left: g5.body.seatsLeft });
      const rs = await http('POST', `/api/portal/logins/client/${client.id}/users/${u2.id}/resend`, T.sa, {});
      check('B9 a new link can be sent from the plan', rs.status === 200 && (rs.body.link ? /\/set-password\//.test(rs.body.link) : /sent/i.test(rs.body.message)), rs.body);
    } else check(`B5-B9 skipped: the company limit is ${max}, not 3`, true);

    // ---------------------------------------------------------------- C: an ATS client with the same name is NEVER touched
    const pre = await prisma.client.create({ data: { name: `ZZTEST Pre Existing ${RUN}`, agreementStatus: 'ACTIVE', clientCode: `ZZ-${RUN}` } });
    made.clients.push(pre.id);
    const { id: planId2 } = await newPlan(`  zztest PRE existing ${RUN}  `);
    const g6 = await http('GET', `${MP}/${planId2}`, T.sa);
    check('C3 the panel does NOT pick the ATS client of that name (no AI Marketing record yet)', g6.status === 200 && g6.body.client === null, g6.body);
    const em5 = `zz-pl-pre-${RUN}@example.test`;
    const add5 = await http('POST', `${MP}/${planId2}/login`, T.sa, { name: `ZZTEST Pre Person ${RUN}`, email: em5 });
    const u5 = await prisma.user.findFirst({ where: { email: em5 } }); if (u5) made.users.push(u5.id);
    const mk5 = u5 ? (await anyClients({ id: u5.clientId }))[0] : null; if (mk5) made.clients.push(mk5.id);
    check('C4 the login goes on its OWN AI Marketing record, not on the ATS client', add5.status === 201 && add5.body.clientCreated === true && !!mk5 && mk5.id !== pre.id && mk5.marketingOnly === true, add5.body);
    check('C5 the ATS client is not changed and has no login on it', await (async () => { const p2 = await prisma.client.findUnique({ where: { id: pre.id } }); const n = await prisma.user.count({ where: { clientId: pre.id } }); return p2.name === pre.name && p2.clientCode === pre.clientCode && p2.agreementStatus === 'ACTIVE' && p2.marketingOnly === false && n === 0; })());
    check('C6 two records carry the name (the ATS client and the AI Marketing one); ATS sees ONE of them', (await rawCount(pre.name)) === 2 && (await prisma.client.findMany({ where: { name: { contains: `Pre Existing ${RUN}` } } })).length === 1);
    const g7 = await http('GET', `${MP}/${planId2}`, T.sa);
    check('C7 the second plan of the same company reuses that AI Marketing record', g7.status === 200 && g7.body.client && mk5 && g7.body.client.id === mk5.id, g7.body);

    // ---------------------------------------------------------------- F: the older Add user route is unchanged
    const emR = `zz-pl-rev-${RUN}@example.test`;
    const rev = await http('POST', `/api/portal/logins/client/${pre.id}/users`, T.sa, { name: `ZZTEST Reviewer ${RUN}`, email: emR, portalType: 'REVIEWER' });
    const uR = await prisma.user.findFirst({ where: { email: emR } }); if (uR) made.users.push(uR.id);
    check('F1 Add user: a Reviewer login on a client whose agreement is Active still works (201)', rev.status === 201 && rev.body.created === true, rev.body);
    const clientD = await prisma.client.create({ data: { name: `ZZTEST Draft Agreement ${RUN}`, agreementStatus: 'DRAFT' } }); made.clients.push(clientD.id);
    const revBad = await http('POST', `/api/portal/logins/client/${clientD.id}/users`, T.sa, { name: `ZZTEST Reviewer2 ${RUN}`, email: `zz-pl-rev2-${RUN}@example.test`, portalType: 'REVIEWER' });
    check('F2 Add user: a Reviewer login is still refused while the agreement is not active (409)', revBad.status === 409 && /agreement/i.test((revBad.body && revBad.body.error) || ''), revBad.body);

    // ---------------------------------------------------------------- G: never an ATS client
    const rawAfter = Number((await prisma.$queryRaw`SELECT COUNT(*) AS n FROM Client`)[0].n);
    check('G1 the ATS count of clients did not move for the AI Marketing companies (2 made), while the table holds them', (await prisma.client.count()) === atsBefore + 2 && rawAfter >= atsBefore + 4, { ats: await prisma.client.count(), before: atsBefore, raw: rawAfter });
    check('G2 an ordinary find does not return the AI Marketing company; asking for the field does', (await prisma.client.findMany({ where: { name: company } })).length === 0 && (await prisma.client.findFirst({ where: { name: company } })) === null && (await anyClients({ name: company })).length === 1);
    check('G3 a search inside a bigger where is hidden too (name contains)', (await prisma.client.findMany({ where: { name: { contains: `Marketing Only ${RUN}` } } })).length === 0);
    const lst = await http('GET', `/api/clients?search=${encodeURIComponent(`Marketing Only ${RUN}`)}`, T.sa);
    const names = JSON.stringify(lst.body || {});
    check('G4 the Clients list (API) does not show the AI Marketing company', lst.status === 200 && !names.includes(`Marketing Only ${RUN}`), lst.status);
    const lstAll = await http('GET', '/api/clients', T.sa);
    check('G5 nor does the full Clients list', lstAll.status === 200 && !JSON.stringify(lstAll.body || {}).includes(`Marketing Only ${RUN}`), lstAll.status);
    // I: a record made by the FIRST version of the button (before the column) is flagged by the migration's UPDATE
    const old = await prisma.client.create({ data: { name: `ZZTEST Old Button ${RUN}`, agreementStatus: 'DRAFT', clientCode: `ZZOLD-${RUN}` } }); made.clients.push(old.id);
    await prisma.auditLog.create({ data: { action: 'Client created', entity: 'Client', entityId: old.id, toValue: 'Made from AI Marketing > Client plans for a phone login (digital marketing only, no staffing agreement)' } });
    const sql = fs.readFileSync(path.join(BACK, 'prisma', 'migrations', '20261125160000_client_marketing_only', 'migration.sql'), 'utf8');
    const upd = sql.slice(sql.indexOf('UPDATE')).trim().replace(/;\s*$/, '');
    await prisma.$executeRawUnsafe(upd);
    check('G6 the migration flags a company made by the first version of the button, and ATS no longer sees it', (await prisma.client.findMany({ where: { name: old.name } })).length === 0 && (await anyClients({ name: old.name }))[0].marketingOnly === true);
    check('G7 an ATS client made the normal way is not flagged by it', (await prisma.client.findUnique({ where: { id: pre.id } })).marketingOnly === false && (await prisma.client.findMany({ where: { name: { contains: `Pre Existing ${RUN}` } } })).length === 1);
  } catch (e) {
    check('the test ran to the end', false, e.stack || e.message);
  } finally {
    // ---------------------------------------------------------------- clean up
    try {
      if (made.reviews.length) await S.run(`DELETE FROM "OmniMkClientReview" WHERE id IN (${made.reviews.map(() => '?').join(',')})`, ...made.reviews);
      if (made.content.length) await S.run(`DELETE FROM "OmniMkContent" WHERE id IN (${made.content.map(() => '?').join(',')})`, ...made.content);
      if (made.plans.length) { await S.run(`DELETE FROM "OmniMkOnboarding" WHERE planId IN (${made.plans.map(() => '?').join(',')})`, ...made.plans).catch(() => {}); await S.run(`DELETE FROM "OmniMkClientPlan" WHERE id IN (${made.plans.map(() => '?').join(',')})`, ...made.plans); }
      const byName = await prisma.$queryRaw`SELECT id FROM Client WHERE name LIKE ${`%${RUN}%`}`;
      const clientIds = [...new Set([...made.clients, ...byName.map((c) => c.id)])];
      const usersOfClients = await prisma.user.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } });
      const userIds = [...new Set([...made.users, ...usersOfClients.map((u) => u.id)])];
      await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { title: { contains: 'ZZTEST' } } });
      await prisma.notification.deleteMany({ where: { message: { contains: 'ZZTEST' } } });
      await prisma.portalRequest.deleteMany({ where: { clientId: { in: clientIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: clientIds } } }).catch(() => {});
    } catch (e) { console.log(`(clean-up: ${e.message})`); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
