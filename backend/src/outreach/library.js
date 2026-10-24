// ---------------------------------------------------------------------------
// OMNI-CHANNEL LIBRARY (media library): files and links that messages, templates, content and posts can use.
//   * a FILE goes through utils/attachments.js (png, jpg, webp, pdf, doc, docx; 5 MB; the first bytes must agree with the type) into the upload folder;
//     the client's file name is only a label. Every file gets an unguessable token for a public share link:
//        GET /api/public/outreach/library/<token>/<name>      (routes/outreachLibraryPublic.js; works only while the item is not deleted)
//   * a LINK (kind 'link') is an http / https address (a video on YouTube, a PDF on the company site ...). Nothing is downloaded.
//   * who: save / delete needs access.js mayLibraryUpload (a delete: own item, or an Admin). Everybody who uses Omni-Channel SEES the items of their
//     own departments and the items with no department; an Admin (and Manager / Assistant Manager) see all.
//   * delete = the row is marked deleted and the file is removed from disk (the share link stops working).
// Table OmniLibrary is made by outreach/v3schema.js (CREATE TABLE IF NOT EXISTS) before any route runs.
// linksFor(ids, user) is for the Campaigns / Console / Social builders: [{ id, name, kind, mediaType, url }] of the items this person may see.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const S = require('./store');
const A = require('./access');
const Att = require('../utils/attachments');
const { logAudit } = require('../utils/audit');

// OmniLibrary.createdAt / deletedAt are declared INTEGER (v3schema.js) but hold milliseconds; Prisma's raw reader fails on such a column ("Raw query failed"), so every read lists the
// columns and adds +0 to those two (an expression has no declared type and comes back as a plain number).
const COLS = 'id, name, kind, mime, size, stored, linkUrl, token, department, note, createdById, createdByName, createdAt+0 AS createdAt, deletedAt+0 AS deletedAt';
const IMAGE = ['image/png', 'image/jpeg', 'image/webp'];
const DOC = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const VIDEO_LINK = /(\.(mp4|3gp|mov|webm)(\?|#|$))|(^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\/)/i;
const MEDIA_TYPES = ['image', 'video', 'document', 'link'];

const mediaTypeOf = (r) => {
  if (r.kind === 'link') return VIDEO_LINK.test(r.linkUrl || '') ? 'video' : 'link';
  if (IMAGE.includes(r.mime)) return 'image';
  if (DOC.includes(r.mime)) return 'document';
  return 'document';
};
const base = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const publicPath = (r) => (r.kind === 'link' ? (r.linkUrl || '') : `/api/public/outreach/library/${r.token}/${encodeURIComponent(r.name || 'file')}`);
const publicUrl = (r) => (r.kind === 'link' ? (r.linkUrl || '') : `${base()}${publicPath(r)}`);

const mayUpload = (u) => A.has('mayLibraryUpload')(u);
const mayAdmin = (u) => A.isAdmin(u);
const visible = (u, r) => !r.deletedAt && A.mayDepartment(u, r.department || '');
const view = (u, r) => ({
  id: r.id, name: r.name, kind: r.kind, mediaType: mediaTypeOf(r), mime: r.mime || '', size: S.num(r.size), department: r.department || '', note: r.note || '',
  createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), isMine: r.createdById === u.id, canDelete: mayUpload(u) && (mayAdmin(u) || r.createdById === u.id),
  url: publicPath(r), linkUrl: r.kind === 'link' ? r.linkUrl : '', shareUrl: publicUrl(r),
});

// who may put an item in which department: an Admin any, everybody else only their own (or none)
function deptFor(u, wanted) {
  const d = S.clip(wanted, 60);
  if (!d) return { dept: '' };
  if (!A.mayDepartment(u, d)) return { error: 'That department is not yours.', status: 403 };
  return { dept: d };
}

async function list(u, { q = '', type = '', dept = '', mine = false, limit = 300 } = {}) {
  if (!A.mayUse(u)) return { items: [], counts: {} };
  const rows = await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT 2000`);
  const needle = String(q || '').trim().toLowerCase();
  let items = rows.filter((r) => visible(u, r)).map((r) => view(u, r));
  if (dept) items = items.filter((i) => !i.department || i.department.toLowerCase() === String(dept).toLowerCase());
  if (mine) items = items.filter((i) => i.isMine);
  const counts = { all: 0 }; MEDIA_TYPES.forEach((t) => { counts[t] = 0; });
  const searched = needle ? items.filter((i) => `${i.name} ${i.note} ${i.createdByName} ${i.department} ${i.linkUrl}`.toLowerCase().includes(needle)) : items;
  searched.forEach((i) => { counts.all += 1; counts[i.mediaType] += 1; });
  const out = MEDIA_TYPES.includes(type) ? searched.filter((i) => i.mediaType === type) : searched;
  return { items: out.slice(0, Math.min(Number(limit) || 300, 1000)), total: out.length, counts, canUpload: mayUpload(u) };
}

async function get(u, id) {
  const r = (await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE id = ?`, String(id || '')))[0];
  return r && visible(u, r) ? r : null;
}

