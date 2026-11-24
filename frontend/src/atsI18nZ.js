// ---------------------------------------------------------------------------
// THE ATS SCREENS IN TELUGU AND HINDI (market benchmark 13.06, ATS wave 2 Z 2026-11-25). The same approach as the CRM's words
// (pages/crm/crmPlusC.jsx): the ATS's own words are ADDED to the app's one dictionary (i18n.jsx), keyed by the English words the
// screens show, and the screens draw them through t(). Wired through the shared pieces, so every ATS screen gets them at once:
//   headings      ListPageHeader / CrqHead / the page <h1>s, the ATS kit's panels and tiles, ATS settings sections
//   tabs          TabStrip (already translated its labels; the ATS tab words are added here)
//   buttons       Import / Export / History / Template, + Add candidate / requirement / client, Filters, Sort, Clear all, Done
//   labels        the filter bar, the chips, the column names of Candidates / Requirements / Clients, the ATS settings tables
//   status words  every step (stageLabel), interview status, requirement Open / Closed, agreement status (frontend/src/atsVocab.js)
// A word with no translation stays English (t() never shows a key). English stays the default; each person picks the language at
// the bottom of the menu. Imported once by App.jsx.
// ---------------------------------------------------------------------------
import { translations } from './i18n.jsx';

export const ATS_TE = {
  // ---- steps (stage labels) and status words
  New: 'కొత్తది', 'AI interview needed': 'AI ఇంటర్వ్యూ అవసరం', 'AI interview booked': 'AI ఇంటర్వ్యూ బుక్ అయింది', 'AI interview done': 'AI ఇంటర్వ్యూ పూర్తయింది',
  'Check by recruiter': 'రిక్రూటర్ పరిశీలన', 'Approved by recruiter': 'రిక్రూటర్ ఆమోదించారు', 'Check by team lead': 'టీమ్ లీడ్ పరిశీలన', 'Check by client manager': 'క్లయింట్ మేనేజర్ పరిశీలన',
  'With BDE TL (to send to client)': 'BDE TL వద్ద (క్లయింట్‌కు పంపడానికి)', 'Sent to client': 'క్లయింట్‌కు పంపబడింది', 'Client checking': 'క్లయింట్ పరిశీలిస్తున్నారు', 'Client shortlisted': 'క్లయింట్ షార్ట్‌లిస్ట్ చేశారు',
  'Interview booked': 'ఇంటర్వ్యూ బుక్ అయింది', 'Interview done': 'ఇంటర్వ్యూ పూర్తయింది', Selected: 'ఎంపికయ్యారు', Offer: 'ఆఫర్', 'Offer accepted': 'ఆఫర్ అంగీకరించారు', Joined: 'చేరారు', Hired: 'నియమించబడ్డారు',
  Rejected: 'తిరస్కరించబడింది', Hold: 'నిలిపివేత', Open: 'తెరిచి ఉంది', Closed: 'మూసివేయబడింది', 'On hold': 'నిలిపివేయబడింది', 'On Hold': 'నిలిపివేయబడింది', Active: 'యాక్టివ్', Inactive: 'నిష్క్రియం', Archived: 'ఆర్కైవ్ చేయబడింది',
  Scheduled: 'షెడ్యూల్ అయింది', Confirmed: 'ధృవీకరించబడింది', Started: 'ప్రారంభమైంది', Completed: 'పూర్తయింది', 'Waiting for feedback': 'అభిప్రాయం కోసం వేచి ఉంది', 'Feedback in': 'అభిప్రాయం వచ్చింది',
  Cancelled: 'రద్దు చేయబడింది', 'No show': 'హాజరు కాలేదు', Rescheduled: 'మళ్ళీ షెడ్యూల్ అయింది', Made: 'తయారైంది', Sent: 'పంపబడింది', Viewed: 'చూశారు', 'Client Confirmation Pending': 'క్లయింట్ ధృవీకరణ పెండింగ్',
  Signed: 'సంతకం అయింది', Expired: 'గడువు ముగిసింది', Pending: 'పెండింగ్', 'In progress': 'జరుగుతోంది', Clear: 'క్లియర్', Discrepancy: 'తేడా ఉంది', Passed: 'ఉత్తీర్ణులయ్యారు', Failed: 'విఫలమైంది',
  Connected: 'కనెక్ట్ అయింది', Ready: 'సిద్ధంగా ఉంది', 'Switched off': 'ఆఫ్ చేయబడింది', 'Not set up': 'సెటప్ చేయలేదు', 'Built in': 'అంతర్నిర్మితం', Late: 'ఆలస్యం', Overdue: 'గడువు దాటింది', 'Due today': 'ఈరోజు గడువు',
  // ---- headings, sections and tabs of the ATS
  Calendar: 'క్యాలెండర్', 'Call lists': 'కాల్ జాబితాలు', 'Data quality': 'డేటా నాణ్యత', Workflow: 'వర్క్‌ఫ్లో', 'Recruiter handover': 'రిక్రూటర్ అప్పగింత', 'My Workload': 'నా పని భారం',
  'Internal Hiring': 'అంతర్గత నియామకం', Posting: 'పోస్టింగ్', 'Duplicate requirements': 'పునరావృత అవసరాలు', 'Every requirement we are hiring for, and how far each one has got.': 'మనం నియమిస్తున్న ప్రతి అవసరం, ఒక్కొక్కటి ఎంత దూరం వచ్చిందో.',
  'Needs Attention': 'శ్రద్ధ అవసరం', 'Needs attention': 'శ్రద్ధ అవసరం', 'Quick actions': 'త్వరిత చర్యలు', 'Candidate pipeline': 'అభ్యర్థుల పైప్‌లైన్', 'Candidate insights': 'అభ్యర్థుల విశ్లేషణ', 'Hiring funnel': 'నియామక ఫన్నెల్',
  'Top requirements': 'ముఖ్య అవసరాలు', 'Requirement list': 'అవసరాల జాబితా', 'Selected requirement': 'ఎంచుకున్న అవసరం', 'Top Clients by Open Requirements': 'తెరిచిన అవసరాల ప్రకారం ముఖ్య క్లయింట్లు', 'Clients List': 'క్లయింట్ల జాబితా',
  'Agreement Steps': 'ఒప్పంద దశలు', 'Total Clients': 'మొత్తం క్లయింట్లు', 'Clients by Department': 'విభాగాల వారీగా క్లయింట్లు', 'Requirements by Department': 'విభాగాల వారీగా అవసరాలు', 'Requirements by stage': 'దశల వారీగా అవసరాలు',
  "Today's interviews": 'ఈరోజు ఇంటర్వ్యూలు', 'Upcoming interviews (next 5)': 'రాబోయే ఇంటర్వ్యూలు (తదుపరి 5)', 'Upcoming (this week)': 'రాబోయేవి (ఈ వారం)', 'Completed (this month)': 'పూర్తయినవి (ఈ నెల)', 'Cancelled / Rescheduled': 'రద్దు / మళ్ళీ షెడ్యూల్',
  'Interviews per week': 'వారానికి ఇంటర్వ్యూలు', 'Open Requirements': 'తెరిచిన అవసరాలు', 'No Open Requirement': 'తెరిచిన అవసరం లేదు', 'Unsigned Agreement': 'సంతకం కాని ఒప్పందం', 'Agreements waiting for you': 'మీ కోసం వేచి ఉన్న ఒప్పందాలు',
  'My Clients': 'నా క్లయింట్లు', 'Agreement Pending': 'ఒప్పందం పెండింగ్', 'Joined / Billing': 'చేరారు / బిల్లింగ్', 'Needs a TL': 'TL అవసరం', 'Needs a recruiter': 'రిక్రూటర్ అవసరం', All: 'అన్నీ', Mine: 'నావి',
  'Needs my action': 'నా చర్య అవసరం', 'New from job portal': 'జాబ్ పోర్టల్ నుండి కొత్తవి', 'In checking': 'పరిశీలనలో', 'Interview done, no feedback': 'ఇంటర్వ్యూ అయింది, అభిప్రాయం లేదు', 'Not followed up': 'ఫాలో-అప్ చేయలేదు',
  'Hiring tools': 'నియామక సాధనాలు', Hiring: 'నియామకం', Duplicates: 'పునరావృతాలు', 'Contact lists': 'కాంటాక్ట్ జాబితాలు', 'Client requirements': 'క్లయింట్ అవసరాలు', Organisation: 'సంస్థ', 'Forms & workflows': 'ఫారాలు & వర్క్‌ఫ్లోలు',
  'Offers & onboarding': 'ఆఫర్లు & ఆన్‌బోర్డింగ్', Integrations: 'ఇంటిగ్రేషన్లు', 'Privacy & security': 'గోప్యత & భద్రత', 'Organisation, forms, onboarding, integrations and privacy for the ATS': 'ATS కోసం సంస్థ, ఫారాలు, ఆన్‌బోర్డింగ్, ఇంటిగ్రేషన్లు మరియు గోప్యత',
  'App catalogue': 'యాప్ కేటలాగ్', 'Single sign-on': 'సింగిల్ సైన్-ఆన్', 'Checks & tests': 'తనిఖీలు & పరీక్షలు', 'Job boards': 'జాబ్ బోర్డులు', 'Google / Microsoft 365': 'Google / Microsoft 365', 'Identity check': 'గుర్తింపు తనిఖీ',
  Branches: 'శాఖలు', 'Seats and plan': 'సీట్లు మరియు ప్లాన్', Currencies: 'కరెన్సీలు', Languages: 'భాషలు', 'Phone app': 'ఫోన్ యాప్', Calendars: 'క్యాలెండర్లు', Contacts: 'కాంటాక్ట్‌లు', 'Vendor connectors': 'వెండర్ కనెక్టర్లు',
  Onboarding: 'ఆన్‌బోర్డింగ్', Feedback: 'అభిప్రాయం', Offers: 'ఆఫర్లు', Joining: 'చేరిక',
  // ---- buttons
  Import: 'దిగుమతి', Export: 'ఎగుమతి', 'Exporting…': 'ఎగుమతి అవుతోంది…', Template: 'టెంప్లేట్', History: 'చరిత్ర', 'Approvals & history': 'ఆమోదాలు & చరిత్ర', 'Import (needs approval)': 'దిగుమతి (ఆమోదం అవసరం)',
  '+ Add candidate': '+ అభ్యర్థిని జోడించు', '+ Add Requirement': '+ అవసరాన్ని జోడించు', '+ Add requirement': '+ అవసరాన్ని జోడించు', '+ Add client': '+ క్లయింట్‌ను జోడించు', '+ Request requirement': '+ అవసరాన్ని అభ్యర్థించు',
  '+ New internal opening': '+ కొత్త అంతర్గత ఖాళీ', 'Draft from a note': 'నోట్ నుండి డ్రాఫ్ట్', Filters: 'ఫిల్టర్లు', 'More filters': 'మరిన్ని ఫిల్టర్లు', Sort: 'క్రమం', 'Clear all': 'అన్నీ తీసివేయి', 'Filters:': 'ఫిల్టర్లు:',
  'Search…': 'వెతుకు…', View: 'చూడు', 'View all': 'అన్నీ చూడు', Download: 'డౌన్‌లోడ్', 'Set up': 'సెటప్', Refresh: 'రిఫ్రెష్', Apply: 'వర్తింపజేయి', 'Assign recruiter': 'రిక్రూటర్‌ను కేటాయించు', 'Add to requirement': 'అవసరానికి జోడించు',
  'Move step': 'దశ మార్చు', 'Book interview': 'ఇంటర్వ్యూ బుక్ చేయి', Compare: 'పోల్చు', Dismiss: 'తీసివేయి', 'Find an app': 'యాప్‌ను వెతుకు', 'Read now': 'ఇప్పుడు చదువు', 'Add to ATS': 'ATS లో జోడించు', 'Check now': 'ఇప్పుడు తనిఖీ చేయి',
  // ---- common labels (filters, columns, fields)
  Candidate: 'అభ్యర్థి', Requirement: 'అవసరం', Client: 'క్లయింట్', Recruiter: 'రిక్రూటర్', 'Team lead': 'టీమ్ లీడ్', 'Senior team lead': 'సీనియర్ టీమ్ లీడ్', 'Client manager': 'క్లయింట్ మేనేజర్', 'Client manager (BDE)': 'క్లయింట్ మేనేజర్ (BDE)',
  Stage: 'దశ', Step: 'దశ', 'Next step': 'తదుపరి దశ', 'Next action': 'తదుపరి చర్య', Date: 'తేదీ', 'Date added': 'జోడించిన తేదీ', 'Added on': 'జోడించిన తేదీ', 'Came on': 'వచ్చిన తేదీ', Source: 'మూలం', Location: 'ప్రదేశం', City: 'నగరం',
  Experience: 'అనుభవం', Skills: 'నైపుణ్యాలు', Skill: 'నైపుణ్యం', 'Notice period': 'నోటీసు కాలం', 'Current job': 'ప్రస్తుత ఉద్యోగం', 'Expected salary': 'ఆశించిన జీతం', CTC: 'CTC', Salary: 'జీతం', Department: 'విభాగం', Designation: 'హోదా',
  Openings: 'ఖాళీలు', 'Openings left': 'మిగిలిన ఖాళీలు', 'Days open': 'తెరిచిన రోజులు', Priority: 'ప్రాధాన్యత', Industry: 'పరిశ్రమ', 'Work mode': 'పని విధానం', 'Posted on job sites': 'జాబ్ సైట్లలో పోస్ట్ చేయబడింది', Posted: 'పోస్ట్ చేయబడింది',
  Interview: 'ఇంటర్వ్యూ', 'Interview date': 'ఇంటర్వ్యూ తేదీ', Round: 'రౌండ్', Mode: 'విధానం', Interviewer: 'ఇంటర్వ్యూయర్', 'Offer date': 'ఆఫర్ తేదీ', 'Offer status': 'ఆఫర్ స్థితి', 'Offered CTC': 'ఆఫర్ చేసిన CTC', 'BGV status': 'BGV స్థితి',
  'Counter-offer': 'కౌంటర్-ఆఫర్', Guarantee: 'గ్యారంటీ', Invoice: 'ఇన్వాయిస్', Due: 'గడువు', 'Due between': 'గడువు మధ్య', Type: 'రకం', Owner: 'యజమాని', Agreement: 'ఒప్పందం', 'Agreement status': 'ఒప్పంద స్థితి', 'Agreement ends': 'ఒప్పందం ముగింపు',
  'Client added on': 'క్లయింట్ జోడించిన తేదీ', Joinings: 'చేరికలు', 'Joined between': 'చేరిన తేదీల మధ్య', 'Last contact': 'చివరి సంప్రదింపు', 'Last update': 'చివరి నవీకరణ', 'Last activity': 'చివరి కార్యకలాపం', Applications: 'దరఖాస్తులు',
  'Applied on': 'దరఖాస్తు తేదీ', 'Follow-up': 'ఫాలో-అప్', Fit: 'సరిపోలిక', 'Fit %': 'సరిపోలిక %', Action: 'చర్య', Actions: 'చర్యలు', Notes: 'నోట్స్', Note: 'నోట్', Reason: 'కారణం', Result: 'ఫలితం', Progress: 'పురోగతి', Target: 'లక్ష్యం',
  Performance: 'పనితీరు', Seat: 'సీటు', 'Work status': 'పని స్థితి', Kind: 'రకం', When: 'ఎప్పుడు', Who: 'ఎవరు', What: 'ఏమిటి', Vendor: 'వెండర్', Board: 'బోర్డు', Order: 'ఆర్డర్', Orders: 'ఆర్డర్లు', Month: 'నెల', Branch: 'శాఖ',
  'All branches': 'అన్ని శాఖలు', 'Working branch': 'పని చేసే శాఖ', 'Showing only {branch}': '{branch} మాత్రమే చూపిస్తోంది', clients: 'క్లయింట్లు', jobs: 'ఉద్యోగాలు', people: 'వ్యక్తులు', 'Pick a branch to work on its {what} only.': 'ఒక శాఖను ఎంచుకుంటే దాని {what} మాత్రమే.',
  Any: 'ఏదైనా', 'Showing {from} to {to} of {total}': '{total}లో {from} నుండి {to} వరకు', requirements: 'అవసరాలు', candidates: 'అభ్యర్థులు', results: 'ఫలితాలు', 'needs founder account': 'వ్యవస్థాపకుడి ఖాతా అవసరం',
  'Nothing needs attention right now.': 'ఇప్పుడు శ్రద్ధ అవసరమైనది ఏదీ లేదు.', 'No data available': 'డేటా లేదు', 'Nothing here yet.': 'ఇక్కడ ఇంకా ఏమీ లేదు.', 'No requirements here yet.': 'ఇక్కడ ఇంకా అవసరాలు లేవు.',
};

