// ---------------------------------------------------------------------------
// RCS BACKGROUND QUEUE + SMS FALLBACK + SETTINGS (founder's spec points 3, 6, 8).
//
//   enqueue()      a send becomes one rcs_batches row + one rcs_message_logs row per number (status queued), then the queue runs.
//   runOnce()      every waiting batch, in requests of at most 500 numbers, RCS_CHUNK_DELAY_MS (1.5 s) between requests.
//                  "Could not reach rcssms.in" / HTTP 5xx: tried again later, 2 retries, then failed.
//                  Error 23 (no credit): the WHOLE queue pauses (AppSetting rcs.queue.paused), the Admins get a notification, the
//                  numbers stay queued; Administration > Integrations > RCS > Resume sends them once credit is added.
//   fallbackFor()  SMS fallback (a switch, off by default): an RCS that failed, or was not delivered within 24 h, goes as an SMS through
//                  the EXISTING SMS gateway (channels.send 'SMS' on sms.gateway, the SMS Push Platform) - only for a template that has
//                  its approved SMS text + DLT template id. Its own result is kept on the same log row.
//   sweep()        the 24 h check (every 15 minutes on the server; off in the test sandbox, where a test calls it).
//
// Nothing here prints a number in full, a credential or a token.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const rcs = require('./rcsService');

const SETTINGS_KEY = 'rcs.settings';
const PAUSE_KEY = 'rcs.queue.paused';
const MAX_RETRIES = 2;
const DEFAULTS = { smsFallback: false, fallbackHours: 24, allowedUserIds: [] };

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const getSetting = async (key) => prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
const putSetting = (key, value) => {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  return prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
};
const mask = (n) => { const d = String(n || '').replace(/\D/g, ''); return d ? `xxxxxx${d.slice(-4)}` : '-'; };

async function settings() {
  const row = await getSetting(SETTINGS_KEY);
  const s = { ...DEFAULTS, ...parse(row && row.value, {}) };
  s.smsFallback = !!s.smsFallback;
  s.fallbackHours = Math.min(72, Math.max(1, Number(s.fallbackHours) || 24));
  s.allowedUserIds = [...new Set((Array.isArray(s.allowedUserIds) ? s.allowedUserIds : []).map(String).filter(Boolean))];
  return s;
}
async function saveSettings(patch) {
  const cur = await settings();
  const next = { ...cur };
  if (patch.smsFallback !== undefined) next.smsFallback = !!patch.smsFallback;
  if (patch.fallbackHours !== undefined) next.fallbackHours = Math.min(72, Math.max(1, Number(patch.fallbackHours) || 24));
  if (patch.allowedUserIds !== undefined) next.allowedUserIds = [...new Set((Array.isArray(patch.allowedUserIds) ? patch.allowedUserIds : []).map(String).filter(Boolean))].slice(0, 500);
  await putSetting(SETTINGS_KEY, next);
  return next;
}

async function pausedInfo() { const r = await getSetting(PAUSE_KEY); return r ? parse(r.value, { at: r.updatedAt }) : null; }

// ---- enqueue -------------------------------------------------------------------------------------------------------------------------
// recipients: [{ msisdn (clean), entityId, personName, variables (personal mode only) }]
async function enqueue({ user, module, template, mode, payload, recipients }) {
  const batch = await prisma.rcsBatch.create({
    data: {
      module, templateId: template.templateId, rcsType: template.rcsType, mode, payloadJson: JSON.stringify(payload || {}),
      total: recipients.length, createdById: user ? user.id : null, createdBy: user ? (user.name || null) : null,
    },
  });
  const rows = recipients.map((r) => ({
    module, entityId: r.entityId || null, personName: r.personName ? String(r.personName).slice(0, 160) : null, msisdn: r.msisdn,
    templateId: template.templateId, rcsType: template.rcsType, variablesJson: JSON.stringify(mode === 'personal' ? r.variables : (payload.variables || [])),
    requestRef: batch.id, sentById: user ? user.id : null, sentByName: user ? (user.name || null) : null,
  }));
  for (let i = 0; i < rows.length; i += 500) await prisma.rcsMessageLog.createMany({ data: rows.slice(i, i + 500) }); // eslint-disable-line no-await-in-loop
  kick();
  return batch;
}

// ---- the queue ---------------------------------------------------------------------------------------------------------------------
let running = null;
let again = false;
// One pass at a time. A kick during a pass (a new send, Resume) runs one more pass right after it, so nothing waits for the next timer.
function kick() {
  if (running) { again = true; return running; }
  again = false;
  running = runOnce().catch((e) => console.error('[rcs-queue]', String(e && e.message).slice(0, 200))) // eslint-disable-line no-console
    .finally(() => { running = null; if (again) kick(); });
  return running;
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const chunkDelay = () => Math.max(0, Number(process.env.RCS_CHUNK_DELAY_MS) || 1500);
const retryDelay = (attempt) => Math.max(0, Number(process.env.RCS_RETRY_DELAY_MS) || 30000) * attempt;

async function runOnce() {
  if (await pausedInfo()) return { paused: true };
  const now = new Date();
  const batches = await prisma.rcsBatch.findMany({
    where: { status: { in: ['queued', 'running'] }, OR: [{ nextTryAt: null }, { nextTryAt: { lte: now } }] },
    orderBy: { createdAt: 'asc' }, take: 20,
  });
  let first = true;
  for (const b of batches) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runBatch(b, () => { const was = first; first = false; return was; });
    if (r === 'paused') return { paused: true };
  }
  return { paused: false, batches: batches.length };
}

