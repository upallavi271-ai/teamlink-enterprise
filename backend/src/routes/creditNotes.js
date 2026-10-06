// ---------------------------------------------------------------------------
// B2 — CREDIT NOTES / DEBIT NOTES against a client invoice, and the PLACEMENT
// MARGIN report. Mounted INSIDE routes/invoices.js (so the Accounts product +
// Invoices view guard and the invoice scope already apply):
//
//   GET    /invoices/credit-notes                 the register (+ placements that left within the guarantee)
//   GET    /invoices/credit-notes/prefill         ?invoiceId= | ?applicationId=  &kind=credit|debit
//   POST   /invoices/credit-notes/preview         { invoiceId, kind, amount } -> the calculation
//   POST   /invoices/credit-notes                 a Draft (Invoices · create)
//   PATCH  /invoices/credit-notes/:id             edit a Draft (its maker or an approver)
//   DELETE /invoices/credit-notes/:id             throw away a Draft (its maker or an approver)
//   POST   /invoices/credit-notes/:id/issue       Draft -> Issued: approver, never the maker (maker-checker)
//   POST   /invoices/credit-notes/:id/cancel      Issued -> Cancelled: approver, a reason
//   POST   /invoices/credit-notes/:id/refund-paid the refund due went back to the client
//   GET    /invoices/credit-notes/:id/document    the printable payload
//   GET    /invoices/credit-notes/:id/pdf         the PDF
//   POST   /invoices/credit-notes/export.xlsx     Excel of the notes shown
//   GET    /invoices/margin                       placement margin rows
//   POST   /invoices/margin/export.xlsx           Excel of the margin rows shown
//
// The money rule is utils/invoiceTax.js (noteCalc / withNotes); the plumbing
// is utils/creditNotes.js. Nothing here changes how an invoice is computed —
// an issued note only moves Invoice.creditedAmount / debitedAmount (and the
// derived status), and an invoice without a note reads exactly as before.
// ---------------------------------------------------------------------------
const express = require('express');
const XLSX = require('xlsx');
const prisma = require('../db');
const { requirePerm, requireInternal, can } = require('../utils/permissions');
const { invoiceWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const {
  invoiceOutstanding, deriveInvoiceStatus, stateOf, wordsINR,
} = require('../utils/accounts');
const { stateName: gstStateName } = require('../utils/gstin');
const TAX = require('../utils/invoiceTax');
const CN = require('../utils/creditNotes');
const { renderNote } = require('../utils/creditNotePdf');

const router = express.Router();
const R = TAX.R;
const KINDS = ['credit', 'debit'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const money = (n) => `₹${R(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const guard = (req, res, next) => (CN.ready() ? next() : res.status(503).json(CN.NOT_READY));
const notesOnly = [requireInternal, guard];

// One invoice, only if this login may see it (utils/scope.js invoiceWhere).
async function scopedInvoice(user, id) {
  if (!id) return null;
  return prisma.invoice.findFirst({
    where: { AND: [invoiceWhere(user), { id: String(id) }] },
    include: { client: true, candidate: true, requirement: { select: { id: true, title: true, clientId: true } } },
  });
}
async function scopedNote(req, res) {
  const note = await prisma.creditNote.findUnique({ where: { id: req.params.id } });
  if (!note) { res.status(404).json({ error: 'That note was not found.' }); return null; }
  const inv = await scopedInvoice(req.user, note.invoiceId);
  if (!inv) { res.status(403).json({ error: 'That note is not part of your access.' }); return null; }
  return { note, inv };
}

// The invoice as a note sees it: its GST / TDS reading, its figures after the
// notes already issued, and how much more can be credited.
async function invoiceContext(inv) {
  const company = (await prisma.company.findFirst()) || {};
  const tv = TAX.taxView(inv, { company });
  const notes = (await CN.notesByInvoice([inv.id])).get(inv.id) || [];
  const wn = TAX.withNotes(inv, notes);
  // Drafts waiting on this invoice are not counted until issued, but a credit
  // can never take the fee below zero.
  const maxCredit = R(Math.max(0, wn.billing));
  return {
    company, tv, notes, wn, maxCredit,
  };
}
function invoiceSummary(inv, ctx) {
  const { tv, wn } = ctx;
  return {
    id: inv.id,
    number: inv.invoiceNumber || inv.id.slice(-6),
    date: inv.invoiceDate,
    status: inv.status,
    client: inv.client ? inv.client.name : '—',
    clientId: inv.clientId,
    candidate: inv.candidate ? inv.candidate.name : null,
    base: tv.base,
    gst: tv.gst,
    gross: tv.gross,
    tds: tv.tds,
    net: tv.net,
    received: tv.received,
    credited: tv.credited,
    debited: tv.debited,
    balance: R(Math.max(0, tv.balance)),
    gstType: tv.gstType,
    gstTypeLabel: tv.gstTypeLabel,
    gstPercent: tv.gstPercent,
    tdsPercent: tv.tdsPercent,
    tdsBase: tv.tdsBase,
    afterNotes: {
      billing: wn.billing, receivable: wn.receivable, pending: wn.pending, refundDue: wn.refundDue,
    },
    maxCredit: ctx.maxCredit,
  };
}

// The calculation of a note and what issuing it would do to the invoice now.
function previewOf(inv, ctx, kind, base) {
  const c = TAX.noteCalc(ctx.tv, base);
  const outstanding = R(Math.max(0, invoiceOutstanding(inv)));
  const applied = kind === 'debit' ? c.net : R(Math.min(c.net, outstanding));
  const refundDue = kind === 'debit' ? 0 : R(c.net - applied);
  return {
    base: c.base,
    gstType: c.gstType,
    gstTypeLabel: TAX.GST_TYPE_LABEL[c.gstType],
    gstPercent: c.gstPercent,
    cgst: c.cgst,
    sgst: c.sgst,
    igst: c.igst,
    gst: c.gst,
    gross: c.gross,
    tdsPercent: c.tdsPercent,
    tdsBase: c.tdsBase,
    tds: c.tds,
    net: c.net,
    balanceNow: outstanding,
    applied,
    refundDue,
    balanceAfter: kind === 'debit' ? R(outstanding + c.net) : R(outstanding - applied),
    line: kind === 'debit'
      ? `${money(c.base)} + GST ${money(c.gst)} − TDS ${money(c.tds)} = ${money(c.net)} added to what the client owes`
      : `${money(c.base)} + GST ${money(c.gst)} − TDS ${money(c.tds)} = ${money(c.net)} off what the client owes`,
  };
}

// Reads and checks a create / edit body. -> { error } | { data }
function readBody(body, inv, ctx, kind, existing) {
  const num = (v) => Number(String(v == null ? '' : v).replace(/[₹,\s]/g, ''));
  const base = body.amount !== undefined ? num(body.amount) : Number(existing ? existing.amount : NaN);
  if (!Number.isFinite(base) || !(base > 0)) return { error: 'Enter the amount before GST — more than ₹0.' };
  if (base > 1e10) return { error: 'That amount is too large.' };
  if (kind === 'credit' && base > ctx.maxCredit + 0.005) {
    return { error: `A credit note can take off at most ${money(ctx.maxCredit)} before GST — what is left of this invoice's fee after the notes already issued.` };
  }
  const reasons = TAX.reasonsOf(kind).map((x) => x.value);
  const reason = body.reason !== undefined ? String(body.reason || '') : (existing ? existing.reason : '');
  if (!reasons.includes(reason)) return { error: 'Pick a reason from the list.' };
  const reasonText = body.reasonText !== undefined ? String(body.reasonText || '').trim().slice(0, 1000) : (existing ? existing.reasonText : '');
  if (reason === 'other' && !reasonText) return { error: 'Say in a few words why — the reason is "Other".' };
  const noteDate = body.noteDate !== undefined ? String(body.noteDate || '').slice(0, 10) : (existing ? existing.noteDate : todayIst());
  if (!ISO.test(noteDate)) return { error: 'The note date is not a date.' };
  if (inv.invoiceDate && noteDate < String(inv.invoiceDate).slice(0, 10)) return { error: 'The note date cannot be before the invoice date.' };
  const c = TAX.noteCalc(ctx.tv, base);
  return {
    data: {
      amount: c.base,
      gstType: c.gstType,
      gstPercent: c.gstPercent,
      cgst: c.cgst,
      sgst: c.sgst,
      igst: c.igst,
      gst: c.gst,
      tdsPercent: c.tdsPercent,
      tdsBase: c.tdsBase,
      tds: c.tds,
      net: c.net,
      reason,
      reasonText: reasonText || null,
      noteDate,
    },
  };
}

