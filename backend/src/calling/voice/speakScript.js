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

// MORE WORDS (2026-10-30: requirements read from the ATS description - subjects, degrees, places, numbers - came out as
// letter-by-letter guesses: "years" -> యెఅర్స్, "road" -> రొఅద్). How people in India say them, in each voice's letters.
Object.assign(WORDS, {
  years: ['సంవత్సరాలు', 'साल'], year: ['సంవత్సరం', 'साल'], yrs: ['సంవత్సరాలు', 'साल'], months: ['నెలలు', 'महीने'], month: ['నెల', 'महीना'],
  thousand: ['వేలు', 'हज़ार'], lakh: ['లక్షలు', 'लाख'], lakhs: ['లక్షలు', 'लाख'], per: ['పర్', 'पर'], to: ['టు', 'टू'], with: ['విత్', 'विद'],
  road: ['రోడ్', 'रोड'], street: ['స్ట్రీట్', 'स्ट्रीट'], colony: ['కాలనీ', 'कॉलोनी'], cross: ['క్రాస్', 'क्रॉस'], main: ['మెయిన్', 'मेन'],
  near: ['నియర్', 'नियर'], opposite: ['ఆపోజిట్', 'अपोज़िट'], district: ['డిస్ట్రిక్ట్', 'डिस्ट्रिक्ट'], city: ['సిటీ', 'सिटी'],
  physics: ['ఫిజిక్స్', 'फिज़िक्स'], mathematics: ['మ్యాథమెటిక్స్', 'मैथमेटिक्स'], maths: ['మ్యాథ్స్', 'मैथ्स'], math: ['మ్యాథ్స్', 'मैथ्स'],
  chemistry: ['కెమిస్ట్రీ', 'केमिस्ट्री'], biology: ['బయాలజీ', 'बायोलॉजी'], english: ['ఇంగ్లీష్', 'इंग्लिश'], telugu: ['తెలుగు', 'तेलुगु'], hindi: ['హిందీ', 'हिंदी'],
  computer: ['కంప్యూటర్', 'कंप्यूटर'], computers: ['కంప్యూటర్స్', 'कंप्यूटर्स'], science: ['సైన్స్', 'साइंस'], computing: ['కంప్యూటింగ్', 'कंप्यूटिंग'],
  cloud: ['క్లౌడ్', 'क्लाउड'], engineering: ['ఇంజనీరింగ్', 'इंजीनियरिंग'], electronics: ['ఎలక్ట్రానిక్స్', 'इलेक्ट्रॉनिक्स'],
  electrical: ['ఎలక్ట్రికల్', 'इलेक्ट्रिकल'], mechanical: ['మెకానికల్', 'मैकेनिकल'], civil: ['సివిల్', 'सिविल'], commerce: ['కామర్స్', 'कॉमर्स'],
  management: ['మేనేజ్‌మెంట్', 'मैनेजमेंट'], economics: ['ఎకనామిక్స్', 'इकोनॉमिक्स'], statistics: ['స్టాటిస్టిక్స్', 'स्टैटिस्टिक्स'],
  data: ['డేటా', 'डेटा'], analytics: ['అనలిటిక్స్', 'एनालिटिक्स'], machine: ['మెషిన్', 'मशीन'], learning: ['లెర్నింగ్', 'लर्निंग'],
  network: ['నెట్‌వర్క్', 'नेटवर्क'], networking: ['నెట్‌వర్కింగ్', 'नेटवर्किंग'], administrator: ['అడ్మినిస్ట్రేటర్', 'एडमिनिस्ट्रेटर'],
  admin: ['అడ్మిన్', 'एडमिन'], service: ['సర్వీస్', 'सर्विस'], now: ['నౌ', 'नाउ'], salesforce: ['సేల్స్‌ఫోర్స్', 'सेल्सफोर्स'], pega: ['పెగా', 'पेगा'],
  python: ['పైథాన్', 'पायथन'], java: ['జావా', 'जावा'], testing: ['టెస్టింగ్', 'टेस्टिंग'], software: ['సాఫ్ట్‌వేర్', 'सॉफ्टवेयर'], hardware: ['హార్డ్‌వేర్', 'हार्डवेयर'],
  support: ['సపోర్ట్', 'सपोर्ट'], customer: ['కస్టమర్', 'कस्टमर'], call: ['కాల్', 'कॉल'], center: ['సెంటర్', 'सेंटर'], centre: ['సెంటర్', 'सेंटर'],
  certified: ['సర్టిఫైడ్', 'सर्टिफाइड'], certification: ['సర్టిఫికేషన్', 'सर्टिफिकेशन'], course: ['కోర్స్', 'कोर्स'], courses: ['కోర్సులు', 'कोर्स'],
  related: ['రిలేటెడ్', 'रिलेटेड'], trainer: ['ట్రైనర్', 'ट्रेनर'], trainers: ['ట్రైనర్స్', 'ट्रेनर्स'], teacher: ['టీచర్', 'टीचर'], teachers: ['టీచర్స్', 'टीचर्स'],
  college: ['కాలేజ్', 'कॉलेज'], university: ['యూనివర్సిటీ', 'यूनिवर्सिटी'], degree: ['డిగ్రీ', 'डिग्री'], any: ['ఏదైనా', 'कोई भी'], graduate: ['గ్రాడ్యుయేట్', 'ग्रेजुएट'],
  fresher: ['ఫ్రెషర్', 'फ्रेशर'], freshers: ['ఫ్రెషర్స్', 'फ्रेशर्स'], experience: ['ఎక్స్‌పీరియన్స్', 'एक्सपीरियंस'], salary: ['జీతం', 'सैलरी'],
  pharmacist: ['ఫార్మసిస్ట్', 'फार्मासिस्ट'], pharmacy: ['ఫార్మసీ', 'फार्मेसी'], lab: ['ల్యాబ్', 'लैब'], ward: ['వార్డ్', 'वार्ड'], boy: ['బాయ్', 'बॉय'],
  operator: ['ఆపరేటర్', 'ऑपरेटर'], machinist: ['మెషినిస్ట్', 'मशीनिस्ट'], welder: ['వెల్డర్', 'वेल्डर'], fitter: ['ఫిట్టర్', 'फिटर'], electrician: ['ఎలక్ట్రీషియన్', 'इलेक्ट्रीशियन'],
  store: ['స్టోర్', 'स्टोर'], stores: ['స్టోర్స్', 'स्टोर्स'], plant: ['ప్లాంట్', 'प्लांट'], maintenance: ['మెయింటెనెన్స్', 'मेंटेनेंस'], safety: ['సేఫ్టీ', 'सेफ्टी'],
  billing: ['బిల్లింగ్', 'बिलिंग'], front: ['ఫ్రంట్', 'फ्रंट'], desk: ['డెస్క్', 'डेस्क'], clinic: ['క్లినిక్', 'क्लिनिक'], diagnostics: ['డయాగ్నొస్టిక్స్', 'डायग्नोस्टिक्स'],
  shift: ['షిఫ్ట్', 'शिफ्ट'], night: ['నైట్', 'नाइट'], day: ['డే', 'डे'], week: ['వీక్', 'वीक'],
  // places (the spelling rules give "Kakinada" -> కకినద; people say కాకినాడ)
  hyderabad: ['హైదరాబాద్', 'हैदराबाद'], secunderabad: ['సికింద్రాబాద్', 'सिकंदराबाद'], kakinada: ['కాకినాడ', 'काकीनाडा'],
  andhra: ['ఆంధ్ర', 'आंध्र'], pradesh: ['ప్రదేశ్', 'प्रदेश'], telangana: ['తెలంగాణ', 'तेलंगाना'], vijayawada: ['విజయవాడ', 'विजयवाड़ा'],
  visakhapatnam: ['విశాఖపట్నం', 'विशाखापत्तनम'], vizag: ['వైజాగ్', 'वाइज़ैग'], guntur: ['గుంటూరు', 'गुंटूर'], nellore: ['నెల్లూరు', 'नेल्लोर'],
  tirupati: ['తిరుపతి', 'तिरुपति'], warangal: ['వరంగల్', 'वारंगल'], karimnagar: ['కరీంనగర్', 'करीमनगर'], khammam: ['ఖమ్మం', 'खम्मम'],
  kurnool: ['కర్నూలు', 'कुरनूल'], rajahmundry: ['రాజమండ్రి', 'राजमुंदरी'], rajamahendravaram: ['రాజమహేంద్రవరం', 'राजमहेंद्रवरम'],
  eluru: ['ఏలూరు', 'एलुरु'], ongole: ['ఒంగోలు', 'ओंगोल'], kadapa: ['కడప', 'कडप्पा'], anantapur: ['అనంతపురం', 'अनंतपुर'], chittoor: ['చిత్తూరు', 'चित्तूर'],
  srikakulam: ['శ్రీకాకుళం', 'श्रीकाकुलम'], vizianagaram: ['విజయనగరం', 'विजयनगरम'], nizamabad: ['నిజామాబాద్', 'निज़ामाबाद'], nalgonda: ['నల్గొండ', 'नलगोंडा'],
  mahabubnagar: ['మహబూబ్‌నగర్', 'महबूबनगर'], medak: ['మెదక్', 'मेदक'], adilabad: ['ఆదిలాబాద్', 'आदिलाबाद'], machilipatnam: ['మచిలీపట్నం', 'मछलीपट्टनम'],
  bhimavaram: ['భీమవరం', 'भीमावरम'], narasaraopet: ['నరసరావుపేట', 'नरसरावपेट'], mehdipatnam: ['మెహదీపట్నం', 'मेहदीपट्टनम'], mehadipanam: ['మెహదీపట్నం', 'मेहदीपट्टनम'],
  kukatpally: ['కూకట్‌పల్లి', 'कूकटपल्ली'], madhapur: ['మాదాపూర్', 'मादापुर'], gachibowli: ['గచ్చిబౌలి', 'गच्चीबौली'], ameerpet: ['అమీర్‌పేట్', 'अमीरपेट'],
  dilsukhnagar: ['దిల్‌సుఖ్‌నగర్', 'दिलसुखनगर'], uppal: ['ఉప్పల్', 'उप्पल'], kondapur: ['కొండాపూర్', 'कोंडापुर'], nagar: ['నగర్', 'नगर'],
  bangalore: ['బెంగళూరు', 'बैंगलोर'], bengaluru: ['బెంగళూరు', 'बेंगलुरु'], chennai: ['చెన్నై', 'चेन्नई'], mumbai: ['ముంబై', 'मुंबई'], pune: ['పుణె', 'पुणे'],
  delhi: ['ఢిల్లీ', 'दिल्ली'], kolkata: ['కోల్‌కతా', 'कोलकाता'], karnataka: ['కర్ణాటక', 'कर्नाटक'], tamil: ['తమిళ్', 'तमिल'], nadu: ['నాడు', 'नाडु'],
  kerala: ['కేరళ', 'केरल'], maharashtra: ['మహారాష్ట్ర', 'महाराष्ट्र'], odisha: ['ఒడిశా', 'ओडिशा'], belagavi: ['బెళగావి', 'बेलगावी'], india: ['ఇండియా', 'इंडिया'],
});

