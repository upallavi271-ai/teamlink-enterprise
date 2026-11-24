// ---------------------------------------------------------------------------
// CRM WAVE D - PRODUCTS, QUOTES & ORDERS (2026-11-24). Everything stays inside CRM Deals; nothing here reads or writes the Accounts module.
//   line items        products (our catalogue's plans, or anything typed) on a deal: qty, unit price, line discount, billing period;
//                     the deal's value becomes the sum of its lines, and the invoice made on Won carries the same lines
//   price books       other price lists per region (customer state) or per customer; the first that fits a deal gives its prices
//   CPQ rules         bundles (several products at a bundle discount), "needs" rules (X cannot be sold without Y), volume discounts
//   quote templates   the built-in recruitment proposal plus product quotation templates the Admin writes (title, intro, terms, footer,
//                     colour); every quote of a deal is a numbered version, "Revise" makes the next one
//   quote approval    a quote whose discount is over the limit (or every quote, or a recruitment fee under a floor) waits for a Sales
//                     manager before it can be emailed
//   sales orders /    made from a deal: number, dates, renewal date (a follow-up for the owner before it), status
//   contracts
//   Tally / Zoho file the CRM's own invoices as a Tally XML or a Zoho Books CSV to download - posting into the books is the founder's call
// ---------------------------------------------------------------------------
const S = require('./service');
const SETTINGS = require('./settings');
const P = require('./plusSchema');

const BILLINGS = ['One-time', 'Monthly', 'Quarterly', 'Yearly'];
const cents = (n) => Math.round(Number(n || 0) * 100) / 100;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const priceNum = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
const billingOfUnit = (u) => (/year|annual/i.test(String(u || '')) ? 'Yearly' : /quarter/i.test(String(u || '')) ? 'Quarterly' : /month/i.test(String(u || '')) ? 'Monthly' : 'One-time');
const lineNet = (l) => cents((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * (1 - (Number(l.discountPercent) || 0) / 100));
const sid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const managerOnly = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'Only a Sales manager or an Admin can change this.'));

// ---- the catalogue (crm/productSales.js products and their plans) --------------------------------------------------------
async function catalogue() {
  const PS = require('./productSales'); // eslint-disable-line global-require
  const prods = await PS.products().catch(() => []);
  const out = [];
  prods.forEach((p) => (p.plans || []).forEach((pl) => { if (pl && pl.name) out.push({ productKey: p.key, plan: pl.name, name: `${p.name} - ${pl.name}`, listPrice: priceNum(pl.price), unit: pl.unit || '', billing: billingOfUnit(pl.unit) }); }));
  return out;
}

// ---- price books ---------------------------------------------------------------------------------------------------------
function cleanBook(b) {
  const list = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/\n|,/)).map((x) => String(x || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 60);
  return {
    id: String((b && b.id) || sid('pb')).replace(/[^a-z0-9_-]/gi, '').slice(0, 40), name: String((b && b.name) || '').trim().slice(0, 60),
    states: list(b && b.states), accountIds: list(b && b.accountIds), isDefault: !!(b && b.isDefault), active: !(b && b.active === false),
    entries: (Array.isArray(b && b.entries) ? b.entries : []).map((e) => ({ productKey: String((e && e.productKey) || '').toUpperCase().slice(0, 30), plan: String((e && e.plan) || '').slice(0, 60), price: cents(priceNum(e && e.price)) })).filter((e) => e.productKey && e.plan).slice(0, 200),
  };
}
async function priceBooks() { const v = await P.getCfg('pricebooks', { books: [] }); return (v.books || []).map(cleanBook).filter((b) => b.name); }
async function savePriceBooks(user, body = {}) {
  const no = managerOnly(user); if (no) return no;
  const books = (Array.isArray(body.books) ? body.books : []).map(cleanBook).filter((b) => b.name).slice(0, 30);
  if (new Set(books.map((b) => b.name.toLowerCase())).size !== books.length) return S.fail(400, 'Two price books have the same name.');
  let def = false; books.forEach((b) => { if (b.isDefault) { if (def) b.isDefault = false; def = true; } });
  await P.setCfg('pricebooks', { books });
  await S.audit(user, 'CRM price books changed', 'CrmSettings', 'pricebooks', books.map((b) => `${b.name} (${b.entries.length} prices)`).join('; '));
  return S.okBody({ ok: true, books });
}
// the book that prices a deal: the one picked on the deal, else one made for its customer, else one for the customer's state, else the default
async function bookFor(deal, account) {
  const books = (await priceBooks()).filter((b) => b.active);
  if (deal && deal.priceBookId) { const b = books.find((x) => x.id === deal.priceBookId); if (b) return b; }
  if (account) {
    const byAcc = books.find((b) => b.accountIds.includes(account.id));
    if (byAcc) return byAcc;
    const st = String(account.state || '').trim().toLowerCase();
    const bySt = st && books.find((b) => b.states.some((x) => x.toLowerCase() === st));
    if (bySt) return bySt;
  }
  return books.find((b) => b.isDefault) || null;
}
const priceIn = (book, productKey, plan) => { const e = book && book.entries.find((x) => x.productKey === productKey && x.plan === plan); return e ? e.price : null; };