async function runBatch(batch, isFirst) {
  await prisma.rcsBatch.update({ where: { id: batch.id }, data: { status: 'running' } });
  const payload = parse(batch.payloadJson, {});
  let tries = batch.attempts;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const logs = await prisma.rcsMessageLog.findMany({ where: { requestRef: batch.id, status: 'queued' }, orderBy: { createdAt: 'asc' }, take: rcs.MAX_PER_REQUEST });
    if (!logs.length) {
      await prisma.rcsBatch.update({ where: { id: batch.id }, data: { status: 'done', nextTryAt: null } }); // eslint-disable-line no-await-in-loop
      return 'done';
    }
    if (!isFirst()) await wait(chunkDelay()); // eslint-disable-line no-await-in-loop
    const numbers = logs.map((l) => l.msisdn);
    // eslint-disable-next-line no-await-in-loop
    const ans = batch.mode === 'personal'
      ? await rcs.sendPersonalizedChunk(logs.map((l) => ({ msisdn: l.msisdn, templateid: l.templateId, variables: parse(l.variablesJson, []), buttonUrl: payload.buttonUrl })))
      : await rcs.sendChunk({ rcstype: batch.rcsType, templateid: batch.templateId, numbers, variables: payload.variables, buttonUrl: payload.buttonUrl, imageUrl: payload.imageUrl });
    const ids = logs.map((l) => l.id);
    await prisma.rcsMessageLog.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 } } }); // eslint-disable-line no-await-in-loop
    if (ans.ok) {
      const byNumber = rcs.idsByNumber(numbers, ans.items);
      const at = new Date();
      for (const l of logs) {
        const msgId = byNumber.get(l.msisdn);
        // eslint-disable-next-line no-await-in-loop
        if (msgId) await prisma.rcsMessageLog.update({ where: { id: l.id }, data: { status: 'sent', msgId, sentAt: at, errorCode: null, errorText: null } });
        // eslint-disable-next-line no-await-in-loop
        else await failLogs([l], 'NO_ID', 'rcssms.in did not confirm this number, so it is not counted as sent.', { fallback: true });
      }
      tries = 0;
      await prisma.rcsBatch.update({ where: { id: batch.id }, data: { attempts: 0, lastError: null } }); // eslint-disable-line no-await-in-loop
      continue; // eslint-disable-line no-continue
    }
    const code = String(ans.errorCode || '');
    if (code === '23') {
      // NO CREDIT: everything waits; nothing is marked failed (it was not refused for the person)
      const info = { at: new Date().toISOString(), reason: rcs.friendly(23), batchId: batch.id };
      await putSetting(PAUSE_KEY, info); // eslint-disable-line no-await-in-loop
      await prisma.rcsBatch.updateMany({ where: { status: { in: ['queued', 'running'] } }, data: { status: 'paused', lastError: rcs.friendly(23) } }); // eslint-disable-line no-await-in-loop
      await alertAdmins('RCS paused: no credit', `rcssms.in says there is not enough RCS credit. ${await prisma.rcsMessageLog.count({ where: { status: 'queued' } })} RCS messages are waiting. Add credit on rcssms.in, then press Resume in Administration > Integrations > RCS.`); // eslint-disable-line no-await-in-loop
      return 'paused';
    }
    if (ans.transient && tries < MAX_RETRIES) {
      const attempts = tries + 1;
      // eslint-disable-next-line no-await-in-loop
      await prisma.rcsBatch.update({ where: { id: batch.id }, data: { status: 'queued', attempts, lastError: ans.error, nextTryAt: new Date(Date.now() + retryDelay(attempts)) } });
      // these numbers went nowhere: their try is not counted against them
      await prisma.rcsMessageLog.updateMany({ where: { id: { in: ids } }, data: { errorText: `Trying again (${attempts} of ${MAX_RETRIES}): ${ans.error}`.slice(0, 500) } }); // eslint-disable-line no-await-in-loop
      setTimeout(kick, retryDelay(attempts) + 50).unref?.();
      return 'retry';
    }
    // refused, or retries used up: failed. A reply TeamLink could not read (maybe sent) gets no automatic SMS on top.
    // eslint-disable-next-line no-await-in-loop
    await failLogs(logs, code || 'ERROR', ans.error, { fallback: !ans.unknown });
    tries = 0;
    await prisma.rcsBatch.update({ where: { id: batch.id }, data: { attempts: 0, lastError: ans.error } }); // eslint-disable-line no-await-in-loop
  }
}

async function failLogs(logs, code, text, { fallback }) {
  await prisma.rcsMessageLog.updateMany({ where: { id: { in: logs.map((l) => l.id) } }, data: { status: 'failed', errorCode: String(code).slice(0, 20), errorText: String(text || '').slice(0, 500) } });
  if (fallback) await fallbackFor(logs.map((l) => l.id), 'RCS failed');
}

