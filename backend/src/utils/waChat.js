// ---------------------------------------------------------------------------
// WHATSAPP CLICK-TO-CHAT (free wa.me links): the engine. NO API, NO tokens, NO sending from the server - the person's own browser opens
// https://wa.me/<number>?text=... ; this module only decides WHO may be messaged, builds the {placeholder} values, and keeps the records.
// Plain SQL over WaTemplate / WaLog / WaOptIn / WaBulkSession (migration 20261015500000_wa_clicktochat), feature-detected: until it is
// applied ready() is false and the screens say "being set up".  Small config lives in AppSetting 'wa.settings'.
//
//   settings()                       { enabled, defaultCountryCode, modules:{hrms,ats,accounts}, dailyBulkLimit }
//   gate(user, entityType)           may this login WhatsApp this kind of person?  { ok, reason, product }
//   recipients(user, type, ids, o)   [{ key, id, name, number, cleaned, valid, optedIn, optInRequired, dnc, vars, ... }]  (scope-held, privacy-held)
//   templates: list / create / update / remove (a system template can be edited, never deleted)
//   log: appendLog(...) (append-only: there is no update / delete) / listLog / logCsv
//   optin: setOptIn ;   bulk: startBulk / activeBulk / getBulk / markSent / closeBulk
// The full number only ever reaches a login that may already see it (contactAccess 'direct' mode); the log masks it for everybody else.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('./audit');
const W = require('./waLink');
const core = require('./messagingCore');

const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);
const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const ms = (v) => { if (v == null) return null; if (v instanceof Date) return v.getTime(); const n = typeof v === 'bigint' ? Number(v) : v; return typeof n === 'number' ? n : (Date.parse(n) || null); };
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

const ENTITY_TYPES = ['candidate', 'employee', 'vendor', 'client', 'invoice'];
const MODULES = ['HRMS', 'ATS', 'Accounts', 'General'];
const PRODUCT_OF = { employee: 'hrms', candidate: 'ats', client: 'ats', vendor: 'accounts', invoice: 'accounts' };
const MODULE_OF = { employee: 'HRMS', candidate: 'ATS', client: 'ATS', vendor: 'Accounts', invoice: 'Accounts' };
const OPT_TYPES = ['candidate', 'vendor'];
const SAFETY_NOTE = 'WhatsApp may restrict numbers that message many people who did not ask. Send only to people who expect to hear from you. This quick chat is separate from the QR / Cloud rules in Omni-Channel.';
const NOT_READY = 'WhatsApp quick chat is being set up. Ask the admin to apply the latest database update.';

