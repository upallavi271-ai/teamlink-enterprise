// ---------------------------------------------------------------------------
// DATA QUALITY (ATS audit A1-A7 / AR1 "Data Quality Report", founder 2026-11-17).
//   completeness(c)  0-100: how much of a profile a recruiter needs is filled (phone, email, location, experience, education,
//                    specialization, skills, current + expected salary, notice period, resume) + the missing items, in words.
//   report()         the whole database: average completeness and its spread, profiles missing phone / email, duplicate
//                    flags still open and the duplicate rate, merges done, profiles not touched for 6 months (stale),
//                    consent not recorded. Reports & Team -> Data quality.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ITEMS = [
  ['phone', 'Phone', 15, (c) => !!c.phone],
  ['email', 'Email', 10, (c) => !!c.email],
  ['location', 'Location', 8, (c) => !!c.location],
  ['experience', 'Experience', 10, (c) => c.experienceYears != null],
  ['education', 'Qualification', 10, (c) => !!(c.education || c.qualificationId)],
  ['specialization', 'Specialization', 8, (c) => !!(c.specialization || c.specialisationId)],
  ['skills', 'Skills', 10, (c) => !!(c.skills || c.technicalSkills)],
  ['currentSalary', 'Current salary', 7, (c) => !!c.currentSalary],
  ['expectedSalary', 'Expected salary', 7, (c) => !!c.expectedSalary],
  ['noticePeriod', 'Notice period', 5, (c) => !!c.noticePeriod],
  ['resume', 'Resume', 10, (c) => !!c.resumeName],
];
const TOTAL = ITEMS.reduce((s, i) => s + i[2], 0);
const SELECT = { id: true, name: true, dob: true, passingYear: true, phone: true, email: true, location: true, experienceYears: true, education: true, qualificationId: true, specialization: true, specialisationId: true, skills: true, technicalSkills: true, currentSalary: true, expectedSalary: true, noticePeriod: true, resumeName: true };

// --- WRONG VALUES, NOT ONLY MISSING ONES (ATS audit 2026-11-18, Q707 / Q708) ----------------------------------------------------
// validity(c) -> [{ key, label }] for values that are filled in but cannot be right: an e-mail that is not an address, a phone that is
// not a 10-digit Indian mobile (or one digit repeated), a date of birth that is not a date / in the future / an age under 15 or over 80,
// and values that contradict each other (more experience than the age allows, a passing year in the future on an experienced profile).
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const ISSUES = {
  email: 'E-mail is not a valid address',
  phone: 'Phone is not a valid 10-digit mobile number',
  dob: 'Date of birth is not a real date',
  age: 'Age from the date of birth is under 15 or over 80',
  experience: 'Experience is negative or more than 50 years',
  experienceAge: 'Experience is more than the age allows',
  passingYear: 'Passing year is in the future but the profile has experience',
};
function mobileDigits(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}
function dobDate(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}
function validity(c, now = new Date()) {
  const out = [];
  if (!c) return out;
  if (c.email && !EMAIL_OK.test(String(c.email).trim())) out.push('email');
  if (c.phone) { const d = mobileDigits(c.phone); if (d.length !== 10 || !/^[6-9]/.test(d) || /^(\d)\1{9}$/.test(d)) out.push('phone'); }
  let age = null;
  if (c.dob) {
    const d = dobDate(c.dob);
    if (!d || Number.isNaN(d.getTime()) || d > now) out.push('dob');
    else { age = (now - d) / (365.25 * 86400000); if (age < 15 || age > 80) out.push('age'); }
  }
  const exp = c.experienceYears != null ? Number(c.experienceYears) : null;
  if (exp != null && (exp < 0 || exp > 50)) out.push('experience');
  if (exp != null && age != null && age >= 15 && exp > age - 14) out.push('experienceAge');
  if (exp != null && exp > 0 && /^\d{4}$/.test(String(c.passingYear || '').trim()) && Number(c.passingYear) > now.getFullYear()) out.push('passingYear');
  return out.map((key) => ({ key, label: ISSUES[key] }));
}

function completeness(c) {
  if (!c) return { score: 0, missing: [] };
  let got = 0; const missing = [];
  ITEMS.forEach(([, label, w, has]) => { if (has(c)) got += w; else missing.push(label); });
  return { score: Math.round((got / TOTAL) * 100), missing };
}

