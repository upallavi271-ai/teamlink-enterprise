// ---------------------------------------------------------------------------
// INDEED — Job Sync API (GraphQL), the approved way for an employer / staffing
// firm / ATS to put jobs on Indeed.
//   Docs  https://docs.indeed.com/job-sync-api/
//         https://docs.indeed.com/job-sync-api/job-sync-api-guide  (mutations, scopes, status query)
//         https://docs.indeed.com/getstarted/integrate-and-call-apis (2-legged OAuth token)
//         https://docs.indeed.com/api/graphql_schema
//   Access: sign Indeed's Developer Agreement and apply as a partner
//         (https://partners.indeed.com/?becomePartner); once approved the
//         Client ID / Client secret are in the Partner Console
//         (https://console.indeed.com/integrations/home). Onboarding takes weeks.
//   Alternative (also documented, approved by the Indeed partner manager):
//         the XML job feed — this app already serves /api/public/jobs.xml
//         (https://docs.indeed.com/job-sync-xml/xml-feed). Indeed says partners
//         should prefer the API.
//
//   token    POST https://apis.indeed.com/oauth/v2/tokens  (form: client_id,
//            client_secret, grant_type=client_credentials,
//            scope="employer_access employer.hosted_job", employer=<id>)
//   publish  mutation jobsIngest.createSourcedJobPostings — an UPSERT keyed on
//            metadata.jobPostingId + jobSource.sourceName, so the same job is
//            never posted twice (jobPostingId = the master job id)
//   status   query node(id: <employerJobId>) … globalStatus.lifecycleStatus
//            PENDING | ACTIVE | INACTIVE (publishing takes 1–2 hours)
//   remove   mutation jobsIngest.expireSourcedJobsBySourcedPostingId
// "Posted" only when Indeed reports lifecycleStatus ACTIVE.
// ---------------------------------------------------------------------------
const http = require('./http');
const { PUBLIC_COMPANY, boardSettings, jobText } = require('./common');

const LABEL = 'Indeed';
const F = {
  clientId: 'Client ID',
  secret: 'Client secret',
  employer: 'Employer ID (optional)',
  contact: 'Contact email for Indeed',
  sourceName: 'Source name (as agreed with Indeed)',
};
const TOKEN_URL = 'https://apis.indeed.com/oauth/v2/tokens';
const GRAPHQL_URL = 'https://apis.indeed.com/graphql';
const SCOPE = 'employer_access employer.hosted_job';

const FIELDS = [[F.clientId, 'from the Indeed Partner Console'], [F.secret, ''], [F.employer, 'only for a token per employer'],
  [F.contact, 'jobs@your-company'], [F.sourceName, PUBLIC_COMPANY]];
const NEED = [F.clientId, F.secret, F.contact];
const SETUP = 'Indeed needs a partner account: sign Indeed\'s Developer Agreement and apply at partners.indeed.com, then enter the Client ID, Client secret and a contact email from the Indeed Partner Console in Administration → Integrations → Indeed.';

// externalJobId keeps both of Indeed's ids: "sp:<sourcedPostingId>;ej:<employerJobId>"
const packId = (sp, ej) => `sp:${sp || ''};ej:${ej || ''}`;
function unpackId(v) {
  const m = /^sp:([^;]*);ej:(.*)$/.exec(String(v || ''));
  return m ? { sp: m[1] || null, ej: m[2] || null } : { sp: v || null, ej: null };
}
const shownId = (v) => unpackId(v).sp;

async function config() {
  const s = await boardSettings('indeed', NEED, LABEL);
  if (s.ready || s.hint) return s;
  return { ...s, hint: s.missing.length === NEED.length ? SETUP : `Indeed: fill in ${s.missing.join(', ')} in Administration → Integrations → Indeed.` };
}

async function token(cfg) {
  const v = cfg.values;
  const key = `indeed|${v[F.clientId]}|${v[F.employer] || ''}`;
  const have = http.cachedToken(key);
  if (have) return { ok: true, token: have };
  const form = { client_id: v[F.clientId], client_secret: v[F.secret], grant_type: 'client_credentials', scope: SCOPE };
  if (String(v[F.employer] || '').trim()) form.employer = String(v[F.employer]).trim();
  const res = await http.call(LABEL, TOKEN_URL, { method: 'POST', form, secrets: [v[F.secret]] });
  if (!res.ok) return { ok: false, error: res.code ? res.error : `Could not sign in to Indeed. ${res.error}` };
  if (!res.body || !res.body.access_token) return { ok: false, error: 'Indeed did not return an access token.' };
  http.rememberToken(key, res.body.access_token, res.body.expires_in);
  return { ok: true, token: res.body.access_token };
}

async function gql(cfg, query) {
  const t = await token(cfg);
  if (!t.ok) return { ok: false, error: t.error };
  const res = await http.call(LABEL, GRAPHQL_URL, {
    method: 'POST', headers: { authorization: `Bearer ${t.token}` }, json: { query }, secrets: [cfg.values[F.secret], t.token],
  });
  if (!res.ok) return res;
  const errs = res.body && Array.isArray(res.body.errors) ? res.body.errors : [];
  if (errs.length) return { ok: false, error: `Indeed said: ${http.plain(http.scrub(errs.map((e) => e.message).join('; ')), 200)}` };
  return { ok: true, data: res.body ? res.body.data : null };
}

