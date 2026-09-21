const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  ROUND, invoiceTotal, invoiceOutstanding, deriveInvoiceStatus,
  suggestInvoiceFor, txnState, toIsoDate, isOpenInvoice, normName,
} = require('../utils/accounts');

const router = express.Router();
router.use(requireAuth);

router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Bank & Reconciliation', 'view'));

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
  [/airtel|jio|vodafone|vi\b/i, 'Airtel Bill'],
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
  const rule = ruleHit(txn, ctx.rules);
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
  already: '', sure: 'priority-low', named: 'priority-low', amount: 'priority-medium',
  client: 'priority-medium', many: 'priority-medium', expense: '', hand: '', transfer: '', none: 'priority-high',
};

const fmtMoney = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Step 1..5 for a credit.
function readCreditLine(txn, ctx) {
  const amount = ROUND(txn.amount);
  const refn = `${normName(txn.reference)} ${normName(txn.description)}`;

  // 1 — already recorded: a payment with the same reference, or the same
  //     amount on the same day.
  const already = ctx.payments.find((p) => {
    const pr = normName(p.reference);
    if (pr && pr.length > 5 && refn.indexOf(pr) >= 0) return true;
    return Math.abs(Number(p.amount || 0) - amount) <= BANK_TOL && String(p.date) === String(txn.date);
  });
  if (already) {
    const inv = ctx.invoices.find((i) => i.id === already.invoiceId);
    return {
      kind: 'already',
      client: inv?.client?.name || null,
      invoiceNumber: inv?.invoiceNumber || null,
      why: `Already recorded as a payment on ${already.date}`,
    };
  }

  // 2 — client named in the narration.
  const named = txn.clientName
    ? ctx.clients.find((c) => c.name === txn.clientName)
    : readClient(txn.description, ctx.clients, ctx.df);
  const open = ctx.invoices.filter(isOpenInvoice);
  if (named) {
    const theirs = open.filter((i) => i.clientId === named.id);
    const exact = theirs.find((i) => Math.abs(invoiceOutstanding(i) - amount) <= BANK_TOL);
    if (exact) {
      return {
        kind: 'sure',
        client: named.name,
        clientId: named.id,
        invoiceId: exact.id,
        invoiceNumber: exact.invoiceNumber || exact.id.slice(-6),
        amount,
        options: theirs.map((i) => i.id),
        why: `Narration names ${named.name} and it clears invoice ${exact.invoiceNumber || exact.id.slice(-6)} exactly`,
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
    prisma.invoice.findMany({ include: { client: true } }),
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
  const un = live.filter((t) => txnState(t) !== 'Reconciled' && !t.category);
  const inBank = statedBalance(rows);
  const inBooks = booksBalance(account, rows);
  const implied = impliedOpening(rows);
  const ordered = oldestFirst(rows);
  return {
    lines: live.length,
    unmatched: un.length,
    excluded: rows.filter((t) => t.excluded).length,
    matched: live.filter((t) => txnState(t) === 'Reconciled' || !!t.category).length,
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
    const recognised = mine.filter((t) => !t.excluded && txnState(t) !== 'Reconciled' && !t.category)
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
  const [transactions, ctx] = await Promise.all([
    prisma.bankTransaction.findMany({ orderBy: { date: 'desc' } }),
    matchContext(),
  ]);
  const invoiceById = new Map(ctx.invoices.map((i) => [i.id, i]));

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
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.body?.bankAccountId || firstId;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];

  let rows = Array.isArray(req.body?.transactions) ? req.body.transactions : null;
  if (!rows && typeof req.body?.csv === 'string') {
    const parsed = parseCsv(req.body.csv);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    rows = parsed.rows;
  }
  if (!rows || !rows.length) return res.status(400).json({ error: 'Provide transactions[] or csv text to import' });

  const dedup = req.body?.dedup !== 'No' && req.body?.dedup !== false;
  const existing = await prisma.bankTransaction.findMany();
  const key = (t) => [t.date, t.type, ROUND(t.amount), String(t.reference || '').trim().toLowerCase() || String(t.description || '').trim().toLowerCase()].join('|');
  const seen = new Set(onAccount(existing, account.id, firstId).map(key));

  const batch = `IMP-${Date.now()}`;
  const file = String(req.body?.file || 'pasted text');
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
  if (created.length && req.body?.autoPost !== 'no' && req.body?.autoPost !== false) {
    const result = await postAllNamed(account.id, firstId, req);
    autoPosted = result.posted;
  }

  res.status(201).json({
    batch, imported: created.length, duplicates: skipped.length, skipped, openingSetTo, autoPosted, transactions: created,
  });
});

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

// Post every credit whose narration names a client with money still outstanding.
async function postAllNamed(accountId, firstId, req) {
  const all = await prisma.bankTransaction.findMany();
  const mine = onAccount(all, accountId, firstId)
    .filter((t) => t.type === 'Credit' && txnState(t) === 'Unmatched' && !t.excluded);
  let posted = 0;
  let value = 0;
  for (const txn of mine) {
    // Re-read each time: balances move as we post.
    const ctx = await matchContext();
    const read = readLine(txn, ctx);
    if (read.kind !== 'sure' && read.kind !== 'named') continue;
    const theirs = ctx.invoices.filter((i) => i.clientId === read.clientId && isOpenInvoice(i));
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
  const theirs = ctx.invoices.filter((i) => i.clientId === client.id && isOpenInvoice(i));
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

  let reversed = 0;
  if (state === 'Reconciled') {
    const payments = await prisma.invoicePayment.findMany({ where: { bankTxnId: txn.id } });
    for (const p of payments) {
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

// Every invoice this credit could settle, or every bill this debit could be.
router.get('/:id/candidates', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const ctx = await matchContext();
  const amount = ROUND(txn.amount);
  const read = readLine(txn, ctx);
  if (txn.type === 'Credit') {
    const open = ctx.invoices.filter(isOpenInvoice);
    const clientName = txn.clientName || read.client || null;
    const best = open.filter((i) => Math.abs(invoiceOutstanding(i) - amount) <= BANK_TOL);
    const rest = open.filter((i) => !best.includes(i));
    const score = (i) => ((clientName && i.client?.name === clientName) ? 0 : 1) * 1e12 + Math.abs(invoiceOutstanding(i) - amount);
    const shape = (i) => ({
      id: i.id, invoiceNumber: i.invoiceNumber || i.id.slice(-6), client: i.client?.name || '—',
      invoiceDate: i.invoiceDate, total: invoiceTotal(i), outstanding: invoiceOutstanding(i),
      diff: ROUND(invoiceOutstanding(i) - amount),
    });
    return res.json({ kind: 'Credit', amount, read, client: clientName, best: best.map(shape), maybe: rest.sort((a, b) => score(a) - score(b)).slice(0, 60).map(shape) });
  }
  const open = ctx.expenses;
  const best = open.filter((e) => Math.abs(expenseNet(e) - amount) <= BANK_TOL && e.expenseDate === txn.date);
  const maybe = open.filter((e) => !best.includes(e) && Math.abs(expenseNet(e) - amount) <= Math.max(BANK_TOL, amount * 0.02))
    .sort((a, b) => Math.abs(expenseNet(a) - amount) - Math.abs(expenseNet(b) - amount)).slice(0, 25);
  const shape = (e) => ({
    id: e.id, category: e.category, vendor: e.vendor, expenseDate: e.expenseDate, net: expenseNet(e),
    diff: ROUND(expenseNet(e) - amount),
  });
  return res.json({
    kind: 'Debit',
    amount,
    read,
    best: best.map(shape),
    maybe: maybe.map(shape),
    suggestion: catzGuess(txn, ctx),
    words: ruleWords(txn.description),
    categories: Object.keys(CHART_OF_ACCOUNTS),
  });
});

// File a line under a category. "remember" keeps the narration as a rule, so
// every future statement uses it.
router.post('/:id/categorise', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txnState(txn) === 'Reconciled') return res.status(400).json({ error: 'This line is posted against an invoice — undo that first' });
  const kind = String(req.body?.kind || 'expense');
  const category = String(req.body?.category || '').trim();
  if (kind === 'expense' && !category) return res.status(400).json({ error: 'Choose what this should be filed under.' });

  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: {
      category: kind === 'expense' || kind === 'other' ? category : null,
      categoryKind: kind,
      vendor: req.body?.vendor || null,
      counterparty: req.body?.party || null,
    },
  });
  let rule = null;
  if (req.body?.remember) {
    const match = String(req.body?.match || ruleWords(txn.description)[0] || '').trim();
    if (match) {
      rule = await prisma.bankRule.create({ data: { match, category: category || (req.body?.party || ''), vendor: req.body?.vendor || null, gstRate: req.body?.gstRate == null ? null : Number(req.body.gstRate), kind } });
    }
  }
  await logAudit({ userId: req.user.id, action: 'Bank line categorised', entity: 'BankTransaction', entityId: txn.id, toValue: `${kind}${category ? ` · ${category}` : ''}` });
  res.json({ ...updated, state: txnState(updated), rule });
});

// Undo a categorisation.
router.post('/:id/uncategorise', async (req, res) => {
  const txn = await loadTxn(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (!txn.category && !txn.categoryKind) return res.status(400).json({ error: 'This line is not categorised' });
  const updated = await prisma.bankTransaction.update({
    where: { id: txn.id },
    data: { category: null, categoryKind: null, vendor: null, counterparty: null },
  });
  await logAudit({ userId: req.user.id, action: 'Categorisation undone', entity: 'BankTransaction', entityId: txn.id, fromValue: txn.category || txn.categoryKind, toValue: '—' });
  res.json({ ...updated, state: txnState(updated) });
});

// Every debit the app already recognises becomes an office bill in one press.
router.post('/quick-categorise', async (req, res) => {
  const accounts = await ensureAccounts();
  const firstId = accounts[0].id;
  const accountId = req.body?.bankAccountId || firstId;
  const all = await prisma.bankTransaction.findMany();
  const ctx = await matchContext();
  const mine = onAccount(all, accountId, firstId)
    .filter((t) => t.type === 'Debit' && !t.excluded && !t.category && txnState(t) !== 'Reconciled');
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
    group: coaGroupOf(r.category),
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

module.exports = router;
