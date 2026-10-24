// ---------------------------------------------------------------------------
// FACEBOOK PAGE adapter: the official Graph API (https://developers.facebook.com/docs/pages-api), free.
//   username = the Page number (Page id), password = a PAGE access token with the pages_manage_posts permission
//   (from an approved Meta app: docs/job-publishing/FACEBOOK.md).
//   Test connection  GET /{page-id}?fields=id,name  (reads the page name, SENDS NOTHING)
//   Post             POST /{page-id}/feed   { message }
//   Post update      POST /{post-id}        { message }   (edits the post that is already there)
// Errors are mapped to plain words: token not accepted (190), page not found, no permission, rate limit.
// The base address is https://graph.facebook.com/v19.0 unless TL_FACEBOOK_GRAPH_BASE or the Admin setting
// jobpublish.api.facebook.base says otherwise (the tests use a local fake server).
// ---------------------------------------------------------------------------
const ApiPortal = require('../api/ApiPortal');
const { PORTALS, ERRORS } = require('../../jobPublish/constants');
const { PortalError } = require('../base/errors');

class FacebookAdapter extends ApiPortal {
  static get meta() { return { ...PORTALS.facebook }; }

  envBase() { return 'TL_FACEBOOK_GRAPH_BASE'; }

  defaultBase() { return 'https://graph.facebook.com/v19.0'; }

  token() { return this.creds && this.creds.password; }

  page() { return this.creds && this.creds.username; }

  async api(method, path, { query = null, form = null } = {}) {
    if (!this.token() || !this.page()) throw new PortalError('NO_CREDENTIALS', ERRORS.NO_CREDENTIALS.words, { retryable: false });
    const base = await this.base();
    let url = `${base}/${path}`;
    let r;
    if (method === 'GET') {
      url += `?${new URLSearchParams({ ...(query || {}), access_token: this.token() }).toString()}`;
      r = await this.call('GET', url);
    } else r = await this.call('POST', url, { form: { ...(form || {}), access_token: this.token() } });
    const j = r.json || {};
    if (r.status >= 200 && r.status < 300 && !j.error) return { json: j, status: r.status };
    const e = j.error || {};
    const msg = String(e.message || '').toLowerCase();
    const code = Number(e.code);
    const E = (c, text, o = {}) => Object.assign(new PortalError(c, text || ERRORS[c].words, { retryable: !!ERRORS[c].retry, ...o }), { apiStatus: `${r.status}${e.code ? ` / ${e.code}` : ''}`, retryAfterMs: o.retryAfterMs || null });
    if (code === 190 || (r.status === 401)) throw E('BAD_TOKEN');
    if ([4, 17, 32, 341, 613].includes(code) || r.status === 429) {
      const wait = r.retryAfterMs ? r.retryAfterMs / 1000 : 60;
      throw E('RATE_LIMITED', `Facebook asked us to slow down. TeamLink tries again in about ${Math.round(wait)} seconds.`, { retryAfterMs: wait * 1000, retryable: true });
    }
    if ([200, 10, 299, 283].includes(code) || /permission|not authorized|\(#200\)/.test(msg)) throw E('NOT_ADMIN', `${ERRORS.NOT_ADMIN.words} Facebook says: ${this.scrub(e.message || '').slice(0, 160)}`);
    if (code === 803 || (code === 100 && /does not exist|cannot be loaded|unsupported (get|post) request/.test(msg)) || r.status === 404) throw E('CHANNEL_NOT_FOUND');
    if (r.status >= 500) throw E('NETWORK', 'Facebook had a problem on its side. TeamLink tries again.', { retryable: true });
    throw E('API_ERROR', `${ERRORS.API_ERROR.words} Facebook says: ${this.scrub(e.message || `error ${r.status}`).slice(0, 200)}`);
  }

  async check() {
    const r = await this.api('GET', encodeURIComponent(this.page()), { query: { fields: 'id,name' } });
    const j = r.json;
    if (!j.id) throw Object.assign(new PortalError('CHANNEL_NOT_FOUND', ERRORS.CHANNEL_NOT_FOUND.words, { retryable: false }), { apiStatus: String(r.status) });
    return { ok: true, summary: `Connected: the page "${j.name || j.id}" was read. Nothing was posted. (Posting also needs the pages_manage_posts permission.)`, apiStatus: String(r.status), channel: j.name || j.id };
  }

  urlOf(id) {
    const [pg, post] = String(id).split('_');
    return post ? `https://www.facebook.com/${pg}/posts/${post}` : `https://www.facebook.com/${id}`;
  }

  async send(text) {
    const r = await this.api('POST', `${encodeURIComponent(this.page())}/feed`, { form: { message: text } });
    const id = r.json && r.json.id;
    if (!id) throw new PortalError('PORTAL_REJECTED', 'Facebook answered but gave no post id, so TeamLink cannot say it is posted.', { retryable: false });
    await this.log.info('api', `Facebook answered ${r.status}: post ${id} created`);
    return { id, url: this.urlOf(id), apiStatus: String(r.status) };
  }

  async edit(id, text) {
    const r = await this.api('POST', encodeURIComponent(id), { form: { message: text } });
    if (!(r.json && (r.json.success === true || r.json.id))) throw new PortalError('API_ERROR', 'Facebook did not confirm the change.', { retryable: false });
    await this.log.info('api', `Facebook answered ${r.status}: post ${id} updated`);
    return { id, url: this.urlOf(id), apiStatus: String(r.status) };
  }

  async testPost(text) {
    const r = await this.send(text);
    return { id: r.id, apiStatus: r.apiStatus };
  }
}
module.exports = FacebookAdapter;
