// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > BLOG PLANNER (2026-11-24). The "SEO blogs" of the Premium plan (4 a month) as a real workflow: a month's plan of blog BRIEFS for a client, made with plain code from
//   * the client's own facts (business name, city, services, specialty, phone, website) typed by the team,
//   * what the client has already shown in real data: the Google Search Console queries saved in its monthly report (a query where the website shows at position 4 to 20 is the best blog topic: it is
//     already close), and the latest saved website check (no FAQ, short pages -> the post that fixes it),
//   * a library of topic shapes for healthcare and for other businesses (questions, guides, local, process, choosing, cost, checklist, myths).
// A brief is NOT an article: a working title, the phrase to write for, an outline, the questions to answer, the page title and description (with their lengths), the web address, links to the client's
// other pages and to the other posts of the plan, the schema to add, the facts only the client can give, and, for healthcare, the doctor's review. Nothing here writes, posts or sends anything.
// HONEST BY DESIGN: TeamLink does not know how many people search a phrase and promises no ranking, traffic or lead; healthcare briefs carry no medical statement and need a doctor's review; every fact,
//   price and claim in a post must come from the client. A topic already given to a client in an earlier plan is not given again. The team marks each post Idea / Writing / Published: the posts marked
//   Published in a month are the "SEO blogs" counted by themselves on the client's plan (clientServices.js autoCounts).
// saved per client: table OmniMkBlogPlan; audit log "Omni-Channel AI Marketing: blog plan ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const CS = require('./clientServices');
const Site = require('./siteCheck');
const Packs = require('./industryPacks');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkBlogPlan';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "planId" TEXT, "month" TEXT NOT NULL, "industry" TEXT, "inputs" TEXT, "items" TEXT, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_client" ON "${T}"("clientName", "createdAt")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] blog plan schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const STATUSES = ['idea', 'writing', 'published'];
const STATUS_WORDS = { idea: 'Idea', writing: 'Being written', published: 'Published' };
const DISCLAIMER = "These are plans for blog posts, not finished articles. TeamLink does not know how many people search each phrase and does not promise rankings, traffic or leads: check the phrases in Google Search Console (Performance > Queries) before writing. Every fact, price and claim in a post must come from the client and be real. Healthcare posts are reviewed by a doctor or a qualified medical reviewer before they are published.";
const NOUN = { doctor: ['doctor', 'patients'], clinic: ['clinic', 'patients'], hospital: ['hospital', 'patients'], it: ['company', 'customers'], manufacturing: ['manufacturer', 'customers'], education: ['institute', 'students'], other: ['provider', 'customers'] };

