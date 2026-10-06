// ---------------------------------------------------------------------------
// B7 — AGENCY / FREELANCER PARTNERS (ATS-011 / MOD-ATS-016), 2026-10-06.
// The shared rules every partner screen reads:
//   * ready()            the partners migration is applied (else 503, nothing read)
//   * codes              PRT-0001 partner · PS-00001 submission · PP-2026-0001 payout
//   * payoutMoney()      fee (% of CTC or fixed) + GST if registered − TDS at the
//                        partner's section % = net payable
//   * submission status  derived from the application's step (one mapping)
//   * ownership          first submitter owns the person for Partner.ownershipDays
//   * onJoined()         Joined + client invoice → a Draft payout, on hold until
//                        the guarantee ends; booked as an Office & Expenses bill
//                        (category "Partner payout") on approval, so the Accounts
//                        Dashboard and Office ledger treat it as a cost
//   * onLeft()           left inside the guarantee → Draft / Approved payout
//                        cancelled; Paid → a CLAWBACK (negative payout) drafted
//   * payoutCosts()      what the Placement margin report subtracts per placement
//   * notices            in-app to recruiter / TL; in-portal (+ email only behind
//                        the "Partner emails" switch) to the partner
// Routes: routes/partnerPortal.js (the partner), routes/partners.js (Admin /
// TL / reports), routes/partnerPayouts.js (Accounts).
// ---------------------------------------------------------------------------
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const PC = require('./partnerConfig');

const R = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (s) => {
  const v = str(s);
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const normEmail = (e) => str(e).toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function hasModel(name) {
  try { return !!Prisma.dmmf.datamodel.models.find((m) => m.name === name); } catch { return false; }
}
function hasField(model, field) {
  try {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
    return !!(m && m.fields.some((f) => f.name === field));
  } catch { return false; }
}
const ready = () => hasModel('Partner') && hasModel('PartnerPayout') && hasField('Candidate', 'ownerPartnerId') && hasField('Application', 'partnerId');
const NOT_READY = { error: 'Partners are built but the database update for them is not applied yet — ask the administrator to apply migration partners.' };

const TYPES = ['Agency', 'Freelancer'];
const FEE_TYPES = ['PERCENT', 'FIXED'];
const TDS_SECTIONS = ['194J', '194C', '194H', 'None'];
// Defaults by partner type (a decision for the user; editable per partner):
//   Agency (a company)      194C @ 2 %
//   Freelancer (a person)   194J @ 10 %
const TDS_DEFAULT = { Agency: { section: '194C', percent: 2 }, Freelancer: { section: '194J', percent: 10 } };
const GST_PERCENT = 18;
const SUB_STATUSES = ['Submitted', 'Duplicate', 'Screening', 'Interview', 'Selected', 'Joined', 'Rejected', 'Dropped'];
const PAYOUT_STATUSES = ['Draft', 'Approved', 'Paid', 'Cancelled'];
const PAY_MODES = ['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Other'];
const PARTNER_SOURCE = 'Partner';
const EXPENSE_CATEGORY = 'Partner payout';

// ---- codes --------------------------------------------------------------------
async function nextCode(model, field, prefix, width) {
  const rows = await prisma[model].findMany({ where: { [field]: { startsWith: prefix } }, select: { [field]: true } });
  const max = rows.reduce((m, r) => { const n = Number(String(r[field] || '').slice(prefix.length)); return Number.isFinite(n) && n > m ? n : m; }, 0);
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}
const nextPartnerCode = () => nextCode('partner', 'code', 'PRT-', 4);
const nextSubmissionCode = () => nextCode('partnerSubmission', 'code', 'PS-', 5);
const nextPayoutNumber = (ymd) => nextCode('partnerPayout', 'number', `PP-${String(ymd || todayIst()).slice(0, 4)}-`, 4);
// Unique-clash safe create (two joinings in the same second).
async function createWithCode(model, field, codeFn, data) {
  for (let i = 0; i < 6; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma[model].create({ data: { ...data, [field]: await codeFn() } });
    } catch (err) { if (!(err && err.code === 'P2002') || i === 5) throw err; }
  }
  return prisma[model].create({ data });
}

