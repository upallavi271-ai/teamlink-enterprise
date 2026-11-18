// ---------------------------------------------------------------------------
// RESUME FIELDS (founder audit 2026-11-18, parsing quality). The part of the free resume parser that reads the fields
// utils/resumeParse.js did not: current / expected CTC, notice period, one entry per job and per degree, languages the person
// knows, address, native place, marital status, father's name, date of birth, gender - and a CONFIDENCE (high / medium / low)
// and the resume sentence each value came from, so a person can check it.
//
//   enrich(text, parsed, { DEGREES })   adds the fields below to the object parseResumeText built (no database, no network)
//   classifySkills(skills)              { byCategory, map }  language / framework / database / cloud / tool / domain / soft
//   rtfToText(buffer)                   plain text out of an RTF file
//   salaryOf(raw)                       "6,00,000" -> "6 LPA" (utils/salaryFit.js does the reading)
//
// Confidence rule (the same everywhere):
//   high    the resume LABELS the value ("Current CTC: 5.5 LPA", "Name:", "DOB:") and says it once
//   medium  read from a phrase or a place without a label ("5 years of experience", the first line as the name, job dates)
//   low     a guess (an unlabelled "5.5 LPA", a name in a script the parser is weak in) or TWO different values were found
// A field that has two different values is also listed in parsed.conflicts so the verify queue can show both.
// ---------------------------------------------------------------------------
const SAL = require('./salaryFit');

const LEVEL = { high: 3, medium: 2, low: 1 };
const lower = (c1, c2) => (LEVEL[c1] <= LEVEL[c2] ? c1 : c2);
const clip = (s, n = 240) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- RTF -----------------------------------------------------------------------------------------------------
// A small reader: groups that are not text (fonts, colours, pictures, headers) are dropped, \par and \line become line breaks,
// \'hh and \uN become the character. Good enough for a resume saved as .rtf from Word / WordPad / LibreOffice.
function rtfToText(input) {
  const s = Buffer.isBuffer(input) ? input.toString('latin1') : String(input || '');
  const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'fldinst', 'operator', 'author', 'company', 'title', 'subject', 'keywords', 'comment', 'object']);
  const out = [];
  const stack = [];
  let skipDepth = -1; // depth at which a skipped group began
  let depth = 0;
  let i = 0;
  let uc = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') { depth += 1; stack.push(uc); i += 1; } else if (ch === '}') {
      if (skipDepth === depth) skipDepth = -1;
      depth -= 1; uc = stack.pop() || 1; i += 1;
    } else if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { if (skipDepth < 0) out.push(nx); i += 2; } else if (nx === '\'') {
        const hex = s.substr(i + 2, 2);
        if (skipDepth < 0 && /^[0-9a-fA-F]{2}$/.test(hex)) out.push(Buffer.from([parseInt(hex, 16)]).toString('latin1'));
        i += 4;
      } else if (nx === '*') { // an ignorable destination: skip the whole group
        if (skipDepth < 0) skipDepth = depth;
        i += 2;
      } else if (nx === '~') { if (skipDepth < 0) out.push(' '); i += 2; } else if (nx === '-' || nx === '_') { i += 2; } else {
        const m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(s.slice(i, i + 40));
        if (!m) { i += 1; continue; }
        const word = m[1]; const param = m[2];
        i += m[0].length;
        if (skipDepth < 0 && SKIP.has(word)) skipDepth = depth;
        else if (skipDepth < 0) {
          if (word === 'par' || word === 'line' || word === 'row' || word === 'sect') out.push('\n');
          else if (word === 'tab' || word === 'cell') out.push(' ');
          else if (word === 'bullet') out.push('• ');
          else if (word === 'emdash' || word === 'endash') out.push('-');
          else if (word === 'uc' && param != null) uc = Number(param);
          else if (word === 'u' && param != null) {
            let n = Number(param); if (n < 0) n += 65536;
            out.push(String.fromCharCode(n));
            i += uc; // the replacement characters that follow \uN
          }
        }
      }
    } else { if (skipDepth < 0 && ch !== '\r' && ch !== '\n') out.push(ch); i += 1; }
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const isRtf = (buf) => buf && buf.length > 5 && buf.toString('latin1', 0, 5) === '{\\rtf';