// ---------------------------------------------------------------------------
// GUARANTEE LINK — placements marked "left within the guarantee" (Replacement
// Due) that have an invoice and no credit note yet. The Credit notes tab lists
// them with "Raise credit note", pre-filled from the invoice.
// ---------------------------------------------------------------------------
async function lastLeftReason(appId) {
  const ev = await prisma.applicationStageEvent.findFirst({
    where: { applicationId: appId, action: { startsWith: 'Left within the guarantee' } },
    orderBy: { createdAt: 'desc' },
    select: { comment: true, createdAt: true },
  });
  return ev ? ev.comment : null;
}
async function guaranteeWaiting(user) {
  const apps = await prisma.application.findMany({
    where: { joiningStatus: 'Replacement Due' },
    select: {
      id: true, candidateId: true, requirementId: true, joiningDate: true,
      candidate: { select: { name: true } },
      requirement: { select: { id: true, title: true, clientId: true, client: { select: { name: true } } } },
    },
  });
  if (!apps.length) return [];
  const raised = await prisma.creditNote.findMany({
    where: { applicationId: { in: apps.map((a) => a.id) }, status: { not: 'Cancelled' } },
    select: { applicationId: true },
  });
  const done = new Set(raised.map((r) => r.applicationId));
  const out = [];
  for (const a of apps) {
    if (done.has(a.id)) continue;
    // eslint-disable-next-line no-await-in-loop
    const inv = await CN.invoiceForApplication(a);
    if (!inv) continue;
    // eslint-disable-next-line no-await-in-loop
    const seen = await scopedInvoice(user, inv.id);
    if (!seen) continue;
    out.push({
      applicationId: a.id,
      candidate: a.candidate ? a.candidate.name : '—',
      job: a.requirement ? a.requirement.title : '—',
      client: a.requirement && a.requirement.client ? a.requirement.client.name : '—',
      joiningDate: a.joiningDate || null,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber || inv.id.slice(-6),
      fee: R(inv.amount),
      // eslint-disable-next-line no-await-in-loop
      left: await lastLeftReason(a.id),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE REGISTER
// ---------------------------------------------------------------------------
async function listNotes(user, q = {}) {
  const where = {};
  if (KINDS.includes(q.kind)) where.kind = q.kind;
  if (CN.STATUS.includes(q.status)) where.status = q.status;
  if (q.invoiceId) where.invoiceId = String(q.invoiceId);
  const notes = await prisma.creditNote.findMany({ where, orderBy: [{ createdAt: 'desc' }] });
  const invIds = [...new Set(notes.map((n) => n.invoiceId))];
  const invs = invIds.length ? await prisma.invoice.findMany({
    where: { AND: [invoiceWhere(user), { id: { in: invIds } }] },
    select: { id: true, invoiceNumber: true, invoiceDate: true, clientId: true, client: { select: { name: true } }, candidate: { select: { name: true } } },
  }) : [];
  const byId = new Map(invs.map((i) => [i.id, i]));
  return notes.filter((n) => byId.has(n.invoiceId)).map((n) => ({
    ...CN.shapeNote(n, byId.get(n.invoiceId)),
    invoiceDate: byId.get(n.invoiceId).invoiceDate,
    candidate: byId.get(n.invoiceId).candidate ? byId.get(n.invoiceId).candidate.name : null,
  }));
}

router.get('/credit-notes', ...notesOnly, async (req, res) => {
  const rows = await listNotes(req.user, req.query);
  const canCreate = await can(req.user, 'accounts', 'accounts', 'Invoices', 'create');
  const issued = rows.filter((r) => r.status === 'Issued');
  const sumK = (kind, k) => R(issued.filter((r) => r.kind === kind).reduce((s, r) => s + Number(r[k] || 0), 0));
  res.json({
    rows,
    counts: {
      all: rows.length,
      Draft: rows.filter((r) => r.status === 'Draft').length,
      Issued: issued.length,
      Cancelled: rows.filter((r) => r.status === 'Cancelled').length,
      credit: rows.filter((r) => r.kind === 'credit').length,
      debit: rows.filter((r) => r.kind === 'debit').length,
      refundOpen: rows.filter((r) => r.refundOpen > 0.005).length,
    },
    totals: {
      creditBase: sumK('credit', 'amount'),
      creditNet: sumK('credit', 'net'),
      debitBase: sumK('debit', 'amount'),
      debitNet: sumK('debit', 'net'),
      refundOpen: R(rows.reduce((s, r) => s + Number(r.refundOpen || 0), 0)),
    },
    waiting: canCreate ? await guaranteeWaiting(req.user) : [],
    reasons: { credit: TAX.CREDIT_REASONS, debit: TAX.DEBIT_REASONS },
    canCreate,
    canApprove: await CN.isNoteApprover(req.user),
    me: req.user.id,
  });
});

router.get('/credit-notes/prefill', ...notesOnly, requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'credit';
  let inv = null;
  let app = null;
  if (req.query.applicationId) {
    app = await prisma.application.findUnique({
      where: { id: String(req.query.applicationId) },
      include: { candidate: { select: { name: true } }, requirement: { select: { id: true, title: true, clientId: true } } },
    });
    if (!app) return res.status(404).json({ error: 'That placement was not found.' });
    const found = await CN.invoiceForApplication(app);
    if (!found) return res.status(404).json({ error: `No invoice was raised for ${app.candidate ? app.candidate.name : 'this placement'} yet — there is nothing to credit.` });
    inv = await scopedInvoice(req.user, found.id);
  } else {
    inv = await scopedInvoice(req.user, req.query.invoiceId);
  }
  if (!inv) return res.status(404).json({ error: 'That invoice was not found, or it is not part of your access.' });
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled — a note cannot be raised against it.' });
  const ctx = await invoiceContext(inv);
  const left = app ? await lastLeftReason(app.id) : null;
  const suggested = app && kind === 'credit' ? ctx.maxCredit : null;
  res.json({
    kind,
    invoice: invoiceSummary(inv, ctx),
    applicationId: app ? app.id : null,
    suggested: {
      amount: suggested,
      reason: app ? 'left_in_guarantee' : '',
      reasonText: app ? `${app.candidate ? app.candidate.name : 'The candidate'} left within the guarantee — replacement not possible.${left ? ` ${left}` : ''}`.slice(0, 1000) : '',
      noteDate: todayIst(),
    },
    preview: suggested ? previewOf(inv, ctx, kind, suggested) : null,
    reasons: TAX.reasonsOf(kind),
    notes: ctx.notes.map((n) => CN.shapeNote(n, inv)),
  });
});

router.post('/credit-notes/preview', ...notesOnly, async (req, res) => {
  const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'credit';
  const inv = await scopedInvoice(req.user, req.body.invoiceId);
  if (!inv) return res.status(404).json({ error: 'That invoice was not found.' });
  const ctx = await invoiceContext(inv);
  const base = Number(String(req.body.amount || '').replace(/[₹,\s]/g, ''));
  if (!(base > 0)) return res.json({ preview: null });
  const over = kind === 'credit' && base > ctx.maxCredit + 0.005;
  res.json({ preview: previewOf(inv, ctx, kind, base), warning: over ? `At most ${money(ctx.maxCredit)} before GST can be credited on this invoice.` : null });
});

router.post('/credit-notes', ...notesOnly, requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'credit';
  const inv = await scopedInvoice(req.user, req.body.invoiceId);
  if (!inv) return res.status(404).json({ error: 'Pick the invoice the note is against.' });
  if (inv.status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled — a note cannot be raised against it.' });
  const ctx = await invoiceContext(inv);
  const read = readBody(req.body, inv, ctx, kind, null);
  if (read.error) return res.status(400).json({ error: read.error });
  let applicationId = null;
  if (req.body.applicationId) {
    const app = await prisma.application.findUnique({ where: { id: String(req.body.applicationId) }, select: { id: true, candidateId: true } });
    if (app && (!inv.candidateId || app.candidateId === inv.candidateId)) applicationId = app.id;
  }
  const note = await prisma.creditNote.create({
    data: {
      ...read.data,
      kind,
      invoiceId: inv.id,
      clientId: inv.clientId,
      applicationId,
      status: 'Draft',
      createdById: req.user.id,
      createdByName: req.user.name || req.user.email || null,
    },
  });
  await logAudit({
    userId: req.user.id, action: `${CN.KIND_LABEL[kind]} drafted`, entity: 'CreditNote', entityId: note.id,
    toValue: `${inv.invoiceNumber || inv.id.slice(-6)} · ${money(note.amount)} before GST · net ${money(note.net)} · ${TAX.reasonLabel(kind, note.reason)}`,
  });
  res.status(201).json(CN.shapeNote(note, inv));
});

async function makerOrApprover(req, note) {
  if (note.createdById === req.user.id) return true;
  return CN.isNoteApprover(req.user);
}

router.patch('/credit-notes/:id', ...notesOnly, requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const { note, inv } = got;
  if (note.status !== 'Draft') return res.status(400).json({ error: `This note is ${note.status.toLowerCase()} — only a draft can be changed.` });
  if (!(await makerOrApprover(req, note))) return res.status(403).json({ error: 'Only the person who made this draft, or an Accounts approver, can change it.' });
  const ctx = await invoiceContext(inv);
  const read = readBody(req.body, inv, ctx, note.kind, note);
  if (read.error) return res.status(400).json({ error: read.error });
  const updated = await prisma.creditNote.update({ where: { id: note.id }, data: read.data });
  await logAudit({
    userId: req.user.id, action: `${CN.KIND_LABEL[note.kind]} draft changed`, entity: 'CreditNote', entityId: note.id,
    fromValue: `${money(note.amount)} · net ${money(note.net)}`, toValue: `${money(updated.amount)} · net ${money(updated.net)}`,
  });
  res.json(CN.shapeNote(updated, inv));
});

router.delete('/credit-notes/:id', ...notesOnly, requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const { note, inv } = got;
  if (note.status !== 'Draft') return res.status(400).json({ error: 'An issued note is never deleted — cancel it instead.' });
  if (!(await makerOrApprover(req, note))) return res.status(403).json({ error: 'Only the person who made this draft, or an Accounts approver, can remove it.' });
  await prisma.creditNote.delete({ where: { id: note.id } });
  await logAudit({
    userId: req.user.id, action: `${CN.KIND_LABEL[note.kind]} draft removed`, entity: 'CreditNote', entityId: note.id,
    fromValue: `${inv.invoiceNumber || inv.id.slice(-6)} · ${money(note.amount)}`,
  });
  res.json({ removed: true });
});

// The invoice's new status after its notes moved (same rule as PATCH /:id).
function statusData(inv, next) {
  const after = { ...inv, ...next };
  const status = deriveInvoiceStatus(after);
  const today = todayIst();
  return {
    ...next,
    status,
    paidDate: status === 'Paid' ? (inv.paidDate || today) : (inv.status === 'Paid' ? null : inv.paidDate),
  };
}

// A Pipeline History line on the placement when its credit note is issued.
async function placementEvent(user, note, words) {
  if (!note.applicationId) return;
  const app = await prisma.application.findUnique({
    where: { id: note.applicationId },
    select: {
      id: true, candidateId: true, stage: true, requirementId: true,
      requirement: { select: { title: true, clientId: true, internal: true, client: { select: { name: true } } } },
    },
  });
  if (!app) return;
  const r = app.requirement || {};
  await prisma.applicationStageEvent.create({
    data: {
      applicationId: app.id,
      candidateId: app.candidateId,
      fromStage: app.stage,
      toStage: app.stage,
      action: words,
      comment: note.reasonText ? String(note.reasonText).slice(0, 2000) : null,
      actorUserId: user.id,
      actorName: user.name,
      actorRole: user.accountsRole || user.role,
      actorSide: 'Internal',
      requirementId: app.requirementId,
      requirementTitle: r.title || null,
      clientId: r.clientId || null,
      clientName: (r.client && r.client.name) || null,
    },
  }).catch(() => {});
}

router.post('/credit-notes/:id/issue', ...notesOnly, async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const { note } = got;
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: CN.APPROVER_ONLY });
  if (note.createdById && note.createdById === req.user.id) {
    return res.status(403).json({ error: 'You made this draft, so another approver must issue it (maker-checker).' });
  }
  if (note.status !== 'Draft') return res.status(400).json({ error: `This note is already ${note.status.toLowerCase()}.` });
  // The rates and the limit are re-read now: another note may have been issued since the draft.
  const inv0 = await prisma.invoice.findUnique({ where: { id: note.invoiceId }, include: { client: true } });
  if (!inv0 || inv0.status === 'Cancelled') return res.status(400).json({ error: 'The invoice is cancelled — this note can no longer be issued.' });
  const ctx = await invoiceContext(inv0);
  const read = readBody({}, inv0, ctx, note.kind, note);
  if (read.error) return res.status(400).json({ error: read.error });
  let issued;
  let invAfter;
  try {
    await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id: note.invoiceId }, include: { client: true } });
      if (!inv || inv.status === 'Cancelled') throw Object.assign(new Error('The invoice is cancelled — this note can no longer be issued.'), { http: 400 });
      const p = previewOf(inv, ctx, note.kind, note.amount);
      const number = await CN.nextNoteNumber(note.kind, note.noteDate, tx);
      issued = await tx.creditNote.update({
        where: { id: note.id },
        data: {
          ...read.data,
          number,
          status: 'Issued',
          applied: p.applied,
          refundDue: p.refundDue,
          approvedById: req.user.id,
          approvedByName: req.user.name || req.user.email || null,
          issuedAt: new Date(),
        },
      });
      const next = note.kind === 'debit'
        ? { debitedAmount: R(Number(inv.debitedAmount || 0) + p.applied) }
        : { creditedAmount: R(Number(inv.creditedAmount || 0) + p.applied) };
      invAfter = await tx.invoice.update({ where: { id: inv.id }, data: statusData(inv, next), include: { client: true } });
    });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    if (e.code === 'P2002') return res.status(409).json({ error: 'Someone issued a note at the same moment — try again.' });
    throw e;
  }
  const label = CN.KIND_LABEL[note.kind];
  await logAudit({
    userId: req.user.id, action: `${label} issued`, entity: 'CreditNote', entityId: note.id,
    toValue: `${issued.number} · ${invAfter.invoiceNumber || invAfter.id.slice(-6)} · net ${money(issued.net)}${issued.refundDue > 0.005 ? ` · refund due ${money(issued.refundDue)}` : ''}`,
    approvalStatus: 'Approved', approvedByName: req.user.name, approvedAt: new Date(),
  });
  await logAudit({
    userId: req.user.id, action: `Invoice ${note.kind === 'debit' ? 'debited' : 'credited'}`, entity: 'Invoice', entityId: invAfter.id,
    toValue: `${issued.number} · net ${money(issued.net)} · balance now ${money(Math.max(0, invoiceOutstanding(invAfter)))} · ${invAfter.status}`,
  });
  await placementEvent(req.user, issued, `${label} ${issued.number} issued — ${money(issued.net)} ${note.kind === 'debit' ? 'added to' : 'off'} the invoice`);
  res.json({
    note: CN.shapeNote(issued, invAfter),
    invoice: { id: invAfter.id, status: invAfter.status, balance: R(Math.max(0, invoiceOutstanding(invAfter))) },
    said: issued.refundDue > 0.005
      ? `Issued ${issued.number}. ${money(issued.applied)} cleared the balance; ${money(issued.refundDue)} is a refund due to the client.`
      : `Issued ${issued.number}. The invoice balance is now ${money(Math.max(0, invoiceOutstanding(invAfter)))}.`,
  });
});

