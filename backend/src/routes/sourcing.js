// ---------------------------------------------------------------------------
// SOURCING (b6_, ATS-100 B6) — /api/sourcing
//
// EMPLOYEE REFERRALS (any staff login — HRMS My profile, or the ATS)
//   GET  /referrals/me            my code + links, my referrals with status
//                                 (Submitted / Interview / Joined), open jobs
//   POST /referrals               "Refer a candidate" (JSON or multipart with an
//                                 optional resume): name, phone, email,
//                                 requirementId?, note, agreed=yes
// REFERRALS, THE TEAM'S VIEW (internal ATS logins, scoped)
//   GET  /referrals               every referral this login may see
//   POST /referrals/:id/bonus     record a bonus amount (Super Admin / Admin / HR)
//   POST /referrals/:id/bonus/decide   APPROVED | REJECTED (Super Admin only)
//                                 Recorded here only — never posted to payroll.
// CAMPUS DRIVES
//   GET  /campus-drives           drives + how many people came from each
//   POST /campus-drives           { collegeName, driveDate, location, requirementId, cost, note }
//   PUT  /campus-drives/:id
// CAMPAIGN COSTS (for the Campaign performance report)
//   GET  /campaigns               cost rows + every utm_campaign seen on applications
//   POST /campaigns               upsert by name: { name, cost, source, medium, startDate, endDate, note }
// PICKERS
//   GET  /employees?q=            "Referred by" picker (internal ATS logins)
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../db');
const { requireAuth } = require('../middleware/auth');
const { roleForProduct } = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');
const scope = require('../utils/scope');
const rec = require('../utils/candidateRecord');
const store = require('../utils/resumeStore');
const { emailKey, phoneKeys } = require('../utils/candidateDedupe');
const { REQUIREMENT_LIVE_STATUSES } = require('../utils/atsVocab');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (!rec.supported()) return res.status(503).json({ error: rec.NOT_READY });
  return next();
});

const held = (u) => {
  const sr = (u && u.scopeRoles) || {};
  return [u.role, u.atsRole, u.hrmsRole, u.accountsRole, sr.ats, sr.hrms, sr.accounts].filter(Boolean);
};
const has = (u, roles) => held(u).some((r) => roles.includes(r));
const isOutsider = (u) => !u || has(u, ['CLIENT', 'CANDIDATE']);
const atsRole = (u) => roleForProduct(u, 'ats');
const ATS_INTERNAL = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'RECRUITER', 'BDE', 'HR'];
const isAtsInternal = (u) => !isOutsider(u) && (ATS_INTERNAL.includes(atsRole(u)) || has(u, ['SUPER_ADMIN', 'ADMIN', 'HR']));
const mayRecordBonus = (u) => has(u, ['SUPER_ADMIN', 'ADMIN', 'HR']);
const mayApproveBonus = (u) => has(u, ['SUPER_ADMIN']);
const mayManageDrives = (u) => has(u, ['SUPER_ADMIN', 'ADMIN', 'HR', 'TL', 'STL', 'RECRUITER']);
const mayManageCosts = (u) => has(u, ['SUPER_ADMIN', 'ADMIN', 'HR']);
const isTestText = (s) => /zztest|example\.test/i.test(String(s || ''));

const txt = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const money = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) / 100 : NaN;
};
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
const EMAIL_OK = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

