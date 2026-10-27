#!/usr/bin/env node
// ---------------------------------------------------------------------------
// INVOICES -> RECRUITER NAME FILTER = HRMS NAMES (founder 2026-10-27: "EDU-2 · Edu 2" showed a seat as a person). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/invoice-recruiter-names-test.js
// Proves: a tracker owner name that is a seat's name ("Edu 2") or matches no employee becomes the employee who held that
// seat on the joining date (PositionAssignment); every e: key is a real Employee; the recruiter text is a name, not a seat code.
// Read-only: no rows are written.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('IRN');

(async () => {
  const { prisma } = Z;
  try {
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', employee: { isNot: null } } });
    const S = await Z.mint(sa);
    const r = await Z.call('GET', '/api/invoices/register', S);
    const rows = (r.body && (r.body.rows || r.body.invoices)) || [];
    Z.check('R1 the invoice register loads', r.status === 200 && rows.length > 0, [r.status, rows.length]);
    const withRec = rows.filter((x) => x.recruiterKey);
    const empIds = new Set((await prisma.employee.findMany({ select: { id: true } })).map((e) => e.id));
    const eKeys = withRec.filter((x) => String(x.recruiterKey).startsWith('e:'));
    Z.check('R2 every employee key on an invoice is a real HRMS employee', eKeys.every((x) => empIds.has(x.recruiterKey.slice(2))), eKeys.filter((x) => !empIds.has(x.recruiterKey.slice(2))).slice(0, 3));
    const seatish = withRec.filter((x) => /^(edu|med|mfg|non\s*it)[\s-]*\d+$/i.test(String(x.recruiter || '').trim()));
    Z.check('R3 no recruiter is shown as a seat name ("Edu 2", "MED 3")', seatish.length === 0, seatish.slice(0, 3).map((x) => [x.invoiceNumber, x.recruiter, x.seat]));
    const codeAsName = withRec.filter((x) => x.seat && String(x.recruiter || '').trim().toUpperCase() === String(x.seat).toUpperCase());
    Z.check('R4 no recruiter name equals its seat code', codeAsName.length === 0, codeAsName.slice(0, 3).map((x) => [x.invoiceNumber, x.recruiter]));
    // the seat holder rule: an EDU-2 invoice whose recorded owner was "Edu 2" -> whoever held EDU-2 on the joining date
    const edu2 = withRec.filter((x) => x.seat === 'EDU-2');
    const pos = await prisma.position.findFirst({ where: { code: 'EDU-2' }, include: { assignments: { include: { employee: { select: { name: true } } } } } });
    const holderOn = (d) => (pos ? pos.assignments.filter((a) => !(a.toDate && a.toDate <= a.fromDate) && a.fromDate <= d && (!a.toDate || a.toDate >= d)) : []);
    const fu = await prisma.applicationFollowUp.findFirst({ where: { ownerName: 'Edu 2' }, select: { applicationId: true, application: { select: { joiningDate: true, candidateId: true } } } });
    if (fu && fu.application && fu.application.joiningDate) {
      const h = holderOn(fu.application.joiningDate.slice(0, 10));
      const inv = rows.find((x) => x.candidateId === fu.application.candidateId);
      Z.check('R5 the "Edu 2" invoice now names the EDU-2 holder on the joining date (or stays flagged when the seat was empty)', !inv || (h.length === 1 ? inv.recruiter === h[0].employee.name : String(inv.recruiterKey || '').startsWith('n:')), [inv && inv.recruiter, inv && inv.recruiterKey, h.map((a) => a.employee.name), fu.application.joiningDate]);
    } else {
      Z.check('R5 (no "Edu 2" tracker row with a joining date in this copy - nothing to resolve)', true);
    }
    const unmatched = [...new Set(withRec.filter((x) => String(x.recruiterKey).startsWith('n:')).map((x) => x.recruiter))];
    console.log(`INFO  ${edu2.length} EDU-2 invoice(s); names not found in HRMS (shown as "— not found in HRMS"): ${unmatched.length}${unmatched.length ? ` (${unmatched.join(', ')})` : ''}`);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