router.post('/credit-notes/:id/cancel', ...notesOnly, async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const { note } = got;
  if (!(await CN.isNoteApprover(req.user))) return res.status(403).json({ error: CN.APPROVER_ONLY });
  if (note.status !== 'Issued') return res.status(400).json({ error: note.status === 'Draft' ? 'A draft is not issued — remove it instead.' : 'Already cancelled.' });
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Say why the note is being cancelled.' });
  if (note.refundPaidOn) return res.status(400).json({ error: 'The refund on this note was already paid back to the client — it cannot be cancelled.' });
  let invAfter;
  let cancelled;
  try {
    await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id: note.invoiceId } });
      const next = note.kind === 'debit'
        ? { debitedAmount: R(Math.max(0, Number(inv.debitedAmount || 0) - Number(note.applied || 0))) }
        : { creditedAmount: R(Math.max(0, Number(inv.creditedAmount || 0) - Number(note.applied || 0))) };
      if (invoiceOutstanding({ ...inv, ...next }) < -0.5) {
        throw Object.assign(new Error(`More has been received than the invoice would be without this debit note — remove a payment first.`), { http: 400 });
      }
      cancelled = await tx.creditNote.update({
        where: { id: note.id },
        data: {
          status: 'Cancelled', cancelledAt: new Date(), cancelledByName: req.user.name || req.user.email || null, cancelReason: reason,
        },
      });
      invAfter = await tx.invoice.update({ where: { id: inv.id }, data: statusData(inv, next) });
    });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    throw e;
  }
  await logAudit({
    userId: req.user.id, action: `${CN.KIND_LABEL[note.kind]} cancelled`, entity: 'CreditNote', entityId: note.id,
    fromValue: `${note.number} · net ${money(note.net)}`, toValue: 'Cancelled', reason,
  });
  await placementEvent(req.user, cancelled, `${CN.KIND_LABEL[note.kind]} ${note.number} cancelled`);
  res.json({ note: CN.shapeNote(cancelled, invAfter), said: `Cancelled ${note.number}. The invoice balance is back to ${money(Math.max(0, invoiceOutstanding(invAfter)))}.` });
});

