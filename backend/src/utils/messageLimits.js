// ---------------------------------------------------------------------------
// MESSAGE LIMITS — how fast and how many.
//
//   AppSetting "message-limits" = { Email: { perMinute, perDay }, SMS: {…}, WhatsApp: {…} }
//
//   perMinute   the pace of bulk / individual sends (a gap between messages)
//   perDay      the most messages one channel may send in a day through this
//               screen's bulk and individual sends. The count is made from the
//               send records (bulkMessaging jobs), so a rise or a fall in the
//               setting applies at once. Automatic pipeline messages
//               (stage changes) are not counted against it.
//
// The numbers are kept under what the providers allow; an Admin may change
// them. They are limits for safety, not a promise of what the provider will
// deliver.
// ---------------------------------------------------------------------------

const prisma = require('../db');

const KEY = 'message-limits';
const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
const DEFAULTS = {
  Email: { perMinute: 120, perDay: 500 },
  SMS: { perMinute: 120, perDay: 500 },
  WhatsApp: { perMinute: 120, perDay: 500 },
};
const BOUNDS = { perMinute: [1, 600], perDay: [1, 20000] };

let cache = null;
async function load({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 20000) return cache.value;
  let stored = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    stored = row ? JSON.parse(row.value) : {};
  } catch { stored = {}; }
  const value = {};
  CHANNELS.forEach((c) => {
    const s = (stored && stored[c]) || {};
    value[c] = {
      perMinute: Math.min(BOUNDS.perMinute[1], Math.max(BOUNDS.perMinute[0], Number(s.perMinute) || DEFAULTS[c].perMinute)),
      perDay: Math.min(BOUNDS.perDay[1], Math.max(BOUNDS.perDay[0], Number(s.perDay) || DEFAULTS[c].perDay)),
    };
  });
  cache = { at: Date.now(), value };
  return value;
}

async function save(user, patch) {
  const cur = await load({ fresh: true });
  const next = {};
  for (const c of CHANNELS) {
    const p = (patch && patch[c]) || {};
    next[c] = { ...cur[c] };
    for (const f of ['perMinute', 'perDay']) {
      if (p[f] === undefined) continue; // eslint-disable-line no-continue
      const n = Math.floor(Number(p[f]));
      if (!Number.isFinite(n) || n < BOUNDS[f][0] || n > BOUNDS[f][1]) {
        return { error: `${c}: ${f === 'perMinute' ? 'messages per minute' : 'messages per day'} must be between ${BOUNDS[f][0]} and ${BOUNDS[f][1]}.`, status: 400 };
      }
      next[c][f] = n;
    }
  }
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next), ...who }, update: { value: JSON.stringify(next), ...who } });
  cache = null;
  // eslint-disable-next-line global-require
  await require('./audit').logAudit({ userId: user && user.id, actorName: user && user.name, action: 'Message limits changed', entity: 'AppSetting', entityId: KEY, toValue: JSON.stringify(next) });
  return { limits: await load({ fresh: true }) };
}

// A gap between messages of the same channel, from the perMinute setting.
const nextSlot = {};
async function pace(channel) {
  const lim = (await load())[channel];
  const gap = 60000 / (lim ? lim.perMinute : 60);
  const now = Date.now();
  const at = Math.max(now, nextSlot[channel] || 0);
  nextSlot[channel] = at + gap;
  const wait = at - now;
  if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
}

const dayStart = () => {
  // Midnight today, India time.
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3600 * 1000;
};

// Messages this channel has sent (or has waiting to go) today.
function usedToday(channel, jobs) {
  const from = dayStart();
  let n = 0;
  jobs.forEach((j) => {
    j.recipients.forEach((r) => {
      if (r.channel !== channel) return;
      if (r.status === 'sent' && r.sentAt && Date.parse(r.sentAt) >= from) n += 1;
      else if ((r.status === 'queued' || r.status === 'sending') && Date.parse(j.createdAt) >= from) n += 1;
    });
  });
  return n;
}

module.exports = { KEY, CHANNELS, DEFAULTS, BOUNDS, load, save, pace, usedToday };
