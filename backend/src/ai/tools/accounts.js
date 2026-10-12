// Accounts tools: expenses, invoices, payments, customer (client billing) details,
// and recruiter incentive decisions. Every one replays the app's own route:
//   POST /api/office-expenses     POST /api/invoices      PATCH /api/invoices/:id[/cancel]
//   POST /api/invoices/:id/payments    PUT /api/clients/:id
//   POST /api/recruiter-joinings/decisions
const { defineTool } = require('../registry');
const T = require('../lib/tooling');
const entities = require('../lib/entities');
const { problemOf } = require('../lib/http');
const { niceDate, addDays, ymd } = require('../lib/dates');
const { scopeOf } = require('../../utils/scope');
const S = require('./_shared');
const F = require('./_fields');

const same = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
const rs = T.rupees;

// The amount the user typed: Rs / k / lakh forms, "of 1500", "amount 1500", else the last plain number.
function amountFrom(input) {
  if (input.slots.amount != null) return input.slots.amount;
  const t = String(input.text || '');
  const m = t.match(/\b(?:amount|of|for|rs\.?|inr|payment|received|paid)\s*:?\s*([\d,]+(?:\.\d+)?)\b/i);
  if (m) return Number(m[1].replace(/,/g, ''));
  const nums = (input.slots.numbers || []).filter((n) => n > 0);
  return nums.length ? nums[nums.length - 1] : null;
}

function invoiceNumberFrom(input) {
  const t = String(input.text || '');
  const m = t.match(/\b(?:invoice|inv)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Za-z]{0,4}-?\d{2,8})\b/i);
  if (m) return m[1].replace(/^INV-?/i, '');
  const code = (input.slots.codes || []).find((c) => /^INV/i.test(c));
  return code ? code.replace(/^INV-?/i, '') : null;
}

async function pickInvoice(ctx, input, { question = 'Which invoice? Give its number.', status = null } = {}) {
  if (input.choices && input.choices.invoice) {
    const inv = await entities.invoiceById(ctx.user, input.choices.invoice);
    return inv ? { one: inv } : { ret: T.refuse('I cannot find that invoice in your list any more.') };
  }
  const number = invoiceNumberFrom(input);
  let res;
  if (number) res = await entities.findInvoices(ctx.user, { number });
  else {
    const spans = T.nameSpans(input);
    if (!spans.length) return { ret: T.clarify(question, { need: 'invoice' }) };
    const hit = await F.locate(spans, (s) => entities.findInvoices(ctx.user, { text: s }));
    res = hit ? hit.res : { rows: [] };
  }
  let rows = res.rows;
  if (status) rows = rows.filter((r) => status.includes(r.status));
  if (!rows.length) return { ret: T.refuse(number ? `I cannot find invoice ${number} in your list.` : 'I cannot find a matching invoice in your list.') };
  if (rows.length === 1) return { one: rows[0] };
  return { ret: T.which(`I found ${rows.length} invoices that fit. Which one?`, rows, 'invoice') };
}

// ----------------------------------------------------------------------------
// create_expense
// ----------------------------------------------------------------------------
const CATEGORY_WORDS = [
  [/cab|taxi|fuel|petrol|diesel|travel|flight|train|bus|auto|toll|parking/i, ['Travel']],
  [/food|lunch|dinner|tea|coffee|snack|refreshment|pantry|biscuit/i, ['Food & Refreshments']],
  [/internet|broadband|wifi|wi-fi|data card/i, ['Internet', 'Internet & Telecom']],
  [/stationery|pen|paper|notebook|file folder|print/i, ['Stationery', 'Office Supplies']],
  [/rent/i, ['Office Rent', 'Rent']],
  [/electric|power bill|eb bill/i, ['Electricity']],
  [/repair|maintenance|plumber|electrician|cleaning/i, ['Maintenance']],
  [/market|advert|ads\b|campaign|banner/i, ['Marketing']],
  [/software|subscription|license|licence|saas/i, ['Software / Subscription', 'Software Subscriptions']],
  [/courier|postage|misc|other/i, ['Miscellaneous']],
  [/supplies|supply/i, ['Office Supplies']],
];

