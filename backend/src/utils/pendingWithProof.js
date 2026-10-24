// ---------------------------------------------------------------------------
// "PENDING, BUT THERE IS PROOF" - the read-only scan (Accounts, 2026-10-21)
//
// Founder: "the data is showing the amount is Pending but there is proof attached to that, but there is no change in the status".
// This file walks EVERY kind of record that can carry proof next to an unpaid status, asks the one truth table of that kind
// (utils/expensePaymentState.js for bills we pay, utils/invoicePaymentState.js for invoices we raise) and sorts what it finds:
//
//   WRONG    the status must change: the proof is a confirmed, matched, full payment (or a recorded receipt) that the status
//            never followed. These - and only these - are what scripts/pending-with-proof-repair.js moves.
//   CORRECT  the proof is not a confirmed payment (a bill file is the bill itself, a link that is not matched, part payment,
//            reversed, a bare proof file with nothing recorded): the record stays as it is, and `why` says exactly why.
//
// It only READS (pure queries). Used by the repair script, the test and the Desktop review file.
// A bare proof file NEVER makes anything Paid.
// ---------------------------------------------------------------------------
const PS = require('./expensePaymentState');
const IPS = require('./invoicePaymentState');
const { invoiceOutstanding } = require('./accounts');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PAID_LIKE = ['PAID', 'REIMBURSED'];

// Columns of the Desktop review file.
const COLUMNS = ['kind', 'idOrCode', 'party', 'amount', 'shownStatus', 'proofAttached', 'whyStillPending', 'rootCauseClass', 'proposedStatus', 'verdict'];

async function tableCount(prisma, name) {
  try { const r = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${name}"`); return Number(r[0].n); } catch { return null; }
}

// ---- 1. office bills (money we pay) -------------------------------------------------------------------
async function scanOfficeBills(prisma) {
  const rows = [];
  const bills = await prisma.officeExpense.findMany({ orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }] });
  // the bank line's own record of which bill(s) it was filed against (so a bill that does not point back is also found)
  const lines = await prisma.bankTransaction.findMany({ where: { OR: [{ createdBillId: { not: null } }, { billLinks: { not: null } }] } });
  const lineOf = new Map();
  for (const t of lines) {
    const ids = new Set(t.createdBillId ? [t.createdBillId] : []);
    PS.links(t).forEach((l) => ids.add(l.id));
    ids.forEach((id) => { if (!lineOf.has(id)) lineOf.set(id, t); });
  }
  const candidates = bills.filter((b) => !PAID_LIKE.includes(PS.approvalOf(b)) && PS.approvalOf(b) !== 'REJECTED');
  const F = await PS.loadFacts(prisma, candidates);
  for (const b of bills) {
    const status = PS.approvalOf(b);
    if (status === 'REJECTED') continue;
    const code = b.expenseCode || b.id;
    const party = b.vendor || b.category || '';
    const net = PS.netOf(b);
    if (PAID_LIKE.includes(status)) continue; // the other direction (paid, proof weak) is counted in the dashboard's proof reminder
    const hasLink = !!b.bankTxnId;
    const filedLine = lineOf.get(b.id) || null;
    const hasDoc = !!(b.proofFile || b.proofName);
    if (!hasLink && !hasDoc && !filedLine) continue; // no proof of any kind: a plain pending bill
    const p = PS.judgeWith(b, F);
    let proofTxt;
    let why;
    let klass = 'CORRECT';
    let proposed = 'stays Pending';
    let root;
    let fix = null;
    if (hasLink) {
      proofTxt = p.proof.text || 'bank line link';
      if (p.state === 'confirmed') {
        klass = 'WRONG';
        proposed = 'PAID';
        root = 'matched before the 2026-10-19 rule: the old "Match bills" only moved a bill that was APPROVED (a status retired on 2026-10-05), so the bill stayed Pending';
        why = p.reason;
        fix = { type: 'office-paid', billId: b.id, txnId: b.bankTxnId };
      } else {
        root = { link_only: 'link is only a reference: the line is not filed against this bill', part: 'part payment: the line covers only part of the bill', reversed: 'bank payment was reversed', ignored: 'bank line set aside', broken: 'proof link is broken' }[p.state] || p.state;
        why = p.reason;
      }
    } else if (filedLine && !hasLink) {
      // the line says it is filed against this bill but the bill does not point back (should not happen)
      const asIf = { ...b, bankTxnId: filedLine.id };
      const q = PS.judge(asIf, { txn: filedLine, banks: F.banks, reversedBy: null, payoutOfBill: false });
      proofTxt = `bank line ${filedLine.date} ${filedLine.amount} (filed against this bill)`;
      root = 'the bank line is filed against this bill but the bill does not point back at it';
      why = q.reason;
      if (q.state === 'confirmed') { klass = 'WRONG'; proposed = 'PAID (and linked)'; fix = { type: 'office-paid', billId: b.id, txnId: filedLine.id, relink: true }; }
    } else {
      proofTxt = `bill file: ${b.proofName || 'uploaded file'}`;
      root = 'a file on a Pending bill is the BILL itself (the vendor invoice), not proof of payment';
      why = 'Not paid yet. The attached file is the vendor bill; payment proof is a matched bank line or the Mark as Paid press.';
    }
    rows.push({
      kind: 'Office bill', idOrCode: code, party, amount: net, shownStatus: status === 'PENDING' ? 'Pending' : status, proofAttached: proofTxt, whyStillPending: why, rootCauseClass: root, proposedStatus: proposed, verdict: klass, fix, ref: b.id, link: { billId: b.id },
    });
  }
  // an unpaid bill with a same-cash-amount twin that carries the bank line (duplicate-looking pair) - listed, never touched
  const dupes = [];
  const linkedBills = bills.filter((b) => b.bankTxnId && b.entryKind !== 'hand');
  for (const t of linkedBills) {
    const net = PS.netOf(t);
    for (const u of bills) {
      if (u.id === t.id || u.bankTxnId || PAID_LIKE.includes(PS.approvalOf(u)) || PS.approvalOf(u) === 'REJECTED') continue;
      if (Math.abs(PS.netOf(u) - net) > 1) continue;
      const near = Math.abs((Date.parse(u.expenseDate) - Date.parse(t.expenseDate)) / 86400000) <= 45;
      const sameParty = u.vendor && t.vendor && String(u.vendor).toLowerCase() === String(t.vendor).toLowerCase();
      if (near || sameParty) dupes.push({ pending: u, paidFromLine: t });
    }
  }
  return { rows, dupes, billCount: bills.length };
}