// ---- money --------------------------------------------------------------------
// fee     % of annual CTC, or fixed per joining
// + GST   18 % only when the partner is GST-registered
// − TDS   at the partner's section %, on the fee BEFORE GST (CBDT rule)
// = net   what is actually paid
function payoutMoney(partner, ctc, over = {}) {
  const feeType = over.feeType || partner.feeType || 'PERCENT';
  const feePercent = over.feePercent != null ? Number(over.feePercent) : (partner.feePercent == null ? null : Number(partner.feePercent));
  const feeFixed = over.feeFixed != null ? Number(over.feeFixed) : (partner.feeFixed == null ? null : Number(partner.feeFixed));
  let fee;
  if (over.fee != null) fee = Number(over.fee);
  else if (feeType === 'FIXED') fee = feeFixed || 0;
  else fee = ctc && feePercent ? (Number(ctc) * feePercent) / 100 : 0;
  fee = R(fee);
  const gstPercent = partner.gstRegistered ? GST_PERCENT : 0;
  const gst = R((fee * gstPercent) / 100);
  const tdsPercent = partner.tdsSection && partner.tdsSection !== 'None' ? Number(partner.tdsPercent || 0) : 0;
  const tds = R((fee * tdsPercent) / 100);
  return {
    feeType, feePercent, feeFixed, fee, gstPercent, gst, tdsSection: tdsPercent ? partner.tdsSection : (partner.tdsSection || null), tdsPercent, tds, net: R(fee + gst - tds),
  };
}

// ---- status -------------------------------------------------------------------
const LEFT = ['Dropped', 'Replacement Due', 'Replaced', 'Left after Guarantee'];
function statusOfApplication(a) {
  if (!a) return 'Submitted';
  if (LEFT.includes(a.joiningStatus)) return 'Dropped';
  if (a.stage === 'REJECTED') return 'Rejected';
  if (['JOINED', 'HIRED'].includes(a.stage)) return 'Joined';
  if (['SELECTED', 'OFFER', 'OFFER_ACCEPTED'].includes(a.stage)) return 'Selected';
  if (['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(a.stage)) return 'Interview';
  if (a.stage === 'NEW') return 'Submitted';
  return 'Screening';
}
const STATUS_WORDS = {
  Submitted: 'Received — waiting for the recruiter to look',
  Duplicate: 'Duplicate — this person was already with TeamLink',
  Screening: 'Being screened by TeamLink / the client',
  Interview: 'Interview stage',
  Selected: 'Selected — offer stage',
  Joined: 'Joined the client',
  Rejected: 'Not selected',
  Dropped: 'Did not join / left',
};
const PAYOUT_WORDS = {
  Draft: 'Payout being prepared', Approved: 'Payout approved — waiting to be paid', Paid: 'Paid', Cancelled: 'Payout cancelled',
};

// ---- notices ----------------------------------------------------------------
// In-portal notice: a Notification row with no user, channel 'Partner' and
// recipient 'partner:<id>' (the central Notifications log lists it too).
async function noticePartner(partnerId, { title, message, email = false }) {
  if (!partnerId || !title) return;
  try {
    await prisma.notification.create({
      data: { userId: null, title: String(title).slice(0, 190), message: message ? String(message).slice(0, 1000) : null, channel: 'Partner', recipient: `partner:${partnerId}`, status: 'Sent', read: false },
    });
  } catch { /* a notice never breaks the action */ }
  if (email) {
    try {
      const p = await prisma.partner.findUnique({ where: { id: partnerId }, select: { email: true, name: true } });
      const users = await prisma.partnerUser.findMany({ where: { partnerId, status: 'Active', deletedAt: null }, select: { email: true } });
      const to = [...new Set([p && p.email, ...users.map((u) => u.email)].filter(Boolean))];
      for (const addr of to) await PC.sendPartnerEmail({ to: addr, subject: title, text: message || title }); // eslint-disable-line no-await-in-loop
    } catch { /* ignore */ }
  }
}

// Reads the submission's status off its application and writes the change
// (+ a partner notice). Idempotent; never throws. Called after a stage move,
// a joining, a drop, a leave.
async function syncSubmission(applicationId, { note = null, userId = null } = {}) {
  if (!ready() || !applicationId) return null;
  try {
    const sub = await prisma.partnerSubmission.findUnique({ where: { applicationId } });
    if (!sub) return null;
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { stage: true, joiningStatus: true, requirement: { select: { title: true } } } });
    if (!app) return null;
    const next = statusOfApplication(app);
    if (next === sub.status) return sub;
    const updated = await prisma.partnerSubmission.update({ where: { id: sub.id }, data: { status: next, statusAt: new Date(), statusNote: note ? String(note).slice(0, 500) : null } });
    await logAudit({ userId, action: 'Partner submission status changed', entity: 'PartnerSubmission', entityId: sub.id, fromValue: sub.status, toValue: next, reason: note || undefined });
    await noticePartner(sub.partnerId, {
      title: `${sub.name}: ${STATUS_WORDS[next] || next}`,
      message: `Job: ${app.requirement ? app.requirement.title : ''}. Submission ${sub.code || ''}.`,
      email: true,
    });
    return updated;
  } catch (err) {
    console.error('[partners] syncSubmission:', err.message); // eslint-disable-line no-console
    return null;
  }
}

