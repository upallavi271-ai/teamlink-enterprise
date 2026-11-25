// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT LOGIN ON THE PHONE (2026-11-25). Founder: "in the mobile app we need client logins: we make AI posts and publish them for our clients; the client logs in,
// checks the posts, approves or rejects them, and also knows about their social media accounts."
// NOTHING NEW IS DECIDED HERE. This file is the signed-in client's window onto what marketing/clientReview.js already does:
//   posts      the words / pictures / videos the team sent THIS company for approval (the same OmniMkClientReview rows the private link and the WhatsApp buttons use). A signed-in client login
//              of the company sees them without any link; the answer goes through clientReview.publicDecide(), so every rule stays in one place: the content must be unchanged since it was
//              sent, a rejection needs a reason, the client's "allow the posting" tick must match the exact words and accounts shown, and "post after the client approves" (itemPlan.js)
//              only ever posts after that tick. Nothing goes out for a client before the client has approved.
//   accounts   read only: the connected Facebook Pages / Instagram / X accounts TeamLink manages for this company (the accounts remembered for the client and the ones its posting plans /
//              past posts used), their state, and how many posts wait / are about to go out / went out on each. No token, no error text, no staff names, nothing about other companies.
// WHO: a CLIENT login with a company (User.clientId) that holds the "Approve our creative work" tick (CREATIVE). A row belongs to the company when its clientId is the company's, or when it has no
// clientId and the company name is the same (the rule the web portal's "Creative work" list already uses).
// AUDIT: every answer given here is one more audit line with the client person's own name ("Omni-Channel AI Marketing: client answered from their login"), next to the lines the review flow writes.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');

const TABLE = 'OmniMkClientReview';
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const lower = (s) => String(s || '').trim().toLowerCase();
const PLATFORM_WORD = { facebook: 'Facebook', instagram: 'Instagram', x: 'X', threads: 'Threads', linkedin: 'LinkedIn', youtube: 'YouTube' };
const isClientUser = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT') && !!u.clientId;

async function companyOf(u) {
  if (!isClientUser(u)) return null;
  const prisma = require('../db'); // eslint-disable-line global-require
  return prisma.client.findUnique({ where: { id: u.clientId }, select: { id: true, name: true } }).catch(() => null);
}
const mineWhere = '(clientId = ? OR (clientId IS NULL AND LOWER(TRIM(clientName)) = ?))';

