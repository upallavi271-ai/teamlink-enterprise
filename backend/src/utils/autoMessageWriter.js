// ---------------------------------------------------------------------------
// AUTOMATIC STAGE MESSAGES - "AI writes it".
//
// Only used when (1) a rule asks for it, (2) an AI provider is configured and
// reachable, (3) the channel allows free text (Email, or WhatsApp inside an
// open 24-hour window; SMS and a WhatsApp chat that has to be STARTED need a
// registered template, so they always use the template).
//
// The model is given ONLY real facts (buildFacts): the candidate's first name,
// the job title, "our client" (never the client's name), the interview time,
// mode and link, the recruiter's name and phone and the next step. Whatever it
// writes is then CHECKED (the same idea as the job-post writer, utils/jobText.js
// validateAi): any sentence with a number, link or capitalised name that is not
// in the facts, the client's real name, a salary or promise word, pressure
// wording or discriminatory wording is dropped. If too little is left, or the
// AI is slow, off or fails, the caller uses the template - a stage move or a
// message is NEVER blocked because the AI failed.
// ---------------------------------------------------------------------------

const { stageLabel } = require('./atsVocab');

const NEXT_STEP = {
  NEW: 'A recruiter will look at your profile and get in touch.',
  AI_INTERVIEW_REQUIRED: 'We will send you the link for a short AI screening interview.',
  AI_INTERVIEW_SCHEDULED: 'Please complete the AI screening interview before the deadline.',
  AI_INTERVIEW_COMPLETED: 'A recruiter will review it and come back to you.',
  RECRUITER_REVIEW: 'We will tell you the next step soon.',
  RECRUITER_APPROVED: 'We will tell you the next step soon.',
  TL_REVIEW: 'We will tell you the next step soon.',
  WITH_BDE: 'We will tell you the next step soon.',
  BDE_APPROVED: 'We will share your profile with the hiring team.',
  SHARED_WITH_CLIENT: 'We will come back to you as soon as we hear from the hiring team.',
  CLIENT_REVIEW: 'We will come back to you as soon as we hear from the hiring team.',
  CLIENT_SHORTLISTED: 'We will share the interview details soon.',
  INTERVIEW_SCHEDULED: 'Please confirm that you can attend.',
  INTERVIEW_COMPLETED: 'We will share the outcome as soon as we have it.',
  SELECTED: 'Your recruiter will call you with the next steps.',
  OFFER: 'Please read the offer and tell your recruiter.',
  OFFER_ACCEPTED: 'Please keep your ID and education documents ready for onboarding.',
  JOINED: 'We wish you all the best.',
  HIRED: 'We wish you all the best.',
  HOLD: 'We will get back to you when there is movement.',
  REJECTED: 'We will not move forward on this job this time. Your profile stays with us for other jobs.',
};

// What the model may know. Nothing else is ever sent to it.
function buildFacts({
  stage, candidate, requirement, application, recruiter, language,
}) {
  const r = requirement || {};
  const a = application || {};
  // eslint-disable-next-line global-require
  const ctx = require('./messageContext');
  const t = ctx.appTokens({ ...a, requirement: r });
  const first = String((candidate && candidate.name) || '').trim().split(/\s+/)[0] || null;
  const facts = {
    candidateFirstName: first,
    jobTitle: r.title || null,
    company: r.internal ? 'TeamLink' : 'our client',
    step: stageLabel(stage),
    nextStep: NEXT_STEP[stage] || 'We will be in touch.',
    interviewDate: t.interviewDate || null,
    interviewTime: t.interviewTime || null,
    interviewMode: t.mode || null,
    interviewLink: t.meetingLink || null,
    interviewPlace: t.venue || null,
    aiInterviewDeadline: t.deadline || null,
    joiningDate: t.joiningDate || null,
    recruiterName: (recruiter && recruiter.name) || null,
    recruiterPhone: (recruiter && recruiter.phone) || null,
    language: language || 'English',
  };
  Object.keys(facts).forEach((k) => { if (facts[k] == null || facts[k] === '') delete facts[k]; });
  return facts;
}

