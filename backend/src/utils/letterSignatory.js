// ---------------------------------------------------------------------------
// THE COMPANY'S LETTER SIGNATORY (2026-11-25): the CEO / authorised signatory who signs every TeamLink letter.
//
// Set ONCE in Administration -> Company Setup -> Letter signatory: the name, the title, and a picture of the signature (PNG or
// JPEG, kept small). Every letter (offer letter, relieving letter, service certificate) uses it automatically, so nobody types it
// per letter. Empty name = the letters print "Authorised Signatory"; empty title = the letter's own title ("HR Department").
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const KEY = 'letter-signatory';
const MAX_BYTES = 300 * 1024; // the picture as uploaded, and again after it is shrunk
const MAX_WIDTH = 520; // pixels; plenty for a signature in a letter

const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

async function row() {
  return prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
}
function parse(r) {
  try { const v = r && r.value ? JSON.parse(r.value) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// -> { name, title, png (Buffer | null), signatureUpdatedAt, updatedByName, updatedAt }
async function load() {
  const r = await row();
  const v = parse(r);
  return {
    name: cleanText(v.name, 80),
    title: cleanText(v.title, 120),
    png: v.signaturePng ? Buffer.from(v.signaturePng, 'base64') : null,
    signatureUpdatedAt: v.signatureUpdatedAt || null,
    updatedByName: r ? r.updatedByName : null,
    updatedAt: r ? r.updatedAt : null,
  };
}

// What the Company Setup screen shows (never the picture's bytes; that has its own route).
async function summary() {
  const s = await load();
  return { name: s.name, title: s.title, hasSignature: !!s.png, signatureUpdatedAt: s.signatureUpdatedAt, updatedByName: s.updatedByName, updatedAt: s.updatedAt };
}

// A data URL (PNG or JPEG) -> a small PNG. -> { png } | { error }
async function normalise(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Choose a PNG or JPEG picture of the signature.' };
  const raw = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!raw.length) return { error: 'The signature picture is empty.' };
  if (raw.length > MAX_BYTES) return { error: 'The signature picture is larger than 300 KB. Use a smaller picture.' };
  let png;
  try {
    png = await require('sharp')(raw).resize({ width: MAX_WIDTH, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer(); // eslint-disable-line global-require
  } catch {
    return { error: 'That file is not a readable PNG or JPEG picture.' };
  }
  if (png.length > MAX_BYTES) return { error: 'The signature picture is too large even after shrinking. Use a simpler picture.' };
  return { png };
}

// body: { name, title, signatureDataUrl }. signatureDataUrl: a new picture | '' to remove it | absent to keep the current one.
async function save(body, user) {
  const b = body && typeof body === 'object' ? body : {};
  const current = parse(await row());
  const next = { name: cleanText(b.name, 80), title: cleanText(b.title, 120) };
  let change = 'kept';
  if (b.signatureDataUrl === '') {
    change = 'removed';
  } else if (b.signatureDataUrl) {
    const n = await normalise(b.signatureDataUrl);
    if (n.error) return n;
    next.signaturePng = n.png.toString('base64');
    next.signatureUpdatedAt = new Date().toISOString();
    change = 'replaced';
  } else if (current.signaturePng) {
    next.signaturePng = current.signaturePng;
    next.signatureUpdatedAt = current.signatureUpdatedAt || null;
  }
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next), ...who },
    update: { value: JSON.stringify(next), ...who },
  });
  await logAudit({
    userId: user ? user.id : null,
    action: `Letter signatory saved (signature ${change})`,
    entity: 'AppSetting',
    entityId: KEY,
    toValue: `${next.name || '(no name)'}${next.title ? `, ${next.title}` : ''}`,
  });
  return { ok: true, value: await summary() };
}

module.exports = { KEY, MAX_BYTES, load, summary, save, normalise };
