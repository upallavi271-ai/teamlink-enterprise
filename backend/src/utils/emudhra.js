// ---------------------------------------------------------------------------
// eMUDHRA AADHAAR eSIGN — through the emSigner SIGNER GATEWAY (2026-10-05).
//
// WHICH eMUDHRA PRODUCT, AND WHY (official docs, read 2026-10-05):
//   • emSigner Signer Gateway — "Application providers can integrate by
//     registering as an ASP of eMudhra, or by consuming emSigner Gateway
//     services (no ASP registration required)" (eMudhra eSign datasheet,
//     https://resources.emudhra.com/emudhraDocs/resources/eSign/Datasheets/esign-service-by-emudhra.pdf).
//     A web app POSTs one encrypted PDF to the gateway; the signer is taken to
//     eMudhra's page and signs there; the gateway posts back to our success /
//     failure / cancel URL. SignatureType 3 = "eSign (Aadhar based signing)
//     ... valid ONLY in India"; 2 = DSC token; 4 = eSignature (outside India).
//       https://support.emsigner.com/apis/signer-gateway/gateway-documentation/signing-documents.md
//       https://support.emsigner.com/apis/signer-gateway/gateway-documentation/retrieving-signed-documents.md
//       https://support.emsigner.com/apis/signer-gateway/getting-started/subscription.md
//       https://support.emsigner.com/apis/signer-gateway/getting-started/sandbox-and-going-live.md
//     ← THIS IS WHAT IS BUILT.
//   • eSign API as an ASP of the ESP (CCA eSign API spec, XML signed with the
//     ASP's own certificate): needs ASP registration + an ESP agreement + an
//     integration kit (https://cca.gov.in/sites/files/pdf/esign/CCA-ASP.pdf,
//     https://www.cca.gov.in/sites/files/pdf/ACT/eSign-APIv3.1.pdf). Heavier;
//     not needed when the gateway is used.
//   • emSigner workflow REST API (https://demoapi.emsigner.com/api/ …,
//     https://support.emsigner.com/apis/embedded-signing/getting-started/sandbox-and-going-live.md)
//     — emSigner's own workflow product, emails its own invitations. Not used:
//     TeamLink already sends its own link.
//   • DSC token signing (SignatureType 2) needs a USB crypto token at the
//     signer's desk — not for clients.
//
// THE GATEWAY CALL, as documented:
//   POST (browser form) to the gateway URL with three parameters —
//     Parameter 1  the session key (random AES-256), RSA-encrypted with
//                  eMudhra's certificate ("RSA/ECB/PKCS1Padding")
//     Parameter 2  the JSON below, AES-encrypted with the session key
//                  ("AES/ECB/PKCS7")
//     Parameter 3  SHA-256 of the document, AES-encrypted with the session key
//   JSON: FileType "PDF", File (base64), IsCompressed false, ReferenceNumber
//   (unique, max 20), Name, AuthToken, SignatureType 3, SelectPage,
//   SignaturePosition, SUrl / FUrl / CUrl.
//   Posted back: ReturnStatus, ErrorMessage, Returnvalue, Transactionnumber,
//   Referencenumber.
//   Then (server to server, GET): /api/TransactionStatusRequest and
//   /api/SignedDataRequest with AuthToken, Transactionnumber, Referencenumber
//   → status "Completed" and the encrypted signed data.
//
// WHAT THE DOCS DO NOT STATE (so they are SETTINGS, not guesses in code):
//   the exact HTML field names of "Parameter 1/2/3" (default
//   Parameter1,Parameter2,Parameter3 — confirm with eMudhra), whether the
//   base64 is of the raw bytes (assumed), and the compression of large signed
//   files ("7-zip"/LZMA — not decompressed here: a compressed answer is
//   reported as "could not read", never as signed).
//
// HONESTY RULES (the same as Save & Post):
//   • nothing is "Signed" on the browser's word: the posted-back form is only
//     a hint; Signed needs the status API saying Completed AND the signed PDF
//     fetched, decrypted, a real PDF, carrying a digital signature
//     (/ByteRange + /Sig);
//   • a Test only checks the setup — it never calls eMudhra;
//   • the Aadhaar number is never asked for, seen or stored by TeamLink.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const CHANNEL = 'esign';
const DEFAULTS = {
  gatewayUrl: 'https://testgateway.emsigner.com/eMsecure/V3_0/Index',
  apiBase: 'https://testgateway.emsigner.com/api',
  fieldNames: 'Parameter1,Parameter2,Parameter3',
};
const SESSION_PREFIX = 'emudhraSession:';
const SESSION_TTL_MS = 2 * 3600000;

