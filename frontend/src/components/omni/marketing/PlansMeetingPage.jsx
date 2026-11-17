import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../api';
import { LANGS, SLIDES, STANDARD, FAQ, CHIPS } from './meetingContent.js';
import { matchFaq, sentencesOf, dropFirstTen, dropFirstTenLines, fillProof, answerFor } from './meetingLogic.js';
import { budgetOf, budgetReply } from './meetingBudget.js';
import { planAnswer, plansIn } from './meetingPlans.js';
import './plansMeeting.css';
import { BRAND } from '../../../brand.js';
import logoDark340 from '../../../assets/teamlink-logo-ondark-340.png';
import logoDark680 from '../../../assets/teamlink-logo-ondark-680.png';
// THE LOGO ON THE NAVY PAGE: the same TeamLink artwork with its navy parts turned white (Team, Consultants, the ring) and the azure parts (Link) kept, the way every brand reverses its logo for a dark background.
// It sits straight on the page, no box around it (a white box looked like a patch: founder 2026-11-17). A separate company's copy shows its own name as text (brand.js).
const Logo = ({ w = 156 }) => (BRAND.separate
  ? <span className="pm-textlogo">{BRAND.name}</span>
  : <img className="pm-logo-img" src={logoDark340} srcSet={`${logoDark340} 340w, ${logoDark680} 680w`} sizes={`${w}px`} alt="TeamLink Consultants" width={w} height={Math.round((w * 142) / 680)} draggable="false" />);

// THE PLANS MEETING (/plans-meeting/:token, or /plans-meeting with no token): no login, outside the TeamLink shell. A client who got the link on WhatsApp opens it on their phone: an automated
// assistant shows 12 short slides and SPEAKS them (the browser's own voice, free) in English, Telugu or Hindi, with captions always on screen. The client can ask a question at any time (typed,
// spoken or from a chip): it is answered from a fixed list of answers (no live AI, so it never invents a price), and a question with no answer is saved for the team. At the end they pick the
// trial / a plan / "talk to the team" and say when to call: the team is told. The assistant says it is automated at the start. The words live in meetingContent.js; matching in meetingLogic.js.
// Server: GET / POST /api/public/mk-meeting (marketing/meeting.js).
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const LANG_NAME = { en: 'English', te: 'Telugu', hi: 'Hindi' };
const LANG_CODE = Object.fromEntries(LANGS.map(([k, , code]) => [k, code]));
const ASK_STOPS = [6, 7, 9]; // after these slides the assistant stops and asks "Do you have a question?"
const FONT = '"Segoe UI", "Nirmala UI", "Noto Sans Telugu", "Noto Sans Devanagari", Roboto, system-ui, Helvetica, Arial, sans-serif';