// ---- tables exist? -------------------------------------------------------------
const TABLES = ['WaTemplate', 'WaLog', 'WaOptIn', 'WaBulkSession'];
// SELF-PROVISIONING: the same DDL as migration 20261015500000_wa_clicktochat, but IF NOT EXISTS, run through the app's own connection
// (the running backend holds the SQLite lock, so the CLI cannot migrate). Memoised; never throws (a failure is logged and ready() stays false).
const DDL = [
  'CREATE TABLE IF NOT EXISTS "WaTemplate" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "module" TEXT NOT NULL DEFAULT \'General\', "body" TEXT NOT NULL, "systemKey" TEXT, "isSystem" INTEGER NOT NULL DEFAULT 0, "createdById" TEXT, "createdByName" TEXT, "updatedByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "WaTemplate_systemKey_key" ON "WaTemplate"("systemKey")',
  'CREATE TABLE IF NOT EXISTS "WaLog" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT, "userName" TEXT, "entityType" TEXT NOT NULL, "entityId" TEXT, "recipientName" TEXT, "number" TEXT, "module" TEXT, "templateId" TEXT, "templateName" TEXT, "source" TEXT NOT NULL DEFAULT \'single\', "batchId" TEXT, "status" TEXT NOT NULL DEFAULT \'Opened\', "messageLength" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS "WaLog_createdAt_idx" ON "WaLog"("createdAt")',
  'CREATE INDEX IF NOT EXISTS "WaLog_userId_idx" ON "WaLog"("userId", "createdAt")',
  'CREATE TABLE IF NOT EXISTS "WaOptIn" ("id" TEXT NOT NULL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL, "optedIn" INTEGER NOT NULL DEFAULT 0, "source" TEXT, "setById" TEXT, "setByName" TEXT, "setAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "WaOptIn_entity_key" ON "WaOptIn"("entityType", "entityId")',
  'CREATE TABLE IF NOT EXISTS "WaBulkSession" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "userName" TEXT, "entityType" TEXT NOT NULL, "module" TEXT, "templateId" TEXT, "templateName" TEXT, "templateBody" TEXT, "requirementId" TEXT, "status" TEXT NOT NULL DEFAULT \'open\', "items" TEXT NOT NULL DEFAULT \'[]\', "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS "WaBulkSession_user_idx" ON "WaBulkSession"("userId", "status")',
];
let ensuring = null; let ensuredOk = false; let ensureFailAt = 0;
function ensureTables() {
  if (ensuredOk) return Promise.resolve(true);
  if (ensuring) return ensuring;
  if (ensureFailAt && Date.now() - ensureFailAt < 5000) return Promise.resolve(false);
  ensuring = (async () => {
    try {
      for (const sql of DDL) await run(sql); // eslint-disable-line no-await-in-loop
      await seedSystem();
      ensuredOk = true; readyAt = 0;
      return true;
    } catch (err) {
      ensureFailAt = Date.now();
      // eslint-disable-next-line no-console
      console.error('[wa] could not create the WhatsApp tables:', err && err.message);
      return false;
    } finally { ensuring = null; }
  })();
  return ensuring;
}
const resetEnsure = () => { ensuredOk = false; ensuring = null; ensureFailAt = 0; readyAt = 0; };
let readyAt = 0; let readyVal = false;
async function ready() {
  await ensureTables();
  const age = Date.now() - readyAt;
  if (readyAt && age < (readyVal ? 60000 : 3000)) return readyVal;
  try {
    const t = await q(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => '?').join(',')})`, ...TABLES);
    readyVal = t.length === TABLES.length;
  } catch { readyVal = false; }
  readyAt = Date.now();
  return readyVal;
}
const resetReady = () => { readyAt = 0; };

// ---- settings (AppSetting) ----------------------------------------------------------
const SET_KEY = 'wa.settings';
const DEFAULTS = { enabled: true, defaultCountryCode: '91', modules: { hrms: true, ats: true, accounts: true }, dailyBulkLimit: 200 };
async function settings() {
  let v = null;
  try { const r = await prisma.appSetting.findUnique({ where: { key: SET_KEY } }); v = r ? JSON.parse(r.value) : null; } catch { v = null; }
  v = v && typeof v === 'object' ? v : {};
  const cc = String(v.defaultCountryCode || DEFAULTS.defaultCountryCode).replace(/\D/g, '');
  const lim = Number(v.dailyBulkLimit);
  return {
    enabled: v.enabled !== false,
    defaultCountryCode: cc || DEFAULTS.defaultCountryCode,
    modules: { hrms: !v.modules || v.modules.hrms !== false, ats: !v.modules || v.modules.ats !== false, accounts: !v.modules || v.modules.accounts !== false },
    dailyBulkLimit: Number.isFinite(lim) && lim > 0 ? Math.min(Math.round(lim), 5000) : DEFAULTS.dailyBulkLimit,
  };
}
async function saveSettings(body, user) {
  const before = await settings();
  const b = body || {};
  const next = { ...before, modules: { ...before.modules } };
  if (b.enabled !== undefined) next.enabled = b.enabled === true || b.enabled === 'true';
  if (b.defaultCountryCode !== undefined) {
    const cc = String(b.defaultCountryCode).replace(/\D/g, '');
    if (!cc || cc.length > 3) return { error: 'The country code should be 1 to 3 digits, for example 91.', status: 400 };
    next.defaultCountryCode = cc;
  }
  if (b.modules && typeof b.modules === 'object') {
    ['hrms', 'ats', 'accounts'].forEach((k) => { if (b.modules[k] !== undefined) next.modules[k] = b.modules[k] === true || b.modules[k] === 'true'; });
  }
  if (b.dailyBulkLimit !== undefined) {
    const n = Math.round(Number(b.dailyBulkLimit));
    if (!Number.isFinite(n) || n < 1 || n > 5000) return { error: 'The daily limit should be a number from 1 to 5000.', status: 400 };
    next.dailyBulkLimit = n;
  }
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({ where: { key: SET_KEY }, create: { key: SET_KEY, value, updatedById: user.id, updatedByName: user.name || null }, update: { value, updatedById: user.id, updatedByName: user.name || null } });
  const diff = [];
  if (before.enabled !== next.enabled) diff.push(`quick chat ${next.enabled ? 'ON' : 'OFF'}`);
  if (before.defaultCountryCode !== next.defaultCountryCode) diff.push(`country code ${before.defaultCountryCode} -> ${next.defaultCountryCode}`);
  ['hrms', 'ats', 'accounts'].forEach((k) => { if (before.modules[k] !== next.modules[k]) diff.push(`${k.toUpperCase()} ${next.modules[k] ? 'ON' : 'OFF'}`); });
  if (before.dailyBulkLimit !== next.dailyBulkLimit) diff.push(`daily bulk limit ${before.dailyBulkLimit} -> ${next.dailyBulkLimit}`);
  if (diff.length) await logAudit({ userId: user.id, actorName: user.name || null, action: 'WhatsApp quick chat settings changed', entity: 'WaSettings', toValue: diff.join('; ') });
  return { ok: true, settings: next, before };
}

// ---- who is who -----------------------------------------------------------------------
const P = () => require('./permissions'); // eslint-disable-line global-require
const rolesOf = (user) => {
  const perm = P();
  return { role: user.role, hrms: perm.roleForProduct(user, 'hrms'), ats: perm.roleForProduct(user, 'ats'), accounts: perm.roleForProduct(user, 'accounts') };
};
const isAdmin = (user) => ['SUPER_ADMIN', 'ADMIN'].includes(user.role);
const isHrDesk = (user) => isAdmin(user) || rolesOf(user).hrms === 'HR' || rolesOf(user).ats === 'HR';
const isAccounts = (user) => isAdmin(user) || ['ACCOUNTANT'].includes(rolesOf(user).accounts);
const isOverseer = (user) => ['MANAGER', 'ASSISTANT_MANAGER'].some((r) => Object.values(rolesOf(user)).includes(r));
const mayEditSettings = (user) => isAdmin(user) || isHrDesk(user) || isAccounts(user);
const mayEditTemplates = mayEditSettings;
const mayExport = (user) => isAdmin(user) || isHrDesk(user) || isAccounts(user);

// May this login WhatsApp this kind of person at all (before scope)?
async function gate(user, entityType) {
  const deny = (reason) => ({ ok: false, reason });
  if (!ENTITY_TYPES.includes(entityType)) return deny('Unknown kind of person.');
  const st = await settings();
  if (!st.enabled) return deny('WhatsApp quick chat is switched off. An Admin, HR or Accounts can switch it on in Administration > Message templates > WhatsApp quick chat.');
  const product = PRODUCT_OF[entityType];
  if (!st.modules[product]) return deny(`WhatsApp quick chat is switched off for ${MODULE_OF[entityType]}.`);
  if (!user || !user.id || ['CLIENT', 'CANDIDATE'].includes(user.role)) return deny('Not available to this login.');
  const CA = require('./contactAccess'); // eslint-disable-line global-require
  if (entityType === 'candidate' || entityType === 'employee' || entityType === 'client') {
    const aud = entityType === 'candidate' ? 'candidates' : entityType === 'employee' ? 'employees' : 'clients';
    const rule = await CA.ruleFor(user, aud);
    if (!rule.allowed) return deny(rule.reason || 'Your role cannot contact these people.');
    if (rule.mode === 'masked') {
      return deny(entityType === 'candidate'
        ? 'The BDE team does not see candidate phone numbers, so WhatsApp is not available. Ask the recruiter.'
        : 'Your role does not see these phone numbers, so WhatsApp is not available.');
    }
    return { ok: true, product, rule };
  }
  // vendors and invoices: the Accounts desk (and Admin)
  if (!isAccounts(user)) return deny('Vendors and invoices are handled by the Accounts team.');
  return { ok: true, product };
}

// ---- templates ---------------------------------------------------------------------------
const SYSTEM_TEMPLATES = [
  ['payslip_ready', 'Payslip ready', 'HRMS', 'Hi {name}, your payslip for {month} is ready in TeamLink. Please log in and take a look. If anything looks wrong, write to HR. Thank you.'],
  ['interview_schedule', 'Interview schedule', 'ATS', 'Hi {name}, your interview for {job_title} is on {interview_date}. Please reply to confirm that you can come. Keep your ID proof and your latest resume with you. All the best!'],
  ['invoice_due', 'Invoice due reminder', 'Accounts', 'Hello {name}, a gentle reminder that invoice {invoice_no} for {amount} is due on {due_date}. If you have already paid, please ignore this and send us the payment details. Thank you.'],
  ['payment_received', 'Payment received', 'Accounts', 'Hello {name}, we have received your payment of {amount} for invoice {invoice_no}. Thank you very much!'],
  ['document_request', 'Document request', 'General', 'Hi {name}, please send us the pending documents for your file (a clear photo of each is fine). If you need any help, just reply here. Thank you.'],
];
async function seedSystem() {
  const now = Date.now();
  for (const [key, name, mod, body] of SYSTEM_TEMPLATES) {
    // eslint-disable-next-line no-await-in-loop
    await run('INSERT OR IGNORE INTO "WaTemplate" (id, name, module, body, systemKey, isSystem, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,1,?,?,?)', `wat_${key}`, name, mod, body, key, 'TeamLink', now, now);
  }
}
const tplRow = (r) => ({ id: r.id, name: r.name, module: r.module, body: r.body, isSystem: !!num(r.isSystem), systemKey: r.systemKey || null, updatedAt: ms(r.updatedAt), updatedByName: r.updatedByName || r.createdByName || null });
async function listTemplates({ module } = {}) {
  await seedSystem();
  const rows = await q('SELECT * FROM "WaTemplate" ORDER BY isSystem DESC, module, name');
  return rows.map(tplRow).filter((t) => !module || t.module === module || t.module === 'General');
}
async function getTemplate(id) {
  const r = (await q('SELECT * FROM "WaTemplate" WHERE id = ?', String(id || '')))[0];
  return r ? tplRow(r) : null;
}
function checkTemplate(b) {
  const name = clip(b.name, 80);
  const body = String(b.body == null ? '' : b.body).trim().slice(0, 1200);
  const module = MODULES.includes(b.module) ? b.module : 'General';
  if (!name) return { error: 'Give the template a name.' };
  if (!body) return { error: 'Write the message.' };
  return { name, body, module };
}
async function createTemplate(b, user) {
  const c = checkTemplate(b || {});
  if (c.error) return { error: c.error, status: 400 };
  const dup = (await q('SELECT id FROM "WaTemplate" WHERE lower(name) = lower(?)', c.name))[0];
  if (dup) return { error: 'A template with this name already exists.', status: 409 };
  const id = newId('wat_'); const now = Date.now();
  await run('INSERT INTO "WaTemplate" (id, name, module, body, isSystem, createdById, createdByName, updatedByName, createdAt, updatedAt) VALUES (?,?,?,?,0,?,?,?,?,?)', id, c.name, c.module, c.body, user.id, user.name || null, user.name || null, now, now);
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'WhatsApp template added', entity: 'WaTemplate', entityId: id, toValue: c.name });
  return { ok: true, template: await getTemplate(id) };
}
async function updateTemplate(id, b, user) {
  const cur = await getTemplate(id);
  if (!cur) return { error: 'That template was not found.', status: 404 };
  const c = checkTemplate({ name: b.name == null ? cur.name : b.name, body: b.body == null ? cur.body : b.body, module: b.module == null ? cur.module : b.module });
  if (c.error) return { error: c.error, status: 400 };
  const dup = (await q('SELECT id FROM "WaTemplate" WHERE lower(name) = lower(?) AND id <> ?', c.name, cur.id))[0];
  if (dup) return { error: 'A template with this name already exists.', status: 409 };
  await run('UPDATE "WaTemplate" SET name = ?, module = ?, body = ?, updatedByName = ?, updatedAt = ? WHERE id = ?', c.name, c.module, c.body, user.name || null, Date.now(), cur.id);
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'WhatsApp template edited', entity: 'WaTemplate', entityId: cur.id, fromValue: cur.body.slice(0, 200), toValue: c.body.slice(0, 200) });
  return { ok: true, template: await getTemplate(cur.id) };
}
async function removeTemplate(id, user) {
  const cur = await getTemplate(id);
  if (!cur) return { error: 'That template was not found.', status: 404 };
  if (cur.isSystem) return { error: 'This is a TeamLink template. You can edit it, but it cannot be deleted.', status: 409 };
  await run('DELETE FROM "WaTemplate" WHERE id = ?', cur.id);
  await logAudit({ userId: user.id, actorName: user.name || null, action: 'WhatsApp template deleted', entity: 'WaTemplate', entityId: cur.id, fromValue: cur.name });
  return { ok: true };
}

// ---- values for the {placeholders} ----------------------------------------------------------
const IST = 'Asia/Kolkata';
const istDay = (t = Date.now()) => new Date(t + 330 * 60000).toISOString().slice(0, 10);
const monthWord = () => new Date().toLocaleString('en-IN', { timeZone: IST, month: 'long', year: 'numeric' });
const dmy = (s) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return null; return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }); };
const rupees = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? `Rs ${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : null; };

