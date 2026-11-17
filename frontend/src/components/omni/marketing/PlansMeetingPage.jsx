import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../../api';
import { LANGS, SLIDES, STANDARD, FAQ, CHIPS } from './meetingContent.js';
import { matchFaq, sentencesOf, dropFirstTen, dropFirstTenLines, fillProof, answerFor } from './meetingLogic.js';

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
    choosePlan: 'Choose a plan', auto: 'Automated assistant', waitAsk: 'Do you have a question? Ask now, or press Next.', fin: 'The meeting is finished.', unsure: 'Our team will answer this one. Do you want to talk to them now?',
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
    choosePlan: 'ప్లాన్ ఎంచుకోండి', auto: 'ఆటోమేటెడ్ అసిస్టెంట్', waitAsk: 'ఏదైనా ప్రశ్న ఉందా? ఇప్పుడే అడగండి, లేదా తరువాత నొక్కండి.', fin: 'మీటింగ్ పూర్తయింది.', unsure: 'దీనికి మా టీమ్ సమాధానం ఇస్తుంది. ఇప్పుడే వారితో మాట్లాడతారా?',
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
    choosePlan: 'प्लान चुनें', auto: 'ऑटोमैटिक असिस्टेंट', waitAsk: 'क्या आपका कोई सवाल है? अभी पूछिए, या अगला दबाइए।', fin: 'मीटिंग पूरी हुई।', unsure: 'इसका जवाब हमारी टीम देगी। क्या आप अभी उनसे बात करना चाहेंगे?',
  },
};

