// ---------------------------------------------------------------------------
// THE TEAMLINK AGREEMENT TEMPLATE — "Vendor Services Agreement" (2026-10-05).
//
// The user's own Word document (O\agreement-template\sample-agreement.docx),
// word for word: sections 1–8, the clause letters, "CLIENT" / "Placement
// Company", the 30-day termination, the one-year candidate ownership and
// section 7 "Service Tax" exactly as written. ONLY THE BLANKS ARE FIELDS:
//
//   **-**-****            the "made on" date (dd-mm-yyyy)  ← agreementStart,
//                         else TODAY (never printed blank — 2026-10-10)
//   between ”****“        the client name                  ← legalName / name
//   Address ****          the company (else billing) address
//   section 8 table row   "8.33%+GST And One Month Replacement"
//                         ← fee % (or ₹ per candidate), GST, guarantee in words
//   8 a. "after 6 days"   the invoice trigger days          ← invoiceTrigger
//        "within 6 days"  the payment days                  ← paymentTerms
//   8 c. "1-month"        the guarantee                     ← guaranteePeriod
//   (special terms)       an extra "Special terms:" block after 8 c.
//   signature block       left: TeamLink signatory (Agreement settings);
//                         right: the client legal name; the signer's name /
//                         designation / sign / date are filled by the e-sign
//                         when the PDF and the pages are drawn.
//
// No blank prints as asterisks any more (user, 2026-10-10): the date is always a
// real date (agreementStart, else today in India), the client name is
// "[Client name]" until it is typed, the address "[Client address]" in the live
// preview and a blank line in a saved document.
//
// The text keeps a light structure every renderer understands (the preview,
// the signing page, the PDF): line 1 is the title; "N. Heading:" lines are
// section headings; "a. " lines are clauses; "| … | … |" lines are the
// section 8 table; lines with a TAB are the two-column signature block.
// Internal notes are never read here.
// ---------------------------------------------------------------------------

const VENDOR_TEMPLATE = 'Vendor Services Agreement';
const STAFFING_TEMPLATE = 'Recruitment / Staffing Services Agreement (older 16-clause)';
const TEMPLATES = [
  { id: 'VENDOR', name: VENDOR_TEMPLATE, note: 'TeamLink standard (from your Word document)' },
  { id: 'STAFFING', name: STAFFING_TEMPLATE, note: 'The older 16-clause text — only if a client needs it' },
];
// "Standard Recruitment / Staffing" was the stored default name before this
// change; it means "the TeamLink standard", which is now this document.
function templateIdOf(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n.includes('older') || n.includes('16-clause') || n.startsWith('permanent staffing')) return 'STAFFING';
  return 'VENDOR';
}

const TEAMLINK_NAME = 'Teamlink Consultants (OPC) PVT.LTD.';
const TEAMLINK_ADDRESS = '#512, 5th Floor, ARV Work Spaces LLP, KPHB, Hyderabad 500072';
const SIGN_LEFT = 'Team link Consultants (OPC) PVT. LTD.';
const CLIENT_SIGN_BLANK = 'XXXXXXXXX';

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function paymentDaysOf(c) {
  const m = String((c && c.paymentTerms) || '').match(/within (\d+) days/i);
  return m ? Number(m[1]) : 6;
}
// 0 = on the joining day.
function invoiceDaysOf(c) {
  const t = clean(c && c.invoiceTrigger);
  if (/^on joining$/i.test(t) || /^on the joining/i.test(t)) return 0;
  const m = t.match(/(\d+)\s*day/i);
  if (m) return Number(m[1]);
  const p = String((c && c.paymentTerms) || '').match(/invoice (\d+) days after joining/i);
  return p ? Number(p[1]) : 6;
}
function guaranteeDaysOf(c) {
  const g = clean((c && c.guaranteePeriod) || '30 Days');
  if (/no replacement/i.test(g)) return 0;
  const m = g.match(/(\d+)\s*(day|month)/i);
  if (!m) return 30;
  return /month/i.test(m[2]) ? Number(m[1]) * 30 : Number(m[1]);
}
// The section 8 table: "One Month Replacement".
function guaranteeWords(days) {
  return ({ 30: 'One Month', 60: 'Two Months', 90: 'Three Months' })[days] || `${days} Days`;
}
// Clause 8 c: "a 1-month Guarantee".
function guaranteeShort(days) {
  return ({ 30: '1-month', 60: '2-month', 90: '3-month' })[days] || `${days}-day`;
}
function ddmmyyyy(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
// THE "MADE ON" DATE (user, 2026-10-10): it is NEVER a blank. It is the day the
// agreement is made (today, India time) unless the client carries its own
// agreement date (agreementStart: set when the draft is created, so a later
// regenerate keeps the SAME date; an Admin may correct it).
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function todayYmd(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10); // Asia/Kolkata, no DST
}
function effectiveYmd(c) {
  const s = String((c && c.agreementStart) || '').trim();
  return YMD_RE.test(s) ? s : todayYmd();
}
// The date a REGENERATED draft ("Make a new draft") prints: TODAY, India time —
// the new draft is made today (user, 2026-10-10). { keepDate: true } keeps the
// agreement date on the client instead (an Admin who must keep a backdated day);
// otherwise "Edit dates" sets any day after the draft is made.
function regenerateYmd(c, { keepDate = false, now = new Date() } = {}) {
  const s = String((c && c.agreementStart) || '').trim();
  return keepDate && YMD_RE.test(s) ? s : todayYmd(now);
}
// The text of a stored agreement with its "made on" date replaced (the same
// sentence the builder writes). Returns null when the sentence is not found.
const MADE_ON_RE = /(This agreement is made on )(\S+)( between )/;
function madeOnOf(text) {
  const m = String(text || '').match(MADE_ON_RE);
  return m ? m[2] : null;
}
function restampMadeOn(text, ymd) {
  const d = ddmmyyyy(ymd);
  if (!d || !MADE_ON_RE.test(String(text || ''))) return null;
  return String(text).replace(MADE_ON_RE, `$1${d}$3`);
}
const inr = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const gstOff = (c) => /^no$/i.test(clean(c && c.gstApplicable));

