// ---------------------------------------------------------------------------
// A WHATSAPP NUMBER CONNECTED INSIDE OMNI-CHANNEL ALSO LIVES IN TEAMLINK (founder 2026-11-04: "whatsapp integration green start lonu
// cheyali and teamlink lo kuda undali").
//
// Until now numbers went one way: TeamLink (Administration > Integrations > WhatsApp numbers) -> Omni-Channel (utils/greenStartIntegrations.js,
// utils/omniDeptLogins.js). Now an Admin may also connect a number in Omni-Channel (Settings > Communication Providers > WhatsApp > Add New).
// Green Start then hands the same details to TeamLink on this server (127.0.0.1, POST /api/omni-gs/from-omni/whatsapp-number), signed with the
// one-click sign-in secret both servers already share (GREENSTART_SSO_SECRET here, TEAMLINK_SSO_SECRET there), and TeamLink:
//   - adds the number to its WhatsApp numbers (its own token, stored encrypted like every number's), or, when that Phone number ID is already
//     there, takes the new WhatsApp Business ID and token (the Main number of the WhatsApp Business form is never changed behind its back);
//   - gives it the department of the Omni-Channel workspace it was connected in ("Teamlink Medical" -> Medical), so the same people use it;
//   - pins it to that workspace in the number -> workspace map (AppSetting omni.gs.waMap, a hand-made choice), so the hourly sync keeps it
//     there instead of moving it; a TeamLink number that pointed at the same workspace lets go of it (Omni-Channel keeps ONE number per
//     workspace, and the Admin just put this one there);
//   - asks Meta about it at once (the chip) and lets the department logins run again.
// A connection TeamLink itself sent to Omni-Channel is never sent back (Green Start skips labels that start with "TeamLink - ").
// Nothing secret is logged or returned.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const WN = require('./waNumbers');

const WA_MAP_KEY = 'omni.gs.waMap';
const DEPT_KEY = 'omni.gs.deptLogins';
const SYSTEM = { id: null, name: 'Omni-Channel' };
const MAX_SKEW_S = 300;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const getSetting = async (k, d) => parse(((await prisma.appSetting.findUnique({ where: { key: k } }).catch(() => null)) || {}).value, d);
const putSetting = (k, v) => prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: JSON.stringify(v) }, update: { value: JSON.stringify(v) } });
const digits = (v) => String(v || '').replace(/\D/g, '');

const secret = () => String(process.env.GREENSTART_SSO_SECRET || '');
/** X-TeamLink-Omni-Signature: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${raw body}`>". */
function signatureOk(header, raw, now = Date.now()) {
  const key = secret();
  if (key.length < 32) return false;
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > MAX_SKEW_S || !/^[0-9a-f]{64}$/i.test(String(parts.v1 || ''))) return false;
  const want = crypto.createHmac('sha256', key).update(`${t}.`).update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''))).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(String(parts.v1), 'hex'));
}

// The TeamLink department an Omni-Channel workspace stands for: what the department logins / the map remember, else its name
// ("Teamlink Medical", "Teamlink Education - 2", "Medical") matched against TeamLink's departments.
async function departmentOf(workspaceId, workspaceName) {
  const map = await getSetting(WA_MAP_KEY, {});
  const fromMap = Object.values(map).find((v) => v && v.workspaceId === workspaceId && v.dept);
  if (fromMap) return fromMap.dept;
  const rows = ((await getSetting(DEPT_KEY, {})).last || {}).rows || [];
  const fromRun = rows.find((r) => (r.workspaceIds || [r.workspaceId]).includes(workspaceId) && r.dept && r.dept !== '—');
  if (fromRun) return fromRun.dept;
  const bare = String(require('./omniWsNames').deptOfName(workspaceName) || String(workspaceName || '').trim().replace(/\s+-\s+\d+$/, '')).trim().toLowerCase(); // eslint-disable-line global-require
  if (!bare) return null;
  const master = (await WN.departmentCounts().catch(() => [])).map((d) => d.name);
  return master.find((m) => m.toLowerCase() === bare) || null;
}

function check(b) {
  const bad = (error) => ({ error, status: 400 });
  if (!b || typeof b !== 'object') return bad('Nothing was sent.');
  if (!/^[\w-]{6,64}$/.test(String(b.workspaceId || ''))) return bad('The Omni-Channel workspace is missing.');
  if (!/^\d{6,25}$/.test(String(b.phoneNumberId || ''))) return bad('The Phone number ID is missing.');
  if (b.wabaId && !/^\d{6,25}$/.test(String(b.wabaId))) return bad('The WhatsApp Business Account ID is only digits.');
  if (String(b.accessToken || '').trim().length < 16) return bad('The access token is missing.');
  return null;
}

/** -> { ok, state: 'added' | 'updated' | 'kept', numberId, label, department, words } | { error, status } */
async function importFromOmni(b) {
  const bad = check(b);
  if (bad) return bad;
  await WN.ensure();
  const phoneNumberId = String(b.phoneNumberId);
  const wabaId = b.wabaId ? String(b.wabaId) : undefined;
  const department = await departmentOf(String(b.workspaceId), b.workspaceName);
  const display = digits(b.displayNumber).length >= 8 ? `+${digits(b.displayNumber)}` : '';
  const label = String(b.verifiedName || '').trim().slice(0, 60) || `Omni-Channel ${String(b.workspaceName || '').trim()}`.trim().slice(0, 60);
  const existing = (await WN.listRows()).find((r) => String(r.phoneNumberId) === phoneNumberId);
  let state;
  let row = existing;
  if (existing && existing.credSource === 'legacy') {
    state = 'kept'; // the WhatsApp Business form owns the Main number's details
  } else if (existing) {
    const u = await WN.update(SYSTEM, existing.id, { ...(wabaId ? { wabaId } : {}), token: String(b.accessToken).trim(), tokenMode: 'own' });
    if (u.error) return u;
    row = u.row; state = 'updated';
  } else {
    if (!display) return { error: 'Omni-Channel did not say which phone number this is.', status: 400 };
    const c = await WN.create(SYSTEM, {
      label: label.length >= 2 ? label : 'Omni-Channel number', displayNumber: display, phoneNumberId, ...(wabaId ? { wabaId } : {}),
      token: String(b.accessToken).trim(), tokenMode: 'own', ...(department ? { access: { departments: [department] } } : {}),
    });
    if (c.error) return c;
    row = c.row; state = 'added';
  }
  // pin it to the workspace it was connected in; another TeamLink number that pointed there lets go (one number per workspace)
  const map = await getSetting(WA_MAP_KEY, {});
  for (const [nid, v] of Object.entries(map)) if (nid !== row.id && v && v.workspaceId === b.workspaceId) delete map[nid];
  map[row.id] = { workspaceId: String(b.workspaceId), auto: false, ...(department ? { dept: department } : {}), from: 'omni' };
  await putSetting(WA_MAP_KEY, map);
  try { require('./omniDeptLogins').schedule('WhatsApp number connected in Omni-Channel'); } catch { /* the hourly run does it */ } // eslint-disable-line global-require
  const words = state === 'kept'
    ? `This is TeamLink's Main number: its details stay in the WhatsApp Business form (Administration > Integrations).`
    : `${state === 'added' ? 'Added to' : 'Updated in'} TeamLink's WhatsApp numbers as "${row.label}"${department ? `, for the ${department} department` : ' (no department yet: give it one in TeamLink)'}.`;
  return { ok: true, state, numberId: row.id, label: row.label, department, words };
}

module.exports = { importFromOmni, signatureOk, departmentOf };
