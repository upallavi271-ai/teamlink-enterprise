// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT PROJECTS (2026-11-14). The real agency workflow, in one place:
//   1 request   a client asks for a creative (for example "a Diwali video with our logo") by email, WhatsApp, phone or in our portal. The team logs it here, or
//               sends the client a private REQUEST LINK (status 'invited') and the client fills the brief, their social pages and their logo themselves.
//   2 accept    the team accepts the request (it gets an owner) or declines it with a reason.
//   3 work      the team makes pictures / videos in AI Images and AI Video (the project's logo and colours are used) and PICKS several as OPTIONS.
//   4 present   one private link shows ALL the options to the client. The client picks ONE and may add suggestions, or asks for changes with suggestions.
//               The client's pick IS the approval: the chosen picture / video becomes Approved by the client; the others go back to Drafts.
//   5 post      the approved creative is posted on the client's social pages: the caption, the file and the Calendar are ready; "Mark as posted" ends the project.
//   The client's link is one page for the whole life of the project: the request form, then the progress, then the options, then the final result.
// status    invited -> request -> working -> awaiting_client -> approved -> posted     (declined from request / working)
// link      /client-project/<id>.<signature>: HMAC of the id, nothing secret is stored; options are served by option id (never an item id or a file path).
// money     none: nothing here calls a paid service.
// audit     every step is in the audit log ("Omni-Channel AI Marketing: project ...") and in the project's own timeline.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('../outreach/store');
const A = require('../outreach/access');
const AI = require('./ai');
const Cfg = require('./settings');
const { logAudit } = require('../utils/audit');
const { notifyUsers } = require('../utils/notify');

