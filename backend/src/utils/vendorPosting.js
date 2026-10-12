// ---------------------------------------------------------------------------
// VENDOR BILLS -> JOURNAL (2026-10-09). SWITCH: AppSetting 'vendor.journalPosting'
// {"enabled":true|false}, DEFAULT OFF. While OFF nothing here writes anything.
//
// Only bills LINKED TO A VENDOR (OfficeExpense.vendorId set, entryKind expense,
// not rejected) are posted - the rest of Office & Expenses is untouched, so the
// books are not changed under anyone. Vendors never see journals / ledgers.
//
// WHAT IT POSTS (source VENDOR_BILLS, idempotent: one entry per key):
//   Bill     key vendor-bill:<expenseId>   dated the bill date
//     Dr 5500 Vendor Expenses            amount before GST
//     Dr 1400 Input GST                  GST
//        Cr 2300 Vendor Payable          net payable (amount + GST - TDS)
//        Cr 2260 TDS Payable - Vendors   TDS deducted from the vendor
//   Payment  key vendor-pay:<expenseId>    dated the payment date (Paid / Reimbursed)
//     Dr 2300 Vendor Payable             net payable
//        Cr 1100 Bank   (Cash mode: Cr 1000 Cash)
// A bill that is edited after posting is NOT silently re-posted: syncExpense()
// reports it as "changed" and leaves the entry for Accounts to reverse by hand.
// A closed month is not posted; the bill stays unposted and is reported.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  ensureAccount, postJournal, paise, LedgerError, isClosedMonth, monthOfDate,
} = require('./ledger');
const { logAudit } = require('./audit');

const KEY = 'vendor.journalPosting';
const SOURCE = 'VENDOR_BILLS';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const today = () => new Date().toISOString().slice(0, 10);

const ACCOUNTS = [
  { code: '1000', name: 'Cash', type: 'ASSET', description: 'Cash in hand' },
  { code: '1100', name: 'Bank', type: 'ASSET', description: 'Company bank account(s)' },
  { code: '1400', name: 'Input GST', type: 'ASSET', description: 'GST paid on purchases and repairs (input tax credit)' },
  { code: '2300', name: 'Vendor Payable', type: 'LIABILITY', description: 'Amounts owed to vendors / service centres' },
  { code: '2260', name: 'TDS Payable - Vendors', type: 'LIABILITY', description: 'Tax deducted at source from vendor payments, due to the government' },
  { code: '5500', name: 'Vendor Expenses', type: 'EXPENSE', description: 'Goods and services bought from vendors (bills linked to the vendor master)' },
];

async function settings() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const v = row ? JSON.parse(row.value) : {};
    return { enabled: v.enabled === true, updatedAt: row ? row.updatedAt : null, updatedByName: row ? row.updatedByName : null };
  } catch { return { enabled: false }; }
}
async function setEnabled(enabled, user) {
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify({ enabled: !!enabled }), updatedById: user && user.id, updatedByName: user && (user.name || user.email) },
    update: { value: JSON.stringify({ enabled: !!enabled }), updatedById: user && user.id, updatedByName: user && (user.name || user.email) },
  });
  return settings();
}

async function ensureAll() {
  const out = {};
  for (const a of ACCOUNTS) out[a.code] = await ensureAccount(a); // eslint-disable-line no-await-in-loop
  return out;
}

const eligible = (e) => !!(e && e.vendorId && e.entryKind !== 'hand' && e.approvalStatus !== 'REJECTED');

// The planned entries for one expense (pure: amounts and dates only).
function plan(e) {
  const total = r2(e.monthlyAmount);
  const gst = r2(e.gstAmount);
  const tds = r2(e.tdsAmount);
  const base = r2(total - gst);
  const net = r2(total - tds);
  const billDate = isDate(e.expenseDate) ? e.expenseDate : today();
  const paid = ['PAID', 'REIMBURSED'].includes(e.approvalStatus);
  const payDate = isDate(e.paymentDate) ? e.paymentDate : (e.paidAt ? new Date(e.paidAt).toISOString().slice(0, 10) : today());
  const label = `${e.expenseCode || e.id} ${e.billNumber ? `bill ${e.billNumber}` : ''} - ${e.vendor || 'vendor'}`.replace(/\s+/g, ' ').trim();
  return { total, gst, tds, base, net, billDate, paid, payDate, label, cash: /cash/i.test(String(e.paymentMode || '')) };
}