const SYSTEM = (language, maxWords) => [
  'You write ONE short message from a recruitment firm to a job candidate in India.',
  `Write in ${language}. Simple everyday words. Friendly and polite. No emojis. At most ${maxWords} words.`,
  'Use ONLY the facts in the JSON. Never invent a name, date, time, number, link, salary, benefit or promise. If a fact is missing, leave it out.',
  'Never promise a job, a salary, a result or a date that is not in the facts.',
  'Never name the client: say the "company" value from the facts ("our client" or "TeamLink").',
  'No wording about age, gender, marital status, religion, caste or looks. No pressure words ("urgent", "last chance").',
  'Say what has happened at this step and what happens next (the "nextStep" fact). Include the recruiter name and phone from the facts if they are there.',
  'Never mention any other candidate.',
  'Return JSON only: {"subject":"... (email only, max 80 letters)","body":"..."}.',
].join('\n');

// --- the output check ------------------------------------------------------------
const COMMON = new Set(['Email', 'WhatsApp', 'SMS', 'TeamLink', 'AI', 'Zoom', 'Teams', 'Meet', 'Google', 'Online', 'Telephonic', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'January', 'February', 'March', 'April', 'June', 'July', 'August',
  'September', 'October', 'November', 'December', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'India', 'Indian', 'Thanks', 'Thank', 'Regards', 'Congratulations', 'Hello', 'Hi', 'Dear']);
