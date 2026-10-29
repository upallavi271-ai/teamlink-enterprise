// ---------------------------------------------------------------------------
// SAY IT IN THE VOICE'S OWN LETTERS (2026-10-29: "names kuda proper ga pronunciation cheyyatledhu").
//
// The Telugu / Hindi voices read Telugu / Devanagari letters; an English-letter word in their sentence ("Gujjula
// Velangini Keerthi", "work from office", "Sales Officer") comes out wrong. Before speaking, every English-letter word
// is turned into the voice's letters:
//   * common job / recruitment words from a small dictionary (how people in India say them: office -> ఆఫీస్)
//   * everything else - mostly names - by Indian spelling rules (Keerthi -> కీర్తి, Sudheer -> సుధీర్, Karthik -> కార్తిక్)
//   * "Ch." / "V." initials are left out ("Ch. Vasu" -> "వసు"); "Dr." / "Mr." / "Ms." are said in full
//
//   native(text, 'Telugu' | 'Hindi') -> text    (English: unchanged)
// Only what is SPOKEN changes; the stored transcript keeps the original words.
// ---------------------------------------------------------------------------

// [Telugu, Hindi]
const WORDS = {
  work: ['వర్క్', 'वर्क'], from: ['ఫ్రమ్', 'फ्रॉम'], office: ['ఆఫీస్', 'ऑफिस'], home: ['హోమ్', 'होम'], hybrid: ['హైబ్రిడ్', 'हाइब्रिड'],
  remote: ['రిమోట్', 'रिमोट'], onsite: ['ఆన్‌సైట్', 'ऑनसाइट'], full: ['ఫుల్', 'फुल'], part: ['పార్ట్', 'पार्ट'], time: ['టైమ్', 'टाइम'],
  contract: ['కాంట్రాక్ట్', 'कॉन्ट्रैक्ट'], permanent: ['పర్మనెంట్', 'परमानेंट'], temporary: ['టెంపరరీ', 'टेम्परेरी'], shift: ['షిఫ్ట్', 'शिफ्ट'],
  sales: ['సేల్స్', 'सेल्स'], officer: ['ఆఫీసర్', 'ऑफिसर'], staff: ['స్టాఫ్', 'स्टाफ'], nurse: ['నర్స్', 'नर्स'], nursing: ['నర్సింగ్', 'नर्सिंग'],
  assistant: ['అసిస్టెంట్', 'असिस्टेंट'], associate: ['అసోసియేట్', 'एसोसिएट'], professor: ['ప్రొఫెసర్', 'प्रोफेसर'], senior: ['సీనియర్', 'सीनियर'],
  junior: ['జూనియర్', 'जूनियर'], resident: ['రెసిడెంట్', 'रेजिडेंट'], consultant: ['కన్సల్టెంట్', 'कंसल्टेंट'], doctor: ['డాక్టర్', 'डॉक्टर'],
  executive: ['ఎగ్జిక్యూటివ్', 'एग्जीक्यूटिव'], manager: ['మేనేజర్', 'मैनेजर'], engineer: ['ఇంజనీర్', 'इंजीनियर'], teacher: ['టీచర్', 'टीचर'],
  faculty: ['ఫ్యాకల్టీ', 'फैकल्टी'], lecturer: ['లెక్చరర్', 'लेक्चरर'], technician: ['టెక్నీషియన్', 'टेक्नीशियन'], pharmacist: ['ఫార్మసిస్ట్', 'फार्मासिस्ट'],
  accountant: ['అకౌంటెంట్', 'अकाउंटेंट'], developer: ['డెవలపర్', 'डेवलपर'], trainee: ['ట్రైనీ', 'ट्रेनी'], intern: ['ఇంటర్న్', 'इंटर्न'],
  marketing: ['మార్కెటింగ్', 'मार्केटिंग'], business: ['బిజినెస్', 'बिजनेस'], development: ['డెవలప్‌మెంట్', 'डेवलपमेंट'], operator: ['ఆపరేటర్', 'ऑपरेटर'],
  supervisor: ['సూపర్‌వైజర్', 'सुपरवाइजर'], helper: ['హెల్పర్', 'हेल्पर'], driver: ['డ్రైవర్', 'ड्राइवर'], receptionist: ['రిసెప్షనిస్ట్', 'रिसेप्शनिस्ट'],
  head: ['హెడ్', 'हेड'], incharge: ['ఇన్‌ఛార్జ్', 'इंचार्ज'], quality: ['క్వాలిటీ', 'क्वालिटी'], production: ['ప్రొడక్షన్', 'प्रोडक्शन'],
  general: ['జనరల్', 'जनरल'], medicine: ['మెడిసిన్', 'मेडिसिन'], surgery: ['సర్జరీ', 'सर्जरी'], medical: ['మెడికల్', 'मेडिकल'], college: ['కాలేజ్', 'कॉलेज'],
  hospital: ['హాస్పిటల్', 'हॉस्पिटल'], school: ['స్కూల్', 'स्कूल'], institute: ['ఇన్‌స్టిట్యూట్', 'इंस्टिट्यूट'], requirement: ['రిక్వైర్‌మెంట్', 'रिक्वायरमेंट'],
  and: ['అండ్', 'एंड'], of: ['ఆఫ్', 'ऑफ'], the: ['ది', 'द'], in: ['ఇన్', 'इन'], for: ['ఫర్', 'फॉर'], it: ['ఐటీ', 'आईटी'], non: ['నాన్', 'नॉन'],
  hr: ['హెచ్‌ఆర్', 'एचआर'], ai: ['ఏఐ', 'एआई'], otp: ['ఓటీపీ', 'ओटीपी'], icu: ['ఐసీయూ', 'आईसीयू'], md: ['ఎండీ', 'एमडी'], mbbs: ['ఎంబీబీఎస్', 'एमबीबीएस'],
  lpa: ['ఎల్పీఏ', 'एलपीए'], ctc: ['సీటీసీ', 'सीटीसी'], dr: ['డాక్టర్', 'डॉक्टर'], mr: ['మిస్టర్', 'मिस्टर'], ms: ['మిస్', 'मिस'], mrs: ['మిసెస్', 'मिसेज'],
  teamlink: ['టీమ్‌లింక్', 'टीमलिंक'], consultants: ['కన్సల్టెంట్స్', 'कंसल्टेंट्स'], ok: ['ఓకే', 'ओके'], okay: ['ఓకే', 'ओके'],
};