export const ATS_HI = {
  New: 'नया', 'AI interview needed': 'AI इंटरव्यू ज़रूरी', 'AI interview booked': 'AI इंटरव्यू बुक', 'AI interview done': 'AI इंटरव्यू पूरा',
  'Check by recruiter': 'रिक्रूटर जाँच', 'Approved by recruiter': 'रिक्रूटर ने मंज़ूर किया', 'Check by team lead': 'टीम लीड जाँच', 'Check by client manager': 'क्लाइंट मैनेजर जाँच',
  'With BDE TL (to send to client)': 'BDE TL के पास (क्लाइंट को भेजने के लिए)', 'Sent to client': 'क्लाइंट को भेजा', 'Client checking': 'क्लाइंट देख रहे हैं', 'Client shortlisted': 'क्लाइंट ने शॉर्टलिस्ट किया',
  'Interview booked': 'इंटरव्यू बुक', 'Interview done': 'इंटरव्यू पूरा', Selected: 'चयनित', Offer: 'ऑफ़र', 'Offer accepted': 'ऑफ़र स्वीकार', Joined: 'जॉइन किया', Hired: 'नियुक्त',
  Rejected: 'अस्वीकृत', Hold: 'रोका गया', Open: 'खुला', Closed: 'बंद', 'On hold': 'रोका गया', 'On Hold': 'रोका गया', Active: 'सक्रिय', Inactive: 'निष्क्रिय', Archived: 'संग्रहीत',
  Scheduled: 'तय', Confirmed: 'पुष्ट', Started: 'शुरू', Completed: 'पूरा', 'Waiting for feedback': 'फ़ीडबैक की प्रतीक्षा', 'Feedback in': 'फ़ीडबैक मिला',
  Cancelled: 'रद्द', 'No show': 'नहीं आए', Rescheduled: 'दोबारा तय', Made: 'बना', Sent: 'भेजा', Viewed: 'देखा', 'Client Confirmation Pending': 'क्लाइंट पुष्टि बाकी',
  Signed: 'हस्ताक्षरित', Expired: 'समाप्त', Pending: 'बाकी', 'In progress': 'जारी', Clear: 'साफ़', Discrepancy: 'अंतर मिला', Passed: 'उत्तीर्ण', Failed: 'असफल',
  Connected: 'जुड़ा हुआ', Ready: 'तैयार', 'Switched off': 'बंद किया', 'Not set up': 'सेट नहीं', 'Built in': 'पहले से मौजूद', Late: 'देर', Overdue: 'समय निकल गया', 'Due today': 'आज तक',
  Calendar: 'कैलेंडर', 'Call lists': 'कॉल सूचियाँ', 'Data quality': 'डेटा गुणवत्ता', Workflow: 'वर्कफ़्लो', 'Recruiter handover': 'रिक्रूटर हैंडओवर', 'My Workload': 'मेरा काम',
  'Internal Hiring': 'आंतरिक भर्ती', Posting: 'पोस्टिंग', 'Duplicate requirements': 'दोहराई गई आवश्यकताएँ', 'Every requirement we are hiring for, and how far each one has got.': 'हर आवश्यकता जिसके लिए हम भर्ती कर रहे हैं, और हर एक कहाँ तक पहुँची।',
  'Needs Attention': 'ध्यान चाहिए', 'Needs attention': 'ध्यान चाहिए', 'Quick actions': 'त्वरित काम', 'Candidate pipeline': 'उम्मीदवार पाइपलाइन', 'Candidate insights': 'उम्मीदवार विश्लेषण', 'Hiring funnel': 'भर्ती फ़नल',
  'Top requirements': 'मुख्य आवश्यकताएँ', 'Requirement list': 'आवश्यकता सूची', 'Selected requirement': 'चुनी गई आवश्यकता', 'Top Clients by Open Requirements': 'खुली आवश्यकताओं के अनुसार मुख्य क्लाइंट', 'Clients List': 'क्लाइंट सूची',
  'Agreement Steps': 'अनुबंध के चरण', 'Total Clients': 'कुल क्लाइंट', 'Clients by Department': 'विभाग के अनुसार क्लाइंट', 'Requirements by Department': 'विभाग के अनुसार आवश्यकताएँ', 'Requirements by stage': 'चरण के अनुसार आवश्यकताएँ',
  "Today's interviews": 'आज के इंटरव्यू', 'Upcoming interviews (next 5)': 'आने वाले इंटरव्यू (अगले 5)', 'Upcoming (this week)': 'आने वाले (इस सप्ताह)', 'Completed (this month)': 'पूरे (इस महीने)', 'Cancelled / Rescheduled': 'रद्द / दोबारा तय',
  'Interviews per week': 'प्रति सप्ताह इंटरव्यू', 'Open Requirements': 'खुली आवश्यकताएँ', 'No Open Requirement': 'कोई खुली आवश्यकता नहीं', 'Unsigned Agreement': 'बिना हस्ताक्षर अनुबंध', 'Agreements waiting for you': 'आपकी प्रतीक्षा में अनुबंध',
  'My Clients': 'मेरे क्लाइंट', 'Agreement Pending': 'अनुबंध बाकी', 'Joined / Billing': 'जॉइन / बिलिंग', 'Needs a TL': 'TL चाहिए', 'Needs a recruiter': 'रिक्रूटर चाहिए', All: 'सभी', Mine: 'मेरे',
  'Needs my action': 'मेरा काम चाहिए', 'New from job portal': 'जॉब पोर्टल से नए', 'In checking': 'जाँच में', 'Interview done, no feedback': 'इंटरव्यू हुआ, फ़ीडबैक नहीं', 'Not followed up': 'फ़ॉलो-अप नहीं हुआ',
  'Hiring tools': 'भर्ती उपकरण', Hiring: 'भर्ती', Duplicates: 'दोहराव', 'Contact lists': 'संपर्क सूचियाँ', 'Client requirements': 'क्लाइंट आवश्यकताएँ', Organisation: 'संगठन', 'Forms & workflows': 'फ़ॉर्म और वर्कफ़्लो',
  'Offers & onboarding': 'ऑफ़र और ऑनबोर्डिंग', Integrations: 'इंटीग्रेशन', 'Privacy & security': 'गोपनीयता और सुरक्षा', 'Organisation, forms, onboarding, integrations and privacy for the ATS': 'ATS के लिए संगठन, फ़ॉर्म, ऑनबोर्डिंग, इंटीग्रेशन और गोपनीयता',
  'App catalogue': 'ऐप कैटलॉग', 'Single sign-on': 'सिंगल साइन-ऑन', 'Checks & tests': 'जाँच और टेस्ट', 'Job boards': 'जॉब बोर्ड', 'Google / Microsoft 365': 'Google / Microsoft 365', 'Identity check': 'पहचान जाँच',
  Branches: 'शाखाएँ', 'Seats and plan': 'सीटें और प्लान', Currencies: 'मुद्राएँ', Languages: 'भाषाएँ', 'Phone app': 'फ़ोन ऐप', Calendars: 'कैलेंडर', Contacts: 'संपर्क', 'Vendor connectors': 'वेंडर कनेक्टर',
  Onboarding: 'ऑनबोर्डिंग', Feedback: 'फ़ीडबैक', Offers: 'ऑफ़र', Joining: 'जॉइनिंग',
  Import: 'आयात', Export: 'निर्यात', 'Exporting…': 'निर्यात हो रहा है…', Template: 'टेम्पलेट', History: 'इतिहास', 'Approvals & history': 'मंज़ूरी और इतिहास', 'Import (needs approval)': 'आयात (मंज़ूरी ज़रूरी)',
  '+ Add candidate': '+ उम्मीदवार जोड़ें', '+ Add Requirement': '+ आवश्यकता जोड़ें', '+ Add requirement': '+ आवश्यकता जोड़ें', '+ Add client': '+ क्लाइंट जोड़ें', '+ Request requirement': '+ आवश्यकता का अनुरोध',
  '+ New internal opening': '+ नई आंतरिक रिक्ति', 'Draft from a note': 'नोट से ड्राफ़्ट', Filters: 'फ़िल्टर', 'More filters': 'और फ़िल्टर', Sort: 'क्रम', 'Clear all': 'सब हटाएँ', 'Filters:': 'फ़िल्टर:',
  'Search…': 'खोजें…', View: 'देखें', 'View all': 'सब देखें', Download: 'डाउनलोड', 'Set up': 'सेट करें', Refresh: 'ताज़ा करें', Apply: 'लागू करें', 'Assign recruiter': 'रिक्रूटर दें', 'Add to requirement': 'आवश्यकता में जोड़ें',
  'Move step': 'चरण बदलें', 'Book interview': 'इंटरव्यू बुक करें', Compare: 'तुलना करें', Dismiss: 'हटाएँ', 'Find an app': 'ऐप खोजें', 'Read now': 'अभी पढ़ें', 'Add to ATS': 'ATS में जोड़ें', 'Check now': 'अभी जाँचें',
  Candidate: 'उम्मीदवार', Requirement: 'आवश्यकता', Client: 'क्लाइंट', Recruiter: 'रिक्रूटर', 'Team lead': 'टीम लीड', 'Senior team lead': 'सीनियर टीम लीड', 'Client manager': 'क्लाइंट मैनेजर', 'Client manager (BDE)': 'क्लाइंट मैनेजर (BDE)',
  Stage: 'चरण', Step: 'चरण', 'Next step': 'अगला चरण', 'Next action': 'अगला काम', Date: 'तारीख', 'Date added': 'जोड़ने की तारीख', 'Added on': 'जोड़ने की तारीख', 'Came on': 'आने की तारीख', Source: 'स्रोत', Location: 'स्थान', City: 'शहर',
  Experience: 'अनुभव', Skills: 'कौशल', Skill: 'कौशल', 'Notice period': 'नोटिस अवधि', 'Current job': 'वर्तमान नौकरी', 'Expected salary': 'अपेक्षित वेतन', CTC: 'CTC', Salary: 'वेतन', Department: 'विभाग', Designation: 'पद',
  Openings: 'रिक्तियाँ', 'Openings left': 'बची रिक्तियाँ', 'Days open': 'खुले दिन', Priority: 'प्राथमिकता', Industry: 'उद्योग', 'Work mode': 'काम का तरीका', 'Posted on job sites': 'जॉब साइटों पर पोस्ट', Posted: 'पोस्ट किया',
  Interview: 'इंटरव्यू', 'Interview date': 'इंटरव्यू की तारीख', Round: 'राउंड', Mode: 'तरीका', Interviewer: 'इंटरव्यूअर', 'Offer date': 'ऑफ़र की तारीख', 'Offer status': 'ऑफ़र की स्थिति', 'Offered CTC': 'ऑफ़र किया गया CTC', 'BGV status': 'BGV स्थिति',
  'Counter-offer': 'काउंटर-ऑफ़र', Guarantee: 'गारंटी', Invoice: 'इनवॉइस', Due: 'नियत', 'Due between': 'नियत तारीखों के बीच', Type: 'प्रकार', Owner: 'मालिक', Agreement: 'अनुबंध', 'Agreement status': 'अनुबंध की स्थिति', 'Agreement ends': 'अनुबंध समाप्ति',
  'Client added on': 'क्लाइंट जोड़ने की तारीख', Joinings: 'जॉइनिंग', 'Joined between': 'जॉइन की तारीखों के बीच', 'Last contact': 'आखिरी संपर्क', 'Last update': 'आखिरी अपडेट', 'Last activity': 'आखिरी गतिविधि', Applications: 'आवेदन',
  'Applied on': 'आवेदन की तारीख', 'Follow-up': 'फ़ॉलो-अप', Fit: 'मेल', 'Fit %': 'मेल %', Action: 'काम', Actions: 'काम', Notes: 'नोट्स', Note: 'नोट', Reason: 'कारण', Result: 'परिणाम', Progress: 'प्रगति', Target: 'लक्ष्य',
  Performance: 'प्रदर्शन', Seat: 'सीट', 'Work status': 'काम की स्थिति', Kind: 'प्रकार', When: 'कब', Who: 'कौन', What: 'क्या', Vendor: 'वेंडर', Board: 'बोर्ड', Order: 'ऑर्डर', Orders: 'ऑर्डर', Month: 'महीना', Branch: 'शाखा',
  'All branches': 'सभी शाखाएँ', 'Working branch': 'काम की शाखा', 'Showing only {branch}': 'केवल {branch} दिखा रहे हैं', clients: 'क्लाइंट', jobs: 'नौकरियाँ', people: 'लोग', 'Pick a branch to work on its {what} only.': 'एक शाखा चुनें, केवल उसके {what} दिखेंगे।',
  Any: 'कोई भी', 'Showing {from} to {to} of {total}': '{total} में से {from} से {to}', requirements: 'आवश्यकताएँ', candidates: 'उम्मीदवार', results: 'परिणाम', 'needs founder account': 'संस्थापक का खाता चाहिए',
  'Nothing needs attention right now.': 'अभी किसी चीज़ पर ध्यान की ज़रूरत नहीं।', 'No data available': 'कोई डेटा नहीं', 'Nothing here yet.': 'यहाँ अभी कुछ नहीं।', 'No requirements here yet.': 'यहाँ अभी कोई आवश्यकता नहीं।',
};

// added to the app's one dictionary; a word the app already translates keeps its own translation
function merge(lang, words) {
  if (!translations || !translations[lang]) return;
  Object.keys(words).forEach((k) => { if (!(k in translations[lang])) translations[lang][k] = words[k]; });
}
merge('te', ATS_TE);
merge('hi', ATS_HI);
export const ATS_WORDS = Object.keys(ATS_TE).length;
