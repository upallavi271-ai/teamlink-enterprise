// ---------------------------------------------------------------------------
// JOB BROADCAST STORE: contact lists, campaigns, replies, settings. AppSetting rows only (no migration).
//   bc.settings             { master:false, autoReply:{on:false,text}, quiet:{from:21,to:9} }
//   bc.list.<id>            list meta (name, source, owner, consent, deletedAt, retentionDays, counts)
//   bc.contacts.<id>        [{ i, name, phone(e164), email, company, city, skills, tag, status, why, cand }]
//   bc.camp.<id>            campaign meta
//   bc.crow.<id>            [{ i, phone, name, st, at, ref, why, intent }]  one row per contact
//   bc.reply.<id>           [{ id, phone, name, text, at, intent, added }]
//   bc.jobsent.<jobId>      { <phone>: campaignId }   one message per contact per job
//   bc.day.<yyyymmdd>       { sent: n }              messages this module sent that day (IST)
// Every read-modify-write goes through update() (one queue per key) so a send tick and an inbound reply never
// overwrite each other.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const locks = new Map();
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

async function get(key, d = null) {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  return row ? parse(row.value, d) : d;
}
async function put(key, value, user) {
  const v = JSON.stringify(value);
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v, ...who }, update: { value: v, ...who } });
  return value;
}
async function del(key) { await prisma.appSetting.deleteMany({ where: { key } }); }
// fn(current) -> next (or undefined = leave)
function update(key, d, fn, user) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const cur = await get(key, d);
    const next = await fn(cur);
    if (next === undefined) return cur;
    await put(key, next, user);
    return next;
  });
  locks.set(key, run);
  run.finally(() => { if (locks.get(key) === run) locks.delete(key); }).catch(() => {});
  return run;
}
async function keys(prefix, { updatedAfter } = {}) {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: prefix }, ...(updatedAfter ? { updatedAt: { gt: updatedAfter } } : {}) }, select: { key: true } });
  return rows.map((r) => r.key);
}

const DEFAULT_SETTINGS = { master: false, showAddAsCandidate: false, // Omni-Channel rule: the old "Add as candidate" button is hidden unless an Admin switches it on (the route still works)
  autoReply: { on: false, text: 'Thank you! Please apply here: {{applyLink}}. A recruiter will call you. Reply STOP to stop messages.' }, quiet: { from: 21, to: 9 } };
async function settings() {
  const s = await get('bc.settings', {});
  return { ...DEFAULT_SETTINGS, ...s, autoReply: { ...DEFAULT_SETTINGS.autoReply, ...(s.autoReply || {}) }, quiet: { ...DEFAULT_SETTINGS.quiet, ...(s.quiet || {}) } };
}
const saveSettings = (s, user) => put('bc.settings', s, user);

// the IST day key and hour
const istNow = (now = Date.now()) => new Date(now + 5.5 * 3600 * 1000);
const dayKey = (now = Date.now()) => { const d = istNow(now); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };
const istHour = (now = Date.now()) => istNow(now).getUTCHours();

module.exports = { get, put, del, update, keys, newId, settings, saveSettings, DEFAULT_SETTINGS, dayKey, istHour, parse };
