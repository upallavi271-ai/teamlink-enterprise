// ---------------------------------------------------------------------------
// THE CANDIDATE RECORD + SOURCING ATTRIBUTION (b5_ / b6_, ATS-100 B5 + B6)
//
// CONSENT (Candidate.consent*)
//   consentStatus  GIVEN | NOT_GIVEN | WITHDRAWN, or NULL = "Not recorded".
//                  The 16.9k imported people are NULL and stay NULL: a consent
//                  is only ever written by something that actually asked
//                  (the job portal form, the careers form, a recruiter who
//                  recorded the person's spoken yes / no with a note).
//   purposes       Recruitment · Messages · Share with clients
//   source         portal | careers | recruiter | import | referral
//   proof          what proves it: the form version + IP, or the recruiter's note
//   WITHDRAWN      also sets doNotContact = true: bulk messages skip the
//                  person, one-to-one contact is refused, and exports blank
//                  their phone / email.
//
// ATTRIBUTION (Application.utm* / referralId / referredBy* / campusDriveId)
//   cleanUtm()            utm_source / medium / campaign / content from a link
//   attach()              writes them on the application (+ the referral row
//                         for a ?ref=<code> link), never overwriting a value
//                         already there
//   referral codes        one per login (ReferralCode): r + 6 letters/digits,
//                         lower-case, so the job portal's own ?ref= capture
//                         (which lower-cases what it records as the source)
//                         still matches it.
//
// Every write is audited. Until migration 20261006100000 is applied the
// helpers answer "not available" instead of failing (supported()).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const { hasField } = require('./resumeMatch');
const { stageIndex } = require('./pipelineView');

const supported = () => hasField('Candidate', 'consentStatus') && hasField('Application', 'utmCampaign');
const NOT_READY = 'This needs a database update that has not been applied yet. Ask the admin to run the latest migration.';

// --- consent ------------------------------------------------------------------
const CONSENT_STATUSES = ['GIVEN', 'NOT_GIVEN', 'WITHDRAWN'];
const CONSENT_LABEL = { GIVEN: 'Given', NOT_GIVEN: 'Not given', WITHDRAWN: 'Withdrawn' };
const PURPOSES = ['Recruitment', 'Messages', 'Share with clients'];
const CONSENT_SOURCES = {
  portal: 'Job portal application',
  careers: 'Careers form',
  recruiter: 'Recorded by recruiter',
  import: 'Import',
  referral: 'Referral form',
  partner: 'Partner confirmed (agency / freelancer portal)', // B7
};
// The text the public careers form shows next to its tick box. Bump the
// version whenever that sentence changes, so a consent can be traced to it.
const CAREERS_FORM_VERSION = 'careers-form-2026-10';

const csv = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);
const cleanPurposes = (v) => PURPOSES.filter((p) => csv(v).some((x) => x.toLowerCase() === p.toLowerCase()));

function consentView(c, { internal = true } = {}) {
  if (!c || !supported()) return null;
  const status = CONSENT_STATUSES.includes(c.consentStatus) ? c.consentStatus : null;
  return {
    status,
    label: status ? CONSENT_LABEL[status] : 'Not recorded',
    purposes: csv(c.consentPurposes),
    at: c.consentAt || null,
    source: c.consentSource || null,
    sourceLabel: c.consentSource ? (CONSENT_SOURCES[c.consentSource] || c.consentSource) : null,
    withdrawnAt: c.consentWithdrawnAt || null,
    byName: internal ? (c.consentByName || null) : null,
    proof: internal ? (c.consentProof || null) : null,
    doNotContact: !!c.doNotContact,
  };
}

const isDoNotContact = (c) => !!(c && (c.doNotContact || c.consentStatus === 'WITHDRAWN'));
const DNC_REASON = 'Asked not to be contacted (consent withdrawn)';