async function upload(u, req) {
  if (!mayUpload(u)) return { error: 'Your login can look at the Library but not add to it.', status: 403 };
  let parsed;
  try { parsed = await Att.parseMultipart(req); } catch (e) { return { error: Att.MESSAGE[e.code] || 'The upload could not be read.', status: e.code === 'TOO_LARGE' ? 413 : 400 }; }
  const { fields, file } = parsed;
  const d = deptFor(u, fields.department);
  if (d.error) return d;
  let saved;
  try { saved = Att.store(file, { allowWord: true }); } catch (e) {
    const words = { ...Att.MESSAGE, BAD_TYPE: 'Only PNG, JPG, WebP pictures and PDF, DOC, DOCX documents can be saved here. A video can be saved as a link.' };
    return { error: words[e.code] || 'The file could not be saved.', status: e.code === 'TOO_LARGE' ? 413 : 400 };
  }
  const id = S.newId('lb');
  const token = crypto.randomBytes(24).toString('hex');
  const name = S.clip(fields.name, 120) || saved.billName;
  await S.run('INSERT INTO "OmniLibrary" (id, name, kind, mime, size, stored, linkUrl, token, department, note, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, name, 'file', saved.billMime, saved.billSize, saved.billFile, null, token, d.dept || null, S.clip(fields.note, 300) || null, u.id, u.name, Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Library file added', entity: 'OmniLibrary', entityId: id, toValue: `${saved.billMime}, ${saved.billSize} bytes` });
  return { item: view(u, (await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE id = ?`, id))[0]) };
}

async function saveLink(u, b) {
  if (!mayUpload(u)) return { error: 'Your login can look at the Library but not add to it.', status: 403 };
  const url = S.clip(b.url, 1000);
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(url)) return { error: 'Type a full web address that starts with http:// or https://.', status: 400 };
  const name = S.clip(b.name, 120) || url.replace(/^https?:\/\//i, '').slice(0, 80);
  const d = deptFor(u, b.department);
  if (d.error) return d;
  const id = S.newId('lb');
  await S.run('INSERT INTO "OmniLibrary" (id, name, kind, mime, size, stored, linkUrl, token, department, note, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, name, 'link', null, 0, null, url, crypto.randomBytes(24).toString('hex'), d.dept || null, S.clip(b.note, 300) || null, u.id, u.name, Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Library link added', entity: 'OmniLibrary', entityId: id });
  return { item: view(u, (await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE id = ?`, id))[0]) };
}

async function update(u, id, b) {
  const r = await get(u, id);
  if (!r) return { error: 'This item was not found.', status: 404 };
  if (!(mayUpload(u) && (mayAdmin(u) || r.createdById === u.id))) return { error: 'Only the person who saved it, or an Admin, can change this item.', status: 403 };
  const name = b.name !== undefined ? S.clip(b.name, 120) : r.name;
  if (!name) return { error: 'Give the item a name.', status: 400 };
  const note = b.note !== undefined ? S.clip(b.note, 300) : r.note;
  let dept = r.department || '';
  if (b.department !== undefined) { const d = deptFor(u, b.department); if (d.error) return d; dept = d.dept; }
  await S.run('UPDATE "OmniLibrary" SET name = ?, note = ?, department = ? WHERE id = ?', name, note || null, dept || null, r.id);
  return { item: view(u, (await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE id = ?`, r.id))[0]) };
}

async function remove(u, id) {
  const r = await get(u, id);
  if (!r) return { error: 'This item was not found.', status: 404 };
  if (!(mayUpload(u) && (mayAdmin(u) || r.createdById === u.id))) return { error: 'Only the person who saved it, or an Admin, can delete this item.', status: 403 };
  await S.run('UPDATE "OmniLibrary" SET deletedAt = ? WHERE id = ?', Date.now(), r.id);
  if (r.stored) Att.remove(r.stored);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Library item deleted', entity: 'OmniLibrary', entityId: r.id });
  return { ok: true };
}

// for the Campaigns / Console / Social builders: the links of the items this person may see (a missing, deleted or not-allowed id is skipped)
async function linksFor(ids, u) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean))].slice(0, 20);
  if (!want.length) return [];
  const rows = await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE deletedAt IS NULL AND id IN (${want.map(() => '?').join(',')})`, ...want);
  const byId = new Map(rows.filter((r) => visible(u, r)).map((r) => [r.id, r]));
  return want.filter((id) => byId.has(id)).map((id) => { const r = byId.get(id); return { id, name: r.name, kind: r.kind, mediaType: mediaTypeOf(r), mime: r.mime || '', url: publicUrl(r) }; });
}
// the text a message carries for those items: one line each ("Name: https://...")
async function linesFor(ids, u) { return (await linksFor(ids, u)).map((l) => `${l.name}: ${l.url}`); }

// the public share link: { path, mime, name, inline } or null
async function publicFile(token, name) {
  const t = String(token || '');
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const r = (await S.q(`SELECT ${COLS} FROM "OmniLibrary" WHERE token = ? AND deletedAt IS NULL AND kind = 'file'`, t))[0];
  if (!r || !r.stored) return null;
  const full = Att.resolveStored(r.stored);
  if (!full) return null;
  return { path: full, mime: r.mime, name: r.name, inline: [...IMAGE, 'application/pdf'].includes(r.mime) };
}

module.exports = { list, get, upload, saveLink, update, remove, linksFor, linesFor, publicFile, publicUrl, mediaTypeOf, mayUpload, MEDIA_TYPES };
