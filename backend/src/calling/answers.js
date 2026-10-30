// ---------------------------------------------------------------------------
// ANSWERS FROM THE ATS (founder 2026-10-30: "memu return lo emaina questions adigithey kuda cheppali. telidhu ani
// cheppakudadhu, ats lo research chesi mari cheppali").
//
// A question in the middle of a call ("salary entha?", "timings enti?", "accommodation untundha?", "कब जॉइन करना है?")
// is answered from what the ATS holds for THIS requirement: its fields (salary, location, work mode, job type, experience,
// qualification, openings, joining) and the lines of its description (timings, days a week, accommodation, food, transport,
// PF, leave, incentives ...), plus the answers recruiters wrote in AI Calling > Questions (calling/knowledge.js).
// Nothing is made up: when the ATS truly has no answer the assistant says it will confirm with the team, and the question
// goes to the recruiter's Questions list - once answered there, every later call of that requirement knows it.
// The client's name follows the ATS rule (named once the interview is fixed); nothing about the job before the person is
// confirmed. Used when the AI brain is off or did not answer (dialogue.js).
// ---------------------------------------------------------------------------
const S = require('./scripts');

const norm = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[.,!?।"'`()]/g, ' ').replace(/\s+/g, ' ').trim();
const hasAny = (t, list) => { const p = ` ${t} `; return list.some((w) => (/^[\x00-\x7f]+$/.test(w) ? p.includes(` ${w} `) || (w.includes(' ') && p.includes(w)) : t.includes(w))); };

// how a thing is said on the phone: "1.2L" -> "1.2 lakh", "90000" -> "90 thousand", "9:00 to 4:00" -> "9 to 4"
function spoken(v) {
  return S.clean(String(v || '')
    .replace(/(\d+(?:\.\d+)?)\s*l\b/gi, '$1 lakh')
    .replace(/(\d+(?:\.\d+)?)\s*lpa\b/gi, '$1 lakh per year')
    .replace(/(\d+)\s*k\b/gi, '$1 thousand')
    .replace(/\b(\d{2,3})000\b/g, '$1 thousand')
    .replace(/\b(\d{1,2}):00\b/g, '$1')
    .replace(/\b(\d{1,2}):(\d{2})\b/g, '$1 $2')
    .replace(/\s*[-–]\s*(?=\d)/g, ' ')
    .replace(/\s*[:\-–]\s*$/g, ''), 160);
}

const descLines = (r) => `${(r && r.description) || ''}\n${(r && r.jobDescription) || ''}`.split(/\r?\n/).map((l) => l.trim())
  .filter((l) => l && !/^from the .*sheet|^earlier posting merged/i.test(l));
const findLines = (r, re, n = 2) => [...new Set(descLines(r).filter((l) => re.test(l)))].slice(0, n).map(spoken).join('. ');

// the pay line of THIS role in a "Package:" list ("Assistant professor -1.2L" for an Assistant Professor job)
function salaryOf(d, r) {
  if (d.data && d.data.salary) return spoken(d.data.salary);
  const lines = descLines(r).filter((l) => /\d/.test(l) && /(\d+(\.\d+)?\s*(l|lpa|k|lakh|thousand)\b|\b\d{4,6}\b|₹|rs\.?\s*\d)/i.test(l) && !/bed|capacity|row|tab|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/i.test(l));
  if (!lines.length) return '';
  const title = norm(r && r.title).replace(/[—–-].*$/, '').trim();
  // the most specific label wins: "Assistant professor" over "Professor" for an Assistant Professor job
  const labelOf = (l) => norm(l.replace(/[-–:]?\s*\d.*$/, ''));
  const near = (a, b) => { // spelling slips in the sheet ("Senor Residence" for Senior Resident)
    const m = a.length; const n = b.length; const dp = Array.from({ length: m + 1 }, (_, x) => [x, ...new Array(n).fill(0)]);
    for (let y = 1; y <= n; y += 1) dp[0][y] = y;
    for (let x = 1; x <= m; x += 1) for (let y = 1; y <= n; y += 1) dp[x][y] = Math.min(dp[x - 1][y] + 1, dp[x][y - 1] + 1, dp[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
    return dp[m][n] <= Math.min(3, Math.floor(Math.min(m, n) / 4));
  };
  const fits = (l) => { const label = labelOf(l); return label.length >= 4 && title && (title.includes(label) || label.includes(title) || near(label, title)); };
  const mine = lines.filter(fits).sort((a, b) => labelOf(b).length - labelOf(a).length)[0];
  if (mine) return spoken(mine.replace(/^[^\d₹]*?(?=[-–:]?\s*[\d₹])/, '').replace(/^[-–:\s]+/, ''));
  // pay listed per role but none is this role: never another role's pay (the team confirms instead)
  if (lines.filter((l) => labelOf(l).length >= 3).length > 1) return '';
  return spoken(lines[0]);
}

// what the person asked about: [topic, ...]; the first that the ATS can answer wins
const TOPICS = [
  { key: 'who', words: ['who are you', 'who is this', 'where are you calling from', 'which company are you', 'ఎవరు మీరు', 'మీరు ఎవరు', 'ఎక్కడి నుంచి', 'ఎవరండి', 'కౌన్', 'आप कौन', 'कौन बोल', 'कहाँ से', 'कहां से'], anytime: true },
  { key: 'salary', words: ['salary', 'pay', 'package', 'ctc', 'stipend', 'per month', 'how much', 'సాలరీ', 'జీతం', 'ప్యాకేజ్', 'ఎంత ఇస్తారు', 'పేమెంట్', 'सैलरी', 'पैकेज', 'वेतन', 'तनख्वाह', 'कितना देंगे', 'पेमेंट', 'jeetham', 'salary entha'] },
  { key: 'timings', words: ['timing', 'timings', 'hours', 'shift', 'duty', 'working time', 'days a week', 'టైమింగ్', 'టైమింగ్స్', 'షిఫ్ట్', 'డ్యూటీ', 'వర్కింగ్ టైమ్', 'ఎన్ని గంటలు', 'टाइमिंग', 'शिफ्ट', 'ड्यूटी', 'कितने घंटे', 'kitne ghante', 'timings enti'] },
  { key: 'accommodation', words: ['accommodation', 'hostel', 'room', 'stay', 'quarters', 'అకామడేషన్', 'రూమ్', 'హాస్టల్', 'క్వార్టర్స్', 'ఉండడానికి', 'रहने', 'रूम', 'हॉस्टल', 'क्वार्टर'] },
  { key: 'food', words: ['food', 'meals', 'lunch', 'canteen', 'ఫుడ్', 'భోజనం', 'క్యాంటీన్', 'खाना', 'कैंटीन'] },
  { key: 'transport', words: ['transport', 'bus', 'cab', 'pickup', 'ట్రాన్స్‌పోర్ట్', 'బస్', 'క్యాబ్', 'ट्रांसपोर्ट', 'बस', 'कैब'] },
  { key: 'benefits', words: ['pf', 'esi', 'insurance', 'leave', 'leaves', 'holiday', 'week off', 'incentive', 'bonus', 'benefits', 'పీఎఫ్', 'లీవ్', 'సెలవు', 'ఇన్సెంటివ్', 'బోనస్', 'पीएफ', 'छुट्टी', 'लीव', 'इंसेंटिव', 'बोनस'] },
  { key: 'location', words: ['where', 'location', 'address', 'place', 'which city', 'which area', 'ఎక్కడ', 'లొకేషన్', 'అడ్రస్', 'ఏ ఊరు', 'ఏ ఏరియా', 'कहाँ', 'कहां', 'लोकेशन', 'पता', 'कौन सी जगह', 'ekkada', 'kahan'] },
  { key: 'workMode', words: ['work from home', 'wfh', 'remote', 'hybrid', 'office', 'వర్క్ ఫ్రమ్ హోమ్', 'ఇంటి నుంచి', 'ఆఫీస్', 'घर से', 'वर्क फ्रॉम होम', 'ऑफिस'] },
  { key: 'jobType', words: ['full time', 'part time', 'permanent', 'contract', 'temporary', 'ఫుల్ టైమ్', 'పార్ట్ టైమ్', 'పర్మనెంట్', 'కాంట్రాక్ట్', 'फुल टाइम', 'पार्ट टाइम', 'परमानेंट', 'कॉन्ट्रैक्ट'] },
  { key: 'qualification', words: ['qualification', 'education', 'degree', 'eligib', 'study', 'studied', 'క్వాలిఫికేషన్', 'చదువు', 'డిగ్రీ', 'ఎలిజిబుల్', 'क्वालिफिकेशन', 'पढ़ाई', 'डिग्री', 'एलिजिबल'] },
  { key: 'experienceNeeded', words: ['experience needed', 'experience required', 'how much experience', 'fresher', 'freshers', 'ఎంత ఎక్స్‌పీరియన్స్', 'ఫ్రెషర్స్', 'ఎక్స్‌పీరియన్స్ కావాలా', 'कितना एक्सपीरियंस', 'फ्रेशर'] },
  { key: 'openings', words: ['how many posts', 'how many openings', 'vacancies', 'openings', 'positions', 'ఎన్ని పోస్ట్', 'ఎన్ని ఓపెనింగ్', 'ఎంత మంది', 'कितनी पोस्ट', 'कितनी वैकेंसी', 'कितने लोग'] },
  { key: 'joining', words: ['joining', 'when to join', 'join when', 'start date', 'జాయినింగ్', 'ఎప్పుడు జాయిన్', 'జాయిన్ అవ్వాలి', 'जॉइनिंग', 'कब जॉइन', 'kab join'] },
  { key: 'company', words: ['company', 'client', 'hospital name', 'college name', 'which hospital', 'which college', 'organisation', 'organization', 'కంపెనీ', 'హాస్పిటల్', 'కాలేజ్', 'ఏ హాస్పిటల్', 'ఏ కాలేజ్', 'कंपनी', 'हॉस्पिटल', 'कॉलेज', 'कौन सी कंपनी'] },
  { key: 'role', words: ['what work', 'what is the work', 'job role', 'responsibilities', 'duties', 'what to do', 'ఏం పని', 'పని ఏంటి', 'వర్క్ ఏంటి', 'ఏం చేయాలి', 'क्या काम', 'काम क्या', 'क्या करना'] },
  { key: 'interview', words: ['interview', 'ఇంటర్వ్యూ', 'इंटरव्यू'] },
];
// does it sound like a question? (a statement that holds a topic word - "I live in Hyderabad" - is an answer, not a question)
const Q_MARK = ['what', 'where', 'when', 'which', 'how', 'is there', 'is it', 'do you', 'do they', 'will', 'can i', 'any',
  'ఏంటి', 'ఎంత', 'ఎక్కడ', 'ఎప్పుడు', 'ఎన్ని', 'ఏ ', 'ఉందా', 'ఉంటుందా', 'ఇస్తారా', 'కావాలా', 'ఉంటాయా', 'చేయాలా', 'చెప్తారా', 'ఎలా',
  'क्या', 'कितना', 'कितनी', 'कितने', 'कहाँ', 'कहां', 'कब', 'कौन', 'मिलेगा', 'मिलेगी', 'है क्या', 'kya', 'kitna', 'entha', 'enti', 'ekkada', 'unda', 'untunda', 'kab'];
function looksQuestion(text) {
  const raw = String(text || '');
  if (/[?？]\s*$/.test(raw.trim())) return true;
  return hasAny(norm(raw), Q_MARK);
}
function topicOf(text) {
  const t = norm(text);
  return TOPICS.filter((x) => hasAny(t, x.words)).map((x) => x.key);
}

const SAY = {
  English: {
    who: "I'm calling from TeamLink Consultants, a recruitment company in Hyderabad.",
    salary: 'The salary is {v}.', timings: 'The timings are: {v}.', line: '{v}.', location: "It's in {v}.", workMode: "It's {v}.",
    jobType: "It's a {v} job.", qualification: 'The qualification needed is {v}.', experienceNeeded: 'They want {v} of experience.',
    openings: 'There are {v} openings.', oneOpening: 'There is one opening.', joining: 'Joining is {v}.', companyInternal: "It's a job with TeamLink itself.",
    companyLater: 'The recruiter shares the company name and full details once the interview is fixed.', role: 'The work is mainly {v}.',
    interviewNone: "If you're interested, the recruiter will fix the interview and tell you the details.",
    willCheck: 'Let me confirm that with the team and get back to you.',
  },
  Telugu: {
    who: 'నేను టీమ్‌లింక్ కన్సల్టెంట్స్ నుంచి, హైదరాబాద్‌లో రిక్రూట్‌మెంట్ కంపెనీ.',
    salary: 'సాలరీ {v} వరకు ఉంటుంది.', timings: 'టైమింగ్స్: {v}.', line: '{v}.', location: 'జాబ్ {v} లో.', workMode: '{v}.',
    jobType: '{v} జాబ్.', qualification: 'క్వాలిఫికేషన్ {v} ఉండాలి.', experienceNeeded: '{v} ఎక్స్‌పీరియన్స్ కావాలి.',
    openings: 'మొత్తం {v} పోస్ట్‌లు ఉన్నాయి.', oneOpening: 'ఒక్క పోస్ట్ ఉంది.', joining: 'జాయినింగ్ {v}.', companyInternal: 'ఇది టీమ్‌లింక్‌లోనే జాబ్.',
    companyLater: 'కంపెనీ పేరు, పూర్తి డీటెయిల్స్ ఇంటర్వ్యూ ఫిక్స్ అయినప్పుడు రిక్రూటర్ చెప్తారు.', role: 'పని మెయిన్‌గా {v}.',
    interviewNone: 'మీకు ఇంట్రెస్ట్ ఉంటే, రిక్రూటర్ ఇంటర్వ్యూ ఫిక్స్ చేసి డీటెయిల్స్ చెప్తారు.',
    willCheck: 'అది టీమ్‌తో కన్ఫర్మ్ చేసుకుని మీకు చెప్తా.',
  },
  Hindi: {
    who: 'मैं टीमलिंक कंसल्टेंट्स से बोल रहा हूँ, हैदराबाद की रिक्रूटमेंट कंपनी।',
    salary: 'सैलरी {v} तक है।', timings: 'टाइमिंग्स: {v}।', line: '{v}।', location: 'जॉब {v} में है।', workMode: '{v} है।',
    jobType: '{v} जॉब है।', qualification: 'क्वालिफिकेशन {v} चाहिए।', experienceNeeded: '{v} का एक्सपीरियंस चाहिए।',
    openings: 'कुल {v} पोस्ट हैं।', oneOpening: 'एक ही पोस्ट है।', joining: 'जॉइनिंग {v} है।', companyInternal: 'ये टीमलिंक में ही जॉब है।',
    companyLater: 'कंपनी का नाम और पूरी डिटेल्स इंटरव्यू फिक्स होने पर रिक्रूटर बताएँगे।', role: 'काम मेनली {v} है।',
    interviewNone: 'अगर इंटरेस्ट है, तो रिक्रूटर इंटरव्यू फिक्स करके डिटेल्स बताएँगे।',
    willCheck: 'वो मैं टीम से कन्फर्म करके आपको बताता हूँ।',
  },
};

// the recruiters' own answers (AI Calling > Questions) for this requirement, matched by topic or shared words
const TOPIC_EN = {
  salary: /salary|pay|package|ctc/i, timings: /timing|shift|hours|duty/i, accommodation: /accommodation|hostel|room|stay|quarters/i, food: /food|meal|canteen/i,
  transport: /transport|bus|cab/i, benefits: /pf|esi|insurance|leave|holiday|incentive|bonus|week off/i, location: /location|address|where/i, workMode: /work from home|remote|hybrid/i,
  jobType: /full time|part time|permanent|contract/i, qualification: /qualif|degree|education|eligib/i, joining: /join/i, company: /company|client|hospital|college/i, role: /work|role|duties/i,
};
function fromKnowledge(d, topics, text) {
  const kb = Array.isArray(d.knowledge) ? d.knowledge : [];
  for (const t of topics) { const hit = kb.find((k) => TOPIC_EN[t] && TOPIC_EN[t].test(k.q || '')); if (hit) return hit.a; }
  const words = norm(text).split(' ').filter((w) => w.length > 3);
  const hit = kb.find((k) => { const q = norm(k.q); return words.filter((w) => q.includes(w)).length >= 2; });
  return hit ? hit.a : null;
}

// d: the Dialogue; text: what the person said. -> { say, topic, unknown } or null (not a question about the job)
function answer(d, text, { requirement } = {}) {
  const topics = topicOf(text);
  const isQ = looksQuestion(text);
  if (!topics.length && !isQ) return null;
  if (!topics.length) return { say: (SAY[d.language] || SAY.English).willCheck, topic: null, unknown: true };
  const P = SAY[d.language] || SAY.English;
  const x = d.data || {};
  const r = requirement || d.requirement || {};
  const fill = (k, v) => S.fill(P[k], { v: S.clean(v, 160) });
  const kb = fromKnowledge(d, topics, text);
  for (const t of topics) {
    let v = '';
    switch (t) {
      case 'who': return { say: P.who, topic: t };
      case 'salary': v = d.fields && d.fields.includeSalary === false ? '' : salaryOf(d, r); if (v) return { say: fill('salary', v), topic: t }; break;
      case 'timings': v = findLines(r, /timing|shift|working hours|duty hours|\bdays? a week\b|\d{1,2}[:.]?\d{0,2}\s*(am|pm)?\s*(to|-|–)\s*\d{1,2}[:.]?\d{0,2}\s*(am|pm)?/i); if (v) return { say: fill('timings', v), topic: t }; break;
      case 'accommodation': v = findLines(r, /accommodat|hostel|quarters|\broom\b|stay/i, 1); if (v) return { say: fill('line', v), topic: t }; break;
      case 'food': v = findLines(r, /food|meal|lunch|canteen/i, 1); if (v) return { say: fill('line', v), topic: t }; break;
      case 'transport': v = findLines(r, /transport|\bbus\b|\bcab\b|pick ?up/i, 1); if (v) return { say: fill('line', v), topic: t }; break;
      case 'benefits': v = findLines(r, /\bpf\b|\besi\b|insurance|leave|holiday|week ?off|incentive|bonus/i); if (v) return { say: fill('line', v), topic: t }; break;
      case 'location': v = x.location || (x.interview && x.interview.location) || ''; if (v) return { say: fill('location', v), topic: t }; break;
      case 'workMode': v = x.workMode; if (v) return { say: fill('workMode', v), topic: t }; break;
      case 'jobType': v = x.employmentType; if (v) return { say: fill('jobType', v), topic: t }; break;
      case 'qualification': v = r.education || r.qualifications || findLines(r, /qualification|degree|eligib/i, 1).replace(/^qualification\s*/i, ''); if (v) return { say: fill('qualification', v), topic: t }; break;
      case 'experienceNeeded': v = x.experience; if (v) return { say: fill('experienceNeeded', v), topic: t }; break;
      case 'openings': if (r.openings === 1) return { say: P.oneOpening, topic: t }; v = r.openings > 1 ? String(r.openings) : ''; if (v) return { say: fill('openings', v), topic: t }; break;
      case 'joining': v = r.joiningTimeline ? spoken(r.joiningTimeline) : ''; if (v) return { say: fill('joining', v.toLowerCase()), topic: t }; break;
      case 'company': return { say: r.internal ? P.companyInternal : P.companyLater, topic: t };
      case 'role': v = x.responsibilities || x.needs || x.skills; if (v) return { say: fill('role', v), topic: t }; break;
      case 'interview':
        if (x.interview && x.interview.at) return { say: S.fill(S.phrases(d.language).shortIv, { date: S.dateWords(x.interview.at, d.language), time: S.timeWords(x.interview.at, d.language) }), topic: t };
        return { say: P.interviewNone, topic: t };
      default: break;
    }
    if (kb) return { say: S.clean(kb, 220), topic: t, fromRecruiter: true };
  }
  if (kb) return { say: S.clean(kb, 220), topic: topics[0], fromRecruiter: true };
  // the ATS truly has nothing on it: no guess - "I'll confirm with the team", and the question goes to the recruiter
  return { say: P.willCheck, topic: topics[0], unknown: true };
}

module.exports = { answer, topicOf, looksQuestion, salaryOf, spoken, TOPICS };