// Indian spelling rules -> letters. [independent vowel, vowel sign] per language; consonants longest-first.
const V = {
  Telugu: { a: ['అ', ''], aa: ['ఆ', 'ా'], i: ['ఇ', 'ి'], ee: ['ఈ', 'ీ'], ii: ['ఈ', 'ీ'], u: ['ఉ', 'ు'], oo: ['ఊ', 'ూ'], uu: ['ఊ', 'ూ'], e: ['ఎ', 'ె'], ai: ['ఐ', 'ై'], ei: ['ఐ', 'ై'], o: ['ఒ', 'ొ'], au: ['ఔ', 'ౌ'], ou: ['ఔ', 'ౌ'], y: ['ఇ', 'ి'] },
  Hindi: { a: ['अ', ''], aa: ['आ', 'ा'], i: ['इ', 'ि'], ee: ['ई', 'ी'], ii: ['ई', 'ी'], u: ['उ', 'ु'], oo: ['ऊ', 'ू'], uu: ['ऊ', 'ू'], e: ['ए', 'े'], ai: ['ऐ', 'ै'], ei: ['ऐ', 'ै'], o: ['ओ', 'ो'], au: ['औ', 'ौ'], ou: ['औ', 'ौ'], y: ['इ', 'ि'] },
};
const C = {
  Telugu: { ksh: 'క్ష', chh: 'ఛ', kh: 'ఖ', gh: 'ఘ', ch: 'చ', jh: 'ఝ', th: 'త', dh: 'ధ', ph: 'ఫ', bh: 'భ', sh: 'శ', k: 'క', g: 'గ', c: 'క', j: 'జ', t: 'ట', d: 'డ', n: 'న', m: 'మ', p: 'ప', b: 'బ', y: 'య', r: 'ర', l: 'ల', v: 'వ', w: 'వ', s: 'స', h: 'హ', f: 'ఫ', z: 'జ', q: 'క', x: 'క్స' },
  Hindi: { ksh: 'क्ष', chh: 'छ', kh: 'ख', gh: 'घ', ch: 'च', jh: 'झ', th: 'त', dh: 'ध', ph: 'फ', bh: 'भ', sh: 'श', k: 'क', g: 'ग', c: 'क', j: 'ज', t: 'ट', d: 'ड', n: 'न', m: 'म', p: 'प', b: 'ब', y: 'य', r: 'र', l: 'ल', v: 'व', w: 'व', s: 'स', h: 'ह', f: 'फ', z: 'ज़', q: 'क', x: 'क्स' },
};
// In NAMES a plain t / d is the soft one (Teja తేజ, Deepa దీప); the hard ట / డ comes from tt / dd
const NAME_SOFT = { Telugu: { t: 'త', d: 'ద' }, Hindi: { t: 'त', d: 'द' } };
const VIRAMA = { Telugu: '్', Hindi: '्' };
const ANUSVARA = { Telugu: 'ం', Hindi: 'ं' };
const VOWELS = ['aa', 'ee', 'ii', 'oo', 'uu', 'ai', 'ei', 'au', 'ou', 'a', 'i', 'u', 'e', 'o'];
const CONS = ['ksh', 'chh', 'kh', 'gh', 'ch', 'jh', 'th', 'dh', 'ph', 'bh', 'sh', 'k', 'g', 'c', 'j', 't', 'd', 'n', 'm', 'p', 'b', 'y', 'r', 'l', 'v', 'w', 's', 'h', 'f', 'z', 'q', 'x'];
const take = (w, i, list) => list.find((x) => w.startsWith(x, i)) || null;