// Writes one consent decision on the candidate + an audit row. Returns the
// updated candidate. `status` must be one of CONSENT_STATUSES.
async function setConsent(candidateId, {
  status, purposes, source, proof = null, byName = null, userId = null, at = new Date(),
}) {
  if (!supported()) throw Object.assign(new Error(NOT_READY), { status: 503 });
  if (!CONSENT_STATUSES.includes(status)) throw Object.assign(new Error('Pick Given, Not given or Withdrawn.'), { status: 400 });
  const before = await prisma.candidate.findUnique({
    where: { id: candidateId }, select: { consentStatus: true, consentPurposes: true },
  });
  if (!before) throw Object.assign(new Error('Candidate not found'), { status: 404 });
  const data = {
    consentStatus: status,
    consentSource: source || null,
    consentProof: proof ? String(proof).slice(0, 500) : null,
    consentByName: byName ? String(byName).slice(0, 120) : null,
  };
  if (status === 'WITHDRAWN') {
    data.consentWithdrawnAt = at;
    data.doNotContact = true;
    // What they had agreed to stays readable; the date of the yes is kept too.
  } else {
    data.consentAt = at;
    data.consentPurposes = (status === 'GIVEN' ? cleanPurposes(purposes) : []).join(', ') || null;
    data.consentWithdrawnAt = null;
    data.doNotContact = false;
  }
  if (status === 'GIVEN' && !data.consentPurposes) data.consentPurposes = 'Recruitment';
  const cand = await prisma.candidate.update({ where: { id: candidateId }, data });
  try { require('./candidateListCache').markCandidateDirty(candidateId); } catch { /* optional */ } // eslint-disable-line global-require
  await logAudit({
    userId,
    actorName: byName,
    action: `Consent ${CONSENT_LABEL[status].toLowerCase()} (${CONSENT_SOURCES[source] || source || 'recorded'})`,
    entity: 'Candidate',
    entityId: candidateId,
    fromValue: before.consentStatus ? `${CONSENT_LABEL[before.consentStatus]}${before.consentPurposes ? ` · ${before.consentPurposes}` : ''}` : 'Not recorded',
    toValue: `${CONSENT_LABEL[status]}${data.consentPurposes ? ` · ${data.consentPurposes}` : ''}`,
    reason: data.consentProof,
  });
  return cand;
}

// The job portal's own consent answers (candidate_consent_current: kind
// terms | communication | resume_processing, status granted | withdrawn),
// as the push carries them — or nothing when the portal sent none.
function consentFromPortal(list) {
  const rows = Array.isArray(list) ? list.filter((x) => x && x.kind && x.status) : [];
  if (!rows.length) return null;
  const st = (k) => (rows.find((x) => x.kind === k) || {}).status || null;
  const version = (rows.find((x) => x.version) || {}).version || 'unknown';
  if (st('communication') === 'withdrawn' || st('resume_processing') === 'withdrawn') {
    return { status: 'WITHDRAWN', purposes: [], proof: `Job portal consent v${version} — withdrawn on the portal` };
  }
  const purposes = [];
  if (st('resume_processing') === 'granted' || st('terms') === 'granted') purposes.push('Recruitment');
  if (st('communication') === 'granted') purposes.push('Messages');
  if (!purposes.length) return null;
  return { status: 'GIVEN', purposes, proof: `Job portal consent v${version} (${rows.map((x) => `${x.kind}: ${x.status}`).join(', ')})` };
}

// --- UTM ------------------------------------------------------------------------
const UTM_KEYS = [['utm_source', 'utmSource'], ['utm_medium', 'utmMedium'], ['utm_campaign', 'utmCampaign'], ['utm_content', 'utmContent']];
const cleanTag = (v) => {
  const s = String(v == null ? '' : v).replace(/[^\p{L}\p{N} ._+\-/:&]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return s || null;
};
// Accepts { utm_source, … } or { utmSource, … } (a body, a query, the portal push).
function cleanUtm(obj) {
  const o = obj || {};
  const out = {};
  UTM_KEYS.forEach(([snake, camel]) => {
    const v = cleanTag(o[snake] != null ? o[snake] : o[camel]);
    if (v) out[camel] = v;
  });
  return out;
}

// --- referral codes -----------------------------------------------------------------
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
// The job portal reads a board name out of ?ref= when it contains one
// (naukri, shine …); a code must never look like one.
const BOARD_WORDS = ['naukri', 'linkedin', 'indeed', 'shine', 'monster', 'glassdoor', 'instahyre', 'referral', 'recruiter', 'teamlink', 'portal', 'direct'];
const CODE_RE = /^r[2-9a-hjkmnp-z]{6}$/;
function newCode() {
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const code = `r${[...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`;
    if (!BOARD_WORDS.some((w) => code.includes(w))) return code;
  }
}
const normCode = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return CODE_RE.test(s) ? s : null;
};

