// ---------------------------------------------------------------------------
// A VACANCY, NOT A SCRIPT (founder 2026-11-05: "just a script in English - the job vacancy details - and the AI builds the conversation and talks to the candidates").
//
// The team gives the FACTS of an opening in one place, in English:
//     This is an automated AI call.  Role: HR Recruiter; Company: Teamlink Consultants; Location: Kukatpally; Salary: 10K per month;
//     Qualification: Any graduate; Details: sourcing candidates, screening resumes; Contact: Anil Ravali; Next: share your resume on WhatsApp
// and the call is built from them: greeting, "do you have a minute?", the vacancy, "are you interested?", the next step, a try to convince when the answer is no,
// a kind close - in English, Telugu AND Hindi from built-in phrases (nothing is machine-translated, so it is quick and the facts cannot go wrong), and a
// person's questions about the pay, the place, the qualification and the role are answered from the facts. Keys: Role, Company, Location, Salary, Qualification,
// Experience, Details, Benefits, Contact, Next, Language (the language the call starts in: English / Telugu / Hindi).
//
// HOW THE CALL GOES (founder 2026-11-05, the "AI Voice Calling Agent" and "Professional AI" documents: "ee document lo vunnattu matladali ai"): name confirmed -> which language -> who is calling,
// two minutes? -> the vacancy, of interest? -> one question at a time (experience, the industry, qualification, working?, notice period, salary, location) -> questions? -> what was
// noted is read back -> the resume -> a kind close. More keys: Caller (the name the assistant gives, Bhavana by default), Industry (manufacturing), Client (for the team only: THE CLIENT'S NAME IS NEVER SAID),
// Work mode, Interview, Notice period, Vacancies, Key requirement, Persuasion, Channel. It says it is an AI assistant: that is not hidden from anybody.
// ---------------------------------------------------------------------------
const KEYS = {
  role: 'role|position|post|job|designation|vacancy', company: 'company|organization|organisation|firm', location: 'location|place|city|area',
  salary: 'salary|pay|package|ctc', qualification: 'qualification|education', experience: 'experience', details: 'details|responsibilities|duties|work',
  benefits: 'benefits|perks', vacancies: 'vacancies|openings|no of vacancies|number of vacancies', keyreq: 'key requirement|requirement|note', persuasion: 'persuasion|hook|advantage|upside', channel: 'channel|contact channel',
  contact: 'contact|recruiter|manager|contact person', next: 'next|next step', language: 'language|start language',
  caller: 'caller|caller name|agent name', client: 'client|client name|hiring company|employer', industry: 'industry|sector', interview: 'interview|interview mode',
  workmode: 'work mode|workmode|mode of work', notice: 'notice|notice period', reqlang: 'languages|languages required|required languages|language requirement|languages needed|known languages',
};
const ALL = Object.values(KEYS).join('|');
const KEY_OF = Object.entries(KEYS).map(([k, v]) => [k, new RegExp(`^(${v})$`, 'i')]);

