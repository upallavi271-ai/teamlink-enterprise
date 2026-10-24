// ---------------------------------------------------------------------------
// "IS THE CONTACT STILL IN THE EDITED RESUME?" (founder, 2026-10-22)
//
// A recruiter edits the original resume outside TeamLink (PDF in iLovePDF, Word in Word) and uploads it back as the Edited resume. That file is what a
// CLIENT sees, so it must not show the candidate's phone number or e-mail. This reads the text of the uploaded file and says what is still in it:
//   findContact(text, { phone, email }) -> { emails: [..], phones: [..] }   (empty arrays = clean)
// Only mobile-number-shaped digits (10 digits, optional +91 / 0), e-mail addresses and the candidate's OWN number count; years, marks and amounts do not.
// What is returned is already hidden in part (ab***@gmail.com, 98*****210) so the message itself does not repeat the contact.
// ---------------------------------------------------------------------------
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 10-digit Indian mobile, in one piece or split 5 + 5 / 4 + 3 + 3, optional +91 / 91 / 0 in front
const MOBILE_RE = /(?<!\d)(?:\+?91[\s.-]?|0)?[6-9]\d(?:[\s.-]?\d){8}(?!\d)/g;

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const hideEmail = (e) => { const [u, d] = String(e).split('@'); return `${u.slice(0, 2)}***@${d}`; };
const hidePhone = (d) => `${d.slice(0, 2)}******${d.slice(-2)}`;

function findContact(text, { phone = null, email = null } = {}) {
  const t = String(text || '');
  const emails = new Set();
  const phones = new Set();
  (t.match(EMAIL_RE) || []).forEach((e) => emails.add(e.toLowerCase()));
  const own = last10(phone);
  const ownMail = String(email || '').toLowerCase().trim();
  if (ownMail && t.toLowerCase().includes(ownMail)) emails.add(ownMail);
  (t.match(MOBILE_RE) || []).forEach((m) => { const d = last10(m); if (d.length === 10) phones.add(d); });
  if (own.length === 10) t.split('\n').forEach((line) => { if (line.replace(/\D/g, '').includes(own)) phones.add(own); });
  return { emails: [...emails].map(hideEmail), phones: [...phones].map(hidePhone) };
}

const isClean = (found) => !found.emails.length && !found.phones.length;

module.exports = { findContact, isClean };
