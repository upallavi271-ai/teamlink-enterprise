// ---------------------------------------------------------------------------
// JOININGS / AGREEMENTS IMPORT 2026-10-17 - READ THE DATABASE ONCE.
// Everything the planner needs is read into memory here (read only), with small helper indexes. The planner then
// "writes" into this memory model too (so rows later in the sheets see clients / candidates / applications the earlier rows made).
// ---------------------------------------------------------------------------
const P = require('./parse');

const gone = (e) => ['Relieved', 'Exited', 'Exit Process'].includes(e.employmentStatus);

async function load(prisma) {
  const [clients, aliases, reqs, cands, apps, emps, positions, invoices, users, importerFollowUps, signedDocs, signedSettings] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, legalName: true, ownerDepartment: true, location: true, industry: true, status: true, clientType: true, createdAt: true, agreementStatus: true } }),
    prisma.clientAlias.findMany({ select: { id: true, clientId: true, alias: true, aliasKey: true, source: true } }),
    prisma.requirement.findMany({ select: { id: true, clientId: true, title: true, department: true, specialisation: true, reqCode: true, status: true, createdAt: true, positionCode: true } }),
    prisma.candidate.findMany({ select: { id: true, name: true, phone: true, email: true, source: true, firstSource: true, education: true, specialization: true, experienceYears: true, currentSalary: true, expectedSalary: true, location: true, noticePeriod: true, currentDesignation: true, institute: true, externalRef: true, createdAt: true } }),
    prisma.application.findMany({ select: { id: true, candidateId: true, requirementId: true, stage: true, interviewAt: true, interviewStatus: true, interviewMode: true, interviewFeedback: true, offeredCtc: true, offerNotes: true, offerStatus: true, joiningDate: true, joiningStatus: true, joinedAt: true, documentsStatus: true, billingStatus: true, source: true, firstSource: true, createdAt: true, updatedAt: true } }),
    prisma.employee.findMany({ select: { id: true, userId: true, employeeCode: true, name: true, department: true, designation: true, employmentStatus: true, dateOfJoining: true } }),
    prisma.position.findMany({ select: { id: true, code: true, department: true } }),
    prisma.invoice.findMany({ select: { id: true, invoiceNumber: true, candidateId: true, requirementId: true, clientId: true, status: true } }),
    prisma.user.findMany({ select: { id: true, status: true } }),
    prisma.applicationFollowUp.findMany({ where: { createdByName: { startsWith: 'Imported — Joinings sheets' } }, select: { id: true, applicationId: true, candidateId: true, notes: true } }),
    prisma.clientDocument.findMany({ where: { kind: 'AGREEMENT_SIGNED' }, select: { id: true, clientId: true, fileName: true, fileSize: true } }),
    prisma.appSetting.findMany({ where: { key: { startsWith: 'agrsigned.' } }, select: { key: true, value: true } }),
  ]);
  const S = { clients, aliases, reqs, cands, apps, emps, positions, invoices, importerFollowUps, signedDocs, signedSettings };
  S.userById = new Map(users.map((u) => [u.id, u]));
  S.clientById = new Map(clients.map((c) => [c.id, c]));
  S.reqById = new Map(reqs.map((r) => [r.id, r]));
  S.reqsByClient = new Map(); reqs.forEach((r) => { if (!S.reqsByClient.has(r.clientId)) S.reqsByClient.set(r.clientId, []); S.reqsByClient.get(r.clientId).push(r); });
  S.candById = new Map(cands.map((c) => [c.id, c]));
  S.candsByPhone = new Map();
  cands.forEach((c) => P.phonesIn(c.phone).list.forEach((p) => { if (!S.candsByPhone.has(p)) S.candsByPhone.set(p, []); S.candsByPhone.get(p).push(c); }));
  S.candsByNameKey = new Map();
  cands.forEach((c) => { const k = P.letters(c.name); if (!k) return; if (!S.candsByNameKey.has(k)) S.candsByNameKey.set(k, []); S.candsByNameKey.get(k).push(c); });
  S.appById = new Map(apps.map((a) => [a.id, a]));
  S.appsByCand = new Map(); apps.forEach((a) => { if (!S.appsByCand.has(a.candidateId)) S.appsByCand.set(a.candidateId, []); S.appsByCand.get(a.candidateId).push(a); });
  S.appByPair = new Map(apps.map((a) => [`${a.candidateId}|${a.requirementId}`, a]));
  S.empById = new Map(emps.map((e) => [e.id, e]));
  S.posByCode = new Map(positions.map((p) => [p.code, p]));
  S.invByNo = new Map(); invoices.forEach((i) => { if (i.invoiceNumber) { const k = invoiceKey(i.invoiceNumber); if (!S.invByNo.has(k)) S.invByNo.set(k, []); S.invByNo.get(k).push(i); } });
  S.activeLogin = (e) => (e && e.userId && S.userById.get(e.userId) && S.userById.get(e.userId).status === 'Active' && !gone(e) ? e.userId : null);
  S.gone = gone;
  S.doneMarkers = new Set(); // source keys already imported by an earlier run
  importerFollowUps.forEach((f) => { const m = /\[JNG ([A-Z0-9-]+:\d+)\]/.exec(f.notes || ''); if (m) S.doneMarkers.add(m[1]); });
  S.doneMarkerFollowUp = new Map(); importerFollowUps.forEach((f) => { const m = /\[JNG ([A-Z0-9-]+:\d+)\]/.exec(f.notes || ''); if (m) S.doneMarkerFollowUp.set(m[1], f); });
  S.reqSeq = 0; reqs.forEach((r) => { const m = /^REQ-(\d+)$/.exec(r.reqCode || ''); if (m) S.reqSeq = Math.max(S.reqSeq, Number(m[1])); });
  return S;
}

// 1664 / "TY26-080" / "TY26-80" / " 1478 " -> one key: upper case, no spaces, leading zeros of the number part dropped
function invoiceKey(v) {
  const s = String(v == null ? '' : v).toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]+\d*)-0*(\d+)((?:-\d+)?)$/.exec(s);
  return m ? `${m[1]}-${m[2]}${m[3]}` : s.replace(/^0+(?=\d)/, '');
}

module.exports = { load, invoiceKey, gone };
