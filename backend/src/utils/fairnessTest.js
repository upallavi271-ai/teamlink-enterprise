// ---------------------------------------------------------------------------
// AI FAIRNESS TEST (founder audit 2026-11-17: "AI scoring bias testing").
//
// Tests the candidate Fit score (utils/matching.js computeMatch — the ONE
// deterministic scorer every Fit %, "Good fit" list and Eligible badge comes
// from) for bias against protected or proxy attributes.
//
// METHOD 1 — PAIRED (counterfactual) TEST. Synthetic people who are the same in
// skills, experience, education, salary, notice and city, and differ ONLY in
// one attribute (name / gender / age / marital status / photo / religion and
// caste lines / home state / college / a career break marked maternity). Each
// pair is scored against several sample requirements, three ways:
//   profile           the profile fields only (no resume on file)
//   resume            the profile + a resume text carrying the usual Indian
//                     "Personal details" block (DOB, gender, marital status,
//                     religion, category, native place, photo)
//   resume + meaning  the same, with "Match by meaning" skill folding on
// PASS = the Overall Fit is the SAME (difference 0) and the Eligible answer
// never flips. The current city is a real job criterion (the job's location):
// it may move the Location part only, and must not move anything else, and
// a Remote job must give the same Fit whatever the city.
//
// METHOD 2 — GROUP OUTCOME (four-fifths / 80% rule). A seeded synthetic batch
// of qualifications is given to every group (men, women, each community's
// names, age 50+, under 30, married, maternity break, photo, a name that is
// also a skill word). Shortlist = Eligible on each sample requirement. Every
// group's shortlist rate must be at least 80% of the best group's rate.
//
// The AI interview score (an AI-written number) is NOT re-tested here: the
// sandbox refuses AI calls, and its weight is 0 by default (shown beside the
// Fit, not counted). Everything tested here is deterministic code.
//
// PUBLIC API
//   runBiasTest({ tolerance })   -> the full result object (no database)
//   saveRun(result, user)        -> stores it in AiFairnessRun (raw SQL table)
//   latestRun()                  -> the last stored run, or null
// ---------------------------------------------------------------------------
const M = require('./matching');

let SEM = null;
try { SEM = require('./semanticMatch'); } catch { SEM = null; } // eslint-disable-line global-require

// ---- the sample requirements -------------------------------------------------
const REQUIREMENTS = [
  {
    id: 'req-java', title: 'Java Developer', location: 'Hyderabad', workMode: 'Onsite', employmentType: 'Full Time', jobPreference: 'Permanent',
    skills: 'Java, Spring Boot, SQL', goodToHaveSkills: 'AWS, Docker', experience: '3-6 years', education: 'B.Tech', salary: '6-12 LPA', joiningTimeline: '30 days',
  },
  {
    id: 'req-nurse', title: 'Staff Nurse (ICU)', location: 'Bengaluru', workMode: 'Onsite', employmentType: 'Full Time', jobPreference: 'Permanent',
    skills: 'Patient Care, ICU', goodToHaveSkills: 'BLS, Ventilator Handling', experience: '1-4 years', education: 'B.Sc Nursing', salary: '3-5 LPA', joiningTimeline: '15 days',
  },
  {
    id: 'req-acct', title: 'Accountant', location: 'Pune', workMode: 'Hybrid', employmentType: 'Full Time', jobPreference: 'Permanent',
    skills: 'Tally, GST, Accounts Payable', goodToHaveSkills: 'TDS, Excel', experience: '2-5 years', education: 'B.Com', salary: '3-6 LPA', joiningTimeline: '30 days',
  },
  {
    id: 'req-ruby', title: 'Ruby on Rails Developer', location: 'Bengaluru', workMode: 'Remote', employmentType: 'Full Time', jobPreference: 'Permanent',
    skills: 'Ruby, Rails', goodToHaveSkills: 'PostgreSQL, Redis', experience: '2-6 years', education: 'B.Tech', salary: '8-15 LPA', joiningTimeline: '30 days',
  },
];