const T = 'OmniMkProject'; const TO = 'OmniMkProjectOption'; const TE = 'OmniMkProjectEvent';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL DEFAULT '', "clientId" TEXT, "clientName" TEXT NOT NULL DEFAULT '', "contactName" TEXT, "contactEmail" TEXT, "contactPhone" TEXT, "source" TEXT NOT NULL DEFAULT 'other', "occasion" TEXT, "brief" TEXT, "deliverable" TEXT NOT NULL DEFAULT 'video', "platforms" TEXT NOT NULL DEFAULT '[]', "handles" TEXT, "caption" TEXT, "dueDate" TEXT, "status" TEXT NOT NULL DEFAULT 'request', "logoData" TEXT, "colors" TEXT, "department" TEXT, "ownerId" TEXT, "ownerName" TEXT, "createdById" TEXT, "createdByName" TEXT, "acceptedAt" DATETIME, "acceptedByName" TEXT, "round" INTEGER NOT NULL DEFAULT 0, "linkExpiresAt" DATETIME, "clientMessage" TEXT, "chosenOptionId" TEXT, "decidedAt" DATETIME, "decidedByName" TEXT, "decisionNote" TEXT, "scheduledFor" TEXT, "postUrl" TEXT, "postedAt" DATETIME, "postedByName" TEXT, "declinedNote" TEXT, "views" INTEGER NOT NULL DEFAULT 0, "viewedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${T}_status" ON "${T}"("status", "updatedAt")`,
  `CREATE TABLE IF NOT EXISTS "${TO}" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "round" INTEGER NOT NULL DEFAULT 1, "itemId" TEXT NOT NULL, "label" TEXT NOT NULL DEFAULT '', "sortNo" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${TO}_project" ON "${TO}"("projectId", "round")`,
  `CREATE TABLE IF NOT EXISTS "${TE}" ("id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "at" DATETIME NOT NULL DEFAULT 0, "kind" TEXT NOT NULL, "byName" TEXT, "text" TEXT)`,
  `CREATE INDEX IF NOT EXISTS "${TE}_project" ON "${TE}"("projectId", "at")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try {
    for (const sql of DDL) await S.run(sql); // eslint-disable-line no-await-in-loop
    // the portfolio flags (2026-11-14): "the client agrees we show this work", its public title, and whether the client's name may be shown
    for (const col of ['"showcase" INTEGER NOT NULL DEFAULT 0', '"showcaseTitle" TEXT', '"showcaseClient" INTEGER NOT NULL DEFAULT 0']) { try { await S.run(`ALTER TABLE "${T}" ADD COLUMN ${col}`); } catch { /* the column is already there */ } } // eslint-disable-line no-await-in-loop
    await AI.ensure(); okAt = Date.now(); return true;
  } catch (e) { console.error('[omni-mk] projects schema:', e.message); return false; } // eslint-disable-line no-console
}

const SOURCES = [{ key: 'email', label: 'Email' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'portal', label: 'Client portal' }, { key: 'phone', label: 'Phone call' }, { key: 'link', label: 'Request link' }, { key: 'other', label: 'Other' }];
const DELIVERABLES = [{ key: 'video', label: 'A video' }, { key: 'image', label: 'Pictures' }, { key: 'both', label: 'Video and pictures' }];
const PLATFORM_KEYS = ['facebook', 'instagram', 'linkedin', 'x', 'whatsapp'];
const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', whatsapp: 'WhatsApp status' };
const DAY = 86400000;
const MAX_OPTIONS = 8;
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch { return d; } };
const HEX = /^#[0-9a-f]{6}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- the private link ------------------------------------------------------------------------------------------------------------------------
const secret = () => process.env.MK_PROJECT_SECRET || process.env.JWT_SECRET || 'teamlink-dev';
const sigOf = (id) => crypto.createHmac('sha256', secret()).update(`mk-project:${id}`).digest('base64url').slice(0, 32);
const tokenOf = (id) => `${id}.${sigOf(id)}`;
function idOfToken(token) {
  const m = /^([A-Za-z0-9]{8,40})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const want = Buffer.from(sigOf(m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}

// ---- who may do what -------------------------------------------------------------------------------------------------------------------------
const mayWrite = (u) => A.has('mayAiMarketing')(u);
function visible(u, r) {
  if (r.deletedAt || !mayWrite(u)) return false;
  if (A.isAdmin(u) || r.createdById === u.id || r.ownerId === u.id) return true;
  return A.mayDepartment(u, r.department || '');
}
const row = async (id) => (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, String(id || '')))[0] || null;
const optionRows = async (projectId) => S.q(`SELECT * FROM "${TO}" WHERE projectId = ? ORDER BY round ASC, sortNo ASC, createdAt ASC`, projectId);
async function event(projectId, kind, byName, text) {
  await S.run(`INSERT INTO "${TE}" (id, projectId, at, kind, byName, text) VALUES (?,?,?,?,?,?)`, S.newId('pe'), projectId, Date.now(), kind, S.clip(byName, 80) || null, S.clip(text, 800) || null);
}
const short = (r) => ({
  id: r.id, title: r.title, clientName: r.clientName, contactName: r.contactName || '', contactEmail: r.contactEmail || '', contactPhone: r.contactPhone || '', source: r.source || 'other',
  occasion: r.occasion || '', brief: r.brief || '', deliverable: r.deliverable || 'video', platforms: parse(r.platforms, []), handles: r.handles || '', caption: r.caption || '', dueDate: r.dueDate || '',
  status: r.status, hasLogo: !!r.logoData, colors: parse(r.colors, null), department: r.department || '', ownerName: r.ownerName || '', createdByName: r.createdByName || '',
  createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt), acceptedAt: S.iso(r.acceptedAt), acceptedByName: r.acceptedByName || '', round: S.num(r.round),
  linkExpiresAt: S.iso(r.linkExpiresAt), linkExpired: r.status === 'awaiting_client' && S.num(r.linkExpiresAt) < Date.now(), clientMessage: r.clientMessage || '',
  chosenOptionId: r.chosenOptionId || '', decidedAt: S.iso(r.decidedAt), decidedByName: r.decidedByName || '', decisionNote: r.decisionNote || '', scheduledFor: r.scheduledFor || '',
  postUrl: r.postUrl || '', postedAt: S.iso(r.postedAt), postedByName: r.postedByName || '', declinedNote: r.declinedNote || '', views: S.num(r.views), viewedAt: S.iso(r.viewedAt),
  showcase: S.num(r.showcase) === 1, showcaseTitle: r.showcaseTitle || '', showcaseClient: S.num(r.showcaseClient) === 1,
  link: `/client-project/${tokenOf(r.id)}`,
});

// ---- cleaning ----------------------------------------------------------------------------------------------------------------------------------
function cleanFields(b, cur = {}) {
  const pick = (k, n) => (b[k] !== undefined ? S.clip(b[k], n) : (cur[k] || ''));
  const out = {};
  out.clientName = pick('clientName', 120);
  out.contactName = pick('contactName', 120); out.contactPhone = pick('contactPhone', 30); out.contactEmail = pick('contactEmail', 160);
  if (out.contactEmail && !/^\S+@\S+\.\S+$/.test(out.contactEmail)) return { error: 'That email address does not look right.', status: 400 };
  out.occasion = pick('occasion', 120);
  out.brief = b.brief !== undefined ? String(b.brief || '').replace(/\r/g, '').trim().slice(0, 3000) : (cur.brief || '');
  out.handles = b.handles !== undefined ? String(b.handles || '').replace(/\r/g, '').trim().slice(0, 600) : (cur.handles || '');
  out.caption = b.caption !== undefined ? String(b.caption || '').replace(/\r/g, '').trim().slice(0, 3000) : (cur.caption || '');
  out.source = b.source !== undefined ? (SOURCES.some((s) => s.key === b.source) ? b.source : 'other') : (cur.source || 'other');
  out.deliverable = b.deliverable !== undefined ? (DELIVERABLES.some((d) => d.key === b.deliverable) ? b.deliverable : 'video') : (cur.deliverable || 'video');
  out.platforms = (b.platforms !== undefined ? (Array.isArray(b.platforms) ? b.platforms : []) : parse(cur.platforms, [])).map(String).filter((k, i, a) => PLATFORM_KEYS.includes(k) && a.indexOf(k) === i);
  out.dueDate = b.dueDate !== undefined ? S.clip(b.dueDate, 10) : (cur.dueDate || '');
  if (out.dueDate && !DATE.test(out.dueDate)) return { error: 'Pick the date the client needs it by.', status: 400 };
  if (b.colors !== undefined) {
    const c = b.colors && typeof b.colors === 'object' ? b.colors : {};
    out.colors = HEX.test(c.primary || '') || HEX.test(c.secondary || '') ? { primary: HEX.test(c.primary || '') ? c.primary.toLowerCase() : '', secondary: HEX.test(c.secondary || '') ? c.secondary.toLowerCase() : '' } : null;
  } else out.colors = parse(cur.colors, null);
  if (b.logoDataUrl !== undefined) {
    if (!b.logoDataUrl) out.logoData = null;
    else { const l = Cfg.cleanLogo({ dataUrl: b.logoDataUrl, name: b.logoName }); if (l.error) return { error: l.error.replace('The logo is too big', 'The client logo is too big'), status: 400 }; out.logoData = l.value.dataUrl; }
  } else out.logoData = cur.logoData || null;
  return { value: out };
}

// ---- staff: log a request, invite, list, open, change ---------------------------------------------------------------------------------------------
async function create(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at client projects but not start them.', status: 403 };
  const c = cleanFields(b);
  if (c.error) return c;
  const v = c.value;
  if (v.clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  if (v.occasion.length < 2) return { error: 'Say what it is for (for example Diwali offer, Independence Day).', status: 400 };
  if (v.brief.length < 10) return { error: 'Write the brief the client gave, in a sentence or two.', status: 400 };
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const id = S.newId('prj'); const now = Date.now(); const accept = b.accept === true;
  await S.run(`INSERT INTO "${T}" (id, title, clientId, clientName, contactName, contactEmail, contactPhone, source, occasion, brief, deliverable, platforms, handles, caption, dueDate, status, logoData, colors, department, ownerId, ownerName, createdById, createdByName, acceptedAt, acceptedByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, S.clip(b.title, 120) || `${v.clientName}: ${v.occasion}`, S.clip(b.clientId, 40) || null, v.clientName, v.contactName || null, v.contactEmail || null, v.contactPhone || null, v.source, v.occasion, v.brief, v.deliverable,
    JSON.stringify(v.platforms), v.handles || null, v.caption || null, v.dueDate || null, accept ? 'working' : 'request', v.logoData, v.colors ? JSON.stringify(v.colors) : null, dept || null,
    accept ? u.id : null, accept ? S.clip(u.name, 80) : null, u.id, S.clip(u.name, 80), accept ? now : null, accept ? S.clip(u.name, 80) : null, now, now);
  await event(id, 'request', u.name, `Request logged (${(SOURCES.find((s) => s.key === v.source) || {}).label || 'Other'}): ${v.occasion}`);
  if (accept) await event(id, 'accepted', u.name, 'Accepted: the team starts work');
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project started', entity: T, entityId: id, toValue: `${v.clientName}: ${v.occasion}; ${v.source}${accept ? '; accepted' : ''}` });
  return { project: short(await row(id)) };
}
// a private REQUEST LINK: the client writes the brief and adds the logo themselves (this is the "request in our portal" without a login)
async function invite(u, b = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login can look at client projects but not start them.', status: 403 };
  const clientName = S.clip(b.clientName, 120);
  if (clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  const email = S.clip(b.contactEmail, 160);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { error: 'That email address does not look right.', status: 400 };
  const dept = S.clip(b.department, 60) || (A.departmentsOf(u).length === 1 ? A.departmentsOf(u)[0] : S.clip(u.department, 60));
  const id = S.newId('prj'); const now = Date.now();
  await S.run(`INSERT INTO "${T}" (id, title, clientId, clientName, contactName, contactEmail, contactPhone, source, status, department, ownerId, ownerName, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,'link','invited',?,?,?,?,?,?,?)`,
    id, `${clientName}: new request`, S.clip(b.clientId, 40) || null, clientName, S.clip(b.contactName, 120) || null, email || null, S.clip(b.contactPhone, 30) || null, dept || null, u.id, S.clip(u.name, 80), u.id, S.clip(u.name, 80), now, now);
  await event(id, 'invited', u.name, `Request link made for ${clientName}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client request link made', entity: T, entityId: id, toValue: clientName });
  return { project: short(await row(id)) };
}
async function list(u, { status = '', q = '' } = {}) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login cannot open client projects.', status: 403 };
  const rows = (await S.q(`SELECT * FROM "${T}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 600`)).filter((r) => visible(u, r));
  const needle = String(q || '').trim().toLowerCase();
  const counts = { all: 0 }; rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; counts.all += 1; });
  const shown = rows.filter((r) => (!status || r.status === status) && (!needle || `${r.title} ${r.clientName} ${r.occasion}`.toLowerCase().includes(needle)));
  return { projects: shown.map(short), counts, canWrite: true };
}
async function getVisible(u, id) {
  await ensure();
  if (!mayWrite(u)) return { error: 'Your login cannot open client projects.', status: 403 };
  const r = await row(id);
  if (!r || !visible(u, r)) return { error: 'This project was not found.', status: 404 };
  return { r };
}
async function itemInfo(r) { // a picture / video row as the team sees it
  if (!r) return null;
  return { id: r.id, title: r.title, kind: /^video\//.test(r.mime || '') ? 'video' : 'image', aspect: r.aspect || '1:1', status: r.status, style: r.style || '' };
}
async function get(u, id) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  const Img = require('./images'); // eslint-disable-line global-require
  await Img.ensure();
  const opts = await optionRows(r.id);
  const withItem = [];
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await itemInfo(await Img.rawRow(o.itemId)); // eslint-disable-line no-await-in-loop
    withItem.push({ id: o.id, round: S.num(o.round), label: o.label, itemId: o.itemId, item: it, chosen: r.chosenOptionId === o.id });
  }
  const events = (await S.q(`SELECT * FROM "${TE}" WHERE projectId = ? ORDER BY at ASC`, r.id)).map((e) => ({ id: e.id, at: S.iso(e.at), kind: e.kind, byName: e.byName || '', text: e.text || '' }));
  const made = (await S.q('SELECT id, title, mime, aspect, status, style FROM "OmniMkImage" WHERE projectId = ? AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT 60', r.id).catch(() => [])).map((x) => ({ id: x.id, title: x.title, kind: /^video\//.test(x.mime || '') ? 'video' : 'image', aspect: x.aspect || '1:1', status: x.status, style: x.style || '' }));
  const cur = S.num(r.round);
  return { project: short(r), logo: r.logoData || null, options: withItem.map((o) => ({ ...o, stage: o.round === cur + 1 ? 'staged' : o.round === cur ? 'presented' : 'earlier' })), events, made };
}
async function update(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (['posted', 'declined'].includes(r.status)) return { error: 'This project is finished. Its record stays as it is.', status: 409 };
  const c = cleanFields(b, r);
  if (c.error) return c;
  const v = c.value;
  if (v.clientName.length < 2) return { error: 'Write the client\'s name (the company).', status: 400 };
  await S.run(`UPDATE "${T}" SET clientName = ?, contactName = ?, contactEmail = ?, contactPhone = ?, source = ?, occasion = ?, brief = ?, deliverable = ?, platforms = ?, handles = ?, caption = ?, dueDate = ?, logoData = ?, colors = ?, title = ?, updatedAt = ? WHERE id = ?`,
    v.clientName, v.contactName || null, v.contactEmail || null, v.contactPhone || null, v.source, v.occasion || null, v.brief || null, v.deliverable, JSON.stringify(v.platforms), v.handles || null, v.caption || null, v.dueDate || null, v.logoData, v.colors ? JSON.stringify(v.colors) : null,
    b.title !== undefined ? (S.clip(b.title, 120) || r.title) : r.title, Date.now(), r.id);
  return { project: short(await row(r.id)) };
}

// ---- accept / decline ------------------------------------------------------------------------------------------------------------------------------
async function accept(u, id) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'request') return { error: r.status === 'invited' ? 'The client has not sent the request yet.' : 'This request was already handled.', status: 409 };
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = 'working', ownerId = ?, ownerName = ?, acceptedAt = ?, acceptedByName = ?, updatedAt = ? WHERE id = ?`, u.id, S.clip(u.name, 80), now, S.clip(u.name, 80), now, r.id);
  await event(r.id, 'accepted', u.name, 'Accepted: the team starts work');
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project accepted', entity: T, entityId: r.id, toValue: `${r.clientName}: ${r.occasion}` });
  return { ok: 'Accepted. You own this project now.', project: short(await row(r.id)) };
}
async function decline(u, id, note) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (!['request', 'working'].includes(r.status)) return { error: 'Only a new request, or one being worked on, can be declined.', status: 409 };
  const why = S.clip(note, 400);
  if (why.length < 5) return { error: 'Write a few words for the client: why it is declined.', status: 400 };
  await releaseItems(r, 'draft');
  await S.run(`UPDATE "${T}" SET status = 'declined', declinedNote = ?, updatedAt = ? WHERE id = ?`, why, Date.now(), r.id);
  await event(r.id, 'declined', u.name, why);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project declined', entity: T, entityId: r.id, toValue: `${r.clientName}: ${why}` });
  return { ok: 'Declined. The client sees the reason on their page.', project: short(await row(r.id)) };
}

// ---- options: pick what to show the client, then present it ----------------------------------------------------------------------------------------
const letter = (i) => `Option ${String.fromCharCode(65 + i)}`;
async function setOptions(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'working') return { error: r.status === 'request' ? 'Accept the request first.' : 'Options can be changed only while the team is working on it.', status: 409 };
  const Img = require('./images'); // eslint-disable-line global-require
  const list = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_OPTIONS + 1);
  if (!list.length) { // clearing the options is allowed (only SENDING needs at least one)
    await S.run(`DELETE FROM "${TO}" WHERE projectId = ? AND round = ?`, r.id, S.num(r.round) + 1);
    await S.run(`UPDATE "${T}" SET updatedAt = ? WHERE id = ?`, Date.now(), r.id);
    return { ok: 'The options were cleared.' };
  }
  if (list.length > MAX_OPTIONS) return { error: `Show the client at most ${MAX_OPTIONS} options: fewer, better ones are easier to choose from.`, status: 400 };
  const seen = new Set(); const clean = [];
  for (let i = 0; i < list.length; i += 1) {
    const itemId = String((list[i] && list[i].itemId) || '');
    if (seen.has(itemId)) return { error: 'The same picture or video was picked twice.', status: 400 };
    seen.add(itemId);
    const got = await Img.getRow(u, itemId); // eslint-disable-line no-await-in-loop
    if (!got) return { error: 'One of the pictures or videos was not found.', status: 404 };
    if (got.r.style === 'clip') return { error: 'A raw clip cannot be shown to a client: make a video from it first.', status: 400 };
    if (!['draft', 'changes', 'approved'].includes(got.r.status)) return { error: `"${got.r.title}" is already waiting for somebody's approval.`, status: 409 };
    clean.push({ itemId, label: S.clip(list[i].label, 40) || letter(i) });
  }
  const round = S.num(r.round) + 1; const now = Date.now();
  await S.run(`DELETE FROM "${TO}" WHERE projectId = ? AND round = ?`, r.id, round);
  for (let i = 0; i < clean.length; i += 1) {
    await S.run(`INSERT INTO "${TO}" (id, projectId, round, itemId, label, sortNo, createdAt) VALUES (?,?,?,?,?,?,?)`, S.newId('po'), r.id, round, clean[i].itemId, clean[i].label, i, now); // eslint-disable-line no-await-in-loop
    await S.run('UPDATE "OmniMkImage" SET projectId = ? WHERE id = ? AND projectId IS NULL', r.id, clean[i].itemId); // eslint-disable-line no-await-in-loop
  }
  await S.run(`UPDATE "${T}" SET updatedAt = ? WHERE id = ?`, now, r.id);
  return { ok: `${clean.length} option${clean.length === 1 ? '' : 's'} ready to send.` };
}
// the items of the presented round go back to Drafts (the client's answer, a cancelled link): only the ones the client was holding
async function releaseItems(r, to = 'draft') {
  const Img = require('./images'); // eslint-disable-line global-require
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (it && it.status === 'waiting' && to === 'draft') await Img.backToDraft(o.itemId); // eslint-disable-line no-await-in-loop
  }
}
async function send(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'working') return { error: r.status === 'awaiting_client' ? 'The options are already with the client.' : 'Options can be sent only while the team is working on it.', status: 409 };
  const Img = require('./images'); // eslint-disable-line global-require
  const round = S.num(r.round) + 1;
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === round);
  if (!opts.length) return { error: 'Pick the pictures or videos to show the client first.', status: 400 };
  const days = Math.max(1, Math.min(30, Number(b.days) || 14)); const now = Date.now();
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (!it || it.deletedAt) return { error: 'One of the options was deleted. Pick the options again.', status: 409 };
    if (['draft', 'changes'].includes(it.status)) await Img.holdForClient(u, it); // eslint-disable-line no-await-in-loop
  }
  const message = S.clip(b.message, 500);
  await S.run(`UPDATE "${T}" SET status = 'awaiting_client', round = ?, linkExpiresAt = ?, clientMessage = ?, caption = ?, updatedAt = ? WHERE id = ?`, round, now + days * DAY, message || null, b.caption !== undefined ? (S.clip(b.caption, 3000) || null) : r.caption, now, r.id);
  await event(r.id, 'options_sent', u.name, `${opts.length} option${opts.length === 1 ? '' : 's'} sent to the client (round ${round})${message ? `: ${message}` : ''}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: project options sent to the client', entity: T, entityId: r.id, toValue: `${r.clientName}: ${opts.length} option(s); link valid ${days} day(s)` });
  return { ok: 'The options are with the client. Share the private link.', project: short(await row(r.id)) };
}
async function cancelPresentation(u, id) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'awaiting_client') return { error: 'The options are not with the client.', status: 409 };
  await releaseItems(r);
  await S.run(`UPDATE "${T}" SET status = 'working', round = ?, linkExpiresAt = NULL, updatedAt = ? WHERE id = ?`, Math.max(0, S.num(r.round) - 1), Date.now(), r.id); // the same options are staged again
  await event(r.id, 'cancelled', u.name, 'The link was cancelled; the options are back with the team');
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: project options taken back', entity: T, entityId: r.id, toValue: r.clientName });
  return { ok: 'The link no longer shows the options. They are back with you.', project: short(await row(r.id)) };
}
async function extend(u, id, days) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'awaiting_client') return { error: 'Only a link that is waiting for an answer can be extended.', status: 409 };
  const d = Math.max(1, Math.min(30, Number(days) || 14));
  await S.run(`UPDATE "${T}" SET linkExpiresAt = ?, updatedAt = ? WHERE id = ?`, Date.now() + d * DAY, Date.now(), r.id);
  await event(r.id, 'extended', u.name, `The link works for ${d} more day${d === 1 ? '' : 's'}`);
  return { ok: `The link works for ${d} more day${d === 1 ? '' : 's'}.`, project: short(await row(r.id)) };
}

// ---- after the client approved: schedule, post -------------------------------------------------------------------------------------------------------
async function scheduled(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'approved') return { error: 'Only an approved project can be scheduled.', status: 409 };
  const date = S.clip(b.date, 10);
  if (!DATE.test(date)) return { error: 'Pick the day it will be posted.', status: 400 };
  await S.run(`UPDATE "${T}" SET scheduledFor = ?, updatedAt = ? WHERE id = ?`, date, Date.now(), r.id);
  await event(r.id, 'scheduled', u.name, `Planned in the Content Calendar for ${date}`);
  return { project: short(await row(r.id)) };
}
async function posted(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (r.status !== 'approved') return { error: r.status === 'posted' ? 'It is already marked as posted.' : 'Only an approved project can be marked as posted.', status: 409 };
  const url = S.clip(b.postUrl, 500);
  if (url && !/^https?:\/\//i.test(url)) return { error: 'The post link must start with https://', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = 'posted', postUrl = ?, postedAt = ?, postedByName = ?, updatedAt = ? WHERE id = ?`, url || null, now, S.clip(u.name, 80), now, r.id);
  await event(r.id, 'posted', u.name, `Posted on the client's page${url ? `: ${url}` : ''}`);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: client project posted', entity: T, entityId: r.id, toValue: `${r.clientName}: ${r.occasion}${url ? `; ${url}` : ''}` });
  return { ok: 'Marked as posted. The client sees it on their page.', project: short(await row(r.id)) };
}

