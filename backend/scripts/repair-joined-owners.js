#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// GIVE JOINED CANDIDATES BACK TO WHO PLACED THEM (founder 2026-11-10: "koushik, janathri, vellu recent ga join ayyaru, recruiters ga,
// ayina kaani, vellki joiings vachai... avi vallavi kaadhu, previous recruters vi").
//
// Until 2026-11-10, taking a recruiter off a requirement moved ALL its candidates - Joined ones too - to the new main recruiter, and
// the one-time follow-up clean-up of 2026-11-04 then put that recruiter's name on the candidates' last follow-up. So a recruiter who
// joined in late October "owned" joinings from before they joined. For every Joined / Hired candidate whose owner joined the company
// (HR > Date of joining) AFTER the joining day:
//   - the owner goes back to who placed them (utils/workers.js joinCredit: who got them Selected / who had them on the joining day,
//     from the history and the handover records), or to nobody when that person has no login (a name from the old sheets);
//   - follow-ups written before the late owner joined, that carry the late owner's name, get the placing recruiter's name back;
//   - one audit row per candidate. Steps, dates and everything else stay as they are.
//
//   node scripts/repair-joined-owners.js                                             DRY RUN: what would change, per recruiter
//   TL_ALLOW_REAL_APPLY=1 node scripts/repair-joined-owners.js --apply --really-real  does it (VACUUM INTO backup first)
// Running it twice changes nothing new.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
if (APPLY && !(argv.includes('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
const BACK = path.resolve(__dirname, '..');
process.chdir(BACK);
require('dotenv').config({ path: path.join(BACK, '.env') });
const prisma = require('../src/db');
const W = require('../src/utils/workers');
const H = require('../src/utils/handover');
const { logAudit } = require('../src/utils/audit');

const istDay = (v) => (v ? new Date(new Date(v).getTime() + 330 * 60000).toISOString().slice(0, 10) : null);
const dayOf = (a, evs) => {
  if (/^\d{4}-\d{2}-\d{2}/.test(String(a.joiningDate || '')) && +String(a.joiningDate).slice(0, 4) >= 2015) return String(a.joiningDate).slice(0, 10);
  if (a.joinedAt) return istDay(a.joinedAt);
  const e = evs.find((x) => ['JOINED', 'HIRED'].includes(x.toStage));
  return e ? istDay(e.createdAt) : null;
};

(async () => {
  try {
    const dir = await W.loadDirectory();
    const apps = await prisma.application.findMany({
      where: { stage: { in: ['JOINED', 'HIRED'] }, ownerRecruiterId: { not: null } },
      select: {
        id: true, candidateId: true, ownerRecruiterId: true, joiningDate: true, joinedAt: true,
        candidate: { select: { name: true } },
        requirement: { select: { reqCode: true, recruiterId: true, recruiterIds: true, tlId: true, tl: true, positionCode: true } },
        followUps: { orderBy: { createdAt: 'asc' } },
        stageEvents: { orderBy: { createdAt: 'asc' } },
      },
    });
    const HO = await H.handoversFor(apps.map((a) => a.id));
    const plan = [];
    for (const a of apps) {
      const start = dir.person.startOf(a.ownerRecruiterId);
      const day = dayOf(a, a.stageEvents);
      if (!start || !day) continue; // eslint-disable-line no-continue
      const startDay = istDay(start);
      if (startDay <= day) continue; // eslint-disable-line no-continue -- the owner was here by the joining day
      const r = a.requirement || {};
      const attrReq = { recruiterId: r.recruiterId || String(r.recruiterIds || '').split(',').map((x) => x.trim()).filter(Boolean)[0] || null, tlId: r.tlId, tl: r.tl, positionCode: r.positionCode };
      const credit = W.joinCredit(attrReq, a.followUps, a.stageEvents, dir.person, `${day}T23:59:59+05:30`, HO.get(a.id));
      if (credit && credit.userId === a.ownerRecruiterId) continue; // eslint-disable-line no-continue
      const lateName = (dir.person.userById.get(a.ownerRecruiterId) || {}).name || 'the late owner';
      const fus = a.followUps.filter((f) => f.ownerUserId === a.ownerRecruiterId && new Date(f.createdAt).getTime() < start);
      plan.push({ a, day, startDay, lateName, credit, fus });
    }

    const byLate = new Map();
    plan.forEach((p) => { const k = p.lateName; if (!byLate.has(k)) byLate.set(k, new Map()); const m = byLate.get(k); const to = p.credit ? p.credit.label : 'nobody (an earlier recruiter with no login)'; m.set(to, (m.get(to) || 0) + 1); });
    console.log(`${plan.length} Joined candidate(s) are owned by a recruiter who joined the company after the joining day.`);
    for (const [late, m] of byLate) {
      console.log(`  ${late}: ${[...m.values()].reduce((x, y) => x + y, 0)} -> ${[...m.entries()].map(([to, n]) => `${to} ${n}`).join(', ')}`);
    }
    plan.slice(0, 25).forEach((p) => console.log(`    ${p.a.candidate ? p.a.candidate.name : '—'} (${p.a.requirement && p.a.requirement.reqCode}) joined ${p.day}; ${p.lateName} joined ${p.startDay} -> ${p.credit ? p.credit.label : 'nobody'}${p.fus.length ? `; ${p.fus.length} follow-up name(s) back` : ''}`));
    if (plan.length > 25) console.log(`    … and ${plan.length - 25} more`);
    if (!APPLY) { console.log('DRY RUN: nothing was changed.'); return; }
    if (!plan.length) { console.log('Nothing to change.'); return; }

    const bakDir = path.join(os.homedir(), '.teamlink-backups', `repair-joined-owners-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    let done = 0;
    for (const p of plan) {
      const toId = p.credit && p.credit.userId ? p.credit.userId : null;
      const toName = p.credit ? p.credit.label : null;
      // eslint-disable-next-line no-await-in-loop
      await prisma.$transaction([
        prisma.application.update({ where: { id: p.a.id }, data: { ownerRecruiterId: toId } }),
        ...p.fus.map((f) => prisma.applicationFollowUp.update({ where: { id: f.id }, data: { ownerUserId: toId, ownerName: toName || f.ownerName } })),
      ]);
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: null, actorName: 'Joinings clean-up 2026-11-10', action: 'Joined candidate given back to who placed them', entity: 'Application', entityId: p.a.id, fromValue: p.lateName, toValue: toName || 'nobody (earlier recruiter)', reason: `Joined ${p.day}; ${p.lateName} joined the company ${p.startDay}` });
      try { require('../src/utils/candidateListCache').markCandidateDirty(p.a.candidateId); } catch { /* catches up */ } // eslint-disable-line global-require
      done += 1;
    }
    console.log(`DONE: ${done} Joined candidate(s) given back. Backup (before this): ${bak}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