function feeCell(c) {
  const days = guaranteeDaysOf(c);
  const rep = days === 0 ? 'No Replacement' : `${guaranteeWords(days)} Replacement`;
  const type = clean(c.feeType) || 'PERCENT_CTC';
  if (type !== 'PERCENT_CTC' && c.feeAmount != null && Number.isFinite(Number(c.feeAmount))) {
    return `₹${inr(c.feeAmount)} per candidate${gstOff(c) ? '' : ' + GST'} And ${rep}`;
  }
  const fee = c.agreementFeePercent != null ? Number(c.agreementFeePercent) : 8.33;
  return `${fee}%${gstOff(c) ? '' : '+GST'} And ${rep}`;
}

// The client's address as written in the agreement. A country on its own
// ("India", the form's default) is NOT an address: it falls back to the billing
// address, and then to nothing (the builder prints a placeholder / blank line).
function addressLine(c) {
  const parts = [c.houseNumber, c.street, c.landmark, c.area, c.location, c.state, c.pincode]
    .map(clean).filter(Boolean);
  if (parts.length) return [...parts, clean(c.country)].filter(Boolean).join(', ');
  return clean(c.billingAddress) || null;
}

// What prints where a value does not exist (never "****"): the live preview
// shows a clear [placeholder]; a saved document shows a blank line to write on.
const NAME_PLACEHOLDER = '[Client name]';
const ADDRESS_PLACEHOLDER = '[Client address]';
const ADDRESS_BLANK = '_'.repeat(30);

