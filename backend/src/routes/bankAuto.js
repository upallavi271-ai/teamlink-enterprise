// ---------------------------------------------------------------------------
// AUTO-RECONCILE (Accounts > Bank & Reconciliation > Auto-Reconcile)
//
// Installed onto the Bank router by routes/bank.js (after bankRecon):
//     const auto = require('./bankAuto')(helpers, recon);  auto.install(router);
// so every route here sits behind Bank & Reconciliation `view`, and every write
// behind `edit` (Manager / Assistant Manager are view-only). Changing the
// settings is further limited to Admin / Super Admin.
//
// This layer adds, on top of the exact matching ladder (utils/reconMatch.js):
//   * confidence bands + tolerances + the suggest-only switch (autoReconCore.js)
//   * a proposals table (ReconProposal) - the ONLY thing a dry run writes
//   * an append-only event stream (ReconEvent)
//   * the historical "Reconcile existing transactions" run: preview, batches,
//     progress, resume, per-run results
//   * review of EXISTING matches that look wrong (flags only, never changed)
// Applying a match ALWAYS goes through the existing helpers (allocateCredit,
// linkBill, deallocate), so invoice statuses, outstanding balances and the
// default-OFF journal switch behave exactly as for a hand-made match.
//
// The three new tables are read/written with raw SQL (the generated Prisma
// client does not know them until `prisma generate` runs after the migration).
// Money: Float columns compared in integer paise.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
const prisma = require('../db');
const RM = require('../utils/reconMatch');
const BIC = require('../utils/bankImportCore');
const CORE = require('../utils/autoReconCore');
const { roleForProduct } = require('../utils/permissions');

const P = (n) => Math.round((Number(n) || 0) * 100);
const nowIso = () => new Date().toISOString();
const newId = () => `rc${crypto.randomBytes(11).toString('hex')}`;
const SETTINGS_KEY = 'bank.autoRecon';
const jparse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x)));

class Http extends Error {
  constructor(status, message, extra) { super(message); this.http = status; this.extra = extra; }
}