// --- salary --------------------------------------------------------------------------------------------------
function salaryOf(raw) {
  const p = SAL.parseAmount(raw);
  if (!p || !p.ok || p.fresher || !(p.lpa > 0)) return null;
  const text = SAL.normaliseLoose(raw);
  return { lpa: Math.round(p.lpa * 100) / 100, text: text && /\d/.test(text) ? text : `${Math.round(p.lpa * 100) / 100} LPA`, assumed: !!p.assumed };
}
const AMT = '(?:rs\\.?|inr|₹)?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(lpa|lakhs?\\s*per\\s*annum|lacs?\\s*per\\s*annum|lakhs?|lacs?|l\\b|cr\\b|crores?|k\\b|per\\s*annum|p\\.?\\s?a\\b|per\\s*month|per\\s*mon|p\\.?\\s?m\\b|/\\s*month|/-)?';
const CUR_LABEL = '(?:current|present|existing|last\\s*drawn|drawing|take[\\s-]?home|fixed|c\\.?\\s?ctc)\\s*(?:annual\\s*)?(?:ctc|salary|package|compensation|pay|remuneration)?';
const EXP_LABEL = '(?:expected|expecting|desired|asking|e\\.?\\s?ctc)\\s*(?:annual\\s*)?(?:ctc|salary|package|compensation|pay|remuneration)?';
function extractSalaries(text) {
  const lines = String(text || '').split('\n');
  const found = { current: [], expected: [] };
  const seenAt = new Set();
  const push = (kind, m, line, strength) => {
    const raw = `${m[1]} ${m[2] || ''}`.trim();
    const s = salaryOf(raw);
    if (!s || s.lpa < 0.1 || s.lpa > 500) return;
    const key = `${line}|${m.index}`;
    if (seenAt.has(key)) return;
    seenAt.add(key);
    found[kind].push({ value: s.text, lpa: s.lpa, strength, line: clip(line), assumed: s.assumed });
  };
  lines.forEach((line) => {
    if (line.length > 400) return;
    // labelled expected, then labelled current
    [['expected', EXP_LABEL, 'high'], ['current', CUR_LABEL, 'high']].forEach(([kind, label, strength]) => {
      const re = new RegExp(`(?:${label})\\s*(?:\\(.*?\\))?\\s*[:\\-–=]?\\s*${AMT}`, 'gi');
      let m;
      // eslint-disable-next-line no-cond-assign
      while ((m = re.exec(line))) {
        if (new RegExp(`^\\s*(?:${label})\\s*$`, 'i').test(m[0])) continue;
        push(kind, m, line, strength);
      }
    });
    // a bare "CTC: 6,00,000" / "Salary: 5 LPA" = current (medium); "(expected)" right after the amount turns it into the expected one
    const bare = new RegExp(`\\b(ctc|salary|package)\\b\\s*[:\\-–=]\\s*${AMT.replace('(\\d', '(\\d')}`, 'gi');
    let b;
    // eslint-disable-next-line no-cond-assign
    while ((b = bare.exec(line))) {
      const before = line.slice(Math.max(0, b.index - 14), b.index).toLowerCase();
      if (/(current|present|existing|expected|expecting|desired|asking|e|c)\.?\s*$/.test(before)) continue; // already read as labelled
      const m = [b[0], b[2], b[3]]; m.index = b.index + b[1].length;
      const after = line.slice(b.index + b[0].length, b.index + b[0].length + 18).toLowerCase();
      const kind = /expected|expecting/.test(after) ? 'expected' : 'current';
      push(kind, m, line, /current|expected/.test(after) ? 'high' : 'medium');
    }
    // unlabelled "5.5 LPA" in a line: a guess (expected when the line says so)
    const loose = /(\d+(?:\.\d+)?)\s*(lpa|lakhs?\s*per\s*annum|lacs?\s*per\s*annum)/gi;
    let l;
    // eslint-disable-next-line no-cond-assign
    while ((l = loose.exec(line))) {
      const before = line.slice(Math.max(0, l.index - 28), l.index).toLowerCase();
      const kind = /expect|desir|asking|looking\s*for|seeking|want|hoping/.test(before) || (/expect|desir|asking/.test(line.toLowerCase()) && !/current|present|drawing|earning/.test(before)) ? 'expected' : 'current';
      if ([...found.current, ...found.expected].some((x) => x.line === clip(line) && Math.abs(x.lpa - Number(l[1])) < 0.001)) continue;
      push(kind, l, line, kind === 'expected' ? 'medium' : 'low');
    }
  });
  const pick = (list) => {
    if (!list.length) return null;
    const best = [...list].sort((a, b) => LEVEL[b.strength] - LEVEL[a.strength])[0];
    const distinct = [...new Set(list.map((x) => x.lpa.toFixed(2)))];
    const conflict = distinct.length > 1;
    let confidence = best.strength;
    if (best.assumed && confidence === 'high') confidence = 'medium'; // the period (year / month) was guessed from the size
    if (conflict) confidence = 'low';
    return {
      value: best.value, lpa: best.lpa, confidence, evidence: best.line, conflict,
      values: conflict ? [...new Map(list.map((x) => [x.lpa.toFixed(2), x.value])).values()] : null,
      evidences: conflict ? list.map((x) => x.line) : null,
    };
  };
  return { current: pick(found.current), expected: pick(found.expected) };
}

