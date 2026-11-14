// ---------------------------------------------------------------------------
// WHATSAPP TEMPLATES FOR AI MARKETING MESSAGES (2026-11-14). The company's WhatsApp is the OFFICIAL number (Meta Cloud API). Meta lets a business send free text only to a person who wrote to it in the last 24 hours;
// anything else must be an APPROVED TEMPLATE (otherwise Meta answers #131047 "outside the 24-hour window"). The messages TeamLink itself sends in AI Marketing (the updates to a client about their project, and a journey
// message a person approved) therefore use a template when an Admin has set one for that kind of message (AI usage > Telling the client > WhatsApp templates); with none set they go as free text, as before, and the
// email goes too.
//   THE CONTRACT: for each kind the template is filled with exactly these details, in this order, as the template's {{1}} {{2}} {{3}}. The Admin makes a template at Meta (or in Omni-Channel > Templates) with
//   the suggested words below (any wording works as long as the blanks mean the same), waits for approval, and types its exact name here. TeamLink then sends that template with the blanks filled.
// Blanks never contain a line break or a run of spaces (Meta refuses them) and are cut to a sane length. Nothing here sends anything: projects.js and journeys.js call payload().
// ---------------------------------------------------------------------------
const KINDS = {
  invite: { label: 'The request link', category: 'Utility', vars: ['The client\'s first name', 'Our company name', 'The private link'], body: 'Hello {{1}}, this is {{2}}. Please tell us what you need for your creative request on your private page: {{3}} Reply STOP to stop messages about this request.' },
  accepted: { label: 'We have started', category: 'Utility', vars: ['The client\'s first name', 'Our company name', 'What the request is for (for example Diwali offer)'], body: 'Hello {{1}}, thank you for your request. {{2}} has accepted it ({{3}}) and our team has started work. We will message you again as soon as your options are ready. Reply STOP to stop messages about this request.' },
  options: { label: 'The options are ready', category: 'Utility', vars: ['The client\'s first name', 'What the request is for', 'The private link'], body: 'Hello {{1}}, your options for {{2}} are ready. Please open your private page, choose the one you like and add any suggestions: {{3}} Reply STOP to stop messages about this request.' },
  declined: { label: 'We cannot take it up', category: 'Utility', vars: ['The client\'s first name', 'What the request is for', 'The reason we wrote'], body: 'Hello {{1}}, thank you for your request for {{2}}. We are sorry, we cannot take it up this time: {{3}} Reply STOP to stop messages about this request.' },
  posted: { label: 'It is live', category: 'Utility', vars: ['The client\'s first name', 'What the request is for', 'The link(s) to the live post'], body: 'Hello {{1}}, your post for {{2}} is live: {{3}} Thank you for working with us. Reply STOP to stop messages about this request.' },
  journey: { label: 'A journey message to a lead (written by the AI, approved by a person)', category: 'Marketing', vars: ['The lead\'s first name', 'Our company name', 'The message the person approved'], body: 'Hello {{1}}, a message from {{2}}: {{3}} Reply STOP to stop these messages.' },
};
const KEYS = Object.keys(KINDS);
const NAME = /^[a-z0-9_]{1,200}$/;
const LANG = /^[a-z]{2}(_[A-Z]{2})?$/;
const flat = (v, n = 900) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, n);

// what the Admin typed -> the clean map { kind: { name, language } } (a kind with no name is simply not set). -> { value } or { error }
function clean(raw, cur = {}) {
  const out = {};
  for (const k of KEYS) {
    const src = raw && typeof raw === 'object' && raw[k] !== undefined ? raw[k] : cur[k];
    const name = flat(src && src.name, 200).toLowerCase();
    if (!name) continue; // eslint-disable-line no-continue
    if (!NAME.test(name)) return { error: `${KINDS[k].label}: the template name must be lowercase letters, numbers and underscores only, exactly as it is at Meta (for example tl_request_accepted).` };
    const language = flat(src && src.language, 10) || 'en';
    if (!LANG.test(language)) return { error: `${KINDS[k].label}: the language code looks like en, te, hi or en_US.` };
    out[k] = { name, language };
  }
  return { value: out };
}
// the Meta template to send for `kind` and its blanks, or null when none is set (free text then). values: { name, brand, occasion, link, reason, links, message }
function payload(set, kind, values = {}) {
  const t = set && set[kind];
  if (!t || !t.name || !KINDS[kind]) return null;
  const v = {
    invite: [values.name, values.brand, values.link], accepted: [values.name, values.brand, values.occasion], options: [values.name, values.occasion, values.link],
    declined: [values.name, values.occasion, values.reason], posted: [values.name, values.occasion, values.links], journey: [values.name, values.brand, values.message],
  }[kind].map((x) => flat(x) || '-');
  return { template: { name: t.name, language: t.language || 'en' }, vars: v };
}
// the suggested words with the company name filled in, for the screen
const suggestions = () => Object.fromEntries(KEYS.map((k) => [k, { label: KINDS[k].label, category: KINDS[k].category, vars: KINDS[k].vars, body: KINDS[k].body }]));

module.exports = { KINDS, KEYS, clean, payload, suggestions, flat };