async function alertAdmins(title, message) {
  try {
    const admins = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true } });
    await require('./notify').notifyUsers(admins.map((a) => a.id), { title, message }); // eslint-disable-line global-require
  } catch (e) { console.error('[rcs-queue] admin alert failed:', String(e && e.message).slice(0, 120)); } // eslint-disable-line no-console
}

async function resume() {
  await prisma.appSetting.deleteMany({ where: { key: PAUSE_KEY } });
  const n = await prisma.rcsBatch.updateMany({ where: { status: 'paused' }, data: { status: 'queued', nextTryAt: null, attempts: 0 } });
  kick();
  return n.count;
}

// ---- SMS fallback ------------------------------------------------------------------------------------------------------------------
// The SMS words: the template's approved SMS text with {var1} {var2} ... filled from the RCS variables (the first card for a carousel).
function smsWords(text, vars) {
  const v = (Array.isArray(vars) ? vars[0] : vars) || {};
  const missing = [];
  const out = String(text || '').replace(/\{\s*(var\d{1,2})\s*\}/g, (m, k) => { if (v[k] == null || v[k] === '') { missing.push(k); return m; } return String(v[k]); });
  return { text: out, missing };
}

async function fallbackFor(logIds, why) {
  const st = await settings();
  if (!st.smsFallback || !logIds.length) return { sent: 0 };
  const logs = await prisma.rcsMessageLog.findMany({ where: { id: { in: logIds }, fallbackStatus: null } });
  if (!logs.length) return { sent: 0 };
  const tpls = await prisma.rcsTemplate.findMany({ where: { templateId: { in: [...new Set(logs.map((l) => l.templateId))] } } });
  const tplOf = new Map(tpls.map((t) => [t.templateId, t]));
  const channels = require('../channels'); // eslint-disable-line global-require
  let sent = 0;
  for (const l of logs) {
    const t = tplOf.get(l.templateId);
    const fb = t ? (parse(t.bodyJson, {}).fallback || {}) : {};
    const mark = (data) => prisma.rcsMessageLog.update({ where: { id: l.id }, data: { fallbackAt: new Date(), ...data } });
    if (!fb.text || !fb.dltTemplateId) { await mark({ fallbackStatus: 'skipped', fallbackError: 'This RCS template has no SMS text / DLT template id for the SMS fallback.' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    const w = smsWords(fb.text, parse(l.variablesJson, []));
    if (w.missing.length) { await mark({ fallbackStatus: 'skipped', fallbackError: `The SMS text needs ${w.missing.join(', ')}, which this message did not have.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    // eslint-disable-next-line no-await-in-loop
    const r = await channels.send('SMS', {
      to: l.msisdn, kind: 'bulk', text: w.text, templateId: String(fb.dltTemplateId), providerOnly: 'sms.gateway',
      meta: { module: l.module, personName: l.personName || null, senderUserId: l.sentById || null, senderName: l.sentByName || null, template: t.name, purpose: 'RCS_FALLBACK', preview: w.text, reason: why },
    }).catch((e) => ({ ok: false, error: String(e && e.message) }));
    // eslint-disable-next-line no-await-in-loop
    await mark(r.ok ? { fallbackStatus: 'sent', fallbackRef: r.providerRef ? String(r.providerRef).slice(0, 120) : null, fallbackError: null } : { fallbackStatus: 'failed', fallbackError: String(r.error || 'The SMS was not sent.').slice(0, 500) });
    if (r.ok) sent += 1;
  }
  return { sent, tried: logs.length };
}

// The 24 h check: sent but no delivery report in time -> SMS (when the switch is on).
async function sweep() {
  const st = await settings();
  if (!st.smsFallback) return { checked: 0, sent: 0 };
  const before = new Date(Date.now() - st.fallbackHours * 3600 * 1000);
  const late = await prisma.rcsMessageLog.findMany({ where: { status: 'sent', deliveredAt: null, fallbackStatus: null, sentAt: { lte: before } }, select: { id: true }, take: 500 });
  const r = await fallbackFor(late.map((l) => l.id), `not delivered within ${st.fallbackHours} h`);
  return { checked: late.length, sent: r.sent || 0 };
}

let timers = [];
function start() {
  if (require('./sandbox').isSandbox() || /^(0|off|false)$/i.test(String(process.env.RCS_QUEUE || ''))) return; // eslint-disable-line global-require
  timers.forEach(clearInterval);
  timers = [
    setInterval(() => { kick(); }, 60 * 1000),
    setInterval(() => { sweep().catch((e) => console.error('[rcs-fallback]', String(e && e.message).slice(0, 200))); }, 15 * 60 * 1000), // eslint-disable-line no-console
  ];
  timers.forEach((t) => t.unref && t.unref());
  setTimeout(kick, 20 * 1000).unref?.();
}

module.exports = { settings, saveSettings, pausedInfo, enqueue, kick, runOnce, resume, fallbackFor, sweep, smsWords, start, mask, PAUSE_KEY, SETTINGS_KEY };