// ---- 2. client invoices (money we receive) -----------------------------------------------------------
async function scanInvoices(prisma) {
  const rows = [];
  const invs = await prisma.invoice.findMany({ include: { client: { select: { name: true } }, payments: true }, orderBy: { invoiceDate: 'asc' } });
  const matchedBy = new Map();
  (await prisma.bankTransaction.findMany({ where: { type: 'Credit', reconStatus: 'Matched', excluded: false, matchedInvoiceId: { not: null } } }))
    .forEach((t) => { if (!matchedBy.has(t.matchedInvoiceId)) matchedBy.set(t.matchedInvoiceId, []); matchedBy.get(t.matchedInvoiceId).push({ date: t.date, amount: t.amount }); });
  const credits = await prisma.bankTransaction.findMany({ where: { type: 'Credit', reconStatus: 'Unmatched', excluded: false } });
  for (const i of invs) {
    if (i.status === 'Cancelled') continue;
    const p = IPS.judge(i, { matchedLines: matchedBy.get(i.id) || [] });
    const code = i.invoiceNumber || i.id;
    const party = (i.client && i.client.name) || '';
    const left = Math.max(0, invoiceOutstanding(i));
    if (p.state === 'proof_only') {
      rows.push({
        kind: 'Client invoice', idOrCode: code, party, amount: left, shownStatus: i.status, proofAttached: p.proof.text, whyStillPending: p.reason, rootCauseClass: 'proof was attached (dashboard "Attach proof") but no receipt was recorded: a proof is never money by itself', proposedStatus: 'stays Pending (shows "Proof attached - payment not recorded yet" + Record payment)', verdict: 'CORRECT', fix: null, ref: i.id,
      });
    } else if (p.state === 'matched') {
      rows.push({
        kind: 'Client invoice (bank credit matched, not posted)', idOrCode: code, party, amount: left, shownStatus: i.status, proofAttached: `bank credit ${matchedBy.get(i.id)[0].date} Rs ${matchedBy.get(i.id)[0].amount} (Matched)`, whyStillPending: p.reason, rootCauseClass: 'the bank screen has two steps - Match, then Reconcile (post the receipt); only the receipt moves the invoice', proposedStatus: 'stays Pending until the line is Reconciled', verdict: 'CORRECT', fix: null, ref: i.id,
      });
    } else if (p.state === 'unrecorded') {
      rows.push({
        kind: 'Client invoice', idOrCode: code, party, amount: left, shownStatus: i.status, proofAttached: `${i.payments.length} receipt row(s) = ${ROUND(p.paysTotal)}`, whyStillPending: p.reason, rootCauseClass: 'receipt rows exist but Invoice.receivedAmount (which the status is derived from) was not brought up', proposedStatus: 'receivedAmount = receipts total; status re-derived', verdict: 'WRONG', fix: { type: 'invoice-received', invoiceId: i.id }, ref: i.id,
      });
    } else if (p.state === 'part' && (p.proof.bankLine || p.proof.file || p.proof.ref)) {
      rows.push({
        kind: 'Client invoice', idOrCode: code, party, amount: left, shownStatus: i.status, proofAttached: p.proof.text, whyStillPending: p.reason, rootCauseClass: 'part payment: the received money does not cover the invoice', proposedStatus: 'stays Partially Paid', verdict: 'CORRECT', fix: null, ref: i.id,
      });
    }
    // an UNMATCHED bank credit that names this invoice (or the client's name with the amount) - a hint only
    if (left > 0.5) {
      const no = String(i.invoiceNumber || '').toUpperCase();
      const first = String(party).toUpperCase().split(/\s+/)[0] || '';
      const hit = credits.filter((t) => {
        const d = String(t.description || '').toUpperCase();
        // the number must stand on its own in the narration (not the middle of an account / UPI number)
        const named = no.length >= 3 && new RegExp('(^|[^0-9A-Z])' + no.replace(/[^0-9A-Z]/g, (c) => '\\' + c) + '($|[^0-9A-Z])').test(d);
        return named || (first.length >= 4 && d.includes(first) && Math.abs(Number(t.amount) - left) <= left * 0.02);
      });
      for (const t of hit.slice(0, 3)) {
        rows.push({
          kind: 'Client invoice (bank credit not matched)', idOrCode: code, party, amount: left, shownStatus: i.status, proofAttached: `bank credit ${t.date} Rs ${t.amount} ${String(t.description).slice(0, 50)}`, whyStillPending: 'A bank credit that looks like this invoice is in the statement but is NOT matched to it, so nothing was received on the books. Match it in Bank & Reconciliation.', rootCauseClass: 'bank line not matched (a human has to match it)', proposedStatus: 'stays Pending until matched', verdict: 'CORRECT', fix: null, ref: i.id,
        });
      }
    }
  }
  // credit lines the bank screen calls Reconciled to an invoice that nevertheless received nothing
  const rec = await prisma.bankTransaction.findMany({ where: { type: 'Credit', reconStatus: 'Reconciled', matchedInvoiceId: { not: null } } });
  const byId = new Map(invs.map((x) => [x.id, x]));
  for (const t of rec) {
    const i = byId.get(t.matchedInvoiceId);
    if (!i || i.status === 'Cancelled') continue;
    const paid = (i.payments || []).some((x) => x.bankTxnId === t.id) || Number(i.receivedAmount || 0) > 0.5;
    if (!paid && invoiceOutstanding(i) > 0.5) {
      rows.push({
        kind: 'Client invoice (reconciled line, no receipt)', idOrCode: i.invoiceNumber || i.id, party: (i.client && i.client.name) || '', amount: Math.max(0, invoiceOutstanding(i)), shownStatus: i.status, proofAttached: `bank credit ${t.date} Rs ${t.amount} (Reconciled)`, whyStillPending: 'The bank screen says this credit is Reconciled to this invoice but no receipt exists on it.', rootCauseClass: 'reconciled line without a receipt row', proposedStatus: 'needs a person (allocation)', verdict: 'CORRECT', fix: null, ref: i.id,
      });
    }
  }
  return { rows, invoiceCount: invs.length };
}

