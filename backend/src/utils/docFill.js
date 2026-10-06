// ---------------------------------------------------------------------------
// FILL FROM A FILE (docfill_, 2026-10-06) — the one engine behind
// "Upload the requirement" (Add job), "Upload the resume" (Add candidate) and
// "Upload client details" (Add client).
//
//   fill({ target, file, text, user })  -> { fields, found, missing, sources,
//                                            confidence, engine, fileName,
//                                            textChars, warnings, needsAi }
//
// Three steps, in order:
//   1. TEXT   PDF / DOCX / DOC through resumeParse.extractText (the resume
//             parser's own extractor); TXT as it is; pasted text as it is;
//             a PICTURE (JPG / PNG) only through the AI engine — and only
//             Claude can read pictures. Without it the answer says so.
//   2. RULES  labels ("Position:", "CTC", "Experience", "Location", "GSTIN"),
//             the GSTIN / PAN / TAN / IFSC checks of utils/gstin.js, phone /
//             e-mail / website regexes, the known Indian cities of
//             utils/locationMatch.js, and the resume parser's own skill /
//             degree / experience readers. Always runs.
//   3. AI     only when BOTH the switch (RESUME_AI_EXTRACT=1, the same switch
//             the resume parser uses) AND the Role Catalog gate ("Answers
//             from ATS Data" for this login) allow it, and the provider in
//             utils/ai.js answers. It is asked for strict JSON and ONLY FILLS
//             GAPS the rules left: a rule value is never overwritten.
//
// NOTHING IS INVENTED. Every value comes from the document, and each field
// records where it came from ("rule" / "ai"). Missing = required and not
// found; the person fills it by hand.
//
// Files: 10 MB cap, allow-list by BYTES (PDF / DOCX / DOC / TXT / JPG / PNG),
// kept privately in <UPLOAD_DIR>/source-docs with a random name (never the
// client's filename, never served statically).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const attachments = require('./attachments');
const resumeParse = require('./resumeParse');
const { sniffKind } = require('./resumeStore');
const { citiesOf, CITY_ALIASES } = require('./locationMatch');
const gstin = require('./gstin');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 60000;

const KINDS = {
  pdf: { mime: 'application/pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { mime: 'application/msword' },
  txt: { mime: 'text/plain' },
  jpg: { mime: 'image/jpeg' },
  png: { mime: 'image/png' },
};
const EXT_ALIAS = { jpeg: 'jpg', text: 'txt' };
const STORED_NAME = /^[a-f0-9]{32}\.(pdf|docx|doc|txt|jpg|png)$/;

const MESSAGE = {
  NO_FILE: 'Choose a file, or paste the text.',
  TOO_LARGE: `That file is larger than ${MAX_BYTES / (1024 * 1024)} MB. Please upload a smaller one.`,
  BAD_TYPE: 'Only PDF, Word (DOCX / DOC), TXT, JPG or PNG files can be read.',
  CONTENT_MISMATCH: "That file's contents do not match its type (it is not a real PDF / Word / text / picture file).",
  NOT_MULTIPART: 'Upload the file as a multipart/form-data request, or send { text }.',
  NO_TEXT: 'No text was found in this file. If it is a scanned picture, paste the text instead.',
  NEEDS_AI: 'This is a picture. Reading text from a picture needs the AI engine (Claude), which is not switched on here. Paste the text instead, or upload the PDF / Word file.',
};

const TARGETS = ['job', 'candidate', 'client'];

// --- file checks + private storage ------------------------------------------
function sniffAny(buf, filename) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const k = sniffKind(buf);
  if (k) return k;
  // Plain text: a .txt name and no binary bytes in the first 4 KB.
  const ext = (String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1];
  if ((EXT_ALIAS[ext] || ext) === 'txt') {
    const head = buf.slice(0, 4096);
    for (let i = 0; i < head.length; i += 1) {
      const c = head[i];
      if (c === 0 || (c < 7 && c !== 0) || (c > 13 && c < 32 && c !== 27)) return null;
    }
    return 'txt';
  }
  return null;
}

function validateFile(file) {
  const err = (code) => Object.assign(new Error(code), { code });
  if (!file || !file.data || !file.data.length) throw err('NO_FILE');
  if (file.data.length > MAX_BYTES) throw err('TOO_LARGE');
  let ext = (String(file.filename || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1];
  ext = EXT_ALIAS[ext] || ext;
  if (!ext || !KINDS[ext]) throw err('BAD_TYPE');
  const sniffed = sniffAny(file.data, file.filename);
  const word = (k) => k === 'doc' || k === 'docx';
  if (!sniffed || (sniffed !== ext && !(word(sniffed) && word(ext)))) throw err('CONTENT_MISMATCH');
  return { kind: sniffed, ext: sniffed, mime: KINDS[sniffed].mime };
}

function sourceDir() {
  const dir = path.join(attachments.uploadDir(), 'source-docs');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}
function storeSource(file) {
  const { ext, mime } = validateFile(file);
  const stored = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(sourceDir(), stored), file.data, { mode: 0o600, flag: 'wx' });
  return {
    stored, fileName: attachments.safeDisplayName(file.filename), mime, size: file.data.length,
    sha256: crypto.createHash('sha256').update(file.data).digest('hex'),
  };
}
function resolveSource(storedName) {
  if (!storedName || !STORED_NAME.test(storedName)) return null;
  const dir = sourceDir();
  const full = path.resolve(dir, storedName);
  if (path.dirname(full) !== dir) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}
const parseUpload = (req) => attachments.parseMultipart(req, { maxBytes: MAX_BYTES });