async function report() {
  const total = await prisma.candidate.count();
  const buckets = { '0-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 };
  const missingBy = Object.fromEntries(ITEMS.map(([, l]) => [l, 0]));
  let sum = 0; let cursor = null; let seen = 0;
  const invalidBy = Object.fromEntries(Object.keys(ISSUES).map((k) => [k, 0]));
  const toFix = []; // the first 200 profiles with a wrong value, for the list on the screen
  let invalidProfiles = 0;
  // in pages, so 50,000 profiles never sit in memory at once
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({ select: SELECT, take: 5000, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: 'asc' } });
    if (!rows.length) break;
    rows.forEach((c) => {
      const { score, missing } = completeness(c);
      sum += score; seen += 1;
      buckets[score < 40 ? '0-39' : score < 60 ? '40-59' : score < 80 ? '60-79' : '80-100'] += 1;
      missing.forEach((m) => { missingBy[m] += 1; });
      const bad = validity(c);
      if (bad.length) {
        invalidProfiles += 1;
        bad.forEach((b) => { invalidBy[b.key] += 1; });
        if (toFix.length < 200) toFix.push({ id: c.id, name: c.name, issues: bad.map((b) => b.label) });
      }
    });
    cursor = rows[rows.length - 1].id;
    if (rows.length < 5000) break;
  }
  const since = new Date(Date.now() - 182 * 86400000);
  const safeCount = (p) => p.catch(() => null);
  const [openDup, merges, noConsent, staleN, noPhoneEmail, flagStates] = await Promise.all([
    safeCount(prisma.candidateDupFlag.count({ where: { status: 'OPEN' } })),
    safeCount(prisma.candidateMergeLog.count()),
    safeCount(prisma.candidate.count({ where: { consentStatus: null } })),
    safeCount(prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "Candidate" c WHERE c."createdAt" < ? AND NOT EXISTS (SELECT 1 FROM "Application" a WHERE a."candidateId" = c."id" AND a."updatedAt" >= ?)`, since.getTime(), since.getTime()).then((r) => Number(r[0].n))),
    safeCount(prisma.candidate.count({ where: { phone: null, email: null } })),
    safeCount(prisma.candidateDupFlag.groupBy({ by: ['status'], _count: true })),
  ]);
  // HOW RIGHT THE DUPLICATE FINDER IS (A3/A4): of the flags a person has decided, how many were really the same person
  // (merged / merge asked / same person, other job) and how many were not (NOT_DUPLICATE = a false alarm).
  const st = new Map((flagStates || []).map((r) => [r.status, r._count]));
  const truePos = (st.get('MERGED') || 0) + (st.get('MERGE_REQUESTED') || 0) + (st.get('SAME_PERSON_OTHER_JOB') || 0);
  const falsePos = st.get('NOT_DUPLICATE') || 0;
  const decided = truePos + falsePos;
  const accuracy = { decided, sameperson: truePos, falseAlarms: falsePos, precisionPct: decided ? Math.round((truePos / decided) * 1000) / 10 : null, falseAlarmPct: decided ? Math.round((falsePos / decided) * 1000) / 10 : null, autoClosed: st.get('AUTO_CLOSED') || 0 };
  return {
    at: new Date().toISOString(),
    total,
    averageCompleteness: seen ? Math.round(sum / seen) : 0,
    spread: buckets,
    missing: Object.entries(missingBy).map(([label, n]) => ({ label, count: n, pct: total ? Math.round((n / total) * 100) : 0 })).sort((a, b) => b.count - a.count),
    noPhoneNoEmail: noPhoneEmail,
    duplicates: { openFlags: openDup, merged: merges, ratePct: total && openDup != null ? Math.round((openDup / total) * 1000) / 10 : null, accuracy },
    staleSixMonths: staleN,
    consentNotRecorded: noConsent,
    items: ITEMS.map(([k, l, w]) => ({ key: k, label: l, weight: w })),
    // wrong values (Q707/Q708): how many of each, and the profiles to fix first
    invalid: {
      profiles: invalidProfiles,
      pct: total ? Math.round((invalidProfiles / total) * 1000) / 10 : 0,
      byIssue: Object.entries(invalidBy).filter(([, n]) => n > 0).map(([key, n]) => ({ key, label: ISSUES[key], count: n })).sort((a, b) => b.count - a.count),
      toFix,
    },
  };
}

module.exports = { completeness, report, ITEMS, validity, ISSUES };
