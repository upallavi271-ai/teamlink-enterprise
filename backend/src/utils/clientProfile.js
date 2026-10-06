// ---------------------------------------------------------------------------
// ADD CLIENT IN 9 SECTIONS (2026-10-05) — the fields, the rules, in one place.
//
// The form (frontend components/clients/ClientForm.jsx) maps onto existing
// Client columns wherever one exists; the rest are the columns added by
// migration 20261005170000_client_profile_sections. Every new column is used
// ONLY when the generated Prisma client knows it (hasColumn), so an install
// without the migration keeps working — those fields are reported back as
// `pendingFields` instead of crashing the save.
//
// REQUIRED for "Save & Create Agreement" (the user's list of 10):
//   Company Name, Industry, Contact Name, Contact Email, Contact Mobile,
//   Department, BDE / Account Manager, Fee %, Payment Terms, Replacement
//   Guarantee. "Save Draft" needs the Company Name only; the rest are listed
//   as missing.
//
// INTERNAL NOTES (section 9) are never sent to a client login and never read
// by the agreement template, the preview, the link page, the PDF, the portal
// or any email. The bank account number is stored encrypted
// (utils/secrets.js) and only its last 4 digits ever leave the server.
// ---------------------------------------------------------------------------
let dmmfFields = null;
function clientColumns() {
  if (dmmfFields) return dmmfFields;
  try {
    // eslint-disable-next-line global-require
    const { Prisma } = require('@prisma/client');
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === 'Client');
    dmmfFields = new Set(m ? m.fields.map((f) => f.name) : []);
  } catch { dmmfFields = new Set(); }
  return dmmfFields;
}
const hasColumn = (name) => clientColumns().has(name);
function docsAvailable() {
  try {
    // eslint-disable-next-line global-require
    const { Prisma } = require('@prisma/client');
    return Prisma.dmmf.datamodel.models.some((x) => x.name === 'ClientDocument');
  } catch { return false; }
}

// The new columns (migration 20261005170000). type: text | number | bool.
const NEW_FIELDS = {
  companyType: 'text', companyEmail: 'text', contactAltPhone: 'text', secondaryBde: 'text', clientSource: 'text',
  feeType: 'text', feeAmount: 'number', gstApplicable: 'text', tdsApplicable: 'text', replacementTerms: 'text',
  specialTerms: 'text', billingAddress: 'text', billingSameAsAddress: 'bool', billingEmail: 'text', invoiceEmail: 'text',
  paymentMethod: 'text', paymentBankName: 'text', paymentUpi: 'text', paymentReferenceNote: 'text',
  bankAccountHolder: 'text', bankIfsc: 'text',
  internalNotes: 'text', specialInstructions: 'text', recruitmentInstructions: 'text', internalRemarks: 'text',
};
// Section 9 + the bank account: never to a client login.
const INTERNAL_FIELDS = ['internalNotes', 'specialInstructions', 'recruitmentInstructions', 'internalRemarks'];
const BANK_FIELDS = ['bankAccountHolder', 'bankAccountNoEnc', 'bankAccountLast4', 'bankIfsc'];
// Commercial (Super Admin / Admin: Commercial Terms edit), like fee %.
const NEW_COMMERCIAL_FIELDS = ['feeType', 'feeAmount', 'gstApplicable', 'tdsApplicable', 'replacementTerms', 'specialTerms'];
const FEE_TYPES = ['PERCENT_CTC', 'FIXED', 'PER_CANDIDATE'];

const REQUIRED = [
  ['name', 'Company name'], ['industry', 'Industry'], ['contactName', 'Contact name'], ['contactEmail', 'Contact email'],
  ['contactPhone', 'Contact mobile'], ['ownerDepartment', 'Department'], ['bdeOwner', 'Client manager (BDE)'],
  ['agreementFeePercent', 'Fee'], ['paymentTerms', 'Payment terms'], ['guaranteePeriod', 'Replacement guarantee'],
];

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const blankish = (v) => v === undefined || v === null || String(v).trim() === '';

// Which of the 10 required fields a client (or a form body) is missing.
function missingRequired(c) {
  const out = [];
  REQUIRED.forEach(([k, label]) => {
    if (k === 'agreementFeePercent') {
      const fixed = c.feeType && c.feeType !== 'PERCENT_CTC';
      if (fixed ? blankish(c.feeAmount) : blankish(c.agreementFeePercent)) out.push({ field: fixed ? 'feeAmount' : k, label });
      return;
    }
    if (blankish(c[k])) out.push({ field: k, label });
  });
  return out;
}

