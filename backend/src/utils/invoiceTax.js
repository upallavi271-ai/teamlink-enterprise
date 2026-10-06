// ---------------------------------------------------------------------------
// INVOICE GST & TDS — the one place an invoice's tax is worked out (P4,
// 2026-10-05). Every screen, the printable invoice, the bank matching panel and
// the server-side checks read it from here, so the figures can never disagree.
//
//   Amount before GST (base)
//   + GST charged          CGST + SGST (same state) or IGST (another state)
//   = Amount after GST     (gross invoice amount)
//   − TDS deducted         TDS % on the base (default) or on the amount after GST
//   = Net receivable       what the client actually transfers
//   − Received             = Balance
//
// THE STORED NUMBERS ARE THE TRUTH. Invoice.amount / gst / tds are what the
// books hold; nothing here rewrites them. For an older invoice the split
// (CGST / SGST / IGST), the rates and the TDS base are DERIVED from them, and
// checkOf() reports — never fixes — an invoice whose stored numbers do not
// match its own percentages.
//
// New columns (migration 20261005210000_invoice_gst_tds_detail): gstType,
// tdsBase, tdsSection, tdsDeductedOn. Until the migration is applied they are
// simply not read or written (hasCol), and everything still works.
// ---------------------------------------------------------------------------
const { Prisma } = require('@prisma/client');
const { stateOf } = require('./accounts');
const { stateName } = require('./gstin');

// Whether the generated Prisma client knows a field (same check as utils/masters.js,
// kept local so this file loads with no app dependencies).
function hasColumn(model, field) {
  try {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
    return !!(m && m.fields.some((f) => f.name === field));
  } catch { return false; }
}

// Rounded to 2 decimals the way a person would (1.005 -> 1.01).
const R = (n) => {
  const x = Number(n) || 0;
  return Math.round(Number((x * 100).toPrecision(15))) / 100;
};
const TOL = 0.011; // a paisa of float noise
const ROUNDING_TOL = 1; // older invoices rounded GST / TDS to the rupee

const GST_TYPES = ['CGST_SGST', 'IGST', 'NONE'];
const GST_TYPE_LABEL = { CGST_SGST: 'CGST + SGST', IGST: 'IGST', NONE: 'No GST' };
const TDS_BASES = ['base', 'gross'];
const TDS_BASE_LABEL = { base: 'Amount before GST', gross: 'Amount after GST' };
const TDS_STATUSES = ['Not Applicable', 'Pending', 'Deducted', 'Certificate Received'];
const TDS_SECTIONS = ['194J', '194C', '194H', '194I', '194Q', 'Other'];

const hasCol = (f) => hasColumn('Invoice', f);
const inr = (n) => `₹${R(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctTxt = (p) => `${R(p)}%`;

// ---------------------------------------------------------------------------
// Our state and the client's, for "CGST + SGST or IGST?". Ours from the
// Company GSTIN (first two digits) else the Company state; the client's from
// its GSTIN else its address / state. The same reading the printable invoice
// has always used.
// ---------------------------------------------------------------------------
function gstinState(g) {
  const c = String(g || '').trim().toUpperCase();
  return /^\d{2}[A-Z0-9]{13}$/.test(c) && stateName(c.slice(0, 2)) ? { code: c.slice(0, 2), name: stateName(c.slice(0, 2)) } : null;
}
function supplyOf(company, client) {
  const co = company || {};
  const cli = client || {};
  const addr = [cli.houseNumber, cli.street, cli.area, cli.landmark, cli.location, cli.state, cli.pincode].filter(Boolean).join(', ');
  const theirs = gstinState(cli.gst) || stateOf(`${addr} ${cli.state || ''}`);
  const ours = gstinState(co.gstin) || stateOf(co.state || co.address || '');
  const known = !!(ours && theirs);
  const inter = known && ours.code !== theirs.code;
  let why;
  if (known) why = inter ? `TeamLink is in ${ours.name}, the client in ${theirs.name} — inter-state, so IGST` : `TeamLink and the client are both in ${ours.name} — CGST + SGST`;
  else if (!ours) why = "TeamLink's state is not known (Company GSTIN / state) — choose the GST type";
  else why = `The client's state is not on file (GSTIN or address) — choose the GST type (TeamLink is in ${ours.name})`;
  return {
    ours: ours ? `${ours.name} (${ours.code})` : null,
    theirs: theirs ? `${theirs.name} (${theirs.code})` : null,
    known,
    inter,
    suggested: known ? (inter ? 'IGST' : 'CGST_SGST') : null,
    why,
  };
}

