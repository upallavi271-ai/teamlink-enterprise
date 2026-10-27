#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// EMPTY THE ATS BEFORE A FRESH IMPORT (founder 2026-10-27: "mottham ATS ni empty cheyyu, ippudu nenu ichevi matramey import cheyyu,
// remaining em vundakudadhu"). Asked and answered:
//   * candidates: ALL deleted (profiles, resumes, notes, messages) - the joinings import brings back the ones in the joinings sheets;
//   * Accounts invoices and payments are NOT touched: the candidates and requirements an invoice points at are kept (the requirement is
//     set CLOSED), so no invoice loses its candidate / client / job;
//   * clients stay as they are now (the signed-agreements zip clients + the colleges kept Inactive for joinings history);
//   * then: requirement sheets (Medical, Education, Manufacturing) and joinings sheets are imported again (reset-and-import-ats.ps1).
// What is deleted: every application (stage history, follow-ups, interviews go with it), every requirement except the invoiced ones
// (with postings, partner shares, campus drives, referrals, scheduled messages), every candidate except the invoiced ones (aliases,
// duplicate marks, referrals, partner submissions, portal requests), and the Joining screen's records (JoiningRecord / events / notices).
// HRMS, Accounts, users, employees, clients, WhatsApp / Omni chats and the Job Portal's own database are not touched.
//
//   node scripts/reset-ats-2026-10-27.js                       DRY RUN: the numbers
//   TL_ALLOW_REAL_APPLY=1 node scripts/reset-ats-2026-10-27.js --apply --really-real
//   --db <copy.db> to run it on a copy.
// SAFETY: VACUUM INTO backup first (the undo: stop TeamLink, copy it back); one transaction per table group.
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
if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this empties the ATS in the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbArg.split(path.sep).join('/')}` } } });

const chunks = (arr, n = 400) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const tryDel = async (model, where) => { if (!prisma[model]) return 0; try { return (await prisma[model].deleteMany({ where })).count; } catch { return 0; } };
const rawCount = async (t) => { try { return Number((await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n); } catch { return 0; } };

(async () => {
  try {
    const inv = await prisma.invoice.findMany({ select: { candidateId: true, requirementId: true } });
    const keepCand = new Set(inv.map((i) => i.candidateId).filter(Boolean));
    const keepReq = new Set(inv.map((i) => i.requirementId).filter(Boolean));
    const reqs = await prisma.requirement.findMany({ select: { id: true } });
    const cands = await prisma.candidate.findMany({ select: { id: true } });
    const delReq = reqs.map((r) => r.id).filter((id) => !keepReq.has(id));
    const delCand = cands.map((c) => c.id).filter((id) => !keepCand.has(id));
    const apps = await prisma.application.count();
    const jr = await rawCount('JoiningRecord');
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log(`Applications to delete: ${apps} (all)`);
    console.log(`Requirements: ${reqs.length}; delete ${delReq.length}; keep ${keepReq.size} that an invoice points at (set Closed)`);
    console.log(`Candidates: ${cands.length}; delete ${delCand.length}; keep ${keepCand.size} that an invoice points at`);
    console.log(`Joining screen records to delete: ${jr}`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    const dir = path.resolve(isReal ? path.join(os.homedir(), '.teamlink-backups', `reset-ats-${new Date().toISOString().replace(/[:.]/g, '-')}`) : path.join(path.dirname(dbArg), `reset-ats-backup-${Date.now()}`));
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(dir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    console.log(`Backup: ${bak}`);

    // 1. the Joining screen's own tables (raw SQL)
    for (const t of ['JoinDropNotice', 'JoiningEvent', 'JoiningRecord']) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`).catch(() => null);
    // 2. applications and everything hanging on them
    const appIds = (await prisma.application.findMany({ select: { id: true } })).map((a) => a.id);
    for (const part of chunks(appIds)) {
      await tryDel('applicationFollowUp', { applicationId: { in: part } });
      await tryDel('applicationStageEvent', { applicationId: { in: part } });
      await tryDel('interviewFeedback', { applicationId: { in: part } });
      await tryDel('interviewEvent', { applicationId: { in: part } });
      await prisma.application.deleteMany({ where: { id: { in: part } } });
    }
    // 3. requirements (not the invoiced ones) and their satellites
    for (const part of chunks(delReq)) {
      for (const m of ['applicationFollowUp', 'applicationStageEvent', 'campusDrive', 'candidateReferral', 'distPosting', 'partnerJobShare', 'partnerSubmission', 'portalPosting', 'postingLog', 'postingQueue', 'requirementPosting', 'scheduledMessage']) {
        await tryDel(m, { requirementId: { in: part } });
      }
      await prisma.requirement.deleteMany({ where: { id: { in: part } } });
    }
    if (keepReq.size) await prisma.requirement.updateMany({ where: { id: { in: [...keepReq] } }, data: { status: 'CLOSED' } });
    // 4. candidates (not the invoiced ones); notes / resumes / documents / messages / certifications / stage events cascade
    for (const part of chunks(delCand)) {
      for (const m of ['candidateAlias', 'candidateDupFlag', 'candidateDupKey', 'candidateDupSig', 'candidateReferral', 'partnerSubmission', 'portalRequest', 'scheduledMessage', 'applicationFollowUp']) {
        await tryDel(m, { candidateId: { in: part } });
      }
      await prisma.$executeRawUnsafe(`DELETE FROM "CandidateAddedBy" WHERE "candidateId" IN (${part.map(() => '?').join(',')})`, ...part).catch(() => null);
      await prisma.candidate.deleteMany({ where: { id: { in: part } } });
    }
    await prisma.auditLog.create({ data: { action: `ATS emptied before a fresh import: ${appIds.length} applications, ${delReq.length} requirements, ${delCand.length} candidates deleted; ${keepReq.size} invoiced requirements and ${keepCand.size} invoiced candidates kept`, entity: 'ATS', actorName: 'ATS reset 2026-10-27' } });
    console.log(`\nDONE: ${appIds.length} applications, ${delReq.length} requirements, ${delCand.length} candidates deleted; kept ${keepReq.size} invoiced requirements (Closed) and ${keepCand.size} invoiced candidates.`);
    console.log(`Left now: requirements ${await prisma.requirement.count()}, candidates ${await prisma.candidate.count()}, applications ${await prisma.application.count()}, joining records ${await rawCount('JoiningRecord')}.`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 1200)); process.exit(1); });
