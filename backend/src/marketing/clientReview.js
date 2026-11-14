// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT APPROVAL (2026-11-14). After the team has approved a picture, a video or the AI-written words, the sender can send it to a CLIENT
// for approval. The client gets a private link (no login): the page shows the content and the client presses "Approve" or "Request changes" with a
// comment and their name.
//   order    mode 'confirm': internal approval first (the item must be Approved), then the client confirms (a badge). Mode 'decide' (2026-11-14, "Ask the client to
//            approve"): the CLIENT is the approver: the item waits, nobody on the team can approve it, and the client's answer approves it or sends it back.
//            One open link per item: a new link cancels the older one.
//   link     /client-review/<id>.<signature>: the signature is an HMAC of the id (MK_REVIEW_SECRET or JWT_SECRET), so it cannot be guessed and nothing secret
//            is stored. It stops working when it is revoked, when it expires (14 days by default, 1-30) and for a changed item (the content is checked
//            against what was sent). The client decides ONCE; changes asked for mean the sender fixes it and makes a new link.
//   sending  TeamLink does not send the link itself (no email / WhatsApp is connected): the screen gives Copy, WhatsApp and Email buttons.
//   audit    every send, decision, revoke and extension is in the audit log ("Omni-Channel AI Marketing: client ..."); the sender gets an in-app notice.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const TABLE = 'OmniMkClientReview';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "kind" TEXT NOT NULL, "itemId" TEXT NOT NULL, "itemTitle" TEXT NOT NULL DEFAULT '', "clientId" TEXT, "clientName" TEXT NOT NULL, "contactName" TEXT, "contactEmail" TEXT, "contactPhone" TEXT, "message" TEXT, "snapshot" TEXT NOT NULL DEFAULT '', "status" TEXT NOT NULL DEFAULT 'sent', "comment" TEXT, "decidedAt" DATETIME, "decidedByName" TEXT, "decidedIp" TEXT, "viewedAt" DATETIME, "views" INTEGER NOT NULL DEFAULT 0, "expiresAt" DATETIME NOT NULL DEFAULT 0, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_item" ON "${TABLE}"("kind", "itemId", "createdAt")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try {
    for (const sql of DDL) await S.run(sql); // eslint-disable-line no-await-in-loop
    // 2026-11-14: mode 'confirm' = the client confirms an item the team already approved (the answer is a badge); 'decide' = the CLIENT is the approver: the item waits for them
    try { await S.run(`ALTER TABLE "${TABLE}" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'confirm'`); } catch { /* the column is already there */ }
    await AI.ensure(); okAt = Date.now(); return true;
  } catch (e) { console.error('[omni-mk] client review schema:', e.message); return false; } // eslint-disable-line no-console
}

const KINDS = ['content', 'image'];
const DAY = 86400000;
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const secret = () => process.env.MK_REVIEW_SECRET || process.env.JWT_SECRET || 'teamlink-dev';
const sigOf = (id) => crypto.createHmac('sha256', secret()).update(`mk-review:${id}`).digest('base64url').slice(0, 32);
const tokenOf = (id) => `${id}.${sigOf(id)}`;
function idOfToken(token) {
  const m = /^([A-Za-z0-9]{8,40})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const want = Buffer.from(sigOf(m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}
// what the client was shown: if it changes afterwards, the old answer no longer counts
function snapshotOf(kind, o) {
  const basis = kind === 'image' ? [o.id, S.num(o.bytes)] : [parse(o.texts, {}), o.subject || '', parse(o.channels, [])];
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 24);
}

const mayWrite = (u) => A.has('mayAiMarketing')(u);
function visible(u, r) {
  if (r.deletedAt) return false;
  if (A.isAdmin(u) || r.createdById === u.id) return true;
  if (mayWrite(u)) return A.mayDepartment(u, r.department || '');
  return A.has('mayAiApprove')(u) && !!r.department && A.mayDepartment(u, r.department);
}
const effective = (r, now = Date.now()) => (r.status === 'sent' && S.num(r.expiresAt) < now ? 'expired' : r.status);
const short = (r, snap, now = Date.now()) => ({
  id: r.id, status: effective(r, now), mode: r.mode === 'decide' ? 'decide' : 'confirm', clientName: r.clientName, contactName: r.contactName || '', decidedAt: S.iso(r.decidedAt), decidedByName: r.decidedByName || '',
  comment: r.comment || '', expiresAt: S.iso(r.expiresAt), outdated: !!snap && r.status !== 'revoked' && r.snapshot !== snap,
});
const full = (r, now = Date.now()) => ({
  ...short(r, null, now), kind: r.kind, itemId: r.itemId, itemTitle: r.itemTitle, contactEmail: r.contactEmail || '', contactPhone: r.contactPhone || '', message: r.message || '',
  views: S.num(r.views), viewedAt: S.iso(r.viewedAt), createdAt: S.iso(r.createdAt), createdByName: r.createdByName || '', department: r.department || '', link: `/client-review/${tokenOf(r.id)}`,
});
const row = async (id) => (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, String(id || '')))[0] || null;

