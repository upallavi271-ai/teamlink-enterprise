// ---------------------------------------------------------------------------
// ATS WAVE 2, builder Y (founder 2026-11-25: "push ATS to 95+"): AI / data / sourcing.
// The shared pieces of utils/atsY/*.js:
//   ensure()        every raw-SQL table of this builder (self-provisioned, never a Prisma migration)
//   settings()      ONE AppSetting row 'ats.wave2Y.settings': the Admin switches (ALL OFF until the founder turns them on)
//   provider(id)    an outside account's details from Administration > Integrations (utils/integrationStore.js, secrets decrypted
//                   server side only) -> { ready, values, missing, hint }
//   out(...)        the one outbound call (utils/jobBoards/http.js: SSRF guard, timeout, secrets scrubbed out of every error)
//   asUser(...)     a route of this server called AS a person (loopback, a 2-minute token): every rule of that route applies
//   mask*()         what may be shown / sent: masked phone, e-mail, PAN, Aadhaar
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');

const q = (sql, ...a) => prisma.$queryRawUnsafe(sql, ...a);
const x = (sql, ...a) => prisma.$executeRawUnsafe(sql, ...a);
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(12).toString('hex');
const isSandbox = () => { try { return require('../sandbox').isSandbox(); } catch { return false; } }; // eslint-disable-line global-require
const who = (u) => (u && (u.name || u.email)) || 'System';
const json = (v, d) => { if (v == null || v === '') return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const txt = (v, max = 500) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
const lower = (s) => String(s || '').toLowerCase();
const normCo = (s) => lower(s).replace(/\b(pvt|private|ltd|limited|llp|inc|india|technologies|technology|solutions|services|software|systems|corp|corporation|co)\b/g, '').replace(/[^a-z0-9]/g, '');
const normName = (s) => lower(s).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((p) => p.length > 1);

const DDL = [
  // 07.11 the meeting notetaker bot sent to an interview (the provider's bot id, its state, what came back)
  `CREATE TABLE IF NOT EXISTS "AtsYBot" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "round" INTEGER NOT NULL DEFAULT 1, "meetingUrl" TEXT NOT NULL,
    "providerBotId" TEXT, "status" TEXT NOT NULL, "statusText" TEXT, "joinAt" TEXT, "recordingId" TEXT, "createdBy" TEXT, "createdById" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsYBot_app" ON "AtsYBot" ("applicationId")',
  // 10.08 / IN-02 every Resdex search and CV download (the download log; one candidate per Resdex profile)
  `CREATE TABLE IF NOT EXISTS "AtsYResdexLog" ("id" TEXT PRIMARY KEY, "action" TEXT NOT NULL, "resdexId" TEXT, "candidateId" TEXT, "duplicate" INTEGER NOT NULL DEFAULT 0,
    "query" TEXT, "results" INTEGER, "userId" TEXT, "userName" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsYResdexLog_at" ON "AtsYResdexLog" ("action","at")',
  'CREATE INDEX IF NOT EXISTS "AtsYResdexLog_rid" ON "AtsYResdexLog" ("resdexId")',
  // 10.09 / 10.10 a job sent to foundit / LinkedIn RSC by this builder's connectors (the board's own id, the state)
  `CREATE TABLE IF NOT EXISTS "AtsYBoardPost" ("board" TEXT NOT NULL, "requirementId" TEXT NOT NULL, "status" TEXT NOT NULL, "externalId" TEXT, "externalUrl" TEXT,
    "message" TEXT, "byName" TEXT, "at" TEXT NOT NULL, PRIMARY KEY ("board","requirementId"))`,
  // 10.10 LinkedIn RSC: what was synced to LinkedIn (candidates / applications / jobs) and when
  `CREATE TABLE IF NOT EXISTS "AtsYRscSync" ("kind" TEXT NOT NULL, "refId" TEXT NOT NULL, "status" TEXT NOT NULL, "message" TEXT, "at" TEXT NOT NULL, PRIMARY KEY ("kind","refId"))`,
  // 09.04 / 09.06 / 03.12 every lookup at the outside people-data provider (who, why, how many)
  `CREATE TABLE IF NOT EXISTS "AtsYLookup" ("id" TEXT PRIMARY KEY, "kind" TEXT NOT NULL, "candidateId" TEXT, "query" TEXT, "results" INTEGER, "outcome" TEXT,
    "userId" TEXT, "userName" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsYLookup_at" ON "AtsYLookup" ("at")',
  // 03.13 the employer / title last seen per candidate, and every change seen (with where it was seen)
  `CREATE TABLE IF NOT EXISTS "AtsYJobSeen" ("candidateId" TEXT PRIMARY KEY, "company" TEXT, "title" TEXT, "at" TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "AtsYJobChange" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "fromCompany" TEXT, "toCompany" TEXT, "fromTitle" TEXT,
    "toTitle" TEXT, "source" TEXT NOT NULL, "detail" TEXT, "status" TEXT NOT NULL DEFAULT 'New', "applied" INTEGER NOT NULL DEFAULT 0, "seenAt" TEXT NOT NULL,
    "decidedBy" TEXT, "decidedAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "AtsYJobChange_cand" ON "AtsYJobChange" ("candidateId")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "AtsYJobChange_key" ON "AtsYJobChange" ("candidateId","source","toCompany","toTitle")',
  // 15.14 an ID document read against the candidate record (the result only: the document text is never kept)
  `CREATE TABLE IF NOT EXISTS "AtsYIdMatch" ("id" TEXT PRIMARY KEY, "candidateId" TEXT NOT NULL, "documentId" TEXT, "docKind" TEXT, "result" TEXT NOT NULL,
    "score" INTEGER, "verdict" TEXT, "readBy" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS "AtsYIdMatch_cand" ON "AtsYIdMatch" ("candidateId")',
];
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => { for (const s of DDL) await x(s); })() // eslint-disable-line no-restricted-syntax, no-await-in-loop
      .catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// ---- the Admin switches ---------------------------------------------------------
const KEY = 'ats.wave2Y.settings';
const SWITCHES = {
  notetakerBot: 'The AI notetaker may join interview meetings from the meeting link (needs the meeting-bot provider key)',
  outsideLookups: 'Look people up at the outside people-data provider (sourcing search, contact finding, enrichment)',
  jobChangeAlerts: 'Tell the recruiter (a bell) when a candidate\'s employer or job title changes',
  prospecting: 'Prospecting in ATS Clients: suggest new client companies and their hiring contacts, and start outreach',
  mcpWrite: 'Outside AI tools (MCP) may add an ATS note, add a follow-up and move a candidate\'s step',
  rscSync: 'Send jobs, candidates and steps to LinkedIn Recruiter (RSC sync)',
};
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  const v = json(row && row.value, {}) || {};
  const switches = {};
  Object.keys(SWITCHES).forEach((k) => { switches[k] = !!(v.switches && v.switches[k]); });
  return { switches, raw: v };
}
async function saveSwitch(name, on, user) {
  if (!SWITCHES[name]) return { status: 400, error: 'Unknown switch.' };
  const cur = (await settings()).raw;
  const next = { ...cur, switches: { ...(cur.switches || {}), [name]: !!on } };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next), updatedById: user && user.id, updatedByName: who(user) },
    update: { value: JSON.stringify(next), updatedById: user && user.id, updatedByName: who(user) },
  });
  return { ok: true, switches: (await settings()).switches };
}
async function switchOn(name) { return !!(await settings()).switches[name]; }
const SWITCH_OFF = (name) => ({ status: 409, error: `This is switched off. An Admin turns it on in Administration > ATS settings > AI governance > "Sourcing & AI connectors" (${SWITCHES[name] || name}).`, switchedOff: name });

// ---- outside accounts (Administration > Integrations) -----------------------------
async function provider(integrationId, need, label) {
  const { boardSettings } = require('../jobBoards/common'); // eslint-disable-line global-require
  const s = await boardSettings(integrationId, need, label);
  if (!s.ready && !s.hint) s.hint = `${label}: add ${s.missing.join(', ')} in Administration > Integrations > ${label} (needs the founder's account).`;
  return s;
}
const NEEDS = (label, hint) => ({ status: 409, error: hint || `${label} is not set up yet (needs the founder's account details in Administration > Integrations).`, needsFounder: true });

// a provider address: https, or a loopback stub in the test sandbox only
function okUrl(u) {
  const s = String(u || '').trim();
  if (/^https:\/\/\S+$/i.test(s)) return true;
  return isSandbox() && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(s);
}
const joinUrl = (base, p) => `${String(base || '').replace(/\/+$/, '')}/${String(p || '').replace(/^\/+/, '')}`;
async function out(label, url, opts = {}) {
  if (!okUrl(url)) return { ok: false, error: `${label}: the address must start with https:// (Administration > Integrations).` };
  return require('../jobBoards/http').call(label, url, opts); // eslint-disable-line global-require
}

// ---- a route of this server, as a person ------------------------------------------
async function asUser(user, method, path, body) {
  const jwt = require('jsonwebtoken'); // eslint-disable-line global-require
  const { resolveIdentity, tokenPayload } = require('../identity'); // eslint-disable-line global-require
  const ident = user && user.id ? await resolveIdentity(user.id).catch(() => null) : null;
  if (!ident) return { status: 403, body: { error: 'That login is not active.' } };
  const tok = jwt.sign({ ...tokenPayload(ident), tms: Date.now() }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j || {} };
}

// ---- masking ----------------------------------------------------------------------
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 6 ? `${d.slice(0, 2)}XXXXXX${d.slice(-2)}` : (d ? 'XXXX' : null); };
const maskMail = (e) => { const [u, d] = String(e || '').split('@'); return u && d ? `${u[0]}***@${d}` : null; };
const maskPan = (p) => { const s = String(p || '').toUpperCase(); return s.length === 10 ? `${s.slice(0, 2)}XXXXX${s.slice(7)}` : null; };
const maskAadhaar = (d) => { const s = String(d || '').replace(/\D/g, ''); return s.length >= 4 ? `XXXX XXXX ${s.slice(-4)}` : null; };
function maskText(t) {
  return String(t || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id]')
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[id]')
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, '[number]');
}

// ---- roles --------------------------------------------------------------------------
const viewRole = (u) => require('../scope').atsViewRole(u); // eslint-disable-line global-require
const isAdmin = (u) => viewRole(u) === 'admin';
const isMgmt = (u) => viewRole(u) === 'mgmt';
const isBde = (u) => viewRole(u) === 'bde';
const isStaff = (u) => !['client', 'candidate', 'none'].includes(viewRole(u)) && !require('../permissions').isExternalLogin(u); // eslint-disable-line global-require

async function logAudit(e) { try { await require('../audit').logAudit(e); } catch { /* the action is not undone by a missing log */ } } // eslint-disable-line global-require

module.exports = {
  q, x, nowIso, newId, isSandbox, who, json, txt, lower, normCo, normName, ensure, settings, saveSwitch, switchOn, SWITCHES, SWITCH_OFF,
  provider, NEEDS, okUrl, joinUrl, out, asUser, maskPhone, maskMail, maskPan, maskAadhaar, maskText, viewRole, isAdmin, isMgmt, isBde, isStaff, logAudit,
};
