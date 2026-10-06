// ---------------------------------------------------------------------------
// NAUKRI and SHINE — partner integrations only (checked 2026-10-05).
//
// NAUKRI (Info Edge). There is no public posting API, XML feed spec or bulk
// upload spec on naukri.com / infoedge.in. ATS products connect through
// Naukri's paid integration module "Amplify" by Zwayam (an Info Edge company,
// https://www.infoedge.in/announcements/IEILReg30Zwayam11062021.pdf). How it
// works for other ATSs (vendor help pages, not Naukri's own docs):
//   https://support.greenhouse.io/hc/en-us/articles/16297968058651
//   https://help.zoho.com/portal/en/kb/recruit/talent-sourcing/job-boards/premium-job-boards/articles/post-jobs-on-naukri-through-zoho-recruit
//   — the ATS enters a "Zwayam Amplify API key" and secret key, and Naukri
//   verifies each job (up to 24 hours) before it goes live.
//   To get: a paid Naukri job-posting subscription + the Amplify module, from
//   the Naukri account manager or amplify@zwayam.com; at onboarding they give
//   the endpoint and field mapping for a new ATS.
//
// SHINE (HT Media). No public API, feed or bulk-upload documentation exists.
//   Zoho Recruit announced a Shine integration with account credentials, so a
//   private partner route exists. To get: ask Shine's employer sales / account
//   manager (recruiter.shine.com) for an ATS / job-posting API agreement.
//
// WHAT THIS CONNECTOR DOES once the Admin has the partner credentials:
//   POST <Job endpoint URL> with the job as JSON
//     { action: "upsert" | "close", reference: <master job id>, … }
//   headers  Authorization: Bearer <API key>
//            X-TeamLink-Signature: sha256=<HMAC-SHA256 of the body, Secret key>
//            (when a secret key is set)
//   It reads the board's job id (id / jobId / job_id), link (url / jobUrl) and
//   state (status) from the answer. "Posted" only when the board's answer says
//   the job is live / active / published; any other 2xx is "Pending" (sent,
//   the board is checking it). The board's onboarding team confirms or maps
//   this contract — only payload() / read() would change.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const http = require('./http');
const { PUBLIC_COMPANY, boardSettings, jobText, csv } = require('./common');

// The posting-method field (a choice on the Integrations card). Naukri also
// takes jobs from an XML feed for accounts where Naukri has agreed one: the
// feed is served at /api/public/feeds/naukri.xml (routes/jobFeeds.js) and a
// job in it is "Sent, waiting for confirmation" — never Posted — until Naukri
// confirms it (there is no public Naukri status API).
const METHOD = 'Posting method (Amplify API / XML feed)';

