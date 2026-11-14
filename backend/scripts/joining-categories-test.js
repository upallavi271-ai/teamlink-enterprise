// node scripts/joining-categories-test.js
// The Medical category targets (founder 2026-11-14): which category a joining is, how each target and the total close, a recruiter's share, the
// incentive. Part 1 is pure (no database). Part 2 runs on the SANDBOX copy only (it refuses any other database): the category counts against the
// Recruiter joinings numbers, and the closing and incentive against a hand calculation. It writes test targets into the sandbox and takes them out.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./sandbox.db';
if (!/sandbox/i.test(process.env.DATABASE_URL)) { console.error('Refusing: this test only runs on the sandbox database.'); process.exit(1); }
process.env.TEST_MODE = '1';
const assert = require('assert');
const JC = require('../src/utils/joiningCategories');

const cls = (f) => JC.classifyMedical({ employmentType: 'Full Time', ...f });
const key = (f) => { const r = cls(f); return r.bucket === 'six' ? r.category : r.bucket; };

// ---- Part 1: the category of a joining ---------------------------------------------------------------------------------------------
assert.strictEqual(key({ education: 'MD', title: 'Consultant Doctor — Dermatology' }), 'MD_MS_DOCTOR_FT');
assert.strictEqual(key({ education: 'MBBS, MD', title: 'Sr Doctor — Pediatrics' }), 'MD_MS_DOCTOR_FT', 'MBBS + MD is an MD doctor');
assert.strictEqual(key({ education: 'MBBS, MS', title: 'Consultant Doctor — General Surgery' }), 'MD_MS_DOCTOR_FT');
assert.strictEqual(key({ education: 'M.D', title: 'Medical Officer' }), 'MD_MS_DOCTOR_FT', 'M.D = MD');
assert.strictEqual(key({ education: 'MD', title: 'Assistant Professor — Biochemistry' }), 'MD_MS_FACULTY_FT');
assert.strictEqual(key({ education: 'MD DVL', title: 'Senior Resident — Dermatology, Cosmetology' }), 'MD_MS_FACULTY_FT', 'Senior Resident is faculty');
assert.strictEqual(key({ education: 'MD', title: 'Associate Professor — Radiology' }), 'MD_MS_FACULTY_FT');
assert.strictEqual(key({ education: 'MBBS, MD', title: 'Professor — Physiology' }), 'MD_MS_FACULTY_FT');
assert.strictEqual(key({ education: 'MD', title: 'Asst. Prof — Anatomy' }), 'MD_MS_FACULTY_FT', 'Asst. Prof');
assert.strictEqual(key({ education: 'MD', title: 'Assistant Professor — Dvl', employmentType: 'Part Time' }), 'MD_MS_FACULTY_PT');
assert.strictEqual(key({ education: 'MS', title: 'Consultant', employmentType: 'part time' }), 'MD_MS_DOCTOR_PT');
assert.strictEqual(key({ education: 'MBBS', title: 'Duty Medical Officer' }), 'MBBS_DOCTOR_FT');
assert.strictEqual(key({ education: 'Mbbs', title: 'Duty Doctor' }), 'MBBS_DOCTOR_FT');
assert.strictEqual(key({ education: 'MBBS', title: 'Duty Doctor', employmentType: 'Part Time' }), 'other', 'MBBS Part Time has no target');
assert.strictEqual(key({ education: 'GNM', title: 'Staff Nurse — Nursing' }), 'STAFF_NURSE');
assert.strictEqual(key({ education: 'B.Sc', title: 'Ot-Scurb Nurse — Nursing' }), 'STAFF_NURSE');
assert.strictEqual(key({ education: 'BSc', title: 'Nursing — Nursing' }), 'STAFF_NURSE', 'a bare "Nursing" post is a nurse');
assert.strictEqual(key({ education: 'GNM', title: 'Staff Nurse', employmentType: 'Part Time' }), 'STAFF_NURSE', 'Staff Nurses has one target, Full or Part');
assert.strictEqual(key({ education: 'B.Sc', title: 'Tutor — Nursing' }), 'other', 'a nursing tutor is not a staff nurse');
assert.strictEqual(key({ education: 'M.Sc', title: 'Assistant Professor — Medical Surgical Nursing' }), 'other', 'M.Sc is recorded and is not a doctor');
assert.strictEqual(key({ education: 'B.Pharmacy', title: 'Pharmacist — Pharmacy' }), 'other');
assert.strictEqual(key({ education: 'M.Sc', title: 'Nutrition — Nutrition' }), 'other', 'M.Sc is not MS');
assert.strictEqual(key({ education: null, title: 'Associate Professor — Radiology' }), 'check', 'a doctor post with no qualification cannot be told');
assert.strictEqual(key({ education: 'DNB', title: 'Consultant' }), 'check', 'DNB / DM / MCh is for the founder to say');
assert.strictEqual(key({ education: 'MD', title: 'Consultant', employmentType: 'Contract' }), 'check', 'Contract is neither Full nor Part');
assert.strictEqual(key({ education: 'MD', title: 'Consultant', employmentType: '' }), 'check');
assert.strictEqual(key({ education: null, qualificationName: 'MD', title: 'Consultant' }), 'MD_MS_DOCTOR_FT', 'the master qualification counts too');
// Super Admin's switch: a faculty post with NO qualification recorded counts as MD/MS faculty (and says so); off, it needs a check
const sw = JC.classifyMedical({ education: null, title: 'Associate Professor — Radiology', employmentType: 'Full Time', facultyImpliesMdMs: true });
assert.deepStrictEqual([sw.bucket, sw.category, sw.assumed], ['six', 'MD_MS_FACULTY_FT', true]);
assert.strictEqual(JC.classifyMedical({ education: null, title: 'Associate Professor — Radiology', employmentType: 'Part Time', facultyImpliesMdMs: true }).category, 'MD_MS_FACULTY_PT');
assert.strictEqual(JC.classifyMedical({ education: null, title: 'Consultant Doctor', employmentType: 'Full Time', facultyImpliesMdMs: true }).bucket, 'check', 'only faculty posts are assumed, not any doctor post');
assert.strictEqual(JC.classifyMedical({ education: 'MBBS', title: 'Assistant Professor — Anatomy', employmentType: 'Full Time', facultyImpliesMdMs: true }).category, 'MBBS_DOCTOR_FT', 'a recorded MBBS is never changed by the switch');
assert.strictEqual(JC.classifyMedical({ education: 'M.Sc', title: 'Assistant Professor — Nursing', employmentType: 'Full Time', facultyImpliesMdMs: true }).bucket, 'other', 'a recorded non-doctor qualification is never changed either');
// the joining's own designation wins over the job title (it can be corrected)
assert.strictEqual(key({ education: 'MD', title: 'Consultant', designation: 'Associate Professor — ENT' }), 'MD_MS_FACULTY_FT');