router.post('/credit-notes/:id/refund-paid', ...notesOnly, requirePerm('accounts', 'accounts', 'Payments', 'create'), async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const { note, inv } = got;
  if (note.status !== 'Issued' || !(Number(note.refundDue || 0) > 0.005)) return res.status(400).json({ error: 'This note has no refund due.' });
  if (note.refundPaidOn) return res.status(400).json({ error: `The refund was already paid on ${note.refundPaidOn}.` });
  const date = String(req.body.date || todayIst()).slice(0, 10);
  if (!ISO.test(date)) return res.status(400).json({ error: 'The refund date is not a date.' });
  const updated = await prisma.creditNote.update({
    where: { id: note.id },
    data: { refundPaidOn: date, refundRef: String(req.body.reference || '').trim().slice(0, 120) || null, refundPaidBy: req.user.name || req.user.email || null },
  });
  await logAudit({
    userId: req.user.id, action: 'Credit note refund paid', entity: 'CreditNote', entityId: note.id,
    toValue: `${note.number} · ${money(note.refundDue)} · ${date}${updated.refundRef ? ` · ${updated.refundRef}` : ''}`,
  });
  res.json({ note: CN.shapeNote(updated, inv), said: `Saved. Refund of ${money(note.refundDue)} marked paid on ${date}.` });
});