async function post(key, date, narration, debit, credit, expense, actor) {
  const [y, m] = date.split('-').map(Number);
  if (await isClosedMonth(monthOfDate(date))) return { status: 'closed-month' };
  const r = await postJournal({
    month: m, year: y, date, narration, source: SOURCE, voucher_type: 'Journal',
    reference_type: 'VENDOR_BILL', reference_id: expense.id, idempotency_key: key, debit, credit,
  }, { actor });
  return { status: r.replay ? 'in-sync' : 'posted', entry: r.entry };
}

// Posts what is missing for ONE expense. Safe to call any number of times.
// Returns { status: 'off' | 'not-linked' | 'ok', bill, payment } where bill /
// payment are posted | in-sync | closed-month | changed | error:<text>.
async function syncExpense(expenseId, actor = null) {
  const set = await settings();
  if (!set.enabled) return { status: 'off' };
  const e = await prisma.officeExpense.findUnique({ where: { id: String(expenseId) } });
  if (!eligible(e)) return { status: 'not-linked' };
  await ensureAll();
  const p = plan(e);
  const res = { status: 'ok', bill: null, payment: null };
  const guard = async (fn) => { try { return await fn(); } catch (err) { if (err instanceof LedgerError) return { status: `error:${err.message}` }; throw err; } };
  res.bill = await guard(async () => {
    const key = `vendor-bill:${e.id}`;
    const existing = await prisma.journalEntry.findUnique({ where: { idempotencyKey: key } });
    if (existing) return { status: paise(existing.totalDebit) === paise(p.total) ? 'in-sync' : 'changed' };
    const debit = [{ account: '5500', amount: p.base, memo: p.label }, { account: '1400', amount: p.gst, memo: p.label }];
    const credit = [{ account: '2300', amount: p.net, memo: p.label }, { account: '2260', amount: p.tds, memo: p.label }];
    const r = await post(key, p.billDate, `Vendor bill ${p.label}`, debit, credit, e, actor);
    if (r.status === 'posted') {
      await logAudit({ userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Vendor bill posted to journal', entity: 'OfficeExpense', entityId: e.id, toValue: `${key} - Rs ${p.total}` });
    }
    return r;
  });
  if (p.paid) {
    res.payment = await guard(async () => {
      const key = `vendor-pay:${e.id}`;
      const existing = await prisma.journalEntry.findUnique({ where: { idempotencyKey: key } });
      if (existing) return { status: paise(existing.totalDebit) === paise(p.net) ? 'in-sync' : 'changed' };
      if (!(res.bill && ['posted', 'in-sync', 'changed'].includes(res.bill.status))) return { status: 'waiting-for-bill' };
      const r = await post(key, p.payDate, `Payment to vendor ${p.label}`, [{ account: '2300', amount: p.net, memo: p.label }], [{ account: p.cash ? '1000' : '1100', amount: p.net, memo: p.label }], e, actor);
      if (r.status === 'posted') {
        await logAudit({ userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Vendor payment posted to journal', entity: 'OfficeExpense', entityId: e.id, toValue: `${key} - Rs ${p.net}` });
      }
      return r;
    });
  }
  return res;
}

// Catch-up for every vendor-linked bill (the Admin button; also useful after
// the switch is turned ON). Returns counts.
async function syncAll(actor = null) {
  const set = await settings();
  if (!set.enabled) return { enabled: false, checked: 0, posted: 0, inSync: 0, problems: [] };
  const list = await prisma.officeExpense.findMany({ where: { vendorId: { not: null }, entryKind: { not: 'hand' }, NOT: { approvalStatus: 'REJECTED' } }, select: { id: true, expenseCode: true } });
  const out = { enabled: true, checked: list.length, posted: 0, inSync: 0, problems: [] };
  for (const x of list) {
    // eslint-disable-next-line no-await-in-loop
    const r = await syncExpense(x.id, actor);
    for (const part of ['bill', 'payment']) {
      const s = r[part] && r[part].status;
      if (!s) continue; // eslint-disable-line no-continue
      if (s === 'posted') out.posted += 1;
      else if (s === 'in-sync') out.inSync += 1;
      else out.problems.push({ expense: x.expenseCode || x.id, part, status: s });
    }
  }
  return out;
}

module.exports = { KEY, settings, setEnabled, syncExpense, syncAll, plan, eligible, ACCOUNTS };
