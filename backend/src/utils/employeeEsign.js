// ---------------------------------------------------------------------------
// THE EMPLOYEE SIGNS THEIR OWN OFFER LETTER WITH AADHAAR (2026-11-25).
//
// The same eMudhra Aadhaar eSign that the candidate's offer page uses (utils/emudhra.js): the employee presses "Sign with Aadhaar" on My
// Profile, the offer letter goes to eMudhra's own page, and the employee enters the OTP that UIDAI sends to THEIR Aadhaar-linked mobile.
// eMudhra signs the PDF; TeamLink checks the signed file with eMudhra before keeping it. Only then does the letter show as signed.
//
// Nothing is signed by TeamLink itself, and nothing is shown as signed unless eMudhra confirmed it (utils/emudhra.js verifyAndFetch).
// The signed copy is kept in the employee's documents as "Offer Letter" - "Signed with Aadhaar eSign (eMudhra)".
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const attachments = require('./attachments');
const emudhra = require('./emudhra');
const OLM = require('./offerLetterMail');

const SIGNED_DOC_NAME = 'Signed with Aadhaar eSign (eMudhra)';
const RETURN_PATH = '/api/employee-esign/emudhra/return';
const NOT_SET_UP = 'Aadhaar eSign is not set up yet, so you cannot sign online yet. HR will tell you when it is ready.';

async function signedDocOf(employeeId) {
  return prisma.employeeDocument.findFirst({
    where: { employeeId, docType: 'Offer Letter', docName: SIGNED_DOC_NAME },
    orderBy: { uploadedAt: 'desc' },
  }).catch(() => null);
}

// -> { gatewayUrl, fields, ref } | { status, error, notAvailable? }
async function startFor({ employee, user, base, completion }) {
  const gate = OLM.selfDownloadGate(employee, completion);
  if (!gate.ok) return { status: 409, error: gate.why };
  if (await signedDocOf(employee.id)) return { status: 409, error: 'Your offer letter is already signed.' };
  if (!(await emudhra.isAvailable())) return { status: 409, error: NOT_SET_UP, notAvailable: true };
  const made = await OLM.pdfForEmployee(employee);
  try {
    const form = await emudhra.startSession({
      client: null,
      pdf: made.pdf,
      signerName: String(employee.name || '').slice(0, 100),
      returnBase: base,
      returnPath: RETURN_PATH,
      sessionExtra: { kind: 'employee-offer', employeeId: employee.id, userId: user.id, frontBase: base },
    });
    await logAudit({
      userId: user.id,
      action: 'Offer letter sent to eMudhra for Aadhaar eSign (by the employee)',
      entity: 'Employee',
      entityId: employee.id,
      toValue: `${employee.name} (${employee.employeeCode}) · ${form.ref}`,
    });
    return { gatewayUrl: form.gatewayUrl, fields: form.fields, ref: form.ref };
  } catch (err) {
    if (err.code === 'NOT_READY') return { status: 409, error: NOT_SET_UP, notAvailable: true };
    throw err;
  }
}

// eMudhra's reply, after the employee has signed (or cancelled, or failed) on eMudhra's page.
// -> { to, state, why } (send the browser to `to`) | { status, state: 'refused', why } (nothing was changed)
async function finish({ ref, kind, body, base }) {
  const b = body || {};
  const session = await emudhra.readSession(ref);
  if (!session || session.kind !== 'employee-offer' || !['success', 'failure', 'cancel'].includes(kind)) {
    return { status: 400, state: 'refused', why: 'This signing reply was not recognised, so nothing was changed.' };
  }
  if (session.status !== 'Started') {
    return { status: 409, state: 'refused', why: 'This signing reply was already handled, so nothing was changed.' };
  }
  const employee = await prisma.employee.findUnique({ where: { id: session.employeeId } });
  const back = (state, why) => ({
    to: `${session.frontBase || base || ''}/my-profile?esign=${state}${why ? `&why=${encodeURIComponent(why)}` : ''}`,
    state,
    why: why || null,
  });
  if (!employee) {
    await emudhra.closeSession(ref, 'Failed');
    return back('failed', 'The employee record is not there.');
  }
  const posted = String(b.ErrorMessage || '').slice(0, 300);
  if (kind !== 'success' || String(b.ReturnStatus || '').toLowerCase() !== 'success') {
    await emudhra.closeSession(ref, kind === 'cancel' ? 'Cancelled' : 'Failed');
    await logAudit({
      userId: session.userId || null,
      action: kind === 'cancel' ? 'Offer letter eSign cancelled by the employee' : 'Offer letter eSign failed',
      entity: 'Employee',
      entityId: employee.id,
      toValue: ref,
      reason: posted || null,
    });
    return back(kind === 'cancel' ? 'cancelled' : 'failed', posted.slice(0, 160));
  }
  const ver = await emudhra.verifyAndFetch({ ref, postedTxn: b.Transactionnumber });
  if (!ver.ok) {
    if (ver.refuse) return { status: 400, state: 'refused', why: 'This signing reply could not be verified, so nothing was changed.' };
    await emudhra.closeSession(ref, 'Failed');
    await logAudit({
      userId: session.userId || null,
      action: 'Offer letter eSign not confirmed — not signed',
      entity: 'Employee',
      entityId: employee.id,
      toValue: ref,
      reason: String(ver.reason || '').slice(0, 300),
    });
    return back('failed', String(ver.reason || '').replace(/\s*\(.*\)\s*$/, ''));
  }
  if (await signedDocOf(employee.id)) {
    await emudhra.closeSession(ref, 'Late');
    return back('already', 'Your offer letter is already signed.');
  }
  const stored = attachments.store(
    { data: ver.pdf, contentType: 'application/pdf', filename: `Offer-letter-${employee.employeeCode || employee.id}-signed.pdf` },
    { maxBytes: 25 * 1024 * 1024 },
  );
  const doc = await prisma.employeeDocument.create({
    data: {
      employeeId: employee.id,
      docType: 'Offer Letter',
      docName: SIGNED_DOC_NAME,
      file: stored.billFile,
      fileName: stored.billName,
      mime: stored.billMime,
      size: stored.billSize,
      uploadedBy: session.userId || null,
    },
  });
  await emudhra.closeSession(ref, 'Signed');
  await logAudit({
    userId: session.userId || null,
    action: 'Offer letter signed with Aadhaar eSign (eMudhra)',
    entity: 'Employee',
    entityId: employee.id,
    toValue: `${employee.name} (${employee.employeeCode}) · eMudhra transaction ${ver.transactionNumber}`,
    reason: `${stored.billSize} bytes · document ${doc.id}`,
  });
  return back('signed');
}

module.exports = { SIGNED_DOC_NAME, RETURN_PATH, startFor, finish, signedDocOf };