// ---- do-not-contact / opt-in ----------------------------------------------------------------------
async function suppressedSet(digitsList) {
  const out = new Set();
  try {
    const S = require('../outreach/store'); // eslint-disable-line global-require
    if (!(await S.ready())) return out;
    const map = new Map();
    digitsList.forEach((d) => { if (d) { const h = S.hashAddress('phone', d); if (h) map.set(h, d); } });
    const hs = [...map.keys()];
    for (let i = 0; i < hs.length; i += 400) {
      const part = hs.slice(i, i + 400);
      // eslint-disable-next-line no-await-in-loop
      const rows = await S.q(`SELECT addressHash FROM "OutreachSuppression" WHERE channel IN ('whatsapp','*') AND addressHash IN (${part.map(() => '?').join(',')})`, ...part);
      rows.forEach((r) => out.add(map.get(r.addressHash)));
    }
  } catch { /* Omni-Channel tables not here yet: nothing is on that list */ }
  return out;
}
async function optInMap(entityType, ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await q(`SELECT entityId, optedIn, source, setByName, setAt FROM "WaOptIn" WHERE entityType = ? AND entityId IN (${part.map(() => '?').join(',')})`, entityType, ...part);
    rows.forEach((r) => out.set(r.entityId, { optedIn: !!num(r.optedIn), source: r.source || null, setByName: r.setByName || null, setAt: ms(r.setAt) }));
  }
  return out;
}