// ---- CPQ rules -----------------------------------------------------------------------------------------------------------
function cleanCpq(v = {}) {
  const pk = (x) => String(x || '').toUpperCase().slice(0, 30);
  const pct = (x) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : 0; };
  return {
    bundles: (Array.isArray(v.bundles) ? v.bundles : []).map((b) => ({ id: String((b && b.id) || sid('bdl')).replace(/[^a-z0-9_-]/gi, '').slice(0, 40), name: String((b && b.name) || '').trim().slice(0, 80), discountPercent: pct(b && b.discountPercent), items: (Array.isArray(b && b.items) ? b.items : []).map((i) => ({ productKey: pk(i && i.productKey), plan: String((i && i.plan) || '').slice(0, 60), qty: Math.max(1, Number(i && i.qty) || 1) })).filter((i) => i.productKey && i.plan).slice(0, 10) })).filter((b) => b.name && b.items.length).slice(0, 30),
    requires: (Array.isArray(v.requires) ? v.requires : []).map((x) => ({ productKey: pk(x && x.productKey), needs: pk(x && x.needs), message: String((x && x.message) || '').trim().slice(0, 200) })).filter((x) => x.productKey && x.needs && x.productKey !== x.needs).slice(0, 40),
    volume: (Array.isArray(v.volume) ? v.volume : []).map((x) => ({ productKey: pk(x && x.productKey), minQty: Math.max(1, Math.round(Number(x && x.minQty) || 1)), discountPercent: pct(x && x.discountPercent) })).filter((x) => x.productKey && x.discountPercent > 0).slice(0, 40),
    maxLineDiscount: v.maxLineDiscount === '' || v.maxLineDiscount == null ? null : pct(v.maxLineDiscount),
  };
}
async function cpq() { return cleanCpq(await P.getCfg('cpq', {})); }
async function saveCpq(user, body = {}) {
  const no = managerOnly(user); if (no) return no;
  const next = cleanCpq(body);
  await P.setCfg('cpq', next);
  await S.audit(user, 'CRM CPQ rules changed', 'CrmSettings', 'cpq', `${next.bundles.length} bundles, ${next.requires.length} needs-rules, ${next.volume.length} volume discounts`);
  return S.okBody({ ok: true, cpq: next });
}
// Apply the rules to a set of lines: volume discounts lift a lower line discount; a "needs" rule not met is an error; a line discount over the cap is an error.
function applyCpq(lines, rules) {
  const notes = [];
  const keys = new Set(lines.map((l) => l.productKey).filter(Boolean));
  for (const rq of rules.requires) {
    if (keys.has(rq.productKey) && !keys.has(rq.needs)) return { error: rq.message || `${rq.productKey} cannot be sold without ${rq.needs}. Add a ${rq.needs} line.` };
  }
  const out = lines.map((l) => {
    if (!l.productKey) return l;
    const qtyOfProduct = lines.filter((x) => x.productKey === l.productKey).reduce((n, x) => n + (Number(x.qty) || 0), 0);
    const best = rules.volume.filter((v) => v.productKey === l.productKey && qtyOfProduct >= v.minQty).sort((a, b) => b.discountPercent - a.discountPercent)[0];
    if (best && (Number(l.discountPercent) || 0) < best.discountPercent) { notes.push(`${l.name}: ${best.discountPercent}% volume discount (${best.minQty}+)`); return { ...l, discountPercent: best.discountPercent, rule: `volume ${best.minQty}+` }; }
    return l;
  });
  if (rules.maxLineDiscount != null) {
    const over = out.find((l) => (Number(l.discountPercent) || 0) > rules.maxLineDiscount && !l.bundle && !l.rule);
    if (over) return { error: `${over.name}: a line discount above ${rules.maxLineDiscount}% is not allowed. Use the deal discount (it goes for approval) instead.` };
  }
  return { lines: out, notes };
}

