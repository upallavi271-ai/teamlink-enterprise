// ---------------------------------------------------------------------------
// THE PARTNER PORTAL API — /api/partner-portal/* (B7, 2026-10-06).
// The ONLY API a partner session can reach (utils/partnerAuth.js
// partnerSessionGuard refuses every other path with 403).
//
// Every route after /login:
//   1. validates the token AND its server-side session (requirePartner);
//   2. the caller is a PartnerUser (its own table — not a staff role);
//   3. partnerUserId / partnerId come from the session, never from the body;
//   4. a job is reached only through a live PartnerJobShare of THIS partner;
//   5. a submission / payout is reached only when it belongs to THIS partner.
// Out of reach and does-not-exist give the same 403, so ids cannot be probed.
// A partner sees: the shared job cards, their own submissions + status words,
// their own payouts. Never another partner's people, never client internals.
// ---------------------------------------------------------------------------
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../db');
const attachments = require('../utils/attachments');
const resumeStore = require('../utils/resumeStore');
const { rateLimit, ipOf } = require('../utils/publicRateLimit');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const { phoneKeys, emailKey } = require('../utils/candidateDedupe');
const PA = require('../utils/partnerAuth');
const PC = require('../utils/partnerConfig');
const P = require('../utils/partners');

const router = express.Router();
const { str, R } = P;
const NOT_YOURS = { error: 'Forbidden. This job is not shared with you.' };

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use((req, res, next) => (PC.portalEnabled() ? next() : res.status(404).json({ error: 'The Partner Portal is switched off.' })));
router.use((req, res, next) => (P.ready() ? next() : res.status(503).json(P.NOT_READY)));

// ---- sign in ----------------------------------------------------------------
const ipLimit = rateLimit({ bucket: 'partner-login-ip', max: Number(process.env.PARTNER_LOGIN_IP_MAX || 30), windowMs: 15 * 60000 });
const perEmail = new Map();
function emailLimit(req, res, next) {
  const key = `${ipOf(req)}|${P.normEmail(req.body && req.body.email)}`;
  const now = Date.now();
  const list = (perEmail.get(key) || []).filter((t) => now - t < 15 * 60000);
  if (list.length >= Number(process.env.PARTNER_LOGIN_EMAIL_MAX || 10)) {
    res.set('Retry-After', '900');
    return res.status(429).json({ error: 'Too many sign-in tries. Please wait 15 minutes and try again.' });
  }
  list.push(now);
  perEmail.set(key, list);
  if (perEmail.size > 5000) perEmail.clear();
  return next();
}
const DUMMY_HASH = bcrypt.hashSync(`x${Math.random()}`, 10);
const isLocked = (pu) => !!(pu.lockedUntil && new Date(pu.lockedUntil) > new Date());

