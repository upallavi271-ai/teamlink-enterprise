// ---------------------------------------------------------------------------
// HRMS ASSETS + REPAIRS -> JOURNAL & LEDGERS (Accounts spec S2, 2026-10-05).
//
// HRMS owns the data (Asset, AssetRepair — and, until they are copied into
// AssetRepair, the repair entries in Asset.history). Accounts only READS it,
// posts journals and reports. Nothing here edits an asset or a repair.
//
// LEDGERS (made on demand, per HRMS category "Laptop", "Mouse", …):
//   15NN Fixed Asset — <category>          (Fixed Assets)
//   16NN Accumulated Depreciation — <cat>  (Accumulated Depreciation, contra)
//   54NN Repairs & Maintenance — <cat>     (Expenses, sub-ledger of 5400)
//   plus 1000 Cash, 1400 Input GST, 2300 Vendor Payable, 5300 Depreciation
//   Expense, 5400 Repairs & Maintenance, 4900 Profit on Sale of Assets,
//   5900 Loss on Sale / Disposal of Assets.
//
// JOURNALS (source HRMS_ASSETS; every line carries the asset id):
//   Purchase   Dr Fixed Asset + Dr Input GST / Cr Bank | Cash | Vendor Payable
//              key asset-purchase:<assetId>[:v<n>]
//   Repair     Dr R&M (or Fixed Asset when capitalised) + Dr Input GST / Cr …
//              key asset-repair:<repairId>[:v<n>]   (Completed, cost > 0)
//   Depreciation  Dr Depreciation Expense / Cr Accumulated Depreciation, per
//              asset, for a period — key asset-dep:<from>:<to>
//   Sale       Dr Bank/Cash + Dr Acc Dep / Cr Fixed Asset ± Profit / Loss
//   Write-off  Dr Acc Dep + Dr Loss on Disposal / Cr Fixed Asset
//              key asset-disposal:<assetId>[:v<n>]
// One booking per record (the key); an HRMS edit is shown as "Changed in
// HRMS" and "Update entry" books a reversal of the old entry and the new
// version — never a silent change. A closed month (Books closed up to) is a
// warning that must be confirmed.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const {
  ensureAccount, postJournal, reverseJournal, paise, LedgerError, isClosedMonth, closedUpTo, monthOfDate,
} = require('./ledger');
const { logAudit } = require('./audit');

const SOURCE = 'HRMS_ASSETS';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const DISPOSED = ['Sold', 'Written off', 'Written Off', 'Disposed'];
const isSold = (s) => String(s || '') === 'Sold';
const isWrittenOff = (s) => /^written off$|^disposed$/i.test(String(s || ''));

const BASE = [
  { code: '1000', name: 'Cash', type: 'ASSET', description: 'Cash in hand' },
  { code: '1400', name: 'Input GST', type: 'ASSET', description: 'GST paid on purchases and repairs (input tax credit)' },
  { code: '2300', name: 'Vendor Payable', type: 'LIABILITY', description: 'Amounts owed to vendors / service centres' },
  { code: '5300', name: 'Depreciation Expense', type: 'EXPENSE', description: 'Depreciation on fixed assets' },
  { code: '5400', name: 'Repairs & Maintenance', type: 'EXPENSE', description: 'Repairs, service and AMC (per-category sub-ledgers 54NN)' },
  { code: '4900', name: 'Profit on Sale of Assets', type: 'INCOME', description: 'Sale proceeds above book value' },
  { code: '5900', name: 'Loss on Sale / Disposal of Assets', type: 'EXPENSE', description: 'Book value not recovered on a sale or write-off' },
];
async function ensureBaseRaw() {
  const out = {};
  for (const a of BASE) {
    // eslint-disable-next-line no-await-in-loop
    out[a.code] = await ensureAccount(a);
  }
  return out;
}

// The three ledgers of one HRMS category, made on demand. NN is the first
// number free in all of 15xx, 16xx and 54xx; the category is remembered in
// the Fixed Asset ledger's aliases ("asset-cat:<category>").
async function categoryLedgersRaw(category) {
  const cat = String(category || 'Other').trim() || 'Other';
  const tag = `asset-cat:${cat.toLowerCase()}`;
  const all = await prisma.ledgerAccount.findMany({ where: { OR: [{ code: { startsWith: '15' } }, { code: { startsWith: '16' } }, { code: { startsWith: '54' } }] } });
  let fa = all.find((a) => a.code.startsWith('15') && String(a.aliases || '').split(',').includes(tag));
  let nn;
  if (fa) nn = fa.code.slice(2);
  else {
    const used = new Set(all.map((a) => a.code.slice(2)));
    let i = 1;
    while (i < 100 && (used.has(String(i).padStart(2, '0')))) i += 1;
    if (i >= 100) throw new LedgerError(422, 'No free ledger code for another asset category');
    nn = String(i).padStart(2, '0');
    fa = await ensureAccount({ code: `15${nn}`, name: `Fixed Asset — ${cat}`, type: 'ASSET', aliases: tag, description: `HRMS asset category "${cat}" (cost)` });
  }
  const dep = await ensureAccount({ code: `16${nn}`, name: `Accumulated Depreciation — ${cat}`, type: 'ASSET', aliases: `${tag}:dep`, description: `Depreciation booked on "${cat}" (contra asset)` });
  const rm = await ensureAccount({ code: `54${nn}`, name: `Repairs & Maintenance — ${cat}`, type: 'EXPENSE', aliases: `${tag}:rm`, description: `Repairs of "${cat}" assets` });
  return { fa, dep, rm };
}