defineTool({
  name: 'create_expense',
  module: 'accounts',
  label: 'Record an office expense',
  description: 'Record an office expense (it starts as Pending approval).',
  parameters: {
    category: { type: 'enum', required: true, description: 'One of the company expense categories.' },
    amount: { type: 'money', required: true, description: 'Bill amount before GST.' },
    date: { type: 'date', required: false, description: 'Bill date (today if not said).' },
    vendor: { type: 'text', required: false, description: 'Who was paid.' },
    description: { type: 'text', required: false, description: 'What it was for.' },
  },
  permission: { product: 'accounts', module: 'accounts', feature: 'Office & Expenses', action: 'edit' },
  confirm: 'default',
  examples: ['Add an expense of 1500 for cab fare', 'Record office expense 2500 for stationery from Staples'],
  async validate(ctx, input) {
    const amount = amountFrom(input);
    if (!(amount > 0)) return T.clarify('How much was the expense (before GST)?', { need: 'amount' });
    if (amount > 10000000) return T.refuse('That amount looks too large. Please check it.');
    const date = (input.slots.dates || [])[0] || ctx.today;
    if (date > ctx.today) return T.refuse('An expense cannot be dated in the future.');
    const cr = await ctx.read.get('/office-expenses/categories');
    if (!cr.ok) return T.refuse(problemOf(cr, 'You cannot see the expense categories.'));
    const cats = (cr.data || []).filter((c) => c.isActive !== false).map((c) => c.name);
    const low = input.text.toLowerCase();
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let category = (input.choices && input.choices.category)
      || cats.find((c) => c.length >= 3 && new RegExp(`(^|[^a-z0-9])${esc(c.toLowerCase())}($|[^a-z0-9])`).test(low)) || null;
    if (!category) {
      for (const [re, names] of CATEGORY_WORDS) {
        if (re.test(low)) { category = names.find((n) => cats.includes(n)) || null; if (category) break; }
      }
    }
    if (!category || !cats.includes(category)) {
      return T.clarify('Which category is this expense?', { need: 'category', options: cats.filter((c) => !/zztest/i.test(c)).slice(0, 8).map((c) => ({ label: c, choice: { category: c } })) });
    }
    const forM = input.text.match(/\bfor\s+([a-z][\w &'/-]{2,50}?)(?=\s+(?:from|at|on|dated|yesterday|today|tomorrow|paid)\b|[,.]|$)/i);
    const description = forM ? S.CLEAN(forM[1]) : '';
    const vendorSpan = (input.slots.spans || []).find((s) => ['from', 'at', 'to', 'vendor'].includes(s.prev));
    const vendor = vendorSpan ? vendorSpan.text : '';
    return T.done({
      params: { category, baseAmount: amount, expenseDate: date, ...(vendor ? { vendor } : {}), ...(description ? { description } : {}) },
      summary: `Record an expense of ${rs(amount)} under ${category}${vendor ? ` (${vendor})` : ''} dated ${niceDate(date)}.`,
      display: T.card('Record Expense', [['Category', category], ['Amount (before GST)', rs(amount)], ['Date', niceDate(date)], ['Vendor', vendor], ['For', description]],
        'It starts as Pending approval - I cannot approve it.'),
    });
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/office-expenses', { ...p, notes: 'Recorded by the AI Agent at the user\'s request' });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Expense of ${rs(p.baseAmount)} recorded${r.data.expenseCode ? ` (${r.data.expenseCode})` : ''}, waiting for approval.`, data: { id: r.data.id, code: r.data.expenseCode } };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    if (!id) return { ok: false, message: 'The app did not give the expense an id.' };
    const r = await ctx.read.get(`/office-expenses/${encodeURIComponent(id)}`);
    const d = r.ok && r.data;
    const ok = !!d && same(d.category, p.category) && Math.abs(Number(d.monthlyAmount || 0) - p.baseAmount) < 1;
    return { ok, message: ok ? 'The expense is on the register.' : 'I could not match the saved expense to what was asked.', evidence: { id } };
  },
  audit: (p) => `Recorded expense ${p.baseAmount} ${p.category}`,
});

// ----------------------------------------------------------------------------
// create_invoice / update_invoice / cancel_invoice / record_payment
// ----------------------------------------------------------------------------
function percentsFrom(text) {
  const t = String(text || '');
  const g = t.match(/\bgst\D{0,12}(\d{1,2}(?:\.\d+)?)\s*(?:%|percent|per cent)?/i);
  const d = t.match(/\btds\D{0,12}(\d{1,2}(?:\.\d+)?)\s*(?:%|percent|per cent)?/i);
  return { gstPercent: g ? Number(g[1]) : null, tdsPercent: d ? Number(d[1]) : null };
}

defineTool({
  name: 'create_invoice',
  module: 'accounts',
  label: 'Create an invoice',
  description: 'Create an invoice for a client: amount before GST, date, optional GST / TDS percent.',
  parameters: {
    client: { type: 'client', required: true, description: 'The client.' },
    amount: { type: 'money', required: true, description: 'Amount before GST.' },
    invoiceDate: { type: 'date', required: false, description: 'Invoice date (today if not said).' },
    gstPercent: { type: 'percent', required: false, description: 'GST % (the client\'s agreed rate if not said).' },
    tdsPercent: { type: 'percent', required: false, description: 'TDS %.' },
  },
  permission: { product: 'accounts', module: 'accounts', feature: 'Invoices', action: 'create' },
  confirm: 'default',
  examples: ['Create an invoice for Acme of 100000', 'Raise invoice for Sunrise Pharma amount 50000'],
  async validate(ctx, input) {
    const c = await S.pickClient(ctx, input, { text: undefined, question: 'Which client is the invoice for?' });
    if (c.ret) return c.ret;
    const client = c.one;
    const amount = amountFrom(input);
    if (!(amount > 0)) return T.clarify(`What is the invoice amount for ${client.name} (before GST)?`, { need: 'amount' });
    const invoiceDate = (input.slots.dates || [])[0] || ctx.today;
    const { gstPercent, tdsPercent } = percentsFrom(input.text);
    const dueM = input.text.match(/\bdue\s+in\s+(\d{1,3})\s+days?\b/i);
    const dueDate = dueM ? ymd(addDays(new Date(`${invoiceDate}T00:00:00`), Number(dueM[1]))) : null;
    return T.done({
      params: { clientId: client.id, clientName: client.name, amount, invoiceDate, ...(gstPercent != null ? { gstPercent } : {}), ...(tdsPercent != null ? { tdsPercent } : {}), ...(dueDate ? { dueDate } : {}) },
      summary: `Create an invoice for ${client.name} of ${rs(amount)} before GST, dated ${niceDate(invoiceDate)}.`,
      display: T.card('Create Invoice', [
        ['Client', client.name], ['Amount before GST', rs(amount)], ['Date', niceDate(invoiceDate)], ['GST', gstPercent != null ? `${gstPercent}%` : 'as in the client\'s agreement'],
        ['TDS', tdsPercent != null ? `${tdsPercent}%` : 'as in the client\'s agreement'], ['Due', dueDate ? niceDate(dueDate) : 'from the payment terms'],
      ]),
    });
  },
  async rules(ctx, p) {
    const c = await entities.clientById(ctx.user, p.clientId);
    return c ? { ok: true } : { ok: false, message: 'I cannot find that client in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/invoices', {
      clientId: p.clientId, amount: p.amount, invoiceDate: p.invoiceDate, ...(p.gstPercent != null ? { gstPercent: p.gstPercent } : {}), ...(p.tdsPercent != null ? { tdsPercent: p.tdsPercent } : {}), ...(p.dueDate ? { dueDate: p.dueDate } : {}), notes: 'Created by the AI Agent at the user\'s request',
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Invoice ${r.data.invoiceNumber || ''} created for ${p.clientName}.`.replace('  ', ' '), data: { id: r.data.id, number: r.data.invoiceNumber } };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    const inv = id ? await entities.invoiceById(ctx.user, id) : null;
    const ok = !!inv && Math.abs(Number(inv.amount) - p.amount) < 0.5;
    return { ok, message: ok ? `Invoice ${inv.number} is on the register for ${rs(inv.total)} in total.` : 'I could not find the new invoice.', evidence: { id } };
  },
  audit: (p) => `Created invoice for ${p.clientName} amount ${p.amount}`,
});

