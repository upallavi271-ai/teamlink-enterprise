// ---------------------------------------------------------------------------
// VMS CONNECTOR (02.15 VMS job import · 06.14 VMS submission sync · 14.14 VMS connectors).
// A client that buys contract staff through a Vendor Management System (SAP Fieldglass, Beeline, Workday VNDLY ...) posts its jobs
// there and takes the candidates there. This connector:
//   1. reads the open jobs of our supplier account  -> "VMS jobs" (Contract staff > VMS); a person files one as a requirement request
//      (utils/requirementRequest.js, via "VMS": the normal BDE -> BDE TL -> TL flow), or, with the Admin switch, it happens by itself
//   2. sends a TeamLink candidate to the VMS job (name, role, experience, skills, bill rate, start date; phone / e-mail only when
//      the sender ticks it) and keeps the VMS's submission id
//   3. reads each submission's status back (Submitted / Shortlisted / Interview / Offered / Rejected / Withdrawn ...)
// One adapter per system: the sign-in, the paths and the field names differ; the rest is shared. The settings (base URL, keys,
// supplier id, optional path overrides) are in Administration > Integrations > VMS (utils/integrationStore.js; secrets encrypted).
// The exact paths of a customer's tenant come with its onboarding pack, so each one can be overridden there.
// NEEDS FOUNDER CREDENTIALS: a supplier API account on the client's VMS. Tested end to end against the built-in stub.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const S = require('./store');
const H = require('./http');

const CHANNEL = 'vms';
const F = {
  system: 'VMS system (beeline, fieldglass, vndly or generic)', base: 'API base URL', clientId: 'Client ID', secret: 'Client secret', token: 'API key / token',
  supplier: 'Supplier ID', jobs: 'Jobs path (optional)', submit: 'Submit path (optional)', status: 'Status path (optional)',
};
const first = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; };
const listOf = (j, keys) => { if (Array.isArray(j)) return j; for (const k of keys) { const v = j && j[k]; if (Array.isArray(v)) return v; } return []; };
const numOr = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const day = (v) => (v ? String(v).slice(0, 10) : null);

// VMS status words -> one plain set
function plain(s) {
  const t = String(s || '').toLowerCase();
  if (/withdr/.test(t)) return 'Withdrawn';
  if (/reject|declin|not selected|closed - not/.test(t)) return 'Rejected';
  if (/hired|onboard|start|engag|work order|assign/.test(t)) return 'Hired';
  if (/offer/.test(t)) return 'Offered';
  if (/interview/.test(t)) return 'Interview';
  if (/short|review|forward|consider/.test(t)) return 'Shortlisted';
  if (/submit|receiv|new|pending|applied/.test(t)) return 'Submitted';
  return s ? String(s).slice(0, 40) : 'Unknown';
}

