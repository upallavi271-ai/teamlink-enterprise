#!/usr/bin/env node
/**
 * RESUME PARSER ACCURACY (founder audit 2026-11-17, "parsing accuracy measurement"). Runs the free resume parser
 * (src/utils/resumeParse.js parseResumeText) over a small built-in set of sample resume texts whose right answers are known,
 * and prints field-level accuracy. No database, no network, no AI.
 *
 *   node scripts/resume-parse-accuracy.js            the table + accuracy per field
 *   node scripts/resume-parse-accuracy.js --json     the same as JSON
 *   node scripts/resume-parse-accuracy.js --min 70   exit 1 when the overall accuracy is below 70 %
 *   RESUME_SAMPLE_DIR=D:\anonymised-resumes node scripts/resume-parse-accuracy.js     also run the founder's own files (below)
 *
 * How a field counts as right:
 *   name        the same words (case and spaces ignored)
 *   email       the expected address is among the ones read
 *   phone       the expected 10 digits are among the ones read
 *   skills      F1 of the skills read vs expected >= 0.8 (precision and recall are printed too)
 *   experience  within 0.5 years of the expected total (null expected = nothing should be read)
 *   currentSalary / expectedSalary   the same LPA figure (within 0.05)
 *   noticePeriod  the same number of days ("Immediate" = 0)
 *   dob         the same date (YYYY-MM-DD)
 *   jobs / degrees   the number of job entries / degree entries read
 * The built-in samples include Telugu and Hindi resumes (script detection, Telugu / Devanagari digits).
 *
 * REAL RESUMES (founder audit 2026-11-18, parsing accuracy): RESUME_SAMPLE_DIR=<folder> also runs every .pdf / .docx / .doc / .rtf / .txt resume found
 * under that folder (sub-folders included, at most 500 files). Put anonymised real resumes there. A file may have a sidecar "<same name>.expected.json":
 *   { "name": "...", "email": "...", "phone": "98480 22331", "skills": ["java"], "experience": 5, "currentSalary": "5.5 LPA", "expectedSalary": "8 LPA",
 *     "noticePeriod": "30 Days", "dob": "1995-03-12", "jobs": 3, "degrees": 2 }
 * Only the fields written in the sidecar are scored. A file with no sidecar is only read: it counts toward "read in" (coverage), never toward accuracy.
 * Per-field accuracy (right / checked) and coverage (read / files) are printed for the built-in set and for the folder.
 * The Admin "Parsing quality" card (Candidates -> Verify) runs this same function and stores every run.
 */
const path = require('path');
const fs = require('fs');

// The parser module requires the database client for its skill vocabulary; it is not needed here (a fixed vocabulary is passed),
// so a stand-in is put in the require cache and nothing is opened.
const DB = path.resolve(__dirname, '..', 'src', 'db.js');
if (!require.cache[DB]) require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: {} }; // (inside a test the real client is already loaded: kept)
const { parseResumeText, BUILTIN_SKILLS } = require('../src/utils/resumeParse');