// --- shared: referral rows with their live status -----------------------------------
async function shapeReferrals(rows) {
  if (!rows.length) return [];
  const appIds = rows.map((r) => r.applicationId).filter(Boolean);
  const candIds = [...new Set(rows.map((r) => r.candidateId))];
  const [apps, cands, reqs] = await Promise.all([
    prisma.application.findMany({
      where: { OR: [{ id: { in: appIds } }, { candidateId: { in: candIds } }] },
      select: { id: true, candidateId: true, requirementId: true, stage: true, interviewAt: true, interviewStatus: true, createdAt: true, joinedAt: true, joiningDate: true },
    }),
    prisma.candidate.findMany({ where: { id: { in: candIds } }, select: { id: true, name: true } }),
    prisma.requirement.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.requirementId).filter(Boolean))] } },
      select: { id: true, title: true, reqCode: true },
    }),
  ]);
  const appById = new Map(apps.map((a) => [a.id, a]));
  const candName = new Map(cands.map((c) => [c.id, c.name]));
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  return rows.map((r) => {
    // The referral's own application; with none (referred without a job), the
    // first job they were added to after the referral.
    let app = r.applicationId ? appById.get(r.applicationId) : null;
    if (!app) {
      app = apps.filter((a) => a.candidateId === r.candidateId && a.createdAt >= r.createdAt)
        .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
    }
    const req = reqById.get((app && app.requirementId) || r.requirementId);
    return {
      id: r.id,
      candidateId: r.candidateId,
      candidateName: candName.get(r.candidateId) || '—',
      referrerName: r.referrerName,
      referrerUserId: r.referrerUserId,
      via: r.via,
      job: req ? { id: req.id, title: req.title, code: req.reqCode } : null,
      applicationId: app ? app.id : null,
      status: rec.referralStatus(app),
      joinedOn: app && ['JOINED', 'HIRED'].includes(app.stage) ? (app.joiningDate || (app.joinedAt && app.joinedAt.toISOString().slice(0, 10)) || null) : null,
      note: r.note,
      bonus: r.bonusStatus ? {
        amount: r.bonusAmount, status: r.bonusStatus, note: r.bonusNote,
        proposedBy: r.bonusProposedByName, proposedAt: r.bonusProposedAt, decidedBy: r.bonusDecidedByName, decidedAt: r.bonusDecidedAt,
      } : null,
      createdAt: r.createdAt,
    };
  });
}