// The documents follow the guide's examples, with the input inlined as a
// GraphQL literal (so no input type names are assumed).
const ENUM = (v) => ({ __enum: v });
function lit(v) {
  if (v && typeof v === 'object' && v.__enum) return v.__enum;
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{ ${Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }`;
  }
  return JSON.stringify(v);
}
const UPSERT = (input) => `mutation { jobsIngest { createSourcedJobPostings(input: ${lit(input)}) { results { jobPosting { sourcedPostingId employerJobId } } } } }`;
const EXPIRE = (input) => `mutation { jobsIngest { expireSourcedJobsBySourcedPostingId(input: ${lit(input)}) { results { trackingKey } } } }`;
const STATUS = (id) => `query { node(id: ${JSON.stringify(id)}) { ... on EmployerJob { id managementUrls { viewJob } seatsConnection { seats { jobPost { status { globalStatus { lifecycleStatus } } } } } } } }`;

function posting(r, cfg) {
  const v = cfg.values;
  const applyUrl = http.publicUrl(require('../jobSlug').careersPath(r, 'Indeed')); // eslint-disable-line global-require
  return {
    body: {
      title: r.title,
      description: jobText(r) || r.title,
      descriptionFormatting: ENUM('TEXT'),
      location: { country: 'IN', cityRegionPostal: r.location || 'India' },
      benefits: [],
    },
    metadata: {
      jobSource: { companyName: PUBLIC_COMPANY, sourceName: String(v[F.sourceName] || '').trim() || PUBLIC_COMPANY, sourceType: 'Staffing' },
      jobPostingId: r.id, // the master job id: Indeed upserts on it, never a second job
      jobRequisitionId: r.reqCode || r.id,
      datePublished: new Date(r.portalPublishedAt || r.createdAt || Date.now()).toISOString(),
      url: applyUrl,
      contacts: [{ contactType: ['contact'], contactInfo: { contactEmail: String(v[F.contact]).trim() } }],
    },
  };
}

async function check(cfg, ids) {
  if (!ids.ej) return { status: 'Pending', errorMessage: 'Sent to Indeed. Waiting for Indeed to make it live (usually 1–2 hours).' };
  const res = await gql(cfg, STATUS(ids.ej));
  if (!res.ok) return { status: 'Pending', errorMessage: `Sent to Indeed; could not read its status yet: ${res.error}`, called: true };
  const node = res.data && res.data.node;
  const seat = node && node.seatsConnection && node.seatsConnection.seats && node.seatsConnection.seats[0];
  const life = seat && seat.jobPost && seat.jobPost.status && seat.jobPost.status.globalStatus ? seat.jobPost.status.globalStatus.lifecycleStatus : null;
  const view = node && node.managementUrls ? node.managementUrls.viewJob : null;
  if (life === 'ACTIVE') return { status: 'Posted', externalUrl: view || null, called: true };
  if (life === 'INACTIVE') return { status: 'Failed', errorMessage: 'Indeed shows this job as inactive. Press Retry to send it again.', called: true };
  return { status: 'Pending', errorMessage: 'Sent to Indeed. Waiting for Indeed to make it live (usually 1–2 hours).', called: true };
}

async function publish(r, row, cfg) {
  if (!http.publicUrl('/')) return { status: 'Failed', errorMessage: 'Indeed needs a public apply link, but APP_BASE_URL (this site\'s public address) is not set on the server.' };
  const res = await gql(cfg, UPSERT({ jobPostings: [posting(r, cfg)] }));
  if (!res.ok) return { status: 'Failed', errorMessage: res.error, called: true };
  const out = res.data && res.data.jobsIngest && res.data.jobsIngest.createSourcedJobPostings;
  const jp = out && out.results && out.results[0] && out.results[0].jobPosting;
  if (!jp || !jp.sourcedPostingId) return { status: 'Failed', errorMessage: 'Indeed did not accept the job (no posting id came back).', called: true };
  const ids = { sp: jp.sourcedPostingId, ej: jp.employerJobId || null };
  const st = await check(cfg, ids);
  return { ...st, externalJobId: packId(ids.sp, ids.ej), called: true };
}

async function remove(r, row, cfg) {
  const ids = unpackId(row && row.externalJobId);
  if (!ids.sp) return { status: 'Removed' };
  const res = await gql(cfg, EXPIRE({ jobs: [{ sourcedPostingId: ids.sp }] }));
  if (!res.ok) return { status: 'Posted', errorMessage: `Could not take it off Indeed: ${res.error} Press Retry.`, called: true };
  return { status: 'Removed', called: true };
}

async function status(r, row, cfg) {
  return check(cfg, unpackId(row && row.externalJobId));
}

module.exports = {
  id: 'indeed', label: LABEL, integrationId: 'indeed', FIELDS, SETUP, config, publish, update: publish, remove, status, shownId,
};
