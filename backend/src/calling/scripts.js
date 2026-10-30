// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE WORDS THE ASSISTANT SAYS.
//
//   buildData({candidate, app, requirement, ...})   the VERIFIED facts for one call, read from the database. Nothing is
//                                                    invented: a fact that is not in the database is simply left out.
//   phrases(language)                                fixed sentences in English / Telugu / Hindi with {slots}
//   preview(purpose, language, data, fields)         the lines the recruiter sees before confirming
//
// RULES (checked by checkTemplates() and by the tests):
//   * the assistant says it is an AI assistant of TeamLink Consultants in its first sentence, in every language
//   * a fixed sentence never contains: selected / hired / offered (and their Telugu / Hindi words), a promise, a salary
//   * shortlist: the word is "shortlisted"; interview details come from the real interview record only
//   * a slot is filled only with a sanitised database value; a recruiter's note is screened for the same words
// ---------------------------------------------------------------------------
const LANGS = ['English', 'Telugu', 'Hindi'];
// 'AI Interview Pending' is a JOB PORTAL call (founder 2026-10-30: "job portal ai calling separate, ats ai calling separate"):
// it is started from Candidates > New from job portal, never offered on the ATS AI Calling screens.
// 'Job Match' (Job Portal calling too): a Job Portal applicant is told about ANOTHER live requirement their profile fits; the
// talk is the screening talk with its own opening line, and it needs consent like a screening call (not a service call).
const PURPOSES = ['Screening', 'Shortlist Notification', 'Interview Notification', 'Interview Reminder', 'AI Interview Pending', 'Job Match'];
const PORTAL_PURPOSES = ['AI Interview Pending', 'Job Match'];
// the purposes that run the screening talk (interest, years, city, notice, go ahead)
const screenLike = (purpose) => purpose === 'Screening' || purpose === 'Job Match';
const TRANSACTIONAL = new Set(['Shortlist Notification', 'Interview Notification', 'Interview Reminder', 'AI Interview Pending']);
const TZ = 'Asia/Kolkata';

// Words the assistant must never say unless an authorised decision exists (it never exists inside this module).
const FORBIDDEN = [
  /\b(selected|hired|offered|appointed|recruited|congratulations|guarantee[ds]?\s+(a\s+)?(job|selection|placement)|you\s+(have|got)\s+the\s+job)\b/i,
  /(चयनित|नियुक्त|ऑफर|बधाई|पक्की\s*नौकरी)/,
  /(ఎంపికైన|ఎంపిక\s*చేయబడ|ఆఫర్|అభినందనలు|నియమించ)/,
];
// Words the listener got wrong: two vowel signs in a row ("हैायदराबाद") cannot be a real Telugu / Hindi word
const looksGarbled = (t) => /[ा-ौా-ౌ][ा-ौా-ౌ]/.test(String(t || ''));
const hasForbidden = (t) => FORBIDDEN.some((re) => re.test(String(t || '')));