// ---- ownership ------------------------------------------------------------------
async function ownerInfo(candidate) {
  if (!ready() || !candidate || !candidate.ownerPartnerId) return null;
  const p = await prisma.partner.findUnique({ where: { id: candidate.ownerPartnerId }, select: { id: true, name: true, type: true } });
  if (!p) return null;
  const until = candidate.ownerUntil ? new Date(candidate.ownerUntil) : null;
  return {
    partnerId: p.id, name: p.name, type: p.type, until: until ? until.toISOString().slice(0, 10) : null, active: !!until && until > new Date(),
  };
}
// id -> { name, until } for a list of candidates (the Candidates list badge).
async function ownerMap(candidates) {
  const map = new Map();
  if (!ready()) return map;
  const ids = [...new Set((candidates || []).map((c) => c && c.ownerPartnerId).filter(Boolean))];
  if (!ids.length) return map;
  const ps = await prisma.partner.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const nm = new Map(ps.map((p) => [p.id, p.name]));
  (candidates || []).forEach((c) => {
    if (!c || !c.ownerPartnerId || !nm.has(c.ownerPartnerId)) return;
    map.set(c.id, { name: nm.get(c.ownerPartnerId), until: c.ownerUntil ? new Date(c.ownerUntil).toISOString().slice(0, 10) : null });
  });
  return map;
}

