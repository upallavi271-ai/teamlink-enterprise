// ---------------------------------------------------------------------------
// KAVYA'S OWN WORDS for the notice calls (founder 2026-11-12: "naku Kavya voice aa kavali adhey slang avali").
//
// The notice calls (interview notice / reminder, shortlist, AI interview pending) used TeamLink's formal sentences. Kavya talks the way her job calls do:
// short, friendly, spoken Telugu / Hindi / English, no "andi" / "sir" on every line, "super", "ok, parvaledu", "bye". The facts (job, date, time, mode, place) come from
// the same data TeamLink uses (scripts.buildData); a note or instructions typed by the recruiter is read as written. Voice = her voice (the same clips engine).
// build(purpose, language, data, extra) -> [{ kind, text }]  (kinds: opening, say, interest, ifyes, ifno), or null when there is nothing to ask.
// ---------------------------------------------------------------------------
const S = require('../scripts');

const T = {
  English: {
    opening: (n) => `Hello ${n}! This is Kavya from TeamLink Consultants.`,
    ivNotice: (j, d, t) => `Your ${j} interview is fixed for ${d} at ${t}.`,
    ivRemind: (j, d, t) => `Just a quick reminder, your ${j} interview is on ${d} at ${t}.`,
    online: (link) => (link ? 'It is an online interview, we have sent you the link.' : 'It is an online interview, we will send you the link soon.'),
    inPerson: (loc) => (loc ? `The interview is at ${loc}.` : 'It is a face to face interview, our team will share the address.'),
    phone: 'It is a phone interview, we will call you.',
    ivAsk: 'Can you make it?',
    ivYes: 'Super, thanks! Please be ready on time. Bye!',
    ivNo: 'Okay, no problem. Our team will contact you. Thanks, bye!',
    shortNews: (j) => `Good news! You are shortlisted for the ${j} job.`,
    shortIv: (d, t) => `Your interview is on ${d} at ${t}.`,
    shortAsk: 'Are you okay with the next step?',
    shortYes: 'Super! Our team will send you the next details soon. Thanks, bye!',
    no: 'Okay, no problem. Thanks, bye!',
    aiNews: (j) => `You applied for the ${j} job on our jobs website, and your AI interview is still pending.`,
    aiDue: (d) => `The last date for it is ${d}.`,
    aiHow: 'Log in to the TeamLink jobs website with your mobile number or email, open My Applications and start the AI interview there.',
    aiAsk: 'Will you be able to complete it?',
    aiYes: 'Super, thanks! Please finish it before the last date. Bye!',
  },
  Telugu: {
    opening: (n) => `హలో ${n}! నేను కావ్యని, టీమ్‌లింక్ కన్సల్టెంట్స్ నుంచి మాట్లాడుతున్నాను.`,
    ivNotice: (j, d, t) => `మీ ${j} ఇంటర్వ్యూ ${d} ${t} కి ఫిక్స్ అయింది.`,
    ivRemind: (j, d, t) => `చిన్న రిమైండర్, మీ ${j} ఇంటర్వ్యూ ${d} ${t} కి ఉంది.`,
    online: (link) => (link ? 'ఇది ఆన్‌లైన్ ఇంటర్వ్యూ, లింక్ మీకు పంపించాం.' : 'ఇది ఆన్‌లైన్ ఇంటర్వ్యూ, లింక్ త్వరలో పంపిస్తాం.'),
    inPerson: (loc) => (loc ? `ఇంటర్వ్యూ ${loc} లో ఉంటుంది.` : 'ఇది డైరెక్ట్ ఇంటర్వ్యూ, అడ్రస్ మా టీమ్ షేర్ చేస్తుంది.'),
    phone: 'ఇది ఫోన్ ఇంటర్వ్యూ, మేమే మీకు కాల్ చేస్తాం.',
    ivAsk: 'మీరు రాగలరా?',
    ivYes: 'సూపర్, థాంక్స్! టైమ్‌కి రెడీగా ఉండండి, బై!',
    ivNo: 'ఓకే, పర్వాలేదు. మా టీమ్ మిమ్మల్ని కాంటాక్ట్ చేస్తుంది. థాంక్స్, బై!',
    shortNews: (j) => `ఒక గుడ్ న్యూస్! ${j} జాబ్ కి మీరు షార్ట్‌లిస్ట్ అయ్యారు.`,
    shortIv: (d, t) => `మీ ఇంటర్వ్యూ ${d} ${t} కి ఉంది.`,
    shortAsk: 'నెక్స్ట్ స్టెప్ కి మీరు ఓకేనా?',
    shortYes: 'సూపర్! మా టీమ్ త్వరలో డీటెయిల్స్ పంపిస్తుంది. థాంక్స్, బై!',
    no: 'ఓకే, పర్వాలేదు. థాంక్స్, బై!',
    aiNews: (j) => `మీరు మా జాబ్స్ వెబ్‌సైట్ లో ${j} జాబ్ కి అప్లై చేశారు కదా, మీ AI ఇంటర్వ్యూ ఇంకా పెండింగ్ లో ఉంది.`,
    aiDue: (d) => `దానికి లాస్ట్ డేట్ ${d}.`,
    aiHow: 'టీమ్‌లింక్ జాబ్స్ వెబ్‌సైట్ లో మీ మొబైల్ నంబర్ లేదా ఈమెయిల్ తో లాగిన్ అయి, My Applications లో AI ఇంటర్వ్యూ స్టార్ట్ చేయండి.',
    aiAsk: 'మీరు పూర్తి చేయగలరా?',
    aiYes: 'సూపర్, థాంక్స్! లాస్ట్ డేట్ లోపు పూర్తి చేయండి, బై!',
  },
  Hindi: {
    opening: (n) => `हैलो ${n} जी! मैं काव्या, टीमलिंक कंसल्टेंट्स से बोल रही हूँ।`,
    ivNotice: (j, d, t) => `आपका ${j} इंटरव्यू ${d} को ${t} पर फिक्स हुआ है।`,
    ivRemind: (j, d, t) => `छोटा सा रिमाइंडर, आपका ${j} इंटरव्यू ${d} को ${t} पर है।`,
    online: (link) => (link ? 'यह ऑनलाइन इंटरव्यू है, लिंक हमने आपको भेज दिया है।' : 'यह ऑनलाइन इंटरव्यू है, लिंक हम जल्दी भेजेंगे।'),
    inPerson: (loc) => (loc ? `इंटरव्यू ${loc} में होगा।` : 'यह आमने-सामने का इंटरव्यू है, पता हमारी टीम शेयर करेगी।'),
    phone: 'यह फ़ोन इंटरव्यू है, हम आपको कॉल करेंगे।',
    ivAsk: 'क्या आप आ पाएँगे?',
    ivYes: 'सुपर, थैंक्स! टाइम पर तैयार रहिए, बाय!',
    ivNo: 'ठीक है, कोई बात नहीं। हमारी टीम आपसे बात करेगी। थैंक्स, बाय!',
    shortNews: (j) => `एक गुड न्यूज़! ${j} जॉब के लिए आप शॉर्टलिस्ट हुए हैं।`,
    shortIv: (d, t) => `आपका इंटरव्यू ${d} को ${t} पर है।`,
    shortAsk: 'क्या आप अगले स्टेप के लिए ठीक हैं?',
    shortYes: 'सुपर! हमारी टीम जल्दी ही डिटेल्स भेजेगी। थैंक्स, बाय!',
    no: 'ठीक है, कोई बात नहीं। थैंक्स, बाय!',
    aiNews: (j) => `आपने हमारी जॉब्स वेबसाइट पर ${j} जॉब के लिए अप्लाई किया था, और आपका AI इंटरव्यू अभी बाकी है।`,
    aiDue: (d) => `उसकी आख़िरी तारीख ${d} है।`,
    aiHow: 'टीमलिंक जॉब्स वेबसाइट पर अपने मोबाइल नंबर या ईमेल से लॉगिन करके My Applications में AI इंटरव्यू शुरू कीजिए।',
    aiAsk: 'क्या आप उसे पूरा कर पाएँगे?',
    aiYes: 'सुपर, थैंक्स! आख़िरी तारीख से पहले पूरा कर लीजिए, बाय!',
  },
};