// ---------------------------------------------------------------------------
// THE CALCULATION, from a base and the percentages. Used for every write.
// CGST = base × CGST%, SGST = base × SGST%, total = CGST + SGST; IGST = base × IGST%.
// ---------------------------------------------------------------------------
function calcTax({
  base, gstType, gstPercent, tdsPercent, tdsBase,
}) {
  const b = R(base);
  let type = GST_TYPES.includes(gstType) ? gstType : 'CGST_SGST';
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
    base: b,
    gstApplicable: type !== 'NONE',
    gstType: type,
    gstPercent: gp,
    cgstPercent: type === 'CGST_SGST' ? half : 0,
    sgstPercent: type === 'CGST_SGST' ? half : 0,
    igstPercent: type === 'IGST' ? gp : 0,
    cgst,
    sgst,
    igst,
    gst,
    gross,
    tdsApplicable: tp > 0,
    tdsPercent: tp,
    tdsBase: tb,
    tdsOn,
    tds,
    net: R(gross - tds),
  };
}

// The rates and GST type a NEW invoice for this client starts with — the
// client's own agreed rates and its GST / TDS Applicable flags, the GST type
// from the two states. `fallback` = what the caller used before when the
// client has no rate ({ gst: 18, tds: 10 } for a joining, 0 / 0 otherwise).
function defaultsFor(client, company, fallback = {}) {
  const cli = client || {};
  const off = (v) => /^no$/i.test(String(v || '').trim());
  const sup = supplyOf(company, cli);
  const gstPercent = off(cli.gstApplicable) ? 0 : (cli.gstPercent != null ? Number(cli.gstPercent) : Number(fallback.gst || 0));
  const tdsPercent = off(cli.tdsApplicable) ? 0 : (cli.tdsPercent != null ? Number(cli.tdsPercent) : Number(fallback.tds || 0));
  return {
    gstType: gstPercent > 0 ? (sup.suggested || 'CGST_SGST') : 'NONE',
    gstTypeFrom: gstPercent > 0 ? (sup.suggested ? 'states' : 'assumed') : 'client',
    gstPercent,
    tdsPercent,
    tdsBase: 'base',
    supply: sup,
  };
}

// The columns a write can carry for the new fields (only those that exist).
function extraData(c, input = {}) {
  const out = {};
  if (hasCol('gstType')) out.gstType = c.gstType;
  if (hasCol('tdsBase')) out.tdsBase = c.tdsBase;
  if (hasCol('tdsSection') && input.tdsSection !== undefined) out.tdsSection = input.tdsSection || null;
  if (hasCol('tdsDeductedOn') && input.tdsDeductedOn !== undefined) out.tdsDeductedOn = input.tdsDeductedOn || null;
  return out;
}

// Everything a write stores, from the calculation.
function writeData(c, input) {
  return {
    amount: c.base,
    gst: c.gst,
    tds: c.tds,
    gstPercent: c.gstPercent,
    tdsPercent: c.tdsPercent,
    ...extraData(c, input),
  };
}

// ---------------------------------------------------------------------------
// READ A CREATE / EDIT REQUEST. The percentages decide; an amount sent along
// must agree with them or the request is refused — the server never stores a
// GST amount that is not its GST %, or a TDS amount that is not its TDS %.
//   body: amount, gstApplicable (Yes/No), gstType, gstPercent, gst?,
//         tdsApplicable (Yes/No), tdsPercent, tdsBase, tds?, net?,
//         tdsSection, tdsDeductedOn
//   start: the invoice being edited (or {}), defaults: defaultsFor(...)
// Returns { error } or { calc, data, input }.
// ---------------------------------------------------------------------------
const yesNo = (v) => (v === true || /^(yes|y|true|1)$/i.test(String(v)) ? true
  : (v === false || /^(no|n|false|0)$/i.test(String(v)) ? false : null));