const SAMPLES = [
  {
    id: 'en-java-dev',
    text: `Ravi Teja Kondapalli
Email: ravi.teja.k@gmail.com | Mobile: +91 98480 22331
Hyderabad, Telangana
PROFESSIONAL SUMMARY
Java developer with 5 years of experience building Spring Boot microservices.
SKILLS: Java, Spring Boot, Hibernate, MySQL, Docker, Git
EXPERIENCE
Senior Software Engineer, Infotech Pvt Ltd   Jan 2022 - Present
Software Engineer, CodeWorks   Jun 2019 - Dec 2021
EDUCATION
B.Tech (CSE), JNTU Hyderabad, 2019`,
    expect: { name: 'Ravi Teja Kondapalli', email: 'ravi.teja.k@gmail.com', phone: '9848022331', skills: ['java', 'spring boot', 'hibernate', 'mysql', 'docker', 'git'], experience: 5 },
  },
  {
    id: 'en-nurse',
    text: `CURRICULUM VITAE
Name: Lakshmi Prasanna
Phone: 9701234567
E-mail: lakshmi.prasanna88@yahoo.co.in
Total Experience: 7 years
Key skills: Patient Care, ICU, Phlebotomy
Staff Nurse, Apollo Hospitals, Mar 2018 - till date
GNM, 2015`,
    expect: { name: 'Lakshmi Prasanna', email: 'lakshmi.prasanna88@yahoo.co.in', phone: '9701234567', skills: ['patient care', 'icu', 'phlebotomy'], experience: 7 },
  },
  {
    id: 'en-dates-only',
    text: `SURESH BABU NAIDU
suresh.naidu@outlook.com
+91-9866012345
Work history
Production Engineer — Sri Venkateswara Steels   03/2016 - 08/2020
Maintenance Engineer — Krishna Forge   09/2020 - 02/2024
Skills: Production, Maintenance, Six Sigma, AutoCAD
Diploma in Mechanical Engineering 2015`,
    expect: { name: 'Suresh Babu Naidu', email: 'suresh.naidu@outlook.com', phone: '9866012345', skills: ['production', 'maintenance', 'six sigma', 'autocad'], experience: 8 },
  },
  {
    id: 'en-fresher',
    text: `Resume
Priya Sharma
priya.sharma.2024@gmail.com
Contact: 8008123456
Objective: To start my career as a data analyst.
Skills - Python, SQL, Excel, Power BI
B.Sc Computers, Osmania University, 2024`,
    expect: { name: 'Priya Sharma', email: 'priya.sharma.2024@gmail.com', phone: '8008123456', skills: ['python', 'sql', 'excel', 'power bi'], experience: null },
  },
  {
    id: 'en-accounts',
    text: `Mohammed Imran Khan
Accounts Executive
Email - imran.khan.acc@rediffmail.com   Ph: 040-2345 6789 / 9391122334
4 Years 6 Months experience in Tally, GST, Payroll and Accounting.
M.Com, 2019`,
    expect: { name: 'Mohammed Imran Khan', email: 'imran.khan.acc@rediffmail.com', phone: '9391122334', skills: ['tally', 'gst', 'payroll', 'accounting'], experience: 4.5 },
  },
  {
    id: 'en-sales',
    text: `ANITHA REDDY
Business Development Executive
anitha.reddy@company.co | 9000011223
8+ years experience in B2B sales, marketing and customer service.
Skills: Sales, Marketing, Digital Marketing, Communication
MBA (Marketing) 2016`,
    expect: { name: 'Anitha Reddy', email: 'anitha.reddy@company.co', phone: '9000011223', skills: ['sales', 'marketing', 'digital marketing', 'communication', 'customer service'], experience: 8 },
  },
  {
    id: 'en-testing',
    text: `Profile
Venkata Sai Kiran
Mail: saikiran.qa@gmail.com
Mob: 7799123456
QA Engineer with experience: 3.5 yrs in manual testing, automation testing, Selenium, Jira and Agile.`,
    expect: { name: 'Venkata Sai Kiran', email: 'saikiran.qa@gmail.com', phone: '7799123456', skills: ['manual testing', 'automation testing', 'selenium', 'jira', 'agile'], experience: 3.5 },
  },
  {
    id: 'te-telugu-name-digits',
    text: `పేరు: రమేష్ కుమార్
ఫోన్: ౯౮౪౯౦౧౨౩౪౫
ఈమెయిల్: ramesh.kumar.te@gmail.com
నాకు 6 years experience ఉంది
నైపుణ్యాలు: Tally, GST, Excel`,
    expect: { name: 'రమేష్ కుమార్', email: 'ramesh.kumar.te@gmail.com', phone: '9849012345', skills: ['tally', 'gst', 'excel'], experience: 6 },
  },
  {
    id: 'te-mixed',
    text: `శ్రీనివాస్ రావు గుండు
Mobile: 9440099887
srinivas.gundu@gmail.com
అనుభవం: Experience - 10 years, CNC మరియు Quality Control
విద్య: ITI 2012`,
    expect: { name: 'శ్రీనివాస్ రావు గుండు', email: 'srinivas.gundu@gmail.com', phone: '9440099887', skills: ['cnc', 'quality control'], experience: 10 },
  },
  {
    id: 'hi-hindi',
    text: `नाम: सुनीता शर्मा
मोबाइल: +91 ९८७६५४३२१०
ईमेल: sunita.sharma.hi@yahoo.in
अनुभव: 3 years experience
कौशल: Teaching, Lesson Planning, Communication`,
    expect: { name: 'सुनीता शर्मा', email: 'sunita.sharma.hi@yahoo.in', phone: '9876543210', skills: ['teaching', 'lesson planning', 'communication'], experience: 3 },
  },
];

