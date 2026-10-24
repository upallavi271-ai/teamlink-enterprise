#!/usr/bin/env node
// ---------------------------------------------------------------------------
// "TYPE YOUR OWN VALUE" - part B screens (2026-10-15). COPY DATABASE ONLY, never dev.db.
//
//   1. make a copy:  node -e "const {DatabaseSync}=require('node:sqlite');const s=new DatabaseSync('prisma/dev.db',{readOnly:true});s.exec(\"VACUUM INTO '<copy>.db'\")"
//   2. start a server on the copy (TEST_MODE=1, PORT=4019, DATABASE_URL=file:<copy>.db)
//   3. TL_API=http://localhost:4019 TL_TEST_DB=<absolute path of the copy> node scripts/open-fields-test.js
//
// Checks that a typed own value is SAVED (tidied, one spelling) and never refused with "not in the list":
//   candidate Gender, holiday Type, help-desk Category, "ask HR to unlock my profile" reason,
//   business bank Account type, asset repair Type.
// Everything it creates carries a ZZTEST OF marker and is removed again (copy database only).
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4019 (a copy-database server), never 4010.'); process.exit(2); }
const DB = process.env.TL_TEST_DB;
if (!DB || /dev\.db$/i.test(DB)) { console.error('Refusing: set TL_TEST_DB to the absolute path of a COPY database (never dev.db).'); process.exit(2); }
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${DB.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}` : ''}`);
}
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