// items the client is deciding on right now (marketing/clientReview.js adds them to the "only the client can approve" set)
async function heldIds() {
  await ensure();
  const rows = await S.q(`SELECT o.itemId AS itemId FROM "${TO}" o JOIN "${T}" p ON p.id = o.projectId WHERE p.status = 'awaiting_client' AND p.deletedAt IS NULL AND p.linkExpiresAt > ? AND o.round = p.round`, Date.now());
  return new Set(rows.map((x) => x.itemId));
}

// ---- OUR WORK: the track record and the portfolio that new and existing clients can see (no login) -----------------------------------------------------
// What is shown: (1) numbers over ALL finished projects, with no names: how fast the first options came, how often the client chose from the first set
// (our "accuracy"), how often we posted by the date the client needed it; a percentage appears only once there are 3 projects behind it. (2) the projects the
// team marked "the client agrees we show this work": the chosen picture / video, what it was for, and its timeline. The client's name stays hidden unless
// the team ticked it. Files are served by a signed key of the chosen option, and only while the project is marked to be shown.
const MIN_SAMPLE = 3;
const workSig = (optionId) => crypto.createHmac('sha256', secret()).update(`mk-work:${optionId}`).digest('base64url').slice(0, 32);
function optionIdOfKey(key) {
  const m = /^([A-Za-z0-9]{8,40})\.([A-Za-z0-9_-]{32})$/.exec(String(key || ''));
  if (!m) return null;
  const want = Buffer.from(workSig(m[1])); const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}