// Everyday spoken words, the way people talk on the phone (user, 2026-10-28: "normal daily language, like humans"; no
// "అండి"). English job words that people say anyway (జాబ్, ఎక్స్‌పీరియన్స్) are written in Telugu / Hindi letters so the voice
// says them right. The rules above still hold: AI first, never selected / hired / offered, no promise.
// DAILY SPEECH, NOT OFFICIAL (founder 2026-10-30: "official telugu & official hindi avasaram ledhu"): Hyderabad Teluglish and
// everyday Hinglish - ఓకే, సాలరీ, ఇప్పుడు, ఏళ్ళు (not సంవత్సరం / జీతం / ప్రస్తుతం); सैलरी, सिटी, डायरेक्ट (not भारतीय समय / आमने-सामने).
const PH = {
  English: {
    ai: "Hi, this is TeamLink Consultants' AI recruitment assistant.",
    noticeRec: "This call may be recorded for our records.",
    identity: 'Am I speaking with {name}?',
    identityAgain: "Sorry, I didn't catch that. Am I speaking with {name}?",
    identityNeeded: "First I need to check I'm talking to {name}. Then I can share the details.",
    wrong: 'Oh, sorry to bother you. Thanks, bye.',
    convenient: 'Do you have two minutes to talk now?',
    laterAsk: 'No problem. When should we call you back?',
    laterClose: "Okay, we'll call you later. Bye.",
    laterNoted: "Okay, {when}, got it. We'll call you then. Bye.",
    screenIntro: "We have a job opening for {job}. Can I tell you about it?",
    matchIntro: "You applied with TeamLink before. Your profile matches another job, {job}. Can I tell you about it?", // Job Match (Job Portal calling, 2026-10-30)
    briefLoc: 'The job is in {location}.',
    briefNeeds: "They need: {needs}.", // what the requirement asks for, from the ATS description (2026-10-30)
    briefMode: 'Work mode is {workMode}.',
    briefType: "It's a {employmentType} job.",
    briefExp: 'They want about {experience} of experience.',
    briefSkills: 'Main skills: {skills}.',
    briefResp: 'The work includes: {responsibilities}.',
    briefSalary: 'Salary range is {salary}.',
    briefNone: "I'll share the full details on the next call.",
    interestQ: 'Are you interested in this job?',
    interestMore: "Shall I tell you about the job once more?",
    qExp: 'How many years of experience do you have in this?',
    qLoc: 'Which city are you in right now?',
    qNotice: "What is your notice period, in days?",
    qProceed: "Shall we go to the next step?",
    closeInterested: "Thank you. I have noted everything. We will send you the next details soon. Nothing is final from this call. Bye.",
    closeNotInterested: 'Okay, thanks for your time. Bye.',
    closeStop: "Okay, we won't call you again. Bye.",
    closeUnclear: "The line is not clear. I will call you again. Thank you.",
    humanNoted: "Okay, I noted that you want to talk to a recruiter. Someone from our team will call you.",
    amAi: "I'm an AI assistant of TeamLink Consultants, not a person.",
    noSalary: "I will check with the team and tell you.",
    noInfo: "I will check with the team and tell you.",
    onlyYou: 'I can only talk about your own application.',
    repeat: "Sorry, I didn't catch that. Let me ask again.",
    resumeLine: "We spoke earlier about the {job} job.", // a call-back call (memory, 2026-10-30)
    // hearing problems / unclear answers (2026-10-29 fixes): never guess, ask again; never an endless loop
    notClear: "Sorry, I couldn't hear you clearly.",
    breaking: "Sorry, your voice is breaking up.",
    audioClose: "Sorry, the line is not clear. I will call you again a little later. Bye.",
    stillThere: "Hello, are you still there?",
    stillThere2: "Hello, can you hear me?",
    noAnswerClose: "I can't hear you. I will call you again a little later. Bye.",
    yesOrNo: "Sorry, was that a yes or a no?",
    sureRepeat: "Sure, let me say that again.",
    canHear: "Sorry about that. Can you hear me now?",
    whyNot: "Okay. Can I ask why? Is it this job, or are you not looking for a new job now?",
    // not interested: one honest try to keep them, then other jobs (founder 2026-10-30)
    pitchAck: "I understand.",
    pitchNotNow: "I understand. Even if you are not looking now, you can check this job once.",
    pitchJob: "It's a {kind} job in {location}.",
    pitchPay: "The salary is up to {salary}.",
    pitchNoLoss: "Going for the interview does not mean you must join.",
    convinceSalary: "I understand. The salary for this job is up to {salary}. You can talk about it in the interview.",
    convinceLoc: "I understand. The job is in {location}.",
    convinceGeneral: "I understand. It is a {kind} job. Going for the interview does not mean you must join.",
    convinceBare: "I understand. Going for the interview does not mean you must join.",
    convinceQ: "Do you want to try once?",
    keepOtherQ: "No problem. If a better job for you comes, shall I call you?",
    keepOtherYes: "Okay, I will call you when a good job comes. Thanks for your time. Bye.",
    checkFollowUp: "Sure, please check. When should we call you back?",
    laterWhenAgain: "Sorry, which day or time suits you?",
    thatsFine: "That's fine.",
    langSwitched: "Sure, let's continue in English.",
    // SPOKEN LIKE A PERSON (founder 2026-10-30: "oka person laaga matladali"): a short acknowledgement of what they said
    ackName: "Okay, thank you.",
    ackTime: "Thanks.",
    ackInterest: "Good.",
    ackExp: "Okay, {yrs}.",
    ackFresher: "Okay, a fresher.",
    ackLoc: "Okay, {place}.",
    ackNotice: "Okay, {days} days.",
    ackNoticeNow: "Okay, so you can join immediately.",
    ackNoted: "Okay, noted.",
    briefWhere: "It's in {location}",
    briefExpSkills: "They want around {experience} of experience, mainly in {skills}.",
    calmSorry: "Sorry if this is a bad time. I will keep it short.",
    calmOffer: "Shall I continue, or should someone call you at a better time?",
    calmClose: "Okay, sorry for the trouble. I won't take more of your time. Thanks.",
    noMoney: "TeamLink never asks for money, fees, an OTP or bank details. This call is only about your job application.",
    shortNews: "I am calling to tell you that you are shortlisted for the {job} job.",
    shortIv: 'Your interview is on {date} at {time}.',
    shortNoIv: "The interview isn't fixed yet. The team will share the details later.",
    shortProceed: 'Are you okay to go to the next step?',
    shortYes: "Thank you. We will send you the next details soon. Shortlisting is one step, not the final decision. Bye.",
    // AI interview pending (Job Portal calling, 2026-10-30)
    aiNews: "You applied for the {job} job on the TeamLink jobs website. Your AI interview for it is still pending.",
    aiDue: "Please finish it by {date}.",
    aiHow: "Please log in on the TeamLink jobs website with your mobile number or email. Open My Applications and start the AI interview there.",
    aiProceed: "Will you be able to complete it?",
    aiYes: "Thank you. Please finish it before the last date, so the recruiter can check your application. Bye.",
    ivIntro: 'Your interview for the {job} position is fixed for {date} at {time}.',
    ivRemind: 'Just a reminder, your interview for the {job} position is on {date} at {time}.',
    ivOnline: "It is an online interview. The meeting link is in our message.",
    ivOnlineNoLink: "It's an online interview. The recruiter will send you the link.",
    ivInPerson: "It's an in-person interview at {location}.",
    ivInPersonNoLoc: "It's an in-person interview. The recruiter will share the address.",
    ivPhone: "It's a phone interview.",
    ivInstr: 'One thing to note: {instructions}',
    ivAvail: 'Can you make it?',
    ivConfirmed: 'Great, thanks. Please be ready on time. Bye.',
    ivReschedAsk: 'What time works better for you?',
    ivReschedNoted: "Okay, I will tell the recruiter. Until they confirm, the interview stays at the same time. Bye.",
    ivNotAvail: 'Thanks for letting us know. The recruiter will call you. Bye.',
    ivNoReply: 'Okay, the recruiter will call you to confirm. Bye.',
    tz: 'IST',
  },
  Hindi: {
    ai: "हैलो, मैं टीमलिंक कंसल्टेंट्स से कॉल कर रहा हूँ, मैं उनका AI असिस्टेंट हूँ।",
    noticeRec: "ये कॉल रिकॉर्ड हो सकती है, नोट्स भी लिखे जाएँगे।",
    identity: "{name} जी बोल रहे हैं?",
    identityAgain: "सॉरी, ठीक से सुनाई नहीं दिया। {name} जी बोल रहे हैं?",
    identityNeeded: "पहले ये कन्फर्म करना है कि {name} जी से ही बात हो रही है, फिर डिटेल्स बताता हूँ।",
    wrong: "अरे, सॉरी, शायद रॉन्ग नंबर लग गया। बाय।",
    convenient: "अभी दो मिनट बात कर सकते हैं?",
    laterAsk: "कोई बात नहीं। कब कॉल करूँ?",
    laterClose: "ओके, बाद में कॉल करता हूँ। बाय।",
    laterNoted: "ओके, {when}, नोट कर लिया। तभी कॉल करूँगा। बाय।",
    screenIntro: "हमारे पास एक {job} की जॉब है। थोड़ा बताऊँ उसके बारे में?",
    matchIntro: "आपने पहले टीमलिंक में अप्लाई किया था ना। आपकी प्रोफ़ाइल से मैच होती एक और जॉब है, {job}। थोड़ा बताऊँ उसके बारे में?", // Job Match (Job Portal calling, 2026-10-30)
    briefLoc: "जॉब {location} में है।",
    briefNeeds: "उन्हें चाहिए: {needs}।", // what the requirement asks for, from the ATS description (2026-10-30)
    briefMode: "{workMode} है।",
    briefType: "{employmentType} जॉब है।",
    briefExp: "{experience} का एक्सपीरियंस चाहिए।",
    briefSkills: "मेन स्किल्स {skills} हैं।",
    briefResp: "काम ये है: {responsibilities}।",
    briefSalary: "सैलरी {salary} तक है।",
    briefNone: "पूरी डिटेल्स अगली कॉल में बताऊँगा।",
    interestQ: "इस जॉब में इंटरेस्ट है?",
    interestMore: "जॉब के बारे में एक बार और बताऊँ?",
    qExp: "आपका कितने साल का एक्सपीरियंस है?",
    qLoc: "अभी आप कहाँ रहते हैं?",
    qNotice: "नोटिस पीरियड कितने दिन का है?",
    qProceed: "ओके, आगे बढ़ें?",
    closeInterested: "थैंक्यू। सब नोट कर लिया। आगे क्या करना है, जल्दी बताएँगे। इस कॉल से अभी कुछ फ़ाइनल नहीं है। बाय।",
    closeNotInterested: "ओके, कोई बात नहीं। टाइम देने के लिए थैंक्यू। बाय।",
    closeStop: "ओके, अब कॉल नहीं करेंगे। बाय।",
    closeUnclear: "ठीक है, लाइन साफ़ नहीं लग रही। मैं फिर से कॉल करूँगा। थैंक्यू।",
    humanNoted: "ओके, नोट कर लिया कि आप रिक्रूटर से बात करना चाहते हैं। टीम से कोई कॉल करेगा।",
    amAi: "मैं टीमलिंक का AI असिस्टेंट हूँ, कोई इंसान नहीं।",
    noSalary: "वो मैं टीम से कन्फर्म करके आपको बताता हूँ।",
    noInfo: "वो मैं टीम से कन्फर्म करके आपको बताता हूँ।",
    onlyYou: "मैं सिर्फ़ आपकी एप्लिकेशन के बारे में बात कर सकता हूँ।",
    repeat: "सॉरी, ठीक से सुनाई नहीं दिया।",
    resumeLine: "हमने पहले {job} जॉब के बारे में बात की थी ना।", // a call-back call (memory, 2026-10-30)
    // hearing problems / unclear answers (2026-10-29 fixes): never guess, ask again; never an endless loop
    notClear: "सॉरी, आपकी आवाज़ ठीक से नहीं आई।",
    breaking: "सॉरी, आपकी आवाज़ कट रही है।",
    audioClose: "सॉरी, लाइन क्लियर नहीं है। थोड़ी देर बाद फिर कॉल करता हूँ। बाय।",
    stillThere: "हैलो, लाइन पर हैं?",
    stillThere2: "हैलो, आवाज़ आ रही है?",
    noAnswerClose: "आपकी आवाज़ नहीं आ रही, थोड़ी देर बाद फिर कॉल करता हूँ। बाय।",
    yesOrNo: "सॉरी, हाँ बोला या ना?",
    sureRepeat: "ओके, फिर से बताता हूँ।",
    canHear: "सॉरी। अब आवाज़ आ रही है?",
    whyNot: "ओके। एक बात पूछूँ, ये जॉब पसंद नहीं आई, या अभी जॉब चेंज करने का सोच नहीं रहे?",
    // not interested: one honest try to keep them, then other jobs (founder 2026-10-30)
    pitchAck: "समझ गया। एक बार सोचिए।",
    pitchNotNow: "समझ गया। अभी बदलने का सोच नहीं रहे, फिर भी एक बार देखने में कोई हर्ज नहीं।",
    pitchJob: "ये {location} में {kind} जॉब है।",
    pitchPay: "सैलरी {salary} तक है।",
    pitchNoLoss: "इंटरव्यू देने में कोई नुकसान नहीं, कोई कमिटमेंट भी नहीं।",
    convinceSalary: "समझ गया। इस जॉब में सैलरी {salary} तक है, इंटरव्यू में उस पर बात कर सकते हैं।",
    convinceLoc: "समझ गया। जॉब {location} में है।",
    convinceGeneral: "समझ गया। ये {kind} जॉब है, इंटरव्यू देने से कोई कमिटमेंट नहीं होता।",
    convinceBare: "समझ गया। इंटरव्यू देने से कोई कमिटमेंट नहीं होता।",
    convinceQ: "एक बार ट्राई करें?",
    keepOtherQ: "कोई बात नहीं। आपके लिए सही कोई और जॉब आए तो कॉल करूँ?",
    keepOtherYes: "ठीक है, सही जॉब आने पर कॉल करूँगा। टाइम देने के लिए थैंक्यू। बाय।",
    checkFollowUp: "ओके, चेक कर लीजिए। फिर कब कॉल करूँ?",
    laterWhenAgain: "सॉरी, कौन सा दिन, कौन सा टाइम ठीक रहेगा?",
    thatsFine: "कोई बात नहीं।",
    langSwitched: 'ठीक है, हिंदी में बात करते हैं।',
    // SPOKEN LIKE A PERSON (founder 2026-10-30: "oka person laaga matladali"): a short acknowledgement of what they said
    ackName: "ओके, थैंक्यू।",
    ackTime: "थैंक्यू।",
    ackInterest: "बढ़िया।",
    ackExp: "ओके, {yrs}।",
    ackFresher: "अच्छा, आप फ्रेशर हैं।",
    ackLoc: "अच्छा, {place}।",
    ackNotice: "ओके, {days} दिन।",
    ackNoticeNow: "अच्छा, तुरंत जॉइन कर सकते हैं।",
    ackNoted: "ओके, नोट कर लिया।",
    briefWhere: "जॉब {location} में है",
    briefExpSkills: "{experience} का एक्सपीरियंस चाहिए, मेनली {skills}।",
    calmSorry: "सॉरी, शायद बिज़ी टाइम पर कॉल कर दिया। जल्दी खत्म करता हूँ।",
    calmOffer: "आगे बात करूँ, या जब फ्री हों तब रिक्रूटर कॉल करें?",
    calmClose: "समझ गया, सॉरी डिस्टर्ब किया। अभी और टाइम नहीं लूँगा। थैंक्यू।",
    noMoney: "टीमलिंक कभी कोई पैसा या फीस नहीं माँगता, OTP या बैंक डिटेल्स भी नहीं। ये सिर्फ़ आपकी जॉब एप्लिकेशन के बारे में है।",
    shortNews: "आप {job} पोस्ट के लिए शॉर्टलिस्ट हुए हैं, यही बताने के लिए कॉल किया।",
    shortIv: "आपका इंटरव्यू {date} को {time} बजे है।",
    shortNoIv: "इंटरव्यू अभी फिक्स नहीं हुआ, टीम बाद में बताएगी।",
    shortProceed: "नेक्स्ट स्टेप के लिए चलें?",
    shortYes: "थैंक्यू। आगे क्या करना है, जल्दी बताएँगे। शॉर्टलिस्ट मतलब बस एक स्टेप, फ़ाइनल डिसीजन नहीं। बाय।",
    // AI interview pending (Job Portal calling, 2026-10-30)
    aiNews: "आपने टीमलिंक जॉब्स वेबसाइट पर {job} जॉब के लिए अप्लाई किया था ना। उसका AI इंटरव्यू अभी पेंडिंग है।",
    aiDue: "{date} तक कंप्लीट कर दीजिए।",
    aiHow: "अपने मोबाइल नंबर या ईमेल से टीमलिंक जॉब्स वेबसाइट पर लॉगिन करके माय एप्लिकेशन्स खोलिए, वहीं AI इंटरव्यू मिलेगा।",
    aiProceed: "कंप्लीट कर पाएँगे?",
    aiYes: "थैंक्यू। डेडलाइन से पहले कंप्लीट कर दीजिए, फिर रिक्रूटर आपकी एप्लिकेशन देखेंगे। बाय।",
    ivIntro: "{job} पोस्ट के लिए आपका इंटरव्यू {date} को {time} बजे फिक्स हुआ है।",
    ivRemind: "बस याद दिलाने के लिए कॉल किया, {job} पोस्ट का आपका इंटरव्यू {date} को {time} बजे है।",
    ivOnline: "इंटरव्यू ऑनलाइन है। मीटिंग लिंक मैसेज में भेज देंगे।",
    ivOnlineNoLink: "इंटरव्यू ऑनलाइन है। लिंक रिक्रूटर भेज देंगे।",
    ivInPerson: "इंटरव्यू {location} में डायरेक्ट है।",
    ivInPersonNoLoc: "इंटरव्यू डायरेक्ट है। एड्रेस रिक्रूटर बता देंगे।",
    ivPhone: "इंटरव्यू फ़ोन पर ही है।",
    ivInstr: "एक बात याद रखिए: {instructions}",
    ivAvail: "आप आ पाएँगे?",
    ivConfirmed: "बढ़िया, थैंक्यू। टाइम पर रेडी रहिए। बाय।",
    ivReschedAsk: "आपके लिए कौन सा टाइम ठीक रहेगा?",
    ivReschedNoted: "ओके, रिक्रूटर को बता दूँगा। जब तक वो कन्फर्म न करें, इंटरव्यू पुराने टाइम पर ही रहेगा। बाय।",
    ivNotAvail: "बताने के लिए थैंक्यू। रिक्रूटर आपको कॉल करेंगे। बाय।",
    ivNoReply: "ओके, कन्फर्म करने के लिए रिक्रूटर कॉल करेंगे। बाय।",
    tz: "इंडिया टाइम",
  },
  Telugu: {
    ai: "హలో, టీమ్‌లింక్ కన్సల్టెంట్స్ నుంచి కాల్ చేస్తున్నా, నేను వాళ్ళ AI అసిస్టెంట్‌ని.",
    noticeRec: "ఈ కాల్ రికార్డ్ అవ్వొచ్చు, నోట్స్ కూడా రాసుకుంటాం.",
    identity: "{name} గారేనా మాట్లాడేది?",
    identityAgain: "సారీ, సరిగ్గా వినపడలేదు. {name} గారేనా మాట్లాడేది?",
    identityNeeded: "ముందు {name} గారితోనే మాట్లాడుతున్నానా అని కన్ఫర్మ్ చేసుకోవాలి, తర్వాత డీటెయిల్స్ చెప్తా.",
    wrong: "అయ్యో, సారీ, రాంగ్ నంబర్ అనుకుంటా. బై.",
    convenient: "ఇప్పుడు ఒక రెండు నిమిషాలు మాట్లాడొచ్చా?",
    laterAsk: "పర్లేదు. మళ్ళీ ఎప్పుడు కాల్ చేయమంటారు?",
    laterClose: "ఓకే, తర్వాత మళ్ళీ కాల్ చేస్తా. బై.",
    laterNoted: "ఓకే, {when}, నోట్ చేసుకున్నా. అప్పుడే కాల్ చేస్తా. బై.",
    screenIntro: "మా దగ్గర ఒక {job} జాబ్ ఉంది. దాని గురించి కొంచెం చెప్పనా?",
    matchIntro: "మీరు ఇంతకుముందు టీమ్‌లింక్‌లో అప్లై చేశారు కదా. మీ ప్రొఫైల్‌కి మ్యాచ్ అయ్యే ఇంకో జాబ్ ఉంది, {job}. దాని గురించి కొంచెం చెప్పనా?", // Job Match (Job Portal calling, 2026-10-30)
    briefLoc: "జాబ్ {location} లో.",
    briefNeeds: "వాళ్ళకి కావాల్సింది: {needs}.", // what the requirement asks for, from the ATS description (2026-10-30)
    briefMode: "{workMode}.",
    briefType: "{employmentType} జాబ్.",
    briefExp: "{experience} ఎక్స్‌పీరియన్స్ కావాలి.",
    briefSkills: "మెయిన్‌గా {skills} రావాలి.",
    briefResp: "వర్క్ ఏంటంటే: {responsibilities}.",
    briefSalary: "సాలరీ {salary} వరకు ఉంటుంది.",
    briefNone: "పూర్తి డీటెయిల్స్ ఇంకోసారి కాల్ చేసినప్పుడు చెప్తా.",
    interestQ: "ఈ జాబ్ మీకు ఇంట్రెస్ట్ ఉందా?",
    interestMore: "జాబ్ గురించి ఇంకోసారి చెప్పనా?",
    qExp: "ఈ ఫీల్డ్‌లో మీకు ఎన్నేళ్ళ ఎక్స్‌పీరియన్స్ ఉంది?",
    qLoc: "ఇప్పుడు మీరు ఎక్కడ ఉంటున్నారు?",
    qNotice: "మీ నోటీస్ పీరియడ్ ఎన్ని రోజులు?",
    qProceed: "ఓకే, ముందుకు వెళ్దామా?",
    closeInterested: "థాంక్స్. అన్నీ నోట్ చేసుకున్నా. తర్వాత ఏం చేయాలో త్వరలో మీకు తెలియజేస్తాం. ఈ కాల్‌తోనే ఏదీ ఫైనల్ కాదు. బై.",
    closeNotInterested: "ఓకే, పర్లేదు. టైమ్ ఇచ్చినందుకు థాంక్స్. బై.",
    closeStop: "ఓకే, ఇంకెప్పుడూ కాల్ చేయం. బై.",
    closeUnclear: "సరే, లైన్ సరిగ్గా లేనట్టుంది. మళ్ళీ కాల్ చేస్తా. థాంక్స్.",
    humanNoted: "ఓకే, మీరు రిక్రూటర్‌తో మాట్లాడాలనుకుంటున్నారని నోట్ చేసుకున్నా. టీమ్ నుంచి ఎవరైనా కాల్ చేస్తారు.",
    amAi: "నేను టీమ్‌లింక్ వాళ్ళ AI అసిస్టెంట్‌ని, మనిషిని కాదు.",
    noSalary: "అది టీమ్‌తో కన్ఫర్మ్ చేసుకుని మీకు చెప్తా.",
    noInfo: "అది టీమ్‌తో కన్ఫర్మ్ చేసుకుని మీకు చెప్తా.",
    onlyYou: "నేను మీ అప్లికేషన్ గురించి మాత్రమే మాట్లాడగలను.",
    repeat: "సారీ, సరిగ్గా వినపడలేదు.",
    resumeLine: "ఇంతకుముందు మనం {job} జాబ్ గురించి మాట్లాడుకున్నాం కదా.", // a call-back call (memory, 2026-10-30)
    // hearing problems / unclear answers (2026-10-29 fixes): never guess, ask again; never an endless loop
    notClear: "సారీ, మీ మాట సరిగ్గా వినపడలేదు.",
    breaking: "సారీ, మీ వాయిస్ కట్ అవుతుంది.",
    audioClose: "సారీ, లైన్ క్లియర్‌గా లేదు. కాసేపాగి మళ్ళీ కాల్ చేస్తా. బై.",
    stillThere: "హలో, లైన్‌లో ఉన్నారా?",
    stillThere2: "హలో, వినపడుతుందా?",
    noAnswerClose: "మీ మాట వినపడట్లేదు, కాసేపాగి మళ్ళీ కాల్ చేస్తా. బై.",
    yesOrNo: "సారీ, అవునా కాదా?",
    sureRepeat: "ఓకే, మళ్ళీ చెప్తా.",
    canHear: "సారీ. ఇప్పుడు వినపడుతుందా?",
    whyNot: "ఓకే. ఒక్కటి అడగొచ్చా, ఈ జాబ్ నచ్చలేదా, లేక ఇప్పుడు జాబ్ మారే ఆలోచన లేదా?",
    // not interested: one honest try to keep them, then other jobs (founder 2026-10-30)
    pitchAck: "అర్థమైంది. ఒక్కసారి ఆలోచించండి.",
    pitchNotNow: "అర్థమైంది. ఇప్పుడు మారే ఆలోచన లేకపోయినా, ఒక్కసారి చూడటంలో తప్పులేదు.",
    pitchJob: "ఇది {location} లో {kind} జాబ్.",
    pitchPay: "సాలరీ {salary} వరకు ఉంది.",
    pitchNoLoss: "ఇంటర్వ్యూకి వెళ్తే మీకు ఏ నష్టం లేదు, ఏ కమిట్‌మెంట్ కూడా ఉండదు.",
    convinceSalary: "అర్థమైంది. ఈ జాబ్‌కి సాలరీ {salary} వరకు ఉంది, ఇంటర్వ్యూలో దాని గురించి మాట్లాడొచ్చు.",
    convinceLoc: "అర్థమైంది. జాబ్ {location} లో ఉంది.",
    convinceGeneral: "అర్థమైంది. ఇది {kind} జాబ్, ఇంటర్వ్యూ అటెండ్ అయితే ఏ కమిట్‌మెంట్ ఉండదు.",
    convinceBare: "అర్థమైంది. ఇంటర్వ్యూ అటెండ్ అయితే ఏ కమిట్‌మెంట్ ఉండదు.",
    convinceQ: "ఒక్కసారి ట్రై చేద్దామా?",
    keepOtherQ: "పర్లేదు. మీకు సరిపోయే వేరే జాబ్ వస్తే కాల్ చేయమంటారా?",
    keepOtherYes: "సరే, సరిపోయే జాబ్ వస్తే కాల్ చేస్తా. టైమ్ ఇచ్చినందుకు థాంక్స్. బై.",
    checkFollowUp: "ఓకే, చెక్ చేసుకోండి. మళ్ళీ ఎప్పుడు కాల్ చేయమంటారు?",
    laterWhenAgain: "సారీ, ఏ రోజు, ఏ టైమ్‌కి కాల్ చేయమంటారు?",
    thatsFine: "పర్లేదు.",
    langSwitched: 'సరే, తెలుగులో మాట్లాడుకుందాం.',
    // SPOKEN LIKE A PERSON (founder 2026-10-30: "oka person laaga matladali"): a short acknowledgement of what they said
    ackName: "ఓకే, థాంక్స్.",
    ackTime: "థాంక్స్.",
    ackInterest: "మంచిది.",
    ackExp: "ఓకే, {yrs}.",
    ackFresher: "ఓకే, ఫ్రెషర్ అన్నమాట.",
    ackLoc: "ఓకే, {place}.",
    ackNotice: "ఓకే, {days} రోజులు.",
    ackNoticeNow: "ఓకే, వెంటనే జాయిన్ అవ్వొచ్చన్నమాట.",
    ackNoted: "ఓకే, నోట్ చేసుకున్నా.",
    briefWhere: "జాబ్ {location} లో",
    briefExpSkills: "{experience} ఎక్స్‌పీరియన్స్ ఉండాలి, మెయిన్‌గా {skills}.",
    calmSorry: "సారీ, బిజీగా ఉన్నప్పుడు కాల్ చేసినట్టున్నా. త్వరగా అయిపోతుంది.",
    calmOffer: "కంటిన్యూ చేయనా, లేక మీకు ఫ్రీగా ఉన్నప్పుడు రిక్రూటర్ కాల్ చేయాలా?",
    calmClose: "అర్థమైంది, ఇబ్బంది పెట్టినందుకు సారీ. ఇంక టైమ్ తీసుకోను. థాంక్స్.",
    noMoney: "టీమ్‌లింక్ ఎప్పుడూ డబ్బులు, ఫీజు ఏమీ అడగదు. OTP, బ్యాంక్ డీటెయిల్స్ కూడా అడగదు. ఇది మీ జాబ్ అప్లికేషన్ గురించి మాత్రమే.",
    shortNews: "{job} పోస్ట్‌కి మీరు షార్ట్‌లిస్ట్ అయ్యారు, అది చెప్పడానికే కాల్ చేశా.",
    shortIv: "మీ ఇంటర్వ్యూ {date} న {time} కి.",
    shortNoIv: "ఇంటర్వ్యూ ఇంకా ఫిక్స్ కాలేదు, టీమ్ తర్వాత చెప్తుంది.",
    shortProceed: "ముందుకు వెళ్దామా?",
    shortYes: "థాంక్స్. తర్వాత ఏం చేయాలో త్వరలో మీకు తెలియజేస్తాం. షార్ట్‌లిస్ట్ అంటే ఒక స్టెప్ అంతే, ఫైనల్ డెసిషన్ కాదు. బై.",
    // AI interview pending (Job Portal calling, 2026-10-30)
    aiNews: "మీరు టీమ్‌లింక్ జాబ్స్ వెబ్‌సైట్‌లో {job} జాబ్‌కి అప్లై చేశారు కదా. దాని AI ఇంటర్వ్యూ ఇంకా పెండింగ్‌లో ఉంది.",
    aiDue: "{date} లోపు కంప్లీట్ చేయండి.",
    aiHow: "మీ మొబైల్ నంబర్ లేదా ఈమెయిల్‌తో టీమ్‌లింక్ జాబ్స్ వెబ్‌సైట్‌లో లాగిన్ అయ్యి, మై అప్లికేషన్స్ ఓపెన్ చేస్తే, అక్కడ AI ఇంటర్వ్యూ ఉంటుంది.",
    aiProceed: "అది కంప్లీట్ చేయగలరా?",
    aiYes: "థాంక్స్. డెడ్‌లైన్ లోపు కంప్లీట్ చేయండి, అప్పుడు రిక్రూటర్ మీ అప్లికేషన్ చూస్తారు. బై.",
    ivIntro: "{job} పోస్ట్‌కి మీ ఇంటర్వ్యూ {date} న {time} కి ఫిక్స్ అయింది.",
    ivRemind: "జస్ట్ గుర్తు చేయడానికి కాల్ చేశా, {job} పోస్ట్‌కి మీ ఇంటర్వ్యూ {date} న {time} కి ఉంది.",
    ivOnline: "ఇంటర్వ్యూ ఆన్‌లైన్‌లో. మీటింగ్ లింక్ మెసేజ్‌లో పంపిస్తాం.",
    ivOnlineNoLink: "ఇంటర్వ్యూ ఆన్‌లైన్‌లో. లింక్ రిక్రూటర్ పంపిస్తారు.",
    ivInPerson: "ఇంటర్వ్యూ డైరెక్ట్‌గా {location} లో.",
    ivInPersonNoLoc: "ఇంటర్వ్యూ డైరెక్ట్‌గా. అడ్రస్ రిక్రూటర్ చెప్తారు.",
    ivPhone: "ఇంటర్వ్యూ ఫోన్‌లోనే.",
    ivInstr: "ఒక్క విషయం: {instructions}",
    ivAvail: "మీరు వస్తారా?",
    ivConfirmed: "సూపర్, థాంక్స్. టైమ్‌కి రెడీగా ఉండండి. బై.",
    ivReschedAsk: "మీకు ఏ టైమ్ అయితే ఓకే?",
    ivReschedNoted: "ఓకే, రిక్రూటర్‌కి చెప్తా. వాళ్ళు కన్ఫర్మ్ చేసే వరకు ఇంటర్వ్యూ పాత టైమ్‌కే ఉంటుంది. బై.",
    ivNotAvail: "చెప్పినందుకు థాంక్స్. రిక్రూటర్ మీకు కాల్ చేస్తారు. బై.",
    ivNoReply: "ఓకే, కన్ఫర్మ్ చేయడానికి రిక్రూటర్ కాల్ చేస్తారు. బై.",
    tz: 'ఇండియా టైమ్',
  },
};

