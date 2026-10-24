// ---------------------------------------------------------------------------
// WHAT ELSE GOES INTO THE DAILY ACCOUNTS SUMMARY (founder, 2026-10-21): besides the missing payment proofs, the 09:30 and 17:00 message lists,
// as short counts with the oldest item, what is still WAITING for Accounts:
//   * vendor bills / invoices / monthly bills waiting for a check
//   * partner payouts waiting for approval
//   * client invoices overdue, vendor bills overdue
//   * tax dates that fall due in the next 3 days (TDS / TCS, GSTR-1, PF-ESI, GSTR-3B, PMT-06)
// It is a reading of the live tables, nothing is stored. The wording says "still waiting", never "new": an event notice (a vendor
// sent a bill) goes at once as a bell and is not repeated in here as new. Company-wide, so every recipient gets the same lines.
// Each item is { key, line, where }: `where` is the Accounts screen in words. A recipient with no Accounts access gets the line without it.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const IST = 330 * 60000;
const todayIst = (now) => new Date((now || new Date()).getTime() + IST).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? `${iso.slice(8, 10)} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '-');
const iso = (d) => (d instanceof Date ? new Date(d.getTime() + IST).toISOString().slice(0, 10) : String(d || '').slice(0, 10));
// Statutory dates that do not move (routes/office.js CAL_DUE).
const CAL = [{ d: 7, t: 'TDS / TCS deposit' }, { d: 11, t: 'GSTR-1' }, { d: 15, t: 'PF (ECR) and ESI' }, { d: 20, t: 'GSTR-3B' }, { d: 25, t: 'PMT-06 (QRMP filers)' }];
const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

async function items(now = new Date()) {
  const today = todayIst(now);
  const out = [];
  const bills = await safe(() => prisma.vendorBillSubmission.findMany({ where: { status: 'PENDING_REVIEW' }, select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 500 }), []);
  const mods = await safe(() => prisma.$queryRawUnsafe('SELECT "createdAt" FROM "VendorModuleBill" WHERE "status" = \'Submitted\' ORDER BY "createdAt" ASC LIMIT 500'), []);
  const nWait = bills.length + mods.length;
  if (nWait) {
    const oldest = [...bills.map((b) => iso(b.createdAt)), ...mods.map((b) => iso(new Date(Number(b.createdAt) || Date.parse(b.createdAt))))].filter((x) => /^\d{4}/.test(x)).sort()[0];
    out.push({ key: 'vendorWaiting', line: `Vendor bills and invoices still waiting for a check: ${nWait}${oldest ? ` (oldest sent ${dmy(oldest)})` : ''}.`, where: 'Office & Accounts, Bills from vendors' });
  }
  const payouts = await safe(() => prisma.partnerPayout.findMany({ where: { status: 'Draft' }, select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 200 }), []);
  if (payouts.length) out.push({ key: 'payouts', line: `Partner payouts still waiting for approval: ${payouts.length} (oldest made ${dmy(iso(payouts[0].createdAt))}).`, where: 'Invoices, Partner payouts' });
  const inv = await safe(() => prisma.invoice.findMany({
    where: { dueDate: { lt: today }, status: { in: ['Pending', 'Partially Paid', 'Overdue'] } },
    select: { dueDate: true, amount: true, gst: true, tds: true, receivedAmount: true }, orderBy: { dueDate: 'asc' }, take: 2000,
  }), []);
  const overdue = inv.filter((i) => (Number(i.amount) || 0) + (Number(i.gst) || 0) - (Number(i.tds) || 0) - (Number(i.receivedAmount) || 0) > 0.5 && i.dueDate);
  if (overdue.length) out.push({ key: 'invoicesOverdue', line: `Client invoices overdue: ${overdue.length} (oldest was due ${dmy(overdue[0].dueDate)}).`, where: 'Invoices' });
  const exp = await safe(() => prisma.officeExpense.findMany({
    where: { paidStatus: 'Unpaid', dueDate: { lt: today }, NOT: [{ approvalStatus: 'REJECTED' }, { entryKind: 'hand' }] },
    select: { dueDate: true }, orderBy: { dueDate: 'asc' }, take: 2000,
  }), []);
  if (exp.length) out.push({ key: 'billsOverdue', line: `Vendor bills overdue: ${exp.length} (oldest was due ${dmy(exp[0].dueDate)}).`, where: 'Office & Accounts' });
  // tax dates in the next 3 days
  const t0 = new Date(`${today}T00:00:00Z`);
  CAL.forEach((c) => {
    for (let k = 0; k <= 3; k += 1) {
      const d = new Date(t0.getTime() + k * 86400000);
      if (d.getUTCDate() === c.d) { out.push({ key: `tax${c.d}`, line: `${c.t} is due ${k === 0 ? 'today' : `in ${noun(k, 'day', 'days')}`} (${dmy(d.toISOString().slice(0, 10))}).`, where: null }); break; }
    }
  });
  return out;
}

module.exports = { items, dmy, todayIst };
