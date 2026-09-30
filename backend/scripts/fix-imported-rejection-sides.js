// ---------------------------------------------------------------------------
// PUT THE RIGHT SIDE ON THE IMPORTED REJECTIONS.
//
// Every rejection that came in from the spreadsheets was stamped
// actorSide "Internal" — TeamLink's decision — whatever it actually was. So
// 2,777 candidates who declined an offer, 2,092 who did not turn up to an
// interview and 548 the client did not select all read as though TeamLink
// had screened them out. That is not a detail: "the client said no" and "the
// candidate said no" lead to opposite next steps.
//
// WHERE THE RIGHT ANSWER COMES FROM. Not from reading free text. The importer
// (utils/importNormalise.js STATUS_MAP) turned each source status into one of
// a small fixed set of reason phrases, and each phrase names its own side:
// "offer declined by the candidate" is the candidate's, "not shortlisted by
// the client" is the client's. This table maps those exact phrases and
// nothing else.
//
// "Rejected" and "Interview not done" say nothing about who decided. They are
// NOT guessed: their side is cleared to null, which the screens show as
// "Not recorded" — true, where "Internal" was false.
//
// Touches only rejection events whose actor is "Imported from spreadsheet".
// Nothing a person recorded in the app is changed. Dry run by default;
// --commit writes, after backing up every row it changes.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const prisma = require('../src/db');

const COMMIT = process.argv.includes('--commit');
const IMPORTED = 'Imported from spreadsheet';

// phrase (as the importer wrote it) -> [side, category]
const MAP = {
  "Won't join — offer declined by the candidate": ['Candidate', 'Offer Declined'],
  'Did not attend the interview': ['Candidate', 'Did Not Attend Interview'],
  "Won't attend the interview": ['Candidate', 'Did Not Attend Interview'],
  'Candidate not interested': ['Candidate', 'Not Interested'],
  'Dropped out': ['Candidate', 'Not Interested'],
  'Did not join': ['Candidate', 'Did Not Join'],
  'Not selected': ['Client', 'Not Selected'],
  'Not shortlisted by the client': ['Client', 'Not Shortlisted'],
  'Not eligible': ['Internal', 'Not Eligible'],
  // Say nothing about who decided — cleared rather than guessed.
  Rejected: [null, null],
  'Interview not done': [null, null],
};

(async () => {
  console.log(COMMIT ? '*** COMMIT ***\n' : '*** DRY RUN — nothing will be written ***\n');
  const events = await prisma.applicationStageEvent.findMany({
    where: { toStage: 'REJECTED', actorName: IMPORTED },
    select: { id: true, reasonDetail: true, reasonCategory: true, actorSide: true },
  });

  const plan = new Map(); // key -> { ids, side, category }
  const unknown = {};
  events.forEach((e) => {
    const m = MAP[e.reasonDetail];
    if (!m) { unknown[e.reasonDetail] = (unknown[e.reasonDetail] || 0) + 1; return; }
    const [side, category] = m;
    if (e.actorSide === side && (e.reasonCategory || null) === (category || e.reasonCategory || null)) return;
    const k = `${e.reasonDetail}`;
    if (!plan.has(k)) plan.set(k, { ids: [], side, category });
    plan.get(k).ids.push(e.id);
  });

  console.log(`imported rejection events: ${events.length}\n`);
  console.log('  ' + 'REASON (as imported)'.padEnd(46) + 'SIDE'.padEnd(12) + 'CATEGORY'.padEnd(26) + 'ROWS');
  let total = 0;
  [...plan.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length).forEach(([reason, p]) => {
    total += p.ids.length;
    console.log('  ' + reason.padEnd(46) + String(p.side || 'not recorded').padEnd(12)
      + String(p.category || '—').padEnd(26) + p.ids.length);
  });
  console.log(`\n  ${total} rows would change.`);
  if (Object.keys(unknown).length) {
    console.log('\nPHRASES NOT IN THE MAP — left exactly as they are:');
    Object.entries(unknown).forEach(([k, n]) => console.log(`  ${k}: ${n}`));
  }

  if (!COMMIT) { console.log('\nDRY RUN — re-run with --commit to apply.'); process.exit(0); }

  const dir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rejection-sides-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const allIds = [...plan.values()].flatMap((p) => p.ids);
  fs.writeFileSync(file, JSON.stringify(await prisma.applicationStageEvent.findMany({
    where: { id: { in: allIds } },
    select: { id: true, actorSide: true, reasonCategory: true, reasonDetail: true },
  }), null, 2));
  console.log('\nbackup: ' + file);

  for (const p of plan.values()) {
    // Chunked: SQLite caps the number of bound parameters in one statement.
    for (let i = 0; i < p.ids.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.applicationStageEvent.updateMany({
        where: { id: { in: p.ids.slice(i, i + 500) } },
        data: { actorSide: p.side, ...(p.category ? { reasonCategory: p.category } : {}) },
      });
    }
  }
  const after = await prisma.applicationStageEvent.groupBy({
    by: ['actorSide'], where: { toStage: 'REJECTED' }, _count: true,
  });
  console.log('\nREJECTION SIDES NOW');
  after.forEach((r) => console.log('  ' + String(r.actorSide || 'not recorded').padEnd(14) + r._count));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
