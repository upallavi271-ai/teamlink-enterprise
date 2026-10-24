// ---------------------------------------------------------------------------
// THE "BANK STATEMENT LINE" WINDOW - what it says, as pure functions (Accounts, 2026-10-17).
//
//   bankLineMessage()  the sentence in the bordered box: it explains that this bank line is the PROOF of the
//                      payment / receipt recorded for it, and the sentence changes with the kind of entry and with
//                      what is (or is not) filed. `kind` is the server's (backend utils/bankLineFiling.js).
//   lineModel()        the nine facts the window prints, from the table row + the line's detail. A fact that is
//                      missing prints an em dash - nothing is ever filled in.
//
// Words are plain on purpose (the people reading this are not accountants).
// ---------------------------------------------------------------------------
export const DASH = '—';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const has = (v) => v != null && String(v).trim() !== '';
export const orDash = (v) => (has(v) ? v : DASH);

// The kinds the server can name. Anything else still gets a sensible sentence (by money in / money out).
export const KINDS = [
  'invoice_receipt', 'salary', 'vendor_payment', 'expense', 'loan', 'refund', 'transfer', 'other',
  'reversed', 'ignored', 'unallocated', 'unmatched',
];

// tone: green = filed and proved, amber = not filed yet / needs a look, blue = filed but not income or expense.
export function bankLineMessage({
  direction, kind, unallocated = 0, party = '', loading = false, failed = false,
} = {}) {
  const incoming = direction === 'in';
  if (loading) return { tone: 'blue', title: 'Checking how this line is filed…', text: '' };
  if (failed) {
    return {
      tone: 'amber',
      title: 'The filing details could not be loaded.',
      text: `The date, narration, money and balance above are from the statement itself. Close this window and open the line again to retry.`,
    };
  }
  const who = has(party) ? party : '';
  switch (kind) {
    case 'invoice_receipt': {
      const left = Number(unallocated) > 0.005
        ? ` ${rupees(unallocated)} of this line is not filed against an invoice yet.`
        : '';
      return {
        tone: 'green',
        title: 'This is the proof of the receipt.',
        text: `The client's money reached the bank on this line, and it is recorded as a payment received against the invoice named in “Filed as”.${left}`,
      };
    }
    case 'salary':
      return {
        tone: 'green',
        title: 'This is the proof of the salary payment.',
        text: 'The money left the bank on this line, and it is recorded as salary paid. The statement is the record that it really went out.',
      };
    case 'vendor_payment':
      return {
        tone: 'green',
        title: 'This is the proof of the payment to the vendor.',
        text: `The money left the bank on this line, and it is recorded as paid to ${who || 'the vendor named in “Filed as”'}.`,
      };
    case 'expense':
      return {
        tone: 'green',
        title: 'This is the proof of the expense.',
        text: 'The money left the bank on this line, and it is recorded as an office expense under the heading named in “Filed as”.',
      };
    case 'loan':
      return {
        tone: 'green',
        title: incoming ? 'This is the proof of the loan money we took.' : 'This is the proof of the loan money we gave or repaid.',
        text: incoming
          ? 'The money reached the bank on this line, and it is recorded against the hand loan named in “Filed as”. It is not income.'
          : 'The money left the bank on this line, and it is recorded against the hand loan named in “Filed as”. It is not an expense.',
      };
    case 'refund':
      return {
        tone: 'green',
        title: 'This is the proof of the refund to the client.',
        text: 'The money left the bank on this line, and it is recorded as the refund due on the client’s credit note being paid back.',
      };
    case 'transfer':
      return {
        tone: 'blue',
        title: 'This is money moved between our own accounts.',
        text: 'It is not income and it is not an expense. The statement line is the record of the move.',
      };
    case 'other':
      return {
        tone: 'green',
        title: incoming ? 'This is the proof of the money received.' : 'This is the proof of the payment.',
        text: `The money ${incoming ? 'reached the bank' : 'left the bank'} on this line, and it is recorded as the entry named in “Filed as”.`,
      };
    case 'reversed':
      return {
        tone: 'amber',
        title: 'This receipt came back.',
        text: 'The money was returned (a bounced cheque or a payment sent back), so it no longer counts as received. The invoice owes it again.',
      };
    case 'ignored':
      return {
        tone: 'blue',
        title: 'This line is set aside.',
        text: 'It is kept on the statement but it is not counted anywhere in the accounts, so it is not the proof of any payment or receipt.',
      };
    case 'unallocated':
      return {
        tone: 'amber',
        title: 'Money came in, but it is not filed yet.',
        text: `${Number(unallocated) > 0.005 ? `${rupees(unallocated)} is` : 'This line is'} not matched to any invoice, so it is not counted as a payment received. Match it from Unallocated payments in Bank & Reconciliation; this line will then be its proof.`,
      };
    case 'unmatched':
      return {
        tone: 'amber',
        title: 'Money went out, but it is not filed yet.',
        text: 'This line is not filed under any expense, salary or vendor, so no payment is recorded for it yet. File it from Bank & Reconciliation; this line will then be its proof.',
      };
    default:
      return incoming
        ? { tone: 'blue', title: 'Money came in on this line.', text: 'This line is the bank’s record of the money received. Open Bank & Reconciliation to see how it is filed.' }
        : { tone: 'blue', title: 'Money went out on this line.', text: 'This line is the bank’s record of the money paid. Open Bank & Reconciliation to see how it is filed.' };
  }
}

// The window's facts. row = a Bank statements table row { id, txnDate, description, debit, credit, balance, referenceNo, state },
// bank = { name, last4 } of the bank button, detail = the line's detail (GET /banks/:bankId/transactions/:txnId) or null.
export function lineModel({
  row, bank, detail, loading = false, failed = false,
}) {
  const d = detail || null;
  const direction = d ? d.direction : (Number(row.credit) > 0 ? 'in' : 'out');
  const bankName = (d && d.bank && d.bank.name) || (bank && bank.bank) || (bank && bank.name) || null;
  const last4 = bank && bank.last4 ? `xxxx${String(bank.last4).slice(-4)}` : null;
  const account = (d && d.bank ? d.bank.account : null) || last4;
  const date = d ? d.date : row.txnDate;
  const filed = d && d.filedAs ? d.filedAs : null;
  const moneyOut = d ? d.moneyOut : (Number(row.debit) > 0 ? Number(row.debit) : null);
  const moneyIn = d ? d.moneyIn : (Number(row.credit) > 0 ? Number(row.credit) : null);
  return {
    direction,
    title: `Bank statement line · ${filed ? filed.label : (loading ? '…' : DASH)}`,
    subtitle: [orDash(bankName), orDash(account), orDash(date)],
    date: orDash(date),
    account: bankName ? `${bankName}${account ? ` · ${account}` : ''}` : DASH,
    narration: orDash(d ? d.narration : row.description),
    moneyOut: direction === 'out' ? (moneyOut != null ? moneyOut : null) : undefined, // undefined = the row is left out
    moneyIn: direction === 'in' ? (moneyIn != null ? moneyIn : null) : undefined,
    balanceAfter: d ? d.balanceAfter : (row.balance == null ? null : Number(row.balance)),
    filedAs: filed ? filed.label : (loading ? null : DASH),
    amountFiled: d ? d.amountFiled : null,
    loading,
    message: bankLineMessage({
      direction,
      kind: filed ? filed.kind : null,
      unallocated: d ? d.unallocated : 0,
      party: filed ? filed.label.split(' · ')[1] || '' : '',
      loading,
      failed,
    }),
  };
}
