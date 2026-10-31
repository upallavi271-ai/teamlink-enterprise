// ---------------------------------------------------------------------------
// ALL THE SIGNED AGREEMENT FILES OF A CLIENT (user request, 2026-10-17: "View agreement must open ALL signed files").
//
//   GET    /api/agreement/signed-files-summary          { rows: [{ clientId, count }] } for the clients THIS login may see
//   GET    /api/agreement/:clientId/signed-files        { has, count, files: [...], canRemove }
//   GET    /api/agreement/:clientId/signed-files/:docId the file itself (?download=1 saves it, otherwise a PDF / picture opens in the browser)
//   DELETE /api/agreement/:clientId/signed-files/:docId Admin / Super Admin only: takes the file off the client (the file stays on disk)
//   POST   /api/agreement/:clientId/signed-files?type=vasu|client|agreement   (multipart: file) the BDE team + Admin add a paper
//   POST   /api/agreement/new-client-signed                 { name, location, department } a client signed OUTSIDE the ATS
//
// UPLOADS (founder 2026-10-29): "bde dept mottham ni, view agreement client click chesaka, upload option raavali. total 3 -
// vasu sir confirmation, client confirmation, agreement". Every BDE and the BDE TL (any client: every BDE views every
// agreement) and Admin / Super Admin add files of three kinds; each is one more signed file (nothing is replaced, nothing
// changes the agreement's status). A client that signed before it was in the ATS is added from the same window (name,
// location, department) and its papers uploaded next: it shows in the Clients list at once; an Admin still turns its
// agreement Active (the agreement gate for requirements is unchanged).
//
// STORAGE (no schema change): each signed file = one ClientDocument row, kind 'AGREEMENT_SIGNED'
// (fileStored = the name made by utils/attachments.js). The extras (agreement date, department, branch,
// version, source folder, sha256, what kind of paper it is) = ONE AppSetting row 'agrsigned.<ClientDocument.id>',
// JSON { agreementDate, department, branch, label, version, folder, sha256, kind }. The rows are written by the importer.
//
// WHO: exactly the same rule as the client's own agreement file (routes/agreementOwnFile.js mountView) -
// loadForView / agreementAccess in routes/agreementSeal.js: the client's own login, their BDE, BDE TL, Manager,
// Accounts, Admin, Super Admin. A TL, STL, Recruiter or HR login is refused with the same 403 as every other agreement
// route (so they cannot tell whether files exist). Removing = access.edit = Admin / Super Admin only.
// The file is only ever found through a stored name that attachments.resolveStored accepts (no path tricks).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const attachments = require('../utils/attachments');
const profile = require('../utils/clientProfile');
const signing = require('../utils/agreementSigning');
const { logAudit } = require('../utils/audit');

const KIND = 'AGREEMENT_SIGNED';
// the three papers a BDE uploads (?type=)
const UPLOAD_TYPES = {
  vasu: 'Vasu sir confirmation', client: 'Client confirmation', agreement: 'Signed agreement',
  // THE TWO DIGILOCKER COPIES (founder 2026-10-31): DigiLocker's free Aadhaar eSign keeps ONE signature per PDF, so each side
  // eSigns its own copy of the same agreement (counterparts). A copy is taken only when it truly carries a valid digital
  // signature (utils/pdfSignature.js) - a merged / printed PDF that only shows signature boxes is refused.
  dlteamlink: 'TeamLink eSigned copy (DigiLocker)', dlclient: 'Client eSigned copy (DigiLocker)',
};
const DL_TYPES = ['dlteamlink', 'dlclient'];
const MAX_UPLOAD = 10 * 1024 * 1024;
const PREFIX = 'agrsigned.';
const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
};
const INLINE_OK = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const extOf = (name) => (/\.([A-Za-z0-9]{1,5})$/.exec(String(name || '').trim()) || [null, ''])[1].toLowerCase();
const safeName = (n) => String(n || 'agreement').replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 100) || 'agreement';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function metaOf(row) {
  let m = {};
  try { m = JSON.parse(row.value) || {}; } catch { m = {}; }
  return m && typeof m === 'object' ? m : {};
}