function buildVendorServicesAgreement(client = {}, consultant = null, opts = {}) {
  const c = client || {};
  const us = consultant || {};
  const date = ddmmyyyy(effectiveYmd(c));
  const name = clean(c.legalName || c.name) || NAME_PLACEHOLDER;
  const address = addressLine(c) || (opts && opts.preview ? ADDRESS_PLACEHOLDER : ADDRESS_BLANK);
  const invoiceDays = invoiceDaysOf(c);
  const payDays = paymentDaysOf(c);
  const gDays = guaranteeDaysOf(c);
  const special = String(c.specialTerms || '').split(/\r?\n/).map(clean).filter(Boolean);
  return [
    'Vendor Services Agreement',
    `This agreement is made on ${date} between “${name}” (herein after referred to as “CLIENT”) Address ${address} and “${TEAMLINK_NAME}” (Herein referred to as “Placement Company”) with a principal place of business at ${TEAMLINK_ADDRESS}’.“CLIENT” wishes to engage the services of Placement Company, which is in business of providing professional services.`,
    '1. Terms of Agreement:',
    'a. This agreement shall be made effective from the date mentioned above and gets automatically renewed unless called off by either party.',
    '2. Services:',
    'a. Placement Company will provide, from time to time as requested by “CLIENT”, Services to or for the benefit of “CLIENT” by providing resumes of candidates suitable to specification/details (as per the written job profile and other written communications) mentioned in “CLIENT” resource requirement.',
    'b. The Placement Company shall identify and shortlist suitable candidates (‘Prospects’) as per the written job profile and other written communications provided by “Client” , after proper screening and evaluation of such Prospects.',
    'c. The Placement Company shall act as an interface between “Client” and the Prospects and shall be responsible for arranging meetings, discussions, and interviews of the Prospects with “Client”.',
    '3. Selection of Prospects:',
    'a. “CLIENT” shall provide any information with regard to skill or experience of the professional required or any other information, which is needed by the Placement Company to service the “CLIENT” request in a timely manner.',
    'b. Upon the Prospects being selected and confirmed by “Client” for the specified job and thereupon accepting and joining “Client” for the specified job, the Placement Company shall be paid consideration (‘Fees’), schedule for which is in point no. 8 (Plus applicable taxes, charges, expenses, or levies) for its efforts in identifying, referring and assisting in engaging the Prospect (the Prospect identified and referred to by the Placement Company, upon joining “Client”, shall be referred to as ‘Employee’) for “Client”.',
    'c. In case the candidate refuses to join “CLIENT” after accepting the offer, Placement Company will provide an alternate candidate of equivalent or with better caliber, who is available to join “CLIENT”.',
    'd. Once candidate presented by Placement Company it will be treated as Placement Company’s candidate for next one year and if “CLIENT” recruits the candidate by any sources including other vendor or its own recruitment team, “CLIENT” would still reward the placement fees to the Placement Company.',
    'e. After selection of a candidate, client need to ask the candidate about joining formalities along with the submission of concerned documents like academic or experience, that\'s the management or concerned authority\'s (HR) responsibility. That task has to be done completely by your end(Clients responsibilities). As a consult, we wouldn’t involve or interfere about submissions (Academic or Experience documents) and there is no interrelatedness between submissions and invoice Payments.',
    '4. Relationships:',
    'a. Placement Company asserts that it is an independent vendor, which offers its services to other organizations as and when required. This agreement does not constitute joint ventures or agency relationship between Placement Company and “CLIENT”. “CLIENT” agrees that it will have no right to control or direct the details, manners or means which placement company uses to accomplish the results of services performed.',
    '5. Non-Disclosure:',
    'a. Placement Company agrees to hold confidential and not use for its own benefit or any other party benefit, any secret or confidential information acquired by Placement Company or its referred employees by virtue of services performed in accordance with this agreement. Information shall be considered secret or confidential only if explicitly stated as such and communicated to Placement Company in writing. Confidential information shall not include any information, which is previously known to the placement company, is publicly disclosed either prior to or subsequent to the placement company or its referred employees\' receipt of such information, or is rightfully received by the placement company from a third party without obligation of confidence.',
    '6. Termination:',
    'a. “CLIENT” may terminate this agreement giving a 30-day notice at any time. Placement Company may as well terminate this agreement with 30 days prior notice. Dues should be paid before termination.',
    '7. Service Tax: This would be levied on every Invoice as per applicable rates.',
    '8. Service Charges:',
    'To Placement Company, fees payable on placement of a potential candidate with “Client” shall be based on the working below which is Cost to the “Client” (Guaranteed Annual Salary of the candidate).',
    '| Years of Experience | Service Fee on CTC (Yearly)+GST |',
    `| For All Profiles | ${feeCell(c)} |`,
    'Additionally:',
    `a. An invoice will be sent to the Client ${invoiceDays === 0 ? 'on' : `after ${invoiceDays} days`} commencement of employment of the prospects and the Placement Fee is payable within ${payDays} days from the date of invoice.`,
    'b. After the invoice has been raised, a One-Time Payment has to be made.',
    `c. The Placement Company will give the Client a ${guaranteeShort(gDays)} Guarantee for all employees placed with the Client. The Placement Company will provide FREE REPLACEMENT for candidates who leave the services of the Client AT THEIR OWN WILL.`,
    ...(special.length ? ['Special terms:', ...special] : []),
    'This Agreement has been executed by authorized signatories of the respective parties.',
    `${SIGN_LEFT}\t${clean(c.legalName || c.name) || NAME_PLACEHOLDER}`,
    `Name: ${clean(us.signatoryName)}\tName:`.replace(/ \t/, '\t'),
    `Designation: ${clean(us.signatoryTitle)}\tDesignation:`.replace(/ \t/, '\t'),
    'Sign:\tSign:',
    'Date:\tDate:',
  ].join('\n');
}

const isVendorDocument = (text) => String(text || '').startsWith('Vendor Services Agreement');

module.exports = {
  VENDOR_TEMPLATE, STAFFING_TEMPLATE, TEMPLATES, templateIdOf, buildVendorServicesAgreement, isVendorDocument,
  paymentDaysOf, invoiceDaysOf, guaranteeDaysOf, guaranteeWords, guaranteeShort, feeCell, ddmmyyyy, addressLine,
  todayYmd, effectiveYmd, regenerateYmd, madeOnOf, restampMadeOn, MADE_ON_RE, NAME_PLACEHOLDER, ADDRESS_PLACEHOLDER, ADDRESS_BLANK,
  TEAMLINK_NAME, TEAMLINK_ADDRESS, SIGN_LEFT, CLIENT_SIGN_BLANK,
};
