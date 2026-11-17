// THE PLANS MEETING: "my budget is 6000" -> which plan fits. Fixed words and fixed price lines, no AI. Pure functions, so they can be tested alone.
// The plan prices (marketing sheet, 17 Nov 2026): Starter Rs 3,999, Growth Rs 9,999, Premium Rs 19,999 a month + 18% GST, so with GST they cost Rs 4,719 / 11,799 / 23,599. The limits below are those
// numbers EXACTLY (slide 6 shows the same totals: the founder asked on 2026-11-17 for the slide to say Starter is Rs 3,999 + GST, not "from Rs 4,800"). The trial is Rs 999 + GST (Rs 1,179).
const DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9', '౦': '0', '౧': '1', '౨': '2', '౩': '3', '౪': '4', '౫': '5', '౬': '6', '౭': '7', '౮': '8', '౯': '9' };
export const LIMITS = { trial: 1179, starter: 4719, growth: 11799, premium: 23599 }; // a monthly budget with GST, from this up (the plan prices + 18% GST)

const UNIT = '(crores?|cr|lakhs?|lacs?|lac|l|thousand|k|కోట్లు?|లక్షలు?|లక్ష|వేలు|వెయ్యి|करोड़|लाख|हज़ार|हजार)';
const CONTEXT = /(budget|rs\.?|rupee|rupees|inr|₹|per month|a month|monthly|month|బడ్జెట్|రూపాయ|రూ\.?|నెలకు|నెలవారీ|बजट|रुपये|रुपए|रु\.?|महीने|मासिक)/i;
const MULT = (u) => {
  const x = String(u || '').toLowerCase();
  if (!x) return 1;
  if (/^(crores?|cr|కోట్లు?|करोड़)$/.test(x)) return 10000000;
  if (/^(lakhs?|lacs?|lac|l|లక్షలు?|లక్ష|लाख)$/.test(x)) return 100000;
  return 1000; // thousand, k, వేలు, వెయ్యి, हज़ार
};

// the monthly budget in rupees found in what the person typed or said, or null (no number, or a number that is not about money: "what is 999")
export function budgetOf(input) {
  const raw = String(input == null ? '' : input).replace(/[०-९౦-౯]/g, (d) => DIGITS[d] || d).toLowerCase().replace(/(\d),(?=\d{2,3}(?!\d))/g, '$1');
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}?(?![a-z])`, 'g');
  const hasContext = CONTEXT.test(raw);
  let best = null;
  let m = re.exec(raw);
  while (m) {
    const n = Number(m[1]); const unit = m[2];
    if (Number.isFinite(n) && n > 0 && (unit || hasContext)) { const v = Math.round(n * MULT(unit)); if (v >= 100 && (best == null || v > best)) best = v; }
    m = re.exec(raw);
  }
  return best;
}
export const planFor = (amount) => (amount >= LIMITS.premium ? 'premium' : amount >= LIMITS.growth ? 'growth' : amount >= LIMITS.starter ? 'starter' : amount >= LIMITS.trial ? 'trial' : 'low');

export const TAIL = { en: 'Would you like to start, or should our team call you?', te: 'మొదలుపెడతారా, లేదా మా టీమ్ మీకు కాల్ చేయాలా?', hi: 'क्या आप शुरू करना चाहेंगे, या हमारी टीम आपको कॉल करे?' };
export const REPLY = {
  low: { en: 'That is below our smallest option. Please press Talk to our team, and we will see what is possible.', te: 'అది మా చిన్న ఆప్షన్ కంటే తక్కువ. దయచేసి మా టీమ్‌తో మాట్లాడండి నొక్కండి, ఏం చేయగలమో చూస్తాం.', hi: 'यह हमारे सबसे छोटे विकल्प से कम है। कृपया हमारी टीम से बात करें दबाइए, हम देखेंगे क्या हो सकता है।' },
  trial: { en: 'With that budget, the trial is the right start. It costs nine hundred ninety-nine rupees plus GST, for three pictures and one video. After that you can move to Starter.', te: 'ఆ బడ్జెట్‌కు ట్రయల్‌తో మొదలుపెట్టడం సరైనది. తొమ్మిది వందల తొంభై తొమ్మిది రూపాయలు, జీఎస్టీ అదనం. మూడు చిత్రాలు, ఒక వీడియో వస్తాయి. తర్వాత స్టార్టర్‌కు మారవచ్చు.', hi: 'इस बजट में ट्रायल से शुरू करना सही रहेगा। यह नौ सौ निन्यानवे रुपये है, जीएसटी अलग। तीन तस्वीरें और एक वीडियो मिलता है। उसके बाद स्टार्टर पर जा सकते हैं।' },
  starter: { en: 'With that budget, Starter fits. You get eight pictures and two videos every month.', te: 'ఆ బడ్జెట్‌కు స్టార్టర్ సరిపోతుంది. ప్రతి నెలా ఎనిమిది చిత్రాలు, రెండు వీడియోలు వస్తాయి.', hi: 'इस बजट में स्टार्टर ठीक है। हर महीने आठ तस्वीरें और दो वीडियो मिलते हैं।' },
  growth: { en: 'With that budget, Growth fits. You get sixteen pictures and four videos every month, for three platforms.', te: 'ఆ బడ్జెట్‌కు గ్రోత్ సరిపోతుంది. ప్రతి నెలా పదహారు చిత్రాలు, నాలుగు వీడియోలు, మూడు ప్లాట్‌ఫామ్‌లకు వస్తాయి.', hi: 'इस बजट में ग्रोथ ठीक है। हर महीने सोलह तस्वीरें और चार वीडियो, तीन प्लेटफ़ॉर्म के लिए मिलते हैं।' },
  premium: { en: 'With that budget, Premium fits. You get thirty pictures and eight videos every month, for all five platforms.', te: 'ఆ బడ్జెట్‌కు ప్రీమియం సరిపోతుంది. ప్రతి నెలా ముప్పై చిత్రాలు, ఎనిమిది వీడియోలు, ఐదు ప్లాట్‌ఫామ్‌లకూ వస్తాయి.', hi: 'इस बजट में प्रीमियम ठीक है। हर महीने तीस तस्वीरें और आठ वीडियो, सभी पाँच प्लेटफ़ॉर्म के लिए मिलते हैं।' },
};
const SHOWN = { en: (a) => `Budget understood: ₹${a} a month, with GST`, te: (a) => `అర్థమైన బడ్జెట్: నెలకు ₹${a} (జీఎస్టీతో)`, hi: (a) => `समझा गया बजट: ₹${a} प्रति माह (जीएसटी के साथ)` };

// { plan, text (spoken, and shown), shown (only shown: what number was understood) }
export function budgetReply(amount, lang) {
  const plan = planFor(amount);
  const l = ['en', 'te', 'hi'].includes(lang) ? lang : 'en';
  return { plan, text: plan === 'low' ? REPLY.low[l] : `${REPLY[plan][l]} ${TAIL[l]}`, shown: SHOWN[l](Number(amount).toLocaleString('en-IN')) };
}
