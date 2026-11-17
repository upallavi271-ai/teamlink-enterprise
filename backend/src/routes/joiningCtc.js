// ---------------------------------------------------------------------------
// THE JOINING CTC OF A JOINED CANDIDATE (founder 2026-11-17: "vellu join ayyaru, vellaki CTC ekkada enter chestharu? ... aa respective BDE or BDE TL CTC
// pettukovali anukuntunnaru, dhaani kosam option ivvu").
//   GET  /api/ats/joining-ctc/:applicationId                 { ctc, canEdit, invoiced, invoiceNumber, why }
//   POST /api/ats/joining-ctc/:applicationId {offeredCtc, confirmCtc}   saves the yearly CTC on the joined application (Application.offeredCtc)
// Who may write it: a Super Admin / Admin, the requirement's own BDEs (job BDE, the client's owner and second BDE) and the BDE team leads. Once the joining is
// invoiced the CTC is the invoice's: it is changed in Accounts, not here. The same sanity check as everywhere (utils/ctcCheck.js); the change is audited with
// the old and the new value. The invoice later takes this CTC by itself (Accounts > Invoices > + New join).
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

async function load(id) {
  return prisma.application.findUnique({
    where: { id: String(id || '').slice(0, 60) },
    include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: { select: { id: true, name: true, bdeOwner: true, secondaryBde: true } } } } },
  });
}
async function rightsOf(user, app) {
  const CT = require('../utils/clientTrack'); // eslint-disable-line global-require
  if (CT.isAdmin(user)) return { canEdit: true };
  const people = await CT.peopleFor(app).catch(() => ({ bdes: [], bdeTls: [] }));
  if ((people.bdes || []).includes(user.id) || (people.bdeTls || []).includes(user.id)) return { canEdit: true };
  return { canEdit: false, why: "Only this requirement's BDE, a BDE team lead or an Admin can enter the joining CTC." };
}
const invoiceOf = (app) => prisma.invoice.findFirst({ where: { candidateId: app.candidateId, requirementId: app.requirementId }, select: { id: true, invoiceNumber: true } }).catch(() => null);

router.get('/:applicationId', async (req, res, next) => {
  try {
    const app = await load(req.params.applicationId);
    if (!app) return res.status(404).json({ error: 'This application is not there.' });
    const joined = ['JOINED', 'HIRED'].includes(app.stage);
    const inv = joined ? await invoiceOf(app) : null;
    const r = await rightsOf(req.user, app);
    return res.json({
      ctc: app.offeredCtc || null, joined, invoiced: !!inv, invoiceNumber: inv ? inv.invoiceNumber || null : null,
      canEdit: joined && !inv && r.canEdit, why: !joined ? 'The joining CTC is entered once the candidate has joined.' : (inv ? 'This joining is invoiced: change the CTC on the invoice in Accounts.' : (r.why || null)),
    });
  } catch (e) { return next(e); }
});

router.post('/:applicationId', async (req, res, next) => {
  try {
    const app = await load(req.params.applicationId);
    if (!app) return res.status(404).json({ error: 'This application is not there.' });
    if (!['JOINED', 'HIRED'].includes(app.stage)) return res.status(409).json({ error: 'The joining CTC is entered once the candidate has joined.' });
    const r = await rightsOf(req.user, app);
    if (!r.canEdit) return res.status(403).json({ error: r.why });
    const inv = await invoiceOf(app);
    if (inv) return res.status(409).json({ error: `This joining is already invoiced${inv.invoiceNumber ? ` (${inv.invoiceNumber})` : ''}. Change the CTC on the invoice in Accounts.` });
    const b = req.body || {};
    const CC = require('../utils/ctcCheck'); // eslint-disable-line global-require
    if (CC.isBlank(b.offeredCtc)) return res.status(400).json({ error: 'Write the yearly CTC in rupees, e.g. 450000.' });
    const problem = await CC.check(b.offeredCtc, b.confirmCtc);
    if (problem) return res.status(problem.status).json(problem.body);
    const ctc = Math.round(Number(b.offeredCtc));
    const before = app.offeredCtc || null;
    await prisma.application.update({ where: { id: app.id }, data: { offeredCtc: ctc } });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: 'Joining CTC entered', entity: 'Application', entityId: app.id,
      field: 'offeredCtc', fieldLabel: 'Joining CTC (yearly)', fromValue: before ? String(before) : '(blank)', toValue: String(ctc),
      reason: `${(app.candidate && app.candidate.name) || 'Candidate'} · ${(app.requirement && app.requirement.title) || ''}`.slice(0, 200),
    });
    return res.json({ ok: true, ctc });
  } catch (e) { return next(e); }
});

module.exports = router;
