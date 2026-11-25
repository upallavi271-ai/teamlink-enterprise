// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > COPY WRITERS (2026-11-25). The words an SEO fix needs, written with plain code from the client's REAL facts (no AI, no network, no paid service):
//   * titleOptions / metaDescription / h1Options   page titles (at most 60 characters), meta descriptions (70 to 155) and main headings;
//   * altText                                      alternative text for a picture, from what the team says the picture shows;
//   * productDescription                           a product page text from the product facts the team types (nothing about the product is made up);
//   * landingPage                                  a location landing page: title, description, H1, sections, FAQ and business schema, with the facts that exist and a clear "ask the client" where one is missing;
//   * outline                                      the H1 / H2 headings of a service or guide page;
//   * checkText                                    measures a text (words, sentence length, how often the phrase appears, headings) and runs the wording check: real numbers, no invented "SEO score";
//   * draftsFor(key, ctx)                          the copy-ready fix of an audit finding (a meta description, the canonical tag, the FAQ schema ...) for the recommendations list.
// HONEST BY DESIGN: a fact the client has not given is never written. The line is left out and named in `needs`. A result is a DRAFT for the team and the client to read: TeamLink never edits a website.
// ---------------------------------------------------------------------------
const Packs = require('./industryPacks');
const Geo = require('./geoTools');

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const split = (s, max = 15, n = 80) => (Array.isArray(s) ? s : String(s || '').split(/[,;\n]/)).map((x) => clean(x, n)).filter(Boolean).slice(0, max);
const andList = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : (a[0] || ''));
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const low1 = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s); // "Dental implants" in a sentence, "MRI scan" stays
const people = (F) => (F.healthcare ? 'patients' : F.industry === 'education' ? 'students' : 'customers');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const fit = (s, n) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,;:|–-]+$/, '')}`);
const words = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const FACT_KEYS = ['name', 'city', 'state', 'areas', 'services', 'specialty', 'phone', 'email', 'address', 'hours', 'audience', 'since'];

// the facts of a client in one clean shape. input: { industry, name, city, state, areas, services, specialty, phone, email, address, hours, audience, since, website }
function facts(input = {}) {
  const industry = Packs.PACKS[input.industry] ? input.industry : 'other'; const pack = Packs.PACKS[industry];
  const since = Number(input.since); const F = {
    industry, pack, healthcare: pack.healthcare, kind: pack.label.toLowerCase().replace(' / specialist', ''),
    name: clean(input.name, 120), city: clean(input.city, 80), state: clean(input.state, 80), areas: split(input.areas, 12, 60), services: split(input.services, 12, 80), specialty: clean(input.specialty, 80),
    phone: clean(input.phone, 30), email: clean(input.email, 120), address: clean(input.address, 300), hours: clean(input.hours, 200), audience: clean(input.audience, 100), website: clean(input.website, 300),
    since: since > 1900 && since <= new Date().getFullYear() ? since : 0,
  };
  F.primary = F.services[0] || F.specialty || ''; F.loc = F.city ? ` in ${F.city}` : '';
  return F;
}
const needName = () => ({ error: 'Write the business name first (Site and schedule).', status: 400 });

// ---- titles, descriptions, headings ---------------------------------------------------------------------------------------------------------------------------------
function titleOptions(F, o = {}) {
  if (!F.name) return needName();
  const primary = clean(o.topic, 80) || F.primary; if (!primary) return { options: [], needs: ['services'], notes: ['Add the main service (or specialty) to get a title.'] };
  const P = cap1(primary); const two = F.services.length > 1 && !o.topic ? andList(F.services.slice(0, 2).map(cap1)).replace(' and ', ' & ') : '';
  const cands = [`${P}${F.loc} | ${F.name}`, `${F.name}: ${P}${F.loc}`, two ? `${F.name} | ${two}${F.loc}` : `${P} – ${F.name}${F.city ? `, ${F.city}` : ''}`];
  let ok = [...new Set(cands)].filter((t) => t.length >= 15 && t.length <= 60); if (!ok.length) ok = [fit(cands[0], 60)];
  return { options: ok.slice(0, 3).map((t) => ({ text: t, length: t.length })), needs: F.city ? [] : ['city'], notes: ['Search results usually show the first 50 to 60 characters, so the words people search for come first.', ...(F.city ? [] : ['No city is set: add it to get a title with the place.'])] };
}
function metaDescription(F, o = {}) {
  if (!F.name) return needName();
  const primary = clean(o.topic, 80) || F.primary; if (!primary) return { options: [], needs: ['services'], notes: ['Add the main service (or specialty) to get a description.'] };
  const svc = andList((o.topic ? [clean(o.topic, 80)] : F.services.slice(0, 3).length ? F.services.slice(0, 3) : [primary]).map(low1)); const who = F.audience ? ` for ${F.audience}` : ''; const verb = F.healthcare ? 'offers' : 'provides';
  const call = F.phone ? (F.healthcare ? `Call ${F.phone} to book an appointment.` : `Call ${F.phone} to talk to us.`) : `Contact ${F.name} to know more.`;
  const hrs = F.hours && F.hours.length <= 45 ? `Open ${F.hours}.` : '';
  const build = (parts) => { let s = ''; for (const p of parts.filter(Boolean)) { if (!s) s = p.length > 155 ? fit(p, 155) : p; else if (s.length + 1 + p.length <= 155) s += ` ${p}`; } if (s.length < 70) { const x = 'See the services, timings and how to reach us.'; if (s.length + 1 + x.length <= 155) s += ` ${x}`; } return s; };
  const A = build([`${F.name} ${verb} ${svc}${F.loc}${who}.`, call, hrs]);
  const B = build([`Looking for ${low1(primary)}${F.loc}? ${F.name} ${verb} ${F.services.length > 1 && !o.topic ? andList(F.services.slice(0, 3).map(low1)) : low1(primary)}.`, call]);
  const opts = [...new Set([A, B])].filter((t) => t.length >= 50).map((t) => ({ text: t, length: t.length }));
  return { options: opts, needs: [...(F.city ? [] : ['city']), ...(F.phone ? [] : ['phone'])], notes: ['Search results usually show about 155 characters. Check it says what is really on the page.', 'No claim is made: only the facts typed for the client.'] };
}
function h1Options(F, o = {}) {
  if (!F.name) return needName();
  const primary = clean(o.topic, 80) || F.primary; if (!primary) return { options: [], needs: ['services'], notes: ['Add the main service (or specialty) to get a heading.'] };
  const P = cap1(primary); const opts = [...new Set([`${P}${F.loc}`, `${F.name}: ${P}${F.loc}`])].filter((t) => t.length <= 70).map((t) => ({ text: t, length: t.length }));
  return { options: opts, needs: F.city ? [] : ['city'], notes: ['One H1 per page. It should say what the page is about, in the words a visitor would use.'] };
}

// ---- alt text, product text, a location page, an outline -----------------------------------------------------------------------------------------------------------------
function altText(F, o = {}) {
  const what = clean(o.what, 160).replace(/^(an?\s+)?(image|picture|photo|photograph)( of| showing)?\s+/i, '').replace(/[.]+$/, '');
  if (what.length < 3) return { error: 'Write what the picture really shows (for example "doctor talking to a patient at the reception").', status: 400 };
  const base = cap1(what); const withName = F && F.name ? `${base} at ${F.name}${F.city ? `, ${F.city}` : ''}` : base;
  const options = [...new Set([withName, base])].filter((t) => t.length <= 125).map((t) => ({ text: t, length: t.length }));
  return { options: options.length ? options : [{ text: fit(base, 125), length: fit(base, 125).length }], notes: ['Describe what is really in the picture, in about 125 characters or fewer. Do not start with "image of". A picture that is only decoration can have an empty alt text.', ...(F && F.name ? [] : ['Add the business name in Site and schedule to get the version with the name.'])] };
}
function productDescription(F, p = {}) {
  const name = clean(p.name, 120); const what = clean(p.what, 200).replace(/[.]+$/, ''); if (!name) return { error: 'Write the product name.', status: 400 }; if (!what) return { error: 'Write in one line what the product is (for example "a stainless steel water bottle of 750 ml").', status: 400 };
  const feats = split(p.features, 12, 140); const price = clean(p.price, 40); const aud = clean(p.audience, 100); const paras = [`${name} is ${/^(a|an|the)\s/i.test(what) ? what : `a ${what}`}.`];
  if (aud) paras.push(`It is suited to ${aud}.`);
  const bullets = feats.map((x) => `• ${cap1(x.replace(/[.]+$/, ''))}`); if (price) paras.push(`Price: ${price}.`);
  const where = F && F.name ? `Available from ${F.name}${F.city ? ` in ${F.city}` : ''}.${F.phone ? ` Call ${F.phone} to order.` : ''}` : ''; if (where) paras.push(where);
  const text = [paras[0], aud ? paras[1] : '', bullets.length ? `Features:\n${bullets.join('\n')}` : '', price ? `Price: ${price}.` : '', where].filter(Boolean).join('\n\n');
  const meta = fit(`${name}: ${what}.${price ? ` Price ${price}.` : ''}${F && F.phone ? ` Call ${F.phone} to order.` : ''}`, 155); const w = words(text);
  return { name, text, words: w, metaDescription: meta, metaLength: meta.length, title: fit(`${name}${F && F.name ? ` | ${F.name}` : ''}`, 60), needs: [...(feats.length ? [] : ['features']), ...(price ? [] : ['price (only if it should be shown)'])],
    notes: [w < 100 ? 'This is a short text. A product page gets little from a very short description: add real details (materials, sizes, how it is used) that the client confirms.' : 'Check every line against the real product.', 'Only the facts typed here are used: nothing about the product was made up.'] };
}
function faqLines(F, max) { const pack = Packs.buildPack(F.industry, { name: F.name, city: F.city, state: F.state, address: F.address, phone: F.phone, hours: F.hours, services: F.services.join(', '), website: F.website, specialty: F.specialty }); return pack.error ? [] : pack.faq.slice(0, max || 30); }
function landingPage(F, o = {}) {
  if (!F.name) return needName();
  const service = clean(o.service, 80) || F.primary; const location = clean(o.location, 80) || F.city; if (!service) return { error: 'Write the service this page is about (or add the main service in Site and schedule).', status: 400 }; if (!location) return { error: 'Write the area or city this page is for.', status: 400 };
  const where = F.city && location.toLowerCase() !== F.city.toLowerCase() ? `${location}, ${F.city}` : location;
  const title = fit(`${cap1(service)} in ${location} | ${F.name}`, 60); const h1 = `${cap1(service)} in ${where}`;
  const meta = metaDescription({ ...F, city: location, loc: ` in ${location}` }, { topic: service }); const sections = [];
  sections.push({ h2: `${cap1(service)} at ${F.name}`, body: `${F.name} provides ${low1(service)} for people in ${where}.${F.since ? ` ${F.name} has been serving ${people(F)} since ${F.since}.` : ''}${F.specialty && F.specialty.toLowerCase() !== service.toLowerCase() ? ` Main specialty: ${F.specialty}.` : ''}` });
  if (F.services.length > 1) sections.push({ h2: 'Our services', body: F.services.map((x) => `• ${cap1(x)}`).join('\n') });
  const reach = [F.address ? `Address: ${F.address}` : '', F.phone ? `Phone: ${F.phone}` : '', F.hours ? `Hours: ${F.hours}` : ''].filter(Boolean);
  sections.push({ h2: `How to reach us${location ? ` from ${location}` : ''}`, body: reach.length ? reach.join('\n') : 'Add the address, phone and opening hours in Site and schedule.', ask: 'Add how to get here from this area (a landmark, the route, parking, the bus stop): only the client knows it, and it is what makes this page different from the one for another area.' });
  const faq = faqLines(F, 6); if (faq.length) sections.push({ h2: 'Frequently asked questions', body: faq.map((q) => `${q.question}\n${q.ready ? q.answer : '[Answer from the client]'}`).join('\n\n') });
  const ready = faq.filter((q) => q.ready).map((q) => ({ question: q.question, answer: q.answer }));
  const schema = Geo.businessSchema({ industry: F.industry, name: F.name, website: F.website, phone: F.phone, email: F.email, street: F.address, city: F.city, state: F.state, hours: F.hours, services: F.services.join(', '), specialty: F.specialty });
  const text = [`${h1}`, ...sections.map((s) => `${s.h2}\n${s.body}`)].join('\n\n');
  return { url: `/${slug(service)}-in-${slug(location)}`, title, titleLength: title.length, metaDescription: (meta.options && meta.options[0] && meta.options[0].text) || '', h1, sections, text, words: words(text), faqSchema: ready.length ? Geo.faqSchema(ready).script || '' : '', businessSchema: schema.script || '',
    needs: [...(F.address ? [] : ['address']), ...(F.phone ? [] : ['phone']), ...(F.hours ? [] : ['opening hours'])],
    notes: ['Do not copy this page for many areas with only the place name changed: search engines treat near-copies as thin content. Add facts that belong to each area.', 'A line in [brackets] is an answer only the client can give.', ...(F.healthcare ? ['Healthcare: a doctor or qualified medical reviewer approves every medical statement before it is published.'] : [])] };
}
function outline(F, o = {}) {
  const topic = clean(o.topic, 100) || F.primary; if (!topic) return { error: 'Write the topic (or add the main service in Site and schedule).', status: 400 };
  const T = cap1(topic); const guide = o.kind === 'guide'; const name = F.name || 'the business';
  const h2 = guide ? [`What is ${topic}?`, `Who is ${topic} for?`, `What to expect`, `Questions people ask about ${topic}`, `How to reach ${name}`] : [`${T} at ${name}`, `Who ${topic} is for`, `How it works`, `Questions about ${topic}`, `Contact ${name}`];
  return { h1: guide ? `${T}: a clear guide${F.loc}` : `${T}${F.loc}`, h2, notes: ['Under each heading write 2 to 4 short paragraphs from facts the client confirms. Add a list or table where it helps.', 'One H1, then H2 headings; use H3 only inside an H2.'] };
}

// ---- measuring a text ----------------------------------------------------------------------------------------------------------------------------------------------
function checkText(text, phrase, o = {}) {
  const t = String(text || '').replace(/\r/g, ''); const w = words(t); if (w < 5) return { error: 'Paste the text to check (at least a few sentences).', status: 400 };
  const sentences = t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => words(s) >= 2); const avg = sentences.length ? Math.round((sentences.reduce((a, s) => a + words(s), 0) / sentences.length) * 10) / 10 : 0;
  const flags = []; const ph = clean(phrase, 100).toLowerCase(); let phrase1 = null;
  if (ph) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'giu'); const count = (t.match(re) || []).length; const density = Math.round(((count * words(ph)) / w) * 1000) / 10;
    phrase1 = { text: ph, count, density };
    if (!count) flags.push({ level: 'info', text: `The phrase "${ph}" is not used. Use it where it fits naturally: the title, the first paragraph and one heading.` });
    else if (density > 3) flags.push({ level: 'stop', text: `The phrase "${ph}" is ${density}% of the words (${count} times in ${w} words). That reads as repeated. Say it in other words in some places.` });
    else if (density > 2) flags.push({ level: 'review', text: `The phrase "${ph}" is ${density}% of the words (${count} times). Read it aloud: if it sounds repeated, use other words in some places.` });
    else flags.push({ level: 'ok', text: `The phrase "${ph}" appears ${count} time${count === 1 ? '' : 's'} (${density}% of the words): natural.` });
  }
  const heads = t.split('\n').filter((l) => /^\s{0,3}#{1,3}\s+\S/.test(l)).map((l) => l.replace(/^\s*#+\s*/, '').trim());
  if (ph && heads.length && !heads.some((h) => h.toLowerCase().includes(ph))) flags.push({ level: 'info', text: `None of the ${heads.length} headings has the phrase "${ph}". One heading with it helps a reader and a search engine.` });
  if (avg > 25) flags.push({ level: 'review', text: `Sentences are long (${avg} words on average). Shorter sentences are easier to read.` });
  const starts = {}; sentences.forEach((s) => { const k = s.split(/\s+/).slice(0, 3).join(' ').toLowerCase(); starts[k] = (starts[k] || 0) + 1; }); const rep = Object.entries(starts).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0];
  if (rep) flags.push({ level: 'review', text: `${rep[1]} sentences begin with "${rep[0]}". Vary the openings.` });
  if (o.title != null) { const n = clean(o.title, 300).length; if (n > 60) flags.push({ level: 'review', text: `The title is ${n} characters: search results usually cut it near 60.` }); else if (n < 15) flags.push({ level: 'review', text: `The title is only ${n} characters.` }); }
  if (o.description != null) { const n = clean(o.description, 400).length; if (n > 160) flags.push({ level: 'review', text: `The description is ${n} characters: it is usually cut near 155.` }); else if (n < 70) flags.push({ level: 'review', text: `The description is only ${n} characters.` }); }
  if (w < 300 && o.article) flags.push({ level: 'info', text: `${w} words is short for an article. Answer the question fully, with the details a reader needs.` });
  let wording = null; try { wording = require('./contentGuard').check(t, { industry: o.industry, healthcare: Packs.isHealthcare(o.industry) }); } catch { /* the wording check is optional here */ } // eslint-disable-line global-require
  if (wording && wording.stops) flags.push({ level: 'stop', text: `The wording check found ${wording.stops} thing${wording.stops === 1 ? '' : 's'} to change (a promise or a claim). Open the wording check.` });
  else if (wording && wording.reviews) flags.push({ level: 'review', text: `The wording check found ${wording.reviews} thing${wording.reviews === 1 ? '' : 's'} to look at.` });
  return { words: w, sentences: sentences.length, avgSentence: avg, phrase: phrase1, headings: heads.length, flags, wording: wording ? { stops: wording.stops, reviews: wording.reviews, findings: (wording.findings || []).slice(0, 8) } : null, note: 'These are measurements of the text, not a ranking score: nobody can promise how a page will rank.' };
}

// ---- the copy-ready fix of an audit finding ---------------------------------------------------------------------------------------------------------------------------
const needs = (label, list, note) => ({ label, kind: 'needs', value: '', needs: list, note: note || 'Fill these in under Site and schedule (the client facts) and press "Make the text again".' });
const optionsOf = (label, r, note) => { if (!r || r.error) return [needs(label, ['business name'])]; if (!r.options.length) return [needs(label, r.needs || [])]; return r.options.map((o, i) => ({ label: `${label}, option ${i + 1} (${o.length} characters)`, kind: 'text', value: o.text, note: i === 0 ? note || '' : '' })); };
// ctx: { F (facts()), url, report }
function draftsFor(key, ctx) {
  const { F, url, report } = ctx; const rf = (report && report.facts) || {}; const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  switch (key) {
    case 'title': return optionsOf('Page title', titleOptions(F), 'Use ONE of these as the title tag of the home page.');
    case 'description': return optionsOf('Meta description', metaDescription(F), 'Use ONE of these as the meta description of the home page.');
    case 'h1': return optionsOf('Main heading (H1)', h1Options(F), 'Use ONE as the single H1 of the page.');
    case 'altText': {
      const list = (report && report.extra && report.extra.altImages) || []; const tpl = `[what the picture shows]${F.name ? ` at ${F.name}${F.city ? `, ${F.city}` : ''}` : ''}`;
      if (!list.length) return [{ label: 'Alternative text pattern', kind: 'text', value: tpl, note: 'Replace the part in brackets with what is really in each picture (about 125 characters at most).' }];
      return list.slice(0, 10).map((i) => ({ label: `Picture on ${i.page}: ${i.src.split('/').pop().slice(0, 60) || i.src}`, kind: 'text', value: tpl, note: 'Describe what this picture really shows. Use the "Alt text" writer in the Content tab.' }));
    }
    case 'canonical': return [{ label: 'Canonical link (in the page head)', kind: 'code', value: `<link rel="canonical" href="${esc(url)}">`, note: 'Each page needs its own canonical address (its own web address).' }];
    case 'lang': return [{ label: 'Language (on the html tag)', kind: 'code', value: '<html lang="en">', note: 'Use the language of the page (en, te, hi ...).' }];
    case 'viewport': return [{ label: 'Mobile viewport tag (in the page head)', kind: 'code', value: '<meta name="viewport" content="width=device-width, initial-scale=1">', note: '' }];
    case 'robots': case 'robotsBlocksAll': return [{ label: 'robots.txt (at the top of the website)', kind: 'code', value: `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml`, note: key === 'robots' ? 'Add the Sitemap line only once the sitemap file exists.' : 'This lets search engines in. Keep any private folders in separate Disallow lines.' }];
    case 'socialCard': return [{ label: 'Social-card tags (in the page head)', kind: 'code', value: [`<meta property="og:type" content="website">`, `<meta property="og:title" content="${esc(rf.title || (titleOptions(F).options || [{}])[0].text || F.name || '')}">`, `<meta property="og:description" content="${esc(rf.description || ((metaDescription(F).options || [{}])[0] || {}).text || '')}">`, `<meta property="og:url" content="${esc(url)}">`, `<meta property="og:image" content="[full web address of a real picture of the business]">`, `<meta name="twitter:card" content="summary_large_image">`].join('\n'), note: 'Replace the og:image address with a real picture (about 1200 x 630 pixels).' }];
    case 'orgSchema': case 'orgDetails': { if (!F.name) return [needs('Business schema', ['business name'])]; const s = Geo.businessSchema({ industry: F.industry, name: F.name, website: F.website || url, phone: F.phone, email: F.email, street: F.address, city: F.city, state: F.state, hours: F.hours, services: F.services.join(', '), specialty: F.specialty }); return [{ label: 'Business schema (paste in the home page)', kind: 'code', value: s.script, note: `Only the facts typed for the client are in it.${s.missing && s.missing.length ? ` Not yet in it: ${s.missing.join(', ')}.` : ''}`, needs: s.missing || [] }]; }
    case 'faqSchema': { const ready = faqLines(F).filter((q) => q.ready).map((q) => ({ question: q.question, answer: q.answer })); if (!ready.length) return [needs('FAQ schema', ['services', 'phone', 'address or hours'], 'No question can be answered from the facts yet.')]; return [{ label: 'FAQ schema (paste in the page that shows the same questions)', kind: 'code', value: Geo.faqSchema(ready).script, note: 'The same questions and answers must be visible on the page.' }]; }
    case 'faqSection': case 'questionHeadings': { const q = faqLines(F); if (!q.length) return [needs('FAQ', ['business name'])]; return [{ label: key === 'faqSection' ? 'FAQ for the page (questions with the answers the facts give)' : 'Questions to use as headings', kind: 'text', value: q.map((x) => (key === 'faqSection' ? `${x.question}\n${x.ready ? x.answer : '[Answer from the client]'}` : x.question)).join(key === 'faqSection' ? '\n\n' : '\n'), note: 'A line in [brackets] is an answer only the client can give.' }]; }
    case 'nap': { const lines = [F.name, F.address, F.phone ? `Phone: ${F.phone}` : '', F.email ? `Email: ${F.email}` : '', F.hours ? `Hours: ${F.hours}` : ''].filter(Boolean); if (lines.length < 2) return [needs('Name, address and phone block', ['address', 'phone'])]; return [{ label: 'Name, address and phone block (write it the same everywhere)', kind: 'text', value: lines.join('\n'), note: 'Use the same spelling on the website, Google and every directory.' }]; }
    default: return [];
  }
}

module.exports = { facts, titleOptions, metaDescription, h1Options, altText, productDescription, landingPage, outline, checkText, draftsFor, faqLines, FACT_KEYS, clean, split, andList, cap1, slug, words, fit };
