const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const attachments = require('../utils/attachments');
const { GST_STATES, checkGstin } = require('../utils/gstin');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus,
  suggestInvoiceFor, txnState, toIsoDate, isOpenInvoice, normName,
} = require('../utils/accounts');
// P4 — the invoice's GST / TDS breakdown for the matching panel.
const TAX = require('../utils/invoiceTax');

const router = express.Router();
router.use(requireAuth);

router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Bank & Reconciliation', 'view'));

// VIEW != WRITE, AND THE API IS WHAT REFUSES.  (§20)
//
// The guard above is `view`, and `view` is exactly what a view-only Manager
// (§3) holds on Accounts. Every write in this router — import a statement,
// categorise, reconcile, post to a client, DELETE a bank account, delete an
// import batch, remove a transaction rule — was behind that one `view` guard
// and nothing else, so a hand-written POST or DELETE from a login that may
// only read the ledger would have succeeded.
//
// One guard, applied to every mutating method, rather than forty guards that
// can be forgotten on the forty-first route. A read stays a read.
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const requireBankWrite = requirePerm('accounts', 'accounts', 'Bank & Reconciliation', 'edit');
router.use((req, res, next) => {
  if (!WRITE_METHODS.includes(req.method)) return next();
  return requireBankWrite(req, res, next);
});

// ---------------------------------------------------------------------------
// The reconciliation state machine
//
//   Unmatched --match--> Matched --reconcile--> Reconciled
//        ^                  |                       |
//        |                  +------ unmatch --------+
//        |                  v
//        +--- unignore -- Ignored <-- ignore -- (Unmatched | Matched)
//
// A Reconciled line is closed: it cannot be re-matched or ignored. Unmatching
// it is the one way back, and that reverses the receipt it created.
// ---------------------------------------------------------------------------

// Rounding slack when matching an amount — banks and clients round differently.
// The accounting application calls this BANK_TOL and sets it to ₹20.
const BANK_TOL = 20;

function actor(req) {
  return req.user.name || req.user.email || 'Accounts';
}

// Lines another record leans on: an office bill made or settled from them, or
// a hand loan they prove. Removing one would leave that record pointing at
// nothing, so removal waits until the tie is undone.
async function tiedLines(txns) {
  if (!txns.length) return 0;
  const loanTies = await prisma.handLoanLink.count({ where: { bankTxnId: { in: txns.map((t) => t.id) } } });
  return loanTies + txns.filter((t) => t.createdBillId || t.billLinks).length;
}

async function loadTxn(id) {
  return prisma.bankTransaction.findUnique({ where: { id } });
}

// ---------------------------------------------------------------------------
// Bank accounts. Each one keeps its own statement, its own balance and its own
// opening figure. Lines imported before there were accounts carry no
// bankAccountId and belong to the first account on file.
// ---------------------------------------------------------------------------

async function ensureAccounts() {
  const list = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } });
  if (list.length) return list;
  const company = await prisma.company.findFirst().catch(() => null);
  const seeded = await prisma.bankAccount.create({
    data: {
      bank: 'HDFC Bank',
      name: company?.name || 'Current account',
      accNo: '',
      openBal: 0,
      openDate: '2026-04-01',
    },
  });
  return [seeded];
}

// Which account a line sits on, with the pre-accounts lines folded into the first.
const onAccount = (rows, accountId, firstId) => rows.filter(
  (t) => (t.bankAccountId || firstId) === accountId,
);

// Oldest first, which is the order a running balance has to be built in.
const oldestFirst = (rows) => [...rows].sort(
  (a, b) => String(a.date).localeCompare(String(b.date))
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    || String(a.id).localeCompare(String(b.id)),
);

const signed = (t) => (t.type === 'Credit' ? Number(t.amount || 0) : -Number(t.amount || 0));

// The opening balance nobody typed in: work it back from the first line that
// carries the bank's own printed balance. Without it the running total starts
// at zero and every line looks out by the same amount, which is exactly the
// confusion the accounting application's "Fix opening" button clears.
function impliedOpening(rows) {
  const ordered = oldestFirst(rows).filter((t) => t.balance != null);
  if (!ordered.length) return null;
  const first = ordered[0];
  return ROUND(Number(first.balance) - signed(first));
}

// Balance as the statement itself reports it — the closing balance on the last
// line that carried a balance column.
function statedBalance(rows) {
  const withBalance = oldestFirst(rows).filter((t) => t.balance != null);
  return withBalance.length ? ROUND(Number(withBalance[withBalance.length - 1].balance)) : null;
}

// The opening balance plus every line imported.
const booksBalance = (account, rows) => ROUND(
  Number(account?.openBal || 0) + rows.reduce((s, t) => s + signed(t), 0),
);

const balanceOn = (account, rows, date) => ROUND(
  Number(account?.openBal || 0)
  + rows.filter((t) => !date || String(t.date) <= date).reduce((s, t) => s + signed(t), 0),
);

// ---------------------------------------------------------------------------
// The matching engine, in the accounting application's own order. Every credit
// goes through these and stops at the first one that fits. The wording of each
// answer is the wording the screen prints.
// ---------------------------------------------------------------------------

const tightName = (s) => normName(s).replace(/ /g, '');

// How many client names share each word — a word in one or two names identifies
// a client, so it is worth double.
function clientDf(clients) {
  const df = {};
  clients.forEach((c) => {
    new Set(normName(c.name).split(' ').filter((w) => w.length >= 4))
      .forEach((w) => { df[w] = (df[w] || 0) + 1; });
  });
  return df;
}

// Reads the client out of the narration before it ever looks at the amount.
function readClient(description, clients, df) {
  const d = normName(description);
  if (!d) return null;
  let best = null;
  let bestScore = 0;
  clients.forEach((c) => {
    const words = [...new Set(normName(c.name).split(' ').filter((w) => w.length >= 4))];
    if (!words.length) return;
    let score = 0;
    words.forEach((w) => {
      // Bank narrations truncate — a five-letter prefix is enough to call it a hit.
      const hit = d.indexOf(w) >= 0 || (w.length >= 6 && d.indexOf(w.slice(0, 5)) >= 0);
      if (hit) score += ((df[w] || 9) <= 2 ? 2 : 1);
    });
    if (score > bestScore) { best = c; bestScore = score; }
  });
  if (bestScore >= 3) return best;
  // A cheque deposit often prints one word only — "CHQ DEP … : LORDS". If that
  // word is long and belongs to a single client, it is that client.
  let solo = null;
  let hits = 0;
  clients.forEach((c) => {
    const words = [...new Set(normName(c.name).split(' ').filter((w) => w.length >= 5))];
    if (words.some((w) => (df[w] || 9) <= 1 && d.indexOf(w) >= 0)) { hits += 1; solo = c; }
  });
  return hits === 1 ? solo : null;
}

// Spread one credit across a client's open invoices, oldest invoice first.
function allocationPlan(invoices, amount) {
  const open = invoices.filter(isOpenInvoice).sort(
    (a, b) => String(a.invoiceDate || '9999').localeCompare(String(b.invoiceDate || '9999'))
      || String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || '')),
  );
  let left = ROUND(amount);
  const parts = [];
  open.forEach((inv) => {
    if (left <= 0.5) return;
    const pending = invoiceOutstanding(inv);
    const take = Math.min(left, pending);
    parts.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber || inv.id.slice(-6),
      amount: ROUND(take),
      pending: ROUND(pending),
      invoiceDate: inv.invoiceDate || null,
    });
    left = ROUND(left - take);
  });
  return { parts, unallocated: ROUND(Math.max(0, left)) };
}

// What the app thinks a debit is, before anyone has said anything.
const CATZ_GUESS = [
  [/instaalertchg|alertchg|\bsms\b.*chg|chg.*\bsms\b|nwd.*chg|atm.*chg|\bamb\b.*chg|dpchgs|mabchg/i, 'Bank Fees and Charges'],
  [/salary|sal\b|payroll/i, 'Salary'],
  [/rent|workspace|coworking/i, 'Office Rent'],
  [/airtel|\bjio\b|vodafone|\bvi\b/i, 'Airtel Bill'],
  [/act ?fibernet|broadband|internet/i, 'Internet'],
  [/zoho/i, 'Zoho'],
  [/tata tele|tata tel|vicidial|ivr/i, 'Tata Vicidail'],
  [/shine|naukri|monster|hirist|portal/i, 'Portals'],
  [/whatsapp|gupshup|karix|msg91/i, 'WhatsApp'],
  [/charge|chrg|\bfee\b|comm\b|gst on|sms chg|\bamc\b|\bnach\b.*rtn|bounce/i, 'Bank Fees and Charges'],
  [/\bgstpmt\b|gst ?payment|gst ?challan|\bcpin\b|\bdrc\b/i, 'GST'],
  [/tds|194|24q|26q/i, 'TDS'],
  [/\bpf\b|epfo|provident/i, 'PF'],
  [/\besi\b|esic/i, 'ESI'],
  [/prof.*tax|\bpt\b/i, 'PT'],
  [/hosting|domain|godaddy|rify/i, 'Rify Hosting'],
  [/webmail|mail/i, 'Webmail'],
  [/^pos |\bpos \d|debit card|\becom\b/i, 'Card Spend'],
  [/bharat connect|\bcred\b|credit card|cc payment|billdesk/i, 'Credit Card Payment'],
  [/phonepe|paytm|gpay|google pay|bharatpe|razorpay/i, 'Wallet & UPI Spend'],
];

const CHART_OF_ACCOUNTS = {
  'Bank Fees and Charges': 'Expense',
  Salary: 'Expense',
  'Office Rent': 'Expense',
  Internet: 'Expense',
  Portals: 'Expense',
  'Airtel Bill': 'Expense',
  Zoho: 'Expense',
  'Tata Vicidail': 'Expense',
  WhatsApp: 'Expense',
  'Rify Hosting': 'Expense',
  Webmail: 'Expense',
  'Card Spend': 'Expense',
  'Credit Card Payment': 'Current Liability',
  'Wallet & UPI Spend': 'Expense',
  GST: 'Current Liability',
  TDS: 'Current Liability',
  PF: 'Current Liability',
  ESI: 'Current Liability',
  PT: 'Current Liability',
};
const coaGroupOf = (cat) => CHART_OF_ACCOUNTS[cat] || 'Expense';

const RULE_STOP = /^(the|and|for|from|upi|imps|neft|rtgs|ach|nach|inb|mb|ib|to|by|ref|txn|pmt|payment|transfer|fund|bank|ltd|pvt|india|dr|cr|no|na)$/i;

// The words worth remembering out of a bank narration.
function ruleWords(text) {
  return String(text || '').toUpperCase().split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !RULE_STOP.test(w));
}

function ruleHit(txn, rules) {
  const hay = `${normName(txn.description)} ${normName(txn.reference)}`;
  return rules.find((r) => {
    const q = normName(r.match);
    return q && q.length >= 3 && hay.indexOf(q) >= 0;
  }) || null;
}

// Our own money moving between our own accounts is neither income nor expense.
function ownTransfer(txn, ctx) {
  const hay = tightName(`${txn.description || ''} ${txn.reference || ''}`);
  const names = ctx.companyNames.map(tightName).filter((x) => x.length > 7);
  if (names.some((n) => hay.indexOf(n.slice(0, 14)) >= 0)) return 'our own name is on this line';
  const accs = ctx.accounts.map((b) => String(b.accNo || '').replace(/\D/g, '')).filter((a) => a.length >= 6);
  if (accs.some((a) => hay.indexOf(a) >= 0)) return 'one of our own account numbers is on this line';
  if (/self|own a\/c|own account|to own/i.test(txn.description || '')) return 'the bank marks it as a self transfer';
  return null;
}

// A plain person's name on a UPI or IMPS line — almost always a hand loan,
// never a client.
const PERSON_STOP = /\b(LTD|LIMITED|PVT|LLP|COLLEGE|INSTITUTE|UNIVERSITY|SCHOOL|HOSPITAL|CLINIC|SOCIETY|TRUST|ACADEMY|TECHNOLOGIES|SOLUTIONS|ENTERPRISES|SERVICES|INDIA|BANK|STORES|TEXTILES|MEDICARE|HEALTH|ENGINEERING|SCIENCES|CONSULTANTS|CORPORATION|COMPANY|INDUSTRIES|MEDIA|WORKSPACES|HOSTING|BHARAT|CONNECT|CRED|PHONEPE|PAYTM|GPAY|BHARATPE|RAZORPAY|BILLDESK|RECHARGE|ELECTRICITY|INSURANCE|MUTUAL|FUND|TAX|GST|TDS|EPFO|ESIC)\b/i;

function personName(txn, ctx) {
  const d = String(txn.description || '').toUpperCase();
  const m = /^UPI-([A-Z][A-Z .]{4,40}?)-/.exec(d)
    || /^IMPS-\d+-([A-Z][A-Z .]{4,40}?)-/.exec(d)
    || /^(?:NEFT|RTGS)\s*(?:DR|CR)?-[A-Z]{4}\d{5,}-([A-Z][A-Z .]{4,40}?)-/.exec(d);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim();
  if (name.length < 5 || PERSON_STOP.test(name)) return null;
  if (/^\d|X{3,}/.test(name)) return null;
  const words = name.split(' ').filter(Boolean);
  if (words.length === 1 && name.length < 8) return null;
  if (words.length === 1 && /(COM|ONLINE|MART|STORE|SHOP|TECH|APP|PAY|CART|KART|FOODS|TRADERS)$/i.test(name)) return null;
  if (words.length > 4) return null;
  if (readClient(txn.description, ctx.clients, ctx.df)) return null; // a known client wins
  if (ctx.vendors.some((v) => tightName(name).indexOf(tightName(v).slice(0, 8)) >= 0)) return null;
  return name.replace(/\b([A-Z])([A-Z]+)/g, (x, a, b) => a + b.toLowerCase());
}

// What the app thinks a line is, before anyone has said anything.
function catzGuess(txn, ctx) {
  const rule = ruleHit(txn, ctx.rules.filter((r) => r.kind !== 'client'));
  if (rule) {
    return {
      kind: rule.kind || 'expense',
      category: rule.category,
      vendor: rule.vendor || '',
      gstRate: rule.gstRate,
      why: `rule "${rule.match}"`,
      rule: true,
    };
  }
  const hay = `${txn.description || ''} ${txn.reference || ''}`;
  const own = ownTransfer(txn, ctx);
  if (own) return { kind: 'transfer', category: '', why: own };
  const person = personName(txn, ctx);
  if (person) return { kind: 'hand', party: person, category: '', why: `"${person}" reads like a person, not a business` };
  if (/cash (deposit|dep)\b|cdm|\bcash\b.*deposit/i.test(hay) && txn.type === 'Credit') {
    return { kind: 'hand', party: 'Cash deposited by us', category: '', why: 'cash paid into the account, not a client receipt' };
  }
  const vendor = ctx.vendors.find((v) => tightName(hay).indexOf(tightName(v).slice(0, 10)) >= 0);
  if (vendor) {
    const last = ctx.expenses.filter((e) => tightName(e.vendor) === tightName(vendor)).slice(-1)[0];
    return { kind: 'expense', category: (last && last.category) || '', vendor, gstRate: null, why: `paid ${vendor} before` };
  }
  const guess = CATZ_GUESS.find(([re]) => re.test(hay));
  if (guess) return { kind: 'expense', category: guess[1], vendor: '', gstRate: null, why: `the narration says "${guess[1]}"` };
  const amount = ROUND(txn.amount);
  if (/\bepr\d{6,}/i.test(hay) && txn.type === 'Debit' && amount < 200) {
    return { kind: 'expense', category: 'Bank Fees and Charges', vendor: '', gstRate: null, why: "a few rupees with the bank's own EPR reference — a charge" };
  }
  return null;
}

// The tag each answer prints, in the accounting application's own words.
const KIND_TAG = {
  already: 'already in books',
  possible: 'possible match',
  sure: 'client named',
  named: 'client named',
  amount: 'amount only — check',
  client: 'check invoice',
  many: 'several match',
  expense: 'office expense',
  hand: 'hand loan',
  transfer: 'our own transfer',
  none: 'no match',
};
const KIND_CLASS = {
  already: '', possible: 'priority-medium', sure: 'priority-low', named: 'priority-low', amount: 'priority-medium',
  client: 'priority-medium', many: 'priority-medium', expense: '', hand: '', transfer: '', none: 'priority-high',
};

const fmtMoney = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// A credit that names the INVOICE (Accounts spec 3 part 3): its number, or the
// candidate it was raised for ("invoice name"), compared with case, spaces and
// punctuation ignored — and always checked against the amount.
//
//   clear    = one open invoice, the amount fits inside what is pending, and
//              the number is unmistakable (letters + digits), or a bare-number
//              / candidate-name hit backed by the exact amount or the client's
//              name  ->  linked and posted automatically
//   possible = anything else the narration points at  ->  waits for a person
// ---------------------------------------------------------------------------
function invoiceNumberHit(inv, words, hay) {
  const n = normName(inv.invoiceNumber);
  const t = n.replace(/ /g, '');
  if (t.length < 3) return null;
  const token = ` ${words} `.indexOf(` ${n} `) >= 0;
  if (/[A-Z]/.test(t) && /\d/.test(t) && t.length >= 5 && (token || hay.indexOf(t) >= 0)) return 'strong';
  return token ? 'weak' : null; // a bare number standing as its own word
}

function readInvoiceNamed(txn, ctx, named) {
  const amount = ROUND(txn.amount);
  const words = normName(`${txn.description || ''} ${txn.reference || ''}`);
  const hay = words.replace(/ /g, '');
  const noOf = (i) => i.invoiceNumber || i.id.slice(-6);
  const hits = [];
  ctx.invoices.forEach((i) => {
    if (!isOpenInvoice(i)) return;
    const num = i.invoiceNumber ? invoiceNumberHit(i, words, hay) : null;
    const cand = tightName(i.candidate?.name);
    const byName = cand.length >= 8 && hay.indexOf(cand) >= 0;
    if (!num && !byName) return;
    const out = invoiceOutstanding(i);
    const fits = amount <= out + BANK_TOL;
    const exact = Math.abs(out - amount) <= BANK_TOL;
    const clientOk = !!named && named.id === i.clientId;
    const clear = fits && (num === 'strong' || (num === 'weak' && (exact || clientOk)) || (byName && (exact || clientOk)));
    hits.push({ inv: i, num, byName, fits, exact, clear });
  });
  if (!hits.length) return null;
  const clears = hits.filter((h) => h.clear);
  if (clears.length === 1) {
    const { inv: i, num, exact } = clears[0];
    const pending = invoiceOutstanding(i);
    const take = ROUND(Math.min(amount, pending));
    return {
      kind: 'sure',
      clear: true,
      via: 'invoice',
      client: i.client?.name || null,
      clientId: i.clientId,
      invoiceId: i.id,
      invoiceNumber: noOf(i),
      amount,
      plan: { parts: [{ invoiceId: i.id, invoiceNumber: noOf(i), amount: take, pending, invoiceDate: i.invoiceDate || null }], unallocated: ROUND(Math.max(0, amount - take)) },
      options: [i.id],
      why: `Narration carries ${num ? `invoice ${noOf(i)}` : `${i.candidate?.name}, billed on ${noOf(i)}`}${exact
        ? ' and the amount clears it exactly'
        : ` — ${fmtMoney(amount)} of the ${fmtMoney(pending)} pending, a part payment`}`,
    };
  }
  const list = hits.map((h) => h.inv);
  const one = list.length === 1 ? list[0] : null;
  return {
    kind: 'possible',
    clear: false,
    amount,
    options: list.map((i) => i.id),
    client: one ? one.client?.name || null : null,
    clientId: one ? one.clientId : null,
    invoiceId: one ? one.id : null,
    invoiceNumber: one ? noOf(one) : '',
    why: one
      ? `Narration mentions ${hits[0].num ? `invoice ${noOf(one)}` : `${one.candidate?.name} (invoice ${noOf(one)})`}${hits[0].fits
        ? ' but not clearly enough to post on its own — confirm it'
        : `, but ${fmtMoney(amount)} is more than the ${fmtMoney(invoiceOutstanding(one))} pending`}`
      : `Narration mentions ${list.length} invoices (${list.map(noOf).join(', ')}) — pick the right one`,
  };
}

