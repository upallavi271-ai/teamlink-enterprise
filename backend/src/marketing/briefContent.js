// ---------------------------------------------------------------------------
// AI MARKETING: CONTENT FROM A CLIENT'S BRIEF (2026-11-23). A client project already holds what the client asked for (who they are, the occasion, the brief). When nobody types an
// idea, the video / post is written FROM THAT BRIEF, for the client's own customers: a doctor's video teaches patients something useful, it does not shout "buy".
//   profileOf(text)     which kind of client this is (skin doctor, dentist, eye, bones and joints, children, women's health, heart, hospital / clinic, lab, pharmacy, else general) from the words of the brief
//   buildPlan(...)      a complete, free plan (no AI service, instant): hook line, useful points, call to action, caption, hashtags, one scene per picture with the words to find a real photo with
//   guide(profile)      the lines added to the AI writer's instructions when the AI writer IS used (same rules: useful, accurate, calm, no promises)
// Health rules for every medical client: general education only, "see a doctor" for anything serious, never a cure, a guaranteed result, a before / after claim, a price or a fear message.
// Nothing is invented about the client: no prices, phone numbers, addresses, years of experience or awards. The caption uses only what the brief says.
// ---------------------------------------------------------------------------
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

const PROFILES = [
  {
    id: 'skin', re: /dermat|skin|hair|cosmetolog|acne|aesthetic/i, who: 'people who care about their skin and hair', tag: ['SkinCare', 'Dermatology'], search: ['dermatologist clinic', 'skin care woman', 'sunscreen skin care', 'doctor patient consultation', 'healthy glowing skin'],
    hook: 'Healthy skin starts with small daily habits',
    tips: ['Use sunscreen every day, even on cloudy days', 'Do not squeeze pimples: it can leave marks. See a skin doctor for acne that stays', 'Patch-test a new product on a small area before using it on your face', 'Moisturise after a bath and drink enough water', 'A mole that changes size or colour needs a doctor to look at it'],
    cta: 'Book a consultation',
  },
  {
    id: 'dental', re: /dent|tooth|teeth|orthodont|oral/i, who: 'families who want healthy teeth', tag: ['DentalCare', 'HealthySmile'], search: ['dentist clinic', 'smiling teeth', 'brushing teeth', 'dentist patient', 'family smile'],
    hook: 'A healthy smile needs care every day',
    tips: ['Brush twice a day for two minutes, and change your brush every three months', 'Clean between your teeth once a day', 'Fewer sweets and sugary drinks means fewer cavities', 'Do not wait for pain: a check-up every six months finds problems early', 'Bleeding gums are a reason to see the dentist, not to stop brushing'],
    cta: 'Book a check-up',
  },
  {
    id: 'eye', re: /eye|ophthal|optom|vision|retina|lasik/i, who: 'people who want to protect their eyesight', tag: ['EyeCare', 'HealthyEyes'], search: ['eye doctor clinic', 'eye examination', 'person with glasses', 'eye care', 'child eye test'],
    hook: 'Look after your eyes: you only get one pair',
    tips: ['After every 20 minutes on a screen, look at something far away for 20 seconds', 'Get your eyes tested every year, and children before they start school', 'Wear sunglasses that block UV light outdoors', 'Do not put drops in your eyes without a doctor\'s advice', 'Sudden blurry vision or eye pain needs a doctor the same day'],
    cta: 'Book an eye test',
  },
  {
    id: 'bones', re: /ortho|bone|joint|physio|spine|fracture|knee/i, who: 'people with back, joint or muscle pain', tag: ['BoneHealth', 'Physiotherapy'], search: ['orthopedic doctor', 'physiotherapy exercise', 'healthy back posture', 'walking exercise senior', 'doctor patient x-ray'],
    hook: 'Strong bones and joints for every age',
    tips: ['Sit with your back supported and get up to stretch every hour', 'Walk or do gentle exercise daily to keep joints moving', 'Calcium and vitamin D matter: sunlight and a balanced diet help', 'Lift with your knees, not your back', 'Pain that stays for weeks, or follows a fall, should be checked by a doctor'],
    cta: 'Book a consultation',
  },
  {
    id: 'child', re: /paed|pedia|child|baby|neonat|newborn/i, who: 'parents who want the best for their children', tag: ['ChildHealth', 'Parenting'], search: ['pediatrician child', 'mother baby', 'child doctor check up', 'happy child', 'family healthy food'],
    hook: 'Healthy children, happy parents',
    tips: ['Follow your child\'s vaccination schedule and keep the card safe', 'Wash hands before meals and after play', 'Breast milk is the best food for a baby in the first six months', 'Do not give medicines to a child without the doctor\'s advice', 'High fever, trouble breathing or a baby who will not feed: see a doctor straight away'],
    cta: 'Book a visit',
  },
  {
    id: 'women', re: /gyn|obstet|women|maternity|pregnan|fertility|ivf/i, who: 'women and families', tag: ['WomensHealth', 'Maternity'], search: ['gynecologist doctor', 'pregnant woman', 'woman doctor consultation', 'healthy woman', 'mother and baby'],
    hook: 'Your health matters at every stage',
    tips: ['Regular check-ups help find problems early', 'A balanced diet with iron, calcium and folic acid supports women\'s health', 'During pregnancy go for every antenatal visit and take only the medicines your doctor gives', 'Moderate exercise and enough sleep help body and mind', 'Pain, bleeding or anything that worries you: speak to your doctor early'],
    cta: 'Book an appointment',
  },
  {
    id: 'heart', re: /cardio|heart|cardiac/i, who: 'people who want a healthy heart', tag: ['HeartHealth', 'Cardiology'], search: ['cardiologist doctor', 'heart health', 'walking exercise', 'healthy food vegetables', 'doctor checking blood pressure'],
    hook: 'A healthy heart is built every day',
    tips: ['Walk briskly for 30 minutes on most days', 'Eat less salt and fried food, and more vegetables and fruit', 'Check your blood pressure and sugar regularly after 30', 'Do not smoke: your heart starts to recover soon after you stop', 'Chest pain, sweating or breathlessness: get medical help immediately'],
    cta: 'Book a heart check-up',
  },
  {
    id: 'lab', re: /diagnos|pathol|laborator|\blab\b|scan|radiolog/i, who: 'people who want clear, timely test results', tag: ['Diagnostics', 'HealthCheck'], search: ['laboratory test', 'blood test sample', 'doctor report', 'health check up', 'medical laboratory'],
    hook: 'The right test at the right time',
    tips: ['A regular health check-up finds problems before they cause symptoms', 'Follow the preparation your doctor gives, such as fasting, before a test', 'Keep your reports together and show them at every visit', 'Do not decide treatment from a report alone: your doctor reads it with your history', 'Ask us how to prepare before you come'],
    cta: 'Book a test',
  },
  {
    id: 'pharmacy', re: /pharm|chemist|medical store|medicine/i, who: 'families who rely on safe medicines', tag: ['Pharmacy', 'SafeMedicine'], search: ['pharmacist medicine', 'pharmacy shelf', 'pharmacist helping customer', 'medicines tablets', 'family health'],
    hook: 'Use medicines safely',
    tips: ['Take medicines exactly as your doctor wrote them', 'Finish the course of antibiotics: stopping early is not safe', 'Store medicines away from heat and children', 'Check the expiry date before you take any medicine', 'Ask the pharmacist if you are unsure how to take it'],
    cta: 'Visit us',
  },
  {
    id: 'clinic', re: /doctor|clinic|hospital|physician|medical|health|surgeon|dr\.?\s/i, who: 'patients and their families', tag: ['Healthcare', 'HealthTips'], search: ['doctor patient consultation', 'hospital reception', 'doctor stethoscope', 'healthy family', 'nurse care'],
    hook: 'Your health, our care',
    tips: ['Do not ignore symptoms that stay for more than a few days', 'A yearly health check-up finds problems early', 'Eat on time, sleep well and stay active: the simple things protect your health', 'Do not take medicines on your own: ask your doctor', 'In an emergency go to the nearest hospital without waiting'],
    cta: 'Book an appointment',
  },
];
const GENERAL = { id: 'general', who: 'their customers', tag: ['Business'], search: ['business team', 'customer service', 'office meeting', 'happy customer', 'professional handshake'], hook: '', tips: [], cta: 'Contact us' };
const HEALTH = new Set(['skin', 'dental', 'eye', 'bones', 'child', 'women', 'heart', 'lab', 'pharmacy', 'clinic']);