// ---- Part 1b: the closing and the incentive, hand made --------------------------------------------------------------------------------
const def = JC.MEDICAL;
const targets = new Map([
  ['MD_MS_DOCTOR_FT', { target: 1, incentive: 1000 }], ['MD_MS_DOCTOR_PT', { target: 2, incentive: 800 }], ['MD_MS_FACULTY_FT', { target: 1, incentive: 1500 }],
  ['MD_MS_FACULTY_PT', { target: 4, incentive: 1200 }], ['MBBS_DOCTOR_FT', { target: 3, incentive: 600 }], ['STAFF_NURSE', { target: 4, incentive: 300 }],
]);
const person = (name, counts, other = 0, check = 0) => ({ counts, other, check, base: { key: name, name } });
const people = [
  person('A', { STAFF_NURSE: 3, MBBS_DOCTOR_FT: 1 }, 1),
  person('B', { STAFF_NURSE: 3, MD_MS_FACULTY_FT: 2 }, 0, 1),
  person('C', {}),
];
const fig = JC.figures(def, people, targets);
const byKey = Object.fromEntries(fig.categories.map((c) => [c.key, c]));
assert.deepStrictEqual([byKey.STAFF_NURSE.achieved, byKey.STAFF_NURSE.above, byKey.STAFF_NURSE.closingPct], [6, 2, 150], 'nurses: 6 of 4 = 150%, 2 above');
assert.deepStrictEqual([byKey.MD_MS_FACULTY_FT.achieved, byKey.MD_MS_FACULTY_FT.above, byKey.MD_MS_FACULTY_FT.closingPct], [2, 1, 200]);
assert.deepStrictEqual([byKey.MBBS_DOCTOR_FT.achieved, byKey.MBBS_DOCTOR_FT.left, byKey.MBBS_DOCTOR_FT.closingPct], [1, 2, 33]);
assert.deepStrictEqual([byKey.MD_MS_DOCTOR_PT.achieved, byKey.MD_MS_DOCTOR_PT.left, byKey.MD_MS_DOCTOR_PT.closingPct], [0, 2, 0]);
assert.strictEqual(fig.total.target, 15, 'the six add up to 15');
assert.strictEqual(fig.total.joinedInSix, 9, '6 + 2 + 1');
// each category counted up to its target: nurses 4 + faculty 1 + MBBS 1 = 6 of 15 = 40%, not 9 of 15
assert.deepStrictEqual([fig.total.achieved, fig.total.above, fig.total.closingPct], [6, 3, 40]);
assert.strictEqual(fig.total.closedCategories, 2, 'nurses and FT faculty are closed');
// incentive: every counted joining at its category's amount: 6x300 + 2x1500 + 1x600 = 5400
assert.strictEqual(fig.total.incentive, 5400);
const ra = fig.recruiters.find((r) => r.name === 'A'); const rb = fig.recruiters.find((r) => r.name === 'B'); const rc = fig.recruiters.find((r) => r.name === 'C');
assert.deepStrictEqual([ra.inSix, ra.sharePct, ra.incentive, ra.other], [4, 27, 3 * 300 + 600, 1]);
assert.deepStrictEqual([rb.inSix, rb.sharePct, rb.incentive, rb.check], [5, 33, 3 * 300 + 2 * 1500, 1]);
assert.deepStrictEqual([rc.inSix, rc.incentive], [0, 0]);
assert.strictEqual(ra.cells.STAFF_NURSE.pctOfTarget, 75, '3 of the team target of 4');
assert.strictEqual(ra.incentive + rb.incentive + rc.incentive, fig.total.incentive, 'the recruiters add up to the total');
// A FULL TIME DOCTOR IS ENOUGH (switch on): Full Time joinings above their own target fill the Part Time target of the same group
const fc = JC.figures(def, people, targets, { fullCoversPart: true });
const fcat = Object.fromEntries(fc.categories.map((c) => [c.key, c]));
// faculty: 2 Full Time joined of 1, so 1 is above and fills 1 of the 4 Part Time places; nobody joined Part Time
assert.deepStrictEqual([fcat.MD_MS_FACULTY_FT.achieved, fcat.MD_MS_FACULTY_FT.usedForPart, fcat.MD_MS_FACULTY_FT.above], [2, 1, 0]);
assert.deepStrictEqual([fcat.MD_MS_FACULTY_PT.achieved, fcat.MD_MS_FACULTY_PT.covered, fcat.MD_MS_FACULTY_PT.left, fcat.MD_MS_FACULTY_PT.closingPct], [0, 1, 3, 25]);
assert.deepStrictEqual([fc.total.achieved, fc.total.closingPct], [7, 47], 'nurses 4 + faculty FT 1 + faculty PT 1 + MBBS 1 = 7 of 15');
assert.strictEqual(fc.total.incentive, 5400, 'the incentive is paid at each joining own category: unchanged by the cover');
assert.deepStrictEqual(fc.recruiters.map((r) => r.incentive), fig.recruiters.map((r) => r.incentive), 'no recruiter incentive moves');
assert.strictEqual(fc.total.joinedInSix, 9, 'what joined does not change either');
// 4 Full Time MD/MS doctors of 1: 2 fill the Part Time target of 2, 1 is left above
const dd = JC.figures(def, [person('D', { MD_MS_DOCTOR_FT: 4 })], targets, { fullCoversPart: true });
const ddc = Object.fromEntries(dd.categories.map((c) => [c.key, c]));
assert.deepStrictEqual([ddc.MD_MS_DOCTOR_FT.usedForPart, ddc.MD_MS_DOCTOR_FT.above, ddc.MD_MS_DOCTOR_PT.covered, ddc.MD_MS_DOCTOR_PT.closingPct, ddc.MD_MS_DOCTOR_PT.left], [2, 1, 2, 100, 0]);
assert.strictEqual(dd.total.closedCategories, 2, 'both MD/MS Doctors categories are closed');
// Full Time does not fill a different group: faculty is untouched by the doctors
assert.strictEqual(ddc.MD_MS_FACULTY_PT.covered, 0);
// a Part Time joining never fills a Full Time target
const pp = JC.figures(def, [person('E', { MD_MS_DOCTOR_PT: 3 })], targets, { fullCoversPart: true });
const ppc = Object.fromEntries(pp.categories.map((c) => [c.key, c]));
assert.deepStrictEqual([ppc.MD_MS_DOCTOR_FT.achieved, ppc.MD_MS_DOCTOR_FT.left, ppc.MD_MS_DOCTOR_FT.closingPct, ppc.MD_MS_DOCTOR_PT.above], [0, 1, 0, 1]);
// a Part Time target already met leaves the Full Time extras above
const met = JC.figures(def, [person('F', { MD_MS_DOCTOR_FT: 3, MD_MS_DOCTOR_PT: 2 })], targets, { fullCoversPart: true });
assert.deepStrictEqual([met.categories[0].usedForPart, met.categories[0].above, met.categories[1].covered], [0, 2, 0]);
// switch off: nothing is filled
const off = JC.figures(def, [person('D', { MD_MS_DOCTOR_FT: 4 })], targets, { fullCoversPart: false });
assert.deepStrictEqual([off.categories[1].covered, off.categories[1].closingPct, off.categories[0].above], [0, 0, 3]);
// no Part Time target set: nothing to fill
const noPt = JC.figures(def, [person('D', { MD_MS_DOCTOR_FT: 4 })], new Map([['MD_MS_DOCTOR_FT', { target: 1, incentive: null }]]), { fullCoversPart: true });
assert.strictEqual(noPt.categories[0].usedForPart, 0);
// no amount decided: nothing is worked out, nothing is invented
const bare = new Map([...targets].map(([k, v]) => [k, { target: v.target, incentive: null }]));
const f0 = JC.figures(def, people, bare);
assert.strictEqual(f0.total.incentive, null);
assert.strictEqual(f0.recruiters[0].hasAmounts, false);
assert.strictEqual(f0.total.amountsSet, false);
// an amount for some only: the recruiter is flagged as incomplete
const part = new Map(targets); part.set('STAFF_NURSE', { target: 4, incentive: null });
const fp = JC.figures(def, people, part);
assert.strictEqual(fp.recruiters.find((r) => r.name === 'A').incentiveComplete, false);
assert.strictEqual(fp.recruiters.find((r) => r.name === 'A').incentive, 600, 'only the categories with an amount are paid');
// no targets for the month
const none = JC.figures(def, people, new Map());
assert.deepStrictEqual([none.set, none.total.target, none.total.closingPct], [false, 0, null]);
// the targets in force: the latest row on or before the month
const rows = [
  { department: 'Medical', category: 'STAFF_NURSE', fromMonth: '2026-11', target: 4, incentive: null },
  { department: 'Medical', category: 'STAFF_NURSE', fromMonth: '2027-01', target: 6, incentive: 250 },
];
assert.strictEqual(JC.effectiveTargets(rows, 'Medical', '2026-10').size, 0, 'a target does not reach back before its month');
assert.strictEqual(JC.effectiveTargets(rows, 'Medical', '2026-12').get('STAFF_NURSE').target, 4);
assert.strictEqual(JC.effectiveTargets(rows, 'medical', '2027-02').get('STAFF_NURSE').target, 6, 'later months use the later row; the name is not case-sensitive');
console.log('part 1 (pure): all checks passed');

