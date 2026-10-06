// BANK-WISE STATEMENTS (Accounts spec S4) — read only.
//
//   GET /api/banks                         → [{ id, name, bank, last4 }]
//   GET /api/banks/:bankId/transactions    → { data, page, limit, total, totalPages }
//        ?from=YYYY-MM-DD&to=YYYY-MM-DD&reconciled=all|true|false&page=1&limit=25 (max 100)
//
// "banks" are the existing BankAccount rows and "bank_transactions" the
// existing BankTransaction rows (bankAccountId is the bank id). Every read is
// filtered on the bank id IN THE QUERY — date range, reconciled, ordering and
// paging all run in SQL, never on the client, so two banks can never mix.
//
// "Reconciled" here means the line is accounted for: posted to an invoice
// (reconStatus Reconciled), filed under a category / office bill, or tied to
// a hand loan (categoryKind). Everything else is "Unreconciled".
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));
router.use(requirePerm('accounts', 'accounts', 'Bank & Reconciliation', 'view'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s) => {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const ROUND = (n) => Math.round(Number(n || 0) * 100) / 100;

const bankName = (a) => `${a.bank}${a.accNo ? ` ·${String(a.accNo).slice(-4)}` : ''}`;

async function banksInOrder() {
  return prisma.bankAccount.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

router.get('/', async (req, res) => {
  const list = await banksInOrder();
  res.json(list.map((a) => ({
    id: a.id, name: bankName(a), bank: a.bank, last4: a.accNo ? String(a.accNo).slice(-4) : '', active: a.active,
  })));
});

const RECONCILED = { OR: [{ reconStatus: 'Reconciled' }, { category: { not: null } }, { categoryKind: { not: null } }] };
const UNRECONCILED = { AND: [{ NOT: { reconStatus: 'Reconciled' } }, { category: null }, { categoryKind: null }] };

router.get('/:bankId/transactions', async (req, res) => {
  const q = req.query || {};
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const from = one(q.from) ? String(one(q.from)).trim() : '';
  const to = one(q.to) ? String(one(q.to)).trim() : '';
  const reconciled = one(q.reconciled) ? String(one(q.reconciled)).trim().toLowerCase() : 'all';
  const pageRaw = one(q.page) == null || one(q.page) === '' ? '1' : String(one(q.page));
  const limitRaw = one(q.limit) == null || one(q.limit) === '' ? '25' : String(one(q.limit));

  const problems = [];
  if (from && !validIso(from)) problems.push('"from" must be a date like 2026-04-01.');
  if (to && !validIso(to)) problems.push('"to" must be a date like 2027-03-31.');
  if (from && to && validIso(from) && validIso(to) && from > to) problems.push('The from date is after the to date.');
  if (!['all', 'true', 'false'].includes(reconciled)) problems.push('"reconciled" must be all, true or false.');
  if (!/^\d+$/.test(pageRaw) || Number(pageRaw) < 1) problems.push('"page" must be 1 or more.');
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) problems.push('"limit" must be between 1 and 100.');
  if (problems.length) return res.status(400).json({ error: problems[0], problems });

  const bankId = String(req.params.bankId);
  const banks = await banksInOrder();
  const bank = banks.find((b) => b.id === bankId);
  if (!bank) return res.status(404).json({ error: 'That bank was not found.' });

  // WHERE bankAccountId = :bankId — always. Lines saved before accounts existed
  // (bankAccountId NULL) have always belonged to the first account; the
  // migration 20261005100000_bank_txn_account_index stamps them, and until it
  // has run they are read as the first account's own.
  const byBank = bank.id === banks[0].id
    ? { OR: [{ bankAccountId: bank.id }, { bankAccountId: null }] }
    : { bankAccountId: bank.id };
  const and = [byBank];
  if (from) and.push({ date: { gte: from } });
  if (to) and.push({ date: { lte: to } });
  if (reconciled === 'true') and.push(RECONCILED);
  if (reconciled === 'false') and.push(UNRECONCILED);
  const where = { AND: and };

  const page = Number(pageRaw);
  const limit = Number(limitRaw);
  const [total, rows] = await prisma.$transaction([
    prisma.bankTransaction.count({ where }),
    prisma.bankTransaction.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  const isReconciled = (t) => t.reconStatus === 'Reconciled' || !!t.category || !!t.categoryKind;
  res.json({
    bank: { id: bank.id, name: bankName(bank) },
    data: rows.map((t) => ({
      id: t.id,
      bankId: t.bankAccountId || bank.id,
      txnDate: t.date,
      description: t.description,
      debit: t.type === 'Debit' ? ROUND(t.amount) : 0,
      credit: t.type === 'Credit' ? ROUND(t.amount) : 0,
      balance: t.balance == null ? null : ROUND(t.balance),
      referenceNo: t.reference || null,
      reconciled: isReconciled(t),
      state: t.reconStatus || 'Unmatched',
      createdAt: t.createdAt,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

module.exports = router;
