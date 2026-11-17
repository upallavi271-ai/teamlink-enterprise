// THE PLANS MEETING: questions about ONE named plan ("starter plan with GST final cost", "what does Premium include", "Starter vs Growth"). Fixed words, fixed numbers, no AI.
// The numbers are the approved plan sheet: Starter Rs 3,999, Growth Rs 9,999, Premium Rs 19,999 a month + 18% GST (so Rs 4,719 / 11,799 / 23,599 with GST); what each plan includes is on slides 3 to 5.
// Amounts are written in WORDS in the spoken text (voices read digits badly in Telugu and Hindi); the digits are shown on screen in `shown`.
import { norm } from './meetingLogic.js';

const NAMES = { starter: ['starter', 'స్టార్టర్', 'स्टार्टर'], growth: ['growth', 'గ్రోత్', 'ग्रोथ'], premium: ['premium', 'ప్రీమియం', 'प्रीमियम'] };
const PRICE_WORDS = ['price', 'prices', 'pricing', 'cost', 'costs', 'gst', 'tax', 'total', 'final', 'amount', 'how much', 'rate', 'rates', 'charges', 'fee', 'fees', 'pay', 'per month', 'monthly', 'rupees', 'rs', 'enta', 'kitna', 'kitne', 'kimmat', 'daam', 'dhara',
  'ధర', 'ఎంత', 'జీఎస్టీ', 'మొత్తం', 'రూపాయ', 'నెలకు', 'ఖర్చు', 'కీమత్', 'कीमत', 'कितना', 'कितने', 'जीएसटी', 'कुल', 'रुपये', 'दाम', 'शुल्क', 'खर्च', 'प्रति माह', 'महीना'];
const STRONG_WORDS = ['include', 'includes', 'included', 'including', 'feature', 'features', 'benefit', 'benefits', 'contain', 'contains', 'how many', 'picture', 'pictures', 'video', 'videos', 'post', 'posts', 'platform', 'platforms', 'revision', 'revisions', 'changes', 'delivery', 'days',
  'kya milta', 'kya milte', 'వస్తాయి', 'ఎన్ని', 'ఏమేం', 'मिलता', 'मिलते', 'शामिल']; // clearly about what the plan holds
const WEAK_WORDS = ['get', 'gets', 'what', 'details', 'detail', 'about', 'explain', 'tell me', 'enni', 'emi', 'ఏమి', 'ఏం', 'వివరాలు', 'क्या', 'विवरण', 'बारे'];
const COMPARE_WORDS = ['compare', 'comparison', 'vs', 'versus', 'difference', 'differences', 'between', 'better', 'తేడా', 'పోల్చ', 'अंतर', 'फर्क', 'फ़र्क', 'तुलना'];
const SUBSUMED = ['F1', 'F2', 'F10', 'F12', 'F13']; // a question the plan answer already covers (price, GST, delivery time, platforms, extras)

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (t, w) => { const k = norm(w); if (!k) return false; return /^[a-z0-9 ]+$/.test(k) ? new RegExp(`(?:^| )${esc(k)}(?: |$)`).test(t) : t.includes(k); };
const anyWord = (t, list) => list.some((w) => hasWord(t, w));
// the plans named in the question, in the order they appear
export function plansIn(input) {
  const t = norm(input);
  return Object.keys(NAMES).map((p) => { const at = Math.min(...NAMES[p].map((w) => { const k = norm(w); const m = /^[a-z0-9 ]+$/.test(k) ? new RegExp(`(?:^| )${esc(k)}(?: |$)`).exec(t) : { index: t.indexOf(k) }; return m && m.index >= 0 ? m.index : 1e9; })); return { p, at }; })
    .filter((x) => x.at < 1e9).sort((a, b) => a.at - b.at).map((x) => x.p);
}