async function itemOf(kind, itemId) {
  try { return kind === 'image' ? await require('./images').rawRow(itemId) : await require('./content').rawRow(itemId); } catch { return null; } // eslint-disable-line global-require
}
const kindWord = (r, item) => (r.kind === 'content' ? 'words' : (item && /^video\//.test(String(item.mime || '')) ? 'video' : 'picture'));
const sample = (item) => { // the first words of an AI-written message, for the card
  if (!item) return '';
  const texts = parse(item.texts, {}); const first = Object.keys(texts).map((k) => String(texts[k] || '')).find(Boolean) || '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 180);
};

// the post's progress in the client's own words
async function progressOf(r, item, plan, now) {
  if (r.status === 'revoked') return null;
  if (r.status === 'sent') {
    if (S.num(r.expiresAt) < now) return { status: 'expired', words: 'This link expired: ask your TeamLink contact to send it again.' };
    if (item && r.snapshot !== require('./clientReview').snapshotOf(r.kind, item)) return { status: 'updating', words: 'Our team is updating this: the new version will come to you here.' };
    return { status: 'waiting', words: 'Waiting for your answer' };
  }
  if (r.status === 'changes') return { status: 'changes', words: 'You said no. Our team is working on it and will send a new version.' };
  if (r.status === 'approved') {
    const st = plan ? plan.state : '';
    if (st === 'posted') return { status: 'posted', words: 'Posted' };
    if (st === 'consented' || st === 'posting') return { status: 'approved', words: 'Approved. Posting now.' };
    if (st === 'consent') return { status: 'approved', words: 'Approved. Not posted, because posting was not allowed.' };
    if (st === 'failed') return { status: 'approved', words: 'Approved. Our team will post it for you.' };
    return { status: 'approved', words: 'Approved' };
  }
  return null;
}

async function myRows(c) {
  const R = require('./clientReview'); // eslint-disable-line global-require
  await R.ensure();
  return S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND status != 'revoked' AND ${mineWhere} ORDER BY createdAt DESC LIMIT 80`, c.id, lower(c.name));
}

async function planOf(itemId, set) { try { return await require('./itemPlan').summary(itemId, set); } catch { return null; } } // eslint-disable-line global-require

const planWords = (plan) => (plan ? plan.accounts.map((a) => `${a.name} (${a.platformWord})`) : []);

// ---- the lists -----------------------------------------------------------------------------------------------------------------------------------------
async function list(u) {
  const c = await companyOf(u); if (!c) return { error: 'Your company record was not found: contact TeamLink.', status: 404 };
  const R = require('./clientReview'); // eslint-disable-line global-require
  const rows = await myRows(c); const now = Date.now(); const set = await Cfg.getSettings();
  const waiting = []; const done = [];
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const item = await itemOf(r.kind, r.itemId); // eslint-disable-line no-await-in-loop
    if (!item || item.deletedAt) continue; // eslint-disable-line no-continue -- removed by the team: nothing to show
    const plan = r.kind === 'image' ? await planOf(r.itemId, set) : null; // eslint-disable-line no-await-in-loop
    const p = await progressOf(r, item, plan, now); // eslint-disable-line no-await-in-loop
    if (!p) continue; // eslint-disable-line no-continue
    const kind = kindWord(r, item);
    const x = {
      id: r.id, title: r.itemTitle || 'For your approval', kind, status: p.status, words: p.words, needsYou: p.status === 'waiting', note: r.message || '',
      sentAt: S.iso(r.createdAt), decidedAt: S.iso(r.decidedAt), decidedByName: r.decidedByName || '', comment: r.comment || '',
      thumb: kind === 'words' ? '' : `/api/public/mk-review/${encodeURIComponent(R.tokenOf(r.id))}/file`, preview: kind === 'words' ? sample(item) : '',
      postOn: planWords(plan), postedOn: plan && plan.results ? plan.results.filter((x2) => x2.ok).map((x2) => ({ name: x2.name, platformWord: x2.platformWord, url: x2.url || '' })) : [],
    };
    (p.status === 'waiting' ? waiting : done).push(x);
  }
  const counts = {
    waiting: waiting.length,
    approved: done.filter((x) => x.status === 'approved').length,
    posted: done.filter((x) => x.status === 'posted').length,
    changes: done.filter((x) => x.status === 'changes' || x.status === 'updating').length,
  };
  return { company: c.name, counts, waiting, done };
}

// ---- one post ------------------------------------------------------------------------------------------------------------------------------------
async function mineRow(u, id) {
  const c = await companyOf(u); if (!c) return { error: 'Your company record was not found: contact TeamLink.', status: 404 };
  const R = require('./clientReview'); // eslint-disable-line global-require
  await R.ensure();
  const r = (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ? AND deletedAt IS NULL AND status != 'revoked' AND ${mineWhere}`, String(id || ''), c.id, lower(c.name)))[0];
  if (!r) return { error: 'This post was not found.', status: 404 };
  return { c, r, R };
}
async function view(u, id) {
  const g = await mineRow(u, id); if (g.error) return g;
  const out = await g.R.publicView(g.R.tokenOf(g.r.id));
  if (out.error) return out;
  const item = out.item || null;
  const kind = item ? (item.type === 'words' ? 'words' : (item.type === 'video' ? 'video' : 'picture')) : 'picture';
  return {
    id: g.r.id, company: g.c.name, title: out.review.itemTitle, kind, note: out.review.message || '', status: out.review.status, mode: out.review.mode, outdated: !!out.review.outdated,
    decidedAt: out.review.decidedAt || '', decidedByName: out.review.decidedByName || '', comment: out.review.comment || '', expiresAt: out.review.expiresAt || '',
    fileUrl: item && item.type !== 'words' ? `/api/public/mk-review/${encodeURIComponent(g.R.tokenOf(g.r.id))}/file${item.version > 1 ? `?v=${item.version}` : ''}` : '',
    version: item && item.version ? item.version : 1, headline: item && item.headline ? item.headline : '',
    words: item && item.type === 'words' ? { subject: item.subject || '', texts: item.texts || {}, channels: item.channels || [] } : null,
    post: item && item.post ? item.post : null, // { accounts: [{ platform, platformWord, name }], caption, key, when: 'with' | 'later' }
    brand: out.brand ? { name: out.brand.name } : { name: 'TeamLink' },
  };
}

