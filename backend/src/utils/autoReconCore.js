// ---------------------------------------------------------------------------
// AUTO RECON CORE - confidence bands, tolerances and the safety rules that sit
// ON TOP of the exact matching ladder (utils/reconMatch.js). PURE FUNCTIONS:
// nothing here reads or writes the database.
//
//   HIGH    reliable and unambiguous. Applied automatically ONLY when an
//           Admin has switched "Auto-reconcile reliable matches" ON; otherwise
//           it is shown as a suggestion like everything else.
//   MEDIUM  one plausible record, or a small configured difference (rounding,
//           bank fee, TDS). Always waits for a person to approve.
//   LOW     several candidates, a hint, or nothing recognised. Review queue.
//
// Never auto-matched on amount alone (rule 4 hints are always LOW), never on a
// bill that has not finished its own approval, never when the line is flagged
// as a possible duplicate, never in a closed period.
// ---------------------------------------------------------------------------
const RM = require('./reconMatch');

const DEFAULT_SETTINGS = Object.freeze({
  autoReconcile: true, // ON by default (user, 2026-10-14): reliable matches are applied; an Admin can switch it OFF for suggest-only
  dateToleranceDays: 3, // bill date vs statement date
  roundingRupees: 1, // |bank - book| up to this = rounding
  bankFeeMaxRupees: 100, // a payment short by up to this = bank fee deducted
  tdsRates: [1, 2, 5, 10], // % a customer may have deducted
  batchSize: 200, // lines per background batch
});

function normaliseSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  s.autoReconcile = s.autoReconcile !== false;
  s.dateToleranceDays = Math.round(num(s.dateToleranceDays, 0, 15, DEFAULT_SETTINGS.dateToleranceDays));
  s.roundingRupees = num(s.roundingRupees, 0, 100, DEFAULT_SETTINGS.roundingRupees);
  s.bankFeeMaxRupees = num(s.bankFeeMaxRupees, 0, 5000, DEFAULT_SETTINGS.bankFeeMaxRupees);
  s.batchSize = Math.round(num(s.batchSize, 20, 1000, DEFAULT_SETTINGS.batchSize));
  const rates = Array.isArray(s.tdsRates) ? s.tdsRates.map(Number).filter((x) => Number.isFinite(x) && x > 0 && x <= 30) : DEFAULT_SETTINGS.tdsRates;
  s.tdsRates = [...new Set(rates)].sort((a, b) => a - b).slice(0, 8);
  return s;
}

const P = RM.toPaise;
const isDupText = (s) => /^(Possible duplicate|Identical to another)/.test(String(s || ''));
const APPROVED_BILL = new Set(['APPROVED', 'PAID', 'REIMBURSED']);

const CHARGE_RE = /\b(BANK\s*CHARGES?|SMS\s*(CHG|CHARGES?|ALERT)|ANNUAL\s*(FEE|MAINT)|AMC\s*CHARGES?|PROCESSING\s*FEE|MIN(IMUM)?\s*BAL(ANCE)?\s*(CHG|CHARGES?)|DEBIT\s*CARD\s*(FEE|CHG)|GST\s*(ON|@)|SERVICE\s*CHARGES?|CHQ\s*BOOK|CHEQUE\s*BOOK)\b/i;
const INTEREST_RE = /\b(INT\.?\s*(PD|PAID|CREDIT|CR)|CREDIT\s*INTEREST|INTEREST\s*(CREDIT|PAID|CR)|SAVINGS\s*INT|INT\s*ON\s*(FD|SB|SAVINGS))\b/i;
const SALARY_RE = /\b(SALARY|SAL\s*FOR|PAYROLL|WAGES)\b/i;
const GST_CHG_RE = /^\s*(SGST|CGST|IGST)\d*\b/i; // bank GST on its own charges, e.g. "SGST2026..."
const CASH_WDL_RE = /\b(CASH\s*WDL|CASH\s*WITHDRAWAL|ATM\s*(WDL|CASH)|SELF\s*CHQ)\b/i;
const CASH_DEP_RE = /\bCASH\s*DEP(OSIT)?\b/i;
const OWN_TRANSFER_RE =/\b(OWN\s*ACC(OUNT|T)?|SELF|SELF\s*TRANSFER|INTER\s*ACC(OUNT|T)?|ACCOUNT\s*TO\s*ACCOUNT|SWEEP|FUND\s*TRANSFER)\b/i;