router.post('/login', ipLimit, emailLimit, async (req, res) => {
  const email = P.normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const pu = await prisma.partnerUser.findUnique({ where: { email }, include: { partner: true } });
  const refuse = async (why) => {
    await logAudit({ action: 'Partner sign-in refused', entity: 'PartnerUser', entityId: pu ? pu.id : null, actorName: email, toValue: why });
    return res.status(403).json({ error: 'This login is switched off. Ask TeamLink to switch it on.' });
  };
  if (!pu || pu.deletedAt) {
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  if (isLocked(pu)) {
    return res.status(423).json({
      error: `This login is locked after ${PC.CFG.maxFailed} wrong passwords. Try again after ${new Date(pu.lockedUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, or ask TeamLink to reset your password.`,
      locked: true,
    });
  }
  const ok = await bcrypt.compare(password, pu.passwordHash);
  if (!ok) {
    const failed = (pu.failedLoginAttempts || 0) + 1;
    const lock = failed >= PC.CFG.maxFailed;
    await prisma.partnerUser.update({
      where: { id: pu.id },
      data: lock ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + PC.CFG.lockMinutes * 60000) } : { failedLoginAttempts: failed },
    });
    if (lock) {
      await PA.revokeSessions(pu.id, 'locked');
      await logAudit({ action: `Partner login locked after ${PC.CFG.maxFailed} wrong passwords`, entity: 'PartnerUser', entityId: pu.id, actorName: `Partner: ${pu.name}`, toValue: `Locked ${PC.CFG.lockMinutes} min` });
      return res.status(423).json({ error: `Too many wrong passwords. This login is locked for ${PC.CFG.lockMinutes} minutes.`, locked: true });
    }
    return res.status(401).json({ error: 'Wrong email or password.', triesLeft: PC.CFG.maxFailed - failed });
  }
  if (pu.status !== 'Active') return refuse('login inactive');
  if (!pu.partner || pu.partner.status !== 'Active') return refuse('partner paused');
  if (pu.mustChangePassword && pu.tempPasswordExpiresAt && new Date(pu.tempPasswordExpiresAt) < new Date()) return refuse('temporary password expired');
  const meta = PC.requestMeta(req);
  await prisma.partnerUser.update({ where: { id: pu.id }, data: { lastLoginAt: new Date(), lastLoginIp: meta.ip, failedLoginAttempts: 0, lockedUntil: null } });
  const { token } = await PA.createSession(pu, req);
  await logAudit({ action: 'Partner signed in', entity: 'PartnerUser', entityId: pu.id, actorName: `Partner: ${pu.name}`, toValue: pu.partner.name });
  return res.json({ token, idleMinutes: PA.IDLE_MINUTES, partner: meOf(pu) });
});

function meOf(pu) {
  return {
    name: pu.name, email: pu.email, partnerName: pu.partner ? pu.partner.name : '', partnerType: pu.partner ? pu.partner.type : '',
    mustChangePassword: !!pu.mustChangePassword, lastLoginAt: pu.lastLoginAt || null,
  };
}

const anyPartner = PA.requirePartner({ allowPasswordChange: true });
const partnerOnly = PA.requirePartner();

router.get('/me', anyPartner, async (req, res) => {
  const unread = await prisma.notification.count({ where: { channel: 'Partner', recipient: `partner:${req.partner.partnerId}`, read: false } });
  res.json({ ...meOf(req.partner.row), idleMinutes: PA.IDLE_MINUTES, unreadNotices: unread });
});

router.post('/logout', anyPartner, async (req, res) => {
  await prisma.partnerSession.update({ where: { id: req.partner.sessionId }, data: { revokedAt: new Date(), revokedReason: 'logout' } });
  res.json({ ok: true, message: 'Signed out.' });
});

router.post('/change-password', anyPartner, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const pu = await prisma.partnerUser.findUnique({ where: { id: req.partner.userId } });
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Enter your current password and a new one.' });
  if (confirmPassword !== undefined && confirmPassword !== newPassword) return res.status(400).json({ field: 'confirmPassword', error: 'The two new passwords do not match.' });
  if (!(await bcrypt.compare(String(currentPassword), pu.passwordHash))) {
    const failed = (pu.failedLoginAttempts || 0) + 1;
    const lock = failed >= PC.CFG.maxFailed;
    await prisma.partnerUser.update({ where: { id: pu.id }, data: lock ? { failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + PC.CFG.lockMinutes * 60000) } : { failedLoginAttempts: failed } });
    if (lock) await PA.revokeSessions(pu.id, 'locked');
    return res.status(400).json({ field: 'currentPassword', error: 'Your current password is not correct.' });
  }
  const weak = PC.partnerPasswordProblem(newPassword, { email: pu.email, name: pu.name });
  if (weak) return res.status(400).json({ field: 'newPassword', error: weak });
  const olds = [pu.passwordHash, ...PC.parseHistory(pu.passwordHistory)];
  for (const h of olds) {
    // eslint-disable-next-line no-await-in-loop
    if (h && await bcrypt.compare(String(newPassword), h)) return res.status(400).json({ field: 'newPassword', error: 'Choose a password you have not used before.' });
  }
  await prisma.partnerUser.update({
    where: { id: pu.id },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), 10), passwordHistory: PC.pushHistory(pu.passwordHistory, pu.passwordHash),
      mustChangePassword: false, tempPasswordExpiresAt: null, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null,
    },
  });
  await PA.revokeSessions(pu.id, 'password changed', req.partner.sessionId);
  await logAudit({ action: 'Partner password changed', entity: 'PartnerUser', entityId: pu.id, actorName: `Partner: ${pu.name}`, toValue: 'Changed' });
  res.json({ ok: true, message: 'Password changed.' });
});