export const PRICE = {
  starter: {
    en: 'Starter costs three thousand nine hundred ninety-nine rupees a month. GST at eighteen percent is seven hundred twenty rupees, so the final cost is four thousand seven hundred nineteen rupees a month.',
    te: 'స్టార్టర్ నెలకు మూడు వేల తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు. పద్దెనిమిది శాతం జీఎస్టీ ఏడు వందల ఇరవై రూపాయలు, కాబట్టి మొత్తం నెలకు నాలుగు వేల ఏడు వందల పంతొమ్మిది రూపాయలు.',
    hi: 'स्टार्टर की कीमत हर महीने तीन हज़ार नौ सौ निन्यानवे रुपये है। अठारह प्रतिशत जीएसटी सात सौ बीस रुपये होता है, इसलिए कुल कीमत हर महीने चार हज़ार सात सौ उन्नीस रुपये है।',
  },
  growth: {
    en: 'Growth costs nine thousand nine hundred ninety-nine rupees a month. GST at eighteen percent is one thousand eight hundred rupees, so the final cost is eleven thousand seven hundred ninety-nine rupees a month.',
    te: 'గ్రోత్ నెలకు తొమ్మిది వేల తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు. పద్దెనిమిది శాతం జీఎస్టీ వెయ్యి ఎనిమిది వందల రూపాయలు, కాబట్టి మొత్తం నెలకు పదకొండు వేల ఏడు వందల తొంభై తొమ్మిది రూపాయలు.',
    hi: 'ग्रोथ की कीमत हर महीने नौ हज़ार नौ सौ निन्यानवे रुपये है। अठारह प्रतिशत जीएसटी एक हज़ार आठ सौ रुपये होता है, इसलिए कुल कीमत हर महीने ग्यारह हज़ार सात सौ निन्यानवे रुपये है।',
  },
  premium: {
    en: 'Premium costs nineteen thousand nine hundred ninety-nine rupees a month. GST at eighteen percent is three thousand six hundred rupees, so the final cost is twenty-three thousand five hundred ninety-nine rupees a month.',
    te: 'ప్రీమియం నెలకు పంతొమ్మిది వేల తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు. పద్దెనిమిది శాతం జీఎస్టీ మూడు వేల ఆరు వందల రూపాయలు, కాబట్టి మొత్తం నెలకు ఇరవై మూడు వేల ఐదు వందల తొంభై తొమ్మిది రూపాయలు.',
    hi: 'प्रीमियम की कीमत हर महीने उन्नीस हज़ार नौ सौ निन्यानवे रुपये है। अठारह प्रतिशत जीएसटी तीन हज़ार छह सौ रुपये होता है, इसलिए कुल कीमत हर महीने तेईस हज़ार पाँच सौ निन्यानवे रुपये है।',
  },
};
const SHOWN = {
  starter: { en: '₹3,999 + ₹720 GST (18%) = ₹4,719 a month', te: 'నెలకు ₹3,999 + ₹720 జీఎస్టీ (18%) = ₹4,719', hi: '₹3,999 + ₹720 जीएसटी (18%) = ₹4,719 प्रति माह' },
  growth: { en: '₹9,999 + ₹1,800 GST (18%) = ₹11,799 a month', te: 'నెలకు ₹9,999 + ₹1,800 జీఎస్టీ (18%) = ₹11,799', hi: '₹9,999 + ₹1,800 जीएसटी (18%) = ₹11,799 प्रति माह' },
  premium: { en: '₹19,999 + ₹3,600 GST (18%) = ₹23,599 a month', te: 'నెలకు ₹19,999 + ₹3,600 జీఎస్టీ (18%) = ₹23,599', hi: '₹19,999 + ₹3,600 जीएसटी (18%) = ₹23,599 प्रति माह' },
};
export const DETAILS = {
  starter: {
    en: 'Starter gives you eight pictures and two videos every month, for Instagram and Facebook, with one round of changes. Each item is delivered in three working days.',
    te: 'స్టార్టర్‌లో ప్రతి నెలా ఎనిమిది చిత్రాలు, రెండు వీడియోలు వస్తాయి, ఇన్‌స్టాగ్రామ్, ఫేస్‌బుక్ కోసం, ఒకసారి మార్పులతో. ప్రతి ఐటమ్ మూడు పని దినాల్లో డెలివరీ అవుతుంది.',
    hi: 'स्टार्टर में हर महीने आठ तस्वीरें और दो वीडियो मिलते हैं, इंस्टाग्राम और फेसबुक के लिए, एक बार बदलाव के साथ। हर आइटम तीन कार्य-दिवस में डिलीवर होता है।',
  },
  growth: {
    en: 'Growth gives you sixteen pictures and four videos every month, for three platforms, with two rounds of changes. Each item is delivered in two days.',
    te: 'గ్రోత్‌లో ప్రతి నెలా పదహారు చిత్రాలు, నాలుగు వీడియోలు వస్తాయి, మూడు ప్లాట్‌ఫామ్‌లకు, రెండుసార్లు మార్పులతో. ప్రతి ఐటమ్ రెండు రోజుల్లో డెలివరీ అవుతుంది.',
    hi: 'ग्रोथ में हर महीने सोलह तस्वीरें और चार वीडियो मिलते हैं, तीन प्लेटफ़ॉर्म के लिए, दो बार बदलाव के साथ। हर आइटम दो दिन में डिलीवर होता है।',
  },
  premium: {
    en: 'Premium gives you thirty pictures and eight videos every month, for all five platforms, with three rounds of changes. Each item is delivered in twenty-four hours. You also get a weekly report and a monthly call with our team.',
    te: 'ప్రీమియంలో ప్రతి నెలా ముప్పై చిత్రాలు, ఎనిమిది వీడియోలు వస్తాయి, ఐదు ప్లాట్‌ఫామ్‌లన్నింటికీ, మూడుసార్లు మార్పులతో. ప్రతి ఐటమ్ ఇరవై నాలుగు గంటల్లో డెలివరీ అవుతుంది. వారపు రిపోర్ట్, మా టీమ్‌తో నెలవారీ కాల్ కూడా ఉంటాయి.',
    hi: 'प्रीमियम में हर महीने तीस तस्वीरें और आठ वीडियो मिलते हैं, सभी पाँच प्लेटफ़ॉर्म के लिए, तीन बार बदलाव के साथ। हर आइटम चौबीस घंटे में डिलीवर होता है। साथ में साप्ताहिक रिपोर्ट और हमारी टीम के साथ मासिक कॉल भी मिलती है।',
  },
};
export const COMPARE = {
  'starter|growth': {
    en: 'Growth has double the content of Starter: sixteen pictures and four videos instead of eight and two. It covers three platforms instead of two, has two rounds of changes instead of one, and delivers in two days instead of three.',
    te: 'గ్రోత్‌లో స్టార్టర్ కంటే రెట్టింపు కంటెంట్: ఎనిమిది, రెండుకు బదులు పదహారు చిత్రాలు, నాలుగు వీడియోలు. రెండు కాకుండా మూడు ప్లాట్‌ఫామ్‌లు, ఒకసారికి బదులు రెండుసార్లు మార్పులు, మూడు రోజులకు బదులు రెండు రోజుల్లో డెలివరీ.',
    hi: 'ग्रोथ में स्टार्टर से दोगुना कंटेंट है: आठ और दो की जगह सोलह तस्वीरें और चार वीडियो। दो की जगह तीन प्लेटफ़ॉर्म, एक की जगह दो बार बदलाव, और तीन दिन की जगह दो दिन में डिलीवरी।',
  },
  'growth|premium': {
    en: 'Premium has thirty pictures and eight videos instead of sixteen and four. It covers all five platforms instead of three, has three rounds of changes instead of two, and delivers in twenty-four hours instead of two days. You also get a weekly report and a monthly call.',
    te: 'ప్రీమియంలో పదహారు, నాలుగుకు బదులు ముప్పై చిత్రాలు, ఎనిమిది వీడియోలు. మూడు కాకుండా ఐదు ప్లాట్‌ఫామ్‌లన్నీ, రెండుకు బదులు మూడుసార్లు మార్పులు, రెండు రోజులకు బదులు ఇరవై నాలుగు గంటల్లో డెలివరీ. వారపు రిపోర్ట్, నెలవారీ కాల్ కూడా ఉంటాయి.',
    hi: 'प्रीमियम में सोलह और चार की जगह तीस तस्वीरें और आठ वीडियो हैं। तीन की जगह सभी पाँच प्लेटफ़ॉर्म, दो की जगह तीन बार बदलाव, और दो दिन की जगह चौबीस घंटे में डिलीवरी। साथ में साप्ताहिक रिपोर्ट और मासिक कॉल भी मिलती है।',
  },
  'starter|premium': {
    en: 'Premium has thirty pictures and eight videos instead of eight and two. It covers all five platforms instead of two, has three rounds of changes instead of one, and delivers in twenty-four hours instead of three working days. You also get a weekly report and a monthly call.',
    te: 'ప్రీమియంలో ఎనిమిది, రెండుకు బదులు ముప్పై చిత్రాలు, ఎనిమిది వీడియోలు. రెండుకు బదులు ఐదు ప్లాట్‌ఫామ్‌లన్నీ, ఒకసారికి బదులు మూడుసార్లు మార్పులు, మూడు పని దినాలకు బదులు ఇరవై నాలుగు గంటల్లో డెలివరీ. వారపు రిపోర్ట్, నెలవారీ కాల్ కూడా ఉంటాయి.',
    hi: 'प्रीमियम में आठ और दो की जगह तीस तस्वीरें और आठ वीडियो हैं। दो की जगह सभी पाँच प्लेटफ़ॉर्म, एक की जगह तीन बार बदलाव, और तीन कार्य-दिवस की जगह चौबीस घंटे में डिलीवरी। साथ में साप्ताहिक रिपोर्ट और मासिक कॉल भी मिलती है।',
  },
};

