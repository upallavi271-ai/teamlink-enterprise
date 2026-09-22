// ---------------------------------------------------------------------------
// BUILDS THE IMPORT WORKBOOK, as a buffer.
//
// Used two ways and written once:
//   scripts/import-template.js  — writes it to a file from the command line
//   routes/dataImport.js        — serves it as a download
//
// Generated entirely from utils/importSpec.js, which the IMPORTER also
// reads. That is the point: the sheet the user fills in and the parser that
// reads it back are the same description, so a column cannot exist in one
// and not the other.
//
// DESIGN DECISIONS WORTH KNOWING
//   * HEADERS ONLY ON ROW 1. No help row and no example row inside the data
//     area — anything above the data is something the parser has to guess
//     whether to skip, and a guess there silently drops somebody's first
//     record. The help lives in a note on the header cell and in full on the
//     Field Guide sheet.
//   * Dropdowns point at RANGES on the Lists sheet, not at inline value
//     strings. Excel caps an inline list at 255 characters and the pipeline
//     stage list is longer than that, so inline would have quietly produced a
//     broken dropdown on the one column where it matters most.
//   * Required headers are a different colour, and the note says so.
// ---------------------------------------------------------------------------

const ExcelJS = require('exceljs');
const { SHEETS, LISTS } = require('./importSpec');

const BRAND = 'FF1E3A5F';      // header fill
const REQUIRED = 'FFB45309';   // required-column header fill
const LIGHT = 'FFF1F5F9';
const RULE = 'FFCBD5E1';


function headerCell(cell, text, required) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: required ? REQUIRED : BRAND } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  cell.border = {
    top: { style: 'thin', color: { argb: RULE } },
    bottom: { style: 'thin', color: { argb: RULE } },
    left: { style: 'thin', color: { argb: RULE } },
    right: { style: 'thin', color: { argb: RULE } },
  };
}