// The credit side of a purchase / repair: Bank (the chosen bank's ledger, or
// the default 1100), Cash, or Vendor Payable. paidVia empty = Bank (decision
// for the assets already on file: reported as "assumed Bank").
async function payLedgerRaw(paidVia, bankAccountId) {
  const v = String(paidVia || '').toLowerCase();
  if (v === 'cash') return { acct: await ensureAccount(BASE[0]), label: 'Cash' };
  if (v === 'payable' || v === 'vendor payable' || v === 'credit') return { acct: await ensureAccount(BASE[2]), label: 'Vendor Payable' };
  if (bankAccountId) {
    // eslint-disable-next-line global-require
    const { bankLedger } = require('./payrollPosting');
    try { return { acct: await bankLedger(bankAccountId), label: 'Bank' }; } catch { /* fall through to the default bank */ }
  }
  const bank = await prisma.ledgerAccount.findUnique({ where: { code: '1100' } });
  return { acct: bank, label: v ? 'Bank' : 'Bank (assumed — "Paid via" is empty in HRMS)', assumed: !v };
}

// The ledgers hardly ever change: a short cache keeps the Pending list (one
// lookup per asset) fast. Entries live 15 seconds.
const memo = new Map();
function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = fn().catch((err) => { memo.delete(key); throw err; });
  memo.set(key, { value, until: Date.now() + 15000 });
  return value;
}
const ensureBase = () => cached('base', ensureBaseRaw);
const categoryLedgers = (category) => cached(`cat:${String(category || 'Other').trim().toLowerCase()}`, () => categoryLedgersRaw(category));
const payLedger = (paidVia, bankAccountId) => cached(`pay:${String(paidVia || '').toLowerCase()}:${bankAccountId || ''}`, () => payLedgerRaw(paidVia, bankAccountId));

// ---- Depreciation defaults (decision: Straight Line, life by category) -----
function defaultLife(category) {
  const c = String(category || '').toLowerCase();
  if (/laptop|computer|desktop|monitor|mouse|keyboard|charger|head ?set|printer|server|mobile|phone|tablet|scanner/.test(c)) return 3;
  if (/furniture|chair|table|desk|cupboard|sofa/.test(c)) return 10;
  if (/vehicle|car|bike|scooter/.test(c)) return 8;
  return 5;
}
function depRules(asset) {
  const method = String(asset.depreciationMethod || '').toUpperCase() === 'WDV' ? 'WDV' : 'SL';
  const life = Number(asset.usefulLifeYears) > 0 ? Number(asset.usefulLifeYears) : defaultLife(asset.category);
  const salvage = Number(asset.salvageValue) > 0 ? Number(asset.salvageValue) : 0;
  const rate = Number(asset.depreciationRate) > 0 ? Number(asset.depreciationRate) : (method === 'WDV' ? r2(100 * (1 - (0.05) ** (1 / life))) : r2(100 / life));
  return {
    method, life, salvage, rate,
    defaulted: { method: !asset.depreciationMethod, life: !(Number(asset.usefulLifeYears) > 0), salvage: asset.salvageValue == null, rate: !(Number(asset.depreciationRate) > 0) },
  };
}

// ---- Bookings: one per record, versions on change ------------------------------
async function bookingsOf(keyBase) {
  const list = await prisma.journalEntry.findMany({
    where: { OR: [{ idempotencyKey: keyBase }, { idempotencyKey: { startsWith: `${keyBase}:v` } }] },
    include: { lines: { orderBy: { lineNo: 'asc' } } }, orderBy: { createdAt: 'asc' },
  });
  const originals = list.filter((e) => !e.idempotencyKey.endsWith(':reversal'));
  const reversed = new Set(list.filter((e) => e.idempotencyKey.endsWith(':reversal')).map((e) => e.idempotencyKey.replace(/:reversal$/, '')));
  const current = [...originals].reverse().find((e) => !reversed.has(e.idempotencyKey)) || null;
  return { current, versions: originals.length };
}