// ---- line items on a deal ----------------------------------------------------------------------------------------------
async function dealFor(user, dealId, { edit } = {}) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!deal || !S.canSeeRow(user, r, deal)) return { err: S.fail(404, 'This deal is not there, or it is not yours.') };
  if (edit && !S.canEditRow(user, r, deal)) return { err: S.fail(403, 'You can read this deal but not change it.') };
  return { deal, r };
}
const linesOf = (dealId) => P.all('SELECT * FROM "CrmDealLine" WHERE "dealId" = ? ORDER BY "sort", "createdAt"', dealId);
async function lines(user, dealId) {
  const x = await dealFor(user, dealId);
  if (x.err) return x.err;
  const { deal } = x;
  const account = deal.accountId ? await S.getRow('account', deal.accountId) : null;
  const book = await bookFor(deal, account);
  const cat = (await catalogue()).map((c) => ({ ...c, price: priceIn(book, c.productKey, c.plan) ?? c.listPrice }));
  const rows = await linesOf(deal.id);
  const PL = require('./pipelines'); // eslint-disable-line global-require
  const subtotal = cents(rows.reduce((n, l) => n + lineNet(l), 0));
  return S.okBody({
    lines: rows.map((l) => ({ ...l, net: lineNet(l) })), subtotal, dealDiscountPercent: Number(deal.discountPercent) || 0, finalValue: deal.finalValue != null ? deal.finalValue : deal.value, mrr: PL.mrrOf(deal, rows),
    priceBook: book ? { id: book.id, name: book.name } : null, priceBookId: deal.priceBookId || null, priceBooks: (await priceBooks()).filter((b) => b.active).map((b) => ({ id: b.id, name: b.name })),
    catalogue: cat, bundles: (await cpq()).bundles, billings: BILLINGS, canEdit: S.canEditRow(user, x.r, deal), approvalStatus: deal.approvalStatus,
  });
}
function cleanLine(x, i) {
  const name = S.clip(x && x.name, 200);
  const qty = Number(x && x.qty); const unit = Number(String((x && x.unitPrice) == null ? '' : x.unitPrice).replace(/[, ]/g, ''));
  const disc = Number((x && x.discountPercent) || 0);
  if (!name) return { error: `Line ${i + 1}: write what it is.` };
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6) return { error: `Line ${i + 1}: the quantity must be more than 0.` };
  if (!Number.isFinite(unit) || unit < 0 || unit > 1e11) return { error: `Line ${i + 1}: write the unit price in rupees.` };
  if (!Number.isFinite(disc) || disc < 0 || disc > 100) return { error: `Line ${i + 1}: the discount is 0 to 100 percent.` };
  const billing = BILLINGS.includes(x && x.billing) ? x.billing : 'One-time';
  return { line: { productKey: x.productKey ? String(x.productKey).toUpperCase().slice(0, 30) : null, plan: x.plan ? String(x.plan).slice(0, 60) : null, name, qty: Math.round(qty * 1000) / 1000, unitPrice: cents(unit), listPrice: x.listPrice == null || x.listPrice === '' ? null : cents(priceNum(x.listPrice)), discountPercent: Math.round(disc * 100) / 100, billing, bundle: x.bundle ? String(x.bundle).slice(0, 80) : null, rule: null } };
}
// Save the deal's lines (the whole list). The deal's value becomes their sum; a line discount over the approval limit sends the deal for approval.
async function saveLines(user, dealId, body = {}) {
  const x = await dealFor(user, dealId, { edit: true });
  if (x.err) return x.err;
  const { deal } = x;
  if (['Won', 'Lost'].includes(deal.stage)) return S.fail(400, 'A won or lost deal keeps its lines.');
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length > 40) return S.fail(400, 'At most 40 lines on a deal.');
  const clean = [];
  for (const [i, l] of raw.entries()) { const c = cleanLine(l, i); if (c.error) return S.fail(400, c.error); clean.push(c.line); }
  const applied = applyCpq(clean, await cpq());
  if (applied.error) return S.fail(400, applied.error);
  if (body.priceBookId !== undefined) {
    const pb = body.priceBookId ? (await priceBooks()).find((b) => b.id === body.priceBookId) : null;
    if (body.priceBookId && !pb) return S.fail(400, 'Pick a price book from the list.');
    await S.update('CrmDeal', deal.id, { priceBookId: pb ? pb.id : null });
  }
  await P.run('DELETE FROM "CrmDealLine" WHERE "dealId" = ?', deal.id);
  const now = new Date().toISOString();
  for (const [i, l] of applied.lines.entries()) {
    // eslint-disable-next-line no-await-in-loop
    await P.run('INSERT INTO "CrmDealLine" ("id", "dealId", "productKey", "plan", "name", "qty", "unitPrice", "listPrice", "discountPercent", "billing", "bundle", "rule", "sort", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', S.newId('dln'), deal.id, l.productKey, l.plan, l.name, l.qty, l.unitPrice, l.listPrice, l.discountPercent, l.billing, l.bundle, l.rule, i, now);
  }
  const value = cents(applied.lines.reduce((n, l) => n + lineNet(l), 0));
  if (applied.lines.length) {
    const out = await S.edit(user, 'deal', deal.id, { value, __fromLines: true });
    if (out.status !== 200) return out;
  }
  // a line discount above the CRM limit (bundle and volume rules excepted) needs the same manager approval as a deal discount
  const limit = SETTINGS.current().discountApprovalLimit;
  const overLine = applied.lines.find((l) => !l.bundle && !l.rule && l.discountPercent > limit);
  const fresh = await S.getRow('deal', deal.id);
  if (overLine && fresh.approvalStatus !== 'Pending' && fresh.approvalStatus !== 'Approved') await S.update('CrmDeal', deal.id, { approvalStatus: 'Pending', approvalByName: null, approvalAt: null, approvalNote: `Line discount ${overLine.discountPercent}% on ${overLine.name}` });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Product lines saved (${applied.lines.length}): ${value}`, note: applied.notes.join('; ') || null, at: now, dealId: deal.id, accountId: deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  const back = await lines(user, deal.id);
  return S.okBody({ ...back.body, ok: true, notes: applied.notes });
}
// Add a bundle's products to the deal at the bundle's discount (and the deal's price book prices).
async function addBundle(user, dealId, { bundleId } = {}) {
  const x = await dealFor(user, dealId, { edit: true });
  if (x.err) return x.err;
  const rules = await cpq();
  const b = rules.bundles.find((y) => y.id === bundleId);
  if (!b) return S.fail(400, 'Pick a bundle from the list.');
  const account = x.deal.accountId ? await S.getRow('account', x.deal.accountId) : null;
  const book = await bookFor(x.deal, account);
  const cat = await catalogue();
  const have = (await linesOf(x.deal.id)).map((l) => ({ ...l }));
  b.items.forEach((it) => {
    const c = cat.find((y) => y.productKey === it.productKey && y.plan === it.plan) || { name: `${it.productKey} - ${it.plan}`, listPrice: 0, billing: 'One-time' };
    const price = priceIn(book, it.productKey, it.plan) ?? c.listPrice;
    have.push({ productKey: it.productKey, plan: it.plan, name: c.name, qty: it.qty, unitPrice: price, listPrice: c.listPrice, discountPercent: b.discountPercent, billing: c.billing, bundle: b.name });
  });
  return saveLines(user, dealId, { lines: have });
}
// The lines of the invoice raised on Won: the deal's lines after their own discount and the deal discount, adding up to the invoice amount exactly.
async function invoiceLinesFor(deal, amount, st) {
  await P.ensure();
  const rows = await linesOf(deal.id);
  if (!rows.length) return null;
  const nets = rows.map(lineNet);
  const sum = nets.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const factor = amount / sum;
  const disc = Number(deal.discountPercent) || 0;
  const out = rows.map((l, i) => {
    const amt = cents(nets[i] * factor);
    return { description: `${l.name}${l.billing && l.billing !== 'One-time' ? ` (${l.billing.toLowerCase()})` : ''}${disc ? ` - after ${disc}% discount` : ''}`.slice(0, 300), sac: st.invoiceSac, qty: l.qty, rate: cents(amt / l.qty), amount: amt };
  });
  const diff = cents(amount - out.reduce((n, l) => n + l.amount, 0));
  if (Math.abs(diff) > 0) { const last = out[out.length - 1]; last.amount = cents(last.amount + diff); last.rate = cents(last.amount / last.qty); }
  // a rate rounded to paise may not multiply back to the amount: such a line is shown as 1 x the amount
  out.forEach((l) => { if (cents(l.rate * l.qty) !== l.amount) { l.description = `${l.description} (${l.qty} x)`.slice(0, 300); l.qty = 1; l.rate = l.amount; } });
  return out;
}

// ---- quote templates, versions and approval --------------------------------------------------------------------------
const BUILTIN = [
  { id: 'recruitment', name: 'Recruitment services proposal', kind: 'recruitment', builtIn: true, title: 'Recruitment Services Proposal', intro: '', terms: [], footer: '', accent: '#1b2a4a' },
  { id: 'quotation', name: 'Product quotation', kind: 'items', builtIn: true, title: 'Quotation', intro: 'Thank you for your interest. Please find our quotation below.', terms: ['Prices are in Indian Rupees.', 'GST is extra as shown.', 'Payment within 15 days of the invoice.'], footer: 'This quotation is valid for the days shown above.', accent: '#1b2a4a' },
];
function cleanTemplate(t) {
  return {
    id: String((t && t.id) || sid('qt')).replace(/[^a-z0-9_-]/gi, '').slice(0, 40), name: String((t && t.name) || '').trim().slice(0, 60), kind: (t && t.kind) === 'recruitment' ? 'recruitment' : 'items',
    title: String((t && t.title) || '').trim().slice(0, 80) || 'Quotation', intro: String((t && t.intro) || '').trim().slice(0, 1500),
    terms: (Array.isArray(t && t.terms) ? t.terms : String((t && t.terms) || '').split('\n')).map((x) => String(x || '').trim().slice(0, 300)).filter(Boolean).slice(0, 15),
    footer: String((t && t.footer) || '').trim().slice(0, 500), accent: /^#[0-9a-f]{6}$/i.test(String(t && t.accent)) ? t.accent : '#1b2a4a',
  };
}
function cleanApproval(a = {}) {
  const fee = Number(a.minFeePercent);
  return { mode: ['off', 'over-limit', 'all'].includes(a.mode) ? a.mode : 'over-limit', minFeePercent: Number.isFinite(fee) && fee >= 0 && fee <= 100 ? fee : 0 };
}
async function quoteSettings() {
  const v = await P.getCfg('quotes', {});
  const own = (Array.isArray(v.templates) ? v.templates : []).map(cleanTemplate).filter((t) => t.name && !BUILTIN.some((b) => b.id === t.id));
  const over = (v.builtInText || {}).quotation;
  const builtIns = BUILTIN.map((b) => (b.id === 'quotation' && over ? { ...b, ...cleanTemplate({ ...over, id: 'quotation', name: b.name, kind: 'items' }), builtIn: true } : b));
  return { templates: [...builtIns, ...own], approval: cleanApproval(v.approval) };
}
async function saveQuoteSettings(user, body = {}) {
  const no = managerOnly(user); if (no) return no;
  const list = Array.isArray(body.templates) ? body.templates : [];
  const quotation = list.find((t) => t && t.id === 'quotation');
  const own = list.filter((t) => t && !BUILTIN.some((b) => b.id === t.id)).map(cleanTemplate).filter((t) => t.name).slice(0, 20);
  const next = { templates: own, builtInText: quotation ? { quotation: cleanTemplate(quotation) } : {}, approval: cleanApproval(body.approval) };
  await P.setCfg('quotes', next);
  await S.audit(user, 'CRM quote templates changed', 'CrmSettings', 'quotes', `${own.length} own templates; approval ${next.approval.mode}`);
  return S.okBody({ ok: true, ...(await quoteSettings()) });
}
async function needsApproval(kind, data) {
  const { approval } = await quoteSettings();
  if (approval.mode === 'off') return false;
  if (approval.mode === 'all') return true;
  if (kind === 'recruitment') return approval.minFeePercent > 0 && Number(data.feePercent) < approval.minFeePercent;
  const limit = SETTINGS.current().discountApprovalLimit;
  const lineMax = Math.max(0, ...(data.lines || []).filter((l) => !l.bundle && !l.rule).map((l) => Number(l.discountPercent) || 0));
  return (Number(data.discountPercent) || 0) > limit || lineMax > limit;
}
async function nextProposalNumber() {
  const ym = S.istToday().slice(2, 7).replace('-', '');
  const n = (await P.one('SELECT COUNT(*) AS "n" FROM "CrmProposal" WHERE "number" LIKE ?', `TLP-${ym}-%`)).n + 1;
  return `TLP-${ym}-${String(n).padStart(3, '0')}`;
}
async function nextVersion(dealId) { const v = await P.one('SELECT MAX("version") AS "v", COUNT(*) AS "n" FROM "CrmProposal" WHERE "dealId" = ?', dealId); return Math.max(Number(v && v.v) || 0, 0) + 1; }
// crm/extra.js createProposal asks this first: a product quotation template is made here (null = the built-in recruitment proposal goes on as before)
async function createQuote(user, deal, body = {}) {
  await P.ensure();
  const { templates } = await quoteSettings();
  const tpl = templates.find((t) => t.id === body.templateId);
  if (!tpl || tpl.kind !== 'items') return null;
  const dealLines = await linesOf(deal.id);
  const src = Array.isArray(body.lines) && body.lines.length ? body.lines : dealLines;
  const clean = [];
  for (const [i, l] of src.entries()) { const c = cleanLine(l, i); if (c.error) return S.fail(400, c.error); clean.push({ ...c.line, bundle: l.bundle || null, rule: l.rule || null }); }
  if (!clean.length) return S.fail(400, 'Add product lines to the deal first (Products tab), or write the lines of the quote.');
  const gstPercent = Math.min(50, Math.max(0, Number(body.gstPercent == null || body.gstPercent === '' ? SETTINGS.current().invoiceTaxPercent : body.gstPercent) || 0));
  const subtotal = cents(clean.reduce((n, l) => n + lineNet(l), 0));
  const discountPercent = Math.min(100, Math.max(0, Number(body.discountPercent == null || body.discountPercent === '' ? deal.discountPercent : body.discountPercent) || 0));
  const discountAmount = cents((subtotal * discountPercent) / 100);
  const net = cents(subtotal - discountAmount);
  const gst = cents((net * gstPercent) / 100);
  const toEmail = S.clip(body.toEmail, 200);
  if (toEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) return S.fail(400, 'The client\'s email does not look right.');
  const validity = Math.min(365, Math.max(1, Math.round(Number(body.validityDays) || SETTINGS.current().proposalValidityDays)));
  const data = { templateId: tpl.id, lines: clean.map((l) => ({ ...l, net: lineNet(l) })), subtotal, discountPercent, discountAmount, net, gstPercent, gst, total: cents(net + gst), validityDays: validity, company: S.clip(body.company, 200), toName: S.clip(body.toName, 120), toEmail, fromName: S.clip(body.fromName, 120) || user.name || '', fromEmail: S.clip(body.fromEmail, 200), fromPhone: S.clip(body.fromPhone, 40), notes: S.clip(body.notes, 3000) };
  const now = new Date().toISOString();
  const pending = await needsApproval('items', data);
  const p = await S.insert('CrmProposal', { id: S.newId('prop'), number: await nextProposalNumber(), dealId: deal.id, accountId: deal.accountId, dataJson: JSON.stringify(data), status: 'Draft', createdById: user.id, createdByName: user.name || null, createdAt: now, updatedAt: now, templateId: tpl.id, version: await nextVersion(deal.id), revisionOf: S.clip(body.revisionOf, 60), approvalStatus: pending ? 'Pending' : 'None', discountPercent, totalAmount: data.total });
  await S.audit(user, 'CRM quote made', 'CrmProposal', p.id, `${p.number} v${p.version} (${tpl.name}) for ${deal.title}: ${data.total}${pending ? ' - waits for approval' : ''}`);
  return S.okBody({ ok: true, proposal: p });
}
// crm/extra.js createProposal calls this after a recruitment proposal is saved: its version, its template and whether it waits for approval
async function afterProposal(p, deal, body = {}) {
  await P.ensure();
  const data = P.parse(p.dataJson, {});
  const pending = await needsApproval('recruitment', data);
  const n = await P.one('SELECT COUNT(*) AS "n" FROM "CrmProposal" WHERE "dealId" = ?', deal.id); // this proposal is already in the table
  return S.update('CrmProposal', p.id, { templateId: 'recruitment', version: Number(n && n.n) || 1, revisionOf: S.clip(body.revisionOf, 60), approvalStatus: pending ? 'Pending' : 'None' });
}
// crm/extra.js sendProposal asks this before the email goes: a quote waiting for (or refused) approval is not sent
async function sendBlock(p) {
  await P.ensure();
  const row = await P.one('SELECT "approvalStatus" FROM "CrmProposal" WHERE "id" = ?', p.id);
  const st = row && row.approvalStatus;
  if (st === 'Pending') return S.fail(409, 'This quote waits for a Sales manager\'s approval. It can be emailed once it is approved.');
  if (st === 'Rejected') return S.fail(409, 'A Sales manager rejected this quote. Revise it (a new version) and send that one.');
  if (p.status === 'Replaced') return S.fail(409, 'A newer version of this quote was made. Send the newest one.');
  return null;
}
async function quotesOfDeal(user, dealId) {
  const x = await dealFor(user, dealId);
  if (x.err) return x.err;
  await P.ensure();
  const rows = await P.all('SELECT "id", "number", "status", "sentAt", "sentTo", "createdAt", "createdByName", "templateId", "version", "revisionOf", "approvalStatus", "approvalByName", "approvalAt", "approvalNote", "discountPercent", "totalAmount", "dataJson" FROM "CrmProposal" WHERE "dealId" = ? ORDER BY "createdAt" DESC', x.deal.id);
  const { templates } = await quoteSettings();
  return S.okBody({
    quotes: rows.map(({ dataJson, ...q }) => { const d = P.parse(dataJson, {}); return { ...q, templateName: (templates.find((t) => t.id === (q.templateId || 'recruitment')) || {}).name || 'Recruitment services proposal', total: q.totalAmount != null ? q.totalAmount : null, lines: (d.lines || []).length, feePercent: d.feePercent }; }),
    templates: templates.map((t) => ({ id: t.id, name: t.name, kind: t.kind })), canEdit: S.canEditRow(user, x.r, x.deal), canApprove: S.mayAssign(x.r),
  });
}
async function decideQuote(user, id, { decision, note } = {}) {
  const r = S.roleOf(user);
  const p = await P.one('SELECT * FROM "CrmProposal" WHERE "id" = ?', S.clip(id, 60));
  const deal = p ? await S.getRow('deal', p.dealId) : null;
  if (!p || !S.canSeeRow(user, r, deal)) return S.fail(404, 'This quote is not there.');
  if (!S.mayAssign(r)) return S.fail(403, 'Only a Sales manager or an Admin approves a quote.');
  if (!['approve', 'reject'].includes(decision)) return S.fail(400, 'Approve or reject the quote?');
  if (p.approvalStatus !== 'Pending') return S.fail(400, 'This quote is not waiting for approval.');
  const now = new Date().toISOString();
  const status = decision === 'approve' ? 'Approved' : 'Rejected';
  await S.update('CrmProposal', p.id, { approvalStatus: status, approvalByName: user.name || null, approvalAt: now, approvalNote: S.clip(note, 300), updatedAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `Quote ${p.number} ${status.toLowerCase()}`, note: S.clip(note, 300), at: now, dealId: deal.id, accountId: deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, `CRM quote ${status.toLowerCase()}`, 'CrmProposal', p.id, `${p.number}`, S.clip(note, 300) || undefined);
  return S.okBody({ ok: true, approvalStatus: status });
}
// Revise: the next version of a quote (same template; a product quotation takes the deal's lines as they are now). The old one is "Replaced" unless it was answered.
async function reviseQuote(user, id) {
  const r = S.roleOf(user);
  const p = await P.one('SELECT * FROM "CrmProposal" WHERE "id" = ?', S.clip(id, 60));
  const deal = p ? await S.getRow('deal', p.dealId) : null;
  if (!p || !S.canEditRow(user, r, deal)) return S.fail(404, 'This quote is not there, or it is not yours.');
  const data = P.parse(p.dataJson, {});
  let out;
  if ((p.templateId || 'recruitment') === 'recruitment') {
    const X = require('./extra'); // eslint-disable-line global-require
    out = await X.createProposal(user, deal.id, { ...data, revisionOf: p.id });
  } else {
    out = await createQuote(user, deal, { ...data, templateId: p.templateId, lines: undefined, revisionOf: p.id });
    if (out && out.status !== 200 && data.lines) out = await createQuote(user, deal, { ...data, templateId: p.templateId, revisionOf: p.id });
  }
  if (!out || out.status !== 200) return out || S.fail(400, 'The quote could not be revised.');
  if (!['Accepted', 'Declined'].includes(p.status)) await S.update('CrmProposal', p.id, { status: 'Replaced', updatedAt: new Date().toISOString() });
  return out;
}
// crm/extra.js proposalPdf asks this first: a product quotation (or a template of the Admin's) is drawn here; null = the built-in recruitment layout
async function quotePdf(x) {
  const { p, data: d } = x;
  if (!d || !d.templateId || d.templateId === 'recruitment' || !Array.isArray(d.lines)) return null;
  const { templates } = await quoteSettings();
  const tpl = templates.find((t) => t.id === d.templateId) || BUILTIN[1];
  const PDFDocument = require('pdfkit'); // eslint-disable-line global-require
  const { LOGO } = require('../utils/agreementPdf'); // eslint-disable-line global-require
  const fs = require('fs'); // eslint-disable-line global-require
  const inr = (v) => `Rs. ${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const validTill = new Date(Date.parse(p.createdAt) + (d.validityDays || 30) * 86400000).toISOString();
  const from = SETTINGS.current().invoiceFrom || {};
  const buf = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${tpl.title} ${p.number}`, Author: from.name || 'TeamLink' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 100; const ACC = tpl.accent || '#1b2a4a'; const MUTED = '#5b6474';
    if (fs.existsSync(LOGO)) { try { doc.image(LOGO, 50, 40, { height: 28 }); } catch { /* optional */ } }
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${tpl.title} ${p.number}${p.version ? ` (version ${p.version})` : ''}`, 50, 44, { width: W, align: 'right' }).text(date(p.createdAt), { width: W, align: 'right' });
    doc.moveDown(2.2);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(ACC).text(tpl.title, 50);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222').text(`To: ${[d.toName, d.company].filter(Boolean).join(', ') || '-'}`).text(`From: ${[d.fromName, from.name].filter(Boolean).join(', ')}`);
    if (tpl.intro) { doc.moveDown(0.7); doc.text(tpl.intro, { width: W }); }
    doc.moveDown(0.9);
    const cols = [50, 280, 330, 410, 460]; let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('Item', cols[0], y).text('Qty', cols[1], y).text('Unit price', cols[2], y).text('Disc.', cols[3], y).text('Amount', cols[4], y, { width: 50 + W - cols[4], align: 'right' });
    y += 15; doc.moveTo(50, y - 3).lineTo(50 + W, y - 3).strokeColor('#d9dee8').stroke();
    doc.font('Helvetica').fontSize(9.5).fillColor('#222');
    d.lines.forEach((l) => {
      if (y > doc.page.height - 160) { doc.addPage(); y = 60; }
      doc.text(`${l.name}${l.billing && l.billing !== 'One-time' ? ` (${l.billing.toLowerCase()})` : ''}`, cols[0], y, { width: 225 }).text(String(l.qty), cols[1], y).text(inr(l.unitPrice), cols[2], y).text(l.discountPercent ? `${l.discountPercent}%` : '-', cols[3], y).text(inr(l.net), cols[4], y, { width: 50 + W - cols[4], align: 'right' });
      y = Math.max(doc.y, y + 13) + 4;
    });
    y += 4; doc.moveTo(300, y).lineTo(50 + W, y).strokeColor('#d9dee8').stroke(); y += 6;
    const tot = (k, v, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#222').text(k, 300, y).text(v, cols[4] - 40, y, { width: 90 + W - cols[4], align: 'right' }); y += 15; };
    tot('Subtotal', inr(d.subtotal));
    if (d.discountPercent) tot(`Discount ${d.discountPercent}%`, `- ${inr(d.discountAmount)}`);
    tot(`GST ${d.gstPercent}%`, inr(d.gst));
    tot('Total', inr(d.total), true);
    doc.y = y + 10; doc.x = 50;
    if (tpl.terms && tpl.terms.length) {
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(ACC).text('Terms', 50); doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).fillColor('#222');
      tpl.terms.forEach((t) => { doc.text(`•  ${t}`, 60, doc.y, { width: W - 10 }); doc.moveDown(0.2); });
    }
    if (d.notes) { doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(11.5).fillColor(ACC).text('Notes', 50); doc.moveDown(0.3); doc.font('Helvetica').fontSize(10).fillColor('#222').text(d.notes, { width: W }); }
    doc.moveDown(0.9);
    doc.font('Helvetica').fontSize(10).fillColor('#222').text(`Valid until ${date(validTill)}.${tpl.footer ? ` ${tpl.footer}` : ''}`, 50, doc.y, { width: W });
    doc.moveDown(1.4);
    doc.text(`For ${from.name || 'TeamLink'}`, 50); doc.moveDown(0.3);
    doc.font('Helvetica-Bold').text(d.fromName || '');
    doc.font('Helvetica').fillColor(MUTED).text([d.fromEmail, d.fromPhone].filter(Boolean).join('  ·  '));
    doc.end();
  });
  return { status: 200, pdf: buf, name: `${p.number}${p.version > 1 ? `-v${p.version}` : ''}.pdf` };
}