// ---- recipients: the one resolver -----------------------------------------------------------------------
// Returns what the screen needs per person. Scope is held by the same resolvers the Message screens use (messageContext.recipientsFor).
async function recipients(user, entityType, ids, opts = {}) {
  const g = await gate(user, entityType);
  if (!g.ok) return { error: g.reason, status: 403 };
  const st = await settings();
  const cc = st.defaultCountryCode;
  const list = [...new Set((ids || []).map(String))].slice(0, 2000);
  if (!list.length) return { recipients: [], settings: st, module: MODULE_OF[entityType] };
  const month = monthWord();
  let raw = []; // [{ id, name, number, vars, dnc, consentGiven, extra }]
  if (entityType === 'candidate') {
    const MC = require('./messageContext'); // eslint-disable-line global-require
    const rows = await MC.recipientsFor(user, 'candidates', list, { applicationId: opts.applicationId, requirementId: opts.requirementId });
    let consent = new Map();
    try {
      if (require('./candidateRecord').supported()) { // eslint-disable-line global-require
        const cs = await prisma.candidate.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, consentStatus: true, consentPurposes: true } });
        consent = new Map(cs.map((c) => [c.id, c.consentStatus === 'GIVEN' && /messages/i.test(c.consentPurposes || '')]));
      }
    } catch { consent = new Map(); }
    raw = rows.map((r) => ({
      id: r.id, name: r.name, number: r.whatsapp || r.mobile, dnc: !!r.doNotContact, consentGiven: !!consent.get(r.id), applicationId: r.applicationId || null,
      vars: { name: r.tokens && r.tokens.firstName ? r.tokens.firstName : r.name, job_title: r.tokens && r.tokens.role, interview_date: r.tokens && r.tokens.interviewDate, month },
    }));
  } else if (entityType === 'employee') {
    const MC = require('./messageContext'); // eslint-disable-line global-require
    const rows = await MC.recipientsFor(user, 'employees', list);
    raw = rows.map((r) => ({ id: r.id, name: r.name, number: r.whatsapp || r.mobile, dnc: false, vars: { name: r.tokens && r.tokens.firstName ? r.tokens.firstName : r.name, month } }));
  } else if (entityType === 'client') {
    const MC = require('./messageContext'); // eslint-disable-line global-require
    const rows = await MC.recipientsFor(user, 'clients', list, { requirementId: opts.requirementId, contactKind: g.rule && g.rule.kind === 'billing' ? 'billing' : undefined });
    raw = rows.map((r) => ({ id: r.id, name: r.name, number: r.whatsapp || r.mobile, dnc: false, vars: { name: r.tokens && r.tokens.firstName ? r.tokens.firstName : r.name, job_title: r.tokens && r.tokens.role, month } }));
  } else if (entityType === 'vendor') {
    const rows = await prisma.officeVendor.findMany({ where: { id: { in: list } }, select: { id: true, name: true, contactPerson: true, phone: true } });
    raw = rows.map((v) => ({ id: v.id, name: v.contactPerson ? `${v.contactPerson} (${v.name})` : v.name, number: v.phone, dnc: false, vars: { name: v.contactPerson || v.name, month } }));
  } else if (entityType === 'invoice') {
    const scope = require('./scope'); // eslint-disable-line global-require
    const A = require('./accounts'); // eslint-disable-line global-require
    const rows = await prisma.invoice.findMany({ where: { AND: [{ id: { in: list } }, scope.invoiceWhere(user)] }, include: { client: true } });
    const seenKey = new Set();
    for (const inv of rows) {
      const key = `${inv.invoiceNumber || inv.id}|${inv.clientId}`;
      if (seenKey.has(key)) continue; // eslint-disable-line no-continue
      seenKey.add(key);
      // one client invoice = every line with the same number: the amount is what is still to pay on all of them
      let lines = [inv];
      if (inv.invoiceNumber) {
        // eslint-disable-next-line no-await-in-loop
        lines = await prisma.invoice.findMany({ where: { AND: [{ invoiceNumber: inv.invoiceNumber, clientId: inv.clientId }, scope.invoiceWhere(user)] } });
      }
      const live = lines.filter((l) => l.status !== 'Cancelled');
      const out = live.reduce((s, l) => s + Math.max(0, A.invoiceOutstanding(l)), 0);
      const total = live.reduce((s, l) => s + A.invoiceTotal(l), 0);
      const c = inv.client || {};
      const billing = c.billingContactPhone;
      const number = billing || (g.rule && g.rule.kind === 'billing' ? null : (c.contactWhatsApp || c.contactPhone));
      const person = billing ? (c.billingContactName || c.name) : (c.contactName || c.name);
      raw.push({
        id: inv.id, name: `${person}${c.name && person !== c.name ? ` (${c.name})` : ''}`, number, dnc: false,
        vars: {
          name: String(person || '').trim().split(/\s+/)[0] || person, amount: rupees(out || total), invoice_no: inv.invoiceNumber, due_date: dmy(inv.dueDate), month,
        },
        extra: { invoiceNumber: inv.invoiceNumber, outstanding: out, status: inv.status },
      });
    }
  }
  // opt-in (candidates + vendors) and the do-not-contact list
  const needOpt = OPT_TYPES.includes(entityType);
  const optMap = needOpt ? await optInMap(entityType, raw.map((r) => r.id)) : new Map();
  const cleaned = raw.map((r) => W.cleanNumber(r.number, cc));
  const sup = await suppressedSet(cleaned.filter((c) => c.valid).map((c) => c.digits));
  const out = raw.map((r, i) => {
    const c = cleaned[i];
    const explicit = optMap.get(r.id);
    const optedIn = !needOpt ? true : (explicit ? explicit.optedIn : !!r.consentGiven);
    return {
      key: `${entityType}:${r.id}`, entityType, id: r.id, applicationId: r.applicationId || null, name: r.name || '', number: r.number || '', cleaned: c.valid ? c.digits : '', valid: c.valid, numberProblem: c.valid ? null : c.reason,
      optedIn, optInRequired: needOpt, optInSource: explicit ? explicit.source : (r.consentGiven ? 'Consent on the candidate record' : null),
      dnc: !!r.dnc || (c.valid && sup.has(c.digits)), vars: r.vars || {}, extra: r.extra || null,
    };
  });
  return { recipients: out, settings: st, module: MODULE_OF[entityType] };
}

