// ---------------------------------------------------------------------------
// OMNI-CHANNEL CONTENT STUDIO: one master message -> a version for each channel -> saved into the Content Library (table OmniStudioContent).
//   * Channels: WhatsApp, SMS, Email (the three Omni-Channel sends) + Facebook, Instagram, LinkedIn, X, YouTube, Threads (kept as saved text variants:
//     nothing is posted from here; the Social page posts when an account is connected).
//   * adapt(master, ...) is a plain RULE-BASED rewrite (cut to each channel's limit, add the call-to-action, a hashtag): it is not AI. "Write in my brand voice"
//     with AI is Planned; the voice you pick is saved with the content.
//   * Media: ids of Library items (outreach/library.js). Content is shared by the department it is saved for (empty = everybody who uses Omni-Channel).
//   * Send to a campaign: the Campaigns wizard reads GET /gs/studio/content/:id.
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const { logAudit } = require('../utils/audit');

const CHANNELS = [
  { key: 'whatsapp', label: 'WhatsApp', icon: 'WA', color: '#25d366', limit: 1024, hint: 'Message to a person · opt-out line needed', send: true },
  { key: 'sms', label: 'SMS', icon: 'SMS', color: '#4d7ddb', limit: 480, hint: '160 letters is one text, longer is split', send: true },
  { key: 'email', label: 'Email', icon: '@', color: '#666fd3', limit: 20000, hint: 'Subject line + message', send: true },
  { key: 'facebook', label: 'Facebook', icon: 'f', color: '#1877f2', limit: 63206, hint: 'Long-form post · link preview' },
  { key: 'instagram', label: 'Instagram', icon: 'IG', color: '#dd2a7b', limit: 2200, hint: 'Caption + hashtags · visual first' },
  { key: 'linkedin', label: 'LinkedIn', icon: 'in', color: '#0a66c2', limit: 3000, hint: 'Professional tone · first line hooks' },
  { key: 'x', label: 'X', icon: 'X', color: '#111111', limit: 280, hint: 'Short and punchy · 280 letters' },
  { key: 'youtube', label: 'YouTube', icon: '▶', color: '#ff0000', limit: 5000, hint: 'Community post / video description' },
  { key: 'threads', label: 'Threads', icon: '@', color: '#000000', limit: 500, hint: 'Conversational · 500 letters' },
];
const KEYS = CHANNELS.map((c) => c.key);
const VOICES = ['Warm & confident', 'Professional', 'Playful', 'Urgent'];

const TABLE = 'OmniStudioContent';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${TABLE}" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "voice" TEXT, "cta" TEXT, "master" TEXT NOT NULL DEFAULT '', "subject" TEXT, "adaptations" TEXT NOT NULL DEFAULT '{}', "libraryIds" TEXT NOT NULL DEFAULT '[]', "department" TEXT, "status" TEXT NOT NULL DEFAULT 'ready', "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME)`,
  `CREATE INDEX IF NOT EXISTS "${TABLE}_name" ON "${TABLE}"("name")`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-studio] schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}

const first = (s) => String(s || '').split(/\n/)[0].trim();
const rest = (s) => String(s || '').split(/\n/).slice(1).join('\n').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trim()}…`);
const hashtag = (name) => `#${String(name || 'content').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')}`;
// the rule-based versions, one per channel (every one is cut to its own limit)
function adapt(master, { name = '', cta = '' } = {}) {
  const m = String(master || '').trim(); const c = String(cta || '').trim(); const tag = hashtag(name);
  const head = first(m); const body = rest(m);
  const L = Object.fromEntries(CHANNELS.map((x) => [x.key, x.limit]));
  return {
    whatsapp: cut(`${m}${c ? `\n\n${c}` : ''}\n\nReply STOP to opt out`, L.whatsapp),
    sms: cut(`${m.replace(/\s*\n+\s*/g, ' ')}${c ? ` ${c}.` : ''} Reply STOP to opt out`, L.sms),
    email: cut(`${m}${c ? `\n\n${c} →` : ''}\n\n{{unsubscribe}}`, L.email),
    facebook: cut(`${m}${c ? `\n\n${c} →` : ''}`, L.facebook),
    linkedin: cut(`${head}${body ? `\n\n${body}` : ''}${c ? `\n\n${c}.` : ''}`, L.linkedin),
    instagram: cut(`${head}${body ? `\n\n${body}` : ''}\n\n${tag}`, L.instagram),
    x: cut(`${head}${c ? ` ${c}` : ''} ${tag}`.trim(), L.x),
    youtube: cut(`${m}${c ? `\n\n${c}` : ''}`, L.youtube),
    threads: cut(`${head}${body ? `\n${body}` : ''}`, L.threads),
  };
}

