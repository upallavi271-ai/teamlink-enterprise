// ---------------------------------------------------------------------------
// INSTAGRAM adapter: the official Instagram content publishing API (the Graph API, free), for an Instagram professional account that is
// linked to a Facebook Page.
//   username = the Instagram account number (found by itself when the Facebook Page is connected in Social Media),
//   password = the access token (the Page token with instagram_content_publish).
//   Test connection  GET /{ig-id}?fields=id,username  (reads the account name, SENDS NOTHING)
//   Post             1. POST /{ig-id}/media {image_url, caption}   2. POST /{ig-id}/media_publish {creation_id}
//                    The picture is TeamLink's own job card (utils/jobCard.js) at <APP_BASE_URL>/api/public/job-card/<job>.jpg:
//                    Instagram's servers fetch it, so the site address must be public (https).
//   Post update      not possible: Instagram does not let a program change a published post (said in plain words).
// The base address is https://graph.facebook.com/v19.0 unless TL_FACEBOOK_GRAPH_BASE (or the Admin setting jobpublish.api.instagram.base).
// ---------------------------------------------------------------------------
const ApiPortal = require('../api/ApiPortal');
const { PORTALS, ERRORS } = require('../../jobPublish/constants');
const { PortalError } = require('../base/errors');

class InstagramAdapter extends ApiPortal {
  static get meta() { return { ...PORTALS.instagram }; }

  envBase() { return 'TL_FACEBOOK_GRAPH_BASE'; }

  defaultBase() { return 'https://graph.facebook.com/v19.0'; }

  token() { return this.creds && this.creds.password; }

  account() { return this.creds && this.creds.username; }