async function openJobs() {
  const rows = await prisma.requirement.findMany({
    where: { status: { in: REQUIREMENT_LIVE_STATUSES } },
    select: { id: true, title: true, reqCode: true, location: true, department: true, portalPublished: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  // The client is never named here: a job title, place and department only.
  return rows.filter((r) => !isTestText(r.title)).map((r) => ({
    id: r.id, title: r.title, code: r.reqCode, location: r.location, department: r.department, onPortal: !!r.portalPublished,
  }));
}

// --- my referrals -------------------------------------------------------------------------
router.get('/referrals/me', async (req, res) => {
  if (isOutsider(req.user)) return res.status(403).json({ error: 'Referrals are for TeamLink staff.' });
  const [code, rows, jobs] = await Promise.all([
    rec.codeFor(req.user),
    prisma.candidateReferral.findMany({ where: { referrerUserId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    openJobs(),
  ]);
  const referrals = await shapeReferrals(rows);
  const count = (k) => referrals.filter((r) => r.status.key === k).length;
  return res.json({
    code: code.code,
    referrals,
    counts: { total: referrals.length, submitted: count('submitted'), interview: count('interview'), joined: count('joined') },
    jobs,
  });
});

// --- refer a candidate -----------------------------------------------------------------------
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

router.post('/referrals', async (req, res) => {
  if (isOutsider(req.user)) return res.status(403).json({ error: 'Referrals are for TeamLink staff.' });
  let fields = req.body || {};
  let file = null;
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    try {
      const parsed = await store.parseResumeUpload(req);
      fields = parsed.fields || {};
      file = parsed.file;
    } catch (err) {
      return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: store.RESUME_MESSAGE[err.code] || 'The form could not be read. Please try again.' });
    }
  }
  const name = txt(fields.name, 100);
  const email = txt(fields.email, 120).toLowerCase();
  const phone = txt(fields.phone, 30);
  const note = txt(fields.note, 500);
  if (name.length < 2) return res.status(400).json({ error: 'Type the person\'s full name.' });
  if (!phoneKeys(phone).length) return res.status(400).json({ error: 'Type their 10-digit mobile number.' });
  if (email && (!EMAIL_OK.test(email) || !emailKey(email))) return res.status(400).json({ error: 'That email address does not look right.' });
  if (!/^(yes|true|on|1)$/i.test(String(fields.agreed || ''))) return res.status(400).json({ error: 'Tick the box to confirm the person knows you are sharing their details.' });
  if (file) {
    try { store.validateResumeFile(file); } catch (err) { return res.status(err.code === 'TOO_LARGE' ? 413 : 400).json({ error: store.RESUME_MESSAGE[err.code] || 'Only PDF and Word resumes.' }); }
  }
  let job = null;
  if (fields.requirementId) {
    job = await prisma.requirement.findUnique({ where: { id: String(fields.requirementId) } });
    // eslint-disable-next-line global-require
    const refusal = await require('./applications').jobRefusalFor(job);
    if (refusal) return res.status(refusal.status).json(refusal.body);
  }
  const me = req.user;
  const out = await serial(async () => {
    // eslint-disable-next-line global-require
    let candidate = await require('../utils/jobPortalBridge').findCandidateByContact({ email, phone });
    const alreadyOnFile = !!candidate;
    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: {
          name, email: email || null, phone, source: 'Employee Referral', firstSource: 'Employee Referral',
          referredByEmployeeId: me.employeeId || null, referredByName: me.name,
        },
      });
      await logAudit({ userId: me.id, actorName: me.name, action: 'Candidate created (employee referral)', entity: 'Candidate', entityId: candidate.id, toValue: `Referred by ${me.name}` });
    } else if (!candidate.referredByName) {
      candidate = await prisma.candidate.update({ where: { id: candidate.id }, data: { referredByEmployeeId: me.employeeId || null, referredByName: me.name } });
    }
    let application = null;
    let alreadyApplied = false;
    if (job) {
      const existing = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: candidate.id, requirementId: job.id } } });
      if (existing) {
        alreadyApplied = true;
      } else {
        // eslint-disable-next-line global-require
        application = await require('./applications').addApplication(me, {
          candidate, requirement: job, comment: `Employee referral by ${me.name}`, from: { applicationMethod: 'Referral' },
        });
      }
    }
    const referral = await prisma.candidateReferral.create({
      data: {
        referrerUserId: me.id,
        referrerEmployeeId: me.employeeId || null,
        referrerName: me.name,
        via: 'FORM',
        candidateId: candidate.id,
        applicationId: application ? application.id : null,
        requirementId: job ? job.id : null,
        note: [note, alreadyOnFile ? 'Already in our candidate list when referred.' : null, alreadyApplied ? 'Had already applied to this job.' : null].filter(Boolean).join(' ') || null,
        createdById: me.id,
        createdByName: me.name,
      },
    });
    if (application) {
      await prisma.application.update({
        where: { id: application.id },
        data: {
          source: 'Employee Referral', firstSource: 'Employee Referral', referralId: referral.id,
          referredByEmployeeId: me.employeeId || null, referredByName: me.name,
        },
      });
    }
    return { candidate, application, referral, alreadyOnFile, alreadyApplied };
  });
  if (file) {
    try {
      await store.saveOriginalResume({ candidateId: out.candidate.id, file, user: me, note: `Employee referral by ${me.name}` });
    } catch (err) { console.error(`[referral] resume not stored for ${out.candidate.id}: ${err.message}`); }
  }
  try { require('../utils/candidateListCache').markCandidateDirty(out.candidate.id); } catch { /* optional */ } // eslint-disable-line global-require
  await logAudit({
    userId: me.id, actorName: me.name, action: 'Employee referral submitted', entity: 'Candidate', entityId: out.candidate.id,
    toValue: `${out.candidate.name}${job ? ` → ${job.title}` : ' (no job picked)'} · by ${me.name}`,
  });
  if (job) {
    await notifyUsers([job.recruiterId, job.tlId].filter(Boolean), {
      title: 'New employee referral', message: `${me.name} referred ${out.candidate.name} for ${job.title}`, exceptUserId: me.id,
    }).catch(() => null);
  }
  let message = 'Thank you! Your referral is saved. You can follow it below.';
  if (out.alreadyApplied) message = 'Saved. This person had already applied to this job, so the recruiter already has them.';
  else if (out.alreadyOnFile) message = 'Saved. This person was already in our list — the team will see that you referred them.';
  return res.status(201).json({ ok: true, message, referralId: out.referral.id });
});