async function codeFor(user) {
  if (!supported() || !user) return null;
  const hit = await prisma.referralCode.findUnique({ where: { userId: user.id } });
  if (hit) return hit;
  for (let i = 0; i < 5; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await prisma.referralCode.create({
        data: { code: newCode(), userId: user.id, employeeId: user.employeeId || null, name: user.name || 'Employee' },
      });
    } catch (err) {
      if (!/Unique/i.test(String(err.message))) throw err;
      // eslint-disable-next-line no-await-in-loop
      const again = await prisma.referralCode.findUnique({ where: { userId: user.id } });
      if (again) return again;
    }
  }
  throw new Error('Could not make a referral code. Please try again.');
}

async function codeLookup(raw) {
  const code = normCode(raw);
  if (!code || !supported()) return null;
  return prisma.referralCode.findUnique({ where: { code } });
}

// --- referral status (for the person who referred) --------------------------------------
const INTERVIEW_AT = stageIndex('INTERVIEW_SCHEDULED');
function referralStatus(app) {
  if (!app) return { key: 'submitted', label: 'Submitted', tone: 'blue' };
  if (['JOINED', 'HIRED'].includes(app.stage)) return { key: 'joined', label: 'Joined', tone: 'green' };
  if (app.stage === 'REJECTED') return { key: 'closed', label: 'Not selected', tone: 'grey' };
  if (app.interviewAt || app.interviewStatus || stageIndex(app.stage) >= INTERVIEW_AT) return { key: 'interview', label: 'Interview', tone: 'blue' };
  return { key: 'submitted', label: 'Submitted', tone: 'blue' };
}

// --- attach attribution to an application ----------------------------------------
// { utm, refCode | referral, campusDriveId, referredBy: { employeeId, name } }
// Only EMPTY fields are filled: the first link that brought someone wins.
async function attach({
  application, candidate, utm = null, refCode = null, campusDriveId = null, referredBy = null, via = 'LINK', actor = null,
}) {
  if (!supported() || !application) return { referral: null };
  const appNow = await prisma.application.findUnique({ where: { id: application.id } });
  if (!appNow) return { referral: null };
  const data = {};
  const u = cleanUtm(utm);
  Object.entries(u).forEach(([k, v]) => { if (!appNow[k]) data[k] = v; });
  if (campusDriveId && !appNow.campusDriveId) data.campusDriveId = campusDriveId;

  let referral = null;
  const code = refCode ? await codeLookup(refCode) : null;
  if (code && !appNow.referralId) {
    referral = await prisma.candidateReferral.create({
      data: {
        referrerUserId: code.userId,
        referrerEmployeeId: code.employeeId,
        referrerName: code.name,
        via,
        code: code.code,
        candidateId: candidate.id,
        applicationId: appNow.id,
        requirementId: appNow.requirementId,
        createdById: actor ? actor.id : null,
        createdByName: actor ? actor.name : 'Referral link',
      },
    });
    data.referralId = referral.id;
    data.referredByEmployeeId = code.employeeId;
    data.referredByName = code.name;
  } else if (referredBy && referredBy.name && !appNow.referredByName) {
    data.referredByEmployeeId = referredBy.employeeId || null;
    data.referredByName = String(referredBy.name).slice(0, 120);
  }
  if (Object.keys(data).length) await prisma.application.update({ where: { id: appNow.id }, data });
  // The candidate's own "Referred by" is the first one ever recorded.
  const who = data.referredByName ? { referredByEmployeeId: data.referredByEmployeeId || null, referredByName: data.referredByName } : null;
  const candData = {};
  if (who && candidate && !candidate.referredByName) Object.assign(candData, who);
  if (data.campusDriveId && candidate && !candidate.campusDriveId) candData.campusDriveId = data.campusDriveId;
  if (Object.keys(candData).length) await prisma.candidate.update({ where: { id: candidate.id }, data: candData });
  if (Object.keys(data).length) {
    await logAudit({
      userId: actor ? actor.id : null,
      actorName: actor ? actor.name : null,
      action: 'Source details recorded',
      entity: 'Application',
      entityId: appNow.id,
      toValue: [
        u.utmCampaign && `campaign ${u.utmCampaign}`, u.utmSource && `utm_source ${u.utmSource}`,
        u.utmMedium && `medium ${u.utmMedium}`, u.utmContent && `content ${u.utmContent}`,
        data.referredByName && `referred by ${data.referredByName}`, data.campusDriveId && 'campus drive',
      ].filter(Boolean).join(' · ').slice(0, 500),
    });
  }
  return { referral };
}

