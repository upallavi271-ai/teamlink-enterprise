// ---------------------------------------------------------------------------
// AI MARKETING > POSTING (2026-11-14): publishes an approved picture / video with its caption to a connected FACEBOOK PAGE, INSTAGRAM professional account or X account through
// Meta's Graph API. The accounts are the ones an Admin connected in Administration > Integrations > Social Media ("Connect with Facebook": every Page that login can
// manage, with its linked Instagram account); an agency posts for a client once the client has made that Facebook login an admin of the Page (or given the agency's
// Meta Business access). LinkedIn / X / WhatsApp are NOT posted from here: they stay "post by hand".
//   Facebook  picture  POST /{page}/photos {url, caption}         video  POST /{page}/videos {file_url, description}        (no media: /{page}/feed {message})
//   Instagram picture  POST /{ig}/media {image_url (JPEG), caption} -> POST /{ig}/media_publish {creation_id}
//             video    POST /{ig}/media {media_type: REELS, video_url, caption} -> wait until the video is processed -> media_publish
// The media is fetched by Meta from our public link (/api/mk-image/<id>/<signature>.<ext>: approved items only), so the site address must be https and reachable.
// The token goes in the Authorization HEADER only and never in an address, a body, a log, an audit row or a message; Meta's errors are turned into plain sentences.
// Test hook: TL_FACEBOOK_GRAPH_BASE (a local fake Graph API); MK_PUBLISH_POLL_MS (video processing wait).
// ---------------------------------------------------------------------------
const SA = require('../utils/socialAccounts');

const graphBase = () => String(process.env.TL_FACEBOOK_GRAPH_BASE || 'https://graph.facebook.com/v19.0').replace(/\/+$/, '');
const POLL_MS = () => Math.max(20, Number(process.env.MK_PUBLISH_POLL_MS) || 5000);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

class PublishError extends Error { constructor(message, code = 'meta') { super(message); this.name = 'PublishError'; this.code = code; } }