// ---------------------------------------------------------------------------
// THE DOCUMENT — the same letterhead / Bill-to reading as the invoice's own.
// ---------------------------------------------------------------------------
async function noteDocument(note, inv) {
  const co = (await prisma.company.findFirst()) || {};
  const cli = inv.client || {};
  const clientAddress = [cli.houseNumber, cli.street, cli.area, cli.landmark, cli.location, cli.state, cli.pincode].filter(Boolean).join(', ');
  const gstinState = (g) => {
    const c = String(g || '').trim().toUpperCase();
    return /^\d{2}[A-Z0-9]{13}$/.test(c) && gstStateName(c.slice(0, 2)) ? { code: c.slice(0, 2), name: gstStateName(c.slice(0, 2)) } : null;
  };
  const cs = gstinState(cli.gst) || stateOf(`${clientAddress} ${cli.state || ''}`);
  const coAddr = [co.address, [co.city, co.state].filter(Boolean).join(', '), co.pin, 'India'].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  const title = note.kind === 'debit' ? 'DEBIT NOTE' : 'CREDIT NOTE';
  const tv = TAX.taxView(inv, { company: co });
  const gross = R(Number(note.amount) + Number(note.gst));
  return {
    title,
    short: note.kind === 'debit' ? 'Debit note' : 'Credit note',
    kind: note.kind,
    draft: note.status === 'Draft',
    status: note.status,
    number: note.number || 'DRAFT',
    noteDate: note.noteDate,
    reasonLabel: TAX.reasonLabel(note.kind, note.reason),
    reasonText: note.reasonText || '',
    approvedBy: note.approvedByName || null,
    issuedOn: note.issuedAt ? new Date(new Date(note.issuedAt).getTime() + 330 * 60000).toISOString().slice(0, 10) : null,
    company: {
      legalName: co.legalName || co.name || 'Teamlink Consultants',
      addressLines: coAddr,
      gstin: co.gstin || '',
      pan: co.pan || (co.gstin && String(co.gstin).length >= 12 ? String(co.gstin).slice(2, 12) : ''),
      email: co.email || '',
      phone: co.phone || '',
    },
    client: {
      name: cli.legalName || cli.name || '—',
      addressLines: (!cli.billingSameAsAddress && String(cli.billingAddress || '').trim())
        ? String(cli.billingAddress).split(/,|\n/).map((s) => s.trim()).filter(Boolean)
        : (clientAddress ? clientAddress.split(',').map((s) => s.trim()).filter(Boolean) : []),
      gstin: cli.gst || '',
    },
    clientState: cs ? `${cs.name} (${cs.code})` : null,
    placeOfSupply: cs ? `${cs.name} (${cs.code})` : (cli.state || ''),
    supplyType: note.gstType === 'IGST' ? 'Inter-state' : 'Intra-state',
    invoice: { number: inv.invoiceNumber || inv.id.slice(-6), date: inv.invoiceDate },
    gstType: note.gstType,
    gstPercent: R(note.gstPercent),
    halfPct: R(note.gstPercent / 2),
    tdsPercent: R(note.tdsPercent),
    line: {
      title: note.kind === 'debit' ? 'Additional recruitment & placement fee' : 'Reduction of recruitment & placement fee',
      detail: [inv.candidate ? inv.candidate.name : null, `against invoice ${inv.invoiceNumber || inv.id.slice(-6)} of ${inv.invoiceDate || '—'}`, TAX.reasonLabel(note.kind, note.reason)].filter(Boolean).join(' — '),
      sac: co.sac || '998512',
      base: R(note.amount),
      gst: R(note.gst),
      cgst: R(note.cgst),
      sgst: R(note.sgst),
      igst: R(note.igst),
    },
    totals: {
      base: R(note.amount), cgst: R(note.cgst), sgst: R(note.sgst), igst: R(note.igst), gst: R(note.gst), gross, tds: R(note.tds), net: R(note.net),
    },
    words: wordsINR(gross),
    effect: [
      ['Invoice net receivable', tv.net],
      ['Received so far', tv.received],
      ['Credit notes set against it', tv.credited],
      ...(tv.debited > 0.005 ? [['Debit notes added', tv.debited]] : []),
      ['Balance now', Math.max(0, tv.balance)],
    ],
    refundDue: R(note.refundDue),
    refundPaidOn: note.refundPaidOn || null,
  };
}

