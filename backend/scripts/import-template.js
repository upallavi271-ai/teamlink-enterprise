// Writes the import workbook to a file.
//
//   node scripts/import-template.js [output.xlsx]
//
// The workbook itself is built by src/utils/importTemplate.js, which the
// /data-import/template download also uses — so what you hand somebody from
// the command line and what they download from the app are the same file.

const fs = require('fs');
const path = require('path');
const { buildTemplate, SHEETS, LISTS } = require('../src/utils/importTemplate');

const out = process.argv[2] || path.join(process.cwd(), 'TeamLink-Import-Template.xlsx');

(async () => {
  const buffer = await buildTemplate();
  fs.writeFileSync(out, Buffer.from(buffer));
  const total = SHEETS.reduce((n, s) => n + s.columns.length, 0);
  console.log(`Wrote ${out}`);
  console.log(`${SHEETS.length} data sheets, ${total} columns, ${Object.keys(LISTS).length} dropdown lists.`);
})().catch((e) => { console.error(e); process.exit(1); });
