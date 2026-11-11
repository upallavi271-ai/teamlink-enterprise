// ---------------------------------------------------------------------------
// THE VOICE RECORDING KIT - WHAT THE SPEAKER READS (founder 2026-11-11: "One AI Caller = One Consistent Voice Identity across all 3
// languages"). One person records about 25 minutes in English, Telugu and Hindi; a voice is then trained on those recordings for each
// language, so the AI sounds like the same person whatever language the call is in.
//
// The lines are, first, every line the AI calls really say (calling/scripts.js phrases, with the names, jobs, places, salaries and
// dates filled in a few different ways), then the everyday call talk and numbers below, written the way the calls speak them:
// Telugu / Hindi with the English words people really use (salary, experience, notice period ...), in Telugu / Hindi letters.
//
// Each line's id is made from its words, so a line keeps its id (and its recording) when lines are added or reordered.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const FILL = {
  English: {
    name: ['Ravi', 'Priya', 'Sravani', 'Mahesh', 'Lakshmi', 'Kiran'], job: ['Staff Nurse', 'Python Developer', 'HR Executive', 'Accountant', 'Pharmacist', 'Sales Executive'],
    location: ['Hyderabad', 'Visakhapatnam', 'Bangalore', 'Vijayawada', 'Chennai'], salary: ['twenty five thousand a month', 'thirty five thousand a month', 'four lakhs a year', 'eighteen thousand a month', 'six lakhs a year'],
    experience: ['two years of', 'one to three years of', 'at least one year of', 'five years of'], date: ['tomorrow', 'the fifteenth of November', 'Monday', 'the second of December'], time: ['eleven in the morning', 'three in the afternoon', 'ten thirty in the morning', 'five in the evening'],
    when: ['tomorrow evening', 'after six', 'Saturday morning', 'next week'], needs: ['good communication and basic computer skills', 'a nursing registration and ICU experience', 'two wheeler and local language'], workMode: ['It is work from office', 'It is a hybrid job', 'It is a field job'],
    employmentType: ['A full time', 'A contract'], skills: ['Excel and Tally', 'Python and SQL', 'Java and Spring Boot', 'customer handling and MS Office'], responsibilities: ['patient care and keeping the records', 'teaching first year students', 'handling customer calls and follow ups'],
    place: ['hospital', 'college', 'software company', 'school'], education: ['A B.Sc Nursing degree', 'Any graduation', 'A B.Pharmacy degree'], joining: ['Within fifteen days', 'Immediately', 'From the first of next month'],
    kind: ['online', 'face to face'], yrs: ['three', 'two', 'five'], days: ['thirty', 'fifteen', 'sixty'], instructions: ['Please bring your resume and an ID proof', 'Please join the Google Meet link five minutes early'],
  },
  Telugu: {
    name: ['రవి', 'ప్రియ', 'శ్రావణి', 'మహేష్', 'లక్ష్మి', 'కిరణ్'], job: ['స్టాఫ్ నర్స్', 'పైథాన్ డెవలపర్', 'హెచ్ ఆర్ ఎగ్జిక్యూటివ్', 'అకౌంటెంట్', 'ఫార్మసిస్ట్', 'సేల్స్ ఎగ్జిక్యూటివ్'],
    location: ['హైదరాబాద్', 'విశాఖపట్నం', 'బెంగళూరు', 'విజయవాడ', 'చెన్నై'], salary: ['నెలకి ఇరవై ఐదు వేలు', 'నెలకి ముప్పై ఐదు వేలు', 'సంవత్సరానికి నాలుగు లక్షలు', 'నెలకి పద్దెనిమిది వేలు', 'సంవత్సరానికి ఆరు లక్షలు'],
    experience: ['రెండు సంవత్సరాల', 'ఒకటి నుంచి మూడు సంవత్సరాల', 'కనీసం ఒక సంవత్సరం', 'ఐదు సంవత్సరాల'], date: ['రేపు', 'నవంబర్ పదిహేను', 'సోమవారం', 'డిసెంబర్ రెండు'], time: ['పొద్దున పదకొండు గంటలకి', 'మధ్యాహ్నం మూడు గంటలకి', 'పొద్దున పదిన్నరకి', 'సాయంత్రం ఐదు గంటలకి'],
    when: ['రేపు సాయంత్రం', 'ఆరు గంటల తర్వాత', 'శనివారం పొద్దున', 'వచ్చే వారం'], needs: ['మంచి కమ్యూనికేషన్, బేసిక్ కంప్యూటర్ స్కిల్స్', 'నర్సింగ్ రిజిస్ట్రేషన్, ఐ సి యు ఎక్స్‌పీరియన్స్', 'టూ వీలర్, లోకల్ లాంగ్వేజ్'], workMode: ['ఆఫీస్ నుంచి వర్క్', 'హైబ్రిడ్ వర్క్', 'ఫీల్డ్ వర్క్'],
    employmentType: ['ఫుల్ టైమ్', 'కాంట్రాక్ట్'], skills: ['ఎక్సెల్, ట్యాలీ', 'పైథాన్, ఎస్ క్యూ ఎల్', 'జావా, స్ప్రింగ్ బూట్', 'కస్టమర్ హ్యాండ్లింగ్, ఎం ఎస్ ఆఫీస్'], responsibilities: ['పేషెంట్ కేర్, రికార్డ్స్ మెయింటైన్ చేయడం', 'ఫస్ట్ ఇయర్ స్టూడెంట్స్ కి టీచింగ్', 'కస్టమర్ కాల్స్, ఫాలో అప్స్ చూడటం'],
    place: ['హాస్పిటల్', 'కాలేజ్', 'సాఫ్ట్‌వేర్ కంపెనీ', 'స్కూల్'], education: ['బి ఎస్ సి నర్సింగ్', 'ఏదైనా డిగ్రీ', 'బి ఫార్మసీ'], joining: ['పదిహేను రోజుల్లో', 'వెంటనే', 'వచ్చే నెల ఒకటో తారీఖు నుంచి'],
    kind: ['ఆన్‌లైన్', 'డైరెక్ట్'], yrs: ['మూడు', 'రెండు', 'ఐదు'], days: ['ముప్పై', 'పదిహేను', 'అరవై'], instructions: ['రెస్యూమ్, ఐడి ప్రూఫ్ తీసుకుని రండి', 'గూగుల్ మీట్ లింక్ లో ఐదు నిమిషాలు ముందే జాయిన్ అవ్వండి'],
  },
  Hindi: {
    name: ['रवि', 'प्रिया', 'श्रावणी', 'महेश', 'लक्ष्मी', 'किरण'], job: ['स्टाफ नर्स', 'पाइथन डेवलपर', 'एचआर एग्ज़ीक्यूटिव', 'अकाउंटेंट', 'फ़ार्मासिस्ट', 'सेल्स एग्ज़ीक्यूटिव'],
    location: ['हैदराबाद', 'विशाखापट्टनम', 'बैंगलोर', 'विजयवाड़ा', 'चेन्नई'], salary: ['पच्चीस हज़ार महीना', 'पैंतीस हज़ार महीना', 'चार लाख सालाना', 'अठारह हज़ार महीना', 'छह लाख सालाना'],
    experience: ['दो साल का', 'एक से तीन साल का', 'कम से कम एक साल का', 'पाँच साल का'], date: ['कल', 'पंद्रह नवंबर', 'सोमवार', 'दो दिसंबर'], time: ['सुबह ग्यारह बजे', 'दोपहर तीन बजे', 'सुबह साढ़े दस बजे', 'शाम पाँच बजे'],
    when: ['कल शाम', 'छह बजे के बाद', 'शनिवार सुबह', 'अगले हफ़्ते'], needs: ['अच्छी कम्युनिकेशन और बेसिक कंप्यूटर स्किल्स', 'नर्सिंग रजिस्ट्रेशन और आईसीयू एक्सपीरियंस', 'टू व्हीलर और लोकल भाषा'], workMode: ['ऑफ़िस से काम', 'हाइब्रिड काम', 'फ़ील्ड का काम'],
    employmentType: ['फुल टाइम', 'कॉन्ट्रैक्ट'], skills: ['एक्सेल और टैली', 'पाइथन और एसक्यूएल', 'जावा और स्प्रिंग बूट', 'कस्टमर हैंडलिंग और एमएस ऑफ़िस'], responsibilities: ['पेशेंट केयर और रिकॉर्ड रखना', 'फ़र्स्ट ईयर के स्टूडेंट्स को पढ़ाना', 'कस्टमर कॉल्स और फ़ॉलो-अप संभालना'],
    place: ['हॉस्पिटल', 'कॉलेज', 'सॉफ़्टवेयर कंपनी', 'स्कूल'], education: ['बीएससी नर्सिंग', 'कोई भी ग्रेजुएशन', 'बी फ़ार्मेसी'], joining: ['पंद्रह दिन में', 'तुरंत', 'अगले महीने की पहली तारीख़ से'],
    kind: ['ऑनलाइन', 'आमने-सामने'], yrs: ['तीन', 'दो', 'पाँच'], days: ['तीस', 'पंद्रह', 'साठ'], instructions: ['अपना रिज़्यूमे और आईडी प्रूफ़ साथ लाइए', 'गूगल मीट लिंक पर पाँच मिनट पहले जुड़ जाइए'],
  },
};

