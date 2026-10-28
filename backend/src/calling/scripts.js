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
const PURPOSES = ['Screening', 'Shortlist Notification', 'Interview Notification', 'Interview Reminder'];
const TRANSACTIONAL = new Set(['Shortlist Notification', 'Interview Notification', 'Interview Reminder']);
const TZ = 'Asia/Kolkata';

// Words the assistant must never say unless an authorised decision exists (it never exists inside this module).
const FORBIDDEN = [
  /\b(selected|hired|offered|appointed|recruited|congratulations|guarantee[ds]?\s+(a\s+)?(job|selection|placement)|you\s+(have|got)\s+the\s+job)\b/i,
  /(चयनित|नियुक्त|ऑफर|बधाई|पक्की\s*नौकरी)/,
  /(ఎంపికైన|ఎంపిక\s*చేయబడ|ఆఫర్|అభినందనలు|నియమించ)/,
];
const hasForbidden = (t) => FORBIDDEN.some((re) => re.test(String(t || '')));

const PH = {
  English: {
    ai: "I am TeamLink Consultants' AI recruitment assistant.",
    noticeRec: 'This call may be recorded and written down for our records.',
    identity: 'Hello, am I speaking with {name}?',
    identityAgain: 'Sorry, I did not catch that. Am I speaking with {name}?',
    identityNeeded: 'I can share details only after I confirm I am speaking with {name}.',
    wrong: 'Sorry for the disturbance. Thank you. Goodbye.',
    convenient: 'Is this a convenient time to speak for two minutes?',
    laterAsk: 'No problem. When would be a good time for us to call you back?',
    laterClose: 'Thank you. We will try again later. Goodbye.',
    laterNoted: 'Thank you. I have noted that: {when}. Goodbye.',
    screenIntro: 'We currently have a {job} opportunity. Would you be interested in learning more?',
    briefLoc: 'The role is in {location}.',
    briefMode: 'The work mode is {workMode}.',
    briefType: 'It is a {employmentType} role.',
    briefExp: 'It asks for about {experience} of experience.',
    briefSkills: 'The main skills asked for are {skills}.',
    briefResp: 'The work includes: {responsibilities}.',
    briefSalary: 'The salary range is {salary}.',
    briefNone: 'I do not have more details about the role right now. A recruiter can share them.',
    interestQ: 'Are you interested in this opportunity?',
    interestMore: 'Would you like a recruiter to call you with more details?',
    qExp: 'How many years of relevant experience do you have?',
    qLoc: 'Which city do you live in now?',
    qNotice: 'What is your notice period, in days?',
    qProceed: 'Are you willing to go ahead with the next steps?',
    closeInterested: 'Thank you. A recruiter from TeamLink will contact you with the next steps. This call does not guarantee any decision. Goodbye.',
    closeNotInterested: 'Thank you for your time. We will not take more of it. Goodbye.',
    closeStop: 'Understood. We will not call you again. Goodbye.',
    closeUnclear: 'Thank you for your time. A recruiter may contact you. Goodbye.',
    humanNoted: 'I have noted that you would like to speak to a recruiter. Someone from the team will contact you.',
    amAi: 'I am an AI assistant of TeamLink Consultants, not a person.',
    noSalary: 'I do not have that detail. A recruiter can tell you.',
    noInfo: 'I do not have that detail. A recruiter will share it with you.',
    onlyYou: 'I can talk only about your own application.',
    repeat: 'Sorry, I did not understand. Let me ask again.',
    langSwitched: 'Sure, let us continue in English.',
    calmSorry: 'I am sorry if this came at a bad time. I will keep it very short.',
    calmOffer: 'Shall I continue, or would you like a recruiter to call you at a better time?',
    calmClose: 'I understand, and I am sorry for the trouble. We will not take more of your time now. Goodbye.',
    noMoney: 'TeamLink never asks for any money or fee, and never asks for an OTP or bank details. This is only about your job application with TeamLink.',
    shortNews: 'We are pleased to inform you that you have been shortlisted for the {job} position.',
    shortIv: 'Your interview is scheduled for {date} at {time}.',
    shortNoIv: 'No interview has been scheduled yet. The team will share the details later.',
    shortProceed: 'Would you be interested in proceeding to the next stage?',
    shortYes: 'Thank you. The recruiter will contact you with the next steps. Being shortlisted is one step in the process and does not guarantee a final decision. Goodbye.',
    ivIntro: 'Your interview for the {job} position is scheduled for {date} at {time}.',
    ivRemind: 'This is a reminder that your interview for the {job} position is on {date} at {time}.',
    ivOnline: 'The interview will be online. The meeting link is in the message we send you.',
    ivOnlineNoLink: 'The interview will be online. The recruiter will send you the meeting link.',
    ivInPerson: 'The interview will be in person at {location}.',
    ivInPersonNoLoc: 'The interview will be in person. The recruiter will share the address.',
    ivPhone: 'The interview will be on the phone.',
    ivInstr: 'Please note: {instructions}',
    ivAvail: 'Are you available to attend?',
    ivConfirmed: 'Thank you for confirming. Please be ready on time. Goodbye.',
    ivReschedAsk: 'Would you like to tell me a time that suits you better?',
    ivReschedNoted: 'Thank you. I have passed your request to the recruiter. The interview stays as scheduled until the recruiter confirms a change. Goodbye.',
    ivNotAvail: 'Thank you for letting us know. The recruiter will contact you. Goodbye.',
    ivNoReply: 'Thank you. The recruiter will contact you to confirm. Goodbye.',
    tz: 'IST',
  },
  Hindi: {
    ai: 'मैं टीमलिंक कंसल्टेंट्स का AI रिक्रूटमेंट असिस्टेंट हूँ।',
    noticeRec: 'यह कॉल रिकॉर्ड और लिखित रूप में सुरक्षित की जा सकती है।',
    identity: 'नमस्ते, क्या मेरी बात {name} जी से हो रही है?',
    identityAgain: 'माफ़ कीजिए, मैं समझ नहीं पाया। क्या मेरी बात {name} जी से हो रही है?',
    identityNeeded: 'जब तक मैं पक्का नहीं कर लेता कि बात {name} जी से हो रही है, मैं जानकारी नहीं दे सकता।',
    wrong: 'परेशानी के लिए माफ़ कीजिए। धन्यवाद। नमस्कार।',
    convenient: 'क्या अभी दो मिनट बात करने का सही समय है?',
    laterAsk: 'कोई बात नहीं। हम आपको कब दोबारा कॉल करें?',
    laterClose: 'धन्यवाद। हम बाद में दोबारा कोशिश करेंगे। नमस्कार।',
    laterNoted: 'धन्यवाद। मैंने नोट कर लिया: {when}। नमस्कार।',
    screenIntro: 'हमारे पास अभी {job} का एक अवसर है। क्या आप इसके बारे में जानना चाहेंगे?',
    briefLoc: 'यह पद {location} में है।',
    briefMode: 'काम का तरीका {workMode} है।',
    briefType: 'यह {employmentType} पद है।',
    briefExp: 'इसके लिए लगभग {experience} का अनुभव चाहिए।',
    briefSkills: 'मुख्य कौशल हैं: {skills}।',
    briefResp: 'काम में शामिल है: {responsibilities}।',
    briefSalary: 'वेतन की सीमा {salary} है।',
    briefNone: 'अभी मेरे पास इस पद की और जानकारी नहीं है। रिक्रूटर आपको बता सकते हैं।',
    interestQ: 'क्या आप इस अवसर में रुचि रखते हैं?',
    interestMore: 'क्या आप चाहेंगे कि रिक्रूटर आपको और जानकारी के लिए कॉल करें?',
    qExp: 'इस काम का आपके पास कितने साल का अनुभव है?',
    qLoc: 'आप अभी किस शहर में रहते हैं?',
    qNotice: 'आपका नोटिस पीरियड कितने दिनों का है?',
    qProceed: 'क्या आप आगे की प्रक्रिया के लिए तैयार हैं?',
    closeInterested: 'धन्यवाद। टीमलिंक के रिक्रूटर आगे की जानकारी के लिए आपसे संपर्क करेंगे। यह कॉल किसी निर्णय की गारंटी नहीं है। नमस्कार।',
    closeNotInterested: 'आपके समय के लिए धन्यवाद। हम और समय नहीं लेंगे। नमस्कार।',
    closeStop: 'ठीक है। हम आपको दोबारा कॉल नहीं करेंगे। नमस्कार।',
    closeUnclear: 'आपके समय के लिए धन्यवाद। रिक्रूटर आपसे संपर्क कर सकते हैं। नमस्कार।',
    humanNoted: 'मैंने नोट कर लिया कि आप रिक्रूटर से बात करना चाहते हैं। टीम से कोई आपसे संपर्क करेगा।',
    amAi: 'मैं टीमलिंक कंसल्टेंट्स का AI असिस्टेंट हूँ, कोई इंसान नहीं।',
    noSalary: 'यह जानकारी मेरे पास नहीं है। रिक्रूटर आपको बता सकते हैं।',
    noInfo: 'यह जानकारी मेरे पास नहीं है। रिक्रूटर आपको बताएँगे।',
    onlyYou: 'मैं सिर्फ़ आपके अपने आवेदन के बारे में बात कर सकता हूँ।',
    repeat: 'माफ़ कीजिए, मैं समझ नहीं पाया। मैं दोबारा पूछता हूँ।',
    langSwitched: 'ज़रूर, हम हिंदी में बात करते हैं।',
    calmSorry: 'अगर यह गलत समय पर आया हो तो माफ़ कीजिए। मैं बात बहुत छोटी रखूँगा।',
    calmOffer: 'क्या मैं आगे बात करूँ, या आप चाहेंगे कि रिक्रूटर आपको किसी बेहतर समय पर कॉल करें?',
    calmClose: 'मैं समझता हूँ, और परेशानी के लिए माफ़ी चाहता हूँ। अभी हम आपका और समय नहीं लेंगे। धन्यवाद।',
    noMoney: 'टीमलिंक कभी कोई पैसा या फीस नहीं माँगता, और कभी OTP या बैंक की जानकारी नहीं माँगता। यह सिर्फ़ टीमलिंक में आपके नौकरी के आवेदन के बारे में है।',
    shortNews: 'हमें आपको यह बताते हुए खुशी है कि आपको {job} पद के लिए शॉर्टलिस्ट किया गया है।',
    shortIv: 'आपका इंटरव्यू {date} को {time} पर तय है।',
    shortNoIv: 'अभी कोई इंटरव्यू तय नहीं हुआ है। टीम बाद में जानकारी देगी।',
    shortProceed: 'क्या आप अगले चरण में आगे बढ़ना चाहेंगे?',
    shortYes: 'धन्यवाद। रिक्रूटर अगले चरणों के लिए आपसे संपर्क करेंगे। शॉर्टलिस्ट होना प्रक्रिया का एक चरण है, अंतिम निर्णय की गारंटी नहीं। नमस्कार।',
    ivIntro: '{job} पद के लिए आपका इंटरव्यू {date} को {time} पर तय है।',
    ivRemind: 'यह याद दिलाने के लिए कॉल है कि {job} पद के लिए आपका इंटरव्यू {date} को {time} पर है।',
    ivOnline: 'इंटरव्यू ऑनलाइन होगा। मीटिंग लिंक उस संदेश में है जो हम आपको भेजेंगे।',
    ivOnlineNoLink: 'इंटरव्यू ऑनलाइन होगा। रिक्रूटर आपको मीटिंग लिंक भेजेंगे।',
    ivInPerson: 'इंटरव्यू आमने-सामने {location} में होगा।',
    ivInPersonNoLoc: 'इंटरव्यू आमने-सामने होगा। रिक्रूटर पता बताएँगे।',
    ivPhone: 'इंटरव्यू फ़ोन पर होगा।',
    ivInstr: 'कृपया ध्यान दें: {instructions}',
    ivAvail: 'क्या आप आ सकेंगे?',
    ivConfirmed: 'पुष्टि के लिए धन्यवाद। कृपया समय पर तैयार रहें। नमस्कार।',
    ivReschedAsk: 'क्या आप कोई ऐसा समय बताना चाहेंगे जो आपके लिए ठीक हो?',
    ivReschedNoted: 'धन्यवाद। मैंने आपका अनुरोध रिक्रूटर तक पहुँचा दिया है। रिक्रूटर के बदलाव की पुष्टि करने तक इंटरव्यू तय समय पर ही रहेगा। नमस्कार।',
    ivNotAvail: 'बताने के लिए धन्यवाद। रिक्रूटर आपसे संपर्क करेंगे। नमस्कार।',
    ivNoReply: 'धन्यवाद। रिक्रूटर पुष्टि के लिए आपसे संपर्क करेंगे। नमस्कार।',
    tz: 'भारतीय समय',
  },
  Telugu: {
    ai: 'నేను టీమ్‌లింక్ కన్సల్టెంట్స్ యొక్క AI రిక్రూట్‌మెంట్ అసిస్టెంట్‌ని.',
    noticeRec: 'ఈ కాల్ రికార్డ్ చేసి, రాతపూర్వకంగా భద్రపరచవచ్చు.',
    identity: 'నమస్తే, నేను {name} గారితో మాట్లాడుతున్నానా?',
    identityAgain: 'క్షమించండి, నాకు అర్థం కాలేదు. నేను {name} గారితో మాట్లాడుతున్నానా?',
    identityNeeded: '{name} గారితోనే మాట్లాడుతున్నానని నిర్ధారించుకున్న తర్వాతే వివరాలు చెప్పగలను.',
    wrong: 'ఇబ్బందికి క్షమించండి. ధన్యవాదాలు. నమస్కారం.',
    convenient: 'రెండు నిమిషాలు మాట్లాడటానికి ఇది అనుకూలమైన సమయమేనా?',
    laterAsk: 'సరే. మేము మీకు తిరిగి ఎప్పుడు కాల్ చేయాలి?',
    laterClose: 'ధన్యవాదాలు. మేము తర్వాత మళ్ళీ ప్రయత్నిస్తాము. నమస్కారం.',
    laterNoted: 'ధన్యవాదాలు. నేను నోట్ చేసుకున్నాను: {when}. నమస్కారం.',
    screenIntro: 'మా దగ్గర ప్రస్తుతం {job} అవకాశం ఉంది. దాని గురించి తెలుసుకోవాలనుకుంటున్నారా?',
    briefLoc: 'ఈ పోస్టు {location} లో ఉంది.',
    briefMode: 'పని విధానం {workMode}.',
    briefType: 'ఇది {employmentType} పోస్టు.',
    briefExp: 'దీనికి సుమారు {experience} అనుభవం కావాలి.',
    briefSkills: 'ముఖ్యమైన నైపుణ్యాలు: {skills}.',
    briefResp: 'పనిలో ఉండేవి: {responsibilities}.',
    briefSalary: 'జీతం పరిధి {salary}.',
    briefNone: 'ఈ పోస్టు గురించి ఇంకా వివరాలు ప్రస్తుతం నా దగ్గర లేవు. రిక్రూటర్ చెప్పగలరు.',
    interestQ: 'ఈ అవకాశంపై మీకు ఆసక్తి ఉందా?',
    interestMore: 'మరిన్ని వివరాల కోసం రిక్రూటర్ మీకు కాల్ చేయాలా?',
    qExp: 'ఈ పనిలో మీకు ఎన్ని సంవత్సరాల అనుభవం ఉంది?',
    qLoc: 'మీరు ప్రస్తుతం ఏ నగరంలో ఉంటున్నారు?',
    qNotice: 'మీ నోటీస్ పీరియడ్ ఎన్ని రోజులు?',
    qProceed: 'తదుపరి దశలకు వెళ్ళడానికి మీరు సిద్ధంగా ఉన్నారా?',
    closeInterested: 'ధన్యవాదాలు. తదుపరి వివరాల కోసం టీమ్‌లింక్ రిక్రూటర్ మిమ్మల్ని సంప్రదిస్తారు. ఈ కాల్ ఏ నిర్ణయానికీ హామీ కాదు. నమస్కారం.',
    closeNotInterested: 'మీ సమయానికి ధన్యవాదాలు. ఇంకా సమయం తీసుకోము. నమస్కారం.',
    closeStop: 'సరే. మేము మీకు మళ్ళీ కాల్ చేయము. నమస్కారం.',
    closeUnclear: 'మీ సమయానికి ధన్యవాదాలు. రిక్రూటర్ మిమ్మల్ని సంప్రదించవచ్చు. నమస్కారం.',
    humanNoted: 'మీరు రిక్రూటర్‌తో మాట్లాడాలనుకుంటున్నారని నోట్ చేసుకున్నాను. టీమ్ నుంచి ఎవరైనా మిమ్మల్ని సంప్రదిస్తారు.',
    amAi: 'నేను టీమ్‌లింక్ కన్సల్టెంట్స్ AI అసిస్టెంట్‌ని, మనిషిని కాదు.',
    noSalary: 'ఆ వివరం నా దగ్గర లేదు. రిక్రూటర్ చెప్పగలరు.',
    noInfo: 'ఆ వివరం నా దగ్గర లేదు. రిక్రూటర్ మీకు చెబుతారు.',
    onlyYou: 'నేను మీ స్వంత దరఖాస్తు గురించి మాత్రమే మాట్లాడగలను.',
    repeat: 'క్షమించండి, నాకు అర్థం కాలేదు. మళ్ళీ అడుగుతాను.',
    langSwitched: 'సరే, తెలుగులో మాట్లాడుకుందాం.',
    calmSorry: 'ఇబ్బంది కలిగించి ఉంటే క్షమించండి. చాలా తక్కువ సమయంలో ముగిస్తాను.',
    calmOffer: 'కొనసాగించమంటారా, లేదా రిక్రూటర్ మీకు వీలైన సమయంలో కాల్ చేయాలా?',
    calmClose: 'అర్థమైంది, ఇబ్బందికి క్షమించండి. ఇప్పుడు మీ సమయం ఇంకా తీసుకోము. ధన్యవాదాలు.',
    noMoney: 'టీమ్‌లింక్ ఎప్పుడూ డబ్బు లేదా ఫీజు అడగదు, OTP లేదా బ్యాంక్ వివరాలు కూడా అడగదు. ఇది టీమ్‌లింక్‌లో మీ ఉద్యోగ దరఖాస్తు గురించి మాత్రమే.',
    shortNews: '{job} పోస్టుకు మిమ్మల్ని షార్ట్‌లిస్ట్ చేసినట్లు తెలియజేయడం సంతోషంగా ఉంది.',
    shortIv: 'మీ ఇంటర్వ్యూ {date} న {time} కు నిర్ణయించబడింది.',
    shortNoIv: 'ఇంకా ఇంటర్వ్యూ నిర్ణయించలేదు. టీమ్ వివరాలను తర్వాత తెలియజేస్తుంది.',
    shortProceed: 'తదుపరి దశకు వెళ్ళడానికి మీకు ఆసక్తి ఉందా?',
    shortYes: 'ధన్యవాదాలు. తదుపరి దశల కోసం రిక్రూటర్ మిమ్మల్ని సంప్రదిస్తారు. షార్ట్‌లిస్ట్ కావడం ప్రక్రియలో ఒక దశ మాత్రమే, తుది నిర్ణయానికి హామీ కాదు. నమస్కారం.',
    ivIntro: '{job} పోస్టుకు మీ ఇంటర్వ్యూ {date} న {time} కు నిర్ణయించబడింది.',
    ivRemind: '{job} పోస్టుకు మీ ఇంటర్వ్యూ {date} న {time} కు ఉందని గుర్తు చేయడానికి ఈ కాల్.',
    ivOnline: 'ఇంటర్వ్యూ ఆన్‌లైన్‌లో ఉంటుంది. మీటింగ్ లింక్ మేము పంపే సందేశంలో ఉంటుంది.',
    ivOnlineNoLink: 'ఇంటర్వ్యూ ఆన్‌లైన్‌లో ఉంటుంది. రిక్రూటర్ మీటింగ్ లింక్ పంపుతారు.',
    ivInPerson: 'ఇంటర్వ్యూ నేరుగా {location} లో ఉంటుంది.',
    ivInPersonNoLoc: 'ఇంటర్వ్యూ నేరుగా ఉంటుంది. రిక్రూటర్ చిరునామా చెబుతారు.',
    ivPhone: 'ఇంటర్వ్యూ ఫోన్‌లో ఉంటుంది.',
    ivInstr: 'దయచేసి గమనించండి: {instructions}',
    ivAvail: 'మీరు హాజరు కాగలరా?',
    ivConfirmed: 'నిర్ధారించినందుకు ధన్యవాదాలు. దయచేసి సమయానికి సిద్ధంగా ఉండండి. నమస్కారం.',
    ivReschedAsk: 'మీకు సరిపోయే సమయం చెప్పగలరా?',
    ivReschedNoted: 'ధన్యవాదాలు. మీ అభ్యర్థనను రిక్రూటర్‌కి తెలియజేశాను. రిక్రూటర్ మార్పును నిర్ధారించే వరకు ఇంటర్వ్యూ నిర్ణయించిన సమయంలోనే ఉంటుంది. నమస్కారం.',
    ivNotAvail: 'తెలియజేసినందుకు ధన్యవాదాలు. రిక్రూటర్ మిమ్మల్ని సంప్రదిస్తారు. నమస్కారం.',
    ivNoReply: 'ధన్యవాదాలు. నిర్ధారణ కోసం రిక్రూటర్ మిమ్మల్ని సంప్రదిస్తారు. నమస్కారం.',
    tz: 'భారత కాలమానం',
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

// requirement + application + candidate -> the facts. NOTHING that is not stored is added.
function buildData({ candidate, app, requirement, link }) {
  const c = candidate || {};
  const r = requirement || {};
  const a = app || {};
  const first = clean(String(c.name || '').split(/\s+/)[0], 40);
  const kind = MODE_KIND(a.interviewMode);
  let linkOk = false;
  if (link != null) linkOk = !!link; // caller already verified it
  const data = {
    name: clean(c.name, 80),
    firstName: first,
    jobTitle: clean(r.title, 100),
    location: clean(r.location, 80),
    workMode: WORK_MODE[String(r.workMode || '').toLowerCase()] || '',
    employmentType: clean(r.employmentType, 40).toLowerCase(),
    experience: experienceWords(r.experience) || experienceWords(r.relevantExperience),
    skills: firstItems(r.skills, 6, 160),
    responsibilities: firstItems(r.responsibilities, 3, 220),
    salary: clean(r.salary, 60),
    interview: a.interviewAt ? {
      at: new Date(a.interviewAt).toISOString(),
      mode: kind,
      location: clean(a.interviewLocation, 160),
      hasLink: linkOk,
      round: a.interviewRound || 1,
    } : null,
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
  B.intro = fill(P.screenIntro, { job: data.jobTitle });
  const brief = [
    fill(P.briefLoc, { location: data.location }),
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
  if (purpose === 'Screening') {
    add('convenient', B.convenient);
    add('intro', B.intro);
    add('brief', B.brief);
    add('interest', P.interestQ);
    add('qExp', P.qExp);
    add('qLoc', P.qLoc);
    add('qNotice', P.qNotice);
    add('qProceed', P.qProceed);
    add('close', P.closeInterested);
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
  LANGS, PURPOSES, TRANSACTIONAL, TZ, FORBIDDEN, hasForbidden, phrases, clean, fill, dateWords, timeWords, buildData, cleanFields, checkFields, blocks, preview, checkTemplates, MODE_KIND,
};