const given = (v) => v !== undefined && v !== null && v !== '';

function readTaxInput(body = {}, start = {}, defaults = {}) {
  const num = (v) => Number(String(v).replace(/[₹,\s]/g, ''));
  const base = given(body.amount) ? num(body.amount) : Number(start.amount);
  if (!Number.isFinite(base) || !(base > 0)) return { error: 'Enter the amount before GST — more than ₹0.' };
  if (base > 1e10) return { error: 'That amount before GST is too large.' };

  const startType = start.id ? (start.gstType || (Number(start.gst || 0) > 0.005 ? null : 'NONE')) : null;
  let gstPercent = given(body.gstPercent) ? num(body.gstPercent)
    : (start.id ? Number(start.gstPercent ?? 0) : Number(defaults.gstPercent || 0));
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) return { error: 'GST % must be between 0 and 100.' };
  let gstType = GST_TYPES.includes(body.gstType) ? body.gstType : (startType || defaults.gstType || 'CGST_SGST');
  const gstOn = yesNo(body.gstApplicable);
  if (gstOn === false) { gstType = 'NONE'; gstPercent = 0; }
  if (gstOn === true && gstType === 'NONE') gstType = defaults.gstType && defaults.gstType !== 'NONE' ? defaults.gstType : 'CGST_SGST';
  if (gstOn === true && !(gstPercent > 0)) return { error: 'GST is marked applicable — enter the GST %.' };
  if (gstType === 'NONE') gstPercent = 0;

  let tdsPercent = given(body.tdsPercent) ? num(body.tdsPercent)
    : (start.id ? Number(start.tdsPercent ?? 0) : Number(defaults.tdsPercent || 0));
  if (!Number.isFinite(tdsPercent) || tdsPercent < 0 || tdsPercent > 100) return { error: 'TDS % must be between 0 and 100.' };
  const tdsOn = yesNo(body.tdsApplicable);
  if (tdsOn === false) tdsPercent = 0;
  if (tdsOn === true && !(tdsPercent > 0)) return { error: 'TDS is marked applicable — enter the TDS %.' };
  const tdsBase = TDS_BASES.includes(body.tdsBase) ? body.tdsBase : (start.tdsBase || defaults.tdsBase || 'base');

  const tdsSection = body.tdsSection !== undefined ? String(body.tdsSection || '').trim().slice(0, 40) : undefined;
  const tdsDeductedOn = body.tdsDeductedOn !== undefined ? String(body.tdsDeductedOn || '').trim().slice(0, 10) : undefined;
  if (tdsDeductedOn && !/^\d{4}-\d{2}-\d{2}$/.test(tdsDeductedOn)) return { error: 'The TDS deduction date is not a date.' };

  const calc = calcTax({
    base, gstType, gstPercent, tdsPercent, tdsBase,
  });
  // An amount typed alongside a % must be that % — otherwise say what it should be.
  if (given(body.gst) && Math.abs(num(body.gst) - calc.gst) > TOL) {
    return { error: `The GST amount ${inr(num(body.gst))} does not match ${calc.gstApplicable ? `${pctTxt(calc.gstPercent)} of ${inr(calc.base)} = ${inr(calc.gst)}` : 'No GST (₹0.00)'}. Leave it to the calculation.` };
  }
  if (given(body.tds) && Math.abs(num(body.tds) - calc.tds) > TOL) {
    return { error: `The TDS amount ${inr(num(body.tds))} does not match ${calc.tdsApplicable ? `${pctTxt(calc.tdsPercent)} of ${inr(calc.tdsOn)} = ${inr(calc.tds)}` : 'No TDS (₹0.00)'}. Leave it to the calculation.` };
  }
  if (given(body.net) && Math.abs(num(body.net) - calc.net) > TOL) {
    return { error: `The net receivable ${inr(num(body.net))} does not match ${inr(calc.gross)} − ${inr(calc.tds)} = ${inr(calc.net)}.` };
  }
  const input = { tdsSection, tdsDeductedOn };
  return { calc, input, data: writeData(calc, input) };
}

