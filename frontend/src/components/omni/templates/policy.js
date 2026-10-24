// ---------------------------------------------------------------------------
// WHATSAPP TEMPLATE POLICY CHECK, browser copy of backend/src/outreach/tplPolicy.js (keep the two files the same; the server runs it again when a template is saved or sent).
// Pure function: check(t) -> { issues: [{ severity, code, rule, message, fix, field }], errors, warnings, missing, counts, verdict }.
// ---------------------------------------------------------------------------
const VARS = ['name', 'job_title', 'company', 'apply_link', 'unsubscribe'];
const VAR_WORDS = { name: 'Their name', job_title: 'Job title', company: 'Company', apply_link: 'Apply link', unsubscribe: 'Opt-out line' };
const SAMPLE = { name: 'Anita', job_title: 'ICU Staff Nurse', company: 'City Care Hospital', apply_link: 'https://example.org/jobs/apply?cid=SAMPLE', unsubscribe: 'Reply STOP to opt out' };
const CATEGORIES = ['Marketing', 'Utility', 'Authentication'];
const CODE_WORDS = {
  INVALID_FORMAT: 'The template structure or the variables do not meet WhatsApp requirements.',
  TAG_CONTENT_MISMATCH: 'The chosen category does not match what the message says.',
  ABUSIVE_CONTENT: 'The content breaks WhatsApp Business or Commerce policy.',
  SCAM: 'The content looks like it asks for private information or pretends to be someone else.',
  INCORRECT_CATEGORY: 'A different category fits this content.',
  PROMOTIONAL: 'Promotional content is not allowed in this category.',
};
const LIMITS = { body: 1024, footer: 60, header: 60, button: 25, buttons: 10, name: 80 };

const varsIn = (text) => [...String(text || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

// named -> positional: { text (body with {{1}}..), params: [{ index, name, example }] }
function mapping(text) {
  const order = [];
  const out = String(text || '').replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, v) => {
    if (!VARS.includes(v)) return m;
    let i = order.indexOf(v);
    if (i < 0) { order.push(v); i = order.length - 1; }
    return `{{${i + 1}}}`;
  });
  return { text: out, params: order.map((v, i) => ({ index: i + 1, name: v, words: VAR_WORDS[v], example: SAMPLE[v] })) };
}

const PROMO = /\b(offers?|discounts?|sale|\d+\s?%\s?off|free|buy now|limited time|hurry|deals?|coupons?|promo|cashback|lowest price|shop now|order now|flat|save big|exclusive offer|best price|upgrade now|subscribe now)\b/i;
const SENSITIVE = /\b(password|otp code|cvv|card number|aadhaar|aadhar|pan number|ssn|account number|upi pin|atm pin|bank pin|net ?banking)\b/i;
const RESTRICTED = /\b(gambling|casino|betting|lottery|alcohol|liquor|whisky|tobacco|cigarette|dating|escort|mlm|multi-?level|weapons?|firearms?|guns?|narcotics?|drugs?|get rich|guaranteed returns|double your money)\b/i;
const THREAT = /\b(or else|we will find you|you will regret|last warning|legal action will be taken|arrest|we know where you)\b/i;
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co\/|ow\.ly|rebrand\.ly|cutt\.ly|is\.gd|shorturl\.at)/i;
const OPT_OUT = /\b(stop|unsubscribe|opt[\s-]?out)\b/i;
const AUTH_WORDS = /\b(code|otp|verification|verify|password|passcode)\b/i;

