// THE PLANS MEETING: questions about ONE named plan ("starter plan with GST final cost", "what does Premium include", "Starter vs Growth"). Fixed words, fixed numbers, no AI.
// The numbers (founder, 18 Nov 2026): Basic Rs 3,999, Growth Rs 7,999, Premium Rs 14,999 a month + 18% GST (so Rs 4,719 / 9,439 / 17,699 with GST); what each plan includes is on slides 3 to 5.
// The first plan keeps the internal key `starter` (stored in meeting rows) but is called Basic on screen and in speech.
// Amounts are written in WORDS in the spoken text (voices read digits badly in Telugu and Hindi); the digits are shown on screen in `shown`.
import { norm } from './meetingLogic.js';

const NAMES = { starter: ['basic', 'starter', 'బేసిక్', 'స్టార్టర్', 'बेसिक', 'स्टार्टर'], growth: ['growth', 'గ్రోత్', 'ग्रोथ'], premium: ['premium', 'ప్రీమియం', 'प्रीमियम'] };
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
  const t = norm(input).replace(/basic (local )?(seo|aeo|geo|competitor|analysis|check)/g, ' ').replace(/బేసిక్ (లోకల్ )?(ఎస్ఈఓ|ఏఈఓ|పోటీదారుల)/g, ' ').replace(/बेसिक (लोकल )?(एसईओ|एईओ|प्रतिस्पर्धी)/g, ' ');
  return Object.keys(NAMES).map((p) => { const at = Math.min(...NAMES[p].map((w) => { const k = norm(w); const m = /^[a-z0-9 ]+$/.test(k) ? new RegExp(`(?:^| )${esc(k)}(?: |$)`).exec(t) : { index: t.indexOf(k) }; return m && m.index >= 0 ? m.index : 1e9; })); return { p, at }; })
    .filter((x) => x.at < 1e9).sort((a, b) => a.at - b.at).map((x) => x.p);
}