// ---- jobs ---------------------------------------------------------------------
const REQ_INCLUDE = { client: { select: { name: true } } };
async function sharedJobs(partner) {
  const shares = await prisma.partnerJobShare.findMany({ where: { partnerId: partner.id, revokedAt: null } });
  if (!shares.length) return [];
  const reqs = await prisma.requirement.findMany({ where: { id: { in: shares.map((s) => s.requirementId) }, status: { in: P.LIVE } }, include: REQ_INCLUDE, orderBy: { updatedAt: 'desc' } });
  const byId = new Map(shares.map((s) => [s.requirementId, s]));
  return reqs.map((r) => ({ r, share: byId.get(r.id) }));
}
async function myJob(req, id) {
  const share = await prisma.partnerJobShare.findFirst({ where: { partnerId: req.partner.partnerId, requirementId: String(id || ''), revokedAt: null } });
  if (!share) return null;
  const r = await prisma.requirement.findUnique({ where: { id: share.requirementId }, include: REQ_INCLUDE });
  if (!r || !P.LIVE.includes(r.status)) return null;
  return { r, share };
}

function subView(s, payout) {
  return {
    id: s.id, code: s.code, requirementId: s.requirementId, name: s.name, phone: s.phone, email: s.email,
    currentCtc: s.currentCtc, expectedCtc: s.expectedCtc, noticePeriod: s.noticePeriod, location: s.location,
    status: s.status, statusText: P.STATUS_WORDS[s.status] || s.status, statusAt: s.statusAt || s.submittedAt,
    duplicateReason: s.status === 'Duplicate' ? s.duplicateReason : null, submittedAt: s.submittedAt,
    resumeName: s.resumeName || null,
    payout: payout ? { number: payout.number, status: payout.status, statusText: P.PAYOUT_WORDS[payout.status] || payout.status, net: payout.net, holdUntil: payout.holdUntil, paidOn: payout.paidOn } : null,
  };
}
async function payoutsBySubmission(partnerId, subIds) {
  const rows = subIds.length ? await prisma.partnerPayout.findMany({ where: { partnerId, submissionId: { in: subIds }, kind: 'PAYOUT', NOT: { status: 'Cancelled' } } }) : [];
  return new Map(rows.map((p) => [p.submissionId, p]));
}

router.get('/jobs', partnerOnly, async (req, res) => {
  const list = await sharedJobs(req.partner.partner);
  const counts = await prisma.partnerSubmission.groupBy({ by: ['requirementId'], where: { partnerId: req.partner.partnerId }, _count: { _all: true } });
  const cm = new Map(counts.map((c) => [c.requirementId, c._count._all]));
  res.json({
    rows: list.map(({ r, share }) => ({ ...P.partnerJobView(r, share, req.partner.partner), mySubmissions: cm.get(r.id) || 0 })),
    partnerName: req.partner.partnerName,
  });
});