const rupees = (p) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const blank = () => ({
  band: 'low', kind: 'none', rule: null, action: null, targetType: null, targetIds: [], targetLabel: null, party: null,
  bookAmount: null, allocated: null, difference: null, reasons: [], flags: [], candidates: null,
});

function closedPeriod(date, closedUpTo) {
  return !!(closedUpTo && date && String(date).slice(0, 7) <= closedUpTo); // closedUpTo is YYYY-MM
}

// The settle action for a list of {invoiceId, amount} parts.
const settleAction = (parts) => ({ type: 'settle', parts: parts.map((p) => ({ invoiceId: p.invoiceId, amount: p.amount })) });

function describeInvoices(ctx, parts) {
  const invs = parts.map((p) => ctx.invoices.find((i) => i.id === p.invoiceId)).filter(Boolean);
  return {
    label: invs.map((i) => i.invoiceNumber || i.id).join(', '),
    party: [...new Set(invs.map((i) => i.client && i.client.name).filter(Boolean))].join(', ') || null,
    bookP: invs.reduce((s, i) => s + Math.max(0, RM.outstandingP(i)), 0),
  };
}

// A payment a little short of ONE invoice: rounding / bank fee deducted / TDS. null when it is just a part payment.
function shortReason(inv, gapP, S) {
  if (gapP <= 0) return null;
  if (gapP <= P(S.roundingRupees)) return { flag: 'rounding', why: `short by ${rupees(gapP)} - within the ${S.roundingRupees} rupee rounding tolerance` };
  if (gapP <= P(S.bankFeeMaxRupees)) return { flag: 'bank-fee', why: `short by ${rupees(gapP)} - could be a bank fee deducted (limit ${S.bankFeeMaxRupees})` };
  const base = P(inv.amount);
  const rate = S.tdsRates.find((r) => Math.abs(Math.round(base * r / 100) - gapP) <= P(S.roundingRupees));
  if (rate) return { flag: 'tds', why: `short by ${rupees(gapP)} - equals TDS at ${rate}% of the invoice value` };
  return null;
}

