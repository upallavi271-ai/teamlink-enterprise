// ---------------------------------------------------------------------------
// GSTIN, PAN, TAN, IFSC and UPI checks for Office & Expenses → Business
// Details, and the GSTIN on a vendor bill.
//
// A GSTIN is 15 characters:
//   2  state code (01–38, 97, 99)
//   10 the holder's PAN
//   1  entity number for that PAN in that state (1–9, then A–Z)
//   1  'Z' by default
//   1  check character — the GSTN mod-36 checksum over the first 14
//
// The checksum is the one GSTN publishes: each of the first 14 characters is
// read as a base-36 digit (0–9 = 0–9, A–Z = 10–35) and multiplied by 1 and 2
// alternately (odd positions ×1, even ×2, counting from 1). Each product is
// folded back into base 36 — quotient + remainder — and the folded values are
// summed. The check digit is (36 − sum mod 36) mod 36, as a base-36 character.
//
// The backend carries the same code (backend/src/utils/gstin.js) and re-checks
// on every save; this copy lets the form say "GSTIN valid" as it is typed.
// ---------------------------------------------------------------------------

export const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// GST state / UT codes, as the GST portal lists them.
export const GST_STATES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  10: 'Bihar',
  11: 'Sikkim',
  12: 'Arunachal Pradesh',
  13: 'Nagaland',
  14: 'Manipur',
  15: 'Mizoram',
  16: 'Tripura',
  17: 'Meghalaya',
  18: 'Assam',
  19: 'West Bengal',
  20: 'Jharkhand',
  21: 'Odisha',
  22: 'Chhattisgarh',
  23: 'Madhya Pradesh',
  24: 'Gujarat',
  25: 'Daman and Diu',
  26: 'Dadra and Nagar Haveli and Daman and Diu',
  27: 'Maharashtra',
  28: 'Andhra Pradesh (before 2014)',
  29: 'Karnataka',
  30: 'Goa',
  31: 'Lakshadweep',
  32: 'Kerala',
  33: 'Tamil Nadu',
  34: 'Puducherry',
  35: 'Andaman and Nicobar Islands',
  36: 'Telangana',
  37: 'Andhra Pradesh',
  38: 'Ladakh',
  97: 'Other Territory',
  99: 'Centre Jurisdiction',
};

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_SHAPE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_SHAPE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;

export const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();

export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export const stateName = (code) => GST_STATES[String(code || '').padStart(2, '0')] || GST_STATES[Number(code)] || null;

// { ok, gstin, stateCode, stateName, pan, error }
export function checkGstin(raw) {
  const g = clean(raw);
  if (!g) return { ok: false, gstin: '', error: 'GSTIN is empty' };
  if (g.length !== 15) return { ok: false, gstin: g, error: `A GSTIN is 15 characters — this one is ${g.length}` };
  if (!GSTIN_SHAPE.test(g)) return { ok: false, gstin: g, error: 'That is not the shape of a GSTIN (2 digits, PAN, entity, Z, check)' };
  const sc = g.slice(0, 2);
  const st = stateName(sc);
  if (!st) return { ok: false, gstin: g, error: `State code ${sc} is not a GST state code` };
  const want = gstinCheckChar(g.slice(0, 14));
  if (want !== g[14]) return { ok: false, gstin: g, error: `Check character does not match — a typo somewhere (expected ${want} at the end)` };
  return {
    ok: true, gstin: g, stateCode: sc, stateName: st, pan: g.slice(2, 12), error: null,
  };
}

export const isPan = (v) => PAN_SHAPE.test(clean(v));
export const isTan = (v) => TAN_SHAPE.test(clean(v));
export const isIfsc = (v) => IFSC_SHAPE.test(clean(v));
export const isUpi = (v) => UPI_SHAPE.test(String(v || '').trim());

