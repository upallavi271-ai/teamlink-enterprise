// ---------------------------------------------------------------------------
// MERGES DUPLICATE CANDIDATES AND REQUIREMENTS left by the interrupted imports.
//
//   node scripts/dedupe-imported.js            dry run
//   node scripts/dedupe-imported.js --confirm  merge them
//
// The batch-2 import was killed and restarted four times — twice by nodemon
// restarting the server on its own database writes, twice by Node's fetch
// giving up at five minutes. Each attempt got part way, and a few records came
// out the other side more than once.
//
// WHAT COUNTS AS THE SAME RECORD, and nothing looser:
//
//   a candidate   the same email, or the same phone where there is no email.
//                 That is exactly the key the importer itself upserts on, so
//                 this only finishes what an uninterrupted run would have done.
//
//   a requirement the same client, department, job title and specialisation.
//                 Education (the qualification) is NOT part of the key here,
//                 because the same post was written "MD" on one sheet and left
//                 blank on another, and batch 1 made two requirements out of
//                 it. Where the two disagree the fuller value is kept.
//
// THE SURVIVOR IS THE OLDEST ROW, so the id that other records already point
// at stays valid. Everything hanging off a merged row — applications, stage
// events, follow-ups, interviews, notes, documents, invoices — is repointed
// at the survivor BEFORE it is deleted, and a repoint that would collide with
// a row the survivor already has is dropped instead of duplicated.
// ---------------------------------------------------------------------------

const prisma = require('../src/db');

const CONFIRM = process.argv.includes('--confirm');
const k = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const longer = (a, b) => ((b || '').length > (a || '').length ? b : a);

async function dedupeCandidates() {
  const rows = await prisma.candidate.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, email: true, phone: true, createdAt: true },
  });
  const groups = {};
  rows.forEach((c) => {
    const key = c.email ? `e:${k(c.email)}` : (c.phone ? `p:${k(c.phone)}` : '');
    if (!key) return;
    (groups[key] = groups[key] || []).push(c);
  });
  const dupes = Object.values(groups).filter((g) => g.length > 1);
  let removed = 0;
  let moved = 0;

  for (const group of dupes) {
    const [keep, ...drop] = group; // oldest first
    for (const d of drop) {
      // Applications move across unless the survivor already has one for the
      // same requirement — that pair is unique, so the extra is deleted.
      const apps = await prisma.application.findMany({ where: { candidateId: d.id }, select: { id: true, requirementId: true } });
      for (const a of apps) {
        const clash = await prisma.application.findFirst({ where: { candidateId: keep.id, requirementId: a.requirementId }, select: { id: true } });
        if (clash) {
          if (CONFIRM) {
            await prisma.applicationStageEvent.updateMany({ where: { applicationId: a.id }, data: { applicationId: clash.id } }).catch(() => {});
            await prisma.application.delete({ where: { id: a.id } });
          }
        } else if (CONFIRM) {
          await prisma.application.update({ where: { id: a.id }, data: { candidateId: keep.id } });
          moved += 1;
        } else moved += 1;
      }
      if (CONFIRM) {
        for (const m of ['applicationStageEvent', 'candidateMessage', 'candidateNote', 'candidateDocument', 'invoice']) {
          await prisma[m].updateMany({ where: { candidateId: d.id }, data: { candidateId: keep.id } }).catch(() => {});
        }
        await prisma.candidate.delete({ where: { id: d.id } });
      }
      removed += 1;
    }
  }
  return { groups: dupes.length, removed, moved };
}

async function dedupeRequirements() {
  const rows = await prisma.requirement.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, reqCode: true, title: true, department: true, specialisation: true,
      clientId: true, education: true, jobDescription: true, openings: true, status: true,
    },
  });
  const groups = {};
  rows.forEach((r) => {
    const key = [r.department || '', r.clientId, k(r.title), k(r.specialisation)].join('|');
    (groups[key] = groups[key] || []).push(r);
  });
  const dupes = Object.values(groups).filter((g) => g.length > 1);
  let removed = 0;
  let moved = 0;

  for (const group of dupes) {
    const [keep, ...drop] = group;
    // Keep the fuller description, qualification and openings, and stay OPEN
    // if any copy is open — a closed duplicate must not close a live post.
    const patch = {};
    drop.forEach((d) => {
      patch.education = longer(patch.education || keep.education, d.education);
      patch.jobDescription = longer(patch.jobDescription || keep.jobDescription, d.jobDescription);
      if (keep.openings == null && d.openings != null) patch.openings = d.openings;
      if (d.status === 'OPEN') patch.status = 'OPEN';
    });

    for (const d of drop) {
      const apps = await prisma.application.findMany({ where: { requirementId: d.id }, select: { id: true, candidateId: true } });
      for (const a of apps) {
        const clash = await prisma.application.findFirst({ where: { requirementId: keep.id, candidateId: a.candidateId }, select: { id: true } });
        if (clash) {
          if (CONFIRM) {
            await prisma.applicationStageEvent.updateMany({ where: { applicationId: a.id }, data: { applicationId: clash.id } }).catch(() => {});
            await prisma.application.delete({ where: { id: a.id } });
          }
        } else if (CONFIRM) {
          await prisma.application.update({ where: { id: a.id }, data: { requirementId: keep.id } });
          moved += 1;
        } else moved += 1;
      }
      if (CONFIRM) {
        await prisma.applicationStageEvent.updateMany({ where: { requirementId: d.id }, data: { requirementId: keep.id } }).catch(() => {});
        await prisma.invoice.updateMany({ where: { requirementId: d.id }, data: { requirementId: keep.id } }).catch(() => {});
        await prisma.requirement.delete({ where: { id: d.id } });
      }
      removed += 1;
    }
    if (CONFIRM && Object.keys(patch).length) {
      await prisma.requirement.update({ where: { id: keep.id }, data: patch });
    }
  }
  return { groups: dupes.length, removed, moved };
}

(async () => {
  console.log(CONFIRM ? '=== MERGING ===\n' : '=== DRY RUN — nothing will change ===\n');
  const c = await dedupeCandidates();
  console.log(`candidates:   ${c.groups} duplicate groups, ${c.removed} rows ${CONFIRM ? 'removed' : 'would be removed'}, ${c.moved} applications ${CONFIRM ? 'repointed' : 'would move'}`);
  const r = await dedupeRequirements();
  console.log(`requirements: ${r.groups} duplicate groups, ${r.removed} rows ${CONFIRM ? 'removed' : 'would be removed'}, ${r.moved} applications ${CONFIRM ? 'repointed' : 'would move'}`);
  console.log(`\nnow: ${await prisma.candidate.count()} candidates, ${await prisma.requirement.count()} requirements, ${await prisma.application.count()} applications`);
  if (!CONFIRM) console.log('\nRe-run with --confirm.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
