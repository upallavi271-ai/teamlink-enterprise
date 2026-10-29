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
const UPLOAD_TYPES = { vasu: 'Vasu sir confirmation', client: 'Client confirmation', agreement: 'Signed agreement' };
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

// who adds signed papers: the whole BDE team (BDE + BDE TL) and Admin / Super Admin
function mayAdd(user, access) {
  if (access && access.edit) return true;
  return require('../utils/clientLifecycle').isBdeTeam(user); // eslint-disable-line global-require
}

function mountView(router, { requireAuth, loadForView }) {
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
      await prisma.appSetting.create({ data: { key: `${PREFIX}${row.id}`, value: JSON.stringify({ label, kind: label, uploadedBy: req.user.name || null }) } });
      await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Agreement paper uploaded', entity: 'Client', entityId: loaded.client.id, toValue: `${label}: ${stored.billName}`.slice(0, 300) });
      return res.status(201).json({ ok: true, message: `${label} uploaded.`, files: await filesOf(loaded.client.id) });
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

module.exports = { mountView, filesOf, countFor, KIND, PREFIX };