const istDay = (ms) => new Date(S.num(ms) + 19800000).toISOString().slice(0, 10);
async function setShowcase(u, id, b = {}) {
  const g = await getVisible(u, id); if (g.error) return g;
  const { r } = g;
  if (!['approved', 'posted'].includes(r.status) || !r.chosenOptionId) return { error: 'Only a project the client has approved can be shown in our portfolio.', status: 409 };
  const show = b.show === true;
  if (show && b.consent !== true) return { error: 'Tick that the client agrees we may show this work.', status: 400 };
  const title = S.clip(b.title, 80) || r.occasion || r.title;
  await S.run(`UPDATE "${T}" SET showcase = ?, showcaseTitle = ?, showcaseClient = ?, updatedAt = ? WHERE id = ?`, show ? 1 : 0, title, show && b.showName === true ? 1 : 0, Date.now(), r.id);
  await event(r.id, 'showcase', u.name, show ? `Shown in our portfolio${b.showName === true ? ' with the client\'s name' : ' without the client\'s name'}` : 'Taken out of our portfolio');
  await logAudit({ userId: u.id, actorName: u.name, action: show ? 'Omni-Channel AI Marketing: client project shown in the portfolio' : 'Omni-Channel AI Marketing: client project taken out of the portfolio', entity: T, entityId: r.id, toValue: `${r.clientName}: ${title}${show ? (b.showName === true ? '; name shown' : '; anonymous') : ''}` });
  return { ok: show ? 'It is in our portfolio now.' : 'It is out of our portfolio.', project: short(await row(r.id)) };
}
async function trackRecord() {
  await ensure();
  const rows = await S.q(`SELECT id, status, round, dueDate, createdAt, postedAt FROM "${T}" WHERE deletedAt IS NULL AND status IN ('approved', 'posted')`);
  const first = {}; (await S.q(`SELECT projectId, MIN(at) AS at FROM "${TE}" WHERE kind = 'options_sent' GROUP BY projectId`)).forEach((e) => { first[e.projectId] = S.num(e.at); });
  const approved = rows.length; const delivered = rows.filter((r) => r.status === 'posted').length;
  const hours = rows.map((r) => (first[r.id] ? (first[r.id] - S.num(r.createdAt)) / 3600000 : null)).filter((x) => x != null && x >= 0);
  const due = rows.filter((r) => r.status === 'posted' && r.dueDate);
  const pct = (a, b) => Math.round((100 * a) / b);
  return {
    approved, delivered, minSample: MIN_SAMPLE,
    avgHoursToOptions: hours.length >= MIN_SAMPLE ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
    firstRoundPct: approved >= MIN_SAMPLE ? pct(rows.filter((r) => S.num(r.round) === 1).length, approved) : null,
    onTimePct: due.length >= MIN_SAMPLE ? pct(due.filter((r) => istDay(r.postedAt) <= r.dueDate).length, due.length) : null,
  };
}
async function showcaseItems() {
  await ensure();
  const Img = require('./images'); // eslint-disable-line global-require
  const rows = await S.q(`SELECT * FROM "${T}" WHERE deletedAt IS NULL AND showcase = 1 AND status IN ('approved', 'posted') AND chosenOptionId IS NOT NULL ORDER BY COALESCE(postedAt, decidedAt) DESC LIMIT 12`);
  const out = [];
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ? AND projectId = ?`, r.chosenOptionId, r.id))[0]; // eslint-disable-line no-await-in-loop
    const it = o ? await Img.rawRow(o.itemId) : null; // eslint-disable-line no-await-in-loop
    if (!it || it.deletedAt) continue; // eslint-disable-line no-continue
    const sent = (await S.q(`SELECT MIN(at) AS at FROM "${TE}" WHERE projectId = ? AND kind = 'options_sent'`, r.id))[0]; // eslint-disable-line no-await-in-loop
    const h = (ms) => (ms ? Math.max(0, Math.round(((S.num(ms) - S.num(r.createdAt)) / 3600000) * 10) / 10) : null);
    out.push({
      key: `${o.id}.${workSig(o.id)}`, title: r.showcaseTitle || r.occasion || 'A client project', client: S.num(r.showcaseClient) === 1 ? r.clientName : 'A client', occasion: r.occasion || '',
      platforms: parse(r.platforms, []).map((k) => PLATFORM_LABEL[k] || k), type: /^video\//.test(it.mime || '') ? 'video' : 'image', aspect: it.aspect || '1:1', rounds: S.num(r.round),
      hoursToOptions: sent && sent.at ? h(sent.at) : null, hoursToApproved: h(r.decidedAt), hoursToPosted: r.status === 'posted' ? h(r.postedAt) : null, when: S.iso(r.postedAt || r.decidedAt),
    });
  }
  return out;
}
async function publicWork() { return { brand: await ourBrand(), stats: await trackRecord(), items: await showcaseItems() }; }
async function publicWorkFile(key) {
  await ensure();
  const oid = optionIdOfKey(key);
  if (!oid) return null;
  const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ?`, oid))[0];
  const p = o && (await S.q(`SELECT * FROM "${T}" WHERE id = ? AND deletedAt IS NULL AND showcase = 1 AND status IN ('approved', 'posted') AND chosenOptionId = ?`, o.projectId, o.id))[0];
  if (!p) return null;
  const Img = require('./images'); // eslint-disable-line global-require
  const it = await Img.rawRow(o.itemId);
  return it && !it.deletedAt ? Img.rawFile(it) : null;
}