/** { role, company, ... } when the text is the facts of a vacancy (a role and at least two other facts), else null. */
function parseFacts(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r/g, '\n');
  const re = new RegExp(`(?:^|[\\s;|,.])(${ALL})\\s*[:=]\\s*([^;|\\n]*?)(?=\\s*(?:[;|\\n]|(?:^|\\s)(?:${ALL})\\s*[:=]|$))`, 'gi');
  const facts = {};
  let m = re.exec(text);
  while (m) {
    const key = (KEY_OF.find(([, r]) => r.test(m[1].trim())) || [])[0];
    // a pasted paragraph ends where its next heading begins ("... hiring process Interest check Are you interested ...")
    let value = m[2].split(/[“”"]|\b(?:interest check|if interested|if not interested|if yes|closing)\b/i)[0].replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
    const max = ['details', 'benefits', 'next', 'persuasion', 'keyreq', 'interview', 'workmode'].includes(key) ? 300 : 70;
    if (value.length > max) value = value.slice(0, max).replace(/[,;\s][^,;\s]*$/, '').trim();
    if (key && value && !facts[key]) facts[key] = value;
    m = re.exec(text);
  }
  const n = Object.keys(facts).length;
  return facts.role && n >= 3 ? facts : null;
}

// THE WORDS OF THE CALL: the founder's "AI Voice Calling Agent" document (2026-11-05), in English, Telugu and Hindi. One question at a time; the client's name is never said.
const L = {
  English: {
    open: () => '{greet}, am I speaking with {name}?',
    lang: () => 'Thank you for confirming. Before we continue, which language are you most comfortable with: English, Hindi, Telugu, or a mix?',
    langOk: () => 'Perfect, I will continue in English.',
    intro: (f) => `This is ${f.caller}, an AI assistant calling from ${f.company}, on behalf of our recruitment team.`,
    perm: () => 'I have a job opportunity to share. Do you have two minutes?',
    say: (f) => `We have an opening for ${f.role}${f.industry ? ` with a ${f.industry} company` : ''}${f.location ? `, based in ${f.location}` : ''}.${f.details ? ` The role involves ${f.details}.` : ''}`,
    say2: (f) => `${f.qualification ? `They are looking for ${f.qualification}.` : ''}${f.experience ? ` The experience needed is around ${f.experience}.` : ''}${f.salary ? ` The salary is ${f.salary}.` : ''}${f.vacancies ? ` There are ${f.vacancies} positions open right now.` : ''}${f.keyreq ? ` One thing to flag for this role: ${f.keyreq}.` : ''}`.trim(),
    interest: () => 'Would this be of interest to you?',
    exp: () => 'How many years of relevant experience do you have?',
    ind: (f) => `Is your experience in a ${f.industry} company?`,
    indOther: () => 'That is perfectly fine. Which industry have you worked in?',
    duties: () => 'Thank you. Could you briefly tell me about your work in your current or previous company?',
    edu: () => 'What is your highest qualification?',
    work: () => 'Are you currently working?',
    notice: () => 'What is your notice period?',
    sal: () => 'What is your current and expected salary?',
    loc: (f) => (f.location ? `Are you based in ${f.location} already, or would this need relocation?` : 'Where are you currently located?'),
    doubt: () => 'Do you have any questions about this job?',
    next: (f) => `That is great. ${f.next ? `${cap(f.next)}.` : `Could you share your updated resume on ${f.channel}? Our team will review it and reach out about next steps.`}`,
    close: () => 'Thank you for your time, {name}. We will be in touch soon. Have a good day.',
    reason: () => 'No problem. May I know if there is a specific reason, such as location, salary, role, or career plans? This will help us find more suitable opportunities for you.',
    keep: () => 'No problem at all, thank you for letting me know. If a more suitable opening comes up, may I reach out again?',
    bye: () => 'Thank you. We appreciate your time and wish you the very best in your career. Have a good day.',
    wrong: () => 'I apologize for the inconvenience. Thank you for letting me know. Have a good day.',
    cbq: () => 'No problem. When would be a better time to call you back?',
    cbok: () => 'Certainly. I will schedule a call back for then. Thank you for your time. Have a great day.',
    near: (f) => `Excellent, ${f.location} suits you.`,
    fits: () => 'That fits the range.',
    budgetNote: (f) => `Thank you. The current budget for this role is up to ${f.budget}. I will note your expectation for our recruitment team.`,
    budget: (f) => `I understand, thank you for sharing that.${f.persuasion ? ` ${cap(f.persuasion)}.` : ''} The current budget for this role is up to ${f.budget}. If there is any flexibility from the company side after profile evaluation, our recruitment team will discuss it with you. Would you still like to proceed?`,
    budgetYes: () => 'Great. I will note your salary expectation and share it with our recruitment team.',
    prefloc: () => 'I understand. May I know your preferred work location?',
    reloc: (f) => `Thank you for sharing that. This position is based in ${f.location}. Would you be open to relocating if the role and career growth are suitable?`,
    locKeep: () => 'No problem. I will note your location preference and keep your profile for suitable opportunities closer to you.',
    both: () => 'I understand, thank you for your feedback. May I know your expected salary and preferred location, so that we can consider you for more suitable opportunities?',
    bothKeep: () => 'Thank you, I have noted your preferences. With your permission, we will keep your profile in our database and contact you if we receive matching opportunities. Is that okay?',
    objExp: () => 'No problem, I have noted that. I will check if there is a role that is a closer match to your current level and get back to you. Thank you for your time.',
    objJob: (f) => `I completely understand. Many professionals prefer to explore opportunities even when they are not actively looking.${f.details ? ` This role offers exposure to ${f.details}.` : ''} Would you be open to reviewing the details and deciding later?`,
    detailsOk: () => 'Certainly. Our team will share the job details on WhatsApp. Please review them at your convenience, and we can discuss further if you are interested. Thank you for your time.',
    objTrust: (f) => `That is a fair question. Yes, this is a confirmed requirement from ${f.who}${f.location ? ` in ${f.location}` : ''}. Our team can also share the job description and contact details on WhatsApp for your reference.`,
    family: () => 'Certainly, this is an important decision and I completely understand. Would it be helpful if our team shared the job details on WhatsApp, so you can review them?',
    followup: () => 'Great, our team will send the details. May I follow up with you in two days?',
    followupOk: () => 'Thank you. We will connect with you again in two days. Have a good day.',
    studies: () => 'That is wonderful, I wish you success in your studies. I will update our records accordingly. If you are looking for opportunities in the future, we would be happy to assist you. Have a great day.',
    wfhKeep: () => 'Understood, I will note your preference. With your permission, we will contact you if suitable work from home roles become available. Is that okay?',
    company: (f) => `This opportunity is with ${f.who}${f.location ? ` in ${f.location}` : ''}. Once your profile matches the requirement, our recruitment team will share the complete company details and interview process.`,
    benefits: () => 'That is a good question. I do not have the complete benefits information right now. Our recruitment team can give you accurate details about insurance, leave policy, incentives and other benefits in the next stage.',
    interview: () => 'The interview mode is decided by the hiring team. It may be online, offline, or in multiple rounds, depending on the company process. If the exact mode is finalized, our recruitment team will share it with you before scheduling.',
    ivPref: () => 'Understood. I will note your preference and share it with our recruitment team. The final interview mode will be confirmed by the company.',
    ivTravel: () => 'Thank you for letting me know. I will inform our recruitment team and check whether an online interview option is available.',
    noticeLong: (f) => `Thank you for sharing that. This position prefers candidates who can join within ${f.notice}. However, I will note your notice period and discuss it with the hiring team.`,
    unknown: () => 'That is a good question. I do not have that detail in front of me, but our recruiter will confirm it with you directly.',
    aiYes: () => 'Yes, I am an AI assistant calling for our recruitment team. A recruiter will follow up with you personally.',
    sum: (a) => `Let me confirm what I noted. ${a.loc ? `Location, ${a.loc}. ` : ''}${a.exp ? `Experience, ${a.exp}. ` : ''}${a.edu ? `Qualification, ${a.edu}. ` : ''}${a.work ? `Working and notice period, ${a.work}. ` : ''}${a.sal ? `Salary, ${a.sal}. ` : ''}Is that correct?`,
    sumFix: () => 'Okay, I will note the correction for our team.',
    calm: () => 'I understand, I am sorry for the trouble. Thank you for your time. Goodbye.',
    langs: () => 'Which languages can you speak?',
    langMatch: (x) => `Perfect! This job role needs ${x} as well.`,
    langNo: (f) => `Okay, noted. This job role needs ${f.reqlang}.`,
    numWhere: (f) => (/\d/.test(f.channel) ? `Please send it to ${f.channel}. Will you be able to send it today?` : 'Our recruiter will send you the number on WhatsApp right after this call. Will you be able to send your resume there?'),
  },
  Telugu: {
    open: () => '{greet}, {name} గారేనా మాట్లాడేది?',
    lang: () => 'థాంక్స్. తెలుగులో మాట్లాడదామా, ఇంగ్లీష్ లోనా, హిందీ లోనా? లేక మిక్స్ చేసి మాట్లాడదామా?',
    langOk: () => 'సరే, తెలుగులో మాట్లాడుతాను.',
    intro: (f) => `నేను ${f.caller}, ${f.company} నుండి, AI అసిస్టెంట్‌ని.`,
    perm: () => 'ఒక జాబ్ గురించి చెప్దామని కాల్ చేశాను. రెండు నిమిషాలు మాట్లాడొచ్చా?',
    say: (f) => `${f.industry ? `${f.industry} కంపెనీలో ` : ''}${f.role} ఓపెనింగ్ ఉంది${f.location ? `, ${f.location} లో` : ''}.${f.details ? ` పని ఏంటంటే ${f.details}.` : ''}`,
    say2: (f) => `${f.qualification ? `క్వాలిఫికేషన్ ${f.qualification}.` : ''}${f.experience ? ` ఎక్స్‌పీరియన్స్ సుమారు ${f.experience} కావాలి.` : ''}${f.salary ? ` సాలరీ ${f.salary}.` : ''}${f.vacancies ? ` ఇప్పుడు ${f.vacancies} పొజిషన్లు ఉన్నాయి.` : ''}${f.keyreq ? ` ఈ రోల్‌కి ఒక ముఖ్యమైన విషయం: ${f.keyreq}.` : ''}`.trim(),
    interest: () => 'ఇంట్రెస్ట్ ఉందా మీకు?',
    exp: () => 'ఎక్స్‌పీరియన్స్ ఎన్ని ఇయర్స్ ఉంది?',
    ind: (f) => `మీ ఎక్స్‌పీరియన్స్ ${f.industry} కంపెనీలోనేనా?`,
    indOther: () => 'పర్వాలేదు. మీరు ఏ ఇండస్ట్రీలో పని చేశారు?',
    duties: () => 'థాంక్స్. మీ కరెంట్ లేదా పాత కంపెనీలో మీరు చేసిన పని గురించి కొంచెం చెప్తారా?',
    edu: () => 'క్వాలిఫికేషన్ ఏంటి మీది?',
    work: () => 'ఇప్పుడు జాబ్ చేస్తున్నారా?',
    notice: () => 'నోటీస్ పీరియడ్ ఎంత?',
    sal: () => 'ఇప్పుడు సాలరీ ఎంత వస్తోంది? ఎంత ఎక్స్‌పెక్ట్ చేస్తున్నారు?',
    loc: (f) => (f.location ? `ఆల్రెడీ ${f.location} లోనే ఉంటున్నారా? లేక రీలొకేట్ అవ్వాలా?` : 'ఇప్పుడు ఎక్కడ ఉంటున్నారు?'),
    doubt: () => 'జాబ్ గురించి ఏమైనా అడగాలా? డౌట్స్ ఏమైనా ఉన్నాయా?',
    next: (f) => `సూపర్. మీ రెజ్యూమ్ ${f.channel} కి పంపుతారా? మా టీమ్ చూసి, నెక్స్ట్ ఏంటో మీకు కాల్ చేస్తారు.`,
    close: () => 'థాంక్స్ {name} గారు. త్వరలో కాల్ చేస్తాం. బై, హావ్ ఎ గుడ్ డే!',
    reason: () => 'పర్వాలేదు. ఏదైనా రీజన్ ఉందా? లొకేషన్, సాలరీ, రోల్... ఏదైనా? చెప్తే మీకు సరిపోయేది చూస్తాం.',
    keep: () => 'పర్వాలేదు, చెప్పినందుకు థాంక్స్. మీకు సరిపోయే ఓపెనింగ్ వస్తే మళ్ళీ కాంటాక్ట్ చేయవచ్చా?',
    bye: () => 'థాంక్స్. మీ టైమ్‌కి థాంక్స్, మీ కెరీర్‌కి ఆల్ ది బెస్ట్. హావ్ ఎ గుడ్ డే.',
    wrong: () => 'సారీ, ఇబ్బంది పెట్టాను. చెప్పినందుకు థాంక్స్. హావ్ ఎ గుడ్ డే.',
    cbq: () => 'పర్వాలేదు. మళ్ళీ ఎప్పుడు కాల్ చేయమంటారు?',
    cbok: () => 'సరే, ఆ టైమ్‌కి కాల్ చేస్తాను. మీ టైమ్‌కి థాంక్స్. హావ్ ఎ గుడ్ డే.',
    near: (f) => `చాలా మంచిది, ${f.location} మీకు సరిపోతుంది.`,
    fits: () => 'ఇది రేంజ్‌లోనే ఉంది.',
    budgetNote: (f) => `థాంక్స్. ఈ రోల్‌కి ఇప్పటి బడ్జెట్ ${f.budget} వరకు ఉంది. మీ ఎక్స్‌పెక్టేషన్ మా రిక్రూట్‌మెంట్ టీమ్‌కి నోట్ చేస్తాను.`,
    budget: (f) => `అర్థమైంది, చెప్పినందుకు థాంక్స్.${f.persuasion ? ` ${f.persuasion}.` : ''} ఈ రోల్‌కి ఇప్పటి బడ్జెట్ ${f.budget} వరకు ఉంది. ప్రొఫైల్ ఎవాల్యుయేషన్ తర్వాత కంపెనీ నుండి ఫ్లెక్సిబిలిటీ ఉంటే మా రిక్రూట్‌మెంట్ టీమ్ మీతో మాట్లాడుతుంది. మీరు ముందుకు వెళ్ళాలనుకుంటున్నారా?`,
    budgetYes: () => 'చాలా బాగుంది. మీ సాలరీ ఎక్స్‌పెక్టేషన్ నోట్ చేసి మా రిక్రూట్‌మెంట్ టీమ్‌కి చెప్తాను.',
    prefloc: () => 'అర్థమైంది. మీకు ఇష్టమైన వర్క్ లొకేషన్ ఏది?',
    reloc: (f) => `చెప్పినందుకు థాంక్స్. ఈ పొజిషన్ ${f.location} లో ఉంది. రోల్ మరియు కెరీర్ గ్రోత్ బాగుంటే రీలొకేట్ అవ్వడానికి మీరు రెడీనా?`,
    locKeep: () => 'పర్వాలేదు. మీ లొకేషన్ ప్రిఫరెన్స్ నోట్ చేసి, మీకు దగ్గరలో ఓపెనింగ్స్ వస్తే చెప్తాం.',
    both: () => 'అర్థమైంది, చెప్పినందుకు థాంక్స్. మీకు సరిపోయే ఆపర్చునిటీస్ కోసం మీ ఎక్స్‌పెక్టెడ్ సాలరీ, ఇష్టమైన లొకేషన్ చెప్తారా?',
    bothKeep: () => 'థాంక్స్, మీ ప్రిఫరెన్సెస్ నోట్ చేసుకున్నాను. మీరు ఓకే అంటే మీ ప్రొఫైల్ మా డేటాబేస్‌లో ఉంచి, సరిపోయే ఆపర్చునిటీ వస్తే కాంటాక్ట్ చేస్తాం. ఓకేనా?',
    objExp: () => 'పర్వాలేదు, నోట్ చేసుకున్నాను. మీ లెవెల్‌కి సరిపోయే రోల్ ఉంటే చూసి మళ్ళీ కాంటాక్ట్ చేస్తాను. మీ టైమ్‌కి థాంక్స్.',
    objJob: (f) => `అర్థమైంది. చాలా మంది జాబ్ వెతకకపోయినా ఆపర్చునిటీస్ చూస్తుంటారు.${f.details ? ` ఈ రోల్‌లో ${f.details} ఎక్స్‌పోజర్ ఉంటుంది.` : ''} డీటెయిల్స్ చూసి తర్వాత డిసైడ్ చేయడం ఓకేనా?`,
    detailsOk: () => 'సరే. మా టీమ్ జాబ్ డీటెయిల్స్ వాట్సాప్‌లో పంపిస్తుంది. మీకు వీలైనప్పుడు చూసి, ఇంట్రెస్ట్ ఉంటే మాట్లాడుకుందాం. మీ టైమ్‌కి థాంక్స్.',
    objTrust: (f) => `మంచి ప్రశ్న. అవును, ఇది ${f.who}${f.location ? ` ${f.location} లో` : ''} కన్ఫర్మ్డ్ రిక్వైర్‌మెంట్. మీ రిఫరెన్స్ కోసం మా టీమ్ జాబ్ డిస్క్రిప్షన్, కాంటాక్ట్ డీటెయిల్స్ వాట్సాప్‌లో కూడా పంపిస్తుంది.`,
    family: () => 'సరే, ఇది ముఖ్యమైన నిర్ణయం, అర్థమైంది. మీరు చూసుకోవడానికి మా టీమ్ జాబ్ డీటెయిల్స్ వాట్సాప్‌లో పంపిస్తే హెల్ప్ అవుతుందా?',
    followup: () => 'చాలా బాగుంది, మా టీమ్ డీటెయిల్స్ పంపిస్తుంది. రెండు రోజుల్లో మళ్ళీ ఫాలో అప్ చేయవచ్చా?',
    followupOk: () => 'థాంక్స్. రెండు రోజుల్లో మళ్ళీ కాంటాక్ట్ చేస్తాం. హావ్ ఎ గుడ్ డే.',
    studies: () => 'చాలా మంచిది, మీ స్టడీస్‌కి ఆల్ ది బెస్ట్. మా రికార్డ్స్ అప్‌డేట్ చేస్తాను. భవిష్యత్తులో ఆపర్చునిటీస్ కావాలంటే మేం హెల్ప్ చేస్తాం. హావ్ ఎ గుడ్ డే.',
    wfhKeep: () => 'అర్థమైంది, మీ ప్రిఫరెన్స్ నోట్ చేసుకున్నాను. మీరు ఓకే అంటే వర్క్ ఫ్రమ్ హోమ్ రోల్స్ వస్తే కాంటాక్ట్ చేస్తాం. ఓకేనా?',
    company: (f) => `ఈ ఆపర్చునిటీ ${f.who}${f.location ? ` ${f.location} లో` : ''} ఉంది. మీ ప్రొఫైల్ మ్యాచ్ అయ్యాక మా రిక్రూట్‌మెంట్ టీమ్ కంపెనీ పూర్తి డీటెయిల్స్, ఇంటర్వ్యూ ప్రాసెస్ చెప్తుంది.`,
    benefits: () => 'మంచి ప్రశ్న. బెనిఫిట్స్ పూర్తి వివరాలు ఇప్పుడు నా దగ్గర లేవు. ఇన్సూరెన్స్, లీవ్ పాలసీ, ఇన్సెంటివ్స్ గురించి నెక్స్ట్ స్టేజ్‌లో మా రిక్రూట్‌మెంట్ టీమ్ కరెక్ట్‌గా చెప్తుంది.',
    interview: () => 'ఇంటర్వ్యూ మోడ్ హైరింగ్ టీమ్ డిసైడ్ చేస్తుంది. కంపెనీ ప్రాసెస్‌ని బట్టి ఆన్‌లైన్, ఆఫ్‌లైన్ లేదా చాలా రౌండ్లలో ఉండవచ్చు. మోడ్ ఫైనల్ అయితే షెడ్యూల్ ముందే మా టీమ్ చెప్తుంది.',
    ivPref: () => 'అర్థమైంది. మీ ప్రిఫరెన్స్ నోట్ చేసి మా రిక్రూట్‌మెంట్ టీమ్‌కి చెప్తాను. ఫైనల్ ఇంటర్వ్యూ మోడ్ కంపెనీ కన్ఫర్మ్ చేస్తుంది.',
    ivTravel: () => 'చెప్పినందుకు థాంక్స్. మా రిక్రూట్‌మెంట్ టీమ్‌కి చెప్పి ఆన్‌లైన్ ఇంటర్వ్యూ ఆప్షన్ ఉందా చూస్తాను.',
    noticeLong: (f) => `చెప్పినందుకు థాంక్స్. ఈ పొజిషన్‌కి ${f.notice} లో జాయిన్ అయ్యేవాళ్ళను ప్రిఫర్ చేస్తారు. అయినా మీ నోటీస్ పీరియడ్ నోట్ చేసి హైరింగ్ టీమ్‌తో మాట్లాడతాను.`,
    unknown: () => 'మంచి ప్రశ్న. ఆ వివరం ఇప్పుడు నా దగ్గర లేదు, కానీ మా రిక్రూటర్ మీకు డైరెక్ట్‌గా కన్ఫర్మ్ చేస్తారు.',
    aiYes: () => 'అవును, నేను మా రిక్రూట్‌మెంట్ టీమ్ తరపున కాల్ చేస్తున్న AI అసిస్టెంట్‌ని. మా రిక్రూటర్ మీతో పర్సనల్‌గా మాట్లాడతారు.',
    sum: (a) => `నేను నోట్ చేసుకున్నది కన్ఫర్మ్ చేస్తాను. ${a.loc ? `లొకేషన్, ${a.loc}. ` : ''}${a.exp ? `ఎక్స్‌పీరియన్స్, ${a.exp}. ` : ''}${a.edu ? `క్వాలిఫికేషన్, ${a.edu}. ` : ''}${a.work ? `జాబ్ మరియు నోటీస్ పీరియడ్, ${a.work}. ` : ''}${a.sal ? `సాలరీ, ${a.sal}. ` : ''}ఇది కరెక్టేనా?`,
    sumFix: () => 'సరే, ఆ కరెక్షన్ మా టీమ్‌కి చెప్తాను.',
    calm: () => 'అర్థమైంది, ఇబ్బందికి సారీ. మీ టైమ్‌కి థాంక్స్. నమస్కారం.',
    langs: () => 'మీకు ఏ భాషలు వచ్చు?',
    langMatch: (x) => `పర్ఫెక్ట్! ఈ జాబ్ రోల్‌కి కూడా ${x} కావాలి.`,
    langNo: (f) => `సరే, నోట్ చేసుకున్నాను. ఈ జాబ్ రోల్‌కి ${f.reqlang} కావాలి.`,
    numWhere: (f) => (/\d/.test(f.channel) ? `${f.channel} కి పంపండి. ఈ రోజు పంపుతారా?` : 'మా రిక్రూటర్ ఈ కాల్ తర్వాత మీకు వాట్సాప్‌లో నంబర్ పంపుతారు. అక్కడ మీ రెజ్యూమ్ పంపుతారా?'),
  },
  Hindi: {
    open: () => '{greet}, क्या मेरी बात {name} जी से हो रही है?',
    lang: () => 'कन्फर्म करने के लिए धन्यवाद। आगे बढ़ने से पहले, आप किस भाषा में कम्फर्टेबल हैं: इंग्लिश, हिंदी, तेलुगु, या मिक्स?',
    langOk: () => 'ठीक है, मैं हिंदी में बात करता हूँ।',
    intro: (f) => `यह ${f.caller} है, ${f.company} से हमारी रिक्रूटमेंट टीम की ओर से AI असिस्टेंट की कॉल है।`,
    perm: () => 'एक जॉब ऑपॉर्च्युनिटी के बारे में बताना है। क्या आपके पास दो मिनट हैं?',
    say: (f) => `${f.industry ? `एक ${f.industry} कंपनी में ` : ''}${f.role} की ओपनिंग है।${f.location ? ` लोकेशन ${f.location} है।` : ''}${f.details ? ` इस रोल में ${f.details} शामिल है।` : ''}`,
    say2: (f) => `${f.qualification ? `क्वालिफिकेशन ${f.qualification} चाहिए।` : ''}${f.experience ? ` एक्सपीरियंस करीब ${f.experience} चाहिए।` : ''}${f.salary ? ` सैलरी ${f.salary} है।` : ''}${f.vacancies ? ` अभी ${f.vacancies} पोज़िशन खुली हैं।` : ''}${f.keyreq ? ` इस रोल की एक खास बात: ${f.keyreq}।` : ''}`.trim(),
    interest: () => 'क्या यह आपको इंटरेस्टिंग लगता है?',
    exp: () => 'आपके पास कितने साल का रिलेवेंट एक्सपीरियंस है?',
    ind: (f) => `क्या आपका एक्सपीरियंस ${f.industry} कंपनी में है?`,
    indOther: () => 'कोई बात नहीं। आपने किस इंडस्ट्री में काम किया है?',
    duties: () => 'धन्यवाद। अपनी करंट या पिछली कंपनी में अपने काम के बारे में थोड़ा बताएँगे?',
    edu: () => 'आपकी हाईएस्ट क्वालिफिकेशन क्या है?',
    work: () => 'क्या आप अभी जॉब कर रहे हैं?',
    notice: () => 'आपका नोटिस पीरियड कितना है?',
    sal: () => 'आपकी करंट और एक्सपेक्टेड सैलरी कितनी है?',
    loc: (f) => (f.location ? `क्या आप पहले से ${f.location} में हैं, या रीलोकेट होना पड़ेगा?` : 'आप अभी कहाँ रहते हैं?'),
    doubt: () => 'क्या इस जॉब के बारे में आपका कोई सवाल है?',
    next: (f) => `बहुत अच्छा। क्या आप अपना अपडेटेड रिज्यूमे ${f.channel} पर भेज सकते हैं? हमारी टीम उसे देखकर अगले कदमों के बारे में आपसे संपर्क करेगी।`,
    close: () => 'आपके समय के लिए धन्यवाद {name} जी। हम जल्द ही संपर्क करेंगे। आपका दिन शुभ हो।',
    reason: () => 'कोई बात नहीं। क्या कोई खास वजह है, जैसे लोकेशन, सैलरी, रोल या करियर प्लान? इससे हम आपके लिए बेहतर ऑपॉर्च्युनिटी ढूँढ पाएँगे।',
    keep: () => 'कोई बात नहीं, बताने के लिए धन्यवाद। अगर कोई बेहतर ओपनिंग आए, तो क्या हम दोबारा संपर्क कर सकते हैं?',
    bye: () => 'धन्यवाद। आपके समय के लिए शुक्रिया, आपके करियर के लिए शुभकामनाएँ। आपका दिन शुभ हो।',
    wrong: () => 'असुविधा के लिए माफ़ कीजिए। बताने के लिए धन्यवाद। आपका दिन शुभ हो।',
    cbq: () => 'कोई बात नहीं। आपको किस टाइम पर दोबारा कॉल करना ठीक रहेगा?',
    cbok: () => 'ठीक है, मैं उस टाइम पर कॉल करूँगा। आपके समय के लिए धन्यवाद। आपका दिन शुभ हो।',
    near: (f) => `बहुत अच्छा, ${f.location} आपके लिए ठीक है।`,
    fits: () => 'यह रेंज में ही है।',
    budgetNote: (f) => `धन्यवाद। इस रोल का मौजूदा बजट ${f.budget} तक है। मैं आपकी एक्सपेक्टेशन हमारी रिक्रूटमेंट टीम के लिए नोट कर लेता हूँ।`,
    budget: (f) => `समझ गया, बताने के लिए धन्यवाद।${f.persuasion ? ` ${f.persuasion}।` : ''} इस रोल का मौजूदा बजट ${f.budget} तक है। प्रोफाइल देखने के बाद कंपनी की तरफ से कोई फ्लेक्सिबिलिटी हुई तो हमारी रिक्रूटमेंट टीम आपसे बात करेगी। क्या आप फिर भी आगे बढ़ना चाहेंगे?`,
    budgetYes: () => 'बहुत अच्छा। मैं आपकी सैलरी एक्सपेक्टेशन नोट करके हमारी रिक्रूटमेंट टीम को बता दूँगा।',
    prefloc: () => 'समझ गया। आपकी पसंदीदा वर्क लोकेशन कौन सी है?',
    reloc: (f) => `बताने के लिए धन्यवाद। यह पोज़िशन ${f.location} में है। अगर रोल और करियर ग्रोथ अच्छी हो तो क्या आप रीलोकेट हो सकते हैं?`,
    locKeep: () => 'कोई बात नहीं। मैं आपकी लोकेशन प्रेफरेंस नोट करके आपके पास की ओपनिंग के लिए आपका प्रोफाइल रखूँगा।',
    both: () => 'समझ गया, बताने के लिए धन्यवाद। आपके लिए बेहतर ऑपॉर्च्युनिटी के लिए, अपनी एक्सपेक्टेड सैलरी और पसंदीदा लोकेशन बताएँगे?',
    bothKeep: () => 'धन्यवाद, मैंने आपकी प्रेफरेंस नोट कर ली। आपकी अनुमति से हम आपका प्रोफाइल अपने डेटाबेस में रखेंगे और मैचिंग ऑपॉर्च्युनिटी आने पर संपर्क करेंगे। ठीक है?',
    objExp: () => 'कोई बात नहीं, मैंने नोट कर लिया। आपके लेवल का कोई रोल होगा तो मैं आपसे संपर्क करूँगा। आपके समय के लिए धन्यवाद।',
    objJob: (f) => `मैं पूरी तरह समझता हूँ। बहुत से लोग जॉब न ढूँढते हुए भी ऑपॉर्च्युनिटी देखते रहते हैं।${f.details ? ` इस रोल में ${f.details} का एक्सपोज़र मिलता है।` : ''} क्या आप डिटेल्स देखकर बाद में तय करना चाहेंगे?`,
    detailsOk: () => 'ज़रूर। हमारी टीम जॉब डिटेल्स व्हाट्सएप पर भेज देगी। आप अपने समय पर देख लीजिए, इंटरेस्ट हो तो आगे बात करेंगे। आपके समय के लिए धन्यवाद।',
    objTrust: (f) => `यह सही सवाल है। हाँ, यह ${f.who} की${f.location ? ` ${f.location} में` : ''} कन्फर्म्ड रिक्वायरमेंट है। आपके रेफरेंस के लिए हमारी टीम जॉब डिस्क्रिप्शन और कॉन्टैक्ट डिटेल्स व्हाट्सएप पर भी भेज सकती है।`,
    family: () => 'ज़रूर, यह एक ज़रूरी फैसला है, मैं समझता हूँ। क्या आपके देखने के लिए हमारी टीम जॉब डिटेल्स व्हाट्सएप पर भेज दे?',
    followup: () => 'बहुत अच्छा, हमारी टीम डिटेल्स भेज देगी। क्या मैं दो दिन में दोबारा फॉलो अप कर सकता हूँ?',
    followupOk: () => 'धन्यवाद। हम दो दिन में आपसे दोबारा संपर्क करेंगे। आपका दिन शुभ हो।',
    studies: () => 'यह बहुत अच्छी बात है, आपकी पढ़ाई के लिए शुभकामनाएँ। मैं हमारे रिकॉर्ड अपडेट कर देता हूँ। आगे कभी ऑपॉर्च्युनिटी चाहिए हो तो हम मदद करेंगे। आपका दिन शुभ हो।',
    wfhKeep: () => 'समझ गया, मैंने आपकी प्रेफरेंस नोट कर ली। आपकी अनुमति से वर्क फ्रॉम होम रोल आने पर हम संपर्क करेंगे। ठीक है?',
    company: (f) => `यह ऑपॉर्च्युनिटी ${f.who} की${f.location ? ` ${f.location} में` : ''} है। आपका प्रोफाइल मैच होने पर हमारी रिक्रूटमेंट टीम कंपनी की पूरी डिटेल्स और इंटरव्यू प्रोसेस बताएगी।`,
    benefits: () => 'अच्छा सवाल है। बेनिफिट्स की पूरी जानकारी अभी मेरे पास नहीं है। इंश्योरेंस, लीव पॉलिसी और इंसेंटिव के बारे में अगले स्टेज में हमारी रिक्रूटमेंट टीम सही जानकारी देगी।',
    interview: () => 'इंटरव्यू मोड हायरिंग टीम तय करती है। कंपनी के प्रोसेस के हिसाब से यह ऑनलाइन, ऑफलाइन या कई राउंड में हो सकता है। मोड फाइनल होने पर शेड्यूल से पहले हमारी टीम बता देगी।',
    ivPref: () => 'समझ गया। मैं आपकी प्रेफरेंस नोट करके हमारी रिक्रूटमेंट टीम को बता दूँगा। फाइनल इंटरव्यू मोड कंपनी कन्फर्म करेगी।',
    ivTravel: () => 'बताने के लिए धन्यवाद। मैं हमारी रिक्रूटमेंट टीम को बताकर देखता हूँ कि ऑनलाइन इंटरव्यू का ऑप्शन है या नहीं।',
    noticeLong: (f) => `बताने के लिए धन्यवाद। इस पोज़िशन के लिए ${f.notice} में जॉइन करने वाले बेहतर हैं। फिर भी मैं आपका नोटिस पीरियड नोट करके हायरिंग टीम से बात करूँगा।`,
    unknown: () => 'अच्छा सवाल है। यह जानकारी अभी मेरे पास नहीं है, लेकिन हमारे रिक्रूटर आपको सीधे कन्फर्म कर देंगे।',
    aiYes: () => 'जी हाँ, मैं हमारी रिक्रूटमेंट टीम की ओर से कॉल कर रहा AI असिस्टेंट हूँ। हमारे रिक्रूटर आपसे खुद बात करेंगे।',
    sum: (a) => `मैंने जो नोट किया वह कन्फर्म करता हूँ। ${a.loc ? `लोकेशन, ${a.loc}। ` : ''}${a.exp ? `एक्सपीरियंस, ${a.exp}। ` : ''}${a.edu ? `क्वालिफिकेशन, ${a.edu}। ` : ''}${a.work ? `जॉब और नोटिस पीरियड, ${a.work}। ` : ''}${a.sal ? `सैलरी, ${a.sal}। ` : ''}क्या यह सही है?`,
    sumFix: () => 'ठीक है, मैं यह सुधार अपनी टीम को बता दूँगा।',
    calm: () => 'समझ गया, तकलीफ़ के लिए माफ़ कीजिए। आपके समय के लिए धन्यवाद। नमस्ते।',
    langs: () => 'आपको कौन सी भाषाएँ आती हैं?',
    langMatch: (x) => `परफेक्ट! इस जॉब रोल के लिए भी ${x} चाहिए।`,
    langNo: (f) => `ठीक है, नोट कर लिया। इस जॉब रोल के लिए ${f.reqlang} चाहिए।`,
    numWhere: (f) => (/\d/.test(f.channel) ? `कृपया इसे ${f.channel} पर भेजिए। क्या आप आज भेज पाएँगे?` : 'हमारे रिक्रूटर इस कॉल के बाद आपको व्हाट्सएप पर नंबर भेजेंगे। क्या आप वहाँ अपना रिज्यूमे भेज पाएँगे?'),
  },
};
function cap(s) { const t = String(s).trim(); return t ? t[0].toUpperCase() + t.slice(1) : t; }

// "10K" is said "10 thousand" (a voice reads the letter K otherwise)
const THOUSAND = { English: 'thousand', Telugu: 'వేలు', Hindi: 'हज़ार' };
const CLIENT_WORD = {
  English: (i) => (i ? `one of our ${i} clients` : 'one of our clients'),
  Telugu: (i) => (i ? `మా ${i} క్లయింట్ కంపెనీలో` : 'మా క్లయింట్ కంపెనీలో'),
  Hindi: (i) => (i ? `हमारे एक ${i} क्लाइंट` : 'हमारे एक क्लाइंट'),
};
const CHANNEL = { English: 'WhatsApp', Telugu: 'వాట్సాప్', Hindi: 'व्हाट्सएप' };
function sayable(facts, lang) {
  const f = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, String(v).replace(/(\d+(?:\.\d+)?)\s*k\b/gi, `$1 ${THOUSAND[lang]}`)]));
  const industry = (f.industry || '').toLowerCase();
  return {
    ...f, industry, budget: String(f.salary || '').replace(/^up\s*to\s+/i, ''), caller: f.caller || 'Bhavana', company: f.company || (lang === 'Telugu' ? 'మా సంస్థ' : (lang === 'Hindi' ? 'हमारी कंपनी' : 'our company')), channel: f.channel || CHANNEL[lang], who: CLIENT_WORD[lang](industry),
  };
}