// Step 1..5 for a credit.
function readCreditLine(txn, ctx) {
  const amount = ROUND(txn.amount);
  const refn = `${normName(txn.reference)} ${normName(txn.description)}`;

  // 1 — already recorded: a payment with the same reference, or the same
  //     amount on the same day. A receipt found by its reference that no bank
  //     line backs yet is a CLEAR match: the line becomes its proof and no
  //     second receipt is ever written (linkPayment below).
  const byRef = ctx.payments.find((p) => {
    const pr = normName(p.reference);
    return !!(pr && pr.length > 5 && refn.indexOf(pr) >= 0);
  });
  const already = byRef || ctx.payments.find((p) => Math.abs(Number(p.amount || 0) - amount) <= BANK_TOL && String(p.date) === String(txn.date));
  if (already) {
    const inv = ctx.invoices.find((i) => i.id === already.invoiceId);
    const free = !already.bankTxnId || already.bankTxnId === txn.id;
    return {
      kind: 'already',
      clear: !!byRef && free && Math.abs(Number(already.amount || 0) - amount) <= BANK_TOL,
      paymentId: already.id,
      invoiceId: already.invoiceId,
      client: inv?.client?.name || null,
      clientId: inv?.clientId || null,
      invoiceNumber: inv?.invoiceNumber || null,
      amount,
      why: `Already recorded as a payment on ${already.date}${free ? (byRef ? ' with this reference — link this line as its proof' : ' for the same amount — link it as proof if it is the same money') : ''}`,
    };
  }

  // 2 — who the narration names: the client (by name) and, before anything
  //     else, the invoice itself (by number, or by the candidate billed).
  const named = txn.clientName
    ? ctx.clients.find((c) => c.name === txn.clientName)
    : (readClient(txn.description, ctx.clients, ctx.df) || ruleClient(txn, ctx));
  const byInvoice = readInvoiceNamed(txn, ctx, named);
  if (byInvoice) return byInvoice;
  const open = ctx.invoices.filter(isOpenInvoice);
  if (named) {
    const theirs = open.filter((i) => i.clientId === named.id);
    const exacts = theirs.filter((i) => Math.abs(invoiceOutstanding(i) - amount) <= BANK_TOL);
    // Clear: exactly one of their open invoices is for this amount — or they
    // owe on one invoice only and this fits inside it (a part payment).
    const exact = exacts.length === 1 ? exacts[0]
      : (!exacts.length && theirs.length === 1 && amount <= invoiceOutstanding(theirs[0]) + BANK_TOL ? theirs[0] : null);
    if (exact) {
      const isExact = Math.abs(invoiceOutstanding(exact) - amount) <= BANK_TOL;
      const take = ROUND(Math.min(amount, invoiceOutstanding(exact)));
      return {
        kind: 'sure',
        clear: true,
        via: 'client',
        client: named.name,
        clientId: named.id,
        invoiceId: exact.id,
        invoiceNumber: exact.invoiceNumber || exact.id.slice(-6),
        amount,
        plan: {
          parts: [{ invoiceId: exact.id, invoiceNumber: exact.invoiceNumber || exact.id.slice(-6), amount: take, pending: invoiceOutstanding(exact), invoiceDate: exact.invoiceDate || null }],
          unallocated: ROUND(Math.max(0, amount - take)),
        },
        options: theirs.map((i) => i.id),
        why: isExact
          ? `Narration names ${named.name} and it clears invoice ${exact.invoiceNumber || exact.id.slice(-6)} exactly`
          : `Narration names ${named.name}; ${fmtMoney(amount)} is a part payment on their only open invoice ${exact.invoiceNumber || exact.id.slice(-6)} (${fmtMoney(invoiceOutstanding(exact))} pending)`,
      };
    }
    const plan = allocationPlan(theirs, amount);
    if (plan.parts.length) {
      return {
        kind: 'named',
        client: named.name,
        clientId: named.id,
        amount,
        plan,
        options: theirs.map((i) => i.id),
        invoiceId: plan.parts[0].invoiceId,
        invoiceNumber: plan.parts[0].invoiceNumber,
        why: `Narration names ${named.name} — settles ${plan.parts.map((x) => x.invoiceNumber).join(', ')}${
          plan.unallocated > 0.5
            ? ` and leaves ${fmtMoney(plan.unallocated)} unallocated`
            : (plan.parts.length > 1 ? ' (oldest invoice first)' : '')}`,
      };
    }
    const all = ctx.invoices.filter((i) => i.clientId === named.id);
    return {
      kind: 'client',
      client: named.name,
      clientId: named.id,
      amount,
      options: all.map((i) => i.id),
      invoiceId: all.length === 1 ? all[0].id : null,
      invoiceNumber: all.length === 1 ? (all[0].invoiceNumber || all[0].id.slice(-6)) : '',
      why: `Narration names ${named.name}, but nothing is outstanding for them${
        all.length === 1
          ? ` — their only invoice ${all[0].invoiceNumber || all[0].id.slice(-6)} is already settled, so this would be an extra receipt`
          : (all.length ? ` — pick which of their ${all.length} invoices this belongs to` : '')}`,
    };
  }

  // 3 — the amount alone clears exactly one open invoice.
  const hits = open.filter((i) => Math.abs(invoiceOutstanding(i) - amount) <= BANK_TOL);
  if (hits.length === 1) {
    return {
      kind: 'amount',
      client: hits[0].client?.name || null,
      clientId: hits[0].clientId,
      invoiceId: hits[0].id,
      invoiceNumber: hits[0].invoiceNumber || hits[0].id.slice(-6),
      amount,
      why: `Only the amount matches — invoice ${hits[0].invoiceNumber || hits[0].id.slice(-6)} for ${hits[0].client?.name || '—'}. The narration does not name them, so check before posting`,
    };
  }
  // 4 — several invoices are for this exact amount.
  if (hits.length > 1) {
    return {
      kind: 'many',
      amount,
      options: hits.map((i) => i.id),
      why: `${hits.length} open invoices are for this exact amount — pick the right one`,
    };
  }
  // 5 — nothing fits. Read the narration once more before giving up.
  const guess = catzGuess(txn, ctx);
  if (guess && guess.kind === 'transfer') return { kind: 'transfer', amount, why: guess.why };
  if (guess && guess.kind === 'hand') return { kind: 'hand', party: guess.party, amount, why: guess.why, guess: true };
  return { kind: 'none', amount, why: 'No open invoice matches this amount' };
}

function readDebitLine(txn, ctx) {
  const amount = ROUND(txn.amount);
  const sameDay = ctx.expenses.find((e) => Math.abs(expenseNet(e) - amount) <= BANK_TOL && e.expenseDate === txn.date);
  if (sameDay) return { kind: 'expense', expenseId: sameDay.id, category: sameDay.category, why: `Matches office expense ${sameDay.category} on ${sameDay.expenseDate}` };
  const near = ctx.expenses.find((e) => Math.abs(expenseNet(e) - amount) <= BANK_TOL);
  if (near) return { kind: 'expense', expenseId: near.id, category: near.category, why: `Same amount as office expense ${near.category} (${near.expenseDate || '—'})` };
  const guess = catzGuess(txn, ctx);
  if (guess) {
    return {
      kind: guess.kind === 'transfer' ? 'transfer' : (guess.kind === 'hand' ? 'hand' : 'expense'),
      category: guess.category || null,
      vendor: guess.vendor || null,
      party: guess.party || null,
      rule: !!guess.rule,
      coaGroup: guess.category ? coaGroupOf(guess.category) : null,
      why: guess.why,
    };
  }
  return { kind: 'none', why: 'No office expense matches this amount' };
}

const expenseNet = (e) => ROUND(
  Number(e.monthlyAmount || 0) + Number(e.gstAmount || 0) - Number(e.tdsAmount || 0),
);

// The whole read, with the tag the screen prints.
function readLine(txn, ctx) {
  const read = txn.type === 'Credit' ? readCreditLine(txn, ctx) : readDebitLine(txn, ctx);
  return { ...read, tag: KIND_TAG[read.kind] || read.kind, tagClass: KIND_CLASS[read.kind] || '' };
}

// Everything the matching engine needs, read once.
async function matchContext() {
  const [invoices, clients, payments, expenses, rules, accounts, company] = await Promise.all([
    prisma.invoice.findMany({ include: { client: true, candidate: { select: { name: true } } } }),
    prisma.client.findMany({ select: { id: true, name: true } }),
    prisma.invoicePayment.findMany(),
    prisma.officeExpense.findMany(),
    prisma.bankRule.findMany(),
    prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.company.findFirst().catch(() => null),
  ]);
  return {
    invoices,
    clients,
    payments,
    expenses,
    rules,
    accounts,
    df: clientDf(clients),
    vendors: [...new Set(expenses.map((e) => String(e.vendor || '').trim()).filter((v) => v.length > 3))],
    companyNames: [company?.name].filter(Boolean),
    company: company || {},
  };
}

// ---------------------------------------------------------------------------
// Where the statement's own running balance stops adding up.
//
// Each line prints a closing balance. Yesterday's closing balance plus
// everything that moved today must equal today's. The first place it does not
// is exactly where a line is missing from the import, and by how much.
// ---------------------------------------------------------------------------
function statementBreaks(rows) {
  const withBalance = oldestFirst(rows).filter((t) => t.balance != null);
  if (withBalance.length < 2) return [];
  const byDay = new Map();
  withBalance.forEach((t) => {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push(t);
  });
  const days = [...byDay.entries()].map(([date, dayRows]) => ({ date, rows: dayRows }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const out = [];
  let close = Number(days[0].rows[days[0].rows.length - 1].balance);
  for (let i = 1; i < days.length; i += 1) {
    const d = days[i];
    const net = ROUND(d.rows.reduce((s, t) => s + signed(t), 0));
    const expect = ROUND(close + net);
    const printed = d.rows.map((t) => ROUND(Number(t.balance)));
    if (printed.some((v) => Math.abs(v - expect) < 1)) { close = expect; continue; }
    const last = ROUND(Number(d.rows[d.rows.length - 1].balance));
    out.push({
      prevDate: days[i - 1].date,
      date: d.date,
      after: { id: days[i - 1].rows[days[i - 1].rows.length - 1].id, description: days[i - 1].rows[days[i - 1].rows.length - 1].description },
      at: { id: d.rows[0].id, description: d.rows[0].description, balance: last },
      gap: ROUND(last - expect),
    });
    close = last; // carry on from what the statement says, so one break is reported once
  }
  return out;
}

// Duplicate lines: same day, same amount, same reference.
function duplicateGroups(rows) {
  const key = (t) => [t.date, t.type, ROUND(t.amount), String(t.reference || '').trim() || normName(t.description).slice(0, 40)].join('|');
  const m = new Map();
  oldestFirst(rows).forEach((t) => {
    const k = key(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  });
  return [...m.values()].filter((a) => a.length > 1)
    .sort((a, b) => String(a[0].date).localeCompare(String(b[0].date)));
}

// ---------------------------------------------------------------------------
// Attach the derived state and, for anything still to be matched, the invoice
// the matching rules would suggest.
// ---------------------------------------------------------------------------
function decorate(txn, invoiceById, suggestion, read) {
  const inv = txn.matchedInvoiceId ? invoiceById.get(txn.matchedInvoiceId) : null;
  return {
    ...txn,
    state: txnState(txn),
    // What the narration reading made of this line: the accounting app's own
    // confidence vocabulary — client named / amount only — check / several
    // match / no match — with the client it recognised and why.
    read: read || null,
    matchedInvoice: inv
      ? { id: inv.id, invoiceNumber: inv.invoiceNumber, client: inv.client?.name, total: invoiceTotal(inv), outstanding: invoiceOutstanding(inv), status: inv.status }
      : null,
    suggestion: suggestion
      ? {
        invoiceId: suggestion.invoice.id,
        invoiceNumber: suggestion.invoice.invoiceNumber,
        client: suggestion.invoice.client?.name,
        outstanding: invoiceOutstanding(suggestion.invoice),
        diff: suggestion.diff,
      }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function accountStat(account, rows) {
  const live = rows.filter((t) => !t.excluded);
  const un = live.filter((t) => txnState(t) !== 'Reconciled' && !t.category && !t.categoryKind);
  const inBank = statedBalance(rows);
  const inBooks = booksBalance(account, rows);
  const implied = impliedOpening(rows);
  const ordered = oldestFirst(rows);
  return {
    lines: live.length,
    unmatched: un.length,
    excluded: rows.filter((t) => t.excluded).length,
    matched: live.filter((t) => txnState(t) === 'Reconciled' || !!t.category || !!t.categoryKind).length,
    last: ordered.length ? ordered[ordered.length - 1].date : null,
    inBank,
    inBooks,
    difference: inBank == null ? null : ROUND(inBank - inBooks),
    implied,
    openingGap: implied == null ? null : ROUND(implied - Number(account?.openBal || 0)),
    unmatchedIn: ROUND(un.filter((t) => t.type === 'Credit').reduce((s, t) => s + Number(t.amount || 0), 0)),
    unmatchedOut: ROUND(un.filter((t) => t.type === 'Debit').reduce((s, t) => s + Number(t.amount || 0), 0)),
  };
}

router.get('/accounts', async (req, res) => {
  const accounts = await ensureAccounts();
  const transactions = await prisma.bankTransaction.findMany();
  const firstId = accounts[0].id;
  const ctx = await matchContext();
  const rows = accounts.map((b) => {
    const mine = onAccount(transactions, b.id, firstId);
    const stat = accountStat(b, mine);
    const recognised = mine.filter((t) => !t.excluded && txnState(t) !== 'Reconciled' && !t.category && !t.categoryKind)
      .filter((t) => { const r = readLine(t, ctx); return r && r.kind !== 'none'; }).length;
    return { ...b, stat: { ...stat, recognised } };
  });
  // Money held as cash — receipts taken in cash less office bills paid in cash.
  const cashIn = ctx.payments.filter((p) => /cash/i.test(p.method || '')).reduce((s, p) => s + Number(p.amount || 0), 0);
  const cashOut = ctx.expenses.filter((e) => /cash/i.test(e.paymentMode || '')).reduce((s, e) => s + expenseNet(e), 0);
  res.json({ accounts: rows, cashInHand: ROUND(cashIn - cashOut) });
});

router.post('/accounts', async (req, res) => {
  const bank = String(req.body?.bank || '').trim();
  if (!bank) return res.status(400).json({ error: 'Enter the bank name.' });
  const created = await prisma.bankAccount.create({
    data: {
      bank,
      name: req.body?.name || null,
      accNo: req.body?.accNo || null,
      ifsc: req.body?.ifsc || null,
      branch: req.body?.branch || null,
      openBal: Number(req.body?.openBal || 0),
      openDate: req.body?.openDate || toIsoDate(new Date()),
    },
  });
  await logAudit({ userId: req.user.id, action: 'Account added', entity: 'BankAccount', entityId: created.id, toValue: created.accNo || created.bank });
  res.status(201).json(created);
});

router.put('/accounts/:id', async (req, res) => {
  const before = await prisma.bankAccount.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: 'Account not found' });
  if (req.body?.bank !== undefined && !String(req.body.bank).trim()) return res.status(400).json({ error: 'Enter the bank name.' });
  const data = {};
  ['bank', 'name', 'accNo', 'ifsc', 'branch', 'openDate'].forEach((k) => {
    if (req.body?.[k] !== undefined) data[k] = req.body[k];
  });
  if (req.body?.openBal !== undefined) data.openBal = Number(req.body.openBal || 0);
  const updated = await prisma.bankAccount.update({ where: { id: req.params.id }, data });
  await logAudit({ userId: req.user.id, action: 'Bank account updated', entity: 'BankAccount', entityId: updated.id, fromValue: String(before.openBal), toValue: String(updated.openBal) });
  res.json(updated);
});

router.delete('/accounts/:id', async (req, res) => {
  const accounts = await prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } });
  if (accounts.length <= 1) return res.status(400).json({ error: 'The last bank account cannot be removed' });
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const firstId = accounts[0].id;
  const all = await prisma.bankTransaction.findMany();
  const mine = onAccount(all, account.id, firstId);
  if (mine.some((t) => txnState(t) === 'Reconciled')) {
    return res.status(400).json({ error: 'Lines on this account are reconciled — undo those first' });
  }
  if (await tiedLines(mine)) return res.status(400).json({ error: 'Lines on this account back office bills or hand loans — undo those first' });
  await prisma.bankTransaction.deleteMany({ where: { id: { in: mine.map((t) => t.id) } } });
  await prisma.bankAccount.delete({ where: { id: account.id } });
  await logAudit({ userId: req.user.id, action: 'Account removed', entity: 'BankAccount', entityId: account.id, fromValue: `${mine.length} line(s)`, toValue: '—' });
  res.json({ removed: mine.length });
});

// "Fix opening": work the opening balance back from the first line the
// statement carries, instead of asking for it.
router.post('/accounts/:id/fix-opening', async (req, res) => {
  const accounts = await ensureAccounts();
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const all = await prisma.bankTransaction.findMany();
  const mine = onAccount(all, account.id, accounts[0].id);
  const implied = impliedOpening(mine);
  if (implied == null) return res.status(400).json({ error: 'No statement line on this account carries a balance, so the opening balance cannot be worked out' });
  const first = oldestFirst(mine).find((t) => t.balance != null);
  const before = Number(account.openBal || 0);
  const updated = await prisma.bankAccount.update({
    where: { id: account.id },
    data: { openBal: implied, openDate: first ? first.date : account.openDate },
  });
  await logAudit({ userId: req.user.id, action: 'Opening balance set from the statement', entity: 'BankAccount', entityId: account.id, fromValue: fmtMoney(before), toValue: `${fmtMoney(implied)}${first ? ` as on ${first.date}` : ''}` });
  res.json({ ...updated, before, implied });
});

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const [transactions, ctx, loans] = await Promise.all([
    prisma.bankTransaction.findMany({ orderBy: { date: 'desc' } }),
    matchContext(),
    prisma.handLoan.findMany({ include: { links: true } }),
  ]);
  const invoiceById = new Map(ctx.invoices.map((i) => [i.id, i]));
  const loanLinked = new Set(loans.flatMap((l) => l.links.map((x) => x.bankTxnId)));

  const accountId = req.query.bankAccountId && req.query.bankAccountId !== 'All'
    ? req.query.bankAccountId : null;
  const scoped = accountId ? onAccount(transactions, accountId, firstId) : transactions;
  const account = accountId ? accounts.find((a) => a.id === accountId) : null;

  // Running balance is built oldest-first over every line on the account, from
  // its opening balance — so it is the same figure whatever the screen is
  // filtered to. With no opening balance typed in, the one the statement
  // implies is used.
  const ordered = oldestFirst(scoped);
  const runAt = new Map();
  // With no account chosen the running balance starts from every account's
  // opening figure added together, which is what the unfiltered list shows.
  const opening = account ? Number(account.openBal || 0)
    : ROUND(accounts.reduce((s, a) => s + Number(a.openBal || 0), 0));
  let run = opening;
  ordered.forEach((t) => { run = ROUND(run + signed(t)); runAt.set(t.id, run); });

  const breaks = new Map(statementBreaks(scoped).map((b) => [b.at.id, b]));

  const filtered = req.query.state && req.query.state !== 'All'
    ? scoped.filter((t) => txnState(t) === req.query.state)
    : scoped;
  res.json(filtered.map((t) => {
    const needsMatch = txnState(t) === 'Unmatched';
    const read = readLine(t, ctx);
    const row = decorate(t, invoiceById, needsMatch ? suggestInvoiceFor(t, ctx.invoices) : null, read);
    row.runningBalance = runAt.get(t.id) ?? null;
    row.breakHere = breaks.get(t.id) || null;
    // S5: what the app would do with a line nobody has filed yet.
    if (lineOpen(t, loanLinked)) {
      const plan = linePlan(t, ctx, loans);
      row.plan = plan ? {
        key: planKey(plan), confidence: plan.confidence, module: plan.module, label: plan.label, why: plan.why, rule: plan.rule,
      } : null;
    }
    return row;
  }));
});

