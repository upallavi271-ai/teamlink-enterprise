// ---------------------------------------------------------------------------
// WHICH BANK'S STATEMENT IS THIS FILE? (founder 2026-10-29: "HDFC and ICICI statements import chesam kani anni HDFC ani chupistundi")
//
// The import used to put a file into whichever account was selected on the Bank screen, so six ICICI statements landed in the HDFC
// account. Each bank's download has its own column names; when they say clearly which bank it is, the import checks the account:
//   ICICI  "Tran. Id" + "Transaction Remarks" (+ "Withdrawal Amt (INR)" / "Transaction Posted Date")
//   HDFC   "Narration" + "Chq./Ref.No." + "Closing Balance" (+ "Value Dt")
// Anything else = null (not recognised): nothing is refused for it. Pure functions, no database.
// ---------------------------------------------------------------------------
const key = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const SIGNATURES = [
  { bank: 'ICICI', all: ['tran id', 'transaction remarks'], any: ['withdrawal amt inr', 'transaction posted date', 'deposit amt inr'] },
  { bank: 'HDFC', all: ['narration', 'chq ref no', 'closing balance'], any: ['value dt', 'withdrawal amt', 'deposit amt'] },
];

// column names (strings) -> 'ICICI' | 'HDFC' | null
function bankOfColumns(columns) {
  const have = new Set((columns || []).map(key).filter(Boolean));
  const hit = SIGNATURES.filter((s) => s.all.every((c) => have.has(c)) && s.any.some((c) => have.has(c)));
  return hit.length === 1 ? hit[0].bank : null;
}

// Does this bank account belong to that bank? (by the account's bank name: "ICICI Bank", "HDFC Bank Ltd" ...)
const accountIsBank = (account, bank) => !!(account && bank && new RegExp(`\\b${bank}\\b`, 'i').test(`${account.bank || ''} ${account.name || ''}`));

// The verdict for one file + the chosen account. accounts: every bank account (to name the right one).
function checkAccount(fileBank, account, accounts) {
  if (!fileBank || !account) return { fileBank: fileBank || null, ok: true };
  if (accountIsBank(account, fileBank)) return { fileBank, ok: true };
  const right = (accounts || []).filter((a) => accountIsBank(a, fileBank));
  const label = (a) => `${a.bank}${a.accNo ? ` ****${String(a.accNo).slice(-4)}` : ''}`;
  return {
    fileBank,
    ok: false,
    chosen: label(account),
    suggest: right.length === 1 ? { id: right[0].id, label: label(right[0]) } : null,
    message: `This is ${/^[AEIOU]/.test(fileBank) ? 'an' : 'a'} ${fileBank} statement, but it is being imported into ${label(account)}.${right.length === 1 ? ` Choose ${label(right[0])} instead.` : (right.length ? ` Choose the ${fileBank} account.` : ` Add the ${fileBank} account first (Bank & Reconciliation > Add bank).`)}`,
  };
}

module.exports = { bankOfColumns, accountIsBank, checkAccount, SIGNATURES };