function plain(err, platform) {
  const c = Number(err && err.code); const sub = Number(err && err.error_subcode); const m = String((err && err.message) || '').replace(/access_token=[^&\s"]+/gi, 'access_token=…');
  const who = platform === 'instagram' ? 'Instagram' : 'Facebook';
  if (c === 190 || /access token|session has expired|has expired|invalid oauth/i.test(m)) return `The ${who} sign-in for this account has expired or was removed. An Admin connects it again in Administration > Integrations > Social Media.`;
  if (c === 200 || c === 10 || c === 220 || c === 3 || /permission|not authorized|does not have/i.test(m)) return `This ${who} login is not allowed to post on that account. The client must make your Facebook login an admin of the Page (or give your Meta Business access), then connect it again.`;
  if (c === 4 || c === 17 || c === 32 || c === 368 || c === 613 || sub === 2207042 || /too many|rate limit|limit reached/i.test(m)) return `${who} says this account has posted too much for now (Instagram allows 25 posts a day). Try again later.`;
  if (sub === 2207026 || /unsupported (video|format)|video.*(codec|format)/i.test(m)) return `${who} could not use this video format. Make the video again as an MP4 (Chrome or Edge) and try again.`;
  if (sub === 2207009 || /aspect ratio|image.*(size|ratio)/i.test(m)) return `${who} refused the picture because of its shape or size. Use a square, 4:5 or 9:16 picture.`;
  if (/image_url|could not (fetch|download|get)|media uri|cannot be reached|url/i.test(m)) return `${who} could not open the picture or video from our site. The site address must be https and open to the internet.`;
  return `${who} said: ${m.slice(0, 180) || `error ${c || ''}`}`;
}

async function graph(method, path, form, token, platform) {
  // the token travels in the Authorization header (Graph API accepts it there): never in the address or the body
  const body = new URLSearchParams(form);
  const headers = { Authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) };
  let res;
  try { res = await fetch(`${graphBase()}/${path}${method === 'GET' ? `?${body.toString()}` : ''}`, { method, headers, ...(method === 'GET' ? {} : { body }), signal: AbortSignal.timeout(90000) }); } catch { throw new PublishError(`${platform === 'instagram' ? 'Instagram' : 'Facebook'} could not be reached from this server. Try again.`, 'unreachable'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j && j.error)) throw new PublishError(plain(j && j.error, platform), 'meta');
  return j;
}

async function toFacebook(acc, token, media, caption) {
  const page = encodeURIComponent(acc.externalId);
  if (media.type === 'video') {
    const j = await graph('POST', `${page}/videos`, { file_url: media.url, description: caption }, token, 'facebook');
    return { id: String(j.id), url: `https://www.facebook.com/${acc.externalId}/videos/${j.id}` };
  }
  if (media.type === 'image') {
    const j = await graph('POST', `${page}/photos`, { url: media.url, caption, published: 'true' }, token, 'facebook');
    return { id: String(j.post_id || j.id), url: `https://www.facebook.com/${j.post_id || j.id}` };
  }
  const j = await graph('POST', `${page}/feed`, { message: caption }, token, 'facebook');
  return { id: String(j.id), url: `https://www.facebook.com/${j.id}` };
}

async function toInstagram(acc, token, media, caption) {
  const ig = encodeURIComponent(acc.externalId);
  if (media.type !== 'image' && media.type !== 'video') throw new PublishError('Instagram needs a picture or a video. This project has none to post.', 'nomedia');
  const form = media.type === 'video' ? { media_type: 'REELS', video_url: media.url, caption } : { image_url: media.jpgUrl || media.url, caption };
  const made = await graph('POST', `${ig}/media`, form, token, 'instagram');
  // Instagram prepares the media first (a video takes a while): wait until it is FINISHED
  for (let i = 0; i < 40; i += 1) {
    const s = await graph('GET', encodeURIComponent(made.id), { fields: 'status_code' }, token, 'instagram'); // eslint-disable-line no-await-in-loop
    if (s.status_code === 'FINISHED' || s.status_code === undefined) break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new PublishError(`Instagram could not process ${media.type === 'video' ? 'the video' : 'the picture'}. Make it again (video as MP4) and try again.`, 'processing');
    if (i === 39) throw new PublishError('Instagram is still preparing the video. Press Retry in a few minutes.', 'slow');
    await sleep(POLL_MS()); // eslint-disable-line no-await-in-loop
  }
  const pub = await graph('POST', `${ig}/media_publish`, { creation_id: made.id }, token, 'instagram');
  let url = '';
  try { const p = await graph('GET', encodeURIComponent(pub.id), { fields: 'permalink' }, token, 'instagram'); url = p.permalink || ''; } catch { url = ''; }
  return { id: String(pub.id), url };
}

// ---- X (Twitter): the account's four permanent keys (utils/xKeys.js, OAuth 1.0a). Picture: v1.1 media/upload (base64); video: chunked upload (INIT / APPEND / FINALIZE / STATUS);
// then POST /2/tweets. X allows 280 characters. What X lets a free API plan do is X's rule: its refusals are shown in plain words.
const XK = require('../utils/xKeys');
const fs = require('fs');
const xApi = () => String(process.env.TL_X_API_BASE || 'https://api.x.com/2').replace(/\/+$/, '');
const xUpload = () => String(process.env.TL_X_UPLOAD_BASE || 'https://upload.twitter.com/1.1').replace(/\/+$/, '');
function xPlain(status, j) {
  const m = String((j && ((j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].detail)) || j.detail || j.title || j.error)) || '').slice(0, 180);
  if (status === 401) return 'X did not accept the keys of this account. An Admin connects the X account again in Administration > Integrations > Social Media.';
  if (status === 403 && /duplicate|already/i.test(m)) return 'X refuses a post that is the same as a recent one. Change the words a little.';
  if (status === 403) return `X does not allow this app to post (${m || 'forbidden'}). In the X developer portal the app needs "Read and write" permission and an API plan that allows posting; then make the keys again.`;
  if (status === 429) return 'X says this account has posted too much for now. Try again later.';
  return `X said: ${m || `error ${status}`}`;
}
async function xCall(keys, method, url, { form, json } = {}) {
  const headers = { Authorization: XK.oauth1Header(keys, method, url, form || {}) };
  let body;
  if (form && method !== 'GET') { body = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded'; } else if (json) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(90000) }); } catch { throw new PublishError('X could not be reached from this server. Try again.', 'unreachable'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new PublishError(xPlain(res.status, j), 'x');
  return j;
}
async function toX(acc, token, media, caption) {
  let keys; try { keys = JSON.parse(token); } catch { keys = null; }
  if (!keys || !keys.apiKey) throw new PublishError('The keys of this X account cannot be read. An Admin connects it again in Administration > Integrations > Social Media.', 'keys');
  if (String(caption || '').length > 280) throw new PublishError(`The words are too long for X (280 characters; yours are ${String(caption).length}). Shorten them and try again.`, 'toolong');
  let mediaId = '';
  if ((media.type === 'image' || media.type === 'video') && media.path) {
    const buf = fs.readFileSync(media.path);
    if (media.type === 'image') {
      const j = await xCall(keys, 'POST', `${xUpload()}/media/upload.json`, { form: { media_data: buf.toString('base64'), media_category: 'tweet_image' } });
      mediaId = String(j.media_id_string || j.media_id);
    } else {
      const ini = await xCall(keys, 'POST', `${xUpload()}/media/upload.json`, { form: { command: 'INIT', total_bytes: String(buf.length), media_type: media.mime || 'video/mp4', media_category: 'tweet_video' } });
      mediaId = String(ini.media_id_string || ini.media_id);
      const CH = 1024 * 1024;
      for (let i = 0, seg = 0; i < buf.length; i += CH, seg += 1) await xCall(keys, 'POST', `${xUpload()}/media/upload.json`, { form: { command: 'APPEND', media_id: mediaId, segment_index: String(seg), media_data: buf.subarray(i, i + CH).toString('base64') } }); // eslint-disable-line no-await-in-loop
      let fin = await xCall(keys, 'POST', `${xUpload()}/media/upload.json`, { form: { command: 'FINALIZE', media_id: mediaId } });
      for (let k = 0; fin.processing_info && !['succeeded'].includes(fin.processing_info.state) && k < 40; k += 1) {
        if (fin.processing_info.state === 'failed') throw new PublishError('X could not process the video. Make it again as an MP4 and try again.', 'processing');
        await sleep(Math.max(20, Math.min(POLL_MS(), (Number(fin.processing_info.check_after_secs) || 2) * 1000))); // eslint-disable-line no-await-in-loop
        fin = await xCall(keys, 'GET', `${xUpload()}/media/upload.json?${new URLSearchParams({ command: 'STATUS', media_id: mediaId })}`); // eslint-disable-line no-await-in-loop
      }
    }
  }
  const j = await xCall(keys, 'POST', `${xApi()}/tweets`, { json: { text: caption || '', ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) } });
  const id = j && j.data && j.data.id;
  if (!id) throw new PublishError('X did not confirm the post. Check the account on X before trying again.', 'x');
  return { id: String(id), url: `https://x.com/i/web/status/${id}` };
}

