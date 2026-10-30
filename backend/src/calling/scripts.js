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
const hasForbidden = (t) => FORBIDDEN.some((re) => re.test(String(t || '')));

// Everyday spoken words, the way people talk on the phone (user, 2026-10-28: "normal daily language, like humans"; no
// "అండి"). English job words that people say anyway (జాబ్, ఎక్స్‌పీరియన్స్) are written in Telugu / Hindi letters so the voice
// says them right. The rules above still hold: AI first, never selected / hired / offered, no promise.
const PH = {
  English: {
    ai: "Hi, this is TeamLink Consultants' AI recruitment assistant.",
    noticeRec: 'This call may be recorded and written down for our records.',
    identity: 'Am I speaking with {name}?',
    identityAgain: "Sorry, I didn't catch that. Am I speaking with {name}?",
    identityNeeded: "I just need to check I'm talking to {name} first, then I can share the details.",
    wrong: 'Oh, sorry to bother you. Thanks, bye.',
    convenient: 'Do you have two minutes to talk now?',
    laterAsk: 'No problem. When should we call you back?',
    laterClose: "Okay, we'll call you later. Bye.",
    laterNoted: "Okay, {when}, got it. We'll call you then. Bye.",
    screenIntro: 'We have a {job} job open. Can I tell you a bit about it?',
    matchIntro: "You had applied with TeamLink earlier. Your profile matches another opening, a {job} job. Can I tell you a bit about it?", // Job Match (Job Portal calling, 2026-10-30)
    briefLoc: 'The job is in {location}.',
    briefNeeds: "They need: {needs}.", // what the requirement asks for, from the ATS description (2026-10-30)
    briefMode: 'Work mode is {workMode}.',
    briefType: "It's a {employmentType} job.",
    briefExp: 'They want about {experience} of experience.',
    briefSkills: 'Main skills: {skills}.',
    briefResp: 'The work includes: {responsibilities}.',
    briefSalary: 'Salary range is {salary}.',
    briefNone: "I don't have more details right now. The recruiter can tell you.",
    interestQ: 'Are you interested in this job?',
    interestMore: 'Want a recruiter to call you with more details?',
    qExp: 'How many years of experience do you have in this?',
    qLoc: 'Which city are you in right now?',
    qNotice: "What's your notice period, in days?",
    qProceed: 'Are you okay to go ahead with the next steps?',
    closeInterested: 'Thanks. A recruiter from TeamLink will call you with the next steps. Nothing is final from this call. Bye.',
    closeNotInterested: 'Okay, thanks for your time. Bye.',
    closeStop: "Okay, we won't call you again. Bye.",
    closeUnclear: 'Thanks for your time. A recruiter may call you. Bye.',
    humanNoted: "Okay, I've noted you want to talk to a recruiter. Someone from the team will call you.",
    amAi: "I'm an AI assistant of TeamLink Consultants, not a person.",
    noSalary: "I don't have that detail. The recruiter can tell you.",
    noInfo: "I don't have that detail. The recruiter will tell you.",
    onlyYou: 'I can only talk about your own application.',
    repeat: "Sorry, I didn't catch that. Let me ask again.",
    resumeLine: "We spoke earlier about the {job} job.", // a call-back call (memory, 2026-10-30)
    // hearing problems / unclear answers (2026-10-29 fixes): never guess, ask again; never an endless loop
    notClear: "Sorry, I couldn't hear you clearly.",
    breaking: "Sorry, your voice is breaking up.",
    audioClose: "Sorry, the line isn't clear, so I'll stop here. A recruiter may call you later. Bye.",
    stillThere: "Hello, are you still there?",
    stillThere2: "Hello, can you hear me?",
    noAnswerClose: "I can't hear a reply, so I'll end the call now. A recruiter may call you later. Bye.",
    yesOrNo: "Sorry, was that a yes or a no?",
    sureRepeat: "Sure, let me say that again.",
    canHear: "Sorry about that. Can you hear me now?",
    whyNot: "Understood. If you don't mind me asking, is it this job, or are you not looking for a change right now?",
    checkFollowUp: "Of course, please check. When should we call you back?",
    laterWhenAgain: "Sorry, which day or time suits you?",
    thatsFine: "That's fine.",
    langSwitched: "Sure, let's continue in English.",
    calmSorry: "Sorry if this is a bad time. I'll keep it really short.",
    calmOffer: 'Shall I go on, or should a recruiter call you at a better time?',
    calmClose: "Got it, sorry for the trouble. I won't take more of your time now. Thanks.",
    noMoney: 'TeamLink never asks for money or any fee, and never asks for an OTP or bank details. This is only about your job application.',
    shortNews: "I'm calling to let you know you've been shortlisted for the {job} position.",
    shortIv: 'Your interview is on {date} at {time}.',
    shortNoIv: "The interview isn't fixed yet. The team will share the details later.",
    shortProceed: 'Are you okay to go to the next step?',
    shortYes: 'Thanks. The recruiter will call you with the next steps. Being shortlisted is just one step, not a final decision. Bye.',
    // AI interview pending (Job Portal calling, 2026-10-30)
    aiNews: "You applied for the {job} job on the TeamLink jobs website. Your AI interview for it is still pending.",
    aiDue: "Please finish it by {date}.",
    aiHow: "Log in on the TeamLink jobs website with your registered mobile number or email, open My Applications, and start the AI interview there.",
    aiProceed: "Will you be able to complete it?",
    aiYes: "Thanks. Please finish it before the deadline, so the recruiter can look at your application. Bye.",
    ivIntro: 'Your interview for the {job} position is fixed for {date} at {time}.',
    ivRemind: 'Just a reminder, your interview for the {job} position is on {date} at {time}.',
    ivOnline: "It's an online interview. The meeting link is in the message we send you.",
    ivOnlineNoLink: "It's an online interview. The recruiter will send you the link.",
    ivInPerson: "It's an in-person interview at {location}.",
    ivInPersonNoLoc: "It's an in-person interview. The recruiter will share the address.",
    ivPhone: "It's a phone interview.",
    ivInstr: 'One thing to note: {instructions}',
    ivAvail: 'Can you make it?',
    ivConfirmed: 'Great, thanks. Please be ready on time. Bye.',
    ivReschedAsk: 'What time works better for you?',
    ivReschedNoted: "Okay, I'll pass that to the recruiter. The interview stays at the same time until they confirm a change. Bye.",
    ivNotAvail: 'Thanks for letting us know. The recruiter will call you. Bye.',
    ivNoReply: 'Okay, the recruiter will call you to confirm. Bye.',
    tz: 'IST',
  },
  Hindi: {
    ai: 'हाय, मैं टीमलिंक कंसल्टेंट्स से AI रिक्रूटमेंट असिस्टेंट बोल रहा हूँ।',
    noticeRec: 'ये कॉल रिकॉर्ड हो सकती है और लिखकर भी रखी जा सकती है।',
    identity: 'क्या {name} जी बात कर रहे हैं?',
    identityAgain: 'सॉरी, ठीक से सुनाई नहीं दिया। क्या {name} जी बात कर रहे हैं?',
    identityNeeded: 'पहले मुझे पक्का करना है कि {name} जी से ही बात हो रही है, उसके बाद डिटेल्स बता पाऊँगा।',
    wrong: 'ओह, सॉरी, डिस्टर्ब किया। थैंक्यू, बाय।',
    convenient: 'अभी दो मिनट बात हो सकती है?',
    laterAsk: 'कोई बात नहीं। फिर कब कॉल करें?',
    laterClose: 'ठीक है, बाद में फिर कॉल करेंगे। बाय।',
    laterNoted: 'ठीक है, {when}, नोट कर लिया। तब कॉल करेंगे। बाय।',
    screenIntro: 'हमारे पास {job} की एक जॉब है। उसके बारे में थोड़ा बताऊँ?',
    matchIntro: "आपने पहले टीमलिंक में अप्लाई किया था। आपकी प्रोफ़ाइल से मिलती एक और जॉब है, {job}। उसके बारे में थोड़ा बताऊँ?", // Job Match (Job Portal calling, 2026-10-30)
    briefLoc: 'जॉब {location} में है।',
    briefNeeds: "इन्हें चाहिए: {needs}।", // what the requirement asks for, from the ATS description (2026-10-30)
    briefMode: 'वर्क मोड {workMode} है।',
    briefType: 'ये {employmentType} जॉब है।',
    briefExp: 'करीब {experience} का एक्सपीरियंस चाहिए।',
    briefSkills: 'मेन स्किल्स: {skills}।',
    briefResp: 'काम में ये सब है: {responsibilities}।',
    briefSalary: 'सैलरी रेंज {salary} है।',
    briefNone: 'अभी इससे ज़्यादा डिटेल्स मेरे पास नहीं हैं। रिक्रूटर बता देंगे।',
    interestQ: 'इस जॉब में इंटरेस्ट है?',
    interestMore: 'ज़्यादा डिटेल्स के लिए रिक्रूटर आपको कॉल करें?',
    qExp: 'आपका एक्सपीरियंस कितने साल का है?',
    qLoc: 'अभी कौन से शहर में रहते हैं?',
    qNotice: 'नोटिस पीरियड कितने दिन का है?',
    qProceed: 'आगे के स्टेप्स के लिए तैयार हैं?',
    closeInterested: 'थैंक्यू। टीमलिंक के रिक्रूटर आपको कॉल करके आगे के स्टेप्स बताएँगे। इस कॉल से अभी कुछ फ़ाइनल नहीं होता। बाय।',
    closeNotInterested: 'ठीक है, टाइम देने के लिए थैंक्यू। बाय।',
    closeStop: 'ठीक है, अब कॉल नहीं करेंगे। बाय।',
    closeUnclear: 'टाइम देने के लिए थैंक्यू। रिक्रूटर आपको कॉल कर सकते हैं। बाय।',
    humanNoted: 'ठीक है, नोट कर लिया कि आप रिक्रूटर से बात करना चाहते हैं। टीम से कोई कॉल करेगा।',
    amAi: 'मैं टीमलिंक कंसल्टेंट्स का AI असिस्टेंट हूँ, कोई इंसान नहीं।',
    noSalary: 'ये मेरे पास नहीं है। रिक्रूटर बता देंगे।',
    noInfo: 'ये डिटेल मेरे पास नहीं है। रिक्रूटर बता देंगे।',
    onlyYou: 'मैं सिर्फ़ आपकी एप्लिकेशन के बारे में बात कर सकता हूँ।',
    repeat: 'सॉरी, ठीक से सुनाई नहीं दिया। फिर से पूछता हूँ।',
    resumeLine: "हमने पहले {job} जॉब के बारे में बात की थी।", // a call-back call (memory, 2026-10-30)
    // hearing problems / unclear answers (2026-10-29 fixes): never guess, ask again; never an endless loop
    notClear: "सॉरी, आपकी आवाज़ ठीक से सुनाई नहीं दी।",
    breaking: "सॉरी, आपकी आवाज़ कट रही है।",
    audioClose: "सॉरी, लाइन साफ़ नहीं है, इसलिए यहीं रोकता हूँ। रिक्रूटर बाद में आपको कॉल कर सकते हैं। बाय।",
    stillThere: "हैलो, आप लाइन पर हैं?",
    stillThere2: "हैलो, मेरी आवाज़ आ रही है?",
    noAnswerClose: "आपका जवाब सुनाई नहीं दे रहा, इसलिए कॉल यहीं खत्म करता हूँ। रिक्रूटर बाद में कॉल कर सकते हैं। बाय।",
    yesOrNo: "सॉरी, आपने हाँ कहा या ना?",
    sureRepeat: "ज़रूर, फिर से बताता हूँ।",
    canHear: "सॉरी। अब मेरी आवाज़ आ रही है?",
    whyNot: "ठीक है। एक बात पूछूँ, ये जॉब पसंद नहीं आई, या अभी जॉब बदलने का सोच नहीं रहे?",
    checkFollowUp: "ज़रूर, चेक कर लीजिए। फिर कब कॉल करें?",
    laterWhenAgain: "सॉरी, कौन सा दिन या टाइम ठीक रहेगा?",
    thatsFine: "कोई बात नहीं।",
    langSwitched: 'ठीक है, हिंदी में बात करते हैं।',
    calmSorry: 'सॉरी, शायद गलत टाइम पर कॉल किया। जल्दी खत्म करता हूँ।',
    calmOffer: 'आगे बात करूँ, या रिक्रूटर आपको किसी और टाइम पर कॉल करें?',
    calmClose: 'समझ गया, परेशानी के लिए सॉरी। अभी और टाइम नहीं लूँगा। थैंक्यू।',
    noMoney: 'टीमलिंक कभी कोई पैसा या फीस नहीं माँगता, OTP या बैंक डिटेल्स भी नहीं। ये सिर्फ़ आपकी जॉब एप्लिकेशन के बारे में है।',
    shortNews: 'आपको {job} पोस्ट के लिए शॉर्टलिस्ट किया गया है, यही बताने के लिए कॉल किया।',
    shortIv: 'आपका इंटरव्यू {date} को {time} पर है।',
    shortNoIv: 'इंटरव्यू अभी फ़िक्स नहीं हुआ। टीम बाद में बताएगी।',
    shortProceed: 'आगे के स्टेप के लिए चलें?',
    shortYes: 'थैंक्यू। रिक्रूटर कॉल करके आगे के स्टेप्स बताएँगे। शॉर्टलिस्ट होना बस एक स्टेप है, फ़ाइनल फ़ैसला नहीं। बाय।',
    // AI interview pending (Job Portal calling, 2026-10-30)
    aiNews: "आपने टीमलिंक जॉब्स वेबसाइट पर {job} जॉब के लिए अप्लाई किया था। उसका आपका AI इंटरव्यू अभी पेंडिंग है।",
    aiDue: "{date} तक पूरा कर दीजिए।",
    aiHow: "अपने रजिस्टर्ड मोबाइल नंबर या ईमेल से टीमलिंक जॉब्स वेबसाइट पर लॉगिन कीजिए, माय एप्लिकेशन्स खोलिए, और वहाँ AI इंटरव्यू शुरू कीजिए।",
    aiProceed: "क्या आप इसे पूरा कर पाएँगे?",
    aiYes: "थैंक्यू। डेडलाइन से पहले पूरा कर दीजिए, ताकि रिक्रूटर आपकी एप्लिकेशन देख सकें। बाय।",
    ivIntro: '{job} पोस्ट के लिए आपका इंटरव्यू {date} को {time} पर फ़िक्स है।',
    ivRemind: 'बस याद दिलाने के लिए कॉल किया: {job} पोस्ट का आपका इंटरव्यू {date} को {time} पर है।',
    ivOnline: 'इंटरव्यू ऑनलाइन है। मीटिंग लिंक मैसेज में भेज देंगे।',
    ivOnlineNoLink: 'इंटरव्यू ऑनलाइन है। रिक्रूटर लिंक भेज देंगे।',
    ivInPerson: 'इंटरव्यू {location} में आमने-सामने है।',
    ivInPersonNoLoc: 'इंटरव्यू आमने-सामने है। पता रिक्रूटर बता देंगे।',
    ivPhone: 'इंटरव्यू फ़ोन पर ही है।',
    ivInstr: 'एक बात ध्यान रखें: {instructions}',
    ivAvail: 'आप आ पाएँगे?',
    ivConfirmed: 'बढ़िया, थैंक्यू। टाइम पर तैयार रहिए। बाय।',
    ivReschedAsk: 'आपके लिए कौन सा टाइम ठीक रहेगा?',
    ivReschedNoted: 'ठीक है, रिक्रूटर को बता दूँगा। जब तक वो कन्फ़र्म न करें, इंटरव्यू पुराने टाइम पर ही रहेगा। बाय।',
    ivNotAvail: 'बताने के लिए थैंक्यू। रिक्रूटर आपको कॉल करेंगे। बाय।',
    ivNoReply: 'ठीक है, कन्फ़र्म करने के लिए रिक्रूटर कॉल करेंगे। बाय।',
    tz: 'भारतीय समय',
  },
  Telugu: {
    ai: 'హాయ్, నేను టీమ్‌లింక్ కన్సల్టెంట్స్ నుంచి AI రిక్రూట్‌మెంట్ అసిస్టెంట్‌ని.',
    noticeRec: 'ఈ కాల్ రికార్డ్ అవ్వొచ్చు, రాసి కూడా పెట్టుకుంటాం.',
    identity: 'నేను {name} గారితోనే మాట్లాడుతున్నానా?',
    identityAgain: 'సారీ, సరిగ్గా వినపడలేదు. నేను {name} గారితోనే మాట్లాడుతున్నానా?',
    identityNeeded: 'ముందు {name} గారితోనే మాట్లాడుతున్నానని కన్ఫర్మ్ చేసుకోవాలి, తర్వాతే డీటెయిల్స్ చెప్పగలను.',
    wrong: 'ఓహ్, సారీ, డిస్టర్బ్ చేశాను. థాంక్స్, బై.',
    convenient: 'ఇప్పుడు ఒక రెండు నిమిషాలు మాట్లాడొచ్చా?',
    laterAsk: 'పర్లేదు. మళ్ళీ ఎప్పుడు కాల్ చేయమంటారు?',
    laterClose: 'సరే, తర్వాత మళ్ళీ కాల్ చేస్తాం. బై.',
    laterNoted: 'సరే, {when}, నోట్ చేసుకున్నా. అప్పుడు కాల్ చేస్తాం. బై.',
    screenIntro: 'మా దగ్గర {job} జాబ్ ఒకటి ఉంది. దాని గురించి కొంచెం చెప్పనా?',
    matchIntro: "మీరు ఇంతకుముందు టీమ్‌లింక్‌లో అప్లై చేశారు. మీ ప్రొఫైల్‌కి సరిపోయే ఇంకో జాబ్ ఉంది, {job}. దాని గురించి కొంచెం చెప్పనా?", // Job Match (Job Portal calling, 2026-10-30)
    briefLoc: 'జాబ్ {location} లో.',
    briefNeeds: "వాళ్ళకి కావాల్సింది: {needs}.", // what the requirement asks for, from the ATS description (2026-10-30)
    briefMode: 'వర్క్ మోడ్ {workMode}.',
    briefType: 'ఇది {employmentType} జాబ్.',
    briefExp: 'దాదాపు {experience} ఎక్స్‌పీరియన్స్ కావాలి.',
    briefSkills: 'ముఖ్యంగా కావాల్సిన స్కిల్స్: {skills}.',
    briefResp: 'పనిలో ఉండేవి: {responsibilities}.',
    briefSalary: 'జీతం రేంజ్ {salary}.',
    briefNone: 'ఇంకా డీటెయిల్స్ ఇప్పుడు నా దగ్గర లేవు. రిక్రూటర్ చెప్తారు.',
    interestQ: 'ఈ జాబ్ మీకు ఇంట్రెస్ట్ ఉందా?',
    interestMore: 'ఇంకా డీటెయిల్స్ కోసం రిక్రూటర్ మీకు కాల్ చేయాలా?',
    qExp: 'ఈ ఫీల్డ్‌లో మీకు ఎన్నేళ్ళ ఎక్స్‌పీరియన్స్ ఉంది?',
    qLoc: 'ఇప్పుడు ఏ ఊర్లో ఉంటున్నారు?',
    qNotice: 'మీ నోటీస్ పీరియడ్ ఎన్ని రోజులు?',
    qProceed: 'నెక్స్ట్ స్టెప్స్‌కి వెళ్దామా?',
    closeInterested: 'థాంక్స్. టీమ్‌లింక్ రిక్రూటర్ మీకు కాల్ చేసి నెక్స్ట్ స్టెప్స్ చెప్తారు. ఈ కాల్‌తోనే ఏదీ ఫైనల్ కాదు. బై.',
    closeNotInterested: 'సరే, టైమ్ ఇచ్చినందుకు థాంక్స్. బై.',
    closeStop: 'సరే, ఇంకెప్పుడూ కాల్ చేయం. బై.',
    closeUnclear: 'టైమ్ ఇచ్చినందుకు థాంక్స్. రిక్రూటర్ మీకు కాల్ చేయొచ్చు. బై.',
    humanNoted: 'సరే, మీరు రిక్రూటర్‌తో మాట్లాడాలని నోట్ చేసుకున్నా. టీమ్ నుంచి ఎవరైనా కాల్ చేస్తారు.',
    amAi: 'నేను టీమ్‌లింక్ కన్సల్టెంట్స్ AI అసిస్టెంట్‌ని, మనిషిని కాదు.',
    noSalary: 'అది నా దగ్గర లేదు. రిక్రూటర్ చెప్తారు.',
    noInfo: 'ఆ డీటెయిల్ నా దగ్గర లేదు. రిక్రూటర్ చెప్తారు.',
    onlyYou: 'నేను మీ అప్లికేషన్ గురించి మాత్రమే మాట్లాడగలను.',
    repeat: 'సారీ, సరిగ్గా వినపడలేదు. మళ్ళీ అడుగుతా.',
    resumeLine: "మనం ఇంతకుముందు {job} జాబ్ గురించి మాట్లాడుకున్నాం.", // a call-back call (memory, 2026-10-30)
    // hearing problems / unclear answers (2026-10-29 fixes): never guess, ask again; never an endless loop
    notClear: "సారీ, మీ మాట సరిగ్గా వినపడలేదు.",
    breaking: "సారీ, మీ వాయిస్ కట్ అవుతుంది.",
    audioClose: "సారీ, లైన్ క్లియర్‌గా లేదు, ఇక్కడితో ఆపేస్తున్నా. రిక్రూటర్ తర్వాత మీకు కాల్ చేయొచ్చు. బై.",
    stillThere: "హలో, లైన్‌లో ఉన్నారా?",
    stillThere2: "హలో, నా మాట వినపడుతుందా?",
    noAnswerClose: "మీ రిప్లై వినపడట్లేదు, కాల్ ఇక్కడితో ఆపేస్తున్నా. రిక్రూటర్ తర్వాత కాల్ చేయొచ్చు. బై.",
    yesOrNo: "సారీ, మీరు అవును అన్నారా, కాదు అన్నారా?",
    sureRepeat: "సరే, మళ్ళీ చెప్తా.",
    canHear: "సారీ. ఇప్పుడు నా మాట వినపడుతుందా?",
    whyNot: "సరే. ఒక్కటి అడగొచ్చా, ఈ జాబ్ నచ్చలేదా, లేక ఇప్పుడు జాబ్ మారే ఆలోచన లేదా?",
    checkFollowUp: "సరే, చెక్ చేసుకోండి. మళ్ళీ ఎప్పుడు కాల్ చేయమంటారు?",
    laterWhenAgain: "సారీ, ఏ రోజు, ఏ టైమ్ అయితే మీకు వీలు?",
    thatsFine: "పర్లేదు.",
    langSwitched: 'సరే, తెలుగులో మాట్లాడుకుందాం.',
    calmSorry: 'సారీ, టైమ్ కాని టైమ్‌లో కాల్ చేసినట్టున్నా. త్వరగా ముగిస్తా.',
    calmOffer: 'కంటిన్యూ చేయనా, లేక మీకు వీలున్నప్పుడు రిక్రూటర్ కాల్ చేయాలా?',
    calmClose: 'అర్థమైంది, ఇబ్బంది పెట్టినందుకు సారీ. ఇప్పుడు ఇంక టైమ్ తీసుకోను. థాంక్స్.',
    noMoney: 'టీమ్‌లింక్ ఎప్పుడూ డబ్బులు గానీ ఫీజు గానీ అడగదు. OTP, బ్యాంక్ డీటెయిల్స్ కూడా అడగదు. ఇది మీ జాబ్ అప్లికేషన్ గురించి మాత్రమే.',
    shortNews: '{job} పోస్ట్‌కి మిమ్మల్ని షార్ట్‌లిస్ట్ చేశారు, అది చెప్పడానికే కాల్ చేశా.',
    shortIv: 'మీ ఇంటర్వ్యూ {date} న {time} కి ఉంది.',
    shortNoIv: 'ఇంటర్వ్యూ ఇంకా ఫిక్స్ కాలేదు. టీమ్ తర్వాత చెప్తుంది.',
    shortProceed: 'నెక్స్ట్ స్టెప్‌కి వెళ్దామా?',
    shortYes: 'థాంక్స్. రిక్రూటర్ కాల్ చేసి నెక్స్ట్ స్టెప్స్ చెప్తారు. షార్ట్‌లిస్ట్ అనేది ఒక స్టెప్ మాత్రమే, ఫైనల్ డెసిషన్ కాదు. బై.',
    // AI interview pending (Job Portal calling, 2026-10-30)
    aiNews: "మీరు టీమ్‌లింక్ జాబ్స్ వెబ్‌సైట్‌లో {job} జాబ్‌కి అప్లై చేశారు. దానికి మీ AI ఇంటర్వ్యూ ఇంకా పెండింగ్‌లో ఉంది.",
    aiDue: "{date} లోపు పూర్తి చేయండి.",
    aiHow: "మీ రిజిస్టర్డ్ మొబైల్ నంబర్ లేదా ఈమెయిల్‌తో టీమ్‌లింక్ జాబ్స్ వెబ్‌సైట్‌లో లాగిన్ అయ్యి, మై అప్లికేషన్స్ ఓపెన్ చేసి, అక్కడ AI ఇంటర్వ్యూ స్టార్ట్ చేయండి.",
    aiProceed: "మీరు అది పూర్తి చేయగలరా?",
    aiYes: "థాంక్స్. డెడ్‌లైన్ లోపు పూర్తి చేయండి, అప్పుడు రిక్రూటర్ మీ అప్లికేషన్ చూస్తారు. బై.",
    ivIntro: '{job} పోస్ట్‌కి మీ ఇంటర్వ్యూ {date} న {time} కి ఫిక్స్ అయింది.',
    ivRemind: 'జస్ట్ గుర్తు చేయడానికి కాల్ చేశా: {job} పోస్ట్‌కి మీ ఇంటర్వ్యూ {date} న {time} కి ఉంది.',
    ivOnline: 'ఇంటర్వ్యూ ఆన్‌లైన్‌లో. మీటింగ్ లింక్ మెసేజ్‌లో పంపిస్తాం.',
    ivOnlineNoLink: 'ఇంటర్వ్యూ ఆన్‌లైన్‌లో. రిక్రూటర్ లింక్ పంపిస్తారు.',
    ivInPerson: 'ఇంటర్వ్యూ డైరెక్ట్‌గా {location} లో.',
    ivInPersonNoLoc: 'ఇంటర్వ్యూ డైరెక్ట్‌గా ఉంటుంది. అడ్రస్ రిక్రూటర్ చెప్తారు.',
    ivPhone: 'ఇంటర్వ్యూ ఫోన్‌లోనే.',
    ivInstr: 'ఒక్క విషయం: {instructions}',
    ivAvail: 'మీరు రాగలరా?',
    ivConfirmed: 'సూపర్, థాంక్స్. టైమ్‌కి రెడీగా ఉండండి. బై.',
    ivReschedAsk: 'మీకు ఏ టైమ్ అయితే బాగుంటుంది?',
    ivReschedNoted: 'సరే, రిక్రూటర్‌కి చెప్తా. వాళ్ళు కన్ఫర్మ్ చేసే వరకు ఇంటర్వ్యూ పాత టైమ్‌కే ఉంటుంది. బై.',
    ivNotAvail: 'చెప్పినందుకు థాంక్స్. రిక్రూటర్ మీకు కాల్ చేస్తారు. బై.',
    ivNoReply: 'సరే, కన్ఫర్మ్ చేయడానికి రిక్రూటర్ కాల్ చేస్తారు. బై.',
    tz: 'ఇండియా టైమ్',
  },
};