defineTool({
  name: 'update_invoice',
  module: 'accounts',
  label: 'Change an invoice',
  description: 'Change an invoice\'s amount before GST, or its GST / TDS percent.',
  parameters: {
    invoice: { type: 'invoice', required: true, description: 'The invoice number.' },
    amount: { type: 'money', required: false, description: 'New amount before GST.' },
    gstPercent: { type: 'percent', required: false, description: 'New GST %.' },
    tdsPercent: { type: 'percent', required: false, description: 'New TDS %.' },
  },
  permission: { product: 'accounts', module: 'accounts', feature: 'Invoices', action: 'edit' },
  confirm: 'always',
  impact: 'Changing an invoice changes what a client owes, so it always needs your Confirm.',
  examples: ['Update invoice INV-0012 amount to 55000', 'Change INV-0034 GST to 12 percent'],
  async validate(ctx, input) {
    const picked = await pickInvoice(ctx, input, { question: 'Which invoice do you want to change? Give its number.' });
    if (picked.ret) return picked.ret;
    const inv = picked.one;
    if (inv.status === 'Cancelled') return T.refuse(`Invoice ${inv.number} is cancelled and cannot be edited.`);
    const { gstPercent, tdsPercent } = percentsFrom(input.text);
    let amount = null;
    const am = input.text.match(/\bamount\b[^0-9]{0,25}([\d,]+(?:\.\d+)?)/i) || input.text.match(/\bto\s+(?:rs\.?\s*)?([\d,]{3,}(?:\.\d+)?)\b/i);
    if (am) amount = Number(am[1].replace(/,/g, ''));
    else if (input.slots.amount != null) amount = input.slots.amount;
    if (amount == null && gstPercent == null && tdsPercent == null) {
      return T.clarify(`What should I change on invoice ${inv.number}? (the amount before GST, GST % or TDS %)`, { need: 'changes' });
    }
    const changes = {};
    const rows = [['Invoice', inv.number], ['Client', inv.client]];
    if (amount != null && Math.abs(amount - Number(inv.amount)) > 0.005) { changes.amount = amount; rows.push(['Amount before GST - now', rs(inv.amount)], ['Amount before GST - new', rs(amount)]); }
    if (gstPercent != null && Number(inv.gstPercent || 0) !== gstPercent) { changes.gstPercent = gstPercent; rows.push(['GST % - now', `${inv.gstPercent || 0}%`], ['GST % - new', `${gstPercent}%`]); }
    if (tdsPercent != null && Number(inv.tdsPercent || 0) !== tdsPercent) { changes.tdsPercent = tdsPercent; rows.push(['TDS % - now', `${inv.tdsPercent || 0}%`], ['TDS % - new', `${tdsPercent}%`]); }
    if (!Object.keys(changes).length) return T.refuse(`Invoice ${inv.number} already has those figures. Nothing to change.`);
    if (inv.received > 0) rows.push(['Already received', rs(inv.received)]);
    return T.done({
      params: { invoiceId: inv.id, number: inv.number, changes, expectedAmount: inv.amount },
      summary: `Change invoice ${inv.number} (${inv.client}): ${Object.entries(changes).map(([k, v]) => `${k === 'amount' ? 'amount' : k === 'gstPercent' ? 'GST %' : 'TDS %'} to ${v}`).join(', ')}.`,
      display: T.card('Change Invoice', rows, 'GST, TDS and the total are recalculated by the app.'),
    });
  },
  async rules(ctx, p) {
    const inv = await entities.invoiceById(ctx.user, p.invoiceId);
    if (!inv) return { ok: false, message: 'I cannot find that invoice in your list any more. Nothing was changed.' };
    if (inv.status === 'Cancelled') return { ok: false, message: 'That invoice is cancelled now. Nothing was changed.' };
    if (Math.abs(Number(inv.amount) - Number(p.expectedAmount)) > 0.005) return { ok: false, message: 'The invoice amount changed since I asked you. Nothing was changed - ask again.' };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/invoices/${encodeURIComponent(p.invoiceId)}`, p.changes);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Invoice ${p.number} updated.`, data: r.data };
  },
  async verify(ctx, p) {
    const inv = await entities.invoiceById(ctx.user, p.invoiceId);
    if (!inv) return { ok: false, message: 'I could not read the invoice back.' };
    const bad = [];
    if (p.changes.amount != null && Math.abs(Number(inv.amount) - p.changes.amount) > 0.01) bad.push('amount');
    if (p.changes.gstPercent != null && Number(inv.gstPercent || 0) !== p.changes.gstPercent) bad.push('GST %');
    if (p.changes.tdsPercent != null && Number(inv.tdsPercent || 0) !== p.changes.tdsPercent) bad.push('TDS %');
    return { ok: !bad.length, message: bad.length ? `These did not save: ${bad.join(', ')}.` : `The invoice now shows ${rs(inv.total)} in total.`, evidence: { total: inv.total } };
  },
  audit: (p) => `Updated invoice ${p.number}: ${Object.keys(p.changes).join(', ')}`,
});

