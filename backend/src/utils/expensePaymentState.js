// ---------------------------------------------------------------------------
// THE ONE TRUTH TABLE FOR "IS THIS OFFICE BILL REALLY PAID?" (Accounts, 2026-10-19)
//
// An office bill (OfficeExpense) can carry a bank statement line (bankTxnId). That link is the PROOF of
// payment - it is never the payment itself. Before this file the screens only asked "is bankTxnId set?",
// so a bill that was linked to a line but never marked Paid still said just "Pending" next to a
// "Proof of payment ... View line" row, and nothing said why. Every API that returns a bill (the details,
// the table, the bank-line view, the dashboard) now asks THIS file, and the screen only prints the answer.
//
// WHAT IS PERSISTED (never changed here - this file only READS):
//   OfficeExpense.approvalStatus / paidStatus   the payment status (PAID = money out; PENDING = not yet)
//   OfficeExpense.bankTxnId                      the proof link
//   BankTransaction.createdBillId / billLinks    the line's own record of which bill(s) it was filed against
//   BankTransaction.reconStatus / excluded       the line's state (Ignored = set aside, Reversed = returned)
//   BankTransaction.reversalOfId                 a later line that reverses this one
//
// THE TABLE (first row that fits wins):
//   no link                       -> state "no_link"
//   line missing / money IN / its bank account missing
//                                 -> "broken"   the link is not trusted: no "View line", reason given
//   a later line reverses it      -> "reversed" the payment does not count
//   line set aside (Ignored)      -> "ignored"  the payment does not count
//   line not filed against THIS bill (no createdBillId / billLinks / partner payout points back)
//                                 -> "link_only" a link alone is not a match and not a payment
//   line smaller than the bill    -> "part"     Rs X of Y paid, the rest is the balance
//   otherwise                     -> "confirmed" the money left the bank and the line is matched to this bill
//
// STATUS stays what is stored. The answer only adds: a label, a tone, a plain reason, the paid / balance
// amounts, whether an approver still has to press "Mark as Paid" (confirmed + still Pending), and the proof
// block (valid? which bank + line to open?).
//
// Rounding is the bank screen's: net = bill (after GST) - TDS, a line within BANK_TOL rupees of it is a fit.
// ---------------------------------------------------------------------------
const { txnState } = require('./accounts');

const BANK_TOL = 20; // the same slack routes/bank.js matches with
const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const netOf = (e) => ROUND(Number(e.monthlyAmount || 0) - Number(e.tdsAmount || 0));
const PAID_LIKE = ['PAID', 'REIMBURSED'];
const approvalOf = (e) => (['PENDING', 'APPROVED', 'PAID', 'REJECTED', 'REIMBURSED'].includes(e.approvalStatus)
  ? e.approvalStatus : (e.paidStatus === 'Paid' ? 'PAID' : 'PENDING'));

const rs = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : String(iso || '—');
};
function links(txn) {
  if (!txn || !txn.billLinks) return [];
  try { const l = JSON.parse(txn.billLinks); return Array.isArray(l) ? l.filter((x) => x && x.id) : []; } catch { return []; }
}

// The bank screens' order: the first account on file owns the lines saved before accounts existed.
const firstBankId = (banks) => (banks && banks[0] ? banks[0].id : null);

