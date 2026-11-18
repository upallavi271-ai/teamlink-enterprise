/*
 * WORK HISTORY AND EDUCATION FROM A RESUME, MORE THOROUGHLY (2026-11-20, "experience and education kuda extract cheyali").
 * The portal's own reader (api/src/resume/fields.js) finds the total experience, the current company and one education line, but on an ordinary
 * resume it returned NO list of jobs and one degree with the wrong year. This reads the two sections line by line:
 *   workHistory(text)   -> [{ company, jobTitle, location, responsibilities }]   every dated job, in the order written
 *   educationList(text) -> [{ qualification, specialization, institution, passingYear, score, educationType }]   every degree line
 * Used by embed/resume-import.mjs only to FILL a profile that has no rows yet (a candidate's own list is never replaced). Pure text in, rows out.
 */
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE = `(?:${MONTH}\\s*,?\\s*(?:19|20)\\d{2}|\\d{1,2}\\s*[/.-]\\s*(?:19|20)\\d{2}|(?:19|20)\\d{2})`;
const PERIOD = new RegExp(`(${DATE})\\s*(?:-|–|—|to|till|until)\\s*(present|current|till date|till now|now|date|${DATE})`, 'i');
const STOP = /^(education(al)?(\s+qualifications?)?|academic(\s+qualifications?|\s+details|\s+profile)?|qualifications?|skills?|technical\s+skills|key\s+skills|projects?|certifications?|achievements?|languages?|declaration|personal\s+(details|information)|references?|professional\s+summary|summary|objective|career\s+objective|internships?|training|awards?|hobbies|interests)\s*:?$/i;
const EXP_HEAD = /^(work\s+experience|professional\s+experience|employment(\s+history|\s+details)?|career\s+history|work\s+history|experience(\s+details)?|clinical\s+experience|relevant\s+experience)\s*:?$/i;
const EDU_HEAD = /^(education(al)?(\s+qualifications?|\s+details|\s+background)?|academic(\s+qualifications?|\s+details|\s+profile)?|qualifications?)\s*:?$/i;
const TITLE = /\b(surgeon|doctor|dr\.?|engineer|developer|manager|executive|nurse|analyst|consultant|officer|associate|lead|intern|specialist|physician|technician|assistant|head|director|trainee|resident|dentist|recruiter|accountant|teacher|lecturer|professor|supervisor|coordinator|administrator|architect|designer|tester|programmer|pharmacist|therapist|registrar|houseman|clerk|representative|sales|hr)\b/i;

