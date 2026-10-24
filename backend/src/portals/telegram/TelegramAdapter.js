// ---------------------------------------------------------------------------
// TELEGRAM adapter: the official Bot API (https://core.telegram.org/bots/api), free.
//   username = the channel ("@mychannel" or the number -100123...), password = the bot token from @BotFather.
//   Test connection  getMe + getChat + getChatMember: is the token good, is the channel there, is the bot an administrator who
//                    may post. SENDS NOTHING.
//   Post             sendMessage (plain text, no formatting mode, so nothing in a job text can break the message)
//   Post update      editMessageText on the message that is already there (never a second message)
// Errors are mapped to plain words: wrong token, channel not found, bot not an administrator, rate limit (429 retry_after).
// The base address is https://api.telegram.org unless TL_TELEGRAM_API_BASE or the Admin setting jobpublish.api.telegram.base says
// otherwise (the tests use a local fake server).
// ---------------------------------------------------------------------------
const ApiPortal = require('../api/ApiPortal');
const { PORTALS, ERRORS } = require('../../jobPublish/constants');
const { PortalError } = require('../base/errors');

class TelegramAdapter extends ApiPortal {
  static get meta() { return { ...PORTALS.telegram }; }

  envBase() { return 'TL_TELEGRAM_API_BASE'; }

  defaultBase() { return 'https://api.telegram.org'; }

  token() { return this.creds && this.creds.password; }

  chat() { return this.creds && this.creds.username; }

  // One Bot API method. Answers { ok:true, result } or throws a PortalError in plain words.
  async api(method, payload) {
    if (!this.token() || !this.chat()) throw new PortalError('NO_CREDENTIALS', ERRORS.NO_CREDENTIALS.words, { retryable: false });
    const base = await this.base();
    const r = await this.call('POST', `${base}/bot${this.token()}/${method}`, { json: payload || {} });
    const j = r.json || {};
    if (r.status >= 200 && r.status < 300 && j.ok) return { result: j.result, status: r.status };
    const desc = String(j.description || '').toLowerCase();
    const code = Number(j.error_code || r.status);
    const E = (c, msg, o = {}) => Object.assign(new PortalError(c, msg || ERRORS[c].words, { retryable: !!ERRORS[c].retry, ...o }), { apiStatus: `${r.status}${j.error_code ? ` / ${j.error_code}` : ''}`, retryAfterMs: o.retryAfterMs || null });
    if (code === 429 || r.status === 429) {
      const wait = Number(j.parameters && j.parameters.retry_after) || (r.retryAfterMs ? r.retryAfterMs / 1000 : 30);
      throw E('RATE_LIMITED', `Telegram asked us to wait ${wait} seconds before the next message. TeamLink tries again after that.`, { retryAfterMs: wait * 1000, retryable: true });
    }
    if (code === 401 || (r.status === 404 && (!j.description || desc === 'not found'))) throw E('BAD_TOKEN');
    if (code === 400 && /chat not found|peer_id_invalid|chat_id is empty/.test(desc)) throw E('CHANNEL_NOT_FOUND');
    if (code === 403 || /not enough rights|have no rights|bot is not a member|bot was kicked|need administrator|not a member/.test(desc)) throw E('NOT_ADMIN');
    if (/message is too long|message_too_long/.test(desc)) throw E('MESSAGE_TOO_LONG');
    if (/message is not modified/.test(desc)) return { result: null, status: r.status, unchanged: true };
    if (r.status >= 500) throw E('NETWORK', 'Telegram had a problem on its side. TeamLink tries again.', { retryable: true });
    throw E('API_ERROR', `${ERRORS.API_ERROR.words} Telegram says: ${this.scrub(j.description || `error ${r.status}`).slice(0, 200)}`);
  }

  async check() {
    const me = await this.api('getMe');
    const bot = me.result || {};
    const chat = await this.api('getChat', { chat_id: this.chat() });
    const title = (chat.result && (chat.result.title || chat.result.username)) || String(this.chat());
    const mem = await this.api('getChatMember', { chat_id: this.chat(), user_id: bot.id });
    const m = mem.result || {};
    const status = String(m.status || '');
    if (!['administrator', 'creator'].includes(status)) throw Object.assign(new PortalError('NOT_ADMIN', `The bot @${bot.username || '?'} is in "${title}" but is not an administrator. Add it as an administrator with the right to post messages.`, { retryable: false }), { apiStatus: '200' });
    if (status === 'administrator' && m.can_post_messages === false) throw Object.assign(new PortalError('NOT_ADMIN', `The bot @${bot.username || '?'} is an administrator of "${title}" but is not allowed to post messages. Turn on "Post messages" for the bot.`, { retryable: false }), { apiStatus: '200' });
    return { ok: true, summary: `Connected: the bot @${bot.username || '?'} is an administrator of "${title}" and can post. Nothing was sent.`, apiStatus: '200', bot: bot.username || null, channel: title };
  }

  async send(text, ctx = {}) {
    const payload = { chat_id: this.chat(), text };
    if (ctx.replyTo) { payload.reply_parameters = { message_id: Number(ctx.replyTo), allow_sending_without_reply: true }; }
    const r = await this.api('sendMessage', payload);
    const id = r.result && r.result.message_id;
    if (!id) throw new PortalError('PORTAL_REJECTED', 'Telegram answered but gave no message number, so TeamLink cannot say it is posted.', { retryable: false });
    const name = String(this.chat());
    await this.log.info('api', `Telegram answered ${r.status}: message ${id} posted`);
    return { id, url: name.startsWith('@') ? `https://t.me/${name.slice(1)}/${id}` : null, apiStatus: String(r.status) };
  }

  async edit(id, text) {
    const r = await this.api('editMessageText', { chat_id: this.chat(), message_id: Number(id), text });
    await this.log.info('api', `Telegram answered ${r.status}: message ${id} ${r.unchanged ? 'was already the same' : 'updated'}`);
    const name = String(this.chat());
    return { id, url: name.startsWith('@') ? `https://t.me/${name.slice(1)}/${id}` : null, apiStatus: String(r.status) };
  }

  async testPost(text) {
    const r = await this.send(text);
    return { id: r.id, apiStatus: r.apiStatus };
  }
}
module.exports = TelegramAdapter;