// ---- the pure answer ------------------------------------------------------------------------------
// facts = { txn, banks, reversedBy, payoutOfBill }
//   txn          the BankTransaction row the bill points at (null = not found)
//   banks        every BankAccount, in the bank screens' order
//   reversedBy   a BankTransaction that reverses txn (or null)
//   payoutOfBill true when a PartnerPayout of this very bill points at txn (it files its own line)
function judge(e, facts = {}) {
  const p = judgeRaw(e, facts);
  const proof = { ...p.proof, text: proofTextOf(p, e) };
  return { ...p, short: shortOf(p), proof };
}
// THE PROOF COLUMN (founder, 2026-10-21: a bare "bank line" said nothing). One plain line, always from this table:
//   Bank line · 27 Aug · ₹15,000 · matched                 the money left the bank and the line is filed against this bill
//   Bank line · 7 Sep · ₹7,434 · matched, mark Paid        matched, but the bill still waits for an approver
//   Bank line linked · ... · not matched yet               a link is only a reference (it says so when the amount differs)
//   Bank line · ... · part (₹x of ₹y)                      the line covers only part of the bill
//   Bank line · ... · reversed / set aside, link broken    it does not count
function proofTextOf(p, e) {
  const pr = p.proof || {};
  if (!pr.has) return null;
  if (!pr.valid) return 'Bank line · link broken';
  const ln = pr.line || {};
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ln.date || ''));
  const when = m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]}` : null;
  const amt = ln.amount == null ? null : `₹${Number(ln.amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const head = ['Bank line', when, amt].filter(Boolean).join(' · ');
  if (p.state === 'reversed') return `${head} · reversed`;
  if (p.state === 'ignored') return `${head} · set aside`;
  if (p.state === 'link_only') {
    const diff = ln.amount != null && Math.abs(ROUND(ln.amount) - netOf(e)) > BANK_TOL;
    return `Bank line linked${when ? ` · ${when}` : ''}${amt ? ` · ${amt}` : ''} · ${diff ? `different amount (bill ${rs(netOf(e))}) · ` : ''}not matched yet`;
  }
  if (p.state === 'part') return `${head} · part (${rs(p.bankPaid)} of ${rs(p.due)})`;
  if (p.state === 'confirmed') return `${head} · ${p.needsApprover ? 'matched, mark Paid' : 'matched'}`;
  return head;
}
// The few words for a table pill / a dashboard cell.
function shortOf(p) {
  if (p.state === 'no_link') return p.paid ? 'Paid' : 'Pending';
  if (p.state === 'broken') return 'Proof link broken';
  if (p.state === 'reversed') return 'Bank payment reversed';
  if (p.state === 'ignored') return 'Bank line set aside';
  if (p.state === 'link_only') return 'Linked, not matched';
  if (p.state === 'part') return 'Part paid';
  return p.paid ? 'Paid' : 'Matched - mark Paid';
}
function judgeRaw(e, facts) {
  const status = approvalOf(e);
  const paid = PAID_LIKE.includes(status);
  const net = netOf(e);
  const base = {
    status, paid, due: net, bankPaid: 0, balance: paid ? 0 : net, needsApprover: false, inconsistent: false,
  };
  const noProof = {
    has: false, link: null, valid: false, canView: false, bankId: null, txnId: null, brokenReason: null, line: null, lineState: null, filed: false,
  };

  if (!e.bankTxnId) {
    return {
      ...base,
      state: 'no_link',
      label: paid ? 'Paid' : 'Not paid yet',
      tone: paid ? 'green' : 'grey',
      reason: paid ? 'Paid. No bank statement line is linked to this bill.' : 'Not paid yet. No bank statement line is linked to this bill.',
      proof: noProof,
    };
  }

  const { txn = null, banks = [], reversedBy = null, payoutOfBill = false } = facts;
  const proofOf = (o) => ({ ...noProof, has: true, link: e.bankTxnId, ...o });
  const broken = (why) => {
    // A broken link proves nothing: the bill keeps the status it has, flagged when it says Paid.
    const reason = paid
      ? `Marked Paid, but the proof link is broken: ${why}`
      : `Not paid. The bank line linked to this bill cannot be used: ${why}`;
    return {
      ...base,
      state: 'broken',
      label: 'Proof link is broken',
      tone: 'red',
      inconsistent: paid,
      reason,
      proof: proofOf({ brokenReason: why }),
    };
  };

  if (!txn) return broken('that bank line is no longer on file.');
  if (txn.type !== 'Debit') return broken('that line is money coming in, not a payment going out.');
  const bankId = txn.bankAccountId || firstBankId(banks);
  if (!bankId || !banks.some((b) => b.id === bankId)) return broken('the bank account that line belongs to is not on file.');

  const state = txnState(txn);
  const lineAmount = ROUND(txn.amount);
  const line = {
    id: txn.id, date: txn.date, description: txn.description || '', reference: txn.reference || null, amount: lineAmount, type: txn.type, balance: txn.balance == null ? null : ROUND(txn.balance),
  };
  const where = `${day(txn.date)}${txn.reference ? `, Ref ${txn.reference}` : ''}`;
  const proof = (extra = {}) => proofOf({
    valid: true, canView: true, bankId, txnId: txn.id, line, lineState: state, ...extra,
  });

  if (reversedBy || state === 'Reversed') {
    return {
      ...base,
      state: 'reversed',
      label: 'Bank payment was reversed',
      tone: 'red',
      inconsistent: paid,
      reason: paid
        ? `Marked Paid, but the bank line of ${where} was reversed (the money came back). It does not count as a payment.`
        : `Not paid. The bank line of ${where} was reversed (the money came back), so it does not count as a payment.`,
      proof: proof({ filed: false }),
    };
  }
  if (txn.excluded || state === 'Ignored') {
    return {
      ...base,
      state: 'ignored',
      label: 'Bank line is set aside',
      tone: 'amber',
      inconsistent: paid,
      reason: paid
        ? `Marked Paid, but the bank line of ${where} is set aside (not counted), so it is not proof of this payment.`
        : `Not paid. The bank line of ${where} is set aside (not counted), so it is not a payment.`,
      proof: proof({ filed: false }),
    };
  }

  const myLinks = links(txn);
  const mine = myLinks.find((l) => l.id === e.id);
  const filed = txn.createdBillId === e.id || !!mine || payoutOfBill;
  if (!filed) {
    return {
      ...base,
      state: 'link_only',
      label: 'Bank line linked - not matched',
      tone: 'amber',
      inconsistent: paid,
      reason: paid
        ? `Marked Paid. A bank line of ${where} is linked, but that line is not matched to this bill, so it is only a reference, not confirmation.`
        : `Not paid. A bank line of ${where} is linked, but it is not matched to this bill. A link on its own is not a payment - match the line to the bill first.`,
      proof: proof({ filed: false }),
    };
  }

  // The line is filed against this bill. How much of the bill does it cover?
  const lineNeeds = txn.createdBillId === e.id ? net : (myLinks.length ? ROUND(myLinks.reduce((s, l) => s + Number(l.net != null ? l.net : 0), 0)) || net : net);
  if (lineAmount + BANK_TOL < lineNeeds) {
    const part = Math.min(net, lineAmount);
    const bal = ROUND(Math.max(0, net - part));
    return {
      ...base,
      state: 'part',
      label: `Part paid: ${rs(part)} of ${rs(net)}`,
      tone: 'amber',
      bankPaid: part,
      balance: bal,
      inconsistent: paid,
      reason: paid
        ? `Marked Paid, but the bank line of ${where} is only ${rs(lineAmount)} against a bill of ${rs(net)}. ${rs(bal)} is not covered by the bank line.`
        : `Part paid: ${rs(part)} of ${rs(net)} has left the bank (line of ${where}). ${rs(bal)} is still to pay.`,
      proof: proof({ filed: true, lineState: 'Matched to this bill' }),
    };
  }

  if (paid) {
    return {
      ...base,
      state: 'confirmed',
      label: 'Paid - bank payment confirmed',
      tone: 'green',
      bankPaid: net,
      balance: 0,
      reason: `Paid. The bank line of ${where} shows ${rs(net)} left the bank and it is matched to this bill.`,
      proof: proof({ filed: true, lineState: 'Matched to this bill' }),
    };
  }
  // Confirmed money-out, matched to this bill, bill still Pending: only an approver can finish it.
  return {
    ...base,
    state: 'confirmed',
    label: 'Bank payment matched - waiting to be marked Paid',
    tone: 'amber',
    bankPaid: net,
    balance: 0,
    needsApprover: true,
    inconsistent: true,
    reason: `The bank line of ${where} shows ${rs(net)} left the bank and it is matched to this bill, but the bill is still Pending. An approver has to press "Mark as Paid" to confirm it.`,
    proof: proof({ filed: true, lineState: 'Matched to this bill' }),
  };
}

// ---- reading the facts (batch, so a table of 100 rows costs 4 queries) -------------------------------
async function loadFacts(prisma, expenses) {
  const list = (expenses || []).filter(Boolean);
  const ids = [...new Set(list.map((e) => e.bankTxnId).filter(Boolean))];
  const out = { txns: new Map(), banks: [], reversed: new Map(), payouts: new Set() };
  out.banks = await prisma.bankAccount.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!ids.length) return out;
  const [txns, rev, pay] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { id: { in: ids } } }),
    prisma.bankTransaction.findMany({ where: { reversalOfId: { in: ids } }, select: { id: true, reversalOfId: true } }).catch(() => []),
    prisma.partnerPayout.findMany({ where: { bankTxnId: { in: ids } }, select: { bankTxnId: true, expenseId: true } }).catch(() => []),
  ]);
  txns.forEach((t) => out.txns.set(t.id, t));
  rev.forEach((r) => out.reversed.set(r.reversalOfId, r));
  pay.forEach((p) => { if (p.expenseId) out.payouts.add(`${p.expenseId}|${p.bankTxnId}`); });
  return out;
}
function judgeWith(e, F) {
  return judge(e, {
    txn: e.bankTxnId ? (F.txns.get(e.bankTxnId) || null) : null,
    banks: F.banks,
    reversedBy: e.bankTxnId ? (F.reversed.get(e.bankTxnId) || null) : null,
    payoutOfBill: !!e.bankTxnId && F.payouts.has(`${e.id}|${e.bankTxnId}`),
  });
}
// Map<expenseId, answer> for many bills at once.
async function describeMany(prisma, expenses) {
  const F = await loadFacts(prisma, expenses);
  return new Map((expenses || []).filter(Boolean).map((e) => [e.id, judgeWith(e, F)]));
}
async function describeOne(prisma, expense) {
  if (!expense) return null;
  return (await describeMany(prisma, [expense])).get(expense.id);
}