function check(t0) {
  const t = t0 || {};
  const issues = [];
  const add = (severity, code, rule, message, fix, field) => issues.push({ severity, code, rule, message, fix: fix || '', field });
  const name = String(t.name || '').trim();
  const body = String(t.body || '');
  const footer = String(t.footer || '');
  const category = CATEGORIES.includes(t.category) ? t.category : 'Utility';
  const buttons = Array.isArray(t.buttons) ? t.buttons : [];
  const headerType = t.headerType || 'none';
  const headerText = String(t.headerText || '');
  const bodyVars = varsIn(body);

  if (!name) add('error', 'INVALID_FORMAT', 'Template name', 'Template name is required.', 'Give the template a name.', 'name');
  else {
    if (name.length > LIMITS.name) add('error', 'INVALID_FORMAT', 'Template name', `The name is too long (${LIMITS.name} letters at most).`, 'Shorten the name.', 'name');
    if (!/^[a-z0-9_]+$/.test(name)) add('info', 'INVALID_FORMAT', 'Template name', 'WhatsApp allows only lowercase letters, numbers and underscores.', `It will be sent to Meta as "${slug(name)}".`, 'name');
  }
  if (!body.trim()) add('error', 'INVALID_FORMAT', 'Message body', 'Message body cannot be empty.', 'Write the message.', 'body');
  else {
    if (body.length > LIMITS.body) add('error', 'INVALID_FORMAT', 'Message length', `The message is ${body.length} letters; the limit is ${LIMITS.body}.`, 'Make it shorter.', 'body');
    const bad = bodyVars.filter((v, i) => !VARS.includes(v) && bodyVars.indexOf(v) === i);
    if (bad.length) add('error', 'INVALID_FORMAT', 'Variables', `${bad.map((v) => `{{${v}}}`).join(', ')} ${bad.length > 1 ? 'are not known words' : 'is not a known word'}.`, `Use only: ${VARS.map((v) => `{{${v}}}`).join(' ')}.`, 'body');
    const trimmed = body.trim();
    if (/^\{\{[^{}]*\}\}/.test(trimmed)) add('error', 'INVALID_FORMAT', 'Variables', 'The message cannot start with a variable.', 'Put a few words before the first variable, like "Hi {{name}}".', 'body');
    if (/\{\{[^{}]*\}\}[\s.!?,;:]*$/.test(trimmed)) add('error', 'INVALID_FORMAT', 'Variables', 'The message cannot end with a variable.', 'Add a closing line after the last variable.', 'body');
    if (/\{\{[^{}]*\}\}\s*\{\{[^{}]*\}\}/.test(body)) add('error', 'INVALID_FORMAT', 'Variables', 'Variables cannot sit next to each other with no text between them.', 'Put words between the variables.', 'body');
    if (bodyVars.length) {
      const plain = body.replace(/\{\{[^{}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
      const words = plain ? plain.split(' ').length : 0;
      if (plain.length < 8) add('error', 'INVALID_FORMAT', 'Variables', 'Almost the whole message is variables, so the real content cannot be reviewed.', 'Write more fixed words around the variables.', 'body');
      else if (bodyVars.length / (words + bodyVars.length) > 0.5) add('warn', 'INVALID_FORMAT', 'Variable density', 'Many variables for the words you wrote; reviewers often refuse these.', 'Add more fixed text.', 'body');
    }
    if (SHORTENERS.test(body) || buttons.some((b) => SHORTENERS.test(b.url || ''))) add('error', 'INVALID_FORMAT', 'Links', 'Shortened links (bit.ly, tinyurl and the like) are not allowed, because the real place cannot be reviewed.', 'Use the full link.', 'body');
    if (/wa\.me\//i.test(body) || buttons.some((b) => /wa\.me\//i.test(b.url || ''))) add('error', 'INVALID_FORMAT', 'Links', 'wa.me links are not allowed inside a template.', 'Use a "Call on WhatsApp" button or the full website link.', 'body');
    if (category !== 'Marketing' && PROMO.test(`${body} ${headerText} ${footer}`)) add('error', 'TAG_CONTENT_MISMATCH', 'Category', `The message has promotional words ("${(`${body} ${headerText} ${footer}`.match(PROMO) || [''])[0]}") but the category is ${category}.`, 'Change the category to Marketing, or remove the promotional words.', 'category');
    if (category === 'Authentication') {
      if (!AUTH_WORDS.test(body)) add('error', 'INCORRECT_CATEGORY', 'Category', 'An Authentication message must be about a code (code, OTP, verify, password).', 'Mention the code, or pick another category.', 'category');
      if (buttons.length > 1) add('error', 'INVALID_FORMAT', 'Buttons', 'An Authentication message can have only one button.', 'Keep one button.', 'buttons');
      if (bodyVars.length > 1) add('warn', 'INVALID_FORMAT', 'Variables', 'An Authentication message normally has just the code as a variable.', 'Use one variable.', 'body');
    }
    if (category === 'Marketing' && !OPT_OUT.test(`${body} ${footer}`) && !bodyVars.includes('unsubscribe')) add('warn', 'PROMOTIONAL', 'Opt-out', 'A marketing message should show people how to stop it.', 'Add "Reply STOP to unsubscribe" to the footer, or {{unsubscribe}} to the message.', 'footer');
    if (SENSITIVE.test(body)) add('error', 'SCAM', 'Private information', 'The message asks for private information (password, card number, PIN and the like).', 'Never ask for these in a message.', 'body');
    if (RESTRICTED.test(body)) add('error', 'ABUSIVE_CONTENT', 'Restricted content', 'The message is about something WhatsApp does not allow businesses to promote (gambling, alcohol, tobacco, weapons, financial claims and the like).', 'Remove it.', 'body');
    if (THREAT.test(body)) add('error', 'ABUSIVE_CONTENT', 'Threatening words', 'The message has threatening words.', 'Use a polite tone.', 'body');
    const letters = body.replace(/[^A-Za-z]/g, '');
    if (letters.length > 18 && letters === letters.toUpperCase()) add('warn', 'INVALID_FORMAT', 'Style', 'The message is all capital letters.', 'Write it in normal case.', 'body');
    if (/!!/.test(body)) add('warn', 'INVALID_FORMAT', 'Style', 'Repeated "!!" looks like spam.', 'Use one "!" at most.', 'body');
    if (body.trim().length < 12) add('warn', 'INVALID_FORMAT', 'Message length', 'A very short message is often refused.', 'Write at least a full sentence.', 'body');
  }
  if (headerType === 'text') {
    if (headerText.length > LIMITS.header) add('error', 'INVALID_FORMAT', 'Header', `The header text is ${headerText.length} letters; the limit is ${LIMITS.header}.`, 'Shorten it.', 'header');
    if (varsIn(headerText).length > 1) add('error', 'INVALID_FORMAT', 'Header', 'The header can have only one variable.', 'Keep one.', 'header');
  }
  if (['image', 'video', 'document'].includes(headerType) && !t.headerHasMedia) add('error', 'INVALID_FORMAT', 'Header file', `A${headerType === 'image' ? 'n' : ''} ${headerType} header needs a ${headerType === 'image' ? 'picture' : 'file'} chosen from the Library.`, 'Choose a file.', 'header');
  if (headerType === 'location' && !String(t.locationName || '').trim()) add('warn', 'INVALID_FORMAT', 'Header', 'A location header should have a place name.', 'Fill in the place name.', 'header');
  if (footer.length > LIMITS.footer) add('error', 'INVALID_FORMAT', 'Footer', `The footer is ${footer.length} letters; the limit is ${LIMITS.footer}.`, 'Shorten it.', 'footer');
  if (varsIn(footer).length) add('error', 'INVALID_FORMAT', 'Footer', 'Footers cannot contain variables.', 'Remove the variable from the footer.', 'footer');
  if (buttons.length > LIMITS.buttons) add('error', 'INVALID_FORMAT', 'Buttons', `At most ${LIMITS.buttons} buttons.`, 'Remove some.', 'buttons');
  const seen = new Set();
  buttons.forEach((b, i) => {
    const label = String(b.label || '').trim();
    if (!label) add('error', 'INVALID_FORMAT', 'Buttons', 'A button has no label.', 'Type a label or remove the button.', 'buttons');
    else {
      if (label.length > LIMITS.button) add('error', 'INVALID_FORMAT', 'Buttons', `The button "${label}" is longer than ${LIMITS.button} letters.`, 'Shorten it.', 'buttons');
      if (seen.has(label.toLowerCase())) add('error', 'INVALID_FORMAT', 'Buttons', 'Two buttons share the same label.', 'Give each button its own label.', 'buttons');
      seen.add(label.toLowerCase());
    }
    if (b.type === 'url' && !/^https?:\/\//i.test(String(b.url || '').trim())) add('error', 'INVALID_FORMAT', 'Buttons', `The button "${label || i + 1}" needs a full website link (https://...).`, 'Add the link.', 'buttons');
    if (b.type === 'phone' && String(b.phone || '').replace(/\D/g, '').length < 7) add('error', 'INVALID_FORMAT', 'Buttons', `The button "${label || i + 1}" needs a phone number.`, 'Add the number.', 'buttons');
    if (b.type === 'code' && !String(b.code || '').trim()) add('error', 'INVALID_FORMAT', 'Buttons', `The button "${label || i + 1}" needs the offer code.`, 'Add the code.', 'buttons');
    if (b.type === 'flow' && !String(b.flow || '').trim()) add('error', 'INVALID_FORMAT', 'Buttons', `The button "${label || i + 1}" needs a Flow chosen.`, 'Pick or make a Flow.', 'buttons');
  });
  if (t.callPermission) {
    if (category !== 'Marketing') add('error', 'INCORRECT_CATEGORY', 'Call permission', 'A call-permission message must be in the Marketing category.', 'Switch the category to Marketing.', 'category');
    if (buttons.length > 1) add('error', 'INVALID_FORMAT', 'Buttons', 'A call-permission message can carry only one button.', 'Keep one button.', 'buttons');
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warn').length;
  const missing = (!name ? 1 : 0) + (!body.trim() ? 1 : 0);
  let verdict = 'pass';
  if (errors > missing) verdict = 'fail';
  else if (errors > 0) verdict = 'todo';
  else if (warnings > 0) verdict = 'warn';
  return { issues, errors, warnings, missing, counts: { body: body.length, footer: footer.length, buttons: buttons.length }, verdict };
}

export { check, mapping, slug, varsIn, VARS, VAR_WORDS, SAMPLE, CATEGORIES, CODE_WORDS, LIMITS };
