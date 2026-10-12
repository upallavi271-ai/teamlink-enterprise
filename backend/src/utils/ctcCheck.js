// ---------------------------------------------------------------------------
// CTC SANITY CHECK — one rule for every place a CTC is written on an offer or a
// joining (Offers -> Prepare offer, the Joining checklist's date + Joined, and
// the pipeline's move to Joined).
//
// UNIT: Application.offeredCtc is the YEARLY CTC in rupees (the offer letter
// says "Annual CTC", the placement fee is `CTC x fee %`). A monthly figure
// typed by mistake (e.g. 50000) therefore looks too small and is caught by the
// soft minimum.
//
//   value <= 0 or not a number          400  "Write the yearly CTC in rupees…"
//   value  > hardMax   (Rs 10 crore)    400  "This CTC looks wrong: Rs 876 crore. …"
//   outside softMin..softMax            409  { error, needsConfirm:true,
//        (Rs 1 lakh .. Rs 1 crore)            code:'CTC_CONFIRM', value, softMin, softMax }
//                                       and is accepted when the same request
//                                       comes again with confirmCtc:true
//   inside the range                    accepted, nothing changes
//
// The limits are settings (AppSetting rows, YEARLY rupees, JSON numbers):
//   ats.ctc.softMin  default 100000      ats.ctc.softMax  default 10000000
//   ats.ctc.hardMax  default 100000000
// A missing or nonsense value (not a number, or hardMax < softMax < softMin
// out of order) falls back to the defaults.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DEFAULTS = { softMin: 100000, softMax: 10000000, hardMax: 100000000 };
const KEYS = { softMin: 'ats.ctc.softMin', softMax: 'ats.ctc.softMax', hardMax: 'ats.ctc.hardMax' };

async function limits() {
  let rows = [];
  try { rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(KEYS) } } }); } catch { rows = []; }
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...DEFAULTS };
  Object.entries(KEYS).forEach(([name, key]) => {
    if (!byKey.has(key)) return;
    let n = NaN;
    try { n = Number(JSON.parse(byKey.get(key))); } catch { n = Number(byKey.get(key)); }
    if (Number.isFinite(n) && n > 0) out[name] = n;
  });
  if (!(out.softMin < out.softMax && out.softMax <= out.hardMax)) return { ...DEFAULTS };
  return out;
}

// Rs 876 crore · Rs 1,00,00,000 · Rs 50,000  (plain words, Indian grouping).
function rs(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'Rs ?';
  if (Math.abs(v) >= 10000000) {
    const cr = Math.round((v / 10000000) * 100) / 100;
    return `Rs ${cr.toLocaleString('en-IN', { maximumFractionDigits: 2 })} crore`;
  }
  return `Rs ${Math.round(v).toLocaleString('en-IN')}`;
}

// Returns null when the CTC is fine, else { status, body } to send as the answer.
// `raw` is what the request carried; `confirmed` is body.confirmCtc.
async function check(raw, confirmed) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { status: 400, body: { error: 'Write the yearly CTC in rupees, e.g. 450000.', code: 'CTC_INVALID' } };
  }
  const lim = await limits();
  if (value > lim.hardMax) {
    return {
      status: 400,
      body: { error: `This CTC looks wrong: ${rs(value)}. The most we accept is ${rs(lim.hardMax)} a year. Please check the number.`, code: 'CTC_TOO_HIGH', value, hardMax: lim.hardMax },
    };
  }
  if ((value < lim.softMin || value > lim.softMax) && !(confirmed === true || confirmed === 'true' || confirmed === 1 || confirmed === '1')) {
    const error = value < lim.softMin
      ? `${rs(value)} a year is less than ${rs(lim.softMin)}. Is this the yearly CTC? (If it is a monthly amount, multiply it by 12.)`
      : `${rs(value)} a year is more than ${rs(lim.softMax)}. Is this the yearly CTC?`;
    return { status: 409, body: { error, needsConfirm: true, code: 'CTC_CONFIRM', value, softMin: lim.softMin, softMax: lim.softMax } };
  }
  return null;
}

// A CTC that may be left out: blank / missing = nothing to check (null);
// anything written is checked.
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

module.exports = { check, limits, rs, isBlank, DEFAULTS, KEYS };