/** The call, as script text, in each language. */
function build(factsIn) {
  const out = {};
  Object.entries(L).forEach(([lang, t]) => {
    const f = sayable(factsIn, lang);
    const lines = [`Opening: ${t.open(f)}`, `Language: ${t.lang(f)}`, `Say: ${t.intro(f)}`, `Ask: ${t.perm(f)}`, `Say: ${t.say(f)}`, `Interest: ${t.interest(f)}`, ...(t.say2(f) ? [`Say: ${t.say2(f)}`] : []), `Ask: ${t.exp(f)}`];
    if (f.industry) lines.push(`Ask: ${t.ind(f)}`, `IfNo: ${t.indOther(f)}`, `IfNo: ${t.duties(f)}`);
    if (f.qualification) lines.push(`Ask: ${t.edu(f)}`);
    if (f.reqlang) lines.push(`Ask: ${t.langs(f)}`);
    lines.push(`Ask: ${t.work(f)}`, `IfYes: ${t.notice(f)}`, `Ask: ${t.sal(f)}`, `Ask: ${t.loc(f)}`, `Ask: ${t.doubt(f)}`, `Ask: ${t.next(f)}`, `Closing: ${t.close(f)}`, `Convince: ${t.reason(f)}`, `Decline: ${t.keep(f)}`);
    out[lang] = lines.join('\n');
  });
  return out;
}

