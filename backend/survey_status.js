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
const hdr = (ws, row = 1) => {
  const ix = {};
  ws.getRow(row).eachCell({ includeEmpty: true }, (c, n) => { const t = clean(c.value); if (t) ix[t] = n; });
  return ix;
};
const distinct = (ws, col, from = 2, limit = 16) => {
  const m = new Map();
  for (let r = from; r <= ws.rowCount; r += 1) {
    const v = clean(ws.getRow(r).getCell(col).value);
    if (v) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
};
const show = (label, pairs) => {
  console.log(`  ${label}:`);
  pairs.forEach(([v, n]) => console.log(`      ${String(n).padStart(5)} x  ${v.slice(0, 66)}`));
};
(async () => {
  const edu = new ExcelJS.Workbook();
  await edu.xlsx.readFile('C:/Users/user/Downloads/Education Interview Sheet-2022-2026.xlsx');
  const di = edu.getWorksheet('Daily Interviews ');
  const ix = hdr(di);
  console.log('=== Education / Daily Interviews (12,659 rows) ===');
  show('Interview Status', distinct(di, ix['Interview Status']));
  show('Recruiter Name (top)', distinct(di, ix['Recruiter Name'], 2, 12));
  show('TL Name', distinct(di, ix['TL Name'], 2, 12));
  show('Interview Mode', distinct(di, ix['Interview Mode'], 2, 8));
  show('Qualification (top)', distinct(di, ix.Qualification, 2, 8));
  show('Specialization (top)', distinct(di, ix.Specialization, 2, 10));
  const colleges = distinct(di, ix['College Name'], 2, 6);
  show('College Name (top 6)', colleges);
  // how many distinct colleges / candidates / phones
  const setOf = (col) => { const s = new Set(); for (let r = 2; r <= di.rowCount; r += 1) { const v = clean(di.getRow(r).getCell(col).value); if (v) s.add(v.toLowerCase()); } return s.size; };
  console.log(`  distinct colleges=${setOf(ix['College Name'])} candidates=${setOf(ix['Candidate Name'])} phones=${setOf(ix['Contact Number'])}`);

  const bde = new ExcelJS.Workbook();
  await bde.xlsx.readFile('C:/Users/user/Downloads/BDE PROFILES.xlsx');
  const mf = bde.getWorksheet('Manufacturing Interested Profil');
  const mix = hdr(mf);
  console.log('\n=== BDE / Manufacturing Interested Profiles (514) ===');
  show('Status-1', distinct(mf, mix['Status-1'], 2, 8));
  show('Shortlisted', distinct(mf, mix['Shorlisted/Not shortlisted'], 2, 8));
  show('joining/ Rejected', distinct(mf, mix['joining/ Rejected'], 2, 8));
  show('Recruiter name', distinct(mf, mix['Recruiter name'], 2, 12));

  const idx = bde.getWorksheet('Index Interview Sheet');
  const iix = hdr(idx);
  console.log('\n=== BDE / Index Interview Sheet (96) ===');
  show('Rejected/Selected', distinct(idx, iix['Rejected/Selected'], 2, 8));
  show('Recrutier Name', distinct(idx, iix['Recrutier Name'], 2, 10));

  const trk = new ExcelJS.Workbook();
  await trk.xlsx.readFile('C:/Users/user/Downloads/Tracker sheet.xlsx');
  const ct = trk.getWorksheet('Client Trackers');
  const cix = hdr(ct);
  console.log('\n=== Tracker / Client Trackers ===');
  show('Status Update', distinct(ct, cix['Status Update'], 2, 8));
  show('Screening', distinct(ct, cix.Screening, 2, 8));
  const tt = trk.getWorksheet('tryakshari tracker.');
  const tix = hdr(tt);
  console.log('\n=== Tracker / tryakshari (48) ===');
  show('Status (col2)', distinct(tt, tix.Status, 2, 8));
  show('Rejected/Selected', distinct(tt, tix['Rejected/Selected'], 2, 8));
  show('Account Name', distinct(tt, tix['Account Name'], 2, 6));
})();