// Grouped for the reconciliation table: by month, by statement file, or flat.
router.get('/groups', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.query.bankAccountId || firstId;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  const [all, imports, marks] = await Promise.all([
    prisma.bankTransaction.findMany(),
    prisma.bankImport.findMany(),
    prisma.bankMark.findMany(),
  ]);
  const rows = onAccount(all, account.id, firstId);
  const group = req.query.group || 'month';
  const mine = marks.filter((m) => (m.bankAccountId || firstId) === account.id);

  if (group === 'none') {
    return res.json([{ key: '__all', label: '', rows: rows.map((t) => t.id), notes: mine.map((m) => m.id) }]);
  }
  const buckets = new Map();
  const keyOf = (t) => (group === 'imp' ? (t.importBatch || '__hand') : String(t.date || '').slice(0, 7));
  rows.forEach((t) => {
    const k = keyOf(t);
    if (!buckets.has(k)) buckets.set(k, { key: k, rows: [], notes: [] });
    buckets.get(k).rows.push(t);
  });
  mine.forEach((m) => {
    const k = group === 'imp' ? '__hand' : String(m.date || '').slice(0, 7);
    if (!buckets.has(k)) buckets.set(k, { key: k, rows: [], notes: [] });
    buckets.get(k).notes.push(m);
  });
  const out = [...buckets.values()].map((b) => {
    const ordered = oldestFirst(b.rows);
    const withBalance = ordered.filter((t) => t.balance != null);
    const last = withBalance.length ? withBalance[withBalance.length - 1] : null;
    const on = last ? last.date : (ordered.length ? ordered[ordered.length - 1].date : (b.notes[0] || {}).date);
    const credits = b.rows.filter((t) => t.type === 'Credit');
    const imp = group === 'imp' ? imports.find((i) => i.id === b.key) : null;
    const bank = last ? ROUND(Number(last.balance)) : null;
    const books = on ? balanceOn(account, rows, on) : null;
    return {
      key: b.key,
      label: group === 'imp'
        ? (b.key === '__hand' ? 'Entered by hand' : (imp ? imp.file : 'Older import'))
        : b.key,
      sub: group === 'imp'
        ? (imp ? `${imp.fromDate || '—'} to ${imp.toDate || '—'} · read on ${imp.date}` : 'before the app kept a history')
        : `to ${on || '—'}`,
      on: on || null,
      importId: imp ? imp.id : null,
      rows: ordered.map((t) => t.id),
      notes: b.notes.map((m) => m.id),
      in: ROUND(b.rows.filter((t) => t.type === 'Credit').reduce((s, t) => s + Number(t.amount || 0), 0)),
      out: ROUND(b.rows.filter((t) => t.type === 'Debit').reduce((s, t) => s + Number(t.amount || 0), 0)),
      bank,
      books,
      gap: (bank == null || books == null) ? null : ROUND(bank - books),
      posted: credits.filter((t) => txnState(t) === 'Reconciled').length,
      open: credits.filter((t) => txnState(t) !== 'Reconciled').length,
    };
  }).sort((a, b) => String(b.on || '').localeCompare(String(a.on || '')));
  return res.json(out);
});

// Banking position: the statement against the books, and what the narration
// reading makes of everything still unmatched.
router.get('/position', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const transactions = await prisma.bankTransaction.findMany({ orderBy: { date: 'asc' } });
  const ctx = await matchContext();
  const accountId = req.query.bankAccountId && req.query.bankAccountId !== 'All' ? req.query.bankAccountId : null;
  const account = accountId ? accounts.find((a) => a.id === accountId) : null;
  const scoped = accountId ? onAccount(transactions, accountId, firstId) : transactions;

  const credits = ROUND(scoped.filter((t) => t.type === 'Credit').reduce((s, t) => s + Number(t.amount || 0), 0));
  const debits = ROUND(scoped.filter((t) => t.type === 'Debit').reduce((s, t) => s + Number(t.amount || 0), 0));
  const implied = impliedOpening(scoped);
  // "Amount in the books" is the account's own opening balance plus every line
  // imported. Where that starting figure is wrong the whole column is out by
  // the same amount, which is what "Fix opening" clears.
  const opening = account ? Number(account.openBal || 0)
    : ROUND(accounts.reduce((s, a) => s + Number(a.openBal || 0), 0));
  const inBooks = ROUND(opening + credits - debits);
  const inBank = statedBalance(scoped);

  const unmatchedCredits = scoped.filter((t) => t.type === 'Credit' && txnState(t) === 'Unmatched');
  const reads = unmatchedCredits.map((t) => readLine(t, ctx));
  const tagCount = (tag) => reads.filter((r) => r && r.tag === tag).length;
  const ordered = oldestFirst(scoped);

  res.json({
    lines: scoped.length,
    firstLine: ordered[0]?.date || null,
    lastLine: ordered[ordered.length - 1]?.date || null,
    credits,
    debits,
    opening,
    implied,
    openingGap: implied == null ? null : ROUND(implied - opening),
    inBooks,
    inBank,
    difference: inBank == null ? null : ROUND(inBank - inBooks),
    openInvoices: ctx.invoices.filter(isOpenInvoice).length,
    openInvoiceValue: ROUND(ctx.invoices.filter(isOpenInvoice).reduce((s, i) => s + invoiceOutstanding(i), 0)),
    breaks: statementBreaks(scoped),
    duplicates: duplicateGroups(scoped).map((g) => ({
      date: g[0].date,
      description: g[0].description,
      reference: g[0].reference,
      type: g[0].type,
      amount: ROUND(g[0].amount),
      copies: g.length,
      ids: g.map((t) => t.id),
      postedExtras: g.slice(1).filter((t) => txnState(t) === 'Reconciled').length,
    })),
    reading: {
      'client named': tagCount('client named'),
      'possible match': tagCount('possible match'),
      'amount only — check': tagCount('amount only — check'),
      'several match': tagCount('several match'),
      'check invoice': tagCount('check invoice'),
      'no match': tagCount('no match'),
    },
    // The live figures the "How a credit finds its client" panel prints, so it
    // can never drift from the behaviour.
    engine: {
      tolerance: BANK_TOL,
      clients: ctx.clients.length,
      openInvoices: ctx.invoices.filter(isOpenInvoice).length,
      rules: ctx.rules.length,
    },
  });
});

// Reconciliation position: how much of the statement is still to be dealt with.
router.get('/summary', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const all = await prisma.bankTransaction.findMany();
  const accountId = req.query.bankAccountId && req.query.bankAccountId !== 'All' ? req.query.bankAccountId : null;
  const transactions = accountId ? onAccount(all, accountId, firstId) : all;
  const count = (state) => transactions.filter((t) => txnState(t) === state).length;
  const value = (state, type) => ROUND(transactions
    .filter((t) => txnState(t) === state && (!type || t.type === type))
    .reduce((s, t) => s + Number(t.amount || 0), 0));
  const credits = ROUND(transactions.filter((t) => t.type === 'Credit').reduce((s, t) => s + t.amount, 0));
  const debits = ROUND(transactions.filter((t) => t.type === 'Debit').reduce((s, t) => s + t.amount, 0));
  res.json({
    total: transactions.length,
    unmatched: count('Unmatched'),
    matched: count('Matched'),
    reconciled: count('Reconciled'),
    ignored: count('Ignored'),
    unmatchedValue: value('Unmatched'),
    reconciledValue: value('Reconciled'),
    credits,
    debits,
    netMovement: ROUND(credits - debits),
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// Read the rows without writing anything — what the Preview button shows.
router.post('/preview', async (req, res) => {
  const parsed = parseCsv(String(req.body?.csv || ''));
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const rows = parsed.rows;
  const credits = rows.filter((r) => r.type === 'Credit');
  const debits = rows.filter((r) => r.type === 'Debit');
  return res.json({
    lines: rows.length,
    credits: credits.length,
    creditValue: ROUND(credits.reduce((s, r) => s + r.amount, 0)),
    debits: debits.length,
    debitValue: ROUND(debits.reduce((s, r) => s + r.amount, 0)),
    from: rows[0]?.date || null,
    to: rows[rows.length - 1]?.date || null,
    skipped: parsed.bad || 0,
    sample: rows.slice(0, 8),
  });
});

// Import statement lines. Accepts either a parsed array of rows or raw CSV text
// with a date / description / amount(or debit+credit) header. Lines already on
// file are skipped rather than duplicated, so re-importing an overlapping
// statement is safe.
router.post('/import', async (req, res) => {
  let rows = Array.isArray(req.body?.transactions) ? req.body.transactions : null;
  if (!rows && typeof req.body?.csv === 'string') {
    const parsed = parseCsv(req.body.csv);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    rows = parsed.rows;
  }
  if (!rows || !rows.length) return res.status(400).json({ error: 'Provide transactions[] or csv text to import' });
  const out = await importStatement(req, {
    rows,
    bankAccountId: req.body?.bankAccountId,
    dedup: req.body?.dedup !== 'No' && req.body?.dedup !== false,
    file: req.body?.file,
    autoPost: req.body?.autoPost !== 'no' && req.body?.autoPost !== false,
  });
  res.status(201).json(out);
});

// The write half of a statement import, shared with the Accounts "Import any
// file" screen (routes/accountsImport.js) so a spreadsheet upload gets exactly
// the same de-duplication, batch record, opening balance and auto-posting as
// this screen's own import.
async function importStatement(req, {
  rows, bankAccountId, dedup = true, file, autoPost = true,
}) {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = bankAccountId || firstId;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];

  const existing = await prisma.bankTransaction.findMany();
  const key = (t) => [t.date, t.type, ROUND(t.amount), String(t.reference || '').trim().toLowerCase() || String(t.description || '').trim().toLowerCase()].join('|');
  const seen = new Set(onAccount(existing, account.id, firstId).map(key));

  const batch = `IMP-${Date.now()}`;
  file = String(file || 'pasted text');
  const created = [];
  const skipped = [];
  let creditValue = 0;
  let debitValue = 0;
  let from = null;
  let to = null;
  for (const raw of rows) {
    const date = String(raw.date || '').slice(0, 10);
    const amount = ROUND(raw.amount);
    const type = raw.type || (Number(raw.credit) > 0 ? 'Credit' : 'Debit');
    if (!date || !(amount > 0)) { skipped.push({ row: raw, reason: 'A date and a non-zero amount are required' }); continue; }
    const row = {
      date,
      description: String(raw.description || raw.narration || '—'),
      type: type === 'Credit' ? 'Credit' : 'Debit',
      amount,
      reference: raw.reference ? String(raw.reference) : null,
      balance: raw.balance == null || raw.balance === '' ? null : Number(raw.balance),
      importBatch: batch,
      importFile: file,
      bankAccountId: account.id,
    };
    const k = key(row);
    if (dedup && seen.has(k)) { skipped.push({ row, reason: 'Already on file' }); continue; }
    seen.add(k);
    created.push(await prisma.bankTransaction.create({ data: row }));
    if (row.type === 'Credit') creditValue = ROUND(creditValue + amount); else debitValue = ROUND(debitValue + amount);
    if (!from || date < from) from = date;
    if (!to || date > to) to = date;
  }

  if (created.length) {
    await prisma.bankImport.create({
      data: {
        id: batch,
        bankAccountId: account.id,
        date: toIsoDate(new Date()),
        file,
        recordedBy: actor(req),
        lines: created.length,
        skipped: skipped.length,
        credits: creditValue,
        debits: debitValue,
        fromDate: from,
        toDate: to,
      },
    });
  }
  await logAudit({ userId: req.user.id, action: 'Bank statement imported', entity: 'BankTransaction', entityId: batch, toValue: `${created.length} imported, ${skipped.length} skipped` });

  // The statement carries its own running balance, so the opening balance can
  // be worked out instead of asked for — set it the first time, on its own.
  let openingSetTo = null;
  if (created.length && !Number(account.openBal || 0)) {
    const mine = onAccount(await prisma.bankTransaction.findMany(), account.id, firstId);
    const implied = impliedOpening(mine);
    if (implied != null) {
      const first = oldestFirst(mine).find((t) => t.balance != null);
      await prisma.bankAccount.update({ where: { id: account.id }, data: { openBal: implied, openDate: first ? first.date : account.openDate } });
      await logAudit({ userId: req.user.id, action: 'Opening balance worked out from the statement', entity: 'BankAccount', entityId: account.id, fromValue: '₹0.00', toValue: fmtMoney(implied) });
      openingSetTo = implied;
    }
  }

  // Post the credits automatically: only where the narration names a client who
  // still owes money. The oldest invoice is settled first, anything extra is
  // left alone, and every posting can be undone.
  let autoPosted = 0;
  let loansLinked = 0;
  let billsFiled = 0;
  let chargesFiled = 0;
  if (created.length && autoPost) {
    const result = await postAllNamed(account.id, firstId, req, { clearOnly: true });
    autoPosted = result.posted;
    // Hand loans: a line that clearly names a loan is linked as its proof.
    loansLinked = (await autoLinkLoans(req)).linked;
    // S5: office bills and the bank's own charges, filed with the line as proof.
    const debits = await autoFileDebits(account.id, firstId, req);
    billsFiled = debits.filed - debits.charges;
    chargesFiled = debits.charges;
  }

  // "N lines imported · X matched and proof attached · Y need your review".
  let autoMatched = 0;
  let needsReview = 0;
  if (created.length) {
    const ids = created.map((t) => t.id);
    const [fresh, links] = await Promise.all([
      prisma.bankTransaction.findMany({ where: { id: { in: ids } } }),
      prisma.handLoanLink.findMany({ where: { bankTxnId: { in: ids } }, select: { bankTxnId: true } }),
    ]);
    const linkedSet = new Set(links.map((l) => l.bankTxnId));
    autoMatched = fresh.filter((t) => !lineOpen(t, linkedSet) && !t.excluded && txnState(t) !== 'Ignored').length;
    needsReview = fresh.filter((t) => lineOpen(t, linkedSet)).length;
  }

  return {
    batch, account: account.name || account.id, imported: created.length, duplicates: skipped.length, skipped, openingSetTo, autoPosted, loansLinked, billsFiled, chargesFiled, autoMatched, needsReview, transactions: created,
  };
}

// ---------------------------------------------------------------------------
// Posting a matched credit into the accounts
// ---------------------------------------------------------------------------

// One credit, across one client's open invoices, oldest first. Returns the
// parts posted and whatever was more than the client owed.
async function postAcrossInvoices(txn, invoices, req, { allowOverpay = true } = {}) {
  const plan = allocationPlan(invoices, ROUND(txn.amount));
  if (!plan.parts.length) return { error: 'Nothing is outstanding for that client.' };
  if (plan.unallocated > 0.5 && !allowOverpay) {
    return { error: `${fmtMoney(plan.unallocated)} of this credit is more than is owed — confirm to post the rest` };
  }
  for (let i = 0; i < plan.parts.length; i += 1) {
    const part = plan.parts[i];
    const invoice = invoices.find((x) => x.id === part.invoiceId);
    await prisma.invoicePayment.create({
      data: {
        invoiceId: part.invoiceId,
        date: txn.date,
        amount: part.amount,
        method: 'Bank Transfer',
        reference: txn.reference || null,
        notes: `Bank statement · ${txn.description}${plan.parts.length > 1 ? ` · part ${i + 1} of ${plan.parts.length} of ${fmtMoney(txn.amount)}` : ''}`,
        bankTxnId: txn.id,
        recordedBy: actor(req),
      },
    });
    const received = ROUND(Number(invoice.receivedAmount || 0) + part.amount);
    const status = deriveInvoiceStatus({ ...invoice, receivedAmount: received });
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        receivedAmount: received,
        status,
        paidDate: status === 'Paid' ? txn.date : invoice.paidDate,
        bankTxnId: txn.id,
      },
    });
  }
  return { plan };
}

// A receipt already recorded by hand gets this bank line as its proof. No
// money moves — the receipt stays exactly as it was — so this can never
// double-record a payment; undoing it (unmatch) only clears the link.
async function linkPayment(txn, paymentId, req) {
  const p = await prisma.invoicePayment.findUnique({ where: { id: paymentId }, include: { invoice: { include: { client: true } } } });
  if (!p) return { error: 'That receipt no longer exists.' };
  if (p.bankTxnId && p.bankTxnId !== txn.id) return { error: 'That receipt is already backed by another bank line.' };
  await prisma.invoicePayment.update({ where: { id: p.id }, data: { bankTxnId: txn.id, bankLinked: true } });
  const extra = ROUND(Number(txn.amount || 0) - Number(p.amount || 0));
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      matched: true,
      matchedInvoiceId: p.invoiceId,
      reconStatus: 'Reconciled',
      matchedBy: actor(req),
      matchedDate: toIsoDate(new Date()),
      clientName: p.invoice?.client?.name || null,
      excess: extra > 0.5 ? extra : null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Bank line linked as proof', entity: 'BankTransaction', entityId: txn.id,
    toValue: `${p.invoice?.invoiceNumber || p.invoiceId} · receipt of ${fmtMoney(p.amount)} on ${p.date}`,
  });
  return { txn: updated, payment: p };
}

// Post every credit whose narration names a client with money still outstanding.
// clearOnly (the import's automatic pass): only CLEAR matches post by
// themselves — the invoice named with an amount that fits, the client named
// with one invoice for that amount, or a receipt found by its reference. The
// header button (a person pressing "Post all") also posts client-named
// credits spread oldest first. A line is only ever read while Unmatched and is
// Reconciled the moment it posts, so running either twice never posts twice.
async function postAllNamed(accountId, firstId, req, { clearOnly = false } = {}) {
  const all = await prisma.bankTransaction.findMany();
  const mine = onAccount(all, accountId, firstId)
    .filter((t) => t.type === 'Credit' && txnState(t) === 'Unmatched' && !t.excluded && !t.category && !t.categoryKind);
  let posted = 0;
  let value = 0;
  for (const txn of mine) {
    // Re-read each time: balances move as we post.
    const ctx = await matchContext();
    const read = readLine(txn, ctx);
    if (read.kind === 'already') {
      if (read.clear && read.paymentId) {
        const linked = await linkPayment(txn, read.paymentId, req);
        if (!linked.error) {
          posted += 1;
          if (clearOnly) await logAutoMatch(req, txn, { module: 'invoice', confidence: 'high', rule: null }, `receipt on ${read.invoiceNumber || read.invoiceId || '—'}`, 'auto');
        }
      }
      continue;
    }
    if (clearOnly ? !(read.clear && read.kind === 'sure') : (read.kind !== 'sure' && read.kind !== 'named')) continue;
    // A clear match names ONE invoice — post to that invoice, not the
    // client's oldest.
    const theirs = read.kind === 'sure' && read.invoiceId
      ? ctx.invoices.filter((i) => i.id === read.invoiceId && isOpenInvoice(i))
      : ctx.invoices.filter((i) => i.clientId === read.clientId && isOpenInvoice(i));
    const out = await postAcrossInvoices(txn, theirs, req);
    if (out.error) continue;
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        matched: true,
        matchedInvoiceId: out.plan.parts[0].invoiceId,
        reconStatus: 'Reconciled',
        matchedBy: actor(req),
        matchedDate: toIsoDate(new Date()),
        clientName: read.client,
        excess: out.plan.unallocated > 0.5 ? out.plan.unallocated : null,
      },
    });
    posted += 1;
    value = ROUND(value + ROUND(txn.amount - out.plan.unallocated));
    if (clearOnly) {
      const viaRule = !txn.clientName && !readClient(txn.description, ctx.clients, ctx.df)
        ? ruleHit(txn, ctx.rules.filter((x) => x.kind === 'client')) : null;
      await logAutoMatch(req, txn, { module: 'invoice', confidence: 'high', rule: viaRule ? viaRule.match : null }, out.plan.parts.map((x) => x.invoiceNumber).join(', '), 'auto');
    }
  }
  if (posted) {
    await logAudit({ userId: req.user.id, action: 'Credits posted automatically on import', entity: 'BankTransaction', entityId: accountId, toValue: `${posted} credit(s) · ${fmtMoney(value)}` });
  }
  return { posted, value };
}

// "Post all matched credit(s)" — the header button.
router.post('/post-all-named', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.body?.bankAccountId || firstId;
  const out = await postAllNamed(accountId, firstId, req);
  if (!out.posted) return res.status(400).json({ error: 'No credit names a client with money still outstanding.' });
  res.json(out);
});

// Post one credit to a client, spread across their open invoices oldest first.
router.post('/:id/post-to-client', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Reconciled') return res.status(400).json({ error: 'This transaction is already reconciled — unmatch it first' });
  if (state === 'Ignored') return res.status(400).json({ error: 'This transaction is ignored — restore it before matching' });
  if (txn.type !== 'Credit') return res.status(400).json({ error: 'Only money received can be matched to an invoice' });

  const ctx = await matchContext();
  const client = ctx.clients.find((c) => c.name === req.body?.client || c.id === req.body?.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  // With an invoiceId (a clear match that named one invoice) the credit goes
  // to that invoice; otherwise across the client's open invoices, oldest first.
  const theirs = ctx.invoices.filter((i) => i.clientId === client.id && isOpenInvoice(i)
    && (!req.body?.invoiceId || i.id === req.body.invoiceId));
  const out = await postAcrossInvoices(txn, theirs, req, { allowOverpay: req.body?.confirmOverpay !== false });
  if (out.error) return res.status(400).json({ error: out.error });

  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      matched: true,
      matchedInvoiceId: out.plan.parts[0].invoiceId,
      reconStatus: 'Reconciled',
      matchedBy: actor(req),
      matchedDate: toIsoDate(new Date()),
      clientName: client.name,
      excess: out.plan.unallocated > 0.5 ? out.plan.unallocated : null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Posted from the bank statement', entity: 'BankTransaction', entityId: txn.id,
    fromValue: state, toValue: `${fmtMoney(ROUND(txn.amount - out.plan.unallocated))} · ${client.name} · ${out.plan.parts.length} invoice(s)`,
  });
  res.json({
    ...updated,
    state: 'Reconciled',
    parts: out.plan.parts,
    unallocated: out.plan.unallocated,
    posted: ROUND(txn.amount - out.plan.unallocated),
  });
});