// APPROVE or REJECT. Same rules as the private link (clientReview.publicDecide); the name is the signed-in person's own, never typed.
async function decide(u, id, b = {}) {
  const g = await mineRow(u, id); if (g.error) return g;
  const d = String(b.decision || '').toLowerCase();
  const approve = d === 'approve';
  if (!approve && !['reject', 'changes'].includes(d)) return { error: 'Choose Approve or Reject.', status: 400 };
  const comment = S.clip(b.comment, 600);
  if (!approve && comment.length < 5) return { error: 'Please tell us why, in a few words, so we can fix it.', status: 400 };
  const name = S.clip(u.name, 80) || 'Client';
  const out = await g.R.publicDecide(g.R.tokenOf(g.r.id), { decision: approve ? 'approve' : 'changes', name, comment, ...(approve && b.allowPosting === true ? { allowPosting: true, planKey: b.planKey } : {}) }, 'client login (phone app)');
  if (out.error) return out;
  await logAudit({ userId: u.id, actorName: `${name} (client login: ${S.clip(g.c.name, 60)})`, action: 'Omni-Channel AI Marketing: client answered from their login', entity: TABLE, entityId: g.r.id, toValue: `${S.clip(g.r.itemTitle, 80)}: ${approve ? 'approved' : 'rejected'}${comment ? ` (${S.clip(comment, 160)})` : ''}` });
  return approve ? out : { ok: 'Thank you. We have told the TeamLink team why, and they will send you a new version.' };
}

// approved first with a tap on WhatsApp (that tap has no tick): the client opens the post here and allows the posting (clientReview.publicAllowPosting: the exact words and accounts must match)
async function allowPosting(u, id, b = {}) {
  const g = await mineRow(u, id); if (g.error) return g;
  const name = S.clip(u.name, 80) || 'Client';
  const out = await g.R.publicAllowPosting(g.R.tokenOf(g.r.id), { name, allowPosting: b.allowPosting === true, planKey: b.planKey });
  if (out.error) return out;
  await logAudit({ userId: u.id, actorName: `${name} (client login: ${S.clip(g.c.name, 60)})`, action: 'Omni-Channel AI Marketing: client allowed posting from their login', entity: TABLE, entityId: g.r.id, toValue: S.clip(g.r.itemTitle, 80) });
  return out;
}