// ---- the topic shapes ({service} {specialty} {city} {name} {provider} {customer}); a blank city removes "in {city}" ---------------------------------------------------------------
const BIZ = [
  { key: 'faq', angle: 'Questions', intent: 'Learning', title: '{service}: your questions answered', phrase: '{service} faq', also: ['{service} questions and answers', 'what to ask about {service}'], words: '900 to 1,300 words', schema: ['Article', 'FAQPage'],
    outline: ['The five questions {customer} ask most about {service}', 'A short answer first, then the detail, under each question', 'What {service} costs and how long it takes (real figures only)', 'What to do next: how to reach {name}'],
    faq: ['What should I know about {service}?', 'How long will {service} take?', 'How much will {service} cost?', 'How do I get started with {service}?', 'What do I need to prepare?'], needs: ['The real questions your {customer} ask', 'Honest answers written by {name}'],
    meta: 'Clear answers to the questions {customer} ask about {service}, from {name}.' },
  { key: 'guide', angle: 'Guide', intent: 'Learning', title: '{service} explained: a plain guide', phrase: 'what is {service}', also: ['{service} explained', '{service} for beginners'], words: '900 to 1,300 words', schema: ['Article', 'FAQPage'],
    outline: ['The short answer, in two sentences', 'Who needs {service}', 'How it works, step by step', 'What it costs and what changes the price (real figures only)', 'How to get started with {name}'],
    faq: ['What should I know about {service}?', 'Who needs {service}?', 'How will {service} work?'], needs: ['Your own plain explanation', 'Typical time and cost, if you can state them'],
    meta: 'A plain guide to {service} from {name}: what to know, the steps and how to get started.' },
  { key: 'local', angle: 'Local', intent: 'Local', title: 'Looking for {service} in {city}? What to know first', phrase: '{service} in {city}', also: ['{service} near me', '{service} {city} contact'], words: '600 to 900 words', schema: ['Article'],
    outline: ['Who {name} helps in {city} and the nearby area', 'What {service} includes at {name}', 'How to reach {name}: address, map and timings', 'How to contact {name}'],
    faq: ['Where can I find {service} in {city}?', 'What are the timings of {name}?'], needs: ['Full address and a landmark', 'Opening hours', 'Phone and WhatsApp number'],
    meta: 'What to know before you choose {service} in {city}, and how to reach {name}.' },
  { key: 'choose', angle: 'Choosing', intent: 'Deciding', title: 'How to choose a {provider} for {service}: questions to ask', phrase: '{service} {provider} in {city}', also: ['how to choose {service}', '{service} {provider} near me'], words: '800 to 1,200 words', schema: ['Article'],
    outline: ['Why the choice matters', 'The questions to ask before you decide', 'Facts you can check yourself (certificates, years of work, references)', 'What to ask {name}', 'How to contact {name}'],
    faq: ['How do I choose a {provider} for {service}?', 'What should I ask before I decide?'], needs: ['The questions in your own words', 'Credentials or certificates that are real and provable'],
    meta: 'The questions to ask before you choose a {provider} for {service}, and what to check.' },
  { key: 'process', angle: 'Process', intent: 'Deciding', title: 'How we do {service} at {name}, step by step', phrase: '{service} process', also: ['how {service} works', '{service} steps'], words: '800 to 1,200 words', schema: ['Article'],
    outline: ['What happens first', 'The steps, one short section each', 'How long each step takes (real timings only)', 'What we need from you', 'How to start with {name}'],
    faq: ['How will {service} work at {name}?', 'How long will it take?'], needs: ['Your real steps and timings'],
    meta: 'How we do {service} at {name}, step by step, and what we need from you.' },
  { key: 'cost', angle: 'Cost', intent: 'Deciding', title: 'The cost of {service} and what changes the price', phrase: '{service} cost in {city}', also: ['{service} price', '{service} charges in {city}'], words: '800 to 1,200 words', schema: ['Article', 'FAQPage'],
    outline: ['The short answer (a range only if you can state it)', 'What changes the price', 'What is included and what is not', 'How to get an exact quote from {name}'],
    faq: ['How much will {service} cost?', 'What changes the price of {service}?'], needs: ['Real price ranges, or say that the price depends and how to get a quote'],
    meta: 'The cost of {service} in {city}, what changes the price, and how to get a quote from {name}.' },
  { key: 'checklist', angle: 'Checklist', intent: 'Learning', title: '{service} checklist: what to prepare', phrase: '{service} checklist', also: ['how to prepare for {service}', '{service} requirements'], words: '600 to 900 words', schema: ['Article'],
    outline: ['Who this checklist is for', 'The checklist, in the order to do it', 'Documents or details to have ready', 'Mistakes to avoid', 'How to ask {name} for help'],
    faq: ['What do I need before {service}?'], needs: ['The real list from your own work'], meta: 'A simple checklist for {service}: what to prepare and what to have ready.' },
  { key: 'mistakes', angle: 'Mistakes', intent: 'Learning', title: 'Common mistakes to avoid with {service}', phrase: '{service} mistakes to avoid', also: ['{service} problems', '{service} tips'], words: '800 to 1,200 words', schema: ['Article'],
    outline: ['Why these mistakes happen', 'One mistake per section: what it is, why it matters, what to do instead', 'How {name} helps you avoid them'], faq: ['Which mistakes are common with {service}?'], needs: ['The mistakes you see most often in your own work'],
    meta: 'The common mistakes with {service} and what to do instead, from {name}.' },
  { key: 'myths', angle: 'Myths', intent: 'Learning', title: '{service}: myths and facts', phrase: '{service} myths', also: ['{service} facts', 'is {service} worth it'], words: '800 to 1,200 words', schema: ['Article'],
    outline: ['Why people believe these myths', 'One myth per section, with the plain fact and its source', 'What this means for you', 'Ask {name}'], faq: ['What do people get wrong about {service}?'], needs: ['The myths your {customer} really repeat', 'A real source for each fact'],
    meta: 'Common myths about {service} and the facts, from {name}.' },
];
const HEALTH = [
  { key: 'faq', angle: 'Questions', intent: 'Learning', title: '{service}: frequently asked questions (doctor reviewed)', phrase: '{service} faq', also: ['{service} questions and answers', 'questions to ask the doctor about {service}'], words: '900 to 1,300 words', schema: ['Article', 'FAQPage'],
    outline: ['The questions {customer} ask most about {service}', 'A short answer first, written or approved by the doctor', 'When to book a visit', 'How to book at {name}'], faq: ['What should I know about {service}?', 'Who should consider {service}?', 'How do I book an appointment for {service}?', 'What should I bring?'], needs: ['The real questions your {customer} ask', 'Answers written or approved by the doctor'],
    meta: 'Questions {customer} ask about {service}, answered with the doctor at {name}.' },
  { key: 'guide', angle: 'Guide', intent: 'Learning', title: '{service} explained by the doctor', phrase: 'what is {service}', also: ['{service} explained', '{service} meaning'], words: '900 to 1,300 words', schema: ['Article', 'FAQPage'],
    outline: ['The short answer (written or approved by the doctor)', 'Who may need {service} (doctor to write)', 'What happens during the visit', 'How to book at {name}'], faq: ['What should I know about {service}?', 'Who may need {service}?'], needs: ['The medical explanation, written or approved by the doctor', 'The doctor\'s name and registration, if shown'],
    meta: 'A plain explanation of {service} by the doctor at {name}.' },
  { key: 'when', angle: 'When to see a doctor', intent: 'Deciding', title: 'When should you see a {specialty} doctor? Signs that should not wait', phrase: 'when to see a {specialty} doctor', also: ['{specialty} doctor in {city}', 'signs to see a {specialty} doctor'], words: '800 to 1,200 words', schema: ['Article', 'FAQPage'],
    outline: ['Why waiting can be a problem (doctor to write)', 'The signs that should not wait (listed and approved by the doctor)', 'What the first visit involves', 'Emergency numbers and how to reach {name}'], faq: ['When should I see a {specialty} doctor?', 'What happens at the first visit?'], needs: ['The list of signs, written or approved by the doctor', 'Emergency contact details'],
    meta: 'The signs that should not wait, and when to see a {specialty} doctor. Approved by the doctor at {name}.' },
  { key: 'first', angle: 'First visit', intent: 'Deciding', title: 'What to expect at your first {specialty} visit', phrase: '{specialty} first visit', also: ['first visit to a {specialty} doctor', 'what to bring to a {specialty} appointment'], words: '600 to 900 words', schema: ['Article'],
    outline: ['Before the visit: booking and what to bring', 'At the clinic: the steps', 'What the doctor will ask', 'After the visit: reports and follow-up', 'How to book at {name}'], faq: ['What should I bring to my first visit?', 'How long does a visit take?'], needs: ['The real steps at your clinic', 'Documents to bring', 'Timings and fees, if you want them shown'],
    meta: 'What happens at your first {specialty} visit at {name}: what to bring and what to expect.' },
  { key: 'prepare', angle: 'Preparing', intent: 'Learning', title: 'How to prepare for {service} (doctor approved)', phrase: 'how to prepare for {service}', also: ['{service} preparation', 'before {service}'], words: '600 to 900 words', schema: ['Article'],
    outline: ['Who this is for', 'Preparation steps (written or approved by the doctor)', 'On the day', 'Questions to ask the doctor'], faq: ['How do I prepare for {service}?'], needs: ['The preparation steps, written or approved by the doctor'], meta: 'How to prepare for {service}, with steps approved by the doctor at {name}.' },
  { key: 'book', angle: 'Local', intent: 'Local', title: 'How to book {service} in {city}: timings, fees and what to bring', phrase: '{service} appointment in {city}', also: ['{service} in {city}', '{service} near me'], words: '600 to 900 words', schema: ['Article'],
    outline: ['Where {name} is and how to reach us', 'Timings and how to book', 'Fees (real figures only) and accepted insurance or schemes', 'What to bring', 'Parking and directions'], faq: ['How do I book {service} in {city}?', 'What are the timings?'], needs: ['Address, landmark, parking', 'Timings', 'Fees and schemes, if you want them shown', 'Phone and WhatsApp number'],
    meta: 'How to book {service} in {city}: timings, what to bring and how to reach {name}.' },
  { key: 'myths', angle: 'Myths', intent: 'Learning', title: 'Myths and facts about {service} (doctor reviewed)', phrase: '{service} myths', also: ['{service} facts', 'is {service} safe'], words: '800 to 1,200 words', schema: ['Article'],
    outline: ['Why these myths spread', 'One myth per section: the plain fact, written or approved by the doctor', 'When to talk to the doctor'], faq: ['What do people get wrong about {service}?'], needs: ['The myths your {customer} really repeat', 'The facts, written by the doctor, with a real source'],
    meta: 'Common myths about {service} and the facts, reviewed by the doctor at {name}.' },
  { key: 'process', angle: 'Process', intent: 'Deciding', title: 'How we do {service} at {name}, step by step', phrase: '{service} process', also: ['how {service} works', '{service} steps'], words: '800 to 1,200 words', schema: ['Article'],
    outline: ['What happens first', 'The steps, one short section each (written or approved by the doctor)', 'How long it takes (real timings only)', 'How to book at {name}'], faq: ['How will {service} work at {name}?'], needs: ['The real steps, written or approved by the doctor'], meta: 'How we do {service} at {name}, step by step.' },
];