// What the table shows next to the status, trimmed (the details view gets the whole answer).
function brief(p) {
  if (!p) return null;
  return {
    state: p.state,
    label: p.label,
    short: p.short,
    tone: p.tone,
    reason: p.reason,
    needsApprover: p.needsApprover,
    inconsistent: p.inconsistent,
    bankPaid: p.bankPaid,
    balance: p.balance,
    proof: {
      has: p.proof.has, valid: p.proof.valid, canView: p.proof.canView, bankId: p.proof.bankId, txnId: p.proof.txnId, brokenReason: p.proof.brokenReason, text: p.proof.text || null,
    },
  };
}

// ---- the write rule used when a bank line is matched to a bill -----------------------------------------
// What to store on a bill when `txn` is matched to it. The money has left the bank, so:
//   * a bill already PAID / REIMBURSED stays as it is (paidStatus kept "Paid");
//   * an old APPROVED bill (already signed off) becomes PAID when the line covers it; a bill still PENDING does so
//     only when the line covers it AND the person who matched it is an approver (the same people who may press "Mark as Paid" - for them a match is that press,
//     recorded as such, and "marking it paid is the approval" since Accounts spec S1.3c);
//   * anybody else's match links the line but leaves the bill Pending - the screen then says "waiting to be
//     marked Paid" and an approver finishes it. A link never pays a bill by itself.
// Returns { data, moved } - `data` is the update, `moved` true when the bill changes status.
function dataForMatch(bill, txn, user, canApprove, now = new Date()) {
  const data = { bankTxnId: txn.id, paymentDate: bill.paymentDate || String(txn.date).slice(0, 10) };
  const status = approvalOf(bill);
  const covers = ROUND(txn.amount) + BANK_TOL >= netOf(bill);
  let moved = false;
  if (PAID_LIKE.includes(status)) {
    data.paidStatus = 'Paid';
  } else if (covers && (status === 'APPROVED' || (status === 'PENDING' && canApprove))) {
    // an old APPROVED bill is already signed off - the line finishes it for anybody (as before); a PENDING one needs an approver
    Object.assign(data, {
      approvalStatus: 'PAID', paidStatus: 'Paid', paidAt: now, paidById: user.id,
    });
    if (status === 'PENDING') {
      Object.assign(data, { approvedById: user.id, approvedAt: now, approvedBy: user.name || user.email || null });
    }
    moved = true;
  }
  return { data, moved, from: status };
}

module.exports = {
  BANK_TOL, judge, loadFacts, judgeWith, describeMany, describeOne, brief, dataForMatch, netOf, approvalOf, links,
};
