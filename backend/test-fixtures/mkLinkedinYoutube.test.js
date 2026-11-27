// AI Marketing: posting to LinkedIn and YouTube (marketing/publisher.js). LinkedIn and Google are a local stand-in server: nothing leaves this computer and nothing is posted anywhere.
//   node backend/test-fixtures/mkLinkedinYoutube.test.js
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const BACK = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-social-'));
const tmp = path.join(work, 'copy.db');
fs.copyFileSync(path.join(BACK, 'prisma', 'sandbox.db'), tmp);
process.env.DATABASE_URL = `file:${tmp.split(path.sep).join('/')}`; process.env.TEAMLINK_SANDBOX = '1'; process.env.TEST_MODE = '1';
process.env.MK_PUBLISH_POLL_MS = '20'; process.env.YOUTUBE_CLIENT_ID = '123-abc.apps.googleusercontent.com'; process.env.YOUTUBE_CLIENT_SECRET = 'secret-secret-secret';

const IMAGE = path.join(work, 'p.png'); fs.writeFileSync(IMAGE, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const VIDEO = path.join(work, 'v.mp4'); fs.writeFileSync(VIDEO, Buffer.alloc(3000, 7));
const calls = []; const mode = {}; let base = '';
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const raw = Buffer.concat(chunks); let body = null; try { body = JSON.parse(raw.toString()); } catch { body = raw.toString().slice(0, 400); }
    calls.push({ method: req.method, url: req.url, headers: req.headers, body, bytes: raw.length });
    const say = (status, j, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(j === null ? '' : JSON.stringify(j)); };
    if (req.url === '/li/v2/assets?action=registerUpload') return say(200, { value: { asset: 'urn:li:digitalmediaAsset:A1', uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: mode.evil ? 'http://evil.example/take' : `${base}/li/upload/A1`, headers: { 'x-linkedin-extra': '1' } } } } });
    if (req.url === '/li/upload/A1') return say(201, null);
    if (req.url === '/li/v2/assets/A1') { mode.polls = (mode.polls || 0) + 1; return say(200, { recipes: [{ status: mode.polls < 3 ? 'PROCESSING' : 'AVAILABLE' }] }); }
    if (req.url === '/li/v2/ugcPosts') {
      if (mode.li) return say(mode.li.status, mode.li.body);
      if (String(body.author).includes('organization')) return say(403, { message: 'Not enough permissions to access: ugcPosts' });
      return say(201, { id: 'urn:li:share:900' }, { 'x-restli-id': 'urn:li:share:900' });
    }
    if (req.url === '/token') return mode.grant ? say(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) : say(200, { access_token: 'ya29.fresh', expires_in: 3600 });
    if (req.url.startsWith('/yt/videos?')) return mode.yt ? say(mode.yt.status, mode.yt.body) : say(200, null, { location: mode.evil ? 'http://evil.example/session' : `${base}/yt/session/1` });
    if (req.url === '/yt/session/1') return say(200, { id: 'vid123', status: { privacyStatus: mode.privacy || 'public', uploadStatus: 'uploaded' } });
    return say(404, { message: `unexpected ${req.url}` });
  });
});

