// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > REVIEW REPLIES (2026-11-24): the "customer review monitoring" and "review response drafts" of the services document. The team pastes a review (stars and words) and gets
// three reply DRAFTS written from fixed, careful sentence parts (no AI, no network, nothing is posted): thank, acknowledge, invite to talk. Every draft is run through the wording check (contentGuard.js) so a
// healthcare reply never names a patient, never talks about a person's treatment and never gives advice. The client approves the reply before anyone posts it (the document's rule); posting is done by hand.
// A reply never argues, never denies, never promises a result, and puts no private detail from the review back into public view.
// ---------------------------------------------------------------------------
const Guard = require('./contentGuard');
const Packs = require('./industryPacks');

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const THEMES = [
  ['wait', /\b(wait(?:ing|ed)?|delay(?:ed)?|late|long time|slow|queue)\b/i], ['staff', /\b(staff|doctor|dr\.?|nurse|team|receptionist|rude|behaviou?r|polite|helpful|friendly|attitude|support)\b/i],
  ['clean', /\b(clean|hygien\w*|dirty|smell|washroom|toilet|neat)\b/i], ['price', /\b(price|cost|costly|bill|billing|charges?|expensive|fees?|overcharg\w*|refund)\b/i], ['place', /\b(parking|location|crowd|crowded|space|room|ambience|ambiance|facility|facilities)\b/i],
];
const themesOf = (text) => THEMES.filter(([, re]) => re.test(text || '')).map(([k]) => k);
const firstName = (n) => { const w = clean(n, 60).split(/\s+/)[0] || ''; return /^[A-Za-z][A-Za-z.'-]{1,20}$/.test(w) ? w : ''; };

// the sentence parts. {contact} is only used when the person who replies gave a way to reach them.
const GREET = (nm) => (nm ? `Dear ${nm}, ` : '');
const POS = {
  open: ['Thank you for taking the time to share your feedback.', 'Thank you very much for your kind words.', 'We are grateful that you shared your feedback with us.'],
  theme: { staff: 'We will share your kind words with our team.', clean: 'We are glad that the care we take over cleanliness is noticed.', wait: 'We value your patience.', price: 'We value your honest feedback.', place: 'We are glad you found the place comfortable.' },
  close: ['We look forward to being of help whenever you need us.', 'Your feedback encourages the whole team.', 'Thank you again, and take care.'],
};
const MID = {
  open: ['Thank you for sharing your feedback; it helps us improve.', 'Thank you for your honest feedback.', 'We appreciate you taking the time to tell us how it was.'],
  mid: ['We are glad some things went well and we are sorry that it was not right in every way.', 'We note what could have been better and we will share it with the team.', 'We are pleased with the good parts and we take the rest seriously.'],
  close: ['If you would like to tell us more, please contact us{contact}.', 'We would be glad to hear more{contact}.', 'Please reach out{contact} so we can understand better.'],
};
const NEG = {
  open: ['We are sorry to read this.', 'We are sorry that this was not what you expected.', 'Thank you for telling us, and we are sorry to hear it.'],
  theme: { wait: 'We understand how much your time matters.', staff: 'We take the way we treat people very seriously.', clean: 'We take cleanliness very seriously.', price: 'We understand that clear charges matter.', place: 'We want everyone to be comfortable.' },
  mid: ['We would like to understand what happened and put it right.', 'We would like to look into this properly.', 'We want to look into this carefully with you.'],
  close: ['Please contact us{contact} so that we can speak with you.', 'Could you please reach out{contact}? We would like to help.', 'We would be grateful if you could contact us{contact}.'],
};
const withContact = (s, contact) => s.replace('{contact}', contact ? ` on ${contact}` : '');

// b: { rating 1-5, text, reviewerName, business, industry, contact }
function draft(b = {}) {
  const rating = Math.round(Number(b.rating)); if (!(rating >= 1 && rating <= 5)) return { error: 'Choose the stars (1 to 5).', status: 400 };
  const text = clean(b.text, 3000); const industry = Packs.PACKS[b.industry] ? b.industry : 'other'; const health = Packs.isHealthcare(industry);
  const contact = clean(b.contact, 60); const nm = health ? '' : firstName(b.reviewerName); const business = clean(b.business, 120);
  const band = rating >= 4 ? 'positive' : rating === 3 ? 'mixed' : 'negative'; const themes = themesOf(text); const theme = themes[0];
  const set = band === 'positive' ? POS : band === 'mixed' ? MID : NEG; const drafts = [];
  for (let i = 0; i < 3; i += 1) {
    const parts = [set.open[i]];
    if (band !== 'mixed' && theme && set.theme[theme] && i !== 1) parts.push(set.theme[theme]);
    if (set.mid) parts.push(set.mid[i]);
    parts.push(withContact(set.close[i], contact));
    let reply = `${GREET(nm)}${parts.join(' ')}`; if (business && i === 2 && band === 'positive') reply += ` – ${business}`;
    const g = Guard.check(reply, { industry }); drafts.push({ id: i + 1, text: reply, verdict: g.verdict, flags: g.findings.map((f) => ({ level: f.level, why: f.why })) });
  }
  const notes = ['Show the client the reply and get the approval before it is posted.'];
  if (band === 'negative') notes.push('Do not argue, deny or explain the case in public. Invite the person to talk offline.');
  if (health) notes.push('Healthcare: never confirm the person was a patient, never mention treatment, reports or admission, and do not repeat medical details from the review.');
  if (!contact && band !== 'positive') notes.push('Add a phone number or email in "how to reach us" so the reply can invite the person to talk.');
  if (/\b\d{10}\b|@/.test(text)) notes.push('The review contains a phone number or email: do not repeat it in the reply.');
  return { band, themes, drafts, notes, healthcare: health, tone: Packs.PACKS[industry].tone };
}
module.exports = { draft, themesOf };
