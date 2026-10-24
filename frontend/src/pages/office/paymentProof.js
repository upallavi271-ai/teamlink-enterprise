// ---------------------------------------------------------------------------
// WHAT THE EXPENSE SCREENS SAY ABOUT A BILL'S PAYMENT PROOF (Accounts, 2026-10-19) - pure functions.
//
// The server decides (backend utils/expensePaymentState.js: the one truth table - bill + linked bank line +
// the line's own record of what it is filed against + amounts -> state, reason, proof). This file only maps
// that answer to words and colours. It never works out "paid" or "pending" itself, and it never treats a
// proof link as a payment: a link with no confirmation says so.
// ---------------------------------------------------------------------------

const TONE_CLASS = {
  green: 'oe-pay-green', amber: 'oe-pay-amber', red: 'oe-pay-red', grey: 'oe-pay-grey',
};

// The small note printed next to the status. Nothing for a plain bill (no link) or a paid bill whose line
// is matched - those need no explaining. A bill that is linked, part paid, waiting for "Mark as Paid",
// reversed, set aside or broken always says so.
export function payChip(payment) {
  if (!payment || !payment.state || payment.state === 'no_link') return null;
  if (payment.state === 'confirmed' && !payment.needsApprover && !payment.inconsistent) return null;
  const text = payment.short || payment.label;
  if (!text) return null;
  return { text, cls: `oe-pay ${TONE_CLASS[payment.tone] || TONE_CLASS.grey}`, title: payment.reason || '' };
}

// The "Proof of payment" row of the details. kind: 'none' (nothing linked: no row at all),
// 'valid' (a real line - "View line" is offered) or 'broken' (the link cannot be trusted - no "View line").
export function proofRow(payment) {
  const p = payment && payment.proof;
  if (!p || !p.has) return { kind: 'none' };
  if (!p.valid || !p.canView) {
    return {
      kind: 'broken', title: 'Proof link is broken', reason: p.brokenReason || 'that bank line cannot be used.',
    };
  }
  const ln = p.line || {};
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ln.date || ''));
  const when = m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : ln.date;
  const bits = ['Bank statement line', when, ln.reference ? `Ref ${ln.reference}` : null].filter(Boolean);
  return {
    kind: 'valid', title: bits.join(' · '), bankId: p.bankId, txnId: p.txnId, line: ln, note: payment.state === 'link_only' ? (payment.short || '') : '',
  };
}

// The Bank statement line window needs a table-style row first; the detail from
// /api/banks/:bankId/transactions/:txnId fills in the rest.
export function lineRowOf(proof) {
  const ln = proof.line || {};
  const out = ln.type !== 'Credit';
  return {
    id: proof.txnId,
    txnDate: ln.date || null,
    description: ln.description || '',
    debit: out ? Number(ln.amount) || 0 : 0,
    credit: out ? 0 : Number(ln.amount) || 0,
    balance: ln.balance == null ? null : Number(ln.balance),
    referenceNo: ln.reference || null,
    state: 'Unmatched',
  };
}

// The line the server returned must be exactly the one the bill points at.
export function sameLine(detail, proof) {
  return !!(detail && proof && detail.id && detail.id === proof.txnId);
}