router.get('/credit-notes/:id/document', ...notesOnly, async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const inv = await prisma.invoice.findUnique({ where: { id: got.note.invoiceId }, include: { client: true, candidate: true } });
  res.json(await noteDocument(got.note, inv));
});

router.get('/credit-notes/:id/pdf', ...notesOnly, async (req, res) => {
  const got = await scopedNote(req, res);
  if (!got) return;
  const inv = await prisma.invoice.findUnique({ where: { id: got.note.invoiceId }, include: { client: true, candidate: true } });
  const d = await noteDocument(got.note, inv);
  const name = `${d.number}-${String(d.client.name).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
  renderNote(d, res);
});

// Excel of the notes the screen shows (ids in its order).
const xlsMoney = (ws, fromRow, cols) => {
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = fromRow; r <= range.e.r; r += 1) {
    cols.forEach((c) => {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00';
    });
  }
};
function sendBook(res, wb, name) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${todayIst()}.xlsx"`);
  return res.send(buf);
}

router.post('/credit-notes/export.xlsx', ...notesOnly, requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const all = await listNotes(req.user, {});
  const byId = new Map(all.map((r) => [r.id, r]));
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  const list = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : all;
  const head = ['Note no', 'Type', 'Status', 'Note date', 'Invoice no', 'Invoice date', 'Client', 'Candidate', 'Reason', 'Details',
    'Before GST', 'GST type', 'GST %', 'CGST', 'SGST', 'IGST', 'GST', 'TDS %', 'TDS effect', 'Net', 'Set against balance', 'Refund due', 'Refund paid on',
    'Made by', 'Issued by'];
  const aoa = [['Credit & debit notes'], [`Filters: ${String((req.body && req.body.filters) || '').slice(0, 300) || 'none'}`], [], head];
  list.forEach((r) => aoa.push([r.displayNumber, r.kindLabel, r.status, r.noteDate, r.invoiceNumber, r.invoiceDate || '', r.client || '', r.candidate || '',
    r.reasonLabel, r.reasonText || '', r.amount, r.gstTypeLabel, r.gstPercent, r.cgst, r.sgst, r.igst, r.gst, r.tdsPercent, r.tds, r.net, r.applied, r.refundDue,
    r.refundPaidOn || '', r.createdByName || '', r.approvedByName || '']));
  if (!list.length) aoa.push(['No note matches these filters']);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  xlsMoney(ws, 4, [10, 13, 14, 15, 16, 18, 19, 20, 21]);
  ws['!cols'] = [14, 12, 10, 11, 14, 11, 30, 22, 26, 34, 13, 12, 7, 11, 11, 11, 11, 7, 11, 13, 13, 12, 12, 18, 18].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Notes');
  await logAudit({ userId: req.user.id, action: 'Credit notes exported', entity: 'CreditNote', toValue: `${list.length} note(s)` });
  return sendBook(res, wb, 'credit-notes');
});