// ---------------------------------------------------------------------------
// THE VIEW OF ONE INVOICE, from its STORED numbers. Works for every invoice,
// old or new. `ctx` = { company, client } (client defaults to invoice.client).
// ---------------------------------------------------------------------------
function tdsStatusOf(inv, tds, received) {
  if (!(tds > 0.5)) return 'Not Applicable';
  if (inv.tdsCertReceived) return 'Certificate Received';
  if ((hasCol('tdsDeductedOn') && inv.tdsDeductedOn) || received > 0.5) return 'Deducted';
  return 'Pending';
}

function taxView(inv, ctx = {}) {
  const cli = ctx.client || inv.client || {};
  const base = R(inv.amount);
  const gst = R(inv.gst);
  const tds = R(inv.tds);
  const gross = R(base + gst);
  const net = R(gross - tds);
  const received = R(inv.receivedAmount);
  const savedType = hasCol('gstType') && GST_TYPES.includes(inv.gstType) ? inv.gstType : null;
  const sup = supplyOf(ctx.company, cli);

  let gstType;
  let gstTypeFrom;
  if (!(gst > 0.005)) { gstType = 'NONE'; gstTypeFrom = savedType === 'NONE' ? 'saved' : 'amount'; } else if (savedType && savedType !== 'NONE') { gstType = savedType; gstTypeFrom = 'saved'; } else if (sup.suggested) { gstType = sup.suggested; gstTypeFrom = 'states'; } else { gstType = 'CGST_SGST'; gstTypeFrom = 'assumed'; }

  const storedGp = inv.gstPercent != null && Number(inv.gstPercent) > 0 ? Number(inv.gstPercent) : null;
  const gstPercent = gstType === 'NONE' ? 0 : (storedGp != null ? storedGp : (base > 0 ? R((gst / base) * 100) : 0));
  const gstPercentFrom = gstType === 'NONE' ? 'none' : (storedGp != null ? 'saved' : 'amount');
  const cgst = gstType === 'CGST_SGST' ? R(gst / 2) : 0;
  const sgst = gstType === 'CGST_SGST' ? R(gst - cgst) : 0;
  const igst = gstType === 'IGST' ? gst : 0;

  const tdsBase = hasCol('tdsBase') && inv.tdsBase === 'gross' ? 'gross' : 'base';
  const tdsBaseFrom = hasCol('tdsBase') && inv.tdsBase ? 'saved' : 'default';
  const tdsOn = tdsBase === 'gross' ? gross : base;
  const storedTp = inv.tdsPercent != null && Number(inv.tdsPercent) > 0 ? Number(inv.tdsPercent) : null;
  const tdsPercent = !(tds > 0.005) ? 0 : (storedTp != null ? storedTp : (tdsOn > 0 ? R((tds / tdsOn) * 100) : 0));
  const tdsPercentFrom = !(tds > 0.005) ? 'none' : (storedTp != null ? 'saved' : 'amount');
  // B2 — issued credit notes set against the balance / issued debit notes
  // (0 on every invoice without a note, so nothing older moves).
  const credited = hasCol('creditedAmount') ? R(inv.creditedAmount) : 0;
  const debited = hasCol('debitedAmount') ? R(inv.debitedAmount) : 0;

  return {
    base,
    gstApplicable: gstType !== 'NONE',
    gstType,
    gstTypeLabel: GST_TYPE_LABEL[gstType],
    gstTypeFrom, // saved | states | assumed | amount
    gstPercent,
    gstPercentFrom,
    cgstPercent: gstType === 'CGST_SGST' ? gstPercent / 2 : 0,
    sgstPercent: gstType === 'CGST_SGST' ? gstPercent / 2 : 0,
    igstPercent: gstType === 'IGST' ? gstPercent : 0,
    cgst,
    sgst,
    igst,
    gst,
    gross,
    tdsApplicable: tds > 0.005,
    tdsPercent,
    tdsPercentFrom,
    tdsBase,
    tdsBaseLabel: TDS_BASE_LABEL[tdsBase],
    tdsBaseFrom,
    tdsOn,
    tds,
    tdsSection: hasCol('tdsSection') ? (inv.tdsSection || null) : null,
    tdsDeductedOn: hasCol('tdsDeductedOn') ? (inv.tdsDeductedOn || null) : null,
    tdsCertRef: inv.tdsCertRef || null,
    tdsStatus: tdsStatusOf(inv, tds, received),
    net,
    received,
    credited,
    debited,
    balance: R(net - received - credited + debited),
    supply: sup,
    check: checkOf(inv, {
      base, gst, tds, gross, net, received, gstType, tdsBase,
    }),
  };
}

