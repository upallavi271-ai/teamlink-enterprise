// ---------------------------------------------------------------------------
// COMMUNICATION SETTINGS — one AppSetting row ("comm.settings"), no migration.
//
//   switches    company switch per channel (WhatsApp / SMS). Off = candidates are not messaged on that
//               channel at all (same idea as the "Candidate emails" switch). Default ON.
//   providers   which provider a channel uses first, and whether the next one is tried when the first
//               one is not available (not connected, phone offline, daily cap reached ...).
//   qr          the unofficial WhatsApp QR-link prototype: the "I understand" confirmation (also written to
//               the audit log), the per-company kill switch, the caps and the human-like pacing.
//   android     the Android phone as SMS gateway: caps and gap.
//
// Secrets never live here (they are in Integration.values, encrypted - utils/integrationStore.js).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'comm.settings';
const PROVIDERS = {
  WhatsApp: ['whatsapp.cloud', 'whatsapp.qr'],
  SMS: ['sms.android', 'sms.gateway'],
};
const LABELS = {
  'whatsapp.cloud': 'WhatsApp via company number (Official)',
  'whatsapp.qr': 'WhatsApp via QR-linked number (prototype)',
  'sms.android': 'SMS via Android phone',
  'sms.gateway': 'SMS via paid gateway',
};
const SHORT = {
  'whatsapp.cloud': 'Official WhatsApp (Cloud API)',
  'whatsapp.qr': 'QR-linked WhatsApp (prototype)',
  'sms.android': 'Android phone',
  'sms.gateway': 'Paid SMS gateway',
};
const DEFAULTS = {
  switches: { WhatsApp: true, SMS: true },
  providers: {
    WhatsApp: { primary: 'whatsapp.cloud', fallback: true },
    SMS: { primary: 'sms.gateway', fallback: true },
  },
  qr: { ack: null, killSwitch: false, perHour: 30, perDay: 150, gapMin: 8, gapMax: 20, newNumber: false, typing: true },
  android: { perHour: 60, perDay: 200, gapMin: 3, gapMax: 6 },
};
const BOUNDS = {
  qr: { perHour: [1, 120], perDay: [1, 1000], gapMin: [3, 120], gapMax: [3, 300] },
  android: { perHour: [1, 600], perDay: [1, 5000], gapMin: [1, 60], gapMax: [1, 120] },
};
// A number linked for the first time is treated gently.
const NEW_NUMBER = { perHour: 10, perDay: 40 };

let cache = null;
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function merge(base, extra) {
  const out = clone(base);
  if (!extra || typeof extra !== 'object') return out;
  Object.keys(out.switches).forEach((c) => { if (typeof (extra.switches || {})[c] === 'boolean') out.switches[c] = extra.switches[c]; });
  Object.keys(out.providers).forEach((c) => {
    const e = (extra.providers || {})[c] || {};
    if (PROVIDERS[c].includes(e.primary)) out.providers[c].primary = e.primary;
    if (typeof e.fallback === 'boolean') out.providers[c].fallback = e.fallback;
  });
  ['qr', 'android'].forEach((sec) => {
    const e = extra[sec] || {};
    Object.keys(BOUNDS[sec]).forEach((f) => {
      const n = Number(e[f]);
      if (e[f] !== undefined && e[f] !== null && e[f] !== '' && Number.isFinite(n)) out[sec][f] = Math.min(BOUNDS[sec][f][1], Math.max(BOUNDS[sec][f][0], Math.floor(n)));
    });
    if (out[sec].gapMax < out[sec].gapMin) out[sec].gapMax = out[sec].gapMin;
  });
  if (extra.qr) {
    if (typeof extra.qr.killSwitch === 'boolean') out.qr.killSwitch = extra.qr.killSwitch;
    if (typeof extra.qr.newNumber === 'boolean') out.qr.newNumber = extra.qr.newNumber;
    if (typeof extra.qr.typing === 'boolean') out.qr.typing = extra.qr.typing;
    if (extra.qr.ack && typeof extra.qr.ack === 'object') out.qr.ack = { at: String(extra.qr.ack.at || ''), byId: extra.qr.ack.byId || null, byName: String(extra.qr.ack.byName || '') };
  }
  return out;
}

async function load({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 5000) return cache.value;
  let stored = {};
  try { const row = await prisma.appSetting.findUnique({ where: { key: KEY } }); stored = row ? JSON.parse(row.value) : {}; } catch { stored = {}; }
  const value = merge(DEFAULTS, stored);
  cache = { at: Date.now(), value };
  return value;
}
async function write(value, user) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  cache = null;
}

// What the QR worker / adapter really use (the new-number rule lowers the caps).
function effectiveQr(s) {
  const q = { ...s.qr };
  if (q.newNumber) { q.perHour = Math.min(q.perHour, NEW_NUMBER.perHour); q.perDay = Math.min(q.perDay, NEW_NUMBER.perDay); }
  return q;
}

// patch: same shape as the stored value. Returns { settings } or { error }. Audit lines never carry secrets.
async function save(user, patch) {
  const cur = await load({ fresh: true });
  const next = merge(cur, patch || {});
  // The ack is not accepted from a generic patch; it has its own path (acknowledgeQr).
  next.qr.ack = cur.qr.ack;
  const changes = [];
  const diff = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(`${label}: ${a} -> ${b}`); };
  Object.keys(next.switches).forEach((c) => diff(`${c} company switch`, cur.switches[c] ? 'on' : 'off', next.switches[c] ? 'on' : 'off'));
  Object.keys(next.providers).forEach((c) => {
    diff(`${c} first provider`, cur.providers[c].primary, next.providers[c].primary);
    diff(`${c} try the next provider`, cur.providers[c].fallback, next.providers[c].fallback);
  });
  ['qr', 'android'].forEach((sec) => Object.keys(next[sec]).filter((f) => f !== 'ack').forEach((f) => diff(`${sec === 'qr' ? 'QR WhatsApp' : 'Android SMS'} ${f}`, cur[sec][f], next[sec][f])));
  await write(next, user);
  if (changes.length) {
    await require('../utils/audit').logAudit({ userId: user.id, actorName: user.name, action: 'Communication settings changed', entity: 'Integration', entityId: 'comm.settings', toValue: changes.join(' | ').slice(0, 480) }); // eslint-disable-line global-require
  }
  return { settings: next, changed: changes.length };
}

async function acknowledgeQr(user) {
  const cur = await load({ fresh: true });
  cur.qr.ack = { at: new Date().toISOString(), byId: user.id, byName: user.name };
  await write(cur, user);
  await require('../utils/audit').logAudit({ userId: user.id, actorName: user.name, action: 'WhatsApp QR prototype: "I understand" confirmed', entity: 'Integration', entityId: 'whatsapp-qr', toValue: 'Unofficial, can get the number banned, spare number only' }); // eslint-disable-line global-require
  return cur;
}

function order(settings, channel) {
  const all = PROVIDERS[channel];
  if (!all) return [];
  const p = settings.providers[channel];
  const first = all.includes(p.primary) ? p.primary : all[0];
  return p.fallback ? [first, ...all.filter((x) => x !== first)] : [first];
}

module.exports = { KEY, PROVIDERS, LABELS, SHORT, DEFAULTS, BOUNDS, NEW_NUMBER, load, save, acknowledgeQr, effectiveQr, order, merge };
