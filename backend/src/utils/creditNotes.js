// ---------------------------------------------------------------------------
// B2 — CREDIT NOTES / DEBIT NOTES and PLACEMENT MARGIN (2026-10-05).
//
// A note is raised against ONE client invoice (CreditNote, kind credit | debit)
// with the invoice's own GST type and rates and TDS base, so its GST reversal
// and TDS effect are the invoice's (utils/invoiceTax.js noteCalc). The money
// rule every screen reads is utils/invoiceTax.js withNotes(); this file holds
// the plumbing: loading notes, the CN-YYYY-#### / DN-YYYY-#### series, who may
// issue (maker-checker), the guarantee link and the margin rows.
//
//   Draft  -> Issued     an approver (Super Admin / Admin on Accounts, or an
//                        Accountant holding approve on Accounts · Invoices) who
//                        is NOT the person who made the draft
//   Issued -> Cancelled  an approver; the invoice's balance goes back
//
// Until the migration (CreditNote table, Invoice.creditedAmount /
// debitedAmount) is applied, ready() is false and nothing here is read.
// ---------------------------------------------------------------------------
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const TAX = require('./invoiceTax');
const { roleForProduct, can } = require('./permissions');

const R = TAX.R;

function hasModel(name) {
  try { return !!Prisma.dmmf.datamodel.models.find((m) => m.name === name); } catch { return false; }
}
const ready = () => hasModel('CreditNote') && TAX.hasCol('creditedAmount') && TAX.hasCol('debitedAmount');
const NOT_READY = { error: 'Credit notes are built but the database update for them is not applied yet — ask the administrator to apply migration credit_notes.' };

const KIND_LABEL = { credit: 'Credit note', debit: 'Debit note' };
const STATUS = ['Draft', 'Issued', 'Cancelled'];

// Every note of these invoices (null = every invoice), grouped by invoice.
async function notesByInvoice(invoiceIds, { issuedOnly = false } = {}) {
  const map = new Map();
  if (!ready()) return map;
  const where = {};
  if (Array.isArray(invoiceIds)) where.invoiceId = { in: invoiceIds };
  if (issuedOnly) where.status = 'Issued';
  const rows = await prisma.creditNote.findMany({ where, orderBy: { createdAt: 'asc' } });
  rows.forEach((n) => { if (!map.has(n.invoiceId)) map.set(n.invoiceId, []); map.get(n.invoiceId).push(n); });
  return map;
}

// The Accounts approver. Never decided from a name or a designation.
async function isNoteApprover(user) {
  const role = roleForProduct(user, 'accounts');
  if (['SUPER_ADMIN', 'ADMIN'].includes(role)) return true;
  if (role !== 'ACCOUNTANT') return false;
  return can(user, 'accounts', 'accounts', 'Invoices', 'approve');
}
const APPROVER_ONLY = 'Only an Accounts approver (Super Admin, Admin, or an Accountant with approve on Invoices) can do this.';

// CN-2026-0001 … per kind, per calendar year of the note date.
async function nextNoteNumber(kind, noteDate, tx = prisma) {
  const year = /^\d{4}/.test(String(noteDate || '')) ? String(noteDate).slice(0, 4) : String(new Date().getFullYear());
  const prefix = `${kind === 'debit' ? 'DN' : 'CN'}-${year}-`;
  const rows = await tx.creditNote.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } });
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r.number).slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(4, '0');
}

// The invoice behind a placement: the exact candidate + requirement, else the
// candidate at the same client (an older invoice names no requirement).
async function invoiceForApplication(app) {
  if (!app) return null;
  const live = { NOT: { status: 'Cancelled' } };
  const exact = await prisma.invoice.findFirst({
    where: { ...live, candidateId: app.candidateId, requirementId: app.requirementId },
    orderBy: { invoiceDate: 'desc' },
  });
  if (exact) return exact;
  const clientId = app.requirement && app.requirement.clientId;
  if (!clientId) return null;
  return prisma.invoice.findFirst({
    where: { ...live, candidateId: app.candidateId, clientId },
    orderBy: { invoiceDate: 'desc' },
  });
}

