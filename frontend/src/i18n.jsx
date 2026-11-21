// ---------------------------------------------------------------------------
// MULTI-LANGUAGE INTERFACE (market benchmark 13.06, 2026-11-21). English stays the default; Telugu and Hindi are offered.
//
//   t('Candidates')            the words in the chosen language, else the English words themselves (nothing ever shows a key)
//   t('Hello {name}', { name })   {placeholders} filled in
//   useLang()                  [lang, setLang] in a component (re-renders on a change)
//   setLang('te')              saved in this browser and, when signed in, on the person's login (PUT /api/ats-plus/i18n/me)
//
// The dictionary is keyed by the ENGLISH words the screens already show (gettext style), so a screen is translated by wrapping its
// labels in t(): the sidebar, the page and tab titles, the common buttons, and the candidate-facing pages (pre-boarding, privacy
// notice). A word with no translation yet stays English. Add words to TE / HI below.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react';

export const LANGS = [['en', 'English'], ['te', 'తెలుగు (Telugu)'], ['hi', 'हिन्दी (Hindi)']];
const KEY = 'tl_lang';

const TE = {
  // sidebar / modules
  Dashboard: 'డాష్‌బోర్డ్', Candidates: 'అభ్యర్థులు', 'Candidates & Pipeline': 'అభ్యర్థులు & పైప్‌లైన్', Clients: 'క్లయింట్లు', 'Clients & Requirements': 'క్లయింట్లు & అవసరాలు',
  Requirements: 'అవసరాలు', 'Interview Calendar': 'ఇంటర్వ్యూ క్యాలెండర్', Interviews: 'ఇంటర్వ్యూలు', Offers: 'ఆఫర్లు', Joining: 'చేరిక', Feedback: 'అభిప్రాయం',
  'Reports & Team': 'రిపోర్టులు & టీమ్', Reports: 'రిపోర్టులు', Team: 'టీమ్', Administration: 'పరిపాలన', Settings: 'సెట్టింగులు', 'ATS settings': 'ATS సెట్టింగులు',
  'Follow-ups': 'ఫాలో-అప్‌లు', 'Job Portal': 'జాబ్ పోర్టల్', Search: 'వెతుకు', Agreements: 'ఒప్పందాలు', 'Business development': 'వ్యాపార అభివృద్ధి',
  'ATS Reports': 'ATS రిపోర్టులు', 'Recruiter insights': 'రిక్రూటర్ విశ్లేషణ', 'My reports': 'నా రిపోర్టులు', Home: 'హోమ్', Profile: 'ప్రొఫైల్',
  // common words / buttons
  Save: 'సేవ్ చేయి', Cancel: 'రద్దు', Close: 'మూసివేయి', Add: 'జోడించు', Edit: 'మార్చు', Delete: 'తొలగించు', Open: 'తెరువు', Upload: 'అప్‌లోడ్', Done: 'పూర్తయింది',
  Yes: 'అవును', No: 'కాదు', Language: 'భాష', 'Sign out': 'సైన్ అవుట్', Loading: 'లోడ్ అవుతోంది', 'Loading…': 'లోడ్ అవుతోంది…', Status: 'స్థితి', Name: 'పేరు', Phone: 'ఫోన్', Email: 'ఈమెయిల్',
  'To do': 'చేయాలి', 'Waiting for review': 'పరిశీలన కోసం వేచి ఉంది', Verified: 'ధృవీకరించబడింది', 'Sent back': 'తిరిగి పంపబడింది', 'Not needed': 'అవసరం లేదు',
  // pre-boarding page
  'Welcome, {name}!': 'స్వాగతం, {name}!', 'Before your first day': 'మీ మొదటి రోజుకు ముందు', 'Your first day': 'మీ మొదటి రోజు', Time: 'సమయం', Where: 'ఎక్కడ', 'Whom to meet': 'ఎవరిని కలవాలి',
  'Your steps': 'మీ దశలు', 'Choose a file': 'ఫైల్ ఎంచుకోండి', 'Send': 'పంపు', 'Mark as done': 'పూర్తయినట్లు గుర్తించు', '{done} of {of} done': '{of}లో {done} పూర్తయ్యాయి',
  'PDF, JPG, PNG or DOCX, up to 10 MB.': 'PDF, JPG, PNG లేదా DOCX, 10 MB వరకు.', 'Thank you. Your recruiter will check it.': 'ధన్యవాదాలు. మీ రిక్రూటర్ పరిశీలిస్తారు.',
  'Aadhaar: only the last 4 digits are kept.': 'ఆధార్: చివరి 4 అంకెలు మాత్రమే ఉంచబడతాయి.', 'Privacy notice': 'గోప్యతా నోటీసు', 'This link does not work. Ask your recruiter for a new one.': 'ఈ లింక్ పనిచేయడం లేదు. కొత్త లింక్ కోసం మీ రిక్రూటర్‌ను అడగండి.',
  'Joining date': 'చేరే తేదీ', Job: 'ఉద్యోగం',
};
const HI = {
  Dashboard: 'डैशबोर्ड', Candidates: 'उम्मीदवार', 'Candidates & Pipeline': 'उम्मीदवार और पाइपलाइन', Clients: 'क्लाइंट', 'Clients & Requirements': 'क्लाइंट और आवश्यकताएँ',
  Requirements: 'आवश्यकताएँ', 'Interview Calendar': 'इंटरव्यू कैलेंडर', Interviews: 'इंटरव्यू', Offers: 'ऑफ़र', Joining: 'जॉइनिंग', Feedback: 'फ़ीडबैक',
  'Reports & Team': 'रिपोर्ट और टीम', Reports: 'रिपोर्ट', Team: 'टीम', Administration: 'प्रशासन', Settings: 'सेटिंग्स', 'ATS settings': 'ATS सेटिंग्स',
  'Follow-ups': 'फ़ॉलो-अप', 'Job Portal': 'जॉब पोर्टल', Search: 'खोजें', Agreements: 'अनुबंध', 'Business development': 'व्यवसाय विकास',
  'ATS Reports': 'ATS रिपोर्ट', 'Recruiter insights': 'रिक्रूटर विश्लेषण', 'My reports': 'मेरी रिपोर्ट', Home: 'होम', Profile: 'प्रोफ़ाइल',
  Save: 'सहेजें', Cancel: 'रद्द करें', Close: 'बंद करें', Add: 'जोड़ें', Edit: 'बदलें', Delete: 'हटाएँ', Open: 'खोलें', Upload: 'अपलोड', Done: 'पूरा',
  Yes: 'हाँ', No: 'नहीं', Language: 'भाषा', 'Sign out': 'साइन आउट', Loading: 'लोड हो रहा है', 'Loading…': 'लोड हो रहा है…', Status: 'स्थिति', Name: 'नाम', Phone: 'फ़ोन', Email: 'ईमेल',
  'To do': 'करना है', 'Waiting for review': 'जाँच की प्रतीक्षा', Verified: 'सत्यापित', 'Sent back': 'वापस भेजा', 'Not needed': 'ज़रूरी नहीं',
  'Welcome, {name}!': 'स्वागत है, {name}!', 'Before your first day': 'आपके पहले दिन से पहले', 'Your first day': 'आपका पहला दिन', Time: 'समय', Where: 'कहाँ', 'Whom to meet': 'किससे मिलना है',
  'Your steps': 'आपके चरण', 'Choose a file': 'फ़ाइल चुनें', Send: 'भेजें', 'Mark as done': 'पूरा हुआ चिह्नित करें', '{done} of {of} done': '{of} में से {done} पूरे',
  'PDF, JPG, PNG or DOCX, up to 10 MB.': 'PDF, JPG, PNG या DOCX, 10 MB तक।', 'Thank you. Your recruiter will check it.': 'धन्यवाद। आपके रिक्रूटर इसे जाँचेंगे।',
  'Aadhaar: only the last 4 digits are kept.': 'आधार: केवल अंतिम 4 अंक रखे जाते हैं।', 'Privacy notice': 'गोपनीयता सूचना', 'This link does not work. Ask your recruiter for a new one.': 'यह लिंक काम नहीं कर रहा। नए लिंक के लिए अपने रिक्रूटर से कहें।',
  'Joining date': 'जॉइनिंग की तारीख', Job: 'नौकरी',
};
const DICT = { te: TE, hi: HI };

