// ---------------------------------------------------------------------------
// WRITE THE JOB TEXT (user, 2026-10-10) — a Master JD and one version per job
// site (Naukri, Shine, Indeed, LinkedIn), built from the job's REAL fields.
//
//   * Deterministic templates: works with no AI key.
//   * Nothing is invented. A missing fact stays "[ ]" in the text and appears in
//     the "Fill these first" list; the poster types it in and the text refreshes
//     (nothing is saved unless they ask: save()).
//   * The client's name is never written. A client job says "Confidential" /
//     "a leading <industry> organisation"; only TeamLink's own jobs name TeamLink.
//     (Same rule the Indeed feed and the Job Portal follow: the advertiser is
//     TeamLink Consultants.) A client name found inside the job's own text is
//     replaced and reported.
//   * Inclusive lint: age limits, gender, marital status, religion/caste, looks
//     in the SOURCE fields are reported with the phrase and a neutral wording,
//     and are left out of the generated text.
//   * Optional AI draft (utils/ai.js, only when a model is configured): same
//     facts, same rules; the output is checked — a number, tag or hashtag that is
//     not in the input is dropped; it is labelled "AI draft: please read".
//
// Per-site shapes follow the user's brief:
//   Naukri    keyword-rich title, short summary + bullets, a SEPARATE list of
//             10-15 key-skill tags (fewer is fine; never padded)
//   Shine     simple bullets, salary / experience / location prominent, key skills
//   Indeed    plain searchable title, pay stated clearly, job type / location /
//             benefits listed apart, concise description
//   LinkedIn  <= 250 words, strong opening line, 4-5 responsibilities and
//             requirements, 3-5 hashtags, plus a short feed post
// ---------------------------------------------------------------------------
const prisma = require('../db');
const W = require('./jobPostWriter');

const BLANK = '[ ]';
const LINKEDIN_WORDS = 250;
const EXTRA_PREFIX = 'jobtext.extra.';
const OVERRIDE_KEYS = ['location', 'experience', 'education', 'salary', 'skills', 'goodToHave', 'responsibilities', 'notice', 'benefits', 'contactEmail', 'contactName', 'department'];
// What each fill-in saves into on the job itself; the rest (benefits, contact) is kept beside it.
const SAVES_TO = { location: 'location', experience: 'experience', education: 'education', salary: 'salary', skills: 'skills', goodToHave: 'goodToHaveSkills', responsibilities: 'responsibilities', notice: 'noticePeriodMax', department: 'department' };

const BOARDS = ['naukri', 'shine', 'indeed', 'linkedin'];
const BOARD_NAME = { naukri: 'Naukri', shine: 'Shine', indeed: 'Indeed', linkedin: 'LinkedIn' };
const SOURCE_TAG = { naukri: 'Naukri', shine: 'Shine', indeed: 'Indeed', linkedin: 'LinkedIn' };

const CHECKLIST = [
  { key: 'salary', label: 'Salary is right', hint: 'The pay shown is the pay the client agreed (or says "Best in industry" on purpose).' },
  { key: 'location', label: 'Location and work mode are right', hint: 'City, onsite / hybrid / remote.' },
  { key: 'contact', label: 'Contact details are right', hint: 'The apply link opens and the contact email or name is correct.' },
  { key: 'client', label: 'The client name is hidden', hint: 'Read the text once: no client name, no client logo, no client address.' },
  { key: 'review', label: 'I read the job text', hint: 'Nothing odd, no [ ] left that should be filled.' },
];