// --- the team's view -------------------------------------------------------------------------------
router.get('/referrals', async (req, res) => {
  if (!isAtsInternal(req.user)) return res.status(403).json({ error: 'Referrals are for the recruitment team.' });
  const s = scope.atsScopeOf(req.user);
  let rows = await prisma.candidateReferral.findMany({ orderBy: { createdAt: 'desc' }, take: 2000 });
  if (!s.global && !has(req.user, ['HR'])) {
    const reqIds = [...new Set(rows.map((r) => r.requirementId).filter(Boolean))];
    const ok = new Set((await prisma.requirement.findMany({
      where: { AND: [{ id: { in: reqIds } }, scope.requirementWhere(req.user)] }, select: { id: true },
    })).map((r) => r.id));
    rows = rows.filter((r) => r.referrerUserId === req.user.id || (r.requirementId && ok.has(r.requirementId)));
  }
  const referrals = await shapeReferrals(rows);
  return res.json({
    referrals,
    rights: { canRecordBonus: mayRecordBonus(req.user), canApproveBonus: mayApproveBonus(req.user) },
    note: 'Bonus amounts are recorded here for Super Admin approval. They are not added to payroll automatically.',
  });
});

router.post('/referrals/:id/bonus', async (req, res) => {
  if (!mayRecordBonus(req.user)) return res.status(403).json({ error: 'Only Super Admin, Admin or HR can record a referral bonus.' });
  const r = await prisma.candidateReferral.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Referral not found' });
  if (r.bonusStatus === 'APPROVED') return res.status(409).json({ error: 'This bonus is already approved.' });
  const amount = money(req.body.amount);
  if (amount == null || Number.isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Type the bonus amount in rupees.' });
  const row = await prisma.candidateReferral.update({
    where: { id: r.id },
    data: {
      bonusAmount: amount, bonusStatus: 'PROPOSED', bonusNote: txt(req.body.note, 300) || null,
      bonusProposedById: req.user.id, bonusProposedByName: req.user.name, bonusProposedAt: new Date(),
      bonusDecidedById: null, bonusDecidedByName: null, bonusDecidedAt: null,
    },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Referral bonus recorded (waiting for Super Admin)', entity: 'CandidateReferral', entityId: r.id,
    fromValue: r.bonusAmount != null ? String(r.bonusAmount) : null, toValue: `₹${amount} for ${r.referrerName}`,
  });
  const supers = await prisma.user.findMany({ where: { OR: [{ role: 'SUPER_ADMIN' }, { atsRole: 'SUPER_ADMIN' }] }, select: { id: true, name: true, email: true } });
  await notifyUsers(supers.filter((u) => !isTestText(u.name) && !isTestText(u.email)).map((u) => u.id), {
    title: 'Referral bonus to approve', message: `₹${amount} for ${r.referrerName}`, exceptUserId: req.user.id,
  }).catch(() => null);
  return res.json({ ok: true, message: 'Saved. Super Admin will approve it.', bonus: { amount: row.bonusAmount, status: row.bonusStatus } });
});

router.post('/referrals/:id/bonus/decide', async (req, res) => {
  if (!mayApproveBonus(req.user)) return res.status(403).json({ error: 'Only Super Admin can approve a referral bonus.' });
  const decision = String(req.body.decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: 'Choose Approve or Reject.' });
  const r = await prisma.candidateReferral.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'Referral not found' });
  if (r.bonusStatus !== 'PROPOSED') return res.status(409).json({ error: 'There is no bonus waiting for approval on this referral.' });
  if (r.bonusProposedById === req.user.id && decision === 'APPROVED' && req.body.selfApprove !== true) {
    // One person entering and approving the same money is allowed only on purpose.
    return res.status(409).json({ error: 'You recorded this amount yourself. Tick "I checked it" to approve your own entry.', needsConfirm: true });
  }
  await prisma.candidateReferral.update({
    where: { id: r.id },
    data: { bonusStatus: decision, bonusDecidedById: req.user.id, bonusDecidedByName: req.user.name, bonusDecidedAt: new Date(), bonusNote: txt(req.body.note, 300) || r.bonusNote },
  });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: `Referral bonus ${decision === 'APPROVED' ? 'approved' : 'rejected'}`,
    entity: 'CandidateReferral', entityId: r.id, toValue: `₹${r.bonusAmount} for ${r.referrerName}`, reason: txt(req.body.note, 300) || null,
  });
  if (r.referrerUserId) {
    await notifyUsers([r.referrerUserId], {
      title: decision === 'APPROVED' ? 'Referral bonus approved' : 'Referral bonus not approved',
      message: `₹${r.bonusAmount}${decision === 'APPROVED' ? ' — HR / Accounts will pay it.' : ''}`,
    }).catch(() => null);
  }
  return res.json({ ok: true, message: decision === 'APPROVED' ? 'Approved.' : 'Rejected.' });
});

