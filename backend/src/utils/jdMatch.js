// ---------------------------------------------------------------------------
// JD MATCH (checklist-168 #66): the FULL text of the job description against the FULL text of the resume, by the words and short phrases
// they share. No AI, no network. It is shown as "JD match" next to Fit so that the comparison is not only the structured fields.
//
//   jdMatch(jdText, resumeText) -> { pct, matched: [...], missing: [...], jdWords } | null (the JD or the resume has too little text)
//
// How: the job description is cut into words (stop words and very common job-ad words dropped) and two-word phrases. A word counts once
// per mention (at most three times), a phrase counts 2.5. The score is the share of that weight that the resume also contains.
// ---------------------------------------------------------------------------
const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the their this to was were will with you your we our us they them he she his her i my me '
  + 'about above after all also any can could do does done each etc few more most other over per such than then there these those through under up use used using via very who whom why '
  + 'work works working role roles job jobs position candidate candidates company team teams years year experience experienced required requirement requirements responsibilities responsibility '
  + 'strong good excellent ability able skills skill knowledge understanding must should preferred plus including include etc looking seeking hiring join apply ideal like well new based related '
  + 'minimum least month months day days need needs needed one two three').split(/\s+/));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#.\s/-]/g, ' ').replace(/(?<![a-z0-9])[.-]+|[.-]+(?![a-z0-9+#])/g, ' ').replace(/\s+/g, ' ').trim();
function tokens(text) {
  return norm(text).split(' ').map((w) => w.replace(/^[./-]+|[./-]+$/g, '')).filter((w) => w.length >= 2 && !/^\d+$/.test(w));
}
const stem = (w) => (w.length > 5 ? w.replace(/(ing|ers|er|ed|es|s)$/, '') : w.replace(/s$/, ''));

function jdMatch(jdText, resumeText) {
  const jd = tokens(jdText);
  const cv = tokens(resumeText);
  if (jd.length < 15 || cv.length < 20) return null;
  const cvStems = new Set(cv.map(stem));
  const cvPhrases = new Set();
  const cvKeys = cv.filter((w) => !STOP.has(w)).map(stem);
  for (let i = 0; i + 1 < cvKeys.length; i += 1) cvPhrases.add(`${cvKeys[i]} ${cvKeys[i + 1]}`);
  const counts = new Map();
  jd.forEach((w) => { if (STOP.has(w)) return; const s = stem(w); counts.set(s, (counts.get(s) || 0) + 1); });
  const jdKeys = jd.filter((w) => !STOP.has(w)).map(stem);
  const phrases = new Map();
  for (let i = 0; i + 1 < jdKeys.length; i += 1) { const p = `${jdKeys[i]} ${jdKeys[i + 1]}`; phrases.set(p, (phrases.get(p) || 0) + 1); }
  let total = 0; let hit = 0;
  const matched = []; const missing = [];
  counts.forEach((n, s) => {
    const w = 1 + Math.min(n, 3) * 0.5;
    total += w;
    if (cvStems.has(s)) { hit += w; matched.push([s, w]); } else missing.push([s, w]);
  });
  // phrases that repeat in the JD or are skill-like (contain a digit, #, + or .) carry more; every two-word phrase counts 2.5
  [...phrases.keys()].slice(0, 120).forEach((p) => {
    total += 2.5;
    if (cvPhrases.has(p)) { hit += 2.5; matched.push([p, 2.5]); } else missing.push([p, 0.5]);
  });
  if (!total) return null;
  const top = (arr, n) => arr.sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
  return {
    pct: Math.round((hit / total) * 100), matched: top(matched, 12), missing: top(missing.filter(([s]) => !s.includes(' ')), 12), jdWords: jd.length,
  };
}

// the words that say what a job is: its description, responsibilities, qualifications and the skills it lists
function jdTextOf(r) {
  if (!r) return '';
  return [r.title, r.description, r.jobDescription, r.responsibilities, r.qualifications, r.skills, r.goodToHaveSkills, r.education, r.specialisation].filter(Boolean).join('\n');
}

module.exports = { jdMatch, jdTextOf, tokens };