// the words on the page itself (buttons, labels). The slides and answers are in meetingContent.js.
const T = {
  en: {
    hello: (n) => (n ? `Hello ${n}` : 'Hello'), chooseLang: 'Choose your language', start: 'Start the meeting', soundOn: 'Please turn your sound on. This is an automated assistant, not a person. It takes about 5 minutes.',
    next: 'Next', back: 'Back', pause: 'Pause', play: 'Play', mute: 'Sound off', unmute: 'Sound on', ask: 'Ask a question', team: 'Talk to our team', send: 'Ask', typeHere: 'Type your question', mic: 'Speak', listening: 'Listening…',
    chips: 'Common questions', cont: 'Continue the meeting', slide: (a, b) => `Slide ${a} of ${b}`, noVoice: (l) => `This phone has no ${l} voice, so please read the words on the screen. Every button still works.`,
    formTitle: 'How can our team reach you?', optTrial: 'Start the ₹999 trial', optStarter: 'Starter · ₹3,999 a month', optGrowth: 'Growth · ₹9,999 a month', optPremium: 'Premium · ₹19,999 a month', optTeam: 'I want to talk to your team first',
    yourName: 'Your name', yourPhone: 'Your WhatsApp number', otherPhone: 'Use another number (optional)', usePhone: (m) => `We will use ${m}.`, callWhen: 'When should we call?', asap: 'As soon as possible', morning: 'Morning (9 to 12)', afternoon: 'Afternoon (12 to 4)', evening: 'Evening (4 to 7)',
    submit: 'Send to our team', cancel: 'Back to the meeting', needPhone: 'Please type your WhatsApp number.', pickOne: 'Please pick one option.', fail: 'It could not be sent. Please try again.',
    thanks: (n) => `Thank you${n ? `, ${n}` : ''}. Our team has your request and will contact you soon.`, seeWork: 'See our finished work', plansTitle: 'Our plans (+ 18% GST)', again: 'Try again', loading: 'Opening your meeting…',
    gone: 'This link does not work any more. Please ask the sender for a new one.', busy: 'The page could not be opened just now. It will try again by itself.', yourQ: 'You', bot: 'Assistant', idle: 'Still there? Press Next to continue.', listenHelp: 'Say your question',
    choosePlan: 'Choose a plan', howMonth: 'How a month works', thPlan: 'Plan', thMonth: 'Per month', thGst: 'With GST', perMonth: 'a month', plusGst: '+ GST', withGst: (x) => `${x} with GST`, voiceOn: 'Voice on', loadingVoice: 'Loading the voice…', micListening: 'Listening… speak your question now', micRecording: 'Recording… tap the microphone again when you finish', micThinking: 'Understanding what you said…', micDenied: 'The microphone is blocked. Tap the lock icon next to the address, allow the microphone for this page, then try again.', micWebview: 'This window cannot ask for the microphone. Please open this link in Chrome (or Safari on an iPhone) and try again. You can also type your question.', micNo: 'No microphone was found on this device.', micNone: 'I did not hear anything. Tap the microphone and speak a little louder, or type your question.', micFail: 'Your voice could not be understood. Please type your question.', micHeard: (x) => `I heard: “${x}”`, micCheck: (x) => `I heard “${x}”. Is that right? Fix it in the box if needed, then press Ask.`, micLang: (n) => `To ask by voice, speak in ${n}. To speak another language, change it at the top first.`, captionsOnly: 'Captions only', fullText: 'Show full text', trustMin: '5 minutes', trustNoLogin: 'No login', auto: 'Automated assistant', waitAsk: 'Do you have a question? Ask now, or press Next.', fin: 'The meeting is finished.', unsure: 'Our team will answer this one. Do you want to talk to them now?',
  },
  te: {
    hello: (n) => (n ? `నమస్కారం ${n} గారు` : 'నమస్కారం'), chooseLang: 'మీ భాషను ఎంచుకోండి', start: 'మీటింగ్ మొదలుపెట్టండి', soundOn: 'దయచేసి మీ సౌండ్ ఆన్ చేయండి. ఇది ఆటోమేటెడ్ అసిస్టెంట్, మనిషి కాదు. సుమారు 5 నిమిషాలు పడుతుంది.',
    next: 'తరువాత', back: 'వెనక్కి', pause: 'ఆపండి', play: 'ప్లే', mute: 'సౌండ్ ఆఫ్', unmute: 'సౌండ్ ఆన్', ask: 'ప్రశ్న అడగండి', team: 'మా టీమ్‌తో మాట్లాడండి', send: 'అడగండి', typeHere: 'మీ ప్రశ్న రాయండి', mic: 'మాట్లాడండి', listening: 'వింటున్నాను…',
    chips: 'సాధారణ ప్రశ్నలు', cont: 'మీటింగ్ కొనసాగించండి', slide: (a, b) => `స్లైడ్ ${a} / ${b}`, noVoice: () => 'ఈ ఫోన్‌లో తెలుగు వాయిస్ లేదు, కాబట్టి దయచేసి స్క్రీన్ మీద ఉన్న అక్షరాలను చదవండి. అన్ని బటన్లు పనిచేస్తాయి.',
    formTitle: 'మా టీమ్ మిమ్మల్ని ఎలా సంప్రదించాలి?', optTrial: '₹999 ట్రయల్ మొదలుపెట్టండి', optStarter: 'Starter · నెలకు ₹3,999', optGrowth: 'Growth · నెలకు ₹9,999', optPremium: 'Premium · నెలకు ₹19,999', optTeam: 'ముందు మీ టీమ్‌తో మాట్లాడాలి',
    yourName: 'మీ పేరు', yourPhone: 'మీ వాట్సాప్ నంబర్', otherPhone: 'వేరే నంబర్ వాడాలంటే (ఐచ్ఛికం)', usePhone: (m) => `మేము ${m} నంబర్‌ను వాడతాము.`, callWhen: 'ఎప్పుడు కాల్ చేయాలి?', asap: 'వీలైనంత త్వరగా', morning: 'ఉదయం (9 నుండి 12)', afternoon: 'మధ్యాహ్నం (12 నుండి 4)', evening: 'సాయంత్రం (4 నుండి 7)',
    submit: 'మా టీమ్‌కు పంపండి', cancel: 'మీటింగ్‌కు తిరిగి వెళ్ళండి', needPhone: 'దయచేసి మీ వాట్సాప్ నంబర్ రాయండి.', pickOne: 'దయచేసి ఒకటి ఎంచుకోండి.', fail: 'పంపడం కుదరలేదు. దయచేసి మళ్ళీ ప్రయత్నించండి.',
    thanks: (n) => `ధన్యవాదాలు${n ? ` ${n} గారు` : ''}. మీ అభ్యర్థన మా టీమ్‌కు అందింది, త్వరలో సంప్రదిస్తారు.`, seeWork: 'మేము చేసిన పని చూడండి', plansTitle: 'మా ప్లాన్లు (+ 18% జీఎస్టీ)', again: 'మళ్ళీ ప్రయత్నించండి', loading: 'మీ మీటింగ్ తెరుస్తున్నాను…',
    gone: 'ఈ లింక్ ఇప్పుడు పనిచేయడం లేదు. దయచేసి పంపినవారిని కొత్త లింక్ అడగండి.', busy: 'పేజీ ఇప్పుడు తెరుచుకోలేదు. అదే మళ్ళీ ప్రయత్నిస్తుంది.', yourQ: 'మీరు', bot: 'అసిస్టెంట్', idle: 'ఇంకా ఉన్నారా? కొనసాగడానికి తరువాత నొక్కండి.', listenHelp: 'మీ ప్రశ్న చెప్పండి',
    choosePlan: 'ప్లాన్ ఎంచుకోండి', howMonth: 'ఒక నెల ఎలా సాగుతుంది', thPlan: 'ప్లాన్', thMonth: 'నెలకు', thGst: 'జీఎస్టీతో', perMonth: 'నెలకు', plusGst: '+ జీఎస్టీ', withGst: (x) => `జీఎస్టీతో ${x}`, voiceOn: 'వాయిస్ ఆన్', loadingVoice: 'వాయిస్ లోడ్ అవుతోంది…', micListening: 'వింటున్నాను… మీ ప్రశ్న ఇప్పుడే చెప్పండి', micRecording: 'రికార్డ్ అవుతోంది… పూర్తయ్యాక మైక్ మళ్ళీ నొక్కండి', micThinking: 'మీరు చెప్పింది అర్థం చేసుకుంటున్నాను…', micDenied: 'మైక్రోఫోన్ బ్లాక్ అయింది. అడ్రస్ పక్కన ఉన్న తాళం గుర్తు నొక్కి, ఈ పేజీకి మైక్రోఫోన్ అనుమతించి, మళ్ళీ ప్రయత్నించండి.', micWebview: 'ఈ విండో మైక్రోఫోన్ అడగలేకపోతోంది. దయచేసి ఈ లింక్‌ను Chrome (ఐఫోన్‌లో Safari)లో తెరిచి మళ్ళీ ప్రయత్నించండి. లేదా మీ ప్రశ్న రాయవచ్చు.', micNo: 'ఈ పరికరంలో మైక్రోఫోన్ కనిపించలేదు.', micNone: 'నాకు ఏమీ వినిపించలేదు. మైక్ నొక్కి కొంచెం గట్టిగా మాట్లాడండి, లేదా మీ ప్రశ్న రాయండి.', micFail: 'మీ గొంతు అర్థం కాలేదు. దయచేసి మీ ప్రశ్న రాయండి.', micHeard: (x) => `నాకు వినిపించింది: “${x}”`, micCheck: (x) => `నాకు వినిపించింది “${x}”. సరైనదేనా? అవసరమైతే బాక్స్‌లో సరిచేసి అడగండి నొక్కండి.`, micLang: () => 'వాయిస్‌తో అడగడానికి తెలుగులో మాట్లాడండి. వేరే భాషలో మాట్లాడాలంటే ముందు పైన భాషను మార్చండి.', captionsOnly: 'అక్షరాలు మాత్రమే', fullText: 'పూర్తి టెక్స్ట్ చూపండి', trustMin: '5 నిమిషాలు', trustNoLogin: 'లాగిన్ అవసరం లేదు', auto: 'ఆటోమేటెడ్ అసిస్టెంట్', waitAsk: 'ఏదైనా ప్రశ్న ఉందా? ఇప్పుడే అడగండి, లేదా తరువాత నొక్కండి.', fin: 'మీటింగ్ పూర్తయింది.', unsure: 'దీనికి మా టీమ్ సమాధానం ఇస్తుంది. ఇప్పుడే వారితో మాట్లాడతారా?',
  },
  hi: {
    hello: (n) => (n ? `नमस्ते ${n} जी` : 'नमस्ते'), chooseLang: 'अपनी भाषा चुनें', start: 'मीटिंग शुरू करें', soundOn: 'कृपया अपनी आवाज़ चालू करें। यह एक ऑटोमैटिक असिस्टेंट है, इंसान नहीं। इसमें करीब 5 मिनट लगेंगे।',
    next: 'अगला', back: 'पीछे', pause: 'रोकें', play: 'चलाएँ', mute: 'आवाज़ बंद', unmute: 'आवाज़ चालू', ask: 'सवाल पूछें', team: 'हमारी टीम से बात करें', send: 'पूछें', typeHere: 'अपना सवाल लिखें', mic: 'बोलें', listening: 'सुन रहा हूँ…',
    chips: 'आम सवाल', cont: 'मीटिंग जारी रखें', slide: (a, b) => `स्लाइड ${a} / ${b}`, noVoice: () => 'इस फ़ोन में हिंदी आवाज़ नहीं है, इसलिए कृपया स्क्रीन पर लिखा हुआ पढ़ें। सभी बटन काम करेंगे।',
    formTitle: 'हमारी टीम आपसे कैसे संपर्क करे?', optTrial: '₹999 का ट्रायल शुरू करें', optStarter: 'Starter · ₹3,999 प्रति माह', optGrowth: 'Growth · ₹9,999 प्रति माह', optPremium: 'Premium · ₹19,999 प्रति माह', optTeam: 'पहले हमारी टीम से बात करनी है',
    yourName: 'आपका नाम', yourPhone: 'आपका व्हाट्सऐप नंबर', otherPhone: 'दूसरा नंबर देना हो तो (वैकल्पिक)', usePhone: (m) => `हम ${m} नंबर का इस्तेमाल करेंगे।`, callWhen: 'कब कॉल करें?', asap: 'जितनी जल्दी हो सके', morning: 'सुबह (9 से 12)', afternoon: 'दोपहर (12 से 4)', evening: 'शाम (4 से 7)',
    submit: 'हमारी टीम को भेजें', cancel: 'मीटिंग पर वापस जाएँ', needPhone: 'कृपया अपना व्हाट्सऐप नंबर लिखें।', pickOne: 'कृपया एक विकल्प चुनें।', fail: 'भेजा नहीं जा सका। कृपया फिर से कोशिश करें।',
    thanks: (n) => `धन्यवाद${n ? ` ${n} जी` : ''}। आपकी रिक्वेस्ट हमारी टीम को मिल गई है, वे जल्द संपर्क करेंगे।`, seeWork: 'हमारा किया हुआ काम देखें', plansTitle: 'हमारे प्लान (+ 18% जीएसटी)', again: 'फिर से कोशिश करें', loading: 'आपकी मीटिंग खुल रही है…',
    gone: 'यह लिंक अब काम नहीं करता। कृपया भेजने वाले से नया लिंक माँगें।', busy: 'पेज अभी नहीं खुल सका। वह अपने आप फिर कोशिश करेगा।', yourQ: 'आप', bot: 'असिस्टेंट', idle: 'क्या आप अभी भी हैं? आगे बढ़ने के लिए अगला दबाइए।', listenHelp: 'अपना सवाल बोलिए',
    choosePlan: 'प्लान चुनें', howMonth: 'एक महीना कैसे चलता है', thPlan: 'प्लान', thMonth: 'प्रति माह', thGst: 'जीएसटी के साथ', perMonth: 'प्रति माह', plusGst: '+ जीएसटी', withGst: (x) => `जीएसटी के साथ ${x}`, voiceOn: 'आवाज़ चालू', loadingVoice: 'आवाज़ लोड हो रही है…', micListening: 'सुन रहा हूँ… अपना सवाल अभी बोलिए', micRecording: 'रिकॉर्ड हो रहा है… बोलना पूरा होने पर माइक फिर दबाइए', micThinking: 'आपकी बात समझ रहा हूँ…', micDenied: 'माइक्रोफ़ोन बंद है। एड्रेस के पास ताले का निशान दबाकर इस पेज के लिए माइक्रोफ़ोन की अनुमति दीजिए, फिर कोशिश कीजिए।', micWebview: 'यह विंडो माइक्रोफ़ोन की अनुमति नहीं माँग सकती। कृपया इस लिंक को Chrome (iPhone में Safari) में खोलकर फिर कोशिश कीजिए। आप अपना सवाल लिखकर भी पूछ सकते हैं।', micNo: 'इस डिवाइस में माइक्रोफ़ोन नहीं मिला।', micNone: 'मुझे कुछ सुनाई नहीं दिया। माइक दबाकर थोड़ा ज़ोर से बोलिए, या अपना सवाल लिखिए।', micFail: 'आपकी आवाज़ समझ नहीं आई। कृपया अपना सवाल लिखिए।', micHeard: (x) => `मैंने सुना: “${x}”`, micCheck: (x) => `मैंने सुना “${x}”। क्या यह सही है? ज़रूरत हो तो बॉक्स में ठीक करके पूछें दबाइए।`, micLang: () => 'आवाज़ से पूछने के लिए हिन्दी में बोलिए। दूसरी भाषा में बोलना हो तो पहले ऊपर भाषा बदलिए।', captionsOnly: 'सिर्फ़ टेक्स्ट', fullText: 'पूरा टेक्स्ट दिखाएँ', trustMin: '5 मिनट', trustNoLogin: 'लॉगिन ज़रूरी नहीं', auto: 'ऑटोमैटिक असिस्टेंट', waitAsk: 'क्या आपका कोई सवाल है? अभी पूछिए, या अगला दबाइए।', fin: 'मीटिंग पूरी हुई।', unsure: 'इसका जवाब हमारी टीम देगी। क्या आप अभी उनसे बात करना चाहेंगे?',
  },
};

