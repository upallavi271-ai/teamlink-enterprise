// ---------------------------------------------------------------------------
// WHATSAPP AI AGENT: the tools the model may ask for. Every tool works ONLY on the person of this chat: no tool takes a candidate or job id, so nothing a
// person writes can make the model read somebody else's record. A tool never sends anything itself: links are collected here and TeamLink adds them to
// the reply in code, and the client's name, fee and phone numbers are never handed to the model.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('../outreach/store');
const Cfg = require('./config');
const Portal = require('../utils/jobPortalBridge');
const { REQUIREMENT_LIVE_STATUSES } = require('../utils/atsVocab'); // a job with a recruiter on it is still open: most live jobs are RECRUITER_ASSIGNED, not OPEN

const TOOL_HELP = `Tools (each is {"tool":"name","args":{...}}):
- get_candidate_profile {}: skills, location, applied jobs, application status, AI interview status.
- get_job_details {}: the job they replied to.
- search_knowledge_base {"query":"..."}: company and process FAQs.
- save_candidate_data {"availability":"","expected_salary":"","notice_period":"","location":"","interested":true|false}: send only what the person told you.
- send_apply_link {}: adds the job's apply link to your reply (a person without a login registers first), or the number to apply through.
- send_interview_link {}: adds the AI interview link to your reply.
- handoff_to_recruiter {"reason":"..."}: a recruiter takes over.`;

const clean = (v, n = 120) => S.clip(String(v == null ? '' : v).replace(/\s+/g, ' '), n);
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const noClient = (title, client) => (client ? String(title || '').split(client).join('').replace(/\s{2,}/g, ' ').replace(/^[\s\-–|:]+|[\s\-–|:]+$/g, '') : String(title || ''));

async function jobFacts(requirementId) {
  if (!requirementId) return { available: false, note: 'No job is linked to this chat.' };
  const JP = require('../jobPublish/jobPayload'); // eslint-disable-line global-require
  const built = await JP.build(requirementId, 'career').catch(() => null);
  if (!built || !built.payload || built.blocked) return { available: false, note: 'The job details cannot be shared.' };
  const open = REQUIREMENT_LIVE_STATUSES.includes(String(built.requirement && built.requirement.status).toUpperCase());
  if (!open) return { available: false, note: 'This job is closed.' };
  const p = built.payload;
  const r = built.requirement;
  const client = r.client && r.client.name;
  // straight from the ATS requirement; never the client's name, and never the import notes some requirements carry as a description
  const ats = (v, n = 300) => { const t = clean(noClient(v, client), n); return t && !/^(any|n\/?a|-|none)$/i.test(t) ? t : null; };
  const note = /^created from|local import/i;
  return {
    available: true, title: p.title, location: (p.location && p.location.text) || null, experience: (p.experience && p.experience.text) || null,
    salary: (p.salary && p.salary.text) || null, skills: Array.isArray(p.skills) ? p.skills.slice(0, 15) : null, description: note.test(String(p.description || '')) ? null : clean(p.description, 900),
    qualification: ats(r.qualifications) || ats(r.education), employmentType: ats(r.employmentType), workMode: ats(r.workMode), openings: r.openings || null,
    department: ats(r.department), specialisation: ats(r.specialisation), joining: ats(r.joiningTimeline), responsibilities: ats(r.responsibilities, 500),
  };
}

// ---- open jobs -------------------------------------------------------------------------------------------------------------------------------------
const NOISE = new Set('i am im looking for a an the new job jobs position positions vacancy vacancies vaccancy vacancey opening openings role roles interested intrested also want need any please hi hello yes no ok okay is are there do you have in at of to and or my me work this that one tell about know field details more give show list available related regarding relevant sector department dept area kind type full time part nay hloo hlo helo hii may can could sir madam mam'.split(' '));
const wordsOf = (t) => [...new Set(String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !NOISE.has(w) && !/^vac/.test(w) && !/^r[a-z]?e?w?lat/.test(w)))].slice(0, 6);
const JOB_ASK = /\b(jobs?|positions?|posts?|vacanc\w*|vaccan?c\w*|vacnc\w*|openings?|hiring|work)\b/i;
// "nurseing" must find "Nursing": the start of a word is enough
const stemOf = (w) => (w.length > 5 ? w.slice(0, Math.max(4, w.length - 4)) : w);
// at the START of a word in the title: "astronaut" must not find "Gastroenterologist"
const wordStarts = (title, stem) => String(title || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(stem));