// --- notice period -------------------------------------------------------------------------------------------
function extractNotice(text) {
  const t = String(text || '');
  const unit = (n, u) => {
    const x = Number(n);
    if (!(x >= 0)) return null;
    if (/^w/i.test(u)) return x * 7;
    if (/^m/i.test(u)) return x * 30;
    return x;
  };
  const fmt = (days) => (days === 0 ? 'Immediate' : `${days} Days`);
  let m = /notice\s*(?:period)?\s*[:\-–=]?\s*(immediate(?:ly)?|nil|none|serving(?:\s*notice)?|(\d{1,3})\s*(days?|weeks?|months?))/i.exec(t);
  if (m) {
    if (m[2]) { const d = unit(m[2], m[3]); if (d != null && d <= 365) return { value: fmt(d), confidence: 'high', evidence: lineAround(t, m.index) }; }
    if (/immediate|nil|none/i.test(m[1])) return { value: 'Immediate', confidence: 'high', evidence: lineAround(t, m.index) };
    return { value: 'Serving notice', confidence: 'medium', evidence: lineAround(t, m.index) };
  }
  m = /(\d{1,3})\s*(days?|weeks?|months?)\s*(?:of\s*)?notice/i.exec(t);
  if (m) { const d = unit(m[1], m[2]); if (d != null && d <= 365) return { value: fmt(d), confidence: 'medium', evidence: lineAround(t, m.index) }; }
  m = /(?:available|can\s*join|ready\s*to\s*join|joining(?:\s*time)?)\s*(?:immediately|within\s*(\d{1,3})\s*(days?|weeks?|months?)|in\s*(\d{1,3})\s*(days?|weeks?|months?)|[:\-–]\s*(\d{1,3})\s*(days?|weeks?|months?)|[:\-–]\s*immediate(?:ly)?)/i.exec(t);
  if (m) {
    const n = m[1] || m[3] || m[5]; const u = m[2] || m[4] || m[6];
    if (n) { const d = unit(n, u); if (d != null && d <= 365) return { value: fmt(d), confidence: 'medium', evidence: lineAround(t, m.index) }; }
    return { value: 'Immediate', confidence: 'medium', evidence: lineAround(t, m.index) };
  }
  return null;
}
function lineAround(text, idx) {
  const s = text.lastIndexOf('\n', idx) + 1;
  let e = text.indexOf('\n', idx);
  if (e < 0) e = text.length;
  return clip(text.slice(s, e));
}