// ---- small helpers -------------------------------------------------------------------------------------------------------------------------------------------------------------
const clip = (s, n) => S.clip(s, n) || '';
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const okMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
function sub(tpl, c) { // fill {key}; with no city, "in {city}" disappears
  let t = String(tpl); if (!c.city) t = t.replace(/\s+(?:in|for|near)\s+\{city\}/g, '').replace(/\{city\}\s*/g, '');
  return t.replace(/\{(\w+)\}/g, (m, k) => (c[k] != null && c[k] !== '' ? c[k] : '')).replace(/\s+/g, ' ').replace(/\s+([?.,:;)])/g, '$1').trim();
}
function clipWords(s, n) { if (s.length <= n) return s; const cut = s.slice(0, n + 1); const i = cut.lastIndexOf(' '); return (i > 20 ? cut.slice(0, i) : s.slice(0, n)).replace(/[\s,:;.\-–—]+$/, ''); }
const slugOf = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
function guessIndustry(text) {
  const t = String(text || '').toLowerCase();
  if (/hospital/.test(t)) return 'hospital'; if (/clinic|dental|dentist|diagnostic|\blab\b|pharmacy|scan/.test(t)) return 'clinic'; if (/doctor|physician|surgeon|\bdr\b|specialist|consultant/.test(t)) return 'doctor';
  if (/\bit\b|software|tech|\bweb\b|digital|app\b/.test(t)) return 'it'; if (/manufactur|factory|industrial|fabricat|plant\b/.test(t)) return 'manufacturing'; if (/school|college|institute|universit|academy|educat|training|coaching/.test(t)) return 'education';
  return 'other';
}
function metaTitleOf(title, name) { // up to 60 characters: with the business name if it fits, else without the "(doctor reviewed)" tail, else the part before the colon or question mark
  const bare = title.replace(/\s*\([^)]*\)\s*$/, '').trim(); const head = bare.split(/[:?]/)[0].trim();
  for (const c of [`${title} | ${name}`, `${bare} | ${name}`, title, bare, `${head} | ${name}`, head]) if (c.length >= 10 && c.length <= 60) return c;
  return clipWords(bare, 60);
}
function metaDescOf(meta, cta) { const m = /[.!?]$/.test(meta) ? meta : `${meta}.`; const w = `${m} ${cta}`; return w.length <= 155 ? w : clipWords(m, 155).replace(/[.!?]?$/, '.'); }