const startLanguage = (facts) => { const l = String(facts.language || '').toLowerCase(); return l.startsWith('tel') ? 'Telugu' : (l.startsWith('hin') ? 'Hindi' : 'English'); };

// a person's question, answered from the facts only (nothing is invented): null when the facts do not answer it
const Q = {
  salary: /salary|pay\b|package|ctc|money|how much|జీతం|శాలరి|సాలరి|సాలరీ|శాలరీ|జీతమెంత|ఎంత|वेतन|सैलरी|तनख्वाह|कितना/i,
  location: /where|location|place|city|area|office|ఎక్కడ|స్థలం|లొకేషన్|లోకేషన్|లొకేషనా|कहाँ|कहां|स्थान|लोकेशन|जगह/i,
  qualification: /qualification|degree|graduate|education|eligib|అర్హత|క్వాలిఫికేషన్|योग्यता|क्वालिफिकेशन|पात्र/i,
  role: /what (is|kind|work)|role|work|job|duties|responsibilit|ఏ ఉద్యోగం|పని|రోల్|జాబ్|क्या काम|काम|रोल|जॉब/i,
  experience: /experience|fresher|అనుభవం|अनुभव/i,
};
const A = {
  English: { salary: (f) => `The salary is ${f.salary}.`, location: (f) => `The location is ${f.location}.`, qualification: (f) => `The qualification needed is ${f.qualification}.`, role: (f) => `The role is ${f.role}${f.details ? `: ${f.details}` : ''}.`, experience: (f) => `Experience: ${f.experience}.` },
  Telugu: { salary: (f) => `సాలరీ ${f.salary}.`, location: (f) => `లొకేషన్ ${f.location}.`, qualification: (f) => `క్వాలిఫికేషన్ ${f.qualification}.`, role: (f) => `జాబ్ ${f.role}${f.details ? `: ${f.details}` : ''}.`, experience: (f) => `ఎక్స్‌పీరియన్స్ ${f.experience}.` },
  Hindi: { salary: (f) => `सैलरी ${f.salary}।`, location: (f) => `लोकेशन ${f.location}।`, qualification: (f) => `क्वालिफिकेशन ${f.qualification}।`, role: (f) => `जॉब ${f.role}${f.details ? `: ${f.details}` : ''}।`, experience: (f) => `एक्सपीरियंस ${f.experience}।` },
};
// strict: only the pay / place / qualification / experience words count (the plain words of "role" - work, job - are in too many replies)
function answer(factsIn, text, lang, strict = false) {
  if (!factsIn) return null;
  const facts = sayable(factsIn, lang);
  const a = A[lang] || A.English;
  const hit = ['salary', 'location', 'qualification', 'experience', 'role'].filter((k) => !(strict && k === 'role')).find((k) => Q[k].test(String(text || '')) && facts[k]);
  return hit ? a[hit](facts) : null;
}