// Samples added 2026-11-18 (CTC, notice period, date of birth, jobs and degrees as entries).
SAMPLES.push(
  {
    id: 'en-ctc-notice',
    text: `Kiran Kumar Reddy
kiran.reddy@gmail.com | 9000123456
Date of Birth: 21-07-1992
Current CTC: 5.5 LPA
Expected CTC: 7.5 LPA
Notice Period: 60 days
SKILLS: Java, Spring Boot, MySQL
Senior Developer, Alpha Technologies Pvt Ltd   Apr 2018 - Present
Developer, Beta Solutions   Jun 2015 - Mar 2018
B.Tech (CSE), JNTU Hyderabad, 2014, 68%`,
    expect: {
      name: 'Kiran Kumar Reddy', email: 'kiran.reddy@gmail.com', phone: '9000123456', skills: ['java', 'spring boot', 'mysql'], currentSalary: '5.5 LPA', expectedSalary: '7.5 LPA', noticePeriod: '60 Days', dob: '1992-07-21', jobs: 2, degrees: 1,
    },
  },
  {
    id: 'en-unlabelled-ctc',
    text: `Sneha Latha
sneha.latha@yahoo.com
Mobile: 9876501234
Presently drawing 4.2 LPA, looking for around 6 LPA. Can join within 30 days.
Skills: Tally, GST, Accounting
Accounts Executive, Sri Traders   Jan 2019 - Present
M.Com, Osmania University, 2018`,
    expect: {
      name: 'Sneha Latha', email: 'sneha.latha@yahoo.com', phone: '9876501234', skills: ['tally', 'gst', 'accounting'], currentSalary: '4.2 LPA', expectedSalary: '6 LPA', noticePeriod: '30 Days', jobs: 1, degrees: 1,
    },
  },
  {
    id: 'en-ctc-lakh-format',
    text: `Prasad Rao Vemuri
prasad.vemuri@gmail.com
Phone: 9848099999
CTC: 6,00,000 (current)  Expected: 8,00,000
Notice: Immediate
Skills: Sales, Marketing, Communication`,
    expect: {
      name: 'Prasad Rao Vemuri', email: 'prasad.vemuri@gmail.com', phone: '9848099999', skills: ['sales', 'marketing', 'communication'], currentSalary: '6 LPA', expectedSalary: '8 LPA', noticePeriod: 'Immediate',
    },
  },
);

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const d10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
function f1(read, want) {
  const r = new Set(read.map(norm)); const w = new Set(want.map(norm));
  const hit = [...w].filter((x) => r.has(x)).length;
  const precision = r.size ? hit / r.size : (w.size ? 0 : 1);
  const recall = w.size ? hit / w.size : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

const FIELDS = ['name', 'email', 'phone', 'skills', 'experience', 'currentSalary', 'expectedSalary', 'noticePeriod', 'dob', 'jobs', 'degrees'];
const lpaOf = (v) => { const m = /(\d+(?:\.\d+)?)/.exec(String(v == null ? '' : v)); return m ? Number(m[1]) : null; };
const noticeDays = (v) => { const t = String(v || '').toLowerCase(); if (/immediate/.test(t)) return 0; const m = /(\d+)/.exec(t); return m ? Number(m[1]) : null; };
function score(p, expect) {
  const ok = {};
  const sk = expect.skills ? f1(p.skills || [], expect.skills) : null;
  if (expect.name !== undefined) ok.name = norm(p.name) === norm(expect.name);
  if (expect.email !== undefined) ok.email = (p.emails || []).map(norm).includes(norm(expect.email));
  if (expect.phone !== undefined) ok.phone = (p.phones || []).map(d10).includes(d10(expect.phone));
  if (expect.skills !== undefined) ok.skills = sk.f1 >= 0.8;
  if (expect.experience !== undefined) ok.experience = expect.experience == null ? p.totalExperienceYears == null : (p.totalExperienceYears != null && Math.abs(p.totalExperienceYears - expect.experience) <= 0.5);
  if (expect.currentSalary !== undefined) ok.currentSalary = lpaOf(p.currentSalary) != null && Math.abs(lpaOf(p.currentSalary) - lpaOf(expect.currentSalary)) < 0.06;
  if (expect.expectedSalary !== undefined) ok.expectedSalary = lpaOf(p.expectedSalary) != null && Math.abs(lpaOf(p.expectedSalary) - lpaOf(expect.expectedSalary)) < 0.06;
  if (expect.noticePeriod !== undefined) ok.noticePeriod = noticeDays(p.noticePeriod) != null && noticeDays(p.noticePeriod) === noticeDays(expect.noticePeriod);
  if (expect.dob !== undefined) ok.dob = String(p.dob || '') === String(expect.dob);
  if (expect.jobs !== undefined) ok.jobs = (p.employment || []).length === expect.jobs;
  if (expect.degrees !== undefined) ok.degrees = (p.educationEntries || []).length === expect.degrees;
  return { ok, sk };
}
const READ_OF = {
  name: (p) => !!p.name,
  email: (p) => (p.emails || []).length > 0,
  phone: (p) => (p.phones || []).length > 0,
  skills: (p) => (p.skills || []).length > 0,
  experience: (p) => p.totalExperienceYears != null,
  currentSalary: (p) => !!p.currentSalary,
  expectedSalary: (p) => !!p.expectedSalary,
  noticePeriod: (p) => !!p.noticePeriod,
  dob: (p) => !!p.dob,
  jobs: (p) => (p.employment || []).length > 0,
  degrees: (p) => (p.educationEntries || []).length > 0,
};
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.forEach((e) => {
    if (out.length >= 500) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(pdf|docx|doc|rtf|txt)$/i.test(e.name)) out.push(full);
  });
  return out;
}
async function textOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'txt') return fs.readFileSync(file, 'utf8');
  const { extractText } = require('../src/utils/resumeParse');
  return (await extractText(fs.readFileSync(file), ext)).text;
}
function bump(right, checked, ok) { Object.keys(ok).forEach((f) => { checked[f] += 1; if (ok[f]) right[f] += 1; }); }
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const readRow = (p) => ({
  name: p.name, emails: p.emails, phones: p.phones, skills: (p.skills || []).length, experience: p.totalExperienceYears, currentSalary: p.currentSalary, expectedSalary: p.expectedSalary, noticePeriod: p.noticePeriod, dob: p.dob, jobs: (p.employment || []).length, degrees: (p.educationEntries || []).length,
});

