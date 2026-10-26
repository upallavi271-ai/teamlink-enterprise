#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// ONLY THE CLIENTS FROM THE SIGNED-AGREEMENTS ZIP (founder 2026-10-26: "clients kuda, nenu neeku zip file lo ichina clients ey vundali,
// remaining clients evaru vundakudadhu" - and, asked about the invoiced ones: "zip file vunna clients ey vundali, remaining evaru
// vundakudadhu").
//
// A ZIP CLIENT = a client that holds a signed agreement file (ClientDocument kind AGREEMENT_SIGNED - the 2026-10-17 import of
// "All Signed Agreements (File responses).zip", including the second rows of the same college that share the file). On the live site
// those rows come from push-signed-agreements-to-vps.ps1, so run that (-Apply) first there.
//
// Every OTHER client is DELETED with what hangs on it: its requirements (and their candidate applications, follow-ups, stage history,
// interviews, offers, postings, partner shares), its invoices (payments, adjustments, credit notes), its documents, aliases and portal
// requests. Candidate PROFILES stay (only their applications to these requirements go). A client portal login is switched off (Inactive,
// unlinked), not deleted. Notes / messages that pointed at a deleted application keep their text, with the link cleared.
//
//   node scripts/keep-only-zip-clients.js                                   DRY RUN on prisma/dev.db (nothing written)
//   node scripts/keep-only-zip-clients.js --db <copy.db> --apply            on a COPY
//   TL_ALLOW_REAL_APPLY=1 node scripts/keep-only-zip-clients.js --apply --really-real      the real database
//   --list <file.csv>   also write the clients that would go (name, industry, requirements, applications, invoices)
// SAFETY: dry run by default; refuses when no client holds a signed file (wrong database / bundle not imported yet); VACUUM INTO
// backup first; one transaction (all or nothing); the deleted client rows are saved as JSON; undo = put the backup back.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const LIST = val('--list');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const WHO = 'Keep only the signed-agreements zip clients 2026-10-26';

if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first, or --db <copy>.');
  process.exit(2);
}
if (!fs.existsSync(dbArg)) { console.error(`No database at ${dbArg}`); process.exit(2); }
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client'); // eslint-disable-line import/no-extraneous-dependencies

const prisma = new PrismaClient();
const has1 = (db, m) => !!db[m];
const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

