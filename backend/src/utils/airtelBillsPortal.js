// ---------------------------------------------------------------------------
// THE AIRTEL BILLS PORTAL - DATA LAYER (2026-10-19). A separate front end over the SAME Accounts data. Nothing here is copied or stored.
//
//   BILLS        = the vendor's Airtel bills in Accounts (OfficeExpense, vendorId = the vendor; older rows booked before the vendor master existed
//                  carry only the vendor's NAME, and are included when that name is exactly the vendor's, and no other vendor has it)
//                  + the monthly bills the vendor sent from this portal (VendorModuleBill, kind monthly_bill). A sent bill whose invoice number is
//                  already in Accounts is folded into THAT Accounts row (one bill, never two): it only adds what Accounts does not hold
//                  (billing period, due date, per-number charges).
//   SIMs         = the company's SIM assets (Asset, category "SIM Card"): read only, never copied, no second SIM table. A SimConnection row
//                  (the HRMS "SIM & connections" copy), when one exists for an asset, only supplies the Active / Suspended / Disconnected word.
//   PAYMENT      = derived LIVE by utils/airtelBillPayments.js from utils/expensePaymentState.js (Accounts + bank statement). Never stored, never
//                  set by a vendor.
//   PRIVACY      = the FULL 10-digit SIM number is shown (founder 2026-10-29: these are the operator's own SIMs, the number is how a bill and a
//                  SIM are found - "display the complete 10-digit Airtel SIM number everywhere"); WHO uses the SIM now is shown too (founder
//                  2026-10-29: "avaru aa sim use chestunnaru present ani kuda raavali"): the employee's name, employee ID and department from
//                  HRMS's current assignment - never their phone, email, salary or other personal data; no bank account / line id / narration /
//                  balance / full reference, no other vendor's or unrelated company expense.
//   SIM COUNT    = unique SIM numbers (two asset rows with the same number are one SIM), never bill rows or a page of the list.
//   NOT RECORDED = a field the data model does not hold is null (the screen prints "Not recorded"); nothing is invented.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./vmDb');
const PAY = require('./expensePaymentState');
const ACC = require('./accounts');
const VA = require('./vendorAuth');
const AP = require('./airtelBillPayments');
const { wantsAll } = require('./exportAll'); // the vendor Export asks for every row of a list (never reachable from a query string)

const ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normInv = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : (ym || ''); };
const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || ''); }; // 20-08-2026, the portal's date style
const dayOf = (v) => { if (!v) return null; const s = String(v); if (YMD.test(s.slice(0, 10))) return s.slice(0, 10); const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

// ---- numbers --------------------------------------------------------------------------------------
// The SIM number as shown: its last 10 digits (+91 / 0 dropped), in full. null when there are fewer than 10 digits.
const fullNumber = (n) => { const d = String(n == null ? '' : n).replace(/\D/g, '').slice(-10); return d.length === 10 ? d : null; };
// The digits of a search text (a number typed as "+91 99634 18222" finds 9963418222). '' when it holds fewer than 4 digits.
const digitsOf = (s) => { const d = String(s == null ? '' : s).replace(/\D/g, ''); return d.length >= 4 ? (d.length > 10 ? d.slice(-10) : d) : ''; };
// Kept for callers / tests that still import it; the portal itself no longer masks numbers (2026-10-29).
// 9963418222 -> 99xxxxxx22 (first two and last two digits). Anything shorter than 6 digits is hidden completely.
function maskNumber(n) {
  const d = String(n == null ? '' : n).replace(/\D/g, '');
  const t = d.length > 10 ? d.slice(-10) : d;
  if (t.length < 6) return t ? 'x'.repeat(t.length) : null;
  return `${t.slice(0, 2)}${'x'.repeat(t.length - 4)}${t.slice(-2)}`;
}
// Free text (a remark, a line description): any run of 10 or more digits is masked (a mobile number like a mobile, a longer one keeps its last 4).
const maskText = (s) => (s == null ? s : String(s).replace(/\d[\d\s-]{8,}\d/g, (m) => {
  const d = m.replace(/\D/g, '');
  if (d.length < 10) return m;
  return d.length === 10 ? maskNumber(d) : `••••${d.slice(-4)}`;
}));

// ---- the company's seat codes -> department (ONE rule, copied from routes/assetInventory.js deptOfSeat; the test compares the two tables) ----
const SEAT_DEPARTMENTS = { BDE: 'BDE', MED: 'Medical', MFG: 'Manufacturing', EDU: 'Education', HR: 'HR', 'R&D': 'R&D', IHR: 'Internal HR', INTERNAL: 'Internal HR' };
const deptOfSeat = (code) => SEAT_DEPARTMENTS[str(code).toUpperCase().split(/[\s-]+/)[0]] || null;

// ---- paging / facets (same conventions as the Assets portal) ------------------------------------------
function paged(rows, q, defaultSort, sorts, defaultDir = 'asc') {
  const sortKey = typeof sorts[str(q.sort)] === 'function' ? str(q.sort) : defaultSort;
  const dir = str(q.dir) === 'desc' ? 'desc' : (str(q.dir) === 'asc' ? 'asc' : defaultDir);
  const f = sorts[sortKey];
  const cmp = (a, b) => { const x = f(a); const y = f(b); return (typeof x === 'number' && typeof y === 'number') ? x - y : String(x ?? '').localeCompare(String(y ?? '')); };
  const sorted = [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  if (wantsAll(q)) return { rows: sorted, total: sorted.length, page: 1, pageSize: sorted.length, pages: 1, sort: sortKey, dir };
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  return { rows: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize, pages, sort: sortKey, dir };
}
const facet = (rows, get) => {
  const m = new Map();
  rows.forEach((r) => { const k = get(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
};

// ---- who is the provider ---------------------------------------------------------------------------
const KNOWN_PROVIDERS = ['airtel', 'jio', 'vodafone', 'bsnl', 'idea'];
function providerKey(name) {
  const t = norm(name).split(' ').filter(Boolean);
  return KNOWN_PROVIDERS.find((k) => t.includes(k)) || t[0] || '';
}
const providerLabel = (name) => { const k = providerKey(name); return KNOWN_PROVIDERS.includes(k) ? `${k[0].toUpperCase()}${k.slice(1)}` : (str(name) || 'Provider'); };

async function vendorMaster(v) {
  return prisma.officeVendor.findUnique({ where: { id: v.vendorId }, select: { id: true, name: true } });
}

// ---- the vendor's Accounts bills -------------------------------------------------------------------
async function myExpenses(v, master) {
  const base = { entryKind: { not: 'hand' } };
  const own = await prisma.officeExpense.findMany({ where: { ...base, vendorId: v.vendorId } });
  let legacy = [];
  const nm = norm(master && master.name);
  if (nm) {
    const twins = (await prisma.officeVendor.findMany({ select: { id: true, name: true } })).filter((x) => norm(x.name) === nm);
    if (twins.length === 1) { // the name is this vendor's alone: a bill booked by name only (before the vendor master) is theirs
      const first = nm.split(' ')[0];
      const cand = await prisma.officeExpense.findMany({ where: { ...base, vendorId: null, vendor: { contains: first } } });
      legacy = cand.filter((e) => norm(e.vendor) === nm);
    }
  }
  const seen = new Set();
  return [...own, ...legacy].filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return PAY.approvalOf(e) !== 'REJECTED'; });
}
async function myModuleBills(v) {
  if (!(await DB.ready())) return [];
  return DB.q('SELECT * FROM "VendorModuleBill" WHERE "vendorId" = ? AND "kind" = \'monthly_bill\' ORDER BY "createdAt" DESC', [v.vendorId]);
}
const parseLines = (raw) => { try { const x = JSON.parse(raw || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
const linesOf = (mod) => (mod ? parseLines(mod.lines).map((l) => ({ number: l.number ? (fullNumber(l.number) || String(l.number).trim()) : null, numberRaw: String(l.number || '').replace(/\D/g, '').slice(-10), description: l.description ? String(l.description) : null, amount: l.amount == null ? null : ROUND(l.amount) })) : []);

// ---- BILL ROWS ------------------------------------------------------------------------------------------
// Everything a bill row carries. `Not recorded` fields are null. numberRaw (a full number) is used inside the server to match a SIM and is
// removed before anything is sent (publicRow).
async function billRows(v, today = ACC.istDay()) {
  const master = await vendorMaster(v);
  const label = providerLabel(master && master.name);
  const [exps, mods] = await Promise.all([myExpenses(v, master), myModuleBills(v)]);
  const judged = await PAY.describeMany(prisma, exps);
  const subs = exps.length ? await prisma.vendorBillSubmission.findMany({ where: { expenseId: { in: exps.map((e) => e.id) } }, select: { id: true, expenseId: true, billCode: true, documentFile: true, status: true } }) : [];
  const subOf = new Map(subs.map((s) => [s.expenseId, s]));
  const modByInv = new Map();
  mods.forEach((m) => { const k = normInv(m.billNumber); if (k && !modByInv.has(k)) modByInv.set(k, m); });
  const folded = new Set();
  const rows = [];
  // duplicates inside Accounts: the same invoice number AND the same amount (the first one counts, the rest are flagged)
  const firstOf = new Map();
  const sorted = [...exps].sort((a, b) => String(a.expenseDate || '').localeCompare(String(b.expenseDate || '')) || new Date(a.createdAt) - new Date(b.createdAt));
  const dupOf = new Map();
  sorted.forEach((e) => {
    const k = normInv(e.billNumber);
    if (!k) return;
    const sig = `${k}|${ROUND(e.monthlyAmount)}`;
    if (firstOf.has(sig)) dupOf.set(e.id, firstOf.get(sig)); else firstOf.set(sig, e.id);
  });
  const codeOf = new Map(exps.map((e) => [e.id, e.expenseCode || null]));
  for (const e of exps) {
    const inv = normInv(e.billNumber);
    const mod = inv ? modByInv.get(inv) : null;
    if (mod) folded.add(mod.id);
    const sub = subOf.get(e.id) || null;
    const pay = AP.fromExpense(e, judged.get(e.id), today);
    const period = mod && YM.test(mod.period || '') ? mod.period : null;
    const billDate = dayOf(e.expenseDate);
    const due = pay.dueDate || (mod && dayOf(mod.dueDate)) || null;
    const dueFixed = due && due !== pay.dueDate ? AP.fromExpense({ ...e, dueDate: due }, judged.get(e.id), today) : pay;
    const gst = ROUND(e.gstAmount);
    const total = ROUND(e.monthlyAmount);
    rows.push({
      key: `exp:${e.id}`, source: 'Accounts', linked: true, provider: label, accountsRef: e.expenseCode || null, billCode: mod ? mod.billCode : (sub ? sub.billCode : null), invoiceNo: e.billNumber || null,
      billDate, period, periodLabel: period ? monthLabel(period) : null, billMonth: period || (billDate ? billDate.slice(0, 7) : null), billMonthFrom: period ? 'billing period' : 'bill date',
      dueDate: due, amount: ROUND(total - gst), tax: gst, tds: ROUND(e.tdsAmount), additionalCharges: null, total, payable: PAY.netOf(e),
      payment: dueFixed, hasDocument: !!(e.proofFile || (sub && sub.documentFile) || (mod && mod.documentFile)), lines: linesOf(mod), sentByYou: !!mod,
      duplicateOf: dupOf.has(e.id) ? codeOf.get(dupOf.get(e.id)) || 'another bill' : null, counted: !dupOf.has(e.id),
    });
  }
  for (const m of mods) {
    if (folded.has(m.id)) continue; // eslint-disable-line no-continue
    const pay = AP.fromModuleBill(m, today);
    const total = ROUND(m.total);
    const period = YM.test(m.period || '') ? m.period : null;
    const billDate = dayOf(m.billDate);
    rows.push({
      key: `mod:${m.id}`, source: 'Sent by you', linked: false, provider: label, accountsRef: null, billCode: m.billCode, invoiceNo: m.billNumber || null,
      billDate, period, periodLabel: period ? monthLabel(period) : null, billMonth: period || (billDate ? billDate.slice(0, 7) : null), billMonthFrom: period ? 'billing period' : 'bill date',
      dueDate: dayOf(m.dueDate), amount: ROUND(m.amount), tax: ROUND(m.gst), tds: 0, additionalCharges: null, total, payable: total,
      payment: pay, hasDocument: !!m.documentFile, lines: linesOf(m), sentByYou: true, duplicateOf: null, counted: false, rejectionReason: m.status === 'Rejected' ? m.rejectionReason || null : null,
      remarks: m.remarks || null,
    });
  }
  return rows.sort((a, b) => String(b.billDate || '').localeCompare(String(a.billDate || '')) || String(b.invoiceNo || '').localeCompare(String(a.invoiceNo || '')));
}
// What leaves the server: no full numbers, no internal ids beyond the row key.
function publicRow(r) {
  const { lines, ...rest } = r;
  return { ...rest, lines: (lines || []).map((l) => ({ number: l.number, description: l.description, amount: l.amount })), simCount: (lines || []).filter((l) => l.number).length };
}

const sumOf = (rows, f) => ROUND(rows.reduce((t, r) => t + (f(r) || 0), 0));
// Totals: only Accounts-linked bills that count (a bill Accounts holds twice counts once; a bill still only "sent" is not in Accounts' books).
function totalsOf(rows) {
  const l = rows.filter((r) => r.linked && r.counted && r.payment.status !== AP.STATUS.REJECTED);
  return {
    count: l.length, billed: sumOf(l, (r) => r.payable), paid: sumOf(l, (r) => r.payment.paidAmount), outstanding: sumOf(l, (r) => r.payment.balance),
    paidVerified: sumOf(l, (r) => (r.payment.verified ? r.payment.paidAmount : 0)),
  };
}

// ---- SIM rows ----------------------------------------------------------------------------------------
const numberOfAsset = (a) => { const m = /(\d{10})/.exec(`${a.name || ''} ${a.assetType || ''}`); return m ? m[1] : null; };
const iccidOfAsset = (a) => { const m = /ICCID\s+([0-9A-Za-z]+)/i.exec(a.assetType || ''); return m ? m[1] : null; };
const providerOfAsset = (a) => { const t = str(a.assetType).split(/[·|]/)[0] || str(a.name).split(/[\s·]/)[0]; return providerKey(t); };
async function simRows(v, billRowsIn) {
  const master = await vendorMaster(v);
  const key = providerKey(master && master.name);
  const assets = await prisma.asset.findMany({
    where: { category: 'SIM Card', NOT: { status: { in: VA.ARCHIVED } } }, include: { assignedTo: { select: { department: true, name: true, employeeCode: true } } }, orderBy: { assetCode: 'asc' }, take: 5000,
  });
  const mine = assets.filter((a) => a.vendorId === v.vendorId || (key && providerOfAsset(a) === key));
  const conns = (await DB.ready()) && mine.length ? await DB.q(`SELECT "assetId","status","mobileNumber" FROM "SimConnection" WHERE "assetId" IN (${mine.map(() => '?').join(',')})`, mine.map((a) => a.id)) : [];
  const connOf = new Map(conns.map((c) => [c.assetId, c]));
  const bills = billRowsIn || [];
  // ONE row per SIM number: a second asset row with the same number (a re-entered SIM) is the same SIM and is not counted again.
  const seenNumbers = new Set();
  const unique = mine.filter((a) => {
    const c = connOf.get(a.id);
    const raw = numberOfAsset(a) || fullNumber(c && c.mobileNumber);
    if (!raw) return true; // no number recorded: kept (it cannot be matched to another row)
    if (seenNumbers.has(raw)) return false;
    seenNumbers.add(raw);
    return true;
  });
  return unique.map((a) => {
    const c = connOf.get(a.id);
    const raw = numberOfAsset(a) || fullNumber(c && c.mobileNumber) || null;
    const iccid = iccidOfAsset(a);
    const last = raw ? bills.find((b) => (b.lines || []).some((l) => l.numberRaw === raw)) : null;
    const dept = (a.assignedTo && a.assignedTo.department) || deptOfSeat(a.location) || null;
    return {
      id: a.id, simRef: a.assetCode, provider: providerLabel(master && master.name), number: raw, iccid: iccid ? `••••${iccid.slice(-5)}` : null,
      department: dept, holder: a.assignedToId ? 'Assigned' : 'In stock',
      // who uses it NOW (HRMS's current assignment): name + employee ID only
      usedBy: a.assignedToId && a.assignedTo ? { name: a.assignedTo.name || null, employeeCode: a.assignedTo.employeeCode || null } : null, status: c ? c.status : (a.status === 'Assigned' ? 'In use' : (a.status === 'Available' ? 'In stock' : a.status)),
      lastBill: last ? { key: last.key, invoiceNo: last.invoiceNo, periodLabel: last.periodLabel || (last.billMonth ? monthLabel(last.billMonth) : null), payment: last.payment.status } : null,
      numberRaw: raw,
    };
  });
}
const publicSim = (s) => { const { numberRaw, ...rest } = s; return rest; }; // eslint-disable-line no-unused-vars

// ---- filtering ----------------------------------------------------------------------------------------
async function simNumberOf(v, ref, simsIn) {
  const sims = simsIn || await simRows(v, []);
  const q = str(ref).toLowerCase();
  if (!q) return null;
  const d = digitsOf(ref);
  // the SIM ID (AST-0146), or the full number however it is typed (+91 99634 18222)
  const hit = sims.find((s) => s.simRef.toLowerCase() === q || (d.length === 10 && s.numberRaw === d));
  if (hit) return hit.numberRaw;
  return d.length === 10 ? d : ''; // a full number that is not on the asset list still finds the bills that list it
}
// Does a bill list this (part of a) number? d = digits only.
const billHasNumber = (r, d) => !!d && (r.lines || []).some((l) => l.numberRaw && l.numberRaw.includes(d));
function keepBill(r, q, simNum) {
  const s = str(q.q).toLowerCase();
  const sd = digitsOf(q.q);
  const period = str(q.period);
  const from = YM.test(str(q.from)) ? str(q.from) : null;
  const to = YM.test(str(q.to)) ? str(q.to) : null;
  if (str(q.status) && r.payment.status !== str(q.status)) return false;
  if (period && r.billMonth !== period) return false;
  if (from && (r.billMonth || '') < from) return false;
  if (to && (r.billMonth || '') > to) return false;
  if (simNum !== null && simNum !== undefined) { if (!simNum || !(r.lines || []).some((l) => l.numberRaw === simNum)) return false; }
  // the search box: invoice number, references, month, status - or a SIM number (full or part) listed on the bill
  if (s && ![r.invoiceNo, r.billCode, r.accountsRef, r.periodLabel, r.billMonth, monthLabel(r.billMonth), r.payment.status].some((x) => String(x || '').toLowerCase().includes(s)) && !billHasNumber(r, sd)) return false;
  return true;
}

const BILL_SORTS = {
  billDate: (r) => r.billDate || '', dueDate: (r) => r.dueDate || '9999', invoiceNo: (r) => r.invoiceNo || '', total: (r) => r.total || 0, balance: (r) => r.payment.balance || 0, status: (r) => r.payment.status, month: (r) => r.billMonth || '',
};
async function listBills(v, q = {}) {
  const today = ACC.istDay();
  const all = await billRows(v, today);
  const simNum = str(q.sim) ? await simNumberOf(v, q.sim, await simRows(v, all)) : null;
  const rows = all.filter((r) => keepBill(r, q, simNum));
  const sweep = all.filter((r) => keepBill(r, { ...q, status: '' }, simNum));
  return {
    ...paged(rows.map(publicRow), q, 'billDate', BILL_SORTS, 'desc'), all: all.length,
    summary: totalsOf(all), shown: totalsOf(rows),
    facets: { status: facet(sweep, (r) => r.payment.status), month: facet(all, (r) => r.billMonth).map((o) => ({ ...o, label: monthLabel(o.value) })).sort((a, b) => b.value.localeCompare(a.value)) },
    simFilterNote: str(q.sim) ? 'Only bills that list this number are shown. A bill without a per-number list cannot be linked to one SIM.' : null,
    // a number searched (box or SIM filter) that no imported bill lists: say why, instead of an empty list with no reason
    numberNote: !rows.length && (digitsOf(q.q).length >= 10 || (simNum && simNum.length === 10))
      ? `No imported bill lists ${simNum || digitsOf(q.q)}. ${all.some((r) => (r.lines || []).length) ? 'The other bills do not name this number.' : 'The Airtel bills in Accounts were imported with the monthly total only (no per-SIM lines), so a bill cannot be found by a SIM number yet.'}`
      : null,
    today,
  };
}

// ---- audit / history of one bill -----------------------------------------------------------------------
const STATUS_WORD = { PENDING: 'Pending', APPROVED: 'Approved', PAID: 'Paid', REJECTED: 'Rejected', REIMBURSED: 'Paid' };
async function historyOf(row, exp, mod) {
  const out = [];
  if (exp) {
    const logs = await prisma.auditLog.findMany({ where: { entity: 'OfficeExpense', entityId: exp.id }, orderBy: { createdAt: 'asc' }, take: 100 });
    logs.forEach((l) => {
      const a = String(l.action || '');
      let what = null;
      if (a === 'Expense Created') what = 'The bill was recorded in Accounts.';
      else if (a === 'Expense Updated') what = 'Accounts updated the bill details.';
      else if (/^Office expense status:/.test(a)) {
        what = l.toValue === 'PAID' && /^Paid from the bank statement/.test(String(l.reason || ''))
          ? 'Marked Paid after the bank payment was matched to this bill.'
          : `Status changed from ${STATUS_WORD[l.fromValue] || 'Pending'} to ${STATUS_WORD[l.toValue] || l.toValue}.`;
      } else if (a === 'Bill Uploaded') what = 'The bill copy was added.';
      else if (a === 'Bill Updated') what = 'The bill copy was replaced.';
      else if (a === 'Office bill proof removed') what = 'The bill copy was removed.';
      else if (a === 'Office expense corrected after approval (override)') what = 'Accounts corrected the bill.';
      if (what) out.push({ at: l.createdAt, what, by: 'Accounts', derived: false });
    });
    const line = row.payment && row.payment.verified ? row.payment.paymentDate : null;
    if (line) out.push({ at: `${line}T00:00:00.000Z`, what: `The bank payment of ${dmy(line)} is matched to this bill (verified).`, by: 'Bank statement', derived: true });
  }
  if (mod) {
    out.push({ at: DB.toDate(mod.createdAt), what: `You sent this bill (${mod.billCode}).`, by: 'You', derived: false });
    if (mod.reviewedAt && mod.status !== 'Submitted') out.push({ at: DB.toDate(mod.reviewedAt), what: mod.status === 'Rejected' ? `Accounts rejected it${mod.rejectionReason ? `: ${mod.rejectionReason}` : '.'}` : `Accounts ${mod.status === 'Paid' ? 'approved it and marked it paid' : 'approved it'}.`, by: 'Accounts', derived: false });
  }
  return out.sort((a, b) => new Date(a.at) - new Date(b.at)).map((h) => ({ ...h, at: h.at instanceof Date ? h.at.toISOString() : h.at }));
}

async function billDetail(v, key) {
  const today = ACC.istDay();
  const all = await billRows(v, today);
  const r = all.find((x) => x.key === String(key || ''));
  if (!r) return null;
  const id = r.key.slice(4);
  const exp = r.key.startsWith('exp:') ? await prisma.officeExpense.findUnique({ where: { id } }) : null;
  let mod = null;
  if (await DB.ready()) {
    if (r.key.startsWith('mod:')) mod = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "id" = ? AND "vendorId" = ?', [id, v.vendorId]);
    else if (r.billCode) mod = await DB.one('SELECT * FROM "VendorModuleBill" WHERE "billCode" = ? AND "vendorId" = ?', [r.billCode, v.vendorId]);
  }
  const sims = r.lines.length ? await simRows(v, []) : [];
  const simOf = new Map(sims.map((s) => [s.numberRaw, s]));
  const pub = publicRow(r);
  pub.lines = r.lines.map((l) => ({ number: l.number, description: l.description, amount: l.amount, simRef: (simOf.get(l.numberRaw) || {}).simRef || null }));
  return { bill: pub, history: await historyOf(r, exp, mod) };
}

// The bill copy of one bill, only inside this vendor's own set (the signed-download route calls this).
async function ownedBillFile(vendor, key) {
  const k = String(key || '');
  const v = { vendorId: vendor.vendorId };
  const all = await billRows(v, ACC.istDay());
  const r = all.find((x) => x.key === k);
  if (!r || !r.hasDocument) return null;
  const id = k.slice(4);
  if (k.startsWith('exp:')) {
    const e = await prisma.officeExpense.findUnique({ where: { id } });
    if (e && e.proofFile) return { file: e.proofFile, mime: e.proofMime, name: e.proofName || 'airtel-bill' };
    const sub = await prisma.vendorBillSubmission.findFirst({ where: { expenseId: id, vendorId: vendor.vendorId } });
    if (sub && sub.documentFile) return { file: sub.documentFile, mime: sub.documentMime, name: sub.documentName || 'airtel-bill' };
    if (r.billCode && (await DB.ready())) {
      const m = await DB.one('SELECT "documentFile","documentMime","documentName" FROM "VendorModuleBill" WHERE "billCode" = ? AND "vendorId" = ?', [r.billCode, vendor.vendorId]);
      if (m && m.documentFile) return { file: m.documentFile, mime: m.documentMime, name: m.documentName };
    }
    return null;
  }
  const m = await DB.one('SELECT "documentFile","documentMime","documentName" FROM "VendorModuleBill" WHERE "id" = ? AND "vendorId" = ?', [id, vendor.vendorId]);
  return m && m.documentFile ? { file: m.documentFile, mime: m.documentMime, name: m.documentName } : null;
}

// ---- MONTHLY HISTORY ---------------------------------------------------------------------------------------
// One row per bill month. A month with no bill between the first bill and the current month is listed as "No bill recorded" (never as zero rupees).
function monthRange(first, last) {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}
function historyRows(all, today) {
  const months = [...new Set(all.map((r) => r.billMonth).filter(Boolean))].sort();
  if (!months.length) return [];
  const upto = today.slice(0, 7) > months[months.length - 1] ? today.slice(0, 7) : months[months.length - 1];
  return monthRange(months[0], upto).map((ym) => {
    const bills = all.filter((r) => r.billMonth === ym && r.payment.status !== AP.STATUS.REJECTED);
    const linked = bills.filter((r) => r.linked && r.counted);
    const status = AP.rollup(bills.map((r) => r.payment.status));
    const dues = bills.map((r) => r.dueDate).filter(Boolean).sort();
    return {
      month: ym, label: monthLabel(ym), noBill: !bills.length, bills: bills.length, linked: linked.length, notLinked: bills.filter((r) => !r.linked).length,
      billAmount: linked.length ? sumOf(linked, (r) => r.payable) : null, dueDate: dues[0] || null,
      paidAmount: linked.length ? sumOf(linked, (r) => r.payment.paidAmount) : null, outstanding: linked.length ? sumOf(linked, (r) => r.payment.balance) : null,
      status: status || null, tone: status ? AP.TONE[status] : 'grey', overdue: bills.some((r) => r.payment.overdue),
      invoiceNos: bills.map((r) => r.invoiceNo).filter(Boolean), references: bills.map((r) => r.payment.reference).filter(Boolean), keys: bills.map((r) => r.key),
    };
  });
}
// SIM-WISE MONTHLY USAGE (founder 2026-10-29): one SIM (number or SIM ID) + one month -> what the IMPORTED bills of that month say about
// that number: its own charge lines (usage / rental / whatever the bill wrote, word for word) and the total of each bill. Nothing is
// estimated: a bill that has no per-number lines says so, and so does a month with no bill.
async function simUsageOf(v, q, all) {
  if (!str(q.sim) || !YM.test(str(q.period))) return null;
  const sims = await simRows(v, all);
  const num = await simNumberOf(v, q.sim, sims);
  const month = str(q.period);
  const sim = sims.find((s) => s.numberRaw && s.numberRaw === num) || null;
  const base = {
    month, monthLabel: monthLabel(month),
    sim: sim ? { simRef: sim.simRef, number: sim.number, department: sim.department, status: sim.status, usedBy: sim.usedBy } : (num ? { simRef: null, number: num, department: null, status: null, usedBy: null } : null),
  };
  if (!num) return { ...base, available: false, message: `"${str(q.sim)}" is not a SIM ID or a 10-digit SIM number of this account.` };
  const bills = all.filter((r) => r.billMonth === month && r.payment.status !== AP.STATUS.REJECTED);
  if (!bills.length) return { ...base, available: false, message: `There is no Airtel bill for ${monthLabel(month)}.` };
  const per = bills.map((r) => {
    const mine = (r.lines || []).filter((l) => l.numberRaw === num);
    return {
      key: r.key, invoiceNo: r.invoiceNo, source: r.source, billTotal: r.total, hasLines: (r.lines || []).length > 0,
      lines: mine.map((l) => ({ description: l.description, amount: l.amount })), simTotal: mine.length ? sumOf(mine, (l) => l.amount) : null,
    };
  });
  const found = per.filter((b) => b.lines.length);
  const billTotal = sumOf(bills.filter((r) => r.linked ? r.counted : true), (r) => r.total);
  if (!found.length) {
    const noLines = per.every((b) => !b.hasLines);
    return {
      ...base, available: false, billTotal, bills: per,
      message: noLines
        ? `Usage for this SIM is not in the imported bill for ${monthLabel(month)}: that bill was imported with its total only (${per.map((b) => `${b.invoiceNo || 'bill'} ₹${Number(b.billTotal).toLocaleString('en-IN')}`).join(', ')}), not with per-SIM charges.`
        : `The ${monthLabel(month)} bill does not list ${num}.`,
    };
  }
  return { ...base, available: true, billTotal, usageTotal: sumOf(found, (b) => b.simTotal), bills: per };
}

async function listHistory(v, q = {}) {
  const today = ACC.istDay();
  const all = await billRows(v, today);
  const simNum = str(q.sim) ? await simNumberOf(v, q.sim, await simRows(v, all)) : null;
  const scoped = all.filter((r) => keepBill(r, { ...q, q: '', status: '', period: '', from: '', to: '' }, simNum));
  let rows = historyRows(scoped, today);
  const period = str(q.period); const from = YM.test(str(q.from)) ? str(q.from) : null; const to = YM.test(str(q.to)) ? str(q.to) : null;
  if (period) rows = rows.filter((r) => r.month === period);
  if (from) rows = rows.filter((r) => r.month >= from);
  if (to) rows = rows.filter((r) => r.month <= to);
  const st = str(q.status);
  if (st) rows = rows.filter((r) => scoped.some((b) => b.billMonth === r.month && b.payment.status === st));
  const s = str(q.q).toLowerCase();
  if (s) rows = rows.filter((r) => [r.label, r.month, ...r.invoiceNos].some((x) => String(x || '').toLowerCase().includes(s)));
  const sorts = { month: (r) => r.month, billAmount: (r) => r.billAmount || 0, outstanding: (r) => r.outstanding || 0, status: (r) => r.status || '' };
  const withBills = rows.filter((r) => !r.noBill);
  const linkedRows = rows.filter((r) => r.linked);
  return {
    simUsage: await simUsageOf(v, q, all),
    ...paged(rows, q, 'month', sorts, 'desc'), all: historyRows(all, today).length,
    totals: { months: withBills.length, billed: sumOf(linkedRows, (r) => r.billAmount), paid: sumOf(linkedRows, (r) => r.paidAmount), outstanding: sumOf(linkedRows, (r) => r.outstanding), notInAccounts: rows.reduce((t, r) => t + r.notLinked, 0) },
    facets: { status: facet(scoped, (r) => r.payment.status), month: facet(scoped, (r) => r.billMonth).map((o) => ({ ...o, label: monthLabel(o.value) })).sort((a, b) => b.value.localeCompare(a.value)) },
    simFilterNote: str(q.sim) ? 'Only bills that list this number are counted. A bill without a per-number list cannot be linked to one SIM.' : null,
    today,
  };
}

// ---- SIMs page ------------------------------------------------------------------------------------------
const SIM_SORTS = { simRef: (r) => r.simRef, number: (r) => r.number || '', department: (r) => r.department || '', status: (r) => r.status, usedBy: (r) => (r.usedBy && r.usedBy.name) || '~' };
async function listSims(v, q = {}) {
  const bills = await billRows(v);
  const all = await simRows(v, bills);
  const s = str(q.q).toLowerCase();
  const keep = (r, skip) => (skip === 'department' || !str(q.department) || (str(q.department) === 'Not recorded' ? !r.department : r.department === str(q.department)))
    && (skip === 'status' || !str(q.status) || r.status === str(q.status))
    && (!s || [r.simRef, r.number, r.iccid, r.department, r.usedBy && r.usedBy.name, r.usedBy && r.usedBy.employeeCode].some((x) => String(x || '').toLowerCase().includes(s)) || (!!digitsOf(q.q) && !!r.numberRaw && r.numberRaw.includes(digitsOf(q.q))));
  const rows = all.filter((r) => keep(r));
  return {
    ...paged(rows.map(publicSim), q, 'simRef', SIM_SORTS, 'asc'), all: all.length,
    // Department: only switched-on Department & Team names are offered (2026-10-28).
    facets: { department: await require('./masters').keepActiveDepartments(facet(all.filter((r) => keep(r, 'department')), (r) => r.department || 'Not recorded'), (o) => o.value, str(q.department)), status: facet(all.filter((r) => keep(r, 'status')), (r) => r.status) }, // eslint-disable-line global-require
    summary: { total: all.length, inUse: all.filter((r) => r.holder === 'Assigned').length, inStock: all.filter((r) => r.holder !== 'Assigned').length },
  };
}

// ---- OVERVIEW + ALERTS ------------------------------------------------------------------------------------
// Alerts are COMPUTED (nothing is stored, nothing can be sent twice): one per bill - overdue wins over due soon, which wins over "newly paid".
const PAID_NEW_DAYS = 14;
function alertsOf(rows, today) {
  const out = [];
  rows.forEach((r) => {
    if (!r.counted && r.linked) return; // a bill Accounts holds twice: only the first one speaks
    const p = r.payment;
    const t = `${r.invoiceNo ? `Bill ${r.invoiceNo}` : 'A bill'}${r.periodLabel || r.billMonth ? ` (${r.periodLabel || monthLabel(r.billMonth)})` : ''}`;
    if (p.status === AP.STATUS.PAID && p.verified && p.paymentDate) {
      const ago = -AP.daysBetween(today, p.paymentDate);
      if (ago >= 0 && ago <= PAID_NEW_DAYS) out.push({ key: r.key, kind: 'paid', tone: 'green', title: 'Payment confirmed', text: `${t} was paid on ${dmy(p.paymentDate)}. The bank statement confirms it.`, date: p.paymentDate });
      return;
    }
    if (p.overdue && AP.UNPAID.includes(p.status) && p.status !== AP.STATUS.WAITING) out.push({ key: r.key, kind: 'overdue', tone: 'red', title: 'Overdue', text: `${t} was due on ${dmy(p.dueDate)} and ${p.paidAmount > 0 ? `₹${Number(p.balance).toLocaleString('en-IN')} is still to be paid` : 'is not paid yet'}.`, date: p.dueDate });
    else if (p.dueSoon) out.push({ key: r.key, kind: 'due_soon', tone: 'yellow', title: 'Due soon', text: `${t} is due on ${dmy(p.dueDate)}${p.daysToDue === 0 ? ' (today)' : ` (in ${p.daysToDue} day${p.daysToDue === 1 ? '' : 's'})`}.`, date: p.dueDate });
  });
  const order = { overdue: 0, due_soon: 1, paid: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || String(a.date).localeCompare(String(b.date)));
}
async function overview(v, canSend) {
  const today = ACC.istDay();
  const rows = await billRows(v, today);
  const sims = await simRows(v, rows);
  const live = rows.filter((r) => r.payment.status !== AP.STATUS.REJECTED && (r.counted || !r.linked)); // a bill Accounts holds twice counts once
  const n = (st) => live.filter((r) => r.payment.status === st).length;
  return {
    today,
    bills: {
      count: live.length, pending: n(AP.STATUS.PENDING), waiting: n(AP.STATUS.WAITING), overdue: live.filter((r) => r.payment.overdue).length, dueSoon: live.filter((r) => r.payment.dueSoon).length,
      paid: n(AP.STATUS.PAID), paidByAccounts: n(AP.STATUS.PAID_ACCOUNTS), partlyPaid: n(AP.STATUS.PART), reversed: n(AP.STATUS.REVERSED), notInAccounts: live.filter((r) => !r.linked).length,
    },
    money: totalsOf(rows),
    sims: { total: sims.length, inUse: sims.filter((s) => s.holder === 'Assigned').length },
    alerts: alertsOf(rows, today),
    canSend: !!canSend,
  };
}

// ---- SEND A BILL: the duplicate checks that need Accounts (the portal's own rules are in routes/vendorModulePortal.js createBill) ----------------
// Refuse a bill Accounts already holds: same invoice number, or the same bill month AND the same amount. Both read Accounts; nothing is written.
async function duplicateInAccounts(v, d) {
  const master = await vendorMaster(v);
  const exps = await myExpenses(v, master);
  const inv = normInv(d.billNumber);
  const byInv = inv ? exps.find((e) => normInv(e.billNumber) === inv) : null;
  if (byInv) return { status: 409, field: 'billNumber', error: `Accounts already has bill ${byInv.billNumber}${byInv.expenseCode ? ` (${byInv.expenseCode})` : ''}. It is not sent again: you can see it in Bills.` };
  const amt = ROUND(d.total);
  const same = exps.find((e) => (e.expenseDate || '').slice(0, 7) === d.period && Math.abs(ROUND(e.monthlyAmount) - amt) < 0.01);
  if (same) return { status: 409, field: 'amount', error: `Accounts already has a bill for ${monthLabel(d.period)} with the same amount${same.billNumber ? ` (${same.billNumber})` : ''}. It is not sent again.` };
  return null;
}

// The answer to "Send a bill" (the existing createBill echoes the whole row): only the bill's own fields, numbers masked, nothing else.
function sendAnswer(b) {
  if (!b || typeof b !== 'object' || !b.bill) return b;
  const x = b.bill;
  return {
    ...b,
    bill: {
      billCode: x.billCode, billNumber: x.billNumber, billDate: x.billDate, period: x.period, periodLabel: x.periodLabel, dueDate: x.dueDate, amount: x.amount, gst: x.gst, total: x.total,
      status: 'Waiting for Accounts', remarks: x.remarks || null,
      lines: (x.lines || []).map((l) => ({ number: l && l.number ? (fullNumber(l.number) || String(l.number).trim()) : null, description: (l && l.description) || null, amount: l && l.amount != null ? l.amount : null })),
      createdAt: x.createdAt,
    },
  };
}

module.exports = {
  sendAnswer, maskNumber, maskText, deptOfSeat, SEAT_DEPARTMENTS, providerKey, providerLabel, normInv, monthLabel, billRows, simRows, totalsOf, alertsOf, historyRows,
  listBills, billDetail, listHistory, listSims, overview, ownedBillFile, duplicateInAccounts, publicRow, myExpenses, vendorMaster,
};
