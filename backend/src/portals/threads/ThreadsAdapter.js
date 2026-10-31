// ---------------------------------------------------------------------------
// THREADS adapter: the official Threads API (https://developers.facebook.com/docs/threads), free.
//   username = the Threads profile number, password = a Threads access token with threads_content_publish.
//   Test connection  GET /{id}?fields=id,username  (SENDS NOTHING)
//   Post             1. POST /{id}/threads {media_type: TEXT, text}   2. POST /{id}/threads_publish {creation_id}
//   Post update      not possible: Threads does not let a program change a published post.
// Base address https://graph.threads.net/v1.0 unless TL_THREADS_GRAPH_BASE (or the Admin setting jobpublish.api.threads.base).
// ---------------------------------------------------------------------------
const ApiPortal = require('../api/ApiPortal');
const { PORTALS, ERRORS } = require('../../jobPublish/constants');
const { PortalError } = require('../base/errors');

class ThreadsAdapter extends ApiPortal {
  static get meta() { return { ...PORTALS.threads }; }

  envBase() { return 'TL_THREADS_GRAPH_BASE'; }

  defaultBase() { return 'https://graph.threads.net/v1.0'; }

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
      throw E('RATE_LIMITED', `Threads asked us to slow down. TeamLink tries again in about ${Math.round(wait)} seconds.`, { retryAfterMs: wait * 1000, retryable: true });
    }
    if ([200, 10, 299, 283].includes(code) || /permission|not authorized|\(#200\)/.test(msg)) throw E('NOT_ADMIN', `${ERRORS.NOT_ADMIN.words} Threads says: ${this.scrub(e.message || '').slice(0, 160)}`);
    if (code === 803 || (code === 100 && /does not exist|cannot be loaded|unsupported (get|post) request/.test(msg)) || r.status === 404) throw E('CHANNEL_NOT_FOUND', 'The Threads profile was not found. Connect Threads again in Social Media.');
    if (r.status >= 500) throw E('NETWORK', 'Threads had a problem on its side. TeamLink tries again.', { retryable: true });
    throw E('API_ERROR', `${ERRORS.API_ERROR.words} Threads says: ${this.scrub(e.message || `error ${r.status}`).slice(0, 200)}`);
  }

  async check() {
    const r = await this.api('GET', encodeURIComponent(this.account()), { query: { fields: 'id,username' } });
    const j = r.json;
    if (!j.id) throw Object.assign(new PortalError('CHANNEL_NOT_FOUND', 'The Threads profile was not found. Connect Threads again in Social Media.', { retryable: false }), { apiStatus: String(r.status) });
    return { ok: true, summary: `Connected: the Threads profile "${j.username ? `@${j.username}` : j.id}" was read. Nothing was posted. (Posting also needs the threads_content_publish permission.)`, apiStatus: String(r.status), channel: j.username || j.id };
  }

  async send(text, ctx = {}) {
    const acc = encodeURIComponent(this.account());
    const form = { media_type: 'TEXT', text };
    if (ctx.replyTo) form.reply_to_id = String(ctx.replyTo);
    const made = await this.api('POST', `${acc}/threads`, { form });
    const creation = made.json && made.json.id;
    if (!creation) throw new PortalError('PORTAL_REJECTED', 'Threads answered but gave no post id, so nothing was posted.', { retryable: false });
    await this.checkpoint('publish');
    const pub = await this.api('POST', `${acc}/threads_publish`, { form: { creation_id: creation } });
    const id = pub.json && pub.json.id;
    if (!id) throw new PortalError('PORTAL_REJECTED', 'Threads answered but gave no post id, so TeamLink cannot say it is posted.', { retryable: false });
    let url = null;
    try { const p = await this.api('GET', encodeURIComponent(id), { query: { fields: 'permalink' } }); url = (p.json && p.json.permalink) || null; } catch { url = null; }
    await this.log.info('api', `Threads answered ${pub.status}: post ${id} created`);
    return { id, url, apiStatus: String(pub.status) };
  }

  async edit() {
    throw new PortalError('API_ERROR', 'Threads does not let a program change a post after it is published. Delete the post in Threads if it is wrong, then post the job again.', { retryable: false });
  }

  async testPost(text) {
    const r = await this.send(text);
    return { id: r.id, apiStatus: r.apiStatus };
  }
}
module.exports = ThreadsAdapter;