// ---- the base qualifications (strong / partial / weak per requirement) ---------
const BASES = [
  { id: 'java-strong', skills: ['Java', 'Spring Boot', 'SQL', 'AWS'], years: 4, relevant: 4, education: 'B.Tech Computer Science', designation: 'Software Engineer', city: 'Hyderabad', salary: '9 LPA', notice: '30 Days' },
  { id: 'java-partial', skills: ['Java', 'SQL'], years: 2, relevant: 2, education: 'B.Sc Computers', designation: 'Junior Developer', city: 'Hyderabad', salary: '7 LPA', notice: '60 Days' },
  { id: 'nurse-strong', skills: ['Patient Care', 'ICU', 'BLS'], years: 3, relevant: 3, education: 'B.Sc Nursing', designation: 'Staff Nurse', city: 'Bengaluru', salary: '4 LPA', notice: '15 Days' },
  { id: 'nurse-partial', skills: ['Patient Care'], years: 1, relevant: 1, education: 'GNM Nursing', designation: 'Nurse', city: 'Bengaluru', salary: '3 LPA', notice: '30 Days' },
  { id: 'acct-strong', skills: ['Tally', 'GST', 'Accounts Payable', 'Excel'], years: 3, relevant: 3, education: 'B.Com', designation: 'Accounts Executive', city: 'Pune', salary: '4.5 LPA', notice: '30 Days' },
  { id: 'acct-partial', skills: ['Tally', 'Excel'], years: 1.5, relevant: 1, education: 'B.Com', designation: 'Accounts Assistant', city: 'Pune', salary: '3 LPA', notice: 'Immediate' },
  { id: 'ruby-strong', skills: ['Ruby', 'Rails', 'PostgreSQL'], years: 4, relevant: 4, education: 'B.Tech', designation: 'Backend Developer', city: 'Bengaluru', salary: '12 LPA', notice: '30 Days' },
  // Has Rails but NOT Ruby: the case where a name that is also a skill word ("Ruby") could wrongly add a skill.
  { id: 'ruby-partial', skills: ['Rails', 'Redis'], years: 3, relevant: 2, education: 'B.Tech', designation: 'Web Developer', city: 'Bengaluru', salary: '10 LPA', notice: '30 Days' },
  { id: 'weak', skills: ['MS Office', 'Communication'], years: 1, relevant: 0, education: 'BA', designation: 'Office Assistant', city: 'Hyderabad', salary: '2.5 LPA', notice: 'Immediate' },
];

// The neutral person every variant starts from (Kiran: used for men and women).
const NEUTRAL = {
  name: 'Kiran Kumar', gender: '', dob: '1994-06-15', marital: '', photo: false, religion: '', category: '', homeState: '',
  institute: 'State University', gap: false,
};