// --- campus drives -----------------------------------------------------------------------------------
async function driveCounts(ids) {
  if (!ids.length) return new Map();
  const apps = await prisma.application.findMany({ where: { campusDriveId: { in: ids } }, select: { campusDriveId: true, stage: true } });
  const cands = await prisma.candidate.groupBy({ by: ['campusDriveId'], where: { campusDriveId: { in: ids } }, _count: { _all: true } });
  const m = new Map(ids.map((id) => [id, { candidates: 0, applications: 0, joined: 0 }]));
  cands.forEach((c) => { m.get(c.campusDriveId).candidates = c._count._all; });
  apps.forEach((a) => {
    const x = m.get(a.campusDriveId);
    x.applications += 1;
    if (['JOINED', 'HIRED'].includes(a.stage)) x.joined += 1;
  });
  return m;
}

router.get('/campus-drives', async (req, res) => {
  if (!isAtsInternal(req.user)) return res.status(403).json({ error: 'Campus drives are for the recruitment team.' });
  const rows = await prisma.campusDrive.findMany({ orderBy: { driveDate: 'desc' }, take: 500 });
  const counts = await driveCounts(rows.map((r) => r.id));
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter(Boolean))];
  const reqs = new Map((await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, title: true } })).map((r) => [r.id, r.title]));
  return res.json({
    drives: rows.map((d) => ({ ...d, requirementTitle: reqs.get(d.requirementId) || null, ...counts.get(d.id), cost: mayManageCosts(req.user) || has(req.user, ['MANAGER', 'ASSISTANT_MANAGER']) ? d.cost : undefined })),
    canManage: mayManageDrives(req.user),
  });
});

function driveData(b) {
  const collegeName = txt(b.collegeName, 160);
  const driveDate = ymd(b.driveDate);
  if (collegeName.length < 2) return { error: 'Type the college name.' };
  if (!driveDate) return { error: 'Pick the drive date.' };
  const cost = money(b.cost);
  if (Number.isNaN(cost)) return { error: 'The cost must be a number of rupees.' };
  return {
    data: {
      collegeName, driveDate, location: txt(b.location, 120) || null, department: txt(b.department, 80) || null,
      requirementId: b.requirementId ? String(b.requirementId) : null, cost, note: txt(b.note, 500) || null,
    },
  };
}

router.post('/campus-drives', async (req, res) => {
  if (!mayManageDrives(req.user)) return res.status(403).json({ error: 'You cannot add campus drives.' });
  const v = driveData(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (!mayManageCosts(req.user)) delete v.data.cost;
  const d = await prisma.campusDrive.create({ data: { ...v.data, createdById: req.user.id, createdByName: req.user.name } });
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Campus drive added', entity: 'CampusDrive', entityId: d.id, toValue: `${d.collegeName} · ${d.driveDate}` });
  return res.status(201).json({ ok: true, message: 'Saved.', drive: d });
});

router.put('/campus-drives/:id', async (req, res) => {
  if (!mayManageDrives(req.user)) return res.status(403).json({ error: 'You cannot change campus drives.' });
  const before = await prisma.campusDrive.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: 'Campus drive not found' });
  const v = driveData({ ...before, ...(req.body || {}) });
  if (v.error) return res.status(400).json({ error: v.error });
  if (!mayManageCosts(req.user)) delete v.data.cost;
  const d = await prisma.campusDrive.update({ where: { id: before.id }, data: v.data });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: 'Campus drive changed', entity: 'CampusDrive', entityId: d.id,
    fromValue: `${before.collegeName} · ${before.driveDate}${before.cost != null ? ` · ₹${before.cost}` : ''}`,
    toValue: `${d.collegeName} · ${d.driveDate}${d.cost != null ? ` · ₹${d.cost}` : ''}`,
  });
  return res.json({ ok: true, message: 'Saved.', drive: d });
});