const sig = (lines) => lines.map((l) => `${l.code || l.account}|${paise(l.debit || 0)}|${paise(l.credit || 0)}`).sort().join(';');
const sigOfEntry = (e) => sig(e.lines.map((l) => ({ code: l.accountCode, debit: l.debit, credit: l.credit })));

// Book (or re-book) a record's journal. plan: { keyBase, date, narration,
// referenceType, referenceId, lines:[{code, debit, credit, memo, refType, refId}] }
async function book(plan, actor, { confirmClosed = false } = {}) {
  const { current, versions } = await bookingsOf(plan.keyBase);
  const lines = plan.lines.filter((l) => paise(l.debit) || paise(l.credit));
  if (current && current.date === plan.date && sigOfEntry(current) === sig(lines)) return { status: 'in-sync', entry: current };
  const closedOld = current ? await isClosedMonth(current.month) : false;
  const closedNew = await isClosedMonth(monthOfDate(plan.date));
  if ((closedOld || closedNew) && !confirmClosed) {
    const c = await closedUpTo();
    throw new LedgerError(409, `The books are closed up to ${c}. ${current ? 'Changing this entry' : 'Posting this entry'} touches a closed month — confirm to go ahead.`);
  }
  let reversal = null;
  if (current) {
    const r = await reverseJournal(current.id, { actor, narration: `Reversal of ${current.narration} (changed in HRMS)`, date: closedOld ? today() : null });
    reversal = r.entry;
  }
  const [y, m] = plan.date.split('-').map(Number);
  const key = versions ? `${plan.keyBase}:v${versions + 1}` : plan.keyBase;
  const r = await postJournal({
    month: m, year: y, date: plan.date, narration: plan.narration, source: SOURCE, voucher_type: plan.voucherType || 'Journal',
    reference_type: plan.referenceType, reference_id: plan.referenceId, idempotency_key: key, ...(plan.extra || {}),
    debit: lines.filter((l) => paise(l.debit)).map((l) => ({ account: l.code, amount: r2(l.debit), memo: l.memo, reference_type: l.refType, reference_id: l.refId })),
    credit: lines.filter((l) => paise(l.credit)).map((l) => ({ account: l.code, amount: r2(l.credit), memo: l.memo, reference_type: l.refType, reference_id: l.refId })),
  }, { actor });
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System',
    action: current ? 'Asset journal updated from HRMS' : 'Asset journal posted', entity: 'JournalEntry', entityId: r.entry.id,
    fromValue: current ? `${current.idempotencyKey} · ₹${current.totalDebit}` : null, toValue: `${key} · ₹${r.entry.totalDebit}`, reason: plan.narration,
  });
  return { status: current ? 'updated' : 'posted', entry: r.entry, reversal };
}

