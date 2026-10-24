// ---------------------------------------------------------------------------
// OMNI-CHANNEL CONFIGURATION HUB (founder structure plan 2026-10-17, Admin only). Backend of: Meta WhatsApp, Departments, Permissions.
//   Meta WhatsApp  ONE Meta business account (set up in Administration > Integrations > WhatsApp Business; only READ here) shared by every
//                  department. Each department has its own templates, campaigns, analytics and inbox view (the department word on them);
//                  the mapping below is the department list with a head and a "uses WhatsApp" switch. check() only does a read of the number
//                  (name, quality, message limit) at Meta; it never sends.
//   Departments    names come from the Department master (Administration); Admin may add names that are not there yet (stored in
//                  AppSetting 'omni.departments'). Heads are informational: the Department Head LEVEL comes from the person's role (STL / Manager).
//   Permissions    the role table (read only, made from access.js), the credit rules, and the Marketing capability (AppSetting 'omni.permissions',
//                  default nobody; an Admin ticks people; it opens campaigns, promotions, templates, analytics and ROI, never candidate hiring).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./access');
const Hub = require('./hub');
const { logAudit } = require('../utils/audit');

const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const FOUNDER_NAMES = ['Internal', 'Medical', 'Education', 'Manufacturing', 'Non-IT', 'Staffing'];

async function getKey(key, d) { const r = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null); return r ? parse(r.value, d) : d; }
async function putKey(key, value, user) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: v, updatedById: user.id, updatedByName: user.name }, update: { value: v, updatedById: user.id, updatedByName: user.name } });
}