// Degrees, said the way people say them ("M.Tech" -> ఎం టెక్, "Ph.D" -> పీహెచ్‌డీ). Matched before the initials rule.
const DEGREES = [
  [/\bPh\.?\s?D\b/gi, ['పీహెచ్‌డీ', 'पीएचडी']], [/\bM\.?\s?Tech\b/gi, ['ఎం టెక్', 'एम टेक']], [/\bB\.?\s?Tech\b/gi, ['బీ టెక్', 'बी टेक']],
  [/\bM\.?\s?Sc\b/gi, ['ఎమ్మెస్సీ', 'एमएससी']], [/\bB\.?\s?Sc\b/gi, ['బీఎస్సీ', 'बीएससी']], [/\bM\.?\s?Com\b/gi, ['ఎం కామ్', 'एम कॉम']],
  [/\bB\.?\s?Com\b/gi, ['బీ కామ్', 'बी कॉम']], [/\bB\.\s?Ed\b/gi, ['బీఎడ్', 'बीएड']], [/\bM\.\s?Ed\b/gi, ['ఎంఎడ్', 'एमएड']],
  [/\bM\.?\s?Pharm\b/gi, ['ఎం ఫార్మ్', 'एम फार्म']], [/\bB\.?\s?Pharm\b/gi, ['బీ ఫార్మ్', 'बी फार्म']], [/\bPharm\.?\s?D\b/gi, ['ఫార్మ్ డీ', 'फार्म डी']],
];
// Capital letters said one by one, by their names (CSE -> సీ ఎస్ ఈ, LB -> ఎల్ బీ) - not guessed as a word
const LETTER = {
  Telugu: { A: 'ఏ', B: 'బీ', C: 'సీ', D: 'డీ', E: 'ఈ', F: 'ఎఫ్', G: 'జీ', H: 'హెచ్', I: 'ఐ', J: 'జే', K: 'కే', L: 'ఎల్', M: 'ఎమ్', N: 'ఎన్', O: 'ఓ', P: 'పీ', Q: 'క్యూ', R: 'ఆర్', S: 'ఎస్', T: 'టీ', U: 'యూ', V: 'వీ', W: 'డబ్ల్యూ', X: 'ఎక్స్', Y: 'వై', Z: 'జెడ్' },
  Hindi: { A: 'ए', B: 'बी', C: 'सी', D: 'डी', E: 'ई', F: 'एफ', G: 'जी', H: 'एच', I: 'आई', J: 'जे', K: 'के', L: 'एल', M: 'एम', N: 'एन', O: 'ओ', P: 'पी', Q: 'क्यू', R: 'आर', S: 'एस', T: 'टी', U: 'यू', V: 'वी', W: 'डब्ल्यू', X: 'एक्स', Y: 'वाई', Z: 'ज़ेड' },
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
  let t = String(text || '').replace(/\s&\s/g, ' and '); // "AI & ML": the & is said as "and"
  DEGREES.forEach(([re, words]) => { t = t.replace(re, words[col]); });
  return t
    .replace(/\b(Dr|Mr|Mrs|Ms)\.\s*/gi, '$1 ') // Dr. Karthik: said in full, no stop in the middle of a name
    .replace(/\b[A-Za-z]{1,2}\.\s*/g, '') // "Ch. " / "V. " initials: left out
    .replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
      const k = word.toLowerCase().replace(/'.*$/, '');
      if (WORDS[k]) return WORDS[k][col];
      if (/^[A-Z]{2,5}$/.test(word)) return word.split('').map((ch) => LETTER[lang][ch]).join(' '); // short capitals: letter by letter, by name
      return spell(word, lang);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { native, spell, WORDS };