// The usable signed files of one client, newest agreement date first (no date = last, then newest added).
async function filesOf(clientId) {
  if (!profile.docsAvailable()) return [];
  const docs = await prisma.clientDocument.findMany({ where: { clientId, kind: KIND } });
  if (!docs.length) return [];
  const settings = await prisma.appSetting.findMany({ where: { key: { in: docs.map((d) => `${PREFIX}${d.id}`) } } });
  const byKey = new Map(settings.map((s) => [s.key, metaOf(s)]));
  const out = [];
  docs.forEach((d) => {
    if (!attachments.resolveStored(d.fileStored)) return; // the file is gone from disk: do not offer it
    const m = byKey.get(`${PREFIX}${d.id}`) || {};
    const mime = EXT_MIME[extOf(d.fileStored)] || d.fileMime || 'application/octet-stream';
    out.push({
      id: d.id,
      label: String(m.label || d.name || 'Signed agreement').slice(0, 200),
      fileName: d.fileName || null,
      mime,
      size: d.fileSize,
      agreementDate: typeof m.agreementDate === 'string' && YMD.test(m.agreementDate) ? m.agreementDate : null,
      department: m.department || null,
      branch: m.branch || null,
      version: m.version || null,
      kind: m.kind || 'Signed agreement',
      // a DigiLocker copy: what the signature check found when it was uploaded
      esign: m.esign && typeof m.esign === 'object' ? { valid: !!m.esign.valid, signer: m.esign.signer || null, issuer: m.esign.issuer || null, signedAt: m.esign.signedAt || null } : null,
      canShow: INLINE_OK.has(mime),
      addedAt: d.createdAt,
    });
  });
  out.sort((a, b) => {
    if (a.agreementDate && b.agreementDate && a.agreementDate !== b.agreementDate) return a.agreementDate < b.agreementDate ? 1 : -1;
    if (!!a.agreementDate !== !!b.agreementDate) return a.agreementDate ? -1 : 1;
    return new Date(b.addedAt) - new Date(a.addedAt);
  });
  return out;
}

// How many usable signed files a client has - for the own-file info route (old screens).
async function countFor(clientId) {
  try { return (await filesOf(clientId)).length; } catch { return 0; }
}

// THE AGREEMENT STATUS FROM THE PAPERS (founder 2026-10-29: "signed agreement upload chesaka kuda, unsigned ani vasthundhi"):
//   Signed agreement + Vasu sir confirmation on file -> ACTIVE (signed and approved: requirements can open)
//   Signed agreement alone                           -> SIGNED (an Admin activates it)
// Only moves forward: a client already Signed / Active is not touched (Signed -> Active when the confirmation comes later).
// Returns the new status, or null when nothing changed. Never throws.
const SIGNED_NOW = ['SIGNED', 'ACTIVE'];

// ---- A WEB LINK TO ONE DIGILOCKER COPY (founder 2026-10-31: "verey option ettochu kadha, andharu ekkuva use chesedhi") ----------
// The summary's file names open only in Adobe Acrobat Reader (they are PDF attachments). Each copy also gets a web link that opens
// the exact signed copy in any browser or phone (Chrome, Edge, WhatsApp preview): /api/agreement/esign-copy/<docId>/<sig>.
// sig = HMAC(server secret, document id + the copy's SHA-256): nobody can guess another file's link, and a replaced file's old
// link stops working. It needs no login (a client reading the summary has none): whoever holds the summary can open its two copies.
const crypto = require('crypto');