defineTool({
  name: 'cancel_invoice',
  module: 'accounts',
  label: 'Cancel an invoice',
  description: 'Cancel an invoice (only if no money has been received against it).',
  parameters: { invoice: { type: 'invoice', required: true, description: 'The invoice number.' } },
  permission: { product: 'accounts', module: 'accounts', feature: 'Invoices', action: 'edit' },
  confirm: 'always',
  impact: 'Cancelling an invoice cannot be undone, so it always needs your Confirm.',
  examples: ['Cancel invoice INV-0012', 'Void INV-0034'],
  async validate(ctx, input) {
    const picked = await pickInvoice(ctx, input, { question: 'Which invoice do you want to cancel? Give its number.' });
    if (picked.ret) return picked.ret;
    const inv = picked.one;
    if (inv.status === 'Cancelled') return T.refuse(`Invoice ${inv.number} is already cancelled.`);
    if (inv.received > 0) return T.refuse(`Money (${rs(inv.received)}) has already been received on invoice ${inv.number}, so it cannot be cancelled.`);
    return T.done({
      params: { invoiceId: inv.id, number: inv.number },
      summary: `Cancel invoice ${inv.number} for ${inv.client} (${rs(inv.total)}).`,
      display: T.card('Cancel Invoice', [['Invoice', inv.number], ['Client', inv.client], ['Total', rs(inv.total)], ['Status now', inv.status]], 'This cannot be undone.'),
    });
  },
  async rules(ctx, p) {
    const inv = await entities.invoiceById(ctx.user, p.invoiceId);
    if (!inv) return { ok: false, message: 'I cannot find that invoice in your list any more. Nothing was changed.' };
    if (inv.status === 'Cancelled') return { ok: false, message: 'It is already cancelled.' };
    if (inv.received > 0) return { ok: false, message: 'Money has been received on it now, so it cannot be cancelled. Nothing was changed.' };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/invoices/${encodeURIComponent(p.invoiceId)}/cancel`, {});
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Invoice ${p.number} cancelled.`, data: r.data };
  },
  async verify(ctx, p) {
    const inv = await entities.invoiceById(ctx.user, p.invoiceId);
    const ok = !!inv && inv.status === 'Cancelled';
    return { ok, message: ok ? 'The invoice shows as Cancelled.' : 'The invoice does not show as Cancelled.', evidence: { status: inv ? inv.status : null } };
  },
  audit: (p) => `Cancelled invoice ${p.number}`,
});