router.get('/jobs/:id', partnerOnly, async (req, res) => {
  const got = await myJob(req, req.params.id);
  if (!got) return res.status(403).json(NOT_YOURS);
  const subs = await prisma.partnerSubmission.findMany({ where: { partnerId: req.partner.partnerId, requirementId: got.r.id }, orderBy: { submittedAt: 'desc' } });
  const pm = await payoutsBySubmission(req.partner.partnerId, subs.map((s) => s.id));
  return res.json({ job: P.partnerJobView(got.r, got.share, req.partner.partner), submissions: subs.map((s) => subView(s, pm.get(s.id))) });
});

// ---- submit a candidate -------------------------------------------------------
const RESUME_MESSAGE = {
  NO_FILE: 'Attach the resume (PDF or Word).',
  TOO_LARGE: 'The resume is bigger than 10 MB. Please attach a smaller file.',
  BAD_TYPE: 'Only a PDF or Word resume (.pdf, .doc, .docx) can be attached.',
  CONTENT_MISMATCH: 'That file does not look like a real PDF / Word file. Please attach the original.',
  NOT_MULTIPART: 'Could not read the form. Please try again.',
};
const num = (v) => { const r = String(v ?? '').replace(/[,\s₹]/g, ''); return r === '' ? null : Number(r); };
const yes = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

// The duplicate rule, server-side: a phone / email already on a Candidate is a
// duplicate — unless THIS partner owns that person and the ownership is live.
async function findExisting({ phone, email }) {
  const pk = phoneKeys(phone);
  const ek = emailKey(email);
  const or = [...pk.map((k) => ({ phone: { contains: k } })), ...(ek ? [{ email: { contains: ek } }] : [])];
  if (!or.length) return [];
  const rows = await prisma.candidate.findMany({ where: { OR: or }, select: { id: true, name: true, phone: true, email: true, createdAt: true, ownerPartnerId: true, ownerUntil: true, source: true }, take: 30 });
  return rows.filter((c) => (pk.length && phoneKeys(c.phone).some((k) => pk.includes(k))) || (ek && emailKey(c.email) === ek));
}
const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

