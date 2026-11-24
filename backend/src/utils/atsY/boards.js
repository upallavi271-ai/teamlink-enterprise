// ---------------------------------------------------------------------------
// JOB BOARDS (ATS wave 2 Y): foundit posting (10.09), LinkedIn Recruiter System Connect + Apply Connect (10.10).
//
// FOUNDIT (formerly Monster India). No public API: the same partner contract as Naukri / Shine (utils/jobBoards/partner.js make()):
//   POST <Job endpoint URL> { action: "upsert" | "close", reference: <job id>, ... }   Bearer <API key>, X-TeamLink-Signature (secret)
//   posted / edited / taken down from the requirement's "Job boards" card (Clients & Requirements); its state in AtsYBoardPost.
//   Applications come back on the foundit webhook / pull (utils/mkt/portal.js, board "foundit") with Source "foundit".
//
// LINKEDIN RSC. Only LinkedIn-approved ATS partners get Recruiter System Connect. With the partner app's Client ID / secret
// (client-credentials token, the same handshake as utils/jobBoards/linkedin.js) TeamLink sends, inside the ATS integration context:
//   POST <base>/rest/atsJobPostings   { elements: [{ integrationContext, externalJobPostingId, title, location, description, jobPostingUrl, state }] }
//   POST <base>/rest/atsCandidates    { elements: [{ integrationContext, externalCandidateId, firstName, lastName, emailAddresses[], phoneNumbers[],
//                                                   currentCompany, currentTitle, applications: [{ externalJobPostingId, stage, updatedAt }] }] }
//   headers  Authorization: Bearer <token>, LinkedIn-Version, X-Restli-Method: batch_upsert
//   so a recruiter sees TeamLink's candidates and steps inside LinkedIn Recruiter. OFF until an Admin turns on "rscSync" (it sends
//   candidate data to LinkedIn). APPLY CONNECT: LinkedIn "Easy Apply" applications arrive on the signed LinkedIn board webhook
//   (/api/public/mkt/boards/linkedin/applications); fromApplyConnect() reads LinkedIn's own shape as well as the plain one.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');
const { FOUNDIT_FIELDS } = require('./catalog');

const { q, x, nowIso, txt } = C;

// ================================================================== foundit
const foundit = require('../jobBoards/partner').make({
  id: 'foundit',
  label: 'foundit',
  fields: FOUNDIT_FIELDS,
  need: ['API key', 'Job endpoint URL'],
  setup: 'foundit (formerly Monster India) has no public posting API. Ask your foundit employer account manager for an ATS / job-posting API account, then add the API key and job endpoint URL in Administration → Integrations → foundit.',
  reviewNote: 'Waiting for foundit to confirm it is live.',
});
async function postRow(board, rid) { await C.ensure(); return (await q('SELECT * FROM "AtsYBoardPost" WHERE "board" = ? AND "requirementId" = ?', board, rid))[0] || null; }
async function savePost(board, rid, o, user) {
  await x(`INSERT INTO "AtsYBoardPost" ("board","requirementId","status","externalId","externalUrl","message","byName","at") VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT("board","requirementId") DO UPDATE SET "status"=excluded."status","externalId"=COALESCE(excluded."externalId","AtsYBoardPost"."externalId"),"externalUrl"=COALESCE(excluded."externalUrl","AtsYBoardPost"."externalUrl"),"message"=excluded."message","byName"=excluded."byName","at"=excluded."at"`,
  board, rid, o.status, o.externalJobId || null, o.externalUrl || null, o.errorMessage ? txt(o.errorMessage, 500) : null, C.who(user), nowIso());
  return postRow(board, rid);
}
const shapePost = (r) => (r ? { status: r.status, externalId: r.externalId, externalUrl: r.externalUrl, message: r.message, by: r.byName, at: r.at } : null);
async function founditState(rid) {
  const cfg = await foundit.config();
  return { ready: !!cfg.ready, hint: cfg.ready ? null : cfg.hint, post: shapePost(await postRow('foundit', rid)) };
}
async function founditPublish(r, user) {
  const { requirementIsLive } = require('../atsVocab'); // eslint-disable-line global-require
  if (!requirementIsLive(r.status)) return { status: 409, error: 'Only a live requirement goes on a job board.' };
  if (r.internal) return { status: 409, error: 'An internal (own company) requirement stays on our own sites.' };
  const cfg = await foundit.config();
  if (!cfg.ready) return C.NEEDS('foundit', cfg.hint);
  const cur = await postRow('foundit', r.id);
  const out = await foundit.publish(r, cur ? { externalJobId: cur.externalId } : null, cfg);
  const row = await savePost('foundit', r.id, out, user);
  await C.logAudit({ userId: user.id, action: cur ? 'foundit: job updated' : 'foundit: job posted', entity: 'RequirementPosting', entityId: r.id, toValue: `${out.status}${out.errorMessage ? ` - ${out.errorMessage}` : ''}`.slice(0, 300) });
  return out.status === 'Failed' ? { status: 502, error: out.errorMessage, post: shapePost(row) } : { ok: true, post: shapePost(row) };
}
async function founditRemove(r, user) {
  const cur = await postRow('foundit', r.id);
  if (!cur || cur.status === 'Removed') return { ok: true, post: shapePost(cur) };
  const cfg = await foundit.config();
  if (!cfg.ready) return C.NEEDS('foundit', cfg.hint);
  const out = await foundit.remove(r, { externalJobId: cur.externalId }, cfg);
  const row = await savePost('foundit', r.id, out, user);
  await C.logAudit({ userId: user.id, action: 'foundit: job taken down', entity: 'RequirementPosting', entityId: r.id, toValue: out.status });
  return out.status === 'Removed' ? { ok: true, post: shapePost(row) } : { status: 502, error: out.errorMessage, post: shapePost(row) };
}

