/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// JOININGS IMPORT 2026-10-17 - STEP 1: READ THE THREE WORKBOOKS.
//
// Reads every non-empty row of every sheet (hidden rows and unheaded columns included) into one flat list,
// turns each row into the same set of named fields, and writes down what looked odd (phones, dates, salary,
// shifted columns ...) so nothing is silently lost or silently "fixed".
//
//   rows[]  { id, file, sheet, sheetCode, row, hidden, cells{COL:{v,t,w,z}}, f{...}, anomalies[] , extras{COL:text} }
//
// The workbooks are only READ. Nothing here touches the database.
// ---------------------------------------------------------------------------
const path = require('path');
const XLSX = require('xlsx');

const DOWNLOADS = process.env.TL_JOININGS_DIR || 'C:/Users/user/Downloads';
const FILES = {
  med: { file: '_Medical Team Joinings Sheet .xlsx', label: 'Medical Team Joinings Sheet', dept: 'Medical' },
  edu: { file: 'Education-Team Joinings-2022-2025.xlsx', label: 'Education-Team Joinings 2022-2025', dept: 'Education' },
  mfg: { file: 'Manufacturing-Joing sheet (1).xlsx', label: 'Manufacturing Joining sheet', dept: 'Manufacturing' },
};

// kind: J = a list of people who joined (tracking continue / drop) ; P = a pipeline sheet (interview status) ;
//       D = documents-submission-pending ; M = medical joinings ; F = manufacturing joinings
const SHEETS = [
  { code: 'MED', file: 'med', sheet: 'Sheet1', label: 'Medical Team Joinings', kind: 'M', dept: 'Medical',
    cols: { name: 'A', phone: 'B', qual: 'C', spec: 'D', desig: 'E', invoice: 'F', exp: 'G', iv: 'H', status: 'I', join: 'J', ctc: 'K', client: 'L', payment: 'M', recruiter: 'N', seat: 'O' } },
  { code: 'EDU-DOCS', file: 'edu', sheet: 'Documents-Submission-Pending Jo', label: 'Edu - Documents submission pending', kind: 'D', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', invoice: 'F', client: 'G', iv: 'H', join: 'I', ctc: 'J', recruiter: 'K', tl: 'L', remark: 'M', status: 'N' } },
  { code: 'EDU-MISS', file: 'edu', sheet: 'Missing Joinings ', label: 'Edu - Missing Joinings', kind: 'P', dept: 'Education',
    cols: { sched: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', exp: 'F', curCtc: 'G', expCtc: 'H', certs: 'I', notice: 'J', loc: 'K', client: 'L', mode: 'M', ctc: 'N', join: 'O', iv: 'P', status: 'Q', recruiter: 'R', tl: 'S', follow: 'T', remark: 'U' } },
  { code: 'EDU-J22', file: 'edu', sheet: 'June-Dec-22', label: 'Edu - June-Dec 2022 joinings', kind: 'J', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', client: 'F', join: 'G', ctc: 'H', recruiter: 'I', remark: 'J' } },
  { code: 'EDU-REPORT', file: 'edu', sheet: 'Reporting Profiles', label: 'Edu - Reporting Profiles', kind: 'P', dept: 'Education',
    cols: { sched: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', exp: 'F', curCtc: 'G', expCtc: 'H', certs: 'I', notice: 'J', loc: 'K', client: 'L', mode: 'M', ctc: 'N', join: 'O', iv: 'P', status: 'Q', recruiter: 'R', tl: 'S', follow: 'T', remark: 'U' } },
  { code: 'EDU-2023', file: 'edu', sheet: '2023-Joinings ', label: 'Edu - 2023 joinings', kind: 'J', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', invoice: 'F', client: 'G', iv: 'H', join: 'I', ctc: 'J', recruiter: 'K', tl: 'L', remark: 'M', resp: 'N', status: 'O', feedback: 'P' } },
  { code: 'EDU-2024', file: 'edu', sheet: '2024- Joinings ', label: 'Edu - 2024 joinings', kind: 'J', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', invoice: 'F', client: 'G', iv: 'H', join: 'I', ctc: 'J', recruiter: 'K', tl: 'L', remark: 'M', resp: 'N', status: 'O', feedback: 'P' } },
  { code: 'EDU-2025', file: 'edu', sheet: '2025- Joinings ', label: 'Edu - 2025 joinings', kind: 'J', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', invoice: 'F', client: 'G', iv: 'H', join: 'I', ctc: 'J', recruiter: 'K', tl: 'L', remark: 'M', resp: 'N', status: 'O', feedback: 'P' } },
  { code: 'EDU-BIO24', file: 'edu', sheet: 'Bio-Metric Joinings -24', label: 'Edu - Bio-Metric joinings 2024', kind: 'J', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', invoice: 'F', client: 'G', iv: 'H', join: 'I', ctc: 'J', recruiter: 'K', tl: 'L', remark: 'M' } },
  { code: 'EDU-2026', file: 'edu', sheet: '2026- Joinings', label: 'Edu - 2026 joinings', kind: 'J', dept: 'Education',
    cols: { sno: 'A', name: 'B', phone: 'C', qual: 'D', spec: 'E', invoice: 'F', client: 'G', iv: 'H', join: 'I', ctc: 'J', recruiter: 'K', tl: 'L', remark: 'M', resp: 'N', seat: 'O', feedback: 'P' } },
  { code: 'MFG', file: 'mfg', sheet: 'Sheet1', label: 'Manufacturing joinings', kind: 'F', dept: 'Manufacturing',
    cols: { sno: 'A', dept: 'B', name: 'C', phone: 'D', qual: 'E', spec: 'F', desig: 'G', invoice: 'H', client: 'I', iv: 'J', join: 'K', ctc: 'L', recruiter: 'M', role: 'N', tl: 'O', remark: 'P', resp: 'Q', status: 'R', feedback: 'S' } },
];
// Header text per column of each sheet (read from row 1), used to label every cell in the inventory.

// ---------------------------------------------------------------------------- text helpers
const t = (v) => String(v == null ? '' : v).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
const oneLine = (v) => t(v).replace(/\s+/g, ' ');
const lc = (v) => oneLine(v).toLowerCase();
const letters = (v) => lc(v).replace(/[^a-z]/g, '');
const nkey = (v) => lc(v).replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------- dates
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const serialIso = (n) => (typeof n === 'number' && n > 20000 && n < 70000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10) : null);
const isDateFmt = (z) => !!z && /[dmy]/i.test(String(z).replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')) && !/^(general|0|#|@)/i.test(z);

function mk(y, mo, d) {
  let year = Number(y);
  if (year < 100) year += 2000;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { iso: null, why: 'impossible day/month' };
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  const chk = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(chk.getTime()) || chk.toISOString().slice(0, 10) !== iso) return { iso: null, why: 'impossible day/month' };
  if (year < 2015 || year > 2030) return { iso: null, why: `year ${year}`, y: year, m: month, d: day };
  return { iso };
}

// Every date written inside a cell: [{ raw, iso|null, why? }] in the order they appear. "June 2025" (no day) gives { month:'2025-06' }.
function datesIn(v) {
  if (v == null || v === '') return [];
  if (typeof v === 'number') { const s = serialIso(v); return s ? [{ raw: String(v), iso: s }] : []; }
  const s = lc(v).replace(/\bo(\d)/g, '0$1').replace(/auguest|augest/g, 'august').replace(/juen/g, 'june').replace(/sept\b/g, 'sep');
  const out = [];
  const re = /(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([a-z]{3,})[\s\-/.,]*(\d{4}|\d{2})(?!\d)|(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4}|\d{2})(?!\d)|(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  const taken = [];
  while ((m = re.exec(s))) {
    let r = null;
    if (m[1] && MONTHS[m[2].slice(0, 3)]) r = mk(m[3], MONTHS[m[2].slice(0, 3)], m[1]);
    else if (m[4]) r = mk(m[6], m[5], m[4]);
    else if (m[7]) r = mk(m[7], m[8], m[9]);
    if (r) { out.push({ raw: m[0].trim(), ...r }); taken.push([m.index, m.index + m[0].length]); }
  }
  if (!out.length) {
    const mm = s.match(/(?:^|[^a-z])([a-z]{3,})[\s\-/.,]*(\d{4})(?!\d)/);
    if (mm && MONTHS[mm[1].slice(0, 3)]) out.push({ raw: mm[0].trim(), iso: null, month: `${mm[2]}-${pad(MONTHS[mm[1].slice(0, 3)])}`, why: 'month only (no day)' });
  }
  return out;
}

// ---------------------------------------------------------------------------- phones
// One cell may hold two numbers ("6235574050\n9656938352", "9703844851 / 6309499878") or one number written with spaces ("99637 57027").
function phonesIn(v) {
  const s = t(v);
  if (!s) return { list: [], invalid: [], raw: '' };
  const list = [];
  const invalid = [];
  const add = (d) => { if (!list.includes(d)) list.push(d); };
  const parts = s.split(/[\n/,;|]+|\s{3,}/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    let d = p.replace(/\D/g, '');
    if (!d) continue;
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) add(d);
    else if (d.length === 20) { add(d.slice(0, 10)); add(d.slice(10)); }
    else if (d.length > 10 && d.length <= 13) add(d.slice(-10));
    else invalid.push(p);
  }
  if (!list.length && parts.length > 1) {
    // the split may have cut a single number apart ("94417 23402" never splits, but "6301 697 293" does not either): try the whole cell once
    const whole = s.replace(/\D/g, '');
    if (whole.length === 10) { invalid.length = 0; add(whole); }
  }
  return { list, invalid, raw: s };
}

// ---------------------------------------------------------------------------- money (monthly rupees)
// Returns { raw, monthly, quality }.  quality: exact | with-note | range | text | none
//   35K -> 35000, 44,210 -> 44210, 1lpm -> 100000 (lakh PER MONTH), 1.20L -> 120000, 95k per month -> 95000,
//   30000+free hostel -> 30000 (with-note), 22K-25K -> range (no number: it would be a guess), "Demo/Cum Joining" -> text.
function moneyIn(v) {
  const raw = t(v);
  if (!raw) return { raw: '', monthly: null, quality: 'none' };
  const s = lc(raw).replace(/,/g, '').replace(/₹|rs\.?|inr/g, '').replace(/\/-/g, '').replace(/\s+/g, ' ').trim();
  const n = '(\\d+(?:\\.\\d+)?)';
  const unit = (num, u) => {
    const x = Number(num);
    if (/^(k)$/.test(u)) return x * 1000;
    if (/^(l|lac|lakh|lakhs|lpm)$/.test(u)) return x * 100000;
    if (/^lpa$/.test(u)) return (x * 100000) / 12;
    return x;
  };
  let m = s.match(new RegExp(`^${n}\\s*(k|lpm|lpa|lakhs?|lacs?|l)?\\s*(?:per month|pm|gross|monthly|per month gross)?$`));
  if (m) {
    const val = m[2] ? unit(m[1], m[2]) : Number(m[1]);
    if (!m[2] && val < 1000) return { raw, monthly: null, quality: 'text' };
    return { raw, monthly: Math.round(val), quality: 'exact' };
  }
  if (new RegExp(`^${n}\\s*(?:k|lpm|lpa|lakhs?|l)?\\s*(?:-|to)\\s*${n}\\s*(?:k|lpm|lpa|lakhs?|l)?$`).test(s)) return { raw, monthly: null, quality: 'range' };
  m = s.match(new RegExp(`^${n}\\s*(k|lpm|lpa|lakhs?|l)?\\s*(?:\\+|\\(|&|and|with|gross|free|per)`));
  if (m) {
    const val = m[2] ? unit(m[1], m[2]) : Number(m[1]);
    if (val >= 1000) return { raw, monthly: Math.round(val), quality: 'with-note' };
  }
  m = s.match(new RegExp(`^${n}\\s*(k|lpm|lpa|lakhs?|l)\\b`));
  if (m && /(per month|pm|gross|lpm)/.test(s) && !/(-|to)\s*\d/.test(s)) return { raw, monthly: Math.round(unit(m[1], m[2])), quality: 'with-note' };
  return { raw, monthly: null, quality: 'text' };
}

// years of experience from free text ("1.6 Years", "14 Years - ICU", "8-Moths", "1 Year 11 Months", "Fresher") - null when it cannot be said
function yearsIn(v) {
  const s = lc(v);
  if (!s) return null;
  if (/^fresh/.test(s)) return 0;
  const y = s.match(/(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?|yr|yeras|yera|y)\b/);
  const mo = s.match(/(\d+(?:\.\d+)?)\s*(?:months?|moths?|mon|mths?|m)\b/);
  if (y && mo) return Math.round((Number(y[1]) + Number(mo[1]) / 12) * 10) / 10;
  if (y) return Number(y[1]);
  if (mo) return Math.round((Number(mo[1]) / 12) * 10) / 10;
  const only = s.match(/^(\d+(?:\.\d+)?)$/);
  return only ? Number(only[1]) : null;
}

const tidyName = (s) => {
  const v = t(s).replace(/\s+/g, ' ').replace(/^[\s,.;:`'"-]+|[\s,.;:`'"-]+$/g, '').trim();
  if (!v) return '';
  const hasLower = /[a-z]/.test(v);
  if (hasLower) return v;
  return v.toLowerCase().replace(/(^|[\s.&/-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
};

// ---------------------------------------------------------------------------- reading
function readWorkbooks(dir = DOWNLOADS) {
  const out = [];
  const inventory = []; // one entry per non-empty cell: for the audit
  const headers = {};
  const loaded = {};
  for (const key of Object.keys(FILES)) loaded[key] = XLSX.readFile(path.join(dir, FILES[key].file), { cellStyles: true, cellNF: true, sheetStubs: false });

  for (const sh of SHEETS) {
    const wb = loaded[sh.file];
    const ws = wb.Sheets[sh.sheet];
    if (!ws) throw new Error(`${FILES[sh.file].file}: sheet "${sh.sheet}" not found`);
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rowsMeta = ws['!rows'] || [];
    const colLetters = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) colLetters.push(XLSX.utils.encode_col(c));
    // header text, by column letter
    const hdr = {};
    colLetters.forEach((L) => { const cell = ws[`${L}1`]; if (cell && cell.v != null && t(cell.v)) hdr[L] = oneLine(cell.v); });
    headers[sh.code] = hdr;
    const mapped = new Set(Object.values(sh.cols));
    for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
      const cells = {};
      let any = false;
      for (const L of colLetters) {
        const cell = ws[`${L}${r + 1}`];
        if (!cell || cell.v === undefined || cell.v === null || t(cell.v) === '') continue;
        cells[L] = { v: cell.v, t: cell.t, w: cell.w, z: cell.z };
        any = true;
      }
      if (!any) continue;
      const row = { id: `${sh.code}:${r + 1}`, file: FILES[sh.file].file, fileKey: sh.file, sheet: sh.sheet, sheetCode: sh.code, sheetLabel: sh.label, kind: sh.kind, row: r + 1, hidden: !!(rowsMeta[r] && rowsMeta[r].hidden), cells, anomalies: [], extras: {} };
      Object.entries(cells).forEach(([L, c]) => {
        inventory.push({ sheetCode: sh.code, sheet: sh.sheet, row: r + 1, hidden: row.hidden, col: L, header: hdr[L] || '', value: c.t === 'n' && isDateFmt(c.z) ? `${c.w} (serial ${c.v})` : String(c.v) });
        if (!mapped.has(L)) row.extras[L] = t(c.v);
      });
      out.push(row);
    }
  }
  return { rows: out, inventory, headers };
}

// the text of a mapped cell (dates in a date-formatted cell come back as the cell's own shown text)
function cellStr(row, col) {
  const c = row.cells[col];
  if (!c) return '';
  if (c.t === 'n' && isDateFmt(c.z)) return t(c.w || serialIso(c.v) || c.v);
  return t(c.v);
}
// A number format that shows the MONTH BEFORE THE DAY in digits (m-d-yyyy, mm-dd-yy ...). The staff type dd-mm-yyyy; Excel on a US-set computer
// reads a day up to 12 as a month, so the cell holds the day and month SWAPPED (12-10-2026 typed for 12 October is stored as 10 December). A typed
// day above 12 cannot be read that way and stays text, which is why the same column holds both. Found 2026-10-17 on the Manufacturing sheet
// (Dr.Amrutha: joining 12 Oct 2026 was stored as 10 Dec 2026). The digits the cell shows are read as day-month, like the text cells of the same column.
const monthFirstFmt = (z) => { const f = String(z || '').replace(/[[^]]*]|"[^"]*"|\./g, ''); const mi = f.search(/m/i); const di = f.search(/d/i); return mi >= 0 && di >= 0 && mi < di && !/mmm/i.test(f); };
const swapDayMonth = (iso) => { const [y, m, d] = iso.split('-'); if (Number(d) > 12 || d === m) return iso; const out = `${y}-${d}-${m}`; const chk = new Date(`${out}T00:00:00Z`); return !Number.isNaN(chk.getTime()) && chk.toISOString().slice(0, 10) === out ? out : iso; };
// the primary value of a date cell: a serial in a date-formatted cell is exact, text is parsed
function dateOfCell(row, col) {
  const c = row.cells[col];
  if (!c) return { raw: '', dates: [] };
  if (c.t === 'n' && (isDateFmt(c.z) || (c.v > 40000 && c.v < 60000))) {
    const iso = serialIso(c.v);
    // a cell formatted "mmmm yyyy" only shows a month: the day inside is a placeholder, not information
    const fmt = String(c.z || '').replace(/\[[^\]]*\]|"[^"]*"/g, '');
    if (iso && fmt && /m/i.test(fmt) && !/d/i.test(fmt)) return { raw: t(c.w || iso), dates: [{ raw: t(c.w), iso: null, month: iso.slice(0, 7), why: 'month only (no day)' }] };
    // a date cell whose serial is outside the usual range (a typed year like 2202): read the text the cell shows
    if (!iso && c.w) return { raw: t(c.w), dates: datesIn(c.w) };
    if (iso && c.t === 'n' && monthFirstFmt(c.z)) { const sw = swapDayMonth(iso); return { raw: t(c.w || iso), dates: [{ raw: t(c.w), iso: sw, monthFirstSwapped: sw !== iso ? iso : null }] }; }
    return { raw: t(c.w || iso), dates: iso ? [{ raw: t(c.w), iso }] : [] };
  }
  return { raw: t(c.v), dates: datesIn(c.v) };
}

// Year typos found by the date audit of 2026-10-17 (each one is a row where the typed year contradicts the sheet it is on and the interview date).
const DATE_OVERRIDES = {
  'EDU-2023:19': { join: ['2022-01-02', '2023-01-02'], why: 'the row is on the 2023 joinings sheet, between joinings of Jan 2023, and its interview date is 18 Nov 2022 (a joining in Jan 2022 would be before the interview)' },
  'EDU-2026:30': { join: ['2025-03-13', '2026-03-13'], why: 'the row is on the 2026 joinings sheet, between joinings of Mar 2026, and its interview date is the same day, 13 Mar 2026' },
};
const SEAT_RE = [
  [/^\s*edu\W*(\d{1,2})\b/i, (m) => `EDU-${Number(m[1])}`],
  [/^\s*med\W*(\d{1,2})\b/i, (m) => `MED-${Number(m[1])}`],
  [/^\s*non\W*it\W*(\d{1,2})\b/i, (m) => `MFG-${Number(m[1])}`],
];
function seatCode(v) {
  const s = oneLine(v);
  for (const [re, fn] of SEAT_RE) { const m = re.exec(s); if (m) return fn(m); }
  return null;
}

// ---------------------------------------------------------------------------- one row -> named fields
function normaliseRow(row, sh) {
  const g = (k) => (sh.cols[k] ? cellStr(row, sh.cols[k]) : '');
  const A = row.anomalies;
  const f = {
    nameRaw: g('name'), name: tidyName(g('name')),
    qual: oneLine(g('qual')), spec: oneLine(g('spec')), desig: oneLine(g('desig')),
    invoiceRaw: oneLine(g('invoice')), expRaw: oneLine(g('exp')), clientRaw: oneLine(g('client')), deptRaw: oneLine(g('dept')),
    recruiterRaw: oneLine(g('recruiter')), tlRaw: oneLine(g('tl')), seatRaw: oneLine(g('seat')), roleRaw: oneLine(g('role')),
    statusRaw: oneLine(g('status')), remarkRaw: t(g('remark')), respRaw: t(g('resp')), feedbackRaw: t(g('feedback')), followRaw: t(g('follow')),
    paymentRaw: oneLine(g('payment')), curCtc: oneLine(g('curCtc')), expCtc: oneLine(g('expCtc')), certs: oneLine(g('certs')), notice: oneLine(g('notice')),
    loc: oneLine(g('loc')), mode: oneLine(g('mode')), sno: oneLine(g('sno')),
  };
  if (f.name !== f.nameRaw && oneLine(f.nameRaw) !== f.name) A.push({ code: 'NAME_TIDIED', text: `name "${t(f.nameRaw)}" stored as "${f.name}"` });
  const ph = phonesIn(sh.cols.phone ? row.cells[sh.cols.phone] && row.cells[sh.cols.phone].v : '');
  f.phones = ph.list; f.phoneRaw = ph.raw;
  if (ph.list.length > 1) A.push({ code: 'PHONE_TWO', text: `two numbers in one cell: ${ph.list.join(' / ')}` });
  if (ph.invalid.length) A.push({ code: 'PHONE_INVALID', text: `phone part not a 10-digit number: "${ph.invalid.join(' | ')}"` });
  if (!ph.list.length && !ph.raw) A.push({ code: 'PHONE_NONE', text: 'no phone number in the sheet' });
  if (!ph.list.length && ph.raw) A.push({ code: 'PHONE_UNUSABLE', text: `phone cell "${ph.raw}" has no 10-digit number` });
  // dates
  const iv = dateOfCell(row, sh.cols.iv); f.ivRaw = iv.raw; f.ivDates = iv.dates;
  const jn = dateOfCell(row, sh.cols.join); f.joinRaw = jn.raw; f.joinDates = jn.dates;
  const sc = sh.cols.sched ? dateOfCell(row, sh.cols.sched) : { raw: '', dates: [] }; f.schedRaw = sc.raw; f.schedDates = sc.dates;
  const pick = (d) => (d.dates.find((x) => x.iso) || null);
  f.ivIso = pick(iv) ? pick(iv).iso : null; f.joinIso = pick(jn) ? pick(jn).iso : null; f.schedIso = pick(sc) ? pick(sc).iso : null;
  [['interview date', iv], ['joining date', jn]].forEach(([label, d]) => { const p = pick(d); if (p && p.monthFirstSwapped) A.push({ code: 'DATE_DAY_MONTH_SWAPPED', text: `${label} cell shows "${p.raw}" in a month-first number format; read as day-month = ${p.iso} (Excel had stored ${p.monthFirstSwapped})` }); });
  const ovr = DATE_OVERRIDES[`${row.sheetCode}:${row.row}`];
  if (ovr) {
    if (ovr.join && f.joinIso === ovr.join[0]) { A.push({ code: 'DATE_YEAR_TYPO', text: `joining date ${f.joinIso} corrected to ${ovr.join[1]}: ${ovr.why}` }); f.joinIso = ovr.join[1]; }
  }
  [['interview date', iv], ['joining date', jn], ['schedule date', sc]].forEach(([label, d]) => {
    if (d.raw && !d.dates.length) A.push({ code: 'DATE_UNREAD', text: `${label} "${d.raw}" could not be read as a date` });
    d.dates.forEach((x) => { if (!x.iso && x.month) A.push({ code: 'DATE_MONTH_ONLY', text: `${label} "${x.raw}" has a month but no day` }); else if (!x.iso) A.push({ code: 'DATE_BAD', text: `${label} "${x.raw}" is not a usable date (${x.why})` }); });
    if (d.dates.filter((x) => x.iso).length > 1) A.push({ code: 'DATE_MULTI', text: `${label} has more than one date: "${d.raw.replace(/\n/g, ' / ')}" (first one used)` });
  });
  // salary
  f.sal = moneyIn(sh.cols.ctc ? row.cells[sh.cols.ctc] && (row.cells[sh.cols.ctc].t === 'n' ? row.cells[sh.cols.ctc].v : row.cells[sh.cols.ctc].v) : '');
  if (f.sal.quality === 'range') A.push({ code: 'SALARY_RANGE', text: `salary "${f.sal.raw}" is a range - kept as text only` });
  if (f.sal.quality === 'text') A.push({ code: 'SALARY_TEXT', text: `salary "${f.sal.raw}" is not a clear number - kept as text only` });
  if (f.sal.quality === 'with-note') A.push({ code: 'SALARY_NOTE', text: `salary "${f.sal.raw}" - number ${f.sal.monthly} taken, full text kept` });
  f.seat = seatCode(f.seatRaw) || seatCode(f.roleRaw);
  f.years = yearsIn(f.expRaw);
  // A year typed as 2202 / 2203 / 2204 (digits swapped for 2022 / 2023 / 2024) is repaired ONLY when the repaired day falls
  // 0-150 days before the joining day; the repair is written down. Anything else stays unread.
  f.ivRepaired = null;
  if (!f.ivIso && iv.dates.length) {
    const bad = iv.dates.find((x) => !x.iso && x.y && /^22(0[2-5])$/.test(String(x.y)));
    if (bad && f.joinIso) {
      const y2 = Number(`${String(bad.y)[0]}${String(bad.y)[2]}${String(bad.y)[1]}${String(bad.y)[3]}`);
      const r = mk(y2, bad.m, bad.d);
      if (r.iso) {
        const gap = Math.round((Date.parse(`${f.joinIso}T00:00:00Z`) - Date.parse(`${r.iso}T00:00:00Z`)) / 86400000);
        if (gap >= 0 && gap <= 150) {
          f.ivIso = r.iso; f.ivRepaired = `interview date "${bad.raw}" read as ${r.iso} (year typo ${bad.y} -> ${y2}; ${gap} days before the joining day)`;
          A.push({ code: 'DATE_REPAIRED', text: f.ivRepaired });
        }
      }
    }
  }
  // order of dates
  if (f.ivIso && f.joinIso && f.ivIso > f.joinIso) A.push({ code: 'DATE_ORDER', text: `interview date ${f.ivIso} is AFTER the joining date ${f.joinIso}` });
  if (row.hidden) A.push({ code: 'ROW_HIDDEN', text: 'the row is hidden in the workbook (still imported)' });
  const extra = Object.entries(row.extras);
  if (extra.length) A.push({ code: 'EXTRA_COLUMN', text: `text in column(s) with no heading: ${extra.map(([L, v]) => `${L}="${v.replace(/\s+/g, ' ').slice(0, 60)}"`).join('; ')}` });
  return f;
}

function parseAll(dir) {
  const { rows, inventory, headers } = readWorkbooks(dir);
  const byCode = Object.fromEntries(SHEETS.map((s) => [s.code, s]));
  rows.forEach((r) => { r.sheetCfg = byCode[r.sheetCode]; r.f = normaliseRow(r, byCode[r.sheetCode]); });
  return { rows, inventory, headers, SHEETS, FILES };
}

module.exports = {
  parseAll, SHEETS, FILES, t, oneLine, lc, letters, nkey, pad, datesIn, phonesIn, moneyIn, yearsIn, tidyName, serialIso, seatCode, MONTHS,
};
