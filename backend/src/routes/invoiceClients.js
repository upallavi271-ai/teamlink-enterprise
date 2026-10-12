// ---------------------------------------------------------------------------
// INVOICES -> "ADD CLIENT" and the client picker of a manual invoice (2026-10-09).
// /api/invoice-clients - Accounts product, Invoices permission.
//
//   GET  /            real clients from the central Client table (dropdown)
//   GET  /:id         one client's saved details (what selecting a client fills in)
//   POST /            Add Client (a DRAFT client with the billing basics)
//   PATCH /:id        correct the billing basics of a client made HERE and still a draft
//
// THE CLIENT TABLE IS THE ATS'S. Nothing is copied into a second table, and the
// ATS rules are not bypassed:
//   * same ID series (CLI-0001 ... via utils/autoNumber nextClientNumber);
//   * same format checks (clientProfile.formatErrors) and the same duplicate
//     engine (clientDuplicates.findClientDuplicates): same GSTIN / PAN / name /
//     merged spelling BLOCK (409 naming the existing client); same phone / email
//     / near-typo name WARN (409, repeat with confirmDuplicate:true);
//   * the client is created as a DRAFT, exactly like the ATS "Save Draft": no
//     agreement, no owner department, no BDE. A draft client cannot get jobs
//     (the ATS needs an ACTIVE agreement) and no BDE desk sees it until a BDE /
//     Admin completes it in Clients. clientSource marks where it came from.
//   * Accounts can edit only such a draft made here; a client the ATS owns is
//     changed in the ATS under the ATS rules.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, requireProduct } = require('../middleware/auth');
const { invoiceWhere } = require('../utils/scope');
const { logAudit } = require('../utils/audit');
const clientProfile = require('../utils/clientProfile');
const { findClientDuplicates, describeMatches, displayCode } = require('../utils/clientDuplicates');
const { nextClientNumber } = require('../utils/autoNumber');
const VP = require('../utils/vendorPortal');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('accounts'));

const SOURCE = 'Invoices (Accounts)';
const clean = (v, max) => VP.cleanText(v, max).replace(/\s+/g, ' ');

// The clients this login may bill: the same reach as the invoice register.
function listWhere(user) {
  const w = invoiceWhere(user);
  if (w.id === '__none__' || w.clientId) return { id: '__none__' };
  if (!Object.keys(w).length) return {};
  const depts = (w.OR && w.OR[0] && w.OR[0].client && w.OR[0].client.ownerDepartment && w.OR[0].client.ownerDepartment.in) || [];
  return { OR: [{ ownerDepartment: { in: depts } }, { clientSource: SOURCE }] };
}

const billingAddressOf = (c) => {
  if (c.billingAddress && !c.billingSameAsAddress) return c.billingAddress;
  return [c.houseNumber, c.street, c.landmark, c.area, c.location, c.state, c.pincode].filter(Boolean).join(', ') || c.billingAddress || '';
};
const brief = (c) => ({
  id: c.id,
  clientCode: displayCode(c),
  name: c.name,
  company: c.legalName || c.name,
  contactName: c.billingContactName || c.contactName || null,
  email: c.invoiceEmail || c.billingContactEmail || c.contactEmail || null,
  phone: c.billingContactPhone || c.contactPhone || null,
  billingAddress: billingAddressOf(c) || null,
  gstin: c.gst || null,
  paymentTerms: c.paymentTerms || null,
  gstPercent: c.gstPercent,
  tdsPercent: c.tdsPercent,
  isDraft: c.agreementStatus === 'DRAFT',
  fromInvoices: c.clientSource === SOURCE,
  editable: c.clientSource === SOURCE && c.agreementStatus === 'DRAFT',
});

router.get('/', requirePerm('accounts', 'accounts', 'Invoices', 'view'), async (req, res) => {
  const q = clean((req.query || {}).q, 80).toLowerCase();
  const rows = await prisma.client.findMany({ where: listWhere(req.user), orderBy: { name: 'asc' } });
  const out = rows.map(brief).filter((c) => !q || [c.name, c.company, c.clientCode, c.gstin, c.email].some((x) => String(x || '').toLowerCase().includes(q)));
  res.json({ rows: out, total: rows.length, canAdd: true });
});

router.get('/:id', requirePerm('accounts', 'accounts', 'Invoices', 'view'), async (req, res) => {
  const c = await prisma.client.findFirst({ where: { AND: [{ id: String(req.params.id) }, listWhere(req.user)] } });
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  res.json({ client: brief(c) });
});

