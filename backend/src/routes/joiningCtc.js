// ---------------------------------------------------------------------------
// THE JOINING CTC OF A JOINED CANDIDATE (founder 2026-11-17: "vellu join ayyaru, vellaki CTC ekkada enter chestharu? ... aa respective BDE or BDE TL CTC
// pettukovali anukuntunnaru, dhaani kosam option ivvu").
//   GET  /api/ats/joining-ctc/:applicationId                 { ctc, canEdit, invoiced, invoiceNumber, why, invoiceWillChange }
//   POST /api/ats/joining-ctc/:applicationId {offeredCtc, confirmCtc, reason}   saves the yearly CTC on the joined application (Application.offeredCtc)
//
// WHO (founder 2026-11-26: "the option is only for bde tl, super admin, developer logins"): a Super Admin (the Developer login is one) and the BDE team leads
// of the requirement. Nobody else - not a plain BDE, not an Admin.
// A WRONG CTC AFTER THE INVOICE (founder 2026-11-26: "incase ikada ctc wrong ga enter chesthey by mistake, edit cheskodaniki option kaavali"):
//   * the invoice not paid yet (nothing received, no payment line, no credit / debit note, not cancelled): the CTC is changed AND the invoice is corrected
//     with it - the fee on the CTC at the invoice's own fee %, then GST and TDS at the invoice's own rates (utils/invoiceTax.js, the one calculation). A flat-fee
//     invoice keeps its amount; only the CTC on it changes. A reason is required, and the old and new CTC and amount are in the audit log.
//   * money already received, or a note issued: refused - the difference goes through a credit / debit note in Accounts.
// The same CTC sanity check as everywhere (utils/ctcCheck.js).
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
    include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: true } } },
  });
}
const isSuperAdmin = (u) => !!u && [u.role, u.atsRole, u.hrmsRole, u.accountsRole].includes('SUPER_ADMIN');
async function rightsOf(user, app) {
  if (isSuperAdmin(user)) return { canEdit: true };
  const CT = require('../utils/clientTrack'); // eslint-disable-line global-require
  const people = await CT.peopleFor(app).catch(() => ({ bdeTls: [] }));
  if ((people.bdeTls || []).includes(user.id)) return { canEdit: true };
  return { canEdit: false, why: 'Only a BDE team lead of this requirement or a Super Admin can change the joining CTC.' };
}
const invoiceOf = (app) => prisma.invoice.findFirst({
  where: { candidateId: app.candidateId, requirementId: app.requirementId },
  include: { payments: { select: { id: true } }, client: true },
}).catch(() => null);
// Can this invoice still follow a CTC correction? -> null (yes) or the reason it cannot
function lockedWhy(inv) {
  if (!inv) return null;
  const no = inv.invoiceNumber ? ` (${inv.invoiceNumber})` : '';
  if (inv.status === 'Cancelled') return `The invoice${no} is cancelled.`;
  if (Number(inv.receivedAmount || 0) > 0.5 || (inv.payments || []).length || ['Paid', 'Partially Paid'].includes(inv.status)) return `Money is already received on the invoice${no}. Raise a credit / debit note in Accounts for the difference.`;
  if (Number(inv.creditedAmount || 0) > 0.5 || Number(inv.debitedAmount || 0) > 0.5) return `A credit / debit note is already issued on the invoice${no}. Correct it in Accounts.`;
  return null;
}
// a percentage invoice follows the CTC; a flat-fee one keeps its amount
const isPercent = (inv) => !!inv && inv.feePercent != null && inv.offeredCtc != null && Number(inv.offeredCtc) > 0
  && Math.abs(Math.round((Number(inv.offeredCtc) * Number(inv.feePercent)) / 100) - Number(inv.amount)) <= 2;

