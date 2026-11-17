// THE PLANS MEETING: the small pure functions the meeting page uses (no browser, no network), so they can be tested alone.
//   matchFaq(text, faq)      the typed or spoken question -> the best answer, or null (then the assistant says it is not sure and offers a person)
//   sentencesOf(text)        a narration cut into sentences (the voice speaks one at a time, the page highlights the one being spoken)
//   dropFirstTen(...)        removes the "first ten customers" offer when no founding spots are left (never say an offer that is gone)
//   fillProof(text, proof)   puts the real numbers into [N] and [X]
const ZW = /[‌‍]/g;
export const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFC').replace(ZW, '').replace(/['’‘`]/g, '').replace(/[.,!?;:()[\]{}"“”।|/\\_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// a Latin keyword must match whole words ("ai" must not be found inside "again"); a Telugu or Hindi keyword matches inside a word (those scripts glue endings on).
// Returns 2 for an exact hit, 1 for a near hit (one wrong letter in a word of 5 letters or more: the phone's recogniser heard "plants" for "plans"), 0 for none.
function lev1(a, b) { // are the two words one letter apart (a different letter, one more or one less)?
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let miss = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; } else {
      miss += 1; if (miss > 1) return false;
      if (a.length === b.length) { i += 1; j += 1; } else if (a.length > b.length) i += 1; else j += 1;
    }
  }
  return miss + (a.length - i) + (b.length - j) <= 1;
}
function hits(text, kw) {
  const k = norm(kw);
  if (!k) return 0;
  if (/^[a-z0-9 ]+$/.test(k)) {
    if (new RegExp(`(?:^| )${esc(k)}(?: |$)`).test(text)) return 2;
    if (k.length >= 5 && !k.includes(' ')) return text.split(' ').some((w) => w.length >= 4 && lev1(w, k)) ? 1 : 0;
    return 0;
  }
  return text.includes(k) ? 2 : 0;
}

export function matchFaq(input, faq) {
  const text = norm(input);
  if (text.length < 2) return null;
  let best = null;
  for (const f of faq) { // eslint-disable-line no-restricted-syntax
    let score = 0;
    for (const kw of f.keywords) { const h = hits(text, kw); if (h) score += (h === 2 ? 1 : 0.6) + Math.min(norm(kw).length, 12) / 12; } // eslint-disable-line no-restricted-syntax
    if (score <= 0) continue; // eslint-disable-line no-continue
    // "talk to a person" wins a tie: if someone asks for a person they must reach one
    if (!best || score > best.score || (score === best.score && f.id === 'F19')) best = { id: f.id, score };
  }
  return best;
}

export const sentencesOf = (text) => (String(text || '').match(/[^.!?।]+[.!?।]*\s*/g) || []).map((x) => x.trim()).filter(Boolean);

const FIRST_TEN_SENTENCE = [/first ten customers/i, /మొదటి పది మంది/, /पहले दस ग्राहकों/];
const FIRST_TEN_LINE = [/first 10 customers/i, /మొదటి 10 మంది/, /पहले 10 ग्राहक/];
export const dropFirstTen = (text) => sentencesOf(text).filter((s) => !FIRST_TEN_SENTENCE.some((r) => r.test(s))).join(' ');
export const dropFirstTenLines = (lines) => (lines || []).filter((l) => !FIRST_TEN_LINE.some((r) => r.test(l)));

// proof = { n, hours }
export function fillProof(text, proof) {
  if (!proof) return text;
  return String(text).replace(/\[N\]/g, String(proof.n)).replace(/\[X\]/g, String(proof.hours));
}

// the answer text for a language, with the spots rule applied
export function answerFor(f, lang, spotsLeft) {
  const a = f.answer[lang] || f.answer.en;
  return f.id === 'F16' && !(spotsLeft > 0) ? dropFirstTen(a) : a;
}
