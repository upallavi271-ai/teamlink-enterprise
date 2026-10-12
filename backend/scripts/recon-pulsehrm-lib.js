// ---------------------------------------------------------------------------
// recon-pulsehrm-lib.js - shared READ-ONLY helpers for the PulseHRM <-> TeamLink
// reconciliation (scripts recon-pulsehrm-analyze.js / recon-pulsehrm-apply.js).
//
// The four PulseHRM exports are UNTRUSTED DATA: they are only ever parsed here
// (CSV text / raw XML of the xlsx) - nothing in them is executed, no macros.
//
// The Leave History .xlsx written by PulseHRM has no <dimension> element and its
// dates are t="d" ISO cells, which the `xlsx` / `exceljs` readers mangle (the sheet
// reads as 0 rows, or every date as 18-Jul-1905), so it is read from the raw XML.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

// Quote-aware CSV (comments may hold commas / newlines).
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((x) => String(x).trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] === undefined ? '' : r[i])])));
}

function isoDate(s) {
  const v = String(s || '').trim().toUpperCase();
  let m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/.exec(v);
  if (m && MON[m[2]]) return `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
// "9:05:07" -> "09:05:07"
function clock(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] === undefined ? '00' : m[3]}` : null;
}
function secs(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
}
function hms(n) {
  if (n == null || Number.isNaN(n)) return '';
  const neg = n < 0; n = Math.abs(Math.round(n));
  const p = (x) => String(x).padStart(2, '0');
  return `${neg ? '-' : ''}${p(Math.floor(n / 3600))}:${p(Math.floor((n % 3600) / 60))}:${p(n % 60)}`;
}
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---- names --------------------------------------------------------------
// normName: case, punctuation, double / trailing spaces.   'A.Dhathri' -> 'a dhathri'
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-zऀ-෿\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const squash = (s) => normName(s).replace(/\s/g, '');
function tokens(s) { return normName(s).split(' ').filter(Boolean); }
// 'Exact' | 'Same after cleanup' | 'Compatible' (order / initials / repeated word / run-together) | 'Different'
function compareNames(a, b) {
  const na = normName(a); const nb = normName(b);
  if (!na || !nb) return 'Different';
  if (String(a) === String(b)) return 'Exact';
  if (na === nb) return 'Same after cleanup';
  if (squash(a) === squash(b)) return 'Same after cleanup';
  const ta = [...new Set(tokens(a))]; const tb = [...new Set(tokens(b))];
  if ([...ta].sort().join(' ') === [...tb].sort().join(' ')) return 'Compatible';
  if (ta.join('') === tb.join('')) return 'Compatible';
  // every token of the shorter list is matched (full word, a prefix, or an initial) in the longer one
  const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const pool = [...l];
  let ok = s.length > 0;
  for (const t of s) {
    const i = pool.findIndex((x) => x === t || (t.length === 1 && x[0] === t) || (x.length === 1 && t[0] === x) || (t.length >= 4 && x.length >= 4 && (x.startsWith(t) || t.startsWith(x))));
    if (i < 0) { ok = false; break; }
    pool.splice(i, 1);
  }
  if (ok && s.length >= 2) return 'Compatible';
  if (ok && s.length === 1 && l.length === 1) return 'Compatible';
  return 'Different';
}