// --- dates ---------------------------------------------------------------------------------------------------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
// "12/03/1995", "12-Mar-1995", "March 12, 1995", "1995-03-12" -> "1995-03-12" (day first for numbers). No age rule here: an implausible
// date of birth must still be READ so that the verify queue can flag it.
function readDate(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2}|\d{4})$/.exec(s);
  if (m) { let y = +m[3]; if (m[3].length === 2) y += y > 30 ? 1900 : 2000; return ok(y, +m[2], +m[1]); }
  m = /^(\d{1,2})[\s-]+([a-z]{3,9})[\s,.-]+(\d{2,4})$/.exec(s);
  if (m && MON[m[2].slice(0, 3)]) { let y = +m[3]; if (m[3].length === 2) y += y > 30 ? 1900 : 2000; return ok(y, MON[m[2].slice(0, 3)], +m[1]); }
  m = /^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MON[m[1].slice(0, 3)]) return ok(+m[3], MON[m[1].slice(0, 3)], +m[2]);
  return null;
  function ok(y, mo, d) {
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
}
const toYm = (y, mo) => (y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12 ? `${y}-${pad(mo)}` : null);

// --- employment: one entry per job ---------------------------------------------------------------------------
const STRONG_COMPANY = /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|hospital|hospitals|bank|industries|enterprises|consultancy|infotech|group|company|co\.|motors|pharma|steels|forge|works|institute|school|college|university|associates|builders|constructions)\b/i;
const COMPANY_WORDS = /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|technologies|technology|solutions|systems|software|services|hospital|hospitals|bank|industries|enterprises|consultancy|consulting|labs|infotech|group|company|co\.|motors|pharma|steels|forge|works|institute|school|college|university|associates|builders|constructions)\b/i;
const TITLE_WORDS = /\b(engineer|developer|manager|executive|analyst|nurse|officer|assistant|associate|consultant|lead|head|director|supervisor|technician|accountant|teacher|lecturer|professor|designer|architect|administrator|coordinator|specialist|intern|trainee|representative|recruiter|operator|programmer|tester|qa|hr|sales|clerk|driver|pharmacist|doctor|surgeon|auditor|trainer)\b/i;
function extractEmployment(text, now = new Date()) {
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
  const part = `(?:${mon}\\s*[',]?\\s*(\\d{4})|(\\d{1,2})[/.-](\\d{4}))`;
  const range = new RegExp(`${part}\\s*(?:-|–|—|to|till|until)\\s*(?:${part}|(present|current|till\\s*date|to\\s*date|now|date|ongoing))`, 'i');
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const jobs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length > 300) continue;
    const m = range.exec(line);
    if (!m) continue;
    const sMonth = m[1] ? MON[m[1].toLowerCase().slice(0, 3)] : Number(m[3]);
    const sYear = Number(m[2] || m[4]);
    const isCurrent = !!m[9];
    const eMonth = isCurrent ? now.getMonth() + 1 : (m[5] ? MON[m[5].toLowerCase().slice(0, 3)] : Number(m[7]));
    const eYear = isCurrent ? now.getFullYear() : Number(m[6] || m[8]);
    const from = toYm(sYear, sMonth);
    const to = isCurrent ? null : toYm(eYear, eMonth);
    if (!from || (!isCurrent && !to)) continue;
    // company / title: what is left on the line, else the line above (and below) it
    const rest = line.replace(range, ' ').replace(/[()|]/g, ' ');
    let bits = splitParts(rest);
    if (bits.length < 2) {
      const prev = lines[i - 1] && !range.test(lines[i - 1]) && lines[i - 1].length < 120 ? lines[i - 1] : '';
      const next = lines[i + 1] && !range.test(lines[i + 1]) && lines[i + 1].length < 120 && !/^[A-Z ]{4,}$/.test(lines[i + 1]) ? lines[i + 1] : '';
      bits = [...bits, ...splitParts(prev)].slice(0, 3);
      if (bits.length < 2 && next) bits = [...bits, ...splitParts(next)].slice(0, 3);
    }
    let company = null; let title = null;
    bits.forEach((b) => {
      const isTitle = TITLE_WORDS.test(b) && !STRONG_COMPANY.test(b);
      if (!company && !isTitle && COMPANY_WORDS.test(b)) company = b;
      else if (!title && isTitle) title = b;
    });
    const left = bits.filter((b) => b !== company && b !== title);
    if (!title && left.length) title = left.shift();
    if (!company && left.length) company = left.shift();
    jobs.push({
      company: company ? clip(company, 120) : null, title: title ? clip(title, 120) : null, fromMonth: from, toMonth: to, isCurrent, line: clip(line),
    });
  }
  // newest first; drop an exact repeat
  const seen = new Set();
  return jobs.filter((j) => { const k = `${j.company}|${j.title}|${j.fromMonth}|${j.toMonth}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
}
function splitParts(s) {
  return String(s || '').split(/\s{2,}|\s[-–—|@]\s|,|\bat\b|\|/i).map((x) => x.replace(/^[\s\-–—:•*]+|[\s\-–—:•*]+$/g, '').trim()).filter((x) => x.length >= 2 && x.length <= 90 && !/^(experience|work history|employment|professional experience)$/i.test(x));
}

// --- education: one entry per degree -------------------------------------------------------------------------
const INSTITUTE_WORDS = /\b(university|college|institute|school|polytechnic|iit|nit|iiit|jntu[a-z]*|osmania|andhra|acharya|vidyalaya|academy|board)\b/i;
function extractEducationEntries(text, degrees) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const out = [];
  const now = new Date().getFullYear();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length > 260) continue;
    const hits = degrees.filter(([, , re]) => re.test(line));
    if (!hits.length) continue;
    // a line that is clearly a job line (a date range with a month) is not education
    if (/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}\s*(?:-|–|—|to)\s*(?:present|current|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i.test(line)) continue;
    const best = [...hits].sort((a, b) => b[1] - a[1])[0];
    const window = [line, lines[i + 1] && lines[i + 1].length < 160 && !degrees.some(([, , re]) => re.test(lines[i + 1])) ? lines[i + 1] : ''].filter(Boolean).join(' | ');
    const years = [...window.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)].map((x) => Number(x[1])).filter((y) => y <= now + 5);
    const year = years.length ? String(years[years.length - 1]) : null;
    const score = (/(\d{1,2}(?:\.\d+)?)\s*%/.exec(window) || [])[1] || (/(?:cgpa|gpa)\s*[:\-]?\s*(\d(?:\.\d+)?)/i.exec(window) || [])[1] || null;
    const spec = (/\(([^)]{2,50})\)/.exec(line) || [])[1] || (/\b(?:in|with|specializ(?:ation|ing)\s*in)\s+([A-Za-z &.]{3,40}?)(?:[,|\-–]|\s{2,}|\s\d{4}|$)/i.exec(line) || [])[1] || null;
    const parts = window.split(/\s{2,}|\s[-–—|]\s|,|\|/).map((x) => x.trim());
    const institute = parts.find((p) => INSTITUTE_WORDS.test(p) && p.length <= 90) || null;
    out.push({
      degree: best[0], rank: best[1], specialisation: spec && !degrees.some(([, , re]) => re.test(spec)) ? clip(spec, 60) : null,
      institute: institute ? clip(institute, 100) : null, year, score: score ? (/\./.test(score) && Number(score) <= 10 ? `${score} CGPA` : `${score}%`) : null, line: clip(line),
    });
  }
  const seen = new Set();
  return out.filter((e) => { const k = `${e.degree}|${e.year}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
}

// --- languages, personal details -----------------------------------------------------------------------------
const LANGS = ['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Gujarati', 'Bengali', 'Punjabi', 'Urdu', 'Odia', 'Oriya', 'Assamese', 'Konkani', 'Sanskrit', 'French', 'German', 'Spanish', 'Japanese', 'Arabic'];
function extractLanguagesKnown(text) {
  const m = /(?:languages?(?:\s*known)?|language\s*proficiency|known\s*languages?)\s*[:\-–]\s*([^\n]{3,160})/i.exec(String(text || ''));
  if (!m) return null;
  const named = LANGS.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(m[1])).map((l) => (l === 'Oriya' ? 'Odia' : l));
  return named.length ? { list: [...new Set(named)], confidence: 'high', evidence: lineAround(text, m.index) } : null;
}
function field(text, labelRe, { max = 160, multiline = false } = {}) {
  const m = new RegExp(`(?:^|\\n|\\|)\\s*(?:${labelRe})\\s*[:\\-–]\\s*([^\\n|]{2,${max}})`, 'i').exec(String(text || ''));
  if (!m) return null;
  let v = m[1].trim();
  if (multiline) {
    const rest = String(text).slice(m.index + m[0].length).split('\n');
    const nextLine = (rest[1] || '').trim();
    if (nextLine && nextLine.length < 80 && /^[A-Za-z0-9 ,.\-/#]+$/.test(nextLine) && !/:/.test(nextLine) && !/^[A-Z ]{4,}$/.test(nextLine) && !/@|\d{10}/.test(nextLine)) v = `${v}, ${nextLine}`;
  }
  return { value: clip(v.replace(/[,;\s]+$/, ''), max), evidence: lineAround(text, m.index + (m[0].startsWith('\n') ? 1 : 0)) };
}
function extractPersonal(text) {
  const out = {};
  const dobAll = [];
  const re = /(?:date\s*of\s*birth|d\.?\s?o\.?\s?b\.?|born(?:\s*on)?|birth\s*date)\s*[:\-–]?\s*([0-9]{1,2}[\s./-][0-9a-z]{1,9}[\s./,-]+[0-9]{2,4}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[a-z]{3,9}\s+[0-9]{1,2},?\s+[0-9]{4})/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(String(text || '')))) {
    const d = readDate(m[1]);
    if (d) dobAll.push({ value: d, evidence: lineAround(text, m.index) });
  }
  if (dobAll.length) {
    const distinct = [...new Set(dobAll.map((d) => d.value))];
    out.dob = {
      value: dobAll[0].value, confidence: distinct.length > 1 ? 'low' : 'high', evidence: dobAll[0].evidence, conflict: distinct.length > 1, values: distinct.length > 1 ? distinct : null, evidences: distinct.length > 1 ? dobAll.map((d) => d.evidence) : null,
    };
  }
  const addr = field(text, 'permanent\\s*address|present\\s*address|current\\s*address|residential\\s*address|correspondence\\s*address|address', { max: 220, multiline: true });
  if (addr) out.address = { ...addr, confidence: 'high' };
  const native = field(text, 'native\\s*(?:place|town|village|district|city)?|hometown|home\\s*town|place\\s*of\\s*birth', { max: 80 });
  if (native) out.nativePlace = { ...native, confidence: 'high' };
  else {
    const n2 = /native\s+of\s+([A-Z][A-Za-z ]{2,40})/.exec(String(text || ''));
    if (n2) out.nativePlace = { value: clip(n2[1], 60), evidence: lineAround(text, n2.index), confidence: 'medium' };
  }
  const ms = /marital\s*status\s*[:\-–]\s*(single|unmarried|married|divorced|widow(?:ed)?|separated)/i.exec(String(text || ''));
  if (ms) out.maritalStatus = { value: ms[1][0].toUpperCase() + ms[1].slice(1).toLowerCase(), evidence: lineAround(text, ms.index), confidence: 'high' };
  const fa = field(text, 'father\'?s?\\s*name|name\\s*of\\s*(?:the\\s*)?father|father|s/o|son\\s*of|d/o|daughter\\s*of', { max: 60 });
  if (fa && /^[A-Za-z][A-Za-z .']{2,}$/.test(fa.value)) out.fatherName = { ...fa, confidence: 'high' };
  const ge = /\b(?:gender|sex)\s*[:\-–]\s*(male|female|other|m|f)\b/i.exec(String(text || ''));
  if (ge) { const g = ge[1].toLowerCase(); out.gender = { value: g[0] === 'f' ? 'Female' : g[0] === 'm' ? 'Male' : 'Other', evidence: lineAround(text, ge.index), confidence: 'high' }; }
  return out;
}

// --- skills by category (a small rules table; the first matching rule wins, a skill nobody listed is "domain") -----------
const SKILL_RULES = [
  ['language', ['java', 'javascript', 'typescript', 'python', 'c', 'c++', 'c#', 'php', 'ruby', 'go', 'golang', 'kotlin', 'swift', 'scala', 'r', 'sql', 'html', 'css', 'bash', 'perl', 'dart', 'rust', 'matlab']],
  ['framework', ['react', 'react.js', 'angular', 'vue', 'node.js', 'nodejs', 'express', 'spring', 'spring boot', 'django', 'flask', 'laravel', 'hibernate', '.net', 'asp.net', 'flutter', 'react native', 'android', 'ios', 'bootstrap', 'jquery', 'next.js', 'fastapi', 'struts']],
  ['database', ['mysql', 'postgresql', 'postgres', 'oracle', 'mongodb', 'redis', 'sql server', 'sqlite', 'mariadb', 'cassandra', 'dynamodb', 'db2', 'elasticsearch']],
  ['cloud', ['aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'devops', 'ci/cd', 'linux', 'ec2', 's3']],
  ['tool', ['git', 'jira', 'excel', 'tableau', 'power bi', 'figma', 'photoshop', 'autocad', 'solidworks', 'catia', 'selenium', 'tally', 'sap', 'salesforce', 'plc', 'scada', 'postman', 'ms office', 'word', 'powerpoint', 'cnc', 'erp', 'ansys', 'creo']],
  ['soft', ['communication', 'leadership', 'teamwork', 'team work', 'time management', 'problem solving', 'negotiation', 'adaptability', 'critical thinking', 'presentation', 'interpersonal', 'customer service']],
];
const SKILL_CATEGORY = new Map();
SKILL_RULES.forEach(([cat, list]) => list.forEach((s) => { if (!SKILL_CATEGORY.has(s)) SKILL_CATEGORY.set(s, cat); }));
const CATEGORIES = [...SKILL_RULES.map((r) => r[0]), 'domain'];
const CATEGORY_LABEL = {
  language: 'Languages', framework: 'Frameworks', database: 'Databases', cloud: 'Cloud and DevOps', tool: 'Tools', domain: 'Domain knowledge', soft: 'Soft skills',
};
function categoryOfSkill(skill) { return SKILL_CATEGORY.get(String(skill || '').trim().toLowerCase()) || 'domain'; }
function classifySkills(skills) {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  const map = {};
  [...new Set((skills || []).map((s) => String(s).trim()).filter(Boolean))].forEach((s) => { const c = categoryOfSkill(s); byCategory[c].push(s); map[s] = c; });
  return { byCategory, map };
}

// --- put it together -----------------------------------------------------------------------------------------
const firstLineWith = (text, needle) => {
  if (!needle) return null;
  const n = String(needle).toLowerCase();
  const line = String(text || '').split('\n').find((l) => l.toLowerCase().includes(n));
  return line ? clip(line) : null;
};
function enrich(text, parsed, { DEGREES = [] } = {}) {
  const t = String(text || '');
  const confidence = {}; const evidence = {}; const conflicts = [];
  const set = (k, conf, ev) => { if (conf) confidence[k] = conf; if (ev) evidence[k] = ev; };

  // existing fields: confidence from how they were read
  const labelledName = /^\s*(?:name|full\s*name|candidate\s*name|పేరు|नाम)\s*[:\-–]/im.test(t);
  if (parsed.name) {
    const indic = /[ఀ-౿ऀ-ॿ]/.test(parsed.name);
    set('name', labelledName ? 'high' : (indic ? 'low' : 'medium'), firstLineWith(t, parsed.name));
  }
  if (parsed.emails && parsed.emails.length) {
    set('email', parsed.emails.length === 1 ? 'high' : 'medium', firstLineWith(t, parsed.emails[0]));
    if (parsed.emails.length > 1) conflicts.push({ field: 'email', values: parsed.emails.slice(0, 3), evidences: parsed.emails.slice(0, 3).map((e) => firstLineWith(t, e)) });
  }
  if (parsed.phones && parsed.phones.length) {
    set('phone', parsed.phones.length === 1 ? 'high' : 'medium', firstLineWith(t, String(parsed.phones[0]).replace(/\D/g, '').slice(-10).replace(/^(\d{5})(\d{5})$/, '$1')));
  }
  if (parsed.totalExperienceYears != null) {
    const labelled = /(?:total\s+)?experience\s*[:\-–]\s*\d/i.test(t);
    const conf = parsed.experienceSource === 'stated' ? (labelled ? 'high' : 'medium') : 'medium';
    set('experience', conf, firstLineWith(t, 'experience') || firstLineWith(t, 'years'));
  }
  if (parsed.highestEducation) set('education', (parsed.education || []).length > 1 ? 'high' : 'medium', firstLineWith(t, parsed.highestEducation.replace(/\./g, '')) || null);
  if (parsed.location) {
    const labelled = /^\s*(?:current\s+location|present\s+location|location|city|address|residence|current\s+address|present\s+address)\s*[:\-–]/im.test(t);
    set('location', labelled ? 'high' : 'medium', firstLineWith(t, parsed.location));
  }
  set('skills', (parsed.skills || []).length >= 3 ? 'medium' : ((parsed.skills || []).length ? 'low' : 'low'), null);
  if (/skills?\s*[:\-–]/i.test(t) && (parsed.skills || []).length >= 3) confidence.skills = 'high';

  // new fields
  const sal = extractSalaries(t);
  if (sal.current) {
    parsed.currentSalary = sal.current.value; set('currentSalary', sal.current.confidence, sal.current.evidence);
    if (sal.current.conflict) conflicts.push({ field: 'currentSalary', values: sal.current.values, evidences: sal.current.evidences });
  }
  if (sal.expected) {
    parsed.expectedSalary = sal.expected.value; set('expectedSalary', sal.expected.confidence, sal.expected.evidence);
    if (sal.expected.conflict) conflicts.push({ field: 'expectedSalary', values: sal.expected.values, evidences: sal.expected.evidences });
  }
  const notice = extractNotice(t);
  if (notice) { parsed.noticePeriod = notice.value; set('noticePeriod', notice.confidence, notice.evidence); }
  const personal = extractPersonal(t);
  Object.entries(personal).forEach(([k, v]) => {
    parsed[k] = v.value; set(k, v.confidence, v.evidence);
    if (v.conflict) conflicts.push({ field: k, values: v.values, evidences: v.evidences });
  });
  const langs = extractLanguagesKnown(t);
  if (langs) { parsed.languagesKnown = langs.list; set('languagesKnown', langs.confidence, langs.evidence); }
  parsed.employment = extractEmployment(t);
  if (parsed.employment.length) set('employment', parsed.employment.every((j) => j.company && j.title) ? 'medium' : 'low', parsed.employment[0].line);
  parsed.educationEntries = extractEducationEntries(t, DEGREES);
  if (parsed.educationEntries.length) set('educationEntries', parsed.educationEntries.every((e) => e.year && e.institute) ? 'medium' : 'low', parsed.educationEntries[0].line);
  const cls = classifySkills(parsed.skills || []);
  parsed.skillCategories = cls.byCategory;

  parsed.confidence = confidence;
  parsed.evidence = evidence;
  parsed.conflicts = conflicts;
  return parsed;
}

module.exports = {
  enrich, extractSalaries, extractNotice, extractEmployment, extractEducationEntries, extractLanguagesKnown, extractPersonal, classifySkills, categoryOfSkill,
  rtfToText, isRtf, salaryOf, readDate, lineAround, CATEGORIES, CATEGORY_LABEL, LEVEL, lower, firstLineWith, clip, escapeRe, LANGS,
};
