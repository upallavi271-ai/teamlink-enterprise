// ---------------------------------------------------------------------------
// /api/credentials-vault — Administration -> Company Setup -> Credentials vault (utils/credentialVault.js has the rules).
//
//   GET    /me                          what this login may do here (+ whether INTEGRATION_SECRET_KEY is set)
//   GET    /options                     platforms, employees, departments for the form and the filters
//   GET    /credentials                 the list - passwords masked, never a secret
//   GET    /credentials/:id             one login + its history
//   POST   /credentials                 add          PUT /credentials/:id  change          DELETE /credentials/:id  delete
//   POST   /credentials/bulk            { ids, action: assign | disable | enable | delete, employeeIds, mode, confirm }
//   POST   /reauth                      { password } -> a 5-minute ticket (X-Vault-Reauth header); 5 wrong = 15-minute lock
//   POST   /credentials/:id/reveal      { field: password | extra, purpose: show | copy } + X-Vault-Reauth -> the one value
//   GET    /access-log                  "Who opened what"
//   GET    /grants  PUT /grants/:userId  GET /people   per-person access (the real Super Admin only)
//   GET    /import/template  POST /import/preview (multipart)  /import/check  /import/apply  GET /import/batches  POST /import/batches/:id/undo
//   POST   /export                      { filters, withPasswords, confirmText } -> .xlsx; with passwords: + X-Vault-Reauth and "I understand"
// Everything outside the login's rights answers 403. Every answer is Cache-Control: no-store.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const V = require('../utils/credentialVault');
const secrets = require('../utils/secrets');
const attachments = require('../utils/attachments');
const { ipOf } = require('../utils/clientIp');
const prisma = require('../db');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });

const guard = (fn) => async (req, res, next) => {
  try {
    req.vault = await V.rightsFor(req.user);
    return await fn(req, res);
  } catch (e) {
    if (e instanceof V.VaultError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
    // never echo an unexpected error's text: it could carry a value
    console.error('[vault] %s %s failed: %s', req.method, req.path, e && e.code ? e.code : 'error'); // eslint-disable-line no-console
    return next(Object.assign(new Error('The vault could not do that. Try again.'), { status: 500 }));
  }
};
const deny = (msg = 'The credentials vault is not part of your access. The Super Admin can grant it in Role Catalog or on the vault\'s Access tab.') => new V.VaultError(403, msg);
const needView = (req) => { if (!req.vault.view) throw deny(); };
// Showing, copying, exporting secrets and changing access are never done while viewing or acting as somebody else.
const notProxy = (req) => { if (req.viewAs || req.actingAs) throw new V.VaultError(403, 'Not while viewing or acting as another person. Return to your own login first.'); };
const ip = (req) => ipOf(req);
const reauthToken = (req) => req.get('x-vault-reauth') || '';

router.get('/me', guard(async (req, res) => {
  const menu = await V.menuRightsFor(req.user);
  res.json({
    rights: req.vault, open: !!(menu && menu.open), ownOnly: !!(menu && menu.own), keyConfigured: secrets.secretsConfigured(),
    keyMessage: secrets.secretsConfigured() ? null : secrets.NO_KEY_MESSAGE, confirmWords: V.CONFIRM_WORDS, showSeconds: V.SHOW_SECONDS,
    reauthMinutes: V.REAUTH_MS / 60000, lockAfter: V.LOCK_AFTER, lockMinutes: V.LOCK_MS / 60000,
  });
}));

router.get('/options', guard(async (req, res) => {
  const menu = await V.menuRightsFor(req.user);
  if (!menu || !menu.open) throw deny();
  const o = await V.options();
  // the own-only employee needs the platform list for the filters, not the company's employee list
  if (!req.vault.view) { o.employees = []; o.departments = []; }
  res.json(o);
}));

router.get('/credentials', guard(async (req, res) => {
  const menu = await V.menuRightsFor(req.user);
  if (!menu || !menu.open) throw deny();
  const rows = await V.list(req.user, req.vault, req.query || {});
  res.json({ rows, ownOnly: !req.vault.view });
}));

router.post('/credentials/bulk', guard(async (req, res) => {
  needView(req); notProxy(req);
  res.json(await V.bulk(req.user, req.vault, req.body || {}, ip(req)));
}));

router.get('/credentials/:id', guard(async (req, res) => {
  const menu = await V.menuRightsFor(req.user);
  if (!menu || !menu.open) throw deny();
  res.json(await V.detail(req.user, req.vault, req.params.id));
}));

router.post('/credentials', guard(async (req, res) => {
  needView(req); notProxy(req);
  res.status(201).json({ credential: await V.save(req.user, req.vault, null, req.body || {}, ip(req)) });
}));
router.put('/credentials/:id', guard(async (req, res) => {
  needView(req); notProxy(req);
  res.json({ credential: await V.save(req.user, req.vault, req.params.id, req.body || {}, ip(req)) });
}));
router.delete('/credentials/:id', guard(async (req, res) => {
  needView(req); notProxy(req);
  res.json(await V.remove(req.user, req.vault, req.params.id, ip(req)));
}));

router.post('/reauth', guard(async (req, res) => {
  const menu = await V.menuRightsFor(req.user);
  if (!menu || !menu.open) throw deny();
  notProxy(req);
  res.json(await V.reauth(req.user, (req.body || {}).password, ip(req)));
}));

router.post('/credentials/:id/reveal', guard(async (req, res) => {
  const menu = await V.menuRightsFor(req.user);
  if (!menu || !menu.open) throw deny();
  notProxy(req);
  await V.checkReauth(req.user, reauthToken(req));
  res.json(await V.reveal(req.user, req.vault, req.params.id, req.body || {}, ip(req)));
}));

router.get('/access-log', guard(async (req, res) => {
  needView(req);
  res.json({ rows: await V.accessLog(req.query || {}) });
}));

// ---- per-person access: the real Super Admin only --------------------------------------------------------------------
const needSettings = (req) => { if (!req.vault.settings) throw deny('Only the Super Admin decides who may open the vault.'); };
router.get('/grants', guard(async (req, res) => { needSettings(req); res.json({ grants: await V.grants() }); }));
router.put('/grants/:userId', guard(async (req, res) => {
  needSettings(req); notProxy(req);
  res.json(await V.setGrant(req.user, req.params.userId, (req.body || {}).rights || {}, ip(req)));
}));
router.get('/people', guard(async (req, res) => {
  needSettings(req);
  const text = String((req.query || {}).q || '').trim().slice(0, 60);
  const users = await prisma.user.findMany({
    where: { status: 'Active', role: { notIn: ['CLIENT', 'CANDIDATE'] }, ...(text ? { OR: [{ name: { contains: text } }, { email: { contains: text } }] } : {}) },
    select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' }, take: 30,
  });
  res.json({ people: users });
}));

// ---- import ----------------------------------------------------------------------------------------------------------
const needImport = (req) => { needView(req); if (!req.vault.import) throw deny('Importing logins is not part of your access.'); notProxy(req); };
router.get('/import/template', guard(async (req, res) => {
  needImport(req);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="teamlink-credentials-import-template.xlsx"');
  res.send(V.template());
}));
router.post('/import/preview', guard(async (req, res) => {
  needImport(req);
  let upload;
  try {
    // read into memory only: attachments.parseMultipart never writes the body to disk
    upload = await attachments.parseMultipart(req, { maxBytes: V.MAX_BYTES });
  } catch (err) {
    if (err.code === 'TOO_LARGE') throw new V.VaultError(413, 'That file is over 5 MB. Split it into smaller files.');
    throw new V.VaultError(400, 'Send the sheet as a file upload.');
  }
  const { file, fields = {} } = upload;
  if (!file || !file.data || !file.data.length) throw new V.VaultError(400, 'Choose the sheet to import.');
  let mapping = null;
  if (fields.mapping) { try { mapping = JSON.parse(fields.mapping); } catch { mapping = null; } }
  const out = await V.preview(req.user, file, { mapping, sheet: fields.sheet || null });
  file.data.fill(0); // the bytes are dropped with the request; zeroed first so no copy of the sheet lingers in memory
  res.json(out);
}));
router.post('/import/check', guard(async (req, res) => { needImport(req); res.json(await V.check(req.user, (req.body || {}).batchId, (req.body || {}).choices)); }));
router.post('/import/apply', guard(async (req, res) => {
  needImport(req);
  const out = await V.apply(req.user, (req.body || {}).batchId, (req.body || {}).choices, ip(req));
  res.json({ ...out, message: `${out.created} login${out.created === 1 ? '' : 's'} imported and encrypted.${out.refused ? ` ${out.refused} refused.` : ''}${out.waiting ? ` ${out.waiting} skipped (no employee chosen).` : ''} You can undo this import.` });
}));
router.get('/import/batches', guard(async (req, res) => { needImport(req); res.json({ batches: await V.batches(req.user) }); }));
router.post('/import/batches/:id/undo', guard(async (req, res) => {
  needImport(req);
  const out = await V.undo(req.user, req.params.id, ip(req));
  res.json({ ...out, message: `${out.removed} imported login${out.removed === 1 ? '' : 's'} removed.${out.kept ? ` ${out.kept} kept because somebody changed ${out.kept === 1 ? 'it' : 'them'} after the import.` : ''}` });
}));

// ---- export ----------------------------------------------------------------------------------------------------------
router.post('/export', guard(async (req, res) => {
  needView(req);
  if (!req.vault.export) throw deny('Exporting the vault is not part of your access.');
  notProxy(req);
  const b = req.body || {};
  const withPasswords = !!b.withPasswords;
  if (withPasswords) {
    if (!req.vault.reveal) throw deny('An export with passwords needs the right to show passwords as well.');
    if (String(b.confirmText || '').trim().toLowerCase() !== V.CONFIRM_WORDS.toLowerCase()) throw new V.VaultError(400, `Type "${V.CONFIRM_WORDS}" to export the passwords.`, { code: 'CONFIRM_NEEDED' });
    await V.checkReauth(req.user, reauthToken(req));
  }
  const { buffer, count } = await V.exportBook(req.user, req.vault, b.filters || {}, { withPasswords });
  await V.logAccess(req.user, null, withPasswords ? 'export_with_passwords' : 'export', `${count} login(s), Excel`, ip(req));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="teamlink-credentials-${withPasswords ? 'WITH-PASSWORDS-' : ''}${stamp}.xlsx"`);
  res.setHeader('X-Export-Rows', String(count));
  res.send(buffer);
}));

module.exports = router;