const copySecret = () => process.env.AGREEMENT_LINK_SECRET || process.env.JWT_SECRET || 'teamlink-agreement-link';
const copySig = (docId, sha256) => crypto.createHmac('sha256', copySecret()).update(`esigncopy:${docId}:${sha256}`).digest('hex').slice(0, 40);
function apiBase(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, '');
  // behind nginx the browser's own address arrives in the X-Forwarded-* headers
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
async function statusFromPapers(clientId, user) {
  try {
    const files = await filesOf(clientId);
    const has = (label) => files.some((f) => f.label === label || f.kind === label);
    // both DigiLocker copies with a valid signature = executed (each side signed the same agreement with Aadhaar eSign)
    const dl = (label) => files.some((f) => f.kind === label && f.esign && f.esign.valid);
    const dlBoth = dl(UPLOAD_TYPES.dlteamlink) && dl(UPLOAD_TYPES.dlclient);
    if (!has(UPLOAD_TYPES.agreement) && !dlBoth && !dl(UPLOAD_TYPES.dlclient)) return null;
    const target = dlBoth || has(UPLOAD_TYPES.vasu) ? 'ACTIVE' : 'SIGNED';
    const c = await prisma.client.findUnique({ where: { id: clientId }, select: { agreementStatus: true, agreementSignedAt: true, agreementActivatedAt: true } });
    const now = String(c && c.agreementStatus || '').toUpperCase();
    if (!c || now === target || (now === 'ACTIVE') || (now === 'SIGNED' && target === 'SIGNED')) return null;
    const at = new Date();
    await prisma.client.update({
      where: { id: clientId },
      data: {
        agreementStatus: target,
        agreementSignedAt: c.agreementSignedAt || at,
        ...(target === 'ACTIVE' ? { agreementActivatedAt: c.agreementActivatedAt || at } : {}),
        agreementSource: dlBoth ? 'DigiLocker Aadhaar eSign (two signed copies)' : 'Uploaded (signed outside the ATS)',
      },
    });
    await logAudit({
      userId: user ? user.id : null, actorName: user ? user.name || null : 'TeamLink', action: target === 'ACTIVE' ? 'Agreement active (signed papers uploaded)' : 'Agreement signed (signed copy uploaded)',
      entity: 'Client', entityId: clientId, field: 'agreementStatus', fieldLabel: 'Agreement', fromValue: now || 'DRAFT', toValue: target,
      reason: dlBoth ? 'TeamLink and the client each eSigned their copy with Aadhaar (DigiLocker); both signatures checked valid'
        : (target === 'ACTIVE' ? 'Signed agreement and Vasu sir confirmation are on file' : 'Signed agreement on file; Vasu sir confirmation not yet - an Admin activates it'),
    });
    // ALL DONE: thank the client, with both signed copies and the summary (founder 2026-10-31: "mottham complete ayyaka thank you
    // ani raavali client ki"). After the reply, never in its way; the result is in the client's history.
    if (target === 'ACTIVE' && dlBoth) {
      setImmediate(() => {
        require('../utils/agreementLifecycle').dispatchThankYou(clientId) // eslint-disable-line global-require
          .then((r) => logAudit({
            userId: user ? user.id : null, actorName: user ? user.name || null : 'TeamLink', action: 'Agreement thank-you sent to the client',
            entity: 'Client', entityId: clientId, toValue: require('../utils/agreementLifecycle').describeDispatch(r).slice(0, 300), // eslint-disable-line global-require
          }))
          .catch((e) => console.error('[agreement papers] thank-you not sent:', e.message)); // eslint-disable-line no-console
      });
    }
    return target;
  } catch (e) {
    console.error('[agreement papers] status not updated:', e.message); // eslint-disable-line no-console
    return null;
  }
}

// who adds signed papers: the whole BDE team (BDE + BDE TL) and Admin / Super Admin
function mayAdd(user, access) {
  if (access && access.edit) return true;
  return require('../utils/clientLifecycle').isBdeTeam(user); // eslint-disable-line global-require
}

