// ---------------------------------------------------------------------------
// WHATSAPP CLICK-TO-CHAT: the link builder. PURE (no database, no network).
// MIRRORED by frontend/src/utils/waLink.js - keep the two in step (scripts/wa-clicktochat-test.js proves both give the same answers).
//
//   cleanNumber(raw, cc)   -> { digits, valid, reason }
//        removes spaces, +, -, ., brackets and a leading 0 (or 00); a 10-digit number gets the default country code (91);
//        valid only when the result is 11 to 15 digits.
//   buildWaLink(number, message, cc) -> 'https://wa.me/<digits>?text=<encodeURIComponent(message)>'  or null when the number is not valid
//   fillPlaceholders(body, vars)  -> { text, missing[] }   {name} {amount} {invoice_no} {due_date} {job_title} {interview_date} {month}
//        an unknown or empty placeholder stays as the literal {word} in the text and is listed in missing (never sent: the screen blocks it)
// ---------------------------------------------------------------------------
const WA_PLACEHOLDERS = ['name', 'amount', 'invoice_no', 'due_date', 'job_title', 'interview_date', 'month'];
const DEFAULT_CC = '91';

function cleanNumber(raw, cc = DEFAULT_CC) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { digits: '', valid: false, reason: 'No number' };
  if (/[a-z]/i.test(text)) return { digits: '', valid: false, reason: 'That is not a phone number' };
  let d = text.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  const code = String(cc || DEFAULT_CC).replace(/\D/g, '') || DEFAULT_CC;
  if (d.length === 10) d = `${code}${d}`;
  if (d.length < 11 || d.length > 15) return { digits: d, valid: false, reason: d.length < 11 ? 'The number is too short' : 'The number is too long' };
  return { digits: d, valid: true, reason: null };
}

function buildWaLink(number, message, cc = DEFAULT_CC) {
  const n = cleanNumber(number, cc);
  if (!n.valid) return null;
  return `https://wa.me/${n.digits}?text=${encodeURIComponent(String(message == null ? '' : message))}`;
}

const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
function fillPlaceholders(body, vars = {}) {
  const missing = [];
  const text = String(body == null ? '' : body).replace(TOKEN, (whole, key) => {
    const known = WA_PLACEHOLDERS.includes(key);
    const v = known && vars ? vars[key] : null;
    if (v == null || String(v).trim() === '') { if (!missing.includes(key)) missing.push(key); return whole; }
    return String(v).trim();
  });
  return { text, missing };
}
// the {words} still standing in a finished text (what must be filled or removed before opening WhatsApp)
function leftoverPlaceholders(text) {
  const out = [];
  String(text == null ? '' : text).replace(TOKEN, (w, k) => { if (!out.includes(k)) out.push(k); return w; });
  return out;
}

module.exports = { WA_PLACEHOLDERS, DEFAULT_CC, cleanNumber, buildWaLink, fillPlaceholders, leftoverPlaceholders };
