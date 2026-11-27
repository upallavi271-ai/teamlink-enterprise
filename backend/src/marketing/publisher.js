// ---------------------------------------------------------------------------
// AI MARKETING > POSTING (2026-11-14): publishes an approved picture / video with its caption to a connected FACEBOOK PAGE, INSTAGRAM professional account, X account, LINKEDIN profile / Page or YOUTUBE channel
// (Facebook and Instagram through Meta's Graph API). The accounts are the ones an Admin connected in Administration > Integrations > Social Media ("Connect with Facebook": every Page that login can
// manage, with its linked Instagram account); an agency posts for a client once the client has made that Facebook login an admin of the Page (or given the agency's
// Meta Business access). WhatsApp is NOT posted from here: it stays "post by hand".
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

// ---- LINKEDIN (2026-11-27): the profile that connected, or a Company Page the same sign-in may post for (Administration > Integrations > Social Media). LinkedIn's free "Share on LinkedIn" route:
// a picture / video is registered (/v2/assets?action=registerUpload), sent to the address LinkedIn gives, then posted with /v2/ugcPosts. The words are plain text. A Company Page also needs LinkedIn's
// approval of the app (Community Management API) and a Page administrator; without it LinkedIn refuses and says so.
const liApi = () => String(process.env.TL_LINKEDIN_API_BASE || 'https://api.linkedin.com').replace(/\/+$/, '');
const LI_VIDEO_MAX = 200 * 1024 * 1024; // one-piece upload
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
// the token is only ever sent to LinkedIn: the upload address it gives must be LinkedIn's own
const liUploadOk = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(x.hostname)) || x.origin === originOf(liApi()); } catch { return false; } };
function liPlain(status, j, page, token) {
  const m = String((j && (j.message || j.error_description)) || '').split(token || '\u0000').join('…').slice(0, 180);
  if (status === 401) return 'The LinkedIn sign-in has expired or was removed (it lasts 60 days). An Admin presses Connect LinkedIn again in Administration > Integrations > Social Media.';
  if (/duplicate/i.test(m)) return 'LinkedIn refuses a post that is the same as a recent one. Change the words a little.';
  if (status === 403) return page ? `LinkedIn does not allow this sign-in to post for that Company Page. The app needs LinkedIn's Community Management API approval and the person must be an administrator of the Page (${m || 'forbidden'}).` : `LinkedIn does not allow this sign-in to post (${m || 'forbidden'}). Connect LinkedIn again and allow posting.`;
  if (status === 429) return 'LinkedIn says this account has posted too much for now. Try again tomorrow.';
  return `LinkedIn said: ${m || `error ${status}`}`;
}
async function liCall(token, method, url, { json, body, headers = {}, page = false, ms = 90000 } = {}) {
  const h = { Authorization: `Bearer ${token}`, ...(body ? {} : { 'X-Restli-Protocol-Version': '2.0.0' }), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers };
  let res;
  try { res = await fetch(url, { method, headers: h, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(ms) }); } catch { throw new PublishError('LinkedIn could not be reached from this server. Check the account before trying again.', 'unreachable'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new PublishError(liPlain(res.status, j, page, token), 'linkedin');
  return { json: j || {}, header: (n) => res.headers.get(n) };
}
// a video is prepared by LinkedIn first: wait while LinkedIn says it is still working (if it will not say, the post is tried as it is)
async function liReady(token, asset) {
  const id = encodeURIComponent(String(asset).split(':').pop());
  for (let i = 0; i < 40; i += 1) {
    let state = '';
    try { const r = await liCall(token, 'GET', `${liApi()}/v2/assets/${id}`); state = String(((r.json.recipes || [])[0] || {}).status || ''); } catch { return; } // eslint-disable-line no-await-in-loop
    if (!state || state === 'AVAILABLE') return;
    if (/ERROR|ABANDONED/.test(state)) throw new PublishError('LinkedIn could not process the video. Make it again as an MP4 and try again.', 'processing');
    if (i === 39) throw new PublishError('LinkedIn is still preparing the video. Press Retry in a few minutes.', 'slow');
    await sleep(POLL_MS()); // eslint-disable-line no-await-in-loop
  }
}
async function toLinkedIn(acc, token, media, caption) {
  const author = String(acc.externalId || ''); const page = author.includes(':organization:');
  if (String(caption || '').length > 3000) throw new PublishError(`The words are too long for LinkedIn (3000 characters; yours are ${String(caption).length}).`, 'toolong');
  const kind = media.type === 'image' || media.type === 'video' ? media.type : '';
  let asset = '';
  if (kind) {
    if (!media.path) throw new PublishError('The file of this picture or video is not on the server any more.', 'nomedia');
    const buf = fs.readFileSync(media.path);
    if (kind === 'video' && buf.length > LI_VIDEO_MAX) throw new PublishError('The video is larger than 200 MB, too large to send to LinkedIn from here.', 'toobig');
    const reg = await liCall(token, 'POST', `${liApi()}/v2/assets?action=registerUpload`, { page, json: { registerUploadRequest: { recipes: [`urn:li:digitalmediaRecipe:feedshare-${kind}`], owner: author, serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }] } } });
    const v = reg.json.value || {}; const how = (v.uploadMechanism || {})['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'] || {}; asset = String(v.asset || '');
    if (!asset || !how.uploadUrl || !liUploadOk(how.uploadUrl)) throw new PublishError('LinkedIn did not give a place to send the file. Try again.', 'linkedin');
    await liCall(token, 'PUT', how.uploadUrl, { page, body: buf, headers: { ...(how.headers || {}), 'Content-Type': media.mime || 'application/octet-stream' }, ms: 300000 });
    if (kind === 'video') await liReady(token, asset);
  }
  const share = { shareCommentary: { text: String(caption || '') }, shareMediaCategory: kind ? kind.toUpperCase() : 'NONE', ...(kind ? { media: [{ status: 'READY', media: asset }] } : {}) };
  const r = await liCall(token, 'POST', `${liApi()}/v2/ugcPosts`, { page, json: { author, lifecycleState: 'PUBLISHED', specificContent: { 'com.linkedin.ugc.ShareContent': share }, visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' } } });
  const id = r.header('x-restli-id') || r.json.id;
  if (!id) throw new PublishError('LinkedIn did not confirm the post. Check the account on LinkedIn before trying again.', 'linkedin');
  return { id: String(id), url: `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/` };
}

// ---- YOUTUBE (2026-11-27): videos only, to a channel connected with "Connect YouTube". Google's free YouTube Data API: the saved lasting key gives a one-hour key, then a resumable upload
// (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol). The title is the first line of the words; posted public and "not made for kids" (the screen says so).
const ytUpload = () => String(process.env.TL_YOUTUBE_UPLOAD_BASE || 'https://www.googleapis.com/upload/youtube/v3').replace(/\/+$/, '');
const ytTokenUrl = () => String(process.env.TL_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token');
const YT_RECONNECT = 'The YouTube sign-in has expired or was removed. An Admin presses Connect YouTube again in Administration > Integrations > Social Media.';
const noTags = (v) => String(v || '').replace(/[<>]/g, '');
const ytTitle = (caption, fallback) => noTags(String(caption || '').split('\n').map((l) => l.replace(/#[^\s#]+/g, '').replace(/\s+/g, ' ').trim()).find(Boolean) || fallback || 'Video').slice(0, 100).trim() || 'Video';
function ytPlain(status, j) {
  const e = (j && j.error) || {}; const reason = String(((e.errors || [])[0] || {}).reason || ''); const m = String(e.message || j.error_description || '').replace(/<[^>]*>/g, '').slice(0, 180);
  if (status === 401) return YT_RECONNECT;
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || /quota/i.test(m)) return "YouTube's free daily limit is used up. Try again tomorrow.";
  if (reason === 'uploadLimitExceeded') return 'YouTube says this channel has uploaded too many videos for today. Try again tomorrow.';
  if (reason === 'youtubeSignupRequired') return 'This Google account has no YouTube channel. Connect the account that owns the channel.';
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(m)) return '"YouTube Data API v3" is not switched on in the Google Cloud project of the app. Open APIs & Services > Library, press Enable and try again.';
  if (status === 403) return `YouTube does not allow this sign-in to upload (${m || 'forbidden'}). Press Connect YouTube again and allow uploading.`;
  return `YouTube said: ${m || `error ${status}`}`;
}
async function ytFetch(url, init, ms = 60000) {
  let res;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); } catch { throw new PublishError('YouTube could not be reached or did not answer in time. Check the channel before trying again.', 'unreachable'); }
  return res;
}
async function ytAccess(saved) {
  if (/^ya29\./.test(saved)) return saved; // a one-hour key saved without a lasting one
  const app = await require('../utils/youtubeConnect').readApp(); // eslint-disable-line global-require
  if (!app.id || !app.secret) throw new PublishError('The YouTube Client ID and Client secret are missing (Administration > Integrations > Social Media > YouTube).', 'keys');
  const res = await ytFetch(ytTokenUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved, client_id: app.id, client_secret: app.secret }).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new PublishError(res.status >= 500 ? 'Google had a problem signing in. Try again in a few minutes.' : YT_RECONNECT, 'keys');
  return j.access_token;
}
async function toYouTube(acc, saved, media, caption) {
  if (media.type !== 'video') throw new PublishError('YouTube takes videos only.', 'nomedia');
  if (!media.path) throw new PublishError('The video file is not on the server any more.', 'nomedia');
  const buf = fs.readFileSync(media.path); const mime = media.mime || 'video/mp4';
  const access = await ytAccess(saved);
  const start = await ytFetch(`${ytUpload()}/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(buf.length), 'X-Upload-Content-Type': mime },
    body: JSON.stringify({ snippet: { title: ytTitle(caption, media.title), description: noTags(caption).slice(0, 4900), categoryId: '22' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }),
  });
  if (!start.ok) throw new PublishError(ytPlain(start.status, await start.json().catch(() => ({}))), 'youtube');
  const where = start.headers.get('location') || '';
  let ok = false; try { const x = new URL(where); ok = (x.protocol === 'https:' && /(^|\.)googleapis\.com$/i.test(x.hostname)) || x.origin === originOf(ytUpload()); } catch { ok = false; }
  if (!ok) throw new PublishError('YouTube did not give a place to send the video. Try again.', 'youtube');
  const sent = await ytFetch(where, { method: 'PUT', headers: { Authorization: `Bearer ${access}`, 'Content-Type': mime }, body: buf }, 600000);
  const j = await sent.json().catch(() => ({}));
  if (!sent.ok) throw new PublishError(ytPlain(sent.status, j), 'youtube');
  if (!j.id) throw new PublishError('YouTube did not confirm the video. Check the channel before trying again.', 'youtube');
  const hidden = j.status && j.status.privacyStatus && j.status.privacyStatus !== 'public';
  return { id: String(j.id), url: `https://youtu.be/${j.id}`, note: hidden ? `YouTube set it to ${j.status.privacyStatus}: change it in YouTube Studio.` : '' };
}

// every platform TeamLink can post to, its name, and those that fetch the file from our own https address
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube'];
const WORD = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', youtube: 'YouTube' };
const NEEDS_SITE = ['facebook', 'instagram'];
const SENDERS = { facebook: toFacebook, instagram: toInstagram, linkedin: toLinkedIn, x: toX, youtube: toYouTube };

// targets: [{ accountId }]; media: { type: 'image' | 'video' | '', url, jpgUrl, path, mime, title }; returns one result per target: { accountId, platform, name, ok, url, error }
async function publish(targets, media, caption) {
  const out = [];
  for (const t of targets) { // eslint-disable-line no-restricted-syntax
    const got = await SA.withToken(t.accountId); // eslint-disable-line no-await-in-loop
    if (!got || !got.token) { out.push({ accountId: t.accountId, platform: (got && got.account.platform) || '', name: (got && got.account.name) || 'An account', ok: false, url: '', error: 'This account is not connected any more. An Admin connects it again in Administration > Integrations > Social Media.' }); continue; } // eslint-disable-line no-continue
    const { account } = got;
    const base = { accountId: t.accountId, platform: account.platform, name: account.name };
    if (account.status === 'Expired') { out.push({ ...base, ok: false, url: '', error: 'The sign-in for this account has expired. An Admin connects it again in Administration > Integrations > Social Media.' }); continue; } // eslint-disable-line no-continue
    try {
      const send = SENDERS[account.platform];
      const r = send ? await send(account, got.token, media, caption) : null; // eslint-disable-line no-await-in-loop
      if (!r) out.push({ ...base, ok: false, url: '', error: 'Only Facebook, Instagram, LinkedIn, X and YouTube accounts can be posted to from here. Post this one by hand.' });
      else out.push({ ...base, ok: true, url: r.url, error: '', ...(r.note ? { note: r.note } : {}) });
    } catch (e) { out.push({ ...base, ok: false, url: '', error: e instanceof PublishError ? e.message : `It could not be posted (${String(e.message || e).replace(/access_token=[^&\s"]+/gi, 'access_token=…').slice(0, 120)}).` }); }
  }
  return out;
}

module.exports = { publish, plain, PublishError, PLATFORMS, WORD, NEEDS_SITE, ytTitle };
