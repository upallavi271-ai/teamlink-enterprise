// Copies the shared block of backend/src/utils/payrollCalc.js into frontend/src/utils/payrollCalc.js.
const fs = require('fs'); const path = require('path');
const B = path.join(__dirname, '..', 'src', 'utils', 'payrollCalc.js');
const F = path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'payrollCalc.js');
const src = fs.readFileSync(B, 'utf8');
const m = src.match(/\/\/ ---- BEGIN SHARED ----\r?\n([\s\S]*?)\/\/ ---- END SHARED ----/);
if (!m) throw new Error('markers not found');
const out = `// COPY of the shared block of backend/src/utils/payrollCalc.js for the browser (live Before -> After preview of the payroll editor).
// KEEP IN SYNC: backend/scripts/payroll-calc-test.js fails when the two differ. Edit the backend file, then run: node backend/scripts/payroll-calc-sync.js
// ---- BEGIN SHARED ----
${m[1]}// ---- END SHARED ----

export { payrollCalc, payrollCalcProblems, PAYROLL_CALC_AUTO, PAYROLL_CALC_LIMIT };
`;
fs.writeFileSync(F, out);
console.log('written', F);