const BANNED = [
  [/\b(guarantee[ds]?|assured|assurance|100\s?%|definitely|for sure|surely|certain(?:ly)? (?:get|be))\b/i, 'It makes a promise.'],
  [/\b(salary|ctc|lpa|lakhs?|lacs?|per month|stipend|package|compensation|rupees|inr)\b|[₹]|\brs\.?\s?\d/i, 'It talks about pay.'],
  [/\b(urgent(?:ly)?|last chance|hurry|limited time|act now|immediately or)\b/i, 'It uses pressure words.'],
  [/\b(you (?:will|are going to) (?:get|receive) the job|job is yours|you are hired|we will hire you)\b/i, 'It promises the job.'],
];
const norm = (s) => String(s || '').replace(/[,]/g, '');
const numbersIn = (t) => (String(t).match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));
const linksIn = (t) => (String(t).match(/https?:\/\/[^\s)]+|www\.[^\s)]+/gi) || []).map((l) => l.replace(/[.,;]+$/, '').toLowerCase());
const wordsOf = (t) => new Set((String(t).match(/[A-Za-z][A-Za-z'-]{1,}/g) || []));

// -> { text, dropped: [{line, why}], kept }
function checkText(raw, facts, { blockNames = [], extraCorpus = '' } = {}) {
  const corpus = `${JSON.stringify(facts)} ${extraCorpus}`;
  const okNums = new Set(numbersIn(norm(corpus)));
  const okLinks = new Set(linksIn(corpus));
  const okWords = wordsOf(corpus);
  // eslint-disable-next-line global-require
  const { lintHit } = require('./jobText');
  const dropped = [];
  const keep = [];
  const lines = String(raw == null ? '' : raw).replace(/\r/g, '').split('\n');
  lines.forEach((line) => {
    if (!line.trim()) { keep.push(''); return; }
    const parts = line.split(/(?<=[.!?])\s+/);
    const good = [];
    parts.forEach((p) => {
      const s = p.trim();
      if (!s) return;
      const why = (() => {
        const badNum = numbersIn(norm(s)).filter((n) => !okNums.has(n));
        if (badNum.length) return `The number ${badNum[0]} is not in the facts.`;
        const badLink = linksIn(s).filter((l) => !okLinks.has(l));
        if (badLink.length) return 'It has a link that is not in the facts.';
        const hit = blockNames.find((n) => n && s.toLowerCase().includes(String(n).toLowerCase()));
        if (hit) return 'It names the client.';
        for (const [re, w] of BANNED) if (re.test(s)) return w;
        const l = lintHit(s);
        if (l) return l.why;
        // an invented name: a capitalised word in the middle of a sentence that is not in the facts
        const tokens = s.match(/(?<=[a-z,;:)]\s)[A-Z][a-z]{2,}\b/g) || [];
        const odd = tokens.find((tk) => !okWords.has(tk) && !COMMON.has(tk));
        if (odd) return `The name "${odd}" is not in the facts.`;
        return null;
      })();
      if (why) dropped.push({ line: s.slice(0, 140), why }); else good.push(s);
    });
    if (good.length) keep.push(good.join(' '));
  });
  return { text: keep.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

// Cut to a channel's length at a sentence end.
function fit(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (at > 40 ? cut.slice(0, at + 1) : cut).trim();
}

const maxWordsOf = (channel) => (channel === 'Email' ? 110 : 55);
const maxCharsOf = (channel) => (channel === 'Email' ? 3000 : channel === 'WhatsApp' ? 900 : 300);

async function aiReady() {
  try {
    // eslint-disable-next-line global-require
    const ai = require('./ai');
    const s = await ai.checkStatus();
    return { available: !!(s && s.available && s.modelPulled !== false), reason: s && !s.available ? s.reason : null, provider: s ? s.provider : null };
  } catch (e) { return { available: false, reason: String((e && e.message) || e).slice(0, 160), provider: null }; }
}

// Can a rule use AI on this channel? -> { ok, reason }
function channelAllowsAi(channel, { windowOpen = false } = {}) {
  if (channel === 'Email') return { ok: true, reason: null };
  if (channel === 'WhatsApp') {
    return windowOpen ? { ok: true, reason: null }
      : { ok: false, reason: 'WhatsApp can only start a chat with a template Meta approved, so the template is used. (AI wording works inside the 24 hours after the person writes to us.)' };
  }
  return { ok: false, reason: 'SMS needs a registered (DLT) template, so the template is used.' };
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`The AI did not answer in ${Math.round(ms / 1000)} seconds.`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

// -> { ok: true, subject, body, dropped } | { ok: false, reason }
async function write({
  channel, language = 'English', facts, instruction = '', blockNames = [], templateText = '', timeoutSeconds = 25,
}) {
  const status = await aiReady();
  if (!status.available) return { ok: false, reason: status.reason || 'No AI model is connected.' };
  let raw;
  try {
    // eslint-disable-next-line global-require
    const ai = require('./ai');
    const extra = String(instruction || '').trim().slice(0, 300);
    const user = JSON.stringify({ facts, channel, extraInstructionFromManager: extra || undefined });
    raw = await withTimeout(Promise.resolve(ai.chatJson(SYSTEM(language, maxWordsOf(channel)), [{ role: 'user', content: user }])), timeoutSeconds * 1000);
  } catch (e) { return { ok: false, reason: `The AI could not write it: ${String((e && e.message) || e).slice(0, 140)}` }; }
  const obj = raw && typeof raw === 'object' ? raw : {};
  const body0 = typeof obj.body === 'string' ? obj.body : '';
  if (!body0.trim()) return { ok: false, reason: 'The AI gave no text.' };
  const subj0 = channel === 'Email' && typeof obj.subject === 'string' ? obj.subject : '';
  const b = checkText(body0, facts, { blockNames, extraCorpus: templateText });
  const s = subj0 ? checkText(subj0.split('\n')[0], facts, { blockNames, extraCorpus: templateText }) : { text: '', dropped: [] };
  const dropped = [...b.dropped, ...s.dropped];
  let body = b.text;
  if (body.replace(/\s+/g, ' ').length < 25) {
    return { ok: false, reason: 'The AI text did not pass the safety check, so the template is used.', dropped };
  }
  // the recruiter's contact is always there (added by us, from real data, if the AI left it out)
  const contact = [facts.recruiterName, facts.recruiterPhone].filter(Boolean).join(', ');
  if (contact && !(facts.recruiterName && body.includes(facts.recruiterName)) && !(facts.recruiterPhone && body.includes(facts.recruiterPhone))) body = `${body}\n\n${contact}`;
  body = fit(body, maxCharsOf(channel));
  const subject = channel === 'Email' ? (s.text || `An update about ${facts.jobTitle || 'your application'}`).slice(0, 120) : null;
  return { ok: true, subject, body, dropped };
}

module.exports = {
  NEXT_STEP, buildFacts, checkText, write, aiReady, channelAllowsAi, SYSTEM, BANNED, maxCharsOf,
};