// ---- the voice, one sentence at a time (Chrome cuts long texts). Two sources, both free:
//   the SERVER voice (Piper: the same Telugu / Hindi / English voices as our AI interview and AI calls; routes/mkMeetingPublic.js GET /voice): used for Telugu and Hindi when the server has it, because most
//   phones have no Telugu or Hindi voice, and for English when the phone has none. A sentence that cannot be fetched falls back to the phone's own voice.
//   the PHONE's own text-to-speech (speechSynthesis).
// With no voice at all (or sound off) the sentences are shown on a reading timer, so the meeting still moves. ----
const SILENT = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='; // a tenth of a second of silence (an empty file is refused by some phones): playing it in the Start press lets the phone play the voice later
let audioEl = null; // ONE audio element for the whole meeting: unlocked by the Start press, then reused (phones refuse a new one without a press)
const serverFails = {}; // lang -> how many sentences the server could not give; after 2 the page stops asking for that language
const voiceUrl = (lang, text) => `/api/public/mk-meeting/voice?lang=${lang}&t=${encodeURIComponent(text)}`;
const engine = { run: 0, timer: null, safety: null, cur: null };
function stopSpeech() {
  engine.run += 1; clearTimeout(engine.timer); clearTimeout(engine.safety);
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* no voice */ }
  try { if (audioEl) { audioEl.onended = null; audioEl.onerror = null; audioEl.pause(); } } catch { /* no audio */ }
}
function unlockAudio() {
  try { if (!audioEl) audioEl = new Audio(); audioEl.src = SILENT; const p = audioEl.play(); if (p && p.catch) p.catch(() => {}); } catch { /* the phone will not play the server voice */ } // eslint-disable-line no-undef
}
function pickVoice(voices, lang) {
  const list = (voices || []).filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === lang);
  if (!list.length) return null;
  const score = (v) => (/natural|neural|online/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 2 : 0) + (/-in$/i.test(String(v.lang).replace('_', '-')) ? 1 : 0);
  return list.slice().sort((a, b) => score(b) - score(a))[0];
}
// server: the server has a voice for this language (GET /voice/status). Telugu and Hindi use it first; English only when the phone has no voice.
function say(sentences, { lang, muted = false, server = false, from = 0, onSentence, onDone, onLoading } = {}) {
  stopSpeech();
  const my = engine.run;
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let voice = null;
  try { voice = muted || !synth ? null : pickVoice(synth.getVoices(), lang); } catch { voice = null; }
  let i = from;
  const remote = !muted && server && (lang !== 'en' || !voice);
  const step = () => {
    if (engine.run !== my) return;
    if (i >= sentences.length) { if (onDone) onDone(); return; }
    const n = i; i += 1;
    if (onSentence) onSentence(n);
    const text = sentences[n];
    const readMs = Math.max(1800, text.length * 62);
    // the phone's own voice, or (with none / sound off) a reading timer
    const local = () => {
      if (!voice) { engine.timer = setTimeout(step, readMs); return; }
      let over = false;
      const done = () => { if (over || engine.run !== my) return; over = true; clearTimeout(engine.safety); engine.timer = setTimeout(step, 220); };
      try {
        const u = new SpeechSynthesisUtterance(text); // eslint-disable-line no-undef
        u.voice = voice; u.lang = voice.lang; u.rate = 0.95; u.onend = done; u.onerror = done;
        engine.cur = u; // kept so the browser does not drop it before it ends
        engine.safety = setTimeout(done, readMs * 3 + 4000); // some voices never say "ended"
        synth.speak(u);
      } catch { engine.timer = setTimeout(step, readMs); }
    };
    if (!remote || serverFails[lang] >= 2) { local(); return; }
    // the server voice: fetch this sentence (and warm the next two), then play it on the one audio element
    for (let k = 1; k <= 2; k += 1) if (sentences[n + k]) fetch(voiceUrl(lang, sentences[n + k])).catch(() => {}); // eslint-disable-line no-undef
    const url = voiceUrl(lang, text);
    let over = false;
    if (onLoading) onLoading(true); // the first sentence of a cold server voice takes a few seconds: say so
    const finish = () => { if (over || engine.run !== my) return; over = true; clearTimeout(engine.safety); engine.timer = setTimeout(step, 220); };
    const fail = () => { if (over || engine.run !== my) return; over = true; clearTimeout(engine.safety); if (onLoading) onLoading(false); serverFails[lang] = (serverFails[lang] || 0) + 1; local(); };
    engine.safety = setTimeout(fail, 25000); // the server did not answer: carry on without it
    fetch(url).then((r) => { if (!r.ok) throw new Error('no voice'); return r.blob(); }).then(() => { // eslint-disable-line no-undef
      if (engine.run !== my || over) return;
      clearTimeout(engine.safety);
      if (onLoading) onLoading(false);
      if (!audioEl) audioEl = new Audio(); // eslint-disable-line no-undef
      audioEl.onended = finish; audioEl.onerror = fail; audioEl.src = url;
      engine.safety = setTimeout(finish, readMs * 4 + 10000); // never wait for ever on playback
      const p = audioEl.play(); if (p && p.catch) p.catch(fail);
    }).catch(fail);
  };
  engine.timer = setTimeout(step, 90);
}