// whether an answer says the job is near, and what is said then
function near(facts, text) {
  const loc = String((facts && facts.location) || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!loc) return false;
  const SS = require('./voice/speakScript'); // eslint-disable-line global-require
  return t.includes(loc) || t.includes(SS.native(facts.location, 'Telugu')) || t.includes(SS.native(facts.location, 'Hindi')) || /\b(near|nearby|close|around|already)\b|దగ్గర|పక్క|ఇక్కడే|पास|नज़दीक|नजदीक|यहीं/.test(t);
}

// every line of the call, ready to say, in the language of the call
const words = (facts, lang) => { const t = L[lang] || L.English; const f = sayable(facts, lang); return Object.fromEntries(Object.keys(t).map((k) => [k, (arg) => t[k](arg === undefined ? f : arg)])); };

// which line of the call this is (the same words as build())
const STEP_KEYS = ['perm', 'interest', 'exp', 'ind', 'edu', 'langs', 'work', 'notice', 'sal', 'loc', 'doubt', 'next'];
function stepOf(facts, lang, lineText) {
  const t = L[lang] || L.English;
  const f = sayable(facts, lang);
  const line = String(lineText || '').trim();
  return STEP_KEYS.find((k) => t[k](f).trim() === line) || null;
}

// "Telugu", "Telugu + English", "తెలుగులో": the language picked (a mix = the Indian language: the lines of that version are in that mix already)
function languageChoice(text) {
  const t = String(text || '').toLowerCase();
  if (/t+h?el+[aeu]?g+[ou]+|telgu|తెలుగు|तेलुगु/.test(t)) return 'Telugu'; // "Telgu", "Telegu", "Thelugu": the name as a phone line writes it
  if (/hind+h?i|हिंदी|हिन्दी|హిందీ/.test(t)) return 'Hindi';
  if (/english|ఇంగ్లీష్|ఇంగ్లిష్|इंग्लिश|अंग्रेज़ी|अंग्रेजी/.test(t)) return 'English';
  return null;
}

