// ---------------------------------------------------------------------------
// WHAT THE COMPANY PAID THIS VENDOR, FROM THE BANK STATEMENT (founder 2026-10-28: "eppati varaku unna bank statements kuda ekkada
// vendor portal loo kanipinchali, same for all the vendors portals - ee date roju entha pay chesaru").
//
// Every bank statement line (money OUT) that paid this vendor, oldest to newest: the date on the statement, the amount, the
// payment reference (UTR / cheque no.) and which of its bills it paid. Used by EVERY vendor portal (Assets, Airtel Bills, ID Cards,
// finance) and by the invoices: "paid on DATE, Rs X".
//
// A line counts as this vendor's payment when (READ ONLY, nothing is written here):
//   1. it is the bank proof of one of this vendor's bills (OfficeExpense.bankTxnId), or the line says it was filed against one
//      of them (BankTransaction.createdBillId / billLinks), or
//   2. Accounts filed the line to this vendor on the bank screen (BankTransaction.vendor / counterparty = the vendor's name),
//      only when no OTHER vendor carries the same name (never a guess between two vendors).
// A vendor's bills are the ones linked to it (OfficeExpense.vendorId) or, for bills booked before the vendor master, carrying its
// exact name (again only when the name is unique).
// Only money OUT. A line set aside (Ignored) is left out; a reversed line is shown as Reversed and not counted.
// NEVER shown: the bank account, the narration, the balance, any other line of the statement.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The payment reference is shown MASKED (last 4 characters), the same rule as the Airtel portal: enough to find it in the vendor's own bank.
const maskRef = (r) => { const s = String(r || '').replace(/s+/g, ''); return s ? `••••${s.slice(-4)}` : null; };

// The vendor's names, and whether each is unique among all vendors.
async function namesOf(vendorId) {
  const v = await prisma.officeVendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true, companyName: true } });
  if (!v) return { vendor: null, names: [] };
  const mine = [...new Set([norm(v.name), norm(v.companyName)].filter((x) => x.length >= 3))];
  if (!mine.length) return { vendor: v, names: [] };
  const all = await prisma.officeVendor.findMany({ where: { id: { not: vendorId } }, select: { name: true, companyName: true } });
  const taken = new Set(all.flatMap((o) => [norm(o.name), norm(o.companyName)]));
  return { vendor: v, names: mine.filter((n) => !taken.has(n)) };
}

async function billsOf(vendorId, names) {
  const linked = await prisma.officeExpense.findMany({ where: { vendorId }, select: { id: true, billNumber: true, description: true, category: true, bankTxnId: true, monthlyAmount: true, expenseDate: true } });
  if (!names.length) return linked;
  // bills booked before the vendor master: the exact name (checked in JS after a cheap pre-filter)
  const loose = await prisma.officeExpense.findMany({ where: { vendorId: null, vendor: { not: null } }, select: { id: true, vendor: true, billNumber: true, description: true, category: true, bankTxnId: true, monthlyAmount: true, expenseDate: true } });
  const nm = new Set(names);
  return [...linked, ...loose.filter((e) => nm.has(norm(e.vendor)))];
}

// The bill number, else its kind and date. Never the description: a bill made from a bank line carries the raw narration there.
const billLabel = (e) => e.billNumber || `${e.category || 'Bill'}${e.expenseDate ? ` of ${e.expenseDate}` : ''}`;

