// ---------------------------------------------------------------------------
// INTERVIEW PREPARATION (user note, 2026-10-10, item 4: "AI interview (or) client interviews
// unnappudu, JD ni base chesukoni SUGGESTED QUESTIONS candidate ki prepare avvadaniki untundi").
//
// For every interview (a client interview, a team interview, or an AI interview round) the
// recruiter gets a short "Interview preparation" pack built from the JOB DESCRIPTION:
//
//   About you · Skills for this job · Scenario · About the job itself · Questions to ask the
//   interviewer  (about 12-15 likely questions)  +  5 "Revise: ..." tips
//   + what to carry / do on the day (worked out from the booking: time, mode, link).
//
// WHO WRITES IT
//   * AI (utils/ai.js, the same provider / key / sandbox + "view as" guards the job post writer
//     uses) when a model is connected: label "Suggested by AI".
//   * A deterministic TEMPLATE from the JD's own keywords when AI is off, offline, too slow or
//     answers badly: label "Suggested by template". The label is never faked.
//
// CACHE (AppSetting, no schema change): one pack per (job, round type) =
//     interviewprep.pack.<requirementId>.<client|team|ai>
//   with the hash of the JD facts it was made from. If the JD changes: an UNEDITED pack is rewritten
//   by itself, an EDITED pack is kept and flagged "The job changed since" (Regenerate is one press).
//   The recruiter can edit / add / remove questions and regenerate before sharing.
//
// SHARE LOG (AppSetting): interviewprep.share.<applicationId> = who sent which version on which
//   channel, when, and how it ended. The same version is not sent twice for one interview unless the
//   pack was edited / regenerated (or the sender says "send again").
//
// PRIVACY - what the CANDIDATE reads (email, short text, the /prep/<token> page):
//   * never the client's name: "the hiring company" (a name found inside the JD text is replaced);
//   * never pay: no salary, CTC, budget, fee or any rupee amount; no internal notes (tracker lines);
//   * never an AI score, a fit %, a rejection reason or any contact detail of other people;
//   * a client round is written from the JD AND the job's stated must-haves (qualification,
//     experience, place, joining time), still without the client's identity.
//   Sending goes ONLY through the one-person send (utils/omniSend.js -> utils/bulkMessaging.js): consent
//   withdrawn, STOP, the "Candidate emails" switch, test records, WhatsApp template rule, daily caps.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const W = require('./jobPostWriter');

const PACK_PREFIX = 'interviewprep.pack.';
const SHARE_PREFIX = 'interviewprep.share.';
const PREP_LABEL = 'Preparation for your interview';
const TYPES = { client: 'Client interview', team: 'Team interview', ai: 'AI interview' };
const GROUPS = [
  { key: 'about', title: 'About you', max: 6 },
  { key: 'skills', title: 'Skills for this job', max: 8 },
  { key: 'scenario', title: 'Scenario questions', max: 5 },
  { key: 'role', title: 'About the job itself', max: 5 },
  { key: 'ask', title: 'Questions you can ask the interviewer', max: 5 },
];
const MAX_TIPS = 8;
const MAX_Q = 240;
const GEN_VERSION = 'prep-v1';
const OK_STATUS = ['sent', 'sending', 'link'];