// Everyday call talk, numbers and mixed sentences: what a recruiter's AI says around the script lines.
const EXTRA = {
  English: [
    'Good morning, how are you today?', 'Good afternoon, I hope I am not disturbing you.', 'Good evening, is this a good time to talk?',
    'Thank you for picking up the call.', 'Okay, got it.', 'Sure, no problem at all.', 'That sounds good.', 'Perfect, thank you.',
    'Could you please say that once more?', 'Sorry, the line was not clear for a second.', 'Can you hear me now?', 'I can hear you clearly now.',
    'Let me note that down.', 'Just a moment, please.', 'Alright, let us move to the next question.', 'That is very helpful, thank you.',
    'How many years of experience do you have in this field?', 'What is your current salary per month?', 'What salary are you expecting for this role?',
    'What is your notice period in your current company?', 'Can you join within fifteen days?', 'Are you open to working in Hyderabad?',
    'Which city are you staying in right now?', 'Are you currently working, or looking for a change?', 'What is your highest qualification?',
    'Do you have a valid nursing registration?', 'Are you comfortable with night shifts?', 'Is work from office okay for you?',
    'The interview will be online, on Google Meet.', 'The interview is face to face, at the client office.', 'I will share the job details on WhatsApp.',
    'Please send your updated resume to this number.', 'Our recruiter will call you back today.', 'The client will confirm the interview slot by tomorrow.',
    'Your profile looks like a good match for this role.', 'The salary depends on your experience and the interview.', 'There are three openings for this position.',
    'The job timing is nine thirty in the morning to six thirty in the evening.', 'Saturday is a half day, and Sunday is off.', 'The office is close to the metro station.',
    'Transport and food are provided by the company.', 'The joining bonus is paid after three months.', 'You will get PF and health insurance.',
    'Your current salary is twenty two thousand, and you expect thirty thousand. Is that right?', 'You have four years of experience, and your notice period is thirty days.',
    'The expected salary is between three and a half and four lakhs per year.', 'I understand, a long notice period can be difficult.', 'That is completely fine.',
    'May I know why you are looking for a change?', 'Is there anything else you would like to know about the job?', 'You can ask me anything about this role.',
    'I am an AI assistant from TeamLink Consultants.', 'This call is about a job opening that matches your profile.', 'If you are busy, I can call you later.',
    'When would be a good time to call you back?', 'I will call you tomorrow at eleven.', 'No worries, I will not call again about this job.',
    'Thank you for your time, have a nice day.', 'All the best for your interview.', 'We will keep you posted on the next steps.',
    'Your interview is on Monday, the eighteenth of November, at ten thirty in the morning.', 'Please keep your phone switched on during the day.',
    'One, two, three, four, five, six, seven, eight, nine, ten.', 'Fifteen days, thirty days, forty five days, sixty days, ninety days.',
    'Ten thousand, fifteen thousand, twenty thousand, twenty five thousand, fifty thousand.', 'January, February, March, April, May, June.',
    'July, August, September, October, November, December.', 'Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.',
    'The candidate is a B.Tech graduate with two years in Java and Spring Boot.', 'We need someone who knows Excel, Tally and GST filing.',
    'This is a teaching job in an engineering college in Vijayawada.', 'The hospital is looking for ICU nurses with at least one year of experience.',
    'Are you willing to relocate if the salary is good?', 'Would you like the job description on WhatsApp or by email?', 'Your email address, please.',
    'Can you spell your name for me?', 'Thank you, I have updated your details.', 'Let me read back what I noted.', 'Did I get everything right?',
  ],
  Telugu: [
    'గుడ్ మార్నింగ్, ఎలా ఉన్నారు?', 'నమస్కారం, ఇప్పుడు మాట్లాడొచ్చా?', 'కాల్ లిఫ్ట్ చేసినందుకు థాంక్స్.', 'సరే, అర్థమైంది.', 'పర్లేదు, ఏం ప్రాబ్లమ్ లేదు.',
    'బాగుంది, థాంక్యూ.', 'ఇంకోసారి చెప్తారా?', 'సారీ, ఒక సెకన్ లైన్ క్లియర్‌గా లేదు.', 'ఇప్పుడు వినిపిస్తుందా?', 'ఇప్పుడు క్లియర్‌గా వినిపిస్తుంది.',
    'ఒక్క నిమిషం, నోట్ చేసుకుంటా.', 'సరే, నెక్స్ట్ క్వశ్చన్ కి వెళ్దాం.', 'చాలా హెల్ప్ అయ్యింది, థాంక్స్.',
    'ఈ ఫీల్డ్ లో మీకు ఎన్ని సంవత్సరాల ఎక్స్‌పీరియన్స్ ఉంది?', 'ఇప్పుడు మీ నెల సాలరీ ఎంత?', 'ఈ జాబ్ కి ఎంత సాలరీ ఎక్స్‌పెక్ట్ చేస్తున్నారు?',
    'మీ కరెంట్ కంపెనీ లో నోటీస్ పీరియడ్ ఎంత?', 'పదిహేను రోజుల్లో జాయిన్ అవ్వగలరా?', 'హైదరాబాద్ లో వర్క్ చేయడానికి ఓకేనా?',
    'ఇప్పుడు మీరు ఏ సిటీ లో ఉంటున్నారు?', 'ఇప్పుడు జాబ్ చేస్తున్నారా, లేక చేంజ్ కోసం చూస్తున్నారా?', 'మీ హయ్యెస్ట్ క్వాలిఫికేషన్ ఏంటి?',
    'నైట్ షిఫ్ట్ మీకు ఓకేనా?', 'ఆఫీస్ నుంచి వర్క్ చేయడం ఓకేనా?', 'ఇంటర్వ్యూ ఆన్‌లైన్ లో, గూగుల్ మీట్ లో ఉంటుంది.', 'ఇంటర్వ్యూ డైరెక్ట్ గా, క్లయింట్ ఆఫీస్ లో ఉంటుంది.',
    'జాబ్ డీటెయిల్స్ వాట్సాప్ లో పంపిస్తా.', 'మీ అప్‌డేటెడ్ రెస్యూమ్ ఈ నంబర్ కి పంపండి.', 'మా రిక్రూటర్ ఈరోజే మీకు కాల్ చేస్తారు.',
    'రేపటి లోపు క్లయింట్ ఇంటర్వ్యూ టైమ్ కన్ఫర్మ్ చేస్తారు.', 'మీ ప్రొఫైల్ ఈ జాబ్ కి బాగా మ్యాచ్ అవుతుంది.', 'సాలరీ మీ ఎక్స్‌పీరియన్స్, ఇంటర్వ్యూ మీద డిపెండ్ అవుతుంది.',
    'ఈ పొజిషన్ కి మూడు ఓపెనింగ్స్ ఉన్నాయి.', 'జాబ్ టైమింగ్ పొద్దున తొమ్మిదిన్నర నుంచి సాయంత్రం ఆరున్నర వరకు.', 'శనివారం హాఫ్ డే, ఆదివారం హాలిడే.',
    'ఆఫీస్ మెట్రో స్టేషన్ కి దగ్గరలోనే ఉంది.', 'ట్రాన్స్‌పోర్ట్, ఫుడ్ కంపెనీ ఇస్తుంది.', 'పి ఎఫ్, హెల్త్ ఇన్సూరెన్స్ కూడా ఉంటాయి.',
    'మీ కరెంట్ సాలరీ ఇరవై రెండు వేలు, ఎక్స్‌పెక్టెడ్ ముప్పై వేలు, కరెక్టేనా?', 'మీకు నాలుగు సంవత్సరాల ఎక్స్‌పీరియన్స్, నోటీస్ పీరియడ్ ముప్పై రోజులు.',
    'అర్థమైంది, లాంగ్ నోటీస్ పీరియడ్ కొంచెం కష్టమే.', 'అది పూర్తిగా ఓకే.', 'జాబ్ చేంజ్ ఎందుకు చూస్తున్నారో తెలుసుకోవచ్చా?',
    'జాబ్ గురించి ఇంకేమైనా తెలుసుకోవాలా?', 'ఈ జాబ్ గురించి ఏదైనా అడగొచ్చు.', 'నేను టీమ్‌లింక్ కన్సల్టెంట్స్ నుంచి AI అసిస్టెంట్‌ని.',
    'మీ ప్రొఫైల్ కి మ్యాచ్ అయ్యే ఒక జాబ్ గురించి ఈ కాల్.', 'బిజీగా ఉంటే, తర్వాత కాల్ చేస్తా.', 'మళ్ళీ ఎప్పుడు కాల్ చేయమంటారు?',
    'రేపు పదకొండు గంటలకి కాల్ చేస్తా.', 'పర్లేదు, ఈ జాబ్ గురించి మళ్ళీ కాల్ చేయను.', 'మీ టైమ్ కి థాంక్స్, మంచి రోజు గడపండి.',
    'ఇంటర్వ్యూ కి ఆల్ ది బెస్ట్.', 'నెక్స్ట్ స్టెప్స్ గురించి మీకు అప్‌డేట్ చేస్తాం.', 'మీ ఇంటర్వ్యూ సోమవారం, నవంబర్ పద్దెనిమిది, పొద్దున పదిన్నరకి.',
    'పగలంతా ఫోన్ ఆన్ లో ఉంచండి.', 'ఒకటి, రెండు, మూడు, నాలుగు, ఐదు, ఆరు, ఏడు, ఎనిమిది, తొమ్మిది, పది.',
    'పదిహేను రోజులు, ముప్పై రోజులు, నలభై ఐదు రోజులు, అరవై రోజులు, తొంభై రోజులు.', 'పది వేలు, పదిహేను వేలు, ఇరవై వేలు, ఇరవై ఐదు వేలు, యాభై వేలు.',
    'జనవరి, ఫిబ్రవరి, మార్చి, ఏప్రిల్, మే, జూన్.', 'జూలై, ఆగస్ట్, సెప్టెంబర్, అక్టోబర్, నవంబర్, డిసెంబర్.',
    'సోమవారం, మంగళవారం, బుధవారం, గురువారం, శుక్రవారం, శనివారం, ఆదివారం.', 'జావా, స్ప్రింగ్ బూట్ లో రెండు సంవత్సరాలు ఎక్స్‌పీరియన్స్ ఉన్న బి టెక్ క్యాండిడేట్ కావాలి.',
    'ఎక్సెల్, ట్యాలీ, జి ఎస్ టి ఫైలింగ్ తెలిసిన వాళ్ళు కావాలి.', 'ఇది విజయవాడ లో ఒక ఇంజనీరింగ్ కాలేజ్ లో టీచింగ్ జాబ్.',
    'హాస్పిటల్ కి కనీసం ఒక సంవత్సరం ఎక్స్‌పీరియన్స్ ఉన్న ఐ సి యు నర్సెస్ కావాలి.', 'సాలరీ బాగుంటే రీలొకేట్ అవ్వడానికి రెడీనా?',
    'జాబ్ డిస్క్రిప్షన్ వాట్సాప్ లో కావాలా, ఈమెయిల్ లో కావాలా?', 'మీ ఈమెయిల్ ఐడి చెప్తారా?', 'థాంక్స్, మీ డీటెయిల్స్ అప్‌డేట్ చేశా.',
    'నేను నోట్ చేసుకున్నది ఒకసారి చెప్తా.', 'అంతా కరెక్ట్ గా ఉందా?', 'మీ ఫ్యామిలీ కి కూడా ఓకేనా, ఒకసారి మాట్లాడి చెప్తారా?',
    'పర్లేదు అండి, మీరు ఆలోచించుకుని చెప్పండి.', 'ఈ జాబ్ కి టెలుగు కూడా కావాలి, మీకు వస్తుంది కదా?', 'వర్క్ ఫ్రమ్ హోమ్ ఆప్షన్ లేదు, ఆఫీస్ కి రావాలి.',
    'ఫ్రెషర్స్ కూడా అప్లై చేయొచ్చు.', 'ఇంటర్వ్యూ రెండు రౌండ్స్ ఉంటాయి, ఫస్ట్ టెక్నికల్, తర్వాత హెచ్ ఆర్.',
  ],
  Hindi: [
    'गुड मॉर्निंग, आप कैसे हैं?', 'नमस्ते, क्या अभी बात कर सकते हैं?', 'कॉल उठाने के लिए धन्यवाद।', 'ठीक है, समझ गई।', 'कोई बात नहीं, कोई प्रॉब्लम नहीं।',
    'बहुत बढ़िया, थैंक यू।', 'एक बार फिर से बताएँगे?', 'सॉरी, एक सेकंड लाइन साफ़ नहीं थी।', 'अब आवाज़ आ रही है?', 'अब साफ़ सुनाई दे रहा है।',
    'एक मिनट, मैं नोट कर लेती हूँ।', 'ठीक है, अगले सवाल पर चलते हैं।', 'बहुत मदद मिली, धन्यवाद।',
    'इस फ़ील्ड में आपका कितने साल का एक्सपीरियंस है?', 'अभी आपकी महीने की सैलरी कितनी है?', 'इस जॉब के लिए आप कितनी सैलरी एक्सपेक्ट कर रहे हैं?',
    'आपकी करंट कंपनी में नोटिस पीरियड कितना है?', 'क्या आप पंद्रह दिन में जॉइन कर सकते हैं?', 'क्या हैदराबाद में काम करना ठीक रहेगा?',
    'अभी आप किस शहर में रह रहे हैं?', 'अभी जॉब कर रहे हैं, या चेंज देख रहे हैं?', 'आपकी हाईएस्ट क्वालिफ़िकेशन क्या है?',
    'क्या नाइट शिफ़्ट आपके लिए ठीक है?', 'क्या ऑफ़िस से काम करना ठीक है?', 'इंटरव्यू ऑनलाइन होगा, गूगल मीट पर।', 'इंटरव्यू आमने-सामने होगा, क्लाइंट के ऑफ़िस में।',
    'जॉब की डिटेल्स मैं व्हाट्सऐप पर भेज दूँगी।', 'अपना अपडेटेड रिज़्यूमे इस नंबर पर भेज दीजिए।', 'हमारे रिक्रूटर आज ही आपको कॉल करेंगे।',
    'कल तक क्लाइंट इंटरव्यू का टाइम कन्फ़र्म कर देंगे।', 'आपकी प्रोफ़ाइल इस जॉब के लिए अच्छी मैच है।', 'सैलरी आपके एक्सपीरियंस और इंटरव्यू पर डिपेंड करती है।',
    'इस पोज़िशन के लिए तीन ओपनिंग्स हैं।', 'जॉब टाइमिंग सुबह साढ़े नौ से शाम साढ़े छह बजे तक है।', 'शनिवार हाफ़ डे है, और रविवार छुट्टी।',
    'ऑफ़िस मेट्रो स्टेशन के पास ही है।', 'ट्रांसपोर्ट और खाना कंपनी देती है।', 'पीएफ़ और हेल्थ इंश्योरेंस भी मिलेगा।',
    'आपकी करंट सैलरी बाईस हज़ार है, और एक्सपेक्टेड तीस हज़ार, सही है?', 'आपका चार साल का एक्सपीरियंस है, और नोटिस पीरियड तीस दिन।',
    'समझ सकती हूँ, लंबा नोटिस पीरियड थोड़ा मुश्किल होता है।', 'यह बिल्कुल ठीक है।', 'क्या मैं जान सकती हूँ कि आप चेंज क्यों देख रहे हैं?',
    'जॉब के बारे में और कुछ जानना है?', 'इस जॉब के बारे में आप कुछ भी पूछ सकते हैं।', 'मैं टीमलिंक कंसल्टेंट्स की AI असिस्टेंट हूँ।',
    'यह कॉल आपकी प्रोफ़ाइल से मैच होने वाली एक जॉब के बारे में है।', 'अगर आप बिज़ी हैं, तो मैं बाद में कॉल कर लूँगी।', 'आपको दोबारा कब कॉल करूँ?',
    'मैं कल ग्यारह बजे कॉल करूँगी।', 'कोई बात नहीं, इस जॉब के बारे में दोबारा कॉल नहीं करूँगी।', 'आपके समय के लिए धन्यवाद, आपका दिन अच्छा रहे।',
    'इंटरव्यू के लिए ऑल द बेस्ट।', 'अगले स्टेप्स के बारे में हम आपको बताते रहेंगे।', 'आपका इंटरव्यू सोमवार, अठारह नवंबर, सुबह साढ़े दस बजे है।',
    'दिन भर अपना फ़ोन चालू रखिए।', 'एक, दो, तीन, चार, पाँच, छह, सात, आठ, नौ, दस।', 'पंद्रह दिन, तीस दिन, पैंतालीस दिन, साठ दिन, नब्बे दिन।',
    'दस हज़ार, पंद्रह हज़ार, बीस हज़ार, पच्चीस हज़ार, पचास हज़ार।', 'जनवरी, फ़रवरी, मार्च, अप्रैल, मई, जून।', 'जुलाई, अगस्त, सितंबर, अक्टूबर, नवंबर, दिसंबर।',
    'सोमवार, मंगलवार, बुधवार, गुरुवार, शुक्रवार, शनिवार, रविवार।', 'जावा और स्प्रिंग बूट में दो साल के एक्सपीरियंस वाला बीटेक कैंडिडेट चाहिए।',
    'एक्सेल, टैली और जीएसटी फ़ाइलिंग जानने वाले चाहिए।', 'यह विजयवाड़ा के एक इंजीनियरिंग कॉलेज में टीचिंग जॉब है।',
    'हॉस्पिटल को कम से कम एक साल के एक्सपीरियंस वाली आईसीयू नर्सें चाहिए।', 'अगर सैलरी अच्छी हो तो रिलोकेट करने के लिए तैयार हैं?',
    'जॉब डिस्क्रिप्शन व्हाट्सऐप पर चाहिए या ईमेल पर?', 'अपनी ईमेल आईडी बताएँगे?', 'धन्यवाद, आपकी डिटेल्स अपडेट कर दी हैं।',
    'मैंने जो नोट किया है, एक बार पढ़कर सुनाती हूँ।', 'सब कुछ सही है?', 'घर पर भी एक बार बात करके बताएँगे?',
    'कोई बात नहीं, आप सोचकर बता दीजिए।', 'इस जॉब के लिए हिंदी भी चाहिए, आपको आती है ना?', 'वर्क फ़्रॉम होम का ऑप्शन नहीं है, ऑफ़िस आना होगा।',
    'फ़्रेशर्स भी अप्लाई कर सकते हैं।', 'इंटरव्यू के दो राउंड होंगे, पहले टेक्निकल, फिर एचआर।',
  ],
};