// ---- the log (append-only) ---------------------------------------------------------------------
async function appendLog(e) {
  const id = newId('wal_');
  await run('INSERT INTO "WaLog" (id, userId, userName, entityType, entityId, recipientName, number, module, templateId, templateName, source, batchId, status, messageLength, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, e.userId || null, clip(e.userName, 120) || null, e.entityType, e.entityId || null, clip(e.recipientName, 160) || null, e.number || null, e.module || null, e.templateId || null, clip(e.templateName, 100) || null,
    e.source === 'bulk' ? 'bulk' : 'single', e.batchId || null, 'Opened', Math.max(0, Math.round(Number(e.messageLength) || 0)), Date.now());
  return id;
}
function dayRange(from, to) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? Date.parse(`${from}T00:00:00.000Z`) - 330 * 60000 : null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? Date.parse(`${to}T00:00:00.000Z`) - 330 * 60000 + 86400000 : null;
  return { f, t };
}
// which rows may this login read, and may they see the full number?
function visibility(user) {
  if (isAdmin(user)) return { all: true, types: null, overseer: false };
  if (isOverseer(user)) return { all: true, types: null, overseer: true };
  const types = [];
  if (isHrDesk(user)) types.push('employee');
  if (isAccounts(user)) types.push('vendor', 'invoice', 'client');
  return { all: false, types, overseer: false };
}
const canSeeNumber = (user, row, vis) => (vis.all && !vis.overseer) || row.userId === user.id || (vis.types || []).includes(row.entityType);
function logWhere(user, f) {
  const vis = visibility(user);
  const w = []; const p = [];
  if (!vis.all) {
    const ors = ['userId = ?']; p.push(user.id);
    if (vis.types && vis.types.length) { ors.push(`entityType IN (${vis.types.map(() => '?').join(',')})`); p.push(...vis.types); }
    w.push(`(${ors.join(' OR ')})`);
  }
  const { f: from, t: to } = dayRange(f.from, f.to);
  if (from != null) { w.push('createdAt >= ?'); p.push(from); }
  if (to != null) { w.push('createdAt < ?'); p.push(to); }
  if (f.module && MODULES.includes(f.module)) { w.push('module = ?'); p.push(f.module); }
  if (f.templateId) { w.push('templateId = ?'); p.push(String(f.templateId)); }
  if (f.entityType && ENTITY_TYPES.includes(f.entityType)) { w.push('entityType = ?'); p.push(f.entityType); }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', p, vis };
}
const logOut = (user, vis) => (r) => ({
  id: r.id, at: ms(r.createdAt), recipient: r.recipientName || '', number: canSeeNumber(user, r, vis) ? (r.number ? `+${r.number}` : '') : (core.maskMobile(r.number) || '••••'),
  numberMasked: !canSeeNumber(user, r, vis), module: r.module || '', template: r.templateName || '(typed by hand)', templateId: r.templateId || null, sentBy: r.userName || '', status: r.status || 'Opened', source: r.source, entityType: r.entityType,
});
async function listLog(user, f = {}) {
  const w = logWhere(user, f);
  const limit = Math.max(1, Math.min(200, Number(f.limit) || 50)); const offset = Math.max(0, Number(f.offset) || 0);
  const total = num((await q(`SELECT COUNT(*) AS n FROM "WaLog" ${w.sql}`, ...w.p))[0].n);
  const rows = await q(`SELECT * FROM "WaLog" ${w.sql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`, ...w.p, limit, offset);
  return { total, rows: rows.map(logOut(user, w.vis)) };
}
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s) && !/^\+[\d •]+$/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
async function logCsv(user, f = {}) {
  const w = logWhere(user, f);
  const rows = await q(`SELECT * FROM "WaLog" ${w.sql} ORDER BY createdAt DESC LIMIT 20000`, ...w.p);
  const o = rows.map(logOut(user, w.vis));
  const head = ['Date and time (IST)', 'Recipient', 'Number', 'Module', 'Template', 'Sent by', 'Status'];
  const lines = [head.map(csvCell).join(',')];
  o.forEach((r) => lines.push([new Date(r.at + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16), r.recipient, r.number, r.module, r.template, r.sentBy, r.status].map(csvCell).join(',')));
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count: o.length };
}
async function sentToday(userId, source) {
  const start = Date.parse(`${istDay()}T00:00:00.000Z`) - 330 * 60000;
  const r = await q(`SELECT COUNT(*) AS n FROM "WaLog" WHERE userId = ? AND createdAt >= ?${source ? ' AND source = ?' : ''}`, ...(source ? [userId, start, source] : [userId, start]));
  return num(r[0].n);
}