const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const csv = (v) => clean(v).split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
const uniq = (a) => { const seen = new Set(); return a.filter((x) => { const k = String(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha = (t) => crypto.createHash('sha1').update(String(t)).digest('hex').slice(0, 12);
const isTest = (s) => /zztest|example\.test/i.test(String(s || ''));

// ---- text safety --------------------------------------------------------------------------------------------
// Pay words / rupee amounts / contact details never reach a candidate (or the AI).
const PAY_RE = /(₹|\brs\.?\s*\d|\binr\b|\blpa\b|\blpm\b|\bctc\b|\bsalary\b|\bsalaries\b|\bpackage\b|\bbudget\b|\bstipend\b|\bincentives?\b|\bper (?:month|annum)\b|\bpay\b(?! attention)|\bpaid\b|\bcompensation\b|\bremuneration\b|\bearnings?\b|\b\d+(?:\.\d+)?\s?(?:l|lakhs?|lacs?)\b)/i;
const CONTACT_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(\+?\d[\d\s-]{8,}\d)|(https?:\/\/\S+)/;
const AMOUNT_RE = /(?:₹|rs\.?\s*)\s*\d[\d,.]*\s*(?:lpa|lpm|lakhs?|lacs?|crores?|cr|k|l)?/gi;

function dropPay(text) {
  return clean(text).split(/\n+/).map((line) => line.split(/(?<=[.!?])\s+/).filter((p) => !PAY_RE.test(p) && !CONTACT_RE.test(p)).join(' ')).filter((l) => l.trim()).join('\n');
}

// Replace the client's name (and legal name) wherever it appears. -> text
function scrubNames(text, names) {
  let out = String(text == null ? '' : text);
  (names || []).forEach((n) => { if (n && n.length >= 3) out = out.replace(new RegExp(escRe(n), 'gi'), 'the hiring company'); });
  return out;
}

// One line of anything a candidate will read.
function safeLine(text, names, pay) {
  let t = scrubNames(String(text == null ? '' : text), names);
  if (pay) t = t.split(pay).join('');
  t = t.replace(AMOUNT_RE, '').replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim();
  return t;
}
const badForCandidate = (t, names, pay) => {
  const s = String(t || '');
  if (!s.trim()) return true;
  if (PAY_RE.test(s) || CONTACT_RE.test(s)) return true;
  if (pay && s.toLowerCase().includes(String(pay).toLowerCase())) return true;
  if ((names || []).some((n) => n && n.length >= 3 && s.toLowerCase().includes(n.toLowerCase()))) return true;
  return false;
};

// ---- the JD facts -----------------------------------------------------------------------------------------------
// r: a Requirement with its client. Nothing here carries pay or the client's name.
function factsOf(r) {
  const client = r.client || null;
  const names = r.internal || !client ? [] : uniq([client.name, client.legalName].map(clean).filter((n) => n.length >= 3));
  const pay = clean(r.salary);
  const sc = (t) => dropPay(scrubNames(W.publishable(t).text, names));
  const plain = (t) => dropPay(scrubNames(clean(t), names)); // short fields (title, skills, place): not tracker notes
  const list = (t) => sc(t).split(/\n|•|;/).map((s) => s.replace(/^\s*[-*•]+\s*/, '').replace(/^\s*\d+[.)]\s+/, '').trim()).filter((s) => s.length > 3 && s.length <= 160);
  const f = {
    title: plain(r.title) || 'this job',
    department: clean(r.department),
    specialisation: clean(r.specialisation),
    skills: uniq(csv(plain(r.skills)).filter((s) => s.length <= 40)).slice(0, 12),
    goodToHave: uniq(csv(plain(r.goodToHaveSkills)).filter((s) => s.length <= 40)).slice(0, 8),
    experience: clean(r.experience),
    relevantExperience: clean(r.relevantExperience),
    responsibilities: list(r.responsibilities).slice(0, 8),
    qualifications: sc(r.qualifications).replace(/\s+/g, ' ').slice(0, 300),
    education: /^any/i.test(clean(r.education)) ? '' : clean(r.education),
    description: sc(r.jobDescription || r.description).replace(/\s+/g, ' ').slice(0, 1500),
    workMode: clean(r.workMode),
    employmentType: clean(r.employmentType),
    location: plain(r.location).slice(0, 80),
    notice: clean(r.noticePeriodMax),
    joining: clean(r.joiningTimeline),
    internal: !!r.internal,
    names,
    pay,
  };
  f.jdHash = sha(JSON.stringify([GEN_VERSION, f.title, f.department, f.specialisation, f.skills, f.goodToHave, f.experience, f.relevantExperience, f.responsibilities, f.qualifications, f.education, f.description, f.workMode, f.employmentType, f.location, f.notice, f.joining]));
  return f;
}

// ---- which kind of interview ---------------------------------------------------------------------------------
function typeFor(app, asked) {
  if (TYPES[asked]) return asked;
  const live = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'STARTED', 'COMPLETED', 'PENDING_FEEDBACK'].includes(app.interviewStatus) && app.interviewAt;
  if (!live && (['AI_INTERVIEW_REQUIRED', 'AI_INTERVIEW_SCHEDULED'].includes(app.stage) || (app.aiInterviewStatus && app.aiInterviewStatus !== 'Required' && !app.interviewAt))) return 'ai';
  if (app.requirement && app.requirement.internal) return 'team';
  if (/client/i.test(String(app.interviewType || ''))) return 'client';
  return 'team';
}

// ---- the TEMPLATE ------------------------------------------------------------------------------------------------
const DOMAINS = [
  ['medical', /\b(doctor|physician|surgeon|nurse|nursing|mbbs|dnb|gnm|anm|patient|clinical|hospital|icu|ward|pharmac\w*|paramedic|radiolog\w*|patholog\w*|dental|dentist|therap\w*|medical|healthcare|lab technician|opd|anaesthe\w*|cardio\w*|derma\w*)\b/gi],
  ['education', /\b(teacher|faculty|lecturer|professor|principal|tutor|trainer|curriculum|classroom|students?|b\.?ed|school|college|academic|pgt|tgt|prt|teaching|syllabus|lesson)\b/gi],
  ['tech', /\b(developer|engineer|software|java|python|javascript|typescript|react|node|angular|\.net|sql|mysql|aws|azure|devops|docker|kubernetes|api|frontend|backend|full ?stack|qa|testing|selenium|data (?:analyst|scientist|engineer)|machine learning|cloud|programmer|php|android|ios|ui\/ux|cyber\w*|coding)\b/gi],
  ['sales', /\b(sales|business development|bde|lead generation|cold call\w*|target|revenue|client acquisition|account manager|marketing|telecall\w*|field sales|territory)\b/gi],
  ['finance', /\b(account\w*|finance|tally|gst|tds|audit\w*|bookkeep\w*|payroll|invoice|reconciliation|ledger|taxation|auditor|cost accountant|ca\b)\b/gi],
  ['hr', /\b(hr|human resources?|recruit\w*|talent|onboarding|payroll|employee relations|hrbp|staffing|sourcing)\b/gi],
  ['ops', /\b(production|manufactur\w*|plant|machine|assembly|quality|qc|qa engineer|maintenance|warehouse|logistics|supply chain|store keeper|operator|supervisor|safety|fabricat\w*|cnc)\b/gi],
  ['support', /\b(customer (?:support|service|care)|call cent(?:re|er)|helpdesk|help desk|bpo|voice process|chat support|ticket\w*|front office|receptionist|csr)\b/gi],
];

function domainOf(f) {
  const body = [f.skills.join(' '), f.goodToHave.join(' '), f.department, f.specialisation, f.description, f.responsibilities.join(' '), f.qualifications, f.education].join(' ');
  let best = 'generic';
  let top = 0;
  DOMAINS.forEach(([name, re]) => {
    const n = (f.title.match(re) || []).length * 3 + (body.match(re) || []).length;
    if (n > top) { top = n; best = name; }
  });
  return top > 0 ? best : 'generic';
}

const BANK = {
  tech: {
    scenario: [
      'A feature you built stops working in production on release day. What do you check first, and how do you tell your team?',
      'You get a task with unclear requirements and a short deadline. What do you do?',
      'A teammate\'s code has a bug that blocks your work. How do you handle it?',
    ],
    ask: ['What does a good first 90 days look like in this role?', 'How does the team do code review, testing and releases?'],
    revise: ['Revise: your own projects - what you built, which tools you used, what went wrong and how you fixed it', 'Revise: how a request travels from the screen to the database and back'],
  },
  medical: {
    scenario: [
      'A patient\'s family member is upset and shouting about the waiting time. How do you respond?',
      'You find a mistake in a medicine or a report just before it is used. What do you do?',
      'Several emergencies arrive at the same time. How do you decide who comes first?',
    ],
    ask: ['How are shifts and duty hours arranged?', 'What training or updates are given to the staff?'],
    revise: ['Revise: infection control and hand-hygiene steps', 'Revise: patient safety, documentation and handover basics', 'Revise: the emergency steps for your own specialisation'],
  },
  education: {
    scenario: [
      'A student keeps disturbing the class. How do you handle it without shaming the student?',
      'Half the class did not understand your lesson. What do you do next?',
      'A parent is unhappy about their child\'s marks. How do you talk to them?',
    ],
    ask: ['Which classes and subjects will I handle?', 'How are lesson plans and student progress reviewed?'],
    revise: ['Revise: a sample lesson plan for one topic (aim, activity, check, homework)', 'Revise: the syllabus / board you will teach and its recent changes', 'Revise: ways to teach slow and fast learners together'],
  },
  sales: {
    scenario: [
      'A customer says your price is too high. What do you say?',
      'You are 20% behind your monthly target with one week left. What is your plan?',
      'A lead went silent after a good first meeting. How do you follow up?',
    ],
    ask: ['How are targets set and reviewed?', 'What support (leads, training, tools) will I get?'],
    revise: ['Revise: your last three wins - numbers, steps and what you learned', 'Revise: how to answer common objections (price, timing, trust)'],
  },
  finance: {
    scenario: [
      'The books do not balance at month end. How do you find the mistake?',
      'A vendor asks for early payment but the approval is pending. What do you do?',
      'You see an entry that looks wrong, but your senior already approved it. What now?',
    ],
    ask: ['Which software and reports will I work with?', 'What does the month-end closing calendar look like?'],
    revise: ['Revise: debit / credit rules and the GST / TDS basics you have used', 'Revise: bank reconciliation and month-end closing steps'],
  },
  hr: {
    scenario: [
      'Two employees complain about each other. How do you handle it?',
      'A key employee resigns suddenly. What do you do in the first week?',
      'A hiring manager rejects every candidate you send. What do you change?',
    ],
    ask: ['How many positions does the team close in a month?', 'Which HR tools does the team use?'],
    revise: ['Revise: the hiring steps from job post to joining', 'Revise: leave, attendance and basic labour-law rules you have used'],
  },
  ops: {
    scenario: [
      'A machine stops during a rush order. What do you do?',
      'You see a co-worker skipping a safety step. How do you react?',
      'Output quality drops suddenly. How do you find the cause?',
    ],
    ask: ['What are the shift timings and weekly offs?', 'What safety and quality training is given?'],
    revise: ['Revise: safety rules (PPE, lock-out) and quality checks of your area', 'Revise: how you measured output, waste and downtime'],
  },
  support: {
    scenario: [
      'A customer is angry and says they will leave. What do you say?',
      'You do not know the answer to a customer\'s question. What do you do?',
      'Many tickets arrive at once. How do you decide the order?',
    ],
    ask: ['What are the shift timings and targets?', 'What training is given on the product?'],
    revise: ['Revise: how to calm an upset customer in three steps', 'Revise: the products or services you will support and their common problems'],
  },
  generic: {
    scenario: [
      'You have two urgent tasks and one deadline. How do you decide what to do first?',
      'You made a mistake that affected a colleague. What do you do?',
      'You disagree with your manager\'s decision. What do you say?',
    ],
    ask: ['What does a good first three months look like in this job?', 'How will my work be measured?'],
    revise: ['Revise: your last two jobs or projects - what you did and what you achieved', 'Revise: the job description once more, line by line'],
  },
};

// skill keyword -> [a pointed question, a revise topic]
const SKILLS = [
  [/\bjava\b/i, 'What is the difference between an interface and an abstract class in Java? When would you use each?', 'Revise: Java OOP, collections and exception handling'],
  [/\bpython\b/i, 'What is the difference between a list and a tuple in Python? Where have you used each?', 'Revise: Python data types, functions and common libraries you used'],
  [/\b(javascript|typescript)\b/i, 'Explain how closures or promises work in JavaScript, with a small example.', 'Revise: JavaScript basics - scope, promises, async / await'],
  [/\breact\b/i, 'How do state and props differ in React, and when do you use hooks?', 'Revise: React components, hooks and state flow'],
  [/\bnode\b/i, 'How does Node.js handle many requests at the same time?', 'Revise: Node.js event loop and REST API basics'],
  [/\bangular\b/i, 'How do components and services work together in Angular?', 'Revise: Angular modules, components and services'],
  [/\b(sql|mysql|postgres\w*|oracle)\b/i, 'Write (or explain) a query that joins two tables and counts rows per group.', 'Revise: SQL joins, group by and indexes'],
  [/\baws|azure|cloud\b/i, 'Which cloud services have you used, and why did you choose them?', 'Revise: the basics of cloud servers, storage and security'],
  [/\b(docker|kubernetes|devops|ci\/?cd)\b/i, 'Describe how you would take code from a laptop to production safely.', 'Revise: build, test and deploy steps you have used'],
  [/\b(testing|selenium|qa)\b/i, 'How do you decide what to test first when time is short?', 'Revise: test cases, bug reports and the test types you know'],
  [/\b(excel|spreadsheet)\b/i, 'Which Excel functions do you use most (lookup, pivot, formulas)? Show one real use.', 'Revise: VLOOKUP / XLOOKUP, pivot tables and basic formulas'],
  [/\btally\b/i, 'How do you pass a purchase and a sales entry in Tally?', 'Revise: Tally vouchers, ledgers and reports'],
  [/\bgst\b/i, 'How do you file and reconcile GST returns? What mismatches have you solved?', 'Revise: GST returns, input credit and reconciliation'],
  [/\bcommunication\b/i, 'Tell us about a time good communication solved a problem at work.', 'Revise: how to explain a problem clearly in three sentences'],
  [/\b(leadership|team ?lead|team management)\b/i, 'How do you motivate a team member who is not performing?', 'Revise: examples of leading a team through a hard task'],
  [/\b(nursing|patient care)\b/i, 'How do you keep patient records accurate during a busy shift?', 'Revise: patient care routines, vitals and documentation'],
  [/\b(icu|critical care)\b/i, 'Walk us through how you prepare and monitor a critical patient.', 'Revise: critical care protocols and emergency drugs you handle'],
  [/\b(teaching|lesson|curriculum)\b/i, 'How do you plan one lesson from start to finish?', 'Revise: a lesson plan and a quick way to check understanding'],
  [/\b(sales|negotiation)\b/i, 'Describe one deal you closed: how you found it, what the problem was and how you won it.', 'Revise: your sales steps from first call to closing'],
  [/\b(recruit\w*|sourcing)\b/i, 'How do you find and screen candidates for a hard-to-fill job?', 'Revise: sourcing channels, screening questions and follow-up'],
  [/\b(autocad|solidworks|cad)\b/i, 'Describe a drawing or design you made and the mistakes you caught in it.', 'Revise: your CAD commands and drawing standards'],
  [/\b(plc|scada|automation)\b/i, 'How do you find the cause when a PLC-controlled line stops?', 'Revise: PLC logic basics and common faults'],
];

function skillQuestion(skill) {
  const hit = SKILLS.find(([re]) => re.test(skill));
  if (hit) return { q: hit[1], tip: hit[2] };
  return { q: `How have you used ${skill} in your work? Give one real example.`, tip: `Revise: the basics of ${skill}, and one example you can explain` };
}

const expWord = (f) => {
  const e = f.experience || f.relevantExperience;
  if (!e) return '';
  return /year|yr/i.test(e) ? e : `${e} years`;
};

function templatePack(f, type) {
  const dom = domainOf(f);
  const bank = BANK[dom];
  const title = f.title;
  const about = [
    `Tell us about yourself in two minutes, and why you fit a ${title} job.`,
    `Why do you want this ${title} job, and why now?`,
  ];
  if (expWord(f)) about.push(`The job asks for about ${expWord(f)} of experience. Walk us through the experience that matches it.`);
  about.push('Why are you looking for a change? Keep your answer positive.');
  if (type === 'ai') about.splice(0, about.length, ...about.slice(0, 3));

  const skillList = uniq([...f.skills, ...f.goodToHave]);
  const skills = uniq(skillList.map((s) => skillQuestion(s).q)).slice(0, type === 'ai' ? 5 : 6);
  if (skills.length < 3) {
    const extra = [`What are your strongest skills for a ${title} job? Give an example for each.`, 'Which tool, software or method do you use most in your work?', 'What was the hardest task you did in your last job, and how did you do it?'];
    extra.forEach((q) => { if (skills.length < 4) skills.push(q); });
  }

  const scenario = bank.scenario.slice(0, type === 'ai' ? 2 : 3);

  const role = [];
  f.responsibilities.slice(0, 3).forEach((r) => role.push(`This job includes: "${r.replace(/[.\s]+$/, '')}". Tell us how you have done something like this.`));
  if (f.description && !role.length) {
    const first = f.description.split(/(?<=[.!?])\s+/).find((s) => s.length > 25 && s.length < 200);
    if (first) role.push(`The job description says: "${first.replace(/[.\s]+$/, '')}". How would you start on this in your first month?`);
  }
  if (type === 'client') {
    // what the hiring company itself stated as must-haves: the JD facts, with no identity
    if (f.qualifications || f.education) role.push(`The hiring company expects: ${(f.qualifications || f.education).replace(/[.\s]+$/, '')}. Be ready to explain your qualification and show your certificates.`);
    if (f.workMode || f.location) role.push(`The job is ${f.workMode ? f.workMode.toLowerCase() : 'based'}${f.location ? ` in ${f.location}` : ''}. Can you work this way, and relocate if needed?`);
    if (f.joining || f.notice) role.push(`The hiring company wants someone ${f.joining ? `to join ${f.joining.toLowerCase()}` : 'who can join soon'}${f.notice ? ` (notice period up to ${f.notice})` : ''}. What is your notice period and last working day?`);
  }
  if (!role.length) role.push(`What would you do in your first 30 days as a ${title}?`);

  const ask = [...bank.ask, 'What are the next steps after this interview?'].slice(0, 3);

  // tips: the top skills first, then the domain's own topics
  const tips = uniq([
    ...skillList.slice(0, 3).map((s) => skillQuestion(s).tip),
    ...bank.revise,
    'Revise: every project and job line on your own resume - you can be asked about any of it',
    `Revise: the ${title} job description once more, line by line`,
  ]).slice(0, 5);

  // keep the questions (without "ask") near 15
  // a client round keeps the hiring company's own must-haves (the last lines of "role") before the generic duty lines
  const roleKept = type === 'client' && role.length > 4 ? [...role.slice(0, 2), ...role.slice(-3)] : role.slice(0, 4);
  const groups = { about, skills, scenario, role: roleKept, ask };
  let total = about.length + skills.length + scenario.length + groups.role.length;
  while (total > 15 && groups.skills.length > 3) { groups.skills.pop(); total -= 1; }
  while (total > 15 && groups.role.length > 2) { groups.role.pop(); total -= 1; }
  return { groups, tips, domain: dom };
}

// ---- the AI draft -------------------------------------------------------------------------------------------------
const AI_RULES = `You help a recruiter prepare a job candidate for an interview.
Write the questions that are most likely to be asked for THIS job, using only the facts given.
Rules:
- Plain, simple English a fresher can understand. Each question is one short sentence (at most 25 words).
- Never name the hiring company: if you must, say "the hiring company". Never mention pay, salary, budget or any money.
- No questions about age, gender, marriage, religion, caste, looks or family.
- Do not invent facts that are not in the input.
- Use only plain text: no braces, no markdown, no numbering inside the strings.
Answer with ONE JSON object and nothing else:
{"about":[4 questions about the candidate],"skills":[5 or 6 questions, each about one important skill or tool of the job],"scenario":[3 short real-life situations to handle],"role":[3 questions taken from the duties or the stated requirements],"ask":[3 questions the candidate can ask the interviewer],"tips":[5 strings, each starting with "Revise: "]}`;

const TYPE_RULE = {
  client: 'ROUND: an interview taken by the hiring company. Cover its stated must-haves (qualification, experience, place, joining time) in the "role" questions.',
  team: 'ROUND: the first interview taken by the recruiter or an internal panel.',
  ai: 'ROUND: an AI interview where the candidate answers recorded questions in 1-2 minutes each. Keep every question answerable in two minutes.',
};

function factsForAi(f, type) {
  return {
    round: TYPE_RULE[type],
    job: f.title,
    department: f.department || undefined,
    specialisation: f.specialisation || undefined,
    mustHaveSkills: f.skills,
    goodToHaveSkills: f.goodToHave,
    experience: expWord(f) || undefined,
    duties: f.responsibilities,
    qualifications: f.qualifications || f.education || undefined,
    about: f.description ? f.description.slice(0, 900) : undefined,
    workMode: f.workMode || undefined,
    location: f.location || undefined,
    joining: f.joining || undefined,
  };
}

// raw -> { groups, tips } or { error }
function validateAi(raw, f) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The AI answer could not be read.' };
  const groups = {};
  let n = 0;
  GROUPS.forEach((g) => {
    const arr = (Array.isArray(raw[g.key]) ? raw[g.key] : []).map((x) => safeLine(typeof x === 'string' ? x : (x && x.question) || '', f.names, f.pay).slice(0, MAX_Q)).filter((x) => x.length > 8 && !badForCandidate(x, f.names, f.pay));
    groups[g.key] = uniq(arr).slice(0, g.max);
    if (g.key !== 'ask') n += groups[g.key].length;
  });
  const tips = uniq((Array.isArray(raw.tips) ? raw.tips : []).map((x) => safeLine(typeof x === 'string' ? x : '', f.names, f.pay).slice(0, MAX_Q)).filter((x) => x.length > 8 && !badForCandidate(x, f.names, f.pay)).map((x) => (/^revise\s*:/i.test(x) ? x : `Revise: ${x}`))).slice(0, 5);
  if (n < 8) return { error: 'The AI gave too few usable questions.' };
  return { groups, tips };
}

function realAi() { return require('./ai'); } // eslint-disable-line global-require

async function aiStatus(ai = realAi()) {
  try {
    const s = await ai.checkStatus();
    return { available: !!(s && s.available && s.modelPulled !== false), reason: s && !s.available ? s.reason : (s && s.modelPulled === false ? s.reason : null), provider: s ? s.provider : null };
  } catch (e) { return { available: false, reason: String(e && e.message).slice(0, 160) }; }
}

function withTimeout(p, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('The AI took too long, so the template was used.'), { timeout: true })), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// -> { groups, tips, source: 'ai'|'template', aiNote, domain }
async function generate(f, type, { useAi = true, timeoutMs = 40000, ai = null } = {}) {
  const base = templatePack(f, type);
  const template = () => ({ groups: base.groups, tips: base.tips, source: 'template', domain: base.domain });
  if (!useAi) return { ...template(), aiNote: 'AI was not asked.' };
  const client = ai || realAi();
  const st = await aiStatus(client);
  if (!st.available) return { ...template(), aiNote: st.reason || 'No AI model is connected.' };
  try {
    const raw = await withTimeout(client.chatJson(AI_RULES, [{ role: 'user', content: JSON.stringify(factsForAi(f, type)) }]), timeoutMs);
    const v = validateAi(raw, f);
    if (v.error) return { ...template(), aiNote: `${v.error} The template was used.` };
    // gaps the AI left (an empty group) are filled from the template, never left blank
    GROUPS.forEach((g) => { if (!v.groups[g.key].length) v.groups[g.key] = base.groups[g.key]; });
    if (!v.tips.length) v.tips = base.tips;
    return { groups: v.groups, tips: v.tips, source: 'ai', aiNote: null, domain: base.domain };
  } catch (e) {
    return { ...template(), aiNote: `${String((e && e.message) || 'The AI could not answer.').slice(0, 160)} The template was used.` };
  }
}