// Hindi changes with the speaker: a woman says "कर रही हूँ", a man "कर रहा हूँ". The kit asks once and reads the lines in that form.
const HI_FEMALE = [[/रहा हूँ/g, 'रही हूँ'], [/सकता हूँ/g, 'सकती हूँ'], [/गया हूँ/g, 'गई हूँ'], [/रहा था/g, 'रही थी'],
  [/करूँगा/g, 'करूँगी'], [/बताऊँगा/g, 'बताऊँगी'], [/भेजूँगा/g, 'भेजूँगी'], [/दूँगा/g, 'दूँगी'], [/लूँगा/g, 'लूँगी'], [/सुनाता हूँ/g, 'सुनाती हूँ'],
  [/लेता हूँ/g, 'लेती हूँ'], [/समझ गया/g, 'समझ गई'], [/असिस्टेंट हूँ/g, 'असिस्टेंट हूँ']];
const HI_MALE = [[/रही हूँ/g, 'रहा हूँ'], [/सकती हूँ/g, 'सकता हूँ'], [/गई हूँ/g, 'गया हूँ'], [/करूँगी/g, 'करूँगा'], [/भेज दूँगी/g, 'भेज दूँगा'],
  [/दूँगी/g, 'दूँगा'], [/लूँगी/g, 'लूँगा'], [/सुनाती हूँ/g, 'सुनाता हूँ'], [/लेती हूँ/g, 'लेता हूँ'], [/समझ गई/g, 'समझ गया'], [/की AI असिस्टेंट/g, 'का AI असिस्टेंट']];

