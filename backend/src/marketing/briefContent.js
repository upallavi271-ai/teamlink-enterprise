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
function buildPlan({ who, occasion, brief, n }) {
  const text = `${who} ${occasion} ${brief}`;
  const p = profileOf(text);
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

module.exports = { profileOf, buildPlan, guide, sayFor, PROFILES };