// --- the AI switch + gate (same rule as resume parsing) ---------------------
async function aiAllowedFor(user) {
  if (!resumeParse.aiEnabled()) return { ok: false, why: 'AI reading is switched off (RESUME_AI_EXTRACT).' };
  try {
    const sb = require('./sandbox'); // eslint-disable-line global-require
    if (sb.isSandbox() && !sb.allowAi()) return { ok: false, why: sb.aiRefusal() };
  } catch { /* no sandbox helper */ }
  try {
    const access = await require('./aiAccess').aiAccessFor(user); // eslint-disable-line global-require
    if (!(access && access.ask && access.data && access.data.ats)) return { ok: false, why: 'Your role has no AI access for ATS data (Role Catalog).' };
  } catch { return { ok: false, why: 'The AI gate could not be read.' }; }
  return { ok: true, why: null };
}

// --- step 1: text ------------------------------------------------------------
const clean = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);

async function imageText(file, kind, user) {
  const allowed = await aiAllowedFor(user);
  if (!allowed.ok) return { text: '', needsAi: true, why: allowed.why };
  const ai = require('./ai'); // eslint-disable-line global-require
  if (ai.provider() !== 'claude') return { text: '', needsAi: true, why: 'The local Ollama model cannot read pictures; only Claude can.' };
  try {
    const { agentConfig, clientFor } = require('./aiAgent'); // eslint-disable-line global-require
    const cfg = await agentConfig();
    if (!cfg.configured) return { text: '', needsAi: true, why: 'Claude is not configured (Administration → Integrations → AI Assistant).' };
    let data = file.data;
    let mime = KINDS[kind].mime;
    if (data.length > 4 * 1024 * 1024) {
      const sharp = require('sharp'); // eslint-disable-line global-require
      data = await sharp(data).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      mime = 'image/jpeg';
    }
    const response = await clientFor(cfg.apiKey).messages.create({
      model: cfg.model,
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } },
          { type: 'text', text: 'Transcribe every piece of text in this image exactly as written, keeping the line breaks. Output only the transcribed text, nothing else.' },
        ],
      }],
    });
    const text = ((response && response.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { text: clean(text), needsAi: false, ocr: true };
  } catch (err) {
    return { text: '', needsAi: true, why: `The AI engine could not read the picture (${String(err && err.message || err).slice(0, 80)}).` };
  }
}

async function textOf({ file, text, user }) {
  if (text && String(text).trim()) return { text: clean(text), kind: 'text', fileName: null };
  const { kind } = validateFile(file);
  const fileName = attachments.safeDisplayName(file.filename);
  if (kind === 'txt') return { text: clean(file.data.toString('utf8')), kind, fileName };
  if (kind === 'jpg' || kind === 'png') {
    const r = await imageText(file, kind, user);
    return { text: r.text, kind, fileName, needsAi: r.needsAi, why: r.why, ocr: !!r.ocr };
  }
  const r = await resumeParse.extractText(file.data, kind);
  return { text: clean(r.text), kind, fileName, extractError: r.error };
}

// --- small readers ------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s)]*)?/gi;
const DOMAIN_RE = /\b[A-Za-z0-9-]+\.(?:com|in|co\.in|net|org|io|ai|tech|biz|info)\b/gi;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const TAN_RE = /\b[A-Z]{4}\d{5}[A-Z]\b/g;
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const PIN_RE = /\b[1-9]\d{5}\b/g;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const linesOf = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const trimVal = (v) => String(v || '').replace(/^[\s:\-–—|]+|[\s|;,]+$/g, '').trim();

// "Label: value" / "Label - value" / "Label value" on one line (first hit).
// `labels` are tried in order; a label must start the line.
function labelled(text, labels, { maxLen = 200 } = {}) {
  const lines = linesOf(text);
  for (const label of labels) {
    const re = new RegExp(`^\\s*(?:\\*|•|-|–)?\\s*${esc(label)}\\s*(?:\\*|\\(s\\))?\\s*[:\\-–—|]\\s*(.+)$`, 'i');
    for (const line of lines) {
      const m = re.exec(line);
      if (m) {
        const v = trimVal(m[1]);
        if (v && v.length <= maxLen) return v;
      }
    }
  }
  return null;
}

// The text under a heading ("Job Description", "Responsibilities") up to the
// next heading-looking line.
const HEADING_WORDS = ['job description', 'description', 'about the role', 'about the job', 'role overview', 'overview', 'summary',
  'responsibilities', 'key responsibilities', 'roles and responsibilities', 'roles & responsibilities', 'duties', 'what you will do',
  'requirements', 'qualifications', 'qualification', 'eligibility', 'education', 'skills', 'required skills', 'must have skills', 'must-have skills',
  'key skills', 'good to have', 'nice to have', 'preferred skills', 'benefits', 'about us', 'about the company', 'company profile',
  'compensation', 'salary', 'ctc', 'location', 'experience', 'notice period', 'how to apply', 'contact', 'terms', 'payment terms'];
const isHeading = (line) => {
  const l = line.replace(/[:*#\-–—]+$/g, '').trim().toLowerCase();
  return l.length <= 48 && HEADING_WORDS.some((h) => l === h || l === `${h}s` || l.startsWith(`${h} `) && l.length <= h.length + 12);
};
function section(text, names, { maxChars = 4000 } = {}) {
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i].replace(/[:*#\-–—]+$/g, '').trim().toLowerCase();
    if (names.some((n) => l === n || l === `${n}:`)) {
      const out = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isHeading(lines[j])) break;
        out.push(lines[j]);
        if (out.join('\n').length > maxChars) break;
      }
      const v = out.join('\n').trim();
      if (v) return v.slice(0, maxChars);
    }
  }
  return null;
}

