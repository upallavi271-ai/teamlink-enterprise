// ---------------------------------------------------------------------------
// LEAVE META (no schema change): where a leave request came from and what Pulse said about it.
// One AppSetting row per request, key  leave.meta.<leaveId>, JSON:
//   { source: 'TeamLink' | 'Pulse' | 'Pulse sync', pulseStatus, pulseBy, pulseAt, syncId, note }
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = (id) => `leave.meta.${id}`;

async function getMeta(id) {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY(id) } });
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function setMeta(id, patch) {
  const cur = (await getMeta(id)) || {};
  const value = JSON.stringify({ ...cur, ...patch });
  await prisma.appSetting.upsert({ where: { key: KEY(id) }, update: { value }, create: { key: KEY(id), value } });
  return JSON.parse(value);
}
async function metaMap(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.appSetting.findMany({ where: { key: { in: part.map(KEY) } } });
    rows.forEach((r) => { try { out.set(r.key.slice('leave.meta.'.length), JSON.parse(r.value)); } catch { /* skip */ } });
  }
  return out;
}
async function clearMeta(id) { await prisma.appSetting.deleteMany({ where: { key: KEY(id) } }); }

module.exports = { KEY, getMeta, setMeta, metaMap, clearMeta };
