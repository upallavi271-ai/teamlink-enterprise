// Uploads a filled workbook to the import API.
//
//   node scripts/run-import.js check  <file.xlsx>    validate only, writes nothing
//   node scripts/run-import.js commit <file.xlsx>    import it
//
// Talks to the running server rather than to the database directly, so it goes
// through exactly the same permission check, validation and audit trail as the
// Data Import screen. A script that reached past the API would prove nothing
// about whether the API works.
const fs = require('fs');

const BASE = process.env.TL_API || 'http://127.0.0.1:4010/api';
const EMAIL = process.env.TL_EMAIL || 'superadmin@teamlink.com';
const PW = process.env.TL_PASSWORD || 'password123';

const [, , MODE, FILE] = process.argv;
if (!['check', 'commit'].includes(MODE) || !FILE) {
  console.error('usage: node scripts/run-import.js <check|commit> <file.xlsx>');
  process.exit(1);
}

(async () => {
  const lr = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  const lj = await lr.json();
  if (!lj.token) throw new Error(`login failed: ${JSON.stringify(lj)}`);

  const data = fs.readFileSync(FILE);
  const boundary = '----TL' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${FILE.split(/[\\/]/).pop()}"\r\n`
    + 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n', 'utf8',
  );
  const body = Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);

  const r = await fetch(`${BASE}/data-import/${MODE}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lj.token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const j = await r.json();
  const rep = j.report || j;
  console.log(`${MODE.toUpperCase()} -> HTTP ${r.status}`);
  if (j.error) console.log('  ', j.error);
  if (rep && rep.totals) {
    console.log(`  ok=${rep.ok}  created=${rep.totals.created}  updated=${rep.totals.updated}  errors=${rep.totals.errors}`);
    rep.sheets.forEach((s) => {
      if (s.skipped) return;
      console.log(`    ${s.sheet.padEnd(17)} rows=${String(s.rows).padStart(4)}  created=${String(s.created).padStart(4)}  updated=${String(s.updated).padStart(4)}  errors=${s.errors.length}`);
      s.errors.slice(0, 10).forEach((e) => console.log(`         row ${e.row} ${e.column ? `[${e.column}] ` : ''}${e.message}`));
      if (s.errors.length > 10) console.log(`         … and ${s.errors.length - 10} more`);
    });
  }
  process.exit(r.status === 200 ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
