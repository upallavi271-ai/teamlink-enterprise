#!/usr/bin/env node
/**
 * RESUME PARSER ACCURACY (founder audit 2026-11-17, "parsing accuracy measurement"). Runs the free resume parser
 * (src/utils/resumeParse.js parseResumeText) over a small built-in set of sample resume texts whose right answers are known,
 * and prints field-level accuracy: name, email, phone, skills, experience. No database, no network, no AI.
 *
 *   node scripts/resume-parse-accuracy.js            the table + accuracy per field
 *   node scripts/resume-parse-accuracy.js --json     the same as JSON
 *   node scripts/resume-parse-accuracy.js --min 70   exit 1 when the overall accuracy is below 70 %
 *
 * How a field counts as right:
 *   name        the same words (case and spaces ignored)
 *   email       the expected address is among the ones read
 *   phone       the expected 10 digits are among the ones read
 *   skills      F1 of the skills read vs expected >= 0.8 (precision and recall are printed too)
 *   experience  within 0.5 years of the expected total (null expected = nothing should be read)
 * The samples include Telugu and Hindi resumes (script detection, Telugu / Devanagari digits).
 */
const path = require('path');

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

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const d10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
function f1(read, want) {
  const r = new Set(read.map(norm)); const w = new Set(want.map(norm));
  const hit = [...w].filter((x) => r.has(x)).length;
  const precision = r.size ? hit / r.size : (w.size ? 0 : 1);
  const recall = w.size ? hit / w.size : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

async function run({ quiet = false } = {}) {
  const vocabulary = BUILTIN_SKILLS;
  const FIELDS = ['name', 'email', 'phone', 'skills', 'experience'];
  const right = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const rows = [];
  let pSum = 0; let rSum = 0;
  for (const s of SAMPLES) {
    // eslint-disable-next-line no-await-in-loop
    const p = await parseResumeText(s.text, { vocabulary });
    const sk = f1(p.skills || [], s.expect.skills);
    pSum += sk.precision; rSum += sk.recall;
    const ok = {
      name: norm(p.name) === norm(s.expect.name),
      email: (p.emails || []).map(norm).includes(norm(s.expect.email)),
      phone: (p.phones || []).map(d10).includes(d10(s.expect.phone)),
      skills: sk.f1 >= 0.8,
      experience: s.expect.experience == null ? p.totalExperienceYears == null : (p.totalExperienceYears != null && Math.abs(p.totalExperienceYears - s.expect.experience) <= 0.5),
    };
    FIELDS.forEach((f) => { if (ok[f]) right[f] += 1; });
    rows.push({ id: s.id, languages: p.languages, ok, read: { name: p.name, emails: p.emails, phones: p.phones, skills: p.skills, experience: p.totalExperienceYears }, skillsF1: Math.round(sk.f1 * 100) / 100 });
  }
  const n = SAMPLES.length;
  const accuracy = Object.fromEntries(FIELDS.map((f) => [f, Math.round((right[f] / n) * 1000) / 10]));
  const overall = Math.round((FIELDS.reduce((a, f) => a + right[f], 0) / (n * FIELDS.length)) * 1000) / 10;
  const result = { samples: n, accuracy, overall, skillsPrecision: Math.round((pSum / n) * 1000) / 10, skillsRecall: Math.round((rSum / n) * 1000) / 10, rows };
  if (quiet) return result;
  if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return result; }
  console.log(`Resume parser accuracy — ${n} sample resumes (free parser, no AI)\n`);
  console.log(`${'sample'.padEnd(24)}${'lang'.padEnd(16)}${FIELDS.map((f) => f.padEnd(12)).join('')}`);
  rows.forEach((r) => {
    console.log(`${r.id.padEnd(24)}${(r.languages || []).join('+').padEnd(16)}${FIELDS.map((f) => (r.ok[f] ? 'ok' : 'MISS').padEnd(12)).join('')}`);
  });
  console.log('\nField-level accuracy');
  FIELDS.forEach((f) => console.log(`  ${f.padEnd(12)}${String(accuracy[f]).padStart(5)} %  (${right[f]}/${n})`));
  console.log(`  ${'skills P/R'.padEnd(12)}${String(result.skillsPrecision).padStart(5)} % precision, ${result.skillsRecall} % recall`);
  console.log(`  ${'OVERALL'.padEnd(12)}${String(overall).padStart(5)} %`);
  const misses = rows.filter((r) => FIELDS.some((f) => !r.ok[f]));
  if (misses.length) {
    console.log('\nWhat was missed');
    misses.forEach((r) => FIELDS.filter((f) => !r.ok[f]).forEach((f) => console.log(`  ${r.id} · ${f}: read ${JSON.stringify(f === 'experience' ? r.read.experience : f === 'email' ? r.read.emails : f === 'phone' ? r.read.phones : r.read[f])}`)));
  }
  return result;
}

module.exports = { SAMPLES, run };
if (require.main === module) {
  run().then((r) => {
    const i = process.argv.indexOf('--min');
    const min = i > 0 ? Number(process.argv[i + 1]) : null;
    process.exit(min != null && r.overall < min ? 1 : 0);
  }).catch((e) => { console.error(e); process.exit(2); });
}