function make({ id, label, fields, need, setup, reviewNote, feed = false }) {
  const F = { url: 'Job endpoint URL', key: 'API key', secret: 'Secret key' };

  async function config() {
    if (feed) {
      const any = await boardSettings(id, [], label);
      if (/xml/i.test(String(any.values[METHOD] || '')) && !any.off) return { ...any, ready: true, feed: true, method: 'XML feed' };
    }
    const s = await boardSettings(id, need, label);
    if (s.ready) return { ...s, method: feed ? 'Amplify API' : 'Partner API' };
    if (s.hint) return s;
    return { ...s, hint: s.missing.length === need.length ? setup : `${label}: fill in ${s.missing.join(', ')} in Administration → Integrations → ${label}.` };
  }

  function payload(r, action) {
    return {
      action,
      reference: r.id, // the master job id — the same job is never posted twice
      referenceCode: r.reqCode || null,
      company: PUBLIC_COMPANY,
      title: r.title,
      description: jobText(r) || r.title,
      location: r.location || null,
      workMode: r.workMode || null,
      employmentType: r.employmentType || null,
      experience: r.experience || null,
      salary: r.salary || null,
      skills: csv(r.skills),
      openings: r.openings || 1,
      closingDate: r.closingDate || null,
      applyUrl: http.publicUrl(require('../jobSlug').careersPath(r, label)), // eslint-disable-line global-require
    };
  }

  function read(body) {
    const b = body && typeof body === 'object' ? body : {};
    const d = (b.data && typeof b.data === 'object' && b.data) || (b.job && typeof b.job === 'object' && b.job) || {};
    const pickv = (...keys) => keys.map((k) => b[k] ?? d[k]).find((x) => x != null && x !== '');
    const jid = pickv('id', 'jobId', 'job_id');
    return {
      id: jid == null ? null : String(jid),
      url: pickv('url', 'jobUrl', 'job_url') || null,
      state: String(pickv('status', 'state') || ''),
    };
  }

  async function send(cfg, body) {
    const v = cfg.values;
    const url = String(v[F.url] || '').trim();
    if (!/^https:\/\//i.test(url)) return { ok: false, error: `The ${label} Job endpoint URL must start with https:// (Administration → Integrations).` };
    const raw = JSON.stringify(body);
    const headers = { authorization: `Bearer ${String(v[F.key]).trim()}` };
    if (String(v[F.secret] || '').trim()) {
      headers['x-teamlink-signature'] = `sha256=${crypto.createHmac('sha256', String(v[F.secret]).trim()).update(raw).digest('hex')}`;
    }
    return http.call(label, url, { method: 'POST', headers, json: body, secrets: [v[F.key], v[F.secret]] });
  }

  async function publish(r, row, cfg) {
    if (!http.publicUrl('/')) return { status: 'Failed', errorMessage: `${label} needs a public apply link, but APP_BASE_URL (this site's public address) is not set on the server.` };
    const res = await send(cfg, payload(r, 'upsert'));
    if (!res.ok) return { status: 'Failed', errorMessage: res.error, called: true };
    const ans = read(res.body);
    const live = /^(live|active|published|posted|open)$/i.test(ans.state);
    return {
      status: live ? 'Posted' : 'Pending',
      externalJobId: ans.id || (row && row.externalJobId) || null,
      externalUrl: ans.url,
      errorMessage: live ? null : `Sent to ${label}${ans.id ? ` (job id ${ans.id})` : ''}. ${reviewNote}`,
      called: true,
    };
  }

  async function remove(r, row, cfg) {
    const res = await send(cfg, { ...payload(r, 'close'), boardJobId: row && row.externalJobId ? row.externalJobId : null });
    if (!res.ok && res.code !== 404) return { status: 'Posted', errorMessage: `Could not take it off ${label}: ${res.error} Press Retry.`, called: true };
    return { status: 'Removed', called: true };
  }

  // No status API is published for either board: a Pending job stays Pending
  // until a later send comes back live (Retry sends it again — an upsert on the
  // same reference, never a second job).
  async function status(r, row) {
    return { status: row ? row.status : 'Pending', errorMessage: row ? row.errorMessage : null };
  }

  return { id, label, integrationId: id, FIELDS: fields, SETUP: setup, config, publish, update: publish, remove, status, shownId: (x) => x };
}

const naukri = make({
  id: 'naukri',
  label: 'Naukri',
  fields: [[METHOD, 'Amplify API'], ['Recruiter account email', ''], ['API key', 'Zwayam Amplify API key (from Naukri)'], ['Secret key', 'Amplify secret key'],
    ['Job endpoint URL', 'given by Naukri / Zwayam at onboarding (https://…)']],
  need: ['API key', 'Secret key', 'Job endpoint URL'],
  feed: true,
  setup: 'Naukri has no public posting API. Buy the Naukri job-posting plan with the "Amplify" ATS integration (Zwayam) from your Naukri account manager or amplify@zwayam.com, then add the Amplify API key, secret key and job endpoint URL in Administration → Integrations → Naukri.',
  reviewNote: 'Naukri checks each job before it goes live (up to 24 hours).',
});

const shine = make({
  id: 'shine',
  label: 'Shine',
  fields: [['Recruiter account email', ''], ['API key', 'from Shine (partner account)'], ['Secret key', 'if Shine gives one'],
    ['Job endpoint URL', 'given by Shine at onboarding (https://…)']],
  need: ['API key', 'Job endpoint URL'],
  setup: 'Shine has no public posting API. Ask your Shine employer sales / account manager for an ATS job-posting API account, then add the API key and job endpoint URL in Administration → Integrations → Shine.',
  reviewNote: 'Waiting for Shine to confirm it is live.',
});

module.exports = { naukri, shine, METHOD };