// the open client jobs that fit the words: the title counts most, then the specialisation and department ("education" must find the Education jobs, whose titles say "Faculty"),
// then skills and place. Only "any jobs?" on a number given to one department lists that department. The same safe facts as get_job_details, the client's name never. id stays on this side.
const FIELDS = [['title', 3], ['specialisation', 2], ['department', 2], ['education', 2], ['qualifications', 2], ['skills', 1], ['location', 1]];
// what people write and what the titles say: "mbbs" is a degree, the jobs are titled Doctor / Consultant. Matched at the start of a word, like every stem.
const SYNONYMS = {
  mbbs: ['doctor', 'consultant', 'physician'], md: ['doctor', 'consultant', 'physician'], doctor: ['mbbs', 'consultant', 'physician'], doctors: ['doctor', 'mbbs', 'consultant'],
  dr: ['doctor', 'consultant'], physician: ['doctor', 'consultant'], surgeon: ['surgery', 'consultant'], nurse: ['nursing'], nurses: ['nursing'], nursing: ['nurse'],
  gnm: ['nursing', 'nurse'], anm: ['nursing', 'nurse'], bpt: ['physiotherap', 'physio'], physio: ['physiotherap'], pharmacist: ['pharma'], dmlt: ['lab', 'technician'], mlt: ['lab', 'technician'],
};
async function searchJobs(text, { limit = 5, department = null } = {}) {
  const words = wordsOf(text);
  const generic = !words.length && department && JOB_ASK.test(String(text || ''));
  if (!words.length && !generic) return { searched: false, jobs: [], total: 0 };
  const stems = words.map(stemOf);
  const extra = [...new Set(words.flatMap((w) => SYNONYMS[w] || []))].filter((x) => !stems.includes(x));
  const where = generic ? { department } : { OR: [...stems, ...extra].flatMap((w) => FIELDS.map(([f]) => ({ [f]: { contains: w } }))) };
  const rows = await prisma.requirement.findMany({ where: { status: { in: REQUIREMENT_LIVE_STATUSES }, internal: false, ...where }, orderBy: { createdAt: 'desc' }, take: 300, select: { id: true, title: true, specialisation: true, department: true, education: true, qualifications: true, skills: true, location: true, portalPublished: true } });
  const scoreOf = (r) => (generic ? 1 : stems.reduce((n, w) => n + FIELDS.reduce((m, [f, pts]) => m + (wordStarts(r[f], w) ? pts : 0), 0), 0)
    + extra.reduce((n, w) => n + FIELDS.reduce((m, [f, pts]) => m + (wordStarts(r[f], w) ? pts / 2 : 0), 0), 0));
  // the better fit first, and among equals a job with a Job Portal page (it can get an apply link)
  const scored = rows.map((r) => ({ id: r.id, n: scoreOf(r), pub: r.portalPublished ? 1 : 0 })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n || b.pub - a.pub);
  const jobs = [];
  const seen = new Set();
  for (const r of scored.slice(0, 30)) {
    if (jobs.length >= limit) break;
    const f = await jobFacts(r.id); // eslint-disable-line no-await-in-loop
    const key = `${f.title}|${f.location}`.toLowerCase(); // many Education jobs read the same: one line each
    if (f.available && !seen.has(key)) { seen.add(key); jobs.push({ id: r.id, title: f.title, location: f.location, experience: f.experience, salary: f.salary }); }
  }
  return { searched: true, jobs, total: scored.length };
}
// the department of a WhatsApp number, when it was given to exactly one
async function departmentOf(numberId) {
  if (!numberId) return null;
  const rows = await S.q('SELECT "refId", "refLabel" FROM "WaNumberAccess" WHERE "numberId" = ? AND "kind" = \'DEPARTMENT\'', String(numberId)).catch(() => []);
  return rows.length === 1 ? (rows[0].refLabel || rows[0].refId) : null;
}
// what the model sees, numbered; the ids are kept on the chat for select_job
async function offerJobs(conv, text) {
  const out = await searchJobs(text, { department: await departmentOf(conv.numberId) });
  const collected = JSON.parse(conv.collected || '{}');
  // nothing found: the jobs offered before keep their numbers
  if (out.jobs.length) {
    collected.jobChoices = out.jobs.map((j) => j.id);
    conv.collected = JSON.stringify(collected);
    await S.run('UPDATE "OmniWaConv" SET collected = ? WHERE id = ?', conv.collected, conv.id);
  }
  return { searched: out.searched, total: out.total, jobs: out.jobs.map(({ id, ...j }, i) => ({ number: i + 1, ...j })) };
}
async function selectJob(conv, args, ctx) {
  const id = (JSON.parse(conv.collected || '{}').jobChoices || [])[Number(args.number) - 1];
  if (!id) return { selected: false, note: 'There is no such number: use search_open_jobs first.' };
  const job = await jobFacts(id);
  if (!job.available) return { selected: false, note: job.note };
  conv.requirementId = id;
  await S.run('UPDATE "OmniWaConv" SET requirementId = ?, updatedAt = ? WHERE id = ?', id, Date.now(), conv.id);
  ctx.noJob = false;
  return { selected: true, job };
}
// the list a person gets. Written HERE, from the database: the first live chats showed the local model inventing jobs it was never given
function jobListText(jobs, total = jobs.length) {
  const lines = jobs.map((j) => `${j.number}. ${j.title}${j.location ? ` - ${j.location}` : ''}${j.experience ? ` - ${j.experience}` : ''}${j.salary ? ` - ${j.salary}` : ''}`);
  const more = total > jobs.length ? ' Or tell me the subject, role or city to see others.' : '';
  return `These jobs are open now:\n${lines.join('\n')}\nReply with the number of the job you want.${more}`;
}
const GREETING_TEXT = 'Hello. This is TeamLink Consultants. Are you looking for a job? Tell me the kind of work you want, and I will check our open positions. To talk to our team, write "recruiter".';
const isGreeting = (t) => /^\W*(h+i+|hey+|hai+|hel+o+|namaste|namaskaram|good\s+(morning|afternoon|evening)|gm)(\s+(sir|madam|mam|maam|team|there))?\W*$/i.test(String(t || ''));
const NO_MATCH_TEXT = 'I could not find an open job for that right now. Tell me another kind of work you want, or write "recruiter" and someone from our team will help you.';
const mentionsJobs = (text) => JOB_ASK.test(String(text || ''));
const askedAboutJob = (text) => wordsOf(text).length > 0 && JOB_ASK.test(String(text || ''));
const pickedNumber = (text) => { const m = /^\D*([1-5])\D*$/.exec(String(text || '').trim()); return m ? Number(m[1]) : null; };
const titleHas = (title, text) => wordsOf(text).some((w) => wordStarts(title, stemOf(w)));

