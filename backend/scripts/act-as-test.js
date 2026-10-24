#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SUPER ADMIN "ACT AS" acceptance tests (2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/act-as-test.js
//
//   E  who may enter / whom may be acted as
//   M  the Act-as identity is the target's own (no Super Admin extras)
//   W  edits within the target's rights; 403 outside them
//   B  the hard-blocked list answers 403 although the real user is a Super Admin
//   O  anything that really sends to a person asks for a confirmation first
//   A  one human cannot approve what he asked for (maker-checker)
//   N  the target's notifications are left untouched
//   U  audit rows (actor = real Super Admin, onBehalfOf = target, route, IP) + history list
//   X  exit, back to read-only, switch from View as, expiry, ended sessions
//   V  View as stays read-only
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
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

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body, headers) {
  const h = { 'X-Forwarded-For': '10.9.7.7', ...(headers || {}) };
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
  const made = { users: [], emps: [], clients: [], notifs: [] };
  const sids = [];
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST AA ${tag} ${RUN}`, email: `zz-aa-${tag}-${RUN}@example.test`, username: `zz-aa-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({
          data: { employeeCode: `ZZTEST-AA-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra },
        });
        made.emps.push(e.id);
      }
      return u;
    };
    const uSa = await mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsAccess: true, hrmsRole: 'SUPER_ADMIN' });
    const uSa2 = await mkUser('sa2', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsAccess: true, hrmsRole: 'SUPER_ADMIN' });
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education', hrmsAccess: true, hrmsRole: 'MANAGER' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uOff = await mkUser('off', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education', status: 'Inactive' }, {});
    const uGone = await mkUser('gone', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { employmentStatus: 'Exited' });
    const mint = async (u, ttl = '1h') => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: ttl });
    const T = {};
    for (const [k, u] of Object.entries({ sa: uSa, admin: uAdmin, mgr: uMgr, bdeTl: uBdeTl, bde: uBde, rec: uRec })) T[k] = await mint(u);

    const mkClient = async (tag, dept, bde) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST AA Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: bde ? bde.name : null, clientType: 'Client' } });
      made.clients.push(c.id); return c;
    };
    const cEdu = await mkClient('edu', 'Education', uBde);
    const cEdu2 = await mkClient('edu2', 'Education', uBde);

    const act = async (userTok, u) => {
      const r = await call('POST', `/api/admin/view-as/${u.id}/act`, userTok);
      if (r.body && r.body.token) sids.push(jwt.decode(r.body.token).actAs.sid);
      return r;
    };

    // =============================== E: entry ===============================================
    const aTl = await act(T.sa, uBdeTl);
    check('E1 a Super Admin starts Act as a BDE TL (200 + token, mode act, 60 min)', aTl.status === 200 && aTl.body.token && aTl.body.mode === 'act' && jwt.decode(aTl.body.token).actAs.mode === 'act', [aTl.status, aTl.body]);
    const lifeMin = aTl.body && aTl.body.token ? Math.round((jwt.decode(aTl.body.token).exp - jwt.decode(aTl.body.token).iat) / 60) : 0;
    check('E1b the token lasts 60 minutes', lifeMin === 60, lifeMin);
    const aBde = await act(T.sa, uBde);
    const aRec = await act(T.sa, uRec);
    check('E2 ... as a BDE and as a recruiter too', aBde.status === 200 && aRec.status === 200, [aBde.status, aRec.status]);
    const aMgr = await act(T.sa, uMgr);
    check('E2b ... and as a Manager', aMgr.status === 200, [aMgr.status, aMgr.body]);
    check('E3 an Admin cannot use Act as (403)', (await act(T.admin, uBdeTl)).status === 403);
    check('E4 a BDE TL / Manager cannot use Act as (403)', (await act(T.bdeTl, uBde)).status === 403 && (await act(T.mgr, uBde)).status === 403);
    const x1 = await act(T.sa, uSa2);
    check('E5 cannot act as another Super Admin (403, plain words)', x1.status === 403 && /Super Admin or Admin/.test(x1.body.error), [x1.status, x1.body]);
    check('E6 cannot act as an Admin (403)', (await act(T.sa, uAdmin)).status === 403);
    const x2 = await act(T.sa, uOff);
    check('E7 cannot act as a blocked (Inactive) login (403)', x2.status === 403, [x2.status, x2.body]);
    const x3 = await act(T.sa, uGone);
    check('E8 cannot act as an Exited employee (403)', x3.status === 403 && /left the company/.test(x3.body.error), [x3.status, x3.body]);
    check('E9 cannot act as yourself (400)', (await act(T.sa, uSa)).status === 400);
    check('E10 an unknown login is 404', (await call('POST', '/api/admin/view-as/nope-nope-nope/act', T.sa)).status === 404);
    const noTok = await call('POST', `/api/admin/view-as/${uBde.id}/act`);
    check('E11 no token = 401', noTok.status === 401);
    const adminView = await call('POST', `/api/admin/view-as/${uBdeTl.id}`, T.admin);
    check('E12 View as itself is still Super Admin only (Admin 403)', adminView.status === 403, adminView.status);

    const tlTok = aTl.body.token; const bdeTok = aBde.body.token; const recTok = aRec.body.token; const mgrTok = aMgr.body.token;

    // =============================== M: identity is the target's =============================
    const me = await call('GET', '/api/auth/me', tlTok);
    check('M1 /auth/me answers as the BDE TL, role not Super Admin', me.status === 200 && me.body.id === uBdeTl.id && me.body.role === 'TL', [me.status, me.body && me.body.role]);
    check('M2 /auth/me tells the screen it is an editable Act as session', me.body.viewAs && me.body.viewAs.mode === 'act' && me.body.viewAs.readOnly === false && me.body.viewAs.byName === uSa.name, me.body.viewAs);
    check('M3 none of the Super Admin extras: Users list is 403 for the acted BDE TL', (await call('GET', '/api/admin/users', tlTok)).status === 403);
    check('M4 the real Super Admin still reaches Users (control)', (await call('GET', '/api/admin/users', T.sa)).status === 200);

    // =============================== W: writes within / outside rights =========================
    const newC = await call('POST', '/api/clients', tlTok, { name: `ZZTEST AA New Client ${RUN}`, mode: 'draft', ownerDepartment: 'Education' });
    const newId = newC.body && (newC.body.id || (newC.body.client && newC.body.client.id));
    if (newId) made.clients.push(newId);
    check('W1 acting as the BDE TL: add a client works', [200, 201].includes(newC.status), [newC.status, newC.body]);
    const put = await call('PUT', `/api/clients/${cEdu.id}`, tlTok, { location: 'ZZ Pune' });
    check('W2 ... edit a client works', put.status === 200, [put.status, put.body]);
    const dbC = await prisma.client.findUnique({ where: { id: cEdu.id } });
    check('W2b ... and it really changed in the database', dbC.location === 'ZZ Pune', dbC.location);
    const note = await call('POST', `/api/clients/${cEdu.id}/notes`, tlTok, { note: `ZZTEST AA note ${RUN}` });
    check('W3 ... add a client note works', note.status === 201, [note.status, note.body]);
    const bPut = await call('PUT', `/api/clients/${cEdu.id}`, bdeTok, { location: 'ZZ Hyd' });
    check('W4 acting as the BDE: edit their own client works', bPut.status === 200, [bPut.status, bPut.body]);
    const rPut = await call('PUT', `/api/clients/${cEdu.id}`, recTok, { location: 'ZZ Nope' });
    check('W5 acting as a recruiter: edit a client is 403 (their own rights, not the Super Admin\'s)', rPut.status === 403, rPut.status);
    const bInv = await call('POST', '/api/invoices', bdeTok, { clientId: cEdu.id, amount: 100 });
    check('W6 acting as the BDE: an Accounts action (create invoice) is 403', bInv.status === 403, [bInv.status, bInv.body]);
    const bUsers = await call('POST', '/api/admin/users', bdeTok, { name: 'ZZTEST x', email: `zz-aa-x-${RUN}@example.test` });
    check('W7 acting as the BDE: create a user is 403', bUsers.status === 403, bUsers.status);
    const lock = await call('POST', `/api/clients/${cEdu.id}/pause`, bdeTok, { reason: 'ZZTEST AA bde pause' });
    const lockReal = await call('POST', `/api/clients/${cEdu2.id}/pause`, T.bde, { reason: 'ZZTEST AA real bde pause' });
    check('W8 acting as the BDE gives exactly what the real BDE gets for pause', lock.status === lockReal.status || (lock.status === 200 && lockReal.status === 409), [lock.status, lockReal.status]);
    await call('POST', `/api/clients/${cEdu.id}/reactivate`, T.sa, { reason: 'ZZTEST AA reset' });
    await call('POST', `/api/clients/${cEdu2.id}/reactivate`, T.sa, { reason: 'ZZTEST AA reset' });
    const tlPause = await call('POST', `/api/clients/${cEdu2.id}/pause`, tlTok, { reason: 'ZZTEST AA tl pause' });
    console.log(`INFO  BDE TL direct pause answers ${tlPause.status} (real BDE TL, same rule)`);
    const realTl = await call('POST', `/api/clients/${cEdu2.id}/pause`, T.bdeTl, { reason: 'ZZTEST AA real tl pause' });
    check('W9 acting as the BDE TL gives exactly what the real BDE TL gets for pause', tlPause.status === realTl.status || (tlPause.status === 200 && realTl.status === 409), [tlPause.status, realTl.status]);
    await call('POST', `/api/clients/${cEdu2.id}/reactivate`, T.sa, { reason: 'ZZTEST AA reset' });

    // =============================== B: the hard-blocked list ==================================
    const pwBefore = (await prisma.user.findUnique({ where: { id: uBde.id } })).passwordHash;
    const usersBefore = await prisma.user.count();
    const blockedCases = [
      ['POST', '/api/admin/users', { name: 'ZZTEST y', email: `zz-aa-y-${RUN}@example.test`, password: 'Abcd1234!x' }, 'create a user'],
      ['PUT', `/api/admin/users/${uBde.id}`, { role: 'ADMIN' }, 'change a role'],
      ['POST', `/api/admin/users/${uBde.id}/reset-password`, {}, 'reset a password'],
      ['POST', `/api/admin/users/${uBde.id}/reset-link`, {}, 'send a reset link'],
      ['POST', '/api/auth/change-password', { currentPassword: 'a', newPassword: 'Abcd1234!x' }, 'change own password'],
      ['PUT', '/api/admin/role-catalog/BDE/modules/clients', {}, 'edit the Role Catalog'],
      ['PUT', '/api/admin/designation-roles/Executive', {}, 'edit role access by designation'],
      ['POST', '/api/admin/integrations/email/connect', {}, 'connect an integration'],
      ['PUT', '/api/admin/integrations/email/configure', { apiKey: 'x' }, 'save an API key'],
      ['PUT', '/api/admin/company', {}, 'company / security settings'],
      ['DELETE', `/api/employees/${made.emps[0]}`, undefined, 'delete an employee'],
      ['POST', `/api/employees/management/${made.emps[0]}/reset-password`, {}, 'reset an employee password'],
      ['PUT', `/api/employees/management/${made.emps[0]}/roles`, { atsRole: 'ADMIN' }, 'change an employee role'],
      ['POST', '/api/system/backup', {}, 'DB tools (backup)'],
      ['POST', '/api/data-import/commit', {}, 'DB tools (import)'],
      ['POST', `/api/admin/view-as/${uRec.id}`, {}, 'start another View as'],
      ['POST', `/api/admin/view-as/${uRec.id}/act`, {}, 'start another Act as'],
      ['POST', '/api/attendance/punches/verified', {}, 'clock in as the person'],
      ['POST', `/api/agreement/${cEdu.id}/company-seal`, {}, 'stamp an agreement'],
      ['POST', `/api/positions/${cEdu.id}/assign`, {}, 'change a seat'],
    ];
    for (const [m, p, b, what] of blockedCases) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(m, p, tlTok, b);
      check(`B ${what}: 403 and flagged as blocked-while-acting`, r.status === 403 && r.body && r.body.actAsBlocked === true, [r.status, r.body]);
    }
    check('B+ the user\'s password and the user count are untouched', (await prisma.user.findUnique({ where: { id: uBde.id } })).passwordHash === pwBefore && (await prisma.user.count()) === usersBefore);
    const blockedRows = await prisma.auditLog.count({ where: { userId: uSa.id, action: 'Acted as: refused', fieldLabel: 'Blocked while acting' } });
    check('B++ every blocked attempt is in the audit log', blockedRows >= blockedCases.length, blockedRows);

    // =============================== O: sends ask first =====================================
    const o1 = await call('POST', '/api/messaging/send', tlTok, { channel: 'email', candidateIds: [], subject: 'ZZTEST', body: 'ZZTEST' });
    check('O1 sending a message as the BDE TL asks first (409 ACT_CONFIRM_SEND, plain words)', o1.status === 409 && o1.body.code === 'ACT_CONFIRM_SEND' && /really send/.test(o1.body.error), [o1.status, o1.body]);
    const o2 = await call('POST', '/api/messaging/send', tlTok, { channel: 'email', candidateIds: [], subject: 'ZZTEST', body: 'ZZTEST' }, { 'X-Act-Confirm': 'send' });
    check('O2 after the person confirms, the call goes through to the route (no more 409 confirm)', !(o2.body && o2.body.code === 'ACT_CONFIRM_SEND'), [o2.status, o2.body]);
    const o3 = await call('POST', `/api/candidates/${made.clients[0]}/contact`, bdeTok, { channel: 'whatsapp', message: 'ZZTEST' });
    check('O3 contacting a candidate asks first too', o3.status === 409 && o3.body.code === 'ACT_CONFIRM_SEND', [o3.status, o3.body]);
    const o4 = await call('POST', '/api/messaging/send', T.bdeTl, { channel: 'email', candidateIds: [], subject: 'ZZTEST', body: 'ZZTEST' });
    check('O4 a real (not acted) login is never asked (control)', !(o4.body && o4.body.code === 'ACT_CONFIRM_SEND'), [o4.status, o4.body]);
    const o5 = await call('POST', '/api/messaging/send', T.sa, { channel: 'email', candidateIds: [] }, { 'X-Act-Confirm': 'send' });
    check('O5 the confirm header means nothing without an Act-as token', !(o5.body && o5.body.code === 'ACT_CONFIRM_SEND'));

    // =============================== A: maker-checker ======================================
    // A client "submit for approval" (BDE asks, Manager / Admin decides): the same human cannot do both halves.
    const reqAct = await call('POST', `/api/clients/${cEdu.id}/submit-approval`, bdeTok, { note: 'ZZTEST AA please approve' });
    const rid = reqAct.body && reqAct.body.requestId;
    check('A1 acting as the BDE: send the client for approval works', reqAct.status === 201 && !!rid, [reqAct.status, reqAct.body]);
    const pending = rid ? await prisma.auditLog.findUnique({ where: { id: rid } }) : null;
    check('A2 that request exists and is waiting', !!pending && pending.approvalStatus === 'Pending');
    const same = await call('POST', `/api/clients/requests/${rid}/approve`, mgrTok, { note: 'ZZTEST' });
    check('A3 acting as the Manager: approving the request the same human just made is 403', same.status === 403 && same.body.actAsBlocked === true, [same.status, same.body]);
    const rej = await call('POST', `/api/clients/requests/${rid}/reject`, mgrTok, { reason: 'ZZTEST not now' });
    check('A3b ... rejecting it is blocked too', rej.status === 403 && rej.body.actAsBlocked === true, [rej.status, rej.body]);
    const stillPending = rid ? await prisma.auditLog.findUnique({ where: { id: rid } }) : null;
    check('A4 the request is still pending', !!stillPending && stillPending.approvalStatus === 'Pending', stillPending && stillPending.approvalStatus);
    const real = await call('POST', `/api/clients/${cEdu2.id}/submit-approval`, T.bde, { note: 'ZZTEST AA real bde asks' });
    const ok = real.body && real.body.requestId ? await call('POST', `/api/clients/requests/${real.body.requestId}/approve`, mgrTok, { note: 'ZZTEST' }) : { status: -1 };
    check('A5 acting as the Manager: deciding a request a DIFFERENT person made works (control)', real.status === 201 && ok.status === 200, [real.status, ok.status, ok.body]);
    const asBde2 = await call('POST', `/api/clients/${cEdu2.id}/submit-approval`, bdeTok, { note: 'ZZTEST AA again' });
    check('A6 the BDE (acted) may send another one; only the approving half is blocked', asBde2.status === 201 || asBde2.status === 409, asBde2.status);

    // =============================== N: notifications untouched ================================
    const n1 = await prisma.notification.create({ data: { userId: uBde.id, title: 'ZZTEST AA unread 1', message: 'ZZTEST', read: false } });
    const n2 = await prisma.notification.create({ data: { userId: uBde.id, title: 'ZZTEST AA unread 2', message: 'ZZTEST', read: false } });
    made.notifs.push(n1.id, n2.id);
    const r1 = await call('PATCH', `/api/admin/notifications/${n1.id}/read`, bdeTok);
    const r2 = await call('POST', '/api/admin/notifications/read-all', bdeTok, {});
    const left = await prisma.notification.count({ where: { id: { in: [n1.id, n2.id] }, read: false } });
    check('N1 acting as the BDE: "mark read" and "read all" leave their notifications unread', left === 2, [r1.status, r2.status, left]);
    const rr = await call('POST', '/api/admin/notifications/read-all', T.bde, {});
    const left2 = await prisma.notification.count({ where: { id: { in: [n1.id, n2.id] }, read: false } });
    check('N2 the real BDE can mark them read (control)', rr.status < 300 && left2 === 0, [rr.status, left2]);

    // =============================== U: audit + history ===================================
    const changeRows = await prisma.auditLog.findMany({ where: { userId: uSa.id, action: 'Acted as: change' } });
    const one = changeRows.find((r) => /PUT \/api\/clients\//.test(r.field || ''));
    check('U1 every write left an "Acted as: change" row; actor = the real Super Admin', changeRows.length >= 5 && !!one, changeRows.length);
    check('U2 ... naming the person acted as (onBehalfOf), the route, the IP and the session', !!one && one.toValue.includes(uBdeTl.name) && one.actorName.includes(uSa.name) && one.actorName.includes('acting as') && /^[0-9a-f.:]+$/i.test(one.fromValue || '') && /View-as session [0-9a-f-]{36}/.test(one.reason) && one.reason.includes(uBdeTl.id), one);
    const created = await prisma.auditLog.findFirst({ where: { userId: uSa.id, action: 'Acted as: created', entityId: newId } });
    check('U3 a record created while acting is listed (entity + id)', !!created && created.entity === 'Client', created);
    const fn = await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: cEdu.id, userId: uBde.id, actorName: { contains: 'done by' } } });
    console.log(`INFO  app-level audit row actorName: ${fn ? fn.actorName : '(none for that action)'}`);
    const started = await prisma.auditLog.findFirst({ where: { userId: uSa.id, action: 'Act as started', entityId: uBdeTl.id } });
    check('U4 "Act as started" row: Super Admin id, target, IP', !!started && started.fieldLabel === uBdeTl.name && started.field === 'onBehalfOf' && !!started.fromValue, started);
    const hist = await call('GET', '/api/admin/view-as/act-history', T.sa);
    const mine = hist.body && hist.body.sessions ? hist.body.sessions.find((s) => s.sid === sids[0]) : null;
    check('U5 the "Acted as" list shows who acted as whom, when, how many changes', hist.status === 200 && mine && mine.byName === uSa.name && mine.targetName === uBdeTl.name && mine.changes >= 3 && mine.live === true, [hist.status, mine]);
    check('U6 Admin / acted logins cannot read the list (403)', (await call('GET', '/api/admin/view-as/act-history', T.admin)).status === 403 && (await call('GET', '/api/admin/view-as/act-history', tlTok)).status === 403);

    // =============================== X: exit / back / switch / expiry ==========================
    const back = await call('POST', '/api/admin/view-as/back-to-read-only', tlTok);
    if (back.body && back.body.token) sids.push(jwt.decode(back.body.token).viewAs.sid);
    check('X1 "Back to read-only view" ends Act as and hands back a View-as token', back.status === 200 && back.body.mode === 'view' && jwt.decode(back.body.token).viewAs.readOnly === true, [back.status, back.body]);
    const old1 = await call('GET', '/api/auth/me', tlTok);
    check('X2 the old Act-as token is dead (401, "ended")', old1.status === 401 && old1.body.viewAsEnded === true, [old1.status, old1.body]);
    const vTok = back.body.token;
    const vPut = await call('PUT', `/api/clients/${cEdu.id}`, vTok, { location: 'ZZ View' });
    check('V1 View as stays read-only: a save is refused (403 viewAsReadOnly)', vPut.status === 403 && vPut.body.viewAsReadOnly === true, [vPut.status, vPut.body]);
    check('V2 View as can still read', (await call('GET', '/api/auth/me', vTok)).status === 200);
    const sw = await call('POST', '/api/admin/view-as/switch-to-act', vTok);
    if (sw.body && sw.body.token) sids.push(jwt.decode(sw.body.token).actAs.sid);
    check('X3 "Switch to Act as" from a View-as session gives an Act-as token for the same person', sw.status === 200 && sw.body.mode === 'act' && sw.body.target.id === uBdeTl.id, [sw.status, sw.body]);
    check('X4 the View-as token it came from is ended', (await call('GET', '/api/auth/me', vTok)).status === 401);
    const swPut = await call('PUT', `/api/clients/${cEdu.id}`, sw.body.token, { location: 'ZZ Switched' });
    check('X5 the switched session can save', swPut.status === 200, [swPut.status, swPut.body]);
    const swNo = await call('POST', '/api/admin/view-as/switch-to-act', tlTok);
    check('X5b switch-to-act without a View-as token is refused (400/401/403)', [400, 401, 403].includes(swNo.status), swNo.status);
    const ex = await call('POST', '/api/admin/view-as/act-exit', sw.body.token);
    check('X6 Exit ends Act as and reports the number of changes', ex.status === 200 && ex.body.wasActing === true && ex.body.changes >= 1, [ex.status, ex.body]);
    check('X7 the exited token is dead', (await call('GET', '/api/auth/me', sw.body.token)).status === 401);
    const endedRow = await prisma.auditLog.findFirst({ where: { userId: uSa.id, action: 'Act as ended' }, orderBy: { createdAt: 'desc' } });
    check('X8 "Act as ended" is in the audit log with the number of changes', !!endedRow && /change/.test(endedRow.toValue), endedRow);
    // expiry
    const idAs = await resolveIdentity(uBdeTl.id);
    const expired = jwt.sign({ ...tokenPayload(idAs), actAs: { byUserId: uSa.id, byName: uSa.name, mode: 'act', sid: '00000000-0000-4000-8000-000000000001' } }, process.env.JWT_SECRET, { expiresIn: -60 });
    check('X9 an expired Act-as token is refused (401)', (await call('GET', '/api/auth/me', expired)).status === 401);
    // forged: a normal login token with an actAs claim is signed by us only; a token signed with another secret fails
    const forged = jwt.sign({ ...tokenPayload(idAs), actAs: { byUserId: uSa.id, byName: uSa.name, mode: 'act', sid: '00000000-0000-4000-8000-000000000002' } }, 'not-the-secret', { expiresIn: '1h' });
    check('X10 a forged Act-as token is refused (401)', (await call('GET', '/api/auth/me', forged)).status === 401);
    // the Super Admin loses the role mid-session
    const live = await act(T.sa, uBde);
    sids.push(jwt.decode(live.body.token).actAs.sid);
    await prisma.user.update({ where: { id: uSa.id }, data: { status: 'Inactive' } });
    const lostSa = await call('GET', '/api/auth/me', live.body.token);
    check('X11 if the Super Admin login is blocked, the Act-as session ends at once', lostSa.status === 401 || lostSa.status === 403, lostSa.status);
    await prisma.user.update({ where: { id: uSa.id }, data: { status: 'Active' } });
    // the person acted as becomes Admin / is blocked mid-session
    const live2 = await act(T.sa, uRec);
    sids.push(jwt.decode(live2.body.token).actAs.sid);
    await prisma.user.update({ where: { id: uRec.id }, data: { role: 'ADMIN' } });
    const nowAdmin = await call('GET', '/api/auth/me', live2.body.token);
    check('X12 if the person acted as becomes an Admin, the session ends (401)', nowAdmin.status === 401, nowAdmin.status);
    await prisma.user.update({ where: { id: uRec.id }, data: { role: 'EMPLOYEE', status: 'Inactive' } });
    const nowOff = await call('GET', '/api/auth/me', live2.body.token);
    check('X13 if the person acted as is blocked, nothing is served (401/403)', [401, 403].includes(nowOff.status), nowOff.status);
    await prisma.user.update({ where: { id: uRec.id }, data: { status: 'Active' } });
    // the regular suites' view-as exit still works
    const v2 = await call('POST', `/api/admin/view-as/${uBdeTl.id}`, T.sa);
    if (v2.body && v2.body.token) sids.push(jwt.decode(v2.body.token).viewAs.sid);
    const v2x = await call('POST', '/api/admin/view-as/exit', v2.body.token);
    check('V3 View as start / exit are unchanged', v2.status === 200 && v2x.status === 200 && v2x.body.wasViewingAs === true, [v2.status, v2x.status]);
  } catch (e) {
    fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      const byName = await prisma.user.findMany({ where: { name: { contains: 'ZZTEST AA' } }, select: { id: true } });
      const ids = [...new Set([...made.users, ...byName.map((u) => u.id)])];
      const empByName = await prisma.employee.findMany({ where: { OR: [{ userId: { in: ids } }, { name: { contains: 'ZZTEST AA' } }] }, select: { id: true } });
      made.emps = [...new Set([...made.emps, ...empByName.map((e) => e.id)])];
      const clientRows = await prisma.client.findMany({ where: { name: { contains: 'ZZTEST AA' } }, select: { id: true } });
      const clientIds = [...new Set([...made.clients, ...clientRows.map((c) => c.id)])];
      const allIds = [...ids, ...clientIds, ...made.emps];
      await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { title: { contains: 'ZZTEST' } }, { message: { contains: 'ZZTEST' } }] } }).catch(() => {});
      const sidFilters = sids.map((s) => ({ reason: { contains: s } }));
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: allIds } }, { reason: { contains: 'ZZTEST' } }, { actorName: { contains: 'ZZTEST AA' } }, ...sidFilters] } });
      await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      const leftover = {
        users: await prisma.user.count({ where: { name: { contains: 'ZZTEST AA' } } }),
        clients: await prisma.client.count({ where: { name: { contains: 'ZZTEST AA' } } }),
        audit: await prisma.auditLog.count({ where: { OR: [{ actorName: { contains: 'ZZTEST AA' } }, { reason: { contains: 'ZZTEST' } }, ...sidFilters] } }),
        notifications: await prisma.notification.count({ where: { title: { contains: 'ZZTEST AA' } } }),
      };
      console.log('leftovers after cleanup:', JSON.stringify(leftover));
      check('Z cleanup: nothing ZZTEST AA is left in the sandbox', Object.values(leftover).every((n) => n === 0), leftover);
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