const KIND = {
  me: { platform: 'linkedin', externalId: 'urn:li:person:abc', name: 'Ravi Kumar', token: 'li-secret-token' },
  page: { platform: 'linkedin', externalId: 'urn:li:organization:77', name: 'Ravi Sweets Page', token: 'li-secret-token' },
  yt: { platform: 'youtube', externalId: 'UC1', name: 'Ravi Sweets Channel', token: '1//lasting-key' },
  th: { platform: 'threads', externalId: 't1', name: 'Threads account', token: 'x' },
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  process.env.TL_LINKEDIN_API_BASE = `${base}/li`; process.env.TL_YOUTUBE_UPLOAD_BASE = `${base}/yt`; process.env.TL_GOOGLE_TOKEN_URL = `${base}/token`;
  const SA = require('../src/utils/socialAccounts');
  SA.withToken = async (id) => (KIND[id] ? { account: { platform: KIND[id].platform, externalId: KIND[id].externalId, name: KIND[id].name, status: 'Connected' }, token: KIND[id].token } : null);
  const Pub = require('../src/marketing/publisher');
  const picture = { type: 'image', path: IMAGE, mime: 'image/png', title: 'Offer picture' }; const video = { type: 'video', path: VIDEO, mime: 'video/mp4', title: 'Offer video' };
  const one = async (id, media, caption) => { calls.length = 0; return (await Pub.publish([{ accountId: id }], media, caption))[0]; };

  // 1. LinkedIn: a picture is registered, sent to LinkedIn's address and posted; the words are as written
  let r = await one('me', picture, 'Diwali sweets are here #Diwali');
  assert.ok(r.ok && r.url === 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A900/', JSON.stringify(r));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /li/v2/assets?action=registerUpload', 'PUT /li/upload/A1', 'POST /li/v2/ugcPosts']);
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer li-secret-token'));
  assert.equal(calls[0].body.registerUploadRequest.recipes[0], 'urn:li:digitalmediaRecipe:feedshare-image'); assert.equal(calls[0].body.registerUploadRequest.owner, 'urn:li:person:abc');
  assert.equal(calls[1].bytes, fs.statSync(IMAGE).size); assert.equal(calls[1].headers['content-type'], 'image/png');
  const share = calls[2].body.specificContent['com.linkedin.ugc.ShareContent'];
  assert.deepEqual([calls[2].body.author, share.shareMediaCategory, share.shareCommentary.text, share.media[0].media, calls[2].body.lifecycleState], ['urn:li:person:abc', 'IMAGE', 'Diwali sweets are here #Diwali', 'urn:li:digitalmediaAsset:A1', 'PUBLISHED']);
  console.log('PASS LinkedIn picture: registered, uploaded, posted public as the connected profile; the link to the post comes back');

  // 2. LinkedIn: a video waits until LinkedIn has prepared it; words only post with no upload
  r = await one('me', video, 'Watch this'); assert.ok(r.ok, JSON.stringify(r)); assert.equal(calls[0].body.registerUploadRequest.recipes[0], 'urn:li:digitalmediaRecipe:feedshare-video');
  assert.equal(calls.filter((c) => c.url === '/li/v2/assets/A1').length, 3); assert.equal(calls[calls.length - 1].body.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory, 'VIDEO');
  r = await one('me', { type: '' }, 'Only words'); assert.ok(r.ok); assert.deepEqual(calls.map((c) => c.url), ['/li/v2/ugcPosts']); assert.equal(calls[0].body.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory, 'NONE');
  console.log('PASS LinkedIn video (waits for processing) and words only');

  // 3. LinkedIn refusals in plain words; the token is never shown or sent anywhere else
  r = await one('page', picture, 'Hello'); assert.ok(!r.ok && /Company Page.*Community Management API/.test(r.error), r.error);
  mode.li = { status: 401, body: { message: 'Invalid access token li-secret-token' } }; r = await one('me', { type: '' }, 'a'); assert.ok(!r.ok && /expired or was removed/.test(r.error) && !r.error.includes('li-secret-token'), r.error);
  mode.li = { status: 422, body: { message: 'Content is a duplicate of urn:li:share:1' } }; r = await one('me', { type: '' }, 'a'); assert.ok(/same as a recent one/.test(r.error), r.error);
  mode.li = { status: 400, body: { message: 'bad li-secret-token' } }; r = await one('me', { type: '' }, 'a'); assert.ok(/LinkedIn said: bad …/.test(r.error), r.error); delete mode.li;
  mode.evil = true; r = await one('me', picture, 'a'); assert.ok(!r.ok && /did not give a place/.test(r.error), r.error); assert.equal(calls.length, 1, 'nothing is sent to an address that is not LinkedIn'); delete mode.evil;
  r = await one('me', picture, 'x'.repeat(3001)); assert.ok(!r.ok && /3000/.test(r.error) && calls.length === 0, r.error);
  console.log('PASS LinkedIn refusals: Page without approval, expired sign-in, duplicate, foreign upload address, too long');

  // 4. YouTube: the lasting key gives a fresh one, a resumable upload, public and not made for kids; the title is the first line without hashtags
  r = await one('yt', video, '#Diwali Fresh <sweets> this week #Offer\nOrder now at our shop #Hyderabad');
  assert.ok(r.ok && r.url === 'https://youtu.be/vid123' && !r.note, JSON.stringify(r));
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST', 'PUT']);
  assert.ok(/grant_type=refresh_token/.test(calls[0].body) && /refresh_token=1%2F%2Flasting-key/.test(calls[0].body));
  assert.equal(calls[1].headers.authorization, 'Bearer ya29.fresh'); assert.equal(calls[1].headers['x-upload-content-length'], '3000'); assert.equal(calls[1].headers['x-upload-content-type'], 'video/mp4');
  assert.deepEqual([calls[1].body.snippet.title, calls[1].body.status.privacyStatus, calls[1].body.status.selfDeclaredMadeForKids], ['Fresh sweets this week', 'public', false]);
  assert.ok(!/[<>]/.test(calls[1].body.snippet.description) && /Order now at our shop/.test(calls[1].body.snippet.description));
  assert.equal(calls[2].bytes, 3000);
  assert.equal(Pub.ytTitle('', 'Offer video'), 'Offer video'); assert.equal(Pub.ytTitle('y'.repeat(150), '').length, 100);
  console.log('PASS YouTube video: fresh key, resumable upload, title from the first line, public, link comes back');

  // 5. YouTube refusals in plain words; pictures are refused before anything is sent
  r = await one('yt', picture, 'a'); assert.ok(!r.ok && /videos only/.test(r.error) && calls.length === 0, r.error);
  mode.privacy = 'private'; r = await one('yt', video, 'a'); assert.ok(r.ok && /set it to private/.test(r.note), JSON.stringify(r)); delete mode.privacy;
  mode.grant = true; r = await one('yt', video, 'a'); assert.ok(!r.ok && /Connect YouTube again/.test(r.error) && calls.length === 1, r.error); delete mode.grant;
  mode.yt = { status: 403, body: { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } } }; r = await one('yt', video, 'a'); assert.ok(/daily limit is used up/.test(r.error), r.error);
  mode.yt = { status: 403, body: { error: { message: 'YouTube Data API v3 has not been used in project 1 before or it is disabled.' } } }; r = await one('yt', video, 'a'); assert.ok(/not switched on/.test(r.error), r.error); delete mode.yt;
  mode.evil = true; r = await one('yt', video, 'a'); assert.ok(!r.ok && /did not give a place/.test(r.error) && !calls.some((c) => c.method === 'PUT'), r.error); delete mode.evil;
  r = await one('th', picture, 'a'); assert.ok(!r.ok && /Only Facebook, Instagram, LinkedIn, X and YouTube/.test(r.error), r.error);
  console.log('PASS YouTube refusals: a picture, hidden by YouTube (said), expired sign-in, daily limit, API off, foreign upload address; other kinds still by hand');

  console.log('mkLinkedinYoutube: all passed');
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