// ---- sales orders and contracts ---------------------------------------------------------------------------------------
const CONTRACT_KINDS = ['Sales order', 'Contract'];
const CONTRACT_STATUSES = ['Draft', 'Active', 'Expired', 'Renewed', 'Cancelled'];
async function nextContractCode(kind) {
  const seq = await P.getCfg('seq', {});
  const k = kind === 'Sales order' ? 'so' : 'ct';
  const n = (Number(seq[k]) || 0) + 1;
  await P.setCfg('seq', { ...seq, [k]: n });
  return `${kind === 'Sales order' ? 'SO' : 'CT'}-${String(n).padStart(4, '0')}`;
}
const contractOut = (c) => ({ ...c, lines: P.parse(c.linesJson, []), linesJson: undefined, shownStatus: c.status === 'Active' && c.endDate && c.endDate < S.istToday() ? 'Expired' : c.status, renewalSoon: c.status === 'Active' && c.renewalDate && c.renewalDate >= S.istToday() && Date.parse(c.renewalDate) - Date.now() < 45 * 86400000 });
function cleanContract(body, { partial } = {}) {
  const out = {};
  const d = (k) => { if (!(k in body)) return null; const v = S.clip(body[k], 10); if (v && (!YMD.test(v) || Number.isNaN(Date.parse(v)))) return `Pick a proper date for ${k.replace(/Date$/, ' date').replace('signedOn', 'signed on')}.`; out[k] = v; return null; };
  for (const k of ['startDate', 'endDate', 'renewalDate', 'signedOn']) { const e = d(k); if (e) return { error: e }; }
  if ('kind' in body) { if (!CONTRACT_KINDS.includes(body.kind)) return { error: 'Sales order or contract?' }; out.kind = body.kind; }
  if ('status' in body) { if (!CONTRACT_STATUSES.includes(body.status)) return { error: 'Pick a status from the list.' }; out.status = body.status; }
  if ('title' in body) out.title = S.clip(body.title, 200);
  if ('terms' in body) out.terms = S.clip(body.terms, 4000);
  if ('poNumber' in body) out.poNumber = S.clip(body.poNumber, 60);
  if ('billing' in body) out.billing = BILLINGS.includes(body.billing) ? body.billing : null;
  if ('value' in body) { const v = S.num(body.value); if (v == null) return { error: 'Write the value in rupees.' }; out.value = cents(v); }
  if (!partial && !out.title) return { error: 'Give it a title.' };
  if (out.startDate && out.endDate && out.endDate < out.startDate) return { error: 'The end date is after the start date.' };
  return { data: out };
}
async function renewalTask(user, c, remindDays) {
  if (!c.renewalDate || c.status !== 'Active') return null;
  const due = new Date(Date.parse(`${c.renewalDate}T00:00:00Z`) - Math.max(0, remindDays) * 86400000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const id = S.newId('task');
  await S.insert('CrmTask', { id, title: `Renewal: ${c.code} ${c.title} renews on ${c.renewalDate}`.slice(0, 200), dueDate: due < S.istToday() ? S.istToday() : due, status: 'Open', dealId: c.dealId, accountId: c.accountId, ownerId: c.ownerId, ownerName: c.ownerName, createdById: user.id, createdAt: now, updatedAt: now, type: 'Call', priority: 'High', origin: 'contract-renewal' });
  return id;
}
async function createContract(user, dealId, body = {}) {
  const x = await dealFor(user, dealId, { edit: true });
  if (x.err) return x.err;
  const { deal } = x;
  const c = cleanContract({ title: deal.title, value: deal.finalValue != null ? deal.finalValue : deal.value, kind: 'Contract', status: 'Draft', ...body });
  if (c.error) return S.fail(400, c.error);
  const account = deal.accountId ? await S.getRow('account', deal.accountId) : null;
  const dl = await linesOf(deal.id);
  const now = new Date().toISOString();
  const row = { id: S.newId('ctr'), code: await nextContractCode(c.data.kind), kind: c.data.kind, dealId: deal.id, accountId: deal.accountId, accountName: account ? account.name : null, title: c.data.title, startDate: c.data.startDate || null, endDate: c.data.endDate || null, renewalDate: c.data.renewalDate || c.data.endDate || null, value: c.data.value, billing: c.data.billing || deal.billing || null, status: c.data.status || 'Draft', terms: c.data.terms || null, linesJson: JSON.stringify(dl.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, discountPercent: l.discountPercent, billing: l.billing, net: lineNet(l) }))), signedOn: c.data.signedOn || null, poNumber: c.data.poNumber || null, ownerId: deal.ownerId, ownerName: deal.ownerName, createdById: user.id, createdAt: now, updatedAt: now, createdByName: user.name || null };
  await S.insert('CrmContract', row);
  const taskId = await renewalTask(user, row, Number(body.remindDays) >= 0 && body.remindDays !== '' && body.remindDays != null ? Number(body.remindDays) : 30);
  if (taskId) await S.update('CrmContract', row.id, { renewalTaskId: taskId });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `${row.kind} ${row.code} made (${row.status})`, note: row.renewalDate ? `Renews on ${row.renewalDate}` : null, at: now, dealId: deal.id, accountId: deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, `CRM ${row.kind.toLowerCase()} made`, 'CrmContract', row.id, `${row.code}: ${row.title} ${row.value}`);
  return S.okBody({ ok: true, contract: contractOut(await S.getRow('CrmContract', row.id)) });
}
async function updateContract(user, id, body = {}) {
  const r = S.roleOf(user);
  const row = await P.one('SELECT * FROM "CrmContract" WHERE "id" = ?', S.clip(id, 60));
  if (!row || !S.canSeeRow(user, r, row)) return S.fail(404, 'This contract is not there.');
  if (!S.canEditRow(user, r, row)) return S.fail(403, 'You can read this contract but not change it.');
  const c = cleanContract(body, { partial: true });
  if (c.error) return S.fail(400, c.error);
  const data = { ...c.data, updatedAt: new Date().toISOString() };
  const saved = await S.update('CrmContract', row.id, data);
  if ((data.status === 'Active' && row.status !== 'Active') || (data.renewalDate && data.renewalDate !== row.renewalDate && saved.status === 'Active')) {
    if (row.renewalTaskId) await P.run('UPDATE "CrmTask" SET "status" = \'Cancelled\', "updatedAt" = ? WHERE "id" = ? AND "status" = \'Open\'', data.updatedAt, row.renewalTaskId);
    const taskId = await renewalTask(user, saved, 30);
    if (taskId) await S.update('CrmContract', row.id, { renewalTaskId: taskId });
  }
  await S.audit(user, 'CRM contract changed', 'CrmContract', row.id, `${row.code}: ${Object.keys(c.data).join(', ')}`);
  return S.okBody({ ok: true, contract: contractOut(await S.getRow('CrmContract', row.id)) });
}
async function contracts(user, { dealId, status } = {}) {
  const r = S.roleOf(user);
  const sc = S.scopeSql(user, r, 'x.');
  await P.ensure();
  const where = [sc.sql]; const params = [...sc.params];
  if (dealId) { where.push('x."dealId" = ?'); params.push(S.clip(dealId, 60)); }
  if (status && CONTRACT_STATUSES.includes(status)) { where.push('x."status" = ?'); params.push(status); }
  const rows = (await P.all(`SELECT x.* FROM "CrmContract" x WHERE ${where.join(' AND ')} ORDER BY x."createdAt" DESC LIMIT 1000`, ...params)).map(contractOut);
  return S.okBody({ contracts: rows, kinds: CONTRACT_KINDS, statuses: CONTRACT_STATUSES, canEdit: S.mayEdit(r) });
}