// ---- the attributes tested ---------------------------------------------------------
// kind 'protected' = must never move the Fit. kind 'criterion' = a real job criterion.
const ATTRIBUTES = [
  {
    key: 'name_gender', label: 'Name: male vs female', kind: 'protected',
    variants: [
      { label: 'Rahul Sharma', p: { name: 'Rahul Sharma' } }, { label: 'Priya Sharma', p: { name: 'Priya Sharma' } },
      { label: 'Venkatesh Reddy', p: { name: 'Venkatesh Reddy' } }, { label: 'Lakshmi Reddy', p: { name: 'Lakshmi Reddy' } },
      { label: 'Robin Fernandes', p: { name: 'Robin Fernandes' } }, { label: 'Ruby Fernandes', p: { name: 'Ruby Fernandes' } },
    ],
    pairs: [[0, 1], [2, 3], [4, 5]],
  },
  {
    key: 'name_community', label: 'Name: community / religion', kind: 'protected',
    variants: [
      { label: 'Arjun Iyer', p: { name: 'Arjun Iyer' } }, { label: 'Mohammed Irfan Khan', p: { name: 'Mohammed Irfan Khan' } },
      { label: 'Joseph D\'Souza', p: { name: 'Joseph D\'Souza' } }, { label: 'Gurpreet Singh', p: { name: 'Gurpreet Singh' } },
      { label: 'Ravi Paswan', p: { name: 'Ravi Paswan' } }, { label: 'Suresh Valmiki', p: { name: 'Suresh Valmiki' } },
      { label: 'Tenzin Norbu', p: { name: 'Tenzin Norbu' } },
    ],
  },
  {
    key: 'gender', label: 'Gender field', kind: 'protected',
    variants: [{ label: 'Male', p: { gender: 'Male' } }, { label: 'Female', p: { gender: 'Female' } }, { label: 'Transgender', p: { gender: 'Transgender' } }, { label: 'Not given', p: { gender: '' } }],
  },
  {
    key: 'age', label: 'Age / date of birth', kind: 'protected',
    variants: [{ label: 'Born 2001 (age 25)', p: { dob: '2001-03-10' } }, { label: 'Born 1986 (age 40)', p: { dob: '1986-03-10' } }, { label: 'Born 1968 (age 58)', p: { dob: '1968-03-10' } }, { label: 'No DOB', p: { dob: '' } }],
  },
  {
    key: 'marital', label: 'Marital status', kind: 'protected',
    variants: [{ label: 'Single', p: { marital: 'Single' } }, { label: 'Married', p: { marital: 'Married' } }, { label: 'Divorced', p: { marital: 'Divorced' } }, { label: 'Widowed', p: { marital: 'Widowed' } }],
  },
  {
    key: 'photo', label: 'Photo on resume', kind: 'protected',
    variants: [{ label: 'Photo', p: { photo: true } }, { label: 'No photo', p: { photo: false } }],
  },
  {
    key: 'religion_caste', label: 'Religion / caste category lines', kind: 'protected',
    variants: [
      { label: 'Hindu, General', p: { religion: 'Hindu', category: 'General' } }, { label: 'Muslim, OBC', p: { religion: 'Muslim', category: 'OBC' } },
      { label: 'Christian, General', p: { religion: 'Christian', category: 'General' } }, { label: 'Hindu, SC', p: { religion: 'Hindu', category: 'SC' } },
      { label: 'Hindu, ST', p: { religion: 'Hindu', category: 'ST' } }, { label: 'Sikh, General', p: { religion: 'Sikh', category: 'General' } },
      { label: 'Buddhist, SC', p: { religion: 'Buddhist', category: 'SC' } },
    ],
  },
  {
    key: 'home_state', label: 'Home state (native place)', kind: 'protected',
    variants: [{ label: 'Bihar', p: { homeState: 'Bihar' } }, { label: 'Andhra Pradesh', p: { homeState: 'Andhra Pradesh' } }, { label: 'Kerala', p: { homeState: 'Kerala' } }, { label: 'Manipur', p: { homeState: 'Manipur' } }, { label: 'Uttar Pradesh', p: { homeState: 'Uttar Pradesh' } }],
  },
  {
    key: 'college', label: 'College tier (same degree)', kind: 'protected',
    variants: [{ label: 'IIT Bombay', p: { institute: 'IIT Bombay' } }, { label: 'Govt. Degree College, Warangal', p: { institute: 'Govt. Degree College, Warangal' } }, { label: 'Distance education', p: { institute: 'Distance education (open university)' } }],
  },
  {
    key: 'career_gap', label: 'Career break marked maternity (same total years)', kind: 'protected',
    variants: [{ label: 'No break', p: { gap: false } }, { label: 'Maternity break 2 years', p: { gap: true } }],
  },
  {
    key: 'city', label: 'Current city (job criterion)', kind: 'criterion',
    note: 'The job location is a real criterion: it may move the Location part only. A Remote job must give the same Fit for every city.',
    variants: [{ label: 'Job city', p: { city: null } }, { label: 'Patna', p: { city: 'Patna' } }, { label: 'Guwahati', p: { city: 'Guwahati' } }],
  },
];

const MODES = ['profile', 'resume', 'meaning'];
const MODE_LABEL = { profile: 'profile only', resume: 'with resume', meaning: 'resume + match by meaning' };

const emailOf = (name) => `${String(name).toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@example.com`;

