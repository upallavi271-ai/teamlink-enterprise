#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// WHOSE CANDIDATE IS IT - for the applications that existed before Application.ownerRecruiterId (founder 2026-10-26: "oka recruiter
// daggara vunna candidates inkokari dhaanlo kanipinchakudadhu").
//
// The same attribution ATS Reports use (utils/workers.js): the recruiter on the application's follow-up record (imported trackers
// carry it), else the last real recruiter who moved it - when that person can sign in as a RECRUITER and is still on the requirement.
// Everything else goes to the requirement's own recruiter (its main recruiter, else the first assigned: utils/applicationOwner.js),
// founder 2026-10-26: "ekkada nunchi vachina, ahh respective recruiter & tl daggara ki vellali, inka evariki kanipinchakudadhu".
// A requirement with no recruiter leaves its candidates unowned (only its TL and above see them) until a recruiter is assigned.
//
//   node scripts/backfill-application-owners.js                         DRY RUN on prisma/dev.db
//   node scripts/backfill-application-owners.js --db <copy.db> --apply  on a copy
//   TL_ALLOW_REAL_APPLY=1 node scripts/backfill-application-owners.js --apply --really-real
//   node scripts/backfill-application-owners.js --undo <undo.json> [--db <db>] [--really-real]
// SAFETY: dry run by default; VACUUM INTO backup; undo file (ids it set); only fills empty owners, so running it twice adds nothing.
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
const UNDO = val('--undo');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first, or --db <copy>.');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const prisma = require('../src/db');
const W = require('../src/utils/workers');

(async () => {
  try {
    if (UNDO) {
      const u = JSON.parse(fs.readFileSync(UNDO, 'utf8'));
      const r = await prisma.application.updateMany({ where: { id: { in: u.ids } }, data: { ownerRecruiterId: null } });
      console.log(`UNDONE: ${r.count} application(s) are unowned again.`);
      return;
    }
    const dir = await W.loadDirectory();
    const recruiters = new Map(dir.users.filter((u) => u.atsRole === 'RECRUITER' && u.status === 'Active').map((u) => [u.id, u]));
    const ids0 = (await prisma.application.findMany({ where: { ownerRecruiterId: null }, select: { id: true } })).map((x) => x.id);
    const apps = [];
    for (let i = 0; i < ids0.length; i += 500) apps.push(...await prisma.application.findMany({
      where: { id: { in: ids0.slice(i, i + 500) } },
      select: {
        id: true,
        requirement: { select: { recruiterId: true, recruiterIds: true } },
        // (the requirement's recruiter is the fallback owner)
        followUps: { select: { ownerUserId: true, ownerName: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        stageEvents: { where: W.REAL_EVENT, select: { actorUserId: true, actorName: true, actorRole: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      },
    }));
    const set = new Map();
    let notOnJob = 0; let nobody = 0; let toMain = 0; let noRecruiter = 0;
    const AO = require('../src/utils/applicationOwner');
    const fallback = (a) => { const d = AO.defaultOwnerOf(a.requirement); if (d) { set.set(a.id, d); toMain += 1; } else noRecruiter += 1; };
    for (const a of apps) {
      const fu = [...a.followUps].reverse().find((x) => x.ownerName || x.ownerUserId);
      let who = fu ? dir.person(fu.ownerUserId, fu.ownerName) : null;
      if (!who) {
        const ev = [...a.stageEvents].reverse().find((e) => W.roleOfLabel(e.actorRole) === 'RECRUITER' && W.realActor(e));
        if (ev) who = dir.person(ev.actorUserId, ev.actorName);
      }
      if (!who || !who.userId || !recruiters.has(who.userId)) { nobody += 1; fallback(a); continue; } // eslint-disable-line no-continue
      const r = a.requirement || {};
      const onJob = r.recruiterId === who.userId || String(r.recruiterIds || '').split(',').map((x) => x.trim()).includes(who.userId);
      if (!onJob) { notOnJob += 1; fallback(a); continue; } // eslint-disable-line no-continue
      set.set(a.id, who.userId);
    }
    const perPerson = {};
    set.forEach((uid) => { const n = recruiters.get(uid).name; perPerson[n] = (perPerson[n] || 0) + 1; });
    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    console.log(`Unowned applications: ${apps.length}. Given an owner: ${set.size} (by who worked it: ${set.size - toMain}; to the requirement's own recruiter: ${toMain}). Requirement has no recruiter (stay with its TL only): ${noRecruiter}. [no recruiter login behind the work: ${nobody}, that recruiter left the job: ${notOnJob}]`);
    console.log('Per recruiter:', perPerson);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }
    const out = path.resolve(isReal ? path.join(os.homedir(), '.teamlink-backups', `backfill-owners-${STAMP}`) : path.join(path.dirname(dbArg), `backfill-owners-${STAMP}`));
    fs.mkdirSync(out, { recursive: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${path.join(out, 'before.db').split(path.sep).join('/').replace(/'/g, "''")}'`);
    const byOwner = new Map();
    set.forEach((uid, id) => { if (!byOwner.has(uid)) byOwner.set(uid, []); byOwner.get(uid).push(id); });
    await prisma.$transaction(async (tx) => {
      for (const [uid, ids] of byOwner) {
        for (let i = 0; i < ids.length; i += 400) await tx.application.updateMany({ where: { id: { in: ids.slice(i, i + 400) }, ownerRecruiterId: null }, data: { ownerRecruiterId: uid } });
      }
    }, { timeout: 600000 });
    fs.writeFileSync(path.join(out, 'undo.json'), JSON.stringify({ at: new Date().toISOString(), ids: [...set.keys()] }));
    console.log(`\nDONE: ${set.size} owner(s) set.\nBackup: ${path.join(out, 'before.db')}\nUndo:   node scripts/backfill-application-owners.js --undo "${path.join(out, 'undo.json')}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e.message.slice(0, 500)); process.exit(1); });