// A recruiter typed "Referred by: <employee>" on the Add Candidate form: the
// employee gets the same referral row (and status) as if they had used the form.
async function recordStaffReferral({
  candidate, application = null, employeeId, actor = null,
}) {
  if (!supported() || !employeeId || !candidate) return null;
  const emp = await prisma.employee.findUnique({ where: { id: String(employeeId) }, select: { id: true, name: true, userId: true } });
  if (!emp) return null;
  const referral = await prisma.candidateReferral.create({
    data: {
      referrerUserId: emp.userId || null,
      referrerEmployeeId: emp.id,
      referrerName: emp.name,
      via: 'RECRUITER',
      candidateId: candidate.id,
      applicationId: application ? application.id : null,
      requirementId: application ? application.requirementId : null,
      createdById: actor ? actor.id : null,
      createdByName: actor ? actor.name : null,
    },
  });
  if (application) {
    await prisma.application.update({
      where: { id: application.id },
      data: { referralId: referral.id, referredByEmployeeId: emp.id, referredByName: emp.name },
    });
  }
  return referral;
}

// --- certifications read from a resume ---------------------------------------------------
const CERT_HEAD = /^\s*(certifications?|certificates?|licen[cs]es?\s*(?:&|and)\s*certifications?|courses?\s*(?:&|and)\s*certifications?|professional\s+certifications?|trainings?\s*(?:&|and)\s*certifications?)\s*[:\-–]?\s*$/i;
const OTHER_HEAD = /^\s*(experience|work experience|employment|education|academic|skills|technical skills|projects?|summary|profile|objective|achievements?|awards?|languages?|hobbies|interests|personal (details|information)|declaration|references?|strengths?)\b.*$/i;
function certificationsFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.replace(/^[\s•●▪◦*·\-–]+/, '').trim());
  const out = [];
  let on = false;
  for (const line of lines) {
    if (CERT_HEAD.test(line)) { on = true; continue; } // eslint-disable-line no-continue
    if (!on) continue; // eslint-disable-line no-continue
    if (!line) continue; // eslint-disable-line no-continue
    if (OTHER_HEAD.test(line) && line.length < 40) { on = false; continue; } // eslint-disable-line no-continue
    if (line.length < 4 || line.length > 160) continue; // eslint-disable-line no-continue
    const year = (line.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
    const parts = line.replace(/\(?\b(19|20)\d{2}\b\)?/g, '').split(/\s+[-–|]\s+|,\s+(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
    out.push({ name: (parts[0] || line).slice(0, 160), issuer: parts[1] ? parts[1].slice(0, 120) : null, year });
    if (out.length >= 15) break;
  }
  return out;
}

module.exports = {
  supported, NOT_READY,
  CONSENT_STATUSES, CONSENT_LABEL, PURPOSES, CONSENT_SOURCES, CAREERS_FORM_VERSION,
  consentView, setConsent, consentFromPortal, isDoNotContact, DNC_REASON, cleanPurposes,
  cleanUtm, UTM_KEYS, newCode, normCode, codeFor, codeLookup, referralStatus, attach, recordStaffReferral,
  certificationsFromText,
};
