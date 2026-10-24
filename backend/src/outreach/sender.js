// ---------------------------------------------------------------------------
// SENDER DETAILS (Omni-Channel > Settings > Sender details). Stored in the outreach settings (AppSetting 'outreach.settings'), Admin only.
//   fromEmail        the address messages come from (display + preview; the mail server itself is set up in Administration > Integrations)
//   fromName         the name people see (this one already drives real emails)
//   replyTo          where replies go (already used by the email sender)
//   whatsappNumber   the WhatsApp business number: display only for now (WhatsApp sending comes later). Stored as digits with the country code.
//   smsSenderId      the SMS header registered on DLT: exactly 6 letters (India)
//   smsDltEntityId   the DLT principal entity number: 10 to 25 digits
// validate(input, current) -> { value: {...the changed fields, cleaned} } | { error }. Pure.
// ---------------------------------------------------------------------------
const core = require('../utils/messagingCore');

const FIELDS = ['fromEmail', 'fromName', 'replyTo', 'whatsappNumber', 'smsSenderId', 'smsDltEntityId'];
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function validate(input) {
  const b = input && typeof input === 'object' ? input : {};
  const out = {};
  if (b.fromEmail !== undefined) {
    const v = clip(b.fromEmail, 160).toLowerCase();
    if (v && !core.validEmail(v)) return { error: 'The "From" email is not a valid email address.' };
    out.fromEmail = v;
  }
  if (b.fromName !== undefined) out.fromName = clip(b.fromName, 80);
  if (b.replyTo !== undefined) {
    const v = clip(b.replyTo, 160).toLowerCase();
    if (v && !core.validEmail(v)) return { error: 'The reply-to address is not a valid email.' };
    out.replyTo = v;
  }
  if (b.whatsappNumber !== undefined) {
    const raw = clip(b.whatsappNumber, 30);
    if (!raw) out.whatsappNumber = '';
    else { const n = core.normalizeMobile(raw); if (!n.ok) return { error: 'The WhatsApp number does not look right. Type the 10-digit mobile number (with or without +91).' }; out.whatsappNumber = n.e164; }
  }
  if (b.smsSenderId !== undefined) {
    const v = clip(b.smsSenderId, 20).toUpperCase();
    if (v && !/^[A-Z]{6}$/.test(v)) return { error: 'The SMS sender ID must be exactly 6 letters (for example TEAMLK), as registered on DLT.' };
    out.smsSenderId = v;
  }
  if (b.smsDltEntityId !== undefined) {
    const v = clip(b.smsDltEntityId, 30);
    if (v && !/^\d{10,25}$/.test(v)) return { error: 'The DLT entity number must be 10 to 25 digits.' };
    out.smsDltEntityId = v;
  }
  return { value: out };
}
// what a screen shows (the WhatsApp number as +91 98765 43210)
function shown(st) {
  const wa = String(st.whatsappNumber || '');
  return {
    fromEmail: st.fromEmail || '', fromName: st.fromName || '', replyTo: st.replyTo || '', whatsappNumber: wa, whatsappShown: wa ? `+${wa.slice(0, wa.length - 10)} ${wa.slice(-10, -5)} ${wa.slice(-5)}`.replace('+ ', '+') : '',
    smsSenderId: st.smsSenderId || '', smsDltEntityId: st.smsDltEntityId || '',
  };
}
module.exports = { FIELDS, validate, shown };
