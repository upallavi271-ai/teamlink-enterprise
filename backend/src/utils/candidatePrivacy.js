// ---------------------------------------------------------------------------
// CANDIDATE PRIVACY (DPDP Act 2023) - founder 2026-11-17 "build all the gaps", privacy phase. docs/DPDP-PROCESSING-REGISTER.md
// is the register that goes with it. Consent (given / not given / withdrawn = do not contact) was already on the profile
// (utils/candidateRecord.js); this adds the person's other rights and the company's controls:
//
//   exportOf(id)        RIGHT TO ACCESS: everything held about the person in one JSON file - profile, consent, applications
//                       with their steps, follow-ups, messages sent, notes, documents (names, not files), who opened the
//                       profile, the audit rows. Downloaded from the profile by an Admin / HR; the download is audited.
//   hold / release      LEGAL HOLD: a dispute or a legal case - the record cannot be erased or deleted while held.
//   erase(id, reason)   RIGHT TO ERASURE: the personal details are wiped (name -> "Erased candidate", phone, email, birth date,
//                       address, salary, CTC proofs, notes, message bodies, resume text) and the resume / document FILES are
//                       deleted. What is not personal stays so the counts and invoices of the past still add up (which job,
//                       which step, which date). Refused on legal hold, and for a placement still inside its replacement
//                       guarantee or not yet invoiced (money owed). Super Admin / Admin only. Audited with the reason.
//   consentAging(months) CONSENT REVIEW: people whose consent is older than N months (company setting, default 24) or who never
//                       gave it, so the team asks again or erases.
// Raw table "LegalHold" (created on first use, no Prisma migration).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const prisma = require('../db');
const { logAudit } = require('./audit');

