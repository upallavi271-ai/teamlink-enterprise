#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// OLD AGREEMENTS WITH NO "MADE ON" DATE  (user, 2026-10-10)
//
// New agreements always print today's date after "This agreement is made on".
// Agreements made BEFORE that change may still print "**-**-****" (or nothing).
// Nothing changes them silently. This script lists them and, only when told to,
// stamps the date.
//
//   node scripts/stamp-agreement-dates.js                 DRY RUN: writes NOTHING, prints the plan
//   node scripts/stamp-agreement-dates.js --md plan.md    dry run + a readable file of the plan
//   node scripts/stamp-agreement-dates.js --apply         backup first, then stamp the dates
//   node scripts/stamp-agreement-dates.js --undo <file>   put every text / date back (file from --apply)
//
// Options
//   --statuses DRAFT,SENT,...   which agreement steps --apply may touch. Default: DRAFT only
//                               (a text already sent or signed is not rewritten unless you ask).
//   --include-signed            ALSO stamp SIGNED / ACTIVE agreements. Only after the Admin has
//                               approved the NEEDS REVIEW list. Text only: signatures, stamps,
//                               signed dates and the kept signed PDFs are not touched.
//   --db <path-to-sqlite-file>  use another database (the sandbox copy). Default: .env DATABASE_URL.
//
// WHICH DATE (evidence only, never today's date for an old record), in this order:
//   1. the agreement date already on the client (agreementStart)
//   2. the day its draft was made ("Agreement draft created from template" /
//      "Agreement document generated" in the activity trail, India time)
//   3. the day the client record was created (India time)
// SIGNED / ACTIVE agreements are NOT stamped by --apply alone (a signed paper does not
// change silently; needs --include-signed). They are listed under "NEEDS REVIEW" with the date they were
// signed. Proposal: with the Admin's OK, stamp the text of each with the day its
// draft was made (a one-line change, reviewed list); the signed PDF copies kept
// in history stay as they are.
// WHAT IS WRITTEN: the agreement text gets that date after "made on". A DRAFT
// whose agreementStart is empty also gets agreementStart = that date, so a later
// "Make a new draft" keeps the same date. Sent / signed agreements get the text
// date only (their start / renewal dates are left as they are).
//
// SAFETY: --apply on the REAL database needs --really-real. It makes a full
// backup first (utils/backup.js), writes in ONE transaction, only touches a row
// whose text still has no date, and saves an undo file (old text + old date).
// Test rows (ZZTEST / example.test) are never touched.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
require('dotenv').config({ path: path.join(BACKEND, '.env') });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const dbArg = opt('--db');
if (dbArg) process.env.DATABASE_URL = `file:${path.resolve(dbArg).replace(/\\/g, '/')}`;
const REAL_DB = path.resolve(BACKEND, 'prisma', 'dev.db').toLowerCase();
function dbFileNow() {
  let url = String(process.env.DATABASE_URL || 'file:./dev.db').trim().replace(/^["']|["']$/g, '').replace(/^file:/, '').replace(/[?#].*$/, '');
  url = path.isAbsolute(url) ? path.resolve(url) : path.resolve(BACKEND, 'prisma', url);
  return url;
}
const isRealDb = () => dbFileNow().toLowerCase() === REAL_DB;

// eslint-disable-next-line import/order
const prisma = require('../src/db');
const vendor = require('../src/utils/vendorAgreement');

const TEST_ROW = /zztest|example\.test|sample00/i;
const STATUSES = String(opt('--statuses') || 'DRAFT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const DATE_OK = /^\d{2}-\d{2}-\d{4}$/;
const istYmd = (v) => (v ? new Date(new Date(v).getTime() + 330 * 60000).toISOString().slice(0, 10) : null);
const stepOf = (c) => {
  const s = String(c.agreementStatus || 'DRAFT').toUpperCase();
  return s === 'CONFIRMED' ? 'SIGNED' : (s === 'CANCELLED' ? 'REJECTED' : s);
};

// "****" left in the client name / address of an old text. FIXED only for a draft
// that --apply stamps, and only when the client now HAS that data.
const NAME_MASK = /(between “)\*{4}(” \(herein after)/;
const ADDR_MASK = /( Address )\*{4}( and “)/;
function placeholderInfo(c) {
  const doc = String(c.agreementDocument || '');
  const name = String(c.legalName || c.name || '').replace(/\s+/g, ' ').trim();
  const address = vendor.addressLine(c);
  return {
    maskedName: NAME_MASK.test(doc), maskedAddress: ADDR_MASK.test(doc), nameNow: name || null, addressNow: address || null,
  };
}
function fixPlaceholders(text, r) {
  let t = text;
  if (r.maskedName && r.nameNow) t = t.replace(NAME_MASK, (m, a, b) => a + r.nameNow + b);
  if (r.maskedAddress && r.addressNow) t = t.replace(ADDR_MASK, (m, a, b) => a + r.addressNow + b);
  return t;
}

async function plan() {
  const clients = await prisma.client.findMany({
    where: { agreementDocument: { not: null } },
    select: {
      id: true, name: true, clientCode: true, agreementId: true, agreementStatus: true, agreementDocument: true,
      agreementStart: true, createdAt: true, ownerDepartment: true, agreementSignedAt: true, agreementSentAt: true,
      legalName: true, houseNumber: true, street: true, landmark: true, area: true,
      location: true, state: true, pincode: true, country: true, billingAddress: true,
    },
  });
  const real = clients.filter((c) => !TEST_ROW.test(`${c.name} ${c.clientCode || ''} ${c.agreementId || ''}`));
  const trail = await prisma.auditLog.findMany({
    where: { entity: 'Client', entityId: { in: real.map((c) => c.id) }, action: { in: ['Agreement draft created from template', 'Agreement document generated'] } },
    orderBy: { createdAt: 'asc' }, select: { entityId: true, createdAt: true },
  });
  const draftMade = new Map();
  trail.forEach((t) => { draftMade.set(t.entityId, t.createdAt); }); // the latest one wins
  const vendorDocs = real.filter((c) => vendor.isVendorDocument(c.agreementDocument));
  const rows = [];
  let withDate = 0;
  let otherTemplate = 0;
  real.forEach((c) => {
    if (!vendor.isVendorDocument(c.agreementDocument)) { otherTemplate += 1; return; }
    const printed = vendor.madeOnOf(c.agreementDocument);
    if (printed && DATE_OK.test(printed)) { withDate += 1; return; }
    const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(String(c.agreementStart || ''));
    const made = draftMade.get(c.id);
    const ymd = hasStart ? c.agreementStart : istYmd(made || c.createdAt);
    const from = hasStart ? 'agreement date on the client' : (made ? 'day the draft was made' : 'date the client was created');
    const step = stepOf(c);
    const signed = ['SIGNED', 'ACTIVE', 'EXPIRED'].includes(step);
    rows.push({
      id: c.id, name: c.name, agreementId: c.agreementId || '', step, department: c.ownerDepartment || '',
      printed: printed || '(no "made on" sentence)', startSet: !!c.agreementStart,
      proposed: ymd, proposedFrom: from,
      sentAt: c.agreementSentAt ? istYmd(c.agreementSentAt) : null,
      signedAt: c.agreementSignedAt ? istYmd(c.agreementSignedAt) : null,
      needsReview: signed,
      // Only an unsigned step you name (default DRAFT) is stamped; signed / active ones only with --include-signed (after the Admin's OK).
      applies: (signed ? has('--include-signed') : STATUSES.includes(step)) && !!vendor.restampMadeOn(c.agreementDocument, ymd),
      ...placeholderInfo(c),
    });
  });
  return { total: clients.length, test: clients.length - real.length, vendorDocs: vendorDocs.length, withDate, otherTemplate, rows };
}

function byStep(rows) {
  const o = {};
  rows.forEach((r) => { o[r.step] = (o[r.step] || 0) + 1; });
  return Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
}

function printPlan(p) {
  const todo = p.rows.filter((r) => r.applies);
  console.log(`Clients with an agreement document: ${p.total} (test rows skipped: ${p.test})`);
  console.log(`  "Vendor Services Agreement" text: ${p.vendorDocs}   other template (not touched): ${p.otherTemplate}`);
  console.log(`  already print a real date: ${p.withDate}`);
  console.log(`  NO DATE printed: ${p.rows.length}   (by step: ${byStep(p.rows)})`);
  console.log(`  --apply would stamp ${todo.length} of them (steps: ${STATUSES.join(', ')}); ${p.rows.length - todo.length} are left as they are.`);
  const review = p.rows.filter((r) => r.needsReview);
  if (review.length) {
    console.log(`\nNEEDS REVIEW - signed / active (NOT touched unless --include-signed is added): ${review.length}`);
    review.forEach((r) => console.log(`  ${r.id}  ${(r.agreementId || '-').padEnd(8)} ${r.step.padEnd(8)} signed ${r.signedAt || '-'}  sent ${r.sentAt || '-'}  prints ${r.printed}  proposed ${r.proposed} (${r.proposedFrom})  ${r.name}`));
    console.log("  Proposal: with the Admin's OK, stamp the text of each with the proposed date (the day its draft was made) in one reviewed run; the kept signed PDF copies are not changed.");
  }
  const masked = p.rows.filter((r) => r.maskedName || r.maskedAddress);
  if (masked.length) console.log(`\nStill show **** for the name or address: ${masked.length} (${masked.filter((r) => (r.maskedAddress && r.addressNow) || (r.maskedName && r.nameNow)).length} can be filled in now)`);
  console.log('');
  p.rows.filter((r) => !r.needsReview).slice(0, 20).forEach((r) => console.log(`  ${r.applies ? 'STAMP' : 'keep '}  ${r.id}  ${(r.agreementId || '-').padEnd(8)} ${r.step.padEnd(8)} ${r.printed.padEnd(12)} -> ${r.proposed}  ${r.name}`));
  if (p.rows.length > 20) console.log(`  ... ${p.rows.length - 20} more (use --md <file> for the full list)`);
}

function markdown(p, applied) {
  const L = [];
  L.push(`# Agreements with no "made on" date ${applied ? '(APPLIED)' : '- DRY RUN (nothing was written)'}`);
  L.push('');
  L.push(`Database: \`${dbFileNow()}\`  |  agreements: ${p.total}  |  test rows skipped: ${p.test}`);
  L.push(`Already print a date: ${p.withDate}. No date printed: **${p.rows.length}** (${byStep(p.rows)}).`);
  L.push(`Proposed date = the agreement date on the client, else the day its draft was made, else the day the client was created. Signed / active rows are changed only with --include-signed. Steps stamped by --apply: ${STATUSES.join(', ')}.`);
  L.push('');
  L.push('| Client id | Agreement No. | Client | Step | Printed now | Signed on | Proposed date | From | Action |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  p.rows.forEach((r) => L.push(`| ${r.id} | ${r.agreementId || '-'} | ${r.name.replace(/\|/g, '/')} | ${r.step} | ${r.printed} | ${r.signedAt ? vendor.ddmmyyyy(r.signedAt) : '-'} | ${vendor.ddmmyyyy(r.proposed)} | ${r.proposedFrom} | ${r.needsReview ? (r.applies ? 'stamp (signed: approved)' : 'NEEDS REVIEW (signed: not touched)') : (r.applies ? 'stamp' : 'left as is')} |`));
  L.push('');
  return L.join('\n');
}

async function apply(p) {
  if (isRealDb() && !has('--really-real')) {
    throw new Error('This is the REAL database. Run the dry run, get the list approved, then add --really-real.');
  }
  // eslint-disable-next-line global-require
  const backup = require('../src/utils/backup');
  const b = await backup.makeBackup({ reason: 'before stamping agreement dates', by: 'stamp-agreement-dates.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  await prisma.$transaction(async (tx) => {
    for (const r of p.rows.filter((x) => x.applies)) {
      // eslint-disable-next-line no-await-in-loop
      const cur = await tx.client.findUnique({ where: { id: r.id }, select: { agreementDocument: true, agreementStart: true, agreementStatus: true } });
      const printed = vendor.madeOnOf(cur && cur.agreementDocument);
      if (!cur || (printed && DATE_OK.test(printed))) continue; // changed meanwhile: leave it
      let text = vendor.restampMadeOn(cur.agreementDocument, r.proposed);
      if (!text) continue;
      text = fixPlaceholders(text, r);
      const data = { agreementDocument: text };
      const setStart = r.step === 'DRAFT' && !String(cur.agreementStart || '').trim();
      if (setStart) data.agreementStart = r.proposed;
      // eslint-disable-next-line no-await-in-loop
      await tx.client.update({ where: { id: r.id }, data });
      undo.rows.push({ id: r.id, oldDocument: cur.agreementDocument, oldStart: cur.agreementStart || null, newDocument: text, setStart, date: r.proposed });
    }
  }, { timeout: 120000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `agreement-dates-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo, null, 2));
  console.log(`Stamped ${undo.rows.length} agreements.`);
  console.log(`To put them back:  node scripts/stamp-agreement-dates.js --undo "${file}"${isRealDb() ? ' --really-real' : ''}`);
}

async function undoRun(file) {
  if (isRealDb() && !has('--really-real')) throw new Error('This is the REAL database. Add --really-real to undo there.');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  let skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const r of u.rows) {
      // Only if the text is still exactly what --apply wrote (nobody edited it since).
      // eslint-disable-next-line no-await-in-loop
      const cur = await tx.client.findUnique({ where: { id: r.id }, select: { agreementDocument: true } });
      if (!cur || cur.agreementDocument !== r.newDocument) { skipped += 1; continue; }
      const data = { agreementDocument: r.oldDocument };
      if (r.setStart) data.agreementStart = r.oldStart;
      // eslint-disable-next-line no-await-in-loop
      await tx.client.update({ where: { id: r.id }, data });
      n += 1;
    }
  }, { timeout: 120000, maxWait: 30000 });
  console.log(`Undone: ${n} agreements put back as they were. Left alone (edited since): ${skipped}.`);
}

(async () => {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const p = await plan();
  if (has('--apply')) {
    printPlan(p);
    await apply(p);
    if (opt('--md')) fs.writeFileSync(path.resolve(opt('--md')), markdown(p, true));
  } else {
    console.log('DRY RUN: nothing is written.\n');
    printPlan(p);
    if (opt('--md')) { fs.writeFileSync(path.resolve(opt('--md')), markdown(p, false)); console.log(`\nFull list written to ${path.resolve(opt('--md'))}`); }
    console.log('\nTo stamp these dates: add --apply (after approval).');
  }
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