// the answer to a question that names a plan, or null (then the usual answers apply). faqId = the usual answer the words matched (or null).
// { text (spoken and shown), shown (only shown: the sum in digits), faq (the answer id kept for the team) }
export function planAnswer(input, lang, faqId = null) {
  const plans = plansIn(input);
  if (!plans.length) return null;
  const l = ['en', 'te', 'hi'].includes(lang) ? lang : 'en';
  const t = norm(input);
  const price = anyWord(t, PRICE_WORDS); const strong = anyWord(t, STRONG_WORDS); const detail = strong || anyWord(t, WEAK_WORDS); const compare = anyWord(t, COMPARE_WORDS);
  const priceOf = (list) => ({ text: list.map((p) => PRICE[p][l]).join(' '), shown: list.map((p) => SHOWN[p][l]).join(' · '), faq: 'F1' });
  const detailOf = (p, withPrice) => ({ text: `${DETAILS[p][l]}${withPrice ? ` ${PRICE[p][l]}` : ''}`, shown: withPrice ? SHOWN[p][l] : '', faq: 'F3' });
  if (plans.length >= 2) {
    if (price && !compare) return priceOf(plans.slice(0, 3));
    const key = [plans[0], plans[1]].sort((a, b) => ['starter', 'growth', 'premium'].indexOf(a) - ['starter', 'growth', 'premium'].indexOf(b)).join('|');
    return { text: COMPARE[key][l], shown: '', faq: 'F3' };
  }
  const p = plans[0];
  if (price && strong) return { text: `${DETAILS[p][l]} ${PRICE[p][l]}`, shown: SHOWN[p][l], faq: 'F1' }; // "what does Starter include and cost"
  if (price) return priceOf([p]);
  if (detail) return detailOf(p, false);
  if (faqId && !SUBSUMED.includes(faqId)) return null; // "can I cancel Growth?": the cancel answer, not the plan sheet
  return detailOf(p, true);
}