function profileOf(text) {
  const t = String(text || '');
  return PROFILES.find((p) => p.re.test(t)) || GENERAL;
}

// the sentences of the brief, cleaned: what the client said, in their order
const sentences = (brief) => (String(brief || '').replace(/\r/g, '').match(/[^.!?\n]+[.!?]*/g) || []).map((x) => clip(x, 160)).filter((x) => x.length >= 8);

// TOPICS (2026-11-24): a client often LISTS what they do in the brief (a skin doctor: acne, pigmentation, hair fall ...). Each listed thing becomes its own video idea, and a video on that
// topic carries tips about THAT topic, not generic ones. General education only (see the health rules above).
const TOPICS = [
  { re: /acne|pimple/i, hook: 'Clear skin: what really helps with acne', search: ['acne skin care', 'washing face', 'dermatologist consultation'], tips: ['Wash your face twice a day with a gentle cleanser', 'Do not squeeze or pick pimples: it can leave marks and scars', 'Use an oil-free moisturiser and sunscreen', 'Avoid harsh scrubs, and do not change products again and again', 'Acne that is painful, leaves marks or stays for months should be seen by a skin doctor'] },
  { re: /pigment|dark spot|melasma/i, hook: 'Dark spots and pigmentation: what to know', search: ['sunscreen skin care', 'woman face skin', 'dermatologist skin check'], tips: ['The sun is the biggest cause of dark spots: use sunscreen every day and reapply outdoors', 'Do not try home remedies or strong creams without advice: some make spots worse', 'A patch that appears suddenly, grows or changes colour should be checked by a doctor', 'Be patient: care takes weeks, and results are different for every person', 'A doctor finds the cause first, then chooses the right care'] },
  { re: /hair|dandruff|scalp|bald/i, hook: 'Hair fall and dandruff: simple care that helps', search: ['hair care', 'woman hair', 'scalp care doctor'], tips: ['Some hair fall every day is normal; sudden or patchy hair fall is a reason to check', 'Eat enough protein, iron and vitamins, and avoid crash diets', 'Wash gently, avoid tight hairstyles and limit heat styling', 'For dandruff, use the shampoo your doctor advises, regularly', 'Hair fall with scalp pain, itching or bald patches needs a skin doctor'] },
  { re: /eczema|allerg|itch|dermatitis/i, hook: 'Eczema and skin allergies: calm, care, comfort', search: ['moisturiser skin care', 'dry skin hand', 'doctor patient consultation'], tips: ['Moisturise dry skin several times a day, especially after a bath', 'Use mild, fragrance-free soap and avoid very hot water', 'Notice what triggers the itching: soaps, dust, some fabrics or foods', 'Do not scratch: keep nails short and wear soft cotton', 'Allergies that keep coming back or cover large areas need a doctor'] },
  { re: /fung|ringworm|tinea/i, hook: 'Fungal skin infections: keep dry, keep clean', search: ['hygiene hand washing', 'clean cotton clothes', 'dermatologist clinic'], tips: ['Keep skin dry, especially skin folds, feet and the groin', 'Wear clean, loose cotton clothes and do not share towels', 'Do not put steroid creams on a rash without a doctor: they can make a fungus worse', 'Wash clothes and bedsheets regularly in hot water', 'A patch that spreads or does not go away needs a doctor'] },
  { re: /wrinkle|ageing|aging|anti-?ag/i, hook: 'Healthy skin as you age', search: ['skin care woman', 'sunscreen', 'healthy glowing skin'], tips: ['Sun protection every day is the best way to slow the ageing of skin', 'Moisturise, sleep well and drink enough water', 'Do not smoke: it speeds up wrinkles', 'Be careful with "instant" anti-ageing products: ask a doctor what suits your skin', 'For any procedure, choose a qualified skin doctor'] },
  { re: /rash/i, hook: 'Skin rashes: when to wait and when to see a doctor', search: ['skin rash doctor', 'doctor examining skin', 'clinic consultation'], tips: ['A rash with fever, swelling of the lips or face, or trouble breathing is an emergency: go to a hospital at once', 'Do not put random creams on a rash: ask first', 'Keep the area clean and avoid scratching', 'Note when it started and what you ate or used, and tell the doctor', 'A rash that spreads, blisters or lasts more than a few days needs a doctor'] },
];
const topicFor = (text) => TOPICS.find((t) => t.re.test(String(text || ''))) || null;
const GENERIC_WORDS = /^(including|services|we offer|what we do|our services|and|the|treatments?|problems?|conditions?)$/i;
// what the client listed in the brief: lines, "- items", bullets, commas after a colon -> short phrases
function topicsOf(brief) {
  const raw = String(brief || '').replace(/\r/g, '\n');
  const chunks = raw.split(/\n|\s-\s|•|;|:/);
  const items = chunks.length > 2 ? chunks.slice(1) : chunks; // before the first marker is the intro sentence ("A dermatologist helps ..., including:")
  const out = [];
  items.forEach((chunk) => chunk.split(',').forEach((x) => {
    const t = x.replace(/^[\s\-•*\d.)]+/, '').replace(/[.\s]+$/, '').trim();
    if (t.length >= 3 && t.length <= 40 && t.split(/\s+/).length <= 6 && !GENERIC_WORDS.test(t) && !out.some((y) => y.toLowerCase() === t.toLowerCase())) out.push(t);
  }));
  return out.slice(0, 12);
}
// Video IDEAS read from the brief, ready to click: one per thing the client listed (health clients: "simple care tips and when to see a doctor"), plus the overview of the whole brief.
function ideasFor({ who, occasion, brief }) {
  const p = profileOf(`${who} ${occasion} ${brief}`);
  const health = HEALTH.has(p.id);
  const listed = topicsOf(brief).filter((t) => topicFor(t) || t.split(/\s+/).length <= 3);
  const ideas = [];
  const seen = new Set();
  listed.forEach((t) => {
    if (ideas.length >= 6) return;
    const known = topicFor(t);
    if (known) { if (seen.has(known)) return; seen.add(known); }
    ideas.push({ label: clip(t, 40), heading: clip(known ? known.hook : t, 70), idea: health ? `${t}: simple care tips and when to see a doctor, for ${clip(who, 50)}` : `${t}: how ${clip(who, 50)} can help you` });
  });
  if (p.hook && ideas.length < 6) ideas.push({ label: 'General tips', heading: p.hook, idea: `${p.hook}: a few simple, useful points for ${p.who}` });
  return ideas;
}