// ---- opt-in --------------------------------------------------------------------------------------
const list0 = (ids) => [...new Set((ids || []).map(String))];
async function setOptIn(user, entityType, ids, optedIn, source) {
  if (!OPT_TYPES.includes(entityType)) return { error: 'Opt-in is kept for candidates and vendors only.', status: 400 };
  const g = await gate(user, entityType);
  if (!g.ok) return { error: g.reason, status: 403 };
  const src = clip(source, 120);
  if (optedIn && !src) return { error: 'Write where the permission came from (for example: asked on a call, filled the form).', status: 400 };
  // scope: only people this login can actually reach
  const r = await recipients(user, entityType, ids);
  if (r.error) return r;
  const allowed = r.recipients;
  const now = Date.now();
  for (const p of allowed) {
    // eslint-disable-next-line no-await-in-loop
    await run('INSERT INTO "WaOptIn" (id, entityType, entityId, optedIn, source, setById, setByName, setAt) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entityType, entityId) DO UPDATE SET optedIn = excluded.optedIn, source = excluded.source, setById = excluded.setById, setByName = excluded.setByName, setAt = excluded.setAt',
      newId('wao_'), entityType, p.id, optedIn ? 1 : 0, src || null, user.id, user.name || null, now);
    // eslint-disable-next-line no-await-in-loop
    await logAudit({ userId: user.id, actorName: user.name || null, action: optedIn ? 'WhatsApp opt-in marked' : 'WhatsApp opt-in removed', entity: entityType === 'candidate' ? 'Candidate' : 'OfficeVendor', entityId: p.id, toValue: optedIn ? `Opted in - ${src}` : 'Not opted in', reason: src || null });
  }
  return { ok: true, changed: allowed.length, skipped: list0(ids).length - allowed.length };
}