// the recruiter's own words (a note, instructions) are read as typed
function build(purpose, language, data, extra) {
  const L = T[language] || T.English;
  const d = data || {};
  const iv = d.interview || null;
  const first = String(d.firstName || d.name || '').trim().split(/\s+/)[0] || '';
  const job = d.jobTitle || '';
  const out = [{ kind: 'opening', text: L.opening(first) }];
  const say = (text) => { if (text) out.push({ kind: 'say', text }); };
  const dw = iv ? S.dateWords(iv.at, language) : '';
  const tw = iv ? S.timeWords(iv.at, language).replace(/\s*(IST|India time|ఇండియా టైమ్|इंडिया टाइम)\s*$/i, '').trim() : ''; // "5:00 PM", not "5:00 PM India time": it is said to someone in India
  const mode = () => {
    if (!iv) return '';
    if (iv.mode === 'online') return L.online(!!iv.hasLink);
    if (iv.mode === 'in_person') return L.inPerson(iv.location);
    if (iv.mode === 'phone') return L.phone;
    return '';
  };
  if (purpose === 'Interview Notification' || purpose === 'Interview Reminder') {
    if (!iv || !job) return null;
    say(purpose === 'Interview Reminder' ? L.ivRemind(job, dw, tw) : L.ivNotice(job, dw, tw));
    say(mode());
    say(extra && extra.instructions);
    say(extra && extra.note);
    out.push({ kind: 'interest', text: L.ivAsk }, { kind: 'ifyes', text: L.ivYes }, { kind: 'ifno', text: L.ivNo });
  } else if (purpose === 'Shortlist Notification') {
    if (!job) return null;
    say(L.shortNews(job));
    if (iv) say(L.shortIv(dw, tw));
    say(extra && extra.note);
    out.push({ kind: 'interest', text: L.shortAsk }, { kind: 'ifyes', text: L.shortYes }, { kind: 'ifno', text: L.no });
  } else if (purpose === 'AI Interview Pending') {
    if (!job) return null;
    say(L.aiNews(job));
    if (d.aiDeadline) say(L.aiDue(S.dateWords(d.aiDeadline, language)));
    say(L.aiHow);
    say(extra && extra.note);
    out.push({ kind: 'interest', text: L.aiAsk }, { kind: 'ifyes', text: L.aiYes }, { kind: 'ifno', text: L.no });
  } else return null;
  return out;
}

const toText = (lines) => lines.map((l) => `${l.kind[0].toUpperCase()}${l.kind.slice(1)}: ${l.text}`).join('\n').replace(/^Ifyes:/gm, 'IfYes:').replace(/^Ifno:/gm, 'IfNo:');

module.exports = { build, toText, T };