export const PRICE = {
  starter: {
    en: "Basic costs three thousand nine hundred ninety-nine rupees a month. GST at eighteen percent is seven hundred twenty rupees, so the final cost is four thousand seven hundred nineteen rupees a month.",
    te: "బేసిక్ నెలకు మూడు వేల తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు. పద్దెనిమిది శాతం జీఎస్టీ ఏడు వందల ఇరవై రూపాయలు, కాబట్టి మొత్తం నెలకు నాలుగు వేల ఏడు వందల పంతొమ్మిది రూపాయలు.",
    hi: "बेसिक की कीमत हर महीने तीन हज़ार नौ सौ निन्यानवे रुपये है। अठारह प्रतिशत जीएसटी सात सौ बीस रुपये होता है, इसलिए कुल कीमत हर महीने चार हज़ार सात सौ उन्नीस रुपये है।"
  },
  growth: {
    en: "Growth costs seven thousand nine hundred ninety-nine rupees a month. GST at eighteen percent is one thousand four hundred forty rupees, so the final cost is nine thousand four hundred thirty-nine rupees a month.",
    te: "గ్రోత్ నెలకు ఏడు వేల తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు. పద్దెనిమిది శాతం జీఎస్టీ వెయ్యి నాలుగు వందల నలభై రూపాయలు, కాబట్టి మొత్తం నెలకు తొమ్మిది వేల నాలుగు వందల ముప్పై తొమ్మిది రూపాయలు.",
    hi: "ग्रोथ की कीमत हर महीने सात हज़ार नौ सौ निन्यानवे रुपये है। अठारह प्रतिशत जीएसटी एक हज़ार चार सौ चालीस रुपये होता है, इसलिए कुल कीमत हर महीने नौ हज़ार चार सौ उनतालीस रुपये है।"
  },
  premium: {
    en: "Premium costs fourteen thousand nine hundred ninety-nine rupees a month. GST at eighteen percent is two thousand seven hundred rupees, so the final cost is seventeen thousand six hundred ninety-nine rupees a month.",
    te: "ప్రీమియం నెలకు పద్నాలుగు వేల తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు. పద్దెనిమిది శాతం జీఎస్టీ రెండు వేల ఏడు వందల రూపాయలు, కాబట్టి మొత్తం నెలకు పదిహేడు వేల ఆరు వందల తొంభై తొమ్మిది రూపాయలు.",
    hi: "प्रीमियम की कीमत हर महीने चौदह हज़ार नौ सौ निन्यानवे रुपये है। अठारह प्रतिशत जीएसटी दो हज़ार सात सौ रुपये होता है, इसलिए कुल कीमत हर महीने सत्रह हज़ार छह सौ निन्यानवे रुपये है।"
  }
};
const SHOWN = {
  starter: {
    en: "₹3,999 + ₹720 GST (18%) = ₹4,719 a month",
    te: "నెలకు ₹3,999 + ₹720 జీఎస్టీ (18%) = ₹4,719",
    hi: "₹3,999 + ₹720 जीएसटी (18%) = ₹4,719 प्रति माह"
  },
  growth: {
    en: "₹7,999 + ₹1,440 GST (18%) = ₹9,439 a month",
    te: "నెలకు ₹7,999 + ₹1,440 జీఎస్టీ (18%) = ₹9,439",
    hi: "₹7,999 + ₹1,440 जीएसटी (18%) = ₹9,439 प्रति माह"
  },
  premium: {
    en: "₹14,999 + ₹2,700 GST (18%) = ₹17,699 a month",
    te: "నెలకు ₹14,999 + ₹2,700 జీఎస్టీ (18%) = ₹17,699",
    hi: "₹14,999 + ₹2,700 जीएसटी (18%) = ₹17,699 प्रति माह"
  }
};
export const DETAILS = {
  starter: {
    en: "Basic gives you eight posts, two reels and four stories every month, for Instagram and Facebook, with four Google Business Profile posts, captions and hashtags, a monthly content calendar and a monthly report. You approve everything first, with one round of changes. Each item is delivered in three working days.",
    te: "బేసిక్‌లో ప్రతి నెలా ఎనిమిది పోస్ట్‌లు, రెండు రీల్స్, నాలుగు స్టోరీలు వస్తాయి, ఇన్‌స్టాగ్రామ్, ఫేస్‌బుక్ కోసం, నాలుగు గూగుల్ బిజినెస్ ప్రొఫైల్ పోస్ట్‌లు, క్యాప్షన్లు, హ్యాష్‌ట్యాగ్‌లు, నెలవారీ కంటెంట్ క్యాలెండర్, నెలవారీ రిపోర్ట్‌తో. ముందు మీరే ఆమోదిస్తారు, ఒకసారి మార్పులతో. ప్రతి ఐటమ్ మూడు పని దినాల్లో డెలివరీ అవుతుంది.",
    hi: "बेसिक में हर महीने आठ पोस्ट, दो रील और चार स्टोरी मिलती हैं, इंस्टाग्राम और फेसबुक के लिए, साथ में चार गूगल बिज़नेस प्रोफ़ाइल पोस्ट, कैप्शन, हैशटैग, मासिक कंटेंट कैलेंडर और मासिक रिपोर्ट। पहले आप मंज़ूर करते हैं, एक बार बदलाव के साथ। हर आइटम तीन कार्य-दिवस में डिलीवर होता है।"
  },
  growth: {
    en: "Growth gives you twelve posts, four reels and eight stories every month, for Instagram and Facebook. We manage your Google Business Profile with eight posts, draft replies to your reviews, and do basic local SEO and AEO with four patient-question answers a month. You also get a basic competitor check and a monthly report, with two rounds of changes. Each item is delivered in two days.",
    te: "గ్రోత్‌లో ప్రతి నెలా పన్నెండు పోస్ట్‌లు, నాలుగు రీల్స్, ఎనిమిది స్టోరీలు వస్తాయి, ఇన్‌స్టాగ్రామ్, ఫేస్‌బుక్ కోసం. ఎనిమిది పోస్ట్‌లతో మీ గూగుల్ బిజినెస్ ప్రొఫైల్‌ను నిర్వహిస్తాం, మీ రివ్యూలకు సమాధానాల డ్రాఫ్ట్‌లు రాస్తాం, బేసిక్ లోకల్ ఎస్ఈఓ, ఏఈఓ చేస్తాం, నెలకు నాలుగు రోగి-ప్రశ్న సమాధానాలతో. బేసిక్ పోటీదారుల పరిశీలన, నెలవారీ రిపోర్ట్ కూడా ఉంటాయి, రెండుసార్లు మార్పులతో. ప్రతి ఐటమ్ రెండు రోజుల్లో డెలివరీ అవుతుంది.",
    hi: "ग्रोथ में हर महीने बारह पोस्ट, चार रील और आठ स्टोरी मिलती हैं, इंस्टाग्राम और फेसबुक के लिए। हम आठ पोस्ट के साथ आपकी गूगल बिज़नेस प्रोफ़ाइल सँभालते हैं, आपके रिव्यू के जवाब के ड्राफ़्ट लिखते हैं, और बेसिक लोकल एसईओ व एईओ करते हैं, हर महीने चार मरीज़-प्रश्नों के जवाब के साथ। साथ में बेसिक प्रतिस्पर्धी जाँच और मासिक रिपोर्ट भी मिलती है, दो बार बदलाव के साथ। हर आइटम दो दिन में डिलीवर होता है।"
  },
  premium: {
    en: "Premium gives you sixteen posts, eight reels and twelve stories every month, for Instagram, Facebook, LinkedIn and YouTube Shorts, with a content and campaign plan. We manage your Google Business Profile with twelve posts. You get advanced local SEO, four SEO articles a month and updates to your existing website content. We also do GEO and AEO, with eight patient-question answers and a monthly check of how AI assistants describe you. You get competitor analysis, keyword tracking, review replies, detailed monthly analytics, enquiry tracking and priority approval, with three rounds of changes. Each item is delivered in twenty-four hours.",
    te: "ప్రీమియంలో ప్రతి నెలా పదహారు పోస్ట్‌లు, ఎనిమిది రీల్స్, పన్నెండు స్టోరీలు వస్తాయి, ఇన్‌స్టాగ్రామ్, ఫేస్‌బుక్, లింక్డ్‌ఇన్, యూట్యూబ్ షార్ట్స్ కోసం, కంటెంట్, క్యాంపెయిన్ ప్లాన్‌తో. పన్నెండు పోస్ట్‌లతో మీ గూగుల్ బిజినెస్ ప్రొఫైల్‌ను నిర్వహిస్తాం. అడ్వాన్స్‌డ్ లోకల్ ఎస్ఈఓ, నెలకు నాలుగు ఎస్ఈఓ వ్యాసాలు, మీ ప్రస్తుత వెబ్‌సైట్ కంటెంట్ అప్‌డేట్‌లు ఉంటాయి. జీఈఓ, ఏఈఓ కూడా చేస్తాం, ఎనిమిది రోగి-ప్రశ్న సమాధానాలు, ఏఐ అసిస్టెంట్లు మిమ్మల్ని ఎలా వివరిస్తున్నాయో నెలవారీ తనిఖీతో. పోటీదారుల విశ్లేషణ, కీవర్డ్ ట్రాకింగ్, రివ్యూ సమాధానాలు, వివరమైన నెలవారీ అనలిటిక్స్, విచారణల ట్రాకింగ్, ప్రాధాన్య ఆమోదం, మూడుసార్లు మార్పులతో. ప్రతి ఐటమ్ ఇరవై నాలుగు గంటల్లో డెలివరీ అవుతుంది.",
    hi: "प्रीमियम में हर महीने सोलह पोस्ट, आठ रील और बारह स्टोरी मिलती हैं, इंस्टाग्राम, फेसबुक, लिंक्डइन और यूट्यूब शॉर्ट्स के लिए, कंटेंट और कैंपेन योजना के साथ। हम बारह पोस्ट के साथ आपकी गूगल बिज़नेस प्रोफ़ाइल सँभालते हैं। एडवांस्ड लोकल एसईओ, हर महीने चार एसईओ लेख और आपकी मौजूदा वेबसाइट के कंटेंट के अपडेट मिलते हैं। हम जीईओ और एईओ भी करते हैं, आठ मरीज़-प्रश्नों के जवाब और हर महीने इस जाँच के साथ कि एआई असिस्टेंट आपको कैसे बताते हैं। प्रतिस्पर्धी विश्लेषण, कीवर्ड ट्रैकिंग, रिव्यू के जवाब, विस्तृत मासिक एनालिटिक्स, पूछताछ ट्रैकिंग और प्राथमिकता से मंज़ूरी, तीन बार बदलाव के साथ। हर आइटम चौबीस घंटे में डिलीवर होता है।"
  }
};
export const COMPARE = {
  'starter|growth': {
    en: "Growth has more than Basic: twelve posts, four reels and eight stories instead of eight, two and four. It manages your Google Business Profile with eight posts instead of four, drafts replies to your reviews, and adds basic local SEO and AEO and a basic competitor check. It has two rounds of changes instead of one, and delivers in two days instead of three.",
    te: "బేసిక్ కంటే గ్రోత్‌లో ఎక్కువ: ఎనిమిది, రెండు, నాలుగుకు బదులు పన్నెండు పోస్ట్‌లు, నాలుగు రీల్స్, ఎనిమిది స్టోరీలు. నాలుగుకు బదులు ఎనిమిది పోస్ట్‌లతో గూగుల్ బిజినెస్ ప్రొఫైల్ నిర్వహణ, రివ్యూ సమాధానాల డ్రాఫ్ట్‌లు, బేసిక్ లోకల్ ఎస్ఈఓ, ఏఈఓ, బేసిక్ పోటీదారుల పరిశీలన అదనం. ఒకసారికి బదులు రెండుసార్లు మార్పులు, మూడు రోజులకు బదులు రెండు రోజుల్లో డెలివరీ.",
    hi: "बेसिक से ग्रोथ में ज़्यादा है: आठ, दो और चार की जगह बारह पोस्ट, चार रील और आठ स्टोरी। चार की जगह आठ पोस्ट के साथ गूगल बिज़नेस प्रोफ़ाइल का प्रबंधन, रिव्यू के जवाब के ड्राफ़्ट, और बेसिक लोकल एसईओ व एईओ, बेसिक प्रतिस्पर्धी जाँच जुड़ती है। एक की जगह दो बार बदलाव, और तीन दिन की जगह दो दिन में डिलीवरी।"
  },
  'growth|premium': {
    en: "Premium has sixteen posts, eight reels and twelve stories instead of twelve, four and eight. It adds LinkedIn and YouTube Shorts, twelve Google Business Profile posts instead of eight, advanced local SEO, four SEO articles, GEO and AEO with eight patient-question answers, competitor analysis, keyword tracking and detailed analytics. It has three rounds of changes instead of two, and delivers in twenty-four hours instead of two days.",
    te: "ప్రీమియంలో పన్నెండు, నాలుగు, ఎనిమిదికి బదులు పదహారు పోస్ట్‌లు, ఎనిమిది రీల్స్, పన్నెండు స్టోరీలు. లింక్డ్‌ఇన్, యూట్యూబ్ షార్ట్స్, ఎనిమిదికి బదులు పన్నెండు గూగుల్ బిజినెస్ ప్రొఫైల్ పోస్ట్‌లు, అడ్వాన్స్‌డ్ లోకల్ ఎస్ఈఓ, నాలుగు ఎస్ఈఓ వ్యాసాలు, ఎనిమిది రోగి-ప్రశ్న సమాధానాలతో జీఈఓ, ఏఈఓ, పోటీదారుల విశ్లేషణ, కీవర్డ్ ట్రాకింగ్, వివరమైన అనలిటిక్స్ అదనం. రెండుకు బదులు మూడుసార్లు మార్పులు, రెండు రోజులకు బదులు ఇరవై నాలుగు గంటల్లో డెలివరీ.",
    hi: "प्रीमियम में बारह, चार और आठ की जगह सोलह पोस्ट, आठ रील और बारह स्टोरी हैं। लिंक्डइन और यूट्यूब शॉर्ट्स, आठ की जगह बारह गूगल बिज़नेस प्रोफ़ाइल पोस्ट, एडवांस्ड लोकल एसईओ, चार एसईओ लेख, आठ मरीज़-प्रश्नों के जवाब के साथ जीईओ व एईओ, प्रतिस्पर्धी विश्लेषण, कीवर्ड ट्रैकिंग और विस्तृत एनालिटिक्स जुड़ते हैं। दो की जगह तीन बार बदलाव, और दो दिन की जगह चौबीस घंटे में डिलीवरी।"
  },
  'starter|premium': {
    en: "Premium has sixteen posts, eight reels and twelve stories instead of eight, two and four. It adds LinkedIn and YouTube Shorts, Google Business Profile management with twelve posts, advanced local SEO, SEO articles, GEO and AEO, competitor analysis, keyword tracking and detailed analytics. It has three rounds of changes instead of one, and delivers in twenty-four hours instead of three working days.",
    te: "ప్రీమియంలో ఎనిమిది, రెండు, నాలుగుకు బదులు పదహారు పోస్ట్‌లు, ఎనిమిది రీల్స్, పన్నెండు స్టోరీలు. లింక్డ్‌ఇన్, యూట్యూబ్ షార్ట్స్, పన్నెండు పోస్ట్‌లతో గూగుల్ బిజినెస్ ప్రొఫైల్ నిర్వహణ, అడ్వాన్స్‌డ్ లోకల్ ఎస్ఈఓ, ఎస్ఈఓ వ్యాసాలు, జీఈఓ, ఏఈఓ, పోటీదారుల విశ్లేషణ, కీవర్డ్ ట్రాకింగ్, వివరమైన అనలిటిక్స్ అదనం. ఒకసారికి బదులు మూడుసార్లు మార్పులు, మూడు పని దినాలకు బదులు ఇరవై నాలుగు గంటల్లో డెలివరీ.",
    hi: "प्रीमियम में आठ, दो और चार की जगह सोलह पोस्ट, आठ रील और बारह स्टोरी हैं। लिंक्डइन और यूट्यूब शॉर्ट्स, बारह पोस्ट के साथ गूगल बिज़नेस प्रोफ़ाइल प्रबंधन, एडवांस्ड लोकल एसईओ, एसईओ लेख, जीईओ व एईओ, प्रतिस्पर्धी विश्लेषण, कीवर्ड ट्रैकिंग और विस्तृत एनालिटिक्स जुड़ते हैं। एक की जगह तीन बार बदलाव, और तीन कार्य-दिवस की जगह चौबीस घंटे में डिलीवरी।"
  }
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
