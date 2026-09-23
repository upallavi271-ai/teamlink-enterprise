const ExcelJS = require('exceljs');
const clean = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return String(v.text !== undefined ? v.text : (v.result !== undefined ? v.result : '')).replace(/\s+/g, ' ').trim();
  }
  return String(v).replace(/\s+/g, ' ').trim();
};
const hdr = (ws) => { const ix = {}; ws.getRow(1).eachCell({ includeEmpty: true }, (c, n) => { const t = clean(c.value); if (t) ix[t] = n; }); return ix; };
(async () => {
  const edu = new ExcelJS.Workbook();
  await edu.xlsx.readFile('C:/Users/user/Downloads/Education Interview Sheet-2022-2026.xlsx');
  const di = edu.getWorksheet('Daily Interviews ');
  const ix = hdr(di);
  let rows = 0; let noPhone = 0; let noName = 0; let noCollege = 0; let noBoth = 0;
  const phones = new Set();
  for (let r = 2; r <= di.rowCount; r += 1) {
    const name = clean(di.getRow(r).getCell(ix['Candidate Name']).value);
    const ph = clean(di.getRow(r).getCell(ix['Contact Number']).value);
    const cg = clean(di.getRow(r).getCell(ix['College Name']).value);
    if (!name && !ph && !cg) continue;
    rows += 1;
    if (!ph) noPhone += 1; else phones.add(ph.replace(/\D/g, '').slice(-10));
    if (!name) noName += 1;
    if (!cg) noCollege += 1;
    if (!name && !ph) noBoth += 1;
  }
  console.log('=== Daily Interviews ===');
  console.log(`  real rows ${rows} | no phone ${noPhone} | no name ${noName} | no college ${noCollege} | neither name nor phone ${noBoth}`);
  console.log(`  distinct 10-digit phones: ${phones.size}`);

  // normalisation impact
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const raw = new Set(); const normed = new Set();
  for (let r = 2; r <= di.rowCount; r += 1) {
    const v = clean(di.getRow(r).getCell(ix.Specialization).value);
    if (v) { raw.add(v); normed.add(norm(v)); }
  }
  console.log(`  specialisations: ${raw.size} raw -> ${normed.size} after case/punct normalisation`);
  const rawR = new Set(); const normR = new Set();
  [ix['Recruiter Name'], ix['TL Name']].forEach((c) => {
    for (let r = 2; r <= di.rowCount; r += 1) {
      const v = clean(di.getRow(r).getCell(c).value);
      if (v) { rawR.add(v); normR.add(norm(v)); }
    }
  });
  console.log(`  recruiter+TL names: ${rawR.size} raw -> ${normR.size} after normalisation`);
  const rawC = new Set(); const normC = new Set();
  for (let r = 2; r <= di.rowCount; r += 1) {
    const v = clean(di.getRow(r).getCell(ix['College Name']).value);
    if (v) { rawC.add(v); normC.add(norm(v)); }
  }
  console.log(`  colleges: ${rawC.size} raw -> ${normC.size} after normalisation`);

  const ps = edu.getWorksheet('Profile Screening ');
  const pix = hdr(ps);
  console.log('\n=== Profile Screening ===');
  const st = new Map();
  for (let r = 2; r <= ps.rowCount; r += 1) {
    const v = clean(ps.getRow(r).getCell(pix['Interview Status']).value);
    if (v) st.set(v, (st.get(v) || 0) + 1);
  }
  [...st.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, n]) => console.log(`   ${String(n).padStart(4)} x ${k.slice(0, 50)}`));
  console.log('   headers present:', Object.keys(pix).length);
})();