// ---- the Office & Expenses booking --------------------------------------------
const office = () => require('../routes/office'); // eslint-disable-line global-require
async function bookExpense(payout, partner, user, { dueDate }) {
  const cat = await office().resolveCategory(user, EXPENSE_CATEGORY);
  if (cat.error) throw Object.assign(new Error(cat.error), { status: cat.status || 400 });
  return office().createWithCode({
    category: cat.name,
    monthlyAmount: R(payout.fee + payout.gst),
    gstAmount: R(payout.gst),
    tdsAmount: R(payout.tds),
    gstRatePct: payout.gstPercent || null,
    tdsRatePct: payout.tdsPercent || null,
    vendor: partner.name,
    vendorGstin: partner.gstin || null,
    expenseDate: todayIst(),
    dueDate: dueDate || null,
    billNumber: payout.partnerInvoiceNumber || payout.number,
    description: `Partner payout ${payout.number} — ${payout.candidateName || ''} at ${payout.clientName || ''} (${payout.requirementTitle || ''})`.replace(/\s+/g, ' ').trim().slice(0, 500),
    notes: `Partner: ${partner.name} (${partner.type}). Guarantee hold until ${payout.holdUntil || '—'}.`,
    reportingTags: 'Partner payout',
    paymentMode: 'Bank Transfer',
    recurring: false,
    frequency: 'One-Time',
    entryKind: 'expense',
    approvalStatus: 'APPROVED',
    paidStatus: 'Unpaid',
    approvedBy: user.name || user.email,
    approvedById: user.id,
    approvedAt: new Date(),
    createdById: user.id,
    updatedById: user.id,
  });
}
async function expensePaid(expenseId, { paidOn, paidRef, paidMode, bankTxnId, user }) {
  if (!expenseId) return;
  try {
    await prisma.officeExpense.update({
      where: { id: expenseId },
      data: {
        approvalStatus: 'PAID', paidStatus: 'Paid', paidById: user.id, paidAt: new Date(), updatedById: user.id,
        ...(paidMode ? { paymentMode: paidMode } : {}), ...(bankTxnId ? { bankTxnId } : {}),
        ...(paidRef ? { remarks: `Paid ${paidOn} — ref ${paidRef}` } : {}),
      },
    });
  } catch (err) { console.error('[partners] expensePaid:', err.message); } // eslint-disable-line no-console
}
async function expenseCancelled(expenseId, reason, user) {
  if (!expenseId) return;
  try {
    const e = await prisma.officeExpense.findUnique({ where: { id: expenseId }, select: { approvalStatus: true } });
    if (!e || ['PAID', 'REIMBURSED'].includes(e.approvalStatus)) return;
    await prisma.officeExpense.update({ where: { id: expenseId }, data: { approvalStatus: 'REJECTED', rejectionReason: String(reason || 'Payout cancelled').slice(0, 500), rejectedById: user ? user.id : null, rejectedAt: new Date() } });
  } catch (err) { console.error('[partners] expenseCancelled:', err.message); } // eslint-disable-line no-console
}

// ---- payouts ----------------------------------------------------------------------
async function approvers() {
  try { return await require('./vendorConfig').billReviewers(); } catch { return []; } // eslint-disable-line global-require
}

