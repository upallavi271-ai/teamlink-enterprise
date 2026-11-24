// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > INDUSTRY PACKS (2026-11-24). The target customers of the services document (doctors, clinics, hospitals, IT companies, manufacturing companies, educational
// institutions, other businesses): for each, ready starting material that a person fills with the REAL facts of the client:
//   * FAQ questions (the AEO work), with an answer only where the client's own facts give one (address, phone, hours, services); every other answer is left empty for the client to write,
//   * 30 post ideas for the month (the content plan), local search phrases (research, never a claim), Google Business Profile category ideas, the review-reply tone, and the rules of the trade.
// Plain data and plain code: no AI, no network, nothing invented about the client. Healthcare packs carry the document's quality policy (no false claims, no guaranteed cures, patient permission).
// ---------------------------------------------------------------------------
const FACT = {
  name: 'the business name', city: 'the city', address: 'the full address', phone: 'the phone number', hours: 'the opening hours', services: 'the main services', website: 'the website', specialty: 'the main specialty or service',
};
const COMMON_FAQ = [
  { q: 'Where is {name} located?', a: '{name} is at {address}.', needs: ['name', 'address'] },
  { q: 'What are the opening hours of {name}?', a: '{name} is open {hours}.', needs: ['name', 'hours'] },
  { q: 'How can I contact {name}?', a: 'You can call {name} on {phone}.', needs: ['name', 'phone'] },
  { q: 'What services does {name} provide?', a: '{name} provides {services}.', needs: ['name', 'services'] },
];
const HEALTH_COMMON = [
  { q: 'How do I book an appointment at {name}?', a: 'Call {name} on {phone} to book an appointment.', needs: ['name', 'phone'] },
  { q: 'What should I bring for my first visit?', a: '', needs: [] },
  { q: 'Which insurance and health schemes are accepted?', a: '', needs: [] },
  { q: 'What are the consultation fees?', a: '', needs: [] },
  { q: 'Is parking available?', a: '', needs: [] },
  { q: 'How do I get my reports?', a: '', needs: [] },
];
const HEALTH_RULES = [
  'Medical content is reviewed by a doctor or a qualified medical reviewer before it is published.',
  'No guarantee of a cure or of a result; no "100%" claims; no claims that a treatment has no risk or no side effects.',
  'Patient photographs, names and testimonials need the patient\'s written permission, and may be restricted for promotion; when in doubt, leave them out.',
  'Confidential patient information is never put in a post, a review reply or a public AI tool.',
  'Superlatives such as "best" or "No. 1" need documentary proof; prefer plain facts (years of service, departments, equipment, accreditations that are real).',
];
const HEALTH_POSTS = [
  'Meet the team: one doctor or department each week (with their permission)', 'What to expect at your first visit', 'A short health tip written or approved by the doctor', 'Our facilities: reception, waiting area, labs (no patients in the picture)',
  'How to book an appointment: the three steps', 'Opening hours and holiday hours reminder', 'Myth or fact: one common question, answered by the doctor', 'Our equipment and what it is used for', 'Hygiene and safety steps we follow',
  'Festival greeting from the team', 'World Health Day (7 April): a simple awareness post', 'World Heart Day (29 September): a simple awareness post', 'World Diabetes Day (14 November): a simple awareness post', 'Seasonal health reminder (monsoon, summer, winter)',
  'FAQ of the week: one question from the website FAQ', 'When to see a doctor: signs that should not wait (doctor approved)', 'Our timings for the week ahead', 'Staff appreciation and training update', 'Health camp or awareness talk announcement (real dates only)',
  'Healthy-living tip: food, sleep or walking', 'Child and elder care reminder', 'Emergency contact numbers and how to reach us', 'Behind the scenes: how a department runs a day', 'Thank you to the community on an anniversary or milestone (real facts only)',
  'Our services at a glance (a clear list)', 'Language support: which languages our staff speak', 'How to prepare for a test or a procedure (doctor approved)', 'Patient safety week: a reminder', 'New service or new doctor joining (real, approved)', 'Month in review: what we did',
];
const BIZ_POSTS = [
  'Meet the team: one person each week', 'One service explained in plain words', 'A customer question answered (from the FAQ)', 'Behind the scenes: how we work', 'Our process in three steps', 'Festival greeting from the team',
  'A tip for our customers', 'Our office or workshop in pictures', 'New service or new capability (real facts)', 'A short case in plain facts (only with the client\'s permission)', 'Opening hours and holiday hours', 'How to contact us',
  'Staff training or certification update', 'A myth or fact about our industry', 'Month in review', 'Thank you to our customers on a milestone (real facts only)', 'Our values and how we apply them', 'A day in the life of a team member',
  'Industry news in one paragraph with our view', 'Hiring: an open role (real)', 'Checklist our customers can use', 'How we keep quality: the steps', 'Our tools and technology', 'A question we hear often, answered',
  'Community or CSR activity (real)', 'Safety and compliance reminder', 'Our history in one picture', 'Product or service of the month', 'What is new this month', 'Plan for next month',
];
const PACKS = {
  doctor: { label: 'Doctor / specialist', schema: 'Physician', healthcare: true, gbp: ['Doctor', 'Medical clinic', 'Specialist physician'], tone: 'warm, calm and respectful; never confirms a person was a patient; never gives medical advice in a reply',
    faq: [...COMMON_FAQ.slice(0, 3), { q: 'What does {name} treat?', a: '{name} treats {services}.', needs: ['name', 'services'] }, { q: 'When should I consult a {specialty} doctor?', a: '', needs: [] }, ...HEALTH_COMMON, { q: 'What qualifications and registration does the doctor have?', a: '', needs: [] }, { q: 'Do you offer online consultations?', a: '', needs: [] }],
    posts: HEALTH_POSTS, keywords: ['{specialty} doctor in {city}', '{specialty} specialist near me', 'doctor for {service} in {city}', '{specialty} consultation {city}', 'appointment with {specialty} doctor {city}'], rules: HEALTH_RULES },
  clinic: { label: 'Clinic', schema: 'MedicalClinic', healthcare: true, gbp: ['Medical clinic', 'Clinic', 'Health consultant'], tone: 'warm, calm and respectful; never confirms a person was a patient; never gives medical advice in a reply',
    faq: [...COMMON_FAQ, ...HEALTH_COMMON, { q: 'Which doctors consult at {name}?', a: '', needs: [] }, { q: 'Do you accept walk-ins?', a: '', needs: [] }],
    posts: HEALTH_POSTS, keywords: ['{specialty} clinic in {city}', 'clinic near me {city}', '{service} treatment in {city}', '{specialty} clinic {city} appointment', 'family clinic {city}'], rules: HEALTH_RULES },
  hospital: { label: 'Hospital', schema: 'Hospital', healthcare: true, gbp: ['Hospital', 'Multi-specialty hospital', 'Emergency care service'], tone: 'warm, calm and respectful; never confirms a person was a patient; never gives medical advice in a reply',
    faq: [...COMMON_FAQ, { q: 'What departments does {name} have?', a: '', needs: [] }, { q: 'Is emergency care available 24 hours?', a: '', needs: [] }, { q: 'What documents are required for admission?', a: '', needs: [] }, { q: 'Which insurance and health schemes are accepted?', a: '', needs: [] }, { q: 'How do I book an appointment at {name}?', a: 'Call {name} on {phone} to book an appointment.', needs: ['name', 'phone'] }, { q: 'What are the visiting hours?', a: '', needs: [] }, { q: 'How do I get my reports and discharge summary?', a: '', needs: [] }, { q: 'Is there an ambulance service?', a: '', needs: [] }, { q: 'How do I reach {name} by bus, metro or car?', a: '', needs: [] }],
    posts: HEALTH_POSTS, keywords: ['{specialty} hospital in {city}', 'multispecialty hospital {city}', 'hospital near me {city}', '{service} treatment hospital {city}', 'emergency hospital {city}'], rules: HEALTH_RULES },
  it: { label: 'IT company', schema: 'ProfessionalService', healthcare: false, gbp: ['Software company', 'IT services', 'Computer consultant'], tone: 'professional and helpful; thanks the person, answers facts, offers to talk',
    faq: [...COMMON_FAQ, { q: 'What technologies does {name} work with?', a: '', needs: [] }, { q: 'How does a project with {name} start?', a: '', needs: [] }, { q: 'How are projects priced?', a: '', needs: [] }, { q: 'Do you offer support after delivery?', a: '', needs: [] }, { q: 'Can I see examples of your work?', a: '', needs: [] }, { q: 'Which industries do you serve?', a: '', needs: [] }],
    posts: BIZ_POSTS, keywords: ['{service} company in {city}', 'software development {city}', '{service} services near me', 'IT support {city}', '{service} company for small business {city}'], rules: ['Case studies and client names only with the client\'s written permission.', 'No guaranteed rankings, leads or results.'] },
  manufacturing: { label: 'Manufacturing company', schema: 'Organization', healthcare: false, gbp: ['Manufacturer', 'Industrial equipment supplier', 'Factory'], tone: 'professional and helpful; thanks the person, answers facts, offers to talk',
    faq: [...COMMON_FAQ, { q: 'What products does {name} manufacture?', a: '{name} manufactures {services}.', needs: ['name', 'services'] }, { q: 'What is the minimum order quantity?', a: '', needs: [] }, { q: 'Which certifications does {name} hold?', a: '', needs: [] }, { q: 'Do you supply across India or export?', a: '', needs: [] }, { q: 'How do I request a quotation?', a: 'Call {name} on {phone} to request a quotation.', needs: ['name', 'phone'] }, { q: 'What is the usual delivery time?', a: '', needs: [] }],
    posts: BIZ_POSTS, keywords: ['{service} manufacturer in {city}', '{service} supplier {city}', '{service} factory near me', 'buy {service} {city}', '{service} manufacturers in {state}'], rules: ['Certifications, capacities and client names only when they are real and provable.', 'No guaranteed results.'] },
  education: { label: 'Educational institution', schema: 'EducationalOrganization', healthcare: false, gbp: ['School', 'College', 'Educational institution', 'Training center'], tone: 'warm and encouraging; thanks the person, answers facts, offers to talk',
    faq: [...COMMON_FAQ, { q: 'What courses or classes does {name} offer?', a: '{name} offers {services}.', needs: ['name', 'services'] }, { q: 'How do I apply for admission to {name}?', a: '', needs: [] }, { q: 'What are the fees?', a: '', needs: [] }, { q: 'What documents are needed for admission?', a: '', needs: [] }, { q: 'Is there a hostel or transport facility?', a: '', needs: [] }, { q: 'Which affiliation or recognition does {name} have?', a: '', needs: [] }],
    posts: BIZ_POSTS.map((p) => p.replace('customers', 'students and parents')), keywords: ['{service} college in {city}', '{service} course in {city}', '{service} institute near me', 'admission {service} {city}', '{service} training in {city}'], rules: ['Results, rankings and placements only when real and provable; no guaranteed admission or placement.', 'Photos of students need parent or guardian permission.'] },
  other: { label: 'Other business', schema: 'LocalBusiness', healthcare: false, gbp: [], tone: 'professional and helpful; thanks the person, answers facts, offers to talk',
    faq: [...COMMON_FAQ, { q: 'How can I place an order or book {name}?', a: 'Call {name} on {phone}.', needs: ['name', 'phone'] }, { q: 'What are your prices?', a: '', needs: [] }, { q: 'Do you offer a guarantee or warranty?', a: '', needs: [] }],
    posts: BIZ_POSTS, keywords: ['{service} in {city}', '{service} near me', '{service} {city} contact', 'buy {service} {city}'], rules: ['Only real facts; no guaranteed results.'] },
};
const INDUSTRIES = Object.entries(PACKS).map(([key, p]) => ({ key, label: p.label, healthcare: p.healthcare, schema: p.schema }));
const isHealthcare = (industry) => Boolean(PACKS[industry] && PACKS[industry].healthcare);
const FIELD = /\{(\w+)\}/g;
function fill(tpl, ctx) { const missing = []; const text = String(tpl || '').replace(FIELD, (m, k) => { const v = ctx[k] != null ? String(ctx[k]).trim() : ''; if (!v) { missing.push(k); return m; } return v; }); return { text, missing: [...new Set(missing)] }; }
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// the pack for one client: ctx = { name, city, state, address, phone, hours, services, website, specialty }
function buildPack(industry, input = {}) {
  const p = PACKS[industry]; if (!p) return { error: 'Pick the kind of business.', status: 400 };
  const ctx = {}; for (const k of ['name', 'city', 'state', 'address', 'phone', 'hours', 'services', 'website', 'specialty']) ctx[k] = clean(input[k], k === 'address' || k === 'services' ? 300 : 120);
  ctx.service = ctx.services ? ctx.services.split(/[,;\n]/)[0].trim() : ctx.specialty; const fq = ctx.specialty || ctx.service;
  const faq = p.faq.map((f) => { const q = fill(f.q, { ...ctx, specialty: fq }); const a = f.a ? fill(f.a, ctx) : { text: '', missing: [] }; const ready = f.a && !a.missing.length; return { question: q.text, answer: ready ? a.text : '', ready: Boolean(ready), askClient: !f.a, needs: [...new Set([...q.missing, ...a.missing])].map((k) => FACT[k] || k) }; });
  const posts = p.posts.map((t, i) => ({ day: i + 1, idea: fill(t, ctx).text }));
  const kw = []; for (const pat of p.keywords) { const r = fill(pat, { ...ctx, specialty: fq, service: ctx.service || fq }); if (!r.missing.length) kw.push(r.text); }
  return { industry, label: p.label, healthcare: p.healthcare, schemaType: p.schema, faq, posts, keywords: [...new Set(kw)], gbpCategories: p.gbp, replyTone: p.tone, rules: p.rules, ctx,
    note: 'Answers are written only from the facts you entered. Every empty answer must be written by the client. Search phrases are for research, not for claims.' };
}
module.exports = { INDUSTRIES, PACKS, isHealthcare, buildPack, fill };