const KNOWN_CITY_KEYS = new Set(Object.keys(CITY_ALIASES).map((c) => c.toLowerCase().replace(/[^a-z]/g, '')));
function cityIn(s) {
  if (!s) return null;
  const known = citiesOf(s).find((c) => KNOWN_CITY_KEYS.has(c.key));
  return known ? known.label : null;
}
const INDIAN_STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Chandigarh',
  'Puducherry', 'Jammu and Kashmir', 'Ladakh'];
function stateIn(s) {
  if (!s) return null;
  const l = String(s).toLowerCase();
  return INDIAN_STATES.find((st) => l.includes(st.toLowerCase())) || null;
}
const firstPhone = (s) => (resumeParse.parsePhones(String(s || ''))[0] || null);
const firstEmail = (s) => ((String(s || '').match(EMAIL_RE) || [])[0] || null);
const splitSkills = (v) => [...new Set(String(v || '').split(/[,;|•\n/]|\band\b/i).map((s) => s.trim().replace(/\.$/, '')).filter((s) => s && s.length <= 40))];

// "3-5 years", "3 to 5 yrs", "5+ years", "min 3 years", "3 yrs" -> [min, max]
function expRange(v) {
  if (!v) return [null, null];
  const s = String(v).toLowerCase();
  const m = /(\d{1,2}(?:\.\d)?)\s*(?:-|–|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)?/.exec(s);
  if (m) return [Number(m[1]), Number(m[2])];
  const p = /(\d{1,2}(?:\.\d)?)\s*\+\s*(?:years?|yrs?)?/.exec(s);
  if (p) return [Number(p[1]), null];
  const one = /(?:min(?:imum)?\.?\s*)?(\d{1,2}(?:\.\d)?)\s*(?:years?|yrs?)/.exec(s);
  if (one) return [Number(one[1]), null];
  return [null, null];
}
// "8-12 LPA", "₹8,00,000 - 12,00,000", "up to 10 lakhs", "12 LPA", "1.2 cr" -> lakh [min, max]
function lakh(n, unit) {
  const v = Number(String(n).replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  if (/cr/i.test(unit || '')) return v * 100;
  if (/l|lac|lakh|lpa/i.test(unit || '')) return v;
  if (/k/i.test(unit || '')) return v / 100;
  if (v >= 10000) return Math.round((v / 100000) * 100) / 100; // rupees
  return v; // a bare "8-12" is read as lakh
}
function salaryRange(v) {
  if (!v) return [null, null];
  const s = String(v).replace(/₹|rs\.?|inr/gi, ' ');
  const num = '(\\d{1,3}(?:,\\d{2,3})*(?:\\.\\d+)?)\\s*(lpa|lakhs?|lacs?|l|cr|crores?|k)?';
  const range = new RegExp(`${num}\\s*(?:-|–|to)\\s*${num}`, 'i').exec(s);
  if (range) return [lakh(range[1], range[2] || range[4]), lakh(range[3], range[4])];
  const upto = new RegExp(`(?:up\\s*to|upto|max(?:imum)?\\.?)\\s*${num}`, 'i').exec(s);
  if (upto) return [null, lakh(upto[1], upto[2])];
  const one = new RegExp(num, 'i').exec(s);
  if (one && (one[2] || Number(String(one[1]).replace(/,/g, '')) >= 10000)) return [lakh(one[1], one[2]), null];
  return [null, null];
}
function noticeOf(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (/immediate|immediately|\b0\s*days?\b|\bnil\b|\bnone\b/.test(s)) return 'Immediate';
  const m = /(\d{1,3})\s*(days?|weeks?|months?)/.exec(s);
  if (!m) return null;
  let days = Number(m[1]);
  if (/week/.test(m[2])) days *= 7;
  if (/month/.test(m[2])) days *= 30;
  if (days <= 7) return '7 Days';
  if (days <= 15) return '15 Days';
  if (days <= 30) return '30 Days';
  if (days <= 60) return '60 Days';
  return '90 Days';
}
function workModeOf(text) {
  const s = String(text).toLowerCase();
  if (/\b(remote|work from home|wfh)\b/.test(s)) return 'Remote';
  if (/\bhybrid\b/.test(s)) return 'Hybrid';
  if (/\b(work from office|wfo|on-?site|in[- ]office)\b/.test(s)) return 'Work From Office';
  return null;
}
function employmentTypeOf(text) {
  const s = String(text).toLowerCase();
  if (/\binternship\b|\bintern\b/.test(s)) return 'Internship';
  if (/\bpart[- ]time\b/.test(s)) return 'Part Time';
  if (/\bcontract(ual)?\b/.test(s) && !/\bfull[- ]time\b/.test(s)) return 'Contract';
  if (/\bfull[- ]time\b|\bpermanent\b/.test(s)) return 'Full Time';
  return null;
}
const DEPT_WORDS = [
  ['Medical', /\b(nurse|nursing|doctor|physician|hospital|clinical|pharma|pharmacist|medical|icu|surgeon|mbbs|lab technician|radiolog|dental)\b/i],
  ['Manufacturing', /\b(production|cnc|plant|shop floor|machinist|welder|fitter|manufacturing|assembly line|quality inspector|maintenance engineer|plc)\b/i],
  ['Education', /\b(teacher|faculty|lecturer|professor|school|college|tutor|academic|principal)\b/i],
  ['Accounts', /\b(accountant|accounts|tally|bookkeep|audit|taxation|gst filing|payable|receivable)\b/i],
  ['HR', /\b(hr executive|hr manager|human resources|recruiter|talent acquisition|payroll executive)\b/i],
  ['R&D', /\b(research|r&d|scientist)\b/i],
  ['IT', /\b(developer|software|engineer|java|python|react|node|devops|cloud|aws|azure|data analyst|qa|tester|sql|full stack|frontend|backend|programmer|it support)\b/i],
];
function departmentOf(text, title) {
  const head = `${title || ''}\n${String(text).slice(0, 1500)}`;
  for (const [dept, re] of DEPT_WORDS) if (re.test(head)) return dept;
  return null;
}
const INDUSTRY_WORDS = [
  ['Healthcare', /\b(hospital|clinic|pharma|healthcare|medical|diagnostic)\b/i],
  ['Manufacturing', /\b(manufactur|factory|plant|industries|industrial|engineering works)\b/i],
  ['Education', /\b(school|college|university|edtech|education|academy|institute)\b/i],
  ['Finance', /\b(bank|finance|financial|nbfc|insurance|fintech|capital)\b/i],
  ['Retail', /\b(retail|store|supermarket|e-?commerce|fmcg)\b/i],
  ['Logistics', /\b(logistic|transport|shipping|warehouse|courier|supply chain)\b/i],
  ['IT', /\b(software|technolog|it services|infotech|solutions|digital|systems|labs|tech)\b/i],
];
function industryOf(text) {
  for (const [ind, re] of INDUSTRY_WORDS) if (re.test(text)) return ind;
  return null;
}
function companyTypeOf(text) {
  const s = String(text).toLowerCase();
  if (/\b(mnc|multinational|global|fortune 500)\b/.test(s)) return 'MNC';
  if (/\bstart-?up\b/.test(s)) return 'Startup';
  if (/\b(consultancy|consulting|consultants)\b/.test(s)) return 'Consultancy';
  if (/\b(sme|msme|small and medium)\b/.test(s)) return 'SME';
  if (/\b(pvt\.?\s*ltd|private limited|limited|ltd\.?|corporation|corp\.?|inc\.?|llp)\b/.test(s)) return 'Corporate';
  return null;
}
const JOB_TITLE_WORDS = /\b(developer|engineer|manager|executive|analyst|lead|architect|nurse|doctor|physician|technician|consultant|specialist|associate|officer|accountant|teacher|faculty|designer|administrator|coordinator|supervisor|operator|intern|trainee|head|director|scientist|assistant|representative|sales|marketing|recruiter|tester|programmer|machinist|welder|fitter)\b/i;
function titleGuess(text) {
  const lines = linesOf(text).slice(0, 12);
  // A short heading line: "Senior Java Developer", "Hiring: Staff Nurse".
  for (const line of lines) {
    const l = line.replace(/^(job title|position|role|opening|hiring for|we are hiring|urgent hiring|requirement)\s*[:\-–]?\s*/i, '').trim();
    if (l.length >= 4 && l.length <= 60 && JOB_TITLE_WORDS.test(l) && !/@|http|\d{6,}/.test(l) && !/\b(we|our|you|is|are|have|has|for|at)\b/i.test(l)) return l.replace(/[.:]+$/, '');
  }
  // Inside a sentence: "an urgent opening for a Staff Nurse (ICU) at our…".
  const m = /(?:hiring|looking|opening|openings|vacancy|position|requirement|need)\s+(?:for|of)?\s*(?:an?\s+|the\s+)?((?:[A-Z][\w+#./&-]*|of|and|&)(?:\s+(?:[A-Z][\w+#./&-]*|of|and|&|\([A-Za-z ]+\))){0,5})/.exec(text);
  if (m && JOB_TITLE_WORDS.test(m[1])) return m[1].replace(/[.,:]+$/, '').trim();
  const t = /(?:hiring|looking|opening|position|requirement)\s+(?:for|of)?\s*(?:an?\s+)?([A-Za-z+#./ ]{3,60}?(?:developer|engineer|manager|executive|analyst|lead|nurse|doctor|technician|consultant|specialist|accountant|teacher|designer|tester))\b/i.exec(text);
  return t ? t[1].trim() : null;
}

// --- step 2: rules per target ----------------------------------------------------
const put = (out, src, key, value, how = 'rule') => {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' && !value.trim()) return;
  if (Array.isArray(value) && !value.length) return;
  if (out[key] !== undefined && out[key] !== null && out[key] !== '') return;
  out[key] = value;
  src[key] = how;
};

async function rulesJob(text) {
  const f = {}; const src = {};
  put(f, src, 'title', labelled(text, ['job title', 'position', 'role', 'designation', 'title', 'opening', 'requirement', 'hiring for', 'post']) || titleGuess(text));
  put(f, src, 'clientName', labelled(text, ['client', 'client name', 'company', 'company name', 'organisation', 'organization', 'employer', 'hiring company']));
  put(f, src, 'department', (() => { const d = labelled(text, ['department', 'dept', 'function', 'vertical']); return d && ['IT', 'Medical', 'Manufacturing', 'Education', 'BDE', 'HR', 'Accounts', 'R&D'].find((x) => d.toLowerCase().includes(x.toLowerCase())); })() || departmentOf(text, f.title));
  put(f, src, 'specialisation', labelled(text, ['specialisation', 'specialization', 'speciality', 'specialty', 'domain']));
  put(f, src, 'location', cityIn(labelled(text, ['work location', 'job location', 'location', 'city', 'base location', 'posting location', 'place of work'])) || cityIn(String(text).slice(0, 6000)));
  put(f, src, 'workMode', workModeOf(labelled(text, ['work mode', 'mode', 'work type', 'working mode']) || text));
  const exp = labelled(text, ['total experience', 'experience', 'exp', 'years of experience', 'experience required', 'required experience', 'work experience']);
  const [emin, emax] = expRange(exp || (/(\d{1,2}(?:\.\d)?\s*(?:-|–|to)\s*\d{1,2}(?:\.\d)?|\d{1,2}\s*\+)\s*(?:years?|yrs?)/i.exec(text) || [])[0]);
  put(f, src, 'expMin', emin); put(f, src, 'expMax', emax);
  const sal = labelled(text, ['ctc', 'salary', 'package', 'budget', 'compensation', 'salary range', 'ctc range', 'pay', 'salary budget', 'offered ctc', 'annual ctc']);
  const [smin, smax] = salaryRange(sal || (/(?:ctc|salary|package|lpa)[^.\n]{0,40}/i.exec(text) || [])[0]);
  put(f, src, 'salaryMin', smin); put(f, src, 'salaryMax', smax);
  const open = labelled(text, ['no. of openings', 'no of openings', 'number of openings', 'openings', 'positions', 'no. of positions', 'no of positions', 'vacancies', 'headcount', 'no. of vacancies', 'number of positions']);
  const openN = open ? Number((open.match(/\d{1,3}/) || [])[0]) : Number((/(\d{1,3})\s*(?:openings|positions|vacancies)/i.exec(text) || [])[1]);
  put(f, src, 'openings', openN >= 1 && openN <= 999 ? openN : null);
  const must = labelled(text, ['must have skills', 'must-have skills', 'mandatory skills', 'required skills', 'key skills', 'skills required', 'skill set', 'skills', 'technical skills', 'core skills', 'primary skills'], { maxLen: 600 })
    || section(text, ['must have skills', 'must-have skills', 'mandatory skills', 'required skills', 'key skills', 'skills', 'skills required', 'technical skills'], { maxChars: 600 });
  const good = labelled(text, ['good to have', 'good-to-have', 'good to have skills', 'nice to have', 'nice-to-have', 'preferred skills', 'desirable skills', 'secondary skills', 'optional skills'], { maxLen: 600 })
    || section(text, ['good to have', 'good to have skills', 'nice to have', 'preferred skills', 'desirable skills'], { maxChars: 600 });
  const parsed = await resumeParse.parseResumeText(text);
  put(f, src, 'skills', must ? splitSkills(must).join(', ') : (parsed.skills || []).slice(0, 12).join(', '));
  put(f, src, 'goodToHaveSkills', good ? splitSkills(good).join(', ') : null);
  put(f, src, 'education', labelled(text, ['education', 'qualification', 'qualifications', 'degree', 'educational qualification', 'minimum qualification']) || parsed.highestEducation);
  put(f, src, 'noticePeriodMax', noticeOf(labelled(text, ['notice period', 'notice', 'joining time', 'max notice period', 'maximum notice period']) || (/notice period[^.\n]{0,40}/i.exec(text) || [])[0]));
  put(f, src, 'employmentType', employmentTypeOf(labelled(text, ['employment type', 'job type', 'type of employment', 'engagement']) || text));
  put(f, src, 'jobDescription', section(text, ['job description', 'description', 'about the role', 'about the job', 'role overview', 'overview', 'role summary', 'job summary', 'summary']) || labelled(text, ['job description', 'description'], { maxLen: 4000 }));
  put(f, src, 'responsibilities', section(text, ['responsibilities', 'key responsibilities', 'roles and responsibilities', 'roles & responsibilities', 'duties', 'what you will do']));
  put(f, src, 'qualifications', section(text, ['qualifications', 'qualification', 'requirements', 'eligibility', 'candidate requirements', 'who you are']));
  // No section headings at all: the whole text is the description.
  if (!f.jobDescription && text.length >= 60) put(f, src, 'jobDescription', text.slice(0, 4000));
  return { fields: f, sources: src };
}

async function rulesCandidate(text) {
  const f = {}; const src = {};
  const parsed = await resumeParse.parseResumeText(text);
  const name = labelled(text, ['name', 'candidate name', 'full name']) || parsed.name;
  if (name) {
    const parts = name.replace(/^(mr|ms|mrs|dr)\.?\s+/i, '').trim().split(/\s+/);
    put(f, src, 'firstName', parts[0]);
    put(f, src, 'lastName', parts.slice(1).join(' ') || null);
  }
  put(f, src, 'email', (parsed.emails || [])[0]);
  put(f, src, 'phone', (parsed.phones || [])[0]);
  put(f, src, 'location', parsed.location);
  put(f, src, 'experienceYears', parsed.totalExperienceYears);
  put(f, src, 'education', parsed.highestEducation);
  put(f, src, 'skills', (parsed.skills || []).slice(0, 20).join(', '));
  put(f, src, 'currentCompany', labelled(text, ['current company', 'current employer', 'company', 'organisation', 'organization', 'employer', 'working at', 'present company']));
  put(f, src, 'currentDesignation', labelled(text, ['current designation', 'designation', 'current role', 'current position', 'position', 'role', 'job title']));
  put(f, src, 'noticePeriod', (() => { const n = noticeOf(labelled(text, ['notice period', 'notice', 'np']) || (/notice period[^.\n]{0,40}/i.exec(text) || [])[0]); return n === '7 Days' ? '15 Days' : n; })());
  const cur = salaryRange(labelled(text, ['current ctc', 'current salary', 'present ctc', 'ctc', 'current package']));
  const expd = salaryRange(labelled(text, ['expected ctc', 'expected salary', 'expected package', 'ectc']));
  put(f, src, 'currentSalary', cur[0] != null ? `${cur[0]}L` : null);
  put(f, src, 'expectedSalary', expd[0] != null ? `${expd[0]}L` : null);
  put(f, src, 'specialization', labelled(text, ['specialization', 'specialisation', 'branch', 'stream', 'discipline']));
  put(f, src, 'institute', labelled(text, ['institute', 'college', 'university', 'institution']));
  const py = labelled(text, ['passing year', 'year of passing', 'passed out', 'graduation year', 'batch']);
  put(f, src, 'passingYear', py ? (py.match(/(19|20)\d{2}/) || [])[0] : null);
  put(f, src, 'dob', (() => { const d = labelled(text, ['date of birth', 'dob', 'd.o.b', 'birth date']); const m = d && /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(d); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : (d && /(\d{4})-(\d{2})-(\d{2})/.exec(d) ? d.match(/\d{4}-\d{2}-\d{2}/)[0] : null); })());
  put(f, src, 'gender', (() => { const g = labelled(text, ['gender', 'sex']); if (!g) return null; return /^f/i.test(g) ? 'Female' : /^m/i.test(g) ? 'Male' : null; })());
  return { fields: f, sources: src };
}

function rulesClient(text) {
  const f = {}; const src = {};
  const warnings = [];
  const first = linesOf(text)[0] || '';
  put(f, src, 'name', labelled(text, ['company name', 'name of the company', 'company', 'organisation', 'organization', 'client name', 'client', 'firm', 'business name', 'trade name'])
    || (first.length >= 3 && first.length <= 70 && !/@|http|\d{6,}/.test(first) && /\b(pvt|private|limited|ltd|llp|inc|corp|technologies|solutions|industries|hospital|school|college|services|labs|systems|group|enterprises|consult)/i.test(first) ? first.replace(/[.:]+$/, '') : null));
  put(f, src, 'legalName', labelled(text, ['legal name', 'registered name', 'legal entity', 'legal company name']));
  put(f, src, 'companyType', companyTypeOf(labelled(text, ['company type', 'type of company', 'entity type']) || text));
  put(f, src, 'industry', (() => { const i = labelled(text, ['industry', 'sector', 'business', 'domain', 'nature of business']); return (i && industryOf(i)) || industryOf(text); })());
  put(f, src, 'website', (() => {
    const w = labelled(text, ['website', 'web', 'url', 'site']);
    const m = (String(w || '').match(URL_RE) || String(text).match(URL_RE) || [])[0];
    if (m) return m.replace(/[.,)]+$/, '');
    const d = (String(w || '').match(DOMAIN_RE) || []).find((x) => !/@/.test(x));
    return d || null;
  })());
  const emails = [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  put(f, src, 'companyEmail', labelled(text, ['company email', 'official email', 'email id', 'email', 'e-mail', 'mail']) && firstEmail(labelled(text, ['company email', 'official email', 'email id', 'email', 'e-mail', 'mail'])) || emails.find((e) => /^(info|contact|hr|admin|sales|hello|enquiry|enquiries|office|careers)@/.test(e)) || null);
  put(f, src, 'landline', (() => { const v = labelled(text, ['landline', 'telephone', 'tel', 'office phone', 'board line', 'phone']); const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 && d.length <= 12 && /^0/.test(d) ? v.trim() : null; })());
  const addr = labelled(text, ['registered address', 'office address', 'address', 'regd. office', 'registered office', 'corporate office', 'head office'], { maxLen: 300 }) || section(text, ['address', 'registered address', 'office address'], { maxChars: 300 });
  put(f, src, 'street', addr ? addr.split('\n')[0] : null);
  put(f, src, 'location', cityIn(labelled(text, ['city', 'location'])) || cityIn(addr) || cityIn(String(text).slice(0, 6000)));
  put(f, src, 'state', stateIn(labelled(text, ['state'])) || stateIn(addr) || stateIn(text));
  put(f, src, 'pincode', (() => { const p = labelled(text, ['pincode', 'pin code', 'pin', 'postal code', 'zip']); const m = (String(p || '').match(PIN_RE) || String(addr || '').match(PIN_RE) || [])[0]; return m || null; })());
  put(f, src, 'contactName', labelled(text, ['contact person', 'contact name', 'contact person name', 'authorised signatory', 'authorized signatory', 'signatory', 'hr contact', 'spoc', 'point of contact', 'name', 'contact']));
  put(f, src, 'contactDesignation', labelled(text, ['designation', 'title', 'position', 'role']));
  put(f, src, 'contactEmail', firstEmail(labelled(text, ['contact email', 'email', 'e-mail', 'mail', 'email id'])) || emails.find((e) => e !== f.companyEmail) || emails[0] || null);
  put(f, src, 'contactPhone', (() => { const v = labelled(text, ['mobile', 'mobile number', 'mobile no', 'cell', 'contact number', 'contact no', 'phone', 'phone number', 'whatsapp']); const p = firstPhone(v) || firstPhone(text); return p ? p.replace(/^\+91\s?/, '') : null; })());
  // GSTIN: a real check (state code + checksum). A wrong one is a warning, never a value.
  const g = (String(text).toUpperCase().match(GSTIN_RE) || [])[0] || gstin.clean(labelled(text, ['gstin', 'gst no', 'gst number', 'gst', 'gstin no']) || '');
  if (g) {
    const chk = gstin.checkGstin(g);
    if (chk.ok) { put(f, src, 'gst', chk.gstin); put(f, src, 'pan', chk.pan); if (!f.state && gstin.stateName(chk.stateCode)) put(f, src, 'state', gstin.stateName(chk.stateCode)); } else warnings.push(`GSTIN "${g}" in the file is not valid (${chk.error}). It was not filled in.`);
  }
  const pan = (String(text).toUpperCase().match(PAN_RE) || []).find((p) => !g || !g.includes(p)) || gstin.clean(labelled(text, ['pan', 'pan no', 'pan number']) || '');
  if (pan && gstin.isPan(pan)) put(f, src, 'pan', pan);
  else if (pan && !f.pan) warnings.push(`PAN "${pan}" in the file does not look right. It was not filled in.`);
  const tan = (String(text).toUpperCase().match(TAN_RE) || [])[0] || gstin.clean(labelled(text, ['tan', 'tan no', 'tan number']) || '');
  if (tan && gstin.isTan(tan) && !PAN_RE.test(tan)) put(f, src, 'tan', tan);
  const ifsc = (String(text).toUpperCase().match(IFSC_RE) || [])[0];
  if (ifsc && gstin.isIfsc(ifsc)) put(f, src, 'bankIfsc', ifsc);
  put(f, src, 'paymentBankName', labelled(text, ['bank name', 'bank', 'banker']));
  put(f, src, 'bankAccountHolder', labelled(text, ['account holder', 'account name', 'beneficiary name', 'beneficiary']));
  put(f, src, 'billingEmail', firstEmail(labelled(text, ['billing email', 'accounts email', 'invoice email', 'finance email'])) || emails.find((e) => /^(accounts|billing|finance|invoice|ap)@/.test(e)) || null);
  put(f, src, 'billingContactName', labelled(text, ['billing contact', 'accounts contact', 'finance contact', 'accounts person']));
  put(f, src, 'billingAddress', labelled(text, ['billing address', 'invoice address'], { maxLen: 300 }));
  // An old agreement: fee %, payment days, guarantee days.
  const fee = /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:annual\s+|gross\s+|first[- ]year\s+)?(?:ctc|salary|compensation|package|gross)/i.exec(text)
    || /(?:placement fee|service fee|service charge|professional fee|fee|charges?)[^.\n%]{0,60}?(\d{1,2}(?:\.\d{1,2})?)\s*%/i.exec(text);
  if (fee && Number(fee[1]) > 0 && Number(fee[1]) <= 100) { put(f, src, 'feeType', 'PERCENT_CTC'); put(f, src, 'agreementFeePercent', String(fee[1])); }
  const pay = /(?:payment|payable|paid)[^.\n]{0,80}?(?:within|in|net)\s*(\d{1,3})\s*days/i.exec(text) || /net\s*(\d{1,3})\b/i.exec(text);
  if (pay) put(f, src, 'paymentDays', String(pay[1]));
  const guar = /(?:replacement|guarantee|warranty)[^.\n]{0,80}?(\d{1,3})\s*(days?|months?)/i.exec(text) || /(\d{1,3})\s*(days?|months?)[^.\n]{0,40}?(?:replacement|guarantee)/i.exec(text);
  if (guar) put(f, src, 'guaranteeDays', String(/month/i.test(guar[2]) ? Number(guar[1]) * 30 : Number(guar[1])));
  const inv = /invoice[^.\n]{0,60}?(\d{1,3})\s*days?\s*(?:after|from|of)\s*(?:the\s+)?(?:date of\s+)?joining/i.exec(text);
  if (inv) { put(f, src, 'invoiceMode', 'after'); put(f, src, 'invoiceDays', String(inv[1])); }
  const sp = section(text, ['special terms', 'special conditions', 'other terms', 'additional terms'], { maxChars: 600 });
  put(f, src, 'specialTerms', sp);
  const start = /(?:effective|commencement|with effect)\s*(?:date|from)?\s*[:\-–]?\s*(\d{1,2})[/-](\d{1,2})[/-](\d{4})/i.exec(text);
  if (start) put(f, src, 'agreementStart', `${start[3]}-${start[2].padStart(2, '0')}-${start[1].padStart(2, '0')}`);
  return { fields: f, sources: src, warnings };
}

// --- step 3: the AI pass (gaps only, strict JSON) ---------------------------------
const AI_KEYS = {
  job: {
    title: 'string', clientName: 'string (the hiring company / client)', department: 'one of IT|Medical|Manufacturing|Education|HR|Accounts|R&D', specialisation: 'string',
    location: 'city', workMode: 'one of Work From Office|Hybrid|Remote', expMin: 'number of years', expMax: 'number of years', salaryMin: 'number, lakh per year', salaryMax: 'number, lakh per year',
    openings: 'integer', skills: 'comma-separated must-have skills', goodToHaveSkills: 'comma-separated', education: 'string', noticePeriodMax: 'one of Immediate|7 Days|15 Days|30 Days|60 Days|90 Days',
    employmentType: 'one of Full Time|Part Time|Contract|Temporary|Internship', jobDescription: 'string', responsibilities: 'string', qualifications: 'string',
  },
  candidate: {
    firstName: 'string', lastName: 'string', email: 'string', phone: 'string', location: 'current city', experienceYears: 'number', education: 'highest degree', skills: 'comma-separated',
    currentCompany: 'string', currentDesignation: 'string', noticePeriod: 'one of Immediate|15 Days|30 Days|60 Days|90 Days', currentSalary: 'string like 8L', expectedSalary: 'string like 12L',
    specialization: 'string', institute: 'string', passingYear: 'YYYY', dob: 'YYYY-MM-DD', gender: 'Male|Female',
  },
  client: {
    name: 'company name', legalName: 'string', companyType: 'one of Corporate|MNC|Startup|SME|Consultancy|Other', industry: 'one of IT|Healthcare|Manufacturing|Education|Finance|Retail|Logistics|Other',
    website: 'string', companyEmail: 'string', landline: 'string', street: 'address line', location: 'city', state: 'Indian state', pincode: '6 digits',
    contactName: 'string', contactDesignation: 'string', contactEmail: 'string', contactPhone: '10-digit mobile', gst: 'GSTIN', pan: 'PAN', tan: 'TAN',
    billingEmail: 'string', billingAddress: 'string', agreementFeePercent: 'number (fee % of CTC)', paymentDays: 'integer days', guaranteeDays: 'integer days', specialTerms: 'string',
  },
};
const TARGET_NOUN = { job: 'a job requirement / job description', candidate: 'a resume', client: 'a company profile, visiting card or service agreement' };

async function aiPass(target, text, user) {
  const allowed = await aiAllowedFor(user);
  if (!allowed.ok) return { fields: null, engine: null, why: allowed.why };
  const ai = require('./ai'); // eslint-disable-line global-require
  const keys = AI_KEYS[target];
  const system = `You extract fields from ${TARGET_NOUN[target]} for a recruitment system. Extract ONLY what is written in the document; use null when a value is absent. Never guess, never invent, never normalise beyond the listed choices. Return a single JSON object with exactly these keys: ${Object.entries(keys).map(([k, v]) => `${k} (${v})`).join(', ')}.`;
  try {
    const out = await ai.chatJson(system, [{ role: 'user', content: String(text).slice(0, 15000) }]);
    if (!out || typeof out !== 'object' || out.clarify) return { fields: null, engine: null, why: 'The AI reply could not be read.' };
    const f = {};
    Object.keys(keys).forEach((k) => {
      let v = out[k];
      if (v === null || v === undefined || v === '' || v === 'null') return;
      if (Array.isArray(v)) v = v.map((x) => String(x).trim()).filter(Boolean).join(', ');
      if (typeof v === 'object') return;
      f[k] = typeof v === 'number' ? v : String(v).trim();
    });
    return { fields: f, engine: ai.provider(), why: null };
  } catch (err) {
    return { fields: null, engine: null, why: String(err && err.message || err).slice(0, 120) };
  }
}

// --- client-name match for a job ---------------------------------------------------
const normCo = (s) => String(s || '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|co|company|technologies|technology|solutions|services|india)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
async function matchClient(name, user) {
  if (!name) return null;
  let where = {};
  try {
    const scope = require('./scope'); // eslint-disable-line global-require
    where = (typeof scope.clientPickerWhere === 'function' && await scope.clientPickerWhere(user)) || {};
  } catch { where = {}; }
  const rows = await prisma.client.findMany({ where, select: { id: true, name: true, legalName: true } }).catch(() => []);
  const want = normCo(name);
  if (!want) return null;
  const score = (c) => {
    const a = normCo(c.name); const b = normCo(c.legalName);
    if (a === want || (b && b === want)) return 3;
    if (a.startsWith(want) || want.startsWith(a) || (b && (b.startsWith(want) || want.startsWith(b)))) return 2;
    if (want.length >= 5 && (a.includes(want) || want.includes(a))) return 1;
    return 0;
  };
  const best = rows.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s)[0];
  return best ? { id: best.c.id, name: best.c.name, exact: best.s === 3 } : null;
}

const REQUIRED = {
  job: ['title', 'clientName', 'jobDescription', 'skills', 'location', 'expMin'],
  candidate: ['firstName', 'phone', 'email', 'skills'],
  client: ['name', 'industry', 'contactName', 'contactEmail', 'contactPhone'],
};

// --- the one entry point ----------------------------------------------------------------
async function fill({ target, file = null, text = '', user = null }) {
  if (!TARGETS.includes(target)) throw Object.assign(new Error('BAD_TARGET'), { code: 'BAD_TARGET' });
  const t = await textOf({ file, text, user });
  const base = {
    target, fileName: t.fileName, kind: t.kind, textChars: (t.text || '').length, fields: {}, sources: {}, found: [], missing: REQUIRED[target], confidence: 0, warnings: [], engine: 'rule',
  };
  if (!t.text) {
    return { ...base, needsAi: !!t.needsAi, error: t.needsAi ? MESSAGE.NEEDS_AI : (t.extractError || MESSAGE.NO_TEXT), aiNote: t.why || null };
  }
  const rules = target === 'job' ? await rulesJob(t.text) : target === 'candidate' ? await rulesCandidate(t.text) : rulesClient(t.text);
  const fields = { ...rules.fields };
  const sources = { ...rules.sources };
  const warnings = [...(rules.warnings || [])];
  let engine = t.ocr ? 'rule+ai' : 'rule';
  let aiNote = null;
  const ai = await aiPass(target, t.text, user);
  if (ai.fields) {
    engine = `rule+ai`;
    Object.entries(ai.fields).forEach(([k, v]) => {
      if (target === 'client' && k === 'gst') { const chk = gstin.checkGstin(v); if (!chk.ok) { warnings.push(`GSTIN "${v}" read by the AI is not valid (${chk.error}). It was not filled in.`); return; } v = chk.gstin; }
      if (target === 'client' && k === 'pan' && !gstin.isPan(v)) return;
      put(fields, sources, k, v, 'ai');
    });
    aiNote = `AI (${ai.engine}) filled the gaps the rules left.`;
  } else if (ai.why) aiNote = ai.why;
  if (target === 'job' && fields.clientName) {
    const m = await matchClient(fields.clientName, user);
    if (m) { fields.clientId = m.id; fields.clientMatch = m; sources.clientId = sources.clientName; } else fields.clientSuggest = fields.clientName;
  }
  const keys = Object.keys(AI_KEYS[target]);
  const found = keys.filter((k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== '');
  const missing = REQUIRED[target].filter((k) => !found.includes(k));
  return {
    ...base, fields, sources, found, missing, warnings, engine, aiNote, total: keys.length,
    confidence: Math.round((found.length / keys.length) * 100),
  };
}

module.exports = {
  MAX_BYTES, MESSAGE, KINDS, TARGETS, REQUIRED, AI_KEYS,
  fill, textOf, validateFile, sniffAny, storeSource, resolveSource, sourceDir, parseUpload, aiAllowedFor, matchClient,
  // exposed for tests
  rulesJob, rulesCandidate, rulesClient, labelled, section, salaryRange, expRange,
};
