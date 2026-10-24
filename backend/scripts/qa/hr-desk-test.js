const TLT = require('./tl-target');
if (!TLT.sandbox) throw new Error('sandbox only');
const path = require('path'); const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const crypto = require('crypto');
const tag = Date.now().toString(36);
const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log('PASS', m); } else { fail += 1; console.log('FAIL', m); } };
const tok = (u) => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function http(u, method, p, body) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch(`${TLT.API}${p}`, { method, headers: { Authorization: `Bearer ${tok(u)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(150000) });
      const text = await r.text(); let b = null; try { b = JSON.parse(text); } catch { /* */ }
      return { status: r.status, body: b, text };
    } catch (e) { if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { status: 0, body: null, text: '' }; await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error('API down');
}
async function person(label, { role = 'EMPLOYEE', ats = null, hrms = null, dept, designation = null, atsAccess = true }) {
  const u = await prisma.user.create({ data: { name: `ZZTEST ${label}`, email: `zztest.hrd.${label.toLowerCase().replace(/\W+/g, '')}.${tag}@example.test`, passwordHash: crypto.randomBytes(16).toString('hex'), status: 'Active', role, hrmsRole: hrms || role, atsRole: ats || role, hrmsAccess: true, atsAccess, accountsAccess: false } });
  made.users.push(u.id);
  const e = await prisma.employee.create({ data: { userId: u.id, employeeCode: `ZZT-${label.replace(/\W+/g, '').slice(0, 8)}-${tag}`, name: `ZZTEST ${label}`, email: u.email, department: dept, designation, employmentStatus: 'Active' } });
  made.emps.push(e.id);
  return { u, e };
}
(async () => {
  const intClient = await prisma.client.findFirst({ where: { clientType: 'Internal' } })
    || await prisma.client.create({ data: { name: 'ZZTEST TeamLink Internal Hiring', clientType: 'Internal' } });
  if (intClient.name.startsWith('ZZTEST')) made.clients.push(intClient.id);
  const cl = await prisma.client.create({ data: { name: `ZZTEST Acme ${tag}`, ownerDepartment: 'Medical', contactName: 'ZZTEST Contact', contactEmail: `zz${tag}@example.test` } });
  made.clients.push(cl.id);

  const hrTL = await person('HRdeskTL', { role: 'TL', hrms: 'TL', ats: 'TL', dept: 'HR', designation: 'TL' });
  const hrExec = await person('HRexec', { role: 'HR', hrms: 'HR', ats: 'HR', dept: 'HR', designation: 'HR Executive' });
  const hrRec = await person('HRrec', { role: 'RECRUITER', hrms: 'EMPLOYEE', ats: 'RECRUITER', dept: 'HR', designation: 'Recruiter' });
  const medTL = await person('MedTL', { role: 'TL', hrms: 'TL', ats: 'TL', dept: 'Medical', designation: 'TL' });
  const bde = await person('BDE', { role: 'BDE', hrms: 'EMPLOYEE', ats: 'BDE', dept: 'BDE', designation: 'BDE' });
  const mgr = await person('Mgr', { role: 'MANAGER', dept: 'Administration', designation: 'Manager' });
  const adm = await person('Adm', { role: 'ADMIN', dept: 'Administration' });

  const reqInt = await prisma.requirement.create({ data: { title: `ZZTEST Internal Opening ${tag}`, clientId: intClient.id, internal: true, hiringType: 'TeamLink Internal Hire', status: 'OPEN', department: 'HR', tlId: hrTL.u.id } });
  const reqCl = await prisma.requirement.create({ data: { title: `ZZTEST ClientJob ${tag}`, clientId: cl.id, internal: false, status: 'OPEN', department: 'Medical', recruiterId: hrRec.u.id, tlId: hrTL.u.id } });
  made.reqs.push(reqInt.id, reqCl.id);
  const cI = await prisma.candidate.create({ data: { name: `ZZTEST CandInternal ${tag}`, email: `zzci${tag}@example.test` } });
  const cC = await prisma.candidate.create({ data: { name: `ZZTEST CandClient ${tag}`, email: `zzcc${tag}@example.test` } });
  made.cands.push(cI.id, cC.id);
  const aI = await prisma.application.create({ data: { candidateId: cI.id, requirementId: reqInt.id } });
  const aC = await prisma.application.create({ data: { candidateId: cC.id, requirementId: reqCl.id } });
  made.apps.push(aI.id, aC.id);

  const leaks = (text) => [`ClientJob ${tag}`, `Acme ${tag}`, `CandClient ${tag}`, 'ZZTEST Contact'].filter((w) => text.includes(w));

  // identity
  for (const [p, name, expAts, expDesk] of (process.env.PART2 ? [] : [[hrTL, 'HR-desk TL', 'HR', true], [hrExec, 'HR exec', 'HR', true], [hrRec, 'HR-dept recruiter', 'RECRUITER', false], [medTL, 'Medical TL', 'TL', false], [bde, 'BDE', 'BDE', false], [mgr, 'Manager', 'MANAGER', false], [adm, 'Admin', 'ADMIN', false]])) {
    const me = await http(p.u, 'GET', '/auth/me');
    const b = me.body || {}; const usr = b.user || b;
    ok((usr.atsRole || (usr.productRoles || {}).ats) === expAts && !!usr.hrDesk === expDesk, `${name}: ats=${usr.atsRole} hrDesk=${usr.hrDesk} (want ${expAts}/${expDesk})`);
  }
  console.log('hrTL hrmsRole:', ((await http(hrTL.u, 'GET', '/auth/me')).body || {}).hrmsRole);

  const desk = [['HR-desk TL', hrTL], ['HR exec', hrExec]];
  for (const [n, p] of (process.env.PART2 ? [] : desk)) {
    for (const url of ['/clients', `/clients/${cl.id}`, `/clients/${intClient.id}`, '/clients/agreements', '/client-merge/duplicates', '/clients/duplicates']) {
      const r = await http(p.u, 'GET', url);
      ok([403, 404].includes(r.status) && !leaks(r.text).length, `${n} GET ${url} -> ${r.status} ${r.body && r.body.error ? '"' + r.body.error + '"' : ''}`);
    }
    const lst = await http(p.u, 'GET', '/requirements?pageSize=200&limit=200');
    ok(lst.status === 200 && lst.text.includes(`Internal Opening ${tag}`) && !leaks(lst.text).length, `${n} job list: internal only (${lst.status}) leaks=${leaks(lst.text)}`);
    const dI = await http(p.u, 'GET', `/requirements/${reqInt.id}`);
    ok(dI.status === 200, `${n} internal job detail ${dI.status}`);
    const dC = await http(p.u, 'GET', `/requirements/${reqCl.id}`);
    ok([403, 404].includes(dC.status), `${n} client job detail -> ${dC.status}`);
    for (const url of (p === hrTL.u || p === hrTL ? ['/dashboard', '/ats/team', '/reports/ats', '/pending-work', '/search?q=Acme', '/notifications'] : [])) {
      const r = await http(p.u, 'GET', url);
      ok(!leaks(r.text).length, `${n} GET ${url} -> ${r.status}, no client data${leaks(r.text).length ? ' LEAK ' + leaks(r.text) : ''}`);
    }
    const intOnly = await http(p.u, 'GET', '/candidates?search=CandInternal');
    console.log(n, 'internal candidate visible:', intOnly.text.includes(`CandInternal ${tag}`), intOnly.status);
  }
  for (const [n, p] of desk) { const r = await http(p.u, 'GET', '/ats/search?q=Acme'); ok(!leaks(r.text).length && !(r.body && (r.body.clients || []).length), n + ' /ats/search?q=Acme: no client (' + r.status + ')'); const a = await http(p.u, 'POST', '/assistant/ask', { question: 'list ClientJob ' + tag }); ok(!leaks(a.text).length, n + ' assistant: no client data (' + a.status + ')'); }
  // keep-access
  const rr = await http(hrRec.u, 'GET', `/requirements/${reqCl.id}`);
  ok(rr.status === 200, `HR-dept recruiter still opens their client job (${rr.status})`);
  const rl = await http(hrRec.u, 'GET', '/requirements?pageSize=200');
  ok(rl.text.includes(`ClientJob ${tag}`), 'HR-dept recruiter sees their client job in the list');
  for (const [n, p] of [['Medical TL', medTL], ['Manager', mgr], ['Admin', adm]]) {
    const r = await http(p.u, 'GET', '/requirements?pageSize=200');
    ok(r.status === 200, `${n} list ${r.status}`);
  }
  const bl = await http(bde.u, 'GET', '/clients'); ok(bl.status === 200, `BDE clients ${bl.status}`);
  const al = await http(adm.u, 'GET', '/clients'); ok(al.status === 200 && al.text.includes(`Acme ${tag}`), 'Admin sees clients');
  const ml = await http(mgr.u, 'GET', '/clients'); ok(ml.status === 200, `Manager clients ${ml.status}`);
  // creates
  const mk = await http(hrTL.u, 'POST', '/requirements', { title: `ZZTEST HR new internal ${tag}`, internal: true, department: 'HR', openings: 1 });
  console.log('HR TL create internal:', mk.status, mk.body && (mk.body.error || mk.body.id));
  if (mk.body && mk.body.id) made.reqs.push(mk.body.id);
  const mk2 = await http(hrTL.u, 'POST', '/requirements', { title: `ZZTEST HR client ${tag}`, clientId: cl.id, openings: 1 });
  ok([400, 403].includes(mk2.status), `HR TL cannot create a client job (${mk2.status})`);
  if (mk2.body && mk2.body.id) made.reqs.push(mk2.body.id);
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); fail += 1; }).finally(async () => {
  const out = {};
  const ids = [...made.users, ...made.emps, ...made.clients, ...made.reqs, ...made.cands, ...made.apps];
  const extra = await prisma.requirement.findMany({ where: { title: { contains: tag } }, select: { id: true } });
  const rids = [...new Set([...made.reqs, ...extra.map((x) => x.id)])];
  out.ev = (await prisma.applicationStageEvent.deleteMany({ where: { OR: [{ applicationId: { in: made.apps } }, { candidateId: { in: made.cands } }] } })).count;
  out.apps = (await prisma.application.deleteMany({ where: { OR: [{ id: { in: made.apps } }, { requirementId: { in: rids } }] } })).count;
  out.cands = (await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } })).count;
  out.reqs = (await prisma.requirement.deleteMany({ where: { id: { in: rids } } })).count;
  out.clients = (await prisma.client.deleteMany({ where: { id: { in: made.clients } } })).count;
  out.audit = (await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: [...ids, ...rids] } }] } })).count;
  out.notes = (await prisma.notification.deleteMany({ where: { userId: { in: made.users } } })).count;
  out.emps = (await prisma.employee.deleteMany({ where: { id: { in: made.emps } } })).count;
  out.users = (await prisma.user.deleteMany({ where: { id: { in: made.users } } })).count;
  console.log('cleanup', out);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
});
