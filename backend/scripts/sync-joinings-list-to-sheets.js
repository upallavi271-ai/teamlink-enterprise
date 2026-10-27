#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// THE JOININGS LIST = THE JOININGS SHEETS (founder 2026-10-27: "joinings list lo same ee sheet lo vunnattey visible avvali"; asked:
// only the sheets' joinings, the rest moved out - the one with an invoice stays). Run AFTER the joinings import
// (scripts/import-joinings-2026-10-17.js), which brings every sheet row in and marks its application with "[JNG <sheet>:<row>]".
//
//   1. a JOINED application in Medical / Education / Manufacturing that no sheet row marks goes back to SELECTED (stage history row
//      "Not in the joinings sheet"), unless an invoice is raised for it (Accounts stays whole);
//   2. the Joining screen's "Joined and dropped" list (table JoiningRecord) loses the records whose application no longer exists
//      (deleted with old requirements) and the records of the applications moved in step 1;
//   3. every joined application without a record gets one (the module's own backfill: no notices, no invented place).
//
//   node scripts/sync-joinings-list-to-sheets.js                     DRY RUN: the numbers
//   TL_ALLOW_REAL_APPLY=1 node scripts/sync-joinings-list-to-sheets.js --apply --really-real
// SAFETY: VACUUM INTO backup first; the moved / removed rows are written to a file next to it; running it twice changes nothing new.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const BACK = path.resolve(__dirname, '..');
const APPLY = has('--apply');
if (APPLY && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
process.chdir(BACK);
require('dotenv').config({ path: path.join(BACK, '.env') });
const prisma = require('../src/db');

const DEPTS = ['Medical', 'Education', 'Manufacturing'];
const JOINED = ['JOINED', 'HIRED'];

(async () => {
  try {
    const joined = await prisma.application.findMany({
      where: { stage: { in: JOINED }, requirement: { department: { in: DEPTS } } },
      select: { id: true, stage: true, candidateId: true, requirementId: true, candidate: { select: { name: true } }, requirement: { select: { department: true, client: { select: { name: true } } } } },
    });
    const marked = new Set();
    (await prisma.applicationFollowUp.findMany({ where: { notes: { contains: '[JNG ' } }, select: { applicationId: true } })).forEach((f) => marked.add(f.applicationId));
    (await prisma.applicationStageEvent.findMany({ where: { comment: { contains: '[JNG ' } }, select: { applicationId: true } })).forEach((e) => marked.add(e.applicationId));
    if (!marked.size) { console.error('STOP: no application carries a joinings-sheet marker. Run the joinings import first.'); process.exit(3); }
    const notInSheet = joined.filter((a) => !marked.has(a.id));
    const inv = notInSheet.length ? await prisma.invoice.findMany({ where: { OR: notInSheet.map((a) => ({ candidateId: a.candidateId, requirementId: a.requirementId })) }, select: { candidateId: true, requirementId: true, invoiceNumber: true } }) : [];
    const invoiced = new Set(inv.map((i) => `${i.candidateId}|${i.requirementId}`));
    const move = notInSheet.filter((a) => !invoiced.has(`${a.candidateId}|${a.requirementId}`));
    const kept = notInSheet.length - move.length;

    const recs = await prisma.$queryRawUnsafe('SELECT "id","applicationId" FROM "JoiningRecord"');
    const live = new Set((await prisma.application.findMany({ where: { id: { in: recs.map((r) => r.applicationId) } }, select: { id: true } })).map((a) => a.id));
    const moveIds = new Set(move.map((a) => a.id));
    const drop = recs.filter((r) => !live.has(r.applicationId) || moveIds.has(r.applicationId));
    const allJoined = await prisma.application.findMany({ where: { stage: { in: JOINED } }, select: { id: true } });
    const haveRec = new Set(recs.filter((r) => !drop.includes(r)).map((r) => r.applicationId));
    const missing = allJoined.filter((a) => !moveIds.has(a.id) && !haveRec.has(a.id)).length;

    console.log(`Joined now: ${joined.length} (Medical / Education / Manufacturing); in the sheets: ${joined.length - notInSheet.length}`);
    console.log(`Not in the sheets: ${notInSheet.length} -> back to Selected: ${move.length}; kept Joined because an invoice is raised: ${kept}${inv.length ? ` (${inv.map((i) => i.invoiceNumber).join(', ')})` : ''}`);
    console.log(`"Joined and dropped" list records: ${recs.length}; removed: ${drop.length} (${recs.filter((r) => !live.has(r.applicationId)).length} whose application is gone); missing, to be filled: ${missing}`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    const dbFile = path.join(BACK, 'prisma', 'dev.db');
    const url = String(process.env.DATABASE_URL || '');
    const target = url.startsWith('file:') ? path.resolve(BACK, 'prisma', url.slice(5).split('?')[0]) : dbFile;
    const bakDir = path.join(os.homedir(), '.teamlink-backups', `sync-joinings-list-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    const dropIds = drop.map((r) => r.id);
    const removedRows = dropIds.length ? await prisma.$queryRawUnsafe(`SELECT * FROM "JoiningRecord" WHERE "id" IN (${dropIds.map(() => '?').join(',')})`, ...dropIds) : [];
    fs.writeFileSync(path.join(bakDir, 'changes.json'), JSON.stringify({ movedToSelected: move.map((a) => ({ id: a.id, candidate: a.candidate && a.candidate.name, client: a.requirement && a.requirement.client && a.requirement.client.name })), removedRecords: removedRows }, null, 1));

    await prisma.$transaction(async (tx) => {
      for (const a of move) {
        await tx.application.update({ where: { id: a.id }, data: { stage: 'SELECTED' } });
        await tx.applicationStageEvent.create({ data: { applicationId: a.id, candidateId: a.candidateId, fromStage: a.stage, toStage: 'SELECTED', action: 'Not in the joinings sheet', comment: 'Moved back from Joined: this joining is not in the founder\'s joinings sheets (2026-10-27).', actorName: 'Joinings sheets 2026-10-27' } });
      }
      for (let i = 0; i < dropIds.length; i += 300) {
        const part = dropIds.slice(i, i + 300); const qs = part.map(() => '?').join(',');
        for (const t of ['JoiningEvent', 'JoinDropNotice']) await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "recordId" IN (${qs})`, ...part).catch(() => null);
        await tx.$executeRawUnsafe(`DELETE FROM "JoiningRecord" WHERE "id" IN (${qs})`, ...part);
      }
      await tx.auditLog.create({ data: { action: `Joinings list matched to the joinings sheets: ${move.length} moved back to Selected, ${dropIds.length} list records removed`, entity: 'Application', toValue: 'joinings sheets 2026-10-27', actorName: 'Joinings sheets 2026-10-27' } });
    }, { timeout: 600000 });
    const core = require('../src/joindrop/core'); // eslint-disable-line global-require
    const filled = await core.backfillOnce({ force: true });
    console.log(`\nDONE: ${move.length} moved back to Selected, ${dropIds.length} list records removed, ${filled && filled.made != null ? filled.made : '?'} records filled in.\nDatabase: ${target}\nBackup (before this): ${bak}\nWhat changed: ${path.join(bakDir, 'changes.json')}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