const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const visible = (u, r) => !r.deletedAt && A.mayDepartment(u, r.department || '');
// who may save / change / delete content: the people who may write templates; their own items, or any item for an Admin
const canSave = (u) => A.has('canEditTemplates')(u) || A.has('canEditInternalTemplates')(u);
const mayWrite = (u, r) => canSave(u) && (!r || A.isAdmin(u) || r.createdById === u.id || !r.createdById);
const view = (u, r) => ({
  id: r.id, name: r.name, voice: r.voice || VOICES[0], cta: r.cta || '', master: r.master || '', subject: r.subject || '', adaptations: parse(r.adaptations, {}), libraryIds: parse(r.libraryIds, []),
  department: r.department || '', status: r.status || 'ready', createdByName: r.createdByName || '', savedAt: S.iso(r.updatedAt || r.createdAt), canEdit: mayWrite(u, r),
});

async function list(u, { dept = '', q = '' } = {}) {
  await ensure();
  const rows = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 1000`)).filter((r) => visible(u, r));
  const needle = String(q || '').trim().toLowerCase();
  const items = rows.filter((r) => (!dept || !r.department || String(r.department).toLowerCase() === String(dept).toLowerCase()) && (!needle || `${r.name} ${r.master}`.toLowerCase().includes(needle))).map((r) => view(u, r));
  return { items, total: items.length, canSave: canSave(u) };
}
async function get(u, id) {
  await ensure();
  const r = (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, String(id || '')))[0];
  return r && visible(u, r) ? r : null;
}

// the cleaned fields of a request, or { error }
function clean(b, cur = {}) {
  const name = b.name !== undefined ? S.clip(b.name, 80) : (cur.name || '');
  if (!name) return { error: 'Give this content a name first.', status: 400 };
  const master = b.master !== undefined ? String(b.master).slice(0, 5000) : (cur.master || '');
  const adaptations = {};
  const given = b.adaptations !== undefined ? (b.adaptations || {}) : parse(cur.adaptations, {});
  const over = [];
  CHANNELS.forEach((c) => {
    if (given[c.key] === undefined || given[c.key] === null) return;
    const t = String(given[c.key]).slice(0, c.limit + 200);
    if (t.length > c.limit) over.push(c.label);
    adaptations[c.key] = t;
  });
  if (over.length) return { error: `The ${over[0]} version is over its limit. Shorten it first.`, status: 400 };
  const voice = b.voice !== undefined ? S.clip(b.voice, 40) : (cur.voice || VOICES[0]);
  const libraryIds = (b.libraryIds !== undefined ? (Array.isArray(b.libraryIds) ? b.libraryIds : []) : parse(cur.libraryIds, [])).map((x) => String(x)).filter(Boolean).slice(0, 20);
  return { name, master, adaptations, voice, cta: b.cta !== undefined ? S.clip(b.cta, 80) : (cur.cta || ''), subject: b.subject !== undefined ? S.clip(b.subject, 200) : (cur.subject || ''), libraryIds };
}

// save: a piece with the same name (any capital letters) in the same department is updated, not doubled
async function save(u, b) {
  await ensure();
  if (!canSave(u)) return { error: 'Your login can look at saved content but not save it.', status: 403 };
  let f = clean(b);
  if (f.error) return f;
  const dept = S.clip(b.department, 60);
  if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const same = (await S.q(`SELECT * FROM "${TABLE}" WHERE deletedAt IS NULL AND LOWER(name) = LOWER(?) AND COALESCE(department, '') = ?`, f.name, dept))[0];
  const now = Date.now();
  if (same) {
    f = clean(b, same); // what the request leaves out stays as it was
    if (f.error) return f;
    if (!mayWrite(u, same)) return { error: `"${f.name}" was saved by ${same.createdByName || 'somebody else'}. Use another name, or ask them or an Admin.`, status: 403 };
    await S.run(`UPDATE "${TABLE}" SET name = ?, voice = ?, cta = ?, master = ?, subject = ?, adaptations = ?, libraryIds = ?, status = 'ready', updatedAt = ? WHERE id = ?`, f.name, f.voice, f.cta, f.master, f.subject || null, JSON.stringify(f.adaptations), JSON.stringify(f.libraryIds), now, same.id);
    await logAudit({ userId: u.id, actorName: u.name, action: 'Studio content changed', entity: TABLE, entityId: same.id });
    return { content: view(u, (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, same.id))[0]), updated: true };
  }
  const id = S.newId('sc');
  await S.run(`INSERT INTO "${TABLE}" (id, name, voice, cta, master, subject, adaptations, libraryIds, department, status, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?,?,?)`,
    id, f.name, f.voice, f.cta, f.master, f.subject || null, JSON.stringify(f.adaptations), JSON.stringify(f.libraryIds), dept || null, u.id, u.name, now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Studio content saved', entity: TABLE, entityId: id, toValue: f.name });
  return { content: view(u, (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, id))[0]), updated: false };
}
async function update(u, id, b) {
  const r = await get(u, id);
  if (!r) return { error: 'This content was not found.', status: 404 };
  if (!mayWrite(u, r)) return { error: 'Only the person who saved it, or an Admin, can change this content.', status: 403 };
  const f = clean(b, r);
  if (f.error) return f;
  const dup = (await S.q(`SELECT id FROM "${TABLE}" WHERE deletedAt IS NULL AND LOWER(name) = LOWER(?) AND COALESCE(department, '') = COALESCE(?, '') AND id <> ?`, f.name, r.department || '', r.id))[0];
  if (dup) return { error: `There is already content called "${f.name}".`, status: 409 };
  await S.run(`UPDATE "${TABLE}" SET name = ?, voice = ?, cta = ?, master = ?, subject = ?, adaptations = ?, libraryIds = ?, updatedAt = ? WHERE id = ?`, f.name, f.voice, f.cta, f.master, f.subject || null, JSON.stringify(f.adaptations), JSON.stringify(f.libraryIds), Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Studio content changed', entity: TABLE, entityId: r.id });
  return { content: view(u, (await S.q(`SELECT * FROM "${TABLE}" WHERE id = ?`, r.id))[0]) };
}
async function remove(u, id) {
  const r = await get(u, id);
  if (!r) return { error: 'This content was not found.', status: 404 };
  if (!mayWrite(u, r)) return { error: 'Only the person who saved it, or an Admin, can delete this content.', status: 403 };
  await S.run(`UPDATE "${TABLE}" SET deletedAt = ? WHERE id = ?`, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Studio content deleted', entity: TABLE, entityId: r.id });
  return { ok: true };
}

// "Created posts": what Social Media published or scheduled. The Social page keeps its own table; until it exists (nothing was ever posted) the list is honestly empty.
async function posts(u) {
  try {
    const t = (await S.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'OmniSocialPost'"))[0];
    if (!t) return { items: [] };
    const rows = await S.q('SELECT * FROM "OmniSocialPost" ORDER BY createdAt DESC LIMIT 100');
    return { items: rows.filter((r) => A.mayDepartment(u, r.department || '')).map((r) => ({ id: r.id, text: S.clip(r.content || r.text || r.message || '', 300), status: r.status || '', platforms: parse(r.platforms, []), when: S.iso(r.scheduledAt || r.postedAt || r.createdAt) })) };
  } catch { return { items: [] }; }
}

module.exports = { ensure, CHANNELS, KEYS, VOICES, adapt, list, get, save, update, remove, posts, view, canSave, DDL };
