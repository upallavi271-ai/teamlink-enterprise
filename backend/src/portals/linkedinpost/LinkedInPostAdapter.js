// ---------------------------------------------------------------------------
// LINKEDIN POST adapter: a post on the LinkedIn feed through the official Posts API (https://learn.microsoft.com/linkedin/marketing/
// community-management/shares/posts-api), free. It is NOT an entry in LinkedIn Jobs (LinkedIn does not let programs post jobs: that
// stays the by-hand "LinkedIn" place).
//   username = who posts: urn:li:person:<id> (the profile that connected) or urn:li:organization:<id> (a Company Page),
//   password = the LinkedIn access token (w_member_social for a profile, w_organization_social for a Company Page; it lasts 60 days).
//   Test connection  GET /v2/userinfo  (who the token belongs to, SENDS NOTHING)
//   Post             POST /rest/posts {author, commentary, visibility PUBLIC, lifecycleState PUBLISHED}  -> 201 + x-restli-id
//   Post update      POST /rest/posts/{urn} with X-RestLi-Method: PARTIAL_UPDATE  {patch: {$set: {commentary}}}
// Base address https://api.linkedin.com unless TL_LINKEDIN_API_BASE (or the Admin setting jobpublish.api.linkedinpost.base). The
// LinkedIn-Version header comes from TL_LINKEDIN_VERSION / the Admin setting jobpublish.api.linkedinpost.version (LinkedIn retires old months).
// ---------------------------------------------------------------------------
const ApiPortal = require('../api/ApiPortal');
const { PORTALS, ERRORS } = require('../../jobPublish/constants');
const { PortalError } = require('../base/errors');
const S = require('../../jobPublish/settings');

const DEFAULT_VERSION = '202604';

// LinkedIn reads | { } @ [ ] ( ) < > # \ * _ ~ in a post as markup (mentions, hashtags): a backslash makes one plain text.
// A web address is left alone (its _ and ~ are part of the link) and so is # (our hashtags are meant to be hashtags).
function escapeLittleText(text) {
  return String(text || '').split(/(https?:\/\/[^\s]+)/g).map((part, i) => (i % 2 ? part : part.replace(/([\\|{}@[\]()<>*_~])/g, '\\$1'))).join('');
}

class LinkedInPostAdapter extends ApiPortal {
  static get meta() { return { ...PORTALS.linkedinpost }; }

  envBase() { return 'TL_LINKEDIN_API_BASE'; }

  defaultBase() { return 'https://api.linkedin.com'; }

  token() { return this.creds && this.creds.password; }

  author() { return this.creds && this.creds.username; }

  async version() {
    const set = await S.get('jobpublish.api.linkedinpost.version').catch(() => null);
    return process.env.TL_LINKEDIN_VERSION || (set && typeof set.value === 'string' && set.value) || DEFAULT_VERSION;
  }

  async api(method, path, { json = null, headers = {}, v2 = false } = {}) {
    if (!this.token() || !this.author()) throw new PortalError('NO_CREDENTIALS', ERRORS.NO_CREDENTIALS.words, { retryable: false });
    const base = await this.base();
    const h = { Authorization: `Bearer ${this.token()}`, 'X-Restli-Protocol-Version': '2.0.0', ...headers };
    if (!v2) h['LinkedIn-Version'] = await this.version();
    const r = await this.call(method, `${base}${path}`, { json, headers: h, timeoutMs: 30000 });
    const j = r.json || {};
    if (r.status >= 200 && r.status < 300) return { json: j, status: r.status, header: r.header };
    const msg = String(j.message || j.error_description || '').toLowerCase();
    const E = (c, text, o = {}) => Object.assign(new PortalError(c, text || ERRORS[c].words, { retryable: !!ERRORS[c].retry, ...o }), { apiStatus: `${r.status}${j.serviceErrorCode ? ` / ${j.serviceErrorCode}` : ''}`, retryAfterMs: o.retryAfterMs || null });
    if (r.status === 401) throw E('BAD_TOKEN', 'LinkedIn did not accept the token (it lasts 60 days, so it may have expired). Connect LinkedIn again in Social Media.');
    if (r.status === 429) {
      const wait = r.retryAfterMs ? r.retryAfterMs / 1000 : 60;
      throw E('RATE_LIMITED', `LinkedIn asked us to slow down. TeamLink tries again in about ${Math.round(wait)} seconds.`, { retryAfterMs: wait * 1000, retryable: true });
    }
    if (r.status === 403) throw E('NOT_ADMIN', `LinkedIn does not allow this token to post${String(this.author()).includes('organization') ? ' for that Company Page (the token needs w_organization_social and the person must be an administrator of the Page)' : ''}. LinkedIn says: ${this.scrub(j.message || '').slice(0, 160)}`);
    if (r.status === 426 || /version.*(not active|invalid)|nonexistent version/.test(msg)) throw E('API_ERROR', 'LinkedIn no longer accepts the API version TeamLink sends. The developer must set a current one (TL_LINKEDIN_VERSION).');
    if (r.status >= 500) throw E('NETWORK', 'LinkedIn had a problem on its side. TeamLink tries again.', { retryable: true });
    throw E('API_ERROR', `${ERRORS.API_ERROR.words} LinkedIn says: ${this.scrub(j.message || `error ${r.status}`).slice(0, 200)}`);
  }

  async check() {
    const r = await this.api('GET', '/v2/userinfo', { v2: true });
    const j = r.json;
    if (!j.sub) throw Object.assign(new PortalError('BAD_TOKEN', 'LinkedIn answered but did not say who the token belongs to. Connect LinkedIn again in Social Media.', { retryable: false }), { apiStatus: String(r.status) });
    const person = String(this.author()).startsWith('urn:li:person:');
    if (person && String(this.author()) !== `urn:li:person:${j.sub}`) throw Object.assign(new PortalError('BAD_TOKEN', 'This token belongs to a different LinkedIn profile than the one saved. Connect LinkedIn again in Social Media.', { retryable: false }), { apiStatus: String(r.status) });
    return { ok: true, summary: `Connected: signed in to LinkedIn as "${j.name || j.sub}". Nothing was posted.${person ? '' : ' (Posting to a Company Page also needs LinkedIn\'s approval of the Community Management API and a Page administrator.)'}`, apiStatus: String(r.status), channel: j.name || j.sub };
  }

  urlOf(urn) { return `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`; }

  async send(text, ctx = {}) {
    const body = {
      author: this.author(),
      commentary: escapeLittleText(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    const r = await this.api('POST', '/rest/posts', { json: body });
    const urn = r.header && r.header('x-restli-id');
    if (!urn) throw new PortalError('PORTAL_REJECTED', 'LinkedIn answered but gave no post id, so TeamLink cannot say it is posted.', { retryable: false });
    await this.log.info('api', `LinkedIn answered ${r.status}: post ${urn} created`);
    void ctx;
    return { id: urn, url: this.urlOf(urn), apiStatus: String(r.status) };
  }

  async edit(id, text) {
    const r = await this.api('POST', `/rest/posts/${encodeURIComponent(id)}`, { json: { patch: { $set: { commentary: escapeLittleText(text) } } }, headers: { 'X-RestLi-Method': 'PARTIAL_UPDATE' } });
    await this.log.info('api', `LinkedIn answered ${r.status}: post ${id} updated`);
    return { id, url: this.urlOf(id), apiStatus: String(r.status) };
  }

  async testPost(text) {
    const r = await this.send(text);
    return { id: r.id, apiStatus: r.apiStatus };
  }
}
LinkedInPostAdapter.escapeLittleText = escapeLittleText;
module.exports = LinkedInPostAdapter;