// ---------------------------------------------------------------------------
// DOES THE STORED INVOICE AGREE WITH ITS OWN PERCENTAGES? Reported, never fixed.
//   level ok       — every amount is its %
//   level rounded  — off by ₹1 or less (older invoices rounded to the rupee)
//   level mismatch — a real difference a person should look at
// ---------------------------------------------------------------------------
function checkOf(inv, v) {
  const issues = [];
  const add = (level, field, text, stored, expected) => issues.push({
    level, field, text, stored: R(stored), expected: R(expected), diff: R(stored - expected),
  });
  const gp = inv.gstPercent != null ? Number(inv.gstPercent) : null;
  const tp = inv.tdsPercent != null ? Number(inv.tdsPercent) : null;

  if (gp != null && gp > 0 && v.gst > 0.005) {
    const want = calcTax({ base: v.base, gstType: v.gstType === 'NONE' ? 'CGST_SGST' : v.gstType, gstPercent: gp }).gst;
    const d = Math.abs(v.gst - want);
    if (d > TOL) add(d <= ROUNDING_TOL ? 'rounded' : 'mismatch', 'gst', `GST stored ${inr(v.gst)}; ${pctTxt(gp)} of ${inr(v.base)} is ${inr(want)}`, v.gst, want);
  } else if (gp != null && gp > 0 && !(v.gst > 0.005)) {
    add('mismatch', 'gst', `GST % is ${pctTxt(gp)} but no GST was charged (stored ₹0.00; ${pctTxt(gp)} of ${inr(v.base)} would be ${inr(calcTax({ base: v.base, gstPercent: gp }).gst)})`, 0, calcTax({ base: v.base, gstPercent: gp }).gst);
  } else if (gp == null && v.gst > 0.005) {
    add('info', 'gstPercent', `GST % is not stored — reads as ${pctTxt(v.base > 0 ? (v.gst / v.base) * 100 : 0)} from the amounts`, v.gst, v.gst);
  }

  if (tp != null && tp > 0 && v.tds > 0.005) {
    const want = R(((v.tdsBase === 'gross' ? v.gross : v.base) * tp) / 100);
    const d = Math.abs(v.tds - want);
    if (d > TOL) {
      const onGross = R((v.gross * tp) / 100);
      const viaGross = v.tdsBase !== 'gross' && Math.abs(v.tds - onGross) <= ROUNDING_TOL;
      add(viaGross ? 'mismatch' : (d <= ROUNDING_TOL ? 'rounded' : 'mismatch'), 'tds', viaGross
        ? `TDS stored ${inr(v.tds)} is ${pctTxt(tp)} of the amount AFTER GST (${inr(v.gross)}), not of the base ${inr(v.base)} (${inr(want)})`
        : `TDS stored ${inr(v.tds)}; ${pctTxt(tp)} of ${inr(v.tdsBase === 'gross' ? v.gross : v.base)} is ${inr(want)}`, v.tds, want);
    }
  } else if (tp == null && v.tds > 0.005) {
    add('info', 'tdsPercent', `TDS % is not stored — reads as ${pctTxt(v.base > 0 ? (v.tds / v.base) * 100 : 0)} of the base from the amounts`, v.tds, v.tds);
  }
  // TDS % with no TDS amount is normal (a client who paid in full) — not a mismatch.

  if (String(inv.status || '') !== 'Cancelled' && v.received > v.net + 0.5) {
    add('mismatch', 'received', `Received ${inr(v.received)} is more than the net receivable ${inr(v.net)}`, v.received, v.net);
  }
  const level = issues.some((i) => i.level === 'mismatch') ? 'mismatch'
    : (issues.some((i) => i.level === 'rounded') ? 'rounded' : 'ok');
  return { level, issues };
}