// EXPLAINER VIDEOS (2026-11-24): "a doctor explaining": for a skin client the video does not show a few tips over photos, it EXPLAINS each problem the client treats: what you may see (signs), what
// helps at home, how a doctor helps. One topic = a deep dive (greeting, signs, home care, how the doctor helps, call to action); no topic = an overview (greeting, one scene per problem the client
// listed, call to action). Every scene has the picture words (title + three short rows) and the spoken explanation (say). General education only: it never promises a cure or a result, and says
// "see a doctor" for anything serious. Nothing about the client is invented (no prices, years, awards, treatments they did not list).
const TOPIC_EXTRA = [
  { name: 'Acne and pimples', signs: 'Red or painful bumps, blackheads and whiteheads, mostly on the face, chest and back', treat: 'Your doctor looks at the type and the cause of your acne, then may suggest creams, medicines or other treatments that suit you' },
  { name: 'Pigmentation and dark spots', signs: 'Dark patches or spots on the face or body, often after sun, acne or hormone changes', treat: 'Your doctor finds the cause first, then may suggest sun protection, creams or other treatments' },
  { name: 'Hair fall and dandruff', signs: 'Thinning hair, more hair on the comb, bald patches, or flakes and itching on the scalp', treat: 'Your doctor checks the cause, which can be food, stress, hormones or infection, and then plans the care' },
  { name: 'Eczema and skin allergies', signs: 'Dry, itchy, red skin that may crack or ooze, and keeps coming back', treat: 'Your doctor finds your triggers and may suggest moisturisers and medicines to calm the skin' },
  { name: 'Fungal infections', signs: 'Itchy, round or ring-shaped red patches, often in skin folds, with peeling', treat: 'Your doctor confirms that it is a fungus and gives the right medicine for the right time' },
  { name: 'Wrinkles and ageing skin', signs: 'Fine lines, dry or loose skin and dull colour, mostly on the face, neck and hands', treat: 'Your doctor explains what is safe for your skin type and plans simple care that fits you' },
  { name: 'Skin rashes', signs: 'Red, itchy or bumpy skin that may burn, blister or spread', treat: 'Your doctor finds what caused the rash, such as an allergy or an infection, and treats that cause' },
];
TOPICS.forEach((t, i) => Object.assign(t, TOPIC_EXTRA[i]));
const lower = (t) => { const x = stop(t); return x.charAt(0).toLowerCase() + x.slice(1); };
// can the explainer be made for this client? (a skin client: its topics are written)
const canExplain = (text) => profileOf(text).id === 'skin';
// the first few words of a longer sentence, for a row on the picture
const short = (t, n) => { const whole = stop(t); const first = whole.split(/[:;,]/)[0].trim(); const x = first.length >= 14 ? first : whole; if (x.length <= n) return x; const cut = x.slice(0, n); return cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)); };
function buildExplainer({ who, occasion, brief, n, focus }) {
  const w = clip(who, 50);
  const one = focus ? topicFor(focus) : null;
  const listed = topicsOf(brief).map((t) => topicFor(t)).filter((t, i, a) => t && a.indexOf(t) === i);
  const chosen = one ? [one] : (listed.length ? listed : TOPICS.slice(0, 4)).slice(0, 4);
  const search = (t, i) => t.search[i % t.search.length];
  const scenes = [];
  if (one) {
    scenes.push({ caption: one.hook, bullets: [], say: SAY_OPEN[w.length % SAY_OPEN.length].replace('{who}', w) + ' Today we will talk about ' + one.name.toLowerCase() + '. Please watch till the end.', imagePrompt: one.hook, search: search(one, 0) });
    scenes.push({ caption: one.name + ': what you may see', bullets: one.signs.split(/,| and /).map((x) => ({ label: 'Signs', text: short(x.trim(), 60) })).filter((x) => x.text.length > 2).slice(0, 3), say: 'First, what you may see. ' + stop(one.signs) + '.', imagePrompt: one.name + ' signs', search: search(one, 1) });
    scenes.push({ caption: 'What helps at home', bullets: one.tips.slice(0, 3).map((x) => ({ label: 'At home', text: short(x, 66) })), say: 'At home, ' + lower(one.tips[0]) + '. Also, ' + lower(one.tips[1]) + '. And ' + lower(one.tips[2]) + '.', imagePrompt: one.name + ' care', search: search(one, 2) });
    scenes.push({ caption: 'How a skin doctor helps', bullets: [{ label: 'Doctor', text: 'Examines your skin' }, { label: 'Doctor', text: 'Finds the cause' }, { label: 'Doctor', text: 'Chooses the right care' }], say: stop(one.treat) + '. ' + stop(one.tips[4]) + '.', imagePrompt: 'doctor consultation', search: 'dermatologist consultation' });
  } else {
    scenes.push({ caption: 'Skin and hair problems we help with', bullets: chosen.map((t) => ({ label: 'We help', text: t.name })).slice(0, 4), say: SAY_OPEN[w.length % SAY_OPEN.length].replace('{who}', w) + ' Let us talk about ' + chosen.length + ' common skin and hair problems, what you may see, and how a doctor can help.', imagePrompt: 'dermatologist clinic', search: 'dermatologist clinic' });
    chosen.forEach((t, i) => scenes.push({ caption: t.name, bullets: [{ label: 'Signs', text: short(t.signs, 62) }, { label: 'At home', text: short(t.tips[0], 62) }, { label: 'Doctor', text: 'Finds the cause, then treats it' }], say: t.name + '. You may see: ' + lower(t.signs) + '. At home, ' + lower(t.tips[0]) + '. ' + stop(t.treat) + '.', imagePrompt: t.name, search: search(t, 0) }));
  }
  scenes.push({ caption: w + ': ' + 'Book a consultation', bullets: [], say: 'This is general information, so please speak to your doctor about your own skin. Book a consultation with ' + w + '. We are happy to help.', imagePrompt: 'friendly closing scene', search: 'doctor patient consultation' });
  const headline = one ? one.hook : 'Healthy skin and hair: what to know';
  const caption = [headline + '.', ...scenes.slice(1, -1).map((s) => '• ' + s.caption + (s.bullets && s.bullets[0] ? ': ' + s.bullets[0].text : '')), 'This is general information, not a substitute for a doctor\'s advice.', 'Book a consultation: contact ' + w + '.'].join('\n').slice(0, 1800);
  return { title: clip(w + ': ' + headline, 80), headline: clip(headline, 80), tagline: clip(w, 100), cta: 'Book a consultation', caption, hashtags: ['#SkinCare', '#Dermatology', '#SkinHealth'], scenes, profile: 'skin', explain: true };
}