// ---- the badge on every card: the latest review of each item ---------------------------------------------------------------------------------
async function attach(kind, items) {
  await ensure();
  const list = Array.isArray(items) ? items : [];
  const ids = list.map((i) => i.id).slice(0, 900);
  if (!ids.length) return list;
  const rows = await S.q(`SELECT * FROM "${TABLE}" WHERE kind = ? AND deletedAt IS NULL AND itemId IN (${ids.map(() => '?').join(',')}) ORDER BY createdAt DESC`, kind, ...ids);
  const latest = {}; rows.forEach((r) => { if (!latest[r.itemId]) latest[r.itemId] = r; });
  const now = Date.now();
  return list.map((it) => (latest[it.id] ? { ...it, clientReview: short(latest[it.id], snapshotOf(kind, it), now) } : it));
}

const moduleOf = (kind) => (kind === 'image' ? require('./images') : require('./content')); // eslint-disable-line global-require

// the items whose approver is a client right now: an open (not cancelled, not expired) 'decide' link. Nobody on the team can approve or send these back
// until the client answers or the link is cancelled (then the item goes back to Drafts).
async function heldIds(kind) {
  await ensure();
  const rows = await S.q(`SELECT itemId FROM "${TABLE}" WHERE kind = ? AND mode = 'decide' AND status = 'sent' AND expiresAt > ? AND deletedAt IS NULL`, kind, Date.now());
  return new Set(rows.map((r) => r.itemId));
}