// targets: [{ accountId }]; media: { type: 'image' | 'video' | '', url, jpgUrl, path, mime }; returns one result per target: { accountId, platform, name, ok, url, error }
async function publish(targets, media, caption) {
  const out = [];
  for (const t of targets) { // eslint-disable-line no-restricted-syntax
    const got = await SA.withToken(t.accountId); // eslint-disable-line no-await-in-loop
    if (!got || !got.token) { out.push({ accountId: t.accountId, platform: (got && got.account.platform) || '', name: (got && got.account.name) || 'An account', ok: false, url: '', error: 'This account is not connected any more. An Admin connects it again in Administration > Integrations > Social Media.' }); continue; } // eslint-disable-line no-continue
    const { account } = got;
    const base = { accountId: t.accountId, platform: account.platform, name: account.name };
    if (account.status === 'Expired') { out.push({ ...base, ok: false, url: '', error: 'The sign-in for this account has expired. An Admin connects it again in Administration > Integrations > Social Media.' }); continue; } // eslint-disable-line no-continue
    try {
      const r = account.platform === 'instagram' ? await toInstagram(account, got.token, media, caption) : account.platform === 'facebook' ? await toFacebook(account, got.token, media, caption) : account.platform === 'x' ? await toX(account, got.token, media, caption) : null; // eslint-disable-line no-await-in-loop
      if (!r) out.push({ ...base, ok: false, url: '', error: 'Only Facebook Pages, Instagram and X accounts can be posted to from here. Post this one by hand.' });
      else out.push({ ...base, ok: true, url: r.url, error: '' });
    } catch (e) { out.push({ ...base, ok: false, url: '', error: e instanceof PublishError ? e.message : `It could not be posted (${String(e.message || e).replace(/access_token=[^&\s"]+/gi, 'access_token=…').slice(0, 120)}).` }); }
  }
  return out;
}

module.exports = { publish, plain, PublishError };
