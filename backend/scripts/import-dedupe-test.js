#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ATS IMPORTS MUST NOT MAKE THE SAME RECORD TWICE (founder, 2026-10-24: "data import chesthe multiple times repeat ayyi duplicates avuthunnai").
// SANDBOX ONLY.  cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/import-dedupe-test.js
// Proves, for candidates and clients: the same file twice; the same person written differently (phone with spaces / +91 / 0, e-mail capitals and
// spaces, name capitals); a person listed twice in one file by e-mail in one row and phone in another; two people sharing one phone; two imports
// started at the same moment (a double click). Nothing is created twice.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('DDP');
const path = require('path');
const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));

(async () => {
  try {
    const { prisma } = Z;
    const admin = await Z.mkUser('adm', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', hrmsAccess: true, accountsAccess: true });
    const tok = await Z.mint(admin);
    const sheet = (rows, name) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const upload = async (kind, step, buf, extra = {}) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'data.xlsx');
      Object.entries(extra).forEach(([k, v]) => fd.append(k, String(v)));
      const r = await fetch(`${Z.API}/api/ats-io/import/${kind}/${step}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'X-Forwarded-For': `10.6.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: fd });
      const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ }
      return { status: r.status, body, text };
    };
    const N = (s) => `ZZTEST DDP ${s} ${Z.RUN}`;
    const cands = async () => prisma.candidate.findMany({ where: { name: { contains: `ZZTEST DDP` }, AND: [{ name: { contains: Z.RUN } }] }, select: { id: true, name: true, email: true, phone: true } });
    const track = async () => { (await cands()).forEach((c) => { if (!Z.made.cands.includes(c.id)) Z.made.cands.push(c.id); }); };
    const ph = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`.slice(0, 10).replace(/^90/, '98');

    // ============== candidates ==============
    const p1 = ph(); const p2 = ph(); const p3 = ph();
    const e = (s) => `zz-ddp-${s}-${Z.RUN}@example.test`;
    const rows = [
      { 'Full Name': N('Ravi'), Email: e('ravi'), Phone: `${p1.slice(0, 5)} ${p1.slice(5)}`, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },
      { 'Full Name': N('Ravi').toUpperCase(), Email: ` ${e('ravi').toUpperCase()} `, Phone: `+91 ${p1}`, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },       // same person: capitals, spaces, +91
      { 'Full Name': N('Ravi'), Email: '', Phone: `0${p1}`, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },                                                // same person: phone only, leading 0
      { 'Full Name': N('Sita'), Email: e('sita'), Phone: '', 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },
      { 'Full Name': N('Sita'), Email: '', Phone: p2, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },                                                      // may be Sita: no way to know -> two people, fine
      { 'Full Name': N('Gopi'), Email: e('gopi1'), Phone: p3, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },
      { 'Full Name': N('Gopi'), Email: e('gopi2'), Phone: p3, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 },                                              // same phone, other e-mail -> same person
    ];
    const buf = sheet(rows, 'Candidates');
    const chk = await upload('candidates', 'check', buf);
    const t = chk.body && chk.body.totals;
    if (process.env.DDP_DEBUG) console.log(JSON.stringify(chk.body && chk.body.results));
    Z.check('A1 the check accepts the sheet', chk.status === 200 && t, [chk.status, chk.text.slice(0, 300)]);
    Z.check('A2 the check sees Ravi x3 as ONE person (2 duplicates) and the shared-phone Gopi as a duplicate: 4 new, 3 duplicates', t && t.create === 4 && t.duplicate === 3, t);
    const done = await upload('candidates', 'commit', buf);
    await track();
    const made = await cands();
    const ravi = made.filter((c) => /ravi/i.test(c.name));
    const gopi = made.filter((c) => /gopi/i.test(c.name));
    Z.check('B1 committed (200)', done.status === 200 && done.body && done.body.committed === true, [done.status, done.text.slice(0, 300)]);
    Z.check('B2 Ravi written three ways is ONE candidate', ravi.length === 1, ravi);
    Z.check('B3 two Gopi rows with one phone are ONE candidate', gopi.length === 1, gopi);
    // the same file again, and again at once (a double click)
    const before = (await cands()).length;
    const [r1, r2] = await Promise.all([upload('candidates', 'commit', buf), upload('candidates', 'commit', buf)]);
    await track();
    Z.check('C1 the same file imported again (twice at the same moment) adds nobody', (await cands()).length === before, { before, after: (await cands()).length, s: [r1.status, r2.status] });

    // a brand-new file, started twice at once (double click on the first import)
    const q1 = ph();
    const fresh = sheet([{ 'Full Name': N('Latha'), Email: e('latha'), Phone: q1, 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 }, { 'Full Name': N('Mohan'), Email: e('mohan'), Phone: ph(), 'Current Salary': 0, 'Expected Salary': 300000, 'Notice Period': 'Immediate', 'Total Experience (years)': 0 }], 'Candidates');
    const d3 = await Promise.all([upload('candidates', 'commit', fresh), upload('candidates', 'commit', fresh), upload('candidates', 'commit', fresh)]);
    if (process.env.DDP_DEBUG) console.log(JSON.stringify(((d3[0].body || {}).report || {}).results));
    await track();
    const lm = (await cands()).filter((c) => /latha|mohan/i.test(c.name));
    Z.check('D1 a new file sent three times at the same moment makes each person ONCE', lm.length === 2, lm);

    // ============== clients ==============
    const cn = (s) => `ZZTEST DDP ${s} ${Z.RUN}`;
    const crow = (name, extra = {}) => ({ 'Client Name': name, Location: 'ZZ Town', 'Contact Name': 'ZZ', 'Contact Email': `zz-ddp-c-${Z.RUN}@example.test`, ...extra });
    const cheads = await prisma.client.count({ where: { name: { contains: 'ZZTEST DDP' } } });
    void cheads;
    const cb = sheet([crow(cn('Apollo Hospitals')), crow(`  ${cn('apollo hospitals').toUpperCase()}  `), crow(cn('Nova Care'))], 'Clients');
    const cchk = await upload('clients', 'check', cb);
    Z.check('E1 clients: the same name in other capitals / with spaces is a duplicate inside the file (2 new, 1 duplicate)', cchk.status === 200 && cchk.body.totals.create === 2 && cchk.body.totals.duplicate === 1, cchk.body && cchk.body.totals || cchk.text.slice(0, 300));
    await upload('clients', 'commit', cb);
    const cc = await prisma.client.findMany({ where: { name: { contains: `ZZTEST DDP` }, AND: [{ name: { contains: Z.RUN } }] }, select: { id: true, name: true } });
    cc.forEach((c) => Z.made.clients.push(c.id));
    Z.check('E2 two clients were made, not three', cc.length === 2, cc.map((c) => c.name));
    const cbefore = cc.length;
    await Promise.all([upload('clients', 'commit', cb), upload('clients', 'commit', cb)]);
    const cafter = await prisma.client.count({ where: { name: { contains: `ZZTEST DDP` }, AND: [{ name: { contains: Z.RUN } }] } });
    Z.check('E3 the same clients file twice at the same moment adds none', cafter === cbefore, { cbefore, cafter });

    // ============== requirements (founder 2026-10-24: "only the remaining ones come in") ==============
    const rc = await prisma.client.create({ data: { name: cn('Req Client'), clientType: 'Direct', ownerDepartment: 'Medical', agreementStatus: 'ACTIVE', status: 'Active' } });
    Z.made.clients.push(rc.id);
    const rq = await prisma.requirement.create({ data: { title: cn('Staff Nurse'), clientId: rc.id, department: 'Medical', status: 'OPEN', openings: 2, location: 'Hyderabad', reqCode: `ZZDDP-${Z.RUN}-1` } });
    Z.made.reqs.push(rq.id);
    const rrow = (title, loc, openings, extra = {}) => ({ 'Requirement Title': title, 'Client Name': rc.name, Department: 'Medical', Location: loc, Openings: openings, ...extra });
    const rb = sheet([
      rrow(`  ${cn('staff nurse').toUpperCase()} `, 'Hyderabad', 2), // same job, written in capitals with spaces -> duplicate (certain)
      rrow(cn('Staff Nurse.'), 'hyderabad', 5), // same job, same city, other openings -> duplicate (likely, same city)
      rrow(cn('Staff Nurse'), 'Vijayawada', 2), // the same role in ANOTHER city is a different job -> comes in
      rrow(cn('Lab Technician'), 'Hyderabad', 1), // a new role -> comes in
    ], 'Requirements');
    const rchk = await upload('requirements', 'check', rb);
    Z.check('F1 requirements: the check names the 2 twins as duplicates and lets the 2 new ones in', rchk.status === 200 && rchk.body.totals.duplicate === 2 && rchk.body.totals.create === 2, rchk.body ? { totals: rchk.body.totals, rows: (rchk.body.results || []).map((r) => `${r.row}:${r.action}:${String(r.message || '').slice(0, 140)}`) } : rchk.text.slice(0, 300));
    await upload('requirements', 'commit', rb);
    const mine = await prisma.requirement.findMany({ where: { clientId: rc.id }, select: { id: true, title: true, location: true } });
    mine.forEach((m) => { if (!Z.made.reqs.includes(m.id)) Z.made.reqs.push(m.id); });
    Z.check('F2 after the import the client has 3 requirements (1 old + 2 new): no twin was made', mine.length === 3, mine.map((m) => `${m.title}|${m.location}`));
    const rmsg = (rchk.body.results || []).filter((r) => r.action === 'duplicate').map((r) => r.message).join(' ');
    Z.check('F3 the duplicate rows say which requirement they look like', /ZZDDP-/.test(rmsg) || /Staff Nurse/i.test(rmsg), rmsg.slice(0, 240));
    const rbefore = mine.length;
    await upload('requirements', 'commit', rb);
    await Promise.all([upload('requirements', 'commit', rb), upload('requirements', 'commit', rb)]);
    const rafter = await prisma.requirement.count({ where: { clientId: rc.id } });
    Z.check('F4 the same requirements file again (and twice at once) adds nothing', rafter === rbefore, { rbefore, rafter });
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 900) : e); } finally {
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