// JOINED (+ the client invoice) → one Draft payout per partner-sourced
// placement. Idempotent. userId = who marked the joining (the "maker").
async function onJoined({ applicationId, invoice = null, userId = null }) {
  if (!ready() || !applicationId) return null;
  try {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { candidate: { select: { name: true } }, requirement: { select: { title: true, client: { select: { name: true } } } } },
    });
    if (!app || !app.partnerId) return null;
    if (!['JOINED', 'HIRED'].includes(app.stage)) return null;
    const inv = invoice || await prisma.invoice.findFirst({ where: { candidateId: app.candidateId, requirementId: app.requirementId, NOT: { status: 'Cancelled' } }, orderBy: { invoiceDate: 'desc' } });
    if (!inv) return null; // the payout waits for the client invoice (Accounts → Partner payouts → "Missing")
    const existing = await prisma.partnerPayout.findFirst({ where: { applicationId, kind: 'PAYOUT', NOT: { status: 'Cancelled' } } });
    if (existing) return existing;
    const partner = await prisma.partner.findUnique({ where: { id: app.partnerId } });
    if (!partner) return null;
    const ctc = Number(app.offeredCtc || inv.offeredCtc || 0) || null;
    const joinedOn = app.joiningDate || (app.joinedAt ? new Date(app.joinedAt).toISOString().slice(0, 10) : todayIst());
    const m = payoutMoney(partner, ctc);
    const maker = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }) : null;
    const payout = await createWithCode('partnerPayout', 'number', () => nextPayoutNumber(joinedOn), {
      kind: 'PAYOUT',
      partnerId: partner.id,
      submissionId: app.partnerSubmissionId || null,
      applicationId,
      invoiceId: inv.id,
      candidateName: app.candidate ? app.candidate.name : null,
      requirementTitle: app.requirement ? app.requirement.title : null,
      clientName: app.requirement && app.requirement.client ? app.requirement.client.name : null,
      joinedOn,
      ctc,
      ...m,
      holdUntil: partner.guaranteeDays > 0 ? addDays(joinedOn, partner.guaranteeDays) : null,
      status: 'Draft',
      preparedById: userId,
      preparedByName: maker ? maker.name : null,
    });
    await logAudit({
      userId, action: 'Partner payout drafted', entity: 'PartnerPayout', entityId: payout.id,
      toValue: `${payout.number} · ${partner.name} · ${payout.candidateName} · fee ₹${payout.fee} + GST ₹${payout.gst} − TDS ₹${payout.tds} = ₹${payout.net} · hold until ${payout.holdUntil || '—'}`,
    });
    const who = await approvers();
    await notifyUsers(who.map((u) => u.id), {
      title: `Partner payout to approve: ${partner.name}`,
      message: `${payout.candidateName} joined ${payout.clientName || ''} — ₹${payout.net.toLocaleString('en-IN')} payable${payout.holdUntil ? `, on hold until ${payout.holdUntil}` : ''}. Invoices → Partner payouts.`,
    });
    await noticePartner(partner.id, {
      title: `${payout.candidateName} joined — your payout is being prepared`,
      message: `Fee ₹${payout.fee.toLocaleString('en-IN')}${payout.gst ? ` + GST ₹${payout.gst.toLocaleString('en-IN')}` : ''}${payout.tds ? ` − TDS ₹${payout.tds.toLocaleString('en-IN')}` : ''} = ₹${payout.net.toLocaleString('en-IN')}.${payout.holdUntil ? ` Paid after the guarantee period ends on ${payout.holdUntil}.` : ''}`,
      email: true,
    });
    return payout;
  } catch (err) {
    console.error('[partners] onJoined:', err.message); // eslint-disable-line no-console
    return null;
  }
}

// Left inside the guarantee / did not join → the payout is cancelled; a PAID
// one gets a CLAWBACK (negative) draft. Outside the guarantee: nothing.
async function onLeft({ applicationId, inside, leftOn = null, reason = null, user = null }) {
  if (!ready() || !applicationId || !inside) return null;
  try {
    const list = await prisma.partnerPayout.findMany({ where: { applicationId, kind: 'PAYOUT', NOT: { status: 'Cancelled' } } });
    const out = [];
    for (const p of list) {
      const why = `Candidate ${leftOn ? `left on ${leftOn}` : 'did not join'} — inside the guarantee${reason ? `: ${reason}` : ''}`;
      if (p.status === 'Paid') {
        // eslint-disable-next-line no-await-in-loop
        const cb = await createWithCode('partnerPayout', 'number', () => nextPayoutNumber(todayIst()), {
          kind: 'CLAWBACK', parentPayoutId: p.id, partnerId: p.partnerId, submissionId: p.submissionId, applicationId, invoiceId: p.invoiceId,
          candidateName: p.candidateName, requirementTitle: p.requirementTitle, clientName: p.clientName, joinedOn: p.joinedOn, ctc: p.ctc,
          feeType: p.feeType, feePercent: p.feePercent, feeFixed: p.feeFixed,
          fee: -p.fee, gstPercent: p.gstPercent, gst: -p.gst, tdsSection: p.tdsSection, tdsPercent: p.tdsPercent, tds: -p.tds, net: -p.net,
          status: 'Draft', preparedById: user ? user.id : null, preparedByName: user ? user.name : null, notes: why,
        });
        // eslint-disable-next-line no-await-in-loop
        await logAudit({ userId: user ? user.id : null, action: 'Partner clawback drafted', entity: 'PartnerPayout', entityId: cb.id, fromValue: p.number, toValue: `${cb.number} · ₹${cb.net}`, reason: why });
        out.push(cb);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await prisma.partnerPayout.update({ where: { id: p.id }, data: { status: 'Cancelled', cancelledAt: new Date(), cancelledByName: user ? user.name : 'TeamLink', cancelReason: why } });
        // eslint-disable-next-line no-await-in-loop
        await expenseCancelled(p.expenseId, why, user);
        // eslint-disable-next-line no-await-in-loop
        await logAudit({ userId: user ? user.id : null, action: 'Partner payout cancelled', entity: 'PartnerPayout', entityId: p.id, fromValue: p.status, toValue: 'Cancelled', reason: why });
        out.push({ ...p, status: 'Cancelled' });
      }
      // eslint-disable-next-line no-await-in-loop
      await noticePartner(p.partnerId, { title: `${p.candidateName}: ${p.status === 'Paid' ? 'payout to be recovered' : 'payout cancelled'}`, message: why, email: true });
    }
    return out;
  } catch (err) {
    console.error('[partners] onLeft:', err.message); // eslint-disable-line no-console
    return null;
  }
}