// ---- small helpers -------------------------------------------------------------
const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const present = (v) => { const t = clean(v); return t !== '' && t !== '—' && t !== '-' && !/^n\/?a$/i.test(t); };
const csv = (v) => clean(v).split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
const uniq = (a) => { const seen = new Set(); return a.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
const words = (t) => clean(t).split(/\s+/).filter(Boolean).length;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function listItems(text) {
  return clean(text).split(/\n|•|•|;/).map((s) => s.replace(/^\s*[-*••]+\s*/, '').replace(/^\s*\d+[.)]\s+/, '').trim()).filter((s) => s.length > 1);
}
function sentencesOf(text) {
  return clean(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}
const titleCase = (s) => String(s).replace(/\b([a-z])/g, (m) => m.toUpperCase());
const camel = (s) => String(s).replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const firstCity = (loc) => clean(loc).split(/[,/|]/)[0].trim();

function workModeWord(m) {
  const t = clean(m).toLowerCase();
  if (!t) return '';
  if (/home|remote/.test(t)) return 'Remote';
  if (/hybrid/.test(t)) return 'Hybrid';
  return 'Onsite';
}
function experienceText(v) {
  const t = clean(v);
  if (!present(t)) return '';
  if (/year|yr/i.test(t)) return t;
  return /^1(.0)?$/.test(t) ? '1 year' : `${t} years`;
}

// ---- inclusive lint ------------------------------------------------------------
const LINT = [
  { id: 'age', why: 'An age limit is not allowed in a job advert.', suggest: 'Remove the age. Say the experience you need, for example "2-5 years of experience".',
    re: /\b(age\s*(?:limit|bar|below|under|above|between|upto|up to|max(?:imum)?|:)?\s*\d{2}\b|\d{2}\s*(?:-|to)\s*\d{2}\s*(?:years|yrs|yr)?\s*(?:old|of age)\b|(?:below|under|upto|up to|maximum|max)\s*\d{2}\s*(?:years|yrs|yr)\s*(?:old|of age|age)\b|\d{2}\s*(?:years|yrs|yr)\s*(?:old|of age)\b)/i },
  { id: 'young', why: 'Words like "young" or "fresh young" point to age.', suggest: 'Say "motivated" or name the skill you need.', re: /\b(fresh\s+young|young|youthful|youngsters?)\b/i },
  { id: 'gender', why: 'A job cannot ask for one gender.', suggest: 'Write "open to all candidates".', re: /\b(males?|females?|girls?|boys?|ladies|gents|gentlemen)\b/i },
  { id: 'gender2', why: 'A job cannot ask for one gender.', suggest: 'Write "open to all candidates".', re: /\b(men|women)\b(?=[^.]{0,25}\b(only|required|preferred|wanted|needed|candidates?|applicants?)\b)|\b(only|preferably|prefer)\s+(men|women)\b/i },
  { id: 'marital', why: 'Marital status cannot be asked for.', suggest: 'Remove it. It has nothing to do with the job.', re: /\b(unmarried|married|marital status|single (?:girl|boy|male|female|lady))\b/i },
  { id: 'religion', why: 'Religion or caste cannot be asked for.', suggest: 'Remove it.', re: /\b(hindu|muslim|christian|sikh|jain|brahmin|caste|religion)\b/i },
  { id: 'looks', why: 'Looks or height cannot be asked for (unless the job truly needs a physical standard: say that standard plainly).', suggest: 'Describe the real physical requirement of the work, or remove it.', re: /\b(good[- ]looking|attractive|fair[- ]skinned|fair complexion|presentable (?:girl|lady|boy)|height (?:of|above|min))\b/i },
];
function lintHit(sentence) {
  const s = String(sentence || '');
  for (const l of LINT) {
    const m = l.re.exec(s);
    if (m) return { phrase: m[0], why: l.why, suggest: l.suggest, id: l.id };
  }
  return null;
}

// ---- the facts ------------------------------------------------------------------
async function companyContact() {
  const c = await prisma.company.findFirst({ select: { email: true, phone: true } }).catch(() => null);
  const ok = (v) => { const e = clean(v); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/@(example\.(com|org|net)|[^@]*\.(test|example|invalid|localhost|local))$/i.test(e) ? e : ''; };
  return { email: ok(c && c.email) };
}
async function extraOf(id) {
  const row = await prisma.appSetting.findUnique({ where: { key: `${EXTRA_PREFIX}${id}` } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

// r: a Requirement (with client). overrides: what the poster typed in the window.
async function buildFacts(r, overrides = {}, base = '') {
  const client = r.client || null;
  const extra = await extraOf(r.id);
  const ov = {};
  OVERRIDE_KEYS.forEach((k) => { if (present(overrides[k])) ov[k] = clean(overrides[k]); });
  const pick = (key, fromJob) => (ov[key] !== undefined ? ov[key] : (present(fromJob) ? clean(fromJob) : ''));
  const internal = !!r.internal;

  // Client names are scrubbed from every piece of text that goes out.
  const names = internal || !client ? [] : uniq([client.name, client.legalName].map(clean).filter((n) => n.length >= 3));
  const scrubbed = [];
  const scrub = (t) => {
    let out = String(t == null ? '' : t);
    names.forEach((n) => {
      const re = new RegExp(escRe(n), 'gi');
      if (re.test(out)) { scrubbed.push(n); out = out.replace(re, 'our client'); }
    });
    return out;
  };

  const skills = uniq(csv(scrub(pick('skills', r.skills))));
  const good = uniq(csv(scrub(pick('goodToHave', r.goodToHaveSkills))));
  const respSrc = scrub(pick('responsibilities', r.responsibilities));
  const qualSrc = scrub(r.qualifications);
  // Imported jobs keep the team's own tracker notes in the description: those never go on a post.
  const roleRaw = r.jobDescription || r.description;
  const pub = W.publishable(roleRaw);
  const roleSrc = scrub(pub.text);
  const contactEmail = pick('contactEmail', extra.contactEmail) || (await companyContact()).email;
  // A team member's name is not put on a public post unless the poster types it (or saved it with the job).
  const contactName = pick('contactName', extra.contactName);
  const industry = client && clean(client.industry);
  // "No fluff": no "leading" / "reputed" claims we cannot check. Only the sector, when the client has one.
  const companyLine = internal
    ? 'TeamLink Consultants is a recruitment and staffing firm. This role is with TeamLink Consultants.'
    : `Our client is an organisation${industry ? ` in the ${industry.toLowerCase()} sector` : ''}, hiring through TeamLink Consultants.`;
  const companyName = internal ? 'TeamLink Consultants' : 'Confidential';

  const salaryRaw = pick('salary', r.salary);
  const salaryFmt = W.formatSalary(salaryRaw, r.salaryType);
  // The form stores a yearly band; another pay basis (monthly ...) is named so nobody reads it as LPA.
  const salary = !salaryFmt ? '' : (ov.salary !== undefined || /LPA|best in industry/i.test(salaryFmt) || !present(r.salaryType) || /annual|ctc|year/i.test(r.salaryType) ? salaryFmt : `${salaryFmt} (${clean(r.salaryType)})`);
  const notice = pick('notice', r.noticePeriodMax);
  const joining = clean(r.joiningTimeline);
  const urgent = /\b(high|urgent|critical|immediate)\b/i.test(clean(r.priority));

  const apply = (board) => {
    const slug = require('./jobSlug'); // eslint-disable-line global-require
    const p = slug.careersPath(r, SOURCE_TAG[board]);
    const root = String(base || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    return root ? `${root}${p}` : p;
  };

  const facts = {
    internal,
    companyName,
    companyLine,
    title: scrub(clean(r.title)),
    department: pick('department', r.department),
    specialisation: clean(r.specialisation),
    employmentType: clean(r.employmentType),
    jobPreference: clean(r.jobPreference),
    openings: r.openings || 0,
    location: scrub(pick('location', r.location)),
    workMode: workModeWord(r.workMode),
    experience: experienceText(pick('experience', r.experience)),
    education: pick('education', r.education),
    salary,
    skills,
    good,
    responsibilities: listItems(respSrc),
    qualifications: listItems(qualSrc),
    role: roleSrc,
    notice,
    joining,
    urgent,
    benefits: listItems(scrub(pick('benefits', extra.benefits))),
    contactEmail,
    contactName,
    applyFor: apply,
    clientNames: names,
    scrubbed: uniq(scrubbed),
    extra,
    internalDropped: pub.dropped,
    // The text the poster should read to find missing facts (full, notes included: it only SUGGESTS, never publishes).
    sourceText: [r.jobDescription, r.description].map(clean).filter(Boolean).join('\n'),
  };
  return facts;
}

// ---- what is missing --------------------------------------------------------------
function missingOf(f) {
  const m = [];
  const add = (key, label, hint, optional) => m.push({ key, label, hint, optional: !!optional, saves: SAVES_TO[key] ? 'job' : 'beside' });
  if (!f.location) add('location', 'Job location', 'City, for example Hyderabad');
  if (!f.experience) add('experience', 'Experience needed', 'For example 2-5 (years)');
  if (!f.salary) add('salary', 'Salary', 'For example ₹3L - ₹5L, or type Best in industry');
  if (!f.skills.length) add('skills', 'Must-have skills', 'Comma separated, for example ICU, BLS');
  if (!f.responsibilities.length) add('responsibilities', 'Key responsibilities', 'One per line, 5 to 8 short points');
  if (!f.education) add('education', 'Education', 'For example B.Sc Nursing', true);
  if (!f.good.length) add('goodToHave', 'Good-to-have skills', 'Comma separated', true);
  if (!f.benefits.length) add('benefits', 'Benefits and perks', 'One per line, only real ones', true);
  if (!f.contactEmail && !f.contactName) add('contactEmail', 'Contact email', 'The email people can write to');
  return m;
}

// ---- lint over the SOURCE fields ----------------------------------------------------
function lintSource(r, overrides = {}, extra = {}) {
  const src = [
    ['Job title', r.title], ['Job description', r.jobDescription], ['Description', r.description], ['Responsibilities', overrides.responsibilities || r.responsibilities],
    ['Qualifications', r.qualifications], ['Education', overrides.education || r.education], ['Must-have skills', overrides.skills || r.skills],
    ['Good-to-have skills', overrides.goodToHave || r.goodToHaveSkills], ['Benefits', overrides.benefits || extra.benefits], ['Location', overrides.location || r.location],
  ];
  const out = [];
  const seen = new Set();
  src.forEach(([label, text]) => {
    const t = clean(text);
    if (!t) return;
    const parts = t.split(/(?<=[.!?])\s+|\n+|;/).map((s) => s.trim()).filter(Boolean);
    (parts.length ? parts : [t]).forEach((p) => {
      LINT.forEach((l) => {
        const m = l.re.exec(p);
        if (!m) return;
        const k = `${label}|${m[0].toLowerCase()}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ field: label, phrase: m[0], why: l.why, suggest: l.suggest, sentence: p.slice(0, 160) });
      });
    });
  });
  return out;
}

// Drop whatever breaks the inclusive rule from a list / a paragraph.
const okItems = (items) => items.filter((i) => !lintHit(i));
const okText = (t) => sentencesOf(t).filter((s) => !lintHit(s)).join(' ');

// ---- the pieces ----------------------------------------------------------------------
const bullets = (items) => items.map((i) => `• ${i}`).join('\n');
const orBlank = (v) => (v && String(v).trim() ? v : BLANK);
const joinNice = (parts) => parts.filter(Boolean).join(' | ');

function sections(f) {
  const role = okText(f.role);
  const resp = okItems(f.responsibilities);
  const quals = okItems(f.qualifications);
  const skills = okItems(f.skills);
  const good = okItems(f.good);
  const ben = okItems(f.benefits);
  const jobBits = [
    f.department ? `${f.department}${f.specialisation ? ` (${f.specialisation})` : ''}` : '',
    f.employmentType, f.workMode,
  ].filter(Boolean);
  const roleOverview = [
    role || '',
    `Role: ${f.title}${jobBits.length ? ` — ${jobBits.join(', ')}` : ''}.`,
    `Location: ${orBlank(f.location)}${f.workMode ? ` (${f.workMode})` : ''}. Openings: ${f.openings || BLANK}.`,
    `Salary: ${orBlank(f.salary)}`,
    f.urgent ? 'This is an urgent opening.' : '',
    (f.notice || f.joining) ? `Notice period: ${f.notice || BLANK}${f.joining ? `. Joining: ${f.joining}` : ''}.` : '',
  ].filter(Boolean).join('\n');
  const reqItems = [
    `Experience: ${orBlank(f.experience)}`,
    `Education: ${orBlank(f.education)}`,
    ...quals,
    `Must-have skills: ${skills.length ? skills.join(', ') : BLANK}`,
  ];
  return { role, resp, quals, skills, good, ben, roleOverview, reqItems };
}

function howToApply(f, board) {
  const link = f.applyFor(board || 'naukri');
  const who = [f.contactName, f.contactEmail].filter(Boolean).join(', ');
  return [`Apply here: ${link}`, who ? `Questions: ${who}` : `Questions: ${BLANK}`].join('\n');
}

function masterText(f) {
  const s = sections(f);
  return [
    'ABOUT THE COMPANY', f.companyLine, '',
    'ROLE OVERVIEW', s.roleOverview, '',
    'RESPONSIBILITIES', s.resp.length ? bullets(s.resp) : `• ${BLANK}`, '',
    'REQUIREMENTS', bullets(s.reqItems), '',
    'PREFERRED SKILLS', s.good.length ? bullets(s.good) : `• ${BLANK}`, '',
    'BENEFITS', s.ben.length ? bullets(s.ben) : `• ${BLANK}`, '',
    'HOW TO APPLY', howToApply(f, 'naukri').replace(/\?src=Naukri/, ''),
  ].join('\n');
}

// Naukri: tags are the job's real skills (+ title, department as they are real fields). Never padded.
const TAG_STOP = new Set(['and', 'the', 'for', 'with', 'of', 'in', 'at', 'to', 'a', 'an', 'senior', 'junior', 'sr', 'jr', 'executive', 'officer', 'other', 'others']);
function naukriTags(f) {
  // 1. the job's real skills; 2. only if fewer than 10: keywords taken from the job's own title,
  // department, specialisation, city and type. Nothing else is ever added.
  const t = uniq([...okItems(f.skills), ...okItems(f.good)].map((x) => x.slice(0, 40)));
  let tags = t.slice(0, 15);
  if (tags.length < 10) {
    const words2 = clean(f.title).split(/[\s/,()|–—-]+/).filter((w) => w.length >= 3 && !TAG_STOP.has(w.toLowerCase()));
    const derived = [f.title, f.department, f.specialisation, firstCity(f.location), f.employmentType, f.jobPreference, ...words2]
      .map(clean).filter((x) => x && x.length <= 40 && !lintHit(x));
    tags = uniq([...tags, ...derived]).slice(0, 15);
  }
  const fromSkills = Math.min(t.length, 15);
  const note = tags.length < 10
    ? `Only ${tags.length} tag${tags.length === 1 ? '' : 's'} could be made from the job. Add must-have skills to the job to reach 10-15; nothing is made up.`
    : (fromSkills < 10 ? `${fromSkills} tag${fromSkills === 1 ? ' is' : 's are'} real skills; the rest come from the job title, department and city. Adding skills to the job gives better tags.` : null);
  return { tags, note };
}
function naukri(f) {
  const s = sections(f);
  const skillsInTitle = s.skills.slice(0, 3);
  let title = f.title + (skillsInTitle.length ? ` - ${skillsInTitle.join(', ')}` : '') + (f.location ? ` - ${firstCity(f.location)}` : '');
  if (title.length > 100) title = f.title.slice(0, 100);
  const { tags, note } = naukriTags(f);
  const summary = sentencesOf(s.role).slice(0, 2).join(' ') || `${f.companyLine} We are hiring a ${f.title}.`;
  const text = [
    summary, '',
    'Job details', `Location: ${orBlank(f.location)}${f.workMode ? ` (${f.workMode})` : ''}`, `Experience: ${orBlank(f.experience)}`, `Salary: ${orBlank(f.salary)}`,
    `Employment type: ${f.employmentType || BLANK}`, `Openings: ${f.openings || BLANK}`, '',
    'Key responsibilities', s.resp.length ? bullets(s.resp) : `• ${BLANK}`, '',
    'Requirements', bullets(s.reqItems), '',
    ...(s.good.length ? ['Good to have', bullets(s.good), ''] : ['Good to have', `• ${BLANK}`, '']),
    'Benefits', s.ben.length ? bullets(s.ben) : `• ${BLANK}`, '',
    howToApply(f, 'naukri'),
  ].join('\n');
  return { title, text, tags, tagsNote: note };
}
function shine(f) {
  const s = sections(f);
  const text = [
    f.title,
    `Salary: ${orBlank(f.salary)}`, `Experience: ${orBlank(f.experience)}`, `Location: ${orBlank(f.location)}${f.workMode ? ` (${f.workMode})` : ''}`, '',
    'Key skills', s.skills.length || s.good.length ? bullets([...s.skills, ...s.good]) : `• ${BLANK}`, '',
    'About the job', `• ${f.companyLine}`, `• ${f.employmentType || BLANK}${f.department ? `, ${f.department}` : ''}`, `• Openings: ${f.openings || BLANK}`,
    ...(f.notice ? [`• Notice period: ${f.notice}`] : []), '',
    'What you will do', s.resp.length ? bullets(s.resp) : `• ${BLANK}`, '',
    'What we need', bullets(s.reqItems), '',
    'Benefits', s.ben.length ? bullets(s.ben) : `• ${BLANK}`, '',
    howToApply(f, 'shine'),
  ].join('\n');
  return { title: f.title, text };
}
function indeed(f) {
  const s = sections(f);
  const plain = f.title.replace(/\b(rock\s?star|ninja|guru|wizard|superstar|jedi)\b/gi, '').replace(/\s{2,}/g, ' ').trim() || f.title;
  const summary = sentencesOf(s.role).slice(0, 3).join(' ') || `${f.companyLine} We are hiring a ${f.title}.`;
  const text = [
    `Job title: ${plain}`,
    `Pay: ${orBlank(f.salary)}`,
    `Job type: ${[f.employmentType, f.jobPreference].filter(Boolean).join(', ') || BLANK}`,
    `Location: ${orBlank(f.location)}${f.workMode ? ` (${f.workMode})` : ''}`,
    'Benefits:', s.ben.length ? bullets(s.ben) : `• ${BLANK}`, '',
    'Job description', summary, '',
    'Responsibilities', s.resp.length ? bullets(s.resp) : `• ${BLANK}`, '',
    'Requirements', bullets(s.reqItems), '',
    howToApply(f, 'indeed'),
  ].join('\n');
  return { title: plain, text };
}
function hashtagsFor(f) {
  const base = [f.title, f.department, firstCity(f.location), ...f.skills.slice(0, 3)].map(clean).filter(Boolean);
  const tags = uniq(['Hiring', ...base.map(camel).filter((x) => x && x.length <= 25), 'NowHiring', 'Jobs'].map((x) => `#${x}`));
  return tags.slice(0, 5); // always 3-5: the two general ones only fill a thin job
}
function linkedin(f) {
  const s = sections(f);
  const tags = hashtagsFor(f);
  const build = (nResp, nReq, withRole) => {
    const resp = s.resp.slice(0, nResp);
    const req = [
      f.experience ? `${f.experience} of experience` : `Experience: ${BLANK}`,
      `Education: ${orBlank(f.education)}`,
      ...(s.skills.length ? [`Skills: ${s.skills.slice(0, 6).join(', ')}`] : [`Skills: ${BLANK}`]),
      ...s.quals,
      ...(s.good.length ? [`Good to have: ${s.good.slice(0, 4).join(', ')}`] : []),
      ...(f.notice ? [`Notice period: ${f.notice}`] : []),
    ].slice(0, nReq);
    return [
      `We are hiring: ${f.title}${f.location ? ` in ${firstCity(f.location)}` : ''}${f.workMode ? ` (${f.workMode})` : ''}.`,
      withRole ? sentencesOf(s.role).slice(0, 1).join(' ') : '',
      f.companyLine, '',
      'Responsibilities', resp.length ? bullets(resp) : `• ${BLANK}`, '',
      'Requirements', bullets(req), '',
      `Salary: ${orBlank(f.salary)}`,
      `Apply: ${f.applyFor('linkedin')}`,
      tags.join(' '),
    ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').replace(/\n{3,}/g, '\n\n');
  };
  let text = build(5, 5, true);
  let notes = [];
  if (words(text) > LINKEDIN_WORDS) { text = build(4, 4, true); }
  if (words(text) > LINKEDIN_WORDS) { text = build(4, 4, false); }
  if (words(text) > LINKEDIN_WORDS) notes = [`Over ${LINKEDIN_WORDS} words even after trimming. Shorten the responsibilities in the job.`];
  const post = [
    `We are hiring a ${f.title}${f.location ? ` in ${firstCity(f.location)}` : ''}${f.workMode ? ` (${f.workMode})` : ''}.`,
    [f.experience, f.employmentType].filter(Boolean).join(' | ') || BLANK,
    s.skills.length ? `Key skills: ${s.skills.slice(0, 4).join(', ')}` : `Key skills: ${BLANK}`,
    `Apply: ${f.applyFor('linkedin')}  ${tags.slice(0, 3).join(' ')}`,
  ].join('\n');
  return { title: f.title, text, hashtags: tags, post, notes, limit: LINKEDIN_WORDS };
}

const counts = (t) => ({ words: words(t), chars: clean(t).length });

// ---- the whole answer ------------------------------------------------------------------
async function generate(r, overrides = {}, base = '') {
  const f = await buildFacts(r, overrides, base);
  const warnings = lintSource(r, overrides, f.extra);
  const slugText = decodeURIComponent(f.applyFor('naukri')).toLowerCase().replace(/[-_+]+/g, ' ');
  f.clientNames.forEach((n) => {
    if (slugText.includes(n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())) {
      warnings.push({ field: 'Job title', phrase: n, why: 'The client name is in the job title, so it is also in the apply link.', suggest: 'Rename the job title without the client name, then check the link.', sentence: '' });
    }
  });
  f.scrubbed.forEach((n) => warnings.push({ field: 'Job text', phrase: n, why: 'The client name was inside the job text.', suggest: 'It was replaced with "our client" in the text below.', sentence: '' }));
  const master = masterText(f);
  const out = { naukri: naukri(f), shine: shine(f), indeed: indeed(f), linkedin: linkedin(f) };
  const boards = {};
  BOARDS.forEach((b) => { boards[b] = { ...out[b], ...counts(out[b].text) }; });
  const missing = missingOf(f);
  const leak = leakCheck([master, ...BOARDS.map((b) => out[b].text), out.linkedin.post], f.clientNames);
  // "Fill from the job description": what the description's own words suggest for a MISSING field.
  // Each carries the phrase it came from; the poster must press "Use this" — and is told to check it.
  const found = W.extractFromText(f.sourceText);
  const LABEL = { experience: 'Experience needed', salary: 'Salary', education: 'Education', location: 'Job location', skills: 'Must-have skills' };
  const suggestions = missing.filter((m) => found[m.key]).map((m) => {
    const hit = found[m.key];
    let value = hit.value;
    let phrase = hit.phrase;
    f.clientNames.forEach((n) => { const re = new RegExp(escRe(n), 'gi'); value = value.replace(re, 'our client'); phrase = phrase.replace(re, 'our client'); });
    return { key: m.key, label: LABEL[m.key] || m.label, value, phrase, check: m.key === 'salary' ? 'Check the amount and whether it is per month or per year.' : 'Check this before you use it.' };
  });
  const notes = [];
  if (f.internalDropped.length) notes.push(`The job description holds ${f.internalDropped.length} internal note line${f.internalDropped.length === 1 ? '' : 's'} (follow-ups, remarks, agreement notes). They are left out of every post.`);
  const texts = textsOf({ master: { text: master }, boards });
  return {
    mode: 'template',
    requirementId: r.id,
    company: { shown: f.companyName, line: f.companyLine, hidesClient: !f.internal },
    missing,
    suggestions,
    notes,
    warnings,
    master: { text: master, ...counts(master) },
    boards,
    texts,
    checklist: W.checklistFor({ facts: f, missing, warnings, leak, publicLink: !!process.env.APP_BASE_URL }),
    facts: factsForAi(f),
    leak,
  };
}

// The flat map of every editable text (what is saved per job and edited on the screen).
function textsOf(out) {
  const b = out.boards;
  return {
    master: out.master.text,
    naukri: b.naukri.text, naukriTitle: b.naukri.title, naukriTags: (b.naukri.tags || []).join(', '),
    shine: b.shine.text,
    indeed: b.indeed.text, indeedTitle: b.indeed.title,
    linkedin: b.linkedin.text, linkedinPost: b.linkedin.post,
  };
}

// A client's name anywhere in what is generated.
function leakCheck(texts, names) {
  const all = texts.join('\n').replace(/https?:\/\/\S+/g, ' ').toLowerCase(); // a link is checked on its own
  return names.filter((n) => all.includes(n.toLowerCase()));
}

// ---- AI draft ------------------------------------------------------------------------------
function factsForAi(f) {
  return {
    company: f.companyLine, companyNameToShow: f.companyName, title: f.title, department: f.department, specialisation: f.specialisation,
    employmentType: f.employmentType, jobPreference: f.jobPreference, openings: f.openings, location: f.location, workMode: f.workMode,
    experience: f.experience, education: f.education, salary: f.salary, mustHaveSkills: f.skills, goodToHaveSkills: f.good,
    responsibilities: okItems(f.responsibilities), qualifications: okItems(f.qualifications), roleSummary: okText(f.role),
    noticePeriod: f.notice, joining: f.joining, urgent: f.urgent, benefits: okItems(f.benefits), contactName: f.contactName, contactEmail: f.contactEmail,
  };
}
const AI_RULES = [
  'You write job adverts for the Indian job market for a recruitment firm. Simple professional English. No fluff, no exaggeration.',
  'Use ONLY the facts in the JSON. Do not invent salary, benefits, skills, numbers, company details or contact details.',
  'If a fact is missing (empty), write [ ] in its place. Never guess.',
  'Never name the client. The company is shown as given in "companyNameToShow" / "company".',
  'Inclusive wording: no age, gender, marital status, religion or looks requirements.',
  'Return JSON only: {"master":"...","naukri":{"title":"...","text":"...","tags":["..."]},"shine":{"text":"..."},"indeed":{"title":"...","text":"..."},"linkedin":{"text":"... (max 250 words)","hashtags":["#..."],"post":"3-4 lines"}}.',
  'Master sections: ABOUT THE COMPANY, ROLE OVERVIEW, RESPONSIBILITIES, REQUIREMENTS, PREFERRED SKILLS, BENEFITS, HOW TO APPLY. Naukri: 10-15 tags only from the given skills. LinkedIn: 4-5 responsibilities, 4-5 requirements, 3-5 hashtags.',
].join('\n');

const numbersIn = (t) => (String(t).match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));
function corpusOf(f, applyLinks) {
  return JSON.stringify(factsForAi(f)) + ' ' + applyLinks.join(' ');
}
// Check the AI output against the input. Returns the cleaned output + what was dropped.
function validateAi(out, f) {
  const dropped = [];
  const flagged = [];
  const links = BOARDS.map((b) => f.applyFor(b));
  const corpus = corpusOf(f, links).toLowerCase();
  const allowedNums = new Set(numbersIn(corpus));
  const clientHit = (t) => f.clientNames.some((n) => String(t).toLowerCase().includes(n.toLowerCase()));
  const vocab = new Set([...f.skills, ...f.good, f.title, f.department, f.specialisation, ...f.title.split(/\s+/), ...clean(f.location).split(/[,/|\s]+/)].map((x) => String(x).toLowerCase()).filter(Boolean));
  const cleanBlock = (text, where) => {
    const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
    const keep = [];
    lines.forEach((line) => {
      const body = line.replace(/^\s*\d+[.)]\s+/, '');
      const bad = numbersIn(body).filter((n) => !allowedNums.has(n));
      if (bad.length) { dropped.push({ where, line: line.trim().slice(0, 140), why: `The number ${bad[0]} is not in the job.` }); return; }
      if (clientHit(line)) { dropped.push({ where, line: line.trim().slice(0, 140), why: 'It names the client.' }); return; }
      const h = lintHit(line);
      if (h) { dropped.push({ where, line: line.trim().slice(0, 140), why: h.why }); return; }
      keep.push(line);
    });
    return keep.join('\n');
  };
  const tagOk = (t) => {
    const w = String(t).replace(/^#/, '').toLowerCase().replace(/\s+/g, '');
    return [...vocab].some((v) => v && (v.replace(/[^a-z0-9]/g, '') === w.replace(/[^a-z0-9]/g, '') || w.includes(v.replace(/[^a-z0-9]/g, '')) && v.length > 2)) || w === 'hiring';
  };
  const tags = (arr, where) => (Array.isArray(arr) ? arr : []).map(String).filter((t) => {
    if (tagOk(t)) return true;
    dropped.push({ where, line: t, why: 'This tag is not one of the job\'s skills.' });
    return false;
  });
  const o = out && typeof out === 'object' ? out : {};
  const res = {
    master: cleanBlock(o.master, 'Master JD'),
    naukri: { title: cleanBlock(o.naukri && o.naukri.title, 'Naukri title') || f.title, text: cleanBlock(o.naukri && o.naukri.text, 'Naukri'), tags: tags(o.naukri && o.naukri.tags, 'Naukri tags').slice(0, 15) },
    shine: { title: f.title, text: cleanBlock(o.shine && o.shine.text, 'Shine') },
    indeed: { title: cleanBlock(o.indeed && o.indeed.title, 'Indeed title') || f.title, text: cleanBlock(o.indeed && o.indeed.text, 'Indeed') },
    linkedin: { title: f.title, text: cleanBlock(o.linkedin && o.linkedin.text, 'LinkedIn'), hashtags: tags(o.linkedin && o.linkedin.hashtags, 'LinkedIn hashtags').slice(0, 5), post: cleanBlock(o.linkedin && o.linkedin.post, 'LinkedIn post') },
  };
  if (words(res.linkedin.text) > LINKEDIN_WORDS) flagged.push(`The LinkedIn text is over ${LINKEDIN_WORDS} words. Shorten it before posting.`);
  return { res, dropped, flagged };
}

async function aiStatus() {
  try {
    const ai = require('./ai'); // eslint-disable-line global-require
    const s = await ai.checkStatus();
    return { available: !!(s && s.available && (s.modelPulled !== false)), reason: s && !s.available ? s.reason : null, provider: s ? s.provider : null };
  } catch (e) { return { available: false, reason: String(e && e.message).slice(0, 160) }; }
}

async function aiDraft(r, overrides = {}, base = '', current = null) {
  const status = await aiStatus();
  if (!status.available) return { error: status.reason || 'No AI model is connected, so only the template version is available.', status: 409 };
  const f = await buildFacts(r, overrides, base);
  let raw;
  try {
    const ai = require('./ai'); // eslint-disable-line global-require
    raw = await ai.chatJson(AI_RULES, [{ role: 'user', content: JSON.stringify(factsForAi(f)) }]);
  } catch (e) { return { error: `The AI could not write the text: ${String(e && e.message).slice(0, 160)}`, status: 502 }; }
  const { res, dropped, flagged } = validateAi(raw, f);
  const base0 = await generate(r, overrides, base);
  const boards = {};
  BOARDS.forEach((b) => {
    const t = res[b];
    boards[b] = { ...base0.boards[b], ...t, ...(t.text ? {} : { text: base0.boards[b].text }), ...counts(t.text || base0.boards[b].text) };
  });
  if (!boards.naukri.tags || !boards.naukri.tags.length) boards.naukri.tags = base0.boards.naukri.tags;
  if (!boards.linkedin.hashtags || !boards.linkedin.hashtags.length) boards.linkedin.hashtags = base0.boards.linkedin.hashtags;
  if (!boards.linkedin.post) boards.linkedin.post = base0.boards.linkedin.post;
  const master = res.master || base0.master.text;
  const leak = leakCheck([master, ...BOARDS.map((b) => boards[b].text), boards.linkedin.post], f.clientNames);
  const aiOut = { master: { text: master, ...counts(master) }, boards };
  const texts = textsOf(aiOut);
  // "Check what changed": every text against what is on the screen now (the poster's edit, else the template).
  const before = { ...base0.texts, ...(current && typeof current === 'object' ? current : {}) };
  const diff = {};
  Object.keys(texts).forEach((k) => {
    if (texts[k] === before[k]) return;
    diff[k] = W.lineDiff(before[k] || '', texts[k] || '');
  });
  return {
    ...base0, mode: 'ai', label: 'AI draft: please read before posting', master: aiOut.master, boards, texts, diff, dropped, flagged, leak,
  };
}

// The inclusive-wording check on the texts as they are NOW (after the poster edited them):
// { key, field, phrase, why, suggest } and the client's name if it is back in a text.
const TEXT_LABEL = { master: 'Master JD', naukri: 'Naukri text', naukriTitle: 'Naukri title', naukriTags: 'Naukri key skills', shine: 'Shine text', indeed: 'Indeed text', indeedTitle: 'Indeed title', linkedin: 'LinkedIn text', linkedinPost: 'LinkedIn post' };
function lintTexts(texts, clientNames = []) {
  const out = [];
  Object.keys(texts || {}).forEach((k) => {
    const t = clean(texts[k]);
    if (!t) return;
    const seen = new Set();
    t.split(/(?<=[.!?])\s+|\n+|;/).map((s) => s.trim()).filter(Boolean).forEach((p) => {
      LINT.forEach((l) => {
        const m = l.re.exec(p);
        if (!m || seen.has(m[0].toLowerCase())) return;
        seen.add(m[0].toLowerCase());
        out.push({ key: k, field: TEXT_LABEL[k] || k, phrase: m[0], why: l.why, suggest: l.suggest, sentence: p.slice(0, 160) });
      });
    });
    const noLinks = t.replace(/https?:\/\/\S+/g, ' ').toLowerCase();
    (clientNames || []).forEach((n) => {
      if (noLinks.includes(String(n).toLowerCase())) out.push({ key: k, field: TEXT_LABEL[k] || k, phrase: n, why: 'The client name is in this text.', suggest: 'Take it out. Posts never name the client.', sentence: '', client: true });
    });
  });
  return out;
}

// ---- saving what the poster typed into the job ------------------------------------------------
async function save(r, overrides, user) {
  const data = {};
  const savedTo = [];
  Object.keys(SAVES_TO).forEach((k) => {
    if (!present(overrides[k])) return;
    const col = SAVES_TO[k];
    const v = k === 'skills' || k === 'goodToHave' ? csv(overrides[k]).join(', ') : clean(overrides[k]);
    data[col] = v;
    savedTo.push(k);
  });
  if (Object.keys(data).length) await prisma.requirement.update({ where: { id: r.id }, data });
  const extra = await extraOf(r.id);
  let extraChanged = false;
  ['benefits', 'contactEmail', 'contactName'].forEach((k) => { if (present(overrides[k])) { extra[k] = clean(overrides[k]); extraChanged = true; savedTo.push(k); } });
  if (extraChanged) {
    const value = JSON.stringify(extra);
    await prisma.appSetting.upsert({ where: { key: `${EXTRA_PREFIX}${r.id}` }, create: { key: `${EXTRA_PREFIX}${r.id}`, value }, update: { value } });
  }
  if (savedTo.length) {
    await require('./audit').logAudit({ // eslint-disable-line global-require
      userId: user.id, actorName: user.name, action: 'Job details filled from the job text window', entity: 'Requirement', entityId: r.id, toValue: savedTo.join(', '),
    }).catch(() => {});
  }
  return { saved: savedTo };
}

// The Master JD as plain text for the careers page when a job has no description of its own.
async function masterForCareers(r) {
  try {
    const full = r.client !== undefined ? r : await prisma.requirement.findUnique({ where: { id: r.id }, include: { client: true } });
    const f = await buildFacts(full, {}, '');
    const t = masterText(f).replace(/\n?HOW TO APPLY[\s\S]*$/, '').trim();
    return W.stripBlanks(t);
  } catch { return ''; }
}

module.exports = {
  generate, aiDraft, aiStatus, save, validateAi, masterForCareers, lintHit, lintSource, buildFacts, missingOf, naukriTags, hashtagsFor, leakCheck,
  lintTexts, textsOf,
  BLANK, LINKEDIN_WORDS, CHECKLIST, OVERRIDE_KEYS, BOARDS, BOARD_NAME,
};