async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TeamLink.Enterprise';
  wb.created = new Date();

  // ---------------------------------------------------------------- Read Me
  const readme = wb.addWorksheet('Read Me', { properties: { tabColor: { argb: BRAND } } });
  readme.getColumn(1).width = 4;
  readme.getColumn(2).width = 110;
  let r = 1;
  const line = (text, opts = {}) => {
    const cell = readme.getCell(r, 2);
    cell.value = text;
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.font = { size: opts.size || 11, bold: !!opts.bold, color: { argb: opts.color || 'FF0F172A' } };
    if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    readme.getRow(r).height = opts.height || (text.length > 95 ? 30 : 18);
    r += 1;
  };

  line('TeamLink.Enterprise — Data Import Template', { bold: true, size: 18 });
  line('Fill in your real data on the sheets in this workbook and send it back. Everything here maps directly onto the running system, so what you type is what appears on screen.', {});
  line('');
  line('THE TWO RULES THAT MATTER', { bold: true, size: 13 });
  line('1.  FILL THE SHEETS IN ORDER, left to right. A requirement needs its client to exist, an application needs its candidate and its requirement. The tabs are already in the right order.', {});
  line('2.  THE SHEETS REFER TO EACH OTHER BY NAME, not by any internal id. A requirement names its client "Orbit Software Solutions"; an application names its candidate by email. So a name has to be spelled the SAME WAY everywhere. Copy and paste rather than retyping.', {});
  line('');
  line('FILLING IT IN', { bold: true, size: 13 });
  line('•  Row 1 is the headers — do not rename, reorder or delete them. Type your data from row 2 down.', {});
  line('•  ORANGE headers are required. Dark blue headers are optional; leave them blank if you do not have the data.', {});
  line('•  Hover a header for a short note on what goes in that column. The Field Guide sheet has the same notes in full, with an example for each.', {});
  line('•  Columns with a dropdown only accept the values in the list. Do not type your own.', {});
  line('•  DATES: YYYY-MM-DD, e.g. 2026-09-15.', {});
  line('•  Lists inside one cell (skills, for instance) are COMMA SEPARATED: Java, Spring Boot, Microservices', {});
  line('•  Numbers: digits only, no ₹ symbol, no commas. Write 150000, not ₹1,50,000.', {});
  line('•  Delete any sheet you have no data for. An empty sheet is simply skipped.', {});
  line('');
  line('WHAT HAPPENS ON IMPORT', { bold: true, size: 13 });
  line('•  Every row is CHECKED FIRST and you get a report — how many rows will be created, how many updated, and every problem with its sheet name and row number. Nothing is written until that report looks right.', {});
  line('•  Re-importing is safe. Each sheet has a key (Employee Code, Client Name, Requirement Code, candidate email, Invoice Number), and a row whose key already exists UPDATES that record instead of creating a duplicate. So you can fix a few cells and send the same file again.', {});
  line('•  The existing demo data is left alone unless you ask for it to be cleared. Say the word and it is removed in one step before your data goes in.', {});
  line('');
  line('IF YOU ONLY WANT TO START SOMEWHERE', { bold: true, size: 13 });
  line('Departments → Employees → Clients → Requirements → Candidates → Applications. Invoices and Specialisations can follow later; nothing else depends on them.', {});

  // ------------------------------------------------------------ Field Guide
  const guide = wb.addWorksheet('Field Guide', { properties: { tabColor: { argb: BRAND } } });
  const guideCols = [
    ['Sheet', 18], ['Product', 11], ['Column', 30], ['Required', 10],
    ['Type', 10], ['Allowed values', 42], ['What it means', 60], ['Example', 30],
  ];
  guideCols.forEach(([h, w], i) => {
    guide.getColumn(i + 1).width = w;
    headerCell(guide.getCell(1, i + 1), h, false);
  });
  guide.getRow(1).height = 22;
  guide.views = [{ state: 'frozen', ySplit: 1 }];
  let g = 2;
  SHEETS.forEach((sheet) => {
    sheet.columns.forEach((col) => {
      const allowed = col.t === 'list' ? (LISTS[col.list] || []).join(', ') : '';
      guide.getRow(g).values = [
        sheet.name,
        sheet.product,
        col.h,
        col.req ? 'YES' : '',
        col.t === 'list' ? 'dropdown' : col.t,
        allowed,
        col.help || '',
        col.eg || '',
      ];
      const row = guide.getRow(g);
      row.alignment = { wrapText: true, vertical: 'top' };
      if (col.req) row.getCell(4).font = { bold: true, color: { argb: REQUIRED } };
      if (g % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      g += 1;
    });
  });

  // ------------------------------------------------------------------ Lists
  // Built before the data sheets so the dropdown ranges already exist.
  const lists = wb.addWorksheet('Lists', { properties: { tabColor: { argb: 'FF94A3B8' } } });
  const listRange = {};
  Object.entries(LISTS).forEach(([name, values], i) => {
    const colIdx = i + 1;
    lists.getColumn(colIdx).width = Math.max(16, ...values.map((v) => String(v).length + 2));
    headerCell(lists.getCell(1, colIdx), name, false);
    values.forEach((v, j) => { lists.getCell(j + 2, colIdx).value = v; });
    const letter = lists.getColumn(colIdx).letter;
    listRange[name] = `Lists!$${letter}$2:$${letter}$${values.length + 1}`;
  });
  lists.getCell(1, Object.keys(LISTS).length + 2).value = 'These lists feed the dropdowns on the data sheets. Please do not edit them.';

  // ------------------------------------------------------------ data sheets
  const MAX_ROWS = 2000; // how far down the dropdowns and formats reach
  SHEETS.forEach((sheet) => {
    const ws = wb.addWorksheet(sheet.name, { properties: { tabColor: { argb: BRAND } } });
    sheet.columns.forEach((col, i) => {
      const idx = i + 1;
      const width = Math.min(46, Math.max(14, col.h.length + 4, (col.eg || '').length + 4));
      ws.getColumn(idx).width = width;

      const cell = ws.getCell(1, idx);
      headerCell(cell, col.h, col.req);
      const bits = [col.req ? 'REQUIRED' : 'Optional'];
      if (col.help) bits.push(col.help);
      if (col.t === 'date') bits.push('Format: YYYY-MM-DD');
      if (col.t === 'number') bits.push('Numbers only — no symbols, no commas.');
      if (col.t === 'list') bits.push('Pick from the dropdown.');
      if (col.eg) bits.push(`Example: ${col.eg}`);
      cell.note = bits.join('\n');

      // Dropdown / format for the data rows.
      for (let row = 2; row <= MAX_ROWS; row += 1) {
        const dc = ws.getCell(row, idx);
        if (col.t === 'list' && listRange[col.list]) {
          dc.dataValidation = {
            type: 'list', allowBlank: !col.req, formulae: [listRange[col.list]],
            showErrorMessage: true, errorStyle: 'error',
            errorTitle: 'Pick from the list',
            error: `${col.h} only accepts: ${(LISTS[col.list] || []).join(', ')}`,
          };
        } else if (col.t === 'date') {
          dc.numFmt = 'yyyy-mm-dd';
        } else if (col.t === 'number') {
          dc.numFmt = '0.##';
        }
      }
    });
    ws.getRow(1).height = 30;
    ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  });

  return wb.xlsx.writeBuffer();
}

module.exports = { buildTemplate, SHEETS, LISTS };