// One synthetic person: the base qualifications + the personal attributes.
function person(base, personal, req) {
  const p = { ...NEUTRAL, ...personal };
  const city = p.city || (req && req.location && req.workMode !== 'Remote' ? req.location : base.city);
  const candidate = {
    id: `${base.id}`,
    name: p.name,
    gender: p.gender || null,
    dob: p.dob || null,
    maritalStatus: p.marital || null, // not a Candidate column; given anyway, to prove it is ignored
    photoUrl: p.photo ? '/photos/x.jpg' : null, // idem
    religion: p.religion || null, // idem
    category: p.category || null, // idem
    homeState: p.homeState || null, // idem
    institute: p.institute,
    passingYear: '2016',
    skills: base.skills.join(', '),
    experienceYears: base.years,
    relevantExperienceYears: base.relevant,
    education: base.education,
    location: city,
    preferredLocation: '',
    currentDesignation: base.designation,
    expectedSalary: base.salary,
    noticePeriod: base.notice,
    availability: 'Available after notice period',
    jobPreference: 'Permanent',
    preferredEmploymentType: 'Full Time',
    preferredWorkMode: req ? req.workMode : 'Hybrid',
  };
  const lines = [
    p.name.toUpperCase(),
    `${emailOf(p.name)} | +91 98765 43210`,
    p.photo ? '[Photograph attached]' : '',
    `Summary: ${base.designation} with ${base.years} years of experience.`,
    `Key skills: ${base.skills.join(', ')}`,
    `Experience: ${base.designation}, ABC Services Pvt Ltd (${base.years} years)`,
    p.gap ? 'Career break: Jan 2019 - Dec 2020 (maternity break, caring for my child)' : '',
    `Education: ${base.education}, ${p.institute}, 2016`,
    'PERSONAL DETAILS',
    p.name ? `Name: ${p.name}` : '',
    p.dob ? `Date of Birth: ${p.dob}` : '',
    p.gender ? `Gender: ${p.gender}` : '',
    p.marital ? `Marital Status: ${p.marital}` : '',
    p.religion ? `Religion: ${p.religion}` : '',
    p.category ? `Category: ${p.category}` : '',
    p.homeState ? `Native place: ${p.homeState}` : '',
    `Current location: ${city}`,
    `Declaration: I, ${p.name}, hereby declare that the above details are true.`,
  ].filter(Boolean);
  const text = lines.join('\n');
  const resume = {
    text, lowerText: text.toLowerCase(),
    parsed: { skills: base.skills.map((s) => s.toLowerCase()), totalExperienceYears: base.years, education: [base.education], location: city },
  };
  return { candidate, resume };
}

function semanticOpt() {
  if (!SEM || !SEM.canonicalSkill) return null;
  return { canonical: SEM.canonicalSkill, variantsOf: SEM.variantsOf, share: 0, pct: null, shared: [] };
}

function score(base, personal, req, mode) {
  const { candidate, resume } = person(base, personal, req);
  const opts = {};
  if (mode !== 'profile') opts.resume = resume;
  if (mode === 'meaning') { const s = semanticOpt(); if (s) opts.semantic = s; }
  const m = M.computeMatch(candidate, req, opts);
  const el = M.eligibilityOf(m);
  return {
    overall: m.overall, eligible: el.eligible, locPct: m.locPct,
    nonLocation: [m.resumePct, m.skillsPct, m.goodPct, m.expPct, m.relevPct, m.eduPct, m.salPct, m.notPct, m.modePct, m.empPct, m.jpPct, m.availPct].join('|'),
    matchedSkills: m.matchedSkills,
  };
}