// Body (plain words): clientName, company, contactName, email, phone, billingAddress, gstin.
function readBody(b, { partial = false } = {}) {
  const has = (k) => b[k] !== undefined;
  const data = {};
  if (!partial || has('clientName')) {
    const name = clean(b.clientName ?? b.name, 160);
    if (!name) return { field: 'clientName', error: 'Write the client name.' };
    data.name = name;
  }
  if (!partial || has('company')) data.legalName = clean(b.company, 200) || null;
  if (!partial || has('contactName')) data.contactName = clean(b.contactName, 120) || null;
  if (!partial || has('email')) data.contactEmail = clean(b.email, 160).toLowerCase() || null;
  if (!partial || has('phone')) data.contactPhone = clean(b.phone, 30) || null;
  if (!partial || has('billingAddress')) {
    data.billingAddress = VP.cleanText(b.billingAddress, 500) || null;
    data.billingSameAsAddress = false;
  }
  if (!partial || has('gstin')) data.gst = clean(b.gstin ?? b.gst, 20).toUpperCase().replace(/\s+/g, '') || null;
  const errs = clientProfile.formatErrors(data);
  if (errs.length) {
    const map = { gst: 'gstin', contactEmail: 'email', contactPhone: 'phone' };
    return { field: map[errs[0].field] || errs[0].field, error: errs[0].error };
  }
  return { data };
}

const dupBody = (dup, confirmed) => {
  if (dup.blocking) {
    return {
      status: 409,
      body: {
        error: `This client already exists: ${dup.matches[0].name} (${dup.matches[0].displayCode}) - ${dup.matches[0].reasons[0].label}. Pick it from the list instead.`,
        code: 'DUPLICATE_CLIENT', blocking: true, duplicates: dup.matches,
      },
    };
  }
  if (dup.total > 0 && !confirmed) {
    return {
      status: 409,
      body: {
        error: `This may be a client you already have: ${dup.matches[0].name} (${dup.matches[0].displayCode}) - ${dup.matches[0].reasons[0].label}. Is it a different client?`,
        code: 'POSSIBLE_DUPLICATE_CLIENT', blocking: false, warning: true, duplicates: dup.matches,
      },
    };
  }
  return null;
};

router.post('/', requirePerm('accounts', 'accounts', 'Invoices', 'create'), async (req, res) => {
  const b = req.body || {};
  const r = readBody(b);
  if (r.error) return res.status(400).json({ error: r.error, field: r.field });
  const dup = await findClientDuplicates(r.data);
  const out = dupBody(dup, b.confirmDuplicate === true);
  if (out) return res.status(out.status).json(out.body);
  const clientCode = await nextClientNumber();
  const client = await prisma.client.create({
    data: { ...r.data, clientCode, agreementStatus: 'DRAFT', clientSource: SOURCE, internalRemarks: `Added from Invoices by ${req.user.name || req.user.email}. A BDE or Admin should complete it in Clients.` },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name || req.user.email, action: 'Client created from Invoices', entity: 'Client', entityId: client.id,
    toValue: `${client.name} (${clientCode}) - Draft${dup.total ? ` - despite: ${describeMatches(dup.matches)}` : ''}`.slice(0, 900),
  });
  await VP.auditReq(req, { changedById: req.user.id, actorName: req.user.name || req.user.email, role: 'Accounts', action: 'Client created from Invoices', newValue: `${client.name} (${clientCode})` });
  return res.status(201).json({ client: brief(client), message: `Client ${client.name} added (${clientCode}). It is a draft until a BDE or Admin completes it in Clients.` });
});

router.patch('/:id', requirePerm('accounts', 'accounts', 'Invoices', 'edit'), async (req, res) => {
  const cur = await prisma.client.findFirst({ where: { AND: [{ id: String(req.params.id) }, listWhere(req.user)] } });
  if (!cur) return res.status(404).json({ error: 'Client not found.' });
  if (!(cur.clientSource === SOURCE && cur.agreementStatus === 'DRAFT')) {
    return res.status(403).json({ error: 'This client belongs to the ATS. Its details are changed in Clients (by the BDE or Admin), where the ATS rules apply.' });
  }
  const b = req.body || {};
  const r = readBody(b, { partial: true });
  if (r.error) return res.status(400).json({ error: r.error, field: r.field });
  const changed = Object.keys(r.data).filter((k) => String(r.data[k] ?? '') !== String(cur[k] ?? ''));
  if (!changed.length) return res.json({ client: brief(cur), message: 'Nothing changed.' });
  const idChanged = changed.some((k) => ['name', 'legalName', 'gst', 'contactPhone', 'contactEmail'].includes(k));
  if (idChanged) {
    const dup = await findClientDuplicates({ ...cur, ...r.data }, { excludeId: cur.id });
    const out = dupBody(dup, b.confirmDuplicate === true);
    if (out) return res.status(out.status).json(out.body);
  }
  const up = await prisma.client.update({ where: { id: cur.id }, data: r.data });
  await logAudit({
    userId: req.user.id, actorName: req.user.name || req.user.email, action: 'Client edited from Invoices', entity: 'Client', entityId: cur.id,
    fromValue: changed.map((k) => `${k}: ${cur[k] ?? '-'}`).join(' | ').slice(0, 500), toValue: changed.map((k) => `${k}: ${up[k] ?? '-'}`).join(' | ').slice(0, 500),
  });
  return res.json({ client: brief(up), message: 'Saved.' });
});

module.exports = router;
