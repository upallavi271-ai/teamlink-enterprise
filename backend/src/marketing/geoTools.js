// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > FAQ & SCHEMA (2026-11-24): the AEO and GEO work of the services document, as things the team can paste into the client's website:
//   * businessSchema(b)  Organization / LocalBusiness / Hospital / MedicalClinic / Physician / EducationalOrganization ... structured data (JSON-LD, the open schema.org vocabulary), from the
//                        client's REAL facts only: an empty field is left out, nothing is guessed.
//   * faqSchema(list)    FAQPage structured data from the questions and answers the client wrote and approved (a question without an answer is left out; the answers must also be shown on the page).
//   * describe(b)        an AI-friendly business description (plain facts, one paragraph) and the Google Business Profile version (at most 750 characters, no links, no offers).
//   * napCheck(places)   does the name, address and phone read the same on the website, Google and the other places (the "consistent business information" of the GEO work)?
// Plain code: no AI, no network, no paid service. It makes the data; the team pastes it. Nothing here posts or changes anything.
// ---------------------------------------------------------------------------
const Packs = require('./industryPacks');

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const DAYS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// "Mon-Sat 9:00-18:00; Sun closed" -> schema.org openingHoursSpecification. Anything that cannot be read is left out (and listed in `unread`).
function parseHours(text) {
  const out = []; const unread = [];
  for (const part of String(text || '').split(/[;\n]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z]{3})[a-z]*(?:\s*[-–to]+\s*([a-z]{3})[a-z]*)?\s*[:,]?\s*(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|(closed))$/i.exec(part);
    if (!m) { unread.push(part); continue; }
    const a = ORDER.indexOf(m[1].toLowerCase()); const b = m[2] ? ORDER.indexOf(m[2].toLowerCase()) : a; if (a < 0 || b < 0) { unread.push(part); continue; }
    if (m[9]) continue; // closed: no entry (a day with no entry is closed)
    const hh = (h, mi, ap) => { let x = Number(h); if (ap) { const p = ap.toLowerCase(); if (p === 'pm' && x < 12) x += 12; if (p === 'am' && x === 12) x = 0; } return `${String(x).padStart(2, '0')}:${mi || '00'}`; };
    const opens = hh(m[3], m[4], m[5]); const closes = hh(m[6], m[7], m[8] || m[5]);
    const days = []; for (let i = a; ; i = (i + 1) % 7) { days.push(DAYS[ORDER[i]]); if (i === b) break; if (days.length > 7) break; }
    out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens, closes });
  }
  return { spec: out, unread };
}
const links = (s) => String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^https?:\/\/[^\s]+$/i.test(x)).slice(0, 12);

// b: { industry, name, website, phone, email, street, city, state, pin, hours, services, specialty, social, logo, description }
function businessSchema(b = {}) {
  const pack = Packs.PACKS[b.industry] || Packs.PACKS.other; const name = clean(b.name, 140);
  if (!name) return { error: 'Write the business name.', status: 400 };
  const o = { '@context': 'https://schema.org', '@type': pack.schema, name };
  const put = (k, v) => { if (v) o[k] = v; };
  put('url', /^https?:\/\//i.test(clean(b.website, 300)) ? clean(b.website, 300) : ''); put('telephone', clean(b.phone, 30)); put('email', clean(b.email, 120)); put('image', /^https?:\/\//i.test(clean(b.logo, 300)) ? clean(b.logo, 300) : '');
  put('description', clean(b.description, 750));
  const street = clean(b.street, 200); const city = clean(b.city, 80); const state = clean(b.state, 80); const pin = clean(b.pin, 12);
  if (street || city || pin) o.address = { '@type': 'PostalAddress', ...(street ? { streetAddress: street } : {}), ...(city ? { addressLocality: city } : {}), ...(state ? { addressRegion: state } : {}), ...(pin ? { postalCode: pin } : {}), addressCountry: 'IN' };
  const { spec, unread } = parseHours(b.hours); if (spec.length) o.openingHoursSpecification = spec;
  const sa = links(b.social); if (sa.length) o.sameAs = sa;
  const spec1 = clean(b.specialty, 120); if (spec1 && pack.healthcare) o.medicalSpecialty = spec1;
  const svc = String(b.services || '').split(/[,;\n]/).map((x) => clean(x, 80)).filter(Boolean).slice(0, 15); if (svc.length) o.knowsAbout = svc;
  const missing = []; if (!o.url) missing.push('website'); if (!o.telephone) missing.push('phone'); if (!o.address) missing.push('address'); if (!o.sameAs) missing.push('social profile links'); if (!o.openingHoursSpecification) missing.push('opening hours');
  return { schema: o, json: JSON.stringify(o, null, 2), script: `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>`, missing, unreadHours: unread, note: 'Put the script in the page head or body of the home page. Use only facts that are also shown on the page. This helps search and AI systems read the business; it does not guarantee any ranking or recommendation.' };
}

// list: [{ question, answer }]
function faqSchema(list) {
  const items = (Array.isArray(list) ? list : []).map((x) => ({ q: clean(strip(x && x.question), 300), a: clean(strip(x && x.answer), 1200) })); const used = items.filter((x) => x.q && x.a); const skipped = items.filter((x) => x.q && !x.a).map((x) => x.q);
  if (!used.length) return { error: 'Write at least one question with its answer.', status: 400 };
  const o = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: used.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) };
  return { schema: o, json: JSON.stringify(o, null, 2), script: `<script type="application/ld+json">\n${JSON.stringify(o, null, 2)}\n</script>`, count: used.length, skipped, note: 'The same questions and answers must be visible on the page. Questions without an answer were left out.' };
}