  async api(method, path, { query = null, form = null } = {}) {
    if (!this.token() || !this.account()) throw new PortalError('NO_CREDENTIALS', ERRORS.NO_CREDENTIALS.words, { retryable: false });
    const base = await this.base();
    let url = `${base}/${path}`;
    let r;
    if (method === 'GET') {
      url += `?${new URLSearchParams({ ...(query || {}), access_token: this.token() }).toString()}`;
      r = await this.call('GET', url);
    } else r = await this.call('POST', url, { form: { ...(form || {}), access_token: this.token() }, timeoutMs: 30000 });
    const j = r.json || {};
    if (r.status >= 200 && r.status < 300 && !j.error) return { json: j, status: r.status };
    const e = j.error || {};
    const msg = String(e.message || '').toLowerCase();
    const code = Number(e.code);
    const E = (c, text, o = {}) => Object.assign(new PortalError(c, text || ERRORS[c].words, { retryable: !!ERRORS[c].retry, ...o }), { apiStatus: `${r.status}${e.code ? ` / ${e.code}` : ''}`, retryAfterMs: o.retryAfterMs || null });
    if (code === 190 || r.status === 401) throw E('BAD_TOKEN');
    if ([4, 17, 32, 341, 613].includes(code) || r.status === 429) {
      const wait = r.retryAfterMs ? r.retryAfterMs / 1000 : 60;
      throw E('RATE_LIMITED', `Instagram asked us to slow down. TeamLink tries again in about ${Math.round(wait)} seconds.`, { retryAfterMs: wait * 1000, retryable: true });
    }
    if (code === 9007 || /media (is )?not ready|not ready for publishing/.test(msg)) throw E('NETWORK', 'Instagram was still preparing the picture. TeamLink tries again.', { retryable: true });
    if ([200, 10, 299, 283].includes(code) || /permission|not authorized|\(#200\)/.test(msg)) throw E('NOT_ADMIN', `${ERRORS.NOT_ADMIN.words} Instagram says: ${this.scrub(e.message || '').slice(0, 160)}`);
    if (code === 9004 || /image|media uri|download/.test(msg)) throw E('API_ERROR', `Instagram could not download the job picture from this website (${this.scrub(e.message || '').slice(0, 140)}). The website address must be public (https) so Instagram can reach it.`);
    if (code === 803 || (code === 100 && /does not exist|cannot be loaded|unsupported (get|post) request/.test(msg)) || r.status === 404) throw E('CHANNEL_NOT_FOUND', 'The Instagram account was not found. Connect the Facebook Page again in Social Media.');
    if (r.status >= 500) throw E('NETWORK', 'Instagram had a problem on its side. TeamLink tries again.', { retryable: true });
    throw E('API_ERROR', `${ERRORS.API_ERROR.words} Instagram says: ${this.scrub(e.message || `error ${r.status}`).slice(0, 200)}`);
  }

  async check() {
    const r = await this.api('GET', encodeURIComponent(this.account()), { query: { fields: 'id,username' } });
    const j = r.json;
    if (!j.id) throw Object.assign(new PortalError('CHANNEL_NOT_FOUND', 'The Instagram account was not found. Connect the Facebook Page again in Social Media.', { retryable: false }), { apiStatus: String(r.status) });
    return { ok: true, summary: `Connected: the Instagram account "${j.username ? `@${j.username}` : j.id}" was read. Nothing was posted. (Posting also needs the instagram_content_publish permission.)`, apiStatus: String(r.status), channel: j.username || j.id };
  }

  imageUrl(requirementId) {
    const root = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    if (!/^https:\/\//i.test(root) && process.env.TL_API_STRICT_LOCAL !== '1') {
      throw new PortalError('API_ERROR', 'Instagram needs a public https website address to fetch the job picture, and this server has none set (APP_BASE_URL). Ask the developer to set it.', { retryable: false });
    }
    return `${root}/api/public/job-card/${encodeURIComponent(requirementId)}.jpg`;
  }

  async send(text, ctx = {}) {
    if (ctx.replyTo) throw new PortalError('API_ERROR', 'Instagram has no closing note.', { retryable: false });
    const requirementId = ctx.requirementId || (this.ctx && this.ctx.requirementId);
    if (!requirementId) throw new PortalError('API_ERROR', 'Instagram posts need a job: nothing to post.', { retryable: false });
    const acc = encodeURIComponent(this.account());
    const made = await this.api('POST', `${acc}/media`, { form: { image_url: this.imageUrl(requirementId), caption: text } });
    const creation = made.json && made.json.id;
    if (!creation) throw new PortalError('PORTAL_REJECTED', 'Instagram answered but gave no picture id, so nothing was posted.', { retryable: false });
    await this.log.info('api', `Instagram answered ${made.status}: picture ${creation} prepared`);
    // the picture is fetched by Instagram: wait (a few seconds at most) until it says it is ready
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const st = await this.api('GET', encodeURIComponent(creation), { query: { fields: 'status_code' } }).catch(() => null);
      const code = st && st.json && st.json.status_code;
      if (!code || code === 'FINISHED') break;
      if (code === 'ERROR' || code === 'EXPIRED') throw new PortalError('API_ERROR', 'Instagram could not use the job picture. The website address must be public (https) so Instagram can fetch it.', { retryable: false });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((ok) => { setTimeout(ok, process.env.TL_API_STRICT_LOCAL === '1' ? 5 : 2500); });
    }
    await this.checkpoint('publish');
    const pub = await this.api('POST', `${acc}/media_publish`, { form: { creation_id: creation } });
    const id = pub.json && pub.json.id;
    if (!id) throw new PortalError('PORTAL_REJECTED', 'Instagram answered but gave no post id, so TeamLink cannot say it is posted.', { retryable: false });
    let url = null;
    try { const p = await this.api('GET', encodeURIComponent(id), { query: { fields: 'permalink' } }); url = (p.json && p.json.permalink) || null; } catch { url = null; }
    await this.log.info('api', `Instagram answered ${pub.status}: post ${id} created`);
    return { id, url, apiStatus: String(pub.status) };
  }

  async edit() {
    throw new PortalError('API_ERROR', 'Instagram does not let a program change a post after it is published. Delete the post in Instagram if it is wrong, then post the job again.', { retryable: false });
  }

  async testPost() {
    throw new PortalError('API_ERROR', 'Instagram has no test post (every post is a public picture). Use Test connection; the first real job post is the real test.', { retryable: false });
  }
}
module.exports = InstagramAdapter;