// ---- what is said and shown for a slide ------------------------------------------------------------------------------------------------------------------------------
function narrationOf(i, lang, ctx) {
  const s = SLIDES[i];
  let text = s.voice[lang] || s.voice.en;
  if (i === 7 && !(ctx.spots > 0)) text = dropFirstTen(text); // never say an offer that is gone
  if (i === 8) text = fillProof(text, ctx.proof);
  let list = sentencesOf(text);
  if (i === 11) list = list.filter((x) => !/whatsapp|వాట్సాప్|व्हाट्सऐप|व्हाट्सएप/i.test(x)); // no summary is sent yet: do not promise it
  return list;
}
function linesOf(i, lang, ctx) {
  const s = SLIDES[i];
  let lines = (s.screen && (s.screen[lang] || s.screen.en)) || [];
  if (i === 7 && !(ctx.spots > 0)) lines = dropFirstTenLines(lines);
  if (i === 8) lines = lines.map((l) => fillProof(l, ctx.proof));
  return lines.filter((l) => !/^\[.{3,}\]/.test(l)).map((l) => l.replace(/\bRs\.? ?/g, '₹'));
}
const PLANS = [['Starter', '₹3,999', '8 + 2'], ['Growth', '₹9,999', '16 + 4'], ['Premium', '₹19,999', '30 + 8']];
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;