// ---- the real data of the client ------------------------------------------------------------------------------------------------------------------------------------------------
async function consoleQueries(clientName) { // the queries of the newest saved Search Console report where the website already shows on page 1 or 2 but not at the top
  try {
    const rows = await S.q('SELECT m.metrics FROM "OmniMkMonthlyMetrics" m JOIN "OmniMkClientPlan" p ON p.id = m.planId WHERE LOWER(TRIM(p.clientName)) = ? ORDER BY m.month DESC LIMIT 3', String(clientName || '').trim().toLowerCase());
    for (const r of rows) { const seo = (S.parse(r.metrics, {}) || {}).seo; const list = seo && Array.isArray(seo.rows) ? seo.rows : []; if (!list.length) continue;
      return list.filter((x) => x && x.label && !/^(https?:)?\/\//i.test(x.label) && !x.label.startsWith('/') && x.label.length <= 80 && Number(x.position) >= 4 && Number(x.position) <= 20 && /[a-z]/i.test(x.label)).sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0)).slice(0, 3); }
  } catch { /* no report saved yet */ }
  return [];
}
async function siteFindings(u, clientName) { // from the newest saved website check: { faq, thin }
  const out = { faq: false, thin: false };
  try { const l = await Site.latestFor(u, clientName); if (!l) return out; const g = await Site.get(u, l.id); const rep = g && g.report; if (!rep) return out;
    out.faq = (rep.actions || []).some((a) => ['faqSection', 'questionHeadings', 'faqSchema'].includes(a.key)); out.thin = (rep.cross || []).some((x) => x.key === 'thin'); } catch { /* no check saved yet */ }
  return out;
}
async function usedTopics(clientName) { // topics already given to this client in earlier plans
  const used = new Set(); if (!(await ensure())) return used;
  for (const r of await S.q(`SELECT items FROM "${T}" WHERE LOWER(TRIM(clientName)) = ?`, String(clientName || '').trim().toLowerCase())) for (const it of S.parse(r.items, [])) if (it && it.topicKey) used.add(it.topicKey);
  return used;
}

// ---- making the plan ------------------------------------------------------------------------------------------------------------------------------------------------------------
function briefText(b, total) {
  const L = [`Blog ${b.n} of ${total}: ${b.title}`, `Why this post: ${b.why}`, `Phrase to write for: ${b.phrase}${b.also.length ? ` (also: ${b.also.join('; ')})` : ''}`, `Length: ${b.words}. What the reader wants: ${b.intent === 'Local' ? 'to find and reach the business' : b.intent === 'Deciding' ? 'help to decide' : 'to learn'}.`, 'Outline:'];
  b.outline.forEach((h, i) => L.push(`  ${i + 1}. ${h}`)); if (b.faq.length) { L.push('Questions to answer (and put in the FAQ at the end):'); b.faq.forEach((q) => L.push(`  - ${q}`)); }
  L.push(`Page title (${b.metaTitle.length} characters): ${b.metaTitle}`, `Page description (${b.metaDescription.length} characters): ${b.metaDescription}`, `Web address: /blog/${b.slug}`);
  if (b.links.length) L.push(`Link to: ${b.links.join('; ')}`); L.push(`End with: ${b.cta}`, `Add structured data: ${b.schema.join(' + ')}`);
  if (b.needs.length) L.push(`Facts the client must give (nothing is invented): ${b.needs.join('; ')}`); if (b.review) L.push(`Before publishing: ${b.review}`);
  return L.join('\n');
}
async function build(u, b = {}) {
  const month = okMonth(b.month) ? b.month : CS.istMonth();
  let plan = null; if (b.planId) { const r = await CS.getPlan(u, String(b.planId), month); if (r.error) return r; plan = r.plan; }
  const clientName = clip(b.clientName, 120) || (plan ? plan.clientName : '');
  const industry = Packs.PACKS[b.industry] ? b.industry : guessIndustry(plan ? plan.industry : '');
  const pack = Packs.PACKS[industry]; const health = !!pack.healthcare; const [provider, customer] = NOUN[industry];
  const name = clip(b.name, 120) || clientName; if (!name) return { error: 'Write the business name.', status: 400 };
  const services = String(b.services || '').split(/[,;\n]/).map((s) => clip(s, 80)).filter(Boolean).slice(0, 6); const specialty = clip(b.specialty, 80);
  if (!services.length && !specialty) return { error: 'Write at least one service or product, for example "heart check-ups, ECG".', status: 400 };
  const svcs = services.length ? services : [specialty]; const city = clip(b.city, 80); const phone = clip(b.phone, 30); const website = clip(b.website, 200);
  const asked = Math.max(1, Math.min(12, Math.round(Number(b.count)) || (plan && plan.quotas && plan.quotas.blogs) || 4));
  const used = await usedTopics(clientName); const notes = []; let skipped = 0;
  const ctxOf = (service) => ({ service, specialty: specialty || service, city, name, provider, customer, phone });
  const cta = phone ? `Call ${phone}.` : `Contact ${name}.`; const metaCta = phone ? `Call ${phone}.` : 'Get in touch.';
  const make = (t, service, source, why) => {
    const c = ctxOf(service); const title = cap1(sub(t.title, c)); const phrase = sub(t.phrase, c);
    return { topicKey: `${t.key}:${service.toLowerCase()}`, source, why, angle: t.angle, intent: t.intent, title, phrase, also: t.also.map((x) => sub(x, c)).filter((x) => x !== phrase && x.toLowerCase() !== phrase.toLowerCase()), words: t.words,
      outline: t.outline.map((x) => sub(x, c)), faq: t.faq.map((x) => sub(x, c)), needs: t.needs.map((x) => sub(x, c)), schema: t.schema, metaTitle: metaTitleOf(title, name), metaDescription: metaDescOf(sub(t.meta, c), metaCta), slug: slugOf(title.replace(/\s*\([^)]*\)\s*$/, '')),
      links: [], cta: cta.replace(/\.$/, ''), review: health ? "A doctor or a qualified medical reviewer must approve this post before it is published." : '' };
  };
  // 1 the real queries (Search Console), 2 the gaps of the website check, 3 the topic shapes for each service, the services taking turns
  const picks = []; const take = (x) => { if (used.has(x.topicKey)) { skipped += 1; return; } if (!picks.some((p) => p.topicKey === x.topicKey || p.title.toLowerCase() === x.title.toLowerCase())) picks.push(x); };
  const queries = await consoleQueries(clientName);
  for (const q of queries) { const label = q.label.trim(); const title = `${cap1(label)}: a clear guide`;
    take({ topicKey: `query:${label.toLowerCase()}`, source: 'searchConsole', why: `Google already shows the website for "${label}" (position ${Math.round(Number(q.position) * 10) / 10}, ${Number(q.impressions) || 0} impressions, ${Number(q.clicks) || 0} clicks in the saved report). A post written for it is the usual way to move up; it is not a guarantee.`,
      angle: 'From Search Console', intent: 'Learning', title, phrase: label, also: [], words: '800 to 1,200 words', outline: ['Answer the question in the first two sentences', 'The detail a person searching for this needs', `What is different about how ${name} does it (real facts only)`, 'Questions people also ask', `How to contact ${name}`], faq: [cap1(label)], needs: ['Real facts about your own service', 'Edit the title so it reads naturally'],
      schema: ['Article', 'FAQPage'], metaTitle: metaTitleOf(title, name), metaDescription: metaDescOf(`A clear answer on ${label}, from ${name}.`, metaCta), slug: slugOf(title.replace(/\s*\([^)]*\)\s*$/, '')), links: [], cta: cta.replace(/\.$/, ''), review: health ? 'A doctor or a qualified medical reviewer must approve this post before it is published.' : '' }); }
  const found = await siteFindings(u, clientName); const set = health ? HEALTH : BIZ; const tpl = (k) => set.find((t) => t.key === k);
  if (found.faq) take(make(tpl('faq'), svcs[0], 'siteCheck', 'The website check found no FAQ section or no FAQ schema: this post gives the website real questions with real answers.'));
  if (found.thin) take(make(tpl('guide'), svcs[0], 'siteCheck', 'The website check found short pages: a full guide gives search engines and visitors more to read.'));
  for (let j = 0; j < set.length; j += 1) for (let i = 0; i < svcs.length; i += 1) take(make(set[(i + j) % set.length], svcs[i], 'customers', `A question or decision ${customer} have about ${svcs[i]}.`));
  const briefs = picks.slice(0, asked).map((x, i) => ({ ...x, n: i + 1 }));
  briefs.forEach((x, i) => { x.links = [`the ${svcs.find((s) => x.topicKey.endsWith(`:${s.toLowerCase()}`)) || svcs[0]} page of the website`, 'the contact page']; if (briefs[i + 1]) x.links.push(`Blog ${i + 2} of this plan`); if (i > 0) x.links.push(`Blog ${i} of this plan`); x.status = 'idea'; x.publishedAt = null; x.url = ''; x.note = ''; x.text = briefText(x, briefs.length); });
  if (briefs.length < asked) notes.push(`Only ${briefs.length} different topic${briefs.length === 1 ? '' : 's'} could be made from the services entered${skipped ? ' and the topics this client already had' : ''}. Add more services or products for more topics.`);
  if (skipped) notes.push('Topics this client already had in an earlier plan are not given again.');
  if (!city) notes.push('No city was given, so the local phrases ("service in city") are left out. Add the city for local search.');
  if (health) notes.push('Every post needs the doctor\'s review before it is published. Outlines carry no medical statement: the doctor writes or approves those parts.');
  notes.push('Titles and questions are filled with the service names you typed: check that each reads naturally (singular or plural) and edit it.');
  notes.push('The search phrases are what customers are likely to type. TeamLink cannot show how many people search each one: check them in Google Search Console and in Google\'s own suggestions.');
  return { plan: { clientName, planId: plan ? plan.id : null, month, industry, industryLabel: pack.label, healthcare: health, name, inputs: { name, city, services: svcs, specialty, phone, website }, asked, made: briefs.length, briefs, notes,
    sources: { searchConsole: queries.length, siteCheck: !!(found.faq || found.thin) }, disclaimer: DISCLAIMER }, department: plan ? plan.department || '' : '' };
}

