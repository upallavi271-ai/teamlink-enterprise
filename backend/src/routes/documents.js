const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const {
  EXITED, list, parseAudience, parseChannels, resolveAudience, storedColumns, viewerContext, reaches, reachesEmployee, deliver, describeDelivery,
} = require('../utils/audience');
const { NOT_SYSTEM_EMPLOYEE } = require('../utils/systemAccounts');
const chain = require('../utils/chainRoute');
const { raiseUpload, FAILED_MESSAGE } = require('../utils/uploadApproval');

const router = express.Router();
router.use(requireAuth);

const WF_DOC = 'document';
const DENIED = { error: "This action isn't included in your role's permissions" };

// --- WHAT MAY BE PUBLISHED TO EMPLOYEES ------------------------------------
// "documents tab lo, except company documents remaining all can publish."
//
// A COMPANY DOCUMENT is the company's own paperwork — registration, tax
// filings, bank mandates, client contracts. It lives on this screen so HR and
// Administration can find it, but it is NEVER pushed to employee
// self-service. Every other category — Policy, Compliance, Handbook, anything
// typed into the creatable dropdown — can be published.
//
// Enforced HERE, not only in the browser: the create path forces it unpublished
// and the visibility toggle refuses to flip it on, so the rule holds for curl
// exactly as it does for the screen.
const INTERNAL_ONLY_CATEGORY = 'Company Documents';
function isInternalOnly(category) {
  return String(category || '').trim().toLowerCase() === INTERNAL_ONLY_CATEGORY.toLowerCase();
}

// UPLOAD APPROVAL (founder, 2026-10-24: "whatever TLs or HR upload in Documents takes approvals hierarchy-wise, up to the Super Admin").
// A document uploaded by anybody but a real Super Admin / Admin starts PENDING and unpublished, climbs the chain (utils/uploadApproval.js)
// and is published — and its recipients told — only when the last approver says yes. A rejection keeps it unpublished, with the reason.
// A team lead (TL / STL) may SUBMIT a document too: the matrix gives them no create right in HRMS, so the right is given here, to this one
// route, and what they submit never publishes without the chain.
const LEADS = ['TL', 'STL'];
const isLead = (u) => LEADS.includes(u.hrmsRole) || LEADS.includes(u.role);
async function mayUpload(req, res, next) {
  try {
    if (isLead(req.user) || await can(req.user, null, 'hrms', 'Employee Services', 'create')) return next();
    return res.status(403).json(DENIED);
  } catch (err) { return next(err); }
}