// "Why is this amount different?" — a bank amount set against an invoice.
// `view` = taxView(invoice); amount = the bank line. Expected now = what is
// still pending on the net receivable.
function bankCompare(view, amount) {
  const bank = R(amount);
  const expected = R(view.balance);
  const diff = R(bank - expected);
  const reasons = [];
  if (Math.abs(diff) <= 1) return { bank, expected, diff, matched: true, reasons };
  if (view.received > 0.5) reasons.push(`${inr(view.received)} was already received on this invoice, so only ${inr(expected)} of the ${inr(view.net)} net receivable is still to come.`);
  if (view.tds > 0.5 && Math.abs(bank - R(view.balance + view.tds)) <= 1) {
    reasons.push(`The client paid without cutting TDS — ${inr(bank)} is the full amount after GST. Either they will not deduct the ${inr(view.tds)} TDS, or it comes back as a refund / adjustment.`);
  }
  if (view.tds < 0.5 && view.base > 0) {
    [1, 2, 10].forEach((p) => {
      const t = R((view.base * p) / 100);
      if (Math.abs(bank - R(expected - t)) <= 1) reasons.push(`The client looks to have cut ${p}% TDS (${inr(t)}) that this invoice does not show.`);
    });
  }
  if (view.tds > 0.5 && view.tdsBase === 'base' && Math.abs(bank - R(view.gross - (view.gross * view.tdsPercent) / 100 - view.received)) <= 1) {
    reasons.push(`The client calculated ${pctTxt(view.tdsPercent)} TDS on the amount after GST (${inr(view.gross)}) instead of on the base.`);
  }
  if (view.gst > 0.5 && Math.abs(bank - R(view.base - view.tds - view.received)) <= 1) {
    reasons.push(`The client paid without GST — ${inr(bank)} is the base less TDS; the ${inr(view.gst)} GST is still owed.`);
  }
  if (!reasons.length) {
    reasons.push(diff < 0
      ? `${inr(-diff)} less than expected — a part payment, a bank charge, or a deduction the client has not explained.`
      : `${inr(diff)} more than expected — it may also cover another invoice; the extra stays unposted on the line.`);
  }
  return { bank, expected, diff, matched: false, reasons };
}

// ---------------------------------------------------------------------------
// B2 — CREDIT NOTES (and DEBIT NOTES) against ONE invoice. The one rule every
// screen, the register, the Accounts Dashboard and the reports read.
//
//   Note before GST (base)
//   + GST          the INVOICE's own GST type and rate (CGST + SGST / IGST)
//   − TDS effect   the invoice's TDS % on the same base the invoice used
//   = Note net     what the client's net receivable goes down (credit) or up (debit) by
//
// A credit note is set against the invoice's balance; when it is more than the
// balance the rest is a REFUND DUE to the client (CreditNote.refundDue) — the
// balance never goes negative. Invoice.creditedAmount = the part set against
// the balance, Invoice.debitedAmount = issued debit notes, so
//   Balance = net receivable − received − credited + debited
// (utils/accounts.js invoiceOutstanding, taxView above).
// Revenue / GST / TDS / receivable drop by the WHOLE credit note (withNotes).
// ---------------------------------------------------------------------------
const CREDIT_REASONS = [
  { value: 'left_in_guarantee', label: 'Candidate left within the guarantee' },
  { value: 'replacement', label: 'Replacement' },
  { value: 'refund', label: 'Refund' },
  { value: 'wrong_amount', label: 'Wrong amount billed' },
  { value: 'other', label: 'Other' },
];
const DEBIT_REASONS = [
  { value: 'missed_fee', label: 'Fee missed on the invoice' },
  { value: 'wrong_amount', label: 'Billed too little' },
  { value: 'other', label: 'Other' },
];
const reasonsOf = (kind) => (kind === 'debit' ? DEBIT_REASONS : CREDIT_REASONS);
const reasonLabel = (kind, v) => (reasonsOf(kind).find((x) => x.value === v) || {}).label || v || '—';

