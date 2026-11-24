// ---------------------------------------------------------------------------
// VICIDIAL "CLICK TO DIAL" (2026-11-24). The office ViciDial server (ViciDial 2.14 on the office LAN) is on a private address that this
// internet server cannot reach, but the recruiter's BROWSER is on the office LAN and can. So the dial request goes from the recruiter's browser,
// as a small popup window (a top-level navigation: a fetch / iframe from an HTTPS page to a private HTTP address is blocked), to ViciDial's own
// documented AGENT API:
//   http://<vicidial>/agc/api.php?source=teamlink&user=<API user>&pass=<API pass>&agent_user=<the recruiter's agent ID>&function=external_dial
//        &value=<10-digit number>&phone_code=91&search=YES&preview=NO&focus=YES
// ViciDial dials on the agent's OWN session (the agent must be logged in to the ViciDial agent screen), through its normal carriers and its own
// recording. Nothing on ViciDial is changed. This server NEVER contacts ViciDial: it only checks who may call whom, writes the call row and hands
// the one dial link to an allowed caller at call time.
//
// Settings (Administration > Integrations > ViciDial (office dialer)), Admin only:
//   enabled   On / Off (default OFF)
//   server    http://<address>[:port] (default empty)
//   apiUser   the ViciDial API user (only the agent-API permission, allowed function external_dial)
//   apiPass   encrypted with utils/secrets (INTEGRATION_SECRET_KEY); never sent to a browser except inside the one dial link
//   phoneCode default 91
// Each recruiter's ViciDial agent ID: the mapping table ViciDialAgent (TeamLink person -> ViciDial agent user), edited in the same card.
//
// NOT BUILT (and why): reading the call's result back from ViciDial (its non-agent API) - this server cannot reach the private address, so the
// recruiter sets the outcome (Connected / No answer / Busy / Wrong number + note) in the call bar after the call.
// Tables are self-provisioned (raw SQL, CREATE TABLE IF NOT EXISTS). ADDITIVE ONLY.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const secrets = require('../utils/secrets');

const DDL = [
  'CREATE TABLE IF NOT EXISTS "ViciDialSetting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT, "updatedAt" TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "ViciDialAgent" ("userId" TEXT NOT NULL PRIMARY KEY, "agentUser" TEXT NOT NULL, "updatedById" TEXT, "updatedAt" TEXT NOT NULL)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ViciDialAgent_agent" ON "ViciDialAgent"("agentUser")',
];
let READY = null;
function ensure() {
  if (!READY) READY = (async () => { for (const s of DDL) await prisma.$executeRawUnsafe(s); })().catch((e) => { READY = null; throw e; }); // eslint-disable-line no-await-in-loop
  return READY;
}
const plain = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v; return o; };
async function all(sql, ...p) { await ensure(); return (await prisma.$queryRawUnsafe(sql, ...p)).map(plain); }
async function run(sql, ...p) { await ensure(); return prisma.$executeRawUnsafe(sql, ...p); }
const nowIso = () => new Date().toISOString();

const LINE_ID = 'vicidial';
const LINE_NAME = 'ViciDial';
const CARD = 'Administration > Integrations > Connections > ViciDial (office dialer)';
const AGENT_RE = /^[A-Za-z0-9._@-]{1,40}$/;
const SERVER_RE = /^https?:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}))(?::(\d{1,5}))?\/?$/;
const OUTCOMES = { Connected: 'completed', 'No answer': 'missed', Busy: 'busy', 'Wrong number': 'failed' };
const NOTE = 'The ViciDial API user must have ONLY the agent-API permission: in ViciDial, Admin > Users > (the API user) > "Agent API Access" = 1 and "API Allowed Functions" = external_dial only. Each recruiter must be logged in to the ViciDial agent screen when they press Call.';

async function rawSettings() {
  const m = { enabled: '0', server: '', apiUser: '', apiPass: '', phoneCode: '91' };
  for (const r of await all('SELECT "key","value" FROM "ViciDialSetting"')) m[r.key] = r.value == null ? '' : r.value;
  return m;
}
/** What the Admin screen may see: never the password (only whether one is stored). */
async function load() {
  const m = await rawSettings();
  const passOk = !m.apiPass || secrets.decryptSecret(m.apiPass) !== null;
  return {
    enabled: m.enabled === '1', server: m.server || '', apiUser: m.apiUser || '', hasPassword: !!m.apiPass, passwordReadable: passOk,
    phoneCode: /^\d{1,4}$/.test(m.phoneCode || '') ? m.phoneCode : '91', note: NOTE,
  };
}
const missingFor = (s) => [!s.server && 'the server address', !s.apiUser && 'the API user', !s.hasPassword && 'the API password'].filter(Boolean);