// The people a stored audience reaches, read from the row itself: the approver's own scope must not shrink what the uploader sent it to.
const PEOPLE = { id: true, name: true, employeeCode: true, department: true, designation: true, email: true, phone: true, userId: true, employmentStatus: true, team: true, tl: true };
async function reachedBy(doc) {
  const ids = list(doc.employeeIds);
  const depts = list(doc.departments);
  const narrow = ids.length ? { id: { in: ids } } : depts.length ? { department: { in: depts } } : {};
  return prisma.employee.findMany({
    where: { AND: [{ employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE, narrow] }, select: PEOPLE, orderBy: { name: 'asc' },
  });
}

async function announce(doc, by) {
  const people = await reachedBy(doc);
  let channels = [];
  try { channels = parseChannels(JSON.parse(doc.pendingChannels || '[]')); } catch { channels = []; }
  const delivery = await deliver({
    employees: people,
    channels,
    title: `${doc.mandatory ? 'Please acknowledge' : 'New document'}: ${doc.title}`,
    message: `${doc.title} has been published in Employee Services → Documents${doc.mandatory ? ' and needs your acknowledgement' : ''}.`,
    by,
    exceptUserId: doc.createdById || by.id,
  });
  return { reached: people.length, delivery };
}

// AUDIENCE (utils/audience.js). A document can be sent to everyone, to one or
// many departments, or to named employees. `totalEmployees` on each row is
// now THAT document's audience size, so "12 / 37 acknowledged" is measured
// against the people it was actually sent to. An employee only sees (and can
// only acknowledge) what was sent to them.
router.get('/', async (req, res) => {
  const where = req.user.caps.hrmsSelfOnly ? { published: true } : {};
  const documents = await prisma.policyDocument.findMany({ where, include: { acknowledgments: true }, orderBy: { createdAt: 'desc' } });
  const ctx = await viewerContext(req.user);
  const own = ctx.selfOnly ? await prisma.employee.findUnique({ where: { userId: req.user.id }, select: { id: true, department: true } }) : null;
  // A document still climbing the chain (or turned down) is for the person who uploaded it, the people named on its chain and whoever
  // runs this screen (the edit right) — a TL does not see another TL's draft just because it was sent to their team.
  const manages = await can(req.user, null, 'hrms', 'Employee Services', 'edit');
  const onChain = new Set(await chain.participantIds(WF_DOC, req.user.id));
  const visible = documents.filter((d) => {
    if ((d.approvalStatus || 'Approved') !== 'Approved') {
      return !ctx.selfOnly && (manages || d.createdById === req.user.id || onChain.has(d.id));
    }
    return ctx.selfOnly ? reachesEmployee(d, own) : reaches(ctx, d);
  });
  const active = { employmentStatus: { notIn: EXITED } };
  const byDept = new Map((await prisma.employee.groupBy({ by: ['department'], where: active, _count: true }))
    .map((g) => [g.department, g._count]));
  const everyone = [...byDept.values()].reduce((a, b) => a + b, 0);
  const rows = visible.map((d) => {
    const ids = list(d.employeeIds);
    const depts = list(d.departments);
    return {
      ...d,
      departments: depts,
      employeeIds: ids,
      totalEmployees: ids.length ? ids.length : depts.length ? depts.reduce((n, x) => n + (byDept.get(x) || 0), 0) : everyone,
      // So the screen can explain the missing Publish button instead of just
      // not drawing one.
      publishable: !isInternalOnly(d.category),
    };
  });
  // Each row carries its chain summary, so the screen can say "Waiting for <name> (Manager)" and show Approve to the one whose turn it is.
  res.json(await chain.decorate(WF_DOC, rows));
});

router.post('/', mayUpload, async (req, res) => {
  const { title, category, mandatory, uploadedDate } = req.body;
  let { target } = req.body;
  if (!title || !uploadedDate) return res.status(400).json({ error: 'title and uploadedDate are required' });
  const aud = parseAudience(req.body);
  let reached = null;
  let columns = { departments: null, employeeIds: null };
  if (aud) {
    const out = await resolveAudience(req.user, aud);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    reached = out.employees;
    columns = storedColumns(out.audience);
    target = out.label;
  }
  const internal = isInternalOnly(category);
  // Created UNPUBLISHED and Pending; the chain decides whether it stays that way.
  const doc = await prisma.policyDocument.create({
    data: {
      title, category, mandatory: !!mandatory, target, uploadedDate, uploadedBy: req.user.name,
      createdById: req.user.id, ...columns,
      published: false,
      approvalStatus: 'Pending',
      pendingChannels: JSON.stringify(parseChannels(req.body.channels)),
    },
  });
  const started = await raiseUpload(WF_DOC, req.user, doc.id);
  if (started.failed) {
    await prisma.policyDocument.delete({ where: { id: doc.id } }).catch(() => {});
    return res.status(503).json({ error: FAILED_MESSAGE });
  }
  if (started.pending) {
    await logAudit({ userId: req.user.id, action: 'Document submitted for approval', entity: 'PolicyDocument', entityId: doc.id, toValue: target || null });
    return res.status(201).json({
      ...doc, reached: null, delivery: null, deliveryText: null, pendingApproval: true, workflow: started.summary,
    });
  }
  // Nobody to ask (a real Super Admin / Admin, or nobody above the uploader): publish now, as it always did. A company document is
  // never pushed to employees, so nobody is told about one.
  const live = await prisma.policyDocument.update({ where: { id: doc.id }, data: { published: !internal, approvalStatus: 'Approved', pendingChannels: null } });
  let delivery = null;
  if (reached && !internal) {
    delivery = await deliver({
      employees: reached,
      channels: parseChannels(req.body.channels),
      title: `${mandatory ? 'Please acknowledge' : 'New document'}: ${title}`,
      message: `${title} has been published in Employee Services → Documents${mandatory ? ' and needs your acknowledgement' : ''}.`,
      by: req.user,
      exceptUserId: req.user.id,
    });
  }
  await logAudit({ userId: req.user.id, action: 'Document published', entity: 'PolicyDocument', entityId: doc.id, toValue: target || null });
  res.status(201).json({ ...live, reached: reached ? reached.length : null, delivery, deliveryText: delivery ? describeDelivery(delivery) : null });
});

// One rung deciding on a document. Approving at the top publishes it (and tells the people it was sent to); a rejection anywhere
// leaves it unpublished, with the reason on the chain.
router.patch('/:id/decision', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res, next) => {
  try {
    const { status, reason } = req.body || {};
    if (!['Approved', 'Rejected'].includes(status)) return res.status(400).json({ error: 'status must be Approved or Rejected' });
    const doc = await prisma.policyDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.approvalStatus !== 'Pending') return res.status(409).json({ error: `This document was already ${String(doc.approvalStatus).toLowerCase()}.` });

    const step = await chain.decide(WF_DOC, doc.id, req.user, { decision: status, note: reason });
    if (step.error) return res.status(step.error.status).json(step.error.body);
    if (step.chained) {
      await logAudit({
        userId: req.user.id,
        action: `Document ${status.toLowerCase()} at ${step.result.level}`,
        entity: 'PolicyDocument',
        entityId: doc.id,
        fromValue: step.result.level,
        toValue: step.result.nextLevel || step.result.outcome,
      });
      // STILL CLIMBING — it stays unpublished and nobody is told yet.
      if (!step.result.complete) return res.json({ ...doc, workflow: step.view });
    }
    if (status === 'Rejected') {
      const rejected = await prisma.policyDocument.update({ where: { id: doc.id }, data: { approvalStatus: 'Rejected', published: false } });
      return res.json({ ...rejected, workflow: step.view || null });
    }
    const internal = isInternalOnly(doc.category);
    const approved = await prisma.policyDocument.update({ where: { id: doc.id }, data: { approvalStatus: 'Approved', published: !internal } });
    let told = null;
    if (!internal) told = await announce(doc, req.user);
    await prisma.policyDocument.update({ where: { id: doc.id }, data: { pendingChannels: null } });
    return res.json({
      ...approved, workflow: step.view || null, reached: told ? told.reached : null, deliveryText: told && told.delivery ? describeDelivery(told.delivery) : null,
    });
  } catch (err) { return next(err); }
});