router.post('/jobs/:id/submit', partnerOnly, async (req, res) => {
  const got = await myJob(req, req.params.id);
  if (!got) return res.status(403).json(NOT_YOURS);
  const { r, share } = got;
  const partner = req.partner.partner;
  if (!P.partnerMayDepartment(partner, r.department)) return res.status(403).json({ error: `Your agreement does not cover the ${r.department || ''} department.` });
  let form;
  try {
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('NOT_MULTIPART'), { code: 'NOT_MULTIPART' });
    form = await resumeStore.parseResumeUpload(req);
  } catch (err) { return res.status(400).json({ error: RESUME_MESSAGE[err.code] || 'Could not read the form. Please try again.' }); }
  const f = form.fields || {};
  const name = str(f.name).replace(/\s+/g, ' ').slice(0, 120);
  const phone = str(f.phone).slice(0, 40);
  const email = P.normEmail(f.email).slice(0, 160);
  if (!name) return res.status(400).json({ error: 'Enter the candidate name.', field: 'name' });
  if (!phoneKeys(phone).length) return res.status(400).json({ error: 'Enter a proper 10-digit mobile number.', field: 'phone' });
  if (!email || !P.EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a proper email address.', field: 'email' });
  if (!yes(f.consent)) return res.status(400).json({ error: 'Tick "The candidate agreed to share their details with TeamLink" first.', field: 'consent' });
  if (!form.file) return res.status(400).json({ error: RESUME_MESSAGE.NO_FILE, field: 'resume' });
  let fileInfo;
  try { fileInfo = resumeStore.validateResumeFile(form.file); } catch (err) { return res.status(400).json({ error: RESUME_MESSAGE[err.code] || RESUME_MESSAGE.BAD_TYPE, field: 'resume' }); }
  const currentCtc = num(f.currentCtc);
  const expectedCtc = num(f.expectedCtc);
  if (currentCtc != null && !(currentCtc >= 0)) return res.status(400).json({ error: 'Current CTC must be a number, like 650000.', field: 'currentCtc' });
  const meta = PC.requestMeta(req);
  const by = `Partner: ${partner.name} (${req.partner.name})`;
  const base = {
    partnerId: partner.id, partnerUserId: req.partner.userId, requirementId: r.id, name, phone, email,
    currentCtc, expectedCtc, noticePeriod: str(f.noticePeriod).slice(0, 60) || null, location: str(f.location).slice(0, 120) || null,
    skills: str(f.skills).slice(0, 500) || null, note: str(f.note).slice(0, 1000) || null, consentTicked: true, ip: meta.ip,
  };

  // Duplicate?
  const hits = await findExisting({ phone, email });
  const now = new Date();
  const mine = hits.find((c) => c.ownerPartnerId === partner.id && c.ownerUntil && new Date(c.ownerUntil) > now);
  if (hits.length && !mine) {
    const first = [...hits].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    const other = hits.find((c) => c.ownerPartnerId && c.ownerPartnerId !== partner.id && c.ownerUntil && new Date(c.ownerUntil) > now);
    const reason = other
      ? `Duplicate: already submitted by another partner on ${day(other.createdAt)} (their ownership runs till ${day(other.ownerUntil)})`
      : `Duplicate: already with TeamLink since ${day(first.createdAt)}`;
    const sub = await P.createWithCode('partnerSubmission', 'code', P.nextSubmissionCode, {
      ...base, status: 'Duplicate', duplicateReason: reason, duplicateOfCandidateId: first.id, statusAt: now,
    });
    await logAudit({ action: 'Partner submission refused as duplicate', entity: 'PartnerSubmission', entityId: sub.id, actorName: by, fromValue: `${name} · ${phone} · ${email}`, toValue: reason, reason: `matches candidate ${first.id}` });
    return res.status(409).json({ duplicate: true, error: reason, submission: subView(sub, null) });
  }

  // Already sent for THIS job?
  if (mine) {
    const dup = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: mine.id, requirementId: r.id } } });
    if (dup) return res.status(409).json({ error: `${mine.name} is already submitted for this job.` });
  }

  // Accept: candidate (new, or your own live one) + consent + resume + application.
  const ownershipDays = Math.max(1, Number(partner.ownershipDays) || 365);
  let candidate;
  let created = false;
  if (mine) {
    candidate = await prisma.candidate.findUnique({ where: { id: mine.id } });
  } else {
    candidate = await prisma.candidate.create({
      data: {
        name, phone, email, location: base.location, skills: base.skills,
        currentSalary: currentCtc != null ? String(currentCtc) : null, expectedSalary: expectedCtc != null ? String(expectedCtc) : null,
        noticePeriod: base.noticePeriod || '30 Days', source: P.PARTNER_SOURCE, firstSource: P.PARTNER_SOURCE, sourceCampaign: partner.name,
        ownerPartnerId: partner.id, ownerUntil: new Date(now.getTime() + ownershipDays * 86400000),
      },
    });
    created = true;
    try {
      await require('../utils/candidateRecord').setConsent(candidate.id, { // eslint-disable-line global-require
        status: 'GIVEN', purposes: ['Recruitment', 'Share with clients'], source: 'partner',
        proof: `Partner ${partner.name} (${req.partner.name}, ${req.partner.email}) confirmed the candidate agreed to share their details — ${now.toISOString()} from ${meta.ip}`,
        byName: by,
      });
    } catch (err) { console.error('[partners] consent:', err.message); } // eslint-disable-line no-console
    await logAudit({ action: 'Candidate created (partner)', entity: 'Candidate', entityId: candidate.id, actorName: by, toValue: `${name} · owned by ${partner.name} till ${P.addDays(P.todayIst(), ownershipDays)}` });
  }
  let resume = null;
  try { resume = await resumeStore.saveOriginalResume({ candidateId: candidate.id, file: form.file, user: { id: null, name: by }, note: `Sent by partner ${partner.name}` }); } catch (err) { console.error('[partners] resume:', err.message); } // eslint-disable-line no-console
  const actor = { id: null, name: by, role: 'PARTNER', atsRole: 'PARTNER' };
  const { addApplication } = require('./applications'); // eslint-disable-line global-require
  const application = await addApplication(actor, { candidate, requirement: r, comment: base.note ? `Partner note: ${base.note}` : `Sent by partner ${partner.name}`, from: { applicationMethod: 'Partner' } });
  const sub = await P.createWithCode('partnerSubmission', 'code', P.nextSubmissionCode, {
    ...base, candidateId: candidate.id, applicationId: application.id, status: 'Submitted', statusAt: now,
    resumeFile: resume ? resume.file : null, resumeName: resume ? resume.fileName : attachments.safeDisplayName(form.file.filename), resumeMime: fileInfo.mime, resumeSize: form.file.data.length,
  });
  await prisma.application.update({ where: { id: application.id }, data: { partnerId: partner.id, partnerSubmissionId: sub.id, source: P.PARTNER_SOURCE, firstSource: P.PARTNER_SOURCE, sourceCampaign: partner.name } });
  if (created) await prisma.candidate.update({ where: { id: candidate.id }, data: { ownerSubmissionId: sub.id } });
  try { require('../utils/candidateListCache').markCandidateDirty(candidate.id); } catch { /* optional */ } // eslint-disable-line global-require
  await logAudit({ action: 'Partner submitted a candidate', entity: 'PartnerSubmission', entityId: sub.id, actorName: by, toValue: `${sub.code} · ${name} → ${r.reqCode || ''} ${r.title}` });
  await notifyUsers([r.recruiterId, r.tlId], {
    title: `Partner candidate: ${name}`,
    message: `${partner.name} sent ${name} for ${r.title}${r.client ? ` (${r.client.name})` : ''}. Open Candidates & Pipeline to screen them.`,
  });
  return res.status(201).json({ submission: subView(sub, null), message: `${name} sent. TeamLink will screen the profile and you will see every step here.` });
});