// THE TWO DIGILOCKER COPIES of a client (the newest valid-or-not of each side), each checked again now, with its bytes.
// base: the address the summary's web links start with (none = no links).
async function esignCopies(clientId, base = null) {
  const files = await filesOf(clientId);
  const newest = (kind) => files.filter((f) => f.kind === kind).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))[0] || null;
  const copyOf = async (f) => {
    if (!f) return null;
    const d = await prisma.clientDocument.findUnique({ where: { id: f.id }, select: { fileStored: true, fileName: true } });
    const p = d ? attachments.resolveStored(d.fileStored) : null;
    if (!p) return null;
    const buf = require('fs').readFileSync(p); // eslint-disable-line global-require
    const r = require('../utils/pdfSignature').inspect(buf); // eslint-disable-line global-require
    const out = {
      signer: (r.last && r.last.signer) || (f.esign && f.esign.signer) || null, signedAt: (r.last && r.last.signedAt) || null,
      issuer: (r.last && r.last.issuer) || null, valid: r.valid, fileName: d.fileName || f.fileName, buf, // attached to the summary
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
    // the web link that opens this copy in any browser (see copySig above)
    if (base) out.url = `${base}/api/agreement/esign-copy/${f.id}/${copySig(f.id, out.sha256)}`;
    return out;
  };
  const [us, them] = await Promise.all([copyOf(newest(UPLOAD_TYPES.dlteamlink)), copyOf(newest(UPLOAD_TYPES.dlclient))]);
  return { us, them };
}
// the signature summary PDF (both sides on one page), written to `out` (a response, or a sink that collects a Buffer)
async function writeSummary(client, { us, them }, out) {
  const party = await require('../utils/agreement').consultantParty().catch(() => ({})); // eslint-disable-line global-require
  return require('../utils/esignSummaryPdf').renderEsignSummary({ // eslint-disable-line global-require
    client, agreementId: client.agreementId, consultantName: party.name || 'TeamLink Consultants',
    logoPath: require('../utils/agreementPdf').LOGO, // eslint-disable-line global-require
    sides: [
      { side: 'teamlink', title: `For ${party.name || 'TeamLink Consultants'}`, copy: us },
      { side: 'client', title: `For ${client.legalName || client.name}`, copy: them },
    ],
  }, out);
}
async function summaryBuffer(client, copies) {
  const { PassThrough } = require('stream'); // eslint-disable-line global-require
  const sink = new PassThrough();
  const parts = [];
  sink.on('data', (b) => parts.push(b));
  const done = new Promise((ok) => { sink.on('end', ok); sink.on('finish', ok); });
  await writeSummary(client, copies, sink);
  await done;
  return Buffer.concat(parts);
}

