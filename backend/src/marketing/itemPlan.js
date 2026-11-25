// ---------------------------------------------------------------------------
// AI MARKETING > AI IMAGES > "POST AFTER THE CLIENT APPROVES" (2026-11-25). Owner: "once the client approves the changed picture on WhatsApp, post it automatically on their social media with a caption and hashtags
// related to that post". One picture (a banner sent with "Ask the client to approve") can carry a POSTING PLAN: the connected accounts to post on and the words (caption + hashtags). It reuses what projects
// already do (marketing/projects.js: the Admin switch, the client's own tick naming the accounts, no double post, per-account failures with Retry) and the same publisher as the manual Post window
// (postItem.js publishItem), and nothing new is stored about passwords: the accounts are the ones an Admin connected in Administration > Integrations > Social Media (official sign-in; Facebook, Instagram
// and X do not allow a username and password for automation, and a client's password is never kept here). An account that is not connected cannot be picked and nothing posts to it.
//   words      written by rules from the banner's OWN words (headline, services, who it is for, website): no claim, offer or number is invented; the team can edit them; the hashtags come from the same words.
//   the client sees the exact picture AND the words AND the accounts on the review page and ticks "I allow it" (saved with name, time, accounts, the exact words, the version and the file); the Approve button
//     on WhatsApp has no tick, so it approves the picture but does NOT post (the team is told and can ask the client, or post by hand).
//   posts ONLY when: the client approved, the Admin switch is on (settings.autoPostAllowed), the consent covers the accounts and the words, the picture is the SAME file the client approved (an approved
//     version 2 posts version 2, never the original; a changed file is never posted), no newer client request is open, and nothing was already posted (no double post, also after Retry or a repeated tap).
//   a client's suggestions with the approval stop it (the team reads them first); a failure never marks it posted and says why per account; Retry posts only the accounts that failed.
//   every post (done or failed) is kept per picture (OmniMkItemPost), one audit line each, and the team gets a bell on posted and on failure.
// table OmniMkItemPlan: one plan per picture.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const T = 'OmniMkItemPlan';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "accounts" TEXT, "caption" TEXT, "suggested" TEXT, "state" TEXT NOT NULL DEFAULT 'armed', "consentAt" DATETIME, "consentBy" TEXT, "consentIds" TEXT, "consentCaption" TEXT, "consentVersion" INTEGER, "consentBytes" INTEGER, "site" TEXT, "result" TEXT, "error" TEXT, "lockId" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "postedAt" DATETIME)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_item" ON "${T}"("itemId")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] item plan schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const LABELS = { armed: 'Will post after the client approves', consent: 'Approved, but the client did not allow posting: not posted', review: 'Approved with suggestions: not posted by itself', consented: 'Posting soon', posting: 'Posting…', posted: 'Posted', failed: 'Posting failed', blocked: 'Not posted' };
const PLATFORM_WORD = { facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const rowOf = async (itemId) => (await S.q(`SELECT * FROM "${T}" WHERE itemId = ?`, String(itemId || '')))[0] || null;
const versionOf = (item) => (Number((parse(item.spec, {}) || {}).rev) || 0) + 1;
const running = new Set();

// ---- the words: from the banner's own words, never invented ---------------------------------------------------------------------------------------------------------------------
const STOP = new Set('a an and are as at be been but by can do for from get has have how i if in into is it its more most of on or our out so than that the their them then there these they this those to up us was we were what when where which who why will with you your jobs job'.split(' '));
const tagOf = (words) => `#${words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map(cap1).join('')}`;
function hashtagsFrom(phrases, brandTags = []) {
  const out = []; const add = (t) => { const k = t.toLowerCase(); if (t.length >= 4 && t.length <= 31 && !/^#\d+$/.test(t) && !out.some((x) => x.toLowerCase() === k)) out.push(t); };
  for (const t of brandTags) { const m = /^#?([\p{L}\p{N}_]{2,30})$/u.exec(String(t).trim()); if (m) add(`#${m[1]}`); if (out.length >= 3) break; }
  for (const p of phrases) {
    const ws = String(p || '').split(/[\s,/&|-]+/).map((w) => w.trim()).filter(Boolean);
    const keep = ws.filter((w) => !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
    if (keep.length >= 2 && keep.length <= 4 && String(p).length <= 36) add(tagOf(keep)); // a short phrase ("Social Media Marketing", "Staffing Consultancy") as one tag
    for (const w of keep) if (w.replace(/[^\p{L}]/gu, '').length >= 5) add(tagOf([w]));
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}
// -> { caption, hashtags, text } for a picture: a banner's own fields, else the picture's title
function suggest(item, brand = {}) {
  const spec = parse(item.spec, null) || {}; const Rev = require('./revise'); // eslint-disable-line global-require
  const sentence = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, ''); return s ? `${cap1(s)}.` : ''; };
  const head = [spec.headline, spec.headline2].filter(Boolean).join(' ').trim() || item.headline || item.title || '';
  const lines = []; const h = sentence(head); if (h) lines.push(h);
  if (spec.sub && !Rev.looksLikePrompt(spec.sub)) lines.push(sentence(spec.sub));
  if ((spec.services || []).length) lines.push(`${String(spec.servicesTitle || 'Our services').replace(/[:\s]*$/, '')}: ${spec.services.slice(0, 6).join(', ')}.`);
  if (spec.audience) lines.push(`${String(spec.audienceTitle || 'Who it is for').replace(/[:\s]*$/, '')}: ${String(spec.audience).replace(/[.\s]+$/, '')}.`);
  if (!spec.headline && brand.tagline) lines.push(sentence(brand.tagline)); // a picture that is not a banner: the title above, then the company's own tagline
  const web = spec.chip || brand.website; if (web) lines.push(`Visit ${String(web).replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`);
  const caption = lines.filter(Boolean).join('\n\n').slice(0, 1800);
  const tags = hashtagsFrom([spec.companyName, spec.headline2, spec.headline, ...(spec.services || []), spec.audience || '', item.title && !spec.headline ? item.title : ''].filter(Boolean), (brand.hashtags || []).slice(0, 3));
  return { caption, hashtags: tags, text: [caption, tags.join(' ')].filter(Boolean).join('\n\n') };
}
async function suggestFor(u, itemId) {
  const Img = require('./images'); // eslint-disable-line global-require
  const g = await Img.getRow(u, itemId); if (!g) return { error: 'This picture was not found.', status: 404 };
  return suggest(g.r, await Cfg.getBrand());
}

// ---- the plan -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function checkTargets(ids) {
  const SA = require('../utils/socialAccounts'); const targets = []; // eslint-disable-line global-require
  for (const aid of ids) { // eslint-disable-line no-restricted-syntax
    const got = await SA.withToken(aid); // eslint-disable-line no-await-in-loop
    if (!got) return { error: 'One of those accounts is not connected any more: connect the account first (Administration > Integrations > Social Media).', status: 404 };
    if (!['facebook', 'instagram', 'x'].includes(got.account.platform)) return { error: `${got.account.name}: only Facebook Pages, Instagram and X accounts can be posted to from here. Post the others by hand.`, status: 400 };
    targets.push({ accountId: aid, platform: got.account.platform, name: got.account.name });
  }
  return { targets };
}
// set or change the plan of a picture: b = { accountIds, caption }. A change to the accounts or the words after the client allowed posting cancels that permission (the client has to allow the new words).
async function arm(u, item, b = {}) {
  await ensure();
  if (!(A.has('mayAiMarketing')(u) && (A.isAdmin(u) || item.createdById === u.id))) return { error: 'Only the person who made it, or an Admin, can set posting for it.', status: 403 };
  if (item.style === 'clip') return { error: 'A clip is raw footage: make a video from it first.', status: 400 };
  const set = await Cfg.getSettings();
  if (!set.autoPostAllowed) return { error: 'An Admin has to allow posting from TeamLink first (AI Marketing > AI usage > Posting to client accounts).', status: 409, code: 'auto_off' };
  const ids = (Array.isArray(b.accountIds) ? b.accountIds : []).map(String).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 6);
  if (!ids.length) return { error: 'Pick at least one account to post on.', status: 400 };
  const chk = await checkTargets(ids); if (chk.error) return chk;
  const sug = suggest(item, await Cfg.getBrand()).text;
  const words = S.clip(b.caption, 2200).trim() || sug;
  if (!words) return { error: 'Write the words to post with the picture.', status: 400 };
  if (chk.targets.some((t) => t.platform === 'x') && words.length > 280) return { error: `The words are ${words.length} characters and X allows 280. Shorten them, or pick only Facebook and Instagram.`, status: 400 };
  const old = await rowOf(item.id);
  if (old && ['posting'].includes(old.state)) return { error: 'It is being posted right now.', status: 409 };
  if (old && old.state === 'posted') return { error: 'It was already posted. Post it again by hand from the Post window if you really want that.', status: 409 };
  const same = old && old.consentAt && JSON.stringify(parse(old.accounts, []).map((t) => t.accountId)) === JSON.stringify(ids) && old.caption === words;
  const now = Date.now();
  if (old) await S.run(`UPDATE "${T}" SET accounts = ?, caption = ?, suggested = ?, state = ?, consentAt = ?, consentBy = ?, consentIds = ?, consentCaption = ?, consentVersion = ?, consentBytes = ?, error = NULL, updatedAt = ? WHERE itemId = ?`,
    JSON.stringify(chk.targets), words, sug, same ? old.state : 'armed', same ? old.consentAt : null, same ? old.consentBy : null, same ? old.consentIds : null, same ? old.consentCaption : null, same ? old.consentVersion : null, same ? old.consentBytes : null, now, item.id);
  else await S.run(`INSERT INTO "${T}" (id, itemId, accounts, caption, suggested, state, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,'armed',?,?,?,?)`, S.newId('ipl'), item.id, JSON.stringify(chk.targets), words, sug, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: posting after the client approves was set for a picture', entity: 'OmniMkImage', entityId: item.id, toValue: `${S.clip(item.title, 80)}: ${chk.targets.map((t) => `${t.name} (${PLATFORM_WORD[t.platform]})`).join(', ')}` });
  return { plan: await summary(item.id) };
}
async function clear(u, item) {
  await ensure(); const p = await rowOf(item.id); if (!p) return { ok: 'There was no posting plan.' };
  if (!(A.isAdmin(u) || item.createdById === u.id)) return { error: 'Only the person who made it, or an Admin, can change this.', status: 403 };
  if (p.state === 'posting') return { error: 'It is being posted right now.', status: 409 };
  if (p.state === 'posted') return { error: 'It was already posted: there is nothing to switch off.', status: 409 };
  await S.run(`DELETE FROM "${T}" WHERE itemId = ?`, item.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: posting after the client approves was switched off for a picture', entity: 'OmniMkImage', entityId: item.id, toValue: S.clip(item.title, 80) });
  return { ok: 'It will not be posted by itself.' };
}
const STUCK_MS = 10 * 60000;
const stalePosting = (p) => ['posting', 'consented'].includes(p.state) && Date.now() - S.num(p.updatedAt) > STUCK_MS; // the server stopped part-way (or before it began): shown as failed; Retry first checks each account's history, so nothing is posted twice
const keyOf = (accounts, caption) => require('crypto').createHash('sha256').update(JSON.stringify([(accounts || []).map((t) => t.accountId), caption || ''])).digest('hex').slice(0, 20); // eslint-disable-line global-require
async function summary(itemId, set) {
  const p = await rowOf(itemId); if (!p) return null;
  const sw = set || await Cfg.getSettings();
  const results = parse(p.result, []); const accounts = parse(p.accounts, []); const state = stalePosting(p) ? 'failed' : p.state;
  return { state, label: LABELS[state] || state, switchOn: !!sw.autoPostAllowed, accounts: accounts.map((t) => ({ accountId: t.accountId, platform: t.platform, platformWord: PLATFORM_WORD[t.platform] || t.platform, name: t.name })), caption: p.caption || '',
    results: results.map((x) => ({ name: x.name, platform: x.platform, platformWord: PLATFORM_WORD[x.platform] || x.platform, ok: !!x.ok, url: x.url || '', error: x.error || '' })),
    consent: p.consentAt ? { by: p.consentBy || '', at: S.iso(p.consentAt) } : null, reason: stalePosting(p) ? 'It stopped part-way or did not start (the server was restarted?). Check the accounts, then press Retry: an account that already has it is skipped.' : (p.error || ''), canRetry: ['failed', 'blocked'].includes(state) && !!p.consentAt, postedAt: S.iso(p.postedAt) };
}
// for the cards of the AI Images list (one settings read, one query)
async function attach(items) {
  await ensure(); const list = Array.isArray(items) ? items : []; const ids = list.map((i) => i.id).slice(0, 900); if (!ids.length) return list;
  const rows = await S.q(`SELECT itemId FROM "${T}" WHERE itemId IN (${ids.map(() => '?').join(',')})`, ...ids); if (!rows.length) return list;
  const have = new Set(rows.map((r) => r.itemId)); const set = await Cfg.getSettings(); const out = [];
  for (const it of list) out.push(have.has(it.id) ? { ...it, plan: await summary(it.id, set) } : it); // eslint-disable-line no-await-in-loop
  return out;
}
// what the CLIENT is shown beside the picture while their link is open: the accounts and the exact words (nothing else of the plan), and a key that proves they read THESE words
async function forReview(itemId) {
  await ensure(); const p = await rowOf(itemId); if (!p || ['posted', 'posting'].includes(p.state)) return null;
  if (!(await Cfg.getSettings()).autoPostAllowed) return null; // an Admin switched posting off: the client is not asked for a permission that cannot be used
  const accounts = parse(p.accounts, []); if (!accounts.length || !p.caption) return null;
  return { accounts: accounts.map((t) => ({ platform: t.platform, platformWord: PLATFORM_WORD[t.platform] || t.platform, name: t.name })), caption: p.caption, key: keyOf(accounts, p.caption), state: p.state };
}
// the lines added to the WhatsApp caption / the email: the accounts, the exact words, and where to tick (WhatsApp keeps a picture's caption short: max cuts the words and says the rest is on the link)
async function clientNote(itemId, link, max = 0) {
  const sh = await forReview(itemId); if (!sh) return '';
  const names = sh.accounts.map((a) => `${a.name} (${a.platformWord})`).join(', ');
  const head = `\n\nIf you approve, we will post it on ${names} with these words:\n"`; const foot = `"\nTo allow the posting, open ${link} and tick the box. (The Approve button here approves the picture only: it does not post.)`;
  let words = sh.caption;
  if (max && head.length + words.length + foot.length > max) { const room = Math.max(0, max - head.length - foot.length - 40); words = `${words.slice(0, room).trimEnd()}… (all the words are on the link)`; }
  return `${head}${words}${foot}`;
}
// the client opens the SAME link again after a change: the permission of the earlier answer is spent; words the team never edited follow the changed banner
async function onReopen(itemId, item) {
  await ensure(); const p = await rowOf(itemId); if (!p || ['posted', 'posting'].includes(p.state)) return;
  let { caption, suggested } = p;
  if (item && p.suggested && p.caption === p.suggested) { try { const s = suggest(item, await Cfg.getBrand()).text; if (s) { caption = s; suggested = s; } } catch { /* the old words stay */ } }
  await S.run(`UPDATE "${T}" SET caption = ?, suggested = ?, state = 'armed', consentAt = NULL, consentBy = NULL, consentIds = NULL, consentCaption = NULL, consentVersion = NULL, consentBytes = NULL, error = NULL, updatedAt = ? WHERE itemId = ?`, caption, suggested, Date.now(), itemId);
}

// ---- the client's answer ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// before the answer is saved: a tick that does not match the words and accounts the page showed (the team changed them meanwhile) is refused, so the client never allows words they did not read
async function consentCheck(itemId, b = {}) {
  if (b.allowPosting !== true) return {};
  await ensure(); const sh = await forReview(itemId); if (!sh) return {};
  if (String(b.planKey || '') !== sh.key) return { error: 'The words or the accounts for the post were changed while this page was open. Please reload the page, read them again, and then approve.', status: 409 };
  return {};
}
// r: the review row; item: the picture; d: { approve, name, comment, allowPosting, planKey }. -> { state, note } | null (no plan, or the client asked for changes)
async function onClientDecision(r, item, d) {
  await ensure(); const p = await rowOf(r.itemId); if (!p || !d.approve || ['posted', 'posting'].includes(p.state)) return null;
  const now = Date.now(); const targets = parse(p.accounts, []);
  if (!(await Cfg.getSettings()).autoPostAllowed) {
    await S.run(`UPDATE "${T}" SET state = 'consent', error = NULL, updatedAt = ? WHERE itemId = ?`, now, p.itemId);
    return { state: 'consent', note: ' An Admin has switched off posting from TeamLink, so it is NOT posted.' };
  }
  if (d.allowPosting !== true || !targets.length || String(d.planKey || '') !== keyOf(targets, p.caption)) {
    await S.run(`UPDATE "${T}" SET state = 'consent', error = NULL, updatedAt = ? WHERE itemId = ?`, now, p.itemId);
    return { state: 'consent', note: ' The client did NOT tick permission to post (an Approve tap on WhatsApp has no tick), so it is NOT posted by itself: ask the client to open the link and tick, or post it yourself from the Post window if you have their permission.' };
  }
  const hold = !!S.clip(d.comment, 600);
  await S.run(`UPDATE "${T}" SET consentAt = ?, consentBy = ?, consentIds = ?, consentCaption = ?, consentVersion = ?, consentBytes = ?, site = ?, state = ?, error = NULL, updatedAt = ? WHERE itemId = ?`,
    now, S.clip(d.name, 80), JSON.stringify(targets.map((t) => t.accountId)), p.caption, versionOf(item), S.num(item.bytes), S.clip(r.site, 200) || null, hold ? 'review' : 'consented', now, p.itemId);
  await logAudit({ userId: r.createdById, actorName: `${S.clip(d.name, 80)} (client: ${S.clip(r.clientName, 80)})`, action: 'Omni-Channel AI Marketing: the client allowed posting on their accounts', entity: 'OmniMkImage', entityId: p.itemId, toValue: `${S.clip(r.itemTitle, 80)}: ${targets.map((t) => `${t.name} (${PLATFORM_WORD[t.platform] || t.platform})`).join(', ')}; version ${versionOf(item)}` });
  if (hold) return { state: 'review', note: ' The client allowed posting but added suggestions, so it is NOT posted by itself: read them, then post it from the Post window.' };
  return { state: 'consented', note: ' The client allowed posting: it is being posted on their accounts now.' };
}

// the client approved first (a tap on WhatsApp has no tick) and opens the link afterwards to allow the posting: valid only for a plan that is waiting exactly for that, on the SAME picture the client approved
async function allowLater(r, item, d = {}) {
  await ensure(); const p = await rowOf(r.itemId); if (!p || p.state !== 'consent') return { error: 'There is nothing waiting for your permission.', status: 409 };
  if (item.status !== 'approved') return { error: 'The picture is not approved, so it cannot be posted.', status: 409 };
  const sh = await forReview(r.itemId); if (!sh) return { error: 'Posting is not available for this picture now.', status: 409 };
  if (d.allowPosting !== true) return { error: 'Tick the box to allow the posting.', status: 400 };
  if (String(d.planKey || '') !== sh.key) return { error: 'The words or the accounts for the post were changed while this page was open. Please reload the page, read them again, and then allow.', status: 409 };
  const out = await onClientDecision(r, item, { approve: true, name: d.name, comment: '', allowPosting: true, planKey: d.planKey });
  return out && out.state === 'consented' ? { ok: true, state: 'consented' } : { error: 'The permission could not be saved. Please try again.', status: 409 };
}

// ---- the post -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// started in the background when the client's permission is in (never in the test sandbox unless a test asks)
function kick(itemId, base = '') {
  if (require('../utils/sandbox').isSandbox() && !kick.force) return; // eslint-disable-line global-require
  setImmediate(() => { run(itemId, { base }).catch((e) => console.error('[omni-mk] post after the client approved:', e.message)); }); // eslint-disable-line no-console
}
// -> { skipped } | { state, results, reason } ; the plan row is the record
async function run(itemId, opts = {}) {
  await ensure(); const p0 = await rowOf(itemId); if (!p0) return { skipped: 'no plan' }; if (p0.state !== 'consented') return { skipped: `state ${p0.state}` };
  const lock = S.newId('lk'); await S.run(`UPDATE "${T}" SET state = 'posting', lockId = ?, updatedAt = ? WHERE itemId = ? AND state = 'consented'`, lock, Date.now(), itemId); // one run wins the plan: a repeated tap or a second Retry finds it 'posting'
  const p = await rowOf(itemId); if (!p || p.lockId !== lock) return { skipped: 'another run has it' };
  const Img = require('./images'); const Post = require('./postItem'); const P = require('./projects'); const SA = require('../utils/socialAccounts'); // eslint-disable-line global-require
  const item = await Img.rawRow(itemId); const title = S.clip(item ? item.title : p.itemId, 60); const ver = S.num(p.consentVersion);
  const tellTeam = async (head, message) => { const ids = [...new Set([p.createdById, item && item.createdById].filter(Boolean))]; if (ids.length) { try { await notifyUsers(ids, { title: head, message: S.clip(message, 420) }); } catch { /* a notice that cannot be made does not stop the post */ } } };
  const stop = async (state, reason) => {
    await S.run(`UPDATE "${T}" SET state = ?, error = ?, lockId = NULL, updatedAt = ? WHERE itemId = ?`, state, S.clip(reason, 300), Date.now(), itemId);
    await logAudit({ userId: p.createdById || null, actorName: 'TeamLink', action: 'Omni-Channel AI Marketing: automatic posting after the client approved was held back', entity: 'OmniMkImage', entityId: itemId, toValue: `${title}: ${S.clip(reason, 200)}` });
    await tellTeam(`Not posted: "${title}"`, `${reason} Open AI Images to see it.`); return { state, reason };
  };
  try {
    if (!item || item.deletedAt || item.status !== 'approved') return await stop('blocked', 'The picture is not approved any more, so nothing was posted.');
    if (versionOf(item) !== ver || S.num(item.bytes) !== S.num(p.consentBytes)) return await stop('blocked', 'The picture changed after the client allowed posting, so it was not posted. The client has to approve the new version.');
    if (!(await Cfg.getSettings()).autoPostAllowed) return await stop('blocked', 'An Admin switched off posting from TeamLink (AI usage), so nothing was posted.');
    const open = (await S.q(`SELECT id FROM "OmniMkClientReview" WHERE kind = 'image' AND itemId = ? AND status = 'sent' AND deletedAt IS NULL LIMIT 1`, itemId))[0];
    if (open) return await stop('blocked', 'A newer request to the client is still open, so it was not posted.');
    const targets = parse(p.accounts, []); const consented = parse(p.consentIds, []);
    if (!targets.length || !targets.every((t) => consented.includes(t.accountId)) || !p.consentCaption || p.caption !== p.consentCaption) return await stop('blocked', 'The client\'s permission does not cover these accounts and these words, so nothing was posted.');
    const rv = (await S.q(`SELECT site FROM "OmniMkClientReview" WHERE kind = 'image' AND itemId = ? ORDER BY createdAt DESC LIMIT 1`, itemId))[0];
    const site = P.siteFor(opts.base || p.site || (rv && rv.site) || '');
    if (!site && targets.some((t) => t.platform !== 'x')) return await stop('blocked', 'Posting to Facebook or Instagram needs the site\'s https address (Meta fetches the picture from it). Open AI Images on the live site and press Retry.');
    // an account that already has THIS version (from an earlier run, a Retry, or a hand post after the client allowed it) is never posted again
    await Post.ensure();
    const before = parse(p.result, []).filter((x) => x.ok && x.version === ver); const have = new Set(before.map((x) => x.accountId));
    for (const h of await S.q(`SELECT accountId, platform, accountName, url FROM "OmniMkItemPost" WHERE itemId = ? AND ok = 1 AND at >= ?`, itemId, S.num(p.consentAt))) { if (h.accountId && !have.has(h.accountId)) { have.add(h.accountId); before.push({ accountId: h.accountId, platform: h.platform, name: h.accountName, ok: true, url: h.url || '', error: '', version: ver }); } } // eslint-disable-line no-restricted-syntax, no-await-in-loop
    const fail = (t, error) => ({ accountId: t.accountId, platform: t.platform, name: t.name, ok: false, url: '', error, version: ver });
    const fails = []; const live = [];
    for (const t of targets.filter((x) => !have.has(x.accountId))) { // eslint-disable-line no-restricted-syntax
      if (t.platform === 'x' && p.consentCaption.length > 280) { fails.push(fail(t, `The words are ${p.consentCaption.length} characters and X allows 280: shorten them (AI Images > the picture > Posting), then press Retry.`)); continue; } // eslint-disable-line no-continue
      if (!(await SA.withToken(t.accountId))) { fails.push(fail(t, 'This account is not connected any more: connect the account first (Administration > Integrations > Social Media).')); continue; } // eslint-disable-line no-await-in-loop, no-continue
      live.push(t);
    }
    let sent = [];
    if (live.length) sent = (await Post.publishItem(item, Img, live, p.consentCaption, site, p.createdById || '', S.clip(p.createdByName || 'TeamLink', 80), 'automatically after the client allowed it')).map((x) => ({ accountId: x.accountId, platform: x.platform, name: x.name, ok: !!x.ok, url: x.url || '', error: x.ok ? '' : S.clip(x.error, 300) || 'The account refused it.', version: ver }));
    const all = [...before, ...sent, ...fails]; const bad = all.filter((x) => !x.ok); const good = all.filter((x) => x.ok);
    const why = S.clip(bad.map((x) => `${x.name}: ${x.error}`).join(' | '), 300);
    await S.run(`UPDATE "${T}" SET state = ?, result = ?, error = ?, postedAt = ?, lockId = NULL, updatedAt = ? WHERE itemId = ?`, bad.length ? 'failed' : 'posted', JSON.stringify(all), bad.length ? why : null, bad.length ? null : Date.now(), Date.now(), itemId);
    if (bad.length) await tellTeam(`Posting failed: "${title}"`, `${bad.map((x) => `${x.name}: ${x.error}`).join(' ')} ${good.length ? `It was posted on ${good.map((x) => x.name).join(', ')}. ` : ''}Open AI Images and press Retry.`);
    else await tellTeam(`Posted: "${title}"`, `The picture the client approved (version ${ver}) was posted on ${good.map((x) => x.name).join(', ')}.${good.find((x) => x.url) ? ` ${good.find((x) => x.url).url}` : ''}`);
    return { state: bad.length ? 'failed' : 'posted', results: all, reason: bad.length ? why : '' };
  } catch (e) { return await stop('failed', `Posting stopped: ${e.message}`); }
}
// "Retry": a plan that failed (or was held back for a reason that is gone) posts again, only on the accounts that did not go out
async function retry(u, item, base = '') {
  await ensure(); const p = await rowOf(item.id); if (!p) return { error: 'There is no posting plan for this picture.', status: 404 };
  if (!(A.has('mayAiMarketing')(u) && (A.isAdmin(u) || item.createdById === u.id))) return { error: 'Only the person who made it, or an Admin, can retry.', status: 403 };
  if (!(['failed', 'blocked'].includes(p.state) || stalePosting(p))) return { error: 'Only a posting that failed or was held back can be tried again.', status: 409 };
  if (!p.consentAt) return { error: 'The client has not allowed posting.', status: 409 };
  await S.run(`UPDATE "${T}" SET state = 'consented', error = NULL, updatedAt = ? WHERE itemId = ? AND (state IN ('failed', 'blocked') OR (state IN ('posting', 'consented') AND updatedAt < ?))`, Date.now(), item.id, Date.now() - STUCK_MS);
  const out = await run(item.id, { base });
  return { ...out, plan: await summary(item.id) };
}

module.exports = { ensure, suggest, suggestFor, arm, clear, summary, attach, forReview, clientNote, consentCheck, onReopen, onClientDecision, allowLater, kick, run, retry, LABELS, hashtagsFrom };