const METHODS = [[/neft/i, 'Bank Transfer'], [/imps|rtgs|bank transfer|transfer/i, 'Bank Transfer'], [/upi/i, 'UPI'], [/cheque|check\b/i, 'Cheque'], [/cash/i, 'Cash']];

defineTool({
  name: 'record_payment',
  module: 'accounts',
  label: 'Record a payment received',
  description: 'Record money received against an invoice.',
  parameters: {
    invoice: { type: 'invoice', required: true, description: 'The invoice number.' },
    amount: { type: 'money', required: false, description: 'Amount received (the whole balance if you say "paid").' },
    date: { type: 'date', required: false, description: 'The day the money arrived (today if not said).' },
    method: { type: 'enum', required: false, description: 'Bank Transfer, UPI, Cheque or Cash.' },
  },
  permission: { product: 'accounts', module: 'accounts', feature: 'Payments', action: 'create' },
  confirm: 'always',
  impact: 'A payment changes what a client owes and the books, so it always needs your Confirm.',
  examples: ['Record a payment of 50000 on invoice INV-0012', 'Received 25000 against INV-0034 today'],
  async validate(ctx, input) {
    const picked = await pickInvoice(ctx, input, { question: 'Which invoice was paid? Give its number.', status: ['Pending', 'Partially Paid', 'Overdue'] });
    if (picked.ret) return picked.ret;
    const inv = picked.one;
    if (inv.status === 'Cancelled') return T.refuse(`Invoice ${inv.number} is cancelled - no payment can be recorded.`);
    if (inv.outstanding <= 0.5) return T.refuse(`Invoice ${inv.number} is fully paid already.`);
    let amount = null;
    const am = input.text.match(/\b(?:payment|received|receipt|paid|rs\.?|of)\s*(?:of)?\s*:?\s*(?:rs\.?\s*|₹\s*)?([\d,]{3,}(?:\.\d+)?)\b/i);
    if (input.slots.amount != null) amount = input.slots.amount;
    else if (am) amount = Number(am[1].replace(/,/g, ''));
    else if (/\b(as paid|fully paid|in full|full payment|paid in full|mark.*paid)\b/i.test(input.text)) amount = inv.outstanding;
    if (amount == null) return T.clarify(`How much was received on invoice ${inv.number}? (${rs(inv.outstanding)} is still due)`, { need: 'amount' });
    if (!(amount > 0)) return T.refuse('The amount must be more than zero.');
    if (amount > inv.outstanding + 0.5) return T.refuse(`Invoice ${inv.number} only has ${rs(inv.outstanding)} left to receive, and you said ${rs(amount)}. I did not record it.`);
    const date = (input.slots.dates || [])[0] || ctx.today;
    if (date > ctx.today) return T.refuse('A payment cannot be dated in the future.');
    const method = (METHODS.find(([re]) => re.test(input.text)) || [null, 'Bank Transfer'])[1];
    const ref = (input.text.match(/\b(?:utr|ref(?:erence)?)\s*(?:no\.?|number)?\s*[:#-]?\s*([A-Za-z0-9]{6,30})\b/i) || [])[1] || '';
    return T.done({
      params: { invoiceId: inv.id, number: inv.number, amount, date, method, reference: ref || null, expectedReceived: inv.received },
      summary: `Record ${rs(amount)} received on invoice ${inv.number} (${inv.client}) on ${niceDate(date)}.`,
      display: T.card('Record Payment', [
        ['Invoice', inv.number], ['Client', inv.client], ['Invoice total', rs(inv.total)], ['Already received', rs(inv.received)], ['Receiving now', rs(amount)],
        ['Left after this', rs(Math.max(0, inv.outstanding - amount))], ['Date', niceDate(date)], ['Method', method], ['Reference', ref],
      ]),
    });
  },
  async rules(ctx, p) {
    const inv = await entities.invoiceById(ctx.user, p.invoiceId);
    if (!inv) return { ok: false, message: 'I cannot find that invoice in your list any more. Nothing was changed.' };
    if (inv.status === 'Cancelled') return { ok: false, message: 'That invoice is cancelled now. Nothing was recorded.' };
    if (Math.abs(inv.received - p.expectedReceived) > 0.005) return { ok: false, message: 'Another payment was recorded on this invoice since I asked you. Nothing was recorded - ask again.' };
    if (p.amount > inv.outstanding + 0.5) return { ok: false, message: `Only ${rs(inv.outstanding)} is left to receive. Nothing was recorded.` };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post(`/invoices/${encodeURIComponent(p.invoiceId)}/payments`, {
      amount: p.amount, date: p.date, method: p.method, ...(p.reference ? { reference: p.reference } : {}), notes: 'Recorded by the AI Agent at the user\'s request',
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${rs(p.amount)} recorded on invoice ${p.number}.`, data: { paymentId: r.data.payment && r.data.payment.id } };
  },
  async verify(ctx, p) {
    const inv = await entities.invoiceById(ctx.user, p.invoiceId);
    const ok = !!inv && Math.abs(inv.received - (p.expectedReceived + p.amount)) < 0.5;
    return { ok, message: ok ? `The invoice now shows ${rs(inv.received)} received (${inv.status}).` : 'The invoice does not show the new payment.', evidence: { received: inv ? inv.received : null, status: inv ? inv.status : null } };
  },
  audit: (p) => `Recorded payment ${p.amount} on invoice ${p.number}`,
});

// ----------------------------------------------------------------------------
// update_customer (a client's BILLING details)
// ----------------------------------------------------------------------------
const CUST_FIELDS = [
  { key: 'billingEmail', label: 'Billing email', words: ['billing email', 'invoice email', 'accounts email', 'bills email'], kind: 'email' },
  { key: 'gst', label: 'GSTIN', words: ['gstin', 'gst number', 'gst no', 'gst'], kind: 'gstin' },
  { key: 'paymentTerms', label: 'Payment terms', words: ['payment terms', 'terms'], kind: 'text' },
  { key: 'billingAddress', label: 'Billing address', words: ['billing address', 'address'], kind: 'text' },
  { key: 'billingContactName', label: 'Accounts contact', words: ['accounts contact', 'billing contact'], kind: 'text' },
];

defineTool({
  name: 'update_customer',
  module: 'accounts',
  label: 'Change a customer\'s billing details',
  description: 'Change a client\'s billing email, GSTIN, payment terms, billing address or accounts contact.',
  parameters: {
    client: { type: 'client', required: true, description: 'The customer (client).' },
    changes: { type: 'fields', required: true, description: 'What to change.' },
  },
  permission: { product: 'ats', module: 'clients', feature: 'Client Detail', action: 'edit' },
  confirm: 'default',
  examples: ['Update customer Acme billing email to accounts@acme.in', 'Change customer Sunrise Pharma GSTIN to 36ABCDE1234F1Z5'],
  async validate(ctx, input) {
    const asked = {};
    const email = (input.slots.emails || [])[0];
    if (email) asked.billingEmail = email;
    const gstin = (input.slots.codes || []).find((c) => /^[0-9]{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(c));
    if (gstin) asked.gst = gstin;
    const terms = input.text.match(/\bpayment terms?\b[^A-Za-z0-9]{0,8}(?:to|as|is)?\s*((?:net\s*)?\d{1,3}(?:\s*days)?|immediate|advance)\b/i);
    if (terms) asked.paymentTerms = S.CLEAN(terms[1]).replace(/^(\d+)$/, 'Net $1').replace(/^net(\d+)/i, 'Net $1');
    const addr = F.grab(input.text, ['billing address'], { max: 200 });
    if (addr) asked.billingAddress = addr;
    const ac = F.grab(input.text, ['accounts contact', 'billing contact'], { max: 80 });
    if (ac) asked.billingContactName = ac.replace(/\s+\d[\d\s]*$/, '').trim();
    const spans = T.nameSpans(input).filter((s) => ![asked.billingAddress, asked.billingContactName, asked.paymentTerms].some((v) => v && same(v, s)));
    let client;
    if (input.choices && input.choices.client) {
      client = await entities.clientById(ctx.user, input.choices.client);
      if (!client) return T.refuse('I cannot find that customer in your list any more.');
    } else {
      if (!spans.length) return T.clarify('Which customer (client)?', { need: 'client' });
      const hit = await F.locate(spans, (s) => entities.findClients(ctx.user, s));
      if (!hit) return T.refuse(`I cannot find a customer called "${spans[0]}" in your list.`);
      const dec = entities.decide(hit.res);
      if (!dec.one) return T.which(`I found ${hit.res.rows.length} customers that fit "${hit.span}". Which one?`, hit.res.rows, 'client');
      client = dec.one;
    }
    if (!Object.keys(asked).length) return T.clarify(`What should I change on ${client.name}'s billing details? (billing email, GSTIN, payment terms, billing address)`, { need: 'changes' });
    const cur = await ctx.read.get(`/clients/${encodeURIComponent(client.id)}`);
    const now = cur.ok && cur.data ? cur.data : {};
    const changes = {};
    const rows = [['Customer', client.name]];
    CUST_FIELDS.forEach((f) => {
      if (asked[f.key] === undefined || same(now[f.key], asked[f.key])) return;
      changes[f.key] = asked[f.key];
      rows.push([`${f.label} - now`, now[f.key] || '(empty)'], [`${f.label} - new`, asked[f.key]]);
    });
    if (!Object.keys(changes).length) return T.refuse(`${client.name} already has those billing details. Nothing to change.`);
    return T.done({
      params: { clientId: client.id, clientName: client.name, changes },
      summary: `Change ${client.name}'s billing details: ${Object.keys(changes).map((k) => CUST_FIELDS.find((f) => f.key === k).label).join(', ')}.`,
      display: T.card('Change Customer Billing', rows),
    });
  },
  async rules(ctx, p) {
    const c = await entities.clientById(ctx.user, p.clientId);
    return c ? { ok: true } : { ok: false, message: 'I cannot find that customer in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.put(`/clients/${encodeURIComponent(p.clientId)}`, p.changes);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.clientName}'s billing details updated.`, data: r.data };
  },
  async verify(ctx, p) {
    const r = await ctx.read.get(`/clients/${encodeURIComponent(p.clientId)}`);
    if (!r.ok || !r.data) return { ok: false, message: 'I could not read the customer back.' };
    const bad = Object.entries(p.changes).filter(([k, v]) => !same(r.data[k], v)).map(([k]) => k);
    return { ok: !bad.length, message: bad.length ? `These did not save: ${bad.join(', ')}.` : 'The new billing details are on the customer.', evidence: { checked: Object.keys(p.changes) } };
  },
  audit: (p) => `Updated customer ${p.clientId} billing: ${Object.keys(p.changes).join(', ')}`,
});

// ----------------------------------------------------------------------------
// prepare_incentive_action (Super Admin decides recruiter incentives)
// ----------------------------------------------------------------------------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function previousMonth(today) {
  const d = new Date(`${today}T00:00:00`);
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
}
function monthFrom(text, today) {
  const t = String(text || '').toLowerCase();
  const y = Number(today.slice(0, 4));
  const curM = Number(today.slice(5, 7));
  for (let i = 0; i < 12; i += 1) {
    if (new RegExp(`\\b${MONTHS[i].slice(0, 3)}(?:[a-z]*)\\b`).test(t) && new RegExp(`\\b${MONTHS[i]}|\\b${MONTHS[i].slice(0, 3)}\\b`).test(t)) {
      const year = (t.match(/\b(20\d{2})\b/) || [])[1] ? Number(t.match(/\b(20\d{2})\b/)[1]) : (i + 1 >= curM ? y - 1 : y);
      return `${year}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  if (/last month|previous month|gata nela/.test(t)) return previousMonth(today);
  return previousMonth(today);
}

defineTool({
  name: 'prepare_incentive_action',
  module: 'hrms',
  label: 'Decide a recruiter\'s incentive',
  description: 'Record the Super Admin\'s decision on a recruiter\'s incentive for a finished month (it is paid with the next salary).',
  parameters: {
    recruiter: { type: 'person', required: true, description: 'The recruiter.' },
    month: { type: 'month', required: false, description: 'The finished month (last month if not said).' },
    decision: { type: 'enum', required: true, description: 'Incentive (with an amount) or No action.' },
    amount: { type: 'money', required: false, description: 'Incentive in rupees.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Payroll & Compensation', action: 'view' },
  async roles(user) {
    const sc = scopeOf(user);
    return sc.role === 'SUPER_ADMIN' || sc.hrmsRole === 'SUPER_ADMIN'
      ? true : { ok: false, message: 'Only the Super Admin decides recruiter incentives. Nothing was changed.' };
  },
  confirm: 'always',
  impact: 'An incentive goes into payroll, so it always needs your Confirm.',
  examples: ['Give Ravi an incentive of 5000 for September', 'Prepare incentive 8000 for Priya for last month'],
  async validate(ctx, input) {
    const month = monthFrom(input.text, ctx.today);
    if (month >= ctx.today.slice(0, 7)) return T.refuse('That month has not ended yet. Decide after the month is over.');
    const decision = /no incentive|no action|nothing/i.test(input.text) ? 'NONE' : (/\braise\b|\bincrement\b|salary hike/i.test(input.text) ? 'RAISE' : 'INCENTIVE');
    if (decision === 'RAISE') return T.refuse('A salary raise needs the new salary saved first (Payroll -> Salary Structure). I can only record incentives and "no action".');
    const b = await ctx.read.get(`/recruiter-joinings/board?month=${month}`);
    if (!b.ok) return T.refuse(problemOf(b, 'You cannot see the recruiter joinings board.'));
    const rows = (b.data && b.data.rows) || [];
    const spans = T.nameSpans(input);
    if (!spans.length) return T.clarify('For which recruiter?', { need: 'person' });
    let match = null;
    for (const sp of spans) {
      const res = entities.rankRows(rows, (r) => r.name, entities.words(sp), sp);
      const top = res.rows.filter((r) => entities.words(sp).filter((w) => String(r.name).toLowerCase().includes(w)).length === res.bestHits);
      if (top.length) { match = { sp, top, full: res.full }; break; }
    }
    if (!match) return T.refuse(`"${spans[0]}" is not on the recruiter list for that month.`);
    if (match.top.length > 1 || !match.full) {
      return T.which(`I found ${match.top.length} recruiters that fit "${match.sp}". Which one?`, match.top.map((r) => ({ id: r.employeeId, label: `${r.name}${r.seat ? ` (${r.seat})` : ''} - ${r.joinings} of ${r.target} joinings` })), 'employee');
    }
    const row = match.top[0];
    let amount = null;
    if (decision === 'INCENTIVE') {
      amount = amountFrom(input);
      if (!(amount > 0)) return T.clarify(`How much incentive for ${row.name}? (in rupees)`, { need: 'amount' });
      if (amount > 500000) return T.refuse('That is more than Rs 5,00,000. Please check the amount.');
      if (row.left) return T.refuse(`${row.name} is no longer on the payroll. Pay it in their final settlement instead.`);
    }
    return T.done({
      params: { month, employeeId: row.employeeId, name: row.name, decision, amount, joinings: row.joinings, target: row.target },
      summary: decision === 'INCENTIVE' ? `Give ${row.name} an incentive of ${rs(amount)} for ${b.data.label}.` : `Record "no action" for ${row.name} for ${b.data.label}.`,
      display: T.card('Recruiter Incentive', [
        ['Recruiter', row.name], ['Month', b.data.label], ['Joinings', `${row.joinings} of ${row.target}`], ['Decision', decision === 'INCENTIVE' ? 'Give incentive' : 'No action'], ['Amount', amount ? rs(amount) : null],
      ], decision === 'INCENTIVE' ? 'It is paid with the next salary.' : null),
    });
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/recruiter-joinings/decisions', {
      month: p.month, employeeId: p.employeeId, decision: p.decision, ...(p.amount ? { amount: p.amount } : {}), note: 'Recorded via the AI Agent',
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: r.data.message || 'Decision saved.', data: r.data };
  },
  async verify(ctx, p) {
    const b = await ctx.read.get(`/recruiter-joinings/board?month=${p.month}`);
    const row = b.ok && b.data && (b.data.rows || []).find((r) => r.employeeId === p.employeeId);
    const d = row && row.decision;
    const code = d && (d.decision || d.code || d.key);
    const ok = !!d && (String(code || JSON.stringify(d)).toUpperCase().includes(p.decision) || JSON.stringify(d).toLowerCase().includes(p.decision === 'INCENTIVE' ? 'incentive' : 'no action'));
    return { ok, message: ok ? 'The board shows the decision.' : 'The board does not show the decision.', evidence: { decision: d || null } };
  },
  audit: (p) => `Incentive decision ${p.decision} ${p.amount || ''} for ${p.employeeId} ${p.month}`,
});
