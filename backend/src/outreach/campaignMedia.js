// ---------------------------------------------------------------------------
// WHATSAPP MEDIA CAMPAIGNS (2026-11-21): a picture / video / document that a WhatsApp campaign carries.
//
//   upload(user, buf, mime, name)   validates the file against WhatsApp's own rules, keeps it in the private upload folder (outside the repository),
//                                   writes one OutreachCampaignMedia row. Returns the row's view.
//   get(id) / fileOf(id)            the row / the file on disk ({ path, mime, name, size, kind })
//   check(user, media, ctx)         a campaign's media block -> { media } (clean, kept in the campaign meta) or { error, status }
//   waCache(id)                     { get, set, clear }(phoneId): WhatsApp's media id is kept per sending number for 25 days, so a file is uploaded to Meta ONCE
//   forSend(media)                  what the sender needs: the file + the cache
//
// WHATSAPP LIMITS (Cloud API): picture JPEG / PNG up to 5 MB; video MP4 / 3GP (H.264 + AAC) up to 16 MB; document PDF, DOC(X), XLS(X), PPT(X), TXT up to 100 MB
// (we take up to 25 MB here: the upload goes through the API process memory). The first bytes of the file must agree with its type.
// Mode of a campaign's media: 'template' (an approved Meta template with a picture / video / document HEADER: works for anyone) or 'caption'
// (a free message, the words as the caption: WhatsApp allows it only for people who wrote to you in the last 24 hours).
// Tables (self-provisioned): OutreachCampaignMedia.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./store');
const Att = require('../utils/attachments');

