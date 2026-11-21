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
//   sending  a person's click on "Send from TeamLink" (tell() below) sends the link by the company's own WhatsApp number and / or email, through the connections in
//            Administration > Integrations; with "also send the picture" the picture / video itself goes too when WhatsApp allows it (the client wrote in the last 24
//            hours), else the link only. Copy, "Open my WhatsApp" (wa.me: it needs WhatsApp Web) and "Email" (the person's own mail app) stay as the manual way.
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
  const held = new Set(rows.map((r) => r.itemId));
  if (kind === 'image') { try { (await require('./projects').heldIds()).forEach((id) => held.add(id)); } catch { /* the projects tables are not there yet */ } } // pictures / videos the client is choosing between // eslint-disable-line global-require
  return held;
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
  if (kind === 'image' && it.style === 'clip') return { error: 'A clip is raw footage: make a video from it first, then send the video.', status: 400 }; // checked first: a raw clip is always "approved" (ready to use)
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

// ---- sending the link FROM TEAMLINK (2026-11-16) ---------------------------------------------------------------------------------------------------------
// Founder: "when I click Send to WhatsApp it asks me to log in to WhatsApp, but we have the Team Link Consultants number: send the picture to the client's number from it".
// A person's click (never automatic). ways: ['whatsapp','email']; b.phone = the client's number if the person types or changes it (saved on the link); b.picture = also send the
// picture / video itself on WhatsApp. WhatsApp allows a file only in the 24 hours after the client wrote to this number: if it cannot go, the LINK goes (as the company's
// general template when one is saved) and the answer says so. -> { ok, sent: [{ way, ok, to, mode: 'picture'|'link', error }] }
const safeName = (t) => String(t || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'file';
async function mediaFor(item, id) { // the file WhatsApp can take, or { skip: why }
  const fs = require('fs'); const os = require('os'); const path = require('path'); // eslint-disable-line global-require
  const f = require('./images').rawFile(item); // eslint-disable-line global-require
  if (!f) return { skip: 'The file is not on the server any more.' };
  if (/^video\//.test(String(item.mime || ''))) {
    if (item.mime !== 'video/mp4') return { skip: 'WhatsApp takes MP4 videos only.' };
    if (fs.statSync(f.path).size > 16 * 1024 * 1024) return { skip: 'The video is bigger than 16 MB, which WhatsApp does not take.' };
    return { path: f.path, name: `${safeName(item.title)}.mp4`, mime: 'video/mp4', cleanup: () => {} };
  }
  try { // WhatsApp takes a JPEG / PNG up to 5 MB: a JPEG of at most 2048 px is made from the picture
    const buf = await require('sharp')(f.path).rotate().flatten({ background: '#ffffff' }).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(); // eslint-disable-line global-require
    const p = path.join(os.tmpdir(), `mk-send-${safeName(id)}-${Date.now()}.jpg`);
    fs.writeFileSync(p, buf);
    return { path: p, name: `${safeName(item.title)}.jpg`, mime: 'image/jpeg', cleanup: () => { try { fs.unlinkSync(p); } catch { /* already gone */ } } };
  } catch { return { skip: 'The picture could not be prepared for WhatsApp.' }; }
}
async function tell(u, id, b = {}, base = '') {
  const g = await mine(u, id); if (g.error) return g;
  let r = g.r;
  if (effective(r) !== 'sent') return { error: 'This link is not open any more. Make a new link first.', status: 409 };
  const P = require('./projects'); // eslint-disable-line global-require
  const site = P.siteFor(base);
  if (!site) return { error: 'The link needs the site\'s https address: open this page on the live site and try again.', status: 400 };
  const ways = (Array.isArray(b.ways) ? b.ways : []).map(String).filter((w, i, a) => ['whatsapp', 'email'].includes(w) && a.indexOf(w) === i);
  if (!ways.length) return { error: 'Pick WhatsApp or Email.', status: 400 };
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const typed = S.clip(b.phone, 30);
  if (typed && !core.normalizeMobile(typed).ok) return { error: 'That WhatsApp number does not look right. Check it and try again.', status: 400 }; // checked BEFORE it is saved: a wrong number never replaces the good one
  if (typed && typed !== (r.contactPhone || '')) { await S.run(`UPDATE "${TABLE}" SET contactPhone = ?, updatedAt = ? WHERE id = ?`, typed, Date.now(), r.id); r = { ...r, contactPhone: typed }; }
  const item = await moduleOf(r.kind).rawRow(r.itemId);
  const word = r.kind === 'image' ? (item && /^video\//.test(item.mime || '') ? 'video' : 'picture') : 'message';
  const link = `${site}/client-review/${tokenOf(r.id)}`;
  const first = P.firstWord(r.contactName);
  const text = `${first ? `Hello ${first},` : 'Hello,'} ${r.message ? S.clip(r.message, 400) : `please review the ${word} "${r.itemTitle}" and tell us if it is OK to use:`} ${link}`;
  const meta = { audience: 'client', personName: S.clip(r.contactName || r.clientName, 80), purpose: `AI Marketing: ${word} for the client to approve`, module: 'AI Marketing', senderUserId: u.id, senderName: S.clip(u.name, 80) };
  const Sender = require('./sender'); // eslint-disable-line global-require -- the WhatsApp number: the default company number unless the person picked another (marketing/sender.js)
  const pk = ways.includes('whatsapp') ? await Sender.pick(u, b.numberId) : { numberId: null };
  if (pk.error) return { error: pk.error, status: pk.status || 400 };
  const sent = [];
  for (const way of ways) { // eslint-disable-line no-restricted-syntax
    if (way === 'whatsapp') {
      if (!String(r.contactPhone || '').trim()) { sent.push({ way: 'WhatsApp', ok: false, local: true, to: '', error: 'Type the client\'s WhatsApp number first.' }); continue; } // eslint-disable-line no-continue
      const nm = core.normalizeMobile(r.contactPhone);
      if (!nm.ok) { sent.push({ way: 'WhatsApp', ok: false, local: true, to: '', error: 'That number does not look right. Check it.' }); continue; } // eslint-disable-line no-continue
      let res = null; let mode = 'link'; let why = '';
      if (r.kind === 'image' && item) { // a picture / video goes as ITSELF with Approve / Reject buttons (2026-11-21); never as a link
        const AS = require('./approvalSend'); // eslint-disable-line global-require
        const f = await AS.mediaFile(item, r.id, 15 * 1024 * 1024); // eslint-disable-line no-await-in-loop
        if (!f.path) { sent.push({ way: 'WhatsApp', ok: false, to: core.maskMobile(nm.e164), error: f.skip || 'The file could not be prepared.' }); continue; } // eslint-disable-line no-continue
        const caption = `${first ? `Hello ${first},` : 'Hello,'} ${r.message ? S.clip(r.message, 400) : `please review the ${word} "${S.clip(r.itemTitle, 80)}" and tell us if it is OK to use.`} Tap Approve, or Reject and tell us why.`;
        const tpl = require('./waTemplates').payload((await require('./settings').getSettings()).waTemplates, 'approval', { name: first || 'there', occasion: S.clip(r.itemTitle, 80) }); // eslint-disable-line global-require
        const w = await AS.waOne({ e164: nm.e164, file: f, text: caption, buttons: AS.buttonsFor('mkr', r.id), numberOpts: Sender.opts(pk), meta, templatePayload: tpl }); // eslint-disable-line no-await-in-loop
        f.cleanup();
        if (w.ok) { res = w.res; mode = 'picture'; }
        else if (w.closed) { // outside the 24 hours and no approval template: a short note with no link, the file is held until the client replies
          const note = `${first ? `Hello ${first},` : 'Hello,'} your ${word} "${S.clip(r.itemTitle, 80)}" is ready for you to approve. Please reply YES to this message and we will send it here.`;
          res = await messaging.send('WhatsApp', { to: nm.e164, kind: 'bulk', text: `${note}\n\nReply STOP to stop messages from us.`, vars: [note], meta, ...Sender.opts(pk) }); // eslint-disable-line no-await-in-loop
          if (res && res.ok) { await require('./approvalSend').ensure(); await S.run('INSERT INTO "OmniMkApprovalWait" (id, type, kind, refId, optionId, phone, numberId, createdAt) VALUES (?,?,?,?,?,?,?,?)', S.newId('aw'), 'hold', 'review', r.id, null, require('./approvalSend').last10(nm.e164), pk.numberId || null, Date.now()); mode = 'held'; why = `The client is outside WhatsApp's 24 hours, so a short note went first; the ${word} goes the moment they reply.`; } // eslint-disable-line no-await-in-loop
        } else { sent.push({ way: 'WhatsApp', ok: false, to: core.maskMobile(nm.e164), error: w.error }); continue; } // eslint-disable-line no-continue
      } else {
        res = await messaging.send('WhatsApp', { to: nm.e164, kind: 'bulk', text: `${text}\n\nReply STOP to stop messages from us.`, vars: [text], meta, ...Sender.opts(pk) }); // eslint-disable-line no-await-in-loop -- words (not a picture / video): the link is the way to read them
      }
      const ok = !!(res && res.ok);
      if (ok) await require('./remind').schedule({ kind: 'review', refId: r.id, phone: r.contactPhone, name: P.firstWord(r.contactName), clientName: r.clientName, by: u, numberId: pk.numberId || null }); // eslint-disable-line no-await-in-loop, global-require -- ONE reminder after 24 hours if they do not answer
      sent.push({ way: 'WhatsApp', ok, to: core.maskMobile(nm.e164), mode, from: Sender.fromWords(res).trim(), note: ok ? why : '', error: ok ? '' : S.clip((res && (res.notConfigured || res.outcome === 'Not configured') ? `It is not connected: ${res.error || 'ask an Admin to connect it in Administration > Integrations'}` : (res && res.error)) || 'The sender refused it.', 200).replace(/(\+?\d[\d\s-]{8,}\d)/g, 'a number') });
    } else {
      const em = String(r.contactEmail || '').trim();
      if (!em) { sent.push({ way: 'Email', ok: false, local: true, to: '', error: 'This link has no email address.' }); continue; } // eslint-disable-line no-continue
      let attachments; let cleanup = () => {};
      if (r.kind === 'image' && item) { const f = await require('./approvalSend').mediaFile(item, r.id, 12 * 1024 * 1024); if (f.path) { attachments = [{ filename: f.name, content: require('fs').readFileSync(f.path), contentType: f.mime }]; cleanup = f.cleanup; } } // eslint-disable-line global-require, no-await-in-loop
      const res = await messaging.send('Email', { to: em, subject: `Please review: ${r.itemTitle}`, text: attachments ? `${text}\n\nThe ${word} is attached. Approve: ${link}?do=approve   Reject: ${link}?do=reject` : text, ...(attachments ? { attachments } : {}), meta }); // eslint-disable-line no-await-in-loop
      cleanup();
      const ok = !!(res && res.ok);
      sent.push({ way: 'Email', ok, to: core.maskEmail(em), mode: 'link', note: '', error: ok ? '' : S.clip((res && res.error) || 'The sender refused it.', 200).replace(/(\+?\d[\d\s-]{8,}\d)/g, 'a number') });
    }
  }
  const good = sent.filter((x) => x.ok);
  if (!good.length) { const err = sent.map((x) => `${x.way}: ${x.error}`).join(' '); return { error: err || 'Nothing could be sent.', sent, status: sent.every((x) => x.local) ? 400 : 502 }; }
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client approval link sent by TeamLink', entity: TABLE, entityId: r.id, toValue: `${r.itemTitle} to ${r.clientName}: ${sent.map((x) => `${x.way} ${x.ok ? (x.mode === 'picture' ? 'sent with the file' : 'sent') : 'failed'}`).join(', ')}` });
  const notes = good.map((x) => x.note).filter(Boolean);
  return { ok: `Sent by ${good.map((x) => `${x.way}${x.from ? ` ${x.from}` : ''}${x.mode === 'picture' ? ` (the ${word} itself, with the link)` : ' (the link)'}`).join(' and ')}.${notes.length ? ` ${notes[0]}` : ''}${sent.some((x) => !x.ok) ? ` Not sent: ${sent.filter((x) => !x.ok).map((x) => `${x.way}: ${x.error}`).join(' ')}` : ''}`, sent };
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

// ---- the client's answer from WhatsApp (marketing/approvalSend.js onInbound) ----------------------------------------------------------------------------------
async function answerByButton(reviewId, approve, from10, numberId) {
  await ensure();
  const r = await row(reviewId);
  if (!r) return { error: 'not found' };
  if (String(r.contactPhone || '').replace(/\D/g, '').slice(-10) !== from10) return { note: 'a tap from a number that is not the client\'s: ignored' };
  const name = S.clip(r.contactName || r.clientName, 80) || 'Client';
  const out = await publicDecide(tokenOf(r.id), approve ? { decision: 'approve', name, comment: '' } : { decision: 'changes', name, comment: '(reason asked on WhatsApp)' }, 'WhatsApp button');
  if (out.error) return { error: out.error, reply: 'Thank you. ' + out.error };
  if (approve) return { note: 'approved', reply: 'Thank you! We have recorded your approval.' };
  await require('./approvalSend').ensure(); // eslint-disable-line global-require
  await S.run('INSERT INTO "OmniMkApprovalWait" (id, type, kind, refId, optionId, phone, numberId, createdAt) VALUES (?,?,?,?,?,?,?,?)', S.newId('aw'), 'reason', 'review', r.id, null, from10, numberId || null, Date.now());
  return { note: 'rejected, reason asked', reply: 'Thank you. Please reply here with a few words on what you would like changed.' };
}
async function setReasonByReply(reviewId, text) {
  const r = await row(reviewId);
  const why = S.clip(text, 600);
  if (!r || !why) return { note: 'nothing to update' };
  await S.run(`UPDATE "${TABLE}" SET comment = ?, updatedAt = ? WHERE id = ?`, why, Date.now(), r.id);
  if (r.createdById) await notifyUsers([r.createdById], { title: 'Why the client rejected "' + S.clip(r.itemTitle, 60) + '"', message: S.clip(why, 280) });
  return { note: 'reason recorded' };
}
async function deliverHeld(reviewId, fromPhone, numberId) {
  const g = await load(tokenOf(reviewId));
  if (!g || !g.item || g.r.status !== 'sent') return { note: 'nothing to deliver' };
  const AS = require('./approvalSend'); // eslint-disable-line global-require
  const f = await AS.mediaFile(g.item, g.r.id, 15 * 1024 * 1024);
  if (!f.path) return { note: f.skip };
  const word = /^video\//.test(g.item.mime || '') ? 'video' : 'picture';
  const w = await AS.waOne({ e164: fromPhone, file: f, text: 'Here is the ' + word + ' "' + S.clip(g.r.itemTitle, 80) + '". Tap Approve, or Reject and tell us why.', buttons: AS.buttonsFor('mkr', g.r.id), numberOpts: numberId ? { numberId, automatic: true } : { automatic: true }, meta: { audience: 'client', purpose: 'AI Marketing: held picture / video for approval', module: 'AI Marketing', automatic: true } });
  f.cleanup();
  return { note: w.ok ? 'delivered' : 'delivery failed: ' + (w.error || '') };
}

module.exports = { ensure, attach, create, list, revoke, extend, tell, publicView, publicFile, publicDecide, answerByButton, setReasonByReply, deliverHeld, tokenOf, idOfToken, snapshotOf, heldIds };