// OTHER WAYS OF SAYING THE SAME LINE (founder 2026-10-30: "manam humans yela matladthunnamo, same alaagey ai kuda matladali"):
// one call picks one wording per line (seeded by the call id, so it stays the same within the call and differs between
// calls); without a seed the first wording is used (previews, tests). Every variant passes the same forbidden-word check.
const VARIANTS = {
  "English": {
    "ai": [
      "Hello, I'm calling from TeamLink Consultants. I am their AI recruitment assistant."
    ],
    "convenient": [
      "Is this a good time to talk for two minutes?",
      "Can we talk for two minutes now?"
    ],
    "laterAsk": [
      "Sure, no problem. When can we call you back?",
      "Okay, when is a better time to call?"
    ],
    "screenIntro": [
      "There is a job opening for {job} with us. Shall I tell you about it?",
      "We have a job for {job}. Can I tell you about it?"
    ],
    "interestQ": [
      "Is this job interesting for you?",
      "Would you like this job?"
    ],
    "qExp": [
      "How many years of experience do you have?",
      "How many years have you worked in this field?"
    ],
    "qLoc": [
      "Which city do you live in now?",
      "Which city are you in now?"
    ],
    "qNotice": [
      "What is your notice period?",
      "How many days of notice period do you have?"
    ],
    "qProceed": [
      "Can we move forward?",
      "Shall we go ahead?"
    ],
    "closeInterested": [
      "Great, thank you. I have noted everything. We will send you the next details soon. Nothing is final from this call. Bye."
    ],
    "closeNotInterested": [
      "No problem. Thanks for your time. Bye.",
      "Okay. Thank you for talking. Bye."
    ],
    "repeat": [
      "Sorry, I missed that.",
      "Sorry, I didn't get that."
    ],
    "notClear": [
      "Sorry, I couldn't hear you properly."
    ],
    "ackName": [
      "Thanks for picking up."
    ],
    "ackTime": [
      "Okay, thank you.",
      "Thanks a lot."
    ],
    "ackInterest": [
      "Great.",
      "Nice."
    ],
    "ackExp": [
      "Got it, {yrs}.",
      "{yrs}, okay."
    ],
    "ackLoc": [
      "{place}, okay.",
      "Oh, {place}."
    ],
    "ackNotice": [
      "Okay, {days} days notice.",
      "{days} days, okay."
    ],
    "ackNoted": [
      "Got it."
    ]
  },
  "Telugu": {
    "convenient": [
      "ఇప్పుడు రెండు నిమిషాలు టైమ్ ఉందా?",
      "ఒక రెండు నిమిషాలు మాట్లాడదామా?"
    ],
    "laterAsk": [
      "సరే, నో ప్రాబ్లమ్. ఎప్పుడు కాల్ చేస్తే బాగుంటుంది?",
      "పర్లేదు. మీకు ఎప్పుడు వీలవుతుంది?"
    ],
    "screenIntro": [
      "మా దగ్గర ఒక {job} జాబ్ ఓపెనింగ్ ఉంది. దాని గురించి కొంచెం చెప్పనా?",
      "ఒక {job} జాబ్ ఉంది. కొంచెం డీటెయిల్స్ చెప్పనా?"
    ],
    "interestQ": [
      "ఎలా అనిపిస్తుంది, ఈ జాబ్ మీకు ఇంట్రెస్ట్ ఉందా?",
      "మీకు ఈ జాబ్ చేయాలని ఉందా?"
    ],
    "qExp": [
      "ఈ ఫీల్డ్‌లో మీకు ఎంత ఎక్స్‌పీరియన్స్ ఉంది?",
      "మీరు ఈ లైన్‌లో ఎన్నేళ్ళుగా వర్క్ చేస్తున్నారు?"
    ],
    "qLoc": [
      "మీరు ఇప్పుడు ఎక్కడ స్టే చేస్తున్నారు?",
      "మీరు ఇప్పుడు ఏ సిటీలో ఉన్నారు?"
    ],
    "qNotice": [
      "మీ నోటీస్ పీరియడ్ ఎంత?",
      "జాయిన్ అవ్వడానికి ఎన్ని రోజులు పడుతుంది, అంటే మీ నోటీస్ పీరియడ్?"
    ],
    "qProceed": [
      "సరే, ముందుకు వెళ్దామా?",
      "దీన్ని ముందుకు తీసుకెళ్దామా?"
    ],
    "closeInterested": [
      "సూపర్, థాంక్స్. అన్నీ నోట్ చేసుకున్నా, తర్వాత ఏం చేయాలో త్వరలో చెప్తాం. ఈ కాల్‌తో ఏదీ ఫైనల్ కాదు. బై."
    ],
    "closeNotInterested": [
      "పర్లేదు, టైమ్ ఇచ్చినందుకు థాంక్స్. బై.",
      "ఓకే, నో ప్రాబ్లమ్. థాంక్స్, బై."
    ],
    "repeat": [
      "సారీ, సరిగ్గా వినపడలేదు.",
      "సారీ, మిస్ అయ్యాను."
    ],
    "notClear": [
      "సారీ, మీ మాట క్లియర్‌గా వినపడలేదు."
    ],
    "ackName": [
      "కాల్ లిఫ్ట్ చేసినందుకు థాంక్స్."
    ],
    "ackTime": [
      "సరే, థాంక్స్.",
      "థాంక్స్."
    ],
    "ackInterest": [
      "సూపర్.",
      "గుడ్."
    ],
    "ackExp": [
      "ఓకే, {yrs} ఎక్స్‌పీరియన్స్.",
      "{yrs}, గుడ్."
    ],
    "ackLoc": [
      "ఓహ్, {place}.",
      "{place}, సరే."
    ],
    "ackNotice": [
      "ఓకే, {days} రోజుల నోటీస్.",
      "{days} రోజులు, సరే."
    ],
    "ackNoted": [
      "ఓకే."
    ]
  },
  "Hindi": {
    "convenient": [
      "क्या अभी दो मिनट का टाइम है?",
      "दो मिनट बात कर सकते हैं?"
    ],
    "laterAsk": [
      "ठीक है, कोई बात नहीं। कब कॉल करें?",
      "कोई बात नहीं। आपको कब ठीक रहेगा?"
    ],
    "screenIntro": [
      "हमारे पास एक {job} की ओपनिंग है। उसके बारे में थोड़ा बताऊँ?",
      "एक {job} की जॉब है। जल्दी से डिटेल्स बताऊँ?"
    ],
    "interestQ": [
      "कैसा लगा, आपको इस जॉब में इंटरेस्ट है?",
      "क्या आप ये जॉब करना चाहेंगे?"
    ],
    "qExp": [
      "इस फील्ड में आपका कितना एक्सपीरियंस है?",
      "आप कितने साल से इस लाइन में काम कर रहे हैं?"
    ],
    "qLoc": [
      "अभी आप कहाँ रहते हैं?",
      "अभी आप कौन सी सिटी में हैं?"
    ],
    "qNotice": [
      "आपका नोटिस पीरियड कितना है?",
      "जॉइन करने में कितने दिन लगेंगे, मतलब आपका नोटिस पीरियड?"
    ],
    "qProceed": [
      "तो आगे बढ़ें?",
      "इसे आगे ले चलें?"
    ],
    "closeInterested": [
      "बढ़िया, थैंक्यू। सब नोट कर लिया, आगे क्या करना है जल्दी बताएँगे। इस कॉल से कुछ भी फ़ाइनल नहीं है। बाय।"
    ],
    "closeNotInterested": [
      "कोई बात नहीं, टाइम देने के लिए थैंक्यू। बाय।",
      "ठीक है, नो प्रॉब्लम। थैंक्यू, बाय।"
    ],
    "repeat": [
      "सॉरी, ठीक से सुनाई नहीं दिया।",
      "सॉरी, मैं समझ नहीं पाया।"
    ],
    "notClear": [
      "सॉरी, आपकी आवाज़ साफ़ नहीं आई।"
    ],
    "ackName": [
      "कॉल उठाने के लिए थैंक्यू।"
    ],
    "ackTime": [
      "ठीक है, थैंक्यू।",
      "थैंक्यू जी।"
    ],
    "ackInterest": [
      "अच्छा है।",
      "बहुत बढ़िया।"
    ],
    "ackExp": [
      "अच्छा, {yrs} का एक्सपीरियंस।",
      "{yrs}, बढ़िया।"
    ],
    "ackLoc": [
      "ठीक है, {place}।",
      "ओह, {place}।"
    ],
    "ackNotice": [
      "अच्छा, {days} दिन का नोटिस।",
      "{days} दिन, ठीक है।"
    ],
    "ackNoted": [
      "अच्छा।"
    ]
  }
};
const seedHash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const plainCache = {};
function phrases(language, seed) {
  const lang = LANGS.includes(language) ? language : 'English';
  if (seed == null || seed === '') return plainCache[lang] || (plainCache[lang] = { ...PH[lang] });
  const out = { ...PH[lang] };
  for (const [k, alts] of Object.entries(VARIANTS[lang] || {})) {
    const all = [out[k], ...alts].filter((x) => typeof x === 'string' && x);
    out[k] = all[seedHash(`${seed}|${k}`) % all.length];
  }
  return out;
}