// ---- saved plans, per client --------------------------------------------------------------------------------------------------------------------------------------------------
const outOf = (r) => { const inp = S.parse(r.inputs, {}) || {}; const briefs = S.parse(r.items, []) || [];
  return { id: r.id, clientName: r.clientName, planId: r.planId || null, month: r.month, industry: r.industry, industryLabel: (Packs.PACKS[r.industry] || {}).label || '', healthcare: Packs.isHealthcare(r.industry), name: inp.name || r.clientName, inputs: inp.inputs || {}, asked: inp.asked || briefs.length, made: briefs.length, briefs, notes: inp.notes || [], sources: inp.sources || {}, disclaimer: DISCLAIMER, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt) }; };
async function plan(u, b = {}) {
  const made = await build(u, b); if (made.error) return made;
  if (!b.save) return { plan: made.plan };
  if (!(await ensure())) return { error: 'The plan could not be saved.', status: 500 };
  const p = made.plan; if (!p.clientName) return { error: 'Write the client name to save the plan.', status: 400 };
  const dept = clip(b.department, 60) || made.department || null; if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('blp'); const now = Date.now();
  await S.run(`INSERT INTO "${T}" (id, clientName, planId, month, industry, inputs, items, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, p.clientName, p.planId, p.month, p.industry, JSON.stringify({ name: p.name, inputs: p.inputs, asked: p.asked, notes: p.notes, sources: p.sources }), JSON.stringify(p.briefs), dept, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: blog plan saved', entity: T, entityId: id, toValue: `${p.clientName}: ${p.month}, ${p.briefs.length} post(s)` });
  return { plan: { ...p, id }, id };
}
async function list(u, o = {}) {
  if (!(await ensure())) return { error: 'The plans could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT * FROM "${T}" ORDER BY createdAt DESC LIMIT 300`)).filter((r) => A.mayDepartment(u, r.department || '')).filter((r) => !o.clientName || r.clientName.toLowerCase() === String(o.clientName).trim().toLowerCase());
  return { items: rows.map((r) => { const briefs = S.parse(r.items, []) || []; return { id: r.id, clientName: r.clientName, month: r.month, count: briefs.length, published: briefs.filter((x) => x.status === 'published').length, writing: briefs.filter((x) => x.status === 'writing').length, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt) }; }) };
}
async function mine(u, id) { if (!(await ensure())) return null; const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, id))[0]; return r && A.mayDepartment(u, r.department || '') ? r : null; }
async function get(u, id) { const r = await mine(u, id); return r ? { plan: outOf(r) } : { error: 'That plan was not found.', status: 404 }; }
// the team moves a post along: Idea -> Being written -> Published (with the address of the live post); the title can be edited and a note kept
async function setItem(u, id, n, b = {}) {
  const r = await mine(u, id); if (!r) return { error: 'That plan was not found.', status: 404 };
  const items = S.parse(r.items, []) || []; const it = items.find((x) => x.n === Number(n)); if (!it) return { error: 'That post is not in the plan.', status: 404 };
  const was = it.status;
  if (b.status != null) { if (!STATUSES.includes(b.status)) return { error: 'The status is Idea, Being written or Published.', status: 400 }; it.status = b.status; }
  if (b.url != null) { const url = clip(b.url, 300); if (url) { let ok = false; try { ok = /^https?:$/.test(new URL(url).protocol); } catch { ok = false; } if (!ok) return { error: 'That is not a web address (start with https://).', status: 400 }; } it.url = url; }
  if (b.note != null) it.note = clip(b.note, 300);
  if (b.title != null) { const title = clip(b.title, 140); if (!title) return { error: 'The title cannot be empty.', status: 400 }; it.title = title; }
  if (it.status === 'published') { if (!it.publishedAt) it.publishedAt = Date.now(); } else it.publishedAt = null;
  await S.run(`UPDATE "${T}" SET items = ?, updatedAt = ? WHERE id = ?`, JSON.stringify(items), Date.now(), id);
  if (was !== it.status) await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: blog post status changed', entity: T, entityId: id, fromValue: was, toValue: `${r.clientName} #${it.n}: ${it.status}` });
  return get(u, id);
}

module.exports = { ensure, plan, build, list, get, setItem, guessIndustry, BIZ, HEALTH, STATUSES, STATUS_WORDS, DISCLAIMER };