// ---------------------------------------------------------------------------
// The six transitions
// ---------------------------------------------------------------------------

// Match to an invoice. With an invoiceId this is the manual match; without one
// it uses the suggestion, and refuses when nothing is close enough.
router.post('/:id/match', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Reconciled') return res.status(400).json({ error: 'This transaction is already reconciled — unmatch it first' });
  if (state === 'Ignored') return res.status(400).json({ error: 'This transaction is ignored — restore it before matching' });
  if (txn.type !== 'Credit') return res.status(400).json({ error: 'Only money received can be matched to an invoice' });

  let invoice;
  let manual = false;
  if (req.body?.invoiceId) {
    manual = true;
    invoice = await prisma.invoice.findUnique({ where: { id: req.body.invoiceId }, include: { client: true } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  } else {
    const invoices = await prisma.invoice.findMany({ include: { client: true } });
    const suggestion = suggestInvoiceFor(txn, invoices);
    if (!suggestion) return res.status(400).json({ error: 'No confident suggestion — use a manual match' });
    invoice = suggestion.invoice;
  }

  if (invoice.status === 'Cancelled') return res.status(400).json({ error: 'That invoice is cancelled' });
  if (invoiceOutstanding(invoice) <= 0.5) return res.status(400).json({ error: 'That invoice is already settled in full' });

  // One invoice, one transaction — the prototype's guard against double-claiming.
  const claimed = await prisma.bankTransaction.findFirst({
    where: { matchedInvoiceId: invoice.id, id: { not: txn.id }, reconStatus: { in: ['Matched', 'Reconciled'] } },
  });
  if (claimed) return res.status(400).json({ error: 'That invoice is already matched against another transaction' });

  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      matched: true,
      matchedInvoiceId: invoice.id,
      reconStatus: 'Matched',
      matchedBy: actor(req),
      matchedDate: toIsoDate(new Date()),
      clientName: invoice.client?.name || null,
    },
  });
  await logAudit({
    userId: req.user.id, action: manual ? 'Manual match applied' : 'Match applied',
    entity: 'BankTransaction', entityId: txn.id, fromValue: state, toValue: `Matched — ${invoice.invoiceNumber || invoice.id}`,
  });
  res.json({ ...updated, state: 'Matched', matchedInvoice: { id: invoice.id, invoiceNumber: invoice.invoiceNumber, client: invoice.client?.name, outstanding: invoiceOutstanding(invoice) } });
});

// Undo a match. From Reconciled this also reverses the receipt, so the invoice
// goes back to being owed.
router.post('/:id/unmatch', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Unmatched') return res.status(400).json({ error: 'This transaction is not matched to anything' });
  if (state === 'Ignored') return res.status(400).json({ error: 'This transaction is ignored — restore it first' });
  // B9.9a (from B2): once a REFUND has been paid out against this invoice's
  // credit note, the receipt it reverses cannot be unmatched — the money has
  // already gone back to the client. Reverse the refund on the credit note first.
  if (txn.matchedInvoiceId) {
    // eslint-disable-next-line global-require
    const CNU = require('../utils/creditNotes');
    const notes = CNU.ready() ? (await CNU.notesByInvoice([txn.matchedInvoiceId], { issuedOnly: true })).get(txn.matchedInvoiceId) || [] : [];
    const refunded = notes.filter((n) => n.kind !== 'debit' && n.refundPaidOn && Number(n.refundDue || 0) > 0.005);
    if (refunded.length) {
      return res.status(409).json({
        error: `Can't unmatch: a refund of ₹${refunded.reduce((s, n) => s + Number(n.refundDue || 0), 0).toLocaleString('en-IN')} was already paid to the client against credit note ${refunded.map((n) => n.number).filter(Boolean).join(', ') || 'on this invoice'} (on ${refunded[0].refundPaidOn}). Reverse that refund on the credit note first.`,
        code: 'REFUND_PAID',
        creditNotes: refunded.map((n) => ({ id: n.id, number: n.number, refundDue: n.refundDue, refundPaidOn: n.refundPaidOn })),
      });
    }
  }

  let reversed = 0;
  if (state === 'Reconciled') {
    const payments = await prisma.invoicePayment.findMany({ where: { bankTxnId: txn.id } });
    for (const p of payments) {
      // A receipt recorded by hand that this line was only linked to as proof
      // keeps its money; only the link goes.
      if (p.bankLinked) {
        await prisma.invoicePayment.update({ where: { id: p.id }, data: { bankTxnId: null, bankLinked: false } });
        continue;
      }
      const invoice = await prisma.invoice.findUnique({ where: { id: p.invoiceId } });
      await prisma.invoicePayment.delete({ where: { id: p.id } });
      if (!invoice) continue;
      const received = ROUND(Math.max(0, Number(invoice.receivedAmount || 0) - Number(p.amount || 0)));
      const next = { ...invoice, receivedAmount: received };
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { receivedAmount: received, status: deriveInvoiceStatus(next), paidDate: null, bankTxnId: null },
      });
      reversed = ROUND(reversed + Number(p.amount || 0));
    }
  }

  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      matched: false, matchedInvoiceId: null, reconStatus: 'Unmatched', matchedBy: null, matchedDate: null, clientName: null, excess: null,
    },
  });
  await logAudit({
    userId: req.user.id, action: state === 'Reconciled' ? 'Reconciliation reversed' : 'Transaction unmatched',
    entity: 'BankTransaction', entityId: txn.id, fromValue: `${state} — ${txn.matchedInvoiceId || '—'}`, toValue: 'Unmatched',
  });
  res.json({ ...updated, state: 'Unmatched', reversed });
});

// Close the line off: record the receipt against the matched invoice.
router.post('/:id/reconcile', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Reconciled') return res.status(400).json({ error: 'Already reconciled' });
  if (state === 'Ignored') return res.status(400).json({ error: 'This transaction is ignored — restore it first' });
  if (state !== 'Matched') return res.status(400).json({ error: 'Match the transaction to an invoice before reconciling' });

  const invoice = await prisma.invoice.findUnique({ where: { id: txn.matchedInvoiceId } });
  if (!invoice) return res.status(400).json({ error: 'The matched invoice no longer exists — unmatch this transaction' });

  const outstanding = invoiceOutstanding(invoice);
  // A credit larger than the invoice settles it and leaves the rest unallocated,
  // exactly as the prototype's allocation does.
  const applied = ROUND(Math.min(Number(txn.amount || 0), outstanding));
  const unallocated = ROUND(Number(txn.amount || 0) - applied);

  await prisma.invoicePayment.create({
    data: {
      invoiceId: invoice.id,
      date: txn.date,
      amount: applied,
      method: 'Bank Transfer',
      reference: txn.reference || null,
      notes: `Bank statement · ${txn.description}${unallocated > 0.5 ? ` · ₹${unallocated} left unallocated` : ''}`,
      bankTxnId: txn.id,
      recordedBy: actor(req),
    },
  });
  const received = ROUND(Number(invoice.receivedAmount || 0) + applied);
  const status = deriveInvoiceStatus({ ...invoice, receivedAmount: received });
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      receivedAmount: received,
      status,
      paidDate: status === 'Paid' ? txn.date : invoice.paidDate,
      bankTxnId: txn.id,
    },
  });
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { reconStatus: 'Reconciled', matched: true, excess: unallocated > 0.5 ? unallocated : null },
  });
  await logAudit({
    userId: req.user.id, action: 'Transaction reconciled', entity: 'BankTransaction', entityId: txn.id,
    fromValue: 'Matched', toValue: `Reconciled — ${invoice.invoiceNumber || invoice.id} marked ${status}`,
  });
  res.json({
    ...updated,
    state: 'Reconciled',
    applied,
    unallocated,
    invoice: { id: updatedInvoice.id, invoiceNumber: updatedInvoice.invoiceNumber, status: updatedInvoice.status, receivedAmount: updatedInvoice.receivedAmount, outstanding: invoiceOutstanding(updatedInvoice) },
  });
});

// Park a line that is not ours to reconcile. It stays on file and can be restored.
router.post('/:id/ignore', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Reconciled') return res.status(400).json({ error: 'A reconciled transaction cannot be ignored — unmatch it first' });
  if (state === 'Ignored') return res.status(400).json({ error: 'Already ignored' });

  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { reconStatus: 'Ignored', ignoredReason: req.body?.reason || null },
  });
  await logAudit({ userId: req.user.id, action: 'Transaction ignored', entity: 'BankTransaction', entityId: txn.id, fromValue: state, toValue: 'Ignored' });
  res.json({ ...updated, state: 'Ignored' });
});

router.post('/:id/unignore', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txnState(txn) !== 'Ignored') return res.status(400).json({ error: 'This transaction is not ignored' });

  // Back to where it was: still matched if a match survived the parking.
  const back = txn.matched && txn.matchedInvoiceId ? 'Matched' : 'Unmatched';
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { reconStatus: back, ignoredReason: null },
  });
  await logAudit({ userId: req.user.id, action: 'Transaction restored', entity: 'BankTransaction', entityId: txn.id, fromValue: 'Ignored', toValue: back });
  res.json({ ...updated, state: back });
});

// Leave a line on file but out of the count, for a transfer you never want to
// categorise.
router.post('/:id/exclude', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txnState(txn) === 'Reconciled') return res.status(400).json({ error: 'A reconciled transaction cannot be excluded — unmatch it first' });
  const on = req.body?.excluded !== false;
  const updated = await prisma.bankTransaction.update({ where: { id: txn.id }, data: { excluded: on } });
  await logAudit({ userId: req.user.id, action: on ? 'Line excluded' : 'Line brought back', entity: 'BankTransaction', entityId: txn.id, toValue: `${txn.date} · ${String(txn.description || '').slice(0, 40)}` });
  res.json({ ...updated, state: txnState(updated) });
});

// ---------------------------------------------------------------------------
// Categorise: the two-tab panel. "Match transactions" ticks an invoice or a
// bill; "Categorise manually" files the line under a category, and can
// remember the narration as a rule.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE MATCH / CATEGORISE PANEL (Accounts spec 3 part 2).
//
//   GET  /:id/candidates        everything the panel shows for one line
//   POST /:id/settle-invoices   a credit: settle the ticked invoice(s), oldest
//                               first, recording each receipt exactly as the
//                               reconcile path does (InvoicePayment + status)
//   POST /:id/link-payment      a credit: this line is the proof of a receipt
//                               already recorded by hand (no money moves)
//   POST /:id/match-bills       a debit: settle the ticked office bill(s),
//                               oldest first; what is left stays unposted
//   POST /:id/categorise        file the line by hand — for a debit, as a new
//                               office bill (with its bill file); "remember"
//                               keeps the narration as a rule
//   POST /:id/uncategorise      undo any of the above except a credit posting
// ---------------------------------------------------------------------------

const BILL_MAX_BYTES = 8 * 1024 * 1024; // the panel's "one file ≤ 8 MB"
const PANEL_GST_TREATMENTS = ['Registered Business - Regular', 'Registered Business - Composition',
  'Unregistered Business', 'Consumer', 'Overseas', 'Special Economic Zone', 'Deemed Export',
  'Tax Deductor', 'SEZ Developer'];
const PANEL_MODES = ['Bank Transfer', 'UPI', 'Cash', 'Credit Card', 'Debit Card', 'Cheque', 'Other'];
const OUR_STATE = '[36] Telangana';
const stateOptions = () => Object.entries(GST_STATES)
  .filter(([code]) => /^\d{2}$/.test(code))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, name]) => `[${code}] ${name}`);

// A bill the panel can offer: not a hand loan, not rejected, and not already
// backing a different bank line.
const billFree = (e, txnId) => e.entryKind !== 'hand' && e.approvalStatus !== 'REJECTED'
  && (!e.bankTxnId || e.bankTxnId === txnId);
const billShape = (amount) => (e) => ({
  id: e.id,
  code: e.expenseCode || null,
  category: e.category,
  expenseAccount: e.expenseAccount || null,
  vendor: e.vendor || null,
  billNumber: e.billNumber || null,
  expenseDate: e.expenseDate || null,
  net: expenseNet(e),
  diff: ROUND(expenseNet(e) - amount),
  approvalStatus: e.approvalStatus,
  paidStatus: e.paidStatus,
});

// Expense accounts the form offers: the office's own categories first, then
// the ones the narration reader knows.
async function expenseAccounts() {
  const [cats, used] = await Promise.all([
    prisma.expenseCategory.findMany({ where: { isActive: true }, select: { name: true } }).catch(() => []),
    prisma.officeExpense.findMany({ select: { category: true }, distinct: ['category'] }).catch(() => []),
  ]);
  return [...new Set([...cats.map((c) => c.name), ...Object.keys(CHART_OF_ACCOUNTS), ...used.map((u) => u.category)]
    .map((x) => String(x || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

router.get('/:id/candidates', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const [ctx, accounts, loans] = await Promise.all([
    matchContext(),
    ensureAccounts(),
    prisma.handLoan.findMany({ include: { links: true } }),
  ]);
  const amount = ROUND(txn.amount);
  const read = readLine(txn, ctx);
  const account = accounts.find((a) => a.id === txn.bankAccountId) || accounts[0];
  const bank = account ? `${account.bank}${account.accNo ? ` · xxxx${String(account.accNo).slice(-4)}` : ''}` : null;
  // Hand loans this line could belong to (part 4) — the same reading the Hand
  // loans section uses.
  const loanCands = loansForLine(txn, loans);
  const base = {
    id: txn.id, amount, read, bank, date: txn.date, description: txn.description, reference: txn.reference,
    state: txnState(txn), loans: loanCands,
  };
  if (txn.type === 'Credit') {
    const open = ctx.invoices.filter(isOpenInvoice);
    const clientName = txn.clientName || read.client || null;
    const pointed = new Set(read.options || []);
    // Best: the invoice(s) the narration clearly names, else every open
    // invoice for exactly this amount. Possible: what the narration points at,
    // then the closest amounts (the named client's first).
    const best = read.clear && read.invoiceId
      ? open.filter((i) => i.id === read.invoiceId)
      : open.filter((i) => Math.abs(invoiceOutstanding(i) - amount) <= BANK_TOL);
    const rest = open.filter((i) => !best.includes(i));
    const score = (i) => (pointed.has(i.id) ? 0 : 1) * 1e13
      + ((clientName && i.client?.name === clientName) ? 0 : 1) * 1e12 + Math.abs(invoiceOutstanding(i) - amount);
    const close = (i) => pointed.has(i.id) || (clientName && i.client?.name === clientName)
      || Math.abs(invoiceOutstanding(i) - amount) <= Math.max(BANK_TOL * 5, amount * 0.25);
    const shape = (i) => {
      // P4: the bank amount is compared with the NET RECEIVABLE still to come
      // (amount after GST − TDS − already received) — the same figure the
      // matching rules above use — with the full calculation and, when it
      // differs, why.
      const tv = TAX.taxView(i, { company: ctx.company });
      return {
        id: i.id, invoiceNumber: i.invoiceNumber || i.id.slice(-6), client: i.client?.name || '—',
        invoiceDate: i.invoiceDate, total: invoiceTotal(i), outstanding: invoiceOutstanding(i),
        diff: ROUND(invoiceOutstanding(i) - amount), pointed: pointed.has(i.id),
        fy: TAX.fyOf(i.invoiceDate),
        dueDate: i.dueDate || null,
        candidate: i.candidate?.name || null,
        kind: i.candidateId ? 'Placement fee' : 'Service invoice',
        breakdown: {
          base: tv.base, gstPercent: tv.gstPercent, gstTypeLabel: tv.gstTypeLabel, cgst: tv.cgst, sgst: tv.sgst, igst: tv.igst,
          gst: tv.gst, gross: tv.gross, tdsPercent: tv.tdsPercent, tdsBase: tv.tdsBase, tds: tv.tds, net: tv.net,
          received: tv.received, balance: tv.balance,
        },
        compare: TAX.bankCompare(tv, amount),
      };
    };
    const payment = read.kind === 'already' && read.paymentId ? ctx.payments.find((p) => p.id === read.paymentId) : null;
    // P4 — a line that names only the CLIENT (no invoice number, no single
    // exact amount) while that client has several open invoices: the panel
    // asks "Select invoice" and shows the chosen one's breakdown to confirm.
    // The automatic rules are unchanged — this is only what the panel offers.
    const pickClientId = !read.clear && ['named', 'client'].includes(read.kind) ? read.clientId : null;
    const pickList = pickClientId ? open.filter((i) => i.clientId === pickClientId)
      .sort((a, b) => String(a.invoiceDate || '').localeCompare(String(b.invoiceDate || ''))) : [];
    return res.json({
      ...base,
      kind: 'Credit',
      client: clientName,
      selectInvoice: pickList.length >= 2 ? { client: read.client, clientId: pickClientId, invoices: pickList.map(shape) } : null,
      best: best.map(shape),
      maybe: rest.filter(close).sort((a, b) => score(a) - score(b)).slice(0, 40).map(shape),
      payment: payment ? {
        id: payment.id, date: payment.date, amount: ROUND(payment.amount), reference: payment.reference,
        invoiceNumber: read.invoiceNumber, linkable: !payment.bankTxnId || payment.bankTxnId === txn.id,
      } : null,
    });
  }
  const bills = ctx.expenses.filter((e) => billFree(e, txn.id));
  const best = bills.filter((e) => Math.abs(expenseNet(e) - amount) <= BANK_TOL)
    .sort((a, b) => String(a.expenseDate || '').localeCompare(String(b.expenseDate || '')));
  const maybe = bills.filter((e) => !best.includes(e) && Math.abs(expenseNet(e) - amount) <= Math.max(BANK_TOL, amount * 0.1))
    .sort((a, b) => Math.abs(expenseNet(a) - amount) - Math.abs(expenseNet(b) - amount)).slice(0, 25);
  const suggestion = catzGuess(txn, ctx);
  return res.json({
    ...base,
    kind: 'Debit',
    best: best.map(billShape(amount)),
    maybe: maybe.map(billShape(amount)),
    suggestion,
    // "recognised — from the narration says 'PF'": the account and the reason.
    recognised: suggestion && suggestion.kind === 'expense' && suggestion.category
      ? { account: suggestion.category, why: suggestion.why, vendor: suggestion.vendor || '', gstRate: suggestion.gstRate ?? null, rule: !!suggestion.rule }
      : null,
    words: ruleWords(txn.description),
    categories: await expenseAccounts(),
    options: {
      gstTreatments: PANEL_GST_TREATMENTS,
      states: stateOptions(),
      destination: OUR_STATE,
      modes: PANEL_MODES,
      gstRates: [0, 5, 12, 18, 28],
      tdsRates: [1, 2, 5, 10],
    },
    billMaxBytes: BILL_MAX_BYTES,
  });
});

// A credit: settle the ticked invoice(s) with this one line, oldest invoice
// first; anything left over stays on the line as unposted. Each receipt is an
// InvoicePayment carrying this line as its proof (bankTxnId), and the invoice's
// received amount and status move exactly as Record Payment moves them.
router.post('/:id/settle-invoices', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Reconciled') return res.status(400).json({ error: 'This line is already posted — undo it first' });
  if (state === 'Ignored') return res.status(400).json({ error: 'This line is ignored — restore it first' });
  if (txn.type !== 'Credit') return res.status(400).json({ error: 'Only money received can settle an invoice' });
  if (txn.category || txn.categoryKind) return res.status(400).json({ error: 'This line is already filed — undo that first' });
  const ids = Array.isArray(req.body?.invoiceIds) ? req.body.invoiceIds.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'Tick the invoice(s) this money settles.' });
  const invoices = await prisma.invoice.findMany({ where: { id: { in: ids } }, include: { client: true } });
  const open = invoices.filter(isOpenInvoice);
  if (!open.length) return res.status(400).json({ error: 'Every ticked invoice is already settled or cancelled.' });
  const out = await postAcrossInvoices(txn, open, req);
  if (out.error) return res.status(400).json({ error: out.error });
  const clients = [...new Set(open.map((i) => i.client?.name).filter(Boolean))];
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      matched: true,
      matchedInvoiceId: out.plan.parts[0].invoiceId,
      reconStatus: 'Reconciled',
      matchedBy: actor(req),
      matchedDate: toIsoDate(new Date()),
      clientName: clients.length === 1 ? clients[0] : (clients.length ? `${clients[0]} +${clients.length - 1}` : null),
      excess: out.plan.unallocated > 0.5 ? out.plan.unallocated : null,
    },
  });
  if (clients.length === 1) await learnRule(txn, { kind: 'client', category: clients[0] });
  await logAudit({
    userId: req.user.id, action: 'Invoice(s) settled from the bank statement', entity: 'BankTransaction', entityId: txn.id,
    fromValue: state, toValue: `${fmtMoney(ROUND(txn.amount - out.plan.unallocated))} · ${out.plan.parts.map((p) => p.invoiceNumber).join(', ')}`,
  });
  return res.json({
    ...updated, state: 'Reconciled', parts: out.plan.parts, unallocated: out.plan.unallocated, posted: ROUND(txn.amount - out.plan.unallocated),
  });
});