// --- campaign costs ----------------------------------------------------------------------------------
router.get('/campaigns', async (req, res) => {
  if (!isAtsInternal(req.user)) return res.status(403).json({ error: 'Campaigns are for the recruitment team.' });
  const [rows, seen] = await Promise.all([
    prisma.sourcingCampaign.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.application.groupBy({ by: ['utmCampaign'], where: { utmCampaign: { not: null } }, _count: { _all: true } }),
  ]);
  const showCost = mayManageCosts(req.user) || has(req.user, ['MANAGER', 'ASSISTANT_MANAGER']);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const merged = new Map();
  seen.forEach((s) => {
    const key = String(s.utmCampaign).toLowerCase();
    const m = merged.get(key) || { key, name: s.utmCampaign, applications: 0 };
    m.applications += s._count._all;
    merged.set(key, m);
  });
  rows.forEach((r) => { if (!merged.has(r.key)) merged.set(r.key, { key: r.key, name: r.name, applications: 0 }); });
  return res.json({
    campaigns: [...merged.values()].map((m) => {
      const c = byKey.get(m.key);
      return {
        ...m, id: c ? c.id : null, name: c ? c.name : m.name, source: c ? c.source : null, medium: c ? c.medium : null,
        cost: showCost && c ? c.cost : undefined, startDate: c ? c.startDate : null, endDate: c ? c.endDate : null, note: c ? c.note : null,
      };
    }).sort((a, b) => b.applications - a.applications || a.name.localeCompare(b.name)),
    canManage: mayManageCosts(req.user),
  });
});

router.post('/campaigns', async (req, res) => {
  if (!mayManageCosts(req.user)) return res.status(403).json({ error: 'Only Super Admin, Admin or HR can enter campaign costs.' });
  const b = req.body || {};
  const name = rec.cleanUtm({ utm_campaign: b.name }).utmCampaign;
  if (!name) return res.status(400).json({ error: 'Type the campaign name exactly as in the link (utm_campaign).' });
  const cost = money(b.cost);
  if (Number.isNaN(cost)) return res.status(400).json({ error: 'The cost must be a number of rupees.' });
  const key = name.toLowerCase();
  const data = {
    name, cost, source: txt(b.source, 80) || null, medium: txt(b.medium, 80) || null,
    startDate: ymd(b.startDate), endDate: ymd(b.endDate), note: txt(b.note, 500) || null,
  };
  const before = await prisma.sourcingCampaign.findUnique({ where: { key } });
  const row = before
    ? await prisma.sourcingCampaign.update({ where: { key }, data })
    : await prisma.sourcingCampaign.create({ data: { ...data, key, createdById: req.user.id, createdByName: req.user.name } });
  await logAudit({
    userId: req.user.id, actorName: req.user.name, action: before ? 'Campaign cost changed' : 'Campaign cost added', entity: 'SourcingCampaign', entityId: row.id,
    fromValue: before && before.cost != null ? `₹${before.cost}` : null, toValue: `${name}${cost != null ? ` · ₹${cost}` : ''}`,
  });
  return res.json({ ok: true, message: 'Saved.', campaign: row });
});

// --- pickers -----------------------------------------------------------------------------------------
router.get('/employees', async (req, res) => {
  if (!isAtsInternal(req.user)) return res.status(403).json({ error: 'Not available to this login.' });
  const q = txt(req.query.q, 60);
  const rows = await prisma.employee.findMany({
    where: q ? { OR: [{ name: { contains: q } }, { employeeCode: { contains: q } }] } : {},
    select: { id: true, name: true, employeeCode: true, department: true },
    orderBy: { name: 'asc' },
    take: 20,
  });
  return res.json({ employees: rows.filter((e) => !isTestText(e.name)) });
});

module.exports = router;