let current = (() => { try { const v = localStorage.getItem(KEY); return DICT[v] ? v : 'en'; } catch { return 'en'; } })();
const listeners = new Set();
export function getLang() { return current; }
export function setLang(lang, { save = true } = {}) {
  const next = DICT[lang] ? lang : 'en';
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
  try { document.documentElement.lang = next; } catch { /* no document */ }
  listeners.forEach((fn) => fn(next));
  if (save) {
    // signed in: keep it on the login too (best effort; the public pages have no login)
    import('./api').then(({ default: api }) => { if (localStorage.getItem('tl_token')) api.put('/ats-plus/i18n/me', { lang: next }).catch(() => null); }).catch(() => null);
  }
}
export function t(text, vars) {
  const s = String(text == null ? '' : text);
  const hit = current !== 'en' && DICT[current] ? DICT[current][s] : null;
  const out = hit || s;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : out;
}
export function useLang() {
  const [lang, set] = useState(current);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return [lang, setLang];
}
// read the language saved on the login once after sign-in
export function syncFromServer(api) {
  return api.get('/ats-plus/i18n/me').then((r) => { if (r.data && r.data.lang && r.data.lang !== current) setLang(r.data.lang, { save: false }); }).catch(() => null);
}
export function LanguagePicker({ compact = false }) {
  const [lang, set] = useLang();
  return (
    <select aria-label="Language" value={lang} onChange={(e) => set(e.target.value)} style={compact ? { fontSize: 12, padding: '2px 4px' } : undefined}>
      {LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}
export const translations = DICT; // for the tests and the settings page (how many words each language has)