// ---- the stored pack ----------------------------------------------------------------------------------------------------
const packKey = (reqId, type) => `${PACK_PREFIX}${reqId}.${type}`;
const contentHash = (groups, tips) => sha(JSON.stringify([GROUPS.map((g) => groups[g.key] || []), tips]));

function shapeGroups(groups) {
  return GROUPS.map((g) => ({ key: g.key, title: g.title, questions: (groups && groups[g.key]) || [] }));
}

async function loadPack(reqId, type) {
  const row = await prisma.appSetting.findUnique({ where: { key: packKey(reqId, type) } }).catch(() => null);
  if (!row) return null;
  try { const v = JSON.parse(row.value); return v && v.groups ? v : null; } catch { return null; }
}
async function savePack(reqId, type, pack, user) {
  const key = packKey(reqId, type);
  const value = JSON.stringify(pack);
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key }, create: { key, value, ...who }, update: { value, ...who } });
}

function sourceLabel(p) {
  const base = p.source === 'ai' ? 'Suggested by AI' : 'Suggested by template';
  return p.edited ? `${base} - edited${p.editedByName ? ` by ${p.editedByName}` : ''}` : base;
}

function packView(p, f) {
  return {
    type: p.type, typeLabel: TYPES[p.type], source: p.source, sourceLabel: sourceLabel(p), aiNote: p.aiNote || null,
    groups: shapeGroups(p.groups), tips: p.tips || [], version: p.version, generatedAt: p.generatedAt, generatedByName: p.generatedByName || null,
    edited: !!p.edited, editedAt: p.editedAt || null, editedByName: p.editedByName || null, stale: !!(f && p.jdHash !== f.jdHash),
  };
}