// Plain-word format errors: [{ field, error }].
function formatErrors(b) {
  const errs = [];
  const up = (v) => String(v || '').trim().toUpperCase();
  if (!blankish(b.gst) && !GSTIN_RE.test(up(b.gst))) errs.push({ field: 'gst', error: 'GSTIN should be 15 letters/numbers, like 36AABCT1234C1Z5.' });
  if (!blankish(b.pan) && !PAN_RE.test(up(b.pan))) errs.push({ field: 'pan', error: 'PAN should be 10 letters/numbers, like AABCT1234C.' });
  ['contactEmail', 'companyEmail', 'billingEmail', 'invoiceEmail', 'billingContactEmail'].forEach((k) => {
    if (!blankish(b[k]) && !EMAIL_RE.test(String(b[k]).trim())) errs.push({ field: k, error: 'That email does not look right — for example name@company.com.' });
  });
  if (!blankish(b.contactPhone) && String(b.contactPhone).replace(/\D/g, '').length < 10) errs.push({ field: 'contactPhone', error: 'The mobile number needs 10 digits.' });
  if (!blankish(b.pincode) && !/^\d{6}$/.test(String(b.pincode).trim())) errs.push({ field: 'pincode', error: 'Pincode is 6 digits.' });
  if (!blankish(b.feeType) && !FEE_TYPES.includes(b.feeType)) errs.push({ field: 'feeType', error: 'Pick how the fee is charged.' });
  if (!blankish(b.feeAmount) && !(Number(b.feeAmount) > 0)) errs.push({ field: 'feeAmount', error: 'The fee amount must be more than 0.' });
  if (!blankish(b.bankIfsc) && !IFSC_RE.test(up(b.bankIfsc))) errs.push({ field: 'bankIfsc', error: 'IFSC is 11 letters/numbers, like HDFC0001234.' });
  if (!blankish(b.bankAccountNo) && !/^\d{6,18}$/.test(String(b.bankAccountNo).replace(/\s/g, ''))) errs.push({ field: 'bankAccountNo', error: 'The account number should be 6 to 18 digits.' });
  if (!blankish(b.agreementStart) && !blankish(b.agreementEnd) && String(b.agreementEnd) < String(b.agreementStart)) errs.push({ field: 'agreementEnd', error: 'The expiry date is before the effective date.' });
  return errs;
}

// The new-column part of a form body, for the columns this database has.
// Returns { data, pending } — pending = sent but not storable yet.
function pickProfile(body = {}) {
  const data = {};
  const pending = [];
  Object.entries(NEW_FIELDS).forEach(([k, type]) => {
    if (body[k] === undefined) return;
    if (!hasColumn(k)) { if (!blankish(body[k])) pending.push(k); return; }
    let v = body[k];
    if (type === 'number') v = blankish(v) ? null : Number(v);
    else if (type === 'bool') v = v === true || v === 'true' || v === 'Yes';
    else v = blankish(v) ? null : String(v).trim().slice(0, 4000);
    if (k === 'bankIfsc' && v) v = v.toUpperCase();
    data[k] = v;
  });
  // The bank account number: encrypted at rest, last 4 for display.
  if (body.bankAccountNo !== undefined) {
    const raw = String(body.bankAccountNo || '').replace(/\s/g, '');
    if (!hasColumn('bankAccountNoEnc')) { if (raw) pending.push('bankAccountNo'); } else if (!raw) {
      if (body.bankAccountNo === null || body.bankAccountNo === '') { data.bankAccountNoEnc = null; data.bankAccountLast4 = null; }
    } else {
      // eslint-disable-next-line global-require
      const { encryptSecret } = require('./secrets');
      data.bankAccountNoEnc = encryptSecret(raw); // throws NO_SECRET_KEY rather than store plaintext
      data.bankAccountLast4 = raw.slice(-4);
    }
  }
  return { data, pending };
}

// Never to the browser: the encrypted account number. A masked hint instead.
function shapeProfile(out) {
  if (!out || typeof out !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(out, 'bankAccountNoEnc')) {
    out.bankAccountMasked = out.bankAccountLast4 ? `••••••${out.bankAccountLast4}` : null;
    delete out.bankAccountNoEnc;
  }
  return out;
}
// For a client login: no internal notes, no bank account.
function stripForClient(out) {
  if (!out || typeof out !== 'object') return out;
  [...INTERNAL_FIELDS, ...BANK_FIELDS, 'bankAccountMasked'].forEach((k) => { delete out[k]; });
  return out;
}

// Document status: Pending (marked), Expired, Expiring soon (30 days), Valid.
function documentStatus(doc, today = new Date()) {
  if (doc.pending) return 'Pending';
  const m = String(doc.expiryDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Valid';
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (end.getTime() < t) return 'Expired';
  if (end.getTime() - t <= 30 * 86400000) return 'Expiring soon';
  return 'Valid';
}
// SOURCE (docfill_, 2026-10-06): the profile / e-mail / old agreement the client was filled from.
const DOC_KINDS = { AGREEMENT: 'Agreement', GST: 'GST certificate', REGISTRATION: 'Company registration', PAN: 'PAN', SOURCE: 'Source document', OTHER: 'Other' };

module.exports = {
  hasColumn, docsAvailable, NEW_FIELDS, INTERNAL_FIELDS, BANK_FIELDS, NEW_COMMERCIAL_FIELDS, FEE_TYPES, REQUIRED,
  missingRequired, formatErrors, pickProfile, shapeProfile, stripForClient, documentStatus, DOC_KINDS,
  GSTIN_RE, PAN_RE,
};
