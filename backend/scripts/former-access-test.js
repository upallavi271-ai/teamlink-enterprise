/* eslint-disable no-console */
// The limited login of someone who has left (Exited / Relieved) - utils/formerAccess.js. Founder 2026-11-14: they may only download
// their own attendance, leave records, offer letter and joining letter; no other service is open to them.
// Pure checks of the allow-list and the letter rule (no database needed). Run: node scripts/former-access-test.js
const FA = require('../src/utils/formerAccess');

let failed = 0; let total = 0;
function check(name, ok, got) {
  total += 1;
  if (ok) console.log(`  ok   ${name}`);
  else { failed += 1; console.log(`  FAIL ${name}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`); }
}

console.log('The allow-list: exactly these six requests');
const yes = [
  ['GET', '/api/auth/me'], ['POST', '/api/auth/change-password'], ['GET', '/api/former/me'],
  ['GET', '/api/former/letters/cmabc123XYZ/file'], ['GET', '/api/former/attendance/export?format=csv&from=2026-01-01'], ['GET', '/api/former/leaves/export?format=xlsx'],
  ['get', '/api/former/me/'],
];
yes.forEach(([m, p]) => check(`allowed: ${m} ${p}`, FA.pathAllowed(m, p) === true));

console.log('Everything else is refused');
const no = [
  ['GET', '/api/employees'], ['GET', '/api/attendance/dashboard'], ['GET', '/api/leave'], ['POST', '/api/leave'], ['GET', '/api/payroll/payslips'],
  ['GET', '/api/former/payslips/abc/pdf'], ['GET', '/api/former/settings'], ['PUT', '/api/former/settings'], ['POST', '/api/former/employee/abc/switch-off'],
  ['GET', '/api/former/employee/abc/state'], ['POST', '/api/former/me'], ['DELETE', '/api/former/letters/abc/file'], ['PUT', '/api/auth/me'], ['PUT', '/api/auth/me/workspace'],
  ['GET', '/api/former/letters/../../employees/file'], ['GET', '/api/former/letters//file'], ['GET', '/api/former/letters/abc/file/extra'], ['GET', '/api/former/attendance/export/extra'],
  ['GET', '/api/auth/login'], ['GET', '/'], ['GET', ''],
];
no.forEach(([m, p]) => check(`refused: ${m} ${p || '(empty)'}`, FA.pathAllowed(m, p) === false));

console.log('Which files count as a letter: Offer Letter and Joining Letter only');
check('Offer Letter', FA.isLetter({ docType: 'Offer Letter' }));
check('Joining Letter', FA.isLetter({ docType: 'Joining Letter' }));
check('Experience Certificate is not offered', !FA.isLetter({ docType: 'Experience Certificate' }));
check('"Other Documents" named like a letter is not offered', !FA.isLetter({ docType: 'Other Documents', docName: 'Warning letter', fileName: 'warning-letter.pdf' }));
check('Aadhaar / PAN / Bank / Photo are not offered', ['Aadhaar', 'PAN', 'Bank Document', 'Photo', 'Passport'].every((t) => !FA.isLetter({ docType: t })));

console.log('Who gets it');
check('Exited and Relieved only (Terminated stays closed)', JSON.stringify(FA.ELIGIBLE) === JSON.stringify(['Exited', 'Relieved']), FA.ELIGIBLE);

console.log('A stored right can never leak through');
const idn = { role: 'TL', hrmsRole: 'HR', atsRole: 'MANAGER', accountsRole: 'ADMIN', products: { hrms: true, ats: true, accounts: true }, productRoles: { hrms: 'HR' }, scopeRoles: { x: 1 }, workspaces: ['hrms'], hrSuper: true, internalHr: { a: 1 } };
FA.limit(idn, { allowed: true });
check('roles and products are neutralised', idn.hrmsRole === 'NONE' && idn.atsRole === 'NONE' && idn.accountsRole === 'NONE' && !idn.products.hrms && !idn.products.ats && !idn.products.accounts, idn);
check('HR super / internal HR / workspaces are cleared', idn.hrSuper === undefined && idn.internalHr === undefined && idn.workspaces.length === 0);

console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
process.exit(failed ? 1 : 0);