let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LegalHold" ("candidateId" TEXT PRIMARY KEY, "reason" TEXT NOT NULL,
      "byName" TEXT, "byId" TEXT, "at" TEXT NOT NULL)`).catch((e) => { READY = null; throw e; });
  }
  return READY;
}
async function holdOf(candidateId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "LegalHold" WHERE "candidateId" = ?', String(candidateId));
  return rows[0] || null;
}
async function hold(candidateId, { reason, user }) {
  if (!String(reason || '').trim()) return { error: 'Write why the record is held (for example, the legal case or dispute).' };
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "LegalHold" ("candidateId","reason","byName","byId","at") VALUES (?,?,?,?,?) ON CONFLICT("candidateId") DO UPDATE SET "reason"=excluded."reason","byName"=excluded."byName","byId"=excluded."byId","at"=excluded."at"',
    String(candidateId), String(reason).trim().slice(0, 500), user && user.name, user && user.id, new Date().toISOString());
  await logAudit({ userId: user && user.id, action: 'Legal hold placed', entity: 'Candidate', entityId: candidateId, reason: String(reason).trim() });
  return { ok: true };
}
async function release(candidateId, { user, reason }) {
  await ensure();
  const h = await holdOf(candidateId);
  if (!h) return { error: 'This record is not on legal hold.' };
  await prisma.$executeRawUnsafe('DELETE FROM "LegalHold" WHERE "candidateId" = ?', String(candidateId));
  await logAudit({ userId: user && user.id, action: 'Legal hold released', entity: 'Candidate', entityId: candidateId, fromValue: h.reason, reason: reason || null });
  return { ok: true };
}

async function exportOf(candidateId) {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!c) return null;
  const safe = (p) => p.catch(() => []);
  const [apps, events, followUps, messages, notes, docs, resumes, audit] = await Promise.all([
    safe(prisma.application.findMany({ where: { candidateId }, include: { requirement: { select: { title: true, reqCode: true, client: { select: { name: true } } } } } })),
    safe(prisma.applicationStageEvent.findMany({ where: { application: { candidateId } }, orderBy: { createdAt: 'asc' } })),
    safe(prisma.applicationFollowUp.findMany({ where: { candidateId }, orderBy: { createdAt: 'asc' } })),
    safe(prisma.candidateMessage.findMany({ where: { candidateId }, orderBy: { createdAt: 'asc' } })),
    safe(prisma.candidateNote.findMany({ where: { candidateId } })),
    safe(prisma.candidateDocument.findMany({ where: { candidateId }, select: { docType: true, name: true, fileName: true, createdAt: true, deletedAt: true } })),
    safe(prisma.candidateResume.findMany({ where: { candidateId }, select: { kind: true, fileName: true, createdAt: true } })),
    safe(prisma.auditLog.findMany({ where: { entity: 'Candidate', entityId: candidateId }, orderBy: { createdAt: 'asc' }, take: 5000 })),
  ]);
  let views = [];
  try { views = (await require('./readLog').list({ entity: 'Candidate', entityId: candidateId, size: 5000 })).rows; } catch { /* none */ } // eslint-disable-line global-require
  return {
    generatedAt: new Date().toISOString(),
    note: 'Everything TeamLink holds about this person (DPDP Act 2023, right to access). Files are listed by name; copies are given separately on request.',
    profile: c,
    legalHold: await holdOf(candidateId),
    applications: apps,
    steps: events,
    followUps,
    messages,
    notes,
    documents: docs,
    resumes,
    whoOpenedTheProfile: views.map((v) => ({ at: v.at, by: v.userName, what: v.what })),
    auditTrail: audit,
  };
}

// money still owed or a guarantee still running on a placement of this person
async function erasureBlock(candidateId) {
  const h = await holdOf(candidateId);
  if (h) return `This record is on legal hold (${h.reason}). Release the hold first.`;
  const joined = await prisma.application.findMany({ where: { candidateId, stage: { in: ['JOINED', 'HIRED'] } }, select: { id: true, requirementId: true, joinedAt: true, updatedAt: true } }).catch(() => []);
  for (const a of joined) {
    // eslint-disable-next-line no-await-in-loop
    const inv = await prisma.invoice.findFirst({ where: { candidateId, requirementId: a.requirementId } }).catch(() => null);
    if (!inv) return 'This person joined a client and the joining is not invoiced yet. Erase after the invoice is made.';
    const status = String(inv.status || '').toLowerCase();
    if (!/paid|cancel/.test(status)) return `This person's placement is invoiced (${inv.invoiceNumber || 'invoice'}) but not paid yet. Erase after payment.`;
    const joinedAt = a.joinedAt || a.updatedAt;
    if (joinedAt && Date.now() - new Date(joinedAt).getTime() < 90 * 86400000) return 'This placement is still inside its 90-day replacement guarantee. Erase after it ends.';
  }
  return null;
}

function removeFile(rel) {
  if (!rel) return false;
  try {
    const base = require('./attachments').uploadDir(); // eslint-disable-line global-require
    for (const p of [rel, path.join(base, rel), path.join(base, 'candidate-docs', rel)]) {
      const abs = path.resolve(p);
      if (abs.startsWith(path.resolve(base)) && fs.existsSync(abs) && fs.statSync(abs).isFile()) { fs.unlinkSync(abs); return true; }
    }
  } catch { /* the row is wiped anyway */ }
  return false;
}

