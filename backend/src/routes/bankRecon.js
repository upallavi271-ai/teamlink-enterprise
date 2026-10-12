// ---------------------------------------------------------------------------
// BANK RECONCILIATION - the automatic pass, payment allocation, the Unallocated
// Payments queue, reversals / bounced cheques / refunds, saved mappings and the
// tolerance setting (Accounts reconciliation spec 5, 6, 11).
//
// Installed onto the Bank router by routes/bank.js:
//     const recon = require('./bankRecon')(helpers);  recon.install(router);
// so it shares the router's guards: every route here is behind Bank &
// Reconciliation `view`, and every write (POST/PUT/PATCH/DELETE) behind `edit`.
//
// Money: Float columns rounded to 2 dp, compared in integer paise.
// ---------------------------------------------------------------------------
const RM = require('../utils/reconMatch');
const BIC = require('../utils/bankImportCore');

const P = (n) => Math.round((Number(n) || 0) * 100);
const fromP = (p) => p / 100;

class Http extends Error {
  constructor(status, message, extra) { super(message); this.http = status; this.extra = extra; }
}

module.exports = function makeRecon(H) {
  const {
    prisma, logAudit, actor, ROUND, toIsoDate, deriveInvoiceStatus, invoiceOutstanding, ensureAccounts, onAccount, lineOpen, txnState,
    linkPayment, applyPlan, fmtMoney, loadTxn,
  } = H;

  const systemReq = { user: { id: null, name: 'Auto-match' } };
  const who = (req) => (req && req.user ? (req.user.name || req.user.email || 'Accounts') : 'Auto-match');
  const IST_TODAY = () => BIC.istToday();
  const isDupFlag = (s) => /^(Possible duplicate|Identical to another)/.test(String(s || ''));

  // ---- context ---------------------------------------------------------------
  async function getTolerance() {
    try {
      const row = await prisma.appSetting.findUnique({ where: { key: 'bank.dateToleranceDays' } });
      const n = row ? Number(JSON.parse(row.value)) : NaN;
      return Number.isFinite(n) && n >= 0 && n <= 15 ? n : 3;
    } catch { return 3; }
  }

  async function loadContext() {
    const [invoices, clients, aliases, payments, expenses, vendorRows, rules, credits, toleranceDays] = await Promise.all([
      prisma.invoice.findMany({ include: { client: { select: { id: true, name: true, legalName: true } }, candidate: { select: { name: true } } } }),
      prisma.client.findMany({ select: { id: true, name: true, legalName: true } }),
      prisma.clientAlias.findMany().catch(() => []),
      prisma.invoicePayment.findMany(),
      prisma.officeExpense.findMany(),
      prisma.officeVendor.findMany({ select: { name: true } }).catch(() => []),
      prisma.bankRule.findMany(),
      prisma.bankTransaction.findMany({ where: { type: 'Credit' }, select: { id: true, date: true, amount: true, type: true, reference: true, description: true, externalId: true } }),
      getTolerance(),
    ]);
    const vendors = [...new Set([...vendorRows.map((v) => v.name), ...expenses.map((e) => String(e.vendor || '').trim())].filter((v) => v && v.length >= 5))];
    return {
      invoices, clients, clientAliases: aliases, payments, expenses, vendors, rules, credits, toleranceDays,
    };
  }

  // ---- allocation core (all inside one DB transaction) --------------------------
  const sumP = (rows) => rows.reduce((s, r) => s + P(r.amount), 0);

  async function allocateIn(tx, txnId, parts, req, { confirmCrossClient = false, payerClient = null } = {}) {
    const txn = await tx.bankTransaction.findUnique({ where: { id: txnId } });
    if (!txn) throw new Http(404, 'Transaction not found');
    if (txn.type !== 'Credit') throw new Http(400, 'Only money received can be allocated to an invoice');
    const state = txnState(txn);
    if (state === 'Ignored') throw new Http(400, 'This line is ignored - restore it first');
    if (state === 'Reversed') throw new Http(400, 'This line was reversed (bounced / returned) and cannot be allocated');
    if (txn.excluded) throw new Http(400, 'This line is excluded - bring it back first');
    if (txn.category || txn.categoryKind || txn.createdBillId || txn.billLinks) throw new Http(400, 'This line is already filed as something else - undo that first');
    if (!Array.isArray(parts) || !parts.length) throw new Http(400, 'Choose the invoice(s) this money pays and how much to each.');
    const merged = new Map();
    parts.forEach((p) => {
      const id = String(p.invoiceId || '');
      const amt = P(p.amount);
      if (!id || !(amt > 0)) throw new Http(400, 'Each invoice needs a positive amount.');
      merged.set(id, (merged.get(id) || 0) + amt);
    });
    const done = await tx.invoicePayment.findMany({ where: { bankTxnId: txn.id }, select: { amount: true } });
    const doneP = sumP(done);
    const wantP = [...merged.values()].reduce((s, v) => s + v, 0);
    if (doneP + wantP > P(txn.amount)) {
      throw new Http(409, `This line is ${fmtMoney(txn.amount)}; ${fmtMoney(fromP(doneP))} is already allocated, so only ${fmtMoney(fromP(P(txn.amount) - doneP))} is left to allocate.`, { code: 'OVER_ALLOCATION' });
    }
    const invoices = await tx.invoice.findMany({ where: { id: { in: [...merged.keys()] } }, include: { client: true } });
    if (invoices.length !== merged.size) throw new Http(404, 'One of the invoices no longer exists.');
    const clients = new Set(invoices.map((i) => i.clientId));
    if (clients.size > 1 && !confirmCrossClient) {
      throw new Http(409, 'These invoices belong to different clients. Tick "I confirm one payment covers both clients" to continue.', { code: 'CROSS_CLIENT' });
    }
    // Money already identified as one client's must not move to another client's invoice without a person confirming it.
    const payer = payerClient || (txn.clientName && !/ \+\d+$/.test(txn.clientName) ? txn.clientName : null);
    if (payer && !confirmCrossClient && invoices.some((i) => (i.client && i.client.name) !== payer)) {
      throw new Http(409, `This money was identified as coming from ${payer}. Confirm to put it against another client's invoice.`, { code: 'CROSS_CLIENT' });
    }
    for (const inv of invoices) {
      if (inv.status === 'Cancelled') throw new Http(400, `Invoice ${inv.invoiceNumber || inv.id} is cancelled.`);
      const out = P(invoiceOutstanding(inv));
      const take = merged.get(inv.id);
      if (take > out) throw new Http(400, `Invoice ${inv.invoiceNumber || inv.id} has only ${fmtMoney(fromP(out))} outstanding - ${fmtMoney(fromP(take))} is too much.`);
    }
    const n = invoices.length;
    let i = 0;
    const made = [];
    for (const inv of invoices) {
      i += 1;
      const amt = fromP(merged.get(inv.id));
      const row = await tx.invoicePayment.create({
        data: {
          invoiceId: inv.id,
          date: txn.date,
          dateSource: 'bank',
          amount: amt,
          method: 'Bank Transfer',
          reference: txn.reference || null,
          notes: `Bank statement - ${txn.description}${n > 1 ? ` - part ${i} of ${n} of ${fmtMoney(txn.amount)}` : ''}`,
          bankTxnId: txn.id,
          recordedBy: who(req),
        },
      });
      const received = ROUND(Number(inv.receivedAmount || 0) + amt);
      const status = deriveInvoiceStatus({ ...inv, receivedAmount: received });
      await tx.invoice.update({
        where: { id: inv.id },
        data: {
          receivedAmount: received, status, paidDate: status === 'Paid' ? txn.date : inv.paidDate, bankTxnId: txn.id,
        },
      });
      made.push({ paymentId: row.id, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: amt, status });
    }
    const unallocP = P(txn.amount) - doneP - wantP;
    const clientsNamed = [...new Set(invoices.map((x) => x.client && x.client.name).filter(Boolean))];
    const updated = await tx.bankTransaction.update({
      where: { id: txn.id },
      data: {
        matched: true,
        matchedInvoiceId: txn.matchedInvoiceId || invoices[0].id,
        reconStatus: 'Reconciled',
        matchedBy: who(req),
        matchedDate: toIsoDate(new Date()),
        clientName: clientsNamed.length === 1 ? clientsNamed[0] : (clientsNamed.length ? `${clientsNamed[0]} +${clientsNamed.length - 1}` : txn.clientName),
        excess: unallocP > 0 ? fromP(unallocP) : null,
        reviewReason: null,
      },
    });
    return { txn: updated, parts: made, unallocated: fromP(unallocP), before: { allocated: fromP(doneP), unallocated: fromP(P(txn.amount) - doneP) } };
  }

  async function allocateCredit(txnId, parts, req, opts = {}) {
    const out = await prisma.$transaction((tx) => allocateIn(tx, txnId, parts, req, opts), { timeout: 60000, maxWait: 15000 });
    await logAudit({
      userId: req && req.user ? req.user.id : null,
      action: opts.how === 'auto' ? 'Payment allocated automatically' : 'Payment allocated',
      entity: 'BankTransaction',
      entityId: txnId,
      fromValue: `unallocated ${fmtMoney(out.before.unallocated)}`,
      toValue: `${out.parts.map((p) => `${p.invoiceNumber || p.invoiceId} ${fmtMoney(p.amount)}`).join(', ')} - unallocated now ${fmtMoney(out.unallocated)}`,
      reason: opts.reason || null,
    });
    return out;
  }

  // Take ONE allocation back (the receipt row is removed; the invoice goes back
  // to owing it; the audit row keeps the whole old record).
  async function deallocateIn(tx, txnId, paymentId, req) {
    const txn = await tx.bankTransaction.findUnique({ where: { id: txnId } });
    if (!txn) throw new Http(404, 'Transaction not found');
    const pay = await tx.invoicePayment.findUnique({ where: { id: paymentId } });
    if (!pay || pay.bankTxnId !== txn.id) throw new Http(404, 'That allocation does not belong to this line.');
    if (pay.amount < 0) throw new Http(400, 'A reversal entry cannot be taken back.');
    const inv = await tx.invoice.findUnique({ where: { id: pay.invoiceId } });
    const notes = await tx.creditNote.findMany({ where: { invoiceId: pay.invoiceId, status: 'Issued', refundPaidOn: { not: null }, refundDue: { gt: 0.005 } } }).catch(() => []);
    if (notes.length) throw new Http(409, 'A refund was already paid to the client against this invoice - reverse that refund first.', { code: 'REFUND_PAID' });
    if (pay.bankLinked) {
      await tx.invoicePayment.update({ where: { id: pay.id }, data: { bankTxnId: null, bankLinked: false } });
    } else {
      await tx.invoicePayment.delete({ where: { id: pay.id } });
      if (inv) {
        const received = ROUND(Math.max(0, Number(inv.receivedAmount || 0) - Number(pay.amount || 0)));
        const status = deriveInvoiceStatus({ ...inv, receivedAmount: received });
        await tx.invoice.update({ where: { id: inv.id }, data: { receivedAmount: received, status, paidDate: status === 'Paid' ? inv.paidDate : null, bankTxnId: inv.bankTxnId === txn.id ? null : inv.bankTxnId } });
      }
    }
    const left = await tx.invoicePayment.findMany({ where: { bankTxnId: txn.id }, select: { amount: true } });
    const leftP = P(txn.amount) - sumP(left);
    const data = left.length
      ? { excess: leftP > 0 ? fromP(leftP) : null }
      : {
        matched: false, matchedInvoiceId: null, reconStatus: 'Unmatched', matchedBy: null, matchedDate: null, clientName: null, excess: null,
      };
    const updated = await tx.bankTransaction.update({ where: { id: txn.id }, data });
    return { txn: updated, removed: pay, invoice: inv, unallocated: left.length ? fromP(leftP) : fromP(P(txn.amount)) };
  }

  // ---- reversal of a received credit (bounced cheque / returned payment) -------
  async function reverseIn(tx, txnId, req, { reason, date, returnLineId }) {
    const txn = await tx.bankTransaction.findUnique({ where: { id: txnId } });
    if (!txn) throw new Http(404, 'Transaction not found');
    if (txn.type !== 'Credit') throw new Http(400, 'Only money received can be reversed. (A returned payment shows as a debit line - open the credit it returns.)');
    if (txnState(txn) === 'Reversed') throw new Http(400, 'This line is already reversed.');
    let ret = null;
    if (returnLineId) {
      ret = await tx.bankTransaction.findUnique({ where: { id: returnLineId } });
      if (!ret || ret.type !== 'Debit') throw new Http(400, 'The returning line must be a debit on the statement.');
      if (P(ret.amount) !== P(txn.amount)) throw new Http(400, 'The returning debit is not for exactly the same amount.');
      if (ret.reversalOfId || txnState(ret) === 'Reversed') throw new Http(409, 'That debit already reverses another line.');
    }
    const revDate = ret ? ret.date : String(date || '').slice(0, 10);
    if (!BIC.isRealDate(revDate)) throw new Http(400, 'Enter the date the payment was returned / reversed (or pick the returning debit line).');
    if (revDate < txn.date) throw new Http(400, 'A reversal cannot be dated before the payment it reverses.');
    const pays = await tx.invoicePayment.findMany({ where: { bankTxnId: txn.id, amount: { gt: 0 } } });
    const refunds = pays.length
      ? await tx.creditNote.findMany({ where: { invoiceId: { in: pays.map((p) => p.invoiceId) }, status: 'Issued', refundPaidOn: { not: null }, refundDue: { gt: 0.005 } } }).catch(() => [])
      : [];
    if (refunds.length) throw new Http(409, 'A refund was already paid to the client against one of these invoices - reverse that refund first.', { code: 'REFUND_PAID' });
    const out = [];
    for (const p of pays) {
      // Offsetting entry: the original receipt stays on the record, the reversal is a second, negative, dated entry.
      await tx.invoicePayment.create({
        data: {
          invoiceId: p.invoiceId, date: revDate, dateSource: 'bank', amount: -Number(p.amount), method: 'Reversal', reference: p.reference || null,
          notes: `REVERSAL of receipt ${p.date} - ${reason}`, bankTxnId: ret ? ret.id : txn.id, recordedBy: who(req),
        },
      });
      const inv = await tx.invoice.findUnique({ where: { id: p.invoiceId } });
      const received = ROUND(Math.max(0, Number(inv.receivedAmount || 0) - Number(p.amount || 0)));
      const status = deriveInvoiceStatus({ ...inv, receivedAmount: received });
      await tx.invoice.update({ where: { id: inv.id }, data: { receivedAmount: received, status, paidDate: status === 'Paid' ? inv.paidDate : null } });
      out.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: p.amount, from: inv.status, to: status });
    }
    const updated = await tx.bankTransaction.update({
      where: { id: txn.id }, data: { reconStatus: 'Reversed', matched: false, excess: null, reviewReason: null, ignoredReason: `${reason} (${revDate})` },
    });
    if (ret) await tx.bankTransaction.update({ where: { id: ret.id }, data: { reconStatus: 'Reversed', reversalOfId: txn.id, matched: true, matchedBy: who(req), matchedDate: toIsoDate(new Date()), reviewReason: null } });
    return { txn: updated, reversed: out, returnLine: ret ? ret.id : null };
  }

  // ---- the automatic pass -----------------------------------------------------------
  async function applyDecision(txn, dec, req) {
    const a = dec.action;
    if (!a) return { error: 'nothing to do' };
    if (a.type === 'linkPayment') {
      const out = await linkPayment(txn, a.paymentId, req);
      if (out.error) return out;
      await logAudit({
        userId: req && req.user ? req.user.id : null, action: 'Bank line matched automatically + proof attached', entity: 'BankTransaction', entityId: txn.id,
        fromValue: `${txn.date} - in ${fmtMoney(txn.amount)} - ${String(txn.description || '').slice(0, 60)}`, toValue: `receipt on ${dec.invoiceNumber || dec.invoiceId} - rule ${dec.rule}`, reason: (dec.evidence || []).join(' | '),
      });
      return { record: `receipt on ${dec.invoiceNumber || dec.invoiceId}` };
    }
    if (a.type === 'settle') {
      try {
        const out = await allocateCredit(txn.id, a.parts, req, { how: 'auto', reason: `rule ${dec.rule}: ${(dec.evidence || []).join(' | ')}` });
        return { record: out.parts.map((p) => p.invoiceNumber).join(', ') };
      } catch (e) { if (e.http) return { error: e.message }; throw e; }
    }
    if (a.type === 'linkBill') {
      const out = await applyPlan(txn, { action: { type: 'linkBill', billId: a.billId } }, null, [], req);
      if (out.error) return out;
      await logAudit({
        userId: req && req.user ? req.user.id : null, action: 'Bank line matched automatically + proof attached', entity: 'BankTransaction', entityId: txn.id,
        fromValue: `${txn.date} - out ${fmtMoney(txn.amount)} - ${String(txn.description || '').slice(0, 60)}`, toValue: `${out.record} - rule ${dec.rule}`, reason: (dec.evidence || []).join(' | '),
      });
      return out;
    }
    return { error: 'unknown action' };
  }

  async function setReview(txn, reason) {
    const cur = txn.reviewReason || null;
    if (isDupFlag(cur) && !reason) return; // an import-time warning stays until a person looks at it
    const next = reason || null;
    if (cur === next) return;
    if (isDupFlag(cur)) return;
    await prisma.bankTransaction.update({ where: { id: txn.id }, data: { reviewReason: next } });
  }

  // lines: BankTransaction rows (already filtered to open ones by the caller)
  async function runMatcher(lines, req, { apply = true } = {}) {
    const report = {
      checked: 0, matched: 0, needsReview: 0, none: 0, failed: 0, details: [],
    };
    if (!lines.length) return report;
    let ctx = await loadContext();
    const ordered = [...lines].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const line of ordered) {
      const txn = await prisma.bankTransaction.findUnique({ where: { id: line.id } });
      if (!txn) continue;
      const linked = await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } });
      if (!lineOpen(txn, new Set(linked ? [txn.id] : []))) continue;
      report.checked += 1;
      const dec = RM.decide(txn, ctx);
      report.details.push({ id: txn.id, date: txn.date, type: txn.type, amount: txn.amount, description: txn.description, confidence: dec.confidence, rule: dec.rule || null, kind: dec.kind || null, reason: dec.reviewReason || null, evidence: dec.evidence || null });
      if (dec.confidence === 'auto' && apply) {
        const res = await applyDecision(txn, dec, req || systemReq);
        if (!res.error) {
          report.matched += 1;
          ctx = await loadContext(); // balances and links moved
          continue;
        }
        report.failed += 1;
        await setReview(txn, `Matched on rule ${dec.rule} but could not be applied: ${res.error}`);
        continue;
      }
      if (dec.confidence === 'auto') { report.matched += 1; continue; } // dry run: counted, nothing written
      if (dec.confidence === 'review') {
        report.needsReview += 1;
        if (apply) await setReview(txn, dec.reviewReason);
      } else {
        report.none += 1;
        if (apply) await setReview(txn, null);
      }
    }
    return report;
  }

  const openLines = async (where = {}) => {
    const txns = await prisma.bankTransaction.findMany({ where: { excluded: false, reconStatus: 'Unmatched', category: null, categoryKind: null, createdBillId: null, billLinks: null, ...where } });
    return txns;
  };

  // Called after a statement import with the ids that were just saved.
  async function autoMatchNewLines({ ids, account, firstId, req, autoPost }) {
    let matched = 0;
    let loansLinked = 0;
    let chargesFiled = 0;
    let billsFiled = 0;
    let reportAfter = null;
    if (autoPost) {
      const mine = await prisma.bankTransaction.findMany({ where: { id: { in: ids } } });
      const rep = await runMatcher(mine, req);
      matched = rep.matched;
      loansLinked = (await H.autoLinkLoans(req)).linked;
      const debits = await H.autoFileDebits(account.id, firstId, req);
      billsFiled = debits.filed - debits.charges;
      chargesFiled = debits.charges;
      reportAfter = rep;
    }
    const [fresh, links] = await Promise.all([
      prisma.bankTransaction.findMany({ where: { id: { in: ids } } }),
      prisma.handLoanLink.findMany({ where: { bankTxnId: { in: ids } }, select: { bankTxnId: true } }),
    ]);
    const linkedSet = new Set(links.map((l) => l.bankTxnId));
    const autoMatched = fresh.filter((t) => !lineOpen(t, linkedSet) && !t.excluded && txnState(t) !== 'Ignored').length;
    const open = fresh.filter((t) => lineOpen(t, linkedSet));
    return {
      autoPosted: matched, loansLinked, billsFiled, chargesFiled, autoMatched, needsReview: open.filter((t) => t.reviewReason).length, unmatched: open.length, matcher: reportAfter && { checked: reportAfter.checked, matched: reportAfter.matched, needsReview: reportAfter.needsReview, none: reportAfter.none },
    };
  }

  // Looks again at every line still waiting (new expense, new vendor, saved mapping, manual entry).
  async function reconsiderOpenLines({ req, bankAccountId, accounts } = {}) {
    let where = {};
    if (bankAccountId) {
      const accs = accounts || await ensureAccounts();
      const firstId = accs[0].id;
      where = bankAccountId === firstId ? { OR: [{ bankAccountId }, { bankAccountId: null }] } : { bankAccountId };
    }
    const lines = await openLines(where);
    const rep = await runMatcher(lines, req || systemReq);
    return rep;
  }

  // ---- routes ---------------------------------------------------------------------------
  function install(router) {
    const guard = (fn) => async (req, res) => {
      try { return await fn(req, res); } catch (e) {
        if (e && e.http) return res.status(e.http).json({ error: e.message, ...(e.extra || {}) });
        // eslint-disable-next-line no-console
        console.error('[bankRecon]', e);
        return res.status(500).json({ error: 'That did not work. Nothing was changed.' });
      }
    };

    // Tolerance setting ---------------------------------------------------------------
    router.get('/settings', guard(async (req, res) => {
      res.json({ dateToleranceDays: await getTolerance(), allocationPolicy: RM.allocationPolicy(), amountRule: 'Amounts must match to the paisa for an automatic match.' });
    }));
    router.put('/settings', guard(async (req, res) => {
      const n = Number(req.body && req.body.dateToleranceDays);
      if (!Number.isInteger(n) || n < 0 || n > 15) return res.status(400).json({ error: 'Choose a whole number of days from 0 to 15.' });
      const before = await getTolerance();
      await prisma.appSetting.upsert({
        where: { key: 'bank.dateToleranceDays' },
        create: { key: 'bank.dateToleranceDays', value: JSON.stringify(n), updatedById: req.user.id, updatedByName: who(req) },
        update: { value: JSON.stringify(n), updatedById: req.user.id, updatedByName: who(req) },
      });
      await logAudit({ userId: req.user.id, action: 'Bank date tolerance changed', entity: 'AppSetting', entityId: 'bank.dateToleranceDays', fromValue: String(before), toValue: String(n) });
      res.json({ dateToleranceDays: n });
    }));

    // Look again at everything waiting -------------------------------------------------
    router.post('/reconsider', guard(async (req, res) => {
      const rep = await reconsiderOpenLines({ req, bankAccountId: req.body && req.body.bankAccountId && req.body.bankAccountId !== 'All' ? req.body.bankAccountId : null });
      await logAudit({ userId: req.user.id, action: 'Waiting bank lines checked again', entity: 'BankTransaction', toValue: `${rep.checked} checked, ${rep.matched} matched, ${rep.needsReview} need review` });
      res.json({ checked: rep.checked, matched: rep.matched, needsReview: rep.needsReview, unmatched: rep.none, failed: rep.failed });
    }));

    // Save a confirmed narration -> vendor / category / client mapping -----------------------
    router.post('/rules', guard(async (req, res) => {
      const b = req.body || {};
      const kind = b.kind === 'client' ? 'client' : 'expense';
      const match = String(b.match || '').trim();
      const key = RM.norm(match);
      if (key.length < 4 || /^(NEFT|RTGS|IMPS|UPI|CHQ|CHEQUE|PAYMENT|TRANSFER|BANK|CREDIT|DEBIT)( (NEFT|RTGS|IMPS|UPI|CHQ|CHEQUE|PAYMENT|TRANSFER|BANK|CREDIT|DEBIT))*$/.test(key)) {
        return res.status(400).json({ error: 'Type the distinctive words from the narration (at least 4 letters, not just NEFT / UPI / PAYMENT).' });
      }
      let category = String(b.category || '').trim();
      let vendor = String(b.vendor || '').trim() || null;
      if (kind === 'client') {
        const c = await prisma.client.findFirst({ where: { OR: [{ id: String(b.clientId || '__') }, { name: category }] }, select: { id: true, name: true } });
        if (!c) return res.status(400).json({ error: 'Choose a client that is on file.' });
        category = c.name;
        vendor = null;
      } else {
        if (!category && !vendor) return res.status(400).json({ error: 'Choose the expense category or the vendor this narration belongs to.' });
        if (category) {
          const cat = await prisma.expenseCategory.findFirst({ where: { name: category, isActive: true } });
          const used = cat ? null : await prisma.officeExpense.findFirst({ where: { category } });
          if (!cat && !used) return res.status(400).json({ error: `"${category}" is not an expense category on file.` });
        }
        if (vendor) {
          const known = await prisma.officeExpense.findFirst({ where: { vendor } }) || await prisma.officeVendor.findFirst({ where: { name: vendor } }).catch(() => null);
          if (!known) return res.status(400).json({ error: `"${vendor}" is not a vendor on file. Add the vendor first.` });
        }
      }
      const all = await prisma.bankRule.findMany();
      const existing = all.find((r) => RM.norm(r.match) === key && (r.kind || 'expense') === kind);
      const data = {
        match, category: category || vendor || '', vendor, kind, createdById: req.user.id, createdByName: who(req), source: 'confirmed',
      };
      const rule = existing ? await prisma.bankRule.update({ where: { id: existing.id }, data }) : await prisma.bankRule.create({ data });
      await logAudit({
        userId: req.user.id, action: existing ? 'Narration mapping updated' : 'Narration mapping saved', entity: 'BankRule', entityId: rule.id,
        fromValue: existing ? `${existing.match} -> ${existing.category}${existing.vendor ? ` / ${existing.vendor}` : ''}` : '-', toValue: `${match} -> ${kind === 'client' ? 'client ' : ''}${category}${vendor ? ` / ${vendor}` : ''}`,
      });
      const rep = await reconsiderOpenLines({ req });
      res.status(existing ? 200 : 201).json({ rule, rechecked: rep.checked, nowMatched: rep.matched, needsReview: rep.needsReview });
    }));

    // Detail of one line (the "View Transaction" drawer) ----------------------------------------
    router.get('/:id/detail', guard(async (req, res) => {
      res.json(await lineDetail(req.params.id));
    }));

    // Unallocated Payments queue ----------------------------------------------------------------
    router.get('/unallocated', guard(async (req, res) => {
      const accounts = await ensureAccounts();
      const firstId = accounts[0].id;
      const accountId = req.query.bankAccountId && req.query.bankAccountId !== 'All' ? req.query.bankAccountId : null;
      let txns = await prisma.bankTransaction.findMany({ where: { type: 'Credit', excluded: false } });
      if (accountId) txns = onAccount(txns, accountId, firstId);
      txns = txns.filter((t) => !['Ignored', 'Reversed'].includes(txnState(t)) && !t.category && !t.categoryKind && !t.createdBillId && !t.billLinks);
      const loanLinks = await prisma.handLoanLink.findMany({ select: { bankTxnId: true } });
      const loanSet = new Set(loanLinks.map((l) => l.bankTxnId));
      txns = txns.filter((t) => !loanSet.has(t.id));
      const pays = await prisma.invoicePayment.findMany({ where: { bankTxnId: { in: txns.map((t) => t.id) } }, select: { bankTxnId: true, amount: true } });
      const allocBy = new Map();
      pays.forEach((p) => allocBy.set(p.bankTxnId, (allocBy.get(p.bankTxnId) || 0) + P(p.amount)));
      const ctx = await loadContext();
      const rows = [];
      for (const t of txns) {
        const allocP = allocBy.get(t.id) || 0;
        const unP = P(t.amount) - allocP;
        if (unP <= 0) continue;
        const narr = RM.norm(`${t.description || ''} ${t.reference || ''}`);
        const named = RM.clientNamed(narr, ctx);
        const clientId = named && !named.ambiguous ? named.clientId : (t.clientName ? (ctx.clients.find((c) => c.name === t.clientName) || {}).id : null) || null;
        const client = clientId ? ctx.clients.find((c) => c.id === clientId) : null;
        const open = clientId ? ctx.invoices.filter((i) => i.clientId === clientId && RM.isOpen(i)) : [];
        const dec = RM.decide(t, ctx);
        rows.push({
          txnId: t.id, date: t.date, valueDate: t.valueDate || null, description: t.description, reference: t.reference || null,
          received: ROUND(t.amount), allocated: fromP(allocP), unallocated: fromP(unP), partlyAllocated: allocP > 0,
          bankAccountId: t.bankAccountId || firstId, importedAt: t.createdAt,
          clientId, client: client ? client.name : null, reason: t.reviewReason || dec.reviewReason || (client ? null : 'No client recognised in the narration'),
          confidence: dec.confidence, ageDays: Math.max(0, Math.floor((Date.now() - new Date(`${t.date}T00:00:00Z`).getTime()) / 86400000)),
          openInvoices: RM.oldestDueFirst(open).map((i) => ({
            id: i.id, invoiceNumber: i.invoiceNumber, candidate: i.candidate ? i.candidate.name : null, invoiceDate: i.invoiceDate, dueDate: i.dueDate, outstanding: fromP(RM.outstandingP(i)),
          })),
          suggested: open.length ? RM.suggestSplit(open, unP) : null,
          clientRemaining: fromP(open.reduce((s, i) => s + RM.outstandingP(i), 0)),
        });
      }
      const qText = RM.norm(req.query.q || '');
      const clientFilter = String(req.query.client || '');
      const base = rows.filter((r) => !qText || RM.norm(`${r.description} ${r.reference} ${r.client}`).includes(qText));
      const facetRows = base; // cascading: counts come from rows matching the other filters (search)
      const counts = new Map();
      facetRows.forEach((r) => { const k = r.client || '(client not recognised)'; counts.set(k, (counts.get(k) || 0) + 1); });
      const shown = base.filter((r) => !clientFilter || (r.client || '(client not recognised)') === clientFilter)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      res.json({
        policy: RM.allocationPolicy(),
        totals: {
          lines: shown.length,
          received: ROUND(shown.reduce((s, r) => s + r.received, 0)),
          allocated: ROUND(shown.reduce((s, r) => s + r.allocated, 0)),
          unallocated: ROUND(shown.reduce((s, r) => s + r.unallocated, 0)),
        },
        facets: { client: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n })) },
        rows: shown,
      });
    }));

    // Open invoices (for picking, when the client was not recognised) ----------------------------
    router.get('/open-invoices', guard(async (req, res) => {
      const where = { NOT: { status: 'Cancelled' } };
      if (req.query.clientId) where.clientId = String(req.query.clientId);
      const invs = await prisma.invoice.findMany({ where, include: { client: { select: { id: true, name: true } }, candidate: { select: { name: true } } } });
      const q = RM.norm(req.query.q || '');
      const list = invs.filter((i) => RM.isOpen(i) && (!q || RM.norm(`${i.invoiceNumber} ${i.client && i.client.name} ${i.candidate && i.candidate.name}`).includes(q)));
      const counts = new Map();
      list.forEach((i) => { const k = i.client ? i.client.name : '-'; counts.set(k, (counts.get(k) || 0) + 1); });
      res.json({
        facets: { client: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n })) },
        rows: RM.oldestDueFirst(list).slice(0, 200).map((i) => ({
          id: i.id, invoiceNumber: i.invoiceNumber, clientId: i.clientId, client: i.client ? i.client.name : null, candidate: i.candidate ? i.candidate.name : null,
          invoiceDate: i.invoiceDate, dueDate: i.dueDate, outstanding: fromP(RM.outstandingP(i)),
        })),
      });
    }));

    // Allocate (approve) -------------------------------------------------------------------------
    router.post('/:id/allocate', guard(async (req, res) => {
      const out = await allocateCredit(req.params.id, req.body && req.body.parts, req, {
        how: 'manual', reason: String((req.body && req.body.reason) || 'Approved on Unallocated Payments').slice(0, 300), confirmCrossClient: !!(req.body && req.body.confirmCrossClient),
      });
      res.json({ ...out.txn, state: txnState(out.txn), parts: out.parts, unallocated: out.unallocated });
    }));

    router.post('/:id/deallocate', guard(async (req, res) => {
      const reason = String((req.body && req.body.reason) || '').trim();
      if (reason.length < 3) return res.status(400).json({ error: 'Say why the allocation is being taken back.' });
      const out = await prisma.$transaction((tx) => deallocateIn(tx, req.params.id, String((req.body && req.body.paymentId) || ''), req), { timeout: 60000 });
      await logAudit({
        userId: req.user.id, action: 'Payment allocation taken back', entity: 'BankTransaction', entityId: req.params.id,
        fromValue: `${out.invoice ? out.invoice.invoiceNumber : out.removed.invoiceId} ${fmtMoney(out.removed.amount)} (receipt ${out.removed.id}, dated ${out.removed.date})`, toValue: `unallocated now ${fmtMoney(out.unallocated)}`, reason,
      });
      res.json({ ...out.txn, state: txnState(out.txn), unallocated: out.unallocated });
    }));

    router.post('/:id/reallocate', guard(async (req, res) => {
      const b = req.body || {};
      const reason = String(b.reason || '').trim();
      if (reason.length < 3) return res.status(400).json({ error: 'Say why the money is being moved.' });
      const result = await prisma.$transaction(async (tx) => {
        const old = await tx.invoicePayment.findUnique({ where: { id: String(b.fromPaymentId || '') } });
        if (!old) throw new Http(404, 'The allocation to move was not found.');
        const before = await tx.bankTransaction.findUnique({ where: { id: req.params.id } });
        const payerClient = before && before.clientName && !/ \+\d+$/.test(before.clientName) ? before.clientName : null;
        const amount = b.amount != null && b.amount !== '' ? Number(b.amount) : Number(old.amount);
        if (P(amount) !== P(old.amount)) throw new Http(400, 'Move the whole allocation (partial moves: take it back and allocate again).');
        const back = await deallocateIn(tx, req.params.id, old.id, req);
        const to = await allocateIn(tx, req.params.id, [{ invoiceId: String(b.toInvoiceId || ''), amount }], req, { confirmCrossClient: !!b.confirmCrossClient, payerClient });
        return { back, to };
      }, { timeout: 60000 });
      await logAudit({
        userId: req.user.id, action: 'Payment re-allocated', entity: 'BankTransaction', entityId: req.params.id,
        fromValue: `${result.back.invoice ? result.back.invoice.invoiceNumber : '-'} ${fmtMoney(result.back.removed.amount)}`, toValue: `${result.to.parts.map((p) => p.invoiceNumber).join(', ')} ${fmtMoney(result.to.parts.reduce((s, p) => s + p.amount, 0))}`, reason,
      });
      res.json({ ...result.to.txn, state: txnState(result.to.txn), parts: result.to.parts, unallocated: result.to.unallocated });
    }));

    // Bounced cheque / returned payment ------------------------------------------------------------
    router.post('/:id/reverse', guard(async (req, res) => {
      const b = req.body || {};
      const reason = String(b.reason || '').trim();
      if (reason.length < 3) return res.status(400).json({ error: 'Say what happened (for example "cheque bounced - insufficient funds").' });
      const out = await prisma.$transaction((tx) => reverseIn(tx, req.params.id, req, { reason, date: b.date, returnLineId: b.returnLineId }), { timeout: 60000 });
      await logAudit({
        userId: req.user.id, action: 'Receipt reversed (bounced / returned)', entity: 'BankTransaction', entityId: req.params.id,
        fromValue: `${out.reversed.map((r) => `${r.invoiceNumber} ${r.from}`).join(', ') || 'no invoice allocation'}`, toValue: `${out.reversed.map((r) => `${r.invoiceNumber} ${r.to}`).join(', ') || 'reversed'}${out.returnLine ? ` - returning line ${out.returnLine}` : ''}`, reason,
      });
      res.json({ ...out.txn, state: txnState(out.txn), reversed: out.reversed, returnLine: out.returnLine });
    }));

    // A debit that pays a client refund (credit note) ---------------------------------------------------
    router.post('/:id/link-refund', guard(async (req, res) => {
      const txn = await loadTxn(req.params.id);
      if (!txn) return res.status(404).json({ error: 'Transaction not found' });
      if (txn.type !== 'Debit') return res.status(400).json({ error: 'A refund to a client is money paid out (a debit line).' });
      if (txnState(txn) !== 'Unmatched' || txn.category || txn.categoryKind) return res.status(400).json({ error: 'This line is already filed - undo that first.' });
      const note = await prisma.creditNote.findUnique({ where: { id: String((req.body && req.body.creditNoteId) || '') }, include: { invoice: { include: { client: true } } } });
      if (!note || note.status !== 'Issued' || note.kind === 'debit') return res.status(400).json({ error: 'Choose an issued credit note.' });
      if (!(Number(note.refundDue || 0) > 0.005)) return res.status(400).json({ error: 'That credit note has no refund due.' });
      if (note.refundPaidOn) return res.status(409).json({ error: `That refund was already marked paid on ${note.refundPaidOn}.` });
      if (P(note.refundDue) !== P(txn.amount)) return res.status(400).json({ error: `The refund due is ${fmtMoney(note.refundDue)} but this line is ${fmtMoney(txn.amount)} - they must match to the paisa.` });
      const out = await prisma.$transaction(async (tx) => {
        const cn = await tx.creditNote.update({ where: { id: note.id }, data: { refundPaidOn: txn.date, refundRef: String(txn.reference || txn.id).slice(0, 120), refundPaidBy: who(req) } });
        const t = await tx.bankTransaction.update({ where: { id: txn.id }, data: { category: 'Client refund', categoryKind: 'refund', counterparty: note.invoice && note.invoice.client ? note.invoice.client.name : null, billLinks: null, reviewReason: null, matchedBy: who(req), matchedDate: toIsoDate(new Date()) } });
        return { cn, t };
      });
      await logAudit({
        userId: req.user.id, action: 'Client refund matched to a bank line', entity: 'BankTransaction', entityId: txn.id,
        fromValue: `${txn.date} - out ${fmtMoney(txn.amount)}`, toValue: `credit note ${note.number} refund of ${fmtMoney(note.refundDue)} paid on ${txn.date}`, reason: String((req.body && req.body.reason) || 'Confirmed by a person').slice(0, 300),
      });
      res.json({ ...out.t, state: txnState(out.t), creditNote: { id: out.cn.id, number: out.cn.number, refundPaidOn: out.cn.refundPaidOn } });
    }));
    router.post('/:id/unlink-refund', guard(async (req, res) => {
      const txn = await loadTxn(req.params.id);
      if (!txn || txn.categoryKind !== 'refund') return res.status(400).json({ error: 'This line is not matched to a client refund.' });
      const notes = await prisma.creditNote.findMany({ where: { refundPaidOn: txn.date, refundRef: String(txn.reference || txn.id).slice(0, 120) } });
      await prisma.$transaction(async (tx) => {
        for (const n of notes) await tx.creditNote.update({ where: { id: n.id }, data: { refundPaidOn: null, refundRef: null, refundPaidBy: null } });
        await tx.bankTransaction.update({ where: { id: txn.id }, data: { category: null, categoryKind: null, counterparty: null } });
      });
      await logAudit({ userId: req.user.id, action: 'Client refund link undone', entity: 'BankTransaction', entityId: txn.id, toValue: `${notes.length} credit note(s) back to refund due`, reason: String((req.body && req.body.reason) || '').slice(0, 300) || null });
      res.json({ ok: true, creditNotes: notes.length });
    }));
  }

  // ---- one line, in full (drawer) -----------------------------------------------------------------------
  async function lineDetail(id) {
    const txn = await prisma.bankTransaction.findUnique({ where: { id } });
    if (!txn) throw new Http(404, 'Transaction not found');
    const [accounts, pays, bills, imp, loan, ret, reversedBy] = await Promise.all([
      ensureAccounts(),
      prisma.invoicePayment.findMany({ where: { bankTxnId: id }, include: { invoice: { include: { client: { select: { id: true, name: true } }, candidate: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } }),
      prisma.officeExpense.findMany({ where: { bankTxnId: id } }),
      txn.importBatch ? prisma.bankImport.findUnique({ where: { id: txn.importBatch } }) : null,
      prisma.handLoanLink.findUnique({ where: { bankTxnId: id }, include: { loan: true } }),
      txn.reversalOfId ? prisma.bankTransaction.findUnique({ where: { id: txn.reversalOfId } }) : null,
      prisma.bankTransaction.findFirst({ where: { reversalOfId: id } }),
    ]);
    const account = accounts.find((a) => a.id === (txn.bankAccountId || accounts[0].id)) || accounts[0];
    const allocP = pays.reduce((s, p) => s + P(p.amount), 0);
    const billNetP = bills.reduce((s, b) => s + (P(b.monthlyAmount) - P(b.tdsAmount)), 0);
    const credit = txn.type === 'Credit';
    const differenceP = credit ? P(txn.amount) - allocP : (bills.length ? P(txn.amount) - billNetP : null);
    let source = null;
    try { source = txn.sourceRow ? JSON.parse(txn.sourceRow) : null; } catch { source = null; }
    return {
      id: txn.id,
      bank: account ? `${account.bank}${account.accNo ? ` - xxxx${String(account.accNo).slice(-4)}` : ''}` : null,
      transactionDate: txn.date,
      valueDate: txn.valueDate || null,
      importedAt: txn.createdAt,
      narration: txn.description,
      type: txn.type,
      debit: txn.type === 'Debit' ? ROUND(txn.amount) : null,
      credit: credit ? ROUND(txn.amount) : null,
      reference: txn.reference || null,
      bankTxnId: txn.externalId || null,
      balance: txn.balance,
      state: txnState(txn),
      reviewReason: txn.reviewReason || null,
      clientOrVendor: credit ? (txn.clientName || (pays[0] && pays[0].invoice && pays[0].invoice.client ? pays[0].invoice.client.name : null)) : (txn.vendor || (bills[0] && bills[0].vendor) || null),
      allocations: pays.map((p) => ({
        paymentId: p.id, invoiceId: p.invoiceId, invoiceNumber: p.invoice ? p.invoice.invoiceNumber : null, client: p.invoice && p.invoice.client ? p.invoice.client.name : null,
        candidate: p.invoice && p.invoice.candidate ? p.invoice.candidate.name : null, amount: p.amount, date: p.date, dateSource: p.dateSource || null, method: p.method, reversal: p.amount < 0,
      })),
      bills: bills.map((b) => ({ id: b.id, expenseCode: b.expenseCode, category: b.category, vendor: b.vendor, net: ROUND(Number(b.monthlyAmount || 0) - Number(b.tdsAmount || 0)), paymentDate: b.paymentDate || null, status: b.approvalStatus })),
      handLoan: loan ? { name: loan.loan.name, kind: loan.kind } : null,
      refund: txn.categoryKind === 'refund' ? { client: txn.counterparty } : null,
      reverses: ret ? { id: ret.id, date: ret.date, amount: ret.amount } : null,
      reversedBy: reversedBy ? { id: reversedBy.id, date: reversedBy.date } : null,
      allocated: credit ? fromP(allocP) : null,
      unallocated: credit ? fromP(Math.max(0, P(txn.amount) - allocP)) : null,
      difference: differenceP == null ? null : fromP(differenceP),
      import: imp ? { batch: imp.id, file: imp.file, importedOn: imp.date, by: imp.recordedBy } : null,
      sourceLine: txn.sourceLine || null,
      sourceRow: source,
    };
  }

  return {
    install, autoMatchNewLines, reconsiderOpenLines, runMatcher, loadContext, allocateCredit, lineDetail, getTolerance,
  };
};