// ---------------------------------------------------------------------------
// PLACEMENT MARGIN (utils/creditNotes.js marginRows — the register's rows)
// ---------------------------------------------------------------------------
function marginTotals(rows) {
  const s = (k) => R(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
  const fee = s('fee');
  const margin = s('margin');
  return {
    placements: rows.length, fee, credit: s('credit'), debit: s('debit'), net: s('net'), incentive: s('incentive'), payout: s('payout'), margin,
    marginPct: fee > 0 ? Math.round((margin / fee) * 1000) / 10 : null,
    notDecided: rows.filter((r) => !r.incentiveDecided).length,
  };
}
router.get('/margin', requireInternal, async (req, res) => {
  const { rows, incentiveSource } = await CN.marginRows(req.user);
  res.json({
    rows,
    totals: marginTotals(rows),
    incentiveSource,
    rule: 'Margin = fee billed (before GST) + debit notes − credit notes − recruiter incentive − partner payout (the partner fee before GST of every Draft / Approved / Paid payout; a clawback counts back). Payouts: Invoices → Partner payouts.',
  });
});
router.post('/margin/export.xlsx', requireInternal, requirePerm('accounts', 'accounts', 'Invoices', 'export'), async (req, res) => {
  const { rows } = await CN.marginRows(req.user);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
  const list = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : rows;
  const by = ['client', 'recruiter', 'month'].includes(req.body && req.body.groupBy) ? req.body.groupBy : null;
  const head = ['Invoice no', 'Invoice date', 'Month', 'Client', 'Candidate', 'Role', 'Department', 'Recruiter', 'Fee billed (before GST)', 'Credit notes', 'Debit notes', 'Net fee', 'Recruiter incentive', 'Incentive status', 'Partner payout', 'Margin', 'Margin %', 'Notes'];
  const aoa = [['Placement margin'], [`Filters: ${String((req.body && req.body.filters) || '').slice(0, 300) || 'none'}`], [], head];
  list.forEach((r) => aoa.push([r.invoiceNumber, r.invoiceDate || '', r.monthLabel || r.month || '', r.client, r.candidate || '', r.role || '', r.department || '', r.recruiter || '—',
    r.fee, r.credit, r.debit, r.net, r.incentive, r.incentiveStatus || '', r.payout, r.margin, r.marginPct == null ? '' : r.marginPct, (r.notes || []).join(', ')]));
  const t = marginTotals(list);
  aoa.push(['TOTAL', '', '', `${list.length} placement(s)`, '', '', '', '', t.fee, t.credit, t.debit, t.net, t.incentive, '', t.payout, t.margin, t.marginPct == null ? '' : t.marginPct]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  xlsMoney(ws, 4, [8, 9, 10, 11, 12, 14, 15]);
  ws['!cols'] = [14, 11, 10, 30, 22, 20, 14, 18, 14, 12, 12, 13, 13, 30, 12, 13, 8, 18].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Placements');
  if (by) {
    const keyOf = (r) => (by === 'client' ? r.client : by === 'recruiter' ? (r.recruiter || 'No recruiter') : (r.monthLabel || r.month || '—'));
    const m = new Map();
    list.forEach((r) => { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    const g = [[`Placement margin by ${by}`], [], [by === 'client' ? 'Client' : by === 'recruiter' ? 'Recruiter' : 'Month', 'Placements', 'Fee billed', 'Credit notes', 'Debit notes', 'Net fee', 'Incentive', 'Partner payout', 'Margin', 'Margin %']];
    [...m.entries()].forEach(([k, rs]) => { const x = marginTotals(rs); g.push([k, x.placements, x.fee, x.credit, x.debit, x.net, x.incentive, x.payout, x.margin, x.marginPct == null ? '' : x.marginPct]); });
    const ws2 = XLSX.utils.aoa_to_sheet(g);
    xlsMoney(ws2, 3, [2, 3, 4, 5, 6, 7, 8]);
    ws2['!cols'] = [30, 11, 14, 13, 13, 14, 13, 13, 14, 9].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws2, `By ${by}`);
  }
  await logAudit({ userId: req.user.id, action: 'Placement margin exported', entity: 'Invoice', toValue: `${list.length} placement(s)` });
  return sendBook(res, wb, 'placement-margin');
});

module.exports = router;