// ---- the voice: the browser's own text-to-speech, one sentence at a time (Chrome cuts long texts). With no voice (or sound off) the sentences are shown on a reading timer, so the meeting still moves. ----
const engine = { run: 0, timer: null, safety: null, cur: null };
function stopSpeech() {
  engine.run += 1; clearTimeout(engine.timer); clearTimeout(engine.safety);
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* no voice */ }
}
function pickVoice(voices, lang) {
  const list = (voices || []).filter((v) => String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === lang);
  if (!list.length) return null;
  const score = (v) => (/natural|neural|online/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 2 : 0) + (/-in$/i.test(String(v.lang).replace('_', '-')) ? 1 : 0);
  return list.slice().sort((a, b) => score(b) - score(a))[0];
}
function say(sentences, { lang, muted = false, from = 0, onSentence, onDone } = {}) {
  stopSpeech();
  const my = engine.run;
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let voice = null;
  try { voice = muted || !synth ? null : pickVoice(synth.getVoices(), lang); } catch { voice = null; }
  let i = from;
  const step = () => {
    if (engine.run !== my) return;
    if (i >= sentences.length) { if (onDone) onDone(); return; }
    const n = i; i += 1;
    if (onSentence) onSentence(n);
    const text = sentences[n];
    const readMs = Math.max(1800, text.length * 62);
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
  const fromRef = useRef({ key: '', i: 0 });
  const advRef = useRef(null);
  const recRef = useRef(null);
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
  const hasVoice = useMemo(() => !!pickVoice(voices, lang), [voices, lang]);
  const post = useCallback((body) => (token ? api.post(`/public/mk-meeting/${encodeURIComponent(token)}/event`, body).catch(() => null) : Promise.resolve(null)), [token]);

  const go = useCallback((p) => { clearTimeout(advRef.current); setPos(Math.max(0, Math.min(order.length - 1, p))); setWait(false); setSent(-1); setPlaying(true); setPanel(''); }, [order]);

  // the narration of the slide on screen: starts at the current sentence, so Pause then Play carries on where it stopped
  useEffect(() => {
    if (stage !== 'meet' || !playing || panel) return undefined;
    const key = `${idx}|${lang}`;
    if (fromRef.current.key !== key) fromRef.current = { key, i: 0 };
    setWait(false);
    say(sentences, {
      lang, muted, from: fromRef.current.i,
      onSentence: (n) => { fromRef.current.i = n; setSent(n); },
      onDone: () => {
        fromRef.current.i = sentences.length;
        if (last) { setPlaying(false); setWait(true); return; }
        if (ASK_STOPS.includes(idx)) { setWait(true); say(sentencesOf(STANDARD.L1[lang]), { lang, muted }); return; }
        advRef.current = setTimeout(() => go(pos + 1), 900);
      },
    });
    return () => { clearTimeout(advRef.current); stopSpeech(); };
  }, [stage, playing, panel, idx, lang, muted, sentences, last, pos, go]);
  useEffect(() => { if (stage === 'meet' && token) post({ type: 'slide', slide: idx }); }, [stage, idx, token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // still there? (once, after 45 seconds of waiting for an answer)
    if (stage !== 'meet' || !wait || panel || last) return undefined;
    const x = setTimeout(() => say(sentencesOf(STANDARD.L4[lang]), { lang, muted }), 45000);
    return () => clearTimeout(x);
  }, [stage, wait, panel, last, lang, muted]);

  const begin = () => {
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
    const m = faqId ? { id: faqId } : matchFaq(s, FAQ);
    const f = m ? FAQ.find((x) => x.id === m.id) : null;
    const reply = f ? answerFor(f, lang, ctx.spots) : STANDARD.L3[lang];
    setMsgs((x) => [...x.slice(-5), { who: 'me', text: s }, { who: 'bot', text: reply }]);
    setQ(''); setUnsure(!f);
    post({ type: 'ask', q: s, faq: f ? f.id : '' });
    say(sentencesOf(reply), { lang, muted });
    if (f && f.id === 'F19') openForm('team');
  };
  const listen = () => {
    if (!SR) return;
    if (listening && recRef.current) { try { recRef.current.stop(); } catch { /* already stopped */ } return; }
    stopSpeech();
    try {
      const r = new SR();
      r.lang = LANG_CODE[lang]; r.interimResults = false; r.maxAlternatives = 1;
      r.onresult = (e) => { const x = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript; if (x) submitQ(x); };
      r.onend = () => setListening(false); r.onerror = () => setListening(false);
      recRef.current = r; setListening(true); r.start();
    } catch { setListening(false); }
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

  const P = (d && d.brand && d.brand.colors && d.brand.colors.primary) || '#0f766e';
  const S2 = (d && d.brand && d.brand.colors && d.brand.colors.secondary) || '#134e4a';
  const card = { background: '#fff', borderRadius: 16, padding: '18px 16px', boxShadow: '0 1px 8px rgba(0,0,0,.09)', margin: '0 auto 12px', maxWidth: 640, boxSizing: 'border-box' };
  const page = { minHeight: '100vh', background: '#eef3f1', fontFamily: FONT, color: '#17261f', paddingBottom: 130 };
  const btn = (bg, fg = '#fff', extra = {}) => ({ border: 'none', borderRadius: 12, padding: '12px 16px', fontSize: 15, fontWeight: 800, background: bg, color: fg, cursor: 'pointer', fontFamily: 'inherit', ...extra });
  const input = { width: '100%', boxSizing: 'border-box', border: '1px solid #c9d6d0', borderRadius: 10, padding: '11px 12px', font: 'inherit', fontSize: 16 };
  const head = (
    <div style={{ background: `linear-gradient(135deg, ${P}, ${S2})`, color: '#fff', padding: '16px 16px 46px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ fontSize: 12, letterSpacing: '.12em', fontWeight: 800, opacity: 0.9 }}>{String((d && d.brand && d.brand.name) || 'TeamLink').toUpperCase()} · {t.auto.toUpperCase()}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }} role="group" aria-label={t.chooseLang}>
          {LANGS.map(([k, name]) => <button key={k} type="button" onClick={() => pickLang(k)} aria-pressed={lang === k} style={{ ...btn(lang === k ? '#fff' : 'rgba(255,255,255,.18)', lang === k ? P : '#fff'), padding: '7px 14px', fontSize: 14 }}>{name}</button>)}
        </div>
      </div>
    </div>
  );

  if (gone) {
    return (
      <div style={page}>{head}
        <div style={{ ...card, marginTop: -30 }}>
          <p style={{ margin: 0, lineHeight: 1.6, fontSize: 16 }}>{temp ? t.busy : (gone && gone !== 'busy' ? gone : t.gone)}</p>
          {temp ? <button type="button" style={{ ...btn(P), marginTop: 12, width: '100%' }} onClick={() => { tries.current = 0; setGone(''); setTemp(false); boot(); }}>{t.again}</button> : null}
        </div>
      </div>
    );
  }
  if (!d) return <div style={page}>{head}<div style={{ ...card, marginTop: -30 }}><p style={{ margin: 0, fontSize: 16 }}>{t.loading}</p></div></div>;

  // ---- 1) choose the language and press Start (a press is needed: phones will not speak before one) ----
  if (stage === 'pick') {
    return (
      <div style={page}>{head}
        <div style={{ ...card, marginTop: -30 }}>
          <h1 style={{ fontSize: 24, margin: '0 0 6px', fontFamily: 'inherit' }}>{t.hello(d.session.firstName)}</h1>
          <p style={{ margin: '0 0 14px', lineHeight: 1.6, fontSize: 16 }}>{t.soundOn}</p>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#4b6358', marginBottom: 6 }}>{t.chooseLang}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {LANGS.map(([k, name]) => <button key={k} type="button" onClick={() => pickLang(k)} aria-pressed={lang === k} style={{ ...btn(lang === k ? P : '#e3ebe7', lang === k ? '#fff' : '#17261f'), flex: '1 1 90px', fontSize: 17 }}>{name}</button>)}
          </div>
          {voices.length && !hasVoice ? <div style={{ background: '#fff7e6', border: '1px solid #f1d9a0', borderRadius: 10, padding: '9px 11px', fontSize: 13.5, lineHeight: 1.5, marginBottom: 12 }}>{t.noVoice(LANG_NAME[lang])}</div> : null}
          <button type="button" onClick={begin} style={{ ...btn('#15803d'), width: '100%', fontSize: 18, padding: '15px 16px' }}>▶ {t.start}</button>
        </div>
      </div>
    );
  }

  // ---- 2) the meeting ----
  const bigFirst = idx !== 0 && idx !== 10 && idx !== 11;
  const plain = idx === 0 || idx === 10;
  return (
    <div style={page}>{head}
      <div style={{ ...card, marginTop: -30 }} aria-live="polite">
        <div style={{ display: 'flex', gap: 3, marginBottom: 10 }} aria-hidden="true">{order.map((s, n) => <span key={s} style={{ flex: 1, height: 5, borderRadius: 3, background: n <= pos ? P : '#dbe5e0' }} />)}</div>
        <div style={{ fontSize: 12, color: '#5a7266', fontWeight: 700, marginBottom: 6 }}>{t.slide(pos + 1, order.length)}{hasVoice && !muted ? ' · 🔊' : ' · 📝'}</div>
        {idx === 11 ? (
          <div>
            <h2 style={{ fontSize: 22, margin: '0 0 10px', fontFamily: 'inherit' }}>{done ? t.fin : t.plansTitle}</h2>
            {PLANS.map(([n, price, qty]) => <div key={n} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #e3ebe7', fontSize: 16 }}><b>{n}</b><span>{price} · {qty}</span></div>)}
          </div>
        ) : (
          <div>
            {lines.map((l, n) => (n === 0
              ? <h2 key={n} style={{ fontSize: bigFirst ? 24 : 22, margin: '0 0 8px', fontFamily: 'inherit', lineHeight: 1.3 }}>{l}</h2>
              : <div key={n} style={{ fontSize: 17, lineHeight: 1.5, padding: plain ? '3px 0' : '6px 0', borderTop: plain ? 'none' : '1px solid #edf2ef', display: 'flex', gap: 8 }}>{plain ? null : <span style={{ color: P, fontWeight: 900 }}>✓</span>}<span>{l}</span></div>))}
            {idx === 8 ? <a href="/our-work" target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 10, fontWeight: 800, color: P }}>{t.seeWork} ↗</a> : null}
          </div>
        )}
        {done ? <div style={{ marginTop: 12, background: '#e8f7ef', border: '1px solid #bfe3d0', color: '#087844', borderRadius: 10, padding: '10px 12px', fontSize: 15 }}>{done}</div> : null}
        {(idx === 10 || idx === 11) && !done ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" onClick={() => openForm('trial')} style={{ ...btn('#15803d'), flex: '1 1 100%' }}>{t.optTrial}</button>
            <button type="button" onClick={() => openForm('')} style={{ ...btn(P), flex: '1 1 45%' }}>{t.choosePlan}</button>
            <button type="button" onClick={() => openForm('team')} style={{ ...btn('#e3ebe7', '#17261f'), flex: '1 1 45%' }}>{t.team}</button>
          </div>
        ) : null}
      </div>

      <div style={{ ...card, background: '#fffdf5', border: '1px solid #f1e6bd' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: '#8a7330', marginBottom: 6 }}>{t.bot.toUpperCase()}</div>
        <div style={{ fontSize: 17, lineHeight: 1.65 }}>{sentences.map((s, n) => <span key={n} style={{ background: n === sent && playing ? '#fde68a' : 'transparent', borderRadius: 4, padding: '1px 2px' }}>{s} </span>)}</div>
        {wait && !last && panel === '' ? <div style={{ marginTop: 10, fontWeight: 800, color: '#15803d', fontSize: 15 }}>{t.waitAsk}</div> : null}
      </div>

      {panel === 'ask' ? (
        <div style={card}>
          <div style={{ fontWeight: 800, marginBottom: 8 }}>{t.ask}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }} aria-label={t.chips}>
            {CHIPS.map((id) => { const f = FAQ.find((x) => x.id === id); return f ? <button key={id} type="button" onClick={() => submitQ(f.ask[lang], id)} style={{ ...btn('#e3ebe7', '#17261f'), padding: '8px 12px', fontSize: 14, fontWeight: 700 }}>{f.ask[lang]}</button> : null; })}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); submitQ(q); }} style={{ display: 'flex', gap: 6 }}>
            <input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder={listening ? t.listening : t.typeHere} aria-label={t.typeHere} style={{ ...input, flex: 1 }} />
            {SR ? <button type="button" onClick={listen} aria-label={t.mic} title={t.mic} style={{ ...btn(listening ? '#dc2626' : '#e3ebe7', listening ? '#fff' : '#17261f'), padding: '0 14px' }}>🎤</button> : null}
            <button type="submit" disabled={!q.trim()} style={{ ...btn(P), opacity: q.trim() ? 1 : 0.5 }}>{t.send}</button>
          </form>
          {msgs.length ? (
            <div style={{ marginTop: 12 }}>
              {msgs.map((m, n) => <div key={n} style={{ margin: '6px 0', padding: '9px 11px', borderRadius: 10, background: m.who === 'me' ? '#e3ebe7' : '#fffdf5', border: m.who === 'me' ? 'none' : '1px solid #f1e6bd', fontSize: 15.5, lineHeight: 1.55 }}><b style={{ fontSize: 11, color: '#5a7266' }}>{(m.who === 'me' ? t.yourQ : t.bot).toUpperCase()}</b><div>{m.text}</div></div>)}
            </div>
          ) : null}
          {unsure ? <div style={{ marginTop: 8 }}><div style={{ fontSize: 14, marginBottom: 6 }}>{t.unsure}</div><button type="button" onClick={() => openForm('team')} style={{ ...btn('#15803d'), width: '100%' }}>{t.team}</button></div> : null}
          <button type="button" onClick={closePanel} style={{ ...btn('#e3ebe7', '#17261f'), width: '100%', marginTop: 10 }}>{t.cont}</button>
        </div>
      ) : null}

      {panel === 'form' ? (
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 10 }}>{t.formTitle}</div>
          {[['trial', t.optTrial], ['starter', t.optStarter], ['growth', t.optGrowth], ['premium', t.optPremium], ['team', t.optTeam]].map(([k, label]) => (
            <label key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 10px', marginBottom: 6, border: `2px solid ${form.choice === k ? P : '#dbe5e0'}`, borderRadius: 10, fontSize: 16, cursor: 'pointer', background: form.choice === k ? '#f1f9f6' : '#fff' }}>
              <input type="radio" name="choice" checked={form.choice === k} onChange={() => setForm({ ...form, choice: k })} style={{ width: 18, height: 18 }} />{label}
            </label>
          ))}
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t.yourName} aria-label={t.yourName} style={input} />
            {d.session.hasPhone ? <div style={{ fontSize: 14, color: '#4b6358' }}>{t.usePhone(d.session.phoneMasked)}</div> : null}
            <input value={form.phone} maxLength={30} inputMode="tel" onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={d.session.hasPhone ? t.otherPhone : `${t.yourPhone} (+91…)`} aria-label={t.yourPhone} style={input} />
            <label style={{ fontSize: 14, fontWeight: 700 }}>{t.callWhen}
              <select value={form.window} onChange={(e) => setForm({ ...form, window: e.target.value })} style={{ ...input, marginTop: 4 }}>{[['asap', t.asap], ['morning', t.morning], ['afternoon', t.afternoon], ['evening', t.evening]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
          </div>
          {formErr ? <div style={{ marginTop: 8, color: '#b91c1c', fontSize: 14.5 }} role="alert">{formErr}</div> : null}
          <button type="button" disabled={busy} onClick={submitForm} style={{ ...btn('#15803d'), width: '100%', marginTop: 10, opacity: busy ? 0.6 : 1 }}>{t.submit}</button>
          <button type="button" onClick={closePanel} style={{ ...btn('#e3ebe7', '#17261f'), width: '100%', marginTop: 8 }}>{t.cancel}</button>
        </div>
      ) : null}

      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, background: '#fff', borderTop: '1px solid #d5e0da', padding: '10px 12px calc(10px + env(safe-area-inset-bottom))', zIndex: 5 }}>
        <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => go(pos - 1)} disabled={pos === 0} aria-label={t.back} style={{ ...btn('#e3ebe7', '#17261f'), padding: '11px 13px', opacity: pos === 0 ? 0.4 : 1 }}>⏮</button>
          <button type="button" onClick={() => (panel ? closePanel() : setPlaying(!playing))} style={{ ...btn('#e3ebe7', '#17261f'), padding: '11px 14px' }}>{playing && !panel ? `⏸ ${t.pause}` : `▶ ${t.play}`}</button>
          <button type="button" onClick={() => go(pos + 1)} disabled={last} style={{ ...btn(wait && !last ? '#15803d' : P), padding: '11px 16px', flex: 1, opacity: last ? 0.4 : 1 }}>{t.next} ⏭</button>
          <button type="button" onClick={() => setMuted(!muted)} aria-pressed={muted} aria-label={muted ? t.unmute : t.mute} title={muted ? t.unmute : t.mute} style={{ ...btn('#e3ebe7', '#17261f'), padding: '11px 13px' }}>{muted ? '🔇' : '🔊'}</button>
        </div>
        <div style={{ maxWidth: 640, margin: '8px auto 0', display: 'flex', gap: 6 }}>
          <button type="button" onClick={openAsk} style={{ ...btn('#fff', P, { border: `2px solid ${P}` }), flex: 1, padding: '10px 8px', fontSize: 14 }}>❓ {t.ask}</button>
          <button type="button" onClick={() => openForm('team')} style={{ ...btn('#fff', '#15803d', { border: '2px solid #15803d' }), flex: 1, padding: '10px 8px', fontSize: 14 }}>📞 {t.team}</button>
        </div>
      </div>
    </div>
  );
}