// ---- my submissions / payouts / notices -------------------------------------------
router.get('/submissions', partnerOnly, async (req, res) => {
  const subs = await prisma.partnerSubmission.findMany({ where: { partnerId: req.partner.partnerId }, orderBy: { submittedAt: 'desc' }, take: 500 });
  const pm = await payoutsBySubmission(req.partner.partnerId, subs.map((s) => s.id));
  const reqIds = [...new Set(subs.map((s) => s.requirementId))];
  const reqs = reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, title: true, reqCode: true } }) : [];
  const rm = new Map(reqs.map((r) => [r.id, r]));
  const counts = {};
  P.SUB_STATUSES.forEach((s) => { counts[s] = subs.filter((x) => x.status === s).length; });
  res.json({ rows: subs.map((s) => ({ ...subView(s, pm.get(s.id)), job: rm.get(s.requirementId) ? `${rm.get(s.requirementId).reqCode ? `${rm.get(s.requirementId).reqCode} · ` : ''}${rm.get(s.requirementId).title}` : 'Job' })), counts });
});

function payoutView(p) {
  return {
    id: p.id, number: p.number, kind: p.kind, candidateName: p.candidateName, requirementTitle: p.requirementTitle, joinedOn: p.joinedOn,
    fee: p.fee, gstPercent: p.gstPercent, gst: p.gst, tdsSection: p.tdsSection, tdsPercent: p.tdsPercent, tds: p.tds, net: p.net,
    holdUntil: p.holdUntil, status: p.status, statusText: p.kind === 'CLAWBACK' ? `Recovery — ${P.PAYOUT_WORDS[p.status] || p.status}` : (P.PAYOUT_WORDS[p.status] || p.status),
    paidOn: p.paidOn, paidRef: p.paidRef, partnerInvoice: p.partnerInvoiceFile ? { name: p.partnerInvoiceName, number: p.partnerInvoiceNumber, date: p.partnerInvoiceDate } : null,
    canUploadInvoice: p.kind === 'PAYOUT' && ['Draft', 'Approved'].includes(p.status),
  };
}
router.get('/payouts', partnerOnly, async (req, res) => {
  const rows = await prisma.partnerPayout.findMany({ where: { partnerId: req.partner.partnerId }, orderBy: { createdAt: 'desc' } });
  const live = rows.filter((p) => p.status !== 'Cancelled');
  res.json({
    rows: rows.map(payoutView),
    totals: { payable: R(live.filter((p) => p.status === 'Approved').reduce((a, p) => a + p.net, 0)), paid: R(live.filter((p) => p.status === 'Paid').reduce((a, p) => a + p.net, 0)), preparing: R(live.filter((p) => p.status === 'Draft').reduce((a, p) => a + p.net, 0)) },
  });
});
const INV_MAX = 10 * 1024 * 1024;
router.post('/payouts/:id/invoice', partnerOnly, async (req, res) => {
  const p = await prisma.partnerPayout.findFirst({ where: { id: String(req.params.id || ''), partnerId: req.partner.partnerId } });
  if (!p) return res.status(403).json({ error: 'Forbidden. This payout is not yours.' });
  if (!(p.kind === 'PAYOUT' && ['Draft', 'Approved'].includes(p.status))) return res.status(409).json({ error: 'An invoice can be added only while the payout is being prepared or approved.' });
  let form;
  try {
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('NOT_MULTIPART'), { code: 'NOT_MULTIPART' });
    form = await attachments.parseMultipart(req, { maxBytes: INV_MAX });
  } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' }); }
  if (!form.file) return res.status(400).json({ error: 'Choose the invoice file (PDF or photo).' });
  let st;
  try { st = attachments.store(form.file, { maxBytes: INV_MAX }); } catch (err) { return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Only a PDF or a photo can be uploaded.' }); }
  const number = str(form.fields.invoiceNumber).slice(0, 60) || null;
  const date = str(form.fields.invoiceDate);
  if (p.partnerInvoiceFile) attachments.remove(p.partnerInvoiceFile);
  const updated = await prisma.partnerPayout.update({
    where: { id: p.id },
    data: { partnerInvoiceFile: st.billFile, partnerInvoiceName: st.billName, partnerInvoiceMime: st.billMime, partnerInvoiceSize: st.billSize, partnerInvoiceNumber: number, partnerInvoiceDate: P.isRealDay(date) ? date : null },
  });
  await logAudit({ action: 'Partner invoice uploaded', entity: 'PartnerPayout', entityId: p.id, actorName: `Partner: ${req.partner.partnerName}`, toValue: `${p.number} · ${st.billName}${number ? ` · ${number}` : ''}` });
  return res.status(201).json({ payout: payoutView(updated), message: 'Invoice attached. Accounts will see it on the payout.' });
});

router.get('/notices', partnerOnly, async (req, res) => {
  const rows = await prisma.notification.findMany({ where: { channel: 'Partner', recipient: `partner:${req.partner.partnerId}` }, orderBy: { createdAt: 'desc' }, take: 40 });
  res.json({ rows: rows.map((n) => ({ id: n.id, title: n.title, message: n.message, read: n.read, at: n.createdAt })), unread: rows.filter((n) => !n.read).length });
});
router.post('/notices/read', partnerOnly, async (req, res) => {
  await prisma.notification.updateMany({ where: { channel: 'Partner', recipient: `partner:${req.partner.partnerId}`, read: false }, data: { read: true } });
  res.json({ ok: true });
});

// Anything else under /api/partner-portal is not part of the portal.
router.use((req, res) => res.status(403).json({ error: 'Forbidden.' }));

module.exports = router;