// ---- staff: send, list, revoke, extend ----------------------------------------------------------------------------------------------------
// b.mode === 'decide': "ask the client to approve": the item has NOT been approved by the team; it waits, and the client's answer is the approval.
async function create(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at client approvals but not send them.', status: 403 };
  const kind = KINDS.includes(b.kind) ? b.kind : '';
  if (!kind) return { error: 'Pick what to send to the client.', status: 400 };
  const decide = b.mode === 'decide';
  const got = kind === 'image' ? await require('./images').getRow(u, b.itemId) : await require('./content').getRow(u, b.itemId); // eslint-disable-line global-require
  if (!got) return { error: 'This item was not found.', status: 404 };
  const it = got.r;
  if (!(A.isAdmin(u) || it.createdById === u.id)) return { error: 'Only the person who made it, or an Admin, can send it to a client.', status: 403 };
  if (decide) {
    if (it.status === 'approved') return { error: 'It is already approved. Use "Send to client" to show the client what was approved.', status: 409 };
    if (!['draft', 'changes', 'waiting'].includes(it.status)) return { error: 'This item cannot be sent to the client now.', status: 409 };
  } else if (it.status !== 'approved') return { error: 'Your team has to approve it first. Then you can send it to the client.', status: 409 };
  if (kind === 'image' && it.style === 'clip') return { error: 'A clip is raw footage: make a video from it first, then send the video.', status: 400 };
  const clientName = S.clip(b.clientName, 120);
  if (clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  const email = S.clip(b.contactEmail, 160);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { error: 'That email address does not look right.', status: 400 };
  const days = Math.max(1, Math.min(30, Number(b.days) || 14));
  const now = Date.now();
  if (decide) { // the item now waits for the client (no notice to the team's approvers: they cannot approve it)
    const held = await moduleOf(kind).holdForClient(u, it);
    if (held && held.error) return held;
  }
  await S.run(`UPDATE "${TABLE}" SET status = 'revoked', updatedAt = ? WHERE kind = ? AND itemId = ? AND status = 'sent'`, now, kind, it.id); // one open link per item
  const id = S.newId('rv');
  await S.run(`INSERT INTO "${TABLE}" (id, kind, itemId, itemTitle, clientId, clientName, contactName, contactEmail, contactPhone, message, snapshot, status, expiresAt, department, createdById, createdByName, createdAt, updatedAt, mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,'sent',?,?,?,?,?,?,?)`,
    id, kind, it.id, S.clip(it.title, 120), S.clip(b.clientId, 40) || null, clientName, S.clip(b.contactName, 120) || null, email || null, S.clip(b.contactPhone, 30) || null, S.clip(b.message, 400) || null,
    snapshotOf(kind, it), now + days * DAY, it.department || null, u.id, S.clip(u.name, 80), now, now, decide ? 'decide' : 'confirm');
  await logAudit({ userId: u.id, actorName: u.name, action: decide ? 'Omni-Channel AI Marketing: sent to a client to decide (client approval is the approval)' : 'Omni-Channel AI Marketing: sent to a client for approval', entity: TABLE, entityId: id, toValue: `${it.title} (${kind}) to ${clientName}; link valid ${days} day(s)` });
  return { review: full(await row(id)) };
}
async function list(u, { kind = '', itemId = '' } = {}) {
  await ensure();
  const rows = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT 400`)).filter((r) => visible(u, r) && (!kind || r.kind === kind) && (!itemId || r.itemId === itemId));
  const now = Date.now();
  return { reviews: rows.map((r) => full(r, now)), canWrite: mayWrite(u) };
}
async function mine(u, id) {
  await ensure();
  const r = await row(id);
  if (!r || !visible(u, r)) return { error: 'This client approval was not found.', status: 404 };
  if (!(A.isAdmin(u) || r.createdById === u.id)) return { error: 'Only the person who sent it, or an Admin, can change it.', status: 403 };
  return { r };
}
async function revoke(u, id) {
  const g = await mine(u, id); if (g.error) return g;
  if (g.r.status !== 'sent') return { error: g.r.status === 'revoked' ? 'This link is already cancelled.' : 'The client has already answered; the answer stays on record.', status: 409 };
  await S.run(`UPDATE "${TABLE}" SET status = 'revoked', updatedAt = ? WHERE id = ?`, Date.now(), g.r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client approval link cancelled', entity: TABLE, entityId: g.r.id, toValue: g.r.itemTitle });
  // a link the client was to decide on: the item goes back to Drafts, so it can be changed, or sent to the team or to the client again
  const back = g.r.mode === 'decide' ? await moduleOf(g.r.kind).backToDraft(g.r.itemId) : false;
  return { ok: back ? 'The link no longer works. The item is back in Drafts: change it, ask your team, or ask the client again.' : 'The link no longer works.', review: full(await row(g.r.id)) };
}
async function extend(u, id, days) {
  const g = await mine(u, id); if (g.error) return g;
  if (g.r.status !== 'sent') return { error: 'Only a link that is still waiting for an answer can be extended.', status: 409 };
  const d = Math.max(1, Math.min(30, Number(days) || 14));
  await S.run(`UPDATE "${TABLE}" SET expiresAt = ?, updatedAt = ? WHERE id = ?`, Date.now() + d * DAY, Date.now(), g.r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client approval link extended', entity: TABLE, entityId: g.r.id, toValue: `${g.r.itemTitle}; ${d} day(s) from now` });
  return { ok: `The link works for ${d} more day${d === 1 ? '' : 's'}.`, review: full(await row(g.r.id)) };
}

// ---- the client's side (no login): what the link shows, the file, the decision ----------------------------------------------------------------
async function load(token) {
  await ensure();
  const id = idOfToken(token);
  if (!id) return null;
  const r = await row(id);
  if (!r || r.deletedAt || r.status === 'revoked') return null;
  const item = r.kind === 'image' ? await require('./images').rawRow(r.itemId) : await require('./content').rawRow(r.itemId); // eslint-disable-line global-require
  return { r, item: item && !item.deletedAt ? item : null };
}
const GONE = { error: 'This link does not work any more. Please ask the sender for a new one.', status: 404 };
async function publicView(token) {
  const g = await load(token);
  if (!g) return GONE;
  const { r, item } = g;
  const now = Date.now();
  await S.run(`UPDATE "${TABLE}" SET viewedAt = ?, views = views + 1 WHERE id = ?`, now, r.id);
  const brand = await Cfg.getBrand();
  const out = { review: { ...short(r, item ? snapshotOf(r.kind, item) : null, now), message: r.message || '', itemTitle: r.itemTitle, kind: r.kind }, brand: { name: brand.brandName || 'TeamLink', colors: brand.colors, tagline: brand.tagline || '' } };
  if (!item) return { ...out, item: null };
  if (r.kind === 'image') {
    out.item = { type: /^video\//.test(item.mime) ? 'video' : 'image', title: item.title, aspect: item.aspect || '1:1', headline: item.headline || '' };
  } else {
    const C = require('./content'); // eslint-disable-line global-require
    const keys = parse(item.channels, []);
    out.item = { type: 'words', title: item.title, subject: item.subject || '', texts: parse(item.texts, {}), channels: C.CHANNELS.filter((c) => keys.includes(c.key)).map((c) => ({ key: c.key, label: c.label })) };
  }
  return out;
}
async function publicFile(token) {
  const g = await load(token);
  if (!g || !g.item || g.r.kind !== 'image') return null;
  return require('./images').rawFile(g.item); // eslint-disable-line global-require
}
async function publicDecide(token, b = {}, ip = '') {
  const g = await load(token);
  if (!g) return GONE;
  const { r, item } = g;
  if (r.status !== 'sent') return { error: r.status === 'approved' || r.status === 'changes' ? 'This was already answered. Thank you.' : GONE.error, status: 409 };
  if (S.num(r.expiresAt) < Date.now()) return { error: 'This link has expired. Please ask the sender for a new one.', status: 410 };
  if (!item) return GONE;
  if (r.snapshot !== snapshotOf(r.kind, item)) return { error: 'This content was changed after the link was made. Please ask the sender for a new link.', status: 409 };
  const approve = b.decision === 'approve';
  if (!approve && b.decision !== 'changes') return { error: 'Choose Approve or Request changes.', status: 400 };
  const name = S.clip(b.name, 80);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  const comment = S.clip(b.comment, 600);
  if (!approve && comment.length < 5) return { error: 'Please say what should change (a few words).', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${TABLE}" SET status = ?, comment = ?, decidedAt = ?, decidedByName = ?, decidedIp = ?, updatedAt = ? WHERE id = ? AND status = 'sent'`, approve ? 'approved' : 'changes', comment || null, now, name, S.clip(ip, 60) || null, now, r.id);
  // the client was the approver: their answer IS the approval (words reach the Content Library; a picture / video can be used) or sends it back to the writer
  let applied = false;
  if (r.mode === 'decide') {
    try { const d = await moduleOf(r.kind).clientDecision(r.itemId, approve, name, r.clientName, comment); applied = !!(d && d.applied); } catch (e) { console.error('[omni-mk] client decision:', e.message); } // eslint-disable-line no-console
  }
  if (r.createdById) {
    await notifyUsers([r.createdById], { title: `Client ${approve ? 'approved' : 'asked for changes on'} "${S.clip(r.itemTitle, 60)}"`, message: `${name} (${S.clip(r.clientName, 60)}) ${approve ? 'approved it' : 'asked for changes'}${comment ? `: ${S.clip(comment, 200)}` : ''}.${applied ? (approve ? (r.kind === 'content' ? ' It is now Approved and in the Content Library.' : ' It is now Approved and can be used in the Content Calendar.') : ' It is back with you to change.') : ''} Open Omni-Channel > AI Marketing > Approvals.` });
  }
  await logAudit({ userId: r.createdById, actorName: `${name} (client: ${r.clientName})`, action: approve ? 'Omni-Channel AI Marketing: client approved' : 'Omni-Channel AI Marketing: client asked for changes', entity: TABLE, entityId: r.id, toValue: `${r.itemTitle}${comment ? `: ${S.clip(comment, 200)}` : ''}` });
  return { ok: approve ? 'Thank you. Your approval has been recorded.' : 'Thank you. Your request for changes has been sent.' };
}

module.exports = { ensure, attach, create, list, revoke, extend, publicView, publicFile, publicDecide, tokenOf, idOfToken, snapshotOf, heldIds };
