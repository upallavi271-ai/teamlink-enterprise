// ---------------------------------------------------------------------------
// THE OFFER LETTER MAILED WITH THE JOINING DATE - routes (mounted on routes/interviewsJoining.js, so /api/ats and the same scope:
// loadScoped refuses an application outside the login's area). The logic is in utils/offerLetterMail.js.
//
//   GET  /offer-letter-mail/template           the wording, the switches and the placeholder list     (Offers or Joining · view)
//   PUT  /offer-letter-mail/template           save the wording                                        (Admin)
//   POST /offer-letter-mail/template/preview   the unsaved wording filled with sample details          (Admin)
//   POST /offer-letter-mail/template/reset     back to the starting words                              (Admin)
//   PUT  /offer-letter-mail/automatic          { enabled } - the "send it by itself" switch             (Admin)
//   GET  /offer-letter-mail/:id                one joining: sent / held / failed, and may it be sent
//   GET  /offer-letter-mail/:id/preview        the letter as the candidate will read it (HTML)
//   GET  /offer-letter-mail/:id/pdf            the same letter as a PDF
//   POST /offer-letter-mail/:id/send           send it, or send it again                                (Joining or Offers · edit)
// ---------------------------------------------------------------------------
const { can } = require('../middleware/auth');
const { requireInternal } = require('../utils/permissions');
const O = require('../utils/offerLetterMail');

const isAdmin = (u) => ['SUPER_ADMIN', 'ADMIN'].includes(u && u.role);
const { maskEmail } = require('../utils/messagingCore');

module.exports = function offerLetterMailRoutes(router, { loadScoped }) {
  const mayView = async (u) => !!((await can(u, 'ats', 'interviews', 'Offers', 'view')) || (await can(u, 'ats', 'interviews', 'Joining', 'view')));
  const maySend = async (u) => !!((await can(u, 'ats', 'interviews', 'Joining', 'edit')) || (await can(u, 'ats', 'interviews', 'Offers', 'edit')));
  const viewGate = async (req, res, next) => { if (await mayView(req.user)) return next(); return res.status(403).json({ error: 'You do not have access to offer letters.' }); };
  // The letter carries the salary and the candidate's address: only a login that may see "Candidate Contact & Salary" reads it
  // (the BDE team may not). Everybody else with Offers / Joining access sees the state of the mail, with the address masked.
  const mayPrivate = async (u) => !!(await can(u, 'ats', 'candidates', 'Candidate Contact & Salary', 'view'));
  const NO_LETTER = { error: 'The letter carries the salary and the candidate’s contact details, which your login does not see. You can still see whether it was sent.', code: 'NO_PRIVATE_VIEW' };
  const shapeCard = async (user, st) => {
    const priv = await mayPrivate(user);
    return { ...st, to: priv || !st.to ? st.to : maskEmail(st.to), maySeeLetter: priv, maySend: await maySend(user) };
  };
  const adminGate = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin can change the offer letter.' }));

  async function settingsShape(user) {
    const s = await O.loadSettings();
    const masterOn = await require('../utils/interviewNotices').candidateEmailsOn(); // eslint-disable-line global-require
    return {
      enabled: s.enabled, template: s.template, custom: s.custom, updatedByName: s.updatedByName, updatedAt: s.updatedAt,
      masterOn, tokens: O.TOKENS, limits: O.LIMITS, canEdit: isAdmin(user),
    };
  }

  router.get('/offer-letter-mail/template', requireInternal, viewGate, async (req, res) => {
    res.json(await settingsShape(req.user));
  });

  router.put('/offer-letter-mail/template', requireInternal, adminGate, async (req, res) => {
    const r = await O.saveTemplate(req.body, req.user);
    if (r.error) return res.status(400).json({ error: r.error });
    return res.json({ ...(await settingsShape(req.user)), message: 'Saved. The next offer letter uses these words.' });
  });

  router.post('/offer-letter-mail/template/preview', requireInternal, adminGate, async (req, res) => {
    const r = await O.previewTemplate(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    return res.json(r);
  });

  router.post('/offer-letter-mail/template/reset', requireInternal, adminGate, async (req, res) => {
    await O.resetTemplate(req.user);
    res.json({ ...(await settingsShape(req.user)), message: 'The starting words are back.' });
  });

  router.put('/offer-letter-mail/automatic', requireInternal, adminGate, async (req, res) => {
    if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ error: 'Say whether it is on or off.' });
    await O.setAutomatic(req.body.enabled, req.user);
    return res.json({ ...(await settingsShape(req.user)), message: req.body.enabled ? 'Automatic offer letters are ON.' : 'Automatic offer letters are OFF. Nothing goes by itself; a person can still press Send.' });
  });

  router.get('/offer-letter-mail/:id', requireInternal, viewGate, async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    return res.json(await shapeCard(req.user, await O.statusOf(app.id)));
  });

  router.get('/offer-letter-mail/:id/preview', requireInternal, viewGate, async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    if (!(await mayPrivate(req.user))) return res.status(403).json(NO_LETTER);
    return res.json(await O.previewOf(app.id));
  });

  router.get('/offer-letter-mail/:id/pdf', requireInternal, viewGate, async (req, res) => {
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    if (!(await mayPrivate(req.user))) return res.status(403).json(NO_LETTER);
    const f = await O.pdfOf(app.id);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${f.name}"`);
    return res.send(f.pdf);
  });

  router.post('/offer-letter-mail/:id/send', requireInternal, async (req, res) => {
    if (!(await maySend(req.user))) return res.status(403).json({ error: 'You can see this offer letter but not send it. Ask your team lead.' });
    const app = await loadScoped(req, res);
    if (!app) return undefined;
    const r = await O.sendNow(app.id, req.user, { trigger: (req.body || {}).again ? 'Sent again' : 'Sent by hand' });
    return res.status(r.status || 200).json({ ...r, card: await shapeCard(req.user, await O.statusOf(app.id)) });
  });
};