router.post('/:id/link-payment', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const state = txnState(txn);
  if (state === 'Reconciled') return res.status(400).json({ error: 'This line is already posted — undo it first' });
  if (state === 'Ignored') return res.status(400).json({ error: 'This line is ignored — restore it first' });
  if (txn.type !== 'Credit') return res.status(400).json({ error: 'Only money received can prove a receipt' });
  const out = await linkPayment(txn, String(req.body?.paymentId || ''), req);
  if (out.error) return res.status(400).json({ error: out.error });
  return res.json({ ...out.txn, state: 'Reconciled' });
});

// A debit: settle the ticked office bill(s). Oldest bill first; each one that
// fits inside what is left of the line is linked (OfficeExpense.bankTxnId —
// the proof of payment) and, if it was APPROVED, moved on to PAID, exactly as
// the approval chain would. A bill still PENDING approval is linked but keeps
// its approval state. Whatever the ticked bills do not use stays unposted.
router.post('/:id/match-bills', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txn.type !== 'Debit') return res.status(400).json({ error: 'Only money paid out can settle an office bill' });
  if (txnState(txn) === 'Ignored') return res.status(400).json({ error: 'This line is ignored — restore it first' });
  if (txn.category || txn.categoryKind || txn.createdBillId || txn.billLinks) {
    return res.status(400).json({ error: 'This line is already filed — undo that first' });
  }
  const ids = Array.isArray(req.body?.billIds) ? req.body.billIds.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'Tick the bill(s) this payment settles.' });
  const bills = (await prisma.officeExpense.findMany({ where: { id: { in: ids } } }))
    .filter((e) => billFree(e, txn.id))
    .sort((a, b) => String(a.expenseDate || '').localeCompare(String(b.expenseDate || ''))
      || new Date(a.createdAt) - new Date(b.createdAt));
  if (!bills.length) return res.status(400).json({ error: 'None of the ticked bills can take this payment.' });
  let left = ROUND(txn.amount);
  const links = [];
  for (const b of bills) {
    const net = expenseNet(b);
    if (net > left + BANK_TOL) break;
    const data = { bankTxnId: txn.id };
    if (b.approvalStatus === 'APPROVED') {
      Object.assign(data, { approvalStatus: 'PAID', paidStatus: 'Paid', paidAt: new Date(), paidById: req.user.id });
    } else if (['PAID', 'REIMBURSED'].includes(b.approvalStatus)) {
      data.paidStatus = 'Paid';
    }
    await prisma.officeExpense.update({ where: { id: b.id }, data });
    links.push({
      id: b.id, approvalStatus: b.approvalStatus, paidStatus: b.paidStatus, paidAt: b.paidAt, paidById: b.paidById, net,
    });
    left = ROUND(Math.max(0, left - net));
  }
  if (!links.length) {
    return res.status(400).json({ error: `The oldest ticked bill is more than this ${fmtMoney(txn.amount)} payment — tick the right bill.` });
  }
  const first = bills.find((b) => b.id === links[0].id);
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      category: first.category,
      categoryKind: 'expense',
      vendor: first.vendor || null,
      billLinks: JSON.stringify(links),
      excess: left > 0.5 ? left : null,
    },
  });
  await learnRule(txn, { kind: 'expense', category: first.category, vendor: first.vendor || null });
  await logAudit({
    userId: req.user.id, action: 'Office bill(s) settled from the bank statement', entity: 'BankTransaction', entityId: txn.id,
    toValue: `${links.length} bill(s) · ${fmtMoney(ROUND(txn.amount - left))}${left > 0.5 ? ` · ${fmtMoney(left)} unposted` : ''}`,
  });
  return res.json({
    ...updated, state: txnState(updated), settled: links.length, unposted: left, pendingApproval: links.filter((l) => l.approvalStatus === 'PENDING').length,
  });
});

// The categorise form's own rules, returned per field so the panel can show
// each error under its field.
function billProblems(b, txn) {
  const e = {};
  if (!b.expenseAccount || !String(b.expenseAccount).trim()) e.expenseAccount = 'Choose the expense account.';
  const amount = Number(b.amount);
  if (!(amount > 0)) e.amount = 'Enter the amount that left the bank.';
  else if (Math.abs(amount - Number(txn.amount)) > BANK_TOL) e.amount = `The bank line is ${fmtMoney(txn.amount)} — the bill has to match it.`;
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) e.date = 'Enter the date.';
  if (b.gst === 'Yes') {
    const r = Number(b.gstRate);
    if (!(r > 0 && r <= 28)) e.gstRate = 'Choose the GST rate on the bill.';
  }
  if (b.vendorGstin && String(b.vendorGstin).trim()) {
    const c = checkGstin(String(b.vendorGstin).trim().toUpperCase());
    if (!c.ok) e.vendorGstin = c.error || 'A GSTIN is 15 characters.';
  }
  if (b.hsnSac && String(b.hsnSac).trim() && !/^(\d{4}|\d{6}|\d{8})$/.test(String(b.hsnSac).replace(/\s+/g, ''))) {
    e.hsnSac = 'HSN / SAC is 4, 6 or 8 digits.';
  }
  if (b.tds === 'Yes') {
    const r = Number(b.tdsRate);
    if (!(r > 0 && r <= 30)) e.tdsRate = 'Choose the TDS rate cut.';
  }
  if (b.remember && !String(b.match || '').trim()) e.match = 'Type the words to remember, e.g. EPF0.';
  if (b.remember && String(b.match || '').trim() && normName(b.match).length < 3) e.match = 'Use at least three letters or digits.';
  return e;
}

// Money on a bill filed from its bank line. The line is what LEFT the bank:
// net = base + GST − TDS, so base is worked back from the line and the rates
// typed on the form — never an assumed 18%. Under reverse charge the vendor
// charges no GST (we pay it to Government ourselves), so none is in the line.
function billMoney(b, amount) {
  const g = b.gst === 'Yes' && b.reverseCharge !== 'Yes' ? Number(b.gstRate || 0) / 100 : 0;
  const t = b.tds === 'Yes' ? Number(b.tdsRate || 0) / 100 : 0;
  const base = ROUND(amount / (1 + g - t));
  const gst = ROUND(base * g);
  const tds = ROUND(Math.max(0, base + gst - amount));
  return { base, gst, tds };
}

async function rememberRule(match, fields) {
  const key = normName(match);
  const existing = (await prisma.bankRule.findMany()).find((r) => normName(r.match) === key);
  if (existing) return prisma.bankRule.update({ where: { id: existing.id }, data: fields });
  return prisma.bankRule.create({ data: { match: String(match).trim(), ...fields } });
}

// File a line under a category. For a debit filed as an office expense the
// panel sends fileAsBill and the whole bill (optionally with its file, as
// multipart: a "data" JSON field + one "file" part ≤ 8 MB); the bill is
// written to the Office register already paid, with this line as its proof.
// "remember" keeps the narration as a rule, so every future statement line
// carrying those words is recognised the same way.
router.post('/:id/categorise', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  let body = req.body || {};
  let file = null;
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    try {
      const parsed = await attachments.parseMultipart(req, { maxBytes: BILL_MAX_BYTES });
      body = JSON.parse(parsed.fields.data || '{}');
      file = parsed.file;
    } catch (err) {
      if (err.code === 'TOO_LARGE') return res.status(400).json({ error: 'That file is larger than 8 MB.', fields: { file: 'That file is larger than 8 MB.' } });
      return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the form.' });
    }
  }
  if (txnState(txn) === 'Reconciled') return res.status(400).json({ error: 'This line is posted against an invoice — undo that first' });
  if (txn.createdBillId || txn.billLinks) return res.status(400).json({ error: 'This line is already filed as an office bill — undo that first' });
  if (await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } })) {
    return res.status(400).json({ error: 'This line is linked to a hand loan — unlink it there first' });
  }
  const kind = String(body.kind || 'expense');

  // A debit filed as an office bill.
  if (body.fileAsBill && kind === 'expense') {
    if (txn.type !== 'Debit') return res.status(400).json({ error: 'Only money paid out can be filed as an office bill' });
    const problems = billProblems(body, txn);
    if (Object.keys(problems).length) return res.status(400).json({ error: 'Some fields need attention.', fields: problems });
    let stored = null;
    if (file) {
      try {
        stored = attachments.store(file, { maxBytes: BILL_MAX_BYTES });
      } catch (err) {
        const msg = err.code === 'TOO_LARGE' ? 'That file is larger than 8 MB.' : (attachments.MESSAGE[err.code] || 'Could not store the file.');
        return res.status(400).json({ error: msg, fields: { file: msg } });
      }
    }
    const account = String(body.expenseAccount).trim();
    const money = billMoney(body, ROUND(txn.amount));
    const today = toIsoDate(new Date());
    const tags = [...new Set(String(body.reportingTags || '').split(',').map((s) => s.trim()).filter(Boolean))].join(', ') || null;
    const bill = await prisma.officeExpense.create({
      data: {
        category: account,
        expenseAccount: account,
        vendor: String(body.vendor || '').trim() || null,
        expenseDate: String(body.date).slice(0, 10),
        monthlyAmount: money.base,
        gstAmount: money.gst,
        tdsAmount: money.tds,
        gstRatePct: body.gst === 'Yes' ? Number(body.gstRate) : null,
        tdsRatePct: body.tds === 'Yes' ? Number(body.tdsRate) : null,
        vendorGstin: String(body.vendorGstin || '').trim().toUpperCase() || null,
        billNumber: String(body.billNumber || '').trim() || null,
        supplyType: ['Goods', 'Service'].includes(body.supplyType) ? body.supplyType : null,
        hsnSac: String(body.hsnSac || '').replace(/\s+/g, '') || null,
        gstTreatment: PANEL_GST_TREATMENTS.includes(body.gstTreatment) ? body.gstTreatment : null,
        sourceState: String(body.sourceState || '').trim() || null,
        destState: String(body.destState || '').trim() || OUR_STATE,
        reverseCharge: body.reverseCharge === 'Yes',
        billableClient: String(body.billableClient || '').trim() || null,
        reportingTags: tags,
        paymentMode: PANEL_MODES.includes(body.paymentMode) ? body.paymentMode : 'Bank Transfer',
        description: String(body.description || txn.description || '').trim().slice(0, 500) || null,
        notes: `Filed from the bank statement line of ${txn.date}${txn.reference ? ` (Ref ${txn.reference})` : ''}`,
        frequency: 'One-Time',
        recurring: false,
        entryKind: 'expense',
        // The money has already left the bank: the bill is paid, and this
        // statement line is its proof of payment.
        paidStatus: 'Paid',
        approvalStatus: 'PAID',
        approvedBy: actor(req),
        createdById: req.user.id,
        paidById: req.user.id,
        paidAt: new Date(),
        bankTxnId: txn.id,
        ...(stored ? {
          proofFile: stored.billFile, proofName: stored.billName, proofMime: stored.billMime, proofSize: stored.billSize, proofAt: today, proofBy: actor(req),
        } : {}),
      },
    });
    const updated = await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        category: account, categoryKind: 'expense', vendor: bill.vendor, counterparty: null, createdBillId: bill.id, excess: null,
      },
    });
    let rule = null;
    if (body.remember) {
      rule = await rememberRule(body.match, {
        category: account, kind: 'expense', vendor: bill.vendor, gstRate: body.gst === 'Yes' ? Number(body.gstRate) : null,
      });
    } else {
      // S5 learning: a line filed by hand teaches the app its payee.
      rule = await learnRule(txn, {
        category: account, kind: 'expense', vendor: bill.vendor, gstRate: body.gst === 'Yes' ? Number(body.gstRate) : null,
      });
    }
    await logAudit({
      userId: req.user.id, action: 'Bank line filed as an office bill', entity: 'BankTransaction', entityId: txn.id,
      toValue: `${account} · ${fmtMoney(txn.amount)}${stored ? ' · bill attached' : ''}${rule ? ` · rule "${rule.match}"` : ''}`,
    });
    return res.json({ ...updated, state: txnState(updated), bill: { id: bill.id }, rule });
  }

  // Anything else: filed under a category on the line itself (as before).
  const category = String(body.category || '').trim();
  if (kind === 'expense' && !category) return res.status(400).json({ error: 'Choose what this should be filed under.', fields: { expenseAccount: 'Choose the expense account.' } });
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      category: kind === 'expense' || kind === 'other' ? category : null,
      categoryKind: kind,
      vendor: body.vendor || null,
      counterparty: body.party || null,
    },
  });
  let rule = null;
  if (body.remember) {
    const match = String(body.match || ruleWords(txn.description)[0] || '').trim();
    if (match) {
      rule = await rememberRule(match, {
        category: category || (body.party || ''), vendor: body.vendor || null, gstRate: body.gstRate == null || body.gstRate === '' ? null : Number(body.gstRate), kind,
      });
    }
  }
  await logAudit({ userId: req.user.id, action: 'Bank line categorised', entity: 'BankTransaction', entityId: txn.id, toValue: `${kind}${category ? ` · ${category}` : ''}` });
  return res.json({ ...updated, state: txnState(updated), rule });
});

// Undo a categorisation — including the office bill the panel created from
// this line (removed, with its file) and the bills it settled (put back to
// the approval / payment state they had, and unlinked).
router.post('/:id/uncategorise', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const loanLink = await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } });
  if (!txn.category && !txn.categoryKind && !txn.createdBillId && !txn.billLinks && !loanLink) {
    return res.status(400).json({ error: 'This line is not categorised' });
  }
  let removedBill = null;
  if (txn.createdBillId) {
    const bill = await prisma.officeExpense.findUnique({ where: { id: txn.createdBillId } });
    if (bill && bill.bankTxnId === txn.id) {
      if (bill.proofFile) attachments.remove(bill.proofFile);
      await prisma.officeExpense.delete({ where: { id: bill.id } });
      removedBill = bill.expenseCode || bill.id;
    }
  }
  let restored = 0;
  if (txn.billLinks) {
    let links = [];
    try { links = JSON.parse(txn.billLinks) || []; } catch { links = []; }
    for (const l of links) {
      const bill = await prisma.officeExpense.findUnique({ where: { id: l.id } });
      if (!bill || bill.bankTxnId !== txn.id) continue;
      await prisma.officeExpense.update({
        where: { id: bill.id },
        data: {
          bankTxnId: null,
          approvalStatus: l.approvalStatus || bill.approvalStatus,
          paidStatus: l.paidStatus || bill.paidStatus,
          paidAt: l.paidAt ? new Date(l.paidAt) : null,
          paidById: l.paidById || null,
        },
      });
      restored += 1;
    }
  }
  if (loanLink) await prisma.handLoanLink.delete({ where: { id: loanLink.id } });
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      category: null, categoryKind: null, vendor: null, counterparty: null, createdBillId: null, billLinks: null, excess: txnState(txn) === 'Reconciled' ? txn.excess : null,
    },
  });
  await logAudit({
    userId: req.user.id, action: 'Categorisation undone', entity: 'BankTransaction', entityId: txn.id,
    fromValue: txn.category || txn.categoryKind || (loanLink ? 'hand loan' : 'bill'),
    toValue: [removedBill && `bill ${removedBill} removed`, restored && `${restored} bill(s) unlinked`, loanLink && 'hand loan unlinked'].filter(Boolean).join(' · ') || '—',
  });
  return res.json({ ...updated, state: txnState(updated), removedBill, restored });
});

// ---------------------------------------------------------------------------
// HAND LOANS (Accounts spec 3 part 4). Money borrowed from a person: the
// taking is a credit line, each repayment a debit line. A line whose narration
// clearly names the loan (its name or the lender) with an amount that fits is
// linked automatically as proof; anything less certain is offered as a
// possible match for a person to confirm. One statement line backs one loan
// line only (HandLoanLink.bankTxnId is unique), so matching can run any number
// of times without linking anything twice.
// ---------------------------------------------------------------------------
const LOAN_STOP = /^(LOAN|LOANS|HAND|FROM|SHRI|SMT|MRS|MISS|SIR|MADAM|REPAY|REPAYMENT|RETURN)$/;

function loanKeys(loan) {
  const full = [loan.name, loan.lender].map(tightName).filter((k) => k.length >= 5);
  const words = [...new Set(normName(`${loan.name || ''} ${loan.lender || ''}`).split(' ')
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !LOAN_STOP.test(w) && !RULE_STOP.test(w)))];
  return { full, words };
}

function loanHit(txn, loan) {
  const hay = tightName(`${txn.description || ''} ${txn.reference || ''}`);
  const k = loanKeys(loan);
  if (k.full.some((f) => hay.indexOf(f) >= 0)) return 'strong';
  const n = k.words.filter((w) => hay.indexOf(w) >= 0).length;
  if (n >= 2) return 'strong';
  return n === 1 ? 'weak' : null;
}

function loanFigures(loan) {
  const links = loan.links || [];
  const taken = links.find((l) => l.kind === 'taken') || null;
  const repayments = links.filter((l) => l.kind === 'repayment')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || new Date(a.createdAt) - new Date(b.createdAt));
  let run = 0;
  let clearedDate = null;
  repayments.forEach((r) => {
    run = ROUND(run + Number(r.amount || 0));
    if (!clearedDate && run >= Number(loan.amount || 0) - 0.5) clearedDate = r.date;
  });
  const pending = ROUND(Math.max(0, Number(loan.amount || 0) - run));
  const cleared = repayments.length > 0 && pending <= 0.5;
  return {
    taken, repayments, repaid: ROUND(run), pending, cleared, clearedDate: cleared ? clearedDate : null,
    overpaid: ROUND(Math.max(0, run - Number(loan.amount || 0))),
  };
}

// A line a loan may claim: not posted to an invoice, not ignored or excluded,
// not an office bill, and not already backing a loan.
const loanEligible = (t, linked) => !linked.has(t.id) && !t.excluded
  && !['Reconciled', 'Ignored'].includes(txnState(t)) && !t.createdBillId && !t.billLinks
  && !t.category && (!t.categoryKind || t.categoryKind === 'hand');

const daysApart = (a, b) => Math.abs((new Date(String(a).slice(0, 10)) - new Date(String(b).slice(0, 10))) / 86400000);

