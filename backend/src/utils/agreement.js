const crypto = require('crypto');
const prisma = require('../db');

// ---------------------------------------------------------------------------
// THE SERVICE AGREEMENT — the company's own document, verbatim.
//
// The text below is TeamLink_Recruitment_Staffing_Agreement_Update.pdf, clause
// for clause. What came before was a paraphrase written against the prototype:
// sixteen clauses compressed into nine, "thirty (30) days notice" where the
// real document says something more specific, and no Schedule A at all. A
// paraphrase is fine for a mock-up and wrong for a document somebody signs.
//
// WHAT IS MERGED AND WHAT IS NOT. The blanks a real execution fills — the
// client's name, its registered office, the effective date, the agreed
// placement fee — are merged from the client record. Every clause is fixed
// text and is not rewritten per client, because the terms are the terms.
//
// Where the record has no value, the blank stays a blank (a rule of
// underscores) rather than being quietly invented. An agreement that prints
// "undefined" as the registered office is worse than one that prints a line to
// write on.
// ---------------------------------------------------------------------------

const CONSULTANT = 'TeamLink Consultants (OPC) Pvt. Ltd.';
const CONSULTANT_ADDRESS = '#512, 5th Floor, ARV Work Spaces LLP, KPHB, Hyderabad – 500072, Telangana, India';

// A blank to be completed by hand, rather than a value nobody supplied.
const blank = (n = 40) => '_'.repeat(n);
const or = (value, width) => (String(value || '').trim() ? String(value).trim() : blank(width));