// A note's GST / TDS from its base and the invoice's own reading (taxView).
function noteCalc(view, base) {
  return calcTax({
    base, gstType: view.gstType, gstPercent: view.gstPercent, tdsPercent: view.tdsPercent, tdsBase: view.tdsBase,
  });
}

// The totals of an invoice's ISSUED notes.
function noteSum(notes) {
  const z = () => ({
    count: 0, base: 0, gst: 0, tds: 0, net: 0, applied: 0, refundDue: 0, refundOpen: 0, numbers: [],
  });
  const out = { credit: z(), debit: z() };
  (notes || []).filter((n) => n && n.status === 'Issued').forEach((n) => {
    const s = n.kind === 'debit' ? out.debit : out.credit;
    s.count += 1;
    s.base = R(s.base + Number(n.amount || 0));
    s.gst = R(s.gst + Number(n.gst || 0));
    s.tds = R(s.tds + Number(n.tds || 0));
    s.net = R(s.net + Number(n.net || 0));
    s.applied = R(s.applied + Number(n.applied || 0));
    s.refundDue = R(s.refundDue + Number(n.refundDue || 0));
    if (Number(n.refundDue || 0) > 0.005 && !n.refundPaidOn) s.refundOpen = R(s.refundOpen + Number(n.refundDue || 0));
    if (n.number) s.numbers.push(n.number);
  });
  return out;
}

// One invoice's figures AFTER its issued notes. With no note every figure is
// the stored one — an invoice without a note never changes.
//   billing / gst / tds / invoiceValue / receivable  less credit notes, plus debit notes
//   pending        what the client still owes (never below 0)
//   refundDue      credit beyond the balance, owed back to the client (all time)
//   refundOpen     the part of it not paid back yet
// pending = receivable − received + refundDue  (the identity the dashboard checks)
function withNotes(inv, notes) {
  const s = noteSum(notes);
  const billing = R(inv.amount);
  const gst = R(inv.gst);
  const tds = R(inv.tds);
  const receivable = R(billing + gst - tds);
  const received = R(inv.receivedAmount);
  const b = R(billing - s.credit.base + s.debit.base);
  const g = R(gst - s.credit.gst + s.debit.gst);
  const t = R(tds - s.credit.tds + s.debit.tds);
  return {
    asBilled: {
      billing, gst, tds, invoiceValue: R(billing + gst), receivable,
    },
    billing: b,
    gst: g,
    tds: t,
    invoiceValue: R(b + g),
    receivable: R(receivable - s.credit.net + s.debit.net),
    received,
    pending: R(receivable - received - s.credit.applied + s.debit.net),
    refundDue: s.credit.refundDue,
    refundOpen: s.credit.refundOpen,
    credit: s.credit,
    debit: s.debit,
    hasNotes: s.credit.count + s.debit.count > 0,
  };
}

// Indian financial year of a date: "FY 2026-27".
function fyOf(d) {
  const s = String(d || '');
  if (!/^\d{4}-\d{2}/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

module.exports = {
  R,
  TOL,
  GST_TYPES,
  GST_TYPE_LABEL,
  TDS_BASES,
  TDS_BASE_LABEL,
  TDS_STATUSES,
  TDS_SECTIONS,
  hasCol,
  supplyOf,
  calcTax,
  defaultsFor,
  writeData,
  readTaxInput,
  taxView,
  checkOf,
  bankCompare,
  fyOf,
  inr,
  // B2 — credit / debit notes
  CREDIT_REASONS,
  DEBIT_REASONS,
  reasonsOf,
  reasonLabel,
  noteCalc,
  noteSum,
  withNotes,
};
