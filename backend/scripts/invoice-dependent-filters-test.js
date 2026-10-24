#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Invoice page: dependent Department -> Section -> Role (seat) -> Employee filters.
// SANDBOX ONLY:  cd backend && TL_API=http://localhost:4011 node scripts/invoice-dependent-filters-test.js
// Reads the real register payload (GET /api/invoices/register) as a ZZTEST admin and
// runs the page's own filter modules (frontend/src/pages/invoices/invHierarchy.js,
// invFilters.js, bundled with esbuild) over it. Writes nothing but two ZZTEST users.
// ---------------------------------------------------------------------------
const path = require('path');
const os = require('os');
const Z = require('./lib/zzfix')('IF');

const { prisma, call, check } = Z;

const FE = path.resolve(Z.BACK, '..', 'frontend');
function load(entry) {
  const esb = require(path.join(FE, 'node_modules', 'esbuild'));
  const out = path.join(os.tmpdir(), `zzif-${Z.RUN}-${path.basename(entry)}.cjs`);
  esb.buildSync({
    entryPoints: [path.join(FE, 'src/pages/invoices', entry)], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'error',
  });
  return require(out);
}
const sum = (rows, f) => Math.round(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0) * 100) / 100;

(async () => {
  await Z.preclean();
  try {
    const H = load('invHierarchy.js');
    const F = load('invFilters.js');
    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', accountsAccess: false }, {});
    const T = await Z.mint(admin);
    const R = await call('GET', '/api/invoices/register?period=all', T);
    check('A1 register loads for an Accounts admin', R.status === 200 && Array.isArray(R.body.rows), R.status);
    const rr = await call('GET', '/api/invoices/register?period=all', await Z.mint(rec));
    check('A2 a recruiter with no Accounts access still gets nothing (no widening)', rr.status === 403 || rr.status === 401, rr.status);
    const { rows, hierarchy: h, noInvoice } = R.body;
    const stance = R.body.gstStance || {};
    const pass = (f) => rows.filter((r) => F.passes(r, { ...F.BLANK_FILTERS, ...f }, { ...F.ALL_PERIOD }, stance));

    // --- roles for Education come from the stored seats
    const edu = h.departments.find((d) => d.name === 'Education');
    const roles = H.roleOptions(h, 'Education');
    const seatCodes = edu.sections.flatMap((s) => s.seats);
    check('R1 Education roles = its TL seat(s) + EDU-1..EDU-10, read from the structure',
      JSON.stringify(roles.map((o) => o.value).sort()) === JSON.stringify([...seatCodes].sort())
      && roles.some((o) => o.value === 'EDU-1') && roles.some((o) => o.value === 'EDU-10')
      && roles.filter((o) => o.tl).length === edu.sections.length, roles.map((o) => o.label));
    check('R2 no duplicate role options', new Set(roles.map((o) => o.value)).size === roles.length, null);
    const med = H.roleOptions(h, 'Medical').map((o) => o.value);
    check('R3 Medical roles show only Medical seats', med.length > 0 && med.every((c) => /^MED/.test(c)), med);
    const secB = edu.sections.find((s) => s.key === 'Education|Team B');
    check('R4 a section narrows the roles', !!secB && H.roleOptions(h, 'Education', secB.key).every((o) => secB.seats.includes(o.value)), null);

    // --- employees per role vs the database
    const pos = await prisma.position.findMany({ where: { department: 'Education' }, select: { code: true, assignments: { select: { employeeId: true, fromDate: true, toDate: true } } } });
    let allRoleOk = true; let detail = null;
    roles.forEach((o) => {
      if (!allRoleOk) return;
      const want = new Set(pos.find((p) => p.code === o.value).assignments.filter((a) => !(a.toDate && a.toDate <= a.fromDate)).map((a) => `e:${a.employeeId}`));
      const got = H.employeeOptions(h, 'Education', 'All', o.value).map((x) => x.value);
      if (got.length !== new Set(got).size || got.length !== want.size || !got.every((k) => want.has(k))) { allRoleOk = false; detail = [o.value, got.length, want.size]; }
    });
    check('E1 for every Education role the Employee list = exactly the people who held that seat (no duplicates, no one else)', allRoleOk, detail);
    const e1 = H.employeeOptions(h, 'Education', 'All', 'EDU-1');
    const e2 = H.employeeOptions(h, 'Education', 'All', 'EDU-2');
    check('E2 EDU-1 and EDU-2 give different people', e1.length > 0 && e2.length > 0 && !e1.some((a) => e2.some((b) => b.value === a.value)), [e1.map((x) => x.label), e2.map((x) => x.label)]);
    check('E3 EDU-1 includes the current holder', e1.some((o) => o.current), e1.map((o) => o.label));
    const eAll = H.employeeOptions(h, 'Education', 'All', 'All');
    const eduPeople = h.people.filter((p) => !p.unplaced && p.entries.some((e) => e.department === 'Education'));
    check('E4 Role = All lists every Education employee once', eAll.length === eduPeople.length && new Set(eAll.map((x) => x.value)).size === eAll.length, [eAll.length, eduPeople.length]);
    check('E5 former holders are tagged Former, current ones are not', eAll.some((o) => !o.current && /Former/.test(o.label)) && eAll.filter((o) => o.current).every((o) => !/Former/.test(o.label)), null);
    check('E6 no non-Education employee appears under an Education role', eAll.every((o) => o.person.entries.some((e) => e.department === 'Education')), null);

    // --- rows, counts, totals
    const eduRows = pass({ dept: 'Education' });
    const r1 = pass({ dept: 'Education', role: 'EDU-1' });
    check('F1 Role EDU-1 keeps only EDU-1 invoices (inside Education)', r1.every((r) => r.department === 'Education' && (r.seat === 'EDU-1' || r.tlSeat === 'EDU-1')), r1.length);
    check('F2 Role EDU-1 is a subset of the Education invoices', r1.length <= eduRows.length, [r1.length, eduRows.length]);
    check('F3 Role = All equals the Education invoices', pass({ dept: 'Education', role: 'All' }).length === eduRows.length, null);
    const fcN = F.facetCounts(rows, { ...F.BLANK_FILTERS, dept: 'Education' }, { ...F.ALL_PERIOD }, stance);
    check('F4 every role count equals the real filtered rows', roles.every((o) => (fcN.role.get(o.value) || 0) === pass({ dept: 'Education', role: o.value }).length), roles.map((o) => [o.value, fcN.role.get(o.value) || 0, pass({ dept: 'Education', role: o.value }).length]));
    const withInv = e1.find((o) => rows.some((r) => r.recruiterKey === o.value));
    if (withInv) {
      const re = pass({ dept: 'Education', role: 'EDU-1', rec: withInv.value });
      check('F5 Employee filter inside the role narrows to that person only', re.length > 0 && re.every((r) => r.recruiterKey === withInv.value || r.tlKey === withInv.value) && re.length <= r1.length, re.length);
      const before = sum(re, (r) => r.billing); const gst = sum(re, (r) => r.gst); const after = sum(re, (r) => r.invoiceValue);
      check('F6 Before GST + GST = After GST on the filtered list (cards = sums of the rows shown)', Math.abs(before + gst - after) < 0.05 + re.length * 0.01, [before, gst, after]);
    } else check('F5 (no EDU-1 holder has invoices in this sandbox copy)', true);
    check('F7 other departments are unaffected by the new role filter', pass({ dept: 'Medical' }).length === rows.filter((r) => r.department === 'Medical').length && pass({ dept: 'Medical' }).every((r) => r.department === 'Medical'), null);
    const wj = (noInvoice.rows || []).filter((x) => H.matchesHierarchy(x, { dept: 'All', section: 'All', rec: 'All', role: 'EDU-1' }));
    check('F8 waiting joinings carry seat + tlSeat and follow the role', (noInvoice.rows || []).length === 0 || ('seat' in noInvoice.rows[0] && 'tlSeat' in noInvoice.rows[0] && wj.every((x) => x.seat === 'EDU-1' || x.tlSeat === 'EDU-1')), null);
    check('F9 a TL seat matches through the invoice TL seat', roles.filter((o) => o.tl).every((o) => pass({ dept: 'Education', role: o.value }).every((r) => r.seat === o.value || r.tlSeat === o.value)), null);

    // --- reset rules (pure functions)
    const vd = ['Education', 'Medical', 'Manufacturing'];
    const base = { ...F.BLANK_FILTERS };
    let f = H.changeFilter(base, 'dept', 'Education', h, vd);
    f = H.changeFilter(f, 'role', 'EDU-1', h, vd);
    check('X1 picking a role keeps the department', f.role === 'EDU-1' && f.dept === 'Education', f);
    const holder = e1[0].value;
    f = H.changeFilter(f, 'rec', holder, h, vd);
    check('X2 a holder of the role can be picked', f.rec === holder, f);
    const f2 = H.changeFilter(f, 'role', 'EDU-2', h, vd);
    check('X3 changing the role resets an employee who no longer matches', f2.rec === 'All' && f2.role === 'EDU-2', f2);
    const f2b = H.changeFilter(f, 'role', 'All', h, vd);
    check('X4 Role = All keeps an Education employee', f2b.role === 'All' && f2b.rec === holder, f2b);
    const f3 = H.changeFilter(f, 'dept', 'Medical', h, vd);
    check('X5 changing the department resets Role and Employee', f3.role === 'All' && f3.rec === 'All' && f3.dept === 'Medical', f3);
    const sec = edu.sections[edu.sections.length - 1];
    const f4 = H.changeFilter({ ...base, dept: 'Education', role: 'EDU-1' }, 'section', sec.key, h, vd);
    check('X6 a section that does not hold the role resets it; one that does keeps it', sec.seats.includes('EDU-1') ? f4.role === 'EDU-1' : f4.role === 'All', f4);
    const f5 = H.changeFilter(base, 'role', 'MED-3', h, vd);
    check('X7 picking a seat with All departments selects its department', f5.dept === 'Medical' && f5.role === 'MED-3', f5);
    const f6 = H.reconcile({ ...base, role: 'Java Developer' }, h, vd);
    check('X8 an old saved job-title Role goes back to All', f6.role === 'All', f6);
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      const left = await Z.cleanup();
      Z.check('Z cleanup: nothing ZZTEST IF is left in the sandbox', Object.values(left).every((n) => n === 0), left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();