// What a note shows on screen.
function shapeNote(n, inv) {
  return {
    ...n,
    kindLabel: KIND_LABEL[n.kind] || 'Note',
    reasonLabel: TAX.reasonLabel(n.kind, n.reason),
    gstTypeLabel: TAX.GST_TYPE_LABEL[n.gstType] || n.gstType,
    displayNumber: n.number || 'Draft',
    invoiceNumber: inv ? (inv.invoiceNumber || inv.id.slice(-6)) : null,
    client: inv && inv.client ? inv.client.name : null,
    refundOpen: n.status === 'Issued' && Number(n.refundDue || 0) > 0.005 && !n.refundPaidOn ? R(n.refundDue) : 0,
  };
}

// ---------------------------------------------------------------------------
// DIRECT COSTS OF A PLACEMENT.
//   recruiter incentive — HRMS → Recruiter joinings (RecruiterJoiningDecision,
//                         one decision per recruiter per MONTH). An INCENTIVE
//                         decision's amount is shared equally over the
//                         joinings that month credited to that recruiter, by
//                         the module's own counting rule
//                         (utils/recruiterJoinings.js countedPlacements).
//   partner payout      — B7 agency / freelancer partners (utils/partners.js
//                         payoutCosts): the fee before GST of the live
//                         payouts for that placement; clawbacks negative.
// Returns { costs: Map applicationId -> { incentive, payout, incentiveStatus,
// incentiveMonth }, incentiveSource }. A placement in no decided month reads
// "Incentive not decided" (0).
// ---------------------------------------------------------------------------
// B7: partner payouts are real now — utils/partners.js payoutCosts() gives the
// fee before GST of every live payout (Draft / Approved / Paid; clawbacks
// negative) per application. Merged into the costs map after the incentives.
async function directCosts() {
  const r = await incentiveCosts();
  let payouts = new Map();
  try { payouts = await require('./partners').payoutCosts(); } catch { payouts = new Map(); } // eslint-disable-line global-require
  payouts.forEach((payout, appId) => {
    const cur = r.costs.get(appId) || { incentive: 0, payout: 0, incentiveStatus: 'Incentive not decided', incentiveMonth: null, decided: false };
    r.costs.set(appId, { ...cur, payout: R(payout) });
  });
  return { ...r, payoutSource: payouts.size ? 'PartnerPayout' : null };
}
async function incentiveCosts() {
  const costs = new Map();
  if (!hasModel('RecruiterJoiningDecision')) return { costs, incentiveSource: null };
  let decisions = [];
  try {
    decisions = await prisma.recruiterJoiningDecision.findMany({ select: { employeeId: true, month: true, decision: true } });
  } catch { return { costs, incentiveSource: null }; }
  const RJ = require('./recruiterJoinings'); // eslint-disable-line global-require
  if (typeof RJ.countedPlacements !== 'function') return { costs, incentiveSource: null };
  const decOf = new Map(decisions.map((d) => [`${d.employeeId}|${d.month}`, d.decision]));
  // Only months somebody has decided on can carry an incentive; every other
  // placement reads "Incentive not decided".
  const months = [...new Set(decisions.map((d) => d.month).filter(Boolean))].sort();
  for (const month of months) {
    let people = [];
    try { people = await RJ.countedPlacements(month); } catch { people = []; } // eslint-disable-line no-await-in-loop
    people.forEach((p) => {
      const ids = p.applicationIds || [];
      const dec = p.employeeId ? decOf.get(`${p.employeeId}|${month}`) : null;
      const each = p.incentive != null && ids.length ? R(Number(p.incentive) / ids.length) : 0;
      let st = 'Incentive not decided';
      if (p.incentive != null) st = `Incentive ${month}: ₹${R(p.incentive).toLocaleString('en-IN')} ÷ ${ids.length} joining(s)`;
      else if (dec === 'RAISE') st = `No incentive for ${month} — salary raise instead`;
      else if (dec) st = `No incentive for ${month}`;
      ids.forEach((id) => costs.set(id, {
        incentive: each, payout: 0, incentiveStatus: st, incentiveMonth: month, decided: !!dec,
      }));
    });
  }
  return { costs, incentiveSource: 'RecruiterJoiningDecision' };
}

