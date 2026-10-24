// ---------------------------------------------------------------------------
// CSV / EXCEL FORMULA-INJECTION GUARD (security fix 2026-10-13).
//
// A cell that a user typed (a candidate name, a note, a client company) and that
// starts with = + - @ (or a tab / carriage return) would be run as a formula when
// the exported file is opened in Excel. neutralise() prefixes such text with an
// apostrophe so it is shown as text. Real numbers and phone-like values ("-12.5",
// "+919876543210") are left alone.
//
// ONE place covers every writer: installOnSheetJs() wraps XLSX.utils.aoa_to_sheet
// and json_to_sheet (every .xlsx in the app goes through them) and
// utils/tabularExport.js csvCell() calls neutralise() (every CSV).
// ---------------------------------------------------------------------------
const NUMBERISH = /^[-+]?[\d\s().,]+$/;

function neutralise(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (!/^[=+\-@\t\r]/.test(value)) return value;
  if (/^[-+]$/.test(value)) return value; // a lone dash is a blank placeholder
  if (NUMBERISH.test(value) &&/\d/.test(value) && !/^[=@]/.test(value)) return value;
  return `'${value}`;
}

let installed = false;
function installOnSheetJs() {
  if (installed) return;
  installed = true;
  const XLSX = require('xlsx'); // eslint-disable-line global-require
  const origAoa = XLSX.utils.aoa_to_sheet;
  XLSX.utils.aoa_to_sheet = function guardedAoa(data, opts) {
    const safe = Array.isArray(data) ? data.map((row) => (Array.isArray(row) ? row.map(neutralise) : row)) : data;
    return origAoa.call(this, safe, opts);
  };
  const origJson = XLSX.utils.json_to_sheet;
  XLSX.utils.json_to_sheet = function guardedJson(data, opts) {
    const safe = Array.isArray(data)
      ? data.map((o) => {
        if (!o || typeof o !== 'object') return o;
        const c = {}; Object.keys(o).forEach((k) => { c[k] = neutralise(o[k]); }); return c;
      })
      : data;
    return origJson.call(this, safe, opts);
  };
}

module.exports = { neutralise, installOnSheetJs };