async function erase(candidateId, { reason, user }) {
  if (!String(reason || '').trim()) return { error: 'Write why this person\'s data is erased (for example, "Asked to be removed on 17 Nov by email").' };
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true, name: true } });
  if (!c) return { error: 'This candidate is not there.' };
  const block = await erasureBlock(candidateId);
  if (block) return { error: block, blocked: true };
  const tag = candidateId.slice(-6).toUpperCase();
  const NULLS = ['email', 'phone', 'dob', 'gender', 'location', 'preferredLocation', 'currentCompany', 'currentSalary', 'expectedSalary',
    'institute', 'passingYear', 'resumeName', 'externalRef', 'consentProof', 'referredByName', 'skills', 'goodToHaveSkills', 'technicalSkills', 'softSkills'];
  const data = { name: `Erased candidate ${tag}`, doNotContact: true, consentStatus: 'WITHDRAWN', consentWithdrawnAt: new Date() };
  NULLS.forEach((k) => { data[k] = null; });
  await prisma.candidate.update({ where: { id: candidateId }, data });
  let files = 0;
  const [docs, resumes] = await Promise.all([
    prisma.candidateDocument.findMany({ where: { candidateId }, select: { id: true, file: true } }).catch(() => []),
    prisma.candidateResume.findMany({ where: { candidateId }, select: { id: true, file: true, docxFile: true } }).catch(() => []),
  ]);
  for (const d of docs) { if (removeFile(d.file)) files += 1; }
  for (const r of resumes) { if (removeFile(r.file)) files += 1; if (removeFile(r.docxFile)) files += 1; }
  const wipe = (p) => p.catch(() => ({ count: 0 }));
  await Promise.all([
    wipe(prisma.candidateDocument.updateMany({ where: { candidateId }, data: { file: null, fileName: 'erased', name: 'erased', note: null, deletedAt: new Date(), deleteReason: 'Erased (DPDP)' } })),
    wipe(prisma.candidateResume.updateMany({ where: { candidateId }, data: { file: null, docxFile: null, fileName: 'erased', text: null, sections: null, parsed: null } })),
    wipe(prisma.candidateMessage.updateMany({ where: { candidateId }, data: { recipient: 'erased', subject: null, body: null } })),
    wipe(prisma.candidateNote.deleteMany({ where: { candidateId } })),
    wipe(prisma.applicationFollowUp.updateMany({ where: { candidateId }, data: { notes: null, completedNote: null } })),
  ]);
  try { require('./candidateListCache').markCandidateDirty(candidateId); } catch { /* the list catches up */ } // eslint-disable-line global-require
  await logAudit({ userId: user && user.id, action: 'Candidate data erased (DPDP)', entity: 'Candidate', entityId: candidateId, fromValue: c.name, toValue: data.name, reason: `${String(reason).trim()} · ${files} file(s) deleted` });
  return { ok: true, name: data.name, files };
}

const AGING_KEY = 'privacy.consentMonths';
async function consentMonths() {
  const r = await prisma.appSetting.findUnique({ where: { key: AGING_KEY } }).catch(() => null);
  const n = Number(r && r.value);
  return n >= 6 && n <= 60 ? n : 24;
}
async function setConsentMonths(n) {
  const v = Math.max(6, Math.min(60, Math.round(Number(n) || 24)));
  await prisma.appSetting.upsert({ where: { key: AGING_KEY }, create: { key: AGING_KEY, value: String(v) }, update: { value: String(v) } });
  return v;
}
async function consentAging({ months = null, take = 200 } = {}) {
  const m = months || await consentMonths();
  const before = new Date(Date.now() - m * 30.44 * 86400000);
  const [expired, expiredN, neverN, withdrawnN] = await Promise.all([
    prisma.candidate.findMany({ where: { consentStatus: 'GIVEN', consentAt: { lt: before }, doNotContact: false }, select: { id: true, name: true, consentAt: true }, orderBy: { consentAt: 'asc' }, take }),
    prisma.candidate.count({ where: { consentStatus: 'GIVEN', consentAt: { lt: before }, doNotContact: false } }),
    prisma.candidate.count({ where: { consentStatus: null } }),
    prisma.candidate.count({ where: { OR: [{ consentStatus: 'WITHDRAWN' }, { doNotContact: true }] } }),
  ]);
  return { months: m, expiredCount: expiredN, neverRecorded: neverN, withdrawn: withdrawnN, expired };
}

module.exports = { ensure, holdOf, hold, release, exportOf, erasureBlock, erase, consentAging, consentMonths, setConsentMonths };