(async () => {
  try {
    const all = await prisma.client.findMany({ select: { id: true, name: true, industry: true } });
    const keep = new Set((await prisma.clientDocument.findMany({ where: { kind: 'AGREEMENT_SIGNED' }, select: { clientId: true } })).map((d) => d.clientId));
    // --min-keep N: refuse when fewer than N clients hold a signed file (the bundle not imported yet would wipe the zip clients too)
    const minKeep = Math.max(1, Number(val('--min-keep', 1)) || 1);
    if (keep.size < minKeep) { console.log(`REFUSED: only ${keep.size} client(s) hold a signed agreement file here (expected at least ${minKeep}). Live: run push-signed-agreements-to-vps.ps1 -Apply first.`); return; }
    const gone = all.filter((c) => !keep.has(c.id));
    const ids = gone.map((c) => c.id);
    const reqs = await prisma.requirement.findMany({ where: { clientId: { in: ids } }, select: { id: true, clientId: true, department: true, status: true, _count: { select: { applications: true } } } });
    const reqIds = reqs.map((r) => r.id);
    const invs = await prisma.invoice.findMany({ where: { OR: [{ clientId: { in: ids } }, { requirementId: { in: reqIds } }] }, select: { id: true, clientId: true } });
    const apps = reqs.reduce((n, r) => n + r._count.applications, 0);
    const portal = await prisma.user.count({ where: { clientId: { in: ids } } });
    const byDept = {};
    reqs.forEach((r) => { const k = `${r.department || '—'} (${r.status})`; byDept[k] = (byDept[k] || 0) + 1; });

    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log(`Clients now: ${all.length}. In the zip (hold a signed agreement): ${keep.size}. NOT in the zip -> deleted: ${gone.length}`);
    console.log(`  with them: ${reqs.length} requirement(s), ${apps} candidate application(s), ${invs.length} invoice(s) on ${new Set(invs.map((i) => i.clientId)).size} client(s), ${portal} client portal login(s) switched off`);
    console.log('  requirements by department:', byDept);
    console.log(`  e.g. ${gone.slice(0, 12).map((c) => c.name).join(' | ')}${gone.length > 12 ? ' ...' : ''}`);
    if (LIST) {
      const per = (cid) => reqs.filter((r) => r.clientId === cid);
      const lines = ['Client,Industry,Requirements,Applications,Invoices'].concat(gone.map((c) => [c.name, c.industry, per(c.id).length, per(c.id).reduce((n, r) => n + r._count.applications, 0), invs.filter((i) => i.clientId === c.id).length].map(csv).join(',')));
      fs.writeFileSync(path.resolve(LIST), `${lines.join('\n')}\n`);
      console.log(`List: ${path.resolve(LIST)}`);
    }
    if (!gone.length) { console.log('\nNothing to delete.'); return; }
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    const bakDir = path.resolve(isReal ? path.join(os.homedir(), '.teamlink-backups', `keep-only-zip-clients-${STAMP}`) : path.join(path.dirname(dbArg), `keep-only-zip-clients-${STAMP}`));
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    fs.writeFileSync(path.join(bakDir, 'deleted-clients.json'), JSON.stringify(await prisma.client.findMany({ where: { id: { in: ids } } }), null, 1));

    const n = {};
    await prisma.$transaction(async (tx) => {
      const del = async (model, where) => { if (has1(tx, model)) { const r = await tx[model].deleteMany({ where }); n[model] = (n[model] || 0) + r.count; } };
      const clear = async (model, where, data) => { if (has1(tx, model)) await tx[model].updateMany({ where, data }); };
      const appIds = (await tx.application.findMany({ where: { requirementId: { in: reqIds } }, select: { id: true } })).map((a) => a.id);
      const invIds = invs.map((i) => i.id);
      // invoices and what hangs on them
      await del('partnerPayout', { OR: [{ invoiceId: { in: invIds } }, { applicationId: { in: appIds } }] });
      await del('invoicePayment', { invoiceId: { in: invIds } });
      await del('invoiceAdjustment', { invoiceId: { in: invIds } });
      await del('creditNote', { OR: [{ invoiceId: { in: invIds } }, { clientId: { in: ids } }, { applicationId: { in: appIds } }] });
      await del('invoice', { id: { in: invIds } });
      // applications
      for (const m of ['applicationFollowUp', 'applicationStageEvent', 'interviewFeedback', 'interviewPanelist', 'interviewEvent', 'offerVersion']) await del(m, { applicationId: { in: appIds } });
      for (const m of ['candidateMessage', 'candidateNote', 'candidateReferral', 'scheduledMessage', 'partnerSubmission']) await clear(m, { applicationId: { in: appIds } }, { applicationId: null }).catch(() => null);
      await del('partnerSubmission', { applicationId: { in: appIds } });
      await del('application', { id: { in: appIds } });
      // requirements
      for (const m of ['applicationFollowUp', 'applicationStageEvent', 'partnerSubmission', 'partnerJobShare', 'requirementPosting', 'portalPosting', 'distPosting', 'postingQueue', 'postingLog', 'scheduledMessage']) await del(m, { requirementId: { in: reqIds } });
      await clear('candidateReferral', { requirementId: { in: reqIds } }, { requirementId: null }).catch(() => del('candidateReferral', { requirementId: { in: reqIds } }));
      await clear('campusDrive', { requirementId: { in: reqIds } }, { requirementId: null }).catch(() => del('campusDrive', { requirementId: { in: reqIds } }));
      await del('requirement', { id: { in: reqIds } });
      // the client itself
      await clear('interviewFeedback', { clientId: { in: ids } }, { clientId: null });
      await clear('applicationStageEvent', { clientId: { in: ids } }, { clientId: null });
      await clear('jobMergeLog', { clientId: { in: ids } }, { clientId: null });
      await del('portalRequest', { clientId: { in: ids } });
      await del('clientAlias', { clientId: { in: ids } });
      await del('clientDocument', { clientId: { in: ids } });
      await clear('user', { clientId: { in: ids } }, { clientId: null, status: 'Inactive' });
      await del('client', { id: { in: ids } });
      await tx.auditLog.create({ data: { action: `Clients not in the signed-agreements zip deleted: ${ids.length} (with ${reqIds.length} requirements, ${appIds.length} applications, ${invIds.length} invoices)`, entity: 'Client', actorName: WHO } });
    }, { timeout: 900000, maxWait: 60000 });
    console.log('\nDONE:', n);
    console.log(`Backup (the whole database before this): ${bak}\nThe deleted client rows: ${path.join(bakDir, 'deleted-clients.json')}`);
    console.log('To undo: stop TeamLink, copy the backup over the database file (remove its -wal / -shm), start TeamLink.');
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED (nothing was changed - one transaction):', e.message.slice(0, 600)); process.exit(1); });
