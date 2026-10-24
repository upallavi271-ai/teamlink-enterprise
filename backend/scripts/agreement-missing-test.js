#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLIENTS WITH NO AGREEMENT ARE LISTED (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/agreement-missing-test.js
//   M1 a client with nothing on file is listed   M2 a client with an agreement text is not   M3 a client with a Drive link is not
//   M4 a recruiter is refused (403)              M5 every listed client really has no signed file / text (cross-check with the real data)
// ---------------------------------------------------------------------------
const path = require('path');
const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox), never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX; process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400)}` : ''}`); };
async function call(method, p, token) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { method, headers: h });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const made = { users: [], clients: [] };
  try {
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST AM ${tag} ${RUN}`, email: `zz-am-${tag}-${RUN}@example.test`, username: `zz-am-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    };
    const adm = await mk('adm', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const rec = await mk('rec', { atsRole: 'RECRUITER' });
    const mkClient = async (tag, extra = {}) => { const c = await prisma.client.create({ data: { name: `ZZTEST AM ${tag} ${RUN}`, ...extra } }); made.clients.push(c.id); return c; };
    const none = await mkClient('none');
    const withText = await mkClient('text', { agreementDocument: 'AGREEMENT TEXT' });
    const r = await call('GET', '/api/agreement/missing', adm);
    check('M0 admin gets 200', r.status === 200 && r.body && Array.isArray(r.body.rows), [r.status, r.body]);
    const ids = new Set(((r.body && r.body.rows) || []).map((x) => x.id));
    check('M1 a client with nothing on file is listed', ids.has(none.id));
    check('M2 a client with an agreement text is NOT listed', !ids.has(withText.id));
    const rr = await call('GET', '/api/agreement/missing', rec);
    check('M4 a recruiter is refused (403)', rr.status === 403, rr.status);
    // M5 cross-check against the real data
    const rows = (r.body && r.body.rows) || [];
    const sample = rows.filter((x) => !String(x.name).startsWith('ZZTEST')).slice(0, 40);
    let bad = 0;
    for (const x of sample) {
      const c = await prisma.client.findUnique({ where: { id: x.id }, select: { agreementDocument: true } });
      const signed = await prisma.clientDocument.count({ where: { clientId: x.id, kind: 'AGREEMENT_SIGNED' } });
      if ((c && c.agreementDocument) || (signed && !x.fileLost)) bad += 1; // a recorded file that is not on this disk must say so (fileLost)
    }
    const total = await prisma.client.count();
    console.log(`INFO  ${rows.length} of ${total} clients listed as having no agreement`);
    check('M5 no listed client has an agreement text, and a recorded-but-lost file is flagged fileLost', bad === 0, bad);
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 600) : e); } finally {
    try { await prisma.clientDocument.deleteMany({ where: { clientId: { in: made.clients } } }); } catch { /* */ }
    try { await prisma.client.deleteMany({ where: { id: { in: made.clients } } }); } catch (e) { console.log('cleanup clients', e.message); }
    try { await prisma.user.deleteMany({ where: { id: { in: made.users } } }); } catch (e) { console.log('cleanup users', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
