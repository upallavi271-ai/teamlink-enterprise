/*
 * THE NAME WHEN THE PORTAL'S READER FINDS NONE (2026-11-28: "no name is added ani ostundi ... import ayyi create avvali").
 * "GADAM.ROHITH KUMAR" at the top of a resume was refused for the dot, so the person was never added although the phone and the email were read.
 * Used by embed/resume-import.mjs only when the portal's reader gives no name:
 *   1. the first lines of the resume: a short line of letters (dots between initials allowed) that is not a heading or a job title;
 *   2. else the file's own name, without "resume / cv" and job words;
 *   3. else the part of the email before the @.
 * Always returns something for a resume that has an email or a file name, so the candidate is created; a recruiter can correct the name on the profile.
 */
const NOT_A_NAME = /\b(resume|curriculum|vitae|cv|biodata|profile|summary|objective|contact|address|phone|mobile|email|e-mail|skills?|experience|education|projects?|declaration|personal|details|page|career|professional)\b/i;
const JOB_WORDS = /\b(engineer(ing)?|eng|developer|manager|executive|nurse|doctor|dentist|surgeon|analyst|consultant|officer|associate|lead|intern|specialist|physician|technician|assistant|trainee|teacher|lecturer|professor|accountant|designer|tester|programmer|pharmacist|recruiter|supervisor|coordinator|administrator|architect|hardware|software|testing|design|marketing|sales|medical|hr|fresher|updated|latest|final|new|copy|scan(ned)?|doc(ument)?)\b/i;
const CITIES = /\b(hyderabad|bangalore|bengaluru|chennai|mumbai|pune|delhi|india|telangana|andhra|pradesh|karnataka|tamil|nadu|kerala|maharashtra)\b/i;

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const tidy = (s) => String(s || '').replace(/[._]+/g, ' ').replace(/[^A-Za-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const pretty = (s) => (s === s.toUpperCase() || s === s.toLowerCase() ? titleCase(s) : s).slice(0, 120);

function fromText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 6);
  for (const raw of lines) {
    const line = raw.replace(/^(name|candidate name)\s*[:-]\s*/i, '').split(/[|,•]/)[0].trim();
    if (line.length >= 3 && line.length <= 50 && /^[A-Za-z][A-Za-z.\s'-]*$/.test(line) && !NOT_A_NAME.test(line) && !JOB_WORDS.test(line) && !CITIES.test(line)) {
      const t = tidy(line);
      const words = t.split(' ');
      if (t.length >= 3 && words.length <= 5 && words.some((w) => w.length >= 3)) return pretty(t);
    }
  }
  return '';
}

function fromWords(s) {
  const words = tidy(s).split(' ').filter((w) => w && !NOT_A_NAME.test(w) && !JOB_WORDS.test(w) && !CITIES.test(w));
  const t = words.slice(0, 4).join(' ');
  return t.replace(/\s/g, '').length >= 3 ? titleCase(t).slice(0, 120) : '';
}

export function nameFallback(text, email, filename) {
  return fromText(text)
    || fromWords(String(filename || '').replace(/\.[A-Za-z0-9]{1,5}$/, ''))
    || fromWords(String(email || '').split('@')[0]);
}