const ADAPTERS = {
  beeline: {
    name: 'Beeline', auth: 'oauth', tokenPath: '/oauth/token',
    jobs: '/api/v1/suppliers/{supplier}/requisitions?status=open', submit: '/api/v1/requisitions/{job}/submittals', status: '/api/v1/submittals/{sub}',
    jobList: (j) => listOf(j, ['requisitions', 'items', 'data']),
    job: (r) => ({ externalId: first(r, ['requisitionId', 'id']), title: first(r, ['jobTitle', 'title']), clientName: first(r, ['buyerName', 'client.name', 'clientName']), location: first(r, ['workLocation.city', 'location']), openings: numOr(first(r, ['positions', 'openings'])), maxBillRate: numOr(first(r, ['maxBillRate', 'billRate.max'])), startOn: day(first(r, ['startDate'])), endOn: day(first(r, ['endDate'])), description: first(r, ['description', 'jobDescription']), skills: first(r, ['skills']), vmsStatus: first(r, ['status']) }),
    body: (c) => ({ candidate: { firstName: c.firstName, lastName: c.lastName, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) }, currentTitle: c.designation, yearsOfExperience: c.experience, skills: c.skills, proposedBillRate: c.billRate, availableFrom: c.availableFrom, supplierReference: c.reference }),
    subId: (j) => first(j, ['submittalId', 'id', 'submittal.id']), subStatus: (j) => first(j, ['submittalStatus', 'status']),
  },
  fieldglass: {
    name: 'SAP Fieldglass', auth: 'oauth+appkey', tokenPath: '/api/oauth2/v2.0/token',
    jobs: '/api/v1/job_postings?supplier_code={supplier}&status=Open', submit: '/api/v1/job_postings/{job}/job_seekers', status: '/api/v1/job_seekers/{sub}',
    jobList: (j) => listOf(j, ['job_postings', 'Data', 'data']),
    job: (r) => ({ externalId: first(r, ['job_posting_id', 'Job_Posting_ID', 'id']), title: first(r, ['job_posting_title', 'title']), clientName: first(r, ['buyer', 'buyer_name', 'company']), location: first(r, ['site', 'location']), openings: numOr(first(r, ['positions', 'number_of_positions'])), maxBillRate: numOr(first(r, ['bill_rate_max', 'max_bill_rate'])), startOn: day(first(r, ['start_date'])), endOn: day(first(r, ['end_date'])), description: first(r, ['description']), skills: first(r, ['skills']), vmsStatus: first(r, ['status']) }),
    body: (c) => ({ worker: { first_name: c.firstName, last_name: c.lastName, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) }, job_title: c.designation, years_experience: c.experience, skills: c.skills, bill_rate: c.billRate, available_date: c.availableFrom, supplier_reference: c.reference }),
    subId: (j) => first(j, ['job_seeker_id', 'Job_Seeker_ID', 'id']), subStatus: (j) => first(j, ['status', 'job_seeker_status']),
  },
  vndly: {
    name: 'Workday VNDLY', auth: 'token',
    jobs: '/api/v1/jobs/?status=open', submit: '/api/v1/job_applications/', status: '/api/v1/job_applications/{sub}/',
    jobList: (j) => listOf(j, ['results', 'jobs']),
    job: (r) => ({ externalId: first(r, ['id', 'job_id']), title: first(r, ['title', 'job_title']), clientName: first(r, ['client.name', 'company_name']), location: first(r, ['location.city', 'location']), openings: numOr(first(r, ['openings', 'positions'])), maxBillRate: numOr(first(r, ['bill_rate.max', 'max_bill_rate'])), startOn: day(first(r, ['start_date'])), endOn: day(first(r, ['end_date'])), description: first(r, ['description']), skills: first(r, ['skills']), vmsStatus: first(r, ['status']) }),
    body: (c, jobId) => ({ job: jobId, candidate: { first_name: c.firstName, last_name: c.lastName, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}) }, title: c.designation, experience_years: c.experience, skills: c.skills, bill_rate: c.billRate, available_from: c.availableFrom, external_id: c.reference }),
    subId: (j) => first(j, ['id', 'application_id']), subStatus: (j) => first(j, ['status', 'stage']),
  },
  generic: {
    name: 'Other VMS (generic JSON)', auth: 'bearer',
    jobs: '/jobs', submit: '/jobs/{job}/submissions', status: '/submissions/{sub}',
    jobList: (j) => listOf(j, ['jobs', 'items', 'data', 'results']),
    job: (r) => ({ externalId: first(r, ['id', 'jobId']), title: first(r, ['title']), clientName: first(r, ['client', 'clientName', 'client.name']), location: first(r, ['location']), openings: numOr(first(r, ['openings'])), maxBillRate: numOr(first(r, ['maxBillRate'])), startOn: day(first(r, ['startDate'])), endOn: day(first(r, ['endDate'])), description: first(r, ['description']), skills: first(r, ['skills']), vmsStatus: first(r, ['status']) }),
    body: (c) => ({ name: c.name, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}), title: c.designation, experience: c.experience, skills: c.skills, billRate: c.billRate, availableFrom: c.availableFrom, reference: c.reference }),
    subId: (j) => first(j, ['id', 'submissionId']), subStatus: (j) => first(j, ['status']),
  },
};