// Every loan's clear and possible lines, read oldest line first so clear
// repayments are counted against what is still pending as they go.
function loanReads(loans, txns) {
  const linked = new Set(loans.flatMap((l) => (l.links || []).map((x) => x.bankTxnId)));
  const eligible = oldestFirst(txns.filter((t) => loanEligible(t, linked)));
  const out = new Map(loans.map((l) => [l.id, {
    takenClear: null, takenMaybe: [], repayClear: [], repayMaybe: [],
  }]));
  const pend = new Map(loans.map((l) => [l.id, loanFigures(l).pending]));
  const hasTaken = new Set(loans.filter((l) => (l.links || []).some((x) => x.kind === 'taken')).map((l) => l.id));
  eligible.forEach((t) => {
    const amount = ROUND(t.amount);
    const hits = loans.map((loan) => ({ loan, hit: loanHit(t, loan) })).filter((h) => h.hit);
    const strong = hits.filter((h) => h.hit === 'strong');
    const only = strong.length === 1 && hits.length === 1 ? strong[0].loan : null;
    if (t.type === 'Credit') {
      if (only && !hasTaken.has(only.id) && Math.abs(amount - Number(only.amount)) <= BANK_TOL) {
        out.get(only.id).takenClear = t;
        hasTaken.add(only.id);
        return;
      }
      hits.forEach((h) => {
        if (hasTaken.has(h.loan.id)) return;
        out.get(h.loan.id).takenMaybe.push({
          t,
          why: Math.abs(amount - Number(h.loan.amount)) <= BANK_TOL
            ? (hits.length > 1 ? 'the narration names more than one loan' : 'the narration only partly names this loan')
            : `names the loan, but ${fmtMoney(amount)} is not the ${fmtMoney(h.loan.amount)} taken`,
        });
      });
      if (!hits.length) {
        loans.forEach((l) => {
          if (!hasTaken.has(l.id) && Math.abs(amount - Number(l.amount)) <= BANK_TOL && daysApart(t.date, l.dateTaken) <= 10) {
            out.get(l.id).takenMaybe.push({ t, why: 'same amount, close to the date taken — the narration does not name the loan' });
          }
        });
      }
      return;
    }
    // A debit: a repayment.
    if (only && String(t.date) >= String(only.dateTaken) && pend.get(only.id) > 0.5 && amount <= pend.get(only.id) + BANK_TOL) {
      out.get(only.id).repayClear.push(t);
      pend.set(only.id, ROUND(Math.max(0, pend.get(only.id) - amount)));
      return;
    }
    hits.forEach((h) => {
      const p = pend.get(h.loan.id);
      out.get(h.loan.id).repayMaybe.push({
        t,
        why: String(t.date) < String(h.loan.dateTaken) ? 'names the loan, but is dated before it was taken'
          : p <= 0.5 ? 'names the loan, but nothing is pending on it'
            : amount > p + BANK_TOL ? `names the loan, but ${fmtMoney(amount)} is more than the ${fmtMoney(p)} pending`
              : (hits.length > 1 ? 'the narration names more than one loan' : 'the narration only partly names this loan'),
      });
    });
    if (!hits.length) {
      loans.forEach((l) => {
        const p = pend.get(l.id);
        if (p > 0.5 && Math.abs(amount - p) <= BANK_TOL && String(t.date) >= String(l.dateTaken)) {
          out.get(l.id).repayMaybe.push({ t, why: 'the amount is exactly what is still pending — the narration does not name the loan' });
        }
      });
    }
  });
  return out;
}

// The loans one line could belong to — for the Match / Categorise panel.
function loansForLine(txn, loans) {
  const linkedTo = loans.find((l) => (l.links || []).some((x) => x.bankTxnId === txn.id));
  if (linkedTo) return [{ loanId: linkedTo.id, name: linkedTo.name, linked: true, kind: txn.type === 'Credit' ? 'taken' : 'repayment' }];
  const reads = loanReads(loans, [txn]);
  const res = [];
  loans.forEach((l) => {
    const r = reads.get(l.id);
    const clear = (r.takenClear && r.takenClear.id === txn.id) || r.repayClear.some((t) => t.id === txn.id);
    const maybe = [...r.takenMaybe, ...r.repayMaybe].find((m) => m.t.id === txn.id);
    if (clear || maybe) {
      res.push({
        loanId: l.id, name: l.name, lender: l.lender, clear: !!clear, why: clear ? 'the narration names this loan and the amount fits' : maybe.why,
        kind: txn.type === 'Credit' ? 'taken' : 'repayment', pending: loanFigures(l).pending,
      });
    }
  });
  return res;
}

async function linkLoanLine(loan, txn, req, { auto = false } = {}) {
  const kind = txn.type === 'Credit' ? 'taken' : 'repayment';
  const link = await prisma.handLoanLink.create({
    data: {
      loanId: loan.id,
      bankTxnId: txn.id,
      kind,
      date: txn.date,
      amount: ROUND(txn.amount),
      reference: txn.reference || null,
      description: String(txn.description || '').slice(0, 300),
      auto,
      linkedBy: auto ? 'auto' : actor(req),
    },
  });
  await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { categoryKind: 'hand', counterparty: loan.name, category: null, vendor: null },
  });
  return link;
}

async function autoLinkLoans(req) {
  const loans = await prisma.handLoan.findMany({ include: { links: true } });
  if (!loans.length) return { linked: 0 };
  const txns = await prisma.bankTransaction.findMany();
  const reads = loanReads(loans, txns);
  let linked = 0;
  for (const loan of loans) {
    const r = reads.get(loan.id);
    const lines = [r.takenClear, ...r.repayClear].filter(Boolean);
    for (const t of lines) {
      try {
        await linkLoanLine(loan, t, req, { auto: true });
        linked += 1;
        await logAutoMatch(req, t, { module: 'loan', confidence: 'high', rule: null }, `${loan.name} (${t.type === 'Credit' ? 'taken' : 'cleared — paid back'})`, 'auto');
      } catch (err) {
        if (err.code !== 'P2002') throw err; // already linked by a parallel run
      }
    }
  }
  if (linked) {
    await logAudit({ userId: req.user.id, action: 'Hand loan lines linked automatically', entity: 'HandLoan', toValue: `${linked} line(s)` });
  }
  return { linked };
}

// ---------------------------------------------------------------------------
// AUTO-MATCH + AUTO-PROOF (Accounts spec S5). Right after every statement
// import the app reads each line that is still unfiled and makes a PLAN for
// it — what it is, where its proof goes, and how sure the app is:
//
//   high    → done on its own: the receipt / hand-loan movement / office bill
//             is written (or the existing one linked) with THIS line as its
//             proof, and the step is logged.
//   medium  → nothing is filed; the line waits under "Categorise now →" with
//   low       the suggestion and a one-click Accept that runs the same step.
//
// A line somebody has already posted, filed, ignored, excluded or tied to a
// loan is never read, so a match made by hand is never changed. Nothing here
// ever deletes a statement line. Every accepted (or hand-corrected) match is
// remembered as a transaction rule, which is what makes the next statement's
// copy of that payee "high".
// ---------------------------------------------------------------------------

const BANK_CHARGE_STRICT = /instaalertchg|alertchg|\bsms\b.*chg|chg.*\bsms\b|nwd.*chg|atm.*chg|\bamb\b.*chg|dpchgs|mabchg|\bchgs?\b|\bchrgs?\b|service charges?|bank charges?|\bmin(imum)? bal|non.?maint|\bdebit card (annual|fee)|\bcard fee\b|\bgst on (chg|charges?)/i;
const BANK_CHARGE_LOOSE = /\b(charges?|fees?|commission)\b/i;

// A debit that is the bank's own charge — "What the bank takes".
function isBankCharge(txn) {
  if (txn.type !== 'Debit') return false;
  const hay = `${txn.description || ''} ${txn.reference || ''}`;
  const amount = ROUND(txn.amount);
  if (BANK_CHARGE_STRICT.test(hay) && amount <= 25000) return true;
  if (BANK_CHARGE_LOOSE.test(hay) && amount <= 5000 && !/^(UPI|IMPS)-/i.test(String(txn.description || ''))) return true;
  if (/\bepr\d{6,}/i.test(hay) && amount < 200) return true;
  return false;
}
const BANK_CHARGES_CATEGORY = 'Bank Fees and Charges';
const lineIsCharge = (t) => t.type === 'Debit' && !t.excluded && (t.category === BANK_CHARGES_CATEGORY || (!t.category && !t.categoryKind && isBankCharge(t)));

// The payee a narration carries — what a learnt rule remembers.
function payeePattern(txn) {
  const d = String(txn.description || '').toUpperCase();
  const m = /^UPI[-/]([A-Z][A-Z0-9 .&]{2,40}?)[-/@]/.exec(d)
    || /^IMPS-\d+-([A-Z][A-Z .&]{2,40}?)-/.exec(d)
    || /^(?:NEFT|RTGS)\s*(?:DR|CR)?-[A-Z]{4}\d{5,}-([A-Z][A-Z .&]{2,40}?)-/.exec(d)
    || /^(?:NEFT|RTGS|IMPS)\s*(?:DR|CR)?[- ]([A-Z][A-Z .&]{3,40}?)(?:-|$)/.exec(d);
  if (m) {
    const name = normName(m[1]);
    const words = name.split(' ').filter((w) => w.length >= 3 && !RULE_STOP.test(w));
    if (words.length && name.replace(/ /g, '').length >= 4) return name;
  }
  const word = ruleWords(txn.description).find((w) => /^[A-Z]{5,}$/.test(w));
  return word || null;
}

// A learnt client rule names the client for a credit whose narration does not.
function ruleClient(txn, ctx) {
  const rule = ruleHit(txn, (ctx.rules || []).filter((r) => r.kind === 'client'));
  if (!rule) return null;
  return ctx.clients.find((c) => c.name === rule.category) || null;
}

// A line the auto pass (and Accept) may act on: nothing filed on it yet.
const lineOpen = (t, loanLinked) => !t.excluded && txnState(t) === 'Unmatched'
  && !t.category && !t.categoryKind && !t.createdBillId && !t.billLinks && !loanLinked.has(t.id);

const accountLabel = (accounts, id) => {
  const a = accounts.find((x) => x.id === id) || accounts[0];
  return a ? `${a.bank}${a.accNo ? ` ·${String(a.accNo).slice(-4)}` : ''}` : '—';
};

// What the app would do with one open line, and how sure it is.
function linePlan(txn, ctx, loans) {
  const amount = ROUND(txn.amount);
  const loanCands = loansForLine(txn, loans).filter((l) => !l.linked);
  const loanClear = loanCands.filter((l) => l.clear);
  const loanPlan = (l, confidence, why) => ({
    confidence,
    module: 'loan',
    why,
    rule: null,
    label: txn.type === 'Credit' ? `${l.name} — money taken by hand` : `${l.name} — cleared, paid back`,
    action: { type: 'loan', loanId: l.loanId },
  });
  if (txn.type === 'Credit') {
    const read = readLine(txn, ctx);
    // A client the narration does not name but a learnt rule does.
    const rc = !txn.clientName && !readClient(txn.description, ctx.clients, ctx.df)
      ? ruleHit(txn, ctx.rules.filter((x) => x.kind === 'client')) : null;
    if (read.kind === 'already' && read.paymentId) {
      const p = ctx.payments.find((x) => x.id === read.paymentId);
      if (p && (!p.bankTxnId || p.bankTxnId === txn.id)) {
        return {
          confidence: read.clear ? 'high' : 'medium',
          module: 'invoice',
          why: read.why,
          rule: null,
          label: `Proof for the receipt on ${read.invoiceNumber || 'the invoice'}${read.client ? ` · ${read.client}` : ''}`,
          action: { type: 'linkPayment', paymentId: p.id },
        };
      }
    }
    const settle = (confidence, ids) => ({
      confidence,
      module: 'invoice',
      why: read.why,
      rule: rc ? rc.match : null,
      label: `${read.client || 'Client'} · ${ids.length > 1 ? `${ids.length} invoices` : `invoice ${read.invoiceNumber || ''}`}`.trim(),
      action: { type: 'settle', invoiceIds: ids, client: read.client || null },
    });
    if (read.kind === 'sure' && read.clear && read.invoiceId) return settle('high', [read.invoiceId]);
    if (read.kind === 'named' && read.plan?.parts?.length) return settle('medium', read.plan.parts.map((x) => x.invoiceId));
    if (read.kind === 'sure' && read.invoiceId) return settle('medium', [read.invoiceId]);
    if (read.kind === 'possible' && read.invoiceId) return settle('medium', [read.invoiceId]);
    if (read.kind === 'amount' && read.invoiceId) return settle('low', [read.invoiceId]);
    if (loanClear.length === 1) return loanPlan(loanClear[0], 'high', 'the narration names this hand loan and the amount fits');
    if (loanCands.length === 1) return loanPlan(loanCands[0], 'medium', loanCands[0].why);
    if (read.kind === 'transfer') {
      return {
        confidence: 'medium', module: 'transfer', why: read.why, rule: null, label: 'Our own transfer', action: { type: 'categorise', kind: 'transfer' },
      };
    }
    if (read.kind === 'hand') {
      return {
        confidence: 'low', module: 'hand', why: read.why, rule: null, label: `${read.party} — money taken by hand`, action: { type: 'categorise', kind: 'hand', party: read.party },
      };
    }
    return null;
  }

  // A debit. 1 — a hand loan the narration names.
  if (loanClear.length === 1) return loanPlan(loanClear[0], 'high', 'the narration names this hand loan and the amount fits what is still to clear');
  // 2 — a rule the app has learnt.
  const rule = ruleHit(txn, ctx.rules.filter((r) => r.kind !== 'client'));
  if (rule) {
    const ruleWhy = `rule "${rule.match}"`;
    if ((rule.kind || 'expense') === 'expense' && rule.category) {
      return {
        confidence: 'high',
        module: rule.category === BANK_CHARGES_CATEGORY ? 'charges' : 'expense',
        why: ruleWhy,
        rule: rule.match,
        label: `${rule.category}${rule.vendor ? ` · ${rule.vendor}` : ''}`,
        action: {
          type: 'newBill', category: rule.category, vendor: rule.vendor || null, gstRate: rule.gstRate ?? null,
        },
      };
    }
    if (rule.kind === 'hand') {
      const loan = loans.find((l) => normName(l.name) === normName(rule.category));
      // The rule names a loan on file: high when the loan reading agrees, else a suggestion.
      if (loan) return { ...loanPlan({ loanId: loan.id, name: loan.name }, loanCands.some((c) => c.loanId === loan.id) ? 'high' : 'medium', ruleWhy), rule: rule.match };
      return {
        confidence: 'high', module: 'hand', why: ruleWhy, rule: rule.match, label: `${rule.category || 'Hand loan'} — paid out by hand`, action: { type: 'categorise', kind: 'hand', party: rule.category || null },
      };
    }
    if (rule.kind === 'transfer') {
      return {
        confidence: 'high', module: 'transfer', why: ruleWhy, rule: rule.match, label: 'Our own transfer', action: { type: 'categorise', kind: 'transfer' },
      };
    }
  }
  // 3 — an office bill already on file for this exact amount.
  const hay = tightName(`${txn.description || ''} ${txn.reference || ''}`);
  const bills = ctx.expenses.filter((e) => billFree(e, txn.id) && !e.bankTxnId && Math.abs(expenseNet(e) - amount) <= 1);
  const named = bills.filter((e) => tightName(e.vendor).length >= 4 && hay.indexOf(tightName(e.vendor).slice(0, 8)) >= 0);
  const billPlan = (b, confidence, why) => ({
    confidence,
    module: 'expense',
    why,
    rule: null,
    label: `${b.category}${b.vendor ? ` · ${b.vendor}` : ''}${b.billNumber ? ` · bill ${b.billNumber}` : ''}`,
    action: { type: 'linkBill', billId: b.id },
  });
  if (named.length === 1) return billPlan(named[0], 'high', `the narration names ${named[0].vendor} and the amount is the bill's`);
  const sameDay = bills.filter((e) => e.expenseDate === txn.date);
  if (sameDay.length === 1) return billPlan(sameDay[0], 'medium', `same amount and same day as the ${sameDay[0].category} bill`);
  // 4 — the bank's own charges.
  if (isBankCharge(txn)) {
    const account = ctx.accounts.find((a) => a.id === txn.bankAccountId) || ctx.accounts[0];
    return {
      confidence: 'high',
      module: 'charges',
      why: 'the narration reads as a charge the bank took',
      rule: null,
      label: `${BANK_CHARGES_CATEGORY} — what the bank takes`,
      action: {
        type: 'newBill', category: BANK_CHARGES_CATEGORY, vendor: account ? account.bank : null, gstRate: null,
      },
    };
  }
  // 5 — what the narration suggests: a payee paid before beats a loan the
  // narration only partly names; then a bill of the same amount; then a word.
  const guess = catzGuess(txn, ctx);
  const paidBefore = guess && guess.kind === 'expense' && guess.category && guess.vendor;
  if (!paidBefore && loanCands.length === 1) return loanPlan(loanCands[0], 'medium', loanCands[0].why);
  if (!paidBefore && bills.length === 1) return billPlan(bills[0], 'low', `same amount as the ${bills[0].category} bill of ${bills[0].expenseDate || '—'}`);
  if (guess && guess.kind === 'expense' && guess.category) {
    return {
      confidence: 'medium',
      module: 'expense',
      why: guess.why,
      rule: null,
      label: `${guess.category}${guess.vendor ? ` · ${guess.vendor}` : ''}`,
      action: {
        type: 'newBill', category: guess.category, vendor: guess.vendor || null, gstRate: guess.gstRate ?? null,
      },
    };
  }
  if (guess && guess.kind === 'hand') {
    return {
      confidence: 'medium', module: 'hand', why: guess.why, rule: null, label: `${guess.party} — paid out by hand`, action: { type: 'categorise', kind: 'hand', party: guess.party },
    };
  }
  if (guess && guess.kind === 'transfer') {
    return {
      confidence: 'medium', module: 'transfer', why: guess.why, rule: null, label: 'Our own transfer', action: { type: 'categorise', kind: 'transfer' },
    };
  }
  return null;
}

// A stable key for a plan, so Accept runs the suggestion the screen showed.
function planKey(plan) {
  const a = plan.action || {};
  return [a.type, (a.invoiceIds || []).join('+'), a.paymentId, a.loanId, a.billId, a.category, a.kind, a.party].filter(Boolean).join(':');
}

// Run one plan: write the record in its own module with this line as proof.
// Returns { record } on success or { error }.
async function applyPlan(txn, plan, ctx, loans, req, { accepted = false } = {}) {
  const a = plan.action;
  if (a.type === 'linkPayment') {
    const out = await linkPayment(txn, a.paymentId, req);
    return out.error ? out : { record: `receipt on ${out.payment?.invoice?.invoiceNumber || out.payment?.invoiceId || '—'}` };
  }
  if (a.type === 'settle') {
    const invoices = ctx.invoices.filter((i) => a.invoiceIds.includes(i.id) && isOpenInvoice(i));
    if (!invoices.length) return { error: 'The invoice is already settled.' };
    const out = await postAcrossInvoices(txn, invoices, req);
    if (out.error) return out;
    const clients = [...new Set(invoices.map((i) => i.client?.name).filter(Boolean))];
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        matched: true,
        matchedInvoiceId: out.plan.parts[0].invoiceId,
        reconStatus: 'Reconciled',
        matchedBy: actor(req),
        matchedDate: toIsoDate(new Date()),
        clientName: clients.length === 1 ? clients[0] : (clients.length ? `${clients[0]} +${clients.length - 1}` : null),
        excess: out.plan.unallocated > 0.5 ? out.plan.unallocated : null,
      },
    });
    return { record: out.plan.parts.map((p) => p.invoiceNumber).join(', ') };
  }
  if (a.type === 'loan') {
    const loan = loans.find((l) => l.id === a.loanId);
    if (!loan) return { error: 'That hand loan no longer exists.' };
    if (txn.type === 'Credit' && (loan.links || []).some((l) => l.kind === 'taken')) return { error: 'This loan already has the line it was taken on.' };
    try {
      await linkLoanLine(loan, txn, req, { auto: !accepted });
    } catch (err) {
      if (err.code === 'P2002') return { error: 'That line is already linked to a hand loan.' };
      throw err;
    }
    return { record: `${loan.name} (${txn.type === 'Credit' ? 'taken' : 'cleared — paid back'})` };
  }
  if (a.type === 'linkBill') {
    const b = await prisma.officeExpense.findUnique({ where: { id: a.billId } });
    if (!b || !billFree(b, txn.id) || (b.bankTxnId && b.bankTxnId !== txn.id)) return { error: 'That bill is no longer free.' };
    const data = { bankTxnId: txn.id };
    if (b.approvalStatus === 'APPROVED') Object.assign(data, { approvalStatus: 'PAID', paidStatus: 'Paid', paidAt: new Date(), paidById: req.user.id });
    else if (['PAID', 'REIMBURSED'].includes(b.approvalStatus)) data.paidStatus = 'Paid';
    await prisma.officeExpense.update({ where: { id: b.id }, data });
    const links = [{
      id: b.id, approvalStatus: b.approvalStatus, paidStatus: b.paidStatus, paidAt: b.paidAt, paidById: b.paidById, net: expenseNet(b),
    }];
    const left = ROUND(Math.max(0, ROUND(txn.amount) - expenseNet(b)));
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        category: b.category, categoryKind: 'expense', vendor: b.vendor || null, billLinks: JSON.stringify(links), excess: left > 0.5 ? left : null,
      },
    });
    return { record: `bill ${b.expenseCode || b.billNumber || b.id}` };
  }
  if (a.type === 'newBill') {
    const g = Number(a.gstRate || 0);
    const money = billMoney({ gst: g > 0 ? 'Yes' : 'No', gstRate: g, tds: 'No' }, ROUND(txn.amount));
    const bill = await prisma.officeExpense.create({
      data: {
        category: a.category,
        expenseAccount: a.category,
        vendor: a.vendor || null,
        expenseDate: String(txn.date).slice(0, 10),
        monthlyAmount: money.base,
        gstAmount: money.gst,
        tdsAmount: money.tds,
        gstRatePct: g > 0 ? g : null,
        paymentMode: 'Bank Transfer',
        description: String(txn.description || '').trim().slice(0, 500) || null,
        notes: `Filed from the bank statement line of ${txn.date}${txn.reference ? ` (Ref ${txn.reference})` : ''}${accepted ? '' : ' — matched automatically on import'}`,
        frequency: 'One-Time',
        recurring: false,
        entryKind: 'expense',
        paidStatus: 'Paid',
        approvalStatus: 'PAID',
        approvedBy: actor(req),
        createdById: req.user.id,
        paidById: req.user.id,
        paidAt: new Date(),
        destState: OUR_STATE,
        bankTxnId: txn.id,
      },
    });
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        category: a.category, categoryKind: 'expense', vendor: bill.vendor, counterparty: null, createdBillId: bill.id, excess: null,
      },
    });
    return { record: `bill ${bill.expenseCode || bill.id} · ${a.category}` };
  }
  if (a.type === 'categorise') {
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        category: null, categoryKind: a.kind, vendor: null, counterparty: a.party || null,
      },
    });
    return { record: a.kind === 'transfer' ? 'our own transfer' : `hand · ${a.party || '—'}` };
  }
  return { error: 'Nothing to do for this line.' };
}

