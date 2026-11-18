// ---------------------------------------------------------------------------
// CLIENT DEPTH (founder ATS audit 2026-11-18: items 114 / 133 / 134 / 142 / 377 / 711 / 720, Checklist-168 #20 #30, Checklist-120 #92, Practical P7.4).
//
//   Contacts      unlimited per client, each with a ROLE (HR, HOD, Dean, Principal, Director, Finance, Other). The four fixed slots on Client
//                 (primary, secondary, billing, recruitment) are copied into the list the first time a client's contacts are read; the old columns stay
//                 and stay readable, and a slot-born row writes back to its column when it is edited.
//   Positions     a requirement may list several positions (title, count, CTC range); the requirement's headcount (openings) is kept as their total.
//                 An application can be tagged to a position, so each position shows how many are placed and how many joined.
//   Credit        credit period in DAYS and a credit limit per client; the invoice due date = invoice date + the days (invoices that exist are untouched).
//   Desk rule     Admin setting "Desk BDEs see": every client of their desk (as always) or only the clients assigned to them.
//   Client OK     OPTIONAL step (Admin switch, OFF) before a client requirement goes live: the client confirms it in the portal.
//   Portal usage  what a client login views and does in the portal (visits, logins, requirements raised, profiles reviewed, decisions).
//   Renewals      agreements by expiry (Upcoming 60 days / Due 30 / Expired / Renewed), the assigned BDE, Mark renewed with the new dates.
// Raw tables, created on first use (no migration). Settings are AppSetting rows; every switch is OFF / today's behaviour by default.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS "ClientContact" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "role" TEXT NOT NULL, "name" TEXT, "designation" TEXT, "phone" TEXT, "email" TEXT,
          "whatsapp" TEXT, "notes" TEXT, "source" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0, "byName" TEXT, "at" TEXT NOT NULL)`,
        'CREATE INDEX IF NOT EXISTS "ClientContact_client" ON "ClientContact" ("clientId")',
        'CREATE TABLE IF NOT EXISTS "ClientContactMigrated" ("clientId" TEXT PRIMARY KEY, "at" TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS "ClientCredit" ("clientId" TEXT PRIMARY KEY, "creditDays" INTEGER, "creditLimit" REAL, "byName" TEXT, "at" TEXT NOT NULL)',
        `CREATE TABLE IF NOT EXISTS "RequirementPosition" ("id" TEXT PRIMARY KEY, "requirementId" TEXT NOT NULL, "title" TEXT NOT NULL, "count" INTEGER NOT NULL DEFAULT 1, "ctcMin" REAL, "ctcMax" REAL,
          "sortOrder" INTEGER NOT NULL DEFAULT 0, "at" TEXT NOT NULL)`,
        'CREATE INDEX IF NOT EXISTS "RequirementPosition_req" ON "RequirementPosition" ("requirementId")',
        'CREATE TABLE IF NOT EXISTS "ApplicationPosition" ("applicationId" TEXT PRIMARY KEY, "positionId" TEXT NOT NULL, "at" TEXT NOT NULL)',
        `CREATE TABLE IF NOT EXISTS "RequirementClientApproval" ("requirementId" TEXT PRIMARY KEY, "state" TEXT NOT NULL, "requestedAt" TEXT, "requestedByName" TEXT, "decidedAt" TEXT,
          "decidedById" TEXT, "decidedByName" TEXT, "note" TEXT)`,
        'CREATE TABLE IF NOT EXISTS "ClientPortalEvent" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "clientId" TEXT NOT NULL, "userId" TEXT, "kind" TEXT NOT NULL, "ref" TEXT, "at" TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS "ClientPortalEvent_client" ON "ClientPortalEvent" ("clientId","at")',
        `CREATE TABLE IF NOT EXISTS "AgreementRenewal" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "expiryDate" TEXT NOT NULL, "assignedBdeId" TEXT, "assignedBdeName" TEXT, "status" TEXT NOT NULL DEFAULT 'Open',
          "renewedAt" TEXT, "renewedByName" TEXT, "prevStart" TEXT, "prevEnd" TEXT, "newStart" TEXT, "newEnd" TEXT, "note" TEXT, "at" TEXT NOT NULL)`,
        'CREATE UNIQUE INDEX IF NOT EXISTS "AgreementRenewal_one" ON "AgreementRenewal" ("clientId","expiryDate")',
        'CREATE TABLE IF NOT EXISTS "RenewalReminderLog" ("clientId" TEXT NOT NULL, "expiryDate" TEXT NOT NULL, "stage" TEXT NOT NULL, "at" TEXT NOT NULL, PRIMARY KEY ("clientId","expiryDate","stage"))',
      ];
      for (const s of ddl) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const N = (v) => (v == null ? null : Number(v));
const txt = (v, n = 200) => { const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' '); return s ? s.slice(0, n) : null; };
const now = () => new Date().toISOString();
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

// ------------------------------------------------------------------ settings
const SETTINGS = {
  desk: { key: 'ats.deskBdeSees', def: { mode: 'desk' } }, // desk | assigned
  clientApproval: { key: 'ats.clientApproval', def: { enabled: false } },
  renewals: { key: 'renewals.reminders', def: { enabled: false } },
};
const cache = new Map();
async function getSetting(name, { fresh = false } = {}) {
  const def = SETTINGS[name];
  const c = cache.get(name);
  if (!fresh && c && Date.now() - c.at < 20000) return c.v;
  let v = { ...def.def };
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: def.key } });
    if (row) v = { ...v, ...JSON.parse(row.value) };
  } catch { /* the default */ }
  cache.set(name, { at: Date.now(), v });
  return v;
}
async function setSetting(name, patch, user) {
  const def = SETTINGS[name];
  const before = await getSetting(name, { fresh: true });
  const v = { ...before, ...patch };
  await prisma.appSetting.upsert({ where: { key: def.key }, create: { key: def.key, value: JSON.stringify(v), updatedById: user.id, updatedByName: user.name }, update: { value: JSON.stringify(v), updatedById: user.id, updatedByName: user.name } });
  cache.set(name, { at: Date.now(), v });
  return { before, after: v };
}
const deskMode = async () => ((await getSetting('desk')).mode === 'assigned' ? 'assigned' : 'desk');
const DESK_NOTE = {
  desk: 'A desk BDE (Manufacturing, Medical, Education ...) sees every client of their desk, plus the clients assigned to them. This is how it has always worked.',
  assigned: 'A desk BDE sees only the clients assigned to them (Owner BDE, second BDE, or a requirement they hold). Clients of their desk that nobody holds are not shown.',
};

// ------------------------------------------------------------------ contacts (133 / 134)
const ROLES = ['HR', 'HOD', 'Dean', 'Principal', 'Director', 'Finance', 'Other'];
const roleFromTitle = (title, fallback) => {
  const t = String(title || '').toLowerCase();
  if (/\bhod\b|head of dep/.test(t)) return 'HOD';
  if (/dean/.test(t)) return 'Dean';
  if (/principal/.test(t)) return 'Principal';
  if (/director|chairman|managing/.test(t)) return 'Director';
  if (/finance|account|billing|payable/.test(t)) return 'Finance';
  if (/\bhr\b|human|recruit|talent/.test(t)) return 'HR';
  return fallback;
};
const SLOTS = [
  { source: 'slot:primary', role: 'HR', n: 'contactName', d: 'contactDesignation', p: 'contactPhone', e: 'contactEmail', w: 'contactWhatsApp' },
  { source: 'slot:secondary', role: 'Other', n: 'secondaryContactName', d: 'secondaryContactDesignation', p: 'secondaryContactPhone', e: 'secondaryContactEmail' },
  { source: 'slot:billing', role: 'Finance', n: 'billingContactName', d: 'billingContactDesignation', p: 'billingContactPhone', e: 'billingContactEmail' },
  { source: 'slot:recruitment', role: 'HR', n: 'recruitmentContactName', d: 'recruitmentContactDesignation', p: 'recruitmentContactPhone', e: 'recruitmentContactEmail' },
];
async function migrateSlots(clientId) {
  await ensure();
  const [done] = await prisma.$queryRawUnsafe('SELECT "clientId" FROM "ClientContactMigrated" WHERE "clientId" = ?', clientId);
  if (done) return;
  const c = await prisma.client.findUnique({ where: { id: clientId } });
  if (!c) return;
  let pos = 0;
  for (const s of SLOTS) {
    const name = txt(c[s.n]); const phone = txt(c[s.p], 40); const email = txt(c[s.e], 160);
    if (!name && !phone && !email) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('INSERT INTO "ClientContact" ("id","clientId","role","name","designation","phone","email","whatsapp","source","sortOrder","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      newId('cc'), clientId, roleFromTitle(c[s.d], s.role), name, txt(c[s.d]), phone, email, s.w ? txt(c[s.w], 40) : null, s.source, pos, 'migrated from the old contact fields', now());
    pos += 1;
  }
  await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "ClientContactMigrated" ("clientId","at") VALUES (?,?)', clientId, now());
}
const shapeContact = (r) => ({ id: r.id, clientId: r.clientId, role: r.role, name: r.name, designation: r.designation, phone: r.phone, email: r.email, whatsapp: r.whatsapp, notes: r.notes, source: r.source, sortOrder: N(r.sortOrder) });
// level: the client field level of the login (utils/clientRedact.js clientLevelFor): full -> all; billing -> Finance only; anything else -> name + role only.
async function listContacts(clientId, level = 'full') {
  await migrateSlots(clientId);
  const rows = (await prisma.$queryRawUnsafe('SELECT * FROM "ClientContact" WHERE "clientId" = ? ORDER BY "sortOrder", "at"', clientId)).map(shapeContact);
  if (level === 'full') return rows;
  if (level === 'billing') return rows.filter((r) => r.role === 'Finance');
  return rows.map((r) => ({ id: r.id, clientId: r.clientId, role: r.role, name: r.name, designation: r.designation }));
}
function cleanContact(b, partial = false) {
  const out = {};
  if (!partial || b.role !== undefined) {
    const role = ROLES.find((r) => r.toLowerCase() === String(b.role || '').trim().toLowerCase());
    if (!role) return { error: `Pick a role: ${ROLES.join(', ')}.` };
    out.role = role;
  }
  ['name', 'designation', 'notes'].forEach((k) => { if (!partial || b[k] !== undefined) out[k] = txt(b[k], k === 'notes' ? 500 : 120); });
  if (!partial || b.phone !== undefined) {
    out.phone = txt(b.phone, 40);
    if (out.phone && out.phone.replace(/\D/g, '').length < 7) return { error: 'The phone number looks too short.' };
  }
  if (!partial || b.whatsapp !== undefined) out.whatsapp = txt(b.whatsapp, 40);
  if (!partial || b.email !== undefined) {
    out.email = txt(b.email, 160);
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) return { error: `"${out.email}" is not a valid email.` };
  }
  return { value: out };
}
async function addContact(clientId, v, byName) {
  await migrateSlots(clientId);
  if (!v.name && !v.phone && !v.email) return { error: 'Give the contact a name, a phone or an email.' };
  const [{ n }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ClientContact" WHERE "clientId" = ?', clientId);
  if (Number(n) >= 100) return { error: 'A client can have up to 100 contacts.' };
  const id = newId('cc');
  await prisma.$executeRawUnsafe('INSERT INTO "ClientContact" ("id","clientId","role","name","designation","phone","email","whatsapp","notes","source","sortOrder","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, clientId, v.role, v.name, v.designation, v.phone, v.email, v.whatsapp, v.notes, 'list', Number(n), byName, now());
  return { id };
}
async function updateContact(id, patch, byName) {
  await ensure();
  const [cur] = await prisma.$queryRawUnsafe('SELECT * FROM "ClientContact" WHERE "id" = ?', id);
  if (!cur) return { error: 'Contact not found', status: 404 };
  const m = { ...cur, ...patch };
  await prisma.$executeRawUnsafe('UPDATE "ClientContact" SET "role"=?,"name"=?,"designation"=?,"phone"=?,"email"=?,"whatsapp"=?,"notes"=?,"byName"=?,"at"=? WHERE "id"=?',
    m.role, m.name, m.designation, m.phone, m.email, m.whatsapp, m.notes, byName, now(), id);
  // a row that came from one of the four old slots writes back, so every older screen reads the same person
  const slot = SLOTS.find((s) => s.source === cur.source);
  if (slot) {
    const data = { [slot.n]: m.name, [slot.d]: m.designation, [slot.p]: m.phone, [slot.e]: m.email };
    if (slot.w) data[slot.w] = m.whatsapp;
    await prisma.client.update({ where: { id: cur.clientId }, data }).catch(() => null);
  }
  return { clientId: cur.clientId, before: shapeContact(cur) };
}
async function removeContact(id) {
  await ensure();
  const [cur] = await prisma.$queryRawUnsafe('SELECT * FROM "ClientContact" WHERE "id" = ?', id);
  if (!cur) return null;
  await prisma.$executeRawUnsafe('DELETE FROM "ClientContact" WHERE "id" = ?', id);
  return shapeContact(cur);
}

// ------------------------------------------------------------------ credit (142 / 377)
async function getCredit(clientId) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "ClientCredit" WHERE "clientId" = ?', clientId);
  const open = await prisma.invoice.findMany({ where: { clientId, status: { notIn: ['Cancelled', 'Paid'] } }, select: { amount: true, gst: true, tds: true, receivedAmount: true, creditedAmount: true, adjustedAmount: true, status: true, debitedAmount: true } });
  const outstanding = Math.round(open.reduce((s, i) => s + Math.max(0, Number(i.amount || 0) + Number(i.gst || 0) - Number(i.tds || 0) - Number(i.receivedAmount || 0) - Number(i.creditedAmount || 0) - Number(i.adjustedAmount || 0) + Number(i.debitedAmount || 0)), 0) * 100) / 100;
  const days = r && r.creditDays != null ? Number(r.creditDays) : null;
  const limit = r && r.creditLimit != null ? Number(r.creditLimit) : null;
  return { creditDays: days, creditLimit: limit, outstanding, overLimit: limit != null && outstanding > limit, byName: r && r.byName, at: r && r.at };
}
async function setCredit(clientId, b, byName) {
  await ensure();
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const cur = await getCredit(clientId);
  let days = cur.creditDays; let limit = cur.creditLimit;
  if (has('creditDays')) {
    if (b.creditDays === '' || b.creditDays == null) days = null;
    else { const n = Number(b.creditDays); if (!Number.isInteger(n) || n < 0 || n > 365) return { error: 'Credit period is a whole number of days from 0 to 365.' }; days = n; }
  }
  if (has('creditLimit')) {
    if (b.creditLimit === '' || b.creditLimit == null) limit = null;
    else { const n = Number(b.creditLimit); if (!Number.isFinite(n) || n < 0) return { error: 'The credit limit is an amount, zero or more.' }; limit = Math.round(n * 100) / 100; }
  }
  await prisma.$executeRawUnsafe('INSERT INTO "ClientCredit" ("clientId","creditDays","creditLimit","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("clientId") DO UPDATE SET "creditDays"=excluded."creditDays","creditLimit"=excluded."creditLimit","byName"=excluded."byName","at"=excluded."at"',
    clientId, days, limit, byName, now());
  return { before: cur, after: await getCredit(clientId) };
}
// The due date of a NEW invoice: the client's credit days after the invoice date; null when the client has none (the caller keeps its own rule).
async function creditDueDate(clientId, invoiceDay) {
  try {
    await ensure();
    const [r] = await prisma.$queryRawUnsafe('SELECT "creditDays" FROM "ClientCredit" WHERE "clientId" = ?', clientId);
    if (!r || r.creditDays == null || !isDay(String(invoiceDay).slice(0, 10))) return null;
    return addDays(String(invoiceDay).slice(0, 10), Number(r.creditDays));
  } catch { return null; }
}
async function creditWarning(clientId, newAmount) {
  try {
    const c = await getCredit(clientId);
    if (c.creditLimit != null && c.outstanding + Number(newAmount || 0) > c.creditLimit) return `This client's credit limit is Rs. ${Math.round(c.creditLimit).toLocaleString('en-IN')} and Rs. ${Math.round(c.outstanding).toLocaleString('en-IN')} is already outstanding.`;
  } catch { /* none */ }
  return null;
}