const inflight = new Map();

// -> { pack (stored form), view, generatedNow, stale }
async function ensurePack(r, type, { user = null, regenerate = false, useAi = true, timeoutMs, ai = null } = {}) {
  const f = factsOf(r);
  const key = packKey(r.id, type);
  const run = async () => {
    const cur = await loadPack(r.id, type);
    if (cur && !regenerate) {
      if (cur.jdHash === f.jdHash) return { pack: cur, f, generatedNow: false, stale: false };
      if (cur.edited) return { pack: cur, f, generatedNow: false, stale: true };
      // an unedited pack follows the job text by itself
    }
    const g = await generate(f, type, { useAi, timeoutMs: timeoutMs || (regenerate ? 120000 : 40000), ai });
    const pack = {
      v: 1, type, source: g.source, aiNote: g.aiNote || null, jdHash: f.jdHash, groups: g.groups, tips: g.tips, domain: g.domain,
      version: contentHash(g.groups, g.tips), generatedAt: new Date().toISOString(), generatedByName: user ? user.name : 'TeamLink',
      edited: false, editedAt: null, editedByName: null,
    };
    await savePack(r.id, type, pack, user);
    return { pack, f, generatedNow: true, stale: false };
  };
  if (inflight.has(key) && !regenerate) return inflight.get(key);
  const p = run().finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

// The editor's text -> a clean list. Returns { groups, tips, warnings }.
function cleanEdit(input, f) {
  const warnings = [];
  const groups = {};
  GROUPS.forEach((g) => {
    const arr = Array.isArray(input && input.groups && input.groups[g.key]) ? input.groups[g.key] : [];
    groups[g.key] = [];
    arr.forEach((x) => {
      let t = String(x == null ? '' : x).replace(/\s+/g, ' ').replace(/\{\{|\}\}/g, '').trim().slice(0, MAX_Q);
      if (!t) return;
      if ((f.names || []).some((n) => t.toLowerCase().includes(n.toLowerCase()))) { t = scrubNames(t, f.names); warnings.push('The client name was replaced with "the hiring company".'); }
      if (PAY_RE.test(t) && /(₹|\blpa\b|\bctc\b|\d)/i.test(t)) warnings.push(`"${t.slice(0, 40)}..." mentions pay. The candidate will not see pay figures: they are removed when it is sent.`);
      groups[g.key].push(t);
    });
    groups[g.key] = uniq(groups[g.key]).slice(0, 12);
  });
  const tips = uniq((Array.isArray(input && input.tips) ? input.tips : []).map((x) => String(x == null ? '' : x).replace(/\s+/g, ' ').replace(/\{\{|\}\}/g, '').trim().slice(0, MAX_Q)).filter(Boolean)).slice(0, MAX_TIPS);
  return { groups, tips, warnings: uniq(warnings) };
}

async function editPack(r, type, input, user, expectVersion) {
  const cur = await loadPack(r.id, type);
  if (!cur) return { error: 'There is no pack to edit yet. Open the card first.', status: 404 };
  if (expectVersion && cur.version !== expectVersion) return { error: 'Someone changed this list a moment ago. Reload it and try again.', status: 409 };
  const f = factsOf(r);
  const c = cleanEdit(input, f);
  const total = GROUPS.reduce((n, g) => n + (g.key === 'ask' ? 0 : c.groups[g.key].length), 0);
  if (total < 1) return { error: 'Keep at least one question.', status: 400 };
  const version = contentHash(c.groups, c.tips);
  const changed = version !== cur.version;
  const pack = {
    ...cur, groups: c.groups, tips: c.tips, version,
    edited: changed ? true : cur.edited, editedAt: changed ? new Date().toISOString() : cur.editedAt, editedByName: changed ? user.name : cur.editedByName,
    // an edit adopts the job text it was made against, so "the job changed" starts counting from now
    jdHash: f.jdHash,
  };
  await savePack(r.id, type, pack, user);
  return { pack, f, changed, warnings: c.warnings };
}

// ---- who read what: the share log -----------------------------------------------------------------------------------------
async function loadShares(appId) {
  const row = await prisma.appSetting.findUnique({ where: { key: `${SHARE_PREFIX}${appId}` } }).catch(() => null);
  try { const v = row ? JSON.parse(row.value) : null; return Array.isArray(v && v.entries) ? v.entries : []; } catch { return []; }
}
async function addShares(appId, entries, user) {
  if (!entries.length) return;
  const cur = await loadShares(appId);
  const next = [...cur, ...entries].slice(-60);
  const key = `${SHARE_PREFIX}${appId}`;
  const value = JSON.stringify({ entries: next });
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key }, create: { key, value, ...who }, update: { value, ...who } });
}
const shareKey = (e) => `${e.type}|${e.round}|${e.packVersion}|${e.channel}`;
const wasShared = (entries, e) => entries.some((x) => OK_STATUS.includes(x.status) && x.kind !== 'link' && shareKey(x) === shareKey(e));

