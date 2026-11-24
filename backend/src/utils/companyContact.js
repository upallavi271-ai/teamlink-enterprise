// ---------------------------------------------------------------------------
// THE COMPANY AS A LETTER PRINTS IT (2026-11-24: "+91 9032321414 | hello@teamlink.test - why is it coming like this").
//
// The letters (offer letter, service certificate, relieving letter) print the company's name, address, phone and email from the Company
// record. A company set up from the demo data still carries the demo values (hello@teamlink.test, +91 40 1234 5678): those must never
// reach a candidate or an ex-employee, so they are left out (the same rule the public careers page already follows, routes/public.js
// /company-contact). The name is the LEGAL name, as in the founder's own letters: "Teamlink Consultants [OPC] Pvt. Ltd.".
// ---------------------------------------------------------------------------
const REFERENCE_LEGAL_NAME = 'Teamlink Consultants [OPC] Pvt. Ltd.';

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// An address that is real: a well-formed one, not on a reserved / demo domain (example.com, *.test, *.example, *.invalid, *.local ...).
function realEmail(v) {
  const e = clean(v);
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return /@(example\.(com|org|net)|[^@]*\.(test|example|invalid|localhost|local))$/i.test(e) ? null : e;
}

// A phone number that is real: at least 8 digits and not a made-up run (12345678, 00000000, 98765432).
function realPhone(v) {
  const p = clean(v);
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length < 8 || /12345678|00000000|98765432/.test(digits) ? null : p;
}

// The name a letter signs with: the legal name saved on the Company record, else (for TeamLink's own company, which has only the short name)
// the name on the founder's letters, else the environment's legal name, else whatever name the company has.
function legalNameOf(c) {
  const legal = clean(c && c.legalName);
  if (legal) return legal;
  const short = clean(c && c.name);
  if (!short || /^team\s?link consultants$/i.test(short)) return REFERENCE_LEGAL_NAME;
  return clean(process.env.COMPANY_LEGAL_NAME) || short;
}

// -> { name, address, phone, email } for a letter's letterhead; a demo phone or email is null (and so is not printed)
function forLetter(c) {
  return {
    name: legalNameOf(c),
    address: clean(c && c.address) || clean(c && c.hq) || '',
    phone: realPhone(c && c.phone) || '',
    email: realEmail(c && c.email) || '',
  };
}

module.exports = { REFERENCE_LEGAL_NAME, realEmail, realPhone, legalNameOf, forLetter };