async function departments() {
  const master = (await prisma.department.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } }).catch(() => [])).map((d) => d.name);
  const saved = await getKey('omni.departments', { rows: [], extra: [] });
  const extra = (saved.extra || []).filter((n) => !master.some((m) => m.toLowerCase() === n.toLowerCase()));
  const names = [...master, ...extra];
  const rows = names.map((name) => {
    const s = (saved.rows || []).find((r) => String(r.name).toLowerCase() === name.toLowerCase()) || {};
    return { name, inMaster: master.includes(name), head: s.head || null, headName: s.headName || '', whatsapp: s.whatsapp !== false };
  });
  return { rows, master, founderNames: FOUNDER_NAMES.map((n) => ({ name: n, inList: names.some((x) => x.toLowerCase() === n.toLowerCase()) })) };
}
async function saveDepartments(user, b) {
  const cur = await departments();
  const extra = [...new Set((Array.isArray(b.extra) ? b.extra : []).map((x) => clip(x, 60)).filter((x) => x.length >= 2))].slice(0, 40);
  const rows = [];
  for (const r of (Array.isArray(b.rows) ? b.rows : [])) {
    const name = clip(r.name, 60);
    if (!name) continue; // eslint-disable-line no-continue
    let head = null; let headName = '';
    if (r.head) {
      const u = await prisma.user.findUnique({ where: { id: String(r.head) }, select: { id: true, name: true } }).catch(() => null); // eslint-disable-line no-await-in-loop
      if (!u) return { error: `The head chosen for ${name} was not found.`, status: 400 };
      head = u.id; headName = u.name;
    }
    rows.push({ name, head, headName, whatsapp: r.whatsapp !== false });
  }
  const known = new Set([...cur.rows.map((r) => r.name.toLowerCase()), ...extra.map((x) => x.toLowerCase())]);
  const bad = rows.find((r) => !known.has(r.name.toLowerCase()));
  if (bad) return { error: `"${bad.name}" is not in the department list. Add it first.`, status: 400 };
  await putKey('omni.departments', { rows, extra }, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel departments changed', entity: 'OmniDepartments', entityId: 'map', toValue: `${rows.length} departments, ${extra.length} added` });
  return { ok: 'Saved.', ...(await departments()) };
}

// the connected account, read from the existing WhatsApp integration card (no network)
async function account() {
  const wa = require('../utils/whatsappCloud'); // eslint-disable-line global-require
  const cfg = await wa.whatsappConfig();
  const seen = await require('../utils/messageDelivery').seenOf('whatsapp').catch(() => null); // eslint-disable-line global-require
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const mask = (v) => (v ? `${'*'.repeat(Math.max(0, String(v).length - 4))}${String(v).slice(-4)}` : '');
  return {
    connected: !!cfg.configured, why: cfg.configured ? '' : (cfg.reason || 'Not connected'), number: cfg.display || '', phoneIdMasked: mask(cfg.phoneId), businessIdMasked: mask(cfg.wabaId), testServer: !!cfg.testMode,
    secretSaved: !!cfg.appSecret, verifyTokenSaved: !!cfg.verifyToken,
    webhook: { url: `${base || ''}/api/webhooks/whatsapp`, hasPublicAddress: !!base, lastCall: seen ? seen.at : null, calls: seen ? seen.count : 0, state: seen ? 'green' : (cfg.configured ? 'yellow' : 'red') },
    where: 'Administration > Integrations > Connections > WhatsApp Business',
  };
}
// read the number's name, quality and message limit at Meta (a GET; nothing is sent)
async function check() {
  const wa = require('../utils/whatsappCloud'); // eslint-disable-line global-require
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const cfg = await wa.whatsappConfig();
  if (!cfg.configured) return { ok: false, words: `Not connected yet. ${cfg.reason || ''}`.trim() };
  const res = await core.httpJson(`${cfg.base}/${wa.VERSION}/${encodeURIComponent(cfg.phoneId)}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`, { headers: { authorization: `Bearer ${cfg.token}` } });
  if (res.ok && res.json && (res.json.display_phone_number || res.json.id)) {
    const j = res.json;
    const lim = { TIER_50: '50 people a day', TIER_250: '250 people a day', TIER_1K: '1,000 people a day', TIER_10K: '10,000 people a day', TIER_100K: '100,000 people a day', TIER_UNLIMITED: 'no limit' };
    return { ok: true, name: j.verified_name || '', number: j.display_phone_number || '', quality: j.quality_rating || 'not shown', limit: lim[j.messaging_limit_tier] || j.messaging_limit_tier || 'not shown', words: 'Read from Meta just now. Nothing was sent.' };
  }
  return { ok: false, words: 'Meta did not answer. Check the token in Administration > Integrations.' };
}
// the WhatsApp templates and where they stand (one list for the whole company, with the department word)
async function approvals(user) {
  const out = await Hub.list(user, { channel: 'WhatsApp' });
  return out.items.filter((i) => i.wa).map((i) => ({ key: i.key, name: i.name, kind: i.sourceWord, department: i.department || 'All', status: i.wa.status, waName: i.wa.name }));
}

async function people() {
  const emps = await prisma.employee.findMany({ where: { userId: { not: null }, employmentStatus: 'Active' }, select: { userId: true, name: true, department: true, employeeCode: true }, orderBy: { name: 'asc' }, take: 1500 });
  return emps.map((e) => ({ userId: e.userId, name: e.name, department: e.department || '', code: e.employeeCode }));
}
async function permissions(user) {
  const Cr = require('./credits'); // eslint-disable-line global-require
  const saved = await getKey('omni.permissions', { marketingUserIds: [] });
  const ids = Array.isArray(saved.marketingUserIds) ? saved.marketingUserIds : [];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return {
    roles: A.rolesTable(), matrix: Object.entries(A.LEVEL_WORDS).filter(([k]) => k !== 'none').map(([id, words]) => ({ id, words, hubs: A.hubsForLevel(id) })), credits: await Cr.settings(), marketing: users.map((u) => ({ userId: u.id, name: u.name })),
    marketingWords: 'Marketing: campaigns, promotions, templates, analytics and ROI. No candidate hiring work, no phone numbers or emails. Default: nobody.',
  };
}
async function setMarketing(user, userIds) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(String))].slice(0, 100);
  const found = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, status: 'Active' }, select: { id: true } }) : [];
  const ok = found.map((u) => u.id);
  await putKey('omni.permissions', { marketingUserIds: ok }, user);
  A.setMarketingIds(ok);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel Marketing capability changed', entity: 'OmniPermissions', entityId: 'marketing', toValue: `${ok.length} people` });
  return { ok: 'Saved.', count: ok.length };
}

module.exports = { departments, saveDepartments, account, check, approvals, people, permissions, setMarketing };