const lines = (t) => String(t || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
const BUL = /^[•●▪◦*\-–>·]\s*/;
const bullet = (l) => BUL.test(l);
const unbullet = (l) => l.replace(BUL, '').trim();
const trimEdges = (s) => String(s || '').replace(/^[()|,\-–—\s]+/, '').replace(/[()|,\-–—\s]+$/, '').trim();

function section(all, head) {
  const i = all.findIndex((l) => head.test(l.replace(/[:\s]+$/, '')));
  if (i < 0) return [];
  let j = all.length;
  for (let k = i + 1; k < all.length; k += 1) {
    const l = all[k].replace(/[:\s]+$/, '');
    if (l && l.length <= 40 && STOP.test(l) && !head.test(l)) { j = k; break; }
  }
  return all.slice(i + 1, j);
}

function splitHeader(h) {
  const parts = String(h || '').split(/\s+(?:-|–|—|\||@|at)\s+|\s*\|\s*|,\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return TITLE.test(parts[0]) ? { jobTitle: parts[0] } : { company: parts[0] };
  const ti = parts.findIndex((p) => TITLE.test(p));
  const at = ti >= 0 ? ti : 0;
  const rest = parts.filter((_, i) => i !== at);
  return { jobTitle: parts[at], company: rest[0], location: rest[1] };
}

export function workHistory(text) {
  const sec = section(lines(text), EXP_HEAD);
  const out = [];
  const used = new Set();
  for (let i = 0; i < sec.length; i += 1) {
    const m = PERIOD.exec(sec[i]);
    if (m) {
      const period = `${m[1]} - ${m[2]}`;
      let header = trimEdges(sec[i].replace(PERIOD, ''));
      if (header.length < 3) {
        for (let k = i - 1; k >= 0 && k >= i - 3; k -= 1) {
          if (!sec[k]) continue; // eslint-disable-line no-continue
          if (used.has(k) || bullet(sec[k]) || PERIOD.test(sec[k])) break;
          header = header ? `${sec[k]} - ${header}` : sec[k];
          used.add(k);
          if (TITLE.test(sec[k]) || /[-–|@,]|\bat\b/.test(sec[k])) break;
        }
      }
      const body = [];
      for (let k = i + 1; k < sec.length && body.length < 4; k += 1) {
        if (!sec[k]) { if (body.length) break; continue; } // eslint-disable-line no-continue
        if (PERIOD.test(sec[k])) break;
        if (!bullet(sec[k]) && k + 1 < sec.length && PERIOD.test(sec[k + 1])) break; // the next job's header line
        body.push(unbullet(sec[k]));
      }
      const hd = splitHeader(header);
      if (hd.company || hd.jobTitle) {
        out.push({ company: hd.company || '', jobTitle: hd.jobTitle || '', location: hd.location || '', responsibilities: `${period}${body.length ? `. ${body.join('; ')}` : ''}`.slice(0, 600) });
      }
    }
  }
  return out.slice(0, 15);
}

const DEGREE = /\b(mbbs|bds|mds|md|ms|dnb|bams|bhms|bpt|mpt|b\.?\s?pharm|m\.?\s?pharm|pharm\.?\s?d|b\.?\s?sc(?:\.?\s?nursing)?|m\.?\s?sc|gnm|anm|b\.?\s?tech|m\.?\s?tech|b\.?\s?e|m\.?\s?e|b\.?\s?com|m\.?\s?com|bba|mba|bca|mca|b\.?\s?a|m\.?\s?a|ph\.?\s?d|diploma|iti|intermediate|10th|12th|ssc|hsc|x\s?class|xii|graduation|post\s?graduation|pgdm|llb|llm|bachelor|master)\b/i;
const INST = /\b(college|university|institute|school|academy|hospital|iit|nit|polytechnic|vidyalaya|board)\b/i;
const YEAR_G = /\b((?:19|20)\d{2})\b/g;
const SCORE = /(\d{1,3}(?:\.\d+)?\s*%|(?:cgpa|gpa)\s*[:-]?\s*\d(?:\.\d+)?|\d(?:\.\d+)?\s*(?:cgpa|gpa))/i;
const levelOf = (q) => {
  const s = String(q).toLowerCase().replace(/[.\s]/g, '');
  if (/^(10th|ssc|xclass)/.test(s)) return 'Secondary';
  if (/^(12th|xii|intermediate|hsc)/.test(s)) return 'Higher Secondary';
  if (/^(diploma|iti|gnm|anm)/.test(s)) return 'Diploma';
  if (/^phd/.test(s)) return 'Doctorate';
  if (/^(m|pg|llm|dnb|master)/.test(s) && !/^(mbbs|bds|bpt|bams|bhms)/.test(s)) return 'Post Graduation';
  return 'Graduation';
};
const strip = (s) => trimEdges(String(s || '').replace(SCORE, '').replace(YEAR_G, ''));

export function educationList(text) {
  const sec = section(lines(text), EDU_HEAD).filter(Boolean);
  const out = [];
  for (let i = 0; i < sec.length; i += 1) {
    const l = unbullet(sec[i]);
    const dm = DEGREE.exec(l);
    if (dm) {
      const nextOwn = sec[i + 1] && !DEGREE.test(unbullet(sec[i + 1])) ? unbullet(sec[i + 1]) : '';
      const both = `${l} ${nextOwn}`;
      const years = [...both.matchAll(YEAR_G)].map((x) => x[1]);
      const parts = l.split(/\s+(?:-|–|—|,|from)\s+|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
      const inst = parts.find((p) => INST.test(p) && !DEGREE.test(p))
        || (nextOwn && INST.test(nextOwn) ? nextOwn.split(/\s+(?:-|–|\|)\s+/)[0] : '')
        || parts.find((p) => INST.test(p)) || '';
      const qualPart = parts.find((p) => DEGREE.test(p)) || dm[0];
      const spec = (/\b(?:in|specialization|specialisation)\s+([A-Za-z &/]{3,60})/i.exec(qualPart) || [])[1]
        || (parts[0] === qualPart && parts.length > 1 && !INST.test(parts[1]) && !/\d{4}/.test(parts[1]) ? parts[1] : '');
      out.push({
        qualification: strip(qualPart.replace(/\bin\s+[A-Za-z &/]{3,60}/i, '')).slice(0, 80) || dm[0],
        specialization: strip(spec).slice(0, 80),
        institution: strip(inst).slice(0, 120),
        passingYear: years.length ? years[years.length - 1] : '',
        score: (SCORE.exec(both) || [''])[0].trim(),
        educationType: levelOf(dm[0]),
      });
    }
  }
  return out.slice(0, 10);
}
