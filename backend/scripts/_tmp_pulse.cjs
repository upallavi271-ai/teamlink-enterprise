const fs = require('fs');
const D = 'C:/Users/user/Downloads/';
// Minimal CSV parser that respects quotes.
function parse(txt) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < txt.length; i += 1) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i+1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}
function load(f) {
  const rows = parse(fs.readFileSync(D + f, 'utf8'));
  const head = rows[0].map(h => h.replace(/\s+/g, ' ').trim());
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '').trim()])));
}
const active = load('active_employees.csv');
const relieved = load('relieved_employees.csv');
const resigned = load('Resigned Employee list.csv');
const rehired = load('rehired_employee_list.csv');

const code = (r) => String(r['Employee No'] || r['Employee Ref No (Import Purpose)'] || '').trim();
const fmt = (n, s) => '  ' + String(n).padEnd(28) + String(s).padStart(6);

console.log('ROW COUNTS');
console.log(fmt('active', active.length));
console.log(fmt('relieved', relieved.length));
console.log(fmt('resigned', resigned.length));
console.log(fmt('rehired', rehired.length));

const A = new Set(active.map(code)), R = new Set(relieved.map(code)), Q = new Set(resigned.map(code));
const all = new Set([...A, ...R, ...Q]);
console.log('\nUNIQUE EMPLOYEE CODES');
console.log(fmt('active', A.size));
console.log(fmt('relieved', R.size));
console.log(fmt('resigned', Q.size));
console.log(fmt('ALL DISTINCT PEOPLE', all.size));

const inBoth = [...A].filter(c => Q.has(c));
console.log('\nIN ACTIVE *AND* RESIGNED (' + inBoth.length + ') — notice period or rehired:');
inBoth.forEach(c => {
  const a = active.find(r => code(r) === c), q = resigned.find(r => code(r) === c);
  console.log('  ' + c.padEnd(8) + (a.Name || '').padEnd(30) + 'resigned ' + q['Date Of Resignation'] + '  LWD ' + q['Last Working Date']);
});
const activeRelieved = [...A].filter(c => R.has(c));
console.log('\nIN ACTIVE *AND* RELIEVED (' + activeRelieved.length + '):', activeRelieved.join(', ') || 'none');

console.log('\nEMAIL COVERAGE');
const em = (list, f) => list.filter(r => (r['Email Id'] || '').includes('@')).length;
console.log(fmt('active with email', em(active) + ' / ' + active.length));
console.log(fmt('relieved with email', em(relieved) + ' / ' + relieved.length));
console.log(fmt('resigned with email', 'n/a — no email column'));

console.log('\nDEPARTMENT VARIANTS (all files)');
const deps = {};
[...active, ...relieved, ...resigned].forEach(r => { const d = (r.Department || '').trim(); if (d) deps[d] = (deps[d] || 0) + 1; });
Object.entries(deps).sort((a,b)=>b[1]-a[1]).forEach(([d,n]) => console.log('  ' + d.padEnd(28) + n));

console.log('\nDESIGNATION VARIANTS');
const des = {};
[...active, ...relieved, ...resigned].forEach(r => { const d = (r.Designation || '').trim(); if (d) des[d] = (des[d] || 0) + 1; });
Object.entries(des).sort((a,b)=>b[1]-a[1]).forEach(([d,n]) => console.log('  ' + d.padEnd(28) + n));
process.exit(0);