// ---- method 1: the paired test ---------------------------------------------------------
function pairTest(attr, tolerance) {
  let comparisons = 0;
  let maxDiff = 0;
  let flips = 0;
  let otherMoved = 0;
  let remoteDiff = 0;
  let worst = null;
  const perMode = {};
  MODES.forEach((mode) => { perMode[mode] = 0; });
  REQUIREMENTS.forEach((req) => {
    BASES.forEach((base) => {
      MODES.forEach((mode) => {
        const scores = attr.variants.map((v) => ({ v: v.label, s: score(base, v.p, req, mode) }));
        let list = attr.pairs;
        if (!list) { list = []; scores.forEach((_, i) => { for (let j = i + 1; j < scores.length; j += 1) list.push([i, j]); }); }
        list.forEach(([a, b]) => {
          const x = scores[a]; const y = scores[b];
          comparisons += 1;
          const d = Math.abs(x.s.overall - y.s.overall);
          if (x.s.eligible !== y.s.eligible) flips += 1;
          if (attr.kind === 'criterion') {
            if (x.s.nonLocation !== y.s.nonLocation) otherMoved += 1;
            if (req.workMode === 'Remote') remoteDiff = Math.max(remoteDiff, d);
          }
          if (d > perMode[mode]) perMode[mode] = d;
          if (d > maxDiff) {
            maxDiff = d;
            worst = {
              requirement: req.title, base: base.id, mode: MODE_LABEL[mode], a: x.v, b: y.v, scoreA: x.s.overall, scoreB: y.s.overall,
              skillsA: x.s.matchedSkills, skillsB: y.s.matchedSkills,
            };
          }
        });
      });
    });
  });
  const pass = attr.kind === 'criterion'
    ? otherMoved === 0 && remoteDiff <= tolerance
    : maxDiff <= tolerance && flips === 0;
  return {
    key: attr.key, label: attr.label, kind: attr.kind, comparisons, maxDiff, eligibleFlips: flips, perMode,
    ...(attr.kind === 'criterion' ? { otherPartsMoved: otherMoved, remoteMaxDiff: remoteDiff } : {}),
    tolerance, pass, note: attr.note || null, worst: maxDiff > 0 ? worst : null,
  };
}

// ---- method 2: the four-fifths rule ---------------------------------------------------
const GROUPS = [
  { key: 'men', label: 'Men', p: { name: 'Rahul Sharma', gender: 'Male' } },
  { key: 'women', label: 'Women', p: { name: 'Priya Sharma', gender: 'Female' } },
  { key: 'muslim', label: 'Muslim names', p: { name: 'Mohammed Irfan Khan', religion: 'Muslim' } },
  { key: 'christian', label: 'Christian names', p: { name: 'Joseph D\'Souza', religion: 'Christian' } },
  { key: 'sikh', label: 'Sikh names', p: { name: 'Gurpreet Singh', religion: 'Sikh' } },
  { key: 'scst', label: 'SC / ST names and category', p: { name: 'Ravi Paswan', category: 'SC' } },
  { key: 'northeast', label: 'North-east names', p: { name: 'Tenzin Norbu', homeState: 'Sikkim' } },
  { key: 'age50', label: 'Age 50+', p: { dob: '1970-01-01' } },
  { key: 'age25', label: 'Under 30', p: { dob: '2001-01-01' } },
  { key: 'married-women', label: 'Married women', p: { name: 'Lakshmi Reddy', gender: 'Female', marital: 'Married' } },
  { key: 'maternity', label: 'Maternity break', p: { name: 'Lakshmi Reddy', gender: 'Female', gap: true } },
  { key: 'photo', label: 'Photo on resume', p: { photo: true } },
  { key: 'skillname', label: 'Name that is also a skill word', p: { name: 'Ruby Fernandes', gender: 'Female' } },
];

function rng(seed) {
  let a = seed >>> 0; // mulberry32
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A batch of synthetic qualifications per requirement: a random part of its
// must-have and good-to-have skills (plus noise skills), random years.
function batchFor(req, n, rand) {
  const must = req.skills.split(',').map((s) => s.trim());
  const good = req.goodToHaveSkills.split(',').map((s) => s.trim());
  const noise = ['MS Office', 'Communication', 'Python', 'Sales'];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const skills = [...must.filter(() => rand() < 0.75), ...good.filter(() => rand() < 0.5), ...noise.filter(() => rand() < 0.2)];
    const years = Math.round((0.5 + rand() * 8) * 2) / 2;
    out.push({
      id: `${req.id}-b${i}`, skills: skills.length ? skills : ['Communication'], years, relevant: Math.max(0, years - Math.round(rand() * 2)),
      education: rand() < 0.7 ? req.education : 'BA', designation: 'Team Member', city: req.location, salary: rand() < 0.8 ? '4 LPA' : '20 LPA', notice: rand() < 0.5 ? '30 Days' : '90 Days',
    });
  }
  return out;
}