// classify(txn, ctx, settings, env) -> one proposal-shaped object (no DB ids).
// env: { closedUpTo: 'YYYY-MM-DD' | null }
function classify(txn, ctx, settings, env = {}) {
  const S = normaliseSettings(settings);
  const amountP = P(txn.amount);
  const out = blank();
  const dec = RM.decide(txn, { ...ctx, toleranceDays: S.dateToleranceDays });
  const flags = [];
  if (isDupText(txn.reviewReason)) flags.push('potential-duplicate');
  if (closedPeriod(txn.date, env.closedUpTo)) flags.push('closed-period');
  out.rule = dec.rule || null;

  // ---------------------------------------------------------------- AUTO
  if (dec.confidence === 'auto') {
    const a = dec.action;
    out.reasons = [...(dec.evidence || [])];
    if (a.type === 'linkBill') {
      const b = ctx.expenses.find((e) => e.id === a.billId);
      out.kind = 'expense';
      out.targetType = 'expense';
      out.targetIds = [a.billId];
      out.targetLabel = b ? (b.expenseCode || b.billNumber || b.id) : a.billId;
      out.party = b ? (b.vendor || b.category) : null;
      out.bookAmount = b ? RM.expenseNetP(b) / 100 : null;
      out.allocated = amountP / 100;
      out.difference = b ? (amountP - RM.expenseNetP(b)) / 100 : null;
      out.action = { type: 'linkBill', billId: a.billId };
      if (b && !APPROVED_BILL.has(b.approvalStatus)) {
        flags.push('bill-not-approved');
        out.reasons.push('The bill is still Pending. An automatic run never marks it Paid; when an approver accepts this match, the bill is marked Paid (and the match is the approval). For anybody else the bill stays Pending and says "matched - waiting to be marked Paid".');
      }
      if (b && closedPeriod(b.paymentDate || b.expenseDate, env.closedUpTo)) flags.push('closed-period');
    } else if (a.type === 'linkPayment') {
      const pay = (ctx.payments || []).find((p) => p.id === a.paymentId);
      const inv = pay && ctx.invoices.find((i) => i.id === pay.invoiceId);
      out.kind = 'receipt-proof';
      out.targetType = 'invoice';
      out.targetIds = inv ? [inv.id] : [];
      out.targetLabel = dec.invoiceNumber || (inv && inv.invoiceNumber) || null;
      out.party = dec.client || null;
      out.bookAmount = pay ? Number(pay.amount) : null;
      out.allocated = pay ? Number(pay.amount) : null;
      out.difference = pay ? (amountP - P(pay.amount)) / 100 : null;
      out.action = { type: 'linkPayment', paymentId: a.paymentId };
    } else { // settle
      const d = describeInvoices(ctx, a.parts);
      const allocP = a.parts.reduce((s, p) => s + P(p.amount), 0);
      out.kind = 'invoice';
      out.targetType = 'invoice';
      out.targetIds = a.parts.map((p) => p.invoiceId);
      out.targetLabel = d.label;
      out.party = d.party || dec.client || null;
      out.bookAmount = d.bookP / 100;
      out.allocated = allocP / 100;
      out.difference = (amountP - allocP) / 100;
      out.action = settleAction(a.parts);
    }
    out.band = flags.length ? 'medium' : 'high';
    out.flags = flags;
    if (flags.includes('potential-duplicate')) out.reasons.push('This line is flagged as a possible duplicate - a person must confirm it first.');
    if (flags.includes('closed-period')) out.reasons.push('The date falls in a closed period - only an Admin may approve this.');
    return out;
  }

  // -------------------------------------------------------------- REVIEW
  if (dec.confidence === 'review') {
    out.reasons = [dec.reviewReason].filter(Boolean);
    out.kind = dec.kind || 'none';
    out.candidates = dec.candidates || null;
    const c = dec.candidates || {};
    const conflict = (dec.conflicts || []).some((cf) => !/amount is more than the invoice outstanding/.test(cf));
    if (dec.client) out.party = dec.client;

    // one invoice, rule 1-3: a person only has to say yes
    const equalBal = (c.invoiceIds || []).map((id) => ctx.invoices.find((i) => i.id === id)).filter((i) => i && RM.outstandingP(i) === amountP);
    const ambiguous = equalBal.length > 1; // several invoices of exactly this balance: a person must choose
    const oneInvoice = c.invoiceIds && c.invoiceIds.length === 1 && (dec.rule || 9) <= 3 && !conflict;
    if (txn.type === 'Credit' && !ambiguous && (oneInvoice || (dec.suggested && dec.suggested.parts && dec.suggested.parts.length && (dec.rule || 9) <= 3 && !conflict))) {
      let parts;
      if (dec.suggested && dec.suggested.parts && dec.suggested.parts.length && !oneInvoice) parts = dec.suggested.parts;
      else {
        const inv = ctx.invoices.find((i) => i.id === c.invoiceIds[0]);
        const take = Math.min(amountP, Math.max(0, inv ? RM.outstandingP(inv) : 0));
        parts = take > 0 ? [{ invoiceId: inv.id, amount: take / 100 }] : [];
      }
      if (parts.length) {
        const d = describeInvoices(ctx, parts);
        const allocP = parts.reduce((s, p) => s + P(p.amount), 0);
        out.targetType = 'invoice';
        out.kind = 'invoice';
        out.targetIds = parts.map((p) => p.invoiceId);
        out.targetLabel = d.label;
        out.party = d.party || out.party;
        out.bookAmount = d.bookP / 100;
        out.allocated = allocP / 100;
        out.difference = (amountP - allocP) / 100;
        out.action = settleAction(parts);
        out.band = 'medium';
        if (parts.length === 1) {
          const one = ctx.invoices.find((i) => i.id === parts[0].invoiceId);
          const sr = one ? shortReason(one, RM.outstandingP(one) - allocP, S) : null;
          if (sr) {
            out.difference = -(RM.outstandingP(one) - allocP) / 100;
            flags.push('amount-mismatch', sr.flag);
            out.reasons.push(`Invoice ${one.invoiceNumber || one.id} ${sr.why}. Approving records the money received; the remaining difference stays outstanding until an adjustment is approved.`);
          }
        }
        if (out.difference > 0) { flags.push('amount-mismatch'); out.reasons.push(`Bank amount is ${rupees(amountP)} but only ${rupees(allocP)} can be allocated; ${rupees(amountP - allocP)} would stay unallocated.`); }
        out.flags = flags;
        return out;
      }
    }
    // one bill, rule 1-3, amount within the rounding tolerance
    if (txn.type === 'Debit' && c.billIds && c.billIds.length === 1 && (dec.rule || 9) <= 3 && !conflict) {
      const b = ctx.expenses.find((e) => e.id === c.billIds[0]);
      if (b) {
        const diffP = amountP - RM.expenseNetP(b);
        out.kind = 'expense';
        out.targetType = 'expense';
        out.targetIds = [b.id];
        out.targetLabel = b.expenseCode || b.billNumber || b.id;
        out.party = b.vendor || b.category;
        out.bookAmount = RM.expenseNetP(b) / 100;
        out.allocated = amountP / 100;
        out.difference = diffP / 100;
        out.action = { type: 'linkBill', billId: b.id };
        if (diffP === 0 || Math.abs(diffP) <= P(S.roundingRupees)) {
          out.band = 'medium';
          if (diffP !== 0) { flags.push('amount-mismatch'); out.reasons.push(`Differs from the bill by ${rupees(Math.abs(diffP))} - within the ${S.roundingRupees} rupee rounding tolerance.`); }
          if (!APPROVED_BILL.has(b.approvalStatus)) { flags.push('bill-not-approved'); out.reasons.push('The bill is still Pending. An automatic run never marks it Paid; when an approver accepts this match, the bill is marked Paid (and the match is the approval). For anybody else the bill stays Pending and says "matched - waiting to be marked Paid".'); }
          out.flags = flags;
          return out;
        }
        out.band = 'low';
        flags.push('amount-mismatch');
        out.reasons.push(`Bank pays ${rupees(amountP)} but the bill is ${rupees(RM.expenseNetP(b))}: needs a person.`);
        out.action = null;
        out.flags = flags;
        return out;
      }
    }
    if ((dec.rule || 9) === 4 && !conflict) {
      const x = noneBranch();
      if (x.band === 'medium') return x;
    }
    out.band = 'low';
    out.flags = flags;
    return out;
  }

  // Things the exact ladder does not look at: tolerance cases, cash, own transfers, bank charges / interest, salary.
  // (a hoisted function: the REVIEW branch above also asks it when the ladder only had a rule-4 hint)
  function noneBranch() {
    const out = blank();
    out.rule = dec.rule || null;
    // Things the exact ladder does not look at: tolerance cases, own transfers,
    // bank charges / interest, salary.
    const narr = `${txn.description || ''} ${txn.reference || ''}`;
    const narrNorm = RM.norm(narr);
    const named = txn.type === 'Credit' ? RM.clientNamed(narrNorm, ctx) : null;
    if (txn.type === 'Credit' && named && !named.ambiguous) {
      // client named, amount a little short of ONE open invoice: rounding / bank fee / TDS
      const theirs = ctx.invoices.filter((i) => i.clientId === named.clientId && RM.isOpen(i));
      const shorts = [];
      theirs.forEach((i) => {
        const o = RM.outstandingP(i);
        const gap = o - amountP;
        if (gap <= 0) return;
        let why = null;
        if (gap <= P(S.roundingRupees)) why = `short by ${rupees(gap)} - within the ${S.roundingRupees} rupee rounding tolerance`;
        else if (gap <= P(S.bankFeeMaxRupees)) why = `short by ${rupees(gap)} - could be a bank fee deducted (limit ${S.bankFeeMaxRupees})`;
        else {
          const base = P(i.amount);
          const rate = S.tdsRates.find((r) => Math.abs(Math.round(base * r / 100) - gap) <= P(S.roundingRupees));
          if (rate) why = `short by ${rupees(gap)} - equals TDS at ${rate}% of the invoice value`;
        }
        if (why) shorts.push({ inv: i, gap, why, outP: o });
      });
      if (shorts.length === 1) {
        const x = shorts[0];
        out.kind = 'invoice';
        out.targetType = 'invoice';
        out.targetIds = [x.inv.id];
        out.targetLabel = x.inv.invoiceNumber || x.inv.id;
        out.party = x.inv.client ? x.inv.client.name : null;
        out.bookAmount = x.outP / 100;
        out.allocated = amountP / 100;
        out.difference = -x.gap / 100;
        out.action = settleAction([{ invoiceId: x.inv.id, amount: amountP / 100 }]);
        out.band = 'medium';
        flags.push('amount-mismatch');
        out.flags = flags;
        out.reasons = [`Client "${x.inv.client ? x.inv.client.name : ''}" is named in the narration`, `Invoice ${x.inv.invoiceNumber || x.inv.id} ${x.why}`, 'Approving records the money received; the remaining difference stays outstanding until an adjustment is approved.'];
        return out;
      }
      if (shorts.length > 1) {
        out.kind = 'invoice';
        out.reasons = [`${shorts.length} open invoices of ${named.clientId ? 'this client' : ''} are a small amount above this payment - pick which one`];
        out.candidates = { invoiceIds: shorts.map((s) => s.inv.id) };
        out.flags = flags;
        return out;
      }
    }
    if (txn.type === 'Debit' && CASH_WDL_RE.test(narr)) {
      out.kind = 'cash';
      out.targetType = 'category';
      out.targetLabel = 'Cash withdrawal';
      out.party = 'Cash';
      out.band = 'medium';
      out.action = { type: 'tag', categoryKind: 'other', category: 'Cash withdrawal' };
      out.reasons = ['The narration reads like a cash withdrawal', 'Approving files this line as Cash withdrawal (money moved to cash in hand: not an expense yet; no bill is created)'];
      out.flags = flags;
      return out;
    }
    if (txn.type === 'Credit' && CASH_DEP_RE.test(narr) && !named) {
      out.kind = 'cash';
      out.targetType = 'category';
      out.targetLabel = 'Cash deposit';
      out.party = 'Cash';
      out.band = 'medium';
      out.action = { type: 'tag', categoryKind: 'other', category: 'Cash deposit' };
      out.reasons = ['The narration reads like cash paid into the bank and no customer is named', 'Approving files this line as Cash deposit (not income from a customer). If it is a customer payment, match it to the invoice instead.'];
      out.flags = flags;
      return out;
    }
    if (txn.type === 'Debit' && (CHARGE_RE.test(narr) || GST_CHG_RE.test(narr)) && !SALARY_RE.test(narr)) {
      out.kind = 'charge';
      out.targetType = 'category';
      out.targetLabel = 'Bank charges';
      out.party = 'Bank';
      out.band = 'medium';
      out.action = { type: 'tag', categoryKind: 'other', category: 'Bank charges' };
      out.reasons = ['The narration reads like a bank charge or fee', 'Approving files this line as Bank charges (no invoice or bill is created)'];
      out.flags = flags;
      return out;
    }
    if (txn.type === 'Credit' && INTEREST_RE.test(narr)) {
      out.kind = 'charge';
      out.targetType = 'category';
      out.targetLabel = 'Bank interest';
      out.party = 'Bank';
      out.band = 'medium';
      out.action = { type: 'tag', categoryKind: 'other', category: 'Bank interest' };
      out.reasons = ['The narration reads like interest credited by the bank', 'Approving files this line as Bank interest (not revenue from a customer)'];
      out.flags = flags;
      return out;
    }
    if (txn.type === 'Debit' && SALARY_RE.test(narr)) {
      out.kind = 'salary-hint';
      out.reasons = ['Reads like a salary payment. Matching it to payroll is limited to users who may see payroll - no payroll detail is shown here.'];
      out.flags = flags;
      return out;
    }
    if (OWN_TRANSFER_RE.test(narr)) {
      out.kind = 'transfer-hint';
      out.reasons = ['The narration mentions an own-account transfer, but no opposite line of the same amount was found on another account.'];
      out.flags = flags;
      return out;
    }
    out.reasons = [dec.why || 'Nothing recognised: no reference, invoice number, client or vendor.'];
    out.flags = flags;
    return out;
  }
  return noneBranch();
}

// A transfer pair: the same amount leaving one own account and arriving in another.
function transferProposal(txn, peer, S, otherName) {
  const out = blank();
  out.kind = 'transfer';
  out.targetType = 'transfer';
  out.targetIds = [peer.id];
  out.targetLabel = `Own transfer (${txn.type === 'Debit' ? 'to' : 'from'} ${otherName || 'other account'})`;
  out.party = 'Own account';
  out.bookAmount = Number(txn.amount);
  out.allocated = Number(txn.amount);
  out.difference = 0;
  out.band = 'medium';
  out.action = { type: 'tag', categoryKind: 'transfer', category: null, peerId: peer.id };
  out.reasons = [
    `Opposite line of exactly ${rupees(P(txn.amount))} on ${peer.date} on another own bank account`,
    OWN_TRANSFER_RE.test(`${txn.description} ${txn.reference}`) ? 'The narration also says it is an own-account transfer' : 'Approving marks both lines as an internal transfer: not income, not an expense',
  ];
  return out;
}

module.exports = {
  DEFAULT_SETTINGS, normaliseSettings, classify, transferProposal, closedPeriod, isDupText, APPROVED_BILL, blank, OWN_TRANSFER_RE,
};