// ---- what a person may bring up at any point of the call ------------------------------------------------------------
const PAY = /salary|pay\b|package|ctc|\b\d+\s*k\b|జీతం|శాలరి|సాలరి|సాలరీ|శాలరీ|वेतन|सैलरी|तनख्वाह/i;
const PAY_LOW = /\b(low|less|not enough|too little|very little|more|higher)\b|expect|తక్కువ|సరిపోదు|ఎక్కువ|कम\b|ज़्यादा|ज्यादा|और चाहिए/i;
const FAR = /\b(far|distance|long way|commute|not (my )?preferred|other (city|place)|another (city|place)|no relocation|not relocat|can'?t relocat|cannot relocat|can'?t move)\b|దూరం|దూరంగా|రీలొకేట్ కాను|दूर|डिस्टेंस|रीलोकेट नहीं/i;
const TOPICS = [
  ['studies', /higher stud|further stud|preparing for|studying|\bstudent\b|చదువు|స్టడీస్|ప్రిపేర్|पढ़ाई|स्टडीज|तैयारी कर/i],
  ['wfh', /work[\s-]*from[\s-]*home|\bwfh\b|\bremote\b|\bhybrid\b|ఇంటి నుండి|వర్క్ ఫ్రమ్ హోమ్|వర్క్ ఫ్రం హోమ్|घर से|वर्क फ्रॉम होम/i],
  ['family', /\bfamily\b|parents|\bwife\b|\bhusband\b|let me think|think about|need (some )?time|ఫ్యామిలీ|కుటుంబ|ఆలోచి|परिवार|फैमिली|सोच/i],
  ['company', /which company|what company|company name|name of the company|ఏ కంపెనీ|కంపెనీ పేరు|कौन सी कंपनी|कौनसी कंपनी|कंपनी का नाम/i],
  ['benefits', /benefit|insurance|\bpf\b|\besi\b|incentive|bonus|leave policy|బెనిఫిట్|ఇన్సూరెన్స్|बेनिफिट|इंश्योरेंस|लाभ/i],
  ['ivTravel', /(can'?t|cannot|won'?t|not able to|unable to)\s+(be able to\s+)?(travel|come|attend)|రాలేను|रास्ता|नहीं आ सकता|नहीं आ सकती/i],
  ['ivPref', /prefer.{0,25}(online|offline)|(online|offline).{0,25}prefer|ఆన్‌లైన్ కావాలి|ఆఫ్‌లైన్ కావాలి|ऑनलाइन चाहिए|ऑफलाइन चाहिए/i],
  ['interview', /\b(online|offline)\b|interview (mode|date|process|round)|ఆన్‌లైన్|ఆఫ్‌లైన్|ఇంటర్వ్యూ ఎప్పుడు|ऑनलाइन|ऑफलाइन|इंटरव्यू कब/i],
  ['trust', /\b(real|genuine|fake|scam|fraud)\b|నిజమా|ఫేక్|असली|फेक|फर्जी/i],
  ['details', /send.{0,20}(details|jd|description)|details.{0,20}(send|whatsapp)|డీటెయిల్స్ పంప|डिटेल्स भेज/i],
  ['notLooking', /(already|currently)\s*(working|employed)|have a job|not (actively )?looking|no job change|job change|happy (here|where)|ఆల్రెడీ.*జాబ్|ఇప్పటికే.*జాబ్|జాబ్ చేంజ్|पहले से.*जॉब|जॉब चेंज|नौकरी कर/i],
  ['experience', /not enough experience|less experience|no experience|don'?t have (enough |the )?experience|ఎక్స్‌పీరియన్స్ లేదు|అనుభవం లేదు|एक्सपीरियंस नहीं|अनुभव नहीं/i],
];
const NOT_INTERESTED = /not interested|no interest|don'?t want|do not want|ఇంట్రెస్ట్ లేదు|వద్దు|ఇష్టం లేదు|इंटरेस्ट नहीं|नहीं चाहिए/i;
const HOSTILE = /\b(idiot|stupid|nonsense|bloody|shut up|fool)\b|ఎందుకు విసిగిస్త|పిచ్చి|बकवास|बेवकूफ|पागल/i;
// "which number?", "where do I send it?", "email id?" - asked at the resume step
const WHERE = /\b(which|what('?s| is)|your|the)\s+(number|no\b|email|e-?mail|mail|id|whatsapp)|where\s+(to|should i|can i|do i)\s+(send|share)|send\s+(it\s+)?(where|to whom)|number\??$|ఏ\s*(నంబర్|నెంబర్|నంబరు)|నంబర్\s*(ఇవ్వండి|చెప్పండి|ఏమిటి)|నెంబర్|ఎక్కడికి\s*పంపాలి|कौन\s*सा\s*(नंबर|ईमेल)|नंबर\s*(दीजिए|बताइए|क्या)|कहाँ\s*भेज|कहां\s*भेज/i;
const asksWhere = (text) => WHERE.test(String(text || ''));
const notInterested = (text) => NOT_INTERESTED.test(String(text || ''));
const hostile = (text) => HOSTILE.test(String(text || ''));

// the matter the person raised, or null. step: the line just asked; reason: they are answering "is there a specific reason?", so a bare word (salary) is enough.
function topic(text, { step = null, reason = false } = {}) {
  const t = String(text || '');
  const payNow = PAY.test(t) && (reason || PAY_LOW.test(t)) && !/\b(salary|pay|package) is (fine|ok|okay|good)\b/i.test(t);
  const payBig = /expect\w*\s+(around\s+|about\s+|rs\.?\s*|₹\s*)?\d/i.test(t);
  const pay = step !== 'sal' && (payNow || payBig);
  const far = FAR.test(t) || (reason && /\b(location|place|city)\b|లొకేషన్|लोकेशन/i.test(t));
  const hit = TOPICS.find(([k, re]) => !(k === 'experience' && ['exp', 'ind', 'edu'].includes(step)) && !(k === 'notLooking' && step === 'work' && !/not (actively )?looking|job change|जॉब चेंज|జాబ్ చేంజ్/i.test(t)) && re.test(t));
  if (hit && !['notLooking', 'experience'].includes(hit[0])) return hit[0];
  if (pay && far) return 'both';
  if (far) return 'location';
  if (pay) return 'salary';
  return hit ? hit[0] : null;
}

// ---- reading an answer against the facts -------------------------------------------------------------------------------
// amounts a month: "30k", "30,000 per month", "5 LPA", "3.5 lakhs"
function amounts(text) {
  const t = String(text || '').replace(/(\d),(?=\d)/g, '$1').toLowerCase();
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(k\b|thousand|lakhs?\b|lacs?\b|lpa\b|వేలు|లక్ష|हज़ार|हजार|लाख)?/g;
  let m = re.exec(t);
  while (m) {
    const n = Number(m[1]);
    const u = m[2] || '';
    if (/k|thousand|వేలు|हज़ार|हजार/.test(u)) out.push(n * 1000);
    else if (u) out.push(Math.round((n * 100000) / 12));
    else if (n >= 1000) out.push(n);
    m = re.exec(t);
  }
  return out;
}
function overBudget(facts, text) {
  const top = Math.max(0, ...amounts(facts && facts.salary));
  const asked = amounts(text);
  return top > 0 && asked.length > 0 && asked[asked.length - 1] > top * 1.1 ? 'over' : (top > 0 && asked.length > 0 ? 'fits' : null);
}
const firstNum = (t) => { const m = /\d+(?:\.\d+)?/.exec(String(t || '')); return m ? Number(m[0]) : null; };
const lastNum = (t) => { const m = String(t || '').match(/\d+(?:\.\d+)?/g); return m ? Number(m[m.length - 1]) : null; };
const needsYears = (facts) => firstNum(facts && facts.experience); // the least experience the job asks for, in years
const maxNotice = (facts) => lastNum(facts && facts.notice); // the longest notice period the job takes, in days

// ---- A SCRIPT THAT NAMES A JOB (founder 2026-11-09: "ai script lo job role petinadhi human laga nene matladali, ichina script antha chadavadhu") ----------------------
// A script written as plain sentences ("We have an opening for HR Recruiter in Kukatpally, salary 10K ...") is not read out: the role and whatever else it says (place, pay,
// qualification, experience, company) are taken out of it, and the call is built from them like any vacancy - a human conversation about that role.
const CITIES = ['Hyderabad', 'Secunderabad', 'Kukatpally', 'Madhapur', 'Gachibowli', 'Hitech City', 'Ameerpet', 'Banjara Hills', 'Uppal', 'LB Nagar', 'Miyapur', 'Dilsukhnagar', 'Bangalore', 'Bengaluru', 'Chennai', 'Mumbai', 'Pune', 'Delhi', 'Noida', 'Gurgaon', 'Kolkata', 'Vijayawada', 'Visakhapatnam', 'Vizag', 'Guntur', 'Warangal', 'Tirupati', 'Nellore', 'Kakinada', 'Karimnagar', 'Ahmedabad', 'Jaipur', 'Kochi', 'Coimbatore', 'Nagpur', 'Lucknow', 'Indore'];
const NOT_ROLE = /^(you|your|us|our|this|that|it|the|a|an|candidates?|people|someone|anyone|freshers?|them|now|more|good|many|few|new|job|jobs)$/i;
function inferFacts(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r/g, '\n').split('\n').map((l) => l.replace(/^\s*(opening|say|ask|interest|closing|decline|convince|language|ifyes|ifno)\s*[:\-–]\s*/i, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  if (text.length < 15) return null;
  let role = null;
  const up = /\b(?:opening|openings|vacancy|vacancies|position|post|role|hiring|recruiting|requirement|looking)\s+(?:for|of|as)\s+(?:an?\s+|the\s+)?((?:[A-Z][A-Za-z&/+.-]*)(?:\s+(?:[A-Z][A-Za-z&/+.-]*|of|and|&)){0,4})/.exec(text);
  if (up) role = up[1];
  if (!role) {
    const lo = /\b(?:opening|openings|vacancy|vacancies|position|hiring|recruiting)\s+(?:for|of)\s+(?:an?\s+|the\s+)?([a-z][a-z &/-]{2,40}?)(?=\s+(?:in|at|with|near|for|who|that|having|from|on)\b|[.,;!?]|$)/i.exec(text);
    if (lo) role = lo[1];
  }
  if (!role) {
    const deg = /\b(MBBS|BDS|B\.?\s?Pharm|M\.?\s?Pharm|GNM|ANM|BAMS|BHMS|DMLT|MBA|MCA|CMA)\b[^.]{0,24}\b(job|jobs|vacancy|vacancies|opening|position|post|requirement|needed|required)\b/i.exec(text) || /\b(job|vacancy|opening|position|post|requirement)\b[^.]{0,24}\b(MBBS|BDS|B\.?\s?Pharm|M\.?\s?Pharm|GNM|ANM|BAMS|BHMS|DMLT|MBA|MCA|CMA)\b/i.exec(text);
    if (deg) role = (/^(job|vacancy|opening|position|post|requirement)/i.test(deg[1]) ? deg[2] : deg[1]).toUpperCase();
  }
  if (!role) {
    const cap = /\b((?:[A-Z][A-Za-z+./&-]*)(?:\s+[A-Z][A-Za-z+./&-]*){0,3})\s+(?:job|jobs|vacancy|vacancies|position|post|role|opening|openings|requirement)\b/.exec(text);
    if (cap) role = cap[1];
  }
  if (!role && /\b(job|jobs|vacancy|vacancies|opening|openings|position|hiring|recruit\w*|post|requirement)\b/i.test(text)) {
    const occ = /(?:\b([A-Za-z.]+)\s+)?\b(doctor|nurse|teacher|lecturer|professor|accountant|engineer|developer|driver|manager|executive|recruiter|technician|operator|pharmacist|receptionist|telecaller|electrician|plumber|cook|chef|security guard|mechanic|supervisor|clerk|analyst|designer|tutor|counsellor|therapist|surgeon|dentist)\b/i.exec(text);
    if (occ) role = `${occ[1] && !/^(a|an|the|for|as|our|of|with|good|new|any|one|some|need|needed|hiring|we|are|is|have|has)$/i.test(occ[1]) ? `${occ[1]} ` : ''}${occ[2]}`.trim();
  }
  if (!role) return null;
  role = role.replace(/\s+(?:position|role|post|job|vacancy|opening)s?$/i, '').replace(/\s+(?:in|at|of|and|&)$/i, '').trim();
  if (role.length < 3 || role.length > 50 || NOT_ROLE.test(role) || CITIES.some((c) => c.toLowerCase() === role.toLowerCase())) return null;
  const facts = { role };
  const rl = text.split(/(?<=[.!?])\s+/).filter((x) => /\b(?:languages?|speak|speaking|know|knowledge of|fluent|fluency)\b/i.test(x)).join(' ');
  if (rl && languagesIn(rl).length) facts.reqlang = languagesIn(rl).join(', ');
  const city = CITIES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  if (city) facts.location = city;
  const sal = /\b(?:salary|pay|package|ctc)\s*(?:is|of|up to|:)?\s*((?:up to\s+)?(?:₹|rs\.?\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lpa)?(?:\s*(?:per|a|\/)\s*(?:month|annum|year))?)/i.exec(text) || /((?:₹|rs\.?\s*)\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lpa)?(?:\s*(?:per|a|\/)\s*(?:month|annum|year))?|\b\d+(?:\.\d+)?\s*(?:k|lpa|lakhs?)\b(?:\s*(?:per|a|\/)\s*(?:month|annum|year))?)/i.exec(text);
  if (sal) facts.salary = sal[1].trim();
  const q = /\b(any graduate|post[- ]?graduate|graduate|b\.?\s?tech|b\.?\s?e\b|mba|diploma|10th|12th|intermediate|degree|b\.?\s?com|m\.?\s?com|b\.?\s?sc|m\.?\s?sc|iti)\b/i.exec(text);
  if (q) facts.qualification = q[1];
  const ex = /\b(\d+(?:\s*(?:-|to)\s*\d+)?\s*\+?\s*years?)\b/i.exec(text);
  if (ex) facts.experience = ex[1];
  const co = /\b(?:calling|speaking|call|calls|assistant|agent|team|recruiter|representative)\s+(?:from|on behalf of|at|of)\s+((?:[A-Z][\w&-]*)(?:\s+[A-Z][\w&-]*){0,3})/.exec(text) || /\b(?:from|at)\s+([A-Z][\w&-]*(?:\s+(?:Consultants|Consultancy|Solutions|Technologies|Services|Pvt|Ltd|Limited|Group|Hiring))+)/.exec(text);
  if (co && co[1].toLowerCase() !== role.toLowerCase()) facts.company = co[1].trim();
  const det = /([^.!?]*\b(?:responsib\w*|duties|involves?|work includes|you will)\b[^.!?]*)/i.exec(text);
  if (det) facts.details = det[1].replace(/^.*?\b(?:involves?|includes?|responsib\w*(?: are| include)?|duties(?: are| include)?|you will)\b[:\s]*/i, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (facts.details && facts.details.length < 8) delete facts.details;
  return facts;
}
/** the facts of a vacancy: the labelled ones (Role: ...) when the team wrote them so, else what a plain-sentence script says about a job; null when it names no job */
const factsFrom = (raw) => parseFacts(raw) || inferFacts(raw);

// ---- LANGUAGES (founder 2026-11-09): "which languages can you speak?" - the ones the job needs are told back: "Perfect! This job role needs Telugu as well."
const LANG_NAMES = [
  ['Telugu', /telugu|తెలుగు|तेलुगु|तेलुगू/i, { Telugu: 'తెలుగు', Hindi: 'तेलुगु' }], ['Hindi', /hindi|హిందీ|हिंदी|हिन्दी/i, { Telugu: 'హిందీ', Hindi: 'हिंदी' }],
  ['English', /english|ఇంగ్లీష్|ఇంగ్లిష్|इंग्लिश|अंग्रेज़ी|अंग्रेजी/i, { Telugu: 'ఇంగ్లీష్', Hindi: 'इंग्लिश' }], ['Tamil', /tamil|తమిళ|तमिल/i, {}], ['Kannada', /kannada|కన్నడ|कन्नड़/i, {}],
  ['Malayalam', /malayalam|మలయాళ|मलयालम/i, {}], ['Urdu', /urdu|ఉర్దూ|उर्दू/i, {}], ['Marathi', /marathi|మరాఠీ|मराठी/i, {}], ['Bengali', /bengali|bangla|బెంగాలీ|बंगाली/i, {}],
  ['Gujarati', /gujarati|గుజరాతీ|गुजराती/i, {}], ['Odia', /odia|oriya|ఒడియా|ओड़िया/i, {}], ['Punjabi', /punjabi|పంజాబీ|पंजाबी/i, {}],
];
const languagesIn = (text) => LANG_NAMES.filter(([, re]) => re.test(String(text || ''))).map(([n]) => n);
const shownName = (name, lang) => { const r = LANG_NAMES.find(([n]) => n === name); return (r && r[2] && r[2][lang]) || name; };
/** { needed: [names the job asks for], matched: 'Telugu and Hindi' | null } for what the person said they speak */
function languageOverlap(facts, answer, lang = 'English') {
  const needed = languagesIn(facts && facts.reqlang);
  const said = languagesIn(answer);
  const both = needed.filter((n) => said.includes(n));
  const joiner = { English: ' and ', Telugu: ' మరియు ', Hindi: ' और ' }[lang] || ' and ';
  return { needed, matched: both.length ? both.map((n) => shownName(n, lang)).join(joiner) : null };
}

const callbackQuestion = (lang) => (L[lang] || L.English).cbq();
const callbackOk = (lang) => (L[lang] || L.English).cbok();
const GREET = {
  English: ['Good morning', 'Good afternoon', 'Good evening'], Telugu: ['శుభోదయం', 'నమస్కారం', 'శుభ సాయంత్రం'], Hindi: ['सुप्रभात', 'नमस्ते', 'शुभ संध्या'],
};
// the greeting for the time of day in India
function greeting(lang, now = new Date()) {
  const h = new Date(now.getTime() + 330 * 60000).getUTCHours();
  return (GREET[lang] || GREET.English)[h < 12 ? 0 : (h < 17 ? 1 : 2)];
}

module.exports = {
  Q,
  callbackQuestion, callbackOk, languagesIn, languageOverlap, parseFacts, inferFacts, factsFrom, build, startLanguage, answer, near, words, stepOf, languageChoice, topic, asksWhere, notInterested, hostile, overBudget, needsYears, maxNotice, greeting, KEYS,
};