(async () => {
  const made = { users: [], cands: [], holidays: [], tickets: [] };
  let restore = null;
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    // The copy's own Super Admin login (a token is minted for it; nothing about that user is changed).
    const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' }, orderBy: { createdAt: 'asc' } });
    if (!admin) throw new Error('no Super Admin user in the copy');
    void base;
    // Copy database only: mark the logins used here as having chosen their own password (otherwise every call answers 'change your password').
    const ownPassword = (id) => prisma.user.update({ where: { id }, data: { passwordChangedAt: new Date() } });
    await ownPassword(admin.id);
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = await mint(admin);

    // ---- candidate Gender --------------------------------------------------------------------------------------
    const c1 = await call('POST', '/api/candidates', T, { name: `ZZTEST OF Cand ${RUN}`, email: `zz-of-${RUN}@example.test`, phone: `9${String(Date.now()).slice(-9)}`, gender: '  Non-binary <b>x</b> ', skills: 'x', currentSalary: '300000', expectedSalary: '400000' });
    if (c1.body && c1.body.id) made.cands.push(c1.body.id);
    check('candidate saved with a typed Gender (201, not refused)', c1.status === 201 && c1.body && c1.body.id, c1.body || c1.text);
    const cg = c1.body && c1.body.id ? await prisma.candidate.findUnique({ where: { id: c1.body.id } }) : null;
    check('typed Gender is tidied (no HTML, spaces collapsed)', cg && cg.gender === 'Non-binary x', cg && cg.gender);

    // ---- holiday Type ------------------------------------------------------------------------------------------
    const hname = `ZZTEST OF Holiday ${RUN}`;
    const h1 = await call('POST', '/api/leave/holidays', T, { name: hname, date: '2099-03-05', type: `State  Holiday ${RUN}` });
    const hs = await prisma.holiday.findMany({ where: { name: hname } });
    hs.forEach((h) => made.holidays.push(h.id));
    check('holiday created with a typed Type', h1.status < 300 && hs.length === 1 && hs[0].type === `State Holiday ${RUN}`, [h1.status, hs.map((h) => h.type), h1.body]);
    if (hs[0]) {
      const h2 = await call('PUT', `/api/leave/holidays/${hs[0].id}`, T, { type: 'festival' });
      const after = await prisma.holiday.findUnique({ where: { id: hs[0].id } });
      check('a typed Type that matches a listed one by case uses the listed spelling', h2.status < 300 && after.type === 'Festival', [h2.status, after.type]);
      const h3 = await call('PUT', `/api/leave/holidays/${hs[0].id}`, T, { type: `Local ${RUN}` });
      const after3 = await prisma.holiday.findUnique({ where: { id: hs[0].id } });
      check('edit keeps a typed Type', h3.status < 300 && after3.type === `Local ${RUN}`, [h3.status, after3.type]);
    }

    // ---- help-desk Category ------------------------------------------------------------------------------------
    const emp = await prisma.employee.findFirst({ where: { userId: { not: null } }, orderBy: { id: 'asc' } });
    if (emp) {
      const t1 = await call('POST', '/api/helpdesk', T, { employeeId: emp.id, title: `ZZTEST OF ticket ${RUN}`, detail: 'x', category: `Canteen ${RUN}`, priority: 'Low' });
      if (t1.body && t1.body.id) made.tickets.push(t1.body.id);
      check('help-desk ticket saved with a typed Category, routed to the HR Team', t1.status === 201 && t1.body && t1.body.category === `Canteen ${RUN}` && t1.body.routedTo === 'HR Team', t1.body || t1.text);
      const t2 = await call('POST', '/api/helpdesk', T, { employeeId: emp.id, title: `ZZTEST OF ticket2 ${RUN}`, detail: 'x', category: 'it support', priority: 'Low' });
      if (t2.body && t2.body.id) made.tickets.push(t2.body.id);
      check('a typed Category matching a listed one by case is routed like the listed one', t2.status === 201 && t2.body && t2.body.category === 'IT Support' && t2.body.routedTo === 'IT Team', t2.body || t2.text);
    } else { console.log('SKIP  no employee in the copy for the help-desk check'); }

    // ---- unlock-request reason ---------------------------------------------------------------------------------
    const lockedEmp = await prisma.employee.findFirst({ where: { userId: { not: null }, isLocked: true, OR: [{ unlockRequestStatus: null }, { unlockRequestStatus: { not: 'Pending' } }] } })
      || await prisma.employee.findFirst({ where: { userId: { not: null }, OR: [{ unlockRequestStatus: null }, { unlockRequestStatus: { not: 'Pending' } }] } });
    if (lockedEmp) {
      restore = { id: lockedEmp.id, isLocked: lockedEmp.isLocked, unlockRequestReason: lockedEmp.unlockRequestReason, unlockRequestStatus: lockedEmp.unlockRequestStatus, unlockRequestCount: lockedEmp.unlockRequestCount };
      await prisma.employee.update({ where: { id: lockedEmp.id }, data: { isLocked: true, unlockRequestCount: 0, unlockRequestStatus: null } });
      await ownPassword(lockedEmp.userId);
      const tok = await mint({ id: lockedEmp.userId });
      const u1 = await call('POST', '/api/employees/me/unlock-request', tok, { reason: `  Moved to a new <i>flat</i> ${RUN} ` });
      const e2 = await prisma.employee.findUnique({ where: { id: lockedEmp.id } });
      check('unlock request accepted with a typed reason (tidied)', u1.status < 300 && e2.unlockRequestReason === `Moved to a new flat ${RUN}`, [u1.status, u1.body && u1.body.error, e2.unlockRequestReason]);
      const u2 = await call('POST', '/api/employees/me/unlock-request', tok, { reason: '   ' });
      check('an empty reason is still refused', u2.status === 400, [u2.status, u2.body]);
    } else { console.log('SKIP  no employee with a login in the copy for the unlock check'); }

    // ---- business bank Account type ----------------------------------------------------------------------------
    const co0 = await prisma.company.findFirst();
    if (co0) {
      const b1 = await call('PUT', '/api/office-expenses/business-profile', T, { accountType: `Overdraft <b>OD</b> ${RUN}` });
      const co1 = await prisma.company.findFirst();
      check('business Account type accepts a typed value (tidied)', b1.status < 300 && co1.accountType === `Overdraft OD ${RUN}`, [b1.status, b1.body, co1.accountType]);
      await prisma.company.update({ where: { id: co0.id }, data: { accountType: co0.accountType } });
    } else { console.log('SKIP  no company row in the copy for the account-type check'); }

    // ---- asset repair Type -------------------------------------------------------------------------------------
    const asset = await prisma.asset.findFirst().catch(() => null);
    if (asset) {
      const r1 = await call('POST', `/api/asset-inventory/${asset.id}/repairs`, T, { issue: `ZZTEST OF issue ${RUN}`, repairType: `Calibration ${RUN}` });
      const rid = r1.body && r1.body.repair && r1.body.repair.id;
      check('asset repair logged with a typed Type', r1.status === 201 && r1.body && r1.body.repair && r1.body.repair.repairType === `Calibration ${RUN}`, r1.body || r1.text);
      if (rid) {
        const r2 = await call('PATCH', `/api/asset-inventory/${asset.id}/repairs/${rid}`, T, { repairType: 'amc' });
        const row = await prisma.assetRepair.findUnique({ where: { id: rid } });
        check('a typed repair Type matching a listed one by case uses the listed spelling', r2.status < 300 && row.repairType === 'AMC', [r2.status, row.repairType, r2.body]);
        await prisma.assetRepair.deleteMany({ where: { id: rid } });
      }
    } else { console.log('SKIP  no asset in the copy for the repair-type check'); }
  } catch (e) { fail += 1; console.log(`FAIL  test crashed: ${e && e.stack}`); } finally {
    try {
      if (restore) await prisma.employee.update({ where: { id: restore.id }, data: { isLocked: restore.isLocked, unlockRequestReason: restore.unlockRequestReason, unlockRequestStatus: restore.unlockRequestStatus, unlockRequestCount: restore.unlockRequestCount } });
      if (made.tickets.length) await prisma.employeeRecord.deleteMany({ where: { id: { in: made.tickets } } });
      if (made.holidays.length) await prisma.holiday.deleteMany({ where: { id: { in: made.holidays } } });
      if (made.cands.length) {
        await prisma.candidateNote.deleteMany({ where: { candidateId: { in: made.cands } } }).catch(() => {});
        await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch((e) => console.log('candidate cleanup', e.message));
      }
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch((e) => console.log('user cleanup', e.message));
    } catch (e) { console.log('cleanup problem', e.message); }
    console.log(`\n${pass} passed, ${fail} failed (copy database only)`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