// A value from the database is made safe to speak: control characters and braces out, one line, short.
function clean(v, max = 120) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f{}<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Fill {slots}. A slot with no value makes the whole sentence disappear (never half a sentence, never an invented value).
function fill(template, slots) {
  let missing = false;
  const out = String(template).replace(/\{(\w+)\}/g, (_m, k) => {
    const val = slots && slots[k] != null ? clean(slots[k], 220) : '';
    if (!val) missing = true;
    return val;
  });
  return missing ? '' : out;
}

// --- India time, written the way it is spoken ----------------------------------------------------------------------------
const LOCALE = { English: 'en-IN', Hindi: 'hi-IN', Telugu: 'te-IN' };
function dateWords(date, language) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALE[language] || 'en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(d);
}
function timeWords(date, language) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Intl.DateTimeFormat(LOCALE[language] || 'en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }).format(d).replace(/\s+/g, ' ').toUpperCase();
  return `${t} ${phrases(language).tz}`;
}

// --- the verified facts of one call ---------------------------------------------------------------------------------------
const WORK_MODE = { 'work from office': 'work from office', 'work from home': 'work from home', hybrid: 'hybrid', remote: 'remote', onsite: 'on site' };
const MODE_KIND = (m) => {
  const t = String(m || '').toLowerCase();
  if (/online|video|virtual/.test(t)) return 'online';
  if (/person|walk|face|office|onsite|on-site/.test(t)) return 'in_person';
  if (/phone|tele/.test(t)) return 'phone';
  return null;
};
function firstItems(text, n, max) {
  return String(text || '').split(/[\n,;•*]+/).map((s) => clean(s.replace(/^[\s\-–—\d.)]+/, ''), 80)).filter(Boolean).slice(0, n).join(', ').slice(0, max);
}
function experienceWords(exp) {
  const t = clean(exp, 30);
  if (!t) return '';
  const m = /^(\d{1,2})\s*[-–to]+\s*(\d{1,2})$/i.exec(t);
  if (m) return `${m[1]} to ${m[2]} years`;
  if (/^\d{1,2}(\.\d)?$/.test(t)) return `${t} years`;
  return /year|yr/i.test(t) ? t : '';
}