// What the Placement margin report subtracts: the fee BEFORE GST of every
// live payout (Draft / Approved / Paid; clawbacks negative), per application.
async function payoutCosts() {
  const map = new Map();
  if (!ready()) return map;
  try {
    const rows = await prisma.partnerPayout.findMany({ where: { status: { in: ['Draft', 'Approved', 'Paid'] } }, select: { applicationId: true, fee: true, status: true } });
    rows.forEach((r) => { map.set(r.applicationId, R((map.get(r.applicationId) || 0) + Number(r.fee || 0))); });
  } catch { /* none */ }
  return map;
}

// ---- jobs a partner may see ---------------------------------------------------------
const LIVE = require('./atsVocab').REQUIREMENT_LIVE_STATUSES || ['OPEN'];
function partnerJobView(r, share, partner) {
  const showClient = !!(share && share.showClientName) || !!(partner && partner.showClientName);
  return {
    id: r.id,
    reqCode: r.reqCode || null,
    title: r.title,
    department: r.department || null,
    specialisation: r.specialisation || null,
    location: r.location || null,
    experience: r.experience || r.relevantExperience || null,
    skills: r.skills || null,
    goodToHaveSkills: r.goodToHaveSkills || null,
    education: r.education || null,
    employmentType: r.employmentType || null,
    workMode: r.workMode || null,
    salary: r.salary || null,
    openings: r.openings || 1,
    closingDate: r.closingDate || null,
    noticePeriodMax: r.noticePeriodMax || null,
    jobDescription: r.jobDescription || r.description || null,
    responsibilities: r.responsibilities || null,
    qualifications: r.qualifications || null,
    client: showClient && r.client ? r.client.name : null,
    sharedAt: share ? share.sharedAt : null,
    open: LIVE.includes(r.status),
  };
}
function partnerMayDepartment(partner, department) {
  const list = csv(partner && partner.departments);
  if (!list.length) return true;
  const d = String(department || '').trim().toLowerCase();
  return !!d && list.some((x) => x.toLowerCase() === d);
}

module.exports = {
  ready, NOT_READY, R, str, isRealDay, todayIst, addDays, normEmail, EMAIL_RE, csv,
  TYPES, FEE_TYPES, TDS_SECTIONS, TDS_DEFAULT, GST_PERCENT, SUB_STATUSES, PAYOUT_STATUSES, PAY_MODES, PARTNER_SOURCE, EXPENSE_CATEGORY,
  STATUS_WORDS, PAYOUT_WORDS,
  nextPartnerCode, nextSubmissionCode, nextPayoutNumber, createWithCode,
  payoutMoney, statusOfApplication, syncSubmission, noticePartner,
  ownerInfo, ownerMap, bookExpense, expensePaid, expenseCancelled, approvers,
  onJoined, onLeft, payoutCosts, partnerJobView, partnerMayDepartment, LIVE,
};