// YES to a promotion: the details are asked here, one question at a time, and saved. No model: on the live server it was too slow and could not hold the order (founder 2026-11-05)
// "yesssss", "okkk", "yaa", "noooo": people stretch the word, and a stretched yes must not wait for the slow model (founder 2026-11-09)
const isYes = (t) => /^\W*(y+e+s+|y+e+a+h*|y+a+|y+e+p+|y+|o+k+|o+k+a+y+|k+|s+u+r+e+|interested|i am interested|im interested|i'm interested|a+v+u+n+u+|h+a+a*n*|h+a+)\W*(sir|madam|mam|maam)?\W*$/i.test(String(t || ''));
const isClosing = (t) => /^\W*(o+k+|o+k+a+y+|k+|b+y+e+|bye bye|thanks?( you)?|thank u|thx|ok(ay)? thanks?|tq|good ?night|gn)\W*(sir|madam|mam|maam)?\W*$/i.test(String(t || ''));
const isNo = (t) => /^\W*(n+o+|n+o+p+e+|no thanks|no thank you|not interested|v+a+d+d+u+|n+a+h+i+)\W*(sir|madam|mam|maam)?\W*$/i.test(String(t || ''));
// the next line of the list to ask from position i: { index, text } or null when the list is done. Placeholders come from the job; a line with no value is skipped.
function nextQuestion(list, i, job, answers = {}) {
  const notWorking = Object.entries(answers).some(([q, v]) => /currently working/i.test(q) && /\b(not|no|nope|fresher|unemployed)\b/i.test(String(v)));
  const vals = { 'job role': job && job.title, location: job && job.location, salary: job && job.salary, 'work mode': job && job.workMode, 'candidate name': job && job.candidate };
  for (let n = i; n < list.length; n += 1) {
    const line = String(list[n]);
    const skipForWork = /^if working\b/i.test(line) && notWorking;
    // a question the person already answered inside an earlier message ("working in NIIMS, 3 years as doctor") is not asked again
    const answeredAlready = answers[line.replace(/^if working,?\s*/i, '')] !== undefined;
    const holes = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].toLowerCase());
    if (!skipForWork && !answeredAlready && holes.every((h) => vals[h])) {
      let text = line.replace(/\[([^\]]+)\]/g, (m, h) => vals[h.toLowerCase()]);
      if (/^if working\b/i.test(text)) { text = text.replace(/^if working,?\s*/i, ''); text = text.charAt(0).toUpperCase() + text.slice(1); }
      return { index: n, text };
    }
  }
  return null;
}
// WHAT THE PERSON SAID ABOUT THE LATER QUESTIONS (founder 2026-11-13: "IAM WORKING IN NIIMS HOSPITAL, i have 3 years of experience as doctor" and the bot still asked the
// designation and the experience). Only what is plainly in the words: years of experience, "as <designation>", "working in/at <company>", "notice period <time>".
// -> { answers: { <question line without 'If working,'>: value }, fields: { <saved field>: value } } for the questions after position `from` not answered yet.
function volunteered(list, from, text, answers = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const out = { answers: {}, fields: {} };
  const take = (re) => { const m = re.exec(t); return m ? m[1].trim().replace(/[.,;:]+$/, '') : null; };
  const found = {
    experience: () => { const y = take(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/i); return y ? `${y} years` : null; },
    designation: () => take(/\bas\s+(?:an?\s+|the\s+)?([a-z][a-z .\/&-]{2,40}?)(?=[,.;]|\s+(?:in|at|with|for|from|and)\b|$)/i),
    company: () => take(/\b(?:working|work|employed)\s+(?:in|at|with|for)\s+([a-z0-9][a-z0-9&.' -]{1,40}?)(?=[,.;]|\s+(?:and|since|as|for|from|i)\b|$)/i),
    notice: () => take(/notice(?:\s+period)?\s*(?:is|of|:)?\s*(\d+\s*(?:days?|weeks?|months?)|immediate(?:ly)?)/i),
  };
  for (let n = Math.max(0, from); n < list.length; n += 1) {
    const line = String(list[n]); const key = line.replace(/^if working,?\s*/i, '');
    if (answers[key] !== undefined || /\[[^\]]+\]/.test(line)) continue;
    const q = line.toLowerCase();
    let kind = null;
    if (/total work experience|years of experience/.test(q)) kind = 'experience';
    else if (/current designation/.test(q)) kind = 'designation';
    else if (/which company/.test(q)) kind = 'company';
    else if (/notice period/.test(q)) kind = 'notice';
    const v = kind ? found[kind]() : null;
    if (!v) continue;
    out.answers[key] = v.slice(0, 300);
    const f = fieldOf(line); if (f) out.fields[f] = v;
  }
  return out;
}
// which saved field of the person an answer also fills
// DOES THE ANSWER FIT THE QUESTION? (founder 2026-11-09: "yes" to "Which company are you working with?" moved on to the next question.)
// A yes/no question takes any answer. A question with a choice ("..., or are you exploring?") needs more than a bare yes or no.
// Experience, salary, notice and joining need a number or a word like "fresher" / "immediate"; a date question needs a day or a time;
// what / which / where questions need real words, not "yes" or "ok".
const YESNO_Q = /^(are|is|do|does|have|has|will|would|can|could|did|shall)\b/i;
const NUMBER_WORDS = /\b(fresher|immediate(ly)?|no experience|zero|none|nil|negotiable|half|one|two|three|four|five|six|seven|eight|nine|ten|weeks?|months?|days?|years?|yrs?|serving|asap|today|tomorrow|lakh|lakhs|lpa|k)\b/i;
const DAY_WORDS = /\b(today|tomorrow|tmrw|day after|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|anytime|any time|next week|weekend|am|pm)\b/i;
function questionKind(question) {
  const q = String(question || '').replace(/^if working,?\s*/i, '').toLowerCase();
  if (YESNO_Q.test(q)) return /,\s*or\b/.test(q) ? 'choice' : 'yesno';
  if (/experience|salary|package|ctc|notice period|how soon/.test(q)) return 'number';
  if (/date and time|what time|\bwhen\b/.test(q)) return 'day';
  return 'words';
}
// A working person answers "how soon can you join?" / "notice period?" with "already in job", "im already doing job", "currently working" (founder 2026-11-12:
// the bot only said "give a correct answer, in numbers" again and again). That is a real answer about their situation, not a wrong one: the bot
// acknowledges it and asks the useful follow-up (do they want to change jobs, and what is the notice period), instead of repeating the demand.
const EMPLOYED_RE = /\b(already|currently|presently|now)\b.{0,24}\b(job|jobs|work|working|employed|employee|company|serving)\b|\b(i\s*am|i'?m|im)\s+(already\s+)?(working|employed|doing\s+(a\s+)?job|in\s+(a\s+)?job|in\s+job)\b|\bdoing\s+(a\s+)?job\b|\bin\s+(a\s+)?job\b|\bhave\s+(a\s+)?job\b|\bserving\s+(my\s+)?notice\b/i;
const employedStatement = (t) => EMPLOYED_RE.test(String(t || '')) && !/\d/.test(String(t || ''));
// "not looking", "not interested in change", "no plan to change": an answer to a joining or notice question
const NOT_LOOKING_RE = /\b(not\s+(looking|interested|planning|keen|ready)|no\s+(plan|plans|need|intention)|don'?t\s+want|do\s+not\s+want|not\s+now|not\s+(want|wanting)\s+to\s+(change|switch|leave))\b/i;
const notLooking = (t) => NOT_LOOKING_RE.test(String(t || ''));
const employedFollowUp = (question) => (/notice/i.test(String(question || ''))
  ? 'Understood, you are working at present. What is your notice period with your current company? For example "30 days", "2 months" or "immediate". If you are serving notice, tell me how many days are left.'
  : 'Understood, you are working at present. Are you looking to change your job? If yes, how soon can you join after selection, counting your notice period? For example "30 days", "2 months" or "immediate". If you are not looking to change, reply "not looking".');
const employedYesText = (question) => (/notice/i.test(String(question || ''))
  ? 'Thank you. Please tell me your notice period, for example "30 days" or "immediate".'
  : 'Good. Please tell me how soon you can join, counting your notice period, for example "30 days" or "immediate".');
function answerFits(question, text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const bare = isYes(t) || isNo(t) || isClosing(t);
  const kind = questionKind(question);
  if (kind === 'yesno') return true;
  if (kind === 'choice') return !bare;
  if (kind === 'number') return /\d/.test(t) || NUMBER_WORDS.test(t) || NOT_LOOKING_RE.test(t);
  if (kind === 'day') return /\d/.test(t) || DAY_WORDS.test(t);
  return !bare && /[a-z\u0C00-\u0C7F\u0900-\u097F]{2,}/i.test(t);
}
const ASK_AGAIN = {
  choice: 'Please give a correct answer: tell me which one applies to you.',
  number: 'Please give a correct answer, in numbers, for example "2 years" or "immediate".',
  day: 'Please give a correct answer: a day and time, for example "tomorrow 11 am".',
  words: 'Please give a correct answer to this question.',
};
const askAgainText = (question) => ASK_AGAIN[questionKind(question)] || ASK_AGAIN.words;

// JOINING TIME AGAINST THE JOB (founder 2026-11-09: the job says 15 days, the candidate said 30, and the AI only said "we will discuss with HR").
// "30 days" / "2 weeks" / "1 month" / "immediate" -> days; null when there is no time in it.
function daysOf(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(immediate(ly)?|asap|right away|today|now)\b/.test(t)) return 0;
  const m = /(\d+(?:\.\d+)?)\s*(days?|d\b|weeks?|wks?|months?|mons?)?/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || 'days';
  if (/^w/.test(unit)) return Math.round(n * 7);
  if (/^m/.test(unit)) return Math.round(n * 30);
  return Math.round(n);
}
const isJoiningQuestion = (q) => /how soon|when can you join|joining/i.test(String(q || ''));
// -> { need, can } when they can join later than the job needs, else null
function joiningGap(job, answer) {
  const need = job ? daysOf(job.joining) : null;
  const can = daysOf(answer);
  return need != null && can != null && can > need ? { need, can } : null;
}
const joiningNudgeText = (gap) => `This position needs joining within ${gap.need} days, and you said ${gap.can} days. Joining within ${gap.need} days gives your profile a much better chance with the client. Many people speak to their manager to shorten the notice, or adjust it with leave. Can you join within ${gap.need} days?`;

function fieldOf(question) {
  const q = String(question).toLowerCase();
  if (/notice period/.test(q)) return 'notice_period';
  if (/total work experience|years of experience/.test(q)) return 'experience';
  if (/how soon|date and time|free for an interview/.test(q)) return 'availability';
  if (/expected salary/.test(q)) return 'expected_salary';
  if (/which city|current location/.test(q)) return 'location';
  if (/qualification/.test(q)) return 'qualification';
  return null;
}

// a Green Start campaign has no job field: "Nurses REQ-0620" in its name says which job it promotes
async function jobOfCampaign(name) {
  const m = /\bREQ[-\s]?(\d{1,6})\b/i.exec(String(name || ''));
  if (!m) return null;
  const r = await prisma.requirement.findFirst({ where: { reqCode: `REQ-${m[1].padStart(4, '0')}` }, select: { id: true } }).catch(() => null);
  return r ? r.id : null;
}
const onlyThisJobText = (job) => `I can help you with *${job.title}*, the job in our message. For any other job, write "recruiter" and someone from our team will help you.`;

// a job's details and the common questions about it are answered HERE from the ATS requirement: the model could not be trusted with them in the live tests
function jobCardText(job) {
  const line = (label, v) => (v ? `${label}: ${Array.isArray(v) ? v.join(', ') : v}` : null);
  const rows = [
    `*${job.title}*`, line('Department', job.department), line('Speciality', job.specialisation), line('Location', job.location), line('Experience', job.experience), line('Salary', job.salary),
    line('Qualification', job.qualification), line('Skills', job.skills), line('Type', [job.employmentType, job.workMode].filter(Boolean).join(', ')), line('Openings', job.openings), line('Joining', job.joining), job.description || job.responsibilities,
  ].filter(Boolean);
  return `${rows.join('\n')}\n\nDo you want to apply? Reply *apply*, or ask me anything about this job.`;
}
const ASKS = [
  ['salary', 'salary', 'The salary', /\b(salary|sal|ctc|pay|package|lpa|stipend|jeetham|jeetam)\b|\u0c1c\u0c40\u0c24\u0c02|\u0935\u0947\u0924\u0928/i],
  ['location', 'location', 'The location', /\b(location|where|place|city|ekkada|kahan)\b|\u0c0e\u0c15\u0c4d\u0c15\u0c21/i],
  ['experience', 'experience', 'The experience needed', /\b(experience|exp|fresher|freshers)\b/i],
  ['qualification', 'qualification', 'The qualification', /\b(qualifi\w*|degree|eligib\w*|study|studies)\b/i],
  ['skills', 'skills', 'The skills', /\b(skills?)\b/i],
  ['type', 'employmentType', 'The job type', /\b(timings?|shift|full.?time|part.?time|work mode|remote|wfh)\b/i],
  ['openings', 'openings', 'The number of openings', /\b(how many|openings?|seats?)\b/i],
  // last: "where is the post" is the location, "what is the job role" is the role (founder 2026-11-09)
  ['role', 'title', 'The job role', /\b(role|designation|job title|job profile|position|post)\b|\bwhat (is the |is this |is that )?job\b/i],
];
const YES_TO_CARD = /^\W*(yes|yeah|yep|ok|okay|sure|interested|i am interested|im interested|avunu|haan|ha)\W*$/i;
// { text } answered | { apply: true } they want the link | { missing } the ATS has no such detail | null not a job question
function quickAnswer(job, text, { justShown = false } = {}) {
  const t = String(text || '');
  if (/\b(apply|application)\b/i.test(t) || (justShown && YES_TO_CARD.test(t))) return { apply: true };
  if (/\b(details?|about (this|the) (job|post|position|role)|tell me more|more info\w*|description|jd)\b/i.test(t)) return { text: jobCardText(job) };
  // "expecting 8 LPA" tells us something, "salary entha?" asks: only a question is answered here
  const asking = /\?|\b(what|whats|which|how|when|where|tell|share|give|entha|enta|ekkada|ela|emiti|kya|kitna|kitni|kahan|batao)\b/i.test(t) || t.trim().split(/\s+/).length <= 3;
  if (!asking) return null;
  for (const [, field, label, re] of ASKS) {
    if (re.test(t)) {
      const v = job[field];
      if (v && String(v).length) return { text: `${label}: ${Array.isArray(v) ? v.join(', ') : v}.` };
      return { missing: label.replace(/^The /, '').toLowerCase() };
    }
  }
  return null;
}

// A QUESTION FROM THEM, not an answer (founder 2026-11-09: "what is the job role" in the middle of the questions was saved as the answer and the next question came).
// A "?" at the end, a question word in front, or a Telugu / Hindi question word anywhere.
const QUESTION_START = /^\W*(what|whats|what's|which|where|when|why|who|whom|whose|how|is there|is it|is this|is the|are there|are you hiring|can you|could you|can i|could i|do you|does|did you|will you|tell me|please tell|pls tell|plz tell|send me|give me|explain)\b/i;
const QUESTION_WORD = /\b(entha|enta|ekkada|emiti|enti|endhuku|eppudu|kya|kitna|kitni|kahan|kaun|kab|kyun|batao|bataiye)\b/i;
const isQuestion = (t) => { const s = String(t || '').trim(); return /\?\s*$/.test(s) || QUESTION_START.test(s) || QUESTION_WORD.test(s); };
// "the job role", "this post": the job of this chat, not a search for another one
const aboutThisJob = (t) => /\b(this|the|that|your|ur)\s+(job|post|position|role|vacancy|opening)\b|\bjob\s*(role|title|profile|details?|description)\b/i.test(String(t || ''));

// NO JOB LINKED, BUT WE SENT THEM A PROMOTION: the answer comes from the words of our own message, never made up.
// { text } | { missing } | null (not a question about the job, or "tell me more" with no message of ours to show: the model answers that, as before)
const DETAILS_ASK = /\b(details?|about (this|the) (job|post|position|role)|tell me more|more info\w*|description|jd)\b/i;
// a question about a detail of a job (salary, place, shift...) that names no kind of work: about the job of our message, not a search
const asksDetail = (t) => isQuestion(t) && !JOB_ASK.test(String(t || '')) && ASKS.some(([, , , re]) => re.test(String(t || '')));
function promoAnswer(bodies, text) {
  const t = String(text || '');
  const ask = ASKS.find(([, , , re]) => re.test(t));
  const whole = DETAILS_ASK.test(t);
  if (!ask && !whole) return null;
  const body = (bodies || []).map((b) => String(b || '').trim()).find(Boolean);
  if (!body) return ask ? { missing: ask[2].replace(/^The /, '').toLowerCase() } : null;
  // "what is the job role": the Position / Role line of our message, or the message itself when it has no such line (founder 2026-11-11)
  if (!whole && ask[0] === 'role') {
    const pos = body.split(/\n+/).map((l) => l.trim()).find((l) => /\b(position|role|designation|hiring for)\b/i.test(l));
    if (pos) return { text: pos.replace(/^[^\p{L}\p{N}]+/u, '') };
  }
  if (whole || ask[0] === 'role') return { text: `Here are the details from our message:\n${body.length > 600 ? `${body.slice(0, 600).replace(/\s+\S*$/, '')}...` : body}` };
  const line = body.split(/\n+/).map((l) => l.trim()).find((l) => ask[3].test(l));
  return line ? { text: line } : { missing: ask[2].replace(/^The /, '').toLowerCase() };
}

// what the model may read of the chat's memory
function collectedView(conv) {
  const { jobChoices, applyLinkSentAt, cardShown, promoJob, promoCardSent, intakeOn, intakeDone, intakeAt, chosenJob, ...rest } = JSON.parse(conv.collected || '{}');
  return rest;
}

async function profileFacts(conv) {
  if (!conv.candidateId) return { known: false, note: 'This number is not a candidate yet.', collected: JSON.parse(conv.collected || '{}') };
  const c = await prisma.candidate.findUnique({
    where: { id: conv.candidateId },
    select: {
      name: true, skills: true, location: true, noticePeriod: true, expectedSalary: true,
      applications: { orderBy: { createdAt: 'desc' }, take: 5, select: { stage: true, aiInterviewStatus: true, aiInterviewDeadline: true, requirement: { select: { title: true, client: { select: { name: true } } } } } },
    },
  });
  if (!c) return { known: false, note: 'The record was not found.' };
  return {
    known: true, name: c.name, skills: c.skills, location: c.location, noticePeriod: c.noticePeriod, expectedSalary: c.expectedSalary,
    applications: c.applications.map((a) => ({ job: noClient(a.requirement && a.requirement.title, a.requirement && a.requirement.client && a.requirement.client.name), status: a.stage, aiInterviewStatus: a.aiInterviewStatus, aiInterviewDeadline: a.aiInterviewDeadline })),
    collected: JSON.parse(conv.collected || '{}'),
  };
}

// what the person said goes on the chat; on the candidate only into a field that is empty (the recruiter's data is never overwritten by a chat)
async function saveData(conv, args, ctx) {
  const was = JSON.parse(conv.collected || '{}');
  const next = { ...was };
  ['availability', 'expected_salary', 'notice_period', 'location', 'experience', 'qualification'].forEach((k) => { const v = clean(args[k], 100); if (v) next[k] = v; });
  if (typeof args.interested === 'boolean') next.interested = args.interested;
  conv.collected = JSON.stringify(next);
  await S.run('UPDATE "OmniWaConv" SET collected = ?, updatedAt = ? WHERE id = ?', conv.collected, Date.now(), conv.id);
  if (conv.candidateId) {
    const cur = await prisma.candidate.findUnique({ where: { id: conv.candidateId }, select: { expectedSalary: true, location: true } });
    const data = {};
    if (cur && !cur.expectedSalary && next.expected_salary) data.expectedSalary = next.expected_salary;
    if (cur && !cur.location && next.location) data.location = next.location;
    if (Object.keys(data).length) await prisma.candidate.update({ where: { id: conv.candidateId }, data }).catch(() => {});
    if (typeof args.interested === 'boolean') await require('../utils/waChats').setIntent({ name: 'AI assistant' }, 'CANDIDATE', conv.candidateId, args.interested ? 'interested' : 'not_interested').catch(() => {}); // eslint-disable-line global-require
  }
  if (args.interested === false) ctx.notInterested = true;
  return { saved: true, collected: next };
}

// WHAT WE SENT THEM: the bodies of our own (not AI) WhatsApp messages, newest first; the promotion of this chat first when there is one.
async function sentBodies(conv) {
  const rows = [];
  if (conv.campaignId && String(conv.campaignId).startsWith('gs:')) rows.push(...(await require('./gsCampaign').sentText(conv.e164, conv.numberId)).map((body) => ({ body }))); // eslint-disable-line global-require
  if (conv.campaignId) rows.push(...await S.q('SELECT body FROM "OmniWaMessage" WHERE e164 = ? AND direction = \'OUT\' AND aiGenerated = 0 AND campaignId = ? AND body IS NOT NULL ORDER BY at DESC LIMIT 3', conv.e164, conv.campaignId).catch(() => []));
  rows.push(...await S.q('SELECT body FROM "OmniWaMessage" WHERE e164 = ? AND direction = \'OUT\' AND aiGenerated = 0 AND body IS NOT NULL ORDER BY at DESC LIMIT 10', conv.e164).catch(() => []));
  if (conv.candidateId) {
    rows.push(...await prisma.candidateMessage.findMany({ where: { candidateId: conv.candidateId, channel: 'WhatsApp', template: { in: ['BULK', 'MANUAL'] } }, orderBy: { createdAt: 'desc' }, take: 10, select: { body: true } }).catch(() => []));
  }
  return rows.map((r) => String(r.body || '')).filter(Boolean);
}

// The phone number in the last message WE sent them (a campaign template carries the contact line), not their own number. Null when none.
const PHONE_IN_TEXT = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}|(?:\+?91[\s-]?)?\d{3,5}[\s-]\d{3,4}[\s-]\d{3,4}/g;
async function contactNumber(conv, bodies = null) {
  const own = String(conv.e164 || '').slice(-10);
  for (const body of bodies || await sentBodies(conv)) {
    for (const m of body.match(PHONE_IN_TEXT) || []) {
      const digits = m.replace(/\D/g, '');
      if (digits.length >= 10 && digits.slice(-10) !== own) return m.trim();
    }
  }
  return null;
}

// THE APPLY LINK (founder 2026-11-09: the link opens the job role of the template we sent; someone without a login registers first, the Job Portal
// does not just open; no such job -> "please apply through this number" and our Job Portal; a client's link we sent -> that job role's link):
//   1. the template we sent carried the client's own apply link -> that link
//   2. the job is on our Job Portal -> its page with tl_apply=1: a visitor without a login goes to registration first ("You're applying for
//      <job>") and the application goes in right after they register (job-portal-app/embed/apply-link-addon.js + the portal's own apply flow)
//   3. neither -> "Please apply through this number" (the template's contact number) and our Job Portal's registration page
const URL_IN_TEXT = /https?:\/\/[^\s<>"'\])]+/gi;
const NOT_A_JOB_LINK = /(wa\.me|whatsapp\.com|maps\.|goo\.gl\/maps|youtube\.|youtu\.be|facebook\.com|instagram\.com|twitter\.com|\/\/x\.com|unsubscribe|opt-?out)/i;
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
function withApply(url) {
  const at = String(url).indexOf('#');
  const head = at >= 0 ? url.slice(0, at) : String(url);
  const hash = at >= 0 ? url.slice(at) : '';
  return `${head}${head.includes('?') ? '&' : '?'}tl_apply=1${hash}`;
}
function templateLink(bodies) {
  const ours = hostOf(Portal.portalUrl());
  for (const body of bodies) {
    for (const raw of body.match(URL_IN_TEXT) || []) {
      const u = raw.replace(/[.,;:!?]+$/, '');
      if (NOT_A_JOB_LINK.test(u) || !hostOf(u)) continue;
      // our own Job Portal: a job page is used with registration first; its other pages are not a job's link
      if (hostOf(u) === ours) {
        if (/#\/job\//.test(u)) return { url: /[?&]tl_apply=1/.test(u) ? u : withApply(u), how: 'portal' };
        continue;
      }
      return { url: u, how: 'client' };
    }
  }
  return null;
}
function registerUrl(conv) {
  const q = new URLSearchParams({ src: 'whatsapp', utm_source: 'whatsapp', utm_medium: 'ai' });
  if (conv.campaignId) q.set('utm_campaign', String(conv.campaignId).slice(0, 100));
  return `${Portal.portalUrl()}/?${q}#/register/candidate`;
}
// the words before the link(s), by what was sent
function applyWords(link, usual) {
  if (!link || link.how !== 'number') return usual;
  return link.number ? 'Please apply through this number, or register on our Job Portal:' : 'Please register on our Job Portal, and our recruiter will contact you:';
}

async function applyLink(conv, ctx) {
  const collected = JSON.parse(conv.collected || '{}');
  // asked again = sent again (founder 2026-11-09: "malli adigithey malli reply evvali"): never "you already have it"
  const job = conv.requirementId ? await jobFacts(conv.requirementId) : null;
  if (job && !job.available) return { sent: false, note: job.note };
  const bodies = await sentBodies(conv);
  let out = templateLink(bodies);
  if (!out && conv.requirementId) {
    const live = await prisma.requirement.findUnique({ where: { id: conv.requirementId }, select: { portalPublished: true } }).catch(() => null);
    if (live && live.portalPublished) out = { url: withApply(Portal.jobUrl(conv.requirementId, 'whatsapp', { utm_source: 'whatsapp', utm_medium: 'ai', utm_campaign: conv.campaignId || undefined })), how: 'portal' };
  }
  let number = null;
  if (!out) {
    number = await contactNumber(conv, bodies);
    out = { url: registerUrl(conv), how: 'number' };
    if (number) ctx.links.push(`Apply through: ${number}`);
    ctx.handoff = ctx.handoff || `Wants to apply${job && job.title ? ` for ${job.title}` : ''}: the job is not on the Job Portal`;
  }
  ctx.links.push(out.url);
  collected.applyLinkSentAt = Date.now();
  conv.collected = JSON.stringify(collected);
  await S.run('UPDATE "OmniWaConv" SET collected = ? WHERE id = ?', conv.collected, conv.id);
  const note = out.how === 'number'
    ? 'This job is not on the Job Portal: TeamLink adds the number to apply through and the registration link to your reply. Say "Please apply through this number, or register on our Job Portal." Do not write any link or number yourself.'
    : 'TeamLink adds the link to your reply. Do not write any link yourself. Someone without a login registers first, then the application goes in.';
  return { sent: true, how: out.how, number, note };
}

async function interviewLink(conv, ctx) {
  if (!conv.candidateId) return { sent: false, note: 'This number is not a candidate yet: send the apply link first.' };
  const where = { candidateId: conv.candidateId, ...(conv.requirementId ? { requirementId: conv.requirementId } : {}) };
  const app = await prisma.application.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { aiInterviewStatus: true, aiInterviewDeadline: true } });
  if (!app) return { sent: false, note: 'They have not applied yet: send the apply link first.' };
  if (/complete|done|taken|pass|fail/i.test(String(app.aiInterviewStatus))) return { sent: false, note: 'The AI interview is already finished.' };
  if (app.aiInterviewDeadline && String(app.aiInterviewDeadline) < today()) return { sent: false, note: 'The AI interview time is over: hand off to a recruiter.' };
  ctx.links.push(`${Portal.portalUrl()}/#/candidate/applications`);
  return { sent: true, deadline: app.aiInterviewDeadline || null, note: `TeamLink adds the link to your reply. Do not write any link yourself.${app.aiInterviewDeadline ? ` Tell them it must be done by ${app.aiInterviewDeadline}.` : ''}` };
}

async function run(name, args, conv, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'get_candidate_profile': return profileFacts(conv);
    case 'get_job_details': return jobFacts(conv.requirementId);
    case 'search_knowledge_base': { const hits = await Cfg.kbSearch(a.query, 3, conv.numberId); return hits.length ? { found: hits } : { found: [], note: 'Nothing in the knowledge base: hand off to a recruiter.' }; }
    case 'save_candidate_data': return saveData(conv, a, ctx);
    case 'send_apply_link': return applyLink(conv, ctx);
    case 'send_interview_link': return interviewLink(conv, ctx);
    case 'handoff_to_recruiter': ctx.handoff = clean(a.reason, 200) || 'The AI passed this chat to a recruiter'; return { done: true, note: 'Tell them someone from the team will contact them.' };
    default: return { error: 'There is no such tool.' };
  }
}

const NAMES = ['get_candidate_profile', 'get_job_details', 'search_knowledge_base', 'save_candidate_data', 'send_apply_link', 'send_interview_link', 'handoff_to_recruiter'];
module.exports = { volunteered, isQuestion, aboutThisJob, asksDetail, promoAnswer, sentBodies, contactNumber, applyWords, templateLink, withApply, daysOf, isJoiningQuestion, joiningGap, joiningNudgeText, answerFits, askAgainText, questionKind, employedStatement, notLooking, employedFollowUp, employedYesText, GREETING_TEXT, isGreeting, isClosing, mentionsJobs, isYes, isNo, nextQuestion, fieldOf, jobOfCampaign, onlyThisJobText, jobCardText, quickAnswer, run, jobFacts, searchJobs, offerJobs, selectJob, jobListText, NO_MATCH_TEXT, askedAboutJob, pickedNumber, titleHas, collectedView, NAMES, TOOL_HELP };