// ---- Reading HRMS -------------------------------------------------------------------
async function loadAssets(where = {}) {
  return prisma.asset.findMany({ where, include: { assignedTo: { select: { id: true, name: true, employeeCode: true, department: true } } }, orderBy: { assetCode: 'asc' } });
}
function parseHistory(raw) { try { const h = JSON.parse(raw || '[]'); return Array.isArray(h) ? h : []; } catch { return []; } }
function dateOfStamp(s) {
  const t = String(s || '');
  if (isDate(t.slice(0, 10))) return t.slice(0, 10);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Every repair of these assets: AssetRepair rows, plus the older repairs that
// are still only "back from repair" entries in Asset.history (not yet copied).
async function loadRepairs(assets) {
  const ids = assets.map((a) => a.id);
  const rows = prisma.assetRepair ? await prisma.assetRepair.findMany({ where: { assetId: { in: ids } }, orderBy: { createdAt: 'asc' } }) : [];
  const copied = new Set(rows.map((r) => r.legacyEntryId).filter(Boolean));
  const out = rows.map((r) => ({ ...r, legacy: false }));
  assets.forEach((a) => {
    // A row made at 'send' carries the SENT entry's id; its 'back' entry points at it (repairOf).
    parseHistory(a.history).filter((h) => h && h.kind === 'repair' && h.step === 'back' && !copied.has(h.id) && !(h.repairOf && copied.has(h.repairOf))).forEach((h) => {
      const sent = parseHistory(a.history).find((x) => x && x.id === h.repairOf);
      out.push({
        id: `legacy-${h.id}`, legacyEntryId: h.id, legacy: true, repairNo: `H-${String(h.id).slice(-6)}`, assetId: a.id,
        dateReported: sent ? dateOfStamp(sent.at) : null, issue: sent ? sent.issue : null, repairType: 'Repair', vendor: h.vendor || (sent && sent.vendor) || null,
        repairDate: dateOfStamp(h.at), cost: Number(h.cost) || 0, gstPaid: 0, invoiceNo: null, paidVia: null, paidBankAccountId: null,
        underWarranty: false, capitalise: false, status: 'Completed', reportedByName: h.by || null, notes: h.fixed || null,
      });
    });
  });
  return out;
}

// What the books say per asset (from journal lines carrying the asset id).
async function bookFigures(assetIds, { upTo = null, from = null, excludeDisposal = false } = {}) {
  const lines = await prisma.journalLine.findMany({
    where: { referenceId: { in: assetIds }, referenceType: excludeDisposal ? { in: ['ASSET_PURCHASE', 'ASSET_REPAIR', 'ASSET_DEPRECIATION'] } : { startsWith: 'ASSET' }, ...(upTo ? { journalEntry: { date: { lte: upTo } } } : {}) },
    include: { journalEntry: { select: { date: true, idempotencyKey: true, referenceType: true } } },
  });
  const f = new Map();
  const get = (id) => { if (!f.has(id)) f.set(id, { gross: 0, accDep: 0, depInWindow: 0, lastDepTo: null }); return f.get(id); };
  lines.forEach((l) => {
    const x = get(l.referenceId);
    if (/^15/.test(l.accountCode)) x.gross += l.debit - l.credit;
    if (/^16/.test(l.accountCode)) {
      x.accDep += l.credit - l.debit;
      if (from && l.journalEntry.date >= from) x.depInWindow += l.credit - l.debit;
    }
  });
  f.forEach((x) => { x.gross = r2(x.gross); x.accDep = r2(x.accDep); x.bookValue = r2(x.gross - x.accDep); });
  return f;
}

// ---- Plans (what the journal SHOULD hold for a record) --------------------------------
async function purchasePlan(a) {
  const cost = Number(a.purchaseCost) || 0;
  const gst = Number(a.gstPaid) || 0;
  if (cost <= 0) return null;
  const { fa } = await categoryLedgers(a.category);
  const base = await ensureBase();
  const pay = await payLedger(a.paidVia, a.paidBankAccountId);
  const date = isDate(a.purchaseDate) ? a.purchaseDate : new Date(a.createdAt).toISOString().slice(0, 10);
  const ref = { refType: 'ASSET_PURCHASE', refId: a.id };
  return {
    keyBase: `asset-purchase:${a.id}`, date, voucherType: 'Purchase',
    narration: `Asset purchase ${a.assetCode} · ${a.name}${a.vendor ? ` · ${a.vendor}` : ''}${a.invoiceNo ? ` · inv ${a.invoiceNo}` : ''}`,
    referenceType: 'ASSET_PURCHASE', referenceId: a.id, paidLabel: pay.label, assumedPay: !!pay.assumed,
    lines: [
      { code: fa.code, debit: cost, credit: 0, memo: `${a.assetCode} cost`, ...ref },
      { code: base['1400'].code, debit: gst, credit: 0, memo: `${a.assetCode} GST`, ...ref },
      { code: pay.acct.code, debit: 0, credit: cost + gst, memo: `${a.assetCode} paid (${pay.label})`, ...ref },
    ],
  };
}

async function repairPlan(rep, a) {
  if (String(rep.status) !== 'Completed') return null;
  const cost = Number(rep.cost) || 0;
  const gst = Number(rep.gstPaid) || 0;
  if (cost + gst <= 0) return null;
  const { fa, rm } = await categoryLedgers(a.category);
  const base = await ensureBase();
  const pay = await payLedger(rep.paidVia, rep.paidBankAccountId);
  const date = isDate(rep.repairDate) ? rep.repairDate : (isDate(rep.dateReported) ? rep.dateReported : today());
  const ref = { refType: 'ASSET_REPAIR', refId: a.id };
  return {
    keyBase: rep.legacy ? `asset-repair-legacy:${rep.legacyEntryId}` : `asset-repair:${rep.id}`, date, voucherType: 'Purchase',
    narration: `${rep.capitalise ? 'Capitalised repair' : 'Repair'} ${rep.repairNo} · ${a.assetCode} ${a.name}${rep.vendor ? ` · ${rep.vendor}` : ''}`,
    referenceType: 'ASSET_REPAIR', referenceId: rep.id, paidLabel: pay.label, assumedPay: !!pay.assumed,
    lines: [
      { code: rep.capitalise ? fa.code : rm.code, debit: cost, credit: 0, memo: `${rep.repairNo} ${rep.repairType || 'Repair'}`, ...ref },
      { code: base['1400'].code, debit: gst, credit: 0, memo: `${rep.repairNo} GST`, ...ref },
      { code: pay.acct.code, debit: 0, credit: cost + gst, memo: `${rep.repairNo} paid (${pay.label})`, ...ref },
    ],
  };
}

async function disposalPlan(a, fig) {
  if (!isSold(a.status) && !isWrittenOff(a.status)) return null;
  if (!fig || fig.gross <= 0) return { blocked: 'Post the purchase first — the asset is not in the books.' };
  const { fa, dep } = await categoryLedgers(a.category);
  const base = await ensureBase();
  const date = isDate(a.disposalDate) ? a.disposalDate : today();
  const ref = { refType: 'ASSET_DISPOSAL', refId: a.id };
  const proceeds = isSold(a.status) ? Math.max(Number(a.disposalAmount) || 0, 0) : 0;
  const bv = r2(fig.gross - fig.accDep);
  const lines = [
    { code: dep.code, debit: fig.accDep, credit: 0, memo: `${a.assetCode} accumulated depreciation`, ...ref },
    { code: fa.code, debit: 0, credit: fig.gross, memo: `${a.assetCode} cost removed`, ...ref },
  ];
  if (proceeds > 0) {
    const pay = await payLedger(a.disposalPaidVia || 'Bank', null);
    lines.push({ code: pay.acct.code, debit: proceeds, credit: 0, memo: `${a.assetCode} sale proceeds`, ...ref });
  }
  const diff = r2(proceeds - bv);
  if (diff > 0) lines.push({ code: base['4900'].code, debit: 0, credit: diff, memo: `${a.assetCode} profit on sale`, ...ref });
  if (diff < 0) lines.push({ code: base['5900'].code, debit: -diff, credit: 0, memo: `${a.assetCode} ${isSold(a.status) ? 'loss on sale' : 'written off'}`, ...ref });
  return {
    keyBase: `asset-disposal:${a.id}`, date, voucherType: 'Journal',
    narration: `${isSold(a.status) ? 'Sale' : 'Write-off'} of ${a.assetCode} · ${a.name}${proceeds ? ` for ₹${proceeds}` : ''}`,
    referenceType: 'ASSET_DISPOSAL', referenceId: a.id, lines, bookValue: bv, proceeds, result: diff,
  };
}

// ---- The "Pending from HRMS" list -------------------------------------------------------
// One row per record that needs (or has) a journal: kind purchase | repair |
// disposal, state Not posted | Changed in HRMS | Posted | Covered by warranty | Blocked.
async function pendingList({ includePosted = false } = {}) {
  const assets = await loadAssets();
  const repairs = await loadRepairs(assets);
  const figs = await bookFigures(assets.map((a) => a.id), { excludeDisposal: true });
  const rows = [];
  for (const a of assets) {
    const holder = a.assignedTo ? a.assignedTo.name : null;
    const baseRow = { assetId: a.id, assetCode: a.assetCode, assetName: a.name, category: a.category, holder, assetStatus: a.status };
    // eslint-disable-next-line no-await-in-loop
    const pp = await purchasePlan(a);
    if (pp) {
      // eslint-disable-next-line no-await-in-loop
      const { current } = await bookingsOf(pp.keyBase);
      const lines = pp.lines.filter((l) => paise(l.debit) || paise(l.credit));
      const state = !current ? 'Not posted' : (current.date === pp.date && sigOfEntry(current) === sig(lines)) ? 'Posted' : 'Changed in HRMS';
      rows.push({
        ...baseRow, kind: 'purchase', id: a.id, ref: a.assetCode, date: pp.date, amount: r2(Number(a.purchaseCost) + (Number(a.gstPaid) || 0)),
        gst: Number(a.gstPaid) || 0, paid: pp.paidLabel, assumedPay: pp.assumedPay, state, journalEntryId: current ? current.id : null, narration: pp.narration,
      });
    }
    for (const rep of repairs.filter((r) => r.assetId === a.id)) {
      if (rep.underWarranty && !(Number(rep.cost) + Number(rep.gstPaid || 0))) {
        rows.push({ ...baseRow, kind: 'repair', id: rep.id, ref: rep.repairNo, date: rep.repairDate, amount: 0, state: 'Covered by warranty', journalEntryId: null, narration: `${rep.repairNo} · covered by warranty` });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const rp = await repairPlan(rep, a);
      if (!rp) continue;
      // eslint-disable-next-line no-await-in-loop
      const { current } = await bookingsOf(rp.keyBase);
      const lines = rp.lines.filter((l) => paise(l.debit) || paise(l.credit));
      const state = !current ? 'Not posted' : (current.date === rp.date && sigOfEntry(current) === sig(lines)) ? 'Posted' : 'Changed in HRMS';
      rows.push({
        ...baseRow, kind: 'repair', id: rep.id, ref: rep.repairNo, date: rp.date, amount: r2(Number(rep.cost) + (Number(rep.gstPaid) || 0)), gst: Number(rep.gstPaid) || 0,
        capitalise: !!rep.capitalise, legacy: !!rep.legacy, paid: rp.paidLabel, assumedPay: rp.assumedPay, state, journalEntryId: current ? current.id : null, narration: rp.narration,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const dp = await disposalPlan(a, figs.get(a.id));
    if (dp) {
      if (dp.blocked) rows.push({ ...baseRow, kind: 'disposal', id: a.id, ref: a.assetCode, date: a.disposalDate, amount: Number(a.disposalAmount) || 0, state: 'Blocked', reason: dp.blocked });
      else {
        // eslint-disable-next-line no-await-in-loop
        const { current } = await bookingsOf(dp.keyBase);
        const state = !current ? 'Not posted' : (current.date === dp.date && sigOfEntry(current) === sig(dp.lines.filter((l) => paise(l.debit) || paise(l.credit)))) ? 'Posted' : 'Changed in HRMS';
        rows.push({ ...baseRow, kind: 'disposal', id: a.id, ref: a.assetCode, date: dp.date, amount: dp.proceeds, bookValue: dp.bookValue, result: dp.result, state, journalEntryId: current ? current.id : null, narration: dp.narration });
      }
    }
  }
  return includePosted ? rows : rows.filter((r) => r.state !== 'Posted');
}

// Post / update one record. item: { kind, id }
async function postItem(item, actor, opts = {}) {
  if (item.kind === 'purchase' || item.kind === 'disposal') {
    const [a] = await loadAssets({ id: item.id });
    if (!a) throw new LedgerError(404, 'Asset not found in HRMS');
    if (item.kind === 'purchase') {
      const plan = await purchasePlan(a);
      if (!plan) throw new LedgerError(422, `${a.assetCode} has no purchase cost in HRMS — add it there first.`);
      return book(plan, actor, opts);
    }
    const figs = await bookFigures([a.id], { excludeDisposal: true });
    const plan = await disposalPlan(a, figs.get(a.id));
    if (!plan) throw new LedgerError(422, `${a.assetCode} is not Sold / Written off in HRMS.`);
    if (plan.blocked) throw new LedgerError(409, plan.blocked);
    return book(plan, actor, opts);
  }
  if (item.kind === 'repair') {
    const legacy = String(item.id).startsWith('legacy-');
    let rep; let a;
    if (legacy) {
      const all = await loadAssets();
      const reps = await loadRepairs(all);
      rep = reps.find((r) => r.id === item.id);
      a = rep ? all.find((x) => x.id === rep.assetId) : null;
    } else {
      rep = prisma.assetRepair ? await prisma.assetRepair.findUnique({ where: { id: item.id } }) : null;
      if (rep) {
        [a] = await loadAssets({ id: rep.assetId });
        // A repair copied from history that was already posted under its old key.
        if (rep.legacyEntryId) {
          const old = await bookingsOf(`asset-repair-legacy:${rep.legacyEntryId}`);
          if (old.current) return { status: 'in-sync', entry: old.current };
        }
      }
    }
    if (!rep || !a) throw new LedgerError(404, 'Repair not found in HRMS');
    const plan = await repairPlan(rep, a);
    if (!plan) throw new LedgerError(422, rep.underWarranty ? 'Covered by warranty — nothing to post.' : 'Only a Completed repair with a cost is posted.');
    return book(plan, actor, opts);
  }
  throw new LedgerError(400, 'Unknown item');
}

// ---- Depreciation -----------------------------------------------------------------------
const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs) + 1;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

async function depRuns() {
  const runs = await prisma.journalEntry.findMany({ where: { referenceType: 'ASSET_DEPRECIATION' }, orderBy: { date: 'asc' } });
  const keys = runs.map((r) => `${r.idempotencyKey}:reversal`);
  const revs = keys.length ? await prisma.journalEntry.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } }) : [];
  const reversed = new Set(revs.map((r) => r.idempotencyKey.replace(/:reversal$/, '')));
  return runs.filter((r) => !reversed.has(r.idempotencyKey)).map((r) => {
    let p = {}; try { p = JSON.parse(r.payload || '{}'); } catch { p = {}; }
    return { id: r.id, from: p.period_from, to: p.period_to, date: r.date, total: r.totalDebit, narration: r.narration, key: r.idempotencyKey };
  });
}

async function depreciationPreview(from, to) {
  if (!isDate(from) || !isDate(to) || from > to) throw new LedgerError(400, 'Pick a period: from and to dates, from before to.');
  const runs = await depRuns();
  const overlap = runs.find((r) => r.from && r.to && !(to < r.from || from > r.to));
  const assets = await loadAssets();
  const figs = await bookFigures(assets.map((a) => a.id), { upTo: addDays(from, -1) });
  const disposals = await prisma.journalEntry.findMany({ where: { referenceType: 'ASSET_DISPOSAL' }, select: { referenceId: true, date: true, idempotencyKey: true } });
  const disposedOn = new Map();
  for (const d of disposals) {
    // eslint-disable-next-line no-await-in-loop
    const rev = await prisma.journalEntry.findUnique({ where: { idempotencyKey: `${d.idempotencyKey}:reversal` }, select: { id: true } });
    if (!rev) disposedOn.set(d.referenceId, d.date);
  }
  const rows = [];
  let notInBooks = 0;
  for (const a of assets) {
    const fig = figs.get(a.id);
    if (!fig || fig.gross <= 0) { if (Number(a.purchaseCost) > 0) notInBooks += 1; continue; }
    const rules = depRules(a);
    const bought = isDate(a.purchaseDate) ? a.purchaseDate : from;
    const gone = disposedOn.get(a.id) || (DISPOSED.includes(a.status) && isDate(a.disposalDate) ? a.disposalDate : null);
    const start = bought > from ? bought : from;
    const end = gone && gone < to ? gone : to;
    if (start > end || (gone && gone < from)) continue;
    const days = daysBetween(start, end);
    const bv = fig.gross - fig.accDep;
    const room = Math.max(bv - rules.salvage, 0);
    let yearly;
    if (rules.method === 'WDV') yearly = bv * (rules.rate / 100);
    else {
      // Straight line over the REMAINING life on the current book value, so a
      // capitalised repair is spread over what is left.
      const usedYears = Math.max(0, (Date.parse(`${start}T00:00:00Z`) - Date.parse(`${bought}T00:00:00Z`)) / (365 * dayMs));
      const left = rules.life - usedYears;
      yearly = left > 0 ? room / left : room * (365 / days);
    }
    const dep = r2(Math.min(room, yearly * (days / 365)));
    if (dep <= 0) continue;
    rows.push({
      assetId: a.id, assetCode: a.assetCode, name: a.name, category: a.category, holder: a.assignedTo ? a.assignedTo.name : null,
      method: rules.method, life: rules.life, rate: rules.rate, salvage: rules.salvage, defaulted: rules.defaulted,
      cost: fig.gross, accumulatedBefore: fig.accDep, bookValueBefore: r2(bv), days, depreciation: dep, bookValueAfter: r2(bv - dep),
    });
  }
  const total = r2(rows.reduce((n, r) => n + r.depreciation, 0));
  const byCategory = {};
  rows.forEach((r) => { byCategory[r.category] = r2((byCategory[r.category] || 0) + r.depreciation); });
  return {
    from, to, rows, total, byCategory, notInBooks, lastRun: runs.length ? runs[runs.length - 1] : null,
    overlap: overlap ? { ...overlap } : null,
    gap: runs.length && runs[runs.length - 1].to && addDays(runs[runs.length - 1].to, 1) < from ? { after: runs[runs.length - 1].to } : null,
    defaultsUsed: rows.filter((r) => r.defaulted.method || r.defaulted.life).length,
  };
}

async function runDepreciation(from, to, actor, { confirmClosed = false } = {}) {
  const pv = await depreciationPreview(from, to);
  if (pv.overlap) throw new LedgerError(409, `Depreciation for ${pv.overlap.from} – ${pv.overlap.to} is already booked. Pick a period after ${pv.overlap.to}, or reverse that run first.`);
  if (!pv.rows.length) throw new LedgerError(422, 'Nothing to depreciate for this period.');
  if (await isClosedMonth(monthOfDate(to)) && !confirmClosed) throw new LedgerError(409, `The books are closed up to ${await closedUpTo()} — confirm to book into a closed month.`);
  await ensureBase();
  const lines = [];
  for (const r of pv.rows) {
    // eslint-disable-next-line no-await-in-loop
    const { dep } = await categoryLedgers(r.category);
    lines.push({ account: '5300', amount: r.depreciation, memo: `${r.assetCode} ${r.method} ${r.days} day(s)`, reference_type: 'ASSET_DEPRECIATION', reference_id: r.assetId, side: 'debit' });
    lines.push({ account: dep.code, amount: r.depreciation, memo: `${r.assetCode}`, reference_type: 'ASSET_DEPRECIATION', reference_id: r.assetId, side: 'credit' });
  }
  const [y, m] = to.split('-').map(Number);
  const res = await postJournal({
    month: m, year: y, date: to, narration: `Depreciation ${from} to ${to} · ${pv.rows.length} asset(s)`, source: SOURCE, voucher_type: 'Journal',
    reference_type: 'ASSET_DEPRECIATION', reference_id: `${from}..${to}`, idempotency_key: `asset-dep:${from}:${to}`,
    period_from: from, period_to: to,
    debit: lines.filter((l) => l.side === 'debit').map(({ side, ...l }) => l),
    credit: lines.filter((l) => l.side === 'credit').map(({ side, ...l }) => l),
  }, { actor });
  await logAudit({
    userId: actor && actor.id ? actor.id : null, actorName: actor ? actor.name : 'System', action: 'Depreciation run booked', entity: 'JournalEntry', entityId: res.entry.id,
    toValue: `${from} to ${to} · ₹${res.entry.totalDebit} · ${pv.rows.length} asset(s)`,
  });
  return { entry: res.entry, replay: res.replay, preview: pv };
}

// ---- Automatic sync from HRMS (S2.3) ---------------------------------------------------
// Called by HRMS after an asset / repair is saved. Records created after the
// feature went live are posted at once; a record that already has a journal
// is kept in step (reversal + new version). Older records (the assets that
// were on file before) wait in "Pending from HRMS" for Accounts to post —
// that is the user's decision. Never throws: the result says what happened.
const AUTO_KEY = 'accounts.assetAutoPostFrom';
async function autoFrom() {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_KEY } }).catch(() => null);
  if (row) { try { return new Date(JSON.parse(row.value)); } catch { return new Date(); } }
  const now = new Date();
  await prisma.appSetting.create({ data: { key: AUTO_KEY, value: JSON.stringify(now.toISOString()), updatedByName: 'System' } }).catch(() => {});
  return now;
}