// One English-letter word -> letters, by the rules (a name, usually)
const SRI = { Telugu: 'శ్రీ', Hindi: 'श्री' };
function spell(word, lang) {
  const w = word.toLowerCase();
  // Sri / Shri / Sree at the start is always శ్రీ (Srikanth, Srinivas, Shrimathi, Sri)
  const sri = /^s(h)?r(ee|i)/.exec(w);
  if (sri) return SRI[lang] + (w.length > sri[0].length ? spell(`_${w.slice(sri[0].length)}`, lang) : ''); const vs = V[lang]; const cs = { ...C[lang], ...NAME_SOFT[lang] };
  let out = ''; let i = 0; let open = false; // open = the last letter is a consonant still waiting for its vowel
  while (i < w.length) {
    const v = take(w, i, VOWELS);
    if (v) { out += open ? vs[v][1] : vs[v][0]; open = false; i += v.length; continue; }
    let c = take(w, i, CONS);
    if (!c) { i += 1; continue; }
    // doubled consonant (jj, tt, ll): a joined pair; tt / dd are the hard sounds
    if (w[i + c.length] === c[c.length - 1] && c.length === 1) {
      const hard = c === 't' || c === 'd' ? C[lang][c] : cs[c];
      if (open) out += VIRAMA[lang];
      out += hard + VIRAMA[lang] + hard; open = true; i += 2; continue;
    }
    // n / m before another consonant: the nasal dot (Velangini -> వెలంగిని, Champa -> చంప)
    if ((c === 'n' || c === 'm') && take(w, i + 1, CONS) && !take(w, i + 1, ['y', 'h'])) {
      if (open) out += VIRAMA[lang];
      out += ANUSVARA[lang]; open = false; i += 1; continue;
    }
    if (c === 'y' && open === false && out && i === w.length - 1) { out += vs.y[0]; i += 1; continue; }
    if (c === 'y' && open && (i === w.length - 1)) { out += vs.y[1]; open = false; i += 1; continue; } // ...y at the end (Ramy -> రమీ)
    if (open) out += VIRAMA[lang];
    out += cs[c]; open = true; i += c.length;
    c = null;
  }
  if (open && /[^aeiouy]$/.test(w)) out += VIRAMA[lang]; // Karthik -> కార్తిక్ (a word ending in a consonant)
  return out;
}

function native(text, lang) {
  if (lang !== 'Telugu' && lang !== 'Hindi') return text;
  const col = lang === 'Telugu' ? 0 : 1;
  return String(text || '')
    .replace(/\b(Dr|Mr|Mrs|Ms)\.\s*/gi, '$1 ') // Dr. Karthik: said in full, no stop in the middle of a name
    .replace(/\b[A-Za-z]{1,2}\.\s*/g, '') // "Ch. " / "V. " initials: left out
    .replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
      const k = word.toLowerCase().replace(/'.*$/, '');
      if (WORDS[k]) return WORDS[k][col];
      if (/^[A-Z]{2,4}$/.test(word)) return word.split('').map((ch) => spell(ch === 'A' ? 'e' : `${ch.toLowerCase()}`, lang)).join(''); // short capitals: letter by letter
      return spell(word, lang);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { native, spell, WORDS };
