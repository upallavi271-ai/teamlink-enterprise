#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// GIVE OLD / IMPORTED CLIENTS THEIR AGREEMENT NO. (AGR0001 ...) AND CLIENT ID (CLI0001 ...)
//
//   node scripts/number-agreements.js                    DRY RUN: writes NOTHING, prints the plan
//   node scripts/number-agreements.js --md plan.md       dry run + a readable file of the plan
//   node scripts/number-agreements.js --apply            backup first, then write the numbers
//   node scripts/number-agreements.js --undo <file>      put every number back to empty (file from --apply)
//
// Options
//   --only agreements | clients   do just one of the two lists
//   --include-drafts              ALSO number a Draft client that has no agreement document yet
//                                 (default: a number is made when its draft is made)
//   --client-ids fill | after     fill = reuse the free numbers from CLI0001 up (default);
//                                 after = continue after the highest number now on file
//   --db <path-to-sqlite-file>    use another database (the sandbox copy). Default: .env DATABASE_URL.
//
// WHO GETS AN AGREEMENT NO.: a client with no number yet that has an agreement document,
// or whose agreement step is anything but a bare Draft (Sent, Signed, Active, Expired ...).
// Order: agreement date (start date, else the date it went active / was signed / sent,
// else the date the client was added), then client name A-Z, then record id.
// So the same data always gives the same numbers. Numbers continue after the highest
// AGR number already used (AGR0003 -> the first one gets AGR0004).
//
// WHO GETS A CLIENT ID: a client with an empty Client ID. Order: date added, then name.
//
// SAFETY: --apply needs the real database to be confirmed with --really-real; it makes a
// full backup first (utils/backup.js), writes in ONE transaction, refuses to overwrite a
// number that appeared meanwhile, and saves an undo file next to the backup.
// Test rows (ZZTEST / example.test) are never numbered.
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
const autoNumber = require('../src/utils/autoNumber');

const ONLY = opt('--only'); // agreements | clients | null
const MODE = opt('--client-ids') === 'after' ? 'after' : 'fill';
const TEST_ROW = /zztest|example\.test|sample00/i;

const pad = (kind, n) => autoNumber.format(kind, n);
const dateOnly = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const agreementDate = (c) => dateOnly(c.agreementStart) || dateOnly(c.agreementActivatedAt) || dateOnly(c.agreementSignedAt)
  || dateOnly(c.agreementSentAt) || dateOnly(c.createdAt) || '9999-12-31';
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function plan() {
  const clients = await prisma.client.findMany({
    select: {
      id: true, name: true, clientCode: true, agreementId: true, agreementStatus: true, agreementDocument: true,
      agreementStart: true, agreementEnd: true, agreementActivatedAt: true, agreementSignedAt: true, agreementSentAt: true,
      createdAt: true, clientType: true, ownerDepartment: true, bdeOwner: true,
    },
  });
  const real = clients.filter((c) => !TEST_ROW.test(`${c.name} ${c.clientCode || ''} ${c.agreementId || ''}`));

  // ---- Agreement numbers ----
  const hasAgreement = (c) => !!c.agreementDocument || (c.agreementStatus && c.agreementStatus !== 'DRAFT');
  const wantsAgr = (c) => !String(c.agreementId || '').trim() && (hasAgreement(c) || has('--include-drafts'));
  const agrList = real.filter(wantsAgr)
    .map((c) => ({ c, date: agreementDate(c) }))
    .sort((a, b) => byText(a.date, b.date) || byText(a.c.name.toLowerCase(), b.c.name.toLowerCase()) || byText(a.c.id, b.c.id));
  const maxAgr = await autoNumber.highestOnFile('AGR');
  const agreements = agrList.map((x, i) => ({
    id: x.c.id, name: x.c.name, date: x.date, status: x.c.agreementStatus, hasDocument: !!x.c.agreementDocument,
    department: x.c.ownerDepartment || '', bde: x.c.bdeOwner || '', newId: pad('AGR', maxAgr + 1 + i),
  }));
  const draftsSkipped = real.filter((c) => !String(c.agreementId || '').trim() && !hasAgreement(c) && !has('--include-drafts'));

  // ---- Client IDs ----
  const usedNums = new Set();
  const re = /^CLI0*(\d+)$/i;
  clients.forEach((c) => { const m = String(c.clientCode || '').trim().match(re); if (m) usedNums.add(Number(m[1])); });
  const usedText = new Set(clients.map((c) => String(c.clientCode || '').trim().toLowerCase()).filter(Boolean));
  const maxCli = await autoNumber.highestOnFile('CLI');
  const cliList = real.filter((c) => !String(c.clientCode || '').trim())
    .sort((a, b) => byText(dateOnly(a.createdAt) || '', dateOnly(b.createdAt) || '') || byText(a.name.toLowerCase(), b.name.toLowerCase()) || byText(a.id, b.id));
  let next = MODE === 'after' ? maxCli + 1 : 1;
  const clientIds = cliList.map((c) => {
    while (usedNums.has(next) || usedText.has(pad('CLI', next).toLowerCase())) next += 1;
    const code = pad('CLI', next);
    usedNums.add(next);
    next += 1;
    return { id: c.id, name: c.name, added: dateOnly(c.createdAt), status: c.agreementStatus, newCode: code };
  });
  return { total: clients.length, test: clients.length - real.length, agreements, draftsSkipped, maxAgr, clientIds, maxCli };
}

