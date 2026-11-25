// ---------------------------------------------------------------------------
// AI MARKETING > POST AN APPROVED PICTURE / VIDEO (2026-11-23). Owner: "the client approved it, now how do I post it on the client's social media account?"
// A picture or video approved through AI Images / AI Video (by the team, or by the client on a private link) had only Download and Copy link; the Facebook / Instagram / X buttons existed only
// inside a client PROJECT. Now an approved item has a "Post" window: the person picks the connected accounts (Administration > Integrations > Social Media), writes the words, confirms, and it goes out
// through the same publisher as a project (marketing/publisher.js). Every post (done or failed) is kept per item so the window shows what already went out and a second click is never a surprise.
//   Rules  only an APPROVED picture or video (not a raw clip); an Admin must have switched on "Post from TeamLink" (AI usage); only the person who made it, or an Admin; Facebook Pages,
//          Instagram and X only (the others by hand); the person must confirm (it goes public); Facebook / Instagram fetch the file from the site's https address; X takes 280 characters.
//   Nothing is posted by itself, on a schedule or for anybody else.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkItemPost';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "accountId" TEXT, "platform" TEXT, "accountName" TEXT, "ok" INTEGER NOT NULL DEFAULT 0, "url" TEXT, "error" TEXT, "caption" TEXT, "byId" TEXT, "byName" TEXT, "at" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_item" ON "${T}"("itemId", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] item post schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

const mayWrite = (u) => A.has('mayAiMarketing')(u);
const PLATFORMS = ['facebook', 'instagram', 'x'];
const WORD = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
const running = new Set();

async function itemOf(u, id) {
  if (!mayWrite(u)) return { error: 'Your login can look at pictures and videos but not post them.', status: 403 };
  const Img = require('./images'); // eslint-disable-line global-require
  const got = await Img.getRow(u, id);
  if (!got) return { error: 'This picture or video was not found.', status: 404 };
  const it = got.r;
  if (!(A.isAdmin(u) || it.createdById === u.id)) return { error: 'Only the person who made it, or an Admin, can post it.', status: 403 };
  return { it, Img };
}

// what was already posted from this item, newest first
async function posts(u, id) {
  await ensure();
  const g = await itemOf(u, id); if (g.error) return g;
  const rows = await S.q(`SELECT * FROM "${T}" WHERE itemId = ? ORDER BY at DESC LIMIT 50`, g.it.id);
  return { posts: rows.map((r) => ({ id: r.id, accountId: r.accountId || '', platform: r.platform || '', accountName: r.accountName || '', ok: S.num(r.ok) === 1, url: r.url || '', error: r.error || '', caption: r.caption || '', byName: r.byName || '', at: S.iso(r.at) })) };
}

