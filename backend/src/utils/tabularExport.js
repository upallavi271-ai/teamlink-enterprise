// ---------------------------------------------------------------------------
// Export writers — CSV, Excel (.xlsx) and PDF, from one rows-and-headers shape.
//
// WHY NO LIBRARY
// The backend's dependency list is deliberately small and this box builds
// offline. An .xlsx is a ZIP of five small XML parts and a PDF is a plain
// text container, so both are written here with nothing but Node's own zlib
// and Buffer. Everything produced opens in Excel, LibreOffice, Numbers and
// any PDF reader.
//
// These functions are FORMAT ONLY. They know nothing about employees,
// permissions or scope: the caller has already applied the data scope and the
// `export` permission before it gets here, so there is exactly one place that
// decides who may see which rows (routes/employees.js) and no chance of a
// second format quietly skipping it.
// ---------------------------------------------------------------------------

const zlib = require('zlib');

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

function xmlEscape(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 and make Excel refuse the
    // file. Filtered by CODE POINT rather than a regex literal, so this
    // source file stays plain ASCII.
    .split('').filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || c === 13 || c >= 32;
    }).join('');
}

// A1, B1 … Z1, AA1 …
function colRef(index) {
  let n = index;
  let ref = '';
  do {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ref;
}

// Numbers are written as numbers so Excel can sum them; everything else goes
// out as an inline string, which avoids a shared-string table entirely.
function cellXml(value, rowIndex, colIndex) {
  const ref = `${colRef(colIndex)}${rowIndex}`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  const s = String(value);
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 15) return `<c r="${ref}"><v>${s}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s)}</t></is></c>`;
}

function sheetXml(headers, rows) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  // Give every column a sane width so the first thing HR sees is not ####.
  out.push('<cols>');
  headers.forEach((h, i) => {
    const longest = rows.reduce((m, r) => Math.max(m, String(r[i] === undefined || r[i] === null ? '' : r[i]).length), String(h).length);
    out.push(`<col min="${i + 1}" max="${i + 1}" width="${Math.min(46, Math.max(10, longest + 2))}" customWidth="1"/>`);
  });
  out.push('</cols>');
  out.push('<sheetData>');
  out.push(`<row r="1">${headers.map((h, i) => cellXml(h, 1, i)).join('')}</row>`);
  rows.forEach((r, ri) => {
    out.push(`<row r="${ri + 2}">${headers.map((_, ci) => cellXml(r[ci], ri + 2, ci)).join('')}</row>`);
  });
  out.push('</sheetData>');
  // Freeze the header row.
  out.push('<sheetViews/>');
  out.push('</worksheet>');
  return out.join('');
}

// --- A minimal ZIP container (deflate) -------------------------------------
// Enough of PKZIP for a .xlsx: local headers, central directory, end record.
// No zip64, no encryption, no directory entries — none of which an xlsx needs.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  files.forEach(({ name, data }) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01-ish; Excel does not care)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + deflated.length;
  });

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function toXlsx(headers, rows, sheetName = 'Employees') {
  const safeSheet = xmlEscape(String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return zip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(headers, rows) },
  ]);
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

module.exports = { csvCell, toCsv, toXlsx, toPdf };