async function config() {
  const { readConfig } = require('../integrationStore'); // eslint-disable-line global-require
  const r = await readConfig(CHANNEL).catch(() => ({ values: {} }));
  const v = r.values || {};
  const g = (k) => String(v[F[k]] || '').trim();
  const system = (g('system') || '').toLowerCase().replace(/[^a-z]/g, '') || null;
  return { system: ADAPTERS[system] ? system : null, raw: g('system'), base: g('base').replace(/\/+$/, ''), clientId: g('clientId'), secret: g('secret'), token: g('token'), supplier: g('supplier'), paths: { jobs: g('jobs'), submit: g('submit'), status: g('status') } };
}
function status(c) {
  const a = c && c.system ? ADAPTERS[c.system] : null;
  const missing = [];
  if (!a) missing.push('the VMS system');
  if (!c || !c.base) missing.push('the API base URL');
  if (a && a.auth.startsWith('oauth') && (!c.clientId || !c.secret)) missing.push('the client ID and secret');
  if (a && (a.auth === 'token' || a.auth === 'bearer' || a.auth === 'oauth+appkey') && !c.token) missing.push(a.auth === 'oauth+appkey' ? 'the application key' : 'the API token');
  if (a && /\{supplier\}/.test((c.paths.jobs || a.jobs)) && !c.supplier) missing.push('the supplier ID');
  return { system: c && c.system, name: a ? a.name : null, ready: !missing.length, missing, systems: Object.entries(ADAPTERS).map(([k, x]) => ({ key: k, name: x.name })), state: missing.length ? `Not set up: needs founder credentials (Administration > Integrations > VMS: ${missing.join(', ')})` : 'Set up' };
}

let tokenCache = null; // { key, token, until }
async function headers(c) {
  const a = ADAPTERS[c.system];
  if (a.auth === 'token') return { Authorization: `Token ${c.token}` };
  if (a.auth === 'bearer') return { Authorization: `Bearer ${c.token}` };
  const key = `${c.system}|${c.base}|${c.clientId}|${require('crypto').createHash('sha256').update(String(c.secret)).digest('hex').slice(0, 12)}`; // eslint-disable-line global-require
  if (!tokenCache || tokenCache.key !== key || tokenCache.until < Date.now()) {
    const r = await H.send(`${c.base}${a.tokenPath}`, { method: 'POST', form: { grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret } });
    if (!r.ok || !r.json || !r.json.access_token) throw Object.assign(new Error(`${a.name} sign-in failed (HTTP ${r.status}).`), { status: r.status });
    tokenCache = { key, token: r.json.access_token, until: Date.now() + Math.max(60, Number(r.json.expires_in) || 3000) * 1000 - 30000 };
  }
  return { Authorization: `Bearer ${tokenCache.token}`, ...(a.auth === 'oauth+appkey' ? { 'X-ApplicationKey': c.token } : {}) };
}
const fill = (p, o) => p.replace(/\{(\w+)\}/g, (m, k) => encodeURIComponent(o[k] == null ? '' : o[k]));

async function call(c, kind, vars, init = {}, byName = null) {
  const a = ADAPTERS[c.system];
  const path = fill(c.paths[kind] || a[kind], { supplier: c.supplier, ...vars });
  const url = `${c.base}${path.startsWith('/') ? '' : '/'}${path}`;
  const r = await H.send(url, { ...init, headers: { ...(await headers(c)), ...(init.headers || {}) } });
  await S.vmsLog(c.system, `${init.method || 'GET'} ${kind}`, r.ok, r.status, r.ok ? null : r.text, byName);
  if (!r.ok) throw Object.assign(new Error(`${a.name} answered HTTP ${r.status}.`), { status: r.status });
  return r.json;
}

