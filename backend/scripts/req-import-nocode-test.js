#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A REQUIREMENTS SHEET WITH NO "Requirement Code" AND NO "Department" COLUMN (founder, 2026-10-23, the live screenshot: "Required column(s) not found").
// SANDBOX ONLY.  cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/req-import-nocode-test.js
// Proves: such a sheet is accepted; a NEW requirement gets a REQ code from TeamLink; the department comes from the client / the sheet name / the importer;
// duplicates are found (twice in the file, and already on file); everybody imports directly (no approval).
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('RQI');
const path = require('path');
const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));

(async () => {
  try {
    const tl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Manufacturing', atsScopeDepartments: 'Manufacturing' }, { designation: 'TL' });
    const tok = await Z.mint(tl);
    const client = await Z.prisma.client.create({ data: { name: `ZZTEST RQI Client ${Z.RUN}`, location: 'ZZ Town', ownerDepartment: 'Manufacturing', clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-rqi-${Z.RUN}@example.test`, agreementStatus: 'ACTIVE' } });
    Z.made.clients.push(client.id);

    const sheet = (rows, name = 'Manufacturing All Requirement s') => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const upload = async (p, buf, extra = {}) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'reqs.xlsx');
      Object.entries(extra).forEach(([k, v]) => fd.append(k, String(v)));
      const r = await fetch(`${Z.API}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'X-Forwarded-For': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: fd });
      const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* */ }
      return { status: r.status, body, text };
    };

    const t1 = `ZZTEST RQI Plant Engineer ${Z.RUN}`; const t2 = `ZZTEST RQI Quality Chemist ${Z.RUN}`;
    const rows = [
      { 'Requirement Title': t1, 'Client Name': client.name, Openings: 2 },
      { 'Requirement Title': t2, 'Client Name': client.name, Openings: 1 },
      { 'Requirement Title': t1, 'Client Name': client.name, Openings: 2 }, // the same job twice in the file
    ];
    const buf = sheet(rows);
    const mode = (await Z.call('GET', '/api/ats-io/access', tok)).body.importModes.requirements;
    Z.check('A1 a TL imports requirements DIRECTLY (no approval)', mode === 'direct', mode);

    const chk = await upload('/api/ats-io/import/requirements/check', buf);
    const t = chk.body && chk.body.totals;
    Z.check('B1 a sheet with no Requirement Code / Department column is accepted (no "required column not found")', chk.status === 200 && t && t.error === 0, [chk.status, chk.text.slice(0, 300)]);
    Z.check('B2 the check finds 2 new and 1 duplicate (the same title + client twice in the file)', t && t.create === 2 && t.duplicate === 1, t);

    const done = await upload('/api/ats-io/import/requirements/commit', buf);
    Z.check('C1 the import is committed straight away', done.status === 200 && done.body && done.body.committed === true, [done.status, done.text.slice(0, 300)]);
    const made = await Z.prisma.requirement.findMany({ where: { title: { in: [t1, t2] } }, select: { id: true, title: true, reqCode: true, department: true, clientId: true } });
    made.forEach((m) => Z.made.reqs.push(m.id));
    Z.check('C2 two requirements were made (the duplicate row was not)', made.length === 2, made);
    Z.check('C3 each got a REQ code from TeamLink', made.every((m) => /^REQ-\d+$/.test(m.reqCode || '')), made.map((m) => m.reqCode));
    Z.check('C4 and the department of the client (Manufacturing)', made.every((m) => m.department === 'Manufacturing'), made.map((m) => m.department));
    Z.check('C5 the two codes are different', new Set(made.map((m) => m.reqCode)).size === 2, made.map((m) => m.reqCode));

    // the same file again: everything is already on file
    const again = await upload('/api/ats-io/import/requirements/check', buf);
    const t3 = again.body && again.body.totals;
    Z.check('D1 the same file again: nothing new, every row is a duplicate of what is on file', t3 && t3.create === 0 && t3.duplicate === 3, t3);
    const done2 = await upload('/api/ats-io/import/requirements/commit', buf);
    const n = await Z.prisma.requirement.count({ where: { title: { in: [t1, t2] } } });
    Z.check('D2 importing it again writes nothing', done2.status === 200 && n === 2, [done2.status, n]);

    // the sheet name names the department when the client has none
    const client2 = await Z.prisma.client.create({ data: { name: `ZZTEST RQI Client2 ${Z.RUN}`, location: 'ZZ Town', ownerDepartment: null, clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-rqi2-${Z.RUN}@example.test`, agreementStatus: 'ACTIVE' } });
    Z.made.clients.push(client2.id);
    const t4 = `ZZTEST RQI Welder ${Z.RUN}`;
    const dsheet = sheet([{ 'Requirement Title': t4, 'Client Name': client2.name }], 'Manufacturing Jobs');
    await upload('/api/ats-io/import/requirements/commit', dsheet);
    const w = await Z.prisma.requirement.findFirst({ where: { title: t4 }, select: { id: true, department: true, reqCode: true } });
    if (w) Z.made.reqs.push(w.id);
    Z.check('E1 a client with no department: the department named in the sheet name is used', w && w.department === 'Manufacturing' && /^REQ-/.test(w.reqCode || ''), w);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