function fourFifths({ perRequirement = 40, seed = 20261117 } = {}) {
  const rand = rng(seed);
  const batches = REQUIREMENTS.map((req) => ({ req, people: batchFor(req, perRequirement, rand) }));
  const groups = GROUPS.map((g) => {
    let shortlisted = 0; let total = 0;
    batches.forEach(({ req, people }) => people.forEach((base) => {
      total += 1;
      if (score(base, g.p, req, 'resume').eligible) shortlisted += 1;
    }));
    return { key: g.key, label: g.label, shortlisted, total, rate: total ? shortlisted / total : 0 };
  });
  const best = Math.max(...groups.map((g) => g.rate));
  groups.forEach((g) => { g.ratio = best > 0 ? Math.round((g.rate / best) * 1000) / 1000 : 1; g.pass = g.ratio >= 0.8; g.rate = Math.round(g.rate * 1000) / 1000; });
  const minRatio = Math.min(...groups.map((g) => g.ratio));
  // Every group gets the SAME qualifications, so the strict answer is "the same
  // rate for all". The 80% rule alone is too loose to catch a small bias (before
  // the 2026-11-17 fix the "Ruby" name lifted one group to 0.519 vs 0.456, which
  // the 80% rule still passed at 0.88): both must hold.
  const identical = groups.every((g) => g.shortlisted === groups[0].shortlisted);
  return {
    rule: 'four-fifths (80%)', perGroup: perRequirement * REQUIREMENTS.length, seed, groups, minRatio, identical, pass: groups.every((g) => g.pass) && best > 0 && identical,
  };
}

function runBiasTest({ tolerance = 0 } = {}) {
  const started = Date.now();
  const attributes = ATTRIBUTES.map((a) => pairTest(a, tolerance));
  const ff = fourFifths();
  const comparisons = attributes.reduce((s, a) => s + a.comparisons, 0);
  return {
    ranAt: new Date().toISOString(),
    scorer: 'utils/matching.js computeMatch + eligibilityOf',
    fitVersion: M.versionCode(),
    weights: M.getActiveWeights(),
    tolerance,
    requirements: REQUIREMENTS.map((r) => r.title),
    modes: MODES.map((m) => MODE_LABEL[m]),
    meaningEngine: SEM ? 'local skill folding' : 'not available',
    comparisons,
    attributes,
    fourFifths: ff,
    pass: attributes.every((a) => a.pass) && ff.pass,
    ms: Date.now() - started,
  };
}

// ---- storage: the last runs (raw SQL, self-provisioned) -----------------------------
let prismaRef = null;
const prisma = () => { if (!prismaRef) prismaRef = require('../db'); return prismaRef; }; // eslint-disable-line global-require
let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AiFairnessRun" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "ranAt" TEXT NOT NULL, "pass" INTEGER NOT NULL,
      "comparisons" INTEGER NOT NULL DEFAULT 0, "fitVersion" TEXT, "summary" TEXT NOT NULL, "ranById" TEXT, "ranByName" TEXT)`)
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function saveRun(result, user) {
  await ensure();
  await prisma().$executeRawUnsafe('INSERT INTO "AiFairnessRun" ("ranAt","pass","comparisons","fitVersion","summary","ranById","ranByName") VALUES (?,?,?,?,?,?,?)',
    result.ranAt, result.pass ? 1 : 0, result.comparisons, result.fitVersion, JSON.stringify(result), (user && user.id) || null, (user && user.name) || null);
  // keep the last 50 runs
  await prisma().$executeRawUnsafe('DELETE FROM "AiFairnessRun" WHERE "id" NOT IN (SELECT "id" FROM "AiFairnessRun" ORDER BY "id" DESC LIMIT 50)');
}
async function latestRun() {
  await ensure();
  const rows = await prisma().$queryRawUnsafe('SELECT * FROM "AiFairnessRun" ORDER BY "id" DESC LIMIT 1');
  const r = rows && rows[0];
  if (!r) return null;
  let summary = null;
  try { summary = JSON.parse(r.summary); } catch { summary = null; }
  return { ...(summary || {}), ranAt: r.ranAt, pass: Number(r.pass) === 1, ranByName: r.ranByName || null };
}

module.exports = {
  runBiasTest, saveRun, latestRun, REQUIREMENTS, ATTRIBUTES, GROUPS, person, score, batchFor, rng,
};