router.put('/:id/visibility', requirePerm(null, 'hrms', 'Employee Services', 'edit'), async (req, res) => {
  const existing = await prisma.policyDocument.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Document not found' });
  if ((existing.approvalStatus || 'Approved') !== 'Approved') {
    return res.status(409).json({ error: `This document is ${String(existing.approvalStatus).toLowerCase()} — it cannot be shown to employees until the approval chain approves it.` });
  }
  if (!existing.published && isInternalOnly(existing.category)) {
    return res.status(400).json({
      error: `A ${INTERNAL_ONLY_CATEGORY} document is the company's own paperwork and is never published to employees. Change its category first if it is meant for them.`,
    });
  }
  const doc = await prisma.policyDocument.update({ where: { id: req.params.id }, data: { published: !existing.published } });
  res.json(doc);
});

router.delete('/:id', requirePerm(null, 'hrms', 'Employee Services', 'delete'), async (req, res) => {
  await prisma.acknowledgment.deleteMany({ where: { documentId: req.params.id } });
  await prisma.approvalStep.deleteMany({ where: { workflow: WF_DOC, recordId: req.params.id } });
  await prisma.policyDocument.delete({ where: { id: req.params.id } });
  await logAudit({ userId: req.user.id, action: 'Document deleted', entity: 'PolicyDocument', entityId: req.params.id });
  res.status(204).end();
});

router.post('/:id/acknowledge', async (req, res) => {
  const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
  if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
  const doc = await prisma.policyDocument.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if ((doc.approvalStatus || 'Approved') !== 'Approved' || !doc.published) return res.status(403).json({ error: 'This document is not published' });
  if (!reachesEmployee(doc, own)) return res.status(403).json({ error: 'This document was not sent to you' });
  const ack = await prisma.acknowledgment.upsert({
    where: { documentId_employeeId: { documentId: req.params.id, employeeId: own.id } },
    update: {},
    create: { documentId: req.params.id, employeeId: own.id },
  });
  res.status(201).json(ack);
});

module.exports = router;