// ---- the look of each slide (the words are the slide's own lines in meetingContent.js; only the layout is here) ----------------------------------------------------------------
const PLAN_OF = { 3: 'starter', 4: 'growth', 5: 'premium' };
const PLAN_MONEY = { starter: ['₹3,999', '₹4,719'], growth: ['₹9,999', '₹11,799'], premium: ['₹19,999', '₹23,599'] }; // price, price with 18% GST (the approved plan sheet)
const FEAT_ICON = ['🖼️', '📱', '✏️', '⏱️', '📊'];
const colon = (l) => { const t = String(l); const i = t.indexOf(':'); return i < 0 ? [t.trim(), ''] : [t.slice(0, i).trim(), t.slice(i + 1).trim()]; };
const offerBadge = (d) => { const m = /₹\s?[\d,]+/.exec(d) || /\d+%/.exec(d); if (m) return m[0].replace(/\s/g, ''); const q = /(\d+)\D+(\d+)/.exec(d); return q ? `${q[1]}→${q[2]}` : '★'; };
const Bot = () => (
  <svg width="62%" height="62%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="8" width="16" height="11" rx="4" /><path d="M12 8V5" /><circle cx="12" cy="4" r="1" /><circle cx="9" cy="13" r=".7" fill="currentColor" /><circle cx="15" cy="13" r=".7" fill="currentColor" /><path d="M9.5 16.2c1.4 1 3.6 1 5 0" /><path d="M2 12v3M22 12v3" />
  </svg>
);
const Waves = ({ on }) => <div className={`pm-waves${on ? ' on' : ''}`} aria-hidden="true"><i /><i /><i /><i /><i /></div>;
function Cta({ t, openForm, compact }) {
  return (
    <div className={`pm-cta${compact ? ' compact' : ''}`}>
      <button type="button" className="pm-btn go" onClick={() => openForm('trial')}>🚀 {t.optTrial}</button>
      <div className="pm-two">
        <button type="button" className="pm-btn ghost" onClick={() => openForm('')}>{t.choosePlan}</button>
        <button type="button" className="pm-btn ghost" onClick={() => openForm('team')}>📞 {t.team}</button>
      </div>
    </div>
  );
}
function SlideBody({ idx, lines, t, done, openForm, plansInfo }) {
  const [title, ...rest] = lines;
  const tile = (icon, text, n) => <div className="pm-tile" key={n}><span className="pm-ico">{icon}</span><div>{text}</div></div>;
  if (idx === 0) {
    return (<><span className="pm-eyebrow">{lines[2] || t.auto}</span><h1 className="pm-title" style={{ fontSize: 30 }}>{lines[0]}</h1><p className="pm-sub">{lines[1]}</p></>);
  }
  if (PLAN_OF[idx]) {
    const p = PLAN_OF[idx]; const [name] = colon(lines[0]); const [amt, total] = PLAN_MONEY[p];
    const feats = lines.slice(1, -1); const good = lines[lines.length - 1];
    return (
      <div className="pm-plan" data-plan={p}>
        <span className="pm-plan-name">{name}</span>
        <div className="pm-price"><b>{amt}</b><span>{t.perMonth} {t.plusGst}</span></div>
        <div className="pm-with">{t.withGst(total)}</div>
        <ul className="pm-feats">{feats.map((f, n) => <li key={n}><em>{FEAT_ICON[n] || '✓'}</em><span>{f}</span></li>)}</ul>
        <div className="pm-good">{good}</div>
      </div>
    );
  }
  if (idx === 1) return (<><h2 className="pm-title">{title}</h2><div className="pm-tiles">{rest.map((l, n) => tile(['🖼️', '🎨', '✅'][n] || '✓', l, n))}</div></>);
  if (idx === 9) return (<><h2 className="pm-title">{title}</h2><div className="pm-tiles">{rest.map((l, n) => tile(['🛡️', '↩️', '📅', '🤝'][n] || '✓', l, n))}</div></>);
  if (idx === 2) return (<><h2 className="pm-title">{t.howMonth}</h2><div className="pm-steps">{lines.map((l, n) => <div className="pm-step" key={n}><b>{n + 1}</b><span>{String(l).replace(/^\d+\s+/, '')}</span></div>)}</div></>);
  if (idx === 6) {
    return (
      <>
        <h2 className="pm-title">{title}</h2>
        <div className="pm-tiles">{rest.map((l, n) => { const [a, b] = String(l).split('→').map((x) => x.trim()); return <div className="pm-rung" data-k={n} key={n}><span>{a}</span>{b ? <i>{b}</i> : null}</div>; })}</div>
      </>
    );
  }
  if (idx === 7) {
    const offers = rest.filter((l) => String(l).includes(':')); const notes = rest.filter((l) => !String(l).includes(':'));
    return (
      <>
        <h2 className="pm-title">{title}</h2>
        <div className="pm-tiles">{offers.map((l, n) => { const [label, detail] = colon(l); return <div className="pm-tile" key={n}><span className="pm-badge">{offerBadge(detail)}</span><div>{label}<small>{detail}</small></div></div>; })}</div>
        {notes.length ? <div className="pm-foot">{notes.join(' · ')}</div> : null}
      </>
    );
  }
  if (idx === 8) {
    return (
      <>
        <h2 className="pm-title">{title}</h2>
        <div className="pm-two">{rest.map((l, n) => { const m = /\d[\d,]*/.exec(l); return <div className="pm-tile pm-stat" key={n}><b>{m ? m[0] : '★'}</b><span>{l}</span></div>; })}</div>
        <a href="/our-work" target="_blank" rel="noopener noreferrer" className="pm-btn ghost" style={{ marginTop: 12, textDecoration: 'none' }}>{t.seeWork} ↗</a>
      </>
    );
  }
  if (idx === 10) return (<><span className="pm-eyebrow">{t.auto}</span><h2 className="pm-title">{title}</h2>{done ? null : <Cta t={t} openForm={openForm} />}</>);
  if (idx === 11) {
    return (
      <>
        <h2 className="pm-title">{done ? t.fin : t.plansTitle}</h2>
        <div className="pm-tablewrap">
          <table className="pm-table">
            <thead><tr><th>{t.thPlan}</th><th>{t.thMonth}</th><th>{t.thGst}</th></tr></thead>
            <tbody>
              {(plansInfo || []).map((r) => (
                <tr key={r.p} data-plan={r.p}>
                  <td><b>{r.name}</b><small>{r.feat}</small></td>
                  <td className="num">{PLAN_MONEY[r.p][0]}</td>
                  <td className="num strong">{PLAN_MONEY[r.p][1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {done ? null : <Cta t={t} openForm={openForm} compact />}
      </>
    );
  }
  return (<><h2 className="pm-title">{title}</h2><div className="pm-tiles">{rest.map((l, n) => tile('✓', l, n))}</div></>);
}

export default function PlansMeetingPage() {
  const { token: routeToken } = useParams();
  const [token, setToken] = useState(routeToken || '');
  const [d, setD] = useState(null);
  const [gone, setGone] = useState('');
  const [temp, setTemp] = useState(false);
  const [lang, setLang] = useState('en');
  const [stage, setStage] = useState('pick'); // pick | meet
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sent, setSent] = useState(-1);
  const [muted, setMuted] = useState(false);
  const [panel, setPanel] = useState(''); // '' | ask | form
  const [wait, setWait] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [listening, setListening] = useState(false);
  const [unsure, setUnsure] = useState(false);
  const [form, setForm] = useState({ choice: '', name: '', phone: '', window: 'asap' });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [voices, setVoices] = useState([]);
  const [micState, setMicState] = useState(''); // '' | listening | recording | thinking
  const [micMsg, setMicMsg] = useState('');
  const mediaRef = useRef(null);
  const [voiceLoading, setVoiceLoading] = useState(false); // waiting for the server to make the sentence being said
  const [voiceOk, setVoiceOk] = useState(null); // { en, te, hi } true where the SERVER has a voice (GET /voice/status)
  const fromRef = useRef({ key: '', i: 0 });
  const advRef = useRef(null);
  const recRef = useRef(null);
  const panelRef = useRef(null);
  const tries = useRef(0);
  const t = T[lang];

  const boot = useCallback(() => {
    const req = routeToken ? api.get(`/public/mk-meeting/${encodeURIComponent(routeToken)}`) : api.post('/public/mk-meeting', {});
    return req.then((r) => {
      const v = r.data; setD(v); if (v.token) setToken(v.token);
      if (v.session && LANGS.some(([k]) => k === v.session.language)) setLang(v.session.language);
      setForm((f) => ({ ...f, name: (v.session && v.session.firstName) || f.name }));
      setGone(''); setTemp(false);
    }).catch((e) => {
      const s = e && e.response && e.response.status;
      if (!s || s >= 500 || s === 429) { setTemp(true); setGone('busy'); return; }
      setTemp(false); setGone(errOf(e, ''));
    });
  }, [routeToken]);
  useEffect(() => { document.title = 'TeamLink Digital Marketing plans'; const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex'; document.head.appendChild(m); boot(); return () => { stopSpeech(); try { document.head.removeChild(m); } catch { /* gone */ } }; }, [boot]);
  useEffect(() => { // a busy site is not a dead link: try again by itself (up to 6 times)
    if (!temp || tries.current >= 6) return undefined;
    const x = setTimeout(() => { tries.current += 1; boot(); }, 8000);
    return () => clearTimeout(x);
  }, [temp, gone, boot]);
  useEffect(() => { api.get('/public/mk-meeting/voice/status').then((r) => setVoiceOk(r.data)).catch(() => setVoiceOk(null)); }, []);
  useEffect(() => {
    const s = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (!s) return undefined;
    const f = () => { try { setVoices(s.getVoices()); } catch { /* none */ } };
    f();
    if (s.addEventListener) s.addEventListener('voiceschanged', f);
    return () => { if (s.removeEventListener) s.removeEventListener('voiceschanged', f); };
  }, []);

  const ctx = useMemo(() => ({ spots: d ? d.spotsLeft : 0, proof: d ? d.proof : null }), [d]);
  const order = useMemo(() => SLIDES.map((_, i) => i).filter((i) => i !== 8 || !!ctx.proof), [ctx]); // the "real numbers" slide only when there are real numbers
  const idx = order[Math.min(pos, order.length - 1)];
  const last = pos >= order.length - 1;
  const sentences = useMemo(() => narrationOf(idx, lang, ctx), [idx, lang, ctx]);
  const lines = useMemo(() => linesOf(idx, lang, ctx), [idx, lang, ctx]);
  // the closing table: each plan's name and what it holds, in the language chosen (from slides 4 to 6)
  const plansInfo = useMemo(() => [3, 4, 5].map((i) => { const l = linesOf(i, lang, ctx); return { p: PLAN_OF[i], name: colon(l[0])[0], feat: l[1] || '' }; }), [lang, ctx]);
  const hasDeviceVoice = useMemo(() => !!pickVoice(voices, lang), [voices, lang]);
  const srv = !!(voiceOk && voiceOk[lang]) && !(serverFails[lang] >= 2); // the server has a voice for this language
  const hasVoice = hasDeviceVoice || srv;
  const sayOpts = { lang, muted, server: srv };
  const post =useCallback((body) => (token ? api.post(`/public/mk-meeting/${encodeURIComponent(token)}/event`, body).catch(() => null) : Promise.resolve(null)), [token]);

  const go = useCallback((p) => { clearTimeout(advRef.current); setPos(Math.max(0, Math.min(order.length - 1, p))); setWait(false); setSent(-1); setPlaying(true); setPanel(''); }, [order]);

  // the narration of the slide on screen: starts at the current sentence, so Pause then Play carries on where it stopped
  useEffect(() => {
    if (stage !== 'meet' || !playing || panel) return undefined;
    const key = `${idx}|${lang}`;
    if (fromRef.current.key !== key) fromRef.current = { key, i: 0 };
    setWait(false);
    say(sentences, {
      lang, muted, server: srv, from: fromRef.current.i, onLoading: setVoiceLoading,
      onSentence: (n) => { fromRef.current.i = n; setSent(n); },
      onDone: () => {
        fromRef.current.i = sentences.length;
        if (last) { setPlaying(false); setWait(true); return; }
        if (ASK_STOPS.includes(idx)) { setWait(true); say(sentencesOf(STANDARD.L1[lang]), { lang, muted, server: srv }); return; }
        advRef.current = setTimeout(() => go(pos + 1), 900);
      },
    });
    return () => { clearTimeout(advRef.current); stopSpeech(); setVoiceLoading(false); };
  }, [stage, playing, panel, idx, lang, muted, srv, sentences, last, pos, go]);
  // as soon as a language is picked, the server starts making the first sentences, so they are ready when Start is pressed
  useEffect(() => { if (srv && d) narrationOf(0, lang, ctx).slice(0, 3).forEach((x) => fetch(voiceUrl(lang, x)).catch(() => {})); }, [srv, d, lang, ctx]); // eslint-disable-line no-undef
  useEffect(() => { if (stage === 'meet' && token) post({ type: 'slide', slide: idx }); }, [stage, idx, token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // still there? (once, after 45 seconds of waiting for an answer)
    if (stage !== 'meet' || !wait || panel || last) return undefined;
    const x = setTimeout(() => say(sentencesOf(STANDARD.L4[lang]), { lang, muted, server: srv }), 45000);
    return () => clearTimeout(x);
  }, [stage, wait, panel, last, lang, muted, srv]);

  useEffect(() => { // a panel opens below the slide: bring it into view (on a phone it would be off screen)
    if (panel && panelRef.current && panelRef.current.scrollIntoView) { try { panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* old browser */ } }
  }, [panel]);

  const begin = () => {
    unlockAudio(); // the Start press lets the phone play the server voice afterwards
    try { if (window.speechSynthesis) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } } catch { /* the phone will not speak */ } // eslint-disable-line no-undef
    post({ type: 'start', language: lang });
    fromRef.current = { key: '', i: 0 };
    setStage('meet'); setPos(0); setPlaying(true); setWait(false); setDone('');
  };
  const pickLang = (l) => { setLang(l); if (stage === 'meet') { post({ type: 'start', language: l }); fromRef.current = { key: '', i: 0 }; setSent(-1); setPlaying(true); } };
  const openAsk = () => { stopSpeech(); setPanel('ask'); };
  const openForm = (choice) => { stopSpeech(); setForm((f) => ({ ...f, choice })); setFormErr(''); setPanel('form'); };
  const closePanel = () => { setPanel(''); setUnsure(false); setPlaying(true); };

  const submitQ = (text, faqId) => {
    const s = String(text || '').trim();
    if (!s) return;
    // a budget ("my budget is 6000", "upto 30L") gets the plan that fits it; a question that names a plan ("Starter with GST final cost", "Starter vs Growth") gets that plan's own numbers;
    // everything else goes to the fixed answers. (Never the same "which plan" answer again.)
    const amount = faqId ? null : budgetOf(s);
    const bud = amount != null ? budgetReply(amount, lang) : null;
    const usual = faqId ? { id: faqId } : matchFaq(s, FAQ);
    const pa = !faqId && !bud ? planAnswer(s, lang, usual ? usual.id : null) : null;
    const m = bud ? { id: 'F3' } : (pa ? { id: pa.faq } : usual);
    const f = m ? FAQ.find((x) => x.id === m.id) : null;
    const reply = bud ? bud.text : (pa ? pa.text : (f ? answerFor(f, lang, ctx.spots) : STANDARD.L3[lang]));
    setMsgs((x) => [...x.slice(-5), { who: 'me', text: s }, { who: 'bot', text: reply, note: bud ? bud.shown : (pa ? pa.shown : '') }]);
    setQ(''); setUnsure(!f);
    post({ type: 'ask', q: s, faq: f ? f.id : '' });
    say(sentencesOf(reply), sayOpts);
    if (f && f.id === 'F19') openForm('team');
  };
  // ASKING BY VOICE. First the phone's own speech recognition (fast), with the words showing as they are heard and a plain message for every way it can fail. Where it is missing (iPhone, Firefox, an
  // in-app browser) or cannot work (no internet to the recogniser, no Telugu / Hindi model), the question is recorded and sent to our own listener (POST /hear: the free speech engines of the AI calls).
  const stopMic = () => { try { if (recRef.current) recRef.current.abort(); } catch { /* already stopped */ } recRef.current = null; try { if (mediaRef.current && mediaRef.current.state === 'recording') mediaRef.current.stop(); } catch { /* already stopped */ } };
  const micFail = (text) => { setMicMsg(text); setMicState(''); setListening(false); };
  // the browser said "not allowed": either the person (or the browser settings) blocked the microphone for this page, or this window (the browser inside an app) cannot ask at all. The permission state tells which.
  const micBlocked = () => {
    setMicState(''); setListening(false);
    try {
      navigator.permissions.query({ name: 'microphone' }).then((s) => setMicMsg(s && s.state === 'denied' ? t.micDenied : t.micWebview), () => setMicMsg(t.micDenied));
    } catch { setMicMsg(t.micDenied); }
  };
  // how much a sentence means to this page (an answer it knows, a budget, a plan named): 0 = nothing
  const meaning = (x) => { const m = matchFaq(x, FAQ); return (m ? m.score : 0) + (budgetOf(x) != null ? 2 : 0) + (plansIn(x).length ? 1 : 0); };
  // a sentence the page cannot make sense of AND the recogniser itself doubts (a word of the wrong language, a noise) is put in the box to correct, not answered
  const heardIt = (text, conf) => {
    const x = String(text || '').trim(); setMicState(''); setListening(false);
    if (!x) { setMicMsg(t.micNone); return; }
    if (meaning(x) === 0 && conf != null && conf < 0.75) { setQ(x); setMicMsg(t.micCheck(x)); return; }
    setMicMsg(t.micHeard(x)); setQ(''); submitQ(x);
  };
  const record = async () => {
    if (!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { micFail(t.micFail); return; }
    let stream = null;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { if (e && /NotFound|Devices/i.test(e.name)) micFail(t.micNo); else micBlocked(); return; }
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) || '';
      const rec = new window.MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = []; let stopTimer = null;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        clearTimeout(stopTimer); stream.getTracks().forEach((x) => x.stop());
        setMicState('thinking'); setListening(false);
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
          const r = await api.post(`/public/mk-meeting/hear?lang=${lang}`, blob, { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 60000 });
          heardIt(r.data && r.data.text);
        } catch (e) { micFail(errOf(e, t.micFail)); }
      };
      mediaRef.current = rec; rec.start(); setMicState('recording'); setListening(true); setMicMsg('');
      stopTimer = setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, 12000); // never record for ever
    } catch { stream.getTracks().forEach((x) => x.stop()); micFail(t.micFail); }
  };
  const listen = () => {
    if (micState === 'recording' || listening) { stopMic(); return; } // a second tap ends it
    if (micState === 'thinking') return;
    stopSpeech(); setMicMsg('');
    if (!SR) { record(); return; }
    try {
      const r = new SR();
      r.lang = LANG_CODE[lang]; r.interimResults = true; r.continuous = false; r.maxAlternatives = 3; // three guesses: the one that means something wins ("plants" or "plans")
      let said = ''; let conf = null; let failed = false;
      r.onresult = (e) => {
        let fin = ''; let part = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          if (!e.results[i].isFinal) { part += e.results[i][0].transcript; continue; } // eslint-disable-line no-continue
          let best = e.results[i][0];
          for (let j = 1; j < e.results[i].length; j += 1) if (meaning(e.results[i][j].transcript) > meaning(best.transcript)) best = e.results[i][j];
          fin += best.transcript; conf = best.confidence;
        }
        if (fin) said += fin;
        setQ(said || part); // the words show as they are heard
      };
      r.onerror = (e) => {
        failed = true;
        const code = e && e.error;
        if (code === 'not-allowed') micBlocked();
        else if (code === 'audio-capture') micFail(t.micNo);
        else if (code === 'no-speech') micFail(t.micNone);
        else if (code === 'aborted') micFail('');
        else { setListening(false); setMicState(''); record(); } // network / service-not-allowed / language-not-supported: record it and use our own listener
      };
      r.onend = () => { recRef.current = null; if (failed) return; if (said.trim()) heardIt(said, conf); else micFail(t.micNone); };
      recRef.current = r; setListening(true); setMicState('listening'); r.start();
    } catch { setListening(false); setMicState(''); record(); }
  };
  const submitForm = async () => {
    const name = form.name.trim(); const phone = form.phone.trim();
    if (!form.choice) { setFormErr(t.pickOne); return; }
    if (!(d && d.session && d.session.hasPhone) && phone.length < 8) { setFormErr(t.needPhone); return; }
    setBusy(true); setFormErr('');
    try {
      await api.post(`/public/mk-meeting/${encodeURIComponent(token)}/event`, { type: form.choice === 'team' ? 'handover' : 'choice', choice: form.choice, name, ...(phone ? { phone } : {}), window: form.window });
      setDone(t.thanks(name.split(/\s+/)[0] || '')); setPanel(''); setUnsure(false); go(order.length - 1);
    } catch (e) { setFormErr(errOf(e, t.fail)); } finally { setBusy(false); }
  };

  // the colours of the TeamLink logo (navy and azure), as the founder asked (2026-11-17): not the Brand voice colours
  const brandName = String((d && d.brand && d.brand.name) || 'TeamLink');
  const vars = { '--pm-s': '#0a2463', '--pm-p': '#0a73c4', '--pm-azure': '#0c9cfc' };
  const speaking = stage === 'meet' && playing && !panel;
  const top = (withLang = true) => (
    <header className="pm-top">
      <div className="pm-top-in">
        <div className="pm-brand"><Logo w={158} /><span className="pm-live"><i /><em>{t.auto}</em></span></div>
        {withLang ? <div className="pm-lang" role="group" aria-label={t.chooseLang}>{LANGS.map(([k, name]) => <button key={k} type="button" aria-pressed={lang === k} onClick={() => pickLang(k)}>{name}</button>)}</div> : null}
      </div>
    </header>
  );

  if (gone) {
    return (
      <div className="pm" style={vars}>{top(true)}
        <main className="pm-wrap"><div className="pm-card">
          <p style={{ margin: 0 }}>{temp ? t.busy : (gone && gone !== 'busy' ? gone : t.gone)}</p>
          {temp ? <button type="button" className="pm-btn solid" style={{ marginTop: 12, width: '100%' }} onClick={() => { tries.current = 0; setGone(''); setTemp(false); boot(); }}>{t.again}</button> : null}
        </div></main>
      </div>
    );
  }
  if (!d) return <div className="pm" style={vars}>{top(false)}<main className="pm-wrap"><div className="pm-card">{t.loading}</div></main></div>;

  // ---- 1) choose the language and press Start (a press is needed: phones will not speak before one) ----
  if (stage === 'pick') {
    return (
      <div className="pm" style={vars}>{top(false)}
        <main className="pm-wrap">
          <section className="pm-hero">
            <div className="pm-avatar on"><Bot /></div>
            <h1>{t.hello(d.session.firstName)}</h1>
            <p>{t.soundOn}</p>
            <div className="pm-langs" role="group" aria-label={t.chooseLang}>
              {LANGS.map(([k, name]) => <button key={k} type="button" aria-pressed={lang === k} onClick={() => pickLang(k)}>{name}<small>{LANG_NAME[k]}</small></button>)}
            </div>
            {!hasVoice && (voices.length > 0 || typeof window === 'undefined' || !window.speechSynthesis) ? <div className="pm-note">{t.noVoice(LANG_NAME[lang])}</div> : null}
            <button type="button" className="pm-btn pm-start" onClick={begin}><span className="pm-play-ico">▶</span> {t.start}</button>
            <div className="pm-trust"><span>⏱ {t.trustMin}</span><span>🤖 {t.auto}</span><span>🔒 {t.trustNoLogin}</span></div>
          </section>
        </main>
      </div>
    );
  }

  // ---- 2) the meeting ----
  const shownSentence = sentences[Math.max(0, Math.min(sent, sentences.length - 1))] || '';
  return (
    <div className="pm" style={vars}>{top(true)}
      <main className="pm-wrap pm-meet">
        <div className="pm-grid">
        <section className="pm-stage" aria-live="polite">
          <div className="pm-stage-top"><span className="pm-count"><b>{String(pos + 1).padStart(2, '0')}</b> / {String(order.length).padStart(2, '0')}</span><span>{brandName.toUpperCase()}</span></div>
          <div className="pm-seg" aria-hidden="true">{order.map((x, n) => <i key={x} className={n <= pos ? 'on' : ''} />)}</div>
          <div className="pm-body" key={`${idx}-${lang}`}>
            <SlideBody idx={idx} lines={lines} t={t} done={!!done} openForm={openForm} plansInfo={plansInfo} />
            {done ? <div className="pm-thanks">{done}</div> : null}
          </div>
        </section>

        <div className="pm-side">
        <section className="pm-assistant">
          <div><div className={`pm-avatar${speaking ? ' on' : ''}`}><Bot /></div><Waves on={speaking} /></div>
          <div>
            <div className="pm-who">{t.bot}<span>{voiceLoading ? `⏳ ${t.loadingVoice}` : (hasVoice && !muted ? `🔊 ${t.voiceOn}` : `📝 ${t.captionsOnly}`)}</span></div>
            <div className="pm-say" key={`${idx}-${lang}-${Math.max(sent, 0)}`}>{shownSentence}</div>
            {wait && !last && panel === '' ? <div className="pm-ask-now">{t.waitAsk}</div> : null}
          </div>
          <details><summary>{t.fullText}</summary><p>{sentences.map((x, n) => (n === sent && playing ? <mark key={n}>{x} </mark> : <span key={n}>{x} </span>))}</p></details>
        </section>

        {panel === 'ask' ? (
          <section className="pm-panel" ref={panelRef}>
            <h3>{t.ask}</h3>
            <div className="pm-miclang">🎤 {t.micLang(LANG_NAME[lang])}</div>
            <div className="pm-chips" aria-label={t.chips}>
              {CHIPS.map((id) => { const f = FAQ.find((x) => x.id === id); return f ? <button key={id} type="button" className="pm-chip" onClick={() => submitQ(f.ask[lang], id)}>{f.ask[lang]}</button> : null; })}
            </div>
            <form className="pm-row" onSubmit={(e) => { e.preventDefault(); submitQ(q); }}>
              <input className="pm-input" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder={micState === 'listening' || micState === 'recording' ? t.listening : t.typeHere} aria-label={t.typeHere} />
              <button type="button" className={`pm-round pm-mic${micState ? ' on' : ''}`} onClick={listen} aria-label={t.mic} title={t.mic} aria-pressed={!!micState}>🎤</button>
              <button type="submit" className="pm-btn solid" disabled={!q.trim()} style={{ padding: '0 18px' }}>{t.send}</button>
            </form>
            {micState || micMsg ? <div className={`pm-micmsg${micState ? ' live' : ''}`} role="status">{micState === 'listening' ? t.micListening : micState === 'recording' ? t.micRecording : micState === 'thinking' ? t.micThinking : micMsg}</div> : null}
            {msgs.map((m, n) => <div key={n} className={`pm-msg ${m.who}`}><b>{m.who === 'me' ? t.yourQ : t.bot}</b>{m.text}{m.note ? <small>{m.note}</small> : null}</div>)}
            {unsure ? <div style={{ marginTop: 10 }}><div style={{ fontSize: 14.5, marginBottom: 6 }}>{t.unsure}</div><button type="button" className="pm-btn green" style={{ width: '100%' }} onClick={() => openForm('team')}>📞 {t.team}</button></div> : null}
            <button type="button" className="pm-btn soft" style={{ width: '100%', marginTop: 12 }} onClick={closePanel}>{t.cont}</button>
          </section>
        ) : null}

        {panel === 'form' ? (
          <section className="pm-panel" ref={panelRef}>
            <h3>{t.formTitle}</h3>
            {[['trial', t.optTrial], ['starter', t.optStarter], ['growth', t.optGrowth], ['premium', t.optPremium], ['team', t.optTeam]].map(([k, label]) => (
              <label key={k} className={`pm-opt${form.choice === k ? ' on' : ''}`}>
                <input type="radio" name="choice" checked={form.choice === k} onChange={() => setForm({ ...form, choice: k })} />{label}
              </label>
            ))}
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              <input className="pm-input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.yourName} aria-label={t.yourName} />
              {d.session.hasPhone ? <div style={{ fontSize: 14, color: '#4b6358' }}>{t.usePhone(d.session.phoneMasked)}</div> : null}
              <input className="pm-input" value={form.phone} maxLength={30} inputMode="tel" onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={d.session.hasPhone ? t.otherPhone : `${t.yourPhone} (+91…)`} aria-label={t.yourPhone} />
              <label style={{ fontSize: 14, fontWeight: 700 }}>{t.callWhen}
                <select className="pm-input" style={{ marginTop: 4 }} value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })}>{[['asap', t.asap], ['morning', t.morning], ['afternoon', t.afternoon], ['evening', t.evening]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              </label>
            </div>
            {formErr ? <div className="pm-err" role="alert">{formErr}</div> : null}
            <button type="button" className="pm-btn green" disabled={busy} style={{ width: '100%', marginTop: 12 }} onClick={submitForm}>{t.submit}</button>
            <button type="button" className="pm-btn soft" style={{ width: '100%', marginTop: 8 }} onClick={closePanel}>{t.cancel}</button>
          </section>
        ) : null}
        </div>
        </div>
      </main>

      <div className="pm-bar">
        <div className="pm-bar-in">
          <div className="pm-ctl">
            <button type="button" className="pm-round" onClick={() => go(pos - 1)} disabled={pos === 0} aria-label={t.back}>⏮</button>
            <button type="button" className="pm-round pm-play" onClick={() => (panel ? closePanel() : setPlaying(!playing))} aria-label={playing && !panel ? t.pause : t.play}>{playing && !panel ? '⏸' : '▶'}</button>
            <button type="button" className={`pm-next${wait && !last ? ' hint' : ''}`} onClick={() => go(pos + 1)} disabled={last}>{t.next} ›</button>
            <button type="button" className="pm-round" onClick={() => setMuted(!muted)} aria-pressed={muted} aria-label={muted ? t.unmute : t.mute} title={muted ? t.unmute : t.mute}>{muted ? '🔇' : '🔊'}</button>
          </div>
          <div className="pm-two-btn">
            <button type="button" className="pm-pill" onClick={openAsk}>❓ {t.ask}</button>
            <button type="button" className="pm-pill call" onClick={() => openForm('team')}>📞 {t.team}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