// ---- CRM invoices as a Tally XML / Zoho Books CSV (a file to download; nothing is posted to Accounts) ----------------------
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
async function exportInvoices(user, { format, from, to } = {}) {
  const r = S.roleOf(user);
  if (!S.can(user, 'export')) return S.fail(403, 'Your CRM rights do not allow downloading. Ask a Sales manager.');
  if (!['tally', 'zoho'].includes(format)) return S.fail(400, 'Pick Tally or Zoho Books.');
  const sc = S.scopeSql(user, r, 'x.');
  const where = [sc.sql, 'x."status" != \'Cancelled\'', 'x."status" != \'Draft\'']; const params = [...sc.params];
  if (YMD.test(String(from || ''))) { where.push('x."issueDate" >= ?'); params.push(from); }
  if (YMD.test(String(to || ''))) { where.push('x."issueDate" <= ?'); params.push(to); }
  const rows = (await P.all(`SELECT x.* FROM "CrmInvoice" x WHERE ${where.join(' AND ')} ORDER BY x."issueDate", x."code" LIMIT 5000`, ...params)).map(S.invoiceOut);
  const day = S.istToday();
  let body; let name; let type;
  if (format === 'tally') {
    const v = rows.map((inv) => {
      const ymd = String(inv.issueDate || '').replace(/-/g, '');
      const party = xmlEsc(inv.accountName || (inv.billTo && inv.billTo.name) || 'Customer');
      const g = inv.gst || {};
      const taxLines = (g.mode === 'intra' ? [['CGST', g.cgst], ['SGST', g.sgst]] : [['IGST', g.igst != null ? g.igst : inv.taxAmount]]).filter(([, a]) => Number(a) > 0)
        .map(([k, a]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${k}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${cents(a).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('');
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>${ymd}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlEsc(inv.code || inv.id)}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME><NARRATION>${xmlEsc(`${inv.title || ''} (CRM ${inv.code || ''})`)}</NARRATION>`
        + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${party}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${cents(inv.total).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
        + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales - CRM</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${cents(inv.amount).toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>${taxLines}</VOUCHER></TALLYMESSAGE>`;
    }).join('\n');
    body = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>\n${v}\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
    name = `crm-invoices-tally-${day}.xml`; type = 'application/xml';
  } else {
    const esc = (x) => `"${String(x == null ? '' : x).replace(/"/g, '""')}"`;
    const head = ['Invoice Number', 'Invoice Date', 'Due Date', 'Customer Name', 'GST Identification Number (GSTIN)', 'Place of Supply', 'Item Name', 'SAC', 'Quantity', 'Item Price', 'Item Tax %', 'Invoice Status', 'Notes'];
    const lines = [];
    rows.forEach((inv) => (inv.lines || []).forEach((l) => lines.push([inv.code || inv.id, inv.issueDate, inv.dueDate || '', inv.accountName || (inv.billTo && inv.billTo.name) || '', (inv.billTo && inv.billTo.gstin) || '', (inv.gst && inv.gst.placeOfSupply && inv.gst.placeOfSupply.name) || (inv.billTo && inv.billTo.state) || '', l.description, l.sac || '', l.qty, l.rate, inv.taxPercent, inv.status, `CRM ${inv.code || ''}`])));
    body = `﻿${[head.map(esc).join(','), ...lines.map((x) => x.map(esc).join(','))].join('\r\n')}`;
    name = `crm-invoices-zoho-books-${day}.csv`; type = 'text/csv; charset=utf-8';
  }
  await S.audit(user, 'CRM invoices downloaded for the books', 'CrmInvoice', format, `${rows.length} invoices`);
  await require('./analytics').logExport(user, `Invoices for ${format === 'tally' ? 'Tally' : 'Zoho Books'}`, format === 'tally' ? 'xml' : 'csv', rows.length).catch(() => {}); // eslint-disable-line global-require
  return { status: 200, file: body, name, type, rows: rows.length };
}

module.exports = {
  catalogue, priceBooks, savePriceBooks, bookFor, cpq, saveCpq, applyCpq, lines, saveLines, addBundle, invoiceLinesFor, linesOf, lineNet,
  quoteSettings, saveQuoteSettings, createQuote, afterProposal, sendBlock, quotesOfDeal, decideQuote, reviseQuote, quotePdf,
  createContract, updateContract, contracts, exportInvoices, CONTRACT_KINDS, CONTRACT_STATUSES,
};
