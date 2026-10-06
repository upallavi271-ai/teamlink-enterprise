// ---------------------------------------------------------------------------
// GST & TDS on an invoice (P4) — the browser's copy of the server's
// calculation (backend/src/utils/invoiceTax.js calcTax), so the create / edit
// forms recalculate on every keystroke. The server works it out again and
// refuses any amount that does not match its %, so the two cannot drift.
//
//   Before GST + GST charged = After GST − TDS deducted = Net receivable
// ---------------------------------------------------------------------------
export const R = (n) => {
  const x = Number(n) || 0;
  return Math.round(Number((x * 100).toPrecision(15))) / 100;
};

export const GST_TYPES = [
  { value: 'CGST_SGST', label: 'CGST + SGST' },
  { value: 'IGST', label: 'IGST' },
  { value: 'NONE', label: 'No GST' },
];
export const GST_TYPE_LABEL = { CGST_SGST: 'CGST + SGST', IGST: 'IGST', NONE: 'No GST' };
export const TDS_BASES = [
  { value: 'base', label: 'Amount before GST' },
  { value: 'gross', label: 'Amount after GST' },
];
export const TDS_SECTIONS = ['194J', '194C', '194H', '194I', '194Q', 'Other'];
export const TDS_STATUSES = ['Not Applicable', 'Pending', 'Deducted', 'Certificate Received'];

export function calcTax({
  base, gstType, gstPercent, tdsPercent, tdsBase,
}) {
  const b = R(base);
  let type = ['CGST_SGST', 'IGST', 'NONE'].includes(gstType) ? gstType : 'CGST_SGST';
  let gp = Number(gstPercent) || 0;
  if (type === 'NONE' || gp <= 0) { type = 'NONE'; gp = 0; }
  const half = gp / 2;
  const cgst = type === 'CGST_SGST' ? R((b * half) / 100) : 0;
  const sgst = type === 'CGST_SGST' ? R((b * half) / 100) : 0;
  const igst = type === 'IGST' ? R((b * gp) / 100) : 0;
  const gst = R(cgst + sgst + igst);
  const gross = R(b + gst);
  const tp = Math.max(0, Number(tdsPercent) || 0);
  const tb = tdsBase === 'gross' ? 'gross' : 'base';
  const tdsOn = tb === 'gross' ? gross : b;
  const tds = tp > 0 ? R((tdsOn * tp) / 100) : 0;
  return {
    base: b, gstType: type, gstPercent: gp, cgstPercent: type === 'CGST_SGST' ? half : 0, igstPercent: type === 'IGST' ? gp : 0,
    cgst, sgst, igst, gst, gross, tdsPercent: tp, tdsBase: tb, tdsOn, tds, net: R(gross - tds),
  };
}

// "18%" — never "18.000000001%".
export const pct = (p) => `${R(p)}%`;

// The GST line in words: "CGST 9% + SGST 9%" / "IGST 18%" / "No GST".
export function gstSplitText(x) {
  if (!x || x.gstType === 'NONE' || !(Number(x.gst) > 0)) return 'No GST';
  if (x.gstType === 'IGST') return `IGST ${pct(x.gstPercent)}`;
  return `CGST ${pct(x.gstPercent / 2)} + SGST ${pct(x.gstPercent / 2)}`;
}

// Where the GST type came from, said plainly.
export const GST_TYPE_FROM = {
  saved: 'chosen on the invoice',
  states: 'from the two states',
  assumed: 'state not known — assumed same state',
  amount: 'no GST on this invoice',
};

// The colour for a TDS status (green done / blue going on / orange waiting).
export const tdsStatusClass = (s) => (s === 'Certificate Received' ? 'paid'
  : s === 'Deducted' ? 'applied' : s === 'Pending' ? 'pending' : '');