async function save(patch, user) {
  const put = (k, v) => run('INSERT INTO "ViciDialSetting" ("key","value","updatedAt") VALUES (?,?,?) ON CONFLICT("key") DO UPDATE SET "value"=excluded."value","updatedAt"=excluded."updatedAt"', k, String(v), nowIso());
  const b = patch || {};
  if (b.server !== undefined) {
    const v = String(b.server || '').trim().replace(/\/+$/, '');
    if (v && !SERVER_RE.test(v)) return { status: 400, error: 'The server address must look like http://192.168.0.200 (http or https, the address, an optional :port, nothing after it).' };
    if (v) { const port = (v.match(/:(\d{1,5})$/) || [])[1]; if (port && Number(port) > 65535) return { status: 400, error: 'The port must be 1 to 65535.' }; }
    await put('server', v);
  }
  if (b.apiUser !== undefined) {
    const v = String(b.apiUser || '').trim();
    if (v && !AGENT_RE.test(v)) return { status: 400, error: 'The API user may only have letters, digits and . _ @ - (up to 40).' };
    await put('apiUser', v);
  }
  if (b.phoneCode !== undefined) {
    const v = String(b.phoneCode || '').trim() || '91';
    if (!/^\d{1,4}$/.test(v)) return { status: 400, error: 'The phone code is 1 to 4 digits, for example 91.' };
    await put('phoneCode', v);
  }
  if (b.clearPassword) await put('apiPass', '');
  else if (b.apiPass !== undefined && b.apiPass !== null && String(b.apiPass) !== '') {
    const v = String(b.apiPass);
    if (v.length > 100 || /[\r\n]/.test(v)) return { status: 400, error: 'The API password is too long or has a line break.' };
    let enc;
    try { enc = secrets.encryptSecret(v); } catch (e) { return { status: 400, error: e.code === 'NO_SECRET_KEY' ? e.message : 'The password could not be stored.' }; }
    await put('apiPass', enc);
  }
  if (b.enabled !== undefined) {
    const on = b.enabled === true || b.enabled === '1' || b.enabled === 1 || b.enabled === 'On';
    if (on) {
      const s = await load();
      const miss = missingFor(s);
      if (miss.length) return { status: 400, error: `Fill in ${miss.join(', ')} before switching ViciDial on.` };
    }
    await put('enabled', on ? '1' : '0');
  }
  void user;
  return { settings: await load() };
}

// ---- agent IDs (TeamLink person -> ViciDial agent user)
async function agentFor(userId) {
  const r = (await all('SELECT "agentUser" FROM "ViciDialAgent" WHERE "userId"=?', String(userId || '')))[0];
  return r ? r.agentUser : null;
}
async function agentsMap() {
  return new Map((await all('SELECT "userId","agentUser","updatedAt" FROM "ViciDialAgent"')).map((r) => [r.userId, r]));
}
async function setAgent(userId, agentUser, by) {
  const id = String(userId || '').slice(0, 60);
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true, status: true } });
  if (!u) return { status: 404, error: 'That person was not found.' };
  const v = String(agentUser == null ? '' : agentUser).trim();
  if (!v) { await run('DELETE FROM "ViciDialAgent" WHERE "userId"=?', id); return { user: u, agentUser: null }; }
  if (!AGENT_RE.test(v)) return { status: 400, error: 'A ViciDial agent ID may only have letters, digits and . _ @ - (up to 40), for example 1012.' };
  const taken = (await all('SELECT "userId" FROM "ViciDialAgent" WHERE "agentUser"=? AND "userId"<>?', v, id))[0];
  if (taken) {
    const o = await prisma.user.findUnique({ where: { id: taken.userId }, select: { name: true } });
    return { status: 409, error: `The ViciDial agent ID ${v} is already set for ${o ? o.name : 'another person'}. One agent ID belongs to one person.` };
  }
  await run('INSERT INTO "ViciDialAgent" ("userId","agentUser","updatedById","updatedAt") VALUES (?,?,?,?) ON CONFLICT("userId") DO UPDATE SET "agentUser"=excluded."agentUser","updatedById"=excluded."updatedById","updatedAt"=excluded."updatedAt"', id, v, by ? by.id : null, nowIso());
  return { user: u, agentUser: v };
}

// may this login use ViciDial at all (role side only; the candidate / contact checks are at dial time)
const REFUSED_KINDS = ['bde', 'view', 'none', 'marketing'];
/** { ok, reason } for the "Call using" lists. `kind` = outreach/access kind of the login. */
async function readyFor(user, kind) {
  const s = await load();
  if (!s.enabled) return { ok: false, off: true, reason: `ViciDial is not connected yet. An Admin switches it on in ${CARD}.` };
  if (REFUSED_KINDS.includes(kind)) return { ok: false, reason: 'Your role may not dial candidates on ViciDial from TeamLink.' };
  if (!s.passwordReadable) return { ok: false, reason: 'The stored ViciDial API password cannot be read on this server (the encryption key changed). An Admin types it again.' };
  const agent = await agentFor(user && user.id);
  if (!agent) return { ok: false, noAgent: true, reason: `Ask an Admin to set your ViciDial agent ID (${CARD}).` };
  return { ok: true, agent, settings: s };
}

/** The one dial link (contains the API password: handed only to the allowed caller, in the one dial answer; never logged). */
async function dialUrl({ agentUser, number }) {
  const m = await rawSettings();
  const pass = secrets.decryptSecret(m.apiPass);
  if (!pass) return { error: 'The ViciDial API password cannot be read on this server. An Admin types it again.' };
  const q = new URLSearchParams();
  q.set('source', 'teamlink'); q.set('user', m.apiUser); q.set('pass', pass); q.set('agent_user', agentUser); q.set('function', 'external_dial');
  q.set('value', number); q.set('phone_code', /^\d{1,4}$/.test(m.phoneCode || '') ? m.phoneCode : '91'); q.set('search', 'YES'); q.set('preview', 'NO'); q.set('focus', 'YES');
  return { url: `${String(m.server).replace(/\/+$/, '')}/agc/api.php?${q.toString()}`, server: m.server };
}
/** A dial link (or any text) with the password masked - for any log line. */
const maskUrl = (u) => String(u || '').replace(/([?&]pass=)[^&]*/gi, '$1•••');
const hostOf = (server) => { try { return new URL(server).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } };

module.exports = { ensure, load, save, agentFor, agentsMap, setAgent, readyFor, dialUrl, maskUrl, hostOf, missingFor, LINE_ID, LINE_NAME, OUTCOMES, CARD, NOTE, REFUSED_KINDS };