// WHAT IS SAID (2026-11-23): the voice-over of a video is a person explaining, so each scene gets a spoken line (`say`), longer and warmer than the words on the screen.
// Scene 1 greets and names the topic, the middle scenes give one point each in order, the last one invites the viewer. English only: the lines are built from English words.
const stop = (t) => clip(t, 200).replace(/[.!?\s]+$/, '');
const SAY_OPEN = ['Hello, this is {who}.', 'Namaste, this is {who}.', 'Hello, {who} here.'];
const SAY_POINT = ['Here is the first thing to remember: {t}.', 'Next, {t}.', 'Another important point: {t}.', 'And one more thing: {t}.', 'Please also remember this: {t}.'];
function sayFor(scenes, { who, cta, health }) {
  const w = clip(who, 50);
  return scenes.map((s, i) => {
    const cap = stop(s.caption);
    if (i === 0) return clip(`${SAY_OPEN[w.length % SAY_OPEN.length].replace('{who}', w)} ${cap}. Let us look at a few simple points.`, 240);
    if (i === scenes.length - 1) return clip(`${health ? 'This is general information, so please speak to your doctor about your own case. ' : ''}${stop(cta)} with ${w}. We are happy to help.`, 240);
    return clip(SAY_POINT[(i - 1) % SAY_POINT.length].replace('{t}', cap.charAt(0).toLowerCase() + cap.slice(1)), 240);
  });
}