async function autoSync({ assetId, repairId = null }, actor) {
  const out = [];
  try {
    const from = await autoFrom();
    const [a] = await loadAssets({ id: assetId });
    if (!a) return out;
    const isNew = (d) => d && new Date(d) >= from;
    const items = [];
    const pp = await purchasePlan(a);
    if (pp) {
      const { current } = await bookingsOf(pp.keyBase);
      if (current || isNew(a.createdAt)) items.push({ kind: 'purchase', id: a.id });
    }
    if (repairId) {
      const rep = prisma.assetRepair ? await prisma.assetRepair.findUnique({ where: { id: repairId } }) : null;
      if (rep) {
        const { current } = await bookingsOf(`asset-repair:${rep.id}`);
        const [ra] = await loadAssets({ id: rep.assetId });
        const plan = ra ? await repairPlan(rep, ra) : null;
        if (current && !plan) {
          // Cancelled (or its cost cleared) after it was posted: reverse it.
          const r = await reverseJournal(current.id, { actor, narration: `Reversal of ${current.narration} (${rep.status} in HRMS)` });
          out.push({ kind: 'repair', id: rep.id, ok: true, status: 'reversed', journalEntryId: r.entry.id });
        } else if (plan && (current || isNew(rep.createdAt))) items.push({ kind: 'repair', id: rep.id });
      }
    }
    if (isSold(a.status) || isWrittenOff(a.status)) {
      const { current } = await bookingsOf(`asset-purchase:${a.id}`);
      if (current) items.push({ kind: 'disposal', id: a.id });
    } else {
      // No longer Sold / Written off in HRMS: undo the disposal entry.
      const { current } = await bookingsOf(`asset-disposal:${a.id}`);
      if (current) {
        const r = await reverseJournal(current.id, { actor, narration: `Reversal of ${current.narration} (status is ${a.status} again in HRMS)` });
        out.push({ kind: 'disposal', id: a.id, ok: true, status: 'reversed', journalEntryId: r.entry.id });
      }
    }
    for (const it of items) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await postItem(it, actor);
        out.push({ ...it, ok: true, status: r.status });
      } catch (err) {
        out.push({ ...it, ok: false, error: err.message });
      }
    }
  } catch (err) {
    out.push({ ok: false, error: err.message });
  }
  return out;
}

// ---- Delete guard for HRMS (S2.7) ------------------------------------------------------
// true when an asset (or a repair) has journal entries — HRMS must refuse
// to delete it and offer Dispose / Cancel instead.
async function hasJournal({ assetId = null, repairId = null } = {}) {
  if (repairId) {
    const n = await prisma.journalEntry.count({ where: { OR: [{ referenceType: 'ASSET_REPAIR', referenceId: repairId }, { idempotencyKey: { startsWith: `asset-repair:${repairId}` } }] } });
    return n > 0;
  }
  if (assetId) return (await prisma.journalLine.count({ where: { referenceId: assetId, referenceType: { startsWith: 'ASSET' } } })) > 0;
  return false;
}

module.exports = {
  SOURCE, ensureBase, categoryLedgers, depRules, defaultLife, loadAssets, loadRepairs, bookFigures, bookingsOf,
  purchasePlan, repairPlan, disposalPlan, pendingList, postItem, autoSync, autoFrom, depreciationPreview, runDepreciation, depRuns, hasJournal, r2,
};