// ---- 3. the other kinds (vendor bills, repair bills, payouts, id cards, HRMS) -----------------------------
// Each one asks the SAME question: a proof column filled while the status is still Pending / Unpaid.
const OTHER = [
  { kind: 'Vendor bill submission', table: 'VendorBillSubmission', proof: 'documentFile', pending: `"status" IN ('Pending','Submitted','Waiting for Accounts')`, party: 'vendorId', amount: 'amount', id: 'id' },
  { kind: 'Vendor module bill', table: 'VendorModuleBill', proof: 'documentFile', pending: `("status" IN ('Pending','Submitted','Waiting for Accounts')) AND "paidOn" IS NULL`, party: 'vendorId', amount: 'amount', id: 'id' },
  { kind: 'Partner payout', table: 'PartnerPayout', proof: 'bankTxnId', pending: `"status" NOT IN ('Paid','Cancelled')`, party: 'partnerId', amount: 'amount', id: 'id' },
  { kind: 'ID card order', table: 'IdCardOrder', proof: 'challanFile', pending: `"status" NOT IN ('Paid','Delivered','Cancelled')`, party: null, amount: null, id: 'id' },
  { kind: 'HRMS expense claim', table: 'EmployeeRecord', proof: 'billFile', pending: `"type"='EXPENSE' AND "status" IN ('Approved','Pending','Open')`, party: 'employeeId', amount: 'amount', id: 'id' },
  { kind: 'Salary payment', table: 'EmployeePayrollRun', proof: 'paymentReference', pending: `"status" IN ('DRAFT','APPROVED')`, party: 'employeeId', amount: null, id: 'id' },
];
async function scanOthers(prisma) {
  const rows = [];
  const counts = [];
  for (const o of OTHER) {
    const total = await tableCount(prisma, o.table);
    if (total === null) { counts.push({ kind: o.kind, table: o.table, total: 'table not present', proofWithPending: 0 }); continue; }
    let hit = [];
    let error = null;
    try {
      hit = await prisma.$queryRawUnsafe(`SELECT * FROM "${o.table}" WHERE (${o.pending}) AND "${o.proof}" IS NOT NULL AND "${o.proof}" <> ''`);
    } catch (e) { error = String(e.message || e).slice(0, 120); }
    counts.push({ kind: o.kind, table: o.table, total, proofWithPending: hit.length, error });
    for (const r of hit) {
      rows.push({
        kind: o.kind, idOrCode: r[o.id], party: o.party ? r[o.party] : '', amount: o.amount ? r[o.amount] : '', shownStatus: r.status || r.payStatus || '', proofAttached: String(r[o.proof]).slice(0, 60), whyStillPending: 'A proof field is filled while the status is not paid. Needs a person to look - these kinds have no automatic payment rule.', rootCauseClass: 'not auto-resolvable', proposedStatus: 'untouched', verdict: 'CORRECT', fix: null, ref: r[o.id],
      });
    }
  }
  return { rows, counts };
}

async function scanAll(prisma) {
  const office = await scanOfficeBills(prisma);
  const inv = await scanInvoices(prisma);
  const other = await scanOthers(prisma);
  const rows = [...office.rows, ...inv.rows, ...other.rows];
  return {
    rows,
    dupes: office.dupes,
    wrong: rows.filter((r) => r.verdict === 'WRONG'),
    summary: {
      officeBills: office.billCount, invoices: inv.invoiceCount, others: other.counts,
      wrongOffice: office.rows.filter((r) => r.verdict === 'WRONG').length,
      wrongInvoice: inv.rows.filter((r) => r.verdict === 'WRONG').length,
      correct: rows.filter((r) => r.verdict === 'CORRECT').length,
      duplicates: office.dupes.length,
    },
  };
}

module.exports = {
  COLUMNS, scanAll, scanOfficeBills, scanInvoices, scanOthers,
};
