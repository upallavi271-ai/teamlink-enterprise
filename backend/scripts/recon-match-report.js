#!/usr/bin/env node
// ---------------------------------------------------------------------------
// recon-match-report.js - run the NEW matching ladder (src/utils/reconMatch.js)
// over a database and REPORT what it would do. It never writes.
//
//   node scripts/recon-match-report.js --db <file> [--samples 10] [--json]
//
// For every bank line it prints a verdict:
//   AUTO       the ladder would match it by itself (exact, unambiguous), with the evidence
//   REVIEW     something is known but not certain -> "Needs Review", with the reason
//   NONE       nothing recognised -> stays Unmatched
// Lines that are ALREADY filed / posted (by the older matching) are re-judged as if
// they were still open (their own link is taken out of the picture first) and
// reported as "agrees" / "differs" / "would only suggest" so the new rules can be
// compared with what is already on file.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const dbArg = val('--db');
if (!dbArg) { console.error('Give the database with --db <path> (it is only read).'); process.exit(2); }
const dbPath = path.resolve(dbArg);
process.env.DATABASE_URL = 'file:' + dbPath.replace(/\\/g, '/');
const { PrismaClient } = require('@prisma/client');
const RM = require('../src/utils/reconMatch');
const prisma = new PrismaClient();
const SAMPLES = Number(val('--samples', 10));

(async () => {
  const [invoices, clients, aliases, payments, expenses, vendorRows, rules, txns, tolRow] = await Promise.all([
    prisma.invoice.findMany({ include: { client: { select: { id: true, name: true, legalName: true } }, candidate: { select: { name: true } } } }),
    prisma.client.findMany({ select: { id: true, name: true, legalName: true } }),
    prisma.clientAlias.findMany().catch(() => []),
    prisma.invoicePayment.findMany(),
    prisma.officeExpense.findMany(),
    prisma.officeVendor.findMany({ select: { name: true } }).catch(() => []),
    prisma.bankRule.findMany(),
    prisma.bankTransaction.findMany({ orderBy: { date: 'asc' } }),
    prisma.appSetting.findUnique({ where: { key: 'bank.dateToleranceDays' } }).catch(() => null),
  ]);
  const toleranceDays = tolRow ? Number(JSON.parse(tolRow.value)) : 3;
  const vendors = [...new Set([...vendorRows.map((v) => v.name), ...expenses.map((e) => String(e.vendor || '').trim())].filter((v) => v && v.length >= 5))];
  const credits = txns.filter((t) => t.type === 'Credit');
  const baseCtx = () => ({ invoices, clients, clientAliases: aliases, payments, expenses, vendors, rules, credits, toleranceDays });
  const handLinks = new Set((await prisma.handLoanLink.findMany({ select: { bankTxnId: true } })).map((l) => l.bankTxnId));

  const tally = { open: { AUTO: 0, REVIEW: 0, NONE: 0 }, filed: { agrees: 0, differs: 0, 'would only suggest': 0, 'would not match': 0 }, skipped: 0 };
  const samples = { AUTO: [], REVIEW: [], NONE: [], differs: [], agrees: [] };
  const money = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  const push = (k, o) => { if (samples[k].length < SAMPLES) samples[k].push(o); };

  for (const t of txns) {
    if (t.excluded || ['Ignored', 'Reversed'].includes(t.reconStatus) || handLinks.has(t.id)) { tally.skipped += 1; continue; }
    const payRows = payments.filter((p) => p.bankTxnId === t.id);
    const billRows = expenses.filter((e) => e.bankTxnId === t.id);
    const filedAs = t.reconStatus !== 'Unmatched' || t.category || t.categoryKind || t.createdBillId || t.billLinks;
    let ctx = baseCtx();
    if (filedAs) {
      // take this line's own link out of the picture, then judge it afresh
      if (t.type === 'Credit' && payRows.length) {
        ctx = {
          ...ctx,
          payments: payments.filter((p) => p.bankTxnId !== t.id),
          invoices: invoices.map((i) => {
            const mine = payRows.filter((p) => p.invoiceId === i.id);
            return mine.length ? { ...i, receivedAmount: Number(i.receivedAmount || 0) - mine.reduce((s, p) => s + Number(p.amount || 0), 0), status: i.status === 'Paid' ? 'Partially Paid' : i.status } : i;
          }),
        };
      } else if (t.type === 'Debit' && billRows.length) {
        ctx = { ...ctx, expenses: expenses.map((e) => (e.bankTxnId === t.id ? { ...e, bankTxnId: null } : e)) };
      } else { tally.skipped += 1; continue; } // filed as a category / transfer / loan with no bill or receipt to compare
    }
    const d = RM.decide(t, ctx);
    const verdict = d.confidence === 'auto' ? 'AUTO' : (d.confidence === 'review' ? 'REVIEW' : 'NONE');
    const brief = {
      line: `${t.date} ${t.type} ${money(t.amount)} ${String(t.description || '').slice(0, 70)}`, ref: t.reference || null,
    };
    if (!filedAs) {
      tally.open[verdict] += 1;
      push(verdict, { ...brief, rule: d.rule || null, evidence: d.evidence || null, reason: d.reviewReason || d.why || null });
    } else {
      let cmp = 'would not match';
      if (verdict === 'AUTO') {
        const a = d.action || {};
        const sameInv = a.type === 'settle' && new Set(a.parts.map((x) => x.invoiceId)).size === new Set(payRows.map((p) => p.invoiceId)).size && a.parts.every((x) => payRows.some((p) => p.invoiceId === x.invoiceId));
        const sameBill = a.type === 'linkBill' && billRows.some((b) => b.id === a.billId);
        const sameRcpt = a.type === 'linkPayment' && payRows.some((p) => p.id === a.paymentId);
        cmp = sameInv || sameBill || sameRcpt ? 'agrees' : 'differs';
      } else if (verdict === 'REVIEW') cmp = 'would only suggest';
      tally.filed[cmp] += 1;
      if (cmp === 'agrees' || cmp === 'differs') push(cmp, { ...brief, rule: d.rule, evidence: d.evidence, existing: t.type === 'Credit' ? payRows.map((p) => `${p.invoiceId}:${p.amount}`).join(',') : billRows.map((b) => b.expenseCode || b.id).join(',') });
    }
  }
  const out = { database: dbPath, lines: txns.length, toleranceDays, tally, samples };
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); } else {
    console.log('=== NEW MATCHING LADDER - REPORT ONLY (nothing is written) ===');
    console.log('database:', dbPath, '| bank lines:', txns.length, '| date tolerance:', toleranceDays, 'days');
    console.log('\nLINES STILL OPEN (never filed):', JSON.stringify(tally.open));
    console.log('LINES ALREADY FILED by the older matching, re-judged by the new ladder:', JSON.stringify(tally.filed));
    console.log('not judged (ignored / reversed / excluded / hand loan / filed as a category):', tally.skipped);
    Object.entries(samples).forEach(([k, list]) => {
      if (!list.length) return;
      console.log(`\n--- sample ${k} (${list.length}) ---`);
      list.forEach((s, i) => console.log(`${i + 1}. ${s.line}${s.ref ? ` [ref ${s.ref}]` : ''}${s.rule ? `  rule ${s.rule}` : ''}\n     ${s.evidence ? `evidence: ${s.evidence.join(' | ')}` : `why: ${s.reason || '-'}`}${s.existing ? `\n     already filed as: ${s.existing}` : ''}`));
    });
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