// the description of a business in plain facts; the GBP version has no links, no prices and no offers
function describe(b = {}) {
  const pack = Packs.PACKS[b.industry] || Packs.PACKS.other; const name = clean(b.name, 140); if (!name) return { error: 'Write the business name.', status: 400 };
  const city = clean(b.city, 80); const state = clean(b.state, 80); const where = [city, state].filter(Boolean).join(', ');
  const svc = String(b.services || '').split(/[,;\n]/).map((x) => clean(x, 80)).filter(Boolean).slice(0, 10); const kind = pack.label.toLowerCase().replace(' / specialist', '');
  const parts = [`${name} is ${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}${where ? ` in ${where}` : ''}.`];
  if (svc.length) parts.push(`It provides ${svc.length > 1 ? `${svc.slice(0, -1).join(', ')} and ${svc[svc.length - 1]}` : svc[0]}.`);
  const yrs = Number(b.since) > 1900 && Number(b.since) <= new Date().getFullYear() ? `${name} has been serving customers since ${Number(b.since)}.` : ''; if (yrs) parts.push(yrs);
  const hrs = clean(b.hours, 200); if (hrs) parts.push(`Opening hours: ${hrs}.`);
  const adr = [clean(b.street, 200), city, clean(b.pin, 12)].filter(Boolean).join(', '); if (adr) parts.push(`Address: ${adr}.`);
  const ph = clean(b.phone, 30); if (ph) parts.push(`Phone: ${ph}.`);
  const long = parts.join(' ');
  const gbpParts = parts.filter((p) => !/^Phone:/.test(p)); let gbp = gbpParts.join(' ').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim(); if (gbp.length > 750) gbp = `${gbp.slice(0, 747).replace(/\s+\S*$/, '')}...`;
  return { description: long, gbp, gbpLength: gbp.length, note: 'Plain facts only. The Google Business Profile version has no links and no offers, and is at most 750 characters. Add real details (what makes the business different, how long it has run) in the client\'s own words.' };
}

// places: [{ place: 'Website', name, address, phone }] -> which items differ from the first (the website or the profile the team trusts)
const norm = (s) => String(s || '').toLowerCase().replace(/[.,;:()\-/#]/g, ' ').replace(/\b(rd|road)\b/g, 'road').replace(/\b(st|street)\b/g, 'street').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
function napCheck(places) {
  const list = (Array.isArray(places) ? places : []).map((p) => ({ place: clean(p && p.place, 60) || 'Place', name: clean(p && p.name, 160), address: clean(p && p.address, 300), phone: clean(p && p.phone, 40) })).filter((p) => p.name || p.address || p.phone).slice(0, 12);
  if (list.length < 2) return { error: 'Enter at least two places to compare (for example the website and Google).', status: 400 };
  const base = list[0]; const issues = [];
  for (const p of list.slice(1)) {
    if (base.name && p.name && norm(base.name) !== norm(p.name)) issues.push({ place: p.place, field: 'name', here: p.name, expected: base.name });
    if (base.address && p.address && norm(base.address) !== norm(p.address)) issues.push({ place: p.place, field: 'address', here: p.address, expected: base.address });
    if (base.phone && p.phone && digits(base.phone) !== digits(p.phone)) issues.push({ place: p.place, field: 'phone', here: p.phone, expected: base.phone });
  }
  return { places: list, reference: base.place, issues, consistent: issues.length === 0, note: `Compared with "${base.place}". Small spelling differences count as differences: write the details the same way everywhere.` };
}
module.exports = { businessSchema, faqSchema, describe, napCheck, parseHours };
