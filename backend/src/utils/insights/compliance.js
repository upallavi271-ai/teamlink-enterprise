// ---------------------------------------------------------------------------
// COMPLIANCE REPORT PACK (12.14, 2026-11-21) - India: the Digital Personal Data Protection Act, 2023 (DPDP).
//
//   Consent      every candidate's consent status (given / not given / withdrawn / never recorded), by how it was given,
//                and the consents older than the review period (utils/candidatePrivacy.js consentAging)
//   Retention    what the app keeps and for how long, legal holds, erasures done, the recycle bin
//   Access log   who opened personal data (utils/readLog.js) and who downloaded it (the audit trail's "exported" rows)
//
// EEO-1 and OFCCP are United States rules for US employers and federal contractors: they do not apply to an Indian
// staffing company, and the app does not collect race / gender / veteran data for them. GDPR applies only to people in the
// EU / EEA; the consent, access-request export and erasure the DPDP pack covers are the same tools GDPR would need.
// Admin / HR only (the same people as Administration -> Privacy).
// ---------------------------------------------------------------------------
const prisma = require('../../db');

const DAY = 86400000;
async function pack({ days = 30 } = {}) {
  const P = require('../candidatePrivacy'); // eslint-disable-line global-require
  const R = require('../readLog'); // eslint-disable-line global-require
  await Promise.all([P.ensure(), R.ensure()]);
  const since = new Date(Date.now() - Math.max(1, Math.min(365, Number(days) || 30)) * DAY);
  const [byStatus, bySource, aging, holds, total, dnc] = await Promise.all([
    prisma.candidate.groupBy({ by: ['consentStatus'], _count: { _all: true } }),
    prisma.candidate.groupBy({ by: ['consentSource'], where: { consentStatus: 'GIVEN' }, _count: { _all: true } }),
    P.consentAging({ take: 50 }),
    prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "LegalHold"'),
    prisma.candidate.count(),
    prisma.candidate.count({ where: { doNotContact: true } }),
  ]);
  const word = { GIVEN: 'Given', NOT_GIVEN: 'Not given', WITHDRAWN: 'Withdrawn' };
  const consent = byStatus.map((r) => ({ status: word[r.consentStatus] || 'Never recorded', people: r._count._all })).sort((a, b) => b.people - a.people);
  const audits = await prisma.auditLog.findMany({
    where: { createdAt: { gte: since }, OR: [{ action: { contains: 'exported' } }, { action: { contains: 'erase' } }, { action: { contains: 'Erase' } }, { action: { contains: 'legal hold' } }, { action: { contains: 'DPDP' } }] },
    select: { action: true, actorName: true, entity: true, createdAt: true, toValue: true }, orderBy: { createdAt: 'desc' }, take: 500,
  });
  const reads = await prisma.$queryRawUnsafe('SELECT "userName", "what", COUNT(*) AS n FROM "ReadLog" WHERE "at" >= ? GROUP BY "userName", "what" ORDER BY n DESC LIMIT 100', since.toISOString());
  const readTotal = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ReadLog" WHERE "at" >= ?', since.toISOString()))[0];
  const exportsBy = new Map();
  audits.filter((a) => /exported/i.test(a.action)).forEach((a) => { const k = a.actorName || '—'; exportsBy.set(k, (exportsBy.get(k) || 0) + 1); });
  const erasures = audits.filter((a) => /erase/i.test(a.action));
  const monitoringDays = Number(process.env.MONITORING_RETENTION_DAYS) || null;
  return {
    law: 'India - Digital Personal Data Protection Act, 2023 (DPDP)',
    notApplicable: 'EEO-1 and OFCCP are United States rules for US employers and federal contractors, so they do not apply here, and TeamLink does not collect race, gender or veteran data for them. GDPR covers people in the EU / EEA only; for them the same consent, export and erasure tools below are used.',
    window: { days: Math.round((Date.now() - since.getTime()) / DAY), from: since.toISOString().slice(0, 10) },
    consent: {
      total, byStatus: consent,
      bySource: bySource.map((r) => ({ source: r.consentSource || 'Not said', people: r._count._all })).sort((a, b) => b.people - a.people),
      reviewMonths: aging.months, olderThanReview: aging.expiredCount, neverRecorded: aging.neverRecorded, withdrawnOrDoNotContact: aging.withdrawn, doNotContact: dnc,
    },
    retention: {
      rules: [
        { what: 'Deleted candidates (recycle bin)', keep: '90 days, then gone for good' },
        { what: 'Who viewed personal data (access log)', keep: '365 days' },
        { what: 'Audit trail of changes', keep: 'Kept; sealed in a hash chain every 5 minutes' },
        { what: 'Web check-in selfies', keep: 'Deleted after the retention days set by HR (default 30)' },
        { what: 'Employee Monitoring activity', keep: monitoringDays ? `${monitoringDays} days` : 'The retention days set in Employee Monitoring' },
        { what: 'Candidate consent', keep: `Reviewed after ${aging.months} months (Administration -> Privacy)` },
      ],
      legalHolds: Number((holds[0] || {}).n || 0),
      erasures: erasures.length,
      erasureList: erasures.slice(0, 50).map((a) => ({ on: a.createdAt.toISOString().slice(0, 10), by: a.actorName || '—', what: a.action })),
    },
    access: {
      views: Number(readTotal.n || 0),
      byPerson: reads.map((r) => ({ person: r.userName || '—', what: r.what, times: Number(r.n) })),
      exports: [...exportsBy.entries()].map(([person, n]) => ({ person, downloads: n })).sort((a, b) => b.downloads - a.downloads),
      recentExports: audits.filter((a) => /exported/i.test(a.action)).slice(0, 50).map((a) => ({ on: a.createdAt.toISOString().slice(0, 16).replace('T', ' '), by: a.actorName || '—', what: a.action, detail: String(a.toValue || '').slice(0, 120) })),
    },
  };
}

// The pack as workbook sheets (exportKit.sendBook).
function sheets(p) {
  return [
    { name: 'Summary', headers: ['Item', 'Value'], rows: [['Law', p.law], ['Not applicable', p.notApplicable], ['Window', `last ${p.window.days} days (from ${p.window.from})`], ['Candidates', p.consent.total], ['Consent older than review', p.consent.olderThanReview], ['Consent never recorded', p.consent.neverRecorded], ['Withdrawn / do not contact', p.consent.withdrawnOrDoNotContact], ['Legal holds', p.retention.legalHolds], ['Erasures in window', p.retention.erasures], ['Personal-data views in window', p.access.views]] },
    { name: 'Consent', headers: ['Consent', 'People'], rows: p.consent.byStatus.map((r) => [r.status, r.people]) },
    { name: 'Consent source', headers: ['How consent was given', 'People'], rows: p.consent.bySource.map((r) => [r.source, r.people]) },
    { name: 'Retention', headers: ['What', 'Kept'], rows: p.retention.rules.map((r) => [r.what, r.keep]) },
    { name: 'Erasures', headers: ['On', 'By', 'What'], rows: p.retention.erasureList.map((r) => [r.on, r.by, r.what]) },
    { name: 'Access log', headers: ['Person', 'Opened', 'Times'], rows: p.access.byPerson.map((r) => [r.person, r.what, r.times]) },
    { name: 'Downloads', headers: ['On', 'By', 'What', 'Detail'], rows: p.access.recentExports.map((r) => [r.on, r.by, r.what, r.detail]) },
  ];
}

module.exports = { pack, sheets };