const idOf = (lang, text) => `${lang.slice(0, 2).toLowerCase()}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`;

/** The lines to record for a language: [{ id, text, kind: 'call' | 'talk' }], in reading order, no repeats. */
function sentencesFor(lang, gender = 'female') {
  const S = require('./scripts'); // eslint-disable-line global-require
  const fill = FILL[lang];
  if (!fill) return [];
  const out = []; const seen = new Set();
  const add = (text, kind) => {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (lang === 'Hindi') (gender === 'male' ? HI_MALE : HI_FEMALE).forEach(([a, b]) => { t = t.replace(a, b); });
    if (!t || t.length < 3 || /\{[a-zA-Z_]+\}/.test(t) || seen.has(t)) return;
    seen.add(t); out.push({ id: idOf(lang, t), text: t, kind });
  };
  let lines = [];
  try {
    const walk = (v) => { if (typeof v === 'string') lines.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(S.phrases(lang));
  } catch { lines = []; }
  lines.forEach((line, n) => {
    const keys = [...new Set((line.match(/\{([a-zA-Z_]+)\}/g) || []).map((k) => k.slice(1, -1)))];
    if (!keys.length) { add(line, 'call'); return; }
    if (!keys.every((k) => fill[k])) return; // a placeholder the kit has no words for: skipped
    // four versions of a line with names / numbers in it, with different words each time
    for (let v = 0; v < 4; v += 1) add(keys.reduce((t, k) => t.split(`{${k}}`).join(fill[k][(n + v) % fill[k].length]), line), 'call');
  });
  EXTRA[lang].forEach((t) => add(t, 'talk'));
  return out;
}

const LANGS = ['English', 'Telugu', 'Hindi'];
module.exports = { sentencesFor, LANGS, idOf };