// Remember an accepted / corrected match as a transaction rule.
async function learnRule(txn, fields) {
  if (!fields || !fields.category) return null;
  const match = payeePattern(txn);
  if (!match) return null;
  // Already recognised by a rule pointing the same way — nothing new to learn.
  const hit = ruleHit(txn, await prisma.bankRule.findMany());
  if (hit && (hit.kind || 'expense') === fields.kind && hit.category === fields.category) return null;
  return rememberRule(match, { vendor: null, gstRate: null, ...fields });
}

function ruleFromPlan(plan, ctx, loans) {
  const a = plan.action;
  if (a.type === 'settle' || a.type === 'linkPayment') {
    const inv = a.type === 'settle'
      ? ctx.invoices.find((i) => i.id === a.invoiceIds[0])
      : ctx.invoices.find((i) => i.id === (ctx.payments.find((p) => p.id === a.paymentId) || {}).invoiceId);
    return inv?.client?.name ? { kind: 'client', category: inv.client.name } : null;
  }
  if (a.type === 'loan') {
    const loan = loans.find((l) => l.id === a.loanId);
    return loan ? { kind: 'hand', category: loan.name } : null;
  }
  if (a.type === 'linkBill') {
    const b = ctx.expenses.find((e) => e.id === a.billId);
    return b ? { kind: 'expense', category: b.category, vendor: b.vendor || null } : null;
  }
  if (a.type === 'newBill') {
    return {
      kind: 'expense', category: a.category, vendor: a.vendor || null, gstRate: a.gstRate ?? null,
    };
  }
  if (a.type === 'categorise') return a.kind === 'hand' ? { kind: 'hand', category: a.party || '' } : { kind: 'transfer', category: 'Own transfer' };
  return null;
}

const MODULE_NAME = {
  invoice: 'Invoices', loan: 'Hand loans', expense: 'Office bills', charges: 'What the bank takes', hand: 'Hand loans', transfer: 'Own transfer',
};

async function logAutoMatch(req, txn, plan, record, how) {
  await logAudit({
    userId: req.user.id,
    action: how === 'accepted' ? 'Bank line matched (accepted) + proof attached' : 'Bank line matched automatically + proof attached',
    entity: 'BankTransaction',
    entityId: txn.id,
    fromValue: `${txn.date} · ${txn.type === 'Credit' ? 'in' : 'out'} ${fmtMoney(txn.amount)} · ${String(txn.description || '').slice(0, 60)}`,
    toValue: `${MODULE_NAME[plan.module] || plan.module} · ${record} · confidence ${plan.confidence}${plan.rule ? ` · rule "${plan.rule}"` : ''}`,
  });
}

// The import's own pass over the debits of one account (credits go through
// postAllNamed and hand loans through autoLinkLoans first, exactly as before).
async function autoFileDebits(accountId, firstId, req) {
  const [all, loans, ctx] = await Promise.all([
    prisma.bankTransaction.findMany(),
    prisma.handLoan.findMany({ include: { links: true } }),
    matchContext(),
  ]);
  const linked = new Set(loans.flatMap((l) => l.links.map((x) => x.bankTxnId)));
  const mine = oldestFirst(onAccount(all, accountId, firstId)).filter((t) => t.type === 'Debit' && lineOpen(t, linked));
  const done = [];
  for (const txn of mine) {
    const plan = linePlan(txn, ctx, loans);
    if (!plan || plan.confidence !== 'high' || plan.module === 'loan') continue; // loans: autoLinkLoans
    const out = await applyPlan(txn, plan, ctx, loans, req);
    if (out.error) continue;
    done.push({ txnId: txn.id, module: plan.module });
    await logAutoMatch(req, txn, plan, out.record, 'auto');
    if (plan.action.type === 'linkBill') ctx.expenses = await prisma.officeExpense.findMany();
  }
  return { filed: done.length, charges: done.filter((d) => d.module === 'charges').length, lines: done };
}

// Releases the statement line behind an office bill that is being deleted
// (routes/office.js DELETE): the proof link goes, the line goes back to
// uncategorised, the line itself is kept.
async function releaseLineForBill(bill) {
  if (!bill || !bill.bankTxnId) return null;
  const txn = await prisma.bankTransaction.findUnique({ where: { id: bill.bankTxnId } });
  if (!txn) return null;
  if (txn.createdBillId === bill.id) {
    return prisma.bankTransaction.update({
      where: { id: txn.id },
      data: {
        category: null, categoryKind: null, vendor: null, counterparty: null, createdBillId: null, excess: null,
      },
    });
  }
  if (txn.billLinks) {
    let links = [];
    try { links = JSON.parse(txn.billLinks) || []; } catch { links = []; }
    const left = links.filter((l) => l.id !== bill.id);
    if (left.length === links.length) return null;
    return prisma.bankTransaction.update({
      where: { id: txn.id },
      data: left.length
        ? { billLinks: JSON.stringify(left) }
        : {
          category: null, categoryKind: null, vendor: null, counterparty: null, billLinks: null, excess: null,
        },
    });
  }
  return null;
}

const lineShape = (t, why) => ({
  txnId: t.id, date: t.date, reference: t.reference || null, description: t.description, amount: ROUND(t.amount), type: t.type, why: why || null,
});

router.get('/hand-loans', async (req, res) => {
  const [loans, txns, accounts, ctx] = await Promise.all([
    prisma.handLoan.findMany({ include: { links: true }, orderBy: { dateTaken: 'desc' } }),
    prisma.bankTransaction.findMany(),
    prisma.bankAccount.findMany({ orderBy: { createdAt: 'asc' } }),
    matchContext(),
  ]);
  const reads = loanReads(loans, txns);
  const txnById = new Map(txns.map((t) => [t.id, t]));
  // S5 / S6: every movement with the statement line it came off (the proof),
  // and the people money went out to with no hand entry behind it.
  const movements = loans.flatMap((l) => l.links.map((x) => {
    const t = txnById.get(x.bankTxnId);
    return {
      linkId: x.id,
      loanId: l.id,
      person: l.name,
      lender: l.lender || null,
      kind: x.kind,
      date: x.date,
      amount: ROUND(x.amount),
      auto: x.auto,
      txnId: x.bankTxnId,
      type: t ? t.type : (x.kind === 'taken' ? 'Credit' : 'Debit'),
      description: t ? t.description : x.description,
      reference: t ? t.reference : x.reference,
      balance: t && t.balance != null ? ROUND(t.balance) : null,
      account: t ? accountLabel(accounts, t.bankAccountId) : '—',
      accountId: t ? (t.bankAccountId || (accounts[0] && accounts[0].id) || null) : null,
    };
  })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const linkedIds = new Set(movements.map((m) => m.txnId));
  const known = new Set(loans.flatMap((l) => [normName(l.name), normName(l.lender)]).filter(Boolean));
  const people = new Map();
  txns.forEach((t) => {
    if (t.type !== 'Debit' || t.excluded || linkedIds.has(t.id) || txnState(t) === 'Ignored') return;
    let name = null;
    if (t.categoryKind === 'hand') name = t.counterparty || null;
    else if (lineOpen(t, linkedIds)) {
      const g = catzGuess(t, ctx);
      if (g && g.kind === 'hand' && g.party && !/cash deposited/i.test(g.party)) name = g.party;
    }
    if (!name || known.has(normName(name))) return;
    const k = normName(name);
    if (!people.has(k)) people.set(k, { name, out: 0, count: 0, last: null, accountIds: new Set(), lines: [] });
    const p = people.get(k);
    p.out = ROUND(p.out + Number(t.amount || 0));
    p.count += 1;
    if (!p.last || String(t.date) > p.last) p.last = t.date;
    p.accountIds.add(t.bankAccountId || (accounts[0] && accounts[0].id));
    p.lines.push({
      txnId: t.id, date: t.date, amount: ROUND(t.amount), description: t.description, reference: t.reference || null, balance: t.balance == null ? null : ROUND(t.balance), account: accountLabel(accounts, t.bankAccountId), filed: t.categoryKind === 'hand',
    });
  });
  const unentered = [...people.values()].map((p) => ({
    name: p.name, out: p.out, count: p.count, last: p.last, account: [...p.accountIds].map((id) => accountLabel(accounts, id)).join(', '), lines: p.lines.sort((a, b) => String(b.date).localeCompare(String(a.date))),
  })).sort((a, b) => b.out - a.out);
  const rows = loans.map((l) => {
    const f = loanFigures(l);
    const r = reads.get(l.id);
    return {
      id: l.id,
      name: l.name,
      lender: l.lender,
      amount: ROUND(l.amount),
      dateTaken: l.dateTaken,
      notes: l.notes,
      taken: f.taken ? {
        linkId: f.taken.id, txnId: f.taken.bankTxnId, date: f.taken.date, reference: f.taken.reference, amount: ROUND(f.taken.amount), auto: f.taken.auto,
      } : null,
      repayments: f.repayments.map((x) => ({
        linkId: x.id, txnId: x.bankTxnId, date: x.date, reference: x.reference, amount: ROUND(x.amount), description: x.description, auto: x.auto,
      })),
      repaid: f.repaid,
      pending: f.pending,
      overpaid: f.overpaid,
      cleared: f.cleared,
      clearedDate: f.clearedDate,
      // Clear lines not yet linked (a statement imported before the loan was
      // entered) and possible ones to confirm.
      toLink: [r.takenClear, ...r.repayClear].filter(Boolean).map((t) => lineShape(t, 'the narration names this loan and the amount fits')),
      possible: [...r.takenMaybe, ...r.repayMaybe].slice(0, 20).map((m) => lineShape(m.t, m.why)),
    };
  });
  res.json({
    loans: rows,
    movements,
    unentered,
    summary: {
      loans: rows.length,
      taken: ROUND(rows.reduce((s, l) => s + l.amount, 0)),
      repaid: ROUND(rows.reduce((s, l) => s + l.repaid, 0)),
      pending: ROUND(rows.reduce((s, l) => s + l.pending, 0)),
      cleared: rows.filter((l) => l.cleared).length,
      paidOutNoEntry: ROUND(unentered.reduce((s, p) => s + p.out, 0)),
      peopleNoEntry: unentered.length,
      auto: movements.filter((m) => m.auto).length,
      accounts: new Set(movements.map((m) => m.accountId).filter(Boolean)).size,
    },
  });
});

function loanProblems(b) {
  const e = {};
  if (!String(b.name || '').trim()) e.name = 'Give the loan a name.';
  if (!(Number(b.amount) > 0)) e.amount = 'Enter the amount taken.';
  if (!b.dateTaken || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.dateTaken))) e.dateTaken = 'Enter the date taken.';
  return e;
}

router.post('/hand-loans', async (req, res) => {
  const b = req.body || {};
  const problems = loanProblems(b);
  if (Object.keys(problems).length) return res.status(400).json({ error: 'Some fields need attention.', fields: problems });
  const loan = await prisma.handLoan.create({
    data: {
      name: String(b.name).trim().slice(0, 120),
      lender: String(b.lender || '').trim().slice(0, 120) || null,
      amount: ROUND(b.amount),
      dateTaken: String(b.dateTaken).slice(0, 10),
      notes: String(b.notes || '').trim().slice(0, 1000) || null,
      createdById: req.user.id,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Hand loan added', entity: 'HandLoan', entityId: loan.id, toValue: `${loan.name} · ${fmtMoney(loan.amount)}` });
  const { linked } = await autoLinkLoans(req);
  res.status(201).json({ ...loan, linked });
});

router.put('/hand-loans/:id', async (req, res) => {
  const loan = await prisma.handLoan.findUnique({ where: { id: req.params.id } });
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  const b = { ...loan, ...req.body };
  const problems = loanProblems(b);
  if (Object.keys(problems).length) return res.status(400).json({ error: 'Some fields need attention.', fields: problems });
  const updated = await prisma.handLoan.update({
    where: { id: loan.id },
    data: {
      name: String(b.name).trim().slice(0, 120),
      lender: String(b.lender || '').trim().slice(0, 120) || null,
      amount: ROUND(b.amount),
      dateTaken: String(b.dateTaken).slice(0, 10),
      notes: String(b.notes || '').trim().slice(0, 1000) || null,
    },
  });
  // The lines already linked carry the loan's name on the statement view.
  const links = await prisma.handLoanLink.findMany({ where: { loanId: loan.id } });
  if (links.length && updated.name !== loan.name) {
    await prisma.bankTransaction.updateMany({ where: { id: { in: links.map((l) => l.bankTxnId) } }, data: { counterparty: updated.name } });
  }
  await logAudit({ userId: req.user.id, action: 'Hand loan updated', entity: 'HandLoan', entityId: loan.id, fromValue: `${loan.name} · ${fmtMoney(loan.amount)}`, toValue: `${updated.name} · ${fmtMoney(updated.amount)}` });
  const { linked } = await autoLinkLoans(req);
  res.json({ ...updated, linked });
});

// Removing a loan unlinks its lines (they go back to uncategorised); the
// statement itself is never touched.
router.delete('/hand-loans/:id', async (req, res) => {
  const loan = await prisma.handLoan.findUnique({ where: { id: req.params.id }, include: { links: true } });
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  const ids = loan.links.map((l) => l.bankTxnId);
  if (ids.length) {
    await prisma.bankTransaction.updateMany({ where: { id: { in: ids }, categoryKind: 'hand' }, data: { categoryKind: null, counterparty: null } });
  }
  await prisma.handLoan.delete({ where: { id: loan.id } });
  await logAudit({ userId: req.user.id, action: 'Hand loan removed', entity: 'HandLoan', entityId: loan.id, fromValue: `${loan.name} · ${fmtMoney(loan.amount)}`, toValue: `${ids.length} line(s) unlinked` });
  res.json({ removed: loan.id, unlinked: ids.length });
});

// Confirm a possible line (or link any eligible line) as this loan's taking
// (a credit) or a repayment (a debit).
router.post('/hand-loans/:id/link', async (req, res) => {
  const loan = await prisma.handLoan.findUnique({ where: { id: req.params.id }, include: { links: true } });
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  const txn = await loadTxn(String(req.body?.bankTxnId || ''));
  if (!txn) return res.status(404).json({ error: 'Statement line not found' });
  const taken = await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } });
  if (taken) return res.status(400).json({ error: 'That line is already linked to a hand loan' });
  if (!loanEligible(txn, new Set())) {
    return res.status(400).json({ error: 'That line is already posted, filed or ignored — undo that first' });
  }
  if (txn.type === 'Credit' && loan.links.some((l) => l.kind === 'taken')) {
    return res.status(400).json({ error: 'This loan already has the line it was taken on — unlink that first' });
  }
  try {
    await linkLoanLine(loan, txn, req);
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'That line is already linked to a hand loan' });
    throw err;
  }
  await learnRule(txn, { kind: 'hand', category: loan.name });
  await logAudit({
    userId: req.user.id, action: txn.type === 'Credit' ? 'Hand loan taking linked' : 'Hand loan repayment linked', entity: 'HandLoan', entityId: loan.id,
    toValue: `${txn.date} · ${fmtMoney(txn.amount)}${txn.reference ? ` · ${txn.reference}` : ''}`,
  });
  const fresh = await prisma.handLoan.findUnique({ where: { id: loan.id }, include: { links: true } });
  const f = loanFigures(fresh);
  res.json({ linked: true, repaid: f.repaid, pending: f.pending, cleared: f.cleared, clearedDate: f.clearedDate });
});

router.delete('/hand-loans/links/:linkId', async (req, res) => {
  const link = await prisma.handLoanLink.findUnique({ where: { id: req.params.linkId } });
  if (!link) return res.status(404).json({ error: 'That link no longer exists' });
  await prisma.handLoanLink.delete({ where: { id: link.id } });
  await prisma.bankTransaction.updateMany({ where: { id: link.bankTxnId, categoryKind: 'hand' }, data: { categoryKind: null, counterparty: null } });
  await logAudit({ userId: req.user.id, action: 'Hand loan line unlinked', entity: 'HandLoan', entityId: link.loanId, fromValue: `${link.date} · ${fmtMoney(link.amount)}`, toValue: '—' });
  res.json({ unlinked: link.id });
});

router.post('/hand-loans/auto-match', async (req, res) => {
  res.json(await autoLinkLoans(req));
});

// ---------------------------------------------------------------------------
// S5 — the proof strip, "What the bank takes", and one-click Accept.
// ---------------------------------------------------------------------------

// Every payment the books hold, and whether a document stands behind it:
// a client receipt (the bank line, or the proof on the invoice itself when
// there is no receipt row), a paid office bill (the bank line or its bill
// file), and every hand-loan movement (always a bank line).
router.get('/proof', async (req, res) => {
  let invoices;
  try {
    invoices = await prisma.invoice.findMany({
      select: {
        id: true, receivedAmount: true, proofFile: true, proofRef: true, _count: { select: { payments: true } },
      },
    });
  } catch {
    invoices = (await prisma.invoice.findMany({ select: { id: true, receivedAmount: true, _count: { select: { payments: true } } } }));
  }
  const [payments, bills, loanLinks] = await Promise.all([
    prisma.invoicePayment.findMany({ select: { id: true, bankTxnId: true } }),
    prisma.officeExpense.findMany({ where: { paidStatus: 'Paid' }, select: { id: true, entryKind: true, bankTxnId: true, proofFile: true, proofName: true } }),
    prisma.handLoanLink.count(),
  ]);
  const onInvoice = invoices.filter((i) => Number(i.receivedAmount || 0) > 0.5 && !i._count.payments);
  const receipts = { total: payments.length + onInvoice.length, withProof: payments.filter((p) => p.bankTxnId).length + onInvoice.filter((i) => i.proofFile || i.proofRef).length };
  const office = bills.filter((b) => b.entryKind !== 'hand');
  const billsOut = { total: office.length, withProof: office.filter((b) => b.bankTxnId || b.proofFile || b.proofName).length };
  const loans = { total: loanLinks, withProof: loanLinks };
  const total = receipts.total + billsOut.total + loans.total;
  const withProof = receipts.withProof + billsOut.withProof + loans.withProof;
  res.json({
    total, withProof, missing: total - withProof, receipts, bills: billsOut, loans,
  });
});

// The bank's own charges, every account, month by month.
router.get('/charges', async (req, res) => {
  const txns = await prisma.bankTransaction.findMany();
  const lines = txns.filter(lineIsCharge);
  const byMonth = new Map();
  lines.forEach((t) => {
    const k = String(t.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(k)) return;
    if (!byMonth.has(k)) byMonth.set(k, { key: k, count: 0, amount: 0, notFiled: 0 });
    const m = byMonth.get(k);
    m.count += 1;
    m.amount = ROUND(m.amount + Number(t.amount || 0));
    if (t.category !== BANK_CHARGES_CATEGORY) m.notFiled += 1;
  });
  const months = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
  const total = ROUND(months.reduce((s, m) => s + m.amount, 0));
  res.json({
    months,
    total,
    monthsCounted: months.length,
    average: months.length ? ROUND(total / months.length) : 0,
    notFiled: lines.filter((t) => t.category !== BANK_CHARGES_CATEGORY).length,
    notFiledAmount: ROUND(lines.filter((t) => t.category !== BANK_CHARGES_CATEGORY).reduce((s, t) => s + Number(t.amount || 0), 0)),
  });
});