// the part that really posts, shared by the click (postItem) and the automatic post after the client approved (marketing/itemPlan.js): the public links Meta fetches, the local file X uploads, the publisher,
// one history row per account (done or failed) and one audit line. -> the publisher's results [{ accountId, platform, name, ok, url, error }]
async function publishItem(it, Img, targets, caption, site, byId, byName, how = 'by a click') {
  const video = Img.isVideoRow(it);
  const file = Img.rawFile(it);
  const media = { type: video ? 'video' : 'image', url: site ? `${site}${Img.publicPathOf(it)}` : '', jpgUrl: site && !video && /^image\/(png|webp)$/.test(it.mime || '') ? `${site}${Img.publicJpegPath(it)}` : (site ? `${site}${Img.publicPathOf(it)}` : ''), path: file ? file.path : '', mime: it.mime };
  const results = await require('./publisher').publish(targets, media, caption); // eslint-disable-line global-require
  const now = Date.now();
  for (const x of results) { // eslint-disable-line no-restricted-syntax
    await S.run(`INSERT INTO "${T}" (id, itemId, accountId, platform, accountName, ok, url, error, caption, byId, byName, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, // eslint-disable-line no-await-in-loop
      S.newId('ip'), it.id, x.accountId || null, x.platform || null, S.clip(x.name, 120), x.ok ? 1 : 0, x.url || null, x.ok ? null : S.clip(x.error, 300), caption || null, byId, S.clip(byName, 80), now);
  }
  await logAudit({ userId: byId, actorName: byName, action: results.every((x) => x.ok) ? `Omni-Channel AI Marketing: ${video ? 'video' : 'picture'} posted ${how}` : `Omni-Channel AI Marketing: ${video ? 'video' : 'picture'} posting ${how} had a failure`, entity: 'OmniMkImage', entityId: it.id, toValue: `${S.clip(it.title, 80)}: ${results.map((x) => `${x.name} (${WORD[x.platform] || x.platform}) ${x.ok ? 'posted' : 'failed'}`).join(', ')}` });
  return results;
}

// body: { accountIds: [..], caption, confirm: true }
async function postItem(u, id, b = {}, base = '') {
  await ensure();
  const g = await itemOf(u, id); if (g.error) return g;
  const { it, Img } = g;
  if (it.status !== 'approved') return { error: 'Only an approved picture or video can be posted. Get it approved first (your team, or the client on a private link).', status: 409 };
  if (it.style === 'clip') return { error: 'A clip is raw footage: make a video from it first, then post the video.', status: 400 };
  if (b.confirm !== true) return { error: 'Confirm that you want to post it now: it goes public on the accounts you picked.', status: 400, code: 'confirm' };
  const set = await Cfg.getSettings();
  if (!set.autoPostAllowed) return { error: 'An Admin has to allow posting from TeamLink first (AI Marketing > AI usage > Posting to client accounts).', status: 409, code: 'auto_off' };
  const SA = require('../utils/socialAccounts'); // eslint-disable-line global-require
  const ids = (Array.isArray(b.accountIds) ? b.accountIds : []).map(String).filter((x, i, a) => a.indexOf(x) === i).slice(0, 6);
  if (!ids.length) return { error: 'Pick at least one account to post on.', status: 400 };
  const targets = [];
  for (const aid of ids) { // eslint-disable-line no-restricted-syntax
    const got = await SA.withToken(aid); // eslint-disable-line no-await-in-loop
    if (!got) return { error: 'One of those accounts is not connected any more. Connect it in Administration > Integrations > Social Media.', status: 404 };
    if (!PLATFORMS.includes(got.account.platform)) return { error: `${got.account.name}: only Facebook Pages, Instagram and X accounts can be posted to from here. Post the others by hand.`, status: 400 };
    targets.push({ accountId: aid, platform: got.account.platform, name: got.account.name });
  }
  const caption = S.clip(b.caption, 2200).trim();
  if (targets.some((t) => t.platform === 'x') && caption.length > 280) return { error: `The words are ${caption.length} characters and X allows 280. Shorten them, or pick only Facebook and Instagram.`, status: 400 };
  const site = require('./projects').siteFor(base); // eslint-disable-line global-require
  if (targets.some((t) => t.platform !== 'x') && !site) return { error: 'Posting to Facebook or Instagram needs this page opened on the site\'s https address (Meta fetches the picture or video from it).', status: 400 };
  if (running.has(it.id)) return { error: 'It is being posted right now.', status: 409 };
  running.add(it.id);
  try {
    const results = await publishItem(it, Img, targets, caption, site, u.id, u.name, 'by a click');
    const good = results.filter((x) => x.ok);
    return { ok: good.length === results.length ? `Posted on ${good.map((x) => x.name).join(', ')}.` : (good.length ? 'Some accounts were posted, some were not. See below.' : 'It could not be posted. See why below, then try again.'), results, posted: good.length > 0 };
  } finally { running.delete(it.id); }
}

module.exports = { ensure, posts, postItem, publishItem, PLATFORMS, WORD };