const MB = 1024 * 1024;
const TYPES = {
  'image/jpeg': { kind: 'image', ext: 'jpg', max: 5 * MB, sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { kind: 'image', ext: 'png', max: 5 * MB, sniff: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'video/mp4': { kind: 'video', ext: 'mp4', max: 16 * MB, sniff: (b) => b.length >= 12 && b.slice(4, 8).toString('latin1') === 'ftyp' },
  'video/3gpp': { kind: 'video', ext: '3gp', max: 16 * MB, sniff: (b) => b.length >= 12 && b.slice(4, 8).toString('latin1') === 'ftyp' },
  'application/pdf': { kind: 'document', ext: 'pdf', max: 25 * MB, sniff: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  'application/msword': { kind: 'document', ext: 'doc', max: 25 * MB, sniff: (b) => b.length >= 8 && b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', ext: 'docx', max: 25 * MB, sniff: (b) => b[0] === 0x50 && b[1] === 0x4b },
  'application/vnd.ms-excel': { kind: 'document', ext: 'xls', max: 25 * MB, sniff: (b) => b.length >= 8 && b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', ext: 'xlsx', max: 25 * MB, sniff: (b) => b[0] === 0x50 && b[1] === 0x4b },
  'application/vnd.ms-powerpoint': { kind: 'document', ext: 'ppt', max: 25 * MB, sniff: (b) => b.length >= 8 && b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', ext: 'pptx', max: 25 * MB, sniff: (b) => b[0] === 0x50 && b[1] === 0x4b },
  'text/plain': { kind: 'document', ext: 'txt', max: 25 * MB, sniff: (b) => !b.slice(0, 4096).includes(0) },
};
const MIMES = Object.keys(TYPES);
const KINDS = ['image', 'video', 'document'];
const WORDS = { image: 'picture', video: 'video', document: 'document' };
const CACHE_DAYS = 25;
const STORED = /^cm_[a-f0-9]{32}\.(jpg|png|mp4|3gp|pdf|doc|docx|xls|xlsx|ppt|pptx|txt)$/;
const MAX_UPLOAD = 25 * MB;

let ready = false;
async function ensure() {
  if (ready) return;
  await S.run('CREATE TABLE IF NOT EXISTS "OutreachCampaignMedia" (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, stored TEXT NOT NULL, size INTEGER NOT NULL, sha TEXT, waIds TEXT, createdById TEXT, createdByName TEXT, createdAt DATETIME NOT NULL DEFAULT 0)');
  ready = true;
}
const dir = () => { const d = path.join(Att.uploadDir(), 'campaign-media'); fs.mkdirSync(d, { recursive: true }); return d; };
const cleanMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();
const viewOf = (r) => ({ id: r.id, kind: r.kind, mime: r.mime, name: r.name, size: S.num(r.size), createdAt: S.iso(r.createdAt) });

// the file's rules in plain words, or null when it is fine
function problem(mime, size, buf) {
  const t = TYPES[cleanMime(mime)];
  if (!t) return 'WhatsApp takes a picture (JPG or PNG), a video (MP4 or 3GP) or a document (PDF, Word, Excel, PowerPoint or TXT). This file type is not one of them.';
  if (!size) return 'The file is empty.';
  if (size > t.max) return `A ${WORDS[t.kind]} of this kind can be at most ${Math.round(t.max / MB)} MB on WhatsApp. This one is ${(size / MB).toFixed(1)} MB.`;
  if (buf && !t.sniff(buf)) return 'The file contents do not match its type. Save it again as the right kind of file and upload it again.';
  return null;
}

async function upload(user, buf, mime, name) {
  await ensure();
  const m = cleanMime(mime);
  if (!Buffer.isBuffer(buf) || !buf.length) return { error: 'Choose a file to upload.', status: 400 };
  const bad = problem(m, buf.length, buf);
  if (bad) return { error: bad, status: bad.startsWith('A ') ? 413 : 400 };
  const t = TYPES[m];
  const stored = `cm_${crypto.randomBytes(16).toString('hex')}.${t.ext}`;
  fs.writeFileSync(path.join(dir(), stored), buf, { mode: 0o600 });
  const id = S.newId('cmd');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const now = Date.now();
  const display = Att.safeDisplayName(name || `file.${t.ext}`);
  await S.run('INSERT INTO "OutreachCampaignMedia" (id, kind, mime, name, stored, size, sha, waIds, createdById, createdByName, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, t.kind, m, display, stored, buf.length, sha, '{}', user.id, S.clip(user.name, 80), now);
  return { ok: true, media: { id, kind: t.kind, mime: m, name: display, size: buf.length, createdAt: S.iso(now) } };
}

async function get(id) {
  await ensure();
  const r = (await S.q('SELECT * FROM "OutreachCampaignMedia" WHERE id = ?', String(id || '')))[0];
  return r || null;
}
async function fileOf(id) {
  const r = await get(id);
  if (!r || !STORED.test(String(r.stored))) return null;
  const full = path.resolve(dir(), r.stored);
  if (path.dirname(full) !== path.resolve(dir()) || !fs.existsSync(full)) return null;
  return { path: full, mime: r.mime, name: r.name, size: S.num(r.size), kind: r.kind, id: r.id };
}

// WhatsApp's media id per sending number
function waCache(id) {
  const read = async () => { const r = await get(id); return S.parse(r && r.waIds, {}) || {}; };
  return {
    async get(phoneId) { const x = (await read())[String(phoneId)]; return x && x.id && Date.now() - x.at < CACHE_DAYS * 86400000 ? x.id : null; },
    async set(phoneId, waId) { const x = await read(); x[String(phoneId)] = { id: String(waId), at: Date.now() }; await S.run('UPDATE "OutreachCampaignMedia" SET waIds = ? WHERE id = ?', JSON.stringify(x), id); },
    async clear(phoneId) { const x = await read(); delete x[String(phoneId)]; await S.run('UPDATE "OutreachCampaignMedia" SET waIds = ? WHERE id = ?', JSON.stringify(x), id); },
  };
}

const headerKind = (tpl) => { const x = tpl && tpl.extra && tpl.extra.headerType; return KINDS.includes(x) ? x : null; };

// A campaign's media block as the wizard sends it: { id, mode: 'template' | 'caption', caption }.
// ctx: { channel, template (the OutreachTemplate view or null) }. Returns { media: null } for a text campaign, { media } or { error, status }.
async function check(user, block, ctx = {}) {
  if (!block || typeof block !== 'object' || !block.id) return { media: null };
  if (ctx.channel !== 'whatsapp') return { error: 'A picture, video or document can only be sent on WhatsApp.', status: 400, code: 'media_channel' };
  const f = await fileOf(block.id);
  if (!f) return { error: 'The file for this campaign was not found. Upload it again.', status: 404, code: 'media_gone' };
  const mode = block.mode === 'caption' ? 'caption' : 'template';
  const media = { id: f.id, kind: f.kind, mode, caption: S.clip(block.caption, 1000), name: f.name, mime: f.mime, size: f.size };
  const bad = problem(f.mime, f.size, null);
  if (bad) return { error: bad, status: 400, code: 'media_rules' };
  if (mode === 'template') {
    const hk = headerKind(ctx.template);
    if (!ctx.template) return { error: `Pick the approved WhatsApp message that has a ${WORDS[f.kind]} header.`, status: 400, code: 'media_no_template' };
    if (hk !== f.kind) return { error: hk ? `This approved message has a ${WORDS[hk]} header, but you chose a ${WORDS[f.kind]}. Pick the message with a ${WORDS[f.kind]} header, or upload a ${WORDS[hk]}.` : `This message has no ${WORDS[f.kind]} header, so WhatsApp cannot carry the file. Pick an approved message whose header is a ${WORDS[f.kind]} (Manage Templates > header).`, status: 400, code: 'media_header' };
  }
  return { media };
}

// what the sender needs for one person: the file + the cache of WhatsApp ids
async function forSend(media) {
  if (!media || !media.id) return null;
  const f = await fileOf(media.id);
  if (!f) return null;
  return { file: { path: f.path, mime: f.mime, name: f.name }, cache: waCache(f.id), mode: media.mode === 'caption' ? 'caption' : 'template', kind: f.kind };
}

module.exports = { upload, get, fileOf, check, forSend, waCache, problem, viewOf, ensure, TYPES, MIMES, KINDS, MAX_UPLOAD, WORDS, headerKind };
