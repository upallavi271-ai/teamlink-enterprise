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
const FILES = [
  'Tracker sheet.xlsx',
  'BDE PROFILES.xlsx',
  'Education Interview Sheet-2022-2026.xlsx',
  'Edu - 1 Requirement Sheet .xlsx',
  'Edu - 2 Requirement Sheet .xlsx',
];
(async () => {
  for (const f of FILES) {
    console.log(`\n################ ${f} ################`);
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.readFile('C:/Users/user/Downloads/' + f); } catch (e) { console.log('  CANNOT READ:', e.message); continue; }
    for (const ws of wb.worksheets) {
      // find the header row: the first row with 3+ non-empty cells
      let hdrRow = 1;
      for (let r = 1; r <= Math.min(ws.rowCount, 12); r += 1) {
        let n = 0;
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => { if (clean(c.value)) n += 1; });
        if (n >= 3) { hdrRow = r; break; }
      }
      const hdrs = [];
      ws.getRow(hdrRow).eachCell({ includeEmpty: true }, (c, i) => { const t = clean(c.value); if (t) hdrs.push(`${i}:${t.slice(0, 26)}`); });
      let dataRows = 0;
      for (let r = hdrRow + 1; r <= ws.rowCount; r += 1) {
        let any = false;
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => { if (clean(c.value)) any = true; });
        if (any) dataRows += 1;
      }
      console.log(`\n--- "${ws.name}"  rows=${ws.rowCount} datarows≈${dataRows} headerRow=${hdrRow} merges=${(ws.model.merges || []).length}`);
      console.log(`    HEADERS: ${hdrs.join(' | ')}`);
      for (let r = hdrRow + 1; r <= Math.min(ws.rowCount, hdrRow + 3); r += 1) {
        const v = [];
        ws.getRow(r).eachCell({ includeEmpty: false }, (c, i) => { const t = clean(c.value); if (t) v.push(`${i}=${t.slice(0, 24)}`); });
        if (v.length) console.log(`    r${r}| ${v.join(' | ')}`);
      }
    }
  }
})();