function mountView(router, { requireAuth, loadForView }) {
  // ONE DIGILOCKER COPY BY ITS WEB LINK (the links printed on the signature summary). No login; the signature in the link decides.
  router.get('/esign-copy/:docId/:sig', async (req, res, next) => {
    try {
      const nope = () => res.status(404).type('text/plain').send('This link is not valid any more. Ask TeamLink for a fresh signature summary.');
      if (!/^[a-f0-9]{40}$/.test(String(req.params.sig || ''))) return nope();
      const d = await prisma.clientDocument.findFirst({ where: { id: String(req.params.docId), kind: KIND } });
      const meta = d && metaOf(await prisma.appSetting.findUnique({ where: { key: `${PREFIX}${d.id}` } }));
      if (!d || !meta || !meta.esign) return nope(); // only the DigiLocker copies have a web link
      const p = attachments.resolveStored(d.fileStored);
      if (!p) return nope();
      const buf = require('fs').readFileSync(p); // eslint-disable-line global-require
      const want = Buffer.from(copySig(d.id, crypto.createHash('sha256').update(buf).digest('hex')));
      const got = Buffer.from(String(req.params.sig));
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return nope();
      res.set('Content-Type', 'application/pdf');
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Robots-Tag', 'noindex');
      res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(d.fileName || 'signed-copy.pdf').replace(/\.pdf$/i, '')}.pdf"`);
      return res.send(buf);
    } catch (err) { return next(err); }
  });

  // A CLIENT THAT SIGNED OUTSIDE THE ATS: add it (then its papers are uploaded through POST /:clientId/signed-files).
  router.post('/new-client-signed', requireAuth, async (req, res, next) => {
    try {
      if (!mayAdd(req.user, { edit: !!require('../utils/scope').scopeOf(req.user).global })) { // eslint-disable-line global-require
        return res.status(403).json({ error: 'Adding a client from a signed agreement is for the BDE team and Admin.' });
      }
      const b = req.body || {};
      const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
      const name = clean(b.name, 160);
      const location = clean(b.location, 120);
      const department = clean(b.department, 60);
      if (name.length < 2) return res.status(400).json({ error: 'Type the client\'s name as it is on the agreement.' });
      if (!location) return res.status(400).json({ error: 'Type the location (city / branch) of this client.' });
      if (!department) return res.status(400).json({ error: 'Pick the department.' });
      // the same client at the same place is already here: upload to it instead (another location is a new client)
      const { findClientDuplicates } = require('../utils/clientDuplicates'); // eslint-disable-line global-require
      const CLOC = require('../utils/clientLocations'); // eslint-disable-line global-require
      const dup = await findClientDuplicates({ name, location });
      const question = await CLOC.buildQuestion(dup, { name, location });
      if (question) {
        const m = question.matches && question.matches[0];
        return res.status(409).json({ code: 'CLIENT_EXISTS', error: `${m ? `${m.name}${m.location ? ` (${m.location})` : ''}` : 'This client'} is already in the ATS. Open it in View agreement and upload the papers there.`, clientId: m ? m.id : null });
      }
      const me = require('../utils/scope').scopeOf(req.user); // eslint-disable-line global-require
      const client = await prisma.client.create({
        data: {
          name, legalName: name, location, ownerDepartment: department, status: 'Active', clientType: 'Direct',
          bdeOwner: me.atsRole === 'BDE' ? (req.user.name || null) : null,
          internalNotes: `Added from a signed agreement (signed outside the ATS) by ${req.user.name || 'the BDE team'} on ${new Date().toISOString().slice(0, 10)}.`,
        },
      });
      try { CLOC.forgetLabels(); } catch { /* the label cache refills by itself */ }
      await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Client added from a signed agreement', entity: 'Client', entityId: client.id, toValue: `${name} (${location}) · ${department}` });
      return res.status(201).json({ ok: true, client: { id: client.id, name: client.name, location: client.location }, message: `${name} is added to Clients. Now upload its papers.` });
    } catch (err) { return next(err); }
  });

  // ADD A SIGNED PAPER: Vasu sir confirmation / Client confirmation / Signed agreement
  router.post('/:clientId/signed-files', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      if (!mayAdd(req.user, loaded.access)) return res.status(403).json({ error: 'Uploading agreement papers is for the BDE team and Admin.' });
      if (!profile.docsAvailable()) return res.status(503).json({ error: 'Files cannot be saved on this server yet.' });
      const type = String(req.query.type || '');
      const label = UPLOAD_TYPES[type];
      if (!label) return res.status(400).json({ error: 'Say which paper this is: Vasu sir confirmation, Client confirmation or Agreement.' });
      let parsed;
      try { parsed = await attachments.parseMultipart(req, { maxBytes: MAX_UPLOAD }); } catch (err) {
        if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'The file is too big. Keep it under 10 MB.' });
        return res.status(400).json({ error: 'Choose a file to upload.' });
      }
      const file = parsed.file;
      if (!file || !file.data || !file.data.length) return res.status(400).json({ error: 'Choose a file to upload.' });
      const mime = EXT_MIME[extOf(file.filename)];
      if (!mime) return res.status(400).json({ error: 'Upload a PDF, Word file or a picture (JPG / PNG).' });
      // a DigiLocker copy: a PDF that really carries a valid digital signature
      let esign = null;
      if (DL_TYPES.includes(type)) {
        if (mime !== 'application/pdf') return res.status(400).json({ error: 'Upload the PDF you downloaded from DigiLocker after eSign.' });
        const r = require('../utils/pdfSignature').inspect(file.data); // eslint-disable-line global-require
        if (!r.signed) return res.status(400).json({ error: 'This PDF has no digital signature. A merged, printed or scanned copy only shows the signature box. Upload the file you downloaded from DigiLocker right after eSign.' });
        if (!r.valid) return res.status(400).json({ error: `The signature in this PDF is not valid${r.last && !r.last.unchanged ? ': the file was changed after it was signed' : ''}. Upload the file exactly as DigiLocker gave it (do not edit, merge, compress or print it).` });
        esign = { valid: true, signer: r.last.signer, issuer: r.last.issuer, signedAt: r.last.signedAt, count: r.count };
        // IS IT THIS CLIENT'S AGREEMENT? (founder 2026-10-31: "agreement proper ithey ney ... green tick vasthadhi"). A valid signature
        // only says the file is untouched since eSign; the words must also carry this agreement's number. Checked when the agreement
        // was made in TeamLink (a client's own agreement has no such number) and the PDF's words can be read (a scan cannot).
        const c = loaded.client;
        if (c.agreementId && (c.agreementSource || 'Generated') === 'Generated') {
          const words = require('../utils/pdfSignature').textOf(file.data).replace(/\s+/g, ''); // eslint-disable-line global-require
          const idRe = new RegExp(`${String(c.agreementId).replace(/[^A-Za-z0-9]/g, '')}(?![0-9])`);
          if (words.length > 300 && !idRe.test(words)) {
            return res.status(400).json({ error: `This signed PDF is not agreement ${c.agreementId} of ${c.name}: its pages do not carry that agreement number. Download this client's agreement with "Download agreement PDF to eSign", eSign that file and upload it.` });
          }
          esign.matched = idRe.test(words) ? c.agreementId : null; // null: the words could not be read
        }
        // ONE PERSON CANNOT SIGN FOR BOTH SIDES: the client copy must be eSigned by the client's own person, not by TeamLink's signer
        const other = (await filesOf(c.id)).find((f) => f.kind === (type === 'dlclient' ? UPLOAD_TYPES.dlteamlink : UPLOAD_TYPES.dlclient) && f.esign && f.esign.valid);
        const norm = (n) => String(n || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
        if (other && norm(other.esign.signer) && norm(other.esign.signer) === norm(esign.signer)) {
          return res.status(400).json({ error: type === 'dlclient'
            ? `This copy is eSigned by ${esign.signer}, the same person who signed for TeamLink. The client's authorised person must eSign it with their own Aadhaar.`
            : `This copy is eSigned by ${esign.signer}, the same person who signed the client's copy. TeamLink's director must eSign it with their own Aadhaar.` });
        }
      }
      let stored;
      try { stored = attachments.store({ ...file, contentType: mime }, { maxBytes: MAX_UPLOAD, allowWord: true }); } catch (err) {
        if (err.code === 'TOO_LARGE') return res.status(413).json({ error: 'The file is too big. Keep it under 10 MB.' });
        return res.status(400).json({ error: 'That file could not be read as a PDF, Word file or picture. Please pick it again.' });
      }
      const row = await prisma.clientDocument.create({
        data: {
          clientId: loaded.client.id, kind: KIND, name: label,
          fileStored: stored.billFile, fileName: stored.billName, fileMime: stored.billMime, fileSize: stored.billSize,
          uploadedById: req.user.id, uploadedByName: req.user.name || null,
        },
      });
      await prisma.appSetting.create({ data: { key: `${PREFIX}${row.id}`, value: JSON.stringify({ label, kind: label, uploadedBy: req.user.name || null, ...(esign ? { esign, sha256: require('crypto').createHash('sha256').update(file.data).digest('hex') } : {}) }) } }); // eslint-disable-line global-require
      await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Agreement paper uploaded', entity: 'Client', entityId: loaded.client.id, toValue: `${label}: ${stored.billName}${esign ? ` - valid Aadhaar eSign by ${esign.signer || 'unknown'} (${esign.issuer || 'CA'})` : ''}`.slice(0, 300) });
      const status = await statusFromPapers(loaded.client.id, req.user);
      const said = status === 'ACTIVE' ? ` The agreement is now Active.${type.startsWith('dl') ? ' A thank-you email with both signed copies and the summary goes to the client.' : ''}` : status === 'SIGNED' ? (type === 'dlclient' ? ' The agreement is now Signed by the client (upload the TeamLink eSigned copy to make it Active).' : ' The agreement is now Signed (upload Vasu sir confirmation to make it Active).') : '';
      const who = esign ? ` Valid Aadhaar eSign by ${esign.signer || 'the signer'}.` : '';
      return res.status(201).json({ ok: true, message: `${label} uploaded.${who}${said}`, agreementStatus: status, files: await filesOf(loaded.client.id) });
    } catch (err) { return next(err); }
  });


  // Which of MY clients have signed files (one call for a whole list). Same refusal as GET /list.
  router.get('/signed-files-summary', requireAuth, async (req, res, next) => {
    try {
      const where = await signing.visibleClientWhere(req.user);
      if (!where) return res.status(403).json({ error: 'Agreements are visible to the client, their BDE, Accounts, Admin and Super Admin.' });
      if (!profile.docsAvailable()) return res.json({ rows: [] });
      const g = await prisma.clientDocument.groupBy({ by: ['clientId'], where: { kind: KIND, client: where }, _count: { _all: true } });
      return res.json({ rows: g.map((x) => ({ clientId: x.clientId, count: x._count._all })) });
    } catch (err) { return next(err); }
  });

  // THE CLIENTS WHOSE AGREEMENT THIS LOGIN MAY OPEN - names only, for the "View agreement -> which client?" picker
  // (founder 2026-10-29: every BDE views every agreement; the BDE workspace list holds only their own clients).
  router.get('/viewable-clients', requireAuth, async (req, res, next) => {
    try {
      const where = await signing.visibleClientWhere(req.user);
      if (!where) return res.status(403).json({ error: 'Agreements are visible to the client, their BDE, Accounts, Admin and Super Admin.' });
      const rows = await prisma.client.findMany({ where, select: { id: true, name: true, location: true, clientCode: true }, orderBy: { name: 'asc' }, take: 5000 });
      return res.json({ rows });
    } catch (err) { return next(err); }
  });

  // CLIENTS WITH NO AGREEMENT AT ALL (founder, 2026-10-23: "View agreement" says "No signed agreement uploaded yet" for some clients - list them).
  // A client is listed when none of these exists: a made / e-sign agreement text, a signed file, the client's own uploaded file, an active Drive link.
  // Same reach as GET /list (the server refuses a login that may not read agreements). Stopped / inactive clients are listed last and marked.
  router.get('/missing', requireAuth, async (req, res, next) => {
    try {
      const where = await signing.visibleClientWhere(req.user);
      if (!where) return res.status(403).json({ error: 'Agreements are visible to the client, their BDE, Accounts, Admin and Super Admin.' });
      const DL = require('../utils/agreementDriveLinks'); // eslint-disable-line global-require
      const docsOk = profile.docsAvailable();
      const clients = await prisma.client.findMany({
        where: { AND: [where, { OR: [{ agreementDocument: null }, { agreementDocument: '' }] }] },
        select: { id: true, name: true, clientCode: true, location: true, status: true, bdeOwner: true, agreementStatus: true, createdAt: true },
        orderBy: { name: 'asc' },
        take: 5000,
      });
      const have = new Set();
      const lostFile = new Set(); // a file is recorded for the client but is not on this server's disk
      if (docsOk && clients.length) {
        const ids = clients.map((c) => c.id);
        const docs = await prisma.clientDocument.findMany({
          where: { clientId: { in: ids }, OR: [{ kind: KIND }, { kind: 'AGREEMENT', name: "Client's own agreement" }] },
          select: { clientId: true, fileStored: true },
        });
        docs.forEach((d) => { if (attachments.resolveStored(d.fileStored)) have.add(d.clientId); else lostFile.add(d.clientId); });
        try {
          const links = (await DL.docsWithMeta({ client: where })).filter(DL.isActive);
          links.forEach((x) => have.add(x.doc.clientId));
        } catch { /* links are optional */ }
      }
      const rows = clients.filter((c) => !have.has(c.id)).map((c) => ({
        id: c.id, name: c.name, clientCode: c.clientCode || null, location: c.location || null,
        status: c.status || 'Active', bdeOwner: c.bdeOwner || null, agreementStatus: c.agreementStatus, addedAt: c.createdAt,
        fileLost: lostFile.has(c.id), // true = an agreement was recorded but its file cannot be found on this server
      }));
      rows.sort((a, b) => (a.status === 'Active' ? 0 : 1) - (b.status === 'Active' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
      return res.set('Cache-Control', 'no-store').json({ total: rows.length, rows });
    } catch (err) { return next(err); }
  });

  // THE TWO DIGILOCKER SIGNATURES SIDE BY SIDE (founder 2026-10-31): one summary page, made fresh - each signed copy on disk
  // is checked again (utils/pdfSignature.js) and its fingerprint taken. TeamLink's summary; the signatures stay in the copies.
  router.get('/:clientId/esign-summary', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      const { us, them } = await esignCopies(loaded.client.id, apiBase(req));
      if (!us && !them) return res.status(404).json({ error: 'No DigiLocker eSigned copy is on file yet.' });
      const c = loaded.client;
      res.set('Content-Type', 'application/pdf');
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${safeName(`${c.agreementId || 'agreement'}-signature-summary`)}.pdf"`);
      await writeSummary(c, { us, them }, res);
      return undefined;
    } catch (err) { return next(err); }
  });

  router.get('/:clientId/signed-files', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      const files = await filesOf(loaded.client.id);
      return res.json({ has: files.length > 0, count: files.length, files, canRemove: !!loaded.access.edit, canAdd: mayAdd(req.user, loaded.access), types: UPLOAD_TYPES });
    } catch (err) { return next(err); }
  });

  router.get('/:clientId/signed-files/:docId', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res);
      if (!loaded) return undefined;
      const d = profile.docsAvailable()
        ? await prisma.clientDocument.findFirst({ where: { id: String(req.params.docId), clientId: loaded.client.id, kind: KIND } })
        : null;
      const file = d ? attachments.resolveStored(d.fileStored) : null;
      if (!d || !file) return res.status(404).json({ error: 'That agreement file is not on this client.' });
      const mime = EXT_MIME[extOf(d.fileStored)] || 'application/octet-stream';
      const inline = !req.query.download && INLINE_OK.has(mime);
      res.set('Content-Type', mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName(d.fileName)}"`);
      return res.sendFile(file); // sets the real Content-Length
    } catch (err) { return next(err); }
  });

  router.delete('/:clientId/signed-files/:docId', requireAuth, async (req, res, next) => {
    try {
      const loaded = await loadForView(req, res, { edit: true }); // Admin / Super Admin only
      if (!loaded) return undefined;
      const d = profile.docsAvailable()
        ? await prisma.clientDocument.findFirst({ where: { id: String(req.params.docId), clientId: loaded.client.id, kind: KIND } })
        : null;
      if (!d) return res.status(404).json({ error: 'That agreement file is not on this client.' });
      const meta = await prisma.appSetting.findUnique({ where: { key: `${PREFIX}${d.id}` } });
      const m = meta ? metaOf(meta) : {};
      // The row and its extras go; the file itself stays on disk (it can be put back by the importer).
      await prisma.clientDocument.delete({ where: { id: d.id } });
      if (meta) await prisma.appSetting.delete({ where: { key: meta.key } }).catch(() => {});
      await logAudit({
        userId: req.user.id, action: 'Signed agreement file removed', entity: 'Client', entityId: loaded.client.id,
        fromValue: String(m.label || d.name || '').slice(0, 200), toValue: `${d.fileName || ''} (file kept on the server: ${d.fileStored})`.slice(0, 300),
      });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });
}

module.exports = { esignCopies, summaryBuffer, mountView, filesOf, countFor, statusFromPapers, KIND, PREFIX };