// ---- the link the candidate opens ---------------------------------------------------------------------------------------------
const secret = () => process.env.PREP_LINK_SECRET || process.env.OFFER_LINK_SECRET || process.env.AGREEMENT_LINK_SECRET || process.env.JWT_SECRET || 'teamlink-prep-link';
const sigOf = (appId) => crypto.createHmac('sha256', secret()).update(`interview-prep:${appId}`).digest('hex').slice(0, 32);
const tokenFor = (appId) => `${appId}.${sigOf(appId)}`;
function appIdFromToken(token) {
  const m = /^([A-Za-z0-9_-]{8,40})\.([a-f0-9]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const a = Buffer.from(m[2]); const b = Buffer.from(sigOf(m[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}
function publicBase(req) { return require('./offerLink').publicBase(req); } // eslint-disable-line global-require
const linkFor = (req, appId) => `${publicBase(req)}/prep/${tokenFor(appId)}`;

// ---- what the candidate reads --------------------------------------------------------------------------------------------------
function whenText(app) { return require('./interviewNotices').when(app.interviewAt); } // eslint-disable-line global-require
function whereText(app) { return require('./interviewNotices').whereLine(app); } // eslint-disable-line global-require

// What to carry / do on the day, from the booking itself. -> [string]
function onTheDay(app, type) {
  const out = [];
  if (type === 'ai') {
    if (app.aiInterviewDeadline) out.push(`Finish your AI interview by ${app.aiInterviewDeadline}.`);
    out.push('Use a laptop or phone with a working camera, microphone and internet. Sit in a quiet place with good light.');
    out.push('Answer in short, clear points. Keep each answer to about one or two minutes.');
    return out;
  }
  const mode = String(app.interviewMode || '').toLowerCase();
  out.push('Be ready 10 minutes before the time.');
  if (mode.includes('person')) {
    out.push(`Go to: ${app.interviewLocation || 'the place your recruiter told you'}. Leave early so you are not late.`);
    out.push('Carry: a photo ID, 2 copies of your updated resume, your certificates (originals and one copy) and a pen.');
  } else if (mode.includes('tele') || mode.includes('phone')) {
    out.push('This is a phone interview. Keep your phone charged, stay where the network is good and pick up calls from unknown numbers around that time.');
  } else {
    out.push(app.interviewMeetingLink ? `Join here: ${app.interviewMeetingLink}` : 'We will send the joining link before the interview.');
    out.push('Check your camera, microphone and internet 15 minutes before. Sit in a quiet place with good light.');
  }
  out.push('Dress neatly and keep a notepad and pen with you.');
  return out;
}

// Lines from the CANDIDATE'S OWN resume skills vs the job (not stored: computed per candidate).
function personalOf(candidate, f) {
  const mine = uniq([...csv(candidate && candidate.skills), ...csv(candidate && candidate.technicalSkills)]);
  if (!mine.length) return { questions: [], tips: [] };
  const lower = mine.map((s) => s.toLowerCase());
  const jd = uniq([...f.skills, ...f.goodToHave]);
  const has = (s) => lower.some((m) => m === s.toLowerCase() || m.includes(s.toLowerCase()) || s.toLowerCase().includes(m));
  const matched = jd.filter(has).slice(0, 3);
  const missing = jd.filter((s) => !has(s)).slice(0, 2);
  return {
    questions: matched.map((s) => `Your resume shows ${s}. Be ready with one real example of how you used it.`),
    tips: missing.map((s) => `Refresh: ${s} (the job asks for it)`),
  };
}

// Everything the candidate sees, already cleaned. app: Application with candidate + requirement(+client).
function candidateView(pack, app, f) {
  const names = f.names;
  const pay = f.pay;
  const s = (t) => safeLine(t, names, pay);
  const keep = (t) => !badForCandidate(t, names, pay) || false;
  const groups = shapeGroups(pack.groups).map((g) => ({ key: g.key, title: g.title, questions: g.questions.map(s).filter((q) => q && !PAY_RE.test(q) && !CONTACT_RE.test(q)) })).filter((g) => g.questions.length);
  const personal = personalOf(app.candidate, f);
  const pq = personal.questions.map(s).filter(keep);
  if (pq.length) groups.splice(2, 0, { key: 'cv', title: 'From your resume', questions: pq });
  const tips = [...(pack.tips || []), ...personal.tips].map(s).filter((t) => t && !PAY_RE.test(t) && !CONTACT_RE.test(t)).slice(0, 8);
  const type = pack.type;
  const job = s(app.requirement && app.requirement.title) || 'your job';
  return {
    type, typeLabel: TYPES[type], job, round: app.interviewRound || 1,
    when: type === 'ai' ? (app.aiInterviewDeadline ? `by ${app.aiInterviewDeadline}` : '') : whenText(app),
    where: type === 'ai' ? 'Online' : whereText(app),
    company: app.requirement && app.requirement.internal ? 'TeamLink' : 'the hiring company',
    groups, tips, onTheDay: onTheDay(app, type).map(s),
    firstName: String((app.candidate && app.candidate.name) || '').trim().split(/\s+/)[0] || 'there',
  };
}

async function recruiterLine(app) {
  try { return await require('./messageContext').recruiterLineFor(app); } catch { return 'your TeamLink recruiter'; } // eslint-disable-line global-require
}

function emailSubject(v) { return `How to prepare for your ${v.job} ${v.type === 'ai' ? 'AI interview' : 'interview'}`; }

function emailText(v, link, contactLine) {
  const L = [];
  L.push(`Hi ${v.firstName},`, '');
  if (v.type === 'ai') L.push(`Your AI interview for ${v.job} is waiting${v.when ? ` - please finish it ${v.when}` : ''}.`);
  else L.push(`Your interview for ${v.job} (Round ${v.round}) is on ${v.when}.`, `Where: ${v.where}`);
  L.push('', 'These are questions that are often asked for this job. Read them once and think of a real example for each. You do not need to learn them by heart.');
  v.groups.forEach((g) => {
    L.push('', g.title.toUpperCase());
    g.questions.forEach((q, i) => L.push(g.key === 'ask' ? `- ${q}` : `${i + 1}. ${q}`));
  });
  if (v.tips.length) { L.push('', 'REVISE BEFORE THE INTERVIEW'); v.tips.forEach((t) => L.push(`- ${t.replace(/^revise\s*:\s*/i, '')}`)); }
  L.push('', 'ON THE DAY');
  v.onTheDay.forEach((t) => L.push(`- ${t}`));
  if (link) L.push('', `You can also read this on your phone: ${link}`);
  if (contactLine) L.push('', `Any question? ${contactLine}`);
  L.push('', 'All the best!', '- TeamLink');
  return L.join('\n');
}

function shortText(v, link) {
  return `Hi ${v.firstName}, tips to prepare for your ${v.job} ${v.type === 'ai' ? 'AI interview' : 'interview'}: ${link} All the best! - TeamLink`;
}

// ---- the staff card -----------------------------------------------------------------------------------------------------------------
// canEdit: may change the questions and send. The payload never holds the candidate's number, address or pay.
async function appPayload(user, app, { type: asked, canEdit, canSend, req = null, ai = null } = {}) {
  const r = app.requirement;
  const type = typeFor(app, asked);
  const ensured = await ensurePack(r, type, { user, ai });
  const f = ensured.f;
  const shares = await loadShares(app.id);
  const view = candidateView(ensured.pack, app, f);
  const status = await aiStatus(ai || realAi());
  const current = shares.filter((e) => e.type === type && e.round === (app.interviewRound || 1));
  return {
    applicationId: app.id, requirementId: r.id, candidateName: app.candidate ? app.candidate.name : '', job: r.title, round: app.interviewRound || 1,
    type, types: Object.entries(TYPES).map(([key, label]) => ({ key, label })),
    pack: packView(ensured.pack, f), stale: ensured.stale, generatedNow: ensured.generatedNow,
    ai: { available: status.available, reason: status.available ? null : status.reason },
    canEdit: !!canEdit, canSend: !!canSend,
    personal: personalOf(app.candidate, f),
    candidate: { subject: emailSubject(view), onTheDay: view.onTheDay, groups: view.groups, tips: view.tips, when: view.when, where: view.where },
    shares: shares.slice().reverse().slice(0, 12).map((e) => ({ at: e.at, byName: e.byName, type: e.type, round: e.round, channel: e.channel, status: e.status, reason: e.reason || null, sameAsNow: e.packVersion === ensured.pack.version, kind: e.kind || 'send' })),
    sentThisVersion: current.some((e) => OK_STATUS.includes(e.status) && e.kind !== 'link' && e.packVersion === ensured.pack.version),
    link: canSend && req ? linkFor(req, app.id) : null,
  };
}

// ---- send --------------------------------------------------------------------------------------------------------------------------------
// channels: ['Email'] by default. The words go through the one-person send, so every consent / switch / channel rule applies.
async function send(user, app, { type: asked, channels = ['Email'], again = false, req = null, ai = null, text: bodyOverride = null } = {}) {
  const r = app.requirement;
  const type = typeFor(app, asked);
  const ensured = await ensurePack(r, type, { user, ai });
  const f = ensured.f;
  const pack = ensured.pack;
  const v = candidateView(pack, app, f);
  const link = linkFor(req, app.id);
  const contact = await recruiterLine(app);
  const omni = require('./omniSend'); // eslint-disable-line global-require
  const shares = await loadShares(app.id);
  const attempts = [];
  const log = [];
  const round = app.interviewRound || 1;
  const wanted = ['Email', 'WhatsApp', 'SMS'].filter((c) => (channels || []).includes(c));
  if (!wanted.length) return { error: 'Choose how to send it.', status: 400 };
  // The page the candidate opens needs a share entry to exist; a "link" entry is added with the first real send.
  for (const ch of wanted) {
    const entry = { at: new Date().toISOString(), byId: user.id, byName: user.name, type, round, packVersion: pack.version, channel: ch };
    if (!again && wasShared(shares, entry)) { attempts.push({ channel: ch, status: 'already', reason: 'This version was already sent for this interview. Change the questions, or press "Send again".' }); continue; } // eslint-disable-line no-continue
    const perChannel = ch === 'Email'
      ? { Email: { subject: emailSubject(v), body: bodyOverride || emailText(v, link, contact) } }
      : { [ch]: { body: shortText(v, link) } };
    // the page must open as soon as the message is out: write the entry first as 'link', settled below
    // eslint-disable-next-line no-await-in-loop
    const out = await omni.send(user, {
      audience: 'candidates', id: app.candidateId, channel: ch, applicationId: app.id, purpose: PREP_LABEL, urgent: true, perChannel,
    }).catch((e) => ({ ok: false, error: e.message }));
    if (out && out.ok) {
      const st = out.stillSending ? 'sending' : 'sent';
      attempts.push({ channel: ch, status: st, sandbox: !!(out.result && out.result.sandbox) });
      log.push({ ...entry, status: st });
    } else {
      const reason = String((out && out.error) || 'The message could not be sent.').slice(0, 240);
      attempts.push({ channel: ch, status: 'not sent', reason });
      log.push({ ...entry, status: 'failed', reason });
    }
  }
  await addShares(app.id, log, user);
  const sent = attempts.filter((a) => ['sent', 'sending'].includes(a.status)).length;
  return { ok: true, attempts, sent, nothingSent: sent === 0, link, type, packVersion: pack.version };
}

// Copying the link counts as sharing it (the page opens only for a shared interview).
async function markLinkShared(user, app, { type: asked, req = null } = {}) {
  const type = typeFor(app, asked);
  const ensured = await ensurePack(app.requirement, type, { user });
  await addShares(app.id, [{ at: new Date().toISOString(), byId: user.id, byName: user.name, type, round: app.interviewRound || 1, packVersion: ensured.pack.version, channel: 'Link copied', status: 'link', kind: 'link' }], user);
  return { ok: true, link: linkFor(req, app.id) };
}

// ---- the candidate's page ---------------------------------------------------------------------------------------------------------------
async function publicView(token) {
  const appId = appIdFromToken(token);
  if (!appId) return { error: 'This link does not work. Ask your recruiter for a new one.', status: 404 };
  const app = await prisma.application.findUnique({ where: { id: appId }, include: { candidate: true, requirement: { include: { client: true } } } });
  if (!app) return { error: 'This link does not work. Ask your recruiter for a new one.', status: 404 };
  const shares = await loadShares(appId);
  const last = shares.filter((e) => OK_STATUS.includes(e.status)).slice(-1)[0];
  if (!last) return { error: 'There is nothing to show yet. Your recruiter will send it soon.', status: 404 };
  const ref = app.interviewAt || app.updatedAt;
  if (ref && Date.now() - new Date(ref).getTime() > 30 * 86400000) return { error: 'This page has expired because the interview is over.', status: 410 };
  const type = TYPES[last.type] ? last.type : typeFor(app);
  const pack = await loadPack(app.requirementId, type);
  if (!pack) return { error: 'There is nothing to show yet. Your recruiter will send it soon.', status: 404 };
  const f = factsOf(app.requirement);
  const v = candidateView(pack, app, f);
  const contact = await recruiterLine(app);
  return { view: { ...v, contact, cancelled: app.interviewStatus === 'CANCELLED' } };
}

// A short line for reminders ({{prepNote}}): the link only when a pack was really sent for this application.
async function prepNote(app, req = null) {
  try {
    const shares = await loadShares(app.id);
    if (shares.some((e) => OK_STATUS.includes(e.status))) return `How to prepare: ${linkFor(req, app.id)}`;
  } catch { /* fall through */ }
  return 'Be ready 10 minutes early.';
}

module.exports = {
  PREP_LABEL, TYPES, GROUPS, PACK_PREFIX, SHARE_PREFIX, OK_STATUS,
  factsOf, typeFor, domainOf, templatePack, validateAi, generate, aiStatus, ensurePack, editPack, loadPack, packView, cleanEdit,
  loadShares, addShares, wasShared, tokenFor, appIdFromToken, linkFor, candidateView, emailText, emailSubject, shortText, onTheDay, personalOf,
  appPayload, send, markLinkShared, publicView, prepNote, safeLine, scrubNames, dropPay, isTest,
};