router.get('/:applicationId', async (req, res, next) => {
  try {
    const app = await load(req.params.applicationId);
    if (!app) return res.status(404).json({ error: 'This application is not there.' });
    const joined = ['JOINED', 'HIRED'].includes(app.stage);
    const inv = joined ? await invoiceOf(app) : null;
    const r = await rightsOf(req.user, app);
    const locked = lockedWhy(inv);
    return res.json({
      ctc: app.offeredCtc || null, joined, invoiced: !!inv, invoiceNumber: inv ? inv.invoiceNumber || null : null,
      canEdit: joined && r.canEdit && !locked,
      invoiceWillChange: !!inv && !locked,
      invoiceFlatFee: !!inv && !isPercent(inv),
      feePercent: inv && isPercent(inv) ? Number(inv.feePercent) : null,
      why: !joined ? 'The joining CTC is entered once the candidate has joined.' : (r.why || locked || null),
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
    const locked = lockedWhy(inv);
    if (locked) return res.status(409).json({ error: locked });
    const b = req.body || {};
    const CC = require('../utils/ctcCheck'); // eslint-disable-line global-require
    if (CC.isBlank(b.offeredCtc)) return res.status(400).json({ error: 'Write the yearly CTC in rupees, e.g. 450000.' });
    const problem = await CC.check(b.offeredCtc, b.confirmCtc);
    if (problem) return res.status(problem.status).json(problem.body);
    const ctc = Math.round(Number(b.offeredCtc));
    const reason = String(b.reason || '').trim().slice(0, 300);
    const before = app.offeredCtc || null;
    if (before && Math.round(before) === ctc) return res.json({ ok: true, ctc, unchanged: true });
    if (inv && !reason) return res.status(400).json({ error: 'This joining is invoiced: say why the CTC is changed (it goes on the invoice history).', needsReason: true });

    let invoiceChange = null;
    if (inv) {
      const data = { offeredCtc: ctc };
      if (isPercent(inv)) {
        const TAX = require('../utils/invoiceTax'); // eslint-disable-line global-require
        const base = Math.round((ctc * Number(inv.feePercent)) / 100);
        const taxDef = TAX.defaultsFor(inv.client, (await prisma.company.findFirst()) || {}, { gst: 18, tds: 10 });
        const t = TAX.readTaxInput({ amount: base }, inv, taxDef);
        if (t.error) return res.status(400).json({ error: `The invoice could not be worked out again: ${t.error}` });
        Object.assign(data, t.data);
        invoiceChange = { from: Number(inv.amount), to: Number(t.data.amount != null ? t.data.amount : base) };
      }
      await prisma.$transaction([
        prisma.application.update({ where: { id: app.id }, data: { offeredCtc: ctc } }),
        prisma.invoice.update({ where: { id: inv.id }, data }),
      ]);
      await logAudit({
        userId: req.user.id, actorName: req.user.name, action: 'Invoice corrected: joining CTC changed', entity: 'Invoice', entityId: inv.id,
        field: 'offeredCtc', fieldLabel: 'Joining CTC (yearly)', fromValue: `CTC ${before || '(blank)'}${invoiceChange ? ` · amount ${invoiceChange.from}` : ''}`,
        toValue: `CTC ${ctc}${invoiceChange ? ` · amount ${invoiceChange.to}` : ' · flat fee, amount unchanged'}`, reason: `${reason} (${inv.invoiceNumber || 'invoice'})`.slice(0, 300),
      });
    } else {
      await prisma.application.update({ where: { id: app.id }, data: { offeredCtc: ctc } });
    }
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action: before ? 'Joining CTC changed' : 'Joining CTC entered', entity: 'Application', entityId: app.id,
      field: 'offeredCtc', fieldLabel: 'Joining CTC (yearly)', fromValue: before ? String(before) : '(blank)', toValue: String(ctc),
      reason: `${reason ? `${reason} · ` : ''}${(app.candidate && app.candidate.name) || 'Candidate'} · ${(app.requirement && app.requirement.title) || ''}`.slice(0, 300),
    });
    return res.json({
      ok: true, ctc, invoiceNumber: inv ? inv.invoiceNumber || null : null, invoiceChange,
      message: inv ? (invoiceChange ? `CTC saved and invoice ${inv.invoiceNumber || ''} corrected: ₹${invoiceChange.from.toLocaleString('en-IN')} → ₹${invoiceChange.to.toLocaleString('en-IN')} before GST.${inv.sentDate ? ' It was already sent to the client: send the corrected invoice again.' : ''}` : `CTC saved. Invoice ${inv.invoiceNumber || ''} is a flat fee, so its amount stays the same.`) : null,
    });
  } catch (e) { return next(e); }
});

module.exports = router;
module.exports.lockedWhy = lockedWhy;
module.exports.isPercent = isPercent;