// A complete plan with no AI service. n = number of scenes (3 to 6). Scene 1 = the hook, the last scene = the call to action, the ones between = useful points.
function buildPlan({ who, occasion, brief, n, focus }) {
  const text = `${who} ${occasion} ${brief}`;
  const p0 = profileOf(text);
  const topic = focus ? topicFor(focus) : null; // a video on ONE topic: that topic's own tips and photo words
  const p = topic && HEALTH.has(p0.id) ? { ...p0, hook: topic.hook, tips: topic.tips, search: topic.search.concat(p0.search) } : (focus ? { ...p0, hook: clip(String(focus).split(':')[0], 70) || p0.hook } : p0);
  const count = Math.max(3, Math.min(6, n || 4));
  const mine = sentences(brief);
  const heading = p.hook || clip(occasion, 60) || clip(mine[0], 60) || `Welcome to ${clip(who, 40)}`;
  const middle = count - 2;
  // useful points: the profile's tips; with no profile, the client's own sentences from the brief
  const pool = p.tips.length ? p.tips : mine;
  const points = pool.slice(0, middle);
  while (points.length < middle) points.push(clip(mine[points.length] || `${clip(who, 40)}: here for you`, 120));
  const scenes = [{ caption: heading, imagePrompt: `A calm, professional, welcoming scene for ${clip(who, 60)}: ${clip(occasion || p.search[0], 60)}. Natural light, real people, clean look.`, search: p.search[0] }];
  points.forEach((t, i) => scenes.push({ caption: clip(t, 120), imagePrompt: `${clip(t, 120)}. Calm, professional, natural light, friendly mood. For ${clip(who, 60)}.`, search: p.search[(i + 1) % p.search.length] }));
  scenes.push({ caption: `${clip(who, 50)}: ${p.cta}`, imagePrompt: `A friendly closing scene for ${clip(who, 60)}, inviting people to get in touch.`, search: p.search[(count - 1) % p.search.length] });
  // what is said, scene by scene (a person explaining)
  const said = sayFor(scenes, { who, cta: p.cta, health: HEALTH.has(p.id) });
  scenes.forEach((s, i) => { s.say = said[i]; });
  const caption = [
    heading + '.',
    ...(p.tips.length ? points.map((t) => `• ${t}`) : []),
    p.tips.length && HEALTH.has(p.id) ? 'This is general information, not a substitute for a doctor\'s advice.' : '',
    `${p.cta}: contact ${clip(who, 60)}.`,
  ].filter(Boolean).join('\n');
  const tags = [...p.tag, ...String(who).split(/\s+/).filter((w) => /^[A-Za-z]{4,}$/.test(w)).slice(0, 1)].map((x) => `#${x.replace(/[^A-Za-z0-9_]/g, '')}`).filter((x) => x.length > 1);
  return { title: clip(`${who}: ${p.hook || occasion || 'video'}`, 80), headline: clip(heading, 80), tagline: clip(who, 100), cta: clip(p.cta, 30), caption: caption.slice(0, 1800), hashtags: [...new Set(tags)], scenes, profile: p.id };
}

// extra instructions for the AI writer when a client brief is the source
function guide(text) {
  const p = profileOf(text);
  const lines = [
    `Write for the client's own customers (${p.who}). The video must be USEFUL to them: a clear idea, practical points they can use, and one gentle call to action. It is not an advertisement that shouts.`,
    'Scene 1 is a strong hook line. The middle scenes each teach one short, accurate, practical point. The last scene is the call to action.',
    'Keep every line short and in plain words. Professional, calm and trustworthy tone.',
  ];
  if (HEALTH.has(p.id)) lines.push('This is a health client: general education only. Say "see a doctor" for anything serious. NEVER promise a cure or a result, never use before / after claims, never scare people, never mention prices or medicines by brand.');
  return lines.join('\n');
}

module.exports = { profileOf, buildPlan, buildExplainer, canExplain, guide, sayFor, ideasFor, topicsOf, topicFor, PROFILES };