// ================================================================== LinkedIn RSC
const RSC = 'LinkedIn RSC';
const DEFAULT_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
async function rscConfig() {
  const s = await C.provider('linkedin-rsc', ['Client ID', 'Client secret', 'ATS integration context (URN)'], RSC);
  if (!s.ready && s.missing && s.missing.length >= 3) s.hint = 'LinkedIn Recruiter System Connect is only for LinkedIn-approved ATS partners. Apply through LinkedIn Talent Solutions (ATS partner programme); when approved, add the Client ID, Client secret and the ATS integration context in Administration → Integrations → LinkedIn RSC.';
  return s;
}
async function rscToken(cfg) {
  const http = require('../jobBoards/http'); // eslint-disable-line global-require
  const v = cfg.values;
  const key = `linkedin-rsc|${v['Client ID']}`;
  const have = http.cachedToken(key);
  if (have) return { ok: true, token: have };
  const url = String(v['Login address (LinkedIn)'] || '').trim() || DEFAULT_TOKEN_URL;
  const r = await C.out(RSC, url, { method: 'POST', form: { grant_type: 'client_credentials', client_id: v['Client ID'], client_secret: v['Client secret'] }, secrets: [v['Client secret']] });
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.body || !r.body.access_token) return { ok: false, error: 'LinkedIn did not return an access token.' };
  http.rememberToken(key, r.body.access_token, r.body.expires_in);
  return { ok: true, token: r.body.access_token };
}
async function rscSend(cfg, path, elements) {
  const t = await rscToken(cfg);
  if (!t.ok) return { ok: false, error: t.error };
  const base = String(cfg.values['API base URL'] || '').trim() || 'https://api.linkedin.com';
  return C.out(RSC, C.joinUrl(base, path), { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'linkedin-version': '202601', 'x-restli-method': 'batch_upsert', 'x-restli-protocol-version': '2.0.0' }, json: { elements }, secrets: [t.token, cfg.values['Client secret']] });
}
async function syncMark(kind, refId, status, message) {
  await C.ensure();
  await x('INSERT INTO "AtsYRscSync" ("kind","refId","status","message","at") VALUES (?,?,?,?,?) ON CONFLICT("kind","refId") DO UPDATE SET "status"=excluded."status","message"=excluded."message","at"=excluded."at"', kind, refId, status, message ? txt(message, 300) : null, nowIso());
}
async function rscStatus() {
  const cfg = await rscConfig();
  await C.ensure();
  const by = await q('SELECT "kind","status",COUNT(*) AS n, MAX("at") AS last FROM "AtsYRscSync" GROUP BY "kind","status"');
  return { ready: !!cfg.ready, hint: cfg.ready ? null : cfg.hint, switchOn: await C.switchOn('rscSync'), synced: by.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.n), last: r.last })), applyConnect: { webhook: '/api/public/mkt/boards/linkedin/applications', note: 'Apply Connect applications come in on the signed LinkedIn board webhook (Job Portal settings > Board applications).' } };
}
async function rscCheck() {
  const cfg = await rscConfig();
  if (!cfg.ready) return C.NEEDS(RSC, cfg.hint);
  const t = await rscToken(cfg);
  return t.ok ? { ok: true, message: 'LinkedIn accepted the sign-in. Nothing was sent.' } : { status: 502, error: t.error };
}
const STEP = (s) => require('../atsVocab').STAGE_LABELS[s] || s; // eslint-disable-line global-require
async function jobElement(cfg, r) {
  const { jobText } = require('../jobBoards/common'); // eslint-disable-line global-require
  const http = require('../jobBoards/http'); // eslint-disable-line global-require
  const { requirementIsLive } = require('../atsVocab'); // eslint-disable-line global-require
  return { integrationContext: cfg.values['ATS integration context (URN)'], externalJobPostingId: r.id, title: r.title, location: r.location || 'India', description: (jobText(r) || r.title).slice(0, 20000), jobPostingUrl: http.publicUrl(require('../jobSlug').careersPath(r, 'LinkedIn')), state: requirementIsLive(r.status) ? 'OPEN' : 'CLOSED' }; // eslint-disable-line global-require
}
async function rscSyncJob(r, user) {
  if (!(await C.switchOn('rscSync'))) return C.SWITCH_OFF('rscSync');
  const cfg = await rscConfig();
  if (!cfg.ready) return C.NEEDS(RSC, cfg.hint);
  if (r.internal) return { status: 409, error: 'An internal (own company) requirement is not sent to LinkedIn.' };
  const res = await rscSend(cfg, '/rest/atsJobPostings', [await jobElement(cfg, r)]);
  await syncMark('job', r.id, res.ok ? 'Synced' : 'Failed', res.ok ? null : res.error);
  await C.logAudit({ userId: user && user.id, action: `LinkedIn RSC: job ${res.ok ? 'synced' : 'not synced'}`, entity: 'Requirement', entityId: r.id, toValue: res.ok ? null : res.error });
  return res.ok ? { ok: true } : { status: 502, error: res.error };
}
async function rscSyncCandidate(candidateId, user) {
  if (!(await C.switchOn('rscSync'))) return C.SWITCH_OFF('rscSync');
  const cfg = await rscConfig();
  if (!cfg.ready) return C.NEEDS(RSC, cfg.hint);
  const c = await prisma.candidate.findUnique({ where: { id: candidateId }, include: { applications: { select: { requirementId: true, stage: true, updatedAt: true, requirement: { select: { internal: true } } } } } });
  if (!c) return { status: 404, error: 'Candidate not found.' };
  if (c.doNotContact) return { status: 409, error: 'This person asked not to be contacted: they are not sent to LinkedIn.' };
  const parts = String(c.name || '').trim().split(/\s+/);
  const el = {
    integrationContext: cfg.values['ATS integration context (URN)'], externalCandidateId: c.id, firstName: parts[0] || c.name, lastName: parts.slice(1).join(' ') || '',
    emailAddresses: c.email ? [c.email] : [], phoneNumbers: c.phone ? [c.phone] : [], currentCompany: c.currentCompany || null, currentTitle: c.currentDesignation || null,
    applications: c.applications.filter((a) => !(a.requirement && a.requirement.internal)).map((a) => ({ externalJobPostingId: a.requirementId, stage: STEP(a.stage), updatedAt: a.updatedAt })),
  };
  const res = await rscSend(cfg, '/rest/atsCandidates', [el]);
  await syncMark('candidate', c.id, res.ok ? 'Synced' : 'Failed', res.ok ? null : res.error);
  await C.logAudit({ userId: user && user.id, action: `LinkedIn RSC: candidate ${res.ok ? 'synced' : 'not synced'}`, entity: 'Candidate', entityId: c.id, toValue: res.ok ? `${el.applications.length} application(s)` : res.error });
  return res.ok ? { ok: true, applications: el.applications.length } : { status: 502, error: res.error };
}
// LinkedIn Apply Connect's application shape -> the plain shape utils/mkt/portal.js ingestBoardApp reads (other shapes pass through)
function fromApplyConnect(a) {
  if (!a || typeof a !== 'object' || !(a.applicant || a.jobApplicant || a.externalJobPostingId)) return a;
  const p = a.applicant || a.jobApplicant || {};
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '';
  const pick = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    id: a.applicationId || a.id || a.jobApplicationId, jobReference: a.externalJobPostingId || a.jobReference || a.jobId,
    candidate: { name, email: pick(p.emailAddress || p.emailAddresses || p.email), phone: pick(p.phoneNumber || p.phoneNumbers || p.phone), linkedinUrl: p.profileUrl || p.publicProfileUrl || null, title: p.headline || p.title || null, currentCompany: p.currentCompany || null },
  };
}

module.exports = { foundit, founditState, founditPublish, founditRemove, rscConfig, rscStatus, rscCheck, rscSyncJob, rscSyncCandidate, fromApplyConnect };