// ---- 02.15 jobs ------------------------------------------------------------------------------------------------------------------
async function matchClient(name) {
  if (!name) return null;
  const t = String(name).trim().toLowerCase();
  const all = await prisma.client.findMany({ select: { id: true, name: true, legalName: true }, take: 5000 });
  return all.find((c) => [c.name, c.legalName].filter(Boolean).some((v) => String(v).trim().toLowerCase() === t))
    || all.find((c) => [c.name, c.legalName].filter(Boolean).some((v) => String(v).toLowerCase().includes(t) || t.includes(String(v).toLowerCase()))) || null;
}
async function pullJobs(user, { auto = false } = {}) {
  const c = await config();
  const st = status(c);
  if (!st.ready) return { error: `The VMS is not set up: ${st.missing.join(', ')} (Administration > Integrations > VMS).`, status: 409, state: st.state };
  let list;
  try { list = ADAPTERS[c.system].jobList(await call(c, 'jobs', {}, {}, user ? user.name : 'VMS sync')).map(ADAPTERS[c.system].job).filter((j) => j.externalId && j.title); } catch (e) { return { error: e.message, status: 502 }; }
  let added = 0; let updated = 0;
  for (const j of list) {
    // eslint-disable-next-line no-await-in-loop
    const before = (await S.q('SELECT "id","clientId" FROM "StfVmsJob" WHERE "system" = ? AND "externalId" = ?', c.system, String(j.externalId)))[0];
    // eslint-disable-next-line no-await-in-loop
    const client = before && before.clientId ? { id: before.clientId } : await matchClient(j.clientName);
    const skills = Array.isArray(j.skills) ? j.skills.join(', ') : j.skills;
    if (before) {
      // eslint-disable-next-line no-await-in-loop
      await S.x('UPDATE "StfVmsJob" SET "title"=?,"clientName"=?,"location"=?,"openings"=?,"maxBillRate"=?,"startOn"=?,"endOn"=?,"description"=?,"skills"=?,"vmsStatus"=?,"clientId"=COALESCE("clientId",?),"lastSeenAt"=? WHERE "id"=?',
        S.clean(j.title, 200), S.clean(j.clientName, 200), S.clean(j.location, 200), j.openings, j.maxBillRate, j.startOn, j.endOn, S.clean(j.description, 6000), S.clean(skills, 1000), S.clean(j.vmsStatus, 40), client ? client.id : null, S.now(), before.id);
      updated += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await S.x('INSERT INTO "StfVmsJob" ("id","system","externalId","title","clientName","location","openings","maxBillRate","startOn","endOn","description","skills","vmsStatus","clientId","state","firstSeenAt","lastSeenAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        S.newId(), c.system, String(j.externalId), S.clean(j.title, 200), S.clean(j.clientName, 200), S.clean(j.location, 200), j.openings, j.maxBillRate, j.startOn, j.endOn, S.clean(j.description, 6000), S.clean(skills, 1000), S.clean(j.vmsStatus, 40), client ? client.id : null, 'New', S.now(), S.now());
      added += 1;
    }
  }
  let filed = 0;
  if (auto && await S.setting('vms.autoImport')) {
    const byId = await S.setting('vms.autoImport.byId');
    const owner = byId ? await prisma.user.findUnique({ where: { id: byId }, select: { id: true, name: true } }) : null;
    const fresh = await S.q('SELECT "id" FROM "StfVmsJob" WHERE "state" = \'New\' AND "clientId" IS NOT NULL AND "system" = ?', c.system);
    for (const f of fresh) {
      // eslint-disable-next-line no-await-in-loop
      const r = await importJob(owner ? { ...owner, name: `${owner.name} (VMS sync)` } : { id: null, name: 'VMS sync' }, f.id, {});
      if (r.ok) filed += 1;
    }
  }
  return { ok: true, system: st.name, seen: list.length, added, updated, filed };
}
async function jobs() {
  const rows = await S.q('SELECT j.*, (SELECT COUNT(*) FROM "StfVmsSub" s WHERE s."vmsJobId" = j."id") AS "subs" FROM "StfVmsJob" j ORDER BY j."lastSeenAt" DESC LIMIT 500');
  const reqs = rows.filter((r) => r.requirementId).map((r) => r.requirementId);
  const R = new Map((reqs.length ? await prisma.requirement.findMany({ where: { id: { in: reqs } }, select: { id: true, reqCode: true, status: true } }) : []).map((r) => [r.id, r]));
  const clients = rows.filter((r) => r.clientId).map((r) => r.clientId);
  const CL = new Map((clients.length ? await prisma.client.findMany({ where: { id: { in: clients } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
  return rows.map((r) => ({ id: r.id, system: r.system, systemName: (ADAPTERS[r.system] || {}).name || r.system, externalId: r.externalId, title: r.title, clientName: r.clientName, clientId: r.clientId, client: CL.get(r.clientId) || null, location: r.location, openings: r.openings == null ? null : S.num(r.openings), maxBillRate: r.maxBillRate == null ? null : Number(r.maxBillRate), startOn: r.startOn, endOn: r.endOn, skills: r.skills, vmsStatus: r.vmsStatus, state: r.state, requirementId: r.requirementId, reqCode: r.requirementId && R.get(r.requirementId) ? R.get(r.requirementId).reqCode : null, importedByName: r.importedByName, submissions: S.num(r.subs), lastSeenAt: r.lastSeenAt }));
}
// file a VMS job as a requirement request: the normal BDE -> BDE TL -> TL flow (utils/requirementRequest.js)
async function importJob(user, id, { clientId = null } = {}) {
  const j = (await S.q('SELECT * FROM "StfVmsJob" WHERE "id" = ?', String(id || '')))[0];
  if (!j) return { error: 'VMS job not found.', status: 404 };
  if (j.requirementId) return { error: 'This VMS job is already a requirement.', status: 409 };
  const cid = clientId || j.clientId;
  if (!cid) return { error: `Pick the TeamLink client for "${j.clientName || 'this VMS client'}".` };
  const lines = [j.description, j.maxBillRate != null ? `VMS highest bill rate: ${Number(j.maxBillRate)}` : null, j.startOn ? `Starts ${j.startOn}${j.endOn ? `, ends ${j.endOn}` : ''}` : null, `From ${(ADAPTERS[j.system] || {}).name || j.system} job ${j.externalId}`].filter(Boolean);
  const RR = require('../requirementRequest'); // eslint-disable-line global-require
  const out = await RR.createRequirementRequest({ title: j.title, clientId: cid, openings: j.openings || 1, location: j.location, skills: j.skills, jobDescription: lines.join('\n'), employmentType: 'Contract', closingDate: j.startOn, notes: `VMS job ${j.externalId}` }, { user, via: 'VMS' });
  if (out.status >= 300) return { error: out.body.error || 'Not filed.', status: out.status };
  await prisma.requirement.update({ where: { id: out.body.id }, data: { jobPreference: 'Contract' } }).catch(() => {});
  await S.x('UPDATE "StfVmsJob" SET "requirementId"=?,"clientId"=?,"state"=\'Filed\',"importedByName"=?,"importedAt"=? WHERE "id"=?', out.body.id, cid, user.name, S.now(), j.id);
  return { ok: true, requirementId: out.body.id, reqCode: out.body.reqCode, message: out.body.message };
}
async function dismissJob(user, id) {
  const r = await S.x('UPDATE "StfVmsJob" SET "state"=\'Not for us\',"importedByName"=? WHERE "id"=? AND "requirementId" IS NULL', user.name, String(id || ''));
  return S.num(r) ? { ok: true } : { error: 'VMS job not found (or already a requirement).', status: 404 };
}

// ---- 06.14 submissions -------------------------------------------------------------------------------------------------------------
const SEND_STAGES = ['BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
async function submit(user, applicationId, { billRate, availableFrom = null, withContact = false } = {}) {
  const scope = require('../scope'); // eslint-disable-line global-require
  const app = await prisma.application.findFirst({ where: { AND: [scope.applicationWhere(user), { id: String(applicationId || '') }] }, select: { id: true, stage: true, requirementId: true, candidate: { select: { id: true, name: true, email: true, phone: true, currentDesignation: true, experienceYears: true, skills: true } } } });
  if (!app) return { error: 'Application not found (or not in your scope).', status: 404 };
  const j = (await S.q('SELECT * FROM "StfVmsJob" WHERE "requirementId" = ?', app.requirementId))[0];
  if (!j) return { error: 'This requirement did not come from a VMS job.', status: 409 };
  if (!SEND_STAGES.includes(app.stage)) return { error: 'Send a candidate to the VMS once the BDE has approved them (the same point as sharing with the client).', status: 409 };
  if (withContact && scope.atsViewRole(user) === 'bde') return { error: 'The BDE team does not pass on candidate phone numbers or e-mails. Ask the recruiter or the team lead to send it with contact details.', status: 403 };
  const rate = S.n(billRate);
  if (rate == null || rate <= 0) return { error: 'Give the bill rate you propose.' };
  if (j.maxBillRate != null && rate > Number(j.maxBillRate)) return { error: `The VMS job allows at most ${Number(j.maxBillRate)}.` };
  if ((await S.q('SELECT 1 FROM "StfVmsSub" WHERE "applicationId" = ? AND "vmsJobId" = ? AND "externalId" IS NOT NULL', app.id, j.id)).length) return { error: 'Already sent to this VMS job.', status: 409 };
  const c = await config();
  if (c.system !== j.system) return { error: `The VMS set up now is ${c.system || 'none'}, but this job came from ${j.system}.`, status: 409 };
  const st = status(c);
  if (!st.ready) return { error: `The VMS is not set up: ${st.missing.join(', ')}.`, status: 409 };
  const parts = String(app.candidate.name || '').trim().split(/\s+/);
  const cand = { name: app.candidate.name, firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '-', designation: app.candidate.currentDesignation || null, experience: app.candidate.experienceYears, skills: String(app.candidate.skills || '').split(',').map((s) => s.trim()).filter(Boolean), billRate: rate, availableFrom: S.isDate(availableFrom) ? availableFrom : null, reference: app.id, ...(withContact ? { email: app.candidate.email || null, phone: app.candidate.phone || null } : {}) };
  const a = ADAPTERS[c.system];
  let res; let err = null;
  try { res = await call(c, 'submit', { job: j.externalId }, { method: 'POST', body: a.body(cand, j.externalId) }, user.name); } catch (e) { err = e.message; }
  const extId = res ? a.subId(res) : null;
  const vst = res ? a.subStatus(res) || 'Submitted' : null;
  await S.x('INSERT INTO "StfVmsSub" ("id","system","applicationId","vmsJobId","externalId","billRate","vmsStatus","plainStatus","sentByName","sentAt","checkedAt","error") VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT("applicationId","vmsJobId") DO UPDATE SET "externalId"=excluded."externalId","billRate"=excluded."billRate","vmsStatus"=excluded."vmsStatus","plainStatus"=excluded."plainStatus","sentByName"=excluded."sentByName","sentAt"=excluded."sentAt","error"=excluded."error"',
    S.newId(), c.system, app.id, j.id, extId ? String(extId) : null, rate, vst, extId ? plain(vst) : null, user.name, S.now(), S.now(), err || (extId ? null : 'The VMS gave no submission id.'));
  await require('../audit').logAudit({ userId: user.id, action: extId ? 'Candidate sent to the VMS' : 'Sending to the VMS failed', entity: 'Application', entityId: app.id, toValue: `${a.name} job ${j.externalId}${extId ? ` as ${extId}` : `: ${err || 'no id'}`}${withContact ? ' (with contact details)' : ''}`.slice(0, 300) }); // eslint-disable-line global-require
  return extId ? { ok: true, externalId: String(extId), status: plain(vst) } : { error: `Not sent: ${err || 'the VMS gave no submission id.'}`, status: 502 };
}
// the people on the VMS job's requirement who may be sent now (in this login's scope)
async function candidatesFor(user, id) {
  const j = (await S.q('SELECT * FROM "StfVmsJob" WHERE "id" = ?', String(id || '')))[0];
  if (!j || !j.requirementId) return { error: 'File the VMS job as a requirement first.', status: 404 };
  const scope = require('../scope'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({ where: { AND: [scope.applicationWhere(user), { requirementId: j.requirementId }, { stage: { in: SEND_STAGES } }] }, select: { id: true, stage: true, candidate: { select: { name: true } } }, take: 200 });
  const sent = new Set((await S.q('SELECT "applicationId" FROM "StfVmsSub" WHERE "vmsJobId" = ? AND "externalId" IS NOT NULL', j.id)).map((r) => r.applicationId));
  return { maxBillRate: j.maxBillRate == null ? null : Number(j.maxBillRate), rows: apps.map((a) => ({ applicationId: a.id, name: a.candidate.name, stage: a.stage, sent: sent.has(a.id) })) };
}
async function submissions(user, { applicationId = null } = {}) {
  const scope = require('../scope'); // eslint-disable-line global-require
  const rows = await S.q(`SELECT s.*, j."title", j."externalId" AS "jobExternalId" FROM "StfVmsSub" s JOIN "StfVmsJob" j ON j."id" = s."vmsJobId"${applicationId ? ' WHERE s."applicationId" = ?' : ''} ORDER BY s."sentAt" DESC LIMIT 500`, ...(applicationId ? [applicationId] : []));
  const ids = [...new Set(rows.map((r) => r.applicationId))];
  const ok = new Map((ids.length ? await prisma.application.findMany({ where: { AND: [scope.applicationWhere(user), { id: { in: ids } }] }, select: { id: true, stage: true, candidate: { select: { name: true } } } }) : []).map((a) => [a.id, a]));
  return rows.filter((r) => ok.has(r.applicationId)).map((r) => ({ id: r.id, applicationId: r.applicationId, name: ok.get(r.applicationId).candidate.name, stage: ok.get(r.applicationId).stage, job: r.title, jobExternalId: r.jobExternalId, system: r.system, externalId: r.externalId, billRate: r.billRate == null ? null : Number(r.billRate), vmsStatus: r.vmsStatus, status: r.plainStatus, sentByName: r.sentByName, sentAt: r.sentAt, checkedAt: r.checkedAt, error: r.error }));
}
// read the status of every open submission back from the VMS
async function syncStatuses(user) {
  const c = await config();
  const st = status(c);
  if (!st.ready) return { error: `The VMS is not set up: ${st.missing.join(', ')}.`, status: 409 };
  const a = ADAPTERS[c.system];
  const open = await S.q('SELECT * FROM "StfVmsSub" WHERE "system" = ? AND "externalId" IS NOT NULL AND COALESCE("plainStatus",\'\') NOT IN (\'Rejected\',\'Withdrawn\',\'Hired\') LIMIT 300', c.system);
  let changed = 0; let failed = 0; const moves = [];
  for (const s of open) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const j = await call(c, 'status', { sub: s.externalId }, {}, user ? user.name : 'VMS sync');
      const vst = a.subStatus(j);
      const p = plain(vst);
      if (p !== s.plainStatus) { changed += 1; moves.push({ applicationId: s.applicationId, from: s.plainStatus, to: p }); }
      // eslint-disable-next-line no-await-in-loop
      await S.x('UPDATE "StfVmsSub" SET "vmsStatus"=?,"plainStatus"=?,"checkedAt"=?,"error"=NULL WHERE "id"=?', S.clean(vst, 60), p, S.now(), s.id);
    } catch (e) {
      failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await S.x('UPDATE "StfVmsSub" SET "checkedAt"=?,"error"=? WHERE "id"=?', S.now(), S.clean(e.message, 200), s.id);
    }
  }
  if (changed) await require('../audit').logAudit({ userId: user ? user.id : null, action: 'VMS statuses read back', entity: 'StfVmsSub', entityId: c.system, toValue: moves.slice(0, 5).map((m) => `${m.from || '-'} > ${m.to}`).join(', ') }); // eslint-disable-line global-require
  return { ok: true, checked: open.length, changed, failed, moves };
}
async function testConnection(user) {
  const c = await config();
  const st = status(c);
  if (!st.ready) return { ok: false, message: st.state };
  try { const list = ADAPTERS[c.system].jobList(await call(c, 'jobs', {}, {}, user.name)); return { ok: true, message: `${st.name} answered: ${list.length} open job(s) for your supplier account.` }; } catch (e) { return { ok: false, message: e.message }; }
}
async function log({ limit = 50 } = {}) { return S.q('SELECT * FROM "StfVmsLog" ORDER BY "at" DESC LIMIT ?', Math.min(200, Number(limit) || 50)); }

// ---- the 30-minute sync (OFF until an Admin switches vms.sync on; never in the sandbox) ----------------------------------------------
let timer = null;
function start() {
  if (timer || S.isSandbox()) return;
  timer = setInterval(async () => {
    try {
      if (!(await S.setting('vms.sync'))) return;
      if (!status(await config()).ready) return;
      await pullJobs(null, { auto: true });
      await syncStatuses(null);
    } catch (e) { console.error('[stfx-vms] sync:', e.message); }
  }, 30 * 60000);
  if (timer.unref) timer.unref();
}

module.exports = { CHANNEL, F, ADAPTERS, plain, config, status, pullJobs, jobs, importJob, dismissJob, submit, submissions, candidatesFor, syncStatuses, testConnection, log, start, SEND_STAGES };