module.exports = function makeAuto(H, recon) {
  const {
    logAudit, ROUND, toIsoDate, lineOpen, txnState, applyPlan, linkPayment, fmtMoney, ensureAccounts, attachEvidence,
  } = H;

  const q = async (sql, ...params) => plain(await prisma.$queryRawUnsafe(sql, ...params));
  const x = async (sql, ...params) => Number(await prisma.$executeRawUnsafe(sql, ...params));
  const isAdminReq = (req) => ['ADMIN', 'SUPER_ADMIN'].includes(roleForProduct(req.user, 'accounts'));
  const whoName = (req) => (req && req.user ? (req.user.name || req.user.email || 'Accounts') : 'Auto-reconcile');
  const systemReq = { user: { id: null, name: 'Auto-reconcile' } };

  // The three tables arrive with migration 20261014120000_bank_auto_recon. Until it is applied to a
  // database, every automatic path quietly skips the proposals (settings still work: AppSetting exists).
  let readyAt = 0; let isReady = false;
  async function ready() {
    if (isReady) return true;
    if (Date.now() - readyAt < 15000) return false;
    readyAt = Date.now();
    try { isReady = (await q("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ReconRun','ReconProposal','ReconEvent')")).length === 3; } catch { isReady = false; }
    return isReady;
  }

  // ---- settings ------------------------------------------------------------------------
  async function getSettings() {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
    let raw = null;
    try { raw = row ? JSON.parse(row.value) : null; } catch { raw = null; }
    const s = CORE.normaliseSettings(raw);
    if (!raw || raw.dateToleranceDays == null) {
      // the date tolerance was a stand-alone setting before this screen existed
      const legacy = await prisma.appSetting.findUnique({ where: { key: 'bank.dateToleranceDays' } }).catch(() => null);
      if (legacy) { const n = Number(JSON.parse(legacy.value)); if (Number.isInteger(n) && n >= 0 && n <= 15) s.dateToleranceDays = n; }
    }
    return s;
  }
  async function closedUpTo() {
    const row = await prisma.appSetting.findUnique({ where: { key: 'accounts.booksClosedUpTo' } }).catch(() => null);
    if (!row) return null;
    try { const v = JSON.parse(row.value); return /^\d{4}-\d{2}$/.test(String(v || '')) ? v : null; } catch { return null; }
  }
  const periodClosed = (date, closed) => !!(closed && date && String(date).slice(0, 7) <= closed);

  // ---- events (append only: there is no update or delete of this table anywhere) ---------
  async function ev({
    txnId = null, proposalId = null, runId = null, action, auto = false, req = null, fromValue = null, toValue = null, reason = null,
  }) {
    try {
      await x(
        'INSERT INTO "ReconEvent" ("id","at","txnId","proposalId","runId","action","auto","actorId","actorName","fromValue","toValue","reason") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        newId(), nowIso(), txnId, proposalId, runId, action, auto ? 1 : 0, req && req.user ? req.user.id || null : null, whoName(req), fromValue, toValue, reason,
      );
    } catch (e) { /* eslint-disable-next-line no-console */ console.error('[autoRecon] event not written', e.message); }
  }

  // ---- per-line lock (one apply at a time per bank line, in this process) -------------------
  const locks = new Map();
  async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chain = prev.then(() => mine);
    locks.set(key, chain);
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(key) === chain) locks.delete(key); }
  }

  // ---- proposals --------------------------------------------------------------------------
  const idemOf = (txnId, c) => {
    const parts = c.action && c.action.parts ? c.action.parts.map((p) => `${p.invoiceId}:${P(p.amount)}`).sort().join(',') : '';
    const target = [...(c.targetIds || [])].sort().join(',');
    const body = c.kind === 'none' || !c.action ? `${c.kind}|${c.kind === 'flag' ? (c.flags || []).join('+') : ''}` : `${c.kind}|${target}|${parts}`;
    return crypto.createHash('sha1').update(`${txnId}|${body}`).digest('hex');
  };

  // Returns { row, state: 'new' | 'updated' | 'applied' | 'rejected' | 'reversed' }
  async function upsertProposal(txn, c, { runId = null, source = 'import', pendingKnown = true } = {}) {
    const key = idemOf(txn.id, c);
    const found = (await q('SELECT * FROM "ReconProposal" WHERE "idemKey" = ?', key))[0];
    const vals = [
      c.kind, c.band, c.rule, c.action ? JSON.stringify(c.action) : null, c.targetType, JSON.stringify(c.targetIds || []), c.targetLabel, c.party,
      c.bookAmount, c.allocated, c.difference, JSON.stringify(c.reasons || []), JSON.stringify(c.flags || []), c.candidates ? JSON.stringify(c.candidates) : null,
    ];
    if (found) {
      if (found.status === 'Applied') return { row: found, state: 'applied' };
      if (found.status === 'Rejected') return { row: found, state: 'rejected' };
      if (found.status === 'Reversed') return { row: found, state: 'reversed' };
      await x(
        'UPDATE "ReconProposal" SET "kind"=?,"band"=?,"rule"=?,"action"=?,"targetType"=?,"targetIds"=?,"targetLabel"=?,"party"=?,"bookAmount"=?,"allocated"=?,"difference"=?,"reasons"=?,"flags"=?,"candidates"=?,"status"=\'Pending\',"runId"=?,"source"=?,"updatedAt"=? WHERE "id"=? AND "status" IN (\'Pending\',\'Superseded\',\'Stale\')',
        ...vals, runId, source, nowIso(), found.id,
      );
      await x('UPDATE "ReconProposal" SET "status"=\'Superseded\',"updatedAt"=? WHERE "txnId"=? AND "status"=\'Pending\' AND "id"<>?', nowIso(), txn.id, found.id);
      return { row: { ...found, band: c.band }, state: 'updated' };
    }
    const id = newId();
    try {
      await x(
        'INSERT INTO "ReconProposal" ("id","idemKey","txnId","runId","source","kind","band","rule","action","targetType","targetIds","targetLabel","party","bookAmount","allocated","difference","reasons","flags","candidates","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, key, txn.id, runId, source, c.kind, c.band, c.rule, c.action ? JSON.stringify(c.action) : null, c.targetType, JSON.stringify(c.targetIds || []), c.targetLabel, c.party,
        c.bookAmount, c.allocated, c.difference, JSON.stringify(c.reasons || []), JSON.stringify(c.flags || []), c.candidates ? JSON.stringify(c.candidates) : null, 'Pending', nowIso(), nowIso(),
      );
    } catch (e) {
      const again = (await q('SELECT * FROM "ReconProposal" WHERE "idemKey" = ?', key))[0];
      if (again) return { row: again, state: 'updated' }; // another run inserted the same suggestion first
      throw e;
    }
    if (pendingKnown) await x('UPDATE "ReconProposal" SET "status"=\'Superseded\',"updatedAt"=? WHERE "txnId"=? AND "status"=\'Pending\' AND "id"<>?', nowIso(), txn.id, id);
    return { row: { id, band: c.band, status: 'Pending' }, state: 'new' };
  }

  // ---- applying -----------------------------------------------------------------------------
  async function applyAction(txn, action, req, { auto, reason }) {
    if (action.type === 'settle') {
      try {
        const out = await recon.allocateCredit(txn.id, action.parts, req, { how: auto ? 'auto' : 'manual', reason });
        return { record: out.parts.map((p) => p.invoiceNumber || p.invoiceId).join(', '), unallocated: out.unallocated };
      } catch (e) { if (e.http) return { error: e.message }; throw e; }
    }
    if (action.type === 'evidence') return attachEvidence(txn, action.parts, req);
    if (action.type === 'linkPayment') {
      const out = await linkPayment(txn, action.paymentId, req);
      return out.error ? out : { record: `receipt on ${out.payment && out.payment.invoice ? out.payment.invoice.invoiceNumber : action.paymentId}` };
    }
    if (action.type === 'linkBill') {
      const b = await prisma.officeExpense.findUnique({ where: { id: action.billId } });
      if (!b) return { error: 'That bill no longer exists.' };
      // 2026-10-21: a bill that is still Pending CAN be matched by a person. The shared rule (utils/expensePaymentState.js dataForMatch) decides: an approver's match
      // is the "Mark as Paid" press (bill becomes Paid); anybody else's match links the line and the bill says "matched - waiting to be marked Paid".
      // An automatic pass (no person deciding this line) never marks a bill Paid by itself, so it only links.
      if (b.approvalStatus === 'REJECTED') return { error: 'That bill was rejected - a bank line cannot pay it.' };
      const out = await applyPlan(txn, { action: { type: 'linkBill', billId: action.billId } }, null, [], req, { noApprove: !!auto });
      return out;
    }
    if (action.type === 'tag') {
      const ids = [txn.id];
      if (action.peerId) {
        const peer = await prisma.bankTransaction.findUnique({ where: { id: action.peerId } });
        if (!peer || !lineOpen(peer, new Set())) return { error: 'The opposite line has already been handled.' };
        ids.push(peer.id);
      }
      await prisma.bankTransaction.updateMany({ where: { id: { in: ids } }, data: { category: action.category || null, categoryKind: action.categoryKind, reviewReason: null } });
      return { record: action.categoryKind === 'transfer' ? 'internal transfer' : action.category };
    }
    return { error: 'Nothing to do for this suggestion - match it by hand.' };
  }

  async function snapshotBefore(txn, action) {
    const snap = {
      txn: {
        reconStatus: txn.reconStatus, matched: txn.matched, matchedInvoiceId: txn.matchedInvoiceId, category: txn.category, categoryKind: txn.categoryKind, excess: txn.excess, reviewReason: txn.reviewReason,
      },
    };
    if (action && action.type === 'settle') {
      const invs = await prisma.invoice.findMany({ where: { id: { in: action.parts.map((p) => p.invoiceId) } }, select: { id: true, invoiceNumber: true, status: true, receivedAmount: true } });
      snap.invoices = invs;
    }
    if (action && action.type === 'linkBill') {
      const b = await prisma.officeExpense.findUnique({ where: { id: action.billId }, select: { id: true, approvalStatus: true, paidStatus: true } });
      snap.bill = b;
    }
    return snap;
  }

  async function applyProposal(id, req, { mode = 'approved', parts = null, note = null } = {}) {
    const p = (await q('SELECT * FROM "ReconProposal" WHERE "id" = ?', id))[0];
    if (!p) throw new Http(404, 'Suggestion not found.');
    return withLock(p.txnId, async () => {
      const cur = (await q('SELECT * FROM "ReconProposal" WHERE "id" = ?', id))[0];
      if (!cur || cur.status !== 'Pending') throw new Http(409, `This suggestion was already handled (${cur ? cur.status : 'gone'}).`, { code: 'ALREADY_HANDLED' });
      if (!cur.action) throw new Http(400, 'This is a hint only - match it by hand.');
      const flags = jparse(cur.flags, []);
      if (flags.includes('closed-period') && mode !== 'auto' && !isAdminReq(req)) throw new Http(403, 'This date is in a closed period. Only an Admin may approve it.');
      if (mode === 'auto' && flags.length) throw new Http(409, 'A flagged suggestion is never applied automatically.');
      // atomic claim: simultaneous requests / imports cannot both win
      const claimed = await x('UPDATE "ReconProposal" SET "status"=\'Applying\',"updatedAt"=? WHERE "id"=? AND "status"=\'Pending\'', nowIso(), id);
      if (claimed !== 1) throw new Http(409, 'This suggestion is being handled right now.', { code: 'ALREADY_HANDLED' });
      let done = false;
      try {
        const txn = await prisma.bankTransaction.findUnique({ where: { id: cur.txnId } });
        if (!txn) throw new Http(404, 'The bank line no longer exists.');
        const linked = await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } });
        if (!lineOpen(txn, new Set(linked ? [txn.id] : []))) {
          await x('UPDATE "ReconProposal" SET "status"=\'Stale\',"updatedAt"=? WHERE "id"=?', nowIso(), id);
          done = true;
          throw new Http(409, 'This line has already been handled, so the suggestion is out of date.', { code: 'STALE' });
        }
        if (periodClosed(txn.date, await closedUpTo()) && mode !== 'auto' && !isAdminReq(req)) throw new Http(403, 'This date is in a closed period. Only an Admin may approve it.');
        let action = jparse(cur.action, null);
        if (parts && action && action.type === 'settle') {
          if (!Array.isArray(parts) || !parts.length) throw new Http(400, 'Choose the invoice(s) and amounts.');
          action = { type: 'settle', parts: parts.map((pt) => ({ invoiceId: String(pt.invoiceId), amount: Number(pt.amount) })) };
        }
        const previous = await snapshotBefore(txn, action);
        const reasons = jparse(cur.reasons, []);
        const res = await applyAction(txn, action, mode === 'auto' ? (req || systemReq) : req, { auto: mode === 'auto', reason: `${mode === 'auto' ? 'auto' : 'approved'} (${cur.kind}, rule ${cur.rule || '-'}): ${reasons.join(' | ')}`.slice(0, 480) });
        if (res.error) throw new Http(409, res.error);
        await x(
          'UPDATE "ReconProposal" SET "status"=\'Applied\',"appliedMode"=?,"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"decisionNote"=?,"previous"=?,"updatedAt"=? WHERE "id"=?',
          mode === 'auto' ? 'auto' : 'approved', req && req.user ? req.user.id || null : null, whoName(req), nowIso(), note, JSON.stringify(previous), nowIso(), id,
        );
        done = true;
        await x('UPDATE "ReconProposal" SET "status"=\'Superseded\',"updatedAt"=? WHERE "txnId"=? AND "status"=\'Pending\' AND "id"<>?', nowIso(), txn.id, id);
        await ev({
          txnId: txn.id, proposalId: id, runId: cur.runId, action: mode === 'auto' ? 'Matched automatically' : 'Suggestion approved', auto: mode === 'auto', req,
          fromValue: `${txn.date} ${txn.type} ${fmtMoney(txn.amount)} - ${String(txn.description || '').slice(0, 80)}`, toValue: `${cur.targetLabel || res.record} (${cur.kind}, rule ${cur.rule || '-'}, ${cur.band})`, reason: reasons.join(' | ').slice(0, 800),
        });
        await logAudit({
          userId: req && req.user ? req.user.id || null : null, action: mode === 'auto' ? 'Bank line reconciled automatically' : 'Bank suggestion approved', entity: 'BankTransaction', entityId: txn.id,
          fromValue: `${txn.date} ${txn.type} ${fmtMoney(txn.amount)}`, toValue: `${cur.targetLabel || res.record}`, reason: reasons.join(' | ').slice(0, 500),
        });
        return { ok: true, record: res.record, unallocated: res.unallocated == null ? null : res.unallocated, proposalId: id };
      } catch (e) {
        if (!done) await x('UPDATE "ReconProposal" SET "status"=\'Pending\',"updatedAt"=? WHERE "id"=? AND "status"=\'Applying\'', nowIso(), id);
        throw e;
      }
    });
  }

  // ---- classification of one line ---------------------------------------------------------------
  async function findTransferPeer(txn, S, firstId, getPool) {
    const acct = txn.bankAccountId || firstId;
    const opp = txn.type === 'Debit' ? 'Credit' : 'Debit';
    const from = new Date(Date.parse(`${String(txn.date).slice(0, 10)}T00:00:00Z`) - S.dateToleranceDays * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${String(txn.date).slice(0, 10)}T00:00:00Z`) + S.dateToleranceDays * 86400000).toISOString().slice(0, 10);
    if (getPool) {
      const pool = await getPool();
      const amt = P(txn.amount);
      return pool.filter((r) => r.type === opp && P(r.amount) === amt && r.date >= from && r.date <= to && r.id !== txn.id && (r.bankAccountId || firstId) !== acct);
    }
    const rows = await prisma.bankTransaction.findMany({
      where: {
        type: opp, amount: txn.amount, excluded: false, reconStatus: 'Unmatched', category: null, categoryKind: null, createdBillId: null, billLinks: null, date: { gte: from, lte: to }, id: { not: txn.id },
      },
    });
    return rows.filter((r) => (r.bankAccountId || firstId) !== acct);
  }

  async function classifyLine(txn, ctx, S, env) {
    let c = CORE.classify(txn, ctx, S, env);
    if (c.band === 'low' && ['none', 'transfer-hint'].includes(c.kind) && P(txn.amount) > 0) {
      const peers = await findTransferPeer(txn, S, env.firstId, env.getPool);
      if (peers.length === 1) {
        const accs = env.accounts || [];
        const a = accs.find((z) => z.id === (peers[0].bankAccountId || env.firstId));
        c = CORE.transferProposal(txn, peers[0], S, a ? `${a.bank}${a.accNo ? ` ${String(a.accNo).slice(-4)}` : ''}` : null);
        if (CORE.isDupText(txn.reviewReason)) { c.flags.push('potential-duplicate'); }
      } else if (peers.length > 1) {
        c.reasons = [`${peers.length} lines on other own accounts have exactly this amount near this date - pick the right one`];
        c.candidates = { txnIds: peers.map((z) => z.id) };
        c.kind = 'transfer';
      }
    }
    return c;
  }

  // Process lines: classify, store the proposal, and (only when allowed) apply the HIGH ones.
  async function processLines(lines, { req = null, apply = false, source = 'import', runId = null, settings = null, counts = null } = {}) {
    const S = settings || await getSettings();
    const accounts = await ensureAccounts();
    const env = { closedUpTo: await closedUpTo(), firstId: accounts[0].id, accounts };
    const tally = counts || {};
    const bump = (k, n = 1) => { tally[k] = (tally[k] || 0) + n; };
    let ctx = await recon.loadContext();
    const sorted = [...lines].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
    const ids = sorted.map((l) => l.id);
    const loanLinks = new Set();
    const hasPending = new Set();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      (await prisma.handLoanLink.findMany({ where: { bankTxnId: { in: chunk } }, select: { bankTxnId: true } })).forEach((l) => loanLinks.add(l.bankTxnId));
      (await q(`SELECT DISTINCT "txnId" FROM "ReconProposal" WHERE "status"='Pending' AND "txnId" IN (${chunk.map(() => '?').join(',')})`, ...chunk)).forEach((r) => hasPending.add(r.txnId));
    }
    // transfer partners: one query per batch (open lines near the batch's dates), then matched in memory
    let pool = null;
    env.getPool = async () => {
      if (pool) return pool;
      const tol = S.dateToleranceDays * 86400000;
      const dayMs = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
      const lo = new Date(dayMs(sorted[0].date) - tol).toISOString().slice(0, 10);
      const hi = new Date(dayMs(sorted[sorted.length - 1].date) + tol).toISOString().slice(0, 10);
      pool = await prisma.bankTransaction.findMany({ where: { ...OPEN_WHERE, date: { gte: lo, lte: hi } }, select: { id: true, type: true, amount: true, date: true, bankAccountId: true } });
      return pool;
    };
    const live = apply && S.autoReconcile; // lines can only change under us when we are applying
    for (const line of sorted) {
      const txn = live ? await prisma.bankTransaction.findUnique({ where: { id: line.id } }) : line;
      if (!txn || !lineOpen(txn, loanLinks)) { bump('skipped'); continue; }
      bump('checked');
      bump(txn.type === 'Credit' ? 'creditPaise' : 'debitPaise', P(txn.amount));
      const c = await classifyLine(txn, ctx, S, env);
      const up = await upsertProposal(txn, c, { runId, source, pendingKnown: hasPending.has(txn.id) });
      if (up.state === 'rejected' || up.state === 'reversed') { bump(up.state === 'rejected' ? 'skippedRejected' : 'skippedReversed'); continue; }
      if (up.state === 'applied') { bump('skipped'); continue; }
      if (c.flags.includes('potential-duplicate')) bump('duplicates');
      if (c.flags.includes('amount-mismatch')) bump('mismatches');
      if (c.band === 'high') {
        if (live) {
          try {
            await applyProposal(up.row.id, req || systemReq, { mode: 'auto' });
            bump('autoMatched');
            ctx = await recon.loadContext(); // balances and links moved
            pool = null;
            continue;
          } catch (e) {
            if (!e.http) throw e;
            bump('failedApply');
            await ev({ txnId: txn.id, proposalId: up.row.id, runId, action: 'Automatic match could not be applied', auto: true, req, reason: e.message });
            continue;
          }
        }
        bump('wouldAutoMatch');
      } else if (c.band === 'medium') {
        bump('suggested');
        if (c.difference && Math.abs(c.difference) > 0.004) bump('partial');
      } else if (c.reasons.length && c.candidates) bump('needsReview');
      else bump('unmatched');
      // the event stream records suggestions a person will act on; thousands of "nothing recognised" rows would only bury them
      if (up.state === 'new' && c.band !== 'low') {
        await ev({ txnId: txn.id, proposalId: up.row.id, runId, action: `Suggestion made (${c.band})`, auto: true, req: systemReq, toValue: `${c.targetLabel || c.kind} (rule ${c.rule || '-'})`, reason: (c.reasons || []).join(' | ').slice(0, 800) });
      }
    }
    return tally;
  }


  // ---- existing matches that look wrong (FLAG ONLY) --------------------------------------------------
  async function checkExistingLines(lines, { runId = null, source = 'existing-check', counts = null } = {}) {
    const tally = counts || {};
    const bump = (k, n = 1) => { tally[k] = (tally[k] || 0) + n; };
    const S = await getSettings();
    const ids = lines.map((l) => l.id);
    const pays = await prisma.invoicePayment.findMany({ where: { bankTxnId: { in: ids } }, include: { invoice: { select: { id: true, status: true, invoiceNumber: true } } } });
    const bills = await prisma.officeExpense.findMany({ where: { bankTxnId: { in: ids } }, select: { id: true, bankTxnId: true, monthlyAmount: true, tdsAmount: true, expenseCode: true } });
    const loanLinks = new Set((await prisma.handLoanLink.findMany({ where: { bankTxnId: { in: ids } }, select: { bankTxnId: true } })).map((l) => l.bankTxnId));
    const payBy = new Map(); const billBy = new Map();
    pays.forEach((p) => { (payBy.get(p.bankTxnId) || payBy.set(p.bankTxnId, []).get(p.bankTxnId)).push(p); });
    bills.forEach((b) => { (billBy.get(b.bankTxnId) || billBy.set(b.bankTxnId, []).get(b.bankTxnId)).push(b); });
    for (const t of lines) {
      bump('existingChecked');
      const problems = [];
      const flags = [];
      const myPays = payBy.get(t.id) || [];
      const myBills = billBy.get(t.id) || [];
      const amountP = P(t.amount);
      if (myPays.length) {
        const sumP = myPays.reduce((s, p) => s + P(p.amount), 0);
        if (sumP > amountP) { problems.push(`Receipts allocated to this line add up to ${fmtMoney(sumP / 100)}, more than the line itself (${fmtMoney(t.amount)}).`); flags.push('over-allocated'); }
        if (myPays.some((p) => p.invoice && p.invoice.status === 'Cancelled' && P(p.amount) > 0)) { problems.push('A receipt on this line sits on a cancelled invoice.'); flags.push('invoice-cancelled'); }
        if (t.type === 'Debit' && myPays.some((p) => P(p.amount) > 0)) { problems.push('A money-out line has customer receipts allocated to it.'); flags.push('wrong-direction'); }
      }
      if (myBills.length) {
        const sumP = myBills.reduce((s, b) => s + P(b.monthlyAmount) - P(b.tdsAmount), 0);
        if (Math.abs(sumP - amountP) > P(S.roundingRupees)) { problems.push(`Bills linked to this line add up to ${fmtMoney(sumP / 100)} but the bank line is ${fmtMoney(t.amount)}.`); flags.push('amount-mismatch'); }
        if (t.type === 'Credit') { problems.push('A money-in line is linked to an expense bill.'); flags.push('wrong-direction'); }
      }
      if (t.reconStatus === 'Reconciled' && !myPays.length && !myBills.length && !t.matchedInvoiceId && !t.category && !t.categoryKind && !t.createdBillId && !t.billLinks && !loanLinks.has(t.id) && !t.reversalOfId) {
        problems.push('Marked Reconciled, but nothing is linked to it.'); flags.push('reconciled-without-record');
      }
      if (!problems.length) continue;
      bump('flaggedExisting');
      if (flags.includes('amount-mismatch') || flags.includes('over-allocated')) bump('mismatches');
      const c = CORE.blank();
      c.kind = 'flag'; c.band = 'low'; c.flags = flags; c.reasons = problems; c.targetType = 'existing'; c.targetLabel = 'Existing match to review';
      c.bookAmount = null; c.allocated = null;
      await upsertProposal(t, c, { runId, source });
    }
    // possible duplicate lines among the reconciled ones (same account, day, direction, amount and narration)
    return tally;
  }

  // ---- scope helpers ---------------------------------------------------------------------------------
  async function scopeWhere({ bankAccountId, from, to }) {
    const and = [];
    if (bankAccountId && bankAccountId !== 'All') {
      const accs = await ensureAccounts();
      and.push(bankAccountId === accs[0].id ? { OR: [{ bankAccountId }, { bankAccountId: null }] } : { bankAccountId });
    }
    if (from) and.push({ date: { gte: String(from).slice(0, 10) } });
    if (to) and.push({ date: { lte: String(to).slice(0, 10) } });
    return and;
  }
  const OPEN_WHERE = { excluded: false, reconStatus: 'Unmatched', category: null, categoryKind: null, createdBillId: null, billLinks: null };
  const DONE_WHERE = {
    excluded: false,
    OR: [{ reconStatus: { in: ['Reconciled', 'Matched'] } }, { category: { not: null } }, { categoryKind: { not: null } }, { billLinks: { not: null } }, { createdBillId: { not: null } }],
  };

  async function previewScope(scope) {
    const and = await scopeWhere(scope);
    const [toScan, toCheck, accounts, statements, invoices, expenses, receipts, range, opens, imports] = await Promise.all([
      prisma.bankTransaction.count({ where: { ...OPEN_WHERE, AND: and } }),
      prisma.bankTransaction.count({ where: { ...DONE_WHERE, AND: and } }),
      ensureAccounts(),
      prisma.bankImport.count({ where: scope.bankAccountId && scope.bankAccountId !== 'All' ? { bankAccountId: scope.bankAccountId } : {} }),
      prisma.invoice.findMany({ where: { NOT: { status: 'Cancelled' } }, select: { amount: true, gst: true, tds: true, receivedAmount: true, creditedAmount: true, adjustedAmount: true, debitedAmount: true, status: true } }),
      prisma.officeExpense.count({ where: { bankTxnId: null, approvalStatus: { not: 'REJECTED' } } }),
      prisma.invoicePayment.count({ where: { bankTxnId: null, amount: { gt: 0 } } }),
      prisma.bankTransaction.aggregate({ where: { AND: and }, _min: { date: true }, _max: { date: true } }),
      prisma.bankTransaction.groupBy({ by: ['type'], where: { ...OPEN_WHERE, AND: and }, _sum: { amount: true } }),
      prisma.bankImport.count({}),
    ]);
    const acc = scope.bankAccountId && scope.bankAccountId !== 'All' ? accounts.filter((a) => a.id === scope.bankAccountId) : accounts;
    return {
      bankAccounts: acc.length, statements, importsTotal: imports, toScan, toCheck,
      openInvoices: invoices.filter((i) => RM.isOpen(i)).length, unlinkedBills: expenses, unlinkedReceipts: receipts,
      dateFrom: range._min.date, dateTo: range._max.date,
      debitTotal: Number((opens.find((o) => o.type === 'Debit') || { _sum: { amount: 0 } })._sum.amount || 0),
      creditTotal: Number((opens.find((o) => o.type === 'Credit') || { _sum: { amount: 0 } })._sum.amount || 0),
    };
  }

  // ---- the run engine -------------------------------------------------------------------------------
  const active = new Map(); // runId -> { cancel }

  async function getRun(id) {
    const r = (await q('SELECT * FROM "ReconRun" WHERE "id" = ?', id))[0];
    if (!r) return null;
    const live = active.has(r.id);
    return {
      ...r, dryRun: !!r.dryRun, autoApply: !!r.autoApply, counts: jparse(r.counts, {}), preview: jparse(r.preview, null),
      // a run whose worker is gone (restart / crash) is shown as Paused - never as a Running that will not move
      status: ['Running', 'Queued'].includes(r.status) && !live ? 'Paused' : r.status,
      interrupted: ['Running', 'Queued'].includes(r.status) && !live,
      percent: r.total ? Math.min(100, Math.round((r.processed / r.total) * 100)) : (r.status === 'Done' ? 100 : 0),
    };
  }

  async function sweepInterrupted() {
    // runs left 'Running' by a process that no longer exists become Paused (resumable)
    const rows = await q('SELECT "id" FROM "ReconRun" WHERE "status" IN (\'Running\',\'Queued\')');
    for (const r of rows) if (!active.has(r.id)) await x('UPDATE "ReconRun" SET "status"=\'Paused\',"error"=?,"updatedAt"=? WHERE "id"=?', 'Interrupted - press Resume to continue from where it stopped.', nowIso(), r.id);
  }

  async function runLoop(runId) {
    const handle = active.get(runId);
    try {
      let run = await getRun(runId);
      await x('UPDATE "ReconRun" SET "status"=\'Running\',"error"=NULL,"startedAt"=COALESCE("startedAt",?),"updatedAt"=? WHERE "id"=?', nowIso(), nowIso(), runId);
      const S = await getSettings();
      const scope = { bankAccountId: run.bankAccountId, from: run.fromDate, to: run.toDate };
      const and = await scopeWhere(scope);
      const req = { user: { id: run.startedById, name: run.startedByName || 'Auto-reconcile' } };
      let counts = run.counts || {};
      let cursor = run.cursor || 'A|';
      for (;;) {
        if (handle.cancel) { await x('UPDATE "ReconRun" SET "status"=\'Cancelled\',"counts"=?,"finishedAt"=?,"updatedAt"=? WHERE "id"=?', JSON.stringify(counts), nowIso(), nowIso(), runId); return; }
        const stage = cursor[0];
        const [, d, i] = cursor.split('|');
        const after = d ? [{ OR: [{ date: { gt: d } }, { date: d, id: { gt: i } }] }] : [];
        const where = { ...(stage === 'A' ? OPEN_WHERE : DONE_WHERE), AND: [...and, ...after] };
        const rows = await prisma.bankTransaction.findMany({ where, orderBy: [{ date: 'asc' }, { id: 'asc' }], take: S.batchSize });
        if (!rows.length) {
          if (stage === 'A') { cursor = 'B|'; continue; }
          break;
        }
        if (stage === 'A') await processLines(rows, { req, apply: !run.dryRun && !!run.autoApply, source: 'historical', runId, settings: S, counts });
        else await checkExistingLines(rows, { runId, counts });
        const last = rows[rows.length - 1];
        cursor = `${stage}|${last.date}|${last.id}`;
        await x('UPDATE "ReconRun" SET "processed"="processed"+?,"cursor"=?,"counts"=?,"updatedAt"=? WHERE "id"=?', rows.length, cursor, JSON.stringify(counts), nowIso(), runId);
        await new Promise((r) => setImmediate(r)); // let other requests breathe between batches
      }
      if (!run.dryRun && run.autoApply) {
        // learnt narration rules (vendor / category / payee) and hand loans already linked before: the same passes an import runs
        const accs = await ensureAccounts();
        const wanted = run.bankAccountId ? accs.filter((a) => a.id === run.bankAccountId) : accs;
        for (const a of wanted) {
          try {
            counts.autoFiled = (counts.autoFiled || 0) + (await H.autoFileDebits(a.id, accs[0].id, req)).filed;
          } catch (e) { counts.autoFiledError = String(e.message).slice(0, 120); }
        }
        try { counts.loansLinked = (await H.autoLinkLoans(req)).linked; } catch (e) { counts.autoFiledError = String(e.message).slice(0, 120); }
      }
      counts.debit = (counts.debitPaise || 0) / 100;
      counts.credit = (counts.creditPaise || 0) / 100;
      await x('UPDATE "ReconRun" SET "status"=\'Done\',"counts"=?,"finishedAt"=?,"updatedAt"=? WHERE "id"=?', JSON.stringify(counts), nowIso(), nowIso(), runId);
      await ev({ runId, action: run.dryRun ? 'Dry run finished' : 'Reconciliation run finished', auto: true, req, toValue: JSON.stringify({ checked: counts.checked, autoMatched: counts.autoMatched || 0, wouldAutoMatch: counts.wouldAutoMatch || 0, suggested: counts.suggested || 0 }) });
      await logAudit({ userId: run.startedById, action: run.dryRun ? 'Bank dry run finished' : 'Bank reconciliation run finished', entity: 'ReconRun', entityId: runId, toValue: `${counts.checked || 0} lines, ${counts.autoMatched || 0} matched automatically, ${(counts.wouldAutoMatch || 0) + (counts.suggested || 0)} suggested` });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[autoRecon] run failed', e);
      await x('UPDATE "ReconRun" SET "status"=\'Failed\',"error"=?,"updatedAt"=? WHERE "id"=?', String(e.message || e).slice(0, 400), nowIso(), runId).catch(() => {});
    } finally {
      active.delete(runId);
    }
  }

  function launch(runId) {
    active.set(runId, { cancel: false });
    setImmediate(() => { runLoop(runId); });
  }

  async function createRun({ dryRun, bankAccountId, from, to }, req) {
    await sweepInterrupted();
    if (active.size) throw new Http(409, 'Another reconciliation run is still going. Wait for it to finish (or cancel it).');
    const S = await getSettings();
    const scope = { bankAccountId: bankAccountId && bankAccountId !== 'All' ? bankAccountId : null, from: from || null, to: to || null };
    for (const d of [scope.from, scope.to]) if (d && !BIC.isRealDate(d)) throw new Http(400, 'Dates must look like 2026-04-01.');
    if (scope.from && scope.to && scope.from > scope.to) throw new Http(400, 'The "from" date is after the "to" date.');
    const preview = await previewScope(scope);
    const id = newId();
    await x(
      'INSERT INTO "ReconRun" ("id","dryRun","bankAccountId","fromDate","toDate","status","autoApply","total","processed","counts","preview","startedById","startedByName","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, dryRun ? 1 : 0, scope.bankAccountId, scope.from, scope.to, 'Queued', !dryRun && S.autoReconcile ? 1 : 0, preview.toScan + preview.toCheck, 0, '{}', JSON.stringify(preview), req.user.id, whoName(req), nowIso(), nowIso(),
    );
    await ev({ runId: id, action: dryRun ? 'Dry run started' : 'Reconciliation run started', req, toValue: JSON.stringify(scope), reason: !dryRun && !S.autoReconcile ? 'Auto-reconcile is OFF: suggestions only, nothing will be applied' : null });
    await logAudit({ userId: req.user.id, action: dryRun ? 'Bank dry run started' : 'Bank reconciliation run started', entity: 'ReconRun', entityId: id, toValue: `${preview.toScan} lines to scan` });
    launch(id);
    return getRun(id);
  }

  // ---- unreconcile -------------------------------------------------------------------------------------
  async function unreconcile(txnId, reason, req) {
    const why = String(reason || '').trim();
    if (why.length < 3) throw new Http(400, 'Please give a reason (at least 3 characters).');
    return withLock(txnId, async () => {
      const txn = await prisma.bankTransaction.findUnique({ where: { id: txnId } });
      if (!txn) throw new Http(404, 'Transaction not found.');
      const state = txnState(txn);
      if (state === 'Reversed') throw new Http(400, 'This line was reversed (bounced / returned) and cannot be unreconciled here.');
      if (periodClosed(txn.date, await closedUpTo()) && !isAdminReq(req)) throw new Http(403, 'This date is in a closed period. Only an Admin may reverse it.');
      const loan = await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } });
      if (txn.categoryKind === 'refund') throw new Http(400, 'This line pays a client refund - use "Undo refund link" so the credit note goes back to refund due.');
      const before = { state, reconStatus: txn.reconStatus, matchedInvoiceId: txn.matchedInvoiceId, category: txn.category, categoryKind: txn.categoryKind, excess: txn.excess };
      const pays = await prisma.invoicePayment.findMany({ where: { bankTxnId: txn.id, amount: { gt: 0 } } });
      const restored = { invoices: [], bills: [] };
      if (pays.length) {
        try {
          await prisma.$transaction(async (tx) => {
            for (const p of pays) {
              const inv = await tx.invoice.findUnique({ where: { id: p.invoiceId }, select: { invoiceNumber: true, status: true } });
              const out = await recon.deallocateIn(tx, txn.id, p.id, req);
              restored.invoices.push({ invoice: (inv && inv.invoiceNumber) || p.invoiceId, was: inv && inv.status, amount: p.amount, now: out.invoice ? 'restored' : '' });
            }
          }, { timeout: 60000, maxWait: 15000 });
        } catch (e) { if (e.http) throw new Http(e.http, e.message, e.extra); throw e; }
      }
      // an automatic match that FILED a bill from this line, or linked it to a hand loan: undo = take back exactly what the match made
      if (txn.createdBillId) {
        const made = await prisma.officeExpense.findUnique({ where: { id: txn.createdBillId } });
        if (made && made.bankTxnId === txn.id) {
          try { if (made.proofFile) require('../utils/attachments').remove(made.proofFile); } catch (e) { /* proof already gone */ } // eslint-disable-line global-require
          await prisma.officeExpense.delete({ where: { id: made.id } });
          restored.bills.push({ bill: made.expenseCode || made.id, removed: 'bill made from this line was taken back' });
        }
      }
      if (loan) { await prisma.handLoanLink.delete({ where: { id: loan.id } }); restored.loan = 'hand-loan link removed'; }
      const fresh = await prisma.bankTransaction.findUnique({ where: { id: txn.id } });
      if (fresh.billLinks) {
        for (const l of jparse(fresh.billLinks, [])) {
          const bill = await prisma.officeExpense.findUnique({ where: { id: l.id } });
          if (!bill || bill.bankTxnId !== txn.id) continue;
          await prisma.officeExpense.update({
            where: { id: bill.id },
            data: {
              bankTxnId: null, approvalStatus: l.approvalStatus || bill.approvalStatus, paidStatus: l.paidStatus || bill.paidStatus, paidAt: l.paidAt ? new Date(l.paidAt) : null, paidById: l.paidById || null, paymentDate: l.paymentDate || null,
              // a bill the match moved to Paid also gets back the sign-off it had (none, when it was Pending)
              ...(l.movedToPaid ? { approvedById: l.approvedById || null, approvedAt: l.approvedAt ? new Date(l.approvedAt) : null, approvedBy: l.approvedBy || null } : {}),
            },
          });
          restored.bills.push({ bill: bill.expenseCode || bill.id, status: l.approvalStatus || bill.approvalStatus });
        }
      }
      // a transfer pair we tagged: free the opposite line as well
      const applied = await q('SELECT * FROM "ReconProposal" WHERE "txnId" = ? AND "status" = \'Applied\'', txn.id);
      for (const a of applied) {
        const act = jparse(a.action, null);
        if (act && act.type === 'tag' && act.peerId) {
          const peer = await prisma.bankTransaction.findUnique({ where: { id: act.peerId } });
          if (peer && peer.categoryKind === act.categoryKind && !peer.billLinks && !peer.createdBillId) {
            await prisma.bankTransaction.update({ where: { id: peer.id }, data: { category: null, categoryKind: null } });
            await ev({ txnId: peer.id, proposalId: a.id, action: 'Transfer tag removed (other side reversed)', req, reason: why });
          }
        }
      }
      await prisma.bankTransaction.update({
        where: { id: txn.id },
        data: {
          category: null, categoryKind: null, vendor: null, counterparty: null, billLinks: null, createdBillId: null, excess: null, matched: false, matchedInvoiceId: null, reconStatus: 'Unmatched', matchedBy: null, matchedDate: null, clientName: null,
        },
      });
      await x('UPDATE "ReconProposal" SET "status"=\'Reversed\',"decisionNote"=?,"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"updatedAt"=? WHERE "txnId"=? AND "status"=\'Applied\'', why, req.user.id, whoName(req), nowIso(), nowIso(), txn.id);
      await ev({ txnId: txn.id, action: 'Unreconciled', req, fromValue: JSON.stringify(before), toValue: JSON.stringify(restored), reason: why });
      await logAudit({ userId: req.user.id, action: 'Bank line unreconciled', entity: 'BankTransaction', entityId: txn.id, fromValue: JSON.stringify(before), toValue: JSON.stringify(restored), reason: why });
      return { ok: true, restored };
    });
  }

  // ---- the original uploaded statement, kept for audit -------------------------------------------------
  const STORED = /^[a-f0-9]{32}.(csv|xlsx|xls|txt|tsv|bin)$/;
  const originalsDir = () => {
    const base = process.env.UPLOAD_DIR || pathMod.join(os.homedir() || os.tmpdir(), '.teamlink-uploads');
    const d = pathMod.join(base, 'bank-statements');
    fs.mkdirSync(d, { recursive: true });
    return pathMod.resolve(d);
  };
  async function saveOriginal(importId, filename, buf) {
    if (!(await ready()) || !importId || !buf || !buf.length || buf.length > 25 * 1024 * 1024) return false;
    const ext = ((String(filename).match(/.(csv|xlsx|xls|txt|tsv)$/i) || [])[1] || 'bin').toLowerCase();
    const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(pathMod.join(originalsDir(), stored), buf, { mode: 0o600 });
    await x('UPDATE "BankImport" SET "originalFile"=?,"originalName"=? WHERE "id"=?', stored, String(filename).replace(/[\/:*?"<>|]/g, '_').slice(0, 200), importId);
    return true;
  }

  // ---- hooks used by the import and the "check again" button -----------------------------------------------
  // Suggest for new / waiting lines; apply HIGH ones only when the switch is ON.
  async function afterLines(lines, req, { source = 'import', forceSuggestOnly = false } = {}) {
    const S = await getSettings();
    const counts = {};
    await processLines(lines, { req, apply: S.autoReconcile && !forceSuggestOnly, source, settings: S, counts });
    return { settings: S, counts };
  }

  // ---- routes --------------------------------------------------------------------------------------------------
  function install(router) {
    router.use('/auto', async (req, res, next) => {
      if (await ready()) return next();
      return res.status(503).json({ error: 'Auto-Reconcile is not installed on this database yet (migration 20261014120000_bank_auto_recon is pending).', notReady: true });
    });
    const guard = (fn) => async (req, res) => {
      try { return await fn(req, res); } catch (e) {
        if (e && e.http) return res.status(e.http).json({ error: e.message, ...(e.extra || {}) });
        // eslint-disable-next-line no-console
        console.error('[bankAuto]', e);
        return res.status(500).json({ error: 'That did not work. Nothing was changed.' });
      }
    };

    // settings -------------------------------------------------------------------------
    router.get('/auto/settings', guard(async (req, res) => {
      res.json({ settings: await getSettings(), canEdit: isAdminReq(req), defaults: CORE.DEFAULT_SETTINGS });
    }));
    router.put('/auto/settings', guard(async (req, res) => {
      if (!isAdminReq(req)) return res.status(403).json({ error: 'Only an Admin or Super Admin can change these rules.' });
      const before = await getSettings();
      const b = req.body || {};
      const next = CORE.normaliseSettings({ ...before, ...b });
      await prisma.appSetting.upsert({
        where: { key: SETTINGS_KEY },
        create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedById: req.user.id, updatedByName: whoName(req) },
        update: { value: JSON.stringify(next), updatedById: req.user.id, updatedByName: whoName(req) },
      });
      if (next.dateToleranceDays !== before.dateToleranceDays) {
        await prisma.appSetting.upsert({
          where: { key: 'bank.dateToleranceDays' },
          create: { key: 'bank.dateToleranceDays', value: JSON.stringify(next.dateToleranceDays), updatedById: req.user.id, updatedByName: whoName(req) },
          update: { value: JSON.stringify(next.dateToleranceDays), updatedById: req.user.id, updatedByName: whoName(req) },
        });
      }
      const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
      if (changed.length) {
        await ev({ action: 'Rules changed', req, fromValue: JSON.stringify(Object.fromEntries(changed.map((k) => [k, before[k]]))), toValue: JSON.stringify(Object.fromEntries(changed.map((k) => [k, next[k]]))) });
        await logAudit({ userId: req.user.id, action: 'Auto-reconcile rules changed', entity: 'AppSetting', entityId: SETTINGS_KEY, fromValue: JSON.stringify(Object.fromEntries(changed.map((k) => [k, before[k]]))), toValue: JSON.stringify(Object.fromEntries(changed.map((k) => [k, next[k]]))) });
      }
      res.json({ settings: next });
    }));

    // dashboard --------------------------------------------------------------------------
    router.get('/auto/dashboard', guard(async (req, res) => {
      const accs = await ensureAccounts();
      const where = ['1=1'];
      const par = [];
      const acc = req.query.bankAccountId && req.query.bankAccountId !== 'All' ? String(req.query.bankAccountId) : null;
      if (acc) { where.push(acc === accs[0].id ? '(t."bankAccountId" = ? OR t."bankAccountId" IS NULL)' : 't."bankAccountId" = ?'); par.push(acc); }
      if (req.query.from) { where.push('t."date" >= ?'); par.push(String(req.query.from).slice(0, 10)); }
      if (req.query.to) { where.push('t."date" <= ?'); par.push(String(req.query.to).slice(0, 10)); }
      const W = where.join(' AND ');
      const rows = await q(
        `SELECT t."type" AS type,
          CASE WHEN t."reconStatus"='Ignored' OR t."excluded"=1 THEN 'ignored'
               WHEN t."reconStatus" IN ('Reconciled','Reversed') OR t."category" IS NOT NULL OR t."categoryKind" IS NOT NULL OR t."createdBillId" IS NOT NULL OR t."billLinks" IS NOT NULL OR h."id" IS NOT NULL
                    THEN (CASE WHEN a."id" IS NOT NULL THEN 'auto' WHEN t."type"='Credit' AND COALESCE(t."excess",0) > 0.5 THEN 'partial' ELSE 'manual' END)
               WHEN p."band" IN ('high','medium') THEN 'suggested'
               WHEN (p."id" IS NOT NULL AND p."candidates" IS NOT NULL) OR t."reviewReason" IS NOT NULL THEN 'review'
               ELSE 'unmatched' END AS bucket,
          COUNT(*) AS n, COALESCE(SUM(t."amount"),0) AS amt
         FROM "BankTransaction" t
         LEFT JOIN "HandLoanLink" h ON h."bankTxnId" = t."id"
         LEFT JOIN "ReconProposal" p ON p."txnId" = t."id" AND p."status" = 'Pending'
         LEFT JOIN "ReconProposal" a ON a."txnId" = t."id" AND a."status" = 'Applied' AND a."appliedMode" = 'auto'
         WHERE ${W} GROUP BY t."type", bucket`, ...par,
      );
      const by = {}; let total = 0;
      const sums = { reconDebit: 0, reconCredit: 0, openDebit: 0, openCredit: 0 };
      rows.forEach((r) => {
        by[r.bucket] = (by[r.bucket] || 0) + r.n; total += r.n;
        const isDone = ['auto', 'manual', 'partial'].includes(r.bucket);
        const isOpen = ['suggested', 'review', 'unmatched'].includes(r.bucket);
        if (isDone) sums[r.type === 'Debit' ? 'reconDebit' : 'reconCredit'] += r.amt;
        if (isOpen) sums[r.type === 'Debit' ? 'openDebit' : 'openCredit'] += r.amt;
      });
      const flagRows = await q(
        `SELECT
          SUM(CASE WHEN p."flags" LIKE '%potential-duplicate%' THEN 1 ELSE 0 END) AS dup,
          SUM(CASE WHEN p."flags" LIKE '%amount-mismatch%' OR p."flags" LIKE '%over-allocated%' THEN 1 ELSE 0 END) AS mismatch,
          SUM(CASE WHEN p."kind"='flag' THEN 1 ELSE 0 END) AS existing,
          SUM(CASE WHEN p."band"='high' THEN 1 ELSE 0 END) AS high,
          SUM(CASE WHEN p."band"='medium' THEN 1 ELSE 0 END) AS medium,
          SUM(CASE WHEN p."band"='low' THEN 1 ELSE 0 END) AS low
         FROM "ReconProposal" p JOIN "BankTransaction" t ON t."id" = p."txnId" WHERE p."status"='Pending' AND ${W}`, ...par,
      );
      const f = flagRows[0] || {};
      const dupLines = (await q(`SELECT COUNT(*) AS n FROM "BankTransaction" t WHERE ${W} AND (t."reviewReason" LIKE 'Possible duplicate%' OR t."reviewReason" LIKE 'Identical to another%')`, ...par))[0].n;
      const scanned = (await q('SELECT COALESCE(SUM("processed"),0) AS n FROM "ReconRun" WHERE "status" IN (\'Done\',\'Running\',\'Paused\') AND "dryRun" = 0'))[0].n;
      const lastRun = (await q('SELECT "id" FROM "ReconRun" ORDER BY "createdAt" DESC LIMIT 1'))[0];
      const imports = await q(
        `SELECT i."id", i."file", i."date", i."fromDate", i."toDate", i."lines", i."openingBalance", i."closingBalance", i."status", i."bankAccountId", i."recordedBy", i."originalFile" IS NOT NULL AS hasOriginal,
          (SELECT COUNT(*) FROM "BankTransaction" t WHERE t."importBatch" = i."id") AS inFile,
          (SELECT COUNT(*) FROM "BankTransaction" t WHERE t."importBatch" = i."id" AND t."excluded"=0 AND t."reconStatus"='Unmatched' AND t."category" IS NULL AND t."categoryKind" IS NULL AND t."createdBillId" IS NULL AND t."billLinks" IS NULL
             AND NOT EXISTS (SELECT 1 FROM "HandLoanLink" h WHERE h."bankTxnId" = t."id")) AS openLines,
          (SELECT COUNT(*) FROM "ReconProposal" p JOIN "BankTransaction" t ON t."id"=p."txnId" WHERE t."importBatch" = i."id" AND p."status"='Pending' AND p."kind"='flag') AS flagged
         FROM "BankImport" i ${acc ? 'WHERE i."bankAccountId" = ?' : ''} ORDER BY i."createdAt" DESC LIMIT 30`, ...(acc ? [acc] : []),
      );
      res.json({
        settings: await getSettings(),
        counts: {
          imported: total, historicalScanned: scanned, autoReconciled: by.auto || 0, manuallyReconciled: by.manual || 0, partiallyReconciled: by.partial || 0,
          suggested: by.suggested || 0, needsReview: by.review || 0, unmatched: by.unmatched || 0, ignored: by.ignored || 0,
          potentialDuplicates: Math.max(dupLines, f.dup || 0), amountMismatches: f.mismatch || 0, existingToReview: f.existing || 0,
          pendingHigh: f.high || 0, pendingMedium: f.medium || 0, pendingLow: f.low || 0,
          pendingReview: (by.suggested || 0) + (by.review || 0),
        },
        totals: { reconciledDebit: sums.reconDebit, reconciledCredit: sums.reconCredit, unreconciledDebit: sums.openDebit, unreconciledCredit: sums.openCredit },
        statements: imports.map((i) => ({
          ...i, hasOriginal: !!i.hasOriginal,
          completion: i.inFile === 0 ? 'No lines' : (i.openLines === 0 && i.flagged === 0 ? 'Fully reconciled' : `${i.inFile - i.openLines} of ${i.inFile} reconciled`),
          complete: i.inFile > 0 && i.openLines === 0 && i.flagged === 0,
        })),
        lastRun: lastRun ? await getRun(lastRun.id) : null,
      });
    }));

    // review queue / table --------------------------------------------------------------------------------
    router.get('/auto/queue', guard(async (req, res) => {
      const accs = await ensureAccounts();
      const Q = req.query;
      const where = ['1=1']; const par = [];
      const acc = Q.bankAccountId && Q.bankAccountId !== 'All' ? String(Q.bankAccountId) : null;
      if (acc) { where.push(acc === accs[0].id ? '(t."bankAccountId" = ? OR t."bankAccountId" IS NULL)' : 't."bankAccountId" = ?'); par.push(acc); }
      if (Q.from) { where.push('t."date" >= ?'); par.push(String(Q.from).slice(0, 10)); }
      if (Q.to) { where.push('t."date" <= ?'); par.push(String(Q.to).slice(0, 10)); }
      if (Q.type === 'Debit' || Q.type === 'Credit') { where.push('t."type" = ?'); par.push(Q.type); }
      if (Q.min) { where.push('t."amount" >= ?'); par.push(Number(Q.min)); }
      if (Q.max) { where.push('t."amount" <= ?'); par.push(Number(Q.max)); }
      if (Q.importId) { where.push('t."importBatch" = ?'); par.push(String(Q.importId)); }
      const like = (col, v) => { where.push(`${col} LIKE ? ESCAPE '\\'`); par.push(`%${String(v).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); };
      if (Q.search) {
        const s = `%${String(Q.search).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push('(t."description" LIKE ? ESCAPE \'\\\' OR t."reference" LIKE ? ESCAPE \'\\\' OR t."externalId" LIKE ? ESCAPE \'\\\' OR t."vendor" LIKE ? ESCAPE \'\\\' OR t."clientName" LIKE ? ESCAPE \'\\\')');
        par.push(s, s, s, s, s);
      }
      if (Q.reference) { where.push('(t."reference" LIKE ? ESCAPE \'\\\' OR t."externalId" LIKE ? ESCAPE \'\\\')'); const s = `%${String(Q.reference).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; par.push(s, s); }
      if (Q.party) { where.push('(t."vendor" = ? OR t."clientName" = ? OR p."party" = ?)'); par.push(Q.party, Q.party, Q.party); }
      if (Q.number) like('p."targetLabel"', Q.number);
      if (Q.kind) { where.push('p."kind" = ?'); par.push(Q.kind); }
      if (Q.category) { where.push('(t."category" = ? OR p."targetLabel" = ?)'); par.push(Q.category, Q.category); }
      if (Q.band && ['high', 'medium', 'low'].includes(Q.band)) { where.push('p."band" = ? AND p."status" = \'Pending\''); par.push(Q.band); }
      const doneSql = '(t."reconStatus" IN (\'Reconciled\',\'Reversed\') OR t."category" IS NOT NULL OR t."categoryKind" IS NOT NULL OR t."createdBillId" IS NOT NULL OR t."billLinks" IS NOT NULL OR h."id" IS NOT NULL)';
      const status = String(Q.status || '');
      if (status === 'reconciled') where.push(doneSql);
      else if (status === 'auto') where.push(`${doneSql} AND a."id" IS NOT NULL`);
      else if (status === 'open') where.push(`NOT ${doneSql} AND t."reconStatus" <> 'Ignored' AND t."excluded" = 0`);
      else if (status === 'suggested') where.push(`NOT ${doneSql} AND p."band" IN ('high','medium')`);
      else if (status === 'review') where.push(`NOT ${doneSql} AND (p."band" = 'low' AND p."candidates" IS NOT NULL OR t."reviewReason" IS NOT NULL) AND (p."band" IS NULL OR p."band" = 'low')`);
      else if (status === 'unmatched') where.push(`NOT ${doneSql} AND t."reconStatus" <> 'Ignored' AND t."excluded" = 0 AND (p."band" IS NULL OR (p."band" = 'low' AND p."candidates" IS NULL)) AND t."reviewReason" IS NULL`);
      else if (status === 'duplicate') where.push('(t."reviewReason" LIKE \'Possible duplicate%\' OR t."reviewReason" LIKE \'Identical to another%\' OR p."flags" LIKE \'%potential-duplicate%\')');
      else if (status === 'mismatch') where.push('(p."flags" LIKE \'%amount-mismatch%\' OR p."flags" LIKE \'%over-allocated%\')');
      else if (status === 'existing') where.push('p."kind" = \'flag\'');
      else if (status === 'ignored') where.push('(t."reconStatus" = \'Ignored\' OR t."excluded" = 1)');
      if (Q.proof === 'yes') where.push(`(${doneSql})`); else if (Q.proof === 'no') where.push(`NOT ${doneSql}`);
      const W = where.join(' AND ');
      const sortCols = { date: 't."date"', amount: 't."amount"', type: 't."type"', band: 'p."band"', description: 't."description"' };
      const sortCol = sortCols[Q.sort] || 't."date"';
      const dir = Q.dir === 'asc' ? 'ASC' : 'DESC';
      const per = Math.min(200, Math.max(10, Number(Q.per) || 50));
      const page = Math.max(0, Number(Q.page) || 0);
      const FROM = `FROM "BankTransaction" t
        LEFT JOIN "HandLoanLink" h ON h."bankTxnId" = t."id"
        LEFT JOIN "ReconProposal" p ON p."id" = (SELECT p2."id" FROM "ReconProposal" p2 WHERE p2."txnId" = t."id" AND p2."status" IN ('Pending','Applied','Rejected')
            ORDER BY CASE p2."status" WHEN 'Pending' THEN 0 WHEN 'Applied' THEN 1 ELSE 2 END, p2."createdAt" DESC LIMIT 1)
        LEFT JOIN "ReconProposal" a ON a."id" = (SELECT a2."id" FROM "ReconProposal" a2 WHERE a2."txnId" = t."id" AND a2."status" = 'Applied' AND a2."appliedMode" = 'auto' LIMIT 1)
        WHERE ${W}`;
      const total = (await q(`SELECT COUNT(*) AS n ${FROM}`, ...par))[0].n;
      const rows = await q(
        `SELECT t."id", t."date", t."valueDate", t."description", t."type", t."amount", t."balance", t."reference", t."externalId", t."reconStatus", t."excluded", t."category", t."categoryKind", t."vendor", t."clientName",
           t."bankAccountId", t."excess", t."reviewReason", t."matchedBy", t."importBatch", t."billLinks", t."createdBillId", h."id" AS loanId,
           p."id" AS pid, p."kind" AS pkind, p."band" AS pband, p."status" AS pstatus, p."rule" AS prule, p."targetType", p."targetIds", p."targetLabel", p."party", p."bookAmount", p."allocated", p."difference",
           p."reasons", p."flags", p."candidates", p."action" IS NOT NULL AS actionable, p."appliedMode", p."decisionNote", a."id" AS autoId
         ${FROM} ORDER BY ${sortCol} ${dir}, t."id" ${dir} LIMIT ? OFFSET ?`, ...par, per, page * per,
      );
      // what each reconciled line is linked to (invoice / bill numbers and allocated amounts)
      const doneIds = rows.filter((r) => r.reconStatus === 'Reconciled' || r.category || r.categoryKind || r.billLinks || r.loanId).map((r) => r.id);
      const pays = doneIds.length ? await prisma.invoicePayment.findMany({ where: { bankTxnId: { in: doneIds } }, select: { bankTxnId: true, amount: true, invoice: { select: { invoiceNumber: true, client: { select: { name: true } } } } } }) : [];
      const bills = doneIds.length ? await prisma.officeExpense.findMany({ where: { bankTxnId: { in: doneIds } }, select: { bankTxnId: true, monthlyAmount: true, tdsAmount: true, expenseCode: true, billNumber: true, vendor: true, category: true } }) : [];
      const links = new Map();
      pays.forEach((p) => { const l = links.get(p.bankTxnId) || { type: 'Invoice', nums: [], party: new Set(), alloc: 0 }; l.nums.push(p.invoice && p.invoice.invoiceNumber); if (p.invoice && p.invoice.client) l.party.add(p.invoice.client.name); l.alloc += P(p.amount); links.set(p.bankTxnId, l); });
      bills.forEach((b) => { const l = links.get(b.bankTxnId) || { type: 'Expense / bill', nums: [], party: new Set(), alloc: 0 }; l.nums.push(b.expenseCode || b.billNumber); if (b.vendor || b.category) l.party.add(b.vendor || b.category); l.alloc += P(b.monthlyAmount) - P(b.tdsAmount); links.set(b.bankTxnId, l); });
      const AUTO_ACTIONS = ['Bank line matched automatically + proof attached', 'Bank line reconciled automatically', 'Payment allocated automatically', 'Hand loan lines linked automatically'];
      const auditAuto = new Map();
      if (doneIds.length) {
        const aud = await prisma.auditLog.findMany({ where: { entity: 'BankTransaction', entityId: { in: doneIds }, action: { in: AUTO_ACTIONS } }, orderBy: { createdAt: 'asc' }, select: { entityId: true, toValue: true, reason: true } });
        aud.forEach((a) => auditAuto.set(a.entityId, [a.toValue, a.reason].filter(Boolean).join(' - ')));
      }
      res.json({
        total, page, per,
        rows: rows.map((r) => {
          const isDone = r.reconStatus === 'Reconciled' || r.reconStatus === 'Reversed' || r.category || r.categoryKind || r.billLinks || r.createdBillId || r.loanId;
          const link = links.get(r.id);
          const flags = jparse(r.flags, []);
          const dup = flags.includes('potential-duplicate') || /^(Possible duplicate|Identical to another)/.test(r.reviewReason || '');
          let state;
          if (r.reconStatus === 'Ignored' || r.excluded) state = 'Ignored';
          else if (isDone) state = (r.autoId || (auditAuto.has(r.id) && r.reconStatus !== 'Reversed')) ? 'Reconciled automatically' : (r.reconStatus === 'Reversed' ? 'Reversed' : (r.type === 'Credit' && r.excess > 0.5 ? 'Partly reconciled' : 'Reconciled'));
          else if (r.pstatus === 'Pending' && ['high', 'medium'].includes(r.pband)) state = 'Suggested - needs your OK';
          else if (r.pstatus === 'Pending' && r.pkind === 'flag') state = 'Existing match to review';
          else if (dup) state = 'Possible duplicate';
          else if ((r.pstatus === 'Pending' && r.candidates) || r.reviewReason) state = 'Needs review';
          else state = 'Unmatched';
          const matchedType = isDone
            ? (link ? link.type : (r.loanId ? 'Hand loan' : (r.categoryKind === 'transfer' ? 'Internal transfer' : (r.category || r.categoryKind || null))))
            : (r.pstatus === 'Pending' ? r.targetType : null);
          return {
            id: r.id, date: r.date, valueDate: r.valueDate, description: r.description, reference: r.reference || r.externalId || null, type: r.type, amount: r.amount, debit: r.type === 'Debit' ? r.amount : null, credit: r.type === 'Credit' ? r.amount : null, balance: r.balance,
            suggestedCategory: r.pstatus === 'Pending' ? (r.pkind === 'charge' ? r.targetLabel : (r.pkind === 'expense' ? r.party : null)) : null,
            matchedType, number: isDone ? (link ? link.nums.filter(Boolean).join(', ') : null) : (r.pstatus === 'Pending' ? r.targetLabel : null),
            party: isDone ? (link ? [...link.party].join(', ') : (r.vendor || r.clientName || null)) : (r.pstatus === 'Pending' ? r.party : null),
            bookAmount: r.pstatus === 'Pending' ? r.bookAmount : null,
            allocated: isDone ? (link ? link.alloc / 100 : null) : (r.pstatus === 'Pending' ? r.allocated : null),
            difference: isDone ? (link ? (P(r.amount) - link.alloc) / 100 : null) : (r.pstatus === 'Pending' ? r.difference : null),
            band: r.pstatus === 'Pending' ? r.pband : (r.autoId ? 'high' : null), state, rule: r.prule, kind: r.pkind,
            reasons: r.pstatus === 'Pending' || r.pstatus === 'Applied' || r.pstatus === 'Rejected' ? jparse(r.reasons, []) : [], flags,
            proposalId: r.pstatus === 'Pending' ? r.pid : null, actionable: r.pstatus === 'Pending' && !!r.actionable, rejected: r.pstatus === 'Rejected',
            proof: !!isDone, reviewReason: r.reviewReason || null, bankAccountId: r.bankAccountId,
            autoReason: isDone && (r.autoId || auditAuto.has(r.id)) ? (r.autoId ? jparse(r.reasons, []).join(' | ') : auditAuto.get(r.id)) : null,
          };
        }),
      });
    }));

    router.get('/auto/options', guard(async (req, res) => {
      const [accounts, vendors, clients, parties, cats, imports] = await Promise.all([
        ensureAccounts(),
        q('SELECT "vendor" AS v, COUNT(*) AS n FROM "BankTransaction" WHERE "vendor" IS NOT NULL AND "vendor" <> \'\' GROUP BY "vendor" ORDER BY n DESC LIMIT 300'),
        q('SELECT "clientName" AS v, COUNT(*) AS n FROM "BankTransaction" WHERE "clientName" IS NOT NULL AND "clientName" <> \'\' GROUP BY "clientName" ORDER BY n DESC LIMIT 300'),
        q('SELECT "party" AS v, COUNT(*) AS n FROM "ReconProposal" WHERE "party" IS NOT NULL AND "party" <> \'\' AND "status" = \'Pending\' GROUP BY "party" ORDER BY n DESC LIMIT 300'),
        prisma.expenseCategory.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }).catch(() => []),
        q('SELECT "id", "file", "date", "fromDate", "toDate" FROM "BankImport" ORDER BY "createdAt" DESC LIMIT 60'),
      ]);
      const merge = new Map();
      [...vendors, ...clients, ...parties].forEach((r) => merge.set(r.v, (merge.get(r.v) || 0) + r.n));
      res.json({
        accounts: accounts.map((a) => ({ id: a.id, label: `${a.bank}${a.accNo ? ` ****${String(a.accNo).slice(-4)}` : ''}${a.name ? ` - ${a.name}` : ''}` })),
        parties: [...merge.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n })),
        categories: cats.map((c) => c.name), statements: imports,
      });
    }));

    // bills not yet tied to any bank line (for matching a payment by hand) ------------------------------------------
    router.get('/auto/open-bills', guard(async (req, res) => {
      const needle = RM.norm(req.query.q || '');
      const rows = await prisma.officeExpense.findMany({ where: { bankTxnId: null, approvalStatus: { not: 'REJECTED' }, entryKind: { not: 'hand' } }, orderBy: { expenseDate: 'desc' }, take: 600 });
      const list = rows.filter((b) => !needle || RM.norm(`${b.expenseCode} ${b.billNumber} ${b.vendor} ${b.category} ${b.description}`).includes(needle)).slice(0, 100);
      res.json({
        rows: list.map((b) => ({
          id: b.id, code: b.expenseCode || b.billNumber || null, vendor: b.vendor || null, category: b.category, net: ROUND(RM.expenseNetP(b) / 100), date: b.paymentDate || b.expenseDate || null, approval: b.approvalStatus, canLink: b.approvalStatus !== 'REJECTED',
        })),
      });
    }));

    // one line: suggestion + evidence + candidates + history ------------------------------------------------------
    router.get('/auto/txn/:id', guard(async (req, res) => {
      const txn = await prisma.bankTransaction.findUnique({ where: { id: req.params.id } });
      if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
      const [proposals, events, detail] = await Promise.all([
        q('SELECT * FROM "ReconProposal" WHERE "txnId" = ? ORDER BY "createdAt" DESC LIMIT 15', txn.id),
        q('SELECT * FROM "ReconEvent" WHERE "txnId" = ? ORDER BY "at" DESC LIMIT 60', txn.id),
        recon.lineDetail(txn.id).catch(() => null),
      ]);
      const live = proposals.find((p) => p.status === 'Pending') || null;
      const cands = live ? jparse(live.candidates, {}) || {} : {};
      const candInvoices = cands.invoiceIds && cands.invoiceIds.length
        ? (await prisma.invoice.findMany({ where: { id: { in: cands.invoiceIds.slice(0, 20) } }, include: { client: { select: { name: true } } } })).map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, client: i.client && i.client.name, outstanding: ROUND(RM.outstandingP(i) / 100), invoiceDate: i.invoiceDate, dueDate: i.dueDate }))
        : [];
      const candBills = cands.billIds && cands.billIds.length
        ? (await prisma.officeExpense.findMany({ where: { id: { in: cands.billIds.slice(0, 20) } } })).map((b) => ({ id: b.id, code: b.expenseCode || b.billNumber, vendor: b.vendor, category: b.category, net: ROUND(RM.expenseNetP(b) / 100), date: b.paymentDate || b.expenseDate, approval: b.approvalStatus }))
        : [];
      const norm = (p) => ({ ...p, action: jparse(p.action, null), reasons: jparse(p.reasons, []), flags: jparse(p.flags, []), targetIds: jparse(p.targetIds, []), candidates: jparse(p.candidates, null), previous: jparse(p.previous, null) });
      const loanLink = await prisma.handLoanLink.findUnique({ where: { bankTxnId: txn.id } });
      const isDone = txn.reconStatus === 'Reconciled' || !!(txn.category || txn.categoryKind || txn.billLinks || txn.createdBillId || loanLink);
      const audAuto = isDone ? await prisma.auditLog.findFirst({ where: { entity: 'BankTransaction', entityId: txn.id, action: { in: ['Bank line matched automatically + proof attached', 'Bank line reconciled automatically', 'Payment allocated automatically', 'Hand loan lines linked automatically'] } }, orderBy: { createdAt: 'asc' } }) : null;
      const autoReason = !isDone ? null : (proposals.find((p) => p.status === 'Applied' && p.appliedMode === 'auto') ? jparse(proposals.find((p) => p.status === 'Applied' && p.appliedMode === 'auto').reasons, []).join(' | ') : (audAuto ? [audAuto.toValue, audAuto.reason].filter(Boolean).join(' - ') : null));
      res.json({
        isDone, autoReason,
        txn: { id: txn.id, date: txn.date, valueDate: txn.valueDate, description: txn.description, type: txn.type, amount: txn.amount, reference: txn.reference, externalId: txn.externalId, balance: txn.balance, state: txnState(txn), reviewReason: txn.reviewReason },
        proposal: live ? norm(live) : null, history: proposals.map(norm), events, candidates: { invoices: candInvoices, bills: candBills }, detail,
        canApprove: true,
      });
    }));

    // actions -------------------------------------------------------------------------------------------------------
    router.post('/auto/proposals/:id/approve', guard(async (req, res) => {
      const out = await applyProposal(req.params.id, req, { mode: 'approved', parts: req.body && req.body.parts, note: req.body && req.body.note ? String(req.body.note).slice(0, 300) : null });
      res.json(out);
    }));
    router.post('/auto/proposals/:id/reject', guard(async (req, res) => {
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
      const p = (await q('SELECT * FROM "ReconProposal" WHERE "id" = ?', req.params.id))[0];
      if (!p) return res.status(404).json({ error: 'Suggestion not found.' });
      const n = await x('UPDATE "ReconProposal" SET "status"=\'Rejected\',"decidedById"=?,"decidedByName"=?,"decidedAt"=?,"decisionNote"=?,"updatedAt"=? WHERE "id"=? AND "status"=\'Pending\'', req.user.id, whoName(req), nowIso(), reason || null, nowIso(), p.id);
      if (n !== 1) return res.status(409).json({ error: `This suggestion was already handled (${p.status}).` });
      await ev({ txnId: p.txnId, proposalId: p.id, action: 'Suggestion rejected', req, fromValue: `${p.targetLabel || p.kind} (${p.band})`, reason });
      await logAudit({ userId: req.user.id, action: 'Bank suggestion rejected', entity: 'BankTransaction', entityId: p.txnId, fromValue: `${p.targetLabel || p.kind}`, reason });
      res.json({ ok: true });
    }));
    router.post('/auto/txn/:id/manual', guard(async (req, res) => {
      const b = req.body || {};
      const txn = await prisma.bankTransaction.findUnique({ where: { id: req.params.id } });
      if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
      const c = CORE.blank();
      c.band = 'medium';
      if (Array.isArray(b.parts) && b.parts.length) {
        if (txn.type !== 'Credit') return res.status(400).json({ error: 'Invoices can only be matched to money received.' });
        const invs = await prisma.invoice.findMany({ where: { id: { in: b.parts.map((p) => String(p.invoiceId)) } }, include: { client: { select: { name: true } } } });
        c.kind = 'invoice'; c.targetType = 'invoice'; c.targetIds = b.parts.map((p) => String(p.invoiceId)); c.targetLabel = invs.map((i) => i.invoiceNumber || i.id).join(', ');
        c.party = [...new Set(invs.map((i) => i.client && i.client.name).filter(Boolean))].join(', ');
        c.bookAmount = ROUND(invs.reduce((s, i) => s + Math.max(0, RM.outstandingP(i)), 0) / 100);
        c.allocated = ROUND(b.parts.reduce((s, p) => s + P(p.amount), 0) / 100);
        c.difference = ROUND((P(txn.amount) - P(c.allocated)) / 100);
        c.action = { type: 'settle', parts: b.parts.map((p) => ({ invoiceId: String(p.invoiceId), amount: Number(p.amount) })) };
      } else if (b.billId) {
        if (txn.type !== 'Debit') return res.status(400).json({ error: 'A bill can only be matched to money paid out.' });
        const bill = await prisma.officeExpense.findUnique({ where: { id: String(b.billId) } });
        if (!bill) return res.status(404).json({ error: 'Bill not found.' });
        c.kind = 'expense'; c.targetType = 'expense'; c.targetIds = [bill.id]; c.targetLabel = bill.expenseCode || bill.billNumber || bill.id; c.party = bill.vendor || bill.category;
        c.bookAmount = RM.expenseNetP(bill) / 100; c.allocated = txn.amount; c.difference = ROUND((P(txn.amount) - RM.expenseNetP(bill)) / 100);
        c.action = { type: 'linkBill', billId: bill.id };
      } else if (b.transfer) {
        c.kind = 'transfer'; c.targetType = 'transfer'; c.targetLabel = 'Internal transfer'; c.party = 'Own account'; c.action = { type: 'tag', categoryKind: 'transfer', category: null }; c.bookAmount = txn.amount; c.allocated = txn.amount; c.difference = 0;
      } else return res.status(400).json({ error: 'Choose what this line pays or what it is.' });
      c.reasons = [`Matched by hand by ${whoName(req)}`];
      c.rule = 0;
      // a hand match is allowed over a previous rejection / reversal: it is a person's decision
      const key = idemOf(txn.id, c);
      await x('DELETE FROM "ReconProposal" WHERE "idemKey" = ? AND "status" IN (\'Rejected\',\'Reversed\',\'Superseded\',\'Stale\')', key);
      const up = await upsertProposal(txn, c, { source: 'manual' });
      if (up.state === 'applied') return res.status(409).json({ error: 'This match is already applied.' });
      const out = await applyProposal(up.row.id, req, { mode: 'approved', note: 'Matched by hand' });
      res.json(out);
    }));
    router.post('/auto/txn/:id/flag', guard(async (req, res) => {
      const note = String((req.body && req.body.note) || '').trim().slice(0, 200);
      if (note.length < 3) return res.status(400).json({ error: 'Say what to investigate (at least 3 characters).' });
      const txn = await prisma.bankTransaction.findUnique({ where: { id: req.params.id } });
      if (!txn) return res.status(404).json({ error: 'Transaction not found.' });
      await prisma.bankTransaction.update({ where: { id: txn.id }, data: { reviewReason: `Flagged for investigation: ${note}` } });
      await ev({ txnId: txn.id, action: 'Flagged for investigation', req, fromValue: txn.reviewReason, toValue: note });
      await logAudit({ userId: req.user.id, action: 'Bank line flagged for investigation', entity: 'BankTransaction', entityId: txn.id, toValue: note });
      res.json({ ok: true });
    }));
    router.post('/auto/txn/:id/unreconcile', guard(async (req, res) => {
      res.json(await unreconcile(req.params.id, req.body && req.body.reason, req));
    }));

    // runs ------------------------------------------------------------------------------------------------------------
    router.get('/auto/preview', guard(async (req, res) => {
      res.json({ preview: await previewScope({ bankAccountId: req.query.bankAccountId, from: req.query.from, to: req.query.to }), settings: await getSettings() });
    }));
    router.get('/auto/runs', guard(async (req, res) => {
      await sweepInterrupted();
      const rows = await q('SELECT "id" FROM "ReconRun" ORDER BY "createdAt" DESC LIMIT 25');
      res.json({ runs: await Promise.all(rows.map((r) => getRun(r.id))) });
    }));
    router.get('/auto/runs/:id', guard(async (req, res) => {
      const r = await getRun(req.params.id);
      if (!r) return res.status(404).json({ error: 'Run not found.' });
      res.json({ run: r });
    }));
    router.post('/auto/runs', guard(async (req, res) => {
      const b = req.body || {};
      const run = await createRun({ dryRun: b.dryRun !== false, bankAccountId: b.bankAccountId, from: b.from, to: b.to }, req);
      res.status(202).json({ run });
    }));
    router.post('/auto/runs/:id/resume', guard(async (req, res) => {
      await sweepInterrupted();
      const r = await getRun(req.params.id);
      if (!r) return res.status(404).json({ error: 'Run not found.' });
      if (r.status === 'Done') return res.status(400).json({ error: 'This run already finished.' });
      if (active.has(r.id)) return res.status(409).json({ error: 'This run is still going.' });
      if (active.size) return res.status(409).json({ error: 'Another reconciliation run is still going.' });
      await ev({ runId: r.id, action: 'Run resumed', req, toValue: r.cursor });
      launch(r.id);
      res.json({ run: await getRun(r.id) });
    }));
    router.post('/auto/runs/:id/cancel', guard(async (req, res) => {
      const h = active.get(req.params.id);
      if (!h) return res.status(409).json({ error: 'This run is not running.' });
      h.cancel = true;
      res.json({ ok: true });
    }));
    router.get('/auto/imports/:id/original', guard(async (req, res) => {
      const row = (await q('SELECT "originalFile","originalName" FROM "BankImport" WHERE "id" = ?', req.params.id))[0];
      if (!row || !row.originalFile || !STORED.test(row.originalFile)) return res.status(404).json({ error: 'The original file of this statement was not kept (it was imported before Auto-Reconcile was installed).' });
      const full = pathMod.resolve(originalsDir(), row.originalFile);
      if (pathMod.dirname(full) !== originalsDir() || !fs.existsSync(full)) return res.status(404).json({ error: 'The original file is no longer on disk.' });
      await ev({ action: 'Original statement downloaded', req, toValue: row.originalName });
      return res.download(full, row.originalName || 'statement');
    }));
    router.get('/auto/events', guard(async (req, res) => {
      const rows = await q('SELECT * FROM "ReconEvent" ORDER BY "at" DESC LIMIT ?', Math.min(200, Number(req.query.limit) || 50));
      res.json({ events: rows });
    }));
  }

  return {
    install, ready, saveOriginal, getSettings, afterLines, processLines, applyProposal, unreconcile, createRun, getRun, previewScope, upsertProposal, classifyLine, sweepInterrupted, active, checkExistingLines,
  };
};