// ---- the client's side (no login) ------------------------------------------------------------------------------------------------------------------
const GONE = { error: 'This link does not work any more. Please ask the sender for a new one.', status: 404 };
async function load(token) {
  await ensure();
  const id = idOfToken(token);
  if (!id) return null;
  const r = await row(id);
  return r && !r.deletedAt ? r : null;
}
async function ourBrand() { const b = await Cfg.getBrand(); return { name: b.brandName || 'TeamLink', colors: b.colors, tagline: b.tagline || '' }; }
async function publicView(token) {
  const r = await load(token);
  if (!r) return GONE;
  await S.run(`UPDATE "${T}" SET viewedAt = ?, views = views + 1 WHERE id = ?`, Date.now(), r.id);
  const now = Date.now();
  const out = {
    brand: await ourBrand(),
    project: { status: r.status, clientName: r.clientName, occasion: r.occasion || '', brief: r.brief || '', deliverable: r.deliverable || 'video', platforms: parse(r.platforms, []), dueDate: r.dueDate || '', message: r.clientMessage || '', caption: r.caption || '', expiresAt: S.iso(r.linkExpiresAt), expired: r.status === 'awaiting_client' && S.num(r.linkExpiresAt) < now, declinedNote: r.declinedNote || '', decidedByName: r.decidedByName || '', decidedAt: S.iso(r.decidedAt), decisionNote: r.decisionNote || '', postUrl: r.postUrl || '', postedAt: S.iso(r.postedAt), contactName: r.contactName || '', contactEmail: r.contactEmail || '', contactPhone: r.contactPhone || '', handles: r.handles || '', colors: parse(r.colors, null), hasLogo: !!r.logoData },
    options: [],
    suggestions: (await S.q(`SELECT at, byName, text FROM "${TE}" WHERE projectId = ? AND kind = 'client_changes' ORDER BY at ASC`, r.id)).map((e) => ({ at: S.iso(e.at), byName: e.byName || '', text: e.text || '' })),
  };
  const Img = require('./images'); // eslint-disable-line global-require
  const cur = S.num(r.round);
  let opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === cur);
  if (['approved', 'posted'].includes(r.status)) opts = opts.filter((o) => o.id === r.chosenOptionId);
  if (!['awaiting_client', 'approved', 'posted'].includes(r.status)) opts = [];
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (it && !it.deletedAt) out.options.push({ id: o.id, label: o.label, type: /^video\//.test(it.mime || '') ? 'video' : 'image', aspect: it.aspect || '1:1', chosen: r.chosenOptionId === o.id });
  }
  return out;
}
async function publicOptionFile(token, optionId) {
  const r = await load(token);
  if (!r) return null;
  const o = (await S.q(`SELECT * FROM "${TO}" WHERE id = ? AND projectId = ?`, String(optionId || ''), r.id))[0];
  if (!o || S.num(o.round) !== S.num(r.round)) return null;
  const live = r.status === 'awaiting_client' || (['approved', 'posted'].includes(r.status) && r.chosenOptionId === o.id);
  if (!live) return null;
  const it = await require('./images').rawRow(o.itemId); // eslint-disable-line global-require
  return it && !it.deletedAt ? require('./images').rawFile(it) : null; // eslint-disable-line global-require
}
async function publicLogo(token) { const r = await load(token); return r && r.logoData ? r.logoData : null; }
async function tellTeam(r, title, message) {
  let ids = [r.ownerId, r.createdById].filter(Boolean);
  if (!ids.length) { try { const prisma = require('../db'); ids = (await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true }, take: 10 })).map((x) => x.id); } catch { ids = []; } } // eslint-disable-line global-require
  if (ids.length) await notifyUsers([...new Set(ids)], { title, message });
}
// the client sends the request through the REQUEST LINK
async function publicSubmitRequest(token, b = {}) {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'invited') return { error: 'This request was already sent. Thank you.', status: 409 };
  const c = cleanFields({ ...b, clientName: r.clientName, source: 'link' }, r);
  if (c.error) return c;
  const v = c.value;
  if (v.occasion.length < 2) return { error: 'Say what it is for (for example Diwali offer).', status: 400 };
  if (v.brief.length < 10) return { error: 'Tell us what you would like, in a sentence or two.', status: 400 };
  if (v.contactName.length < 2) return { error: 'Please write your name.', status: 400 };
  if (!v.platforms.length) return { error: 'Pick where it will be posted.', status: 400 };
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET title = ?, contactName = ?, contactEmail = ?, contactPhone = ?, occasion = ?, brief = ?, deliverable = ?, platforms = ?, handles = ?, dueDate = ?, logoData = ?, colors = ?, source = 'link', status = 'request', createdAt = ?, updatedAt = ? WHERE id = ? AND status = 'invited'`,
    `${r.clientName}: ${v.occasion}`, v.contactName, v.contactEmail || null, v.contactPhone || null, v.occasion, v.brief, v.deliverable, JSON.stringify(v.platforms), v.handles || null, v.dueDate || null, v.logoData, v.colors ? JSON.stringify(v.colors) : null, now, now, r.id);
  await event(r.id, 'request', `${v.contactName} (client: ${r.clientName})`, `Request sent by the client: ${v.occasion}`);
  await tellTeam(r, `New client request: ${S.clip(r.clientName, 60)}`, `${v.contactName} asked for "${S.clip(v.occasion, 80)}". Open Omni-Channel > AI Marketing > Client projects to accept it.`);
  await logAudit({ userId: r.createdById, actorName: `${v.contactName} (client: ${r.clientName})`, action: 'Omni-Channel AI Marketing: client sent a request', entity: T, entityId: r.id, toValue: v.occasion });
  return { ok: 'Thank you. We have your request and will come back to you.' };
}
const clientName = (b) => S.clip(b.name, 80);
async function publicChoose(token, b = {}, ip = '') {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'awaiting_client') return { error: ['approved', 'posted'].includes(r.status) ? 'You already chose one. Thank you.' : GONE.error, status: 409 };
  if (S.num(r.linkExpiresAt) < Date.now()) return { error: 'This link has expired. Please ask the sender for a new one.', status: 410 };
  const name = clientName(b);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  const opts = (await optionRows(r.id)).filter((o) => S.num(o.round) === S.num(r.round));
  const chosen = opts.find((o) => o.id === String(b.optionId || ''));
  if (!chosen) return { error: 'Pick one of the options.', status: 400 };
  const comment = S.clip(b.comment, 800);
  const Img = require('./images'); // eslint-disable-line global-require
  const now = Date.now();
  for (const o of opts) { // eslint-disable-line no-restricted-syntax
    const it = await Img.rawRow(o.itemId); // eslint-disable-line no-await-in-loop
    if (!it || it.deletedAt || it.status !== 'waiting') continue; // eslint-disable-line no-continue
    if (o.id === chosen.id) await Img.clientDecision(o.itemId, true, name, r.clientName, comment); // eslint-disable-line no-await-in-loop
    else await Img.backToDraft(o.itemId); // eslint-disable-line no-await-in-loop
  }
  await S.run(`UPDATE "${T}" SET status = 'approved', chosenOptionId = ?, decidedAt = ?, decidedByName = ?, decisionNote = ?, updatedAt = ? WHERE id = ? AND status = 'awaiting_client'`, chosen.id, now, name, comment || null, now, r.id);
  await event(r.id, 'client_chose', `${name} (client: ${r.clientName})`, `Chose ${chosen.label}${comment ? `. Suggestions: ${comment}` : ''}`);
  await tellTeam(r, `Client approved "${S.clip(r.title, 60)}"`, `${name} (${S.clip(r.clientName, 60)}) chose ${chosen.label}${comment ? `: ${S.clip(comment, 200)}` : ''}. It is Approved: schedule and post it from Client projects.`);
  await logAudit({ userId: r.createdById, actorName: `${name} (client: ${r.clientName})`, action: 'Omni-Channel AI Marketing: client chose an option (approved)', entity: T, entityId: r.id, toValue: `${r.title}; ${chosen.label}${comment ? `: ${S.clip(comment, 200)}` : ''}; ${S.clip(ip, 60)}` });
  return { ok: 'Thank you. Your choice has been recorded and we will go ahead.' };
}
async function publicChanges(token, b = {}, ip = '') {
  const r = await load(token);
  if (!r) return GONE;
  if (r.status !== 'awaiting_client') return { error: ['approved', 'posted'].includes(r.status) ? 'You already chose one. Thank you.' : GONE.error, status: 409 };
  if (S.num(r.linkExpiresAt) < Date.now()) return { error: 'This link has expired. Please ask the sender for a new one.', status: 410 };
  const name = clientName(b);
  if (name.length < 2) return { error: 'Please write your name.', status: 400 };
  const comment = S.clip(b.comment, 800);
  if (comment.length < 5) return { error: 'Please tell us what you would like changed (a few words).', status: 400 };
  await releaseItems(r);
  const now = Date.now();
  await S.run(`UPDATE "${T}" SET status = 'working', linkExpiresAt = NULL, updatedAt = ? WHERE id = ? AND status = 'awaiting_client'`, now, r.id);
  await event(r.id, 'client_changes', `${name} (client: ${r.clientName})`, comment);
  await tellTeam(r, `Client suggested changes: "${S.clip(r.title, 60)}"`, `${name} (${S.clip(r.clientName, 60)}): ${S.clip(comment, 240)}. Open Omni-Channel > AI Marketing > Client projects.`);
  await logAudit({ userId: r.createdById, actorName: `${name} (client: ${r.clientName})`, action: 'Omni-Channel AI Marketing: client asked for changes on a project', entity: T, entityId: r.id, toValue: `${r.title}: ${S.clip(comment, 200)}; ${S.clip(ip, 60)}` });
  return { ok: 'Thank you. We will make the changes and show you again.' };
}

module.exports = {
  ensure, SOURCES, DELIVERABLES, PLATFORM_KEYS, PLATFORM_LABEL, create, invite, list, get, update, accept, decline, setOptions, send, cancelPresentation, extend, scheduled, posted, heldIds,
  publicView, publicOptionFile, publicLogo, publicSubmitRequest, publicChoose, publicChanges, tokenOf, idOfToken, mayWrite,
  setShowcase, trackRecord, showcaseItems, publicWork, publicWorkFile,
};