// -> { rows, total, count, firstDate, lastDate, byBill: Map(expenseId -> [{ date, amount, reference }]) }
async function forVendor(vendorId) {
  const { vendor, names } = await namesOf(String(vendorId || ''));
  const empty = { rows: [], total: 0, count: 0, firstDate: null, lastDate: null, byBill: new Map() };
  if (!vendor) return empty;
  const bills = await billsOf(vendor.id, names);
  const billById = new Map(bills.map((b) => [b.id, b]));
  const ids = new Set(bills.map((b) => b.bankTxnId).filter(Boolean));
  const ors = [];
  if (bills.length) {
    ors.push({ createdBillId: { in: bills.map((b) => b.id) } });
    // billLinks is JSON text [{ id, ... }]: a contains pre-filter, checked properly below
    bills.slice(0, 300).forEach((b) => ors.push({ billLinks: { contains: b.id } }));
  }
  const nameRows = names.length ? await prisma.bankTransaction.findMany({ where: { type: 'Debit', OR: [{ vendor: { not: null } }, { counterparty: { not: null } }] }, select: { id: true, vendor: true, counterparty: true } }) : [];
  const nm = new Set(names);
  nameRows.forEach((t) => { if (nm.has(norm(t.vendor)) || nm.has(norm(t.counterparty))) ids.add(t.id); });
  const byLink = ors.length ? await prisma.bankTransaction.findMany({ where: { OR: ors }, select: { id: true } }) : [];
  byLink.forEach((t) => ids.add(t.id));
  if (!ids.size) return empty;
  const txns = await prisma.bankTransaction.findMany({ where: { id: { in: [...ids] } } });
  const reversed = new Set((await prisma.bankTransaction.findMany({ where: { reversalOfId: { in: [...ids] } }, select: { reversalOfId: true } }).catch(() => [])).map((x) => x.reversalOfId));
  const rows = [];
  const byBill = new Map();
  for (const t of txns) {
    if (t.type !== 'Debit') continue; // money OUT only
    if (t.reconStatus === 'Ignored') continue; // set aside by Accounts: not a payment
    let links = [];
    try { links = JSON.parse(t.billLinks || '[]'); } catch { links = []; }
    // A line is a CONFIRMED payment of a bill only when the line itself says it was filed against that bill (createdBillId / billLinks) -
    // the same truth table as utils/expensePaymentState.js. A bill that only points at the line (bankTxnId) is "Under Review": not counted.
    const paidBills = new Set();
    const pointedBy = new Set();
    bills.forEach((b) => { if (b.bankTxnId === t.id) pointedBy.add(b.id); });
    if (t.createdBillId && billById.has(t.createdBillId)) paidBills.add(t.createdBillId);
    (Array.isArray(links) ? links : []).forEach((l) => { if (l && billById.has(l.id)) paidBills.add(l.id); });
    const byName = nm.has(norm(t.vendor)) || nm.has(norm(t.counterparty));
    const underReview = !paidBills.size && !byName && pointedBy.size > 0;
    const isReversed = reversed.has(t.id) || t.reconStatus === 'Reversed';
    const row = {
      id: t.id, date: t.date, amount: ROUND(t.amount), reference: maskRef(t.reference || t.externalId),
      status: isReversed ? 'Reversed' : (underReview ? 'Under Review' : 'Paid'), forBills: [...(underReview ? pointedBy : paidBills)].map((id) => billLabel(billById.get(id))),
      source: 'Bank statement',
    };
    rows.push(row);
    if (!isReversed && !underReview) paidBills.forEach((id) => { if (!byBill.has(id)) byBill.set(id, []); byBill.get(id).push({ date: row.date, amount: row.amount, reference: row.reference }); });
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const counted = rows.filter((r) => r.status === 'Paid');
  const dates = counted.map((r) => r.date).filter(Boolean).sort();
  return { rows, total: ROUND(counted.reduce((s, r) => s + r.amount, 0)), count: counted.length, firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null, byBill };
}

// For the API: the Map is not JSON.
async function view(vendorId, q = {}) {
  const r = await forVendor(vendorId);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? String(q.to) : null;
  const rows = r.rows.filter((x) => (!from || String(x.date) >= from) && (!to || String(x.date) <= to));
  return { rows, total: r.total, count: r.count, firstDate: r.firstDate, lastDate: r.lastDate, shown: rows.length };
}

module.exports = { forVendor, view, norm };