// ---- bulk (queue) sessions ----------------------------------------------------------------------------
const REASONS = { invalid: 'Number missing or not valid', duplicate: 'Same number as an earlier person', not_opted_in: 'Not opted in', dnc: 'Do not contact', missing: 'Message needs details that are missing' };
const sessOut = (r, extra = {}) => {
  const items = JSON.parse(r.items || '[]');
  const c = { total: items.length, sent: 0, pending: 0, skipped: { invalid: 0, duplicate: 0, not_opted_in: 0, dnc: 0, missing: 0 } };
  items.forEach((i) => { if (i.state === 'sent') c.sent += 1; else if (i.state === 'pending') c.pending += 1; else if (i.state === 'skipped' && c.skipped[i.reason] != null) c.skipped[i.reason] += 1; });
  c.skippedTotal = Object.values(c.skipped).reduce((a, b) => a + b, 0);
  return {
    id: r.id, entityType: r.entityType, module: r.module, templateId: r.templateId, templateName: r.templateName, templateBody: r.templateBody, status: r.status, createdAt: ms(r.createdAt), updatedAt: ms(r.updatedAt),
    counts: c, reasons: REASONS, items: items.map((i) => ({ id: i.id, name: i.name, state: i.state, reason: i.reason || null, reasonText: i.reason ? REASONS[i.reason] : null, missing: i.missing || null })), ...extra,
  };
};
async function limitInfo(user) {
  const st = await settings();
  const today = await sentToday(user.id, 'bulk');
  return { dailyBulkLimit: st.dailyBulkLimit, sentToday: today, overLimit: today >= st.dailyBulkLimit };
}
function summaryWords(items) {
  const c = {}; items.forEach((i) => { if (i.reason) c[i.reason] = (c[i.reason] || 0) + 1; });
  return Object.keys(c).map((k) => `${c[k]} ${REASONS[k].toLowerCase()}`).join(', ') || 'no one was selected';
}
async function startBulk(user, { entityType, ids, templateId, requirementId }) {
  const tpl = await getTemplate(templateId);
  if (!tpl) return { error: 'Pick a template first.', status: 400 };
  const r = await recipients(user, entityType, ids, { requirementId });
  if (r.error) return r;
  const seen = new Set();
  const items = r.recipients.map((p) => {
    const fill = W.fillPlaceholders(tpl.body, p.vars);
    const it = { id: p.id, name: p.name, state: 'pending' };
    if (!p.valid) { it.state = 'skipped'; it.reason = 'invalid'; } else if (p.dnc) { it.state = 'skipped'; it.reason = 'dnc'; } else if (p.optInRequired && !p.optedIn) { it.state = 'skipped'; it.reason = 'not_opted_in'; } else if (seen.has(p.cleaned)) { it.state = 'skipped'; it.reason = 'duplicate'; } else if (fill.missing.length) { it.state = 'skipped'; it.reason = 'missing'; it.missing = fill.missing; }
    if (it.state === 'pending') seen.add(p.cleaned);
    return it;
  });
  // people the caller asked for who are out of their reach are not resolved at all: they are counted as skipped
  const askedN = list0(ids).length;
  for (let i = r.recipients.length; i < askedN; i += 1) items.push({ id: `unreachable${i}`, name: '(not in your list)', state: 'skipped', reason: 'invalid' });
  if (!items.some((i) => i.state === 'pending')) return { error: `Nobody in this list can be messaged: ${summaryWords(items)}.`, status: 409 };
  // one open session per person: the older one is closed
  await run('UPDATE "WaBulkSession" SET status = \'discarded\', updatedAt = ? WHERE userId = ? AND status = \'open\'', Date.now(), user.id);
  const id = newId('wab_'); const now = Date.now();
  await run('INSERT INTO "WaBulkSession" (id, userId, userName, entityType, module, templateId, templateName, templateBody, requirementId, status, items, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,\'open\',?,?,?)',
    id, user.id, user.name || null, entityType, MODULE_OF[entityType], tpl.id, tpl.name, tpl.body, requirementId || null, JSON.stringify(items), now, now);
  const row = (await q('SELECT * FROM "WaBulkSession" WHERE id = ?', id))[0];
  return { ok: true, session: sessOut(row, { limit: await limitInfo(user) }) };
}
async function ownSession(user, id) {
  const r = (await q('SELECT * FROM "WaBulkSession" WHERE id = ? AND userId = ?', String(id || ''), user.id))[0];
  return r || null;
}
async function activeBulk(user) {
  const r = (await q('SELECT * FROM "WaBulkSession" WHERE userId = ? AND status = \'open\' ORDER BY updatedAt DESC LIMIT 1', user.id))[0];
  return r ? { session: sessOut(r, { limit: await limitInfo(user) }) } : { session: null };
}
// the session with the numbers of the people still to message (re-read from the records, never stored)
async function getBulk(user, id) {
  const r = await ownSession(user, id);
  if (!r) return { error: 'That list was not found.', status: 404 };
  const items = JSON.parse(r.items || '[]');
  const pend = items.filter((i) => i.state === 'pending').map((i) => i.id);
  let rec = [];
  if (pend.length && r.status === 'open') {
    const out = await recipients(user, r.entityType, pend, { requirementId: r.requirementId || undefined });
    if (out.error) return out;
    rec = out.recipients;
  }
  const s = sessOut(r, { limit: await limitInfo(user), defaultCountryCode: (await settings()).defaultCountryCode });
  const byId = new Map(rec.map((p) => [p.id, p]));
  s.items = s.items.map((i) => {
    const p = byId.get(i.id);
    if (!p || i.state !== 'pending') return i;
    const fill = W.fillPlaceholders(r.templateBody, p.vars);
    return { ...i, number: p.cleaned, message: fill.text, missing: fill.missing, optedIn: p.optedIn };
  });
  return { session: s };
}
async function markSent(user, id, personId) {
  const r = await ownSession(user, id);
  if (!r) return { error: 'That list was not found.', status: 404 };
  if (r.status !== 'open') return { error: 'This list is closed.', status: 409 };
  const g = await gate(user, r.entityType); // the master switch / role is checked again at every send
  if (!g.ok) return { error: g.reason, status: 403 };
  const items = JSON.parse(r.items || '[]');
  const it = items.find((i) => i.id === String(personId));
  if (!it) return { error: 'That person is not in this list.', status: 404 };
  if (it.state === 'sent') return { ok: true, already: true, session: sessOut(r, { limit: await limitInfo(user) }) };
  if (it.state !== 'pending') return { error: `${it.name} was skipped: ${REASONS[it.reason] || 'not allowed'}.`, status: 409 };
  const out = await recipients(user, r.entityType, [it.id], { requirementId: r.requirementId || undefined });
  if (out.error) return out;
  const p = out.recipients[0];
  if (!p || !p.valid || p.dnc || (p.optInRequired && !p.optedIn)) return { error: `${it.name} can no longer be messaged (opt-in or number changed).`, status: 409 };
  it.state = 'sent'; it.at = Date.now();
  const left = items.some((i) => i.state === 'pending');
  await run('UPDATE "WaBulkSession" SET items = ?, status = ?, updatedAt = ? WHERE id = ?', JSON.stringify(items), left ? 'open' : 'done', Date.now(), r.id);
  await appendLog({ userId: user.id, userName: user.name, entityType: r.entityType, entityId: p.id, recipientName: p.name, number: p.cleaned, module: r.module, templateId: r.templateId, templateName: r.templateName, source: 'bulk', batchId: r.id, messageLength: W.fillPlaceholders(r.templateBody, p.vars).text.length });
  const row = (await q('SELECT * FROM "WaBulkSession" WHERE id = ?', r.id))[0];
  return { ok: true, session: sessOut(row, { limit: await limitInfo(user) }) };
}
async function closeBulk(user, id, status) {
  const r = await ownSession(user, id);
  if (!r) return { error: 'That list was not found.', status: 404 };
  if (r.status === 'open') await run('UPDATE "WaBulkSession" SET status = ?, updatedAt = ? WHERE id = ?', status, Date.now(), r.id);
  const row = (await q('SELECT * FROM "WaBulkSession" WHERE id = ?', r.id))[0];
  return { ok: true, session: sessOut(row, { limit: await limitInfo(user) }) };
}

