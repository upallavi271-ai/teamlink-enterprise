#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A NEWLY ADDED CANDIDATE IS VISIBLE AT ONCE, ON TOP, AND FOUND BY SEARCH (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --detach --no-watch && TL_API=http://localhost:4011 node scripts/new-candidate-visible-test.js
//   For an Admin and for a Recruiter: add a person by hand (no requirement) -> first in All people; found by name / phone / email;
//   first in the Pipeline's "new people" strip; the New button counts them; the New filter lists them; the profile opens; the picker finds them.
//   Then: a person added by the recruiter is NOT visible to another recruiter.
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
async function call(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await realFetch(`${API}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { status: r.status, body: j };
}
(async () => {
  const made = { users: [], cands: [] };
  try {
    const mk = async (tag, extra) => {
      const u = await prisma.user.create({ data: { passwordHash: 'x', name: `ZZTEST NV ${tag} ${RUN}`, email: `zz-nv-${tag}-${RUN}@example.test`, username: `zz-nv-${tag}-${RUN}@example.test`, role: 'EMPLOYEE', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active', ...extra } });
      made.users.push(u.id);
      return { u, tok: jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' }) };
    };
    const adm = await mk('adm', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const rec = await mk('rec', { atsRole: 'RECRUITER' });
    const rec2 = await mk('rec2', { atsRole: 'RECRUITER' });
    const mkCand = async (a, tag) => {
      const body = { name: `ZZTEST Newcomer ${tag} ${RUN}`, phone: `9${String(Date.now()).slice(-9)}`, email: `zz-newcomer-${tag}-${RUN}@example.test`, skills: 'ICU', currentSalary: '4 LPA', expectedSalary: '5 LPA', source: 'Naukri' };
      const r = await call('POST', '/api/candidates', a.tok, body);
      if (r.body && r.body.id) made.cands.push(r.body.id);
      return { r, body };
    };
    let recPerson = null;
    for (const [label, a] of [['admin', adm], ['recruiter', rec]]) {
      const { r, body } = await mkCand(a, label);
      check(`${label}: manual add -> 201`, r.status === 201, r.body);
      const id = r.body && r.body.id;
      if (label === 'recruiter') recPerson = { id, body };
      const list = async (qs) => (await call('GET', `/api/candidates?paged=1&${qs}`, a.tok)).body;
      let m = await list('view=master&sub=all&sort=created&dir=desc');
      check(`${label}: the new person is FIRST in All people`, m && m.rows && m.rows[0] && m.rows[0].id === id, m && m.rows && m.rows.slice(0, 2).map((x) => x.name));
      for (const [what, term] of [['name', body.name], ['phone', body.phone], ['email', body.email]]) {
        m = await list(`view=master&sub=all&search=${encodeURIComponent(term)}`);
        check(`${label}: search by ${what} finds them in All people`, m && m.rows && m.rows.some((x) => x.id === id), m && m.total);
      }
      let p = await list('view=pipeline&sub=active&sort=applied&dir=desc');
      check(`${label}: the new person is FIRST in the Pipeline's new-people strip`, p && p.waiting && p.waiting.rows[0] && p.waiting.rows[0].id === id, p && p.waiting && p.waiting.rows.slice(0, 2).map((x) => x.name));
      for (const [what, term] of [['name', body.name], ['phone', body.phone], ['email', body.email]]) {
        p = await list(`view=pipeline&sub=active&search=${encodeURIComponent(term)}`);
        check(`${label}: search by ${what} shows them in the Pipeline strip`, p && p.waiting && p.waiting.rows.some((x) => x.id === id), p && p.waiting);
      }
      const ns = (await call('GET', '/api/candidates/new-summary', a.tok)).body;
      check(`${label}: the New button counts them`, ns && ns.people >= 1 && ns.unplaced >= 1 && ns.today >= 1, ns);
      m = await list('view=master&sub=all&new=1&sort=created&dir=desc');
      check(`${label}: the New filter lists them first, only this week's people`, m && m.rows && m.rows[0] && m.rows[0].id === id && m.rows.every((x) => Date.now() - new Date(x.createdAt) < 8 * 86400000), m && m.rows && m.rows.slice(0, 2).map((x) => [x.name, x.createdAt]));
      const open = await call('GET', `/api/candidates/${id}`, a.tok);
      check(`${label}: can open the profile just added (no 403)`, open.status === 200, [open.status, open.body]);
      const pk = await call('GET', `/api/candidates/picker?q=${encodeURIComponent(body.name)}`, a.tok);
      check(`${label}: the picker (Add application) finds them`, pk.body && pk.body.rows && pk.body.rows.some((x) => x.id === id), pk.body);
      const row = ((await list(`view=master&sub=all&search=${encodeURIComponent(body.email)}`)).rows || []).find((x) => x.id === id) || {};
      check(`${label}: source and the day they came are on the row`, !!row.cameOn && !!(row.source || row.sourceKey), { cameOn: row.cameOn, source: row.source });
    }
    // another recruiter must not see the first recruiter's person
    const m2 = (await call('GET', `/api/candidates?paged=1&view=master&sub=all&search=${encodeURIComponent(recPerson.body.email)}`, rec2.tok)).body;
    check('another recruiter does NOT see it (reach unchanged)', m2 && m2.rows && m2.rows.length === 0, m2 && m2.rows);
    const open2 = await call('GET', `/api/candidates/${recPerson.id}`, rec2.tok);
    check('another recruiter cannot open it (403)', open2.status === 403, open2.status);
    // the wrongly dated old row (a future date) does not sit above today's arrivals
    const fut = await prisma.candidate.create({ data: { name: `ZZTEST Future ${RUN}`, phone: '9000000001', email: `zz-future-${RUN}@example.test`, createdAt: new Date(Date.now() + 40 * 86400000) } });
    made.cands.push(fut.id);
    const m3 = (await call('GET', '/api/candidates?paged=1&view=master&sub=all&sort=created&dir=desc', adm.tok)).body;
    check('a person dated in the future does not sit on top', m3 && m3.rows && m3.rows[0] && m3.rows[0].id !== fut.id, m3 && m3.rows && m3.rows.slice(0, 2).map((x) => x.name));
  } catch (e) { fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 600) : e); } finally {
    try { if (made.cands.length) await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }); } catch (e) { console.log('cleanup candidates', e.message); }
    try { await prisma.$executeRawUnsafe('DELETE FROM "CandidateAddedBy" WHERE "userId" IN (' + made.users.map(() => '?').join(',') + ')', ...made.users); } catch { /* table may not exist */ }
    try { await prisma.user.deleteMany({ where: { id: { in: made.users } } }); } catch (e) { console.log('cleanup users', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