function markdown(p, applied) {
  const L = [];
  const lastAgr = p.agreements.length ? p.agreements[p.agreements.length - 1].newId : '-';
  const lastCli = p.clientIds.length ? p.clientIds[p.clientIds.length - 1].newCode : '-';
  L.push(`# Agreement No. and Client ID numbering ${applied ? '(APPLIED)' : '- DRY RUN (nothing was written)'}`);
  L.push('');
  L.push(`Database: \`${dbFileNow()}\`  |  Clients: ${p.total}  |  test rows skipped: ${p.test}`);
  L.push('');
  L.push(`## 1. Agreement No.: ${p.agreements.length} agreements get a number (${p.agreements.length ? `${p.agreements[0].newId} to ${lastAgr}` : 'none'})`);
  L.push(`Highest number used today: AGR${String(p.maxAgr).padStart(4, '0')}. Order: agreement date, then client name.`);
  const byStatus = {};
  p.agreements.forEach((a) => { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });
  L.push(`By step: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  L.push(`Not numbered (Draft with no agreement document yet): ${p.draftsSkipped.length}. They get a number the moment their draft is made.`);
  L.push('');
  L.push('| New Agreement No. | Client | Agreement date | Step | Has document |');
  L.push('|---|---|---|---|---|');
  p.agreements.forEach((a) => L.push(`| ${a.newId} | ${a.name.replace(/\|/g, '/')} | ${a.date === '9999-12-31' ? '-' : a.date} | ${a.status} | ${a.hasDocument ? 'yes' : 'no'} |`));
  L.push('');
  L.push(`## 2. Client ID: ${p.clientIds.length} clients have an empty Client ID (${p.clientIds.length ? `${p.clientIds[0].newCode} to ${lastCli}` : 'none'})`);
  L.push(`Highest CLI number used today: CLI${String(p.maxCli).padStart(4, '0')}. Order: date the client was added, then name. Mode: ${MODE === 'fill' ? 'fill the free numbers from CLI0001 up' : 'continue after the highest number'}.`);
  L.push('');
  L.push('| New Client ID | Client | Added on | Agreement step |');
  L.push('|---|---|---|---|');
  p.clientIds.forEach((x) => L.push(`| ${x.newCode} | ${x.name.replace(/\|/g, '/')} | ${x.added || '-'} | ${x.status} |`));
  L.push('');
  return L.join('\n');
}

function printPlan(p) {
  console.log(`Clients: ${p.total} (test rows skipped: ${p.test})`);
  console.log(`\nAGREEMENT NO. — ${p.agreements.length} to number (after AGR${String(p.maxAgr).padStart(4, '0')}); ${p.draftsSkipped.length} bare Drafts left for when their draft is made`);
  p.agreements.slice(0, 15).forEach((a) => console.log(`  ${a.newId}  ${a.date}  ${a.status.padEnd(8)} ${a.name}`));
  if (p.agreements.length > 15) console.log(`  ... ${p.agreements.length - 15} more (use --md <file> for the full list)`);
  console.log(`\nCLIENT ID — ${p.clientIds.length} to number`);
  p.clientIds.slice(0, 10).forEach((x) => console.log(`  ${x.newCode}  ${x.added || '-'}  ${x.name}`));
  if (p.clientIds.length > 10) console.log(`  ... ${p.clientIds.length - 10} more`);
}

async function apply(p) {
  if (isRealDb() && !has('--really-real')) {
    throw new Error('This is the REAL database. Run the dry run, get the numbers approved, then add --really-real.');
  }
  // 1. Backup.
  // eslint-disable-next-line global-require
  const backup = require('../src/utils/backup');
  const b = await backup.makeBackup({ reason: 'before numbering agreements / client IDs', by: 'number-agreements.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  // 2. Write in ONE transaction; never overwrite a number that appeared meanwhile.
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, agreements: [], clientIds: [] };
  await prisma.$transaction(async (tx) => {
    if (ONLY !== 'clients') {
      for (const a of p.agreements) {
        // eslint-disable-next-line no-await-in-loop
        const r = await tx.client.updateMany({ where: { id: a.id, OR: [{ agreementId: null }, { agreementId: '' }] }, data: { agreementId: a.newId } });
        if (r.count) undo.agreements.push({ id: a.id, value: a.newId });
      }
    }
    if (ONLY !== 'agreements') {
      for (const x of p.clientIds) {
        // eslint-disable-next-line no-await-in-loop
        const r = await tx.client.updateMany({ where: { id: x.id, OR: [{ clientCode: null }, { clientCode: '' }] }, data: { clientCode: x.newCode } });
        if (r.count) undo.clientIds.push({ id: x.id, value: x.newCode });
      }
    }
    // The automatic counters continue after the numbers just handed out.
    const lastAgr = Math.max(p.maxAgr, ...undo.agreements.map((u) => Number(u.value.slice(3))), 0);
    const lastCli = Math.max(p.maxCli, ...undo.clientIds.map((u) => Number(u.value.slice(3))), 0);
    if (undo.agreements.length) await autoNumber.ensureCounterAtLeast('AGR', lastAgr, tx);
    if (undo.clientIds.length) await autoNumber.ensureCounterAtLeast('CLI', lastCli, tx);
  }, { timeout: 120000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `numbering-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo, null, 2));
  console.log(`Numbered ${undo.agreements.length} agreements and ${undo.clientIds.length} Client IDs.`);
  console.log(`To put them back:  node scripts/number-agreements.js --undo "${file}"`);
}

async function undoRun(file) {
  if (isRealDb() && !has('--really-real')) throw new Error('This is the REAL database. Add --really-real to undo there.');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let a = 0; let c = 0;
  await prisma.$transaction(async (tx) => {
    for (const x of u.agreements) {
      // eslint-disable-next-line no-await-in-loop
      a += (await tx.client.updateMany({ where: { id: x.id, agreementId: x.value }, data: { agreementId: null } })).count;
    }
    for (const x of u.clientIds) {
      // eslint-disable-next-line no-await-in-loop
      c += (await tx.client.updateMany({ where: { id: x.id, clientCode: x.value }, data: { clientCode: null } })).count;
    }
  }, { timeout: 120000, maxWait: 30000 });
  console.log(`Undone: ${a} agreement numbers and ${c} Client IDs set back to empty. (The automatic counter is left where it is, so those numbers are never handed out twice.)`);
}

(async () => {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const p = await plan();
  if (ONLY === 'agreements') p.clientIds = [];
  if (ONLY === 'clients') { p.agreements = []; p.draftsSkipped = []; }
  if (has('--apply')) {
    printPlan(p);
    await apply(p);
    if (opt('--md')) fs.writeFileSync(opt('--md'), markdown(p, true));
  } else {
    console.log('DRY RUN: nothing is written.\n');
    printPlan(p);
    if (opt('--md')) { fs.writeFileSync(path.resolve(opt('--md')), markdown(p, false)); console.log(`\nFull list written to ${path.resolve(opt('--md'))}`); }
    console.log('\nTo write these numbers: add --apply (after approval).');
  }
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