// ---- the social accounts, read only ----------------------------------------------------------------------------------------------------------------------
async function accounts(u) {
  const c = await companyOf(u); if (!c) return { error: 'Your company record was not found: contact TeamLink.', status: 404 };
  const rows = await myRows(c); const now = Date.now(); const set = await Cfg.getSettings();
  const itemIds = rows.filter((r) => r.kind === 'image').map((r) => r.itemId);
  const stat = new Map(); const touch = (id) => { if (!stat.has(id)) stat.set(id, { waiting: 0, soon: 0, posted: 0, lastPostedAt: '', lastPostUrl: '' }); return stat.get(id); };
  const ids = new Set();
  // the accounts remembered for this company when the client was made (marketing/projects.js setClientAccounts)
  const remembered = await Cfg.getClientAccounts().catch(() => ({}));
  [`c:${c.id}`, `n:${lower(c.name)}`].forEach((k) => { const x = remembered[k]; if (x && Array.isArray(x.accountIds)) x.accountIds.forEach((a) => ids.add(String(a))); });
  const recent = [];
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    if (r.kind !== 'image') continue; // eslint-disable-line no-continue
    const item = await itemOf(r.kind, r.itemId); // eslint-disable-line no-await-in-loop
    if (!item || item.deletedAt) continue; // eslint-disable-line no-continue
    const plan = await planOf(r.itemId, set); // eslint-disable-line no-await-in-loop
    if (!plan) continue; // eslint-disable-line no-continue
    const p = await progressOf(r, item, plan, now); // eslint-disable-line no-await-in-loop
    (plan.accounts || []).forEach((a) => {
      if (!a.accountId) return;
      ids.add(String(a.accountId));
      const s = touch(String(a.accountId));
      if (p && p.status === 'waiting') s.waiting += 1;
      else if (['consented', 'posting'].includes(plan.state)) s.soon += 1;
    });
    (plan.results || []).filter((x) => x.ok).forEach((x) => {
      const a = (plan.accounts || []).find((t) => t.name === x.name && t.platform === x.platform);
      if (a && a.accountId) { const s = touch(String(a.accountId)); s.posted += 1; if (x.url) s.lastPostUrl = s.lastPostUrl || x.url; }
    });
    if (plan.state === 'posted') recent.push({ title: r.itemTitle || '', at: S.iso(plan.postedAt) || S.iso(r.decidedAt) || '', on: (plan.results || []).filter((x) => x.ok).map((x) => `${x.name} (${x.platformWord})`) });
  }
  // what really went out (the history of each account), for the date of the last post
  if (itemIds.length) {
    try {
      const hist = await S.q(`SELECT accountId, ok, url, at FROM "OmniMkItemPost" WHERE ok = 1 AND itemId IN (${itemIds.slice(0, 200).map(() => '?').join(',')}) ORDER BY at DESC`, ...itemIds.slice(0, 200));
      hist.forEach((h) => { if (!h.accountId) return; ids.add(String(h.accountId)); const s = touch(String(h.accountId)); if (!s.lastPostedAt) { s.lastPostedAt = S.iso(h.at); if (h.url) s.lastPostUrl = h.url; } });
    } catch { /* no posts have ever been made */ }
  }
  const SA = require('../utils/socialAccounts'); // eslint-disable-line global-require
  const all = await SA.list(); const flat = [].concat(...Object.keys(all).map((p) => all[p]));
  const mine = [...ids].map((id) => flat.find((a) => a.id === id)).filter((a) => a && a.status !== 'Removed');
  const accountsOut = mine.map((a) => {
    const s = stat.get(a.id) || { waiting: 0, soon: 0, posted: 0, lastPostedAt: '', lastPostUrl: '' };
    const connected = a.status === 'Connected';
    return {
      platform: a.platform, platformWord: PLATFORM_WORD[a.platform] || a.platform, name: a.name, username: a.username || '', pageName: a.parentName || '',
      connected, statusWords: connected ? 'Connected' : 'Needs to be reconnected: our team is on it', waiting: s.waiting, soon: s.soon, posted: s.posted, lastPostedAt: s.lastPostedAt, lastPostUrl: s.lastPostUrl,
    };
  }).sort((a, b) => String(a.platform).localeCompare(String(b.platform)) || String(a.name).localeCompare(String(b.name)));
  // the pages the client wrote down in a request (free words), when we have not linked an account yet
  let told = [];
  try {
    const pr = await S.q(`SELECT handles FROM "OmniMkProject" WHERE deletedAt IS NULL AND handles IS NOT NULL AND handles != '' AND (clientId = ? OR (clientId IS NULL AND LOWER(TRIM(clientName)) = ?)) ORDER BY updatedAt DESC LIMIT 5`, c.id, lower(c.name));
    const seen = new Set();
    pr.forEach((x) => String(x.handles || '').split('\n').map((l) => S.clip(l, 140).trim()).filter(Boolean).forEach((l) => { if (!seen.has(l.toLowerCase())) { seen.add(l.toLowerCase()); told.push(l); } }));
    told = told.slice(0, 8);
  } catch { told = []; }
  const counts = { waiting: 0, approved: 0, posted: 0 };
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    if (r.status === 'sent' && S.num(r.expiresAt) >= now) counts.waiting += 1;
    else if (r.status === 'approved') counts.approved += 1;
  }
  counts.posted = recent.length;
  counts.approved = Math.max(0, counts.approved - counts.posted);
  return { company: c.name, accounts: accountsOut, told, counts, recent: recent.slice(0, 5), postingOn: set.autoPostAllowed === true };
}

// a bell (and, where the person switched phone alerts on, a phone alert) for the company's client logins when the team sends something for approval
async function announce(clientId, clientName, title, message) {
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    const CT = require('../utils/clientPortalTypes'); // eslint-disable-line global-require
    let cid = clientId || '';
    if (!cid && lower(clientName)) { const hit = await prisma.$queryRawUnsafe('SELECT id FROM "Client" WHERE LOWER(TRIM(name)) = ? LIMIT 1', lower(clientName)); cid = hit && hit[0] ? hit[0].id : ''; }
    if (!cid) return 0;
    const users = await prisma.user.findMany({ where: { clientId: cid, status: 'Active', OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] } });
    const ids = users.filter((x) => CT.hasCap(x, 'CREATIVE')).map((x) => x.id);
    if (!ids.length) return 0;
    await require('../utils/notify').notifyUsers(ids, { title, message, open: '/client-posts' }); // eslint-disable-line global-require
    return ids.length;
  } catch (e) { console.error('[omni-mk] client phone alert:', e.message); return 0; } // eslint-disable-line no-console
}

module.exports = { list, view, decide, allowPosting, accounts, announce, companyOf, isClientUser };