// ---- Part 2: the sandbox ---------------------------------------------------------------------------------------------------------------
(async () => {
  const prisma = require('../src/db');
  const RJ = require('../src/utils/recruiterJoinings');
  const actor = { id: null, name: 'joining-categories-test' };
  const MONTH = process.env.TEST_MONTH || '2026-10';
  // test targets for the month (start from the month itself so the real ones are not touched), removed at the end
  await prisma.joiningCategoryTarget.deleteMany({ where: { department: 'Medical', fromMonth: MONTH } });
  try {
    await JC.saveTargets({
      department: 'Medical', fromMonth: MONTH, note: 'test',
      items: [['MD_MS_DOCTOR_FT', 1, 1000], ['MD_MS_DOCTOR_PT', 2, 800], ['MD_MS_FACULTY_FT', 1, 1500], ['MD_MS_FACULTY_PT', 4, 1200], ['MBBS_DOCTOR_FT', 3, 600], ['STAFF_NURSE', 4, 300]]
        .map(([category, target, incentive]) => ({ category, target, incentive })),
    }, actor);
    const board = await RJ.monthBoard(MONTH, { fresh: true });
    const [med] = await JC.monthBoards(MONTH, board);
    assert.strictEqual(med.set, true);
    // THE COUNT IS UNCHANGED: every recruiter's joinings are the Recruiter joinings numbers, split three ways with nothing lost or added
    const medRows = board.rows.filter((r) => String(r.department).toLowerCase() === 'medical');
    assert.strictEqual(med.recruiters.length, medRows.length);
    med.recruiters.forEach((r) => {
      const src = medRows.find((x) => x.key === r.key);
      assert.strictEqual(r.joinings, src.joinings, `${r.name}: the joinings are the Recruiter joinings count`);
      assert.strictEqual(r.inSix + r.other + r.check, src.joinings, `${r.name}: six + not in the six + need a check = all joinings`);
    });
    assert.strictEqual(med.joinings, medRows.reduce((n, r) => n + r.joinings, 0));
    // independent count from the raw table: joined applications of Medical jobs with a joining date in the month (no recruiter attribution)
    const raw = await prisma.application.count({ where: { stage: { in: ['JOINED', 'HIRED'] }, joiningDate: { startsWith: MONTH }, requirement: { department: 'Medical' }, candidate: { name: { not: { contains: 'zztest' } } } } });
    console.log(`  ${MONTH}: Medical recruiters ${med.joinings} joinings; raw Medical-job joinings dated ${MONTH}: ${raw}`);
    assert.strictEqual(med.joinings, raw, 'the joinings credited to Medical recruiters equal the Medical-job joinings of the month');
    // the department closing and incentive match the figures function on the same classified counts
    const again = JC.figures(JC.MEDICAL, med.recruiters.map((r) => ({
      counts: Object.fromEntries(JC.MEDICAL.categories.map((c) => [c.key, r.cells[c.key].count])), other: r.other, check: r.check, base: { key: r.key, name: r.name },
    })), JC.effectiveTargets(await JC.loadTargetRows(), 'Medical', MONTH), { fullCoversPart: med.fullCoversPart });
    assert.deepStrictEqual(again.total, med.total);
    // the sum of each recruiter's incentive is the department's
    assert.strictEqual(med.recruiters.reduce((n, r) => n + r.incentive, 0), med.total.incentive);
    console.log('  categories:', med.categories.map((c) => `${c.short} ${c.achieved}/${c.target}`).join(' | '));
    console.log(`  total ${med.total.achieved} of ${med.total.target} = ${med.total.closingPct}% (above targets ${med.total.above}); not in the six ${med.otherCount}; need a check ${med.checkCount}; incentive ₹${med.total.incentive}`);
    console.log('part 2 (sandbox): all checks passed');
  } finally {
    await prisma.joiningCategoryTarget.deleteMany({ where: { department: 'Medical', fromMonth: MONTH } });
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