// ---------------------------------------------------------------------------
// PLACEMENT MARGIN — one row per invoice (a placement), from the Invoices
// register rows themselves (routes/invoices.js buildRegister), so the fee,
// the credit notes and the attribution are the register's own:
//   Fee billed (before GST, as invoiced)
//   + debit notes (before GST) − credit notes (before GST)
//   = Net fee (= the register's Before GST after notes)
//   − recruiter incentive − partner payout
//   = Margin
// ---------------------------------------------------------------------------
async function marginRows(user) {
  const reg = await require('../routes/invoices').buildRegister(user, { period: 'all' }); // eslint-disable-line global-require
  const live = reg.rows.filter((r) => r.status !== 'Cancelled');
  const { costs, incentiveSource: src } = await directCosts();
  const rows = live.map((r) => {
    const fee = R(r.asBilled ? r.asBilled.billing : r.billing);
    const credit = R(r.noteCredit ? r.noteCredit.base : 0);
    const debit = R(r.noteDebit ? r.noteDebit.base : 0);
    const net = R(fee + debit - credit);
    const c = (r.applicationId && costs.get(r.applicationId)) || { incentive: 0, payout: 0, incentiveStatus: 'Incentive not decided', decided: false };
    const margin = R(net - c.incentive - c.payout);
    return {
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      invoiceDate: r.invoiceDate,
      month: r.invoiceMonth,
      monthLabel: r.invoiceMonthLabel,
      client: r.client,
      clientId: r.clientId,
      candidate: r.candidateName || null,
      role: r.role || null,
      department: r.department || '—',
      recruiter: r.recruiter || null,
      recruiterKey: r.recruiterKey || null,
      tl: r.tl || null,
      applicationId: r.applicationId || null,
      fee,
      credit,
      debit,
      net,
      incentive: R(c.incentive),
      payout: R(c.payout),
      incentiveStatus: c.incentiveStatus,
      incentiveDecided: !!c.decided,
      margin,
      marginPct: fee > 0 ? Math.round((margin / fee) * 1000) / 10 : null,
      notes: [...(r.noteCredit ? r.noteCredit.numbers : []), ...(r.noteDebit ? r.noteDebit.numbers : [])],
    };
  });
  return { rows, incentiveSource: src };
}

// ---------------------------------------------------------------------------
// B9.9 — "BILLED" NET OF ISSUED NOTES, for every screen that adds up
// Invoice.amount (the Accounts dashboard, the ATS dashboard Money panel,
// Clients, Office). decorateNet() stamps each invoice with netBilling /
// netGst / netTds / netReceivable / netPending — the STORED figure when the
// invoice has no note, so an invoice without a note never changes — and the
// *Of() readers fall back to the stored amount when a list was not decorated.
// Receipts and invoiceOutstanding() are untouched (they already take
// creditedAmount off).
// ---------------------------------------------------------------------------
async function decorateNet(invoices) {
  const list = (invoices || []).filter(Boolean);
  if (!list.length) return list;
  const notes = ready() ? await notesByInvoice(list.map((i) => i.id), { issuedOnly: true }) : new Map();
  list.forEach((i) => {
    const wn = TAX.withNotes(i, notes.get(i.id) || []);
    const recv = R(Number(i.amount || 0) + Number(i.gst || 0) - Number(i.tds || 0));
    i.netBilling = wn.hasNotes ? wn.billing : R(Number(i.amount || 0));
    i.netGst = wn.hasNotes ? wn.gst : R(Number(i.gst || 0));
    i.netTds = wn.hasNotes ? wn.tds : R(Number(i.tds || 0));
    i.netReceivable = wn.hasNotes ? wn.receivable : recv;
    i.netPending = wn.hasNotes ? wn.pending : R(recv - Number(i.receivedAmount || 0));
    i.hasNotes = wn.hasNotes;
  });
  return list;
}
const billedOf = (i) => (i && i.netBilling != null ? Number(i.netBilling) : Number((i && i.amount) || 0));
const gstBilledOf = (i) => (i && i.netGst != null ? Number(i.netGst) : Number((i && i.gst) || 0));
const tdsBilledOf = (i) => (i && i.netTds != null ? Number(i.netTds) : Number((i && i.tds) || 0));
const receivableOf = (i) => (i && i.netReceivable != null ? Number(i.netReceivable) : R(billedOf(i) + gstBilledOf(i) - tdsBilledOf(i)));
const pendingOf = (i) => (i && i.netPending != null ? Number(i.netPending) : R(receivableOf(i) - Number((i && i.receivedAmount) || 0)));

module.exports = {
  decorateNet,
  billedOf,
  gstBilledOf,
  tdsBilledOf,
  receivableOf,
  pendingOf,
  ready,
  NOT_READY,
  KIND_LABEL,
  STATUS,
  APPROVER_ONLY,
  notesByInvoice,
  isNoteApprover,
  nextNoteNumber,
  invoiceForApplication,
  shapeNote,
  directCosts,
  marginRows,
};