async function run({ quiet = false, sampleDir = process.env.RESUME_SAMPLE_DIR || null } = {}) {
  const vocabulary = BUILTIN_SKILLS;
  const zero = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const right = zero(); const checked = zero();
  const rows = [];
  let pSum = 0; let rSum = 0; let skN = 0;
  for (const s of SAMPLES) {
    // eslint-disable-next-line no-await-in-loop
    const p = await parseResumeText(s.text, { vocabulary });
    const { ok, sk } = score(p, s.expect);
    if (sk) { pSum += sk.precision; rSum += sk.recall; skN += 1; }
    bump(right, checked, ok);
    rows.push({ id: s.id, source: 'built-in', languages: p.languages, ok, read: readRow(p), skillsF1: sk ? Math.round(sk.f1 * 100) / 100 : null });
  }
  const builtIn = { samples: SAMPLES.length, accuracy: Object.fromEntries(FIELDS.map((f) => [f, pct(right[f], checked[f])])), checked: { ...checked } };
  // ---- the founder's own folder
  let folder = null;
  const fr = zero(); const fc = zero();
  if (sampleDir) {
    const files = walk(sampleDir);
    const fread = zero();
    let withExpected = 0; const unreadable = [];
    for (const file of files) {
      let text = '';
      try { text = await textOf(file); } catch { text = ''; } // eslint-disable-line no-await-in-loop
      if (!text || text.length < 30) { unreadable.push(path.basename(file)); continue; } // eslint-disable-line no-continue
      const p = await parseResumeText(text, { vocabulary }); // eslint-disable-line no-await-in-loop
      FIELDS.forEach((f) => { if (READ_OF[f](p)) fread[f] += 1; });
      let expect = null;
      const side = file.replace(/\.[^.]+$/, '.expected.json');
      try { if (fs.existsSync(side)) expect = JSON.parse(fs.readFileSync(side, 'utf8')); } catch { expect = null; }
      let ok = {};
      if (expect) { withExpected += 1; ({ ok } = score(p, expect)); bump(fr, fc, ok); }
      rows.push({ id: path.relative(sampleDir, file), source: 'folder', languages: p.languages, ok, scored: !!expect, read: readRow(p) });
    }
    const readable = files.length - unreadable.length;
    folder = {
      dir: sampleDir,
      files: files.length,
      readable,
      unreadable,
      withExpected,
      accuracy: Object.fromEntries(FIELDS.map((f) => [f, pct(fr[f], fc[f])])),
      checked: { ...fc },
      coverage: Object.fromEntries(FIELDS.map((f) => [f, pct(fread[f], readable)])),
    };
  }
  const tr = {}; const tc = {};
  FIELDS.forEach((f) => { tr[f] = right[f] + fr[f]; tc[f] = checked[f] + fc[f]; });
  const accuracy = Object.fromEntries(FIELDS.map((f) => [f, pct(tr[f], tc[f])]));
  const overall = pct(FIELDS.reduce((a, f) => a + tr[f], 0), FIELDS.reduce((a, f) => a + tc[f], 0));
  const result = {
    samples: SAMPLES.length, accuracy, overall, checked: tc, skillsPrecision: skN ? Math.round((pSum / skN) * 1000) / 10 : null, skillsRecall: skN ? Math.round((rSum / skN) * 1000) / 10 : null, builtIn, folder, rows,
  };
  if (quiet) return result;
  if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return result; }
  console.log(`Resume parser accuracy - ${SAMPLES.length} built-in sample resumes${folder ? ` + ${folder.files} file(s) from ${folder.dir}` : ''} (free parser, no AI)\n`);
  console.log(`${'sample'.padEnd(26)}${'lang'.padEnd(16)}${FIELDS.map((f) => f.slice(0, 11).padEnd(12)).join('')}`);
  rows.forEach((r) => {
    console.log(`${r.id.slice(0, 25).padEnd(26)}${(r.languages || []).join('+').padEnd(16)}${FIELDS.map((f) => (r.ok[f] === undefined ? '-' : (r.ok[f] ? 'ok' : 'MISS')).padEnd(12)).join('')}`);
  });
  console.log('\nField-level accuracy (right / checked)');
  FIELDS.forEach((f) => console.log(`  ${f.padEnd(14)}${accuracy[f] == null ? '  n/a ' : `${String(accuracy[f]).padStart(5)} %`}  (${tr[f]}/${tc[f]})`));
  if (result.skillsPrecision != null) console.log(`  ${'skills P/R'.padEnd(14)}${String(result.skillsPrecision).padStart(5)} % precision, ${result.skillsRecall} % recall`);
  console.log(`  ${'OVERALL'.padEnd(14)}${String(overall).padStart(5)} %`);
  if (folder) {
    console.log(`\nYour folder ${folder.dir}: ${folder.files} file(s), ${folder.readable} readable, ${folder.withExpected} with an .expected.json`);
    if (folder.unreadable.length) console.log(`  not readable (scanned / empty): ${folder.unreadable.slice(0, 10).join(', ')}`);
    console.log(`  ${'field'.padEnd(14)}${'accuracy'.padEnd(26)}read in`);
    FIELDS.forEach((f) => console.log(`  ${f.padEnd(14)}${(folder.accuracy[f] == null ? 'n/a (no answers given)' : `${folder.accuracy[f]} % (${folder.checked[f]})`).padEnd(26)}${folder.coverage[f] == null ? 'n/a' : `${folder.coverage[f]} % of files`}`));
  }
  const misses = rows.filter((r) => FIELDS.some((f) => r.ok[f] === false));
  if (misses.length) {
    console.log('\nWhat was missed');
    const key = (f) => (f === 'email' ? 'emails' : f === 'phone' ? 'phones' : f);
    misses.forEach((r) => FIELDS.filter((f) => r.ok[f] === false).forEach((f) => console.log(`  ${r.id} - ${f}: read ${JSON.stringify(r.read[key(f)])}`)));
  }
  return result;
}

module.exports = { SAMPLES, run, FIELDS };
if (require.main === module) {
  run().then((r) => {
    const i = process.argv.indexOf('--min');
    const min = i > 0 ? Number(process.argv[i + 1]) : null;
    process.exit(min != null && r.overall < min ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(2); });
}