async function readSettings() {
  // eslint-disable-next-line global-require
  const store = require('./integrationStore');
  const cfg = await store.readConfig(CHANNEL).catch(() => ({ values: {} }));
  const v = cfg.values || {};
  const names = String(v['POST field names (Parameter 1,2,3)'] || DEFAULTS.fieldNames).split(',').map((x) => x.trim()).filter(Boolean);
  return {
    environment: String(v.Environment || 'Sandbox').trim(),
    gatewayUrl: String(v['Gateway URL'] || DEFAULTS.gatewayUrl).trim(),
    apiBase: String(v['Status / download API base URL'] || DEFAULTS.apiBase).trim().replace(/\/+$/, ''),
    authToken: String(v['Auth token'] || '').trim(),
    certificate: String(v['eMudhra public certificate (PEM)'] || '').trim(),
    fieldNames: names.length === 3 ? names : DEFAULTS.fieldNames.split(','),
    missingKey: !!cfg.missingKey,
  };
}

function publicKeyOf(pem) {
  const text = String(pem || '').trim();
  if (!text) return null;
  try {
    if (/BEGIN CERTIFICATE/.test(text)) return new crypto.X509Certificate(text).publicKey;
    return crypto.createPublicKey(text);
  } catch { return null; }
}

// What is missing, in plain words — no network.
function problemsOf(s) {
  const p = [];
  if (s.missingKey) p.push('the saved token cannot be read with this server\'s secret key');
  if (!s.authToken) p.push('Auth token');
  if (!s.certificate) p.push('eMudhra public certificate (PEM)');
  else if (!publicKeyOf(s.certificate)) p.push('the certificate is not a valid PEM certificate / public key');
  if (!/^https:\/\//.test(s.gatewayUrl)) p.push('Gateway URL must start with https://');
  if (!/^https:\/\//.test(s.apiBase)) p.push('Status / download API base URL must start with https://');
  return p;
}

async function setupReport() {
  const s = await readSettings();
  const problems = problemsOf(s);
  return {
    ready: problems.length === 0,
    environment: s.environment,
    result: problems.length
      ? `Not ready — missing: ${problems.join('; ')}. Nothing was sent to eMudhra.`
      : `Ready (${s.environment}) — the setup is complete. Nothing was sent to eMudhra; the first real check happens when a client signs.`,
  };
}
async function isAvailable() { return (await setupReport()).ready; }

// --- crypto as documented ------------------------------------------------------
function aesEcb(key, buf) {
  const c = crypto.createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([c.update(buf), c.final()]);
}
function aesEcbDecrypt(key, buf) {
  const d = crypto.createDecipheriv('aes-256-ecb', key, null);
  return Buffer.concat([d.update(buf), d.final()]);
}

// A NEW SIGNING SESSION for one agreement PDF. Returns the form the browser
// posts to the gateway; the session key is kept (encrypted) for the reply.
// returnPath / sessionExtra (B3 offer letters, 2026-10-06): another document can
// use the same gateway with its own return route; defaults = the agreement's.
async function startSession({ client, pdf, signerName, returnBase, returnPath = '/api/agreement/emudhra/return', sessionExtra = null }) {
  const s = await readSettings();
  const problems = problemsOf(s);
  if (problems.length) throw Object.assign(new Error('eMudhra eSign is not set up yet.'), { code: 'NOT_READY' });
  const key = crypto.randomBytes(32);
  const ref = `TL${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 20);
  const back = (kind) => `${returnBase}${returnPath}/${ref}/${kind}`;
  const json = {
    FileType: 'PDF',
    File: pdf.toString('base64'),
    IsCompressed: false,
    ReferenceNumber: ref,
    Name: String(signerName || '').slice(0, 100),
    AuthToken: s.authToken,
    SignatureType: 3, // eSign (Aadhaar based) — India only
    SelectPage: 'LAST',
    SignaturePosition: 'Bottom-Right',
    PreviewRequired: false,
    EnableViewDocumentLink: true,
    SUrl: back('success'),
    FUrl: back('failure'),
    CUrl: back('cancel'),
  };
  const rsaKey = publicKeyOf(s.certificate);
  const p1 = crypto.publicEncrypt({ key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING }, key).toString('base64');
  const p2 = aesEcb(key, Buffer.from(JSON.stringify(json), 'utf8')).toString('base64');
  const p3 = aesEcb(key, Buffer.from(crypto.createHash('sha256').update(pdf).digest('hex'), 'utf8')).toString('base64');
  // eslint-disable-next-line global-require
  const { encryptSecret } = require('./secrets');
  await prisma.appSetting.create({
    data: {
      key: `${SESSION_PREFIX}${ref}`,
      value: JSON.stringify({ ...(sessionExtra || {}), clientId: client ? client.id : null, keyEnc: encryptSecret(key.toString('base64')), createdAt: new Date().toISOString(), status: 'Started', signerName }),
    },
  });
  const [f1, f2, f3] = s.fieldNames;
  return { ref, gatewayUrl: s.gatewayUrl, fields: { [f1]: p1, [f2]: p2, [f3]: p3 } };
}

async function readSession(ref) {
  if (!/^[A-Z0-9]{6,20}$/.test(String(ref || ''))) return null;
  const row = await prisma.appSetting.findUnique({ where: { key: `${SESSION_PREFIX}${ref}` } });
  if (!row) return null;
  try { return { ...JSON.parse(row.value), ref }; } catch { return null; }
}
async function closeSession(ref, status) {
  const row = await prisma.appSetting.findUnique({ where: { key: `${SESSION_PREFIX}${ref}` } });
  if (!row) return;
  let v = {};
  try { v = JSON.parse(row.value); } catch { /* keep empty */ }
  // The session key is no longer needed once the session is closed.
  await prisma.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify({ ...v, keyEnc: null, status, closedAt: new Date().toISOString() }) } });
}

async function apiGet(s, path, params) {
  const url = `${s.apiBase}/${path}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body) throw Object.assign(new Error(`eMudhra answered ${r.status}`), { code: 'BAD_ANSWER' });
  return body;
}

const looksSignedPdf = (buf) => buf && buf.slice(0, 5).toString('latin1') === '%PDF-'
  && /\/ByteRange\s*\[/.test(buf.toString('latin1')) && /\/Type\s*\/Sig\b|\/SubFilter\s*\//.test(buf.toString('latin1'));

// THE OFFICIAL CHECK after eMudhra posts back. Never trusts the posted form:
// returns { ok:true, transactionNumber, pdf } only when eMudhra's own status
// API says Completed and the signed PDF it returns decrypts to a digitally
// signed PDF; otherwise { ok:false, reason } in plain words.
async function verifyAndFetch({ ref, postedTxn }) {
  const session = await readSession(ref);
  if (!session) return { ok: false, reason: 'unknown or expired signing session', refuse: true };
  if (session.status !== 'Started' || !session.keyEnc) return { ok: false, reason: 'this signing session is already closed', refuse: true };
  if (Date.now() - new Date(session.createdAt).getTime() > SESSION_TTL_MS) return { ok: false, reason: 'this signing session expired', session };
  const txn = String(postedTxn || '').trim();
  if (!/^[A-Za-z0-9_\-/]{4,80}$/.test(txn)) return { ok: false, reason: 'no valid eMudhra transaction number came back', refuse: true, session };
  const s = await readSettings();
  if (problemsOf(s).length) return { ok: false, reason: 'eMudhra eSign is not set up', session };
  let status;
  try {
    status = await apiGet(s, 'TransactionStatusRequest', { AuthToken: s.authToken, Transactionnumber: txn, Referencenumber: ref });
  } catch (err) {
    return { ok: false, reason: `could not confirm with eMudhra (${String(err.message || err).slice(0, 120)})`, session };
  }
  const statusText = JSON.stringify((status && status.Value) || '');
  if (!status.IsSuccess || !/Completed/i.test(statusText)) return { ok: false, reason: 'eMudhra says the signing was not completed', session };
  let signed;
  try {
    signed = await apiGet(s, 'SignedDataRequest', { AuthToken: s.authToken, Transactionnumber: txn, Referencenumber: ref });
  } catch (err) {
    return { ok: false, reason: `could not fetch the signed PDF from eMudhra (${String(err.message || err).slice(0, 120)})`, session };
  }
  const enc = signed && signed.IsSuccess && signed.Value && (signed.Value.SignedData || signed.Value);
  if (!enc || typeof enc !== 'string' || /^Failure$/i.test(enc)) return { ok: false, reason: 'eMudhra returned no signed PDF', session };
  let pdf;
  try {
    // eslint-disable-next-line global-require
    const { decryptSecret } = require('./secrets');
    const key = Buffer.from(decryptSecret(session.keyEnc) || '', 'base64');
    pdf = aesEcbDecrypt(key, Buffer.from(enc, 'base64'));
    if (pdf.slice(0, 5).toString('latin1') !== '%PDF-') {
      const asText = Buffer.from(pdf.toString('utf8'), 'base64');
      if (asText.slice(0, 5).toString('latin1') === '%PDF-') pdf = asText;
    }
  } catch {
    return { ok: false, reason: 'the signed PDF from eMudhra could not be decrypted', session };
  }
  if (!looksSignedPdf(pdf)) return { ok: false, reason: 'the file from eMudhra is not a digitally signed PDF (it may be compressed — ask eMudhra)', session };
  return { ok: true, transactionNumber: txn, pdf, session };
}

module.exports = {
  CHANNEL, DEFAULTS, readSettings, setupReport, isAvailable, startSession, readSession, closeSession, verifyAndFetch,
  looksSignedPdf, problemsOf, aesEcb, aesEcbDecrypt, SESSION_PREFIX,
};
