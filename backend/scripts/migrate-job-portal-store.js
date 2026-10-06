#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Move what ONLY the old separate Job Portal holds into the TeamLink database.
//
// The job portal is built in now (/careers, routes/careersPublic.js). The old
// app (job-portal-app/job_portal-main) kept its own embedded PostgreSQL in
// var/dev-db and its resume files in var/uploads. This script reads them and
// brings over what the TeamLink database does not have yet:
//   * portal candidates      -> Candidate (only when no candidate with that
//                               email / phone exists — the same duplicate
//                               check as the portal's apply form)
//   * their resume file      -> an ORIGINAL resume version (resumeStore)
//   * applications on TeamLink jobs (tl_<requirement id>) whose requirement
//     still exists           -> Application at NEW, source "TeamLink Job Portal"
// Portal logins (passwords), demo admin/BDE accounts, settings, templates and
// the portal's copies of TeamLink jobs are NOT moved: candidates sign in with
// a one-time code, and the jobs are the requirements themselves.
//
// SAFE BY DEFAULT
//   * DRY RUN unless --apply is given: it prints what it WOULD do, writes nothing.
//   * The portal database folder is COPIED to a temp folder first and only the
//     copy is opened, so the old app's data is never touched (stop the old app
//     first if it is running).
//   * Writes go to whatever DATABASE_URL points at (backend/.env = the real
//     dev.db). To try it on the test copy first:
//       DATABASE_URL=file:./prisma/sandbox.db node scripts/migrate-job-portal-store.js --apply
//
// Usage (in backend/):
//   node scripts/migrate-job-portal-store.js                 # dry run, real DB
//   node scripts/migrate-job-portal-store.js --apply         # do it
//   options: --portal <dir of job_portal-main>   (default ../job-portal-app/job_portal-main)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const PORTAL = path.resolve(argOf('--portal') || path.join(__dirname, '..', '..', 'job-portal-app', 'job_portal-main'));
const PORTAL_DB = path.join(PORTAL, 'var', 'dev-db');
const PORTAL_UPLOADS = path.join(PORTAL, 'var', 'uploads');

const mask = (e) => String(e || '').replace(/^(.).*?(.)?@/, (m, a, b) => `${a}***${b || ''}@`);