function addressOf(client) {
  const parts = [
    client.houseNumber, client.street, client.landmark, client.area,
    client.location, client.state, client.pincode, client.country,
  ].map((p) => String(p || '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : blank(70);
}

function buildAgreementDocument(client = {}) {
  const c = client || {};
  const fee = c.agreementFeePercent != null ? c.agreementFeePercent : 8.33;
  const gst = c.gstPercent != null ? c.gstPercent : 18;
  const guarantee = String(c.guaranteePeriod || '30 Days').trim();

  const start = c.agreementStart ? new Date(`${c.agreementStart}T00:00:00Z`) : null;
  const day = start ? String(start.getUTCDate()).padStart(2, '0') : blank(4);
  const month = start ? start.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }) : blank(14);
  const year = start ? String(start.getUTCFullYear()).slice(2) : blank(3);

  return [
    'PERMANENT STAFFING / RECRUITMENT SERVICES AGREEMENT',
    '',
    `This Recruitment / Staffing Services Agreement ("Agreement") is entered into on this ${day} day of`,
    `${month}, 20${year} ("Effective Date"), by and between:`,
    '',
    `(1) ${or(c.legalName || c.name, 50)}, a company having its registered / principal office at`,
    `${addressOf(c)} ("Client"); and`,
    '',
    `(2) ${CONSULTANT}, a company incorporated under the Companies Act, 2013,`,
    `having its principal place of business at ${CONSULTANT_ADDRESS} ("Consultant").`,
    '',
    'Client and Consultant are each referred to individually as a "Party" and collectively as the "Parties".',
    '',
    'RECITALS',
    '',
    'A. Client wishes to engage Consultant to identify, screen and refer qualified candidates for open positions',
    'with Client from time to time.',
    'B. Consultant is engaged in the business of providing recruitment and staffing services and represents that',
    'it has the requisite skill, resources and experience to provide such services.',
    'C. The Parties wish to record the terms on which such services will be provided, as set out below.',
    '',
    'NOW THEREFORE, in consideration of the mutual promises set out herein, the Parties agree as follows:',
    '',
    '1. DEFINITIONS',
    '1.1  "Candidate" means any individual identified, screened or referred by Consultant to Client under',
    'this Agreement.',
    '1.2  "Placed Candidate" or "Employee" means a Candidate who accepts an offer of employment or',
    'engagement from Client and commences work with Client.',
    '1.3  "Placement Fee" means the fee payable by Client to Consultant under Clause 6, calculated as set',
    'out in Schedule A.',
    '',
    '2. TERM AND TERMINATION',
    '2.1  This Agreement commences on the Effective Date and continues for an initial term of twelve',
    '(12) months, and shall automatically renew for successive twelve (12)-month terms unless either',
    'Party gives the other written notice of non-renewal at least thirty (30) days before the end of the',
    'then-current term.',
    "2.2  Either Party may terminate this Agreement for convenience by giving the other Party thirty (30)",
    "days' prior written notice.",
    '2.3  Either Party may terminate this Agreement with immediate effect on written notice if the other',
    'Party commits a material breach of this Agreement that remains uncured fifteen (15) days after',
    'written notice of the breach, or becomes insolvent, makes an assignment for the benefit of creditors,',
    'or ceases to carry on business.',
    '2.4  Termination of this Agreement does not affect any rights or obligations of either Party that',
    "accrued before the effective date of termination, including Client's obligation to pay any Placement",
    'Fee due for a Candidate who joined Client prior to termination. All fees and dues outstanding as of',
    'the termination date shall be settled within thirty (30) days of termination.',
    '',
    '3. SCOPE OF SERVICES',
    '3.1  Consultant shall, on request from Client and based on the written job specifications and other',
    'requirements communicated by Client ("Job Profile"), identify and refer resumes of Candidates whom',
    'Consultant reasonably believes are suitable for the relevant role.',
    '3.2  Consultant shall screen and evaluate prospective Candidates against the Job Profile before',
    'referring them to Client, and shall act as the primary point of coordination between Client and',
    'Candidates for scheduling interviews and discussions.',
    '3.3  Consultant does not guarantee that any Candidate will accept an offer of employment, and Client',
    'retains sole and absolute discretion to interview, evaluate, select, reject or make an offer to any',
    'Candidate.',
    '',
    '4. CLIENT OBLIGATIONS',
    '4.1  Client shall provide Consultant with accurate and timely Job Profiles, including role',
    'requirements, compensation range and other information reasonably necessary for Consultant to',
    'perform the Services.',
    "4.2  Client shall be solely responsible for verifying each Candidate's identity, academic and",
    'employment credentials, background, and references, and for completing all joining formalities and',
    "statutory compliance prior to or upon engagement. Consultant's role is limited to sourcing and",
    'referral, and completion of such verification and documentation by Client is not a condition to, and',
    'shall not be linked with, payment of the Placement Fee under Clause 5.',
    "4.3  Client shall notify Consultant in writing within five (5) business days of a Candidate's offer",
    'acceptance, joining, or withdrawal, to enable accurate invoicing and tracking of the Guarantee Period.',
    '4.4  Labour Law Compliance: The Client shall be solely responsible for ensuring compliance with',
    'all applicable labour, employment, and industrial laws in India with respect to each Candidate from',
    'the date of joining, including but not limited to laws relating to wages, social security, provident fund,',
    'employee state insurance, gratuity, occupational safety, working conditions, and all applicable central',
    "and state labour legislations. The Consultant's role is limited to sourcing and referring Candidates.",
    'Accordingly, the Consultant shall have no responsibility or liability for the Client\'s compliance or',
    'non-compliance with any employment or labour law obligations after the Candidate joins the Client\'s',
    'organization.',
    '',
    '5. FEES AND PAYMENT TERMS',
    '5.1  Client shall pay Consultant a Placement Fee for each Candidate referred by Consultant who is',
    "selected by Client and joins Client's employment or engagement, calculated as set out in Schedule A,",
    'plus applicable taxes (including GST).',
    "5.2  Consultant shall raise an invoice after six (6) business days of the Placed Candidate's date of",
    'joining. Client shall pay each invoice within six (6) days of the invoice date, by bank transfer to the',
    'account designated by Consultant.',
    '5.3  If Client disputes any invoice in good faith, Client shall notify Consultant in writing of the',
    'specific basis for the dispute within seven (7) days of receipt of the invoice, and the Parties shall',
    'promptly work to resolve the dispute. Undisputed amounts shall be paid on the original due date.',
    '',
    '6. REPLACEMENT GUARANTEE',
    `6.1  Consultant will give Client a ${guarantee} Guarantee ("Guarantee Period") for all Candidates`,
    'placed with Client. Consultant will provide a free replacement Candidate of comparable caliber, at no',
    'additional Placement Fee, for any Placed Candidate who leaves the services of Client at their own',
    'will within the Guarantee Period.',
    "6.2  The replacement guarantee in Clause 6.1 does not apply where the Placed Candidate's",
    'employment ends due to termination by Client, redundancy, mutual separation, or any cause other',
    "than the Candidate's own voluntary resignation, and does not entitle Client to a refund of any",
    'Placement Fee already paid.',
    '',
    '7. NON-CIRCUMVENTION',
    '7.1  If Client, whether directly or through any other vendor, its own recruitment team, or any third',
    'party, hires or engages a Candidate first referred or selected by Consultant within twelve (12) months',
    'of such referral or selection, Client shall pay Consultant the Placement Fee that would otherwise have',
    'been due under Schedule A, provided Consultant maintains and can produce a written record',
    'evidencing that Consultant first introduced the Candidate to Client.',
    '',
    '8. INDEPENDENT CONTRACTOR STATUS',
    '8.1  Consultant is an independent contractor and not an employee, agent, partner or joint venturer of',
    'Client. Nothing in this Agreement creates an employer-employee relationship between Client and',
    "Consultant, or between Client and any Candidate prior to that Candidate's formal engagement by",
    'Client.',
    '8.2  Consultant has sole control over the manner and means by which it performs the Services and is',
    'solely responsible for its own personnel, including their compensation, benefits and statutory',
    'compliance.',
    '',
    '9. CONFIDENTIALITY',
    '9.1  Each Party shall keep confidential all information disclosed by the other Party in writing and',
    'marked or otherwise identified as confidential ("Confidential Information"), and shall not use such',
    'information other than to perform its obligations under this Agreement, or disclose it to any third',
    "party without the disclosing Party's prior written consent.",
    '',
    '10. GENERAL PROVISIONS',
    '10.1  Entire Agreement: This Agreement, together with Schedule A, constitutes the entire agreement',
    'between the Parties regarding its subject matter and supersedes all prior discussions, negotiations and',
    'agreements, whether written or oral.',
    '10.2  Amendment: This Agreement may be amended only by a written instrument signed by',
    'authorized representatives of both Parties.',
    '10.3  Assignment: Neither Party may assign this Agreement without the prior written consent of the',
    'other Party, except to a successor in connection with a merger, acquisition or sale of substantially all',
    'its assets.',
    '10.4  Severability: If any provision of this Agreement is held invalid or unenforceable, the remaining',
    'provisions shall continue in full force and effect, and the Parties shall negotiate in good faith to',
    'replace the invalid provision with a valid one of similar intent and economic effect.',
    '10.5  Counterparts: This Agreement may be executed in counterparts (including by electronic',
    'signature or scanned copy), each of which is deemed an original and all of which together constitute',
    'one instrument.',
    '',
    '11. GOVERNING LAW AND DISPUTE RESOLUTION',
    '11.1  This Agreement is governed by and construed in accordance with the laws of India, without',
    'regard to conflict-of-law principles.',
    '11.2  Any dispute arising out of or in connection with this Agreement shall first be referred to good-',
    'faith negotiation between senior representatives of the Parties. If not resolved within thirty (30) days,',
    'the dispute shall be referred to and finally resolved by arbitration under the Arbitration and',
    'Conciliation Act, 1996, by a sole arbitrator mutually appointed by the Parties, seated in Hyderabad,',
    'Telangana, with the proceedings conducted in English. Subject to the foregoing, the courts at',
    'Hyderabad, Telangana shall have exclusive jurisdiction.',
    '',
    '12. LIMITATION OF LIABILITY',
    '12.1  Neither Party shall be liable to the other for any indirect, incidental, or consequential damages',
    "arising out of this Agreement. Each Party's aggregate liability shall not exceed the Placement Fees",
    'paid or payable in the twelve (12) months preceding the claim.',
    '',
    '13. INDEMNIFICATION',
    '13.1  Each Party shall indemnify and hold harmless the other Party against third-party claims, losses',
    'or damages arising from its breach of this Agreement, negligence, or willful misconduct.',
    '',
    '14. FORCE MAJEURE',
    '14.1  Neither Party shall be liable for any delay or failure to perform its obligations under this',
    'Agreement caused by events beyond its reasonable control, including natural disasters, war,',
    'pandemic, or governmental action.',
    '',
    '15. NOTICES',
    '15.1  Any notice under this Agreement shall be in writing and delivered by email or registered post to',
    'the address of the receiving Party set out above, and shall be deemed received on actual delivery.',
    '',
    '16. DATA PROTECTION AND CANDIDATE INFORMATION',
    '16.1  Each Party shall use Candidate personal data only for recruitment and related purposes,',
    'maintain reasonable security and confidentiality, and comply with applicable data-protection laws,',
    'including the Digital Personal Data Protection Act, 2023 and rules thereunder, as applicable.',
    '16.2  Candidate personal data shall not be disclosed to third parties except as necessary for',
    'recruitment, required by law, or authorized, and each Party shall take reasonable steps to prevent',
    'unauthorized access or disclosure.',
    '',
    'SCHEDULE A',
    '',
    // The negotiated percentage is the one thing in Schedule A that is per
    // client, so it is merged; the PG / PhD table below it is standard.
    `Placement Fee: ${fee}% of the Placed Candidate's annual CTC, plus applicable GST at ${gst}%.`,
    '',
    'PG / PhD Profiles & Advance Payment',
    '',
    'a.  In addition to the above, Placement Company shall also provide the following profiles to',
    '"CLIENT" at the charges mentioned below (plus applicable GST and subject to a one-month',
    'replacement guarantee):',
    '',
    '      Profile Type                     Charges',
    '      PG Profiles                      Rs. 30,000/- + GST 18%',
    '      PG (Net/Set) Profiles            Rs. 50,000/- + GST 18%',
    '      PhD Profiles                     Rs. 75,000/- + GST 18%',
    '',
    'b.  "CLIENT" shall pay an advance payment of Rs. 5,00,000/- (Rupees Five Lakhs only) to the',
    'Placement Company. Once the said advance balance is utilized/adjusted down to Rs. 4,50,000/-',
    'against invoices raised, "CLIENT" shall renew/replenish the advance payment back to Rs. 5,00,000/-',
    'in order to continue availing the services under this Agreement.',
    '',
    'This Agreement has been executed by authorized signatories of the respective parties.',
    '',
    `For ${CONSULTANT}                          For Client`,
    '',
    `Name: ${blank(28)}                Name: ${blank(28)}`,
    `Designation: ${blank(21)}                Designation: ${blank(21)}`,
    `Signature: ${blank(23)}                Signature: ${blank(23)}`,
    `Date: ${blank(28)}                Date: ${blank(28)}`,
    '',
    'Private & Confidential',
  ].join('\n');
}

async function nextAgreementId() {
  const count = await prisma.client.count({ where: { agreementId: { not: null } } });
  let n = count + 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.client.findUnique({ where: { agreementId: `AGR${String(n).padStart(4, '0')}` } })) n += 1;
  return `AGR${String(n).padStart(4, '0')}`;
}

function newEsignToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { buildAgreementDocument, nextAgreementId, newEsignToken, CONSULTANT, CONSULTANT_ADDRESS };
