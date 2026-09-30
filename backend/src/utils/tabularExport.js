// ---------------------------------------------------------------------------
// Export writers — CSV, Excel (.xlsx) and PDF, from one rows-and-headers shape.
//
// Excel files are written with SheetJS (already a dependency), which Excel
// opens cleanly. The PDF is a plain text container written here by hand.
//
// These functions are FORMAT ONLY. They know nothing about employees,
// permissions or scope: the caller has already applied the data scope and the
// `export` permission before it gets here, so there is exactly one place that
// decides who may see which rows (routes/employees.js) and no chance of a
// second format quietly skipping it.
// ---------------------------------------------------------------------------

const XLSX = require('xlsx');

// --- CSV (RFC 4180) --------------------------------------------------------
// A field is quoted when it holds a comma, a quote or a newline, and an
// embedded quote is doubled — so a designation like 'Engineer, Senior' cannot
// shift every later column.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
}

// --- XLSX ------------------------------------------------------------------

// Strip characters XML 1.0 forbids (Excel refuses them), by code point.
function cleanText(value) {
  return String(value).split('').filter((ch) => {
    const c = ch.charCodeAt(0);
    return c === 9 || c === 10 || c === 13 || c >= 32;
  }).join('');
}

// Numbers stay numbers so Excel can sum them; long digit strings (phones,
// account numbers, Aadhaar last-4 with leading zeros) stay text.
function cellValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = cleanText(value);
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length < 10) return Number(s);
  return s.length > 32000 ? s.slice(0, 32000) : s;
}

// A workbook of one or more sheets: [{ name, headers, rows }]. Sheet names
// are cleaned of the characters Excel forbids, cut to 31, and made unique.
function toXlsxBook(sheets) {
  const used = new Set();
  const named = (sheets && sheets.length ? sheets : [{ name: 'Sheet1', headers: [], rows: [] }]).map((sh, i) => {
    const base = String(sh.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 27)} (${n})`;
    used.add(name.toLowerCase());
    return { ...sh, name };
  });
  // Written with SheetJS: the hand-rolled XML above produced parts Excel
  // rejected (it opened as "[Repaired]" with an empty sheet).
  const wb = XLSX.utils.book_new();
  named.forEach((sh) => {
    const headers = sh.headers || [];
    const aoa = [headers.map((h) => cleanText(h)), ...(sh.rows || []).map((r) => headers.map((_, ci) => cellValue(r[ci])))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = headers.map((h, i) => {
      const longest = (sh.rows || []).reduce((m, r) => Math.max(m, String(r[i] === undefined || r[i] === null ? '' : r[i]).length), String(h).length);
      return { wch: Math.min(46, Math.max(10, longest + 2)) };
    });
    if (headers.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: headers.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, sh.name);
  });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function toXlsx(headers, rows, sheetName = 'Employees') {
  return toXlsxBook([{ name: sheetName, headers, rows }]);
}

// --- PDF -------------------------------------------------------------------
// A landscape A4 table in Helvetica. Long values are truncated to the column
// width rather than overlapping the next column, and the row count on the
// cover line says how many records the reader is holding — the same number
// the CSV and the workbook carry, because all three are built from one array.

const PAGE_W = 842; // A4 landscape, points
const PAGE_H = 595;
const MARGIN = 28;

function pdfEscape(s) {
  return String(s === null || s === undefined ? '' : s)
    // WinAnsi only — anything outside it is transliterated to '?' so the
    // reader never sees a broken glyph. By code point, not a regex literal.
    .split('').map((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? ch : '?';
    }).join('')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Helvetica at `size` is about 0.5 * size per character on average; 0.52 is
// close enough to keep columns from colliding without measuring metrics.
function fitText(text, widthPts, size) {
  const s = String(text === null || text === undefined ? '' : text);
  const max = Math.max(1, Math.floor(widthPts / (size * 0.52)));
  // Helvetica's base WinAnsi set has no ellipsis, so a plain '~' marks a
  // truncated value rather than risking a missing glyph.
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + String.fromCharCode(126) : s;
}

function toPdf(headers, rows, { title = 'Employees', subtitle = '' } = {}) {
  const size = 7.5;
  const headerSize = 8;
  const rowH = 13;
  const usable = PAGE_W - MARGIN * 2;
  // Column widths in proportion to the longest value each column holds.
  const weights = headers.map((h, i) => {
    const longest = rows.reduce((m, r) => Math.max(m, String(r[i] === undefined || r[i] === null ? '' : r[i]).length), String(h).length);
    return Math.min(28, Math.max(6, longest));
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (w / total) * usable);
  const xs = [];
  widths.reduce((acc, w) => { xs.push(acc); return acc + w; }, MARGIN);

  const perPage = Math.floor((PAGE_H - MARGIN * 2 - 46) / rowH);
  const pages = [];
  for (let i = 0; i < Math.max(1, Math.ceil(rows.length / perPage)); i += 1) {
    pages.push(rows.slice(i * perPage, (i + 1) * perPage));
  }

  const contents = pages.map((pageRows, pageIndex) => {
    const ops = [];
    let y = PAGE_H - MARGIN;
    ops.push('BT /F2 13 Tf 1 0 0 1 ' + MARGIN + ' ' + (y - 11) + ' Tm (' + pdfEscape(title) + ') Tj ET');
    y -= 26;
    if (subtitle) {
      ops.push('BT /F1 8 Tf 0.35 0.35 0.35 rg 1 0 0 1 ' + MARGIN + ' ' + (y - 7) + ' Tm (' + pdfEscape(subtitle) + ') Tj ET 0 0 0 rg');
    }
    // Clear of the subtitle's baseline — at 14 the header labels sat on top
    // of it and the first page read as a smudge.
    y -= 24;
    // Header rule + labels.
    ops.push(`0.8 0.8 0.8 RG 0.6 w ${MARGIN} ${y - 2} m ${PAGE_W - MARGIN} ${y - 2} l S`);
    headers.forEach((h, i) => {
      ops.push('BT /F2 ' + headerSize + ' Tf 1 0 0 1 ' + (xs[i] + 2).toFixed(1) + ' ' + (y + 2) + ' Tm ('
        + pdfEscape(fitText(h, widths[i] - 4, headerSize)) + ') Tj ET');
    });
    y -= rowH;
    pageRows.forEach((r) => {
      headers.forEach((_, i) => {
        ops.push('BT /F1 ' + size + ' Tf 1 0 0 1 ' + (xs[i] + 2).toFixed(1) + ' ' + y.toFixed(1) + ' Tm ('
          + pdfEscape(fitText(r[i], widths[i] - 4, size)) + ') Tj ET');
      });
      y -= rowH;
    });
    ops.push('BT /F1 7 Tf 0.45 0.45 0.45 rg 1 0 0 1 ' + MARGIN + ' ' + (MARGIN - 10) + ' Tm ('
      + pdfEscape(`Page ${pageIndex + 1} of ${pages.length}`) + ') Tj ET 0 0 0 rg');
    return ops.join('\n');
  });

  // Object table. 1 catalog, 2 pages, 3+4 fonts, then per page a Page object
  // and a stream.
  const objs = [];
  const pageObjIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  contents.forEach((stream, i) => {
    const pageId = pageObjIds[i];
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objs[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i += 1) {
    if (!objs[i]) continue;
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  const count = objs.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i += 1) {
    pdf += offsets[i]
      ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { csvCell, toCsv, toXlsx, toXlsxBook, toPdf };