// ------------------------------------------------------------------ positions (114)
async function listPositions(requirementId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "RequirementPosition" WHERE "requirementId" = ? ORDER BY "sortOrder","at"', requirementId);
  if (!rows.length) return [];
  const tags = await prisma.$queryRawUnsafe(`SELECT "applicationId","positionId" FROM "ApplicationPosition" WHERE "positionId" IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
  const apps = tags.length ? await prisma.application.findMany({ where: { id: { in: tags.map((t) => t.applicationId) } }, select: { id: true, stage: true } }) : [];
  const stageOf = new Map(apps.map((a) => [a.id, a.stage]));
  return rows.map((r) => {
    const mine = tags.filter((t) => t.positionId === r.id).map((t) => stageOf.get(t.applicationId)).filter(Boolean);
    const joined = mine.filter((s) => ['JOINED', 'HIRED'].includes(s)).length;
    return {
      id: r.id, title: r.title, count: N(r.count), ctcMin: N(r.ctcMin), ctcMax: N(r.ctcMax),
      candidates: mine.length, selected: mine.filter((s) => ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED'].includes(s)).length, joined, open: Math.max(0, N(r.count) - joined),
    };
  });
}
// positions: [{ id?, title, count, ctcMin?, ctcMax? }]. Replaces the list (an id keeps its tagged candidates). -> { positions, total } | { error }
async function savePositions(requirementId, list) {
  await ensure();
  if (!Array.isArray(list)) return { error: 'Send the positions as a list.' };
  if (list.length > 30) return { error: 'A requirement can have up to 30 positions.' };
  const clean = [];
  for (const [i, p] of list.entries()) {
    const title = txt(p && p.title, 120);
    if (!title) return { error: `Position ${i + 1} needs a title.` };
    const count = Number(p.count);
    if (!Number.isInteger(count) || count < 1 || count > 1000) return { error: `${title}: the count is a whole number from 1 to 1000.` };
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const ctcMin = num(p.ctcMin); const ctcMax = num(p.ctcMax);
    if ((ctcMin != null && (!Number.isFinite(ctcMin) || ctcMin < 0)) || (ctcMax != null && (!Number.isFinite(ctcMax) || ctcMax < 0))) return { error: `${title}: the CTC range must be amounts.` };
    if (ctcMin != null && ctcMax != null && ctcMin > ctcMax) return { error: `${title}: the lowest CTC is above the highest.` };
    clean.push({ id: p.id ? String(p.id) : null, title, count, ctcMin, ctcMax });
  }
  const have = await prisma.$queryRawUnsafe('SELECT "id" FROM "RequirementPosition" WHERE "requirementId" = ?', requirementId);
  const keep = new Set(clean.map((c) => c.id).filter(Boolean));
  for (const h of have) {
    if (!keep.has(h.id)) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('DELETE FROM "ApplicationPosition" WHERE "positionId" = ?', h.id);
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('DELETE FROM "RequirementPosition" WHERE "id" = ?', h.id);
    }
  }
  const t = now();
  for (const [i, c] of clean.entries()) {
    const known = c.id && have.some((h) => h.id === c.id);
    if (known) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('UPDATE "RequirementPosition" SET "title"=?,"count"=?,"ctcMin"=?,"ctcMax"=?,"sortOrder"=? WHERE "id"=?', c.title, c.count, c.ctcMin, c.ctcMax, i, c.id);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('INSERT INTO "RequirementPosition" ("id","requirementId","title","count","ctcMin","ctcMax","sortOrder","at") VALUES (?,?,?,?,?,?,?,?)', newId('rp'), requirementId, c.title, c.count, c.ctcMin, c.ctcMax, i, t);
    }
  }
  const total = clean.reduce((a, c) => a + c.count, 0);
  if (clean.length) await prisma.requirement.update({ where: { id: requirementId }, data: { openings: total } }); // the headcount stays the total of the positions
  return { positions: await listPositions(requirementId), total };
}
async function tagApplication(applicationId, requirementId, positionId) {
  await ensure();
  if (!positionId) { await prisma.$executeRawUnsafe('DELETE FROM "ApplicationPosition" WHERE "applicationId" = ?', applicationId); return { ok: true }; }
  const [p] = await prisma.$queryRawUnsafe('SELECT "id" FROM "RequirementPosition" WHERE "id" = ? AND "requirementId" = ?', String(positionId), requirementId);
  if (!p) return { error: 'That position is not on this requirement.' };
  await prisma.$executeRawUnsafe('INSERT INTO "ApplicationPosition" ("applicationId","positionId","at") VALUES (?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "positionId"=excluded."positionId","at"=excluded."at"', applicationId, p.id, now());
  return { ok: true };
}

// ------------------------------------------------------------------ client approval of a requirement (Checklist-168 #30)
async function approvalOf(requirementId) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "RequirementClientApproval" WHERE "requirementId" = ?', requirementId);
  return r ? { state: r.state, requestedAt: r.requestedAt, requestedByName: r.requestedByName, decidedAt: r.decidedAt, decidedByName: r.decidedByName, note: r.note } : null;
}
async function requestApproval(requirementId, byName) {
  await ensure();
  const t = now();
  await prisma.$executeRawUnsafe(`INSERT INTO "RequirementClientApproval" ("requirementId","state","requestedAt","requestedByName") VALUES (?,?,?,?)
    ON CONFLICT("requirementId") DO UPDATE SET "state"='pending',"requestedAt"=excluded."requestedAt","requestedByName"=excluded."requestedByName","decidedAt"=NULL,"decidedById"=NULL,"decidedByName"=NULL,"note"=NULL`, requirementId, 'pending', t, byName || null);
}
async function decideApproval(requirementId, approve, user, note) {
  await ensure();
  await prisma.$executeRawUnsafe('UPDATE "RequirementClientApproval" SET "state"=?,"decidedAt"=?,"decidedById"=?,"decidedByName"=?,"note"=? WHERE "requirementId"=?', approve ? 'approved' : 'declined', now(), user.id, user.name, txt(note, 500), requirementId);
}
async function pendingApprovalsFor(clientId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "RequirementClientApproval" WHERE "state" = \'pending\'');
  if (!rows.length) return [];
  const reqs = await prisma.requirement.findMany({ where: { id: { in: rows.map((r) => r.requirementId) }, clientId, internal: false }, select: { id: true, title: true, reqCode: true, openings: true, location: true, salary: true, experience: true, skills: true, jobDescription: true, closingDate: true } });
  return reqs.map((q) => ({ ...q, requestedAt: rows.find((r) => r.requirementId === q.id).requestedAt, positions: [] }));
}
// The gate used by POST /requirements/:id/activate: null = go on, else { status, body }.
async function activationGate(requirement, user) {
  if (!requirement || requirement.internal) return null;
  if (!(await getSetting('clientApproval')).enabled) return null;
  const a = await approvalOf(requirement.id);
  if (a && a.state === 'approved') return null;
  if (a && a.state === 'declined') return { status: 409, body: { error: `The client did not approve this requirement${a.note ? `: ${a.note}` : ''}. Change it and ask for approval again.`, code: 'CLIENT_DECLINED' } };
  if (!a || a.state !== 'pending') {
    await requestApproval(requirement.id, user && user.name);
    const logins = await prisma.user.findMany({ where: { clientId: requirement.clientId, status: 'Active', role: 'CLIENT' }, select: { id: true } }).catch(() => []);
    await require('./notify').notifyUsers(logins.map((u) => u.id), { title: 'Please confirm a requirement', message: `${requirement.title}: open your TeamLink page and confirm it before it goes live.` }).catch(() => null); // eslint-disable-line global-require
  }
  return { status: 409, body: { error: 'This requirement waits for the client to confirm it in their portal before it goes live.', code: 'CLIENT_APPROVAL' } };
}

// ------------------------------------------------------------------ portal usage (711)
const KIND_LABEL = { login: 'Logins', visit: 'Portal visits', requirement_raised: 'Requirements raised', profile_reviewed: 'Profiles reviewed', decision: 'Decisions made' };
async function recordPortal(user, kind, ref) {
  try {
    if (!user || !user.clientId || !KIND_LABEL[kind]) return;
    await ensure();
    if (kind === 'visit') { // one visit per login per hour
      const since = new Date(Date.now() - 3600000).toISOString();
      const [r] = await prisma.$queryRawUnsafe('SELECT "id" FROM "ClientPortalEvent" WHERE "userId" = ? AND "kind" = \'visit\' AND "at" > ? LIMIT 1', user.id, since);
      if (r) return;
    }
    await prisma.$executeRawUnsafe('INSERT INTO "ClientPortalEvent" ("clientId","userId","kind","ref","at") VALUES (?,?,?,?,?)', user.clientId, user.id, kind, ref ? String(ref).slice(0, 80) : null, now());
  } catch { /* usage counting never breaks the portal */ }
}
// What a request of a CLIENT login means, from its method and path (the portal and the ATS routes a client may reach).
function classifyPortal(method, path) {
  const p = String(path || '').split('?')[0];
  if (method === 'GET' && /^\/api\/portal\/client\/?$/.test(p)) return { kind: 'visit' };
  if (method === 'POST' && /^\/api\/portal\/client\/requirement-requests\/?$/.test(p)) return { kind: 'requirement_raised' };
  let m = /^\/api\/portal\/client\/resume\/([^/]+)/.exec(p);
  if (method === 'GET' && m) return { kind: 'profile_reviewed', ref: m[1] };
  m = /^\/api\/ats\/interviews\/([^/]+)\/client-feedback\/?$/.exec(p);
  if (method === 'POST' && m) return { kind: 'decision', ref: m[1] };
  m = /^\/api\/portal\/client\/(join-drop\/[^/]+\/decision|offers\/[^/]+\/(release|acknowledge)|joining\/[^/]+\/(release|joined)|requirement-approvals\/[^/]+\/decide)/.exec(p);
  if (method === 'POST' && m) return { kind: 'decision', ref: m[1].slice(0, 60) };
  m = /^\/api\/applications\/([^/]+)\/(stage|move|reject|status)\/?$/.exec(p);
  if (method === 'POST' && m) return { kind: 'decision', ref: m[1] };
  return null;
}
// Express middleware (mounted early on /api): once the response is out and it succeeded, a CLIENT login's action is counted.
function portalMiddleware(req, res, next) {
  res.on('finish', () => {
    try {
      const u = req.user;
      if (!u || res.statusCode >= 400 || !u.clientId || (u.role !== 'CLIENT' && u.atsRole !== 'CLIENT')) return;
      const hit = classifyPortal(req.method, req.originalUrl);
      if (hit) recordPortal(u, hit.kind, hit.ref);
    } catch { /* never breaks the request */ }
  });
  next();
}
async function portalUsage(clientId, days = 30) {
  await ensure();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await prisma.$queryRawUnsafe('SELECT "kind", COUNT(*) AS n, MAX("at") AS last, COUNT(DISTINCT "userId") AS people FROM "ClientPortalEvent" WHERE "clientId" = ? AND "at" > ? GROUP BY "kind"', clientId, since);
  const by = Object.fromEntries(rows.map((r) => [r.kind, { count: Number(r.n), last: r.last, people: Number(r.people) }]));
  const [allTime] = await prisma.$queryRawUnsafe('SELECT MAX("at") AS last, COUNT(*) AS n FROM "ClientPortalEvent" WHERE "clientId" = ?', clientId);
  const lastLogin = await prisma.user.findFirst({ where: { clientId, role: 'CLIENT' }, orderBy: { lastLoginAt: 'desc' }, select: { lastLoginAt: true } }).catch(() => null);
  const recent = await prisma.$queryRawUnsafe('SELECT "kind","at" FROM "ClientPortalEvent" WHERE "clientId" = ? ORDER BY "id" DESC LIMIT 8', clientId);
  const c = (k) => (by[k] ? by[k].count : 0);
  return {
    days, logins: c('login'), visits: c('visit'), requirementsRaised: c('requirement_raised'), profilesReviewed: c('profile_reviewed'), decisions: c('decision'),
    activePeople: Math.max(0, ...Object.values(by).map((x) => x.people)), lastActivity: allTime && allTime.last, lastLogin: lastLogin && lastLogin.lastLoginAt,
    recent: recent.map((r) => ({ what: KIND_LABEL[r.kind] || r.kind, at: r.at })), counting: allTime ? Number(allTime.n) > 0 : false,
  };
}

// ------------------------------------------------------------------ renewals (720)
const UPCOMING_DAYS = 60;
const DUE_DAYS = 30;
function statusOf(expiry, today = todayIst()) {
  const left = daysBetween(today, expiry);
  if (left < 0) return { status: 'Expired', daysLeft: left };
  if (left <= DUE_DAYS) return { status: 'Due', daysLeft: left };
  if (left <= UPCOMING_DAYS) return { status: 'Upcoming', daysLeft: left };
  return { status: 'Active', daysLeft: left };
}
// Clients with an agreement end date in the window (or already past it), with the renewal record of that expiry.
async function renewalRows(where, { filter = 'all' } = {}) {
  await ensure();
  const today = todayIst();
  const clients = await prisma.client.findMany({
    where: { AND: [where || {}, { agreementEnd: { not: null } }] },
    select: { id: true, name: true, agreementId: true, agreementStatus: true, agreementStart: true, agreementEnd: true, bdeOwner: true, ownerDepartment: true },
  });
  const recs = await prisma.$queryRawUnsafe('SELECT * FROM "AgreementRenewal"');
  const rows = [];
  for (const c of clients) {
    if (!isDay(c.agreementEnd) || c.agreementStatus === 'CANCELLED') continue;
    const rec = recs.find((r) => r.clientId === c.id && r.expiryDate === c.agreementEnd);
    const st = statusOf(c.agreementEnd, today);
    if (st.status === 'Active') continue;
    rows.push({ clientId: c.id, client: c.name, agreementId: c.agreementId, agreementStatus: c.agreementStatus, start: c.agreementStart, expiryDate: c.agreementEnd, status: st.status, daysLeft: st.daysLeft, assignedBdeId: (rec && rec.assignedBdeId) || null, assignedBdeName: (rec && rec.assignedBdeName) || c.bdeOwner || null, note: rec && rec.note, department: c.ownerDepartment });
  }
  // Renewed ones (the expiry that was renewed), kept for a year
  const renewed = recs.filter((r) => r.status === 'Renewed' && r.renewedAt && daysBetween(String(r.renewedAt).slice(0, 10), today) <= 365);
  if (renewed.length) {
    const names = new Map((await prisma.client.findMany({ where: { AND: [where || {}, { id: { in: renewed.map((r) => r.clientId) } }] }, select: { id: true, name: true, agreementId: true } })).map((c) => [c.id, c]));
    renewed.forEach((r) => {
      const c = names.get(r.clientId);
      if (c) rows.push({ clientId: r.clientId, client: c.name, agreementId: c.agreementId, start: r.prevStart, expiryDate: r.expiryDate, status: 'Renewed', daysLeft: null, assignedBdeId: r.assignedBdeId, assignedBdeName: r.assignedBdeName, renewedAt: r.renewedAt, renewedByName: r.renewedByName, newStart: r.newStart, newEnd: r.newEnd, note: r.note });
    });
  }
  const order = { Expired: 0, Due: 1, Upcoming: 2, Renewed: 3 };
  const out = rows.filter((r) => filter === 'all' || r.status === filter).sort((a, b) => order[a.status] - order[b.status] || String(a.expiryDate).localeCompare(String(b.expiryDate)));
  const counts = { Upcoming: 0, Due: 0, Expired: 0, Renewed: 0 };
  rows.forEach((r) => { counts[r.status] += 1; });
  return { rows: out, counts };
}
async function assignRenewal(clientId, bde, by) {
  await ensure();
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { agreementEnd: true } });
  if (!c || !isDay(c.agreementEnd)) return { error: 'This client has no agreement end date.' };
  let id = null; let name = null;
  if (bde) {
    const u = await prisma.user.findUnique({ where: { id: String(bde) }, select: { id: true, name: true, status: true } });
    if (!u || u.status !== 'Active') return { error: 'That BDE is not an active login.' };
    id = u.id; name = u.name;
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "AgreementRenewal" ("id","clientId","expiryDate","assignedBdeId","assignedBdeName","at") VALUES (?,?,?,?,?,?)
    ON CONFLICT("clientId","expiryDate") DO UPDATE SET "assignedBdeId"=excluded."assignedBdeId","assignedBdeName"=excluded."assignedBdeName","at"=excluded."at"`, newId('ar'), clientId, c.agreementEnd, id, name, now());
  return { ok: true, assignedBdeName: name, by: by && by.name };
}
// New start / end: the next agreement runs from them. The old dates are kept on the renewal record.
async function markRenewed(clientId, b, user) {
  await ensure();
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, agreementStart: true, agreementEnd: true, agreementStatus: true } });
  if (!c || !isDay(c.agreementEnd)) return { error: 'This client has no agreement end date to renew.' };
  if (!isDay(b.newStart) || !isDay(b.newEnd)) return { error: 'Give the new start and end dates (YYYY-MM-DD).' };
  if (b.newEnd <= b.newStart) return { error: 'The new end date must be after the new start date.' };
  if (b.newEnd <= c.agreementEnd) return { error: `The new agreement must run past the old end date (${c.agreementEnd}).` };
  const t = now();
  await prisma.$executeRawUnsafe(`INSERT INTO "AgreementRenewal" ("id","clientId","expiryDate","status","renewedAt","renewedByName","prevStart","prevEnd","newStart","newEnd","note","at") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT("clientId","expiryDate") DO UPDATE SET "status"='Renewed',"renewedAt"=excluded."renewedAt","renewedByName"=excluded."renewedByName","prevStart"=excluded."prevStart","prevEnd"=excluded."prevEnd","newStart"=excluded."newStart","newEnd"=excluded."newEnd","note"=excluded."note","at"=excluded."at"`,
  newId('ar'), clientId, c.agreementEnd, 'Renewed', t, user.name, c.agreementStart || null, c.agreementEnd, b.newStart, b.newEnd, txt(b.note, 500), t);
  const data = { agreementStart: b.newStart, agreementEnd: b.newEnd };
  if (c.agreementStatus === 'EXPIRED') data.agreementStatus = 'ACTIVE'; // an expired agreement is live again on renewal
  await prisma.client.update({ where: { id: clientId }, data });
  return { ok: true, client: c.name, prev: { start: c.agreementStart, end: c.agreementEnd }, next: { start: b.newStart, end: b.newEnd } };
}
// Daily: tell the assigned BDE (else the client's Owner BDE) once per stage (60 / 30 / expired). OFF unless the Admin switch is on.
async function runRenewalReminders({ dryRun = false } = {}) {
  await ensure();
  const out = { enabled: false, reminded: [] };
  if (!(await getSetting('renewals', { fresh: true })).enabled) return out;
  out.enabled = true;
  const { rows } = await renewalRows({}, { filter: 'all' });
  const BD = require('./clientBdes'); // eslint-disable-line global-require
  for (const r of rows.filter((x) => x.status !== 'Renewed')) {
    const stage = r.status; // Upcoming | Due | Expired
    // eslint-disable-next-line no-await-in-loop
    const [done] = await prisma.$queryRawUnsafe('SELECT 1 AS x FROM "RenewalReminderLog" WHERE "clientId" = ? AND "expiryDate" = ? AND "stage" = ?', r.clientId, r.expiryDate, stage);
    if (done) continue;
    // eslint-disable-next-line no-await-in-loop
    let ids = r.assignedBdeId ? [r.assignedBdeId] : await BD.ownerBdeIds({ clientId: r.clientId, internal: false });
    ids = (ids || []).filter(Boolean);
    if (!ids.length) continue;
    out.reminded.push({ client: r.client, stage, to: ids.length });
    if (dryRun) continue;
    // eslint-disable-next-line no-await-in-loop
    await require('./notify').notifyUsers(ids, { title: `${r.client}: agreement ${stage === 'Expired' ? 'expired' : `ends in ${r.daysLeft} day(s)`}`, message: `Renewal ${stage.toLowerCase()}. Open Clients > Renewals to renew it (ends ${r.expiryDate}).` }).catch(() => null); // eslint-disable-line global-require
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "RenewalReminderLog" ("clientId","expiryDate","stage","at") VALUES (?,?,?,?)', r.clientId, r.expiryDate, stage, now());
  }
  return out;
}

module.exports = {
  ensure, getSetting, setSetting, deskMode, DESK_NOTE, ROLES, listContacts, cleanContact, addContact, updateContact, removeContact, migrateSlots,
  getCredit, setCredit, creditDueDate, creditWarning, listPositions, savePositions, tagApplication,
  approvalOf, requestApproval, decideApproval, pendingApprovalsFor, activationGate,
  recordPortal, classifyPortal, portalMiddleware, portalUsage, statusOf, renewalRows, assignRenewal, markRenewed, runRenewalReminders, UPCOMING_DAYS, DUE_DAYS,
};