// ---- the three CSVs --------------------------------------------------------
function readF1(file) { // first check-in / last check-out report
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r, i) => ({
    row: i + 2, code: cleanName(r['Employee Ref No'] || r['Employee No']), no: cleanName(r['Employee No']), name: cleanName(r['Employee Name']),
    rawName: r['Employee Name'], dept: cleanName(r.Department), desig: cleanName(r.Designation), date: isoDate(r.Date),
    firstIn: clock(r['First Check In']), lastOut: clock(r['Last Check Out']), loc: cleanName(r['Work Location']),
    worked: clock(r['Total Time Worked']), brk: clock(r['Total Time In Break']), total: clock(r['Total Hours']),
  }));
}
function readF4(file) { // bio-metric logs
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r, i) => {
    const raw = String(r.Employee || '');
    const m = /^\s*([A-Za-z0-9]+)\s*-\s*([\s\S]*)$/.exec(raw);
    const times = String(r['Time Interval'] || '').split('|').map(clock).filter(Boolean);
    return {
      row: i + 2, code: m ? m[1].trim() : cleanName(raw), name: cleanName(m ? m[2] : ''), rawName: m ? m[2] : raw,
      dept: cleanName(r.Department), desig: cleanName(r.Designation), date: isoDate(r['Attendance Date']), times, rawTimes: r['Time Interval'],
    };
  });
}
function readF3(file) { // attendance summary
  const num = (v) => { const t = String(v === undefined ? '' : v).trim(); if (t === '') return null; const n = Number(t); return Number.isNaN(n) ? null : n; };
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r, i) => {
    const g = (label) => { const k = Object.keys(r).find((x) => x.trim().toLowerCase() === label); return k ? r[k] : ''; };
    const code = cleanName(r['Employee Ref No']);
    const full = String(r['Employee Name'] || '');
    const nm = full.startsWith(`${code}-`) ? full.slice(code.length + 1) : full;
    return {
      row: i + 2, code, name: cleanName(nm), rawName: full, dept: cleanName(r.Department), desig: cleanName(r.Designation), loc: cleanName(r.Location),
      half: num(g('half-day')), present: num(g('present')), weekOffs: num(g('week offs')), holidays: num(g('public holidays')),
      leaves: num(g('leaves')), payable: num(g('payable days')), totalHours: clock(g('total hours')),
    };
  });
}

// ---- the leave xlsx (raw XML) ---------------------------------------------
async function readLeaveXlsx(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const un = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
  const ssFile = zip.file('xl/sharedStrings.xml');
  const ss = ssFile ? await ssFile.async('string') : '';
  const strs = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => un([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const sh = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const rows = [];
  for (const rm of sh.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rec = { _row: +rm[1] };
    for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = (cm[2].match(/t="(\w+)"/) || [])[1];
      const v = ((cm[3] || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (v !== undefined) { if (t === 's') val = strs[+v]; else if (t === 'd') val = v.slice(0, 10); else if (t === 'n') val = +v; else val = un(v); }
      rec[cm[1]] = val;
    }
    rows.push(rec);
  }
  const hdr = rows[0];
  const cols = Object.keys(hdr).filter((k) => k !== '_row');
  return rows.slice(1).map((r) => {
    const o = { row: r._row };
    cols.forEach((c) => { o[hdr[c]] = r[c] === undefined ? null : r[c]; });
    return {
      row: o.row, code: cleanName(o['Employee ID']), name: cleanName(o['Employee Name']), dept: cleanName(o.Department), loc: cleanName(o['Work Location']),
      applied: isoDate(o['Date Of Application']), type: cleanName(o['Leave Type']), from: isoDate(o['Leave From']), to: isoDate(o['Leave To']),
      halfDay: cleanName(o['Half Day']) || null, days: o.Duration == null ? null : Number(o.Duration),
      reason: o.Reason == null ? null : String(o.Reason).trim(), comments: o.Comments == null ? null : String(o.Comments).trim(),
      approver: cleanName(o.Approver) || null, approverComments: o['Approver Comments'] == null ? null : String(o['Approver Comments']).trim(),
      approvedDate: isoDate(o['Approved Date']), status: cleanName(o.Status),
    };
  });
}

// ---- dates ------------------------------------------------------------------
const shiftDay = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function eachDay(from, to) { const out = []; for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d); return out; }
const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Never let a read-only script touch the real database by accident.
function assertNotRealDb(url) {
  const u = String(url || '').replace(/\\/g, '/').toLowerCase();
  if (/prisma\/dev\.db/.test(u) || /(^|\/)dev\.db(\?|$)/.test(u)) throw new Error(`Refusing: ${url} looks like the real dev.db. Use a copy.`);
}

module.exports = {
  parseCsv, isoDate, clock, secs, hms, cleanName, normName, squash, compareNames,
  readF1, readF3, readF4, readLeaveXlsx, shiftDay, eachDay, dow, DOW, assertNotRealDb,
};
