// What a reply means. Simple keyword rules, English / Telugu / Hindi (also written in English letters).
// -> 'optout' | 'interested' | 'not_interested' | 'question'
const clean = (t) => String(t == null ? '' : t).toLowerCase().replace(/[.!?,;:"'()\[\]{}*_~`|\\/-]+/g, ' ').replace(/\s+/g, ' ').trim();

const OPTOUT = ['stop', 'stop all', 'stopall', 'unsubscribe', 'unsub', 'opt out', 'optout', 'cancel subscription', 'do not message', 'dont message', "don't message", 'do not contact', 'dont contact', 'remove me', 'remove my number', 'stop messages', 'stop messaging', 'band karo', 'message mat karo', 'msg mat karo', 'ఆపండి', 'रोको', 'बंद करो'];
const NOT_INTERESTED = ['no', 'nope', 'not interested', 'no thanks', 'no thank you', 'not now', 'not looking', 'vaddu', 'vadhu', 'vaddhu', 'ledu', 'kadu', 'nahi', 'nahin', 'nai', 'nahi chahiye', 'interest ledu', 'interested ledu', 'not required', 'వద్దు', 'లేదు', 'नहीं', 'नही', 'ना'];
const INTERESTED = ['yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'k', 'interested', 'i am interested', 'im interested', 'apply', 'i want to apply', 'sure', 'haan', 'han', 'ha', 'haa', 'avunu', 'avnu', 'aunu', 'chesthanu', 'chestanu', 'chestanu', 'interest undi', 'interested undi', 'ఆవును', 'అవును', 'చేస్తాను', 'हाँ', 'हां', 'जी हां', 'ज़रूर', 'ready'];

function has(text, list) {
  const t = clean(text);
  if (!t) return false;
  if (list.includes(t)) return true;
  // a short sentence that STARTS with the word, or holds a multi-word phrase
  return list.some((w) => (w.includes(' ') ? ` ${t} `.includes(` ${w} `) : (t.split(' ').length <= 6 && t.split(' ')[0] === w)));
}
function classify(text) {
  const t = clean(text);
  if (!t) return 'question';
  if (has(t, OPTOUT) || /\b(stop|unsubscribe)\b/.test(t)) return 'optout';
  if (has(t, NOT_INTERESTED)) return 'not_interested';
  if (has(t, INTERESTED)) return 'interested';
  return 'question';
}
const WORDS = { optout: 'Opt-out', interested: 'Interested', not_interested: 'Not interested', question: 'Question' };
module.exports = { classify, WORDS, clean };