// THE REQUIREMENT AS IT IS WRITTEN IN THE ATS (founder 2026-10-30: "reqments ni care ga, ats nunchi study chesko"). Many
// requirements keep their real facts only in the description ("Location: Kakinada", "M.Tech CSE 4 members", "CSE - 40k",
// "Fresher & 1 to 2 Experience"), with the structured fields empty. These are READ from it, word for word where possible;
// nothing is guessed. A structured field, when filled, always wins.
const NOISE_LINE = /^(requirements?|positions?|requirements?\s*\/\s*positions?|post(i|)on)\b.*:?\s*$|^from the .*sheet|^post(i|)on\s*[:\-]/i;
// "LB NAGAR TO MEHADIPANAM ROAD" -> "LB Nagar to Mehadipanam Road" (2-letter words stay capitals: a place code)
const titleCase = (v) => v.split(/\s+/).map((w) => (/^(TO|AND|OF|ON|NEAR|IN|AT)$/.test(w) ? w.toLowerCase() : (w.length <= 2 && /^[A-Z]+$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))).join(' ');
function descriptionFacts(desc) {
  const out = { location: '', experience: '', needs: '', salary: '' };
  const lines = String(desc || '').replace(/[\u2060\u200b-\u200f\ufeff]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return out;
  // where: the "Location:" line, its first sentence
  const loc = lines.find((l) => /^location\s*[:\-]/i.test(l));
  if (loc) {
    let v = loc.replace(/^location\s*[:\-]\s*/i, '').split(/\.\s|\.$/)[0].replace(/^located\s+/i, '').replace(/^(on the way|on the way to|near|at|in)\s+/i, '');
    if (v && v === v.toUpperCase()) v = titleCase(v);
    out.location = clean(v, 70);
  }
  // experience: a range ("1 to 2 Experience", "2-5 yrs") or one number of years ("5 years industrial experience")
  const all = lines.join(' ');
  const range = /(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\s*\+?\s*(?:yrs?|years?|experience|exp)\b/i.exec(all);
  const single = /(\d{1,2})\s*\+?\s*(?:yrs?|years?)\b/i.exec(all);
  if (range) out.experience = `${range[1]} to ${range[2]} years`;
  else if (single) out.experience = `${single[1]} years`;
  // salary lines: "CSE - 40k", "Physics - 20 - 25k", "3 - 4 LPA"
  const pay = [];
  lines.forEach((l) => {
    const k = /^(.*?)[\s:\-–]*(\d{1,3})\s*(?:-|to|–)?\s*(\d{1,3})?\s*k\b/i.exec(l);
    const lpa = /^(.*?)[\s:\-–]*(\d{1,2}(?:\.\d)?)\s*(?:-|to|–)?\s*(\d{1,2}(?:\.\d)?)?\s*lpa\b/i.exec(l);
    const m = k || lpa;
    if (!m) return;
    const who = clean(m[1].replace(/[\s:\-–]+$/, ''), 30);
    const amt = `${m[2]}${m[3] ? ` to ${m[3]}` : ''} ${k ? 'thousand' : 'lakh per year'}`;
    pay.push(who ? `${who} ${amt}` : amt);
  });
  out.salary = clean(pay.slice(0, 3).join(', '), 120);
  // what they need: the list lines (subjects, roles, degrees) - not the sentences, dates, pay, place or experience lines
  const items = [];
  lines.forEach((l) => {
    if (NOISE_LINE.test(l) || /^location\s*[:\-]/i.test(l) || /\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(l)) return;
    // a heading ("Package:") or a rule / benefit line (hours, age limit, accommodation, bed capacity) is not what they need
    if (/:\s*$/.test(l) || /working hours|age limit|as per nmc|accom+od|bed capacity|timing|days a week|qualification|package/i.test(l)) return;
    if (/\b\d+\s*k\b|lpa|₹|salary|ctc|experience|fresher|eligible|who have|require/i.test(l)) return;
    l.replace(/^\d+[.)]\s*/, '').split(',').forEach((part) => {
      const v = part.replace(/\b\d+\s*(members?|persons?|people|posts?|nos?|vacanc(y|ies))\b/ig, '').replace(/^\d+\s+/, '').replace(/\s+/g, ' ').trim();
      const junk = (v.length < 4 && !/^[A-Z][A-Za-z.]{1,3}$/.test(v)) || /^(years?|yrs?|experience|exp|male|female|any|nil|na|n\/a)\.?$/i.test(v) || /\b(female|male|gender|mandatory|language|preferred|age|years? of)\b/i.test(v);
      if (v && !junk && v.length <= 40 && /[a-z]/i.test(v) && !items.some((x) => x.toLowerCase() === v.toLowerCase())) items.push(v);
    });
  });
  out.needs = clean(items.slice(0, 5).join(', '), 160);
  return out;
}
// "Faculty requirement" is said as "Faculty" ("We have a Faculty job open")
const spokenTitle = (t) => clean(String(t || '').replace(/\s*[-–(]?\s*\b(requirements?|vacanc(y|ies)|openings?|positions?)\b\)?\s*$/i, '').replace(/\s+[—–]\s+/g, ', '), 100) || clean(t, 100);

// requirement + application + candidate -> the facts. NOTHING that is not stored is added.
function buildData({ candidate, app, requirement, link }) {
  const c = candidate || {};
  const r = requirement || {};
  const a = app || {};
  const first = clean(String(c.name || '').split(/\s+/)[0], 40);
  const kind = MODE_KIND(a.interviewMode);
  const fromDesc = descriptionFacts(r.description);
  let linkOk = false;
  if (link != null) linkOk = !!link; // caller already verified it
  const data = {
    name: clean(c.name, 80),
    firstName: first,
    jobTitle: spokenTitle(r.title),
    location: clean(r.location, 80) || fromDesc.location,
    workMode: WORK_MODE[String(r.workMode || '').toLowerCase()] || '',
    employmentType: clean(r.employmentType, 40).toLowerCase(),
    experience: experienceWords(r.experience) || experienceWords(r.relevantExperience) || fromDesc.experience,
    needs: fromDesc.needs,
    skills: firstItems(r.skills, 6, 160),
    responsibilities: firstItems(r.responsibilities, 3, 220),
    // the pay of THIS role from a "Package:" list in the description ("Assistant professor -1.2L"), when the field is empty
    salary: clean(r.salary, 60) || fromDesc.salary || require('./answers').salaryOf({ data: {} }, r), // eslint-disable-line global-require
    interview: a.interviewAt ? {
      at: new Date(a.interviewAt).toISOString(),
      mode: kind,
      location: clean(a.interviewLocation, 160),
      hasLink: linkOk,
      round: a.interviewRound || 1,
    } : null,
    // the Job Portal AI interview's last day (India time), only when it is a real date
    aiDeadline: /^\d{4}-\d\d-\d\d/.test(String(a.aiInterviewDeadline || '')) ? `${String(a.aiInterviewDeadline).slice(0, 10)}T12:00:00+05:30` : null,
  };
  return data;
}

// The parts a recruiter may change in the preview. Everything else is locked (it is verified data).
function cleanFields(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const note = clean(f.instructions, 200);
  const extra = clean(f.extraNote, 200);
  return {
    includeSalary: f.includeSalary !== false,
    includeResponsibilities: f.includeResponsibilities !== false,
    instructions: note,
    extraNote: extra,
  };
}
// Returns an error sentence when an edited field breaks a rule.
function checkFields(fields) {
  for (const k of ['instructions', 'extraNote']) {
    const v = fields[k];
    if (!v) continue; // eslint-disable-line no-continue
    if (hasForbidden(v)) return 'The note cannot use words like selected, hired, offered or congratulations. The assistant never says those.';
    if (/https?:\/\/|www\.|\b\d{10}\b|@/.test(v)) return 'The note cannot contain a web address, a phone number or an email. Links go in the written message.';
  }
  return null;
}

// The named blocks of speech for one call. The live conversation (dialogue.js) and the preview below use THESE, so what the
// recruiter reads before confirming is what the assistant says.
function blocks(purpose, language, data, fieldsIn, opts = {}) {
  const P = phrases(language, opts.seed);
  const f = cleanFields(fieldsIn);
  const name = data.name || data.firstName;
  const iv = data.interview;
  const B = {};
  B.ai = `${P.ai}${opts.recordingNotice ? ` ${P.noticeRec}` : ''}`;
  B.identity = fill(P.identity, { name });
  B.convenient = P.convenient;
  B.intro = fill(purpose === 'Job Match' ? P.matchIntro : P.screenIntro, { job: data.jobTitle });
  // the job told the way a person says it: "It's in Hyderabad, work from office, full time. They want around 2 to 5 years
  // of experience, mainly in Nursing and ICU." (not a list of separate one-fact sentences)
  const where = data.location
    ? `${[fill(P.briefWhere, { location: data.location }), clean(data.workMode, 40), clean(data.employmentType, 40)].filter(Boolean).join(', ')}${language === 'Hindi' ? '।' : '.'}`
    : [fill(P.briefMode, { workMode: data.workMode }), fill(P.briefType, { employmentType: data.employmentType })].filter(Boolean).join(' ');
  const expSkills = data.experience && data.skills
    ? fill(P.briefExpSkills, { experience: data.experience, skills: data.skills })
    : [fill(P.briefExp, { experience: data.experience }), fill(P.briefSkills, { skills: data.skills })].filter(Boolean).join(' ');
  const brief = [
    where,
    data.skills ? '' : fill(P.briefNeeds, { needs: String(data.needs || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(', ') }),
    expSkills,
    f.includeResponsibilities ? fill(P.briefResp, { responsibilities: data.responsibilities }) : '',
    f.includeSalary && !String(data.salary || '').includes(',') ? fill(P.briefSalary, { salary: data.salary }) : '', // a list of pays: told when asked
    f.extraNote,
  ].filter(Boolean);
  B.brief = brief.length ? brief.join(' ') : P.briefNone;
  B.news = fill(P.shortNews, { job: data.jobTitle });
  B.shortIv = iv ? fill(P.shortIv, { date: dateWords(iv.at, language), time: timeWords(iv.at, language) }) : P.shortNoIv;
  B.aiNews = fill(P.aiNews, { job: data.jobTitle });
  B.aiDue = data.aiDeadline ? fill(P.aiDue, { date: dateWords(data.aiDeadline, language) }) : '';
  B.ivLine = iv ? fill(purpose === 'Interview Reminder' ? P.ivRemind : P.ivIntro, { job: data.jobTitle, date: dateWords(iv.at, language), time: timeWords(iv.at, language) }) : '';
  let modeLine = '';
  if (iv) {
    if (iv.mode === 'online') modeLine = iv.hasLink ? P.ivOnline : P.ivOnlineNoLink;
    else if (iv.mode === 'in_person') modeLine = iv.location ? fill(P.ivInPerson, { location: iv.location }) : P.ivInPersonNoLoc;
    else if (iv.mode === 'phone') modeLine = P.ivPhone;
  }
  B.ivMode = modeLine;
  B.ivInstr = f.instructions ? fill(P.ivInstr, { instructions: f.instructions }) : '';
  B.note = f.extraNote;
  return B;
}

// The ordered lines the assistant will say, for the preview.
function preview(purpose, language, data, fieldsIn, opts = {}) {
  const P = phrases(language);
  const B = blocks(purpose, language, data, fieldsIn, opts);
  const lines = [];
  const add = (key, text) => { if (text) lines.push({ key, text }); };
  add('ai', B.ai);
  add('identity', B.identity);
  if (screenLike(purpose)) {
    add('convenient', B.convenient);
    add('intro', B.intro);
    add('brief', B.brief);
    add('interest', P.interestQ);
    add('qExp', P.qExp);
    add('qLoc', P.qLoc);
    add('qNotice', P.qNotice);
    add('qProceed', P.qProceed);
    add('close', P.closeInterested);
  } else if (purpose === 'AI Interview Pending') {
    add('news', B.aiNews);
    add('due', B.aiDue);
    add('how', P.aiHow);
    add('note', B.note);
    add('proceed', P.aiProceed);
    add('close', P.aiYes);
  } else if (purpose === 'Shortlist Notification') {
    add('news', B.news);
    add('iv', B.shortIv);
    add('note', B.note);
    add('proceed', P.shortProceed);
    add('close', P.shortYes);
  } else {
    if (data.interview) {
      add('iv', B.ivLine);
      add('mode', B.ivMode);
      add('instructions', B.ivInstr);
      add('note', B.note);
      add('avail', P.ivAvail);
    }
    add('close', P.ivConfirmed);
  }
  return lines;
}

// All fixed sentences, for the "no forbidden word" test.
function checkTemplates() {
  const bad = [];
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(PH[lang])) if (hasForbidden(v)) bad.push(`${lang}.${k}`);
    for (const [k, alts] of Object.entries(VARIANTS[lang] || {})) alts.forEach((v, i) => { if (hasForbidden(v)) bad.push(`${lang}.${k}#${i + 1}`); });
  }
  return bad;
}

module.exports = {
  LANGS, PURPOSES, PORTAL_PURPOSES, screenLike, looksGarbled, TRANSACTIONAL, TZ, FORBIDDEN, hasForbidden, phrases, clean, fill, dateWords, timeWords, buildData, cleanFields, checkFields, blocks, preview, checkTemplates, MODE_KIND,
};
