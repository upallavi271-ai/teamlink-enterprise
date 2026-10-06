// ---------------------------------------------------------------------------
// B7 — PARTNER PAYOUTS as a COST, for the other reports (2026-10-06).
//   costPerHireRows({ from, to })   ATS Reports → Cost per hire (utils/costPerHire.js
//                                   contract): one row per live payout whose
//                                   joining month falls in the range —
//                                   { month, amount, applicationId, recruiterUserId, department, partner }
//                                   amount = the fee BEFORE GST (GST is pass-through,
//                                   TDS is withholding), clawbacks negative;
//                                   Draft / Approved / Paid count, Cancelled never.
//   payoutCosts()                   Placement margin (utils/partners.js) — re-exported.
// Everything is empty until the partners migration is applied (ready()).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const P = require('./partners');

const monthOf = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null; };

async function costPerHireRows({ from, to } = {}) {
  if (!P.ready()) return [];
  const rows = await prisma.partnerPayout.findMany({
    where: { status: { in: ['Draft', 'Approved', 'Paid'] } },
    select: { applicationId: true, partnerId: true, fee: true, joinedOn: true, createdAt: true, kind: true },
  });
  if (!rows.length) return [];
  const fromM = monthOf(from); const toM = monthOf(to);
  const keep = rows.filter((r) => {
    const mk = monthOf(r.joinedOn) || monthOf(new Date(r.createdAt).toISOString());
    return mk && (!fromM || mk >= fromM) && (!toM || mk <= toM);
  });
  if (!keep.length) return [];
  const appIds = [...new Set(keep.map((r) => r.applicationId))];
  const [apps, partners] = await Promise.all([
    prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, requirement: { select: { recruiterId: true, department: true } } } }),
    prisma.partner.findMany({ where: { id: { in: [...new Set(keep.map((r) => r.partnerId))] } }, select: { id: true, name: true } }),
  ]);
  const am = new Map(apps.map((a) => [a.id, a]));
  const pm = new Map(partners.map((p) => [p.id, p.name]));
  return keep.map((r) => {
    const a = am.get(r.applicationId);
    return {
      month: monthOf(r.joinedOn) || monthOf(new Date(r.createdAt).toISOString()),
      amount: P.R(r.fee),
      applicationId: r.applicationId,
      recruiterUserId: a && a.requirement ? a.requirement.recruiterId || null : null,
      department: a && a.requirement ? a.requirement.department || null : null,
      partner: pm.get(r.partnerId) || null,
      kind: r.kind,
    };
  });
}

module.exports = { costPerHireRows, payoutCosts: P.payoutCosts };
