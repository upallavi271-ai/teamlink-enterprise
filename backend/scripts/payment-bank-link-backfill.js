#!/usr/bin/env node
// ---------------------------------------------------------------------------
// EXISTING PAYMENTS -> THEIR BANK STATEMENT LINES (Accounts prompt 2026-10-27, "historical records").
//   cd backend
//   node scripts/payment-bank-link-backfill.js                 DRY RUN (default): reads only, prints what could be linked
//   node scripts/payment-bank-link-backfill.js --json out.json  ... and writes the full report to a file
//   node scripts/payment-bank-link-backfill.js --apply          links ONLY the reliable ones (see utils/paymentBankLink.js)
// Uses the database in DATABASE_URL (backend/.env), so on the live server it runs against the live database.
//
// For every payment (receipt row, amount > 0) of a Paid / Partially Paid invoice that has no bank line:
//   can link   exactly one imported credit of exactly the amount names its reference / the invoice number, and that line
//              fits no other receipt -> --apply links it (the receipt gets the line as its proof; no money moves; audited)
//   review     more than one line fits, or the line fits another receipt too -> listed, never linked
//   possible   only the amount matches a line near the date -> listed, never linked (the amount alone is never enough)
//   none       no imported line fits
// Invoices whose received amount has NO payment rows behind it ("evidence missing") are listed with any unclaimed line that
// names the invoice number - for a person to check. Nothing is created for them: no receipt is ever made up.
// Running it twice links nothing new (a linked receipt is skipped).
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');

const BACK = path.resolve(__dirname, '..');
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const PBL = require(path.join(BACK, 'src/utils/paymentBankLink'));
const RM = require(path.join(BACK, 'src/utils/reconMatch'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const jsonAt = argv.indexOf('--json');
const JSON_OUT = jsonAt >= 0 ? argv[jsonAt + 1] : null;
const R2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rs = (n) => `Rs ${R2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

(async () => {
  const invoices = await prisma.invoice.findMany({ where: { status: { not: 'Cancelled' } }, include: { payments: true, client: { select: { name: true } } } });
  const slim = invoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, status: i.status }));
  const credits = await prisma.bankTransaction.findMany({ where: { type: 'Credit', excluded: false, matched: false }, select: { id: true, date: true, amount: true, description: true, reference: true, reconStatus: true } });
  const report = { mode: APPLY ? 'apply' : 'dry-run', at: new Date().toISOString(), canLink: [], review: [], possible: [], none: [], evidenceMissing: [], linked: [], failed: [] };

  for (const inv of invoices) {
    const received = R2(inv.receivedAmount);
    if (received <= 0.5) continue;
    for (const p of inv.payments) {
      if (p.bankTxnId || !(Number(p.amount) > 0)) continue;
      const s = await PBL.searchFor(p, { invoice: inv, invoices: slim });
      const row = { invoice: inv.invoiceNumber, client: inv.client ? inv.client.name : null, paymentId: p.id, date: p.date, amount: R2(p.amount), reference: p.reference || null };
      if (s.sure) report.canLink.push({ ...row, line: s.reliable[0], why: s.why });
      else if (s.reliable.length) report.review.push({ ...row, why: s.why, lines: s.reliable });
      else if (s.possible.length) report.possible.push({ ...row, lines: s.possible });
      else report.none.push(row);
    }
    // received with no receipt rows behind it: show lines that name the invoice, never create anything
    const rowsSum = R2(inv.payments.reduce((x, p) => x + Number(p.amount || 0), 0));
    const missing = R2(received - rowsSum);
    if (missing > 0.5) {
      const naming = credits.filter((t) => {
        const hits = RM.invoicesNamed(String(`${t.description || ''} ${t.reference || ''}`).toUpperCase(), slim);
        return hits.length === 1 && hits[0].strong && hits[0].inv.id === inv.id && !['Reconciled', 'Ignored', 'Reversed'].includes(t.reconStatus);
      });
      report.evidenceMissing.push({
        invoice: inv.invoiceNumber, client: inv.client ? inv.client.name : null, received, withoutPaymentRows: missing, linesNamingIt: naming.map((t) => ({ txnId: t.id, date: t.date, amount: R2(t.amount), narration: String(t.description || '').slice(0, 120) })),
      });
    }
  }

  if (APPLY) {
    const bank = require(path.join(BACK, 'src/routes/bank')); // eslint-disable-line global-require
    const req = { user: { id: null, name: 'Bank link backfill (script)' } };
    for (const c of report.canLink) {
      // looked at again right before writing: still unlinked, still exactly one reliable line
      const p = await prisma.invoicePayment.findUnique({ where: { id: c.paymentId } });
      if (!p || p.bankTxnId) continue;
      const s = await PBL.searchFor(p, { invoices: slim });
      if (!s.sure || s.sure.id !== c.line.txnId) { report.failed.push({ ...c, why: 'no longer a single reliable match' }); continue; }
      const out = await bank.linkPayment(s.sure, p.id, req);
      if (out.error) report.failed.push({ ...c, why: out.error });
      else report.linked.push(c);
    }
  }

  const line = (s) => console.log(s);
  line(`\nBank statement links for existing payments - ${report.mode.toUpperCase()} (${report.at})`);
  line(`  can link (reliable, one line)   ${report.canLink.length}`);
  report.canLink.forEach((c) => line(`    ${c.invoice} · ${c.date} · ${rs(c.amount)} -> line ${c.line.date} ${rs(c.line.amount)} (${c.why})`));
  line(`  review (more than one fits)     ${report.review.length}`);
  report.review.forEach((c) => line(`    ${c.invoice} · ${c.date} · ${rs(c.amount)}: ${c.why}`));
  line(`  possible (amount only - never linked) ${report.possible.length}`);
  report.possible.forEach((c) => line(`    ${c.invoice} · ${c.date} · ${rs(c.amount)}: ${c.lines.length} line(s) of the same amount near the date`));
  line(`  no line fits                    ${report.none.length}`);
  line(`  invoices received with NO payment rows (evidence missing) ${report.evidenceMissing.length} · ${rs(report.evidenceMissing.reduce((x, e) => x + e.withoutPaymentRows, 0))}`);
  report.evidenceMissing.filter((e) => e.linesNamingIt.length).forEach((e) => line(`    ${e.invoice}: ${e.linesNamingIt.length} unclaimed line(s) name it - check by hand (nothing is created)`));
  if (APPLY) line(`  LINKED NOW ${report.linked.length} · not linked ${report.failed.length}`);
  else line('  Dry run - nothing was written. Run with --apply to link the "can link" ones.');
  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1)); line(`  full report: ${JSON_OUT}`); }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