function findResume(cand) {
  // The portal's local storage driver keeps files under var/uploads/<storage path>.
  const tries = [];
  if (cand.resume_storage_path) tries.push(path.join(PORTAL_UPLOADS, cand.resume_storage_path));
  const dir = path.join(PORTAL_UPLOADS, 'candidates', cand.id);
  if (fs.existsSync(dir)) fs.readdirSync(dir).forEach((f) => tries.push(path.join(dir, f)));
  return tries.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

(async () => {
  if (!fs.existsSync(path.join(PORTAL_DB, 'PG_VERSION'))) {
    console.log(`No portal database at ${PORTAL_DB} — nothing to migrate.`);
    return;
  }
  const target = process.env.DATABASE_URL || '(not set)';
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — portal: ${PORTAL_DB}`);
  console.log(`TeamLink database: ${target}\n`);

  // 1. read a COPY of the portal database
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-jobportal-copy-'));
  fs.cpSync(PORTAL_DB, copy, { recursive: true });
  const pgliteEntry = path.join(PORTAL, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js');
  const { PGlite } = await import(pathToFileURL(pgliteEntry).href);
  const pg = await new PGlite(copy);
  const q = async (sql) => (await pg.query(sql)).rows;
  const cands = await q('select * from candidates order by created_at');
  const apps = await q(`select a.id, a.job_id, a.candidate_id, a.stage, a.source, a.reference, a.applied_at, j.title as job_title
                          from applications a join jobs j on j.id = a.job_id order by a.applied_at`);
  await pg.close();
  fs.rmSync(copy, { recursive: true, force: true });

  // 2. compare with TeamLink (lazy: DATABASE_URL must be final first)
  // eslint-disable-next-line global-require
  const prisma = require('../src/db');
  // eslint-disable-next-line global-require
  const { findCandidateByContact } = require('../src/utils/jobPortalBridge');
  // eslint-disable-next-line global-require
  const store = require('../src/utils/resumeStore');
  // eslint-disable-next-line global-require
  const { PORTAL_APPLICATION_SOURCE } = require('../src/utils/atsVocab');

  const plan = { candidatesInPortal: cands.length, candidatesAlreadyInTeamLink: 0, candidatesToCreate: 0, resumesToAttach: 0, resumesMissing: 0, applicationsInPortal: apps.length, applicationsToCreate: 0, applicationsAlreadyThere: 0, applicationsJobGone: 0, applicationsNotTeamLinkJob: 0 };
  const map = new Map(); // portal candidate id -> TeamLink candidate (or planned)
  const lines = [];
  for (const c of cands) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await findCandidateByContact({ email: c.email, phone: c.phone });
    const file = findResume(c);
    if (hit) {
      plan.candidatesAlreadyInTeamLink += 1;
      map.set(c.id, { existing: hit });
      lines.push(`  = ${c.name} (${mask(c.email)}) — already in TeamLink as ${hit.id}; nothing changed`);
    } else {
      plan.candidatesToCreate += 1;
      if (file) plan.resumesToAttach += 1; else if (c.resume_file) plan.resumesMissing += 1;
      map.set(c.id, { create: c, file });
      lines.push(`  + ${c.name} (${mask(c.email)}) — NEW candidate${file ? ` + resume ${path.basename(c.resume_file || file)}` : (c.resume_file ? ' (resume file not found)' : '')}`);
    }
  }
  const appPlan = [];
  for (const a of apps) {
    const reqId = String(a.job_id).startsWith('tl_') ? String(a.job_id).slice(3) : null;
    if (!reqId) { plan.applicationsNotTeamLinkJob += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    const req = await prisma.requirement.findUnique({ where: { id: reqId }, select: { id: true, title: true } });
    if (!req) { plan.applicationsJobGone += 1; lines.push(`  ! application ${a.reference || a.id} — job "${a.job_title}" no longer exists in TeamLink; skipped`); continue; }
    const who = map.get(a.candidate_id);
    if (who && who.existing) {
      // eslint-disable-next-line no-await-in-loop
      const dup = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: who.existing.id, requirementId: req.id } } });
      if (dup) { plan.applicationsAlreadyThere += 1; continue; }
    }
    plan.applicationsToCreate += 1;
    appPlan.push({ a, req, who });
    lines.push(`  + application ${a.reference || a.id} → ${req.title}`);
  }

  console.log(lines.join('\n') || '  (nothing)');
  console.log('\nCounts:', JSON.stringify(plan, null, 2));

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Run again with --apply to do it.');
    await prisma.$disconnect();
    return;
  }

  // 3. apply
  const done = { candidates: 0, resumes: 0, applications: 0 };
  for (const [pid, who] of map) {
    if (!who.create) continue;
    const c = who.create;
    // eslint-disable-next-line no-await-in-loop
    const again = await findCandidateByContact({ email: c.email, phone: c.phone });
    if (again) { who.existing = again; continue; }
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.candidate.create({
      data: {
        name: c.name,
        email: c.email || null,
        phone: c.phone || null,
        source: 'Job Portal',
        firstSource: PORTAL_APPLICATION_SOURCE,
        location: c.location || null,
        currentCompany: c.current_company || null,
        currentDesignation: c.title || null,
        experienceYears: c.exp_years == null ? null : Number(c.exp_years),
        skills: Array.isArray(c.skills) && c.skills.length ? c.skills.join(', ') : null,
        education: c.education || null,
        noticePeriod: c.notice_period || undefined,
        expectedSalary: c.expected_ctc == null ? null : String(c.expected_ctc),
        createdAt: c.created_at ? new Date(c.created_at) : undefined,
      },
    });
    who.existing = row;
    done.candidates += 1;
    // eslint-disable-next-line no-await-in-loop
    await prisma.syncLog.create({ data: { entity: 'Candidates', status: 'Success', reason: `${row.name} moved from the old Job Portal store (portal ${pid})`, recordRef: row.id } });
    if (who.file) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await store.saveOriginalResume({
          candidateId: row.id,
          file: { filename: c.resume_file || path.basename(who.file), contentType: c.resume_mime || '', data: fs.readFileSync(who.file) },
          note: 'moved from the old Job Portal',
        });
        done.resumes += 1;
      } catch (err) {
        console.log(`  resume for ${row.name} not stored: ${err.code || err.message}`);
      }
    }
  }
  for (const { a, req, who } of appPlan) {
    if (!who || !who.existing) continue;
    // eslint-disable-next-line no-await-in-loop
    const dup = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: who.existing.id, requirementId: req.id } } });
    if (dup) continue;
    // eslint-disable-next-line no-await-in-loop
    const app = await prisma.application.create({
      data: {
        candidateId: who.existing.id, requirementId: req.id, stage: 'NEW', source: PORTAL_APPLICATION_SOURCE,
        firstSource: PORTAL_APPLICATION_SOURCE, applicationMethod: 'Auto-Apply',
        createdAt: a.applied_at ? new Date(a.applied_at) : undefined,
      },
    });
    done.applications += 1;
    // eslint-disable-next-line no-await-in-loop
    await prisma.syncLog.create({ data: { entity: 'Applications', status: 'Success', reason: `${who.existing.name} → ${req.title} (moved from the old Job Portal, ${a.reference || a.id})`, recordRef: app.id } });
  }
  console.log('\nDone:', JSON.stringify(done));
  await prisma.$disconnect();
})().catch((err) => { console.error('Migration failed:', err); process.exit(1); });