// One-click Accept on a suggestion under "Categorise now →": runs exactly the
// step the automatic pass would have run, then remembers it as a rule.
router.post('/:id/accept', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const [loans, ctx] = await Promise.all([prisma.handLoan.findMany({ include: { links: true } }), matchContext()]);
  const linked = new Set(loans.flatMap((l) => l.links.map((x) => x.bankTxnId)));
  if (!lineOpen(txn, linked)) return res.status(400).json({ error: 'This line is already filed, posted or ignored — undo that first.' });
  const plan = linePlan(txn, ctx, loans);
  if (!plan) return res.status(400).json({ error: 'The app has no suggestion for this line — open it and file it by hand.' });
  if (req.body?.key && req.body.key !== planKey(plan)) {
    return res.status(409).json({ error: 'The suggestion for this line has changed — look at it again.', plan: { ...plan, key: planKey(plan) } });
  }
  const out = await applyPlan(txn, plan, ctx, loans, req, { accepted: true });
  if (out.error) return res.status(400).json({ error: out.error });
  await logAutoMatch(req, txn, plan, out.record, 'accepted');
  let rule = null;
  if (!plan.rule) {
    rule = await learnRule(txn, ruleFromPlan(plan, ctx, loans));
    if (rule) await logAudit({ userId: req.user.id, action: 'Transaction rule learnt', entity: 'BankRule', entityId: rule.id, toValue: `"${rule.match}" → ${rule.category} (${rule.kind})` });
  }
  return res.json({
    accepted: true, record: out.record, module: plan.module, label: plan.label, rule: rule ? { id: rule.id, match: rule.match, category: rule.category, kind: rule.kind } : null,
  });
});

// "⬇ Whole workbook" (S6): the whole Bank & Reconciliation screen as one
// Excel file — accounts, every statement line with what it is filed as, the
// hand-loan movements, what the bank takes month by month, and the rules.
router.get('/workbook', requirePerm('accounts', 'accounts', 'Bank & Reconciliation', 'export'), async (req, res) => {
  const ExcelJS = require('exceljs');
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const [txns, loans, rules] = await Promise.all([
    prisma.bankTransaction.findMany({ orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    prisma.handLoan.findMany({ include: { links: true } }),
    prisma.bankRule.findMany({ orderBy: { createdAt: 'asc' } }),
  ]);
  const loanOf = new Map(loans.flatMap((l) => l.links.map((x) => [x.bankTxnId, { loan: l, link: x }])));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TeamLink Accounts';
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([header, key, width, numFmt]) => ({ header, key, width: width || 16, style: numFmt ? { numFmt } : undefined }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    rows.forEach((r) => ws.addRow(r));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    return ws;
  };
  const INR = '#,##,##0.00';
  sheet('Accounts', [['Bank', 'bank', 18], ['Account name', 'name', 30], ['Account no', 'accNo', 18], ['Opening balance', 'openBal', 16, INR], ['Opening date', 'openDate', 14], ['Lines', 'lines', 8], ['Amount in bank', 'inBank', 16, INR], ['Amount in the books', 'inBooks', 18, INR]],
    accounts.map((a) => {
      const s = accountStat(a, onAccount(txns, a.id, firstId));
      return { bank: a.bank, name: a.name || '', accNo: a.accNo || '', openBal: Number(a.openBal || 0), openDate: a.openDate || '', lines: s.lines, inBank: s.inBank, inBooks: s.inBooks };
    }));
  const filedAs = (t) => {
    const l = loanOf.get(t.id);
    if (l) return `Hand loan · ${l.loan.name} · ${l.link.kind === 'taken' ? 'taken' : 'cleared — paid back'}`;
    if (txnState(t) === 'Reconciled') return `Client receipt · ${t.clientName || '—'}`;
    if (t.categoryKind === 'transfer') return 'Our own transfer';
    if (t.categoryKind === 'hand') return `Hand · ${t.counterparty || '—'}`;
    if (t.category) return `Office bill · ${t.category}`;
    if (txnState(t) === 'Ignored') return 'Ignored';
    return t.excluded ? 'Excluded' : 'Uncategorised';
  };
  sheet('Statement lines', [['Account', 'account', 22], ['Date', 'date', 12], ['Narration', 'description', 60], ['Reference', 'reference', 20], ['Money in', 'credit', 14, INR], ['Money out', 'debit', 14, INR], ['Balance after', 'balance', 16, INR], ['State', 'state', 12], ['Filed as', 'filed', 40]],
    txns.map((t) => ({
      account: accountLabel(accounts, t.bankAccountId), date: t.date, description: t.description, reference: t.reference || '', credit: t.type === 'Credit' ? ROUND(t.amount) : null, debit: t.type === 'Debit' ? ROUND(t.amount) : null, balance: t.balance == null ? null : ROUND(t.balance), state: txnState(t), filed: filedAs(t),
    })));
  sheet('Hand loans', [['Person', 'person', 26], ['Date', 'date', 12], ['What happened', 'kind', 22], ['Amount', 'amount', 14, INR], ['Account', 'account', 22], ['Narration', 'description', 60], ['Picked up on its own', 'auto', 10]],
    loans.flatMap((l) => l.links.map((x) => {
      const t = txns.find((y) => y.id === x.bankTxnId);
      return { person: l.name, date: x.date, kind: x.kind === 'taken' ? 'Taken by hand' : 'Cleared — paid back', amount: ROUND(x.amount), account: t ? accountLabel(accounts, t.bankAccountId) : '—', description: x.description || '', auto: x.auto ? 'yes' : '' };
    })));
  const charges = new Map();
  txns.filter(lineIsCharge).forEach((t) => {
    const k = String(t.date).slice(0, 7);
    const m = charges.get(k) || { month: k, count: 0, amount: 0 };
    m.count += 1; m.amount = ROUND(m.amount + Number(t.amount || 0));
    charges.set(k, m);
  });
  sheet('What the bank takes', [['Month', 'month', 12], ['Charges', 'count', 10], ['Amount', 'amount', 14, INR]], [...charges.values()].sort((a, b) => a.month.localeCompare(b.month)));
  sheet('Transaction rules', [['Text on the statement', 'match', 30], ['Becomes', 'category', 30], ['Kind', 'kind', 12], ['Vendor', 'vendor', 24]], rules.map((r) => ({ match: r.match, category: r.category, kind: r.kind, vendor: r.vendor || '' })));
  await logAudit({ userId: req.user.id, action: 'Bank workbook exported', entity: 'BankTransaction', toValue: `${txns.length} line(s) · ${accounts.length} account(s)` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bank-and-reconciliation-${toIsoDate(new Date())}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// Every debit the app already recognises becomes an office bill in one press.
router.post('/quick-categorise', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.body?.bankAccountId || firstId;
  const all = await prisma.bankTransaction.findMany();
  const ctx = await matchContext();
  const mine = onAccount(all, accountId, firstId)
    .filter((t) => t.type === 'Debit' && !t.excluded && !t.category && !t.categoryKind && !t.createdBillId && !t.billLinks && txnState(t) !== 'Reconciled');
  let filed = 0;
  for (const txn of mine) {
    const guess = catzGuess(txn, ctx);
    if (!guess || (!guess.category && guess.kind !== 'hand' && guess.kind !== 'transfer')) continue;
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: { category: guess.category || null, categoryKind: guess.kind, vendor: guess.vendor || null, counterparty: guess.party || null },
    });
    filed += 1;
  }
  if (!filed) return res.status(400).json({ error: 'No debit on this account is recognised yet.' });
  await logAudit({ userId: req.user.id, action: 'Recognised debits categorised', entity: 'BankTransaction', entityId: accountId, toValue: `${filed} line(s)` });
  res.json({ filed });
});

// ---------------------------------------------------------------------------
// Rules the app has learnt
// ---------------------------------------------------------------------------

router.get('/rules', async (req, res) => {
  const [rules, transactions] = await Promise.all([
    prisma.bankRule.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.bankTransaction.findMany(),
  ]);
  res.json(rules.map((r) => ({
    ...r,
    group: r.kind === 'client' ? 'Client receipt' : r.kind === 'hand' ? 'Hand loan' : r.kind === 'transfer' ? 'Own transfer' : coaGroupOf(r.category),
    lines: transactions.filter((t) => ruleHit(t, [r])).length,
  })));
});

router.delete('/rules/:id', async (req, res) => {
  const rule = await prisma.bankRule.findUnique({ where: { id: req.params.id } });
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  await prisma.bankRule.delete({ where: { id: rule.id } });
  await logAudit({ userId: req.user.id, action: 'Rule deleted', entity: 'BankRule', entityId: rule.id, fromValue: rule.match, toValue: '—' });
  res.json({ deleted: rule.id });
});

// ---------------------------------------------------------------------------
// The balance log — what the bank actually showed on a date, typed in by hand
// ---------------------------------------------------------------------------

const MARK_KINDS = ['Bank balance on that date', 'Cleared / settled', 'Opening balance', 'Adjustment'];

router.get('/marks', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.query.bankAccountId || firstId;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  const [marks, all] = await Promise.all([
    prisma.bankMark.findMany({ orderBy: { date: 'desc' } }),
    prisma.bankTransaction.findMany(),
  ]);
  const rows = onAccount(all, account.id, firstId);
  const mine = marks.filter((m) => (m.bankAccountId || firstId) === account.id);

  // The month-by-month table, worked out from the statements themselves.
  const byMonth = new Map();
  rows.forEach((t) => {
    const k = String(t.date || '').slice(0, 7);
    if (!k) return;
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(t);
  });
  const months = [...byMonth.keys()].sort().reverse().map((k) => {
    const ordered = oldestFirst(byMonth.get(k));
    const withBalance = ordered.filter((t) => t.balance != null);
    const last = withBalance.length ? withBalance[withBalance.length - 1] : null;
    const on = last ? last.date : ordered[ordered.length - 1].date;
    const credits = ordered.filter((t) => t.type === 'Credit');
    const bank = last ? ROUND(Number(last.balance)) : null;
    const books = balanceOn(account, rows, on);
    return {
      key: k,
      on,
      lines: ordered.length,
      in: ROUND(credits.reduce((s, t) => s + Number(t.amount || 0), 0)),
      out: ROUND(ordered.filter((t) => t.type === 'Debit').reduce((s, t) => s + Number(t.amount || 0), 0)),
      bank,
      books,
      gap: bank == null ? null : ROUND(bank - books),
      posted: credits.filter((t) => txnState(t) === 'Reconciled').length,
      open: credits.filter((t) => txnState(t) !== 'Reconciled').length,
    };
  });

  res.json({
    kinds: MARK_KINDS,
    account,
    months,
    marks: mine.map((m) => {
      const books = m.balance == null ? null : balanceOn(account, rows, m.date);
      return {
        ...m,
        books,
        gap: books == null ? null : ROUND(Number(m.balance) - books),
        matches: m.match
          ? rows.filter((t) => normName(t.description).indexOf(normName(m.match)) >= 0 || normName(t.reference).indexOf(normName(m.match)) >= 0).map((t) => t.id)
          : [],
      };
    }),
  });
});

router.post('/marks', async (req, res) => {
  const accounts = await ensureAccounts();
  const date = String(req.body?.date || '').slice(0, 10);
  if (!date) return res.status(400).json({ error: 'Put the date first.' });
  const balance = req.body?.balance === '' || req.body?.balance == null ? null : Number(req.body.balance);
  const cleared = req.body?.cleared === '' || req.body?.cleared == null ? null : Number(req.body.cleared);
  if (balance == null && cleared == null) return res.status(400).json({ error: 'Type the balance, or the amount cleared.' });
  const created = await prisma.bankMark.create({
    data: {
      bankAccountId: req.body?.bankAccountId || accounts[0].id,
      date,
      kind: req.body?.kind || MARK_KINDS[0],
      balance,
      cleared,
      match: req.body?.match || null,
      note: req.body?.note || null,
      recordedBy: actor(req),
    },
  });
  await logAudit({ userId: req.user.id, action: created.kind, entity: 'BankMark', entityId: created.id, toValue: `${date}${balance != null ? ` · balance ${fmtMoney(balance)}` : ''}${cleared != null ? ` · cleared ${fmtMoney(cleared)}` : ''}` });
  res.status(201).json(created);
});

router.delete('/marks/:id', async (req, res) => {
  const mark = await prisma.bankMark.findUnique({ where: { id: req.params.id } });
  if (!mark) return res.status(404).json({ error: 'Entry not found' });
  await prisma.bankMark.delete({ where: { id: mark.id } });
  await logAudit({ userId: req.user.id, action: 'Balance entry removed', entity: 'BankMark', entityId: mark.id, fromValue: mark.date, toValue: '—' });
  res.json({ deleted: mark.id });
});

// Make an opening-balance entry the account's actual opening balance.
router.post('/marks/:id/use-opening', async (req, res) => {
  const mark = await prisma.bankMark.findUnique({ where: { id: req.params.id } });
  if (!mark) return res.status(404).json({ error: 'Entry not found' });
  if (mark.balance == null) return res.status(400).json({ error: 'That entry carries no balance' });
  const accounts = await ensureAccounts();
  const account = accounts.find((a) => a.id === (mark.bankAccountId || accounts[0].id)) || accounts[0];
  const before = Number(account.openBal || 0);
  const updated = await prisma.bankAccount.update({ where: { id: account.id }, data: { openBal: Number(mark.balance), openDate: mark.date } });
  await logAudit({ userId: req.user.id, action: 'Opening balance set from the balance log', entity: 'BankAccount', entityId: account.id, fromValue: fmtMoney(before), toValue: `${fmtMoney(updated.openBal)} as on ${mark.date}` });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Every statement that has ever been imported
// ---------------------------------------------------------------------------

router.get('/imports', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.query.bankAccountId || firstId;
  const [imports, all] = await Promise.all([
    prisma.bankImport.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.bankTransaction.findMany(),
  ]);
  const rows = onAccount(all, accountId, firstId);
  res.json(imports.filter((i) => (i.bankAccountId || firstId) === accountId).map((i) => {
    const mine = rows.filter((t) => t.importBatch === i.id);
    const credits = mine.filter((t) => t.type === 'Credit');
    return {
      ...i,
      onFile: mine.length,
      removed: Math.max(0, i.lines - mine.length),
      open: credits.filter((t) => txnState(t) !== 'Reconciled').length,
      posted: credits.filter((t) => txnState(t) === 'Reconciled').length,
    };
  }));
});

router.delete('/imports/:id', async (req, res) => {
  const imp = await prisma.bankImport.findUnique({ where: { id: req.params.id } });
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  const mine = await prisma.bankTransaction.findMany({ where: { importBatch: imp.id } });
  const posted = mine.filter((t) => txnState(t) === 'Reconciled');
  if (posted.length) return res.status(400).json({ error: `${posted.length} line(s) from this file are already posted — undo those first.` });
  const tiedImp = await tiedLines(mine);
  if (tiedImp) return res.status(400).json({ error: `${tiedImp} line(s) from this file back an office bill or a hand loan — undo those first.` });
  await prisma.bankTransaction.deleteMany({ where: { importBatch: imp.id } });
  await prisma.bankImport.delete({ where: { id: imp.id } });
  await logAudit({ userId: req.user.id, action: 'Import removed', entity: 'BankImport', entityId: imp.id, fromValue: imp.file || '—', toValue: `${mine.length} line(s) deleted` });
  res.json({ deleted: mine.length });
});

// ---------------------------------------------------------------------------
// A line by hand, and removing one
// ---------------------------------------------------------------------------

router.post('/entry', async (req, res) => {
  const accounts = await ensureAccounts();
  const credit = Number(req.body?.credit || 0);
  const debit = Number(req.body?.debit || 0);
  if (!credit && !debit) return res.status(400).json({ error: 'Enter a credit or a debit amount.' });
  const created = await prisma.bankTransaction.create({
    data: {
      bankAccountId: req.body?.bankAccountId || accounts[0].id,
      date: String(req.body?.date || toIsoDate(new Date())).slice(0, 10),
      description: String(req.body?.description || '—'),
      reference: req.body?.reference || null,
      type: credit ? 'Credit' : 'Debit',
      amount: ROUND(credit || debit),
      balance: null,
    },
  });
  await logAudit({ userId: req.user.id, action: 'Entry added by hand', entity: 'BankTransaction', entityId: created.id, toValue: `${credit ? 'credit ' : 'debit '}${fmtMoney(credit || debit)}` });
  res.status(201).json(created);
});

router.delete('/:id', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txnState(txn) === 'Reconciled') return res.status(400).json({ error: 'Undo the posting first.' });
  if (await tiedLines([txn])) return res.status(400).json({ error: 'This line backs an office bill or a hand loan — undo that first.' });
  await prisma.bankTransaction.delete({ where: { id: txn.id } });
  await logAudit({ userId: req.user.id, action: 'Statement line deleted', entity: 'BankTransaction', entityId: txn.id, fromValue: `${txn.date} · ${fmtMoney(txn.amount)}`, toValue: '—' });
  res.json({ deleted: txn.id });
});

// Remove the extra copies of a line imported more than once. The first copy of
// each is kept.
router.post('/duplicates/remove', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.body?.bankAccountId || firstId;
  const all = await prisma.bankTransaction.findMany();
  const extras = duplicateGroups(onAccount(all, accountId, firstId)).flatMap((g) => g.slice(1));
  if (!extras.length) return res.status(400).json({ error: 'No duplicate lines on this account.' });
  const posted = extras.filter((t) => txnState(t) === 'Reconciled');
  if (posted.length) return res.status(400).json({ error: `${posted.length} of the extra copies are already posted — undo those first.` });
  const tiedDup = await tiedLines(extras);
  if (tiedDup) return res.status(400).json({ error: `${tiedDup} of the extra copies back an office bill or a hand loan — undo those first.` });
  await prisma.bankTransaction.deleteMany({ where: { id: { in: extras.map((t) => t.id) } } });
  await logAudit({ userId: req.user.id, action: 'Duplicate lines removed', entity: 'BankTransaction', entityId: accountId, toValue: `${extras.length} line(s)` });
  res.json({ removed: extras.length });
});

// ---------------------------------------------------------------------------

// A forgiving statement parser: finds the header row, then maps date /
// description / reference / debit / credit / balance columns by name.
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { error: 'The file is empty' };
  const split = (l) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i += 1) {
      const c = l[i];
      if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; } else if ((c === ',' || c === '\t') && !q) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim().replace(/^"|"$/g, ''));
  };
  const num = (v) => {
    const n = String(v == null ? '' : v).replace(/[₹,\s]/g, '');
    return n === '' || Number.isNaN(Number(n)) ? null : Number(n);
  };
  const iso = (v) => {
    const t = String(v || '').trim();
    let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
    return null;
  };

  let hi = -1;
  let head = null;
  for (let i = 0; i < Math.min(lines.length, 25); i += 1) {
    const c = split(lines[i]).map((x) => x.toLowerCase());
    if (c.some((x) => /date/.test(x)) && c.some((x) => /credit|deposit|withdraw|debit|amount/.test(x))) { hi = i; head = c; break; }
  }
  if (hi < 0) return { error: 'No header row with a date and an amount column was found' };

  const find = (...pats) => { for (const p of pats) { const i = head.findIndex((h) => p.test(h)); if (i >= 0) return i; } return -1; };
  const iDate = find(/date/);
  const iDesc = find(/narration|description|particular|remark|details/);
  const iRef = find(/ref|utr|cheque|chq/);
  const iCr = find(/deposit|credit|money in/);
  const iDr = find(/withdraw|debit|money out/);
  const iAmt = find(/^amount$/, /amount/);
  const iBal = find(/balance|closing/);

  const rows = [];
  let bad = 0;
  for (const line of lines.slice(hi + 1)) {
    const c = split(line);
    const date = iso(c[iDate]);
    if (!date) { bad += 1; continue; }
    const cr = iCr >= 0 ? num(c[iCr]) : null;
    const dr = iDr >= 0 ? num(c[iDr]) : null;
    let amount = null;
    let type = null;
    if (cr) { amount = Math.abs(cr); type = 'Credit'; } else if (dr) { amount = Math.abs(dr); type = 'Debit'; } else if (iAmt >= 0) {
      const a = num(c[iAmt]);
      if (a != null && a !== 0) { amount = Math.abs(a); type = a > 0 ? 'Credit' : 'Debit'; }
    }
    if (amount == null) { bad += 1; continue; }
    rows.push({
      date,
      description: iDesc >= 0 ? c[iDesc] : '—',
      reference: iRef >= 0 ? c[iRef] : null,
      amount,
      type,
      balance: iBal >= 0 ? num(c[iBal]) : null,
    });
  }
  if (!rows.length) return { error: 'No usable transaction rows were found below the header' };
  return { rows, bad };
}

router.importStatement = importStatement;
router.releaseLineForBill = releaseLineForBill;
module.exports = router;