// ---- one send (individual) ------------------------------------------------------------------------------
async function logSingle(user, b) {
  const g = await gate(user, b.entityType);
  if (!g.ok) return { error: g.reason, status: 403 };
  const out = await recipients(user, b.entityType, [b.entityId], { requirementId: b.requirementId });
  if (out.error) return out;
  const p = out.recipients[0];
  if (!p) return { error: 'That person is not in your list.', status: 404 };
  const st = out.settings;
  const n = W.cleanNumber(b.number != null && String(b.number).trim() ? b.number : p.number, st.defaultCountryCode);
  if (!n.valid) return { error: n.reason || 'The number is not valid.', status: 400 };
  if (p.dnc) return { error: `${p.name} is on the do-not-contact list. WhatsApp is not allowed.`, status: 409 };
  const tpl = b.templateId ? await getTemplate(b.templateId) : null;
  const id = await appendLog({ userId: user.id, userName: user.name, entityType: b.entityType, entityId: p.id, recipientName: p.name, number: n.digits, module: MODULE_OF[b.entityType], templateId: tpl ? tpl.id : null, templateName: tpl ? tpl.name : null, source: 'single', messageLength: Number(b.messageLength) || 0 });
  return { ok: true, id, warning: p.optInRequired && !p.optedIn ? 'Not opted in. Send only if they asked to hear from you.' : null };
}

module.exports = {
  ENTITY_TYPES, MODULES, SAFETY_NOTE, NOT_READY, REASONS, SYSTEM_TEMPLATES,
  ready, resetReady, ensureTables, resetEnsure, DDL, settings, saveSettings, gate, rolesOf, isAdmin, isHrDesk, isAccounts, mayEditSettings, mayEditTemplates, mayExport, visibility,
  listTemplates, getTemplate, createTemplate, updateTemplate, removeTemplate,
  recipients, appendLog, listLog, logCsv, sentToday, setOptIn, startBulk, activeBulk, getBulk, markSent, closeBulk, logSingle, limitInfo,
};