const phrases = (language) => PH[LANGS.includes(language) ? language : 'English'];

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
    if (/\b\d+\s*k\b|lpa|₹|salary|ctc|experience|fresher|eligible|who have|require/i.test(l)) return;
    l.replace(/^\d+[.)]\s*/, '').split(',').forEach((part) => {
      const v = part.replace(/\b\d+\s*(members?|persons?|people|posts?|nos?|vacanc(y|ies))\b/ig, '').replace(/^\d+\s+/, '').replace(/\s+/g, ' ').trim();
      if (v && v.length <= 40 && /[a-z]/i.test(v) && !items.some((x) => x.toLowerCase() === v.toLowerCase())) items.push(v);
    });
  });
  out.needs = clean(items.slice(0, 5).join(', '), 160);
  return out;
}
// "Faculty requirement" is said as "Faculty" ("We have a Faculty job open")
const spokenTitle = (t) => clean(String(t || '').replace(/\s*[-–(]?\s*\b(requirements?|vacanc(y|ies)|openings?|positions?)\b\)?\s*$/i, ''), 100) || clean(t, 100);

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
    salary: clean(r.salary, 60) || fromDesc.salary,
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
  const P = phrases(language);
  const f = cleanFields(fieldsIn);
  const name = data.name || data.firstName;
  const iv = data.interview;
  const B = {};
  B.ai = `${P.ai}${opts.recordingNotice ? ` ${P.noticeRec}` : ''}`;
  B.identity = fill(P.identity, { name });
  B.convenient = P.convenient;
  B.intro = fill(purpose === 'Job Match' ? P.matchIntro : P.screenIntro, { job: data.jobTitle });
  const brief = [
    fill(P.briefLoc, { location: data.location }),
    data.skills ? '' : fill(P.briefNeeds, { needs: data.needs }),
    fill(P.briefMode, { workMode: data.workMode }),
    fill(P.briefType, { employmentType: data.employmentType }),
    fill(P.briefExp, { experience: data.experience }),
    fill(P.briefSkills, { skills: data.skills }),
    f.includeResponsibilities ? fill(P.briefResp, { responsibilities: data.responsibilities }) : '',
    f.includeSalary ? fill(P.briefSalary, { salary: data.salary }) : '',
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
  }
  return bad;
}

module.exports = {
  LANGS, PURPOSES, PORTAL_PURPOSES, screenLike, TRANSACTIONAL, TZ, FORBIDDEN, hasForbidden, phrases, clean, fill, dateWords, timeWords, buildData, cleanFields, checkFields, blocks, preview, checkTemplates, MODE_KIND,
};
